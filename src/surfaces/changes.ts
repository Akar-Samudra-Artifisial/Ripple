/**
 * M3: change detection (FR-7).
 *
 * The `avi:confluence:updated:page` trigger only checks SQL (source? already seen version? Ripple's own edit?) and
 * queues a diff job on the `extract` queue (same per-page concurrency key as extraction, so they never overlap). The
 * consumer re-extracts the new version with the M1 rules and compares it with the confirmed facts: changed values form
 * one pending change per source with the copies of the last scan it would affect. Resolvers (as the user) show the
 * change with copy owners and the teams of their spaces (Teamwork Graph) and let an editor of the source confirm it
 * (facts take the new values; M4 proposes the copy edits) or dismiss it.
 */
import { Queue } from '@forge/events';
import { dismissalKey, sha256, sqlChangeRepo, valueHash, type ChangeRepo, type ChangeRouting, type ChangeRow } from '../adapters/changeRepo';
import { canEditPage, ConfluenceRetryableError, getSourcePage, pageSpaceIdAsApp, PageNotFoundError, visiblePageIds, type SourcePage } from '../adapters/confluence';
import { displayNames } from '../adapters/confluenceUsers';
import { sqlProposalRepo } from '../adapters/proposalRepo';
import { sqlRepo, type FactRepo, type PageVersionInfo } from '../adapters/repo';
import { ensureSchema } from '../adapters/sql';
import { asUserGraph, fetchPageMeta, ownersFromPage, readSpaceTeams, scrubErrorText, type GraphRequest, type PageMeta } from '../adapters/teamworkGraph';
import { addWorkingDays, computeImpact, DEFAULT_DEADLINE_DAYS, isRippleVersion, matchFacts, MAX_DEADLINE_DAYS, offeredFacts, planDiff, wordingOnlyReverts, type KnownFact } from '../core/changes';
import { parseExtraction } from '../core/facts';
import { storageToText, TRUNCATED_MARK } from '../core/pageText';
import { isSqlRateLimited, SchemaSettingUpError } from '../core/schema';
import type {
  ChangeDecision,
  ChangeIdPayload,
  ChangePageView,
  ChangeSpaceView,
  ConfirmChangePayload,
  ErrorReply,
  FactChangeView,
  LatestChangeReply,
  OwnerView,
  PendingChangeFlag,
  PendingChangeReply,
  PendingChangeView,
} from '../core/views';
import { isLlmRateLimited, LlmOutputError } from '../llm';
import { runFactExtraction, type ChatToolFn } from '../llm/extract';
import { EXTRACT_QUEUE, type SourceContext } from './sources';

const errorText = (err: unknown): string => scrubErrorText(err instanceof Error ? err.message : String(err));
const NOT_ALLOWED = 'You need edit permission on this page to do that.';
const GONE = 'This change was already decided or replaced by a newer one. Reload to see the latest.';
/** The UI reloads the change when an error contains "Review it again". */
export const STALE = 'This change was updated by a newer page version. Review it again.';
const UUID = /^[0-9a-f-]{36}$/i;
/** Copy pages whose owner is looked up per `getPendingChange` (REST v2 as the user); the rest show no owner. */
export const MAX_OWNER_LOOKUPS = 50;
const LOOKUP_CONCURRENCY = 5;

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Trigger: avi:confluence:updated:page
// ---------------------------------------------------------------------------------------------------------------

export interface PageUpdate {
  pageId: string;
  version: number | null;
  /** Version comment when the event carries it; the consumer re-checks it from REST v2. */
  message: string | null;
}

export interface TriggerDeps {
  facts: FactRepo;
  changes: ChangeRepo;
  enqueueDiff: (pageId: string, version: number | null, options?: DiffQueueOptions) => Promise<string>;
  ensure: () => Promise<void>;
}

export interface DiffQueueOptions {
  delaySeconds?: number;
  /** Times the diff was already queued again because the schema was not ready. */
  deferrals?: number;
}

const extractQueue = new Queue({ key: EXTRACT_QUEUE });

