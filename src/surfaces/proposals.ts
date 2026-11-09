/**
 * M4: edit proposals per copy (FR-8, PRD "Aturan propagasi").
 *
 * Confirming a change queues `{ pageId: source, kind: 'propose', changeId }` on the `extract` queue. The consumer
 * reads every affected copy page as the app, checks the copy's sentence is still there, swaps the value's number
 * (or asks the model to rewrite the sentence when a swap is not possible), validates the result and dry-runs the
 * storage edit: one proposal per (change, copy), `needs_manual` when the text cannot be replaced safely.
 *
 * Resolvers on the copy page run as the user: an editor approves (optionally with their own wording) and Ripple saves
 * the page as them with the version message "Updated by Ripple from <source title>", which the updated:page trigger
 * ignores. A page saved by someone else since the proposal makes it `stale` (proposed again from the new version).
 */
import { Queue } from '@forge/events';
import { sqlChangeRepo, type ChangeRepo, type ChangeRow } from '../adapters/changeRepo';
import {
  canEditPage,
  ConfluenceRetryableError,
  getPageAsUser,
  getSourcePage,
  PageNotFoundError,
  pageIsOpen,
  updatePageAsUser,
  visiblePageIds,
  type SourcePage,
  type UserPage,
  type UserResult,
} from '../adapters/confluence';
import { displayNames } from '../adapters/confluenceUsers';
import { REQUEUE_WINDOW_SECONDS, sqlProposalRepo, type CopyForProposal, type ProposalRepo, type ProposalRow } from '../adapters/proposalRepo';
import { sqlRepo, type FactRepo } from '../adapters/repo';
import { ensureSchema } from '../adapters/sql';
import { scrubErrorText } from '../adapters/teamworkGraph';
import { RIPPLE_VERSION_PREFIX, type FactChange } from '../core/changes';
import { MAX_COPY_PAGE_CHARS, valueLabel } from '../core/copies';
import { quoteInText } from '../core/facts';
import { storageToText } from '../core/pageText';
import { MANUAL_CODES, MAX_SENTENCE_CHARS, replaceValueToken, validateRewrite, type ProposalErrorCode, type ProposalMethod, type ValueText } from '../core/proposals';
import { isSqlRateLimited, SchemaSettingUpError } from '../core/schema';
import { replaceSentence, sentenceCount } from '../core/storageEdit';
import type {
  ApproveAllResult,
  ApproveProposalPayload,
  ChangeIdOnlyPayload,
  ErrorReply,
  ProposalDecision,
  ProposalIdPayload,
  ProposalList,
  ProposalView,
  Rollout,
  RolloutItem,
} from '../core/views';
import { isLlmRateLimited, isLlmRetryable } from '../llm';
import type { ChatToolFn } from '../llm/extract';
import { rewriteSentence } from '../llm/rewrite';
import { proposeJobKey } from '../adapters/jobKeys';
import { sqlChangeIssueRepo, type ChangeIssueRepo } from '../adapters/changeIssueRepo';
import { createIssuesForChange, rolloutIssues, syncIssuesOf } from './changeIssues';
import { EXTRACT_QUEUE, type SourceContext } from './sources';

const errorText = (err: unknown): string => scrubErrorText(err instanceof Error ? err.message : String(err));
const UUID = /^[0-9a-f-]{36}$/i;
const NOT_ALLOWED = 'You need edit permission on this page to do that.';
const GONE = 'This proposal no longer exists on this page. Reload to see the latest.';
const BAD_EDIT = 'Your sentence must state the new value and no longer the old one (one line, no markup).';

// ---------------------------------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------------------------------

const extractQueue = new Queue({ key: EXTRACT_QUEUE });

/** Which copies a propose job handles again: the stale ones of one copy page, optionally after a delay. */
export interface ProposeTarget {
  copyPageId: string;
  delaySeconds?: number;
}

/** Queues proposals of a confirmed change (all copies, or the stale ones of one copy page). */
export async function enqueuePropose(sourcePageId: string, changeId: string, target?: ProposeTarget): Promise<string> {
  const { jobId } = await extractQueue.push({
    body: { pageId: sourcePageId, kind: 'propose', changeId, ...(target ? { copyPageId: target.copyPageId } : {}) },
    concurrency: { key: proposeJobKey(changeId), limit: 1 },
    ...(target?.delaySeconds ? { delayInSeconds: target.delaySeconds } : {}),
  });
  return jobId;
}

// ---------------------------------------------------------------------------------------------------------------
// Consumer (`extract` queue, body `{ pageId, kind: 'propose', changeId, copyId? }`)
// ---------------------------------------------------------------------------------------------------------------

export interface ProposeDeps {
  changes: Pick<ChangeRepo, 'getChange'> & Partial<Pick<ChangeRepo, 'markProposed'>>;
  proposals: ProposalRepo;
  facts: Pick<FactRepo, 'audit'>;
  /** Copy page with its storage body, as the app. */
  page: (pageId: string) => Promise<SourcePage>;
  llm?: ChatToolFn;
  /** M5: Jira issues of the change, after a full run (never throws). Absent = none. */
  createIssues?: (changeId: string) => Promise<unknown>;
  ensure: () => Promise<void>;
}