/** Queues change detection for a page (`extract` queue, body `{ pageId, kind: 'diff', version }`). */
export async function enqueueDiff(pageId: string, version: number | null, options: DiffQueueOptions = {}): Promise<string> {
  const { jobId } = await extractQueue.push({
    body: { pageId, kind: 'diff', version, ...(options.deferrals ? { deferrals: options.deferrals } : {}) },
    concurrency: { key: `extract-page-${pageId}`, limit: 1 },
    ...(options.delaySeconds ? { delayInSeconds: options.delaySeconds } : {}),
  });
  return jobId;
}

const defaultTriggerDeps: TriggerDeps = { facts: sqlRepo, changes: sqlChangeRepo, enqueueDiff, ensure: ensureSchema };

/** Delay of a diff queued while the schema is not ready (migrations need a minute or two). */
export const SCHEMA_DEFER_SECONDS = 60;

export type TriggerOutcome = { status: 'queued'; jobId: string } | { status: 'deferred'; jobId: string } | { status: 'ignored'; reason: string };

/**
 * Queues a diff for a saved source page; no LLM here. Every other page, a repeat event and Ripple's own edits are
 * ignored. While the schema is not ready the source check cannot run, so the diff is queued with a delay instead of
 * dropping the edit: the consumer waits for the schema and skips pages that are not a source.
 */
export async function handlePageUpdate(update: PageUpdate, deps: TriggerDeps = defaultTriggerDeps): Promise<TriggerOutcome> {
  try {
    await deps.ensure();
  } catch (err) {
    if (!(err instanceof SchemaSettingUpError)) throw err;
    if (isRippleVersion(update.message)) return { status: 'ignored', reason: 'ripple edit' };
    return { status: 'deferred', jobId: await deps.enqueueDiff(update.pageId, update.version, { delaySeconds: SCHEMA_DEFER_SECONDS }) };
  }
  if (!(await deps.facts.getSource(update.pageId))) return { status: 'ignored', reason: 'not a source' };
  if (isRippleVersion(update.message)) return { status: 'ignored', reason: 'ripple edit' };
  const version = update.version;
  if (version !== null && !(await deps.changes.claimPageEvent(update.pageId, version))) return { status: 'ignored', reason: 'duplicate event' };
  try {
    return { status: 'queued', jobId: await deps.enqueueDiff(update.pageId, version) };
  } catch (err) {
    // Not queued: release the claim so a redelivered event is not taken for a duplicate.
    if (version !== null) {
      await deps.changes.releasePageEvent(update.pageId, version).catch((e: unknown) => console.warn('ripple trigger: claim release failed', { pageId: update.pageId, error: errorText(e) }));
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Diff consumer (`extract` queue, body `{ pageId, kind: 'diff', version }`)
// ---------------------------------------------------------------------------------------------------------------

export interface DiffDeps {
  facts: FactRepo;
  changes: ChangeRepo;
  page: (pageId: string) => Promise<SourcePage>;
  /** Space id of a copy page as the app; null when unreadable. */
  spaceOf: (pageId: string) => Promise<string | null>;
  llm?: ChatToolFn;
  ensure: () => Promise<void>;
}

const defaultDiffDeps: DiffDeps = { facts: sqlRepo, changes: sqlChangeRepo, page: getSourcePage, spaceOf: pageSpaceIdAsApp, ensure: ensureSchema };

/** Stored facts of the source with the text matching needs (key/origin from `storedFacts`, wording from `listFacts`). */
async function knownFacts(facts: FactRepo, pageId: string): Promise<KnownFact[]> {
  const views = new Map((await facts.listFacts(pageId)).map((f) => [f.id, f]));
  return (await facts.storedFacts(pageId)).flatMap((s) => {
    const v = views.get(s.id);
    return v ? [{ ...s, subject: v.subject, attribute: v.attribute, condition: v.condition, quote: v.quote }] : [];
  });
}

/**
 * Undoes confirmations that only reworded a value (detected before `factChanged` existed): the fact gets its old
 * value back and the copies that confirmation drifted are in sync again. Change rows and their audit stay; the undo
 * is audited (ids and counts only). Guarded in SQL, so it runs at most once per confirmation.
 */
async function revertWordingOnly(pageId: string, deps: DiffDeps): Promise<void> {
  const reverts = wordingOnlyReverts(await deps.changes.confirmedChanges(pageId));
  let facts = 0;
  let copies = 0;
  for (const r of reverts) {
    const done = await deps.changes.revertFactChange(pageId, r.change, r.copyIds, r.changeId);
    if (!done.reverted) continue;
    facts++;
    copies += done.copies;
    await deps.facts.audit('change.fact_reverted', null, 'change', r.changeId, {
      pageId,
      factId: r.change.factId,
      version: r.change.version,
      copies: done.copies,
      proposalsRejected: done.proposals ?? 0,
      reason: 'wording only',
    });
  }
  if (facts > 0) console.info('ripple diff: wording-only confirmations undone', { pageId, facts, copies });
}

export const MAX_DIFF_RETRIES = 4;
const backoff = (retryCount: number): number => 30 * 2 ** retryCount;

export type DiffOutcome =
  | { status: 'done'; changeId: string | null; changed: number; inserted: number; missing: number; copies: number }
  | { status: 'skipped'; reason: string }
  | { status: 'retry'; seconds: number; reason: string }
  | { status: 'failed'; error: string };

/**
 * Re-extracts the source's current version and records what changed. The source's facts are never deleted and a
 * confirmed value only changes when the owner confirms (`confirmChange`). The source keeps its state on failure
 * (its facts are still valid); the failure is logged.
 */
export async function runDiffJob(pageId: string, retryCount: number, deps: DiffDeps = defaultDiffDeps): Promise<DiffOutcome> {
  try {
    await deps.ensure();
  } catch (err) {
    if (err instanceof SchemaSettingUpError) return { status: 'retry', seconds: 60, reason: 'schema' };
    throw err;
  }
  const source = await deps.facts.getSource(pageId);
  if (!source) return { status: 'skipped', reason: 'not a source' };
  try {
    const page = await deps.page(pageId);
    // No skip on the latest version's message: a human edit (v5) followed by a Ripple edit (v6) before this job ran
    // would be lost. The trigger already drops Ripple's own events; a text identical to the last read is skipped below.
    if (source.pageVersion !== null && page.version <= source.pageVersion) return { status: 'skipped', reason: 'version already read' };
    // A failed undo never blocks change detection; it is tried again on the next version.
    try {
      await revertWordingOnly(pageId, deps);
    } catch (err) {
      console.warn('ripple diff: undoing wording-only confirmations failed', { pageId, error: errorText(err) });
    }
    const text = storageToText(page.body);
    const info: PageVersionInfo = { title: page.title, spaceId: page.spaceId, version: page.version, versionAt: page.versionCreatedAt, truncated: text.endsWith(TRUNCATED_MARK) };
    const hash = sha256(text);
    // Same text as the last diff (title or label edit only): no LLM call, the version is just marked as read.
    if ((await deps.changes.textHash(pageId)) === hash) {
      await deps.facts.finishExtraction(pageId, info);
      return { status: 'skipped', reason: 'text unchanged' };
    }
    // The stored facts are listed in the prompt so the model names the fact it re-reads (its wording may differ).
    const offered = offeredFacts(await knownFacts(deps.facts, pageId));
    const { args, model } = await runFactExtraction(text, { pageId, title: page.title }, deps.llm, offered);
    const parsed = parseExtraction(args, text);
    if (!(await deps.facts.getSource(pageId))) return { status: 'skipped', reason: 'unmarked during diff' };
    // Re-read: a review may have landed while the model ran.
    const known = await knownFacts(deps.facts, pageId);
    const match = matchFacts(known, parsed.facts, new Set(offered.map((f) => f.id)));
    const diff = planDiff(known, match.facts, page.version, page.versionCreatedAt, match.duplicates);
    // Values the owner already dismissed are not raised again (another value still is).
    const dismissed = await deps.changes.dismissedValues(pageId);
    const changes = diff.changes.filter((c) => !dismissed.has(dismissalKey(c.factId, valueHash(c.newValue, c.newUnit))));
    const base = { inserted: diff.merge.insert.length, missing: diff.missing.length };
    const log = {
      pageId,
      version: page.version,
      model,
      matchedById: match.byId,
      matchedByQuote: match.byQuote,
      matchedByKey: match.byKey,
      duplicatesRemoved: diff.merge.remove.length,
      dismissed: diff.changes.length - changes.length,
      ...base,
      dropped: parsed.dropped.length,
    };
    // Order matters for retries: the change is stored before the version is marked as read (`finishExtraction`), so
    // a failure in between re-reads the same version instead of skipping it as "already read".
    await deps.facts.applyMerge(pageId, diff.merge, info);
    if (changes.length === 0) {
      const superseded = await deps.changes.supersedePending(pageId);
      await deps.changes.setTextHash(pageId, hash);
      await deps.facts.finishExtraction(pageId, info);
      console.info('ripple diff done', { ...log, changed: 0, superseded });
      return { status: 'done', changeId: null, changed: 0, copies: 0, ...base };
    }
    const copies = await deps.changes.copiesForFacts(
      pageId,
      changes.map((c) => c.factId),
    );
    const affectedPages = [...new Set(copies.filter((c) => c.status === 'in_sync' || c.status === 'drifted' || c.status === 'updated').map((c) => c.pageId))];
    const spaces = await mapLimit(affectedPages, LOOKUP_CONCURRENCY, deps.spaceOf);
    const impact = computeImpact(changes, copies, new Map(affectedPages.map((id, i) => [id, spaces[i] ?? null])));
    const { id: changeId, replaced } = await deps.changes.savePending(pageId, page.version, changes, diff.missing, impact);
    await deps.facts.audit('change.detected', null, 'page', pageId, { changeId, version: page.version, facts: changes.length, missing: diff.missing.length, copies: impact.copies.length, replaced });
    await deps.changes.setTextHash(pageId, hash);
    await deps.facts.finishExtraction(pageId, info);
    console.info('ripple diff done', {
      ...log,
      changeId,
      changed: changes.length,
      replaced,
      copies: impact.copies.length,
      pages: new Set(impact.copies.map((c) => c.pageId)).size,
      alreadyNew: impact.alreadyNew,
      unsure: impact.unsure,
      historical: impact.historical,
      needsCheck: impact.needsCheck,
    });
    return { status: 'done', changeId, changed: changes.length, copies: impact.copies.length, ...base };
  } catch (err) {
    if (retryCount < MAX_DIFF_RETRIES) {
      if (isLlmRateLimited(err)) return { status: 'retry', seconds: backoff(retryCount), reason: 'llm-rate-limited' };
      if (err instanceof ConfluenceRetryableError) return { status: 'retry', seconds: backoff(retryCount), reason: `confluence-http-${err.status}` };
      if (isSqlRateLimited(err)) return { status: 'retry', seconds: 60, reason: 'sql-rate-limited' };
    }
    const error =
      err instanceof PageNotFoundError ? 'page not readable' : err instanceof LlmOutputError ? `unusable model answer: ${errorText(err)}` : errorText(err);
    console.warn('ripple diff failed', { pageId, error });
    return { status: 'failed', error };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Resolvers (as the user)
// ---------------------------------------------------------------------------------------------------------------

export interface ChangeDeps {
  facts: FactRepo;
  changes: ChangeRepo;
  canEdit: (pageId: string) => Promise<boolean>;
  visible: (pageIds: readonly string[]) => Promise<Set<string>>;
  pageMeta: (pageId: string) => Promise<PageMeta>;
  names: (accountIds: readonly string[]) => Promise<Map<string, string>>;
  graph: (cloudId: string) => GraphRequest;
  ensure: () => Promise<void>;
  now: () => Date;
  /** M4: queues the edit proposals of a confirmed change (`extract` queue, `kind: 'propose'`). */
  enqueuePropose?: (sourcePageId: string, changeId: string) => Promise<string>;
  /** M4: open proposals of older changes of these facts are rejected (`superseded`) once a newer change is confirmed. */
  supersedeProposals?: (sourcePageId: string, changeId: string, factIds: readonly string[]) => Promise<number>;
}

const defaultDeps: ChangeDeps = {
  facts: sqlRepo,
  changes: sqlChangeRepo,
  canEdit: canEditPage,
  visible: visiblePageIds,
  pageMeta: fetchPageMeta,
  names: (ids) => displayNames(ids),
  graph: asUserGraph,
  ensure: ensureSchema,
  now: () => new Date(),
  enqueuePropose: async (sourcePageId, changeId) => {
    const { jobId } = await extractQueue.push({ body: { pageId: sourcePageId, kind: 'propose', changeId }, concurrency: { key: `extract-page-${sourcePageId}`, limit: 1 } });
    return jobId;
  },
  supersedeProposals: (sourcePageId, changeId, factIds) => sqlProposalRepo.supersedeOlder(sourcePageId, changeId, factIds),
};

export type ChangeContext = SourceContext & { cloudId?: string };

function pageIdOf(ctx: ChangeContext): string | undefined {
  const id = ctx.extension?.content?.id;
  return id === undefined || String(id) === '' ? undefined : String(id);
}

async function guarded<T>(ctx: ChangeContext, deps: Pick<ChangeDeps, 'ensure'>, what: string, body: (pageId: string) => Promise<T | ErrorReply>): Promise<T | ErrorReply> {
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

/** Byline flag; null when nothing waits or the lookup fails (the byline never fails because of it). */
export async function pendingChangeFlag(pageId: string, changes: ChangeRepo = sqlChangeRepo): Promise<PendingChangeFlag | null> {
  try {
    const c = await changes.pendingChange(pageId);
    return c ? { id: c.id, facts: c.factChanges.length } : null;
  } catch (err) {
    console.warn('ripple byline: pending change lookup failed', { pageId, error: errorText(err) });
    return null;
  }
}

interface Summary {
  view: PendingChangeView;
  routing: ChangeRouting;
}

const NO_OWNER: OwnerView = { accountId: null, role: null, displayName: null, errors: [] };

/**
 * The change as the viewer may see it: copies on pages they cannot open are one count; owners and teams resolved.
 * `allPages` (confirm): the routing covers every affected page, also those the confirming user cannot open (their
 * owner lookup fails as the user and is recorded as an owner error); the view is not returned to the user then.
 */
async function summarise(ctx: ChangeContext, pageId: string, change: ChangeRow, canDecide: boolean, deps: ChangeDeps, allPages = false): Promise<Summary> {
  const facts = new Map((await deps.facts.listFacts(pageId)).map((f) => [f.id, f]));
  const factViews: FactChangeView[] = change.factChanges.map((c) => {
    const f = facts.get(c.factId);
    return {
      factId: c.factId,
      factLabel: f ? [f.subject, f.attribute, f.condition].filter(Boolean).join(' · ') : 'Fact',
      oldValue: c.oldValue,
      oldUnit: c.oldUnit,
      newValue: c.newValue,
      newUnit: c.newUnit,
      newQuote: c.newQuote,
    };
  });
  const impact = change.impact ?? { copies: [], alreadyNew: 0, syncCopyIds: [], unsure: 0, historical: 0, needsCheck: 0 };
  const affected = [...new Set(impact.copies.map((c) => c.pageId))];
  const seen = allPages ? new Set(affected) : affected.length > 0 ? await deps.visible(affected) : new Set<string>();
  const visibleCopies = impact.copies.filter((c) => seen.has(c.pageId));
  const hiddenCount = impact.copies.length - visibleCopies.length;
  const pageIds = affected.filter((id) => seen.has(id));
  const titles = new Map(
    (
      await deps.changes.copiesForFacts(
        pageId,
        change.factChanges.map((c) => c.factId),
      )
    ).map((c) => [c.pageId, { title: c.pageTitle, url: c.pageUrl }]),
  );
  // Owners (REST v2 as the viewer), capped; one users-bulk call for the names.
  const metas = await mapLimit(pageIds.slice(0, MAX_OWNER_LOOKUPS), LOOKUP_CONCURRENCY, async (id) => {
    try {
      return { meta: await deps.pageMeta(id), error: null };
    } catch (err) {
      return { meta: null, error: errorText(err) };
    }
  });
  const firstOwner = metas.map((m) => (m.meta ? ownersFromPage(m.meta)[0] : undefined));
  let names = new Map<string, string>();
  const ids = firstOwner.filter((o): o is NonNullable<typeof o> => o !== undefined).map((o) => o.accountId);
  if (ids.length > 0) {
    try {
      names = await deps.names(ids);
    } catch (err) {
      console.warn('ripple change: owner names failed', { pageId, error: errorText(err) });
    }
  }
  const pages: ChangePageView[] = pageIds.map((id, i) => {
    const m = metas[i];
    const o = firstOwner[i];
    const spaceId = visibleCopies.find((c) => c.pageId === id)?.spaceId ?? m?.meta?.spaceId ?? null;
    const owner: OwnerView = o
      ? { accountId: o.accountId, role: o.role, displayName: names.get(o.accountId) ?? null, errors: [] }
      : m?.error
        ? { ...NO_OWNER, errors: [m.error] }
        : m
          ? { ...NO_OWNER, errors: ['page has no owner or author'] }
          : NO_OWNER;
    return { pageId: id, pageTitle: titles.get(id)?.title ?? null, pageUrl: titles.get(id)?.url ?? null, spaceId, copies: visibleCopies.filter((c) => c.pageId === id).length, owner };
  });
  const spaceIds = [...new Set(pages.map((p) => p.spaceId).filter((s): s is string => s !== null))].sort();
  // A failed read (request error or GraphQL errors without teams) is `unknown`, never "no team linked". At confirm
  // (`allPages`) such a space is read once more; still failing, the routing records it as unknown without team ids.
  const teamsOf = async (cloudId: string, spaceId: string): Promise<ChangeSpaceView> => {
    try {
      const read = await readSpaceTeams(deps.graph(cloudId), cloudId, spaceId);
      if (read.teams.length > 0) return { spaceId, teams: read.teams, teamSource: 'teamwork_graph' };
      return { spaceId, teams: [], teamSource: read.errors.length > 0 || !read.dataPresent ? 'unknown' : 'none' };
    } catch (err) {
      console.warn('ripple change: space teams failed', { pageId, error: errorText(err) });
      return { spaceId, teams: [], teamSource: 'unknown' };
    }
  };
  const spaces: ChangeSpaceView[] = await mapLimit(spaceIds, LOOKUP_CONCURRENCY, async (spaceId) => {
    if (!ctx.cloudId) return { spaceId, teams: [], teamSource: 'unknown' };
    const first = await teamsOf(ctx.cloudId, spaceId);
    return first.teamSource === 'unknown' && allPages ? teamsOf(ctx.cloudId, spaceId) : first;
  });
  const now = deps.now();
  const view: PendingChangeView = {
    id: change.id,
    version: change.pageVersion,
    detectedAt: change.createdAt,
    facts: factViews,
    missingFacts: change.missingFactIds.length,
    copies: visibleCopies.length,
    pages,
    hiddenCount,
    unsure: impact.unsure,
    historical: impact.historical,
    needsCheck: impact.needsCheck ?? 0,
    alreadyNew: impact.alreadyNew,
    spaces,
    defaultDeadlineDays: DEFAULT_DEADLINE_DAYS,
    defaultDeadline: addWorkingDays(now, DEFAULT_DEADLINE_DAYS),
    canDecide,
  };
  const routing: ChangeRouting = {
    deadline: view.defaultDeadline,
    pages: pages.map((p) => ({ pageId: p.pageId, spaceId: p.spaceId, ownerAccountId: p.owner.accountId, ownerRole: p.owner.role, copies: p.copies })),
    spaces: spaces.map((s) => ({ spaceId: s.spaceId, teamIds: s.teams.map((t) => t.id), teamSource: s.teamSource })),
  };
  return { view, routing };
}

/** The pending change of the viewed source (anyone who can open the page may read it), or null. */
export async function getPendingChange(ctx: ChangeContext, deps: ChangeDeps = defaultDeps): Promise<PendingChangeReply | ErrorReply> {
  return guarded(ctx, deps, 'load the pending change', async (pageId) => {
    const change = await deps.changes.pendingChange(pageId);
    if (!change) return { pageId, change: null };
    const { view } = await summarise(ctx, pageId, change, await deps.canEdit(pageId), deps);
    return { pageId, change: view };
  });
}

/**
 * The most recently confirmed change of the viewed source (the Rollout tab), or null. Anyone who can open the page
 * may read it; ids and version only.
 */
export async function getLatestChange(ctx: ChangeContext, deps: Pick<ChangeDeps, 'changes' | 'ensure'> = defaultDeps): Promise<LatestChangeReply | ErrorReply> {
  return guarded(ctx, deps, 'load the latest change', async (pageId) => {
    const latest = (await deps.changes.confirmedChanges(pageId))[0];
    return { pageId, change: latest ? { changeId: latest.id, version: latest.pageVersion } : null };
  });
}

/** Checks the payload and edit permission and loads the change of the viewed page (any status). */
async function decidable(
  ctx: ChangeContext,
  deps: ChangeDeps,
  pageId: string,
  payload: Partial<ChangeIdPayload> | undefined,
): Promise<{ change: ChangeRow; actor: string; version: number } | ErrorReply> {
  const changeId = typeof payload?.changeId === 'string' ? payload.changeId : '';
  if (!UUID.test(changeId)) return { error: 'Missing or invalid change id.' };
  const version = payload?.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return { error: 'Missing or invalid page version.' };
  if (!ctx.accountId || !(await deps.canEdit(pageId))) return { error: NOT_ALLOWED };
  const change = await deps.changes.getChange(changeId);
  // The page id comes from the context: a change of another source is "gone" here.
  if (!change || change.sourcePageId !== pageId) return { error: GONE };
  return { change, actor: ctx.accountId, version };
}

/** Why a decision did not apply: the reviewed change was replaced by a newer version (review again), or it is gone. */
const notDecidable = (change: ChangeRow | undefined, version: number): ErrorReply => ({ error: change?.status === 'pending' && change.pageVersion !== version ? STALE : GONE });

const count = <T extends string>(values: readonly T[]): Record<string, number> => values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});

/**
 * FR-7 confirmation by an editor of the source, for the version they reviewed: the status flip (guarded by that
 * version) decides the race first, then the facts take their new values (old value kept) and copies stating the old
 * value count as drifted. The routing (owners, teams, deadline) covers every affected copy, also on pages the user
 * cannot open, for M4's edit proposals. Repeat-safe: confirming an already confirmed change of the same version
 * (e.g. after a failure halfway) finishes the fact and copy updates and succeeds.
 */
export async function confirmChange(ctx: ChangeContext, payload: Partial<ConfirmChangePayload> | undefined, deps: ChangeDeps = defaultDeps): Promise<ChangeDecision | ErrorReply> {
  const days = payload?.deadlineDays ?? DEFAULT_DEADLINE_DAYS;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DEADLINE_DAYS) return { error: `The deadline must be 1 to ${MAX_DEADLINE_DAYS} working days.` };
  return guarded(ctx, deps, 'confirm the change', async (pageId) => {
    const r = await decidable(ctx, deps, pageId, payload);
    if ('error' in r) return r;
    const { actor, version } = r;
    let change = r.change;
    let transitioned = false;
    let routing: ChangeRouting | null = change.routing;
    if (change.status === 'pending' && change.pageVersion === version) {
      const { routing: base } = await summarise(ctx, pageId, change, true, deps, true);
      routing = { ...base, deadline: addWorkingDays(deps.now(), days) };
      transitioned = await deps.changes.decide(change.id, version, 'confirmed', actor, days, routing);
      if (!transitioned) {
        const now = await deps.changes.getChange(change.id);
        if (!now || now.status !== 'confirmed' || now.pageVersion !== version) return notDecidable(now, version);
        change = now;
        routing = now.routing;
      }
    } else if (change.status !== 'confirmed' || change.pageVersion !== version) return notDecidable(change, version);
    // Facts (guarded by their old value, so a repeat is a no-op), then the copies of every fact that now holds the
    // new value: also those applied by an earlier, interrupted call.
    let factsUpdated = 0;
    for (const c of change.factChanges) if (await deps.changes.applyFactChange(pageId, c)) factsUpdated++;
    const current = new Map((await deps.facts.listFacts(pageId)).map((f) => [f.id, f]));
    const applied = new Set(change.factChanges.filter((c) => current.get(c.factId)?.status === 'confirmed' && current.get(c.factId)?.value === c.newValue).map((c) => c.factId));
    const impact = change.impact;
    const toDrift = (impact?.copies ?? []).filter((c) => (c.status === 'in_sync' || c.status === 'updated') && applied.has(c.factId)).map((c) => c.copyId);
    const copiesDrifted = await deps.changes.restatusCopies(toDrift, impact?.syncCopyIds ?? []);
    const pages = routing?.pages ?? [];
    const spaces = routing?.spaces ?? [];
    if (transitioned || factsUpdated > 0) {
      await deps.facts.audit('change.confirmed', actor, 'change', change.id, {
        pageId,
        version: change.pageVersion,
        facts: change.factChanges.length,
        factsUpdated,
        copies: impact?.copies.length ?? 0,
        pages: pages.length,
        deadlineDays: change.deadlineDays ?? days,
        ownerSource: count(pages.map((p) => p.ownerRole ?? 'none')),
        teamSource: count(spaces.map((s) => s.teamSource)),
        repeat: !transitioned,
      });
    }
    // M4: proposals of older changes of these facts would write a replaced value.
    let proposalsSuperseded = 0;
    if (deps.supersedeProposals && applied.size > 0) proposalsSuperseded = await deps.supersedeProposals(pageId, change.id, [...applied]);
    if (proposalsSuperseded > 0) await deps.facts.audit('proposal.superseded', actor, 'change', change.id, { pageId, proposals: proposalsSuperseded });
    // M4: edit proposals per copy (idempotent per change and copy, so a repeated confirm queues a no-op).
    let proposeJob: string | null = null;
    if ((impact?.copies.length ?? 0) > 0 && deps.enqueuePropose) {
      try {
        proposeJob = await deps.enqueuePropose(pageId, change.id);
      } catch (err) {
        console.warn('ripple change: proposals not queued (confirm again to retry)', { pageId, changeId: change.id, error: errorText(err) });
      }
    }
    console.info('ripple change confirmed', { pageId, changeId: change.id, repeat: !transitioned, factsUpdated, copiesDrifted, pages: pages.length, spaces: spaces.length, proposeJob });
    return { changeId: change.id, status: 'confirmed', factsUpdated, copiesDrifted, deadline: routing?.deadline ?? null };
  });
}

/**
 * The editor decides the change (the version they reviewed) should not propagate; facts keep their confirmed values
 * and the dismissed values are remembered so a later edit of the page does not raise them again.
 */
export async function dismissChange(ctx: ChangeContext, payload: Partial<ChangeIdPayload> | undefined, deps: ChangeDeps = defaultDeps): Promise<ChangeDecision | ErrorReply> {
  return guarded(ctx, deps, 'dismiss the change', async (pageId) => {
    const r = await decidable(ctx, deps, pageId, payload);
    if ('error' in r) return r;
    const { change, actor, version } = r;
    if (change.status !== 'pending' || change.pageVersion !== version) return notDecidable(change, version);
    if (!(await deps.changes.decide(change.id, version, 'dismissed', actor, null, null))) return notDecidable(await deps.changes.getChange(change.id), version);
    await deps.changes.saveDismissals(pageId, change.factChanges);
    await deps.facts.audit('change.dismissed', actor, 'change', change.id, { pageId, version: change.pageVersion, facts: change.factChanges.length });
    console.info('ripple change dismissed', { pageId, changeId: change.id });
    return { changeId: change.id, status: 'dismissed', factsUpdated: 0, copiesDrifted: 0, deadline: null };
  });
}