const defaultProposeDeps: ProposeDeps = {
  changes: sqlChangeRepo,
  proposals: sqlProposalRepo,
  facts: sqlRepo,
  page: getSourcePage,
  createIssues: (changeId) => createIssuesForChange(changeId),
  ensure: ensureSchema,
};

export const MAX_PROPOSE_RETRIES = 4;
const backoff = (retryCount: number): number => 30 * 2 ** retryCount;

export type ProposeOutcome =
  | { status: 'done'; created: number; proposed: number; needsManual: number; failed: number; skipped: number }
  | { status: 'retry'; seconds: number; reason: string }
  | { status: 'skipped'; reason: string };

/** Value the copy states now (its stated value, else the fact's old value). */
const copyOldValue = (copy: CopyForProposal, fc: FactChange): ValueText =>
  copy.statedValue !== null && copy.statedValue.trim() !== '' ? { value: copy.statedValue, unit: copy.statedUnit } : { value: fc.oldValue, unit: fc.oldUnit };

type Draft = { status: 'proposed' | 'needs_manual' | 'failed'; newSentence: string | null; method: ProposalMethod | null; errorCode: ProposalErrorCode | null; version: number | null };

class RetryLater extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** The proposal for one copy on an already read page. Throws `RetryLater` for a rate-limited model. */
async function draftFor(copy: CopyForProposal, fc: FactChange, page: SourcePage, llm: ChatToolFn | undefined, lastTry: boolean): Promise<Draft> {
  const fail = (status: 'needs_manual' | 'failed', errorCode: ProposalErrorCode, newSentence: string | null = null, method: ProposalMethod | null = null): Draft => ({
    status,
    newSentence,
    method,
    errorCode,
    version: page.version,
  });
  const text = storageToText(page.body, MAX_COPY_PAGE_CHARS);
  if (!quoteInText(copy.quote, text)) return fail('needs_manual', 'quote_not_found');
  const oldValue = copyOldValue(copy, fc);
  const newValue = { value: fc.newValue, unit: fc.newUnit };
  let method: ProposalMethod = 'token';
  let sentence = replaceValueToken(copy.quote, oldValue, newValue);
  if (sentence === undefined || !validateRewrite(copy.quote, sentence, oldValue, newValue, true)) {
    method = 'llm';
    try {
      sentence = await rewriteSentence(copy.quote, oldValue, newValue, llm);
    } catch (err) {
      if (!lastTry && (isLlmRateLimited(err) || isLlmRetryable(err))) throw new RetryLater('llm rate limited');
      console.warn('ripple propose: rewrite failed', { copyId: copy.id, error: errorText(err) });
      return fail('failed', 'llm_failed', null, method);
    }
    if (sentence === undefined) return fail('failed', 'llm_failed', null, method);
    if (!validateRewrite(copy.quote, sentence, oldValue, newValue, true)) return fail('failed', 'validation_failed', null, method);
  }
  const dry = replaceSentence(page.body, copy.quote, sentence);
  if (!dry.ok) return fail(MANUAL_CODES.has(dry.code) ? 'needs_manual' : 'failed', dry.code, sentence, method);
  return { status: 'proposed', newSentence: sentence, method, errorCode: null, version: page.version };
}

/**
 * Proposals of a confirmed change, one per affected copy (`scope`: one copy id, or the copies of one page after they
 * went stale). A copy that already has a proposal (other than `stale`) is skipped, so a redelivered job changes
 * nothing.
 */
export async function runProposeJob(
  changeId: string,
  scope: string | { copyPageId: string } | undefined,
  retryCount: number,
  deps: ProposeDeps = defaultProposeDeps,
): Promise<ProposeOutcome> {
  try {
    await deps.ensure();
  } catch (err) {
    if (err instanceof SchemaSettingUpError) return { status: 'retry', seconds: 60, reason: 'schema' };
    throw err;
  }
  const lastTry = retryCount >= MAX_PROPOSE_RETRIES;
  try {
    const change = await deps.changes.getChange(changeId);
    if (!change || change.status !== 'confirmed') return { status: 'skipped', reason: 'change not confirmed' };
    const targets = (change.impact?.copies ?? []).filter((c) => (scope === undefined ? true : typeof scope === 'string' ? c.copyId === scope : c.pageId === scope.copyPageId));
    const copies = new Map((await deps.proposals.copiesByIds(targets.map((t) => t.copyId))).map((c) => [c.id, c]));
    const byFact = new Map(change.factChanges.map((c) => [c.factId, c]));
    const pages = new Map<string, SourcePage | ProposalErrorCode>();
    const out = { created: 0, proposed: 0, needsManual: 0, failed: 0, skipped: 0 };
    for (const t of targets) {
      const copy = copies.get(t.copyId);
      const fc = byFact.get(t.factId);
      const existing = await deps.proposals.byChangeCopy(change.id, t.copyId);
      // Sticky copies (ignored/updated) and copies with a live proposal are left alone.
      if (!copy || !fc || (copy.status !== 'drifted' && copy.status !== 'in_sync') || (existing && existing.status !== 'stale')) {
        out.skipped++;
        continue;
      }
      let page = pages.get(copy.pageId);
      if (page === undefined) {
        try {
          page = await deps.page(copy.pageId);
        } catch (err) {
          if (err instanceof ConfluenceRetryableError && !lastTry) return { status: 'retry', seconds: backoff(retryCount), reason: 'confluence' };
          if (!(err instanceof PageNotFoundError)) console.warn('ripple propose: copy page read failed', { changeId, pageId: copy.pageId, error: errorText(err) });
          page = 'page_not_readable';
        }
        pages.set(copy.pageId, page);
      }
      const draft: Draft =
        typeof page === 'string' ? { status: 'failed', newSentence: null, method: null, errorCode: page, version: null } : await draftFor(copy, fc, page, deps.llm, lastTry);
      const saved = await deps.proposals.saveDraft({
        changeId: change.id,
        copyId: copy.id,
        factId: copy.factId,
        sourcePageId: change.sourcePageId,
        pageId: copy.pageId,
        pageVersion: draft.version,
        oldSentence: copy.quote,
        newSentence: draft.newSentence,
        oldValue: valueLabel(copyOldValue(copy, fc).value, copyOldValue(copy, fc).unit),
        newValue: valueLabel(fc.newValue, fc.newUnit),
        status: draft.status,
        method: draft.method,
        errorCode: draft.errorCode,
      });
      if (!saved.written) {
        out.skipped++;
        continue;
      }
      if (saved.created) out.created++;
      if (draft.status === 'proposed') out.proposed++;
      else if (draft.status === 'needs_manual') out.needsManual++;
      else out.failed++;
      const action = draft.status === 'proposed' ? 'proposal.created' : draft.status === 'needs_manual' ? 'proposal.needs_manual' : 'proposal.failed';
      await deps.facts.audit(action, null, 'proposal', saved.id, { changeId: change.id, pageId: copy.pageId, method: draft.method, errorCode: draft.errorCode, repeat: !saved.created });
    }
    console.info('ripple propose done', { changeId, copies: targets.length, ...out });
    // M5: one Jira issue per owner, once the proposals exist (a re-propose of one page creates none). The mark comes
    // first: issues (also those the heal asks for) are only created after a full run.
    if (scope === undefined) {
      if (deps.changes.markProposed) await deps.changes.markProposed(change.id);
      if (deps.createIssues) await deps.createIssues(change.id);
    }
    return { status: 'done', ...out };
  } catch (err) {
    if (err instanceof RetryLater) return { status: 'retry', seconds: backoff(retryCount), reason: err.reason };
    if (isSqlRateLimited(err) && !lastTry) return { status: 'retry', seconds: backoff(retryCount), reason: 'sql rate limited' };
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Resolvers (as the user)
// ---------------------------------------------------------------------------------------------------------------

export interface ProposalDeps {
  proposals: ProposalRepo;
  changes: Pick<ChangeRepo, 'getChange' | 'copiesForFacts'>;
  facts: Pick<FactRepo, 'audit' | 'getSource' | 'getFact'>;
  canEdit: (pageId: string) => Promise<boolean>;
  visible: (pageIds: readonly string[]) => Promise<Set<string>>;
  getPage: (pageId: string) => Promise<UserResult<UserPage>>;
  updatePage: (pageId: string, page: { title: string; body: string; version: number; message: string }) => Promise<UserResult<number>>;
  enqueuePropose: (sourcePageId: string, changeId: string, target?: ProposeTarget) => Promise<string>;
  /** The source page has no read restriction (page or ancestors) and its space is readable: its title may be named. */
  sourceIsOpen: (pageId: string) => Promise<boolean>;
  /** Display names as the viewer may see them (users-bulk, as the user). */
  names: (accountIds: readonly string[]) => Promise<Map<string, string>>;
  /** M5: closes the Jira issues of these changes whose owner has nothing left to do (never throws). Absent = none. */
  syncIssues?: (changeIds: readonly string[]) => Promise<void>;
  /** M5: issue rows and settings for the Rollout. Absent = not configured. */
  issues?: Pick<ChangeIssueRepo, 'listForChange' | 'getJiraSettings'>;
  ensure: () => Promise<void>;
}

const defaultDeps: ProposalDeps = {
  proposals: sqlProposalRepo,
  changes: sqlChangeRepo,
  facts: sqlRepo,
  canEdit: canEditPage,
  visible: visiblePageIds,
  getPage: getPageAsUser,
  updatePage: updatePageAsUser,
  enqueuePropose,
  sourceIsOpen: pageIsOpen,
  names: (ids) => displayNames(ids),
  syncIssues: (ids) => syncIssuesOf(ids),
  issues: sqlChangeIssueRepo,
  ensure: ensureSchema,
};

/** Proposals reached a final state: the changes' Jira issues may close. */
async function afterDecision(deps: ProposalDeps, changeIds: readonly string[]): Promise<void> {
  if (deps.syncIssues && changeIds.length > 0) await deps.syncIssues(changeIds);
}

function pageIdOf(ctx: SourceContext): string | undefined {
  const id = ctx.extension?.content?.id;
  return id === undefined || String(id) === '' ? undefined : String(id);
}

async function guarded<T>(ctx: SourceContext, deps: ProposalDeps, what: string, body: (pageId: string) => Promise<T | ErrorReply>): Promise<T | ErrorReply> {
  const pageId = pageIdOf(ctx);
  if (!pageId) return { error: 'Open a Confluence page to use Ripple.' };
  try {
    await deps.ensure();
    return await body(pageId);
  } catch (err) {
    if (err instanceof SchemaSettingUpError) return { error: err.message };
    console.warn(`ripple ${what} failed`, { pageId, error: errorText(err) });
    return { error: `Ripple could not ${what}: ${errorText(err)}` };
  }
}

/**
 * Version message of Ripple's edits; starts with `RIPPLE_VERSION_PREFIX` so the updated:page trigger skips it. The
 * source title only when it may be named to anyone (see `versionMessageFor`).
 */
export function versionMessage(sourceTitle: string | null | undefined): string {
  const title = (sourceTitle ?? '').replace(/\s+/g, ' ').trim().slice(0, 150);
  return title === '' ? RIPPLE_VERSION_PREFIX : `${RIPPLE_VERSION_PREFIX} from ${title}`;
}

/**
 * Message of a version that applies proposals of these sources: the title of a single unrestricted source, else the
 * generic message (a page history is visible to more people than the source may be).
 */
async function versionMessageFor(deps: ProposalDeps, sourcePageIds: readonly string[]): Promise<string> {
  const ids = [...new Set(sourcePageIds)];
  const [only] = ids;
  if (ids.length !== 1 || only === undefined || !(await deps.sourceIsOpen(only))) return versionMessage(null);
  return versionMessage((await deps.facts.getSource(only))?.title);
}

/**
 * The proposal still writes the current official value: its change is confirmed and the fact's value is the change's
 * new value (a newer confirmed change or an undo replaced it otherwise).
 */
async function stillCurrent(deps: ProposalDeps, p: ProposalRow): Promise<boolean> {
  const change = await deps.changes.getChange(p.changeId);
  const fc = change?.factChanges.find((c) => c.factId === p.factId);
  if (!change || change.status !== 'confirmed' || !fc) return false;
  const fact = await deps.facts.getFact(p.factId);
  return fact !== undefined && fact.status === 'confirmed' && fact.value === fc.newValue && (fact.unit ?? null) === (fc.newUnit ?? null);
}

/** Rejects an outdated proposal (`superseded`); false when its status moved on meanwhile. */
async function supersede(deps: ProposalDeps, actor: string, p: ProposalRow): Promise<boolean> {
  if (!(await deps.proposals.setStatus(p.id, ['proposed', 'approved', 'stale', 'needs_manual'], 'rejected', 'superseded'))) return false;
  await deps.facts.audit('proposal.superseded', actor, 'proposal', p.id, { changeId: p.changeId, pageId: p.pageId });
  return true;
}

const decision = (p: Pick<ProposalRow, 'id' | 'status' | 'errorCode' | 'appliedVersion'>): ProposalDecision => ({ proposalId: p.id, status: p.status, errorCode: p.errorCode, version: p.appliedVersion });

/** Proposal `proposalId` of the context page, with edit permission checked. */
async function ownProposal(ctx: SourceContext, deps: ProposalDeps, pageId: string, payload: Partial<ProposalIdPayload> | undefined): Promise<{ proposal: ProposalRow; actor: string } | ErrorReply> {
  const id = payload?.proposalId;
  if (typeof id !== 'string' || !UUID.test(id)) return { error: 'Missing or invalid proposal id.' };
  if (!ctx.accountId || !(await deps.canEdit(pageId))) return { error: NOT_ALLOWED };
  const proposal = await deps.proposals.get(id);
  // The page id comes from the context: a proposal of another page is "gone" here.
  if (!proposal || proposal.pageId !== pageId) return { error: GONE };
  return { proposal, actor: ctx.accountId };
}

const userFailure = (status: number): ProposalErrorCode => (status === 401 || status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'http_error');

/** A failure where trying again later may work: the proposal goes back to `proposed`. */
const transient = (code: ProposalErrorCode): boolean => code === 'http_error';

/**
 * Marks proposals stale (version changed) and queues them again from the new version: one job per (change, copy
 * page), at most once per `REQUEUE_WINDOW_SECONDS` plus one delayed follow-up within the window.
 */
async function goStale(deps: ProposalDeps, actor: string, rows: readonly ProposalRow[], code: ProposalErrorCode): Promise<number> {
  let n = 0;
  const queue = new Map<string, ProposalRow>();
  for (const p of rows) {
    if (!(await deps.proposals.setStatus(p.id, ['approved', 'proposed'], 'stale', code))) continue;
    n++;
    await deps.facts.audit('proposal.stale', actor, 'proposal', p.id, { changeId: p.changeId, pageId: p.pageId, errorCode: code });
    queue.set(`${p.changeId}:${p.pageId}`, p);
  }
  for (const p of queue.values()) {
    try {
      const claim = await deps.proposals.claimRequeue(p.changeId, p.pageId, p.sourcePageId);
      if (claim === 'skip') continue;
      await deps.enqueuePropose(p.sourcePageId, p.changeId, { copyPageId: p.pageId, ...(claim === 'delayed' ? { delaySeconds: REQUEUE_WINDOW_SECONDS } : {}) });
    } catch (err) {
      console.warn('ripple proposal: re-propose not queued', { changeId: p.changeId, pageId: p.pageId, error: errorText(err) });
    }
  }
  return n;
}

/** The new value of the proposal's fact in its change. */
async function factChangeOf(deps: ProposalDeps, p: ProposalRow): Promise<FactChange | undefined> {
  const change: ChangeRow | undefined = await deps.changes.getChange(p.changeId);
  return change?.factChanges.find((c) => c.factId === p.factId);
}

/** After a saved version: `applied`, the copy states the new value. */
async function recordApplied(deps: ProposalDeps, actor: string, p: ProposalRow, sentence: string, version: number, edited: boolean): Promise<void> {
  await deps.proposals.markApplied(p.id, version, actor, sentence);
  const fc = await factChangeOf(deps, p);
  if (fc) await deps.proposals.markCopyUpdated(p.copyId, fc.newValue, fc.newUnit, sentence, version);
  await deps.facts.audit('proposal.applied', actor, 'proposal', p.id, { changeId: p.changeId, pageId: p.pageId, version, method: p.method, edited });
  if (edited) await deps.facts.audit('proposal.edited', actor, 'proposal', p.id, { changeId: p.changeId, pageId: p.pageId });
}

/**
 * Other open proposals of the page were read at the version just replaced: they follow to the new version when their
 * edit still applies to the new body, otherwise they are stale.
 */
async function rebaseOthers(deps: ProposalDeps, actor: string, pageId: string, done: ReadonlySet<string>, body: string, fromVersion: number, toVersion: number): Promise<void> {
  const open = (await deps.proposals.listForPage(pageId)).filter((p) => p.status === 'proposed' && !done.has(p.id) && p.pageVersion === fromVersion);
  const ok = open.filter((p) => p.oldSentence !== null && p.newSentence !== null && replaceSentence(body, p.oldSentence, p.newSentence).ok);
  await deps.proposals.rebase(
    ok.map((p) => p.id),
    fromVersion,
    toVersion,
  );
  await goStale(
    deps,
    actor,
    open.filter((p) => !ok.includes(p)),
    'version_changed',
  );
}

/**
 * Applies one proposal as the user (optionally with their own sentence). Repeat-safe: the status lock lets one call
 * through; a second call answers the current status. A page saved by someone else since the proposal makes it stale.
 */
export async function approveProposal(ctx: SourceContext, payload: Partial<ApproveProposalPayload> | undefined, deps: ProposalDeps = defaultDeps): Promise<ProposalDecision | ErrorReply> {
  return guarded(ctx, deps, 'apply the proposal', async (pageId) => {
    const r = await ownProposal(ctx, deps, pageId, payload);
    if ('error' in r) return r;
    const { proposal: p, actor } = r;
    if (p.status !== 'proposed' && p.status !== 'approved') return decision(p);
    if (p.oldSentence === null || p.newSentence === null || p.pageVersion === null) return { error: 'This proposal has no sentence to apply.' };
    const raw = payload?.editedSentence;
    let sentence = p.newSentence;
    let edited = false;
    if (raw !== undefined && raw !== null) {
      // Length first: nothing below runs a regex over an unbounded string.
      if (typeof raw !== 'string' || raw.length > MAX_SENTENCE_CHARS) return { error: BAD_EDIT };
      const text = raw.replace(/\s+/g, ' ').trim();
      const oldValue = { value: p.oldValue ?? '', unit: null };
      const newValue = { value: p.newValue ?? '', unit: null };
      if (text !== p.newSentence) {
        if (!validateRewrite(p.oldSentence, text, oldValue, newValue, false)) return { error: BAD_EDIT };
        sentence = text;
        edited = true;
      }
    }
    if (!(await deps.proposals.lock(p.id))) {
      const now = await deps.proposals.get(p.id);
      return decision(now ?? p);
    }
    let result: ProposalDecision;
    try {
      result = await applyLocked(deps, actor, pageId, { ...p, oldSentence: p.oldSentence, pageVersion: p.pageVersion }, sentence, edited);
    } catch (err) {
      // Never leave the lock held: back to `proposed` so the editor can try again (no-op once applied).
      await deps.proposals.setStatus(p.id, ['approved'], 'proposed', 'http_error').catch(() => false);
      throw err;
    }
    if (result.status === 'applied' || result.status === 'rejected') await afterDecision(deps, [p.changeId]);
    return result;
  });
}

/** Approval of a locked (`approved`) proposal; every exit moves it out of `approved`, an exception is the caller's. */
async function applyLocked(deps: ProposalDeps, actor: string, pageId: string, p: ProposalRow & { oldSentence: string; pageVersion: number }, sentence: string, edited: boolean): Promise<ProposalDecision> {
  if (!(await stillCurrent(deps, p))) {
      await supersede(deps, actor, p);
      return { proposalId: p.id, status: 'rejected', errorCode: 'superseded', version: null };
    }
    const finish = async (status: 'proposed' | 'stale' | 'needs_manual' | 'failed', code: ProposalErrorCode | null): Promise<ProposalDecision> => {
      if (status === 'stale') await goStale(deps, actor, [{ ...p, status: 'approved' }], code ?? 'version_changed');
      else {
        await deps.proposals.setStatus(p.id, ['approved'], status, code);
        if (status === 'needs_manual') await deps.facts.audit('proposal.needs_manual', actor, 'proposal', p.id, { changeId: p.changeId, pageId, errorCode: code });
      }
      console.info('ripple proposal not applied', { proposalId: p.id, pageId, status, errorCode: code });
      return { proposalId: p.id, status, errorCode: code, version: null };
    };
    const got = await deps.getPage(pageId);
    if (!got.ok) {
      const code = userFailure(got.status);
      return finish(transient(code) ? 'proposed' : 'failed', code);
    }
    const page = got.value;
    if (page.version !== p.pageVersion) {
      // An earlier call saved it and failed before recording: the page states the new sentence and not the old one.
      if (sentenceCount(page.body, sentence) === 1 && sentenceCount(page.body, p.oldSentence) === 0) {
        await recordApplied(deps, actor, p, sentence, page.version, edited);
        return { proposalId: p.id, status: 'applied', errorCode: null, version: page.version };
      }
      return finish('stale', 'version_changed');
    }
    const edit = replaceSentence(page.body, p.oldSentence, sentence);
    // The editor's own wording that cannot be placed (e.g. crosses markup) leaves Ripple's proposal as it was.
    if (!edit.ok) return finish(edited ? 'proposed' : 'needs_manual', edit.code);
    const saved = await deps.updatePage(pageId, { title: page.title, body: edit.body, version: page.version + 1, message: await versionMessageFor(deps, [p.sourcePageId]) });
    if (!saved.ok) {
      const code = userFailure(saved.status);
      if (code === 'conflict') return finish('stale', 'conflict');
      return finish(transient(code) ? 'proposed' : 'failed', code);
    }
    await recordApplied(deps, actor, p, sentence, saved.value, edited);
    await rebaseOthers(deps, actor, pageId, new Set([p.id]), edit.body, page.version, saved.value);
    console.info('ripple proposal applied', { proposalId: p.id, pageId, version: saved.value, method: p.method, edited });
    return { proposalId: p.id, status: 'applied', errorCode: null, version: saved.value };
}

/**
 * Applies every open proposal of the page in ONE saved version, in order; a proposal whose edit no longer applies
 * is left for a manual edit. Proposals read at another page version are stale and nothing is saved for them.
 */
export async function approveAll(ctx: SourceContext, deps: ProposalDeps = defaultDeps): Promise<ApproveAllResult | ErrorReply> {
  return guarded(ctx, deps, 'apply the proposals', async (pageId) => {
    if (!ctx.accountId || !(await deps.canEdit(pageId))) return { error: NOT_ALLOWED };
    const actor = ctx.accountId;
    const result: ApproveAllResult = { applied: 0, stale: 0, needsManual: 0, failed: 0, version: null };
    const open = (await deps.proposals.listForPage(pageId)).filter((p) => p.status === 'proposed' && p.oldSentence !== null && p.newSentence !== null);
    const all: ProposalRow[] = [];
    for (const p of open) if (await deps.proposals.lock(p.id)) all.push(p);
    if (all.length === 0) return result;
    let reply: ApproveAllResult | ErrorReply;
    try {
      reply = await applyAllLocked(deps, actor, pageId, all, result);
    } catch (err) {
      // Never leave locks held: whatever is still `approved` goes back to `proposed`.
      for (const p of all) await deps.proposals.setStatus(p.id, ['approved'], 'proposed', 'http_error').catch(() => false);
      throw err;
    }
    await afterDecision(
      deps,
      all.map((p) => p.changeId),
    );
    return reply;
  });
}

async function applyAllLocked(deps: ProposalDeps, actor: string, pageId: string, all: readonly ProposalRow[], result: ApproveAllResult): Promise<ApproveAllResult | ErrorReply> {
    const release = async (rows: readonly ProposalRow[], to: 'proposed' | 'failed', code: ProposalErrorCode | null) => {
      for (const p of rows) await deps.proposals.setStatus(p.id, ['approved'], to, code);
    };
    // Outdated proposals (a newer confirmed change, an undone confirmation) are rejected, not applied.
    const locked: ProposalRow[] = [];
    for (const p of all) {
      if (await stillCurrent(deps, p)) locked.push(p);
      else await supersede(deps, actor, p);
    }
    if (locked.length === 0) return result;
    const got = await deps.getPage(pageId);
    if (!got.ok) {
      const code = userFailure(got.status);
      await release(locked, transient(code) ? 'proposed' : 'failed', code);
      if (!transient(code)) result.failed = locked.length;
      return transient(code) ? { error: `Confluence did not return the page (HTTP ${got.status}). Try again.` } : result;
    }
    const page = got.value;
    const current = locked.filter((p) => p.pageVersion === page.version);
    result.stale += await goStale(
      deps,
      actor,
      locked.filter((p) => p.pageVersion !== page.version),
      'version_changed',
    );
    let body = page.body;
    const applied: ProposalRow[] = [];
    for (const p of current) {
      const edit = replaceSentence(body, p.oldSentence as string, p.newSentence as string);
      if (!edit.ok) {
        await deps.proposals.setStatus(p.id, ['approved'], 'needs_manual', edit.code);
        await deps.facts.audit('proposal.needs_manual', actor, 'proposal', p.id, { changeId: p.changeId, pageId, errorCode: edit.code });
        result.needsManual++;
        continue;
      }
      body = edit.body;
      applied.push(p);
    }
    if (applied.length === 0) return result;
    const message = await versionMessageFor(
      deps,
      applied.map((p) => p.sourcePageId),
    );
    const saved = await deps.updatePage(pageId, { title: page.title, body, version: page.version + 1, message });
    if (!saved.ok) {
      const code = userFailure(saved.status);
      if (code === 'conflict') result.stale += await goStale(deps, actor, applied, 'conflict');
      else {
        await release(applied, transient(code) ? 'proposed' : 'failed', code);
        if (transient(code)) return { error: `Confluence did not save the page (HTTP ${saved.status}). Try again.` };
        result.failed += applied.length;
      }
      return result;
    }
    for (const p of applied) await recordApplied(deps, actor, p, p.newSentence as string, saved.value, false);
    result.applied = applied.length;
    result.version = saved.value;
    await rebaseOthers(deps, actor, pageId, new Set(applied.map((p) => p.id)), body, page.version, saved.value);
    console.info('ripple proposals applied', { pageId, applied: result.applied, stale: result.stale, needsManual: result.needsManual, version: saved.value });
    return result;
}

/** The editor does not want this edit; the copy keeps its status. */
export async function rejectProposal(ctx: SourceContext, payload: Partial<ProposalIdPayload> | undefined, deps: ProposalDeps = defaultDeps): Promise<ProposalDecision | ErrorReply> {
  return guarded(ctx, deps, 'reject the proposal', async (pageId) => {
    const r = await ownProposal(ctx, deps, pageId, payload);
    if ('error' in r) return r;
    const { proposal: p, actor } = r;
    if (await deps.proposals.setStatus(p.id, ['proposed', 'stale', 'needs_manual', 'failed'], 'rejected', null)) {
      await deps.facts.audit('proposal.rejected', actor, 'proposal', p.id, { changeId: p.changeId, pageId, reason: 'rejected' });
      await afterDecision(deps, [p.changeId]);
      return { proposalId: p.id, status: 'rejected', errorCode: null, version: null };
    }
    return decision((await deps.proposals.get(p.id)) ?? p);
  });
}

/** The copy is not about the source's fact: the proposal is rejected and the copy ignored from now on. */
export async function markNotSameFact(ctx: SourceContext, payload: Partial<ProposalIdPayload> | undefined, deps: ProposalDeps = defaultDeps): Promise<ProposalDecision | ErrorReply> {
  return guarded(ctx, deps, 'mark the copy', async (pageId) => {
    const r = await ownProposal(ctx, deps, pageId, payload);
    if ('error' in r) return r;
    const { proposal: p, actor } = r;
    if (!(await deps.proposals.setStatus(p.id, ['proposed', 'stale', 'needs_manual', 'failed'], 'rejected', null))) return decision((await deps.proposals.get(p.id)) ?? p);
    await deps.proposals.ignoreCopy(p.copyId);
    await deps.facts.audit('proposal.rejected', actor, 'proposal', p.id, { changeId: p.changeId, pageId, reason: 'not_same_fact' });
    await afterDecision(deps, [p.changeId]);
    return { proposalId: p.id, status: 'rejected', errorCode: null, version: null };
  });
}

/** Proposals of the copy page being viewed; source titles only for sources the viewer can open. */
export async function listProposalsForPage(ctx: SourceContext, deps: ProposalDeps = defaultDeps): Promise<ProposalList | ErrorReply> {
  return guarded(ctx, deps, 'list the proposals', async (pageId) => {
    const rows = await deps.proposals.listForPage(pageId);
    const sourceIds = [...new Set(rows.map((p) => p.sourcePageId))];
    const seen = sourceIds.length > 0 ? await deps.visible(sourceIds) : new Set<string>();
    const titles = new Map<string, string | null>();
    for (const id of sourceIds) titles.set(id, seen.has(id) ? ((await deps.facts.getSource(id))?.title ?? null) : null);
    // Fact labels only for facts of sources the viewer can open.
    const labels = new Map<string, string | null>();
    for (const p of rows) {
      if (!seen.has(p.sourcePageId) || labels.has(p.factId)) continue;
      const fact = await deps.facts.getFact(p.factId);
      labels.set(p.factId, fact && fact.sourcePageId === p.sourcePageId ? `${fact.subject} · ${fact.attribute}` : null);
    }
    const canEdit = rows.length > 0 && ctx.accountId ? await deps.canEdit(pageId) : false;
    const proposals: ProposalView[] = rows.map((p) => {
      const shown = seen.has(p.sourcePageId);
      // Editors of this page apply the new sentence, so they see it even when the source is hidden from them.
      const showNew = shown || canEdit;
      return {
        id: p.id,
        changeId: p.changeId,
        status: p.status,
        oldSentence: p.oldSentence,
        newSentence: showNew ? p.newSentence : null,
        oldValue: p.oldValue,
        newValue: showNew ? p.newValue : null,
        method: p.method,
        errorCode: p.errorCode,
        sourcePageId: shown ? p.sourcePageId : null,
        sourceTitle: shown ? (titles.get(p.sourcePageId) ?? null) : null,
        sourceHidden: !shown,
        factLabel: shown ? (labels.get(p.factId) ?? null) : null,
        appliedVersion: p.appliedVersion,
      };
    });
    return { pageId, canEdit, proposals };
  });
}

/** Proposals of a change of the source page being viewed; copies on pages the viewer cannot open are only counted. */
export async function listRollout(ctx: SourceContext, payload: Partial<ChangeIdOnlyPayload> | undefined, deps: ProposalDeps = defaultDeps): Promise<Rollout | ErrorReply> {
  return guarded(ctx, deps, 'list the rollout', async (pageId) => {
    const changeId = payload?.changeId;
    if (typeof changeId !== 'string' || !UUID.test(changeId)) return { error: 'Missing or invalid change id.' };
    const change = await deps.changes.getChange(changeId);
    if (!change || change.sourcePageId !== pageId) return { error: 'This change does not belong to this page.' };
    const rows = await deps.proposals.listForChange(changeId);
    const pageIds = [...new Set(rows.map((p) => p.pageId))];
    const seen = pageIds.length > 0 ? await deps.visible(pageIds) : new Set<string>();
    const titles = new Map(
      (
        await deps.changes.copiesForFacts(
          pageId,
          change.factChanges.map((c) => c.factId),
        )
      ).map((c) => [c.pageId, { title: c.pageTitle, url: c.pageUrl }]),
    );
    const shown = rows.filter((p) => seen.has(p.pageId));
    // Owners recorded at confirm time; names as the viewer may see them (a failed lookup only hides the names).
    const ownerOf = new Map((change.routing?.pages ?? []).map((r) => [r.pageId, r.ownerAccountId]));
    const ownerIds = [...new Set(shown.map((p) => ownerOf.get(p.pageId)).filter((id): id is string => typeof id === 'string' && id !== ''))];
    let names = new Map<string, string>();
    if (ownerIds.length > 0) {
      try {
        names = await deps.names(ownerIds);
      } catch (err) {
        console.warn('ripple rollout: owner names failed', { changeId, owners: ownerIds.length, error: errorText(err) });
      }
    }
    const items: RolloutItem[] = shown.map((p) => {
      const accountId = ownerOf.get(p.pageId) ?? null;
      return {
        proposalId: p.id,
        pageId: p.pageId,
        pageTitle: titles.get(p.pageId)?.title ?? null,
        pageUrl: titles.get(p.pageId)?.url ?? null,
        status: p.status,
        errorCode: p.errorCode,
        owner: { accountId, displayName: accountId ? (names.get(accountId) ?? null) : null },
      };
    });
    const counts: Rollout['counts'] = {};
    for (const p of shown) counts[p.status] = (counts[p.status] ?? 0) + 1;
    let issues: Pick<Rollout, 'issues' | 'issuesState'> = { issues: [], issuesState: 'not_configured' };
    if (deps.issues) {
      try {
        issues = await rolloutIssues(change, rows, names, deps.issues);
      } catch (err) {
        console.warn('ripple rollout: issues failed', { changeId, error: errorText(err) });
        issues = { issues: [], issuesState: 'pending' };
      }
    }
    return { changeId, items, counts, hiddenCount: rows.length - shown.length, ...issues };
  });
}

/** Byline count of proposals waiting on the page; 0 on failure (the byline never fails because of it). */
export async function pendingProposalCount(pageId: string, proposals: Pick<ProposalRepo, 'pendingCount'> = sqlProposalRepo): Promise<number> {
  try {
    return await proposals.pendingCount(pageId);
  } catch (err) {
    console.warn('ripple byline: proposal count failed', { pageId, error: errorText(err) });
    return 0;
  }
}
