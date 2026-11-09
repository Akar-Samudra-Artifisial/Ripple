/**
 * M1: source of truth (FR-1), fact extraction (FR-2) and fact review (FR-3). Resolvers check the viewer's edit
 * permission on the page server-side and only touch SQL and the queue; the LLM runs in the `extract` consumer.
 */
import { Queue } from '@forge/events';
import { canEditPage, ConfluenceRetryableError, getSourcePage, PageNotFoundError, type SourcePage } from '../adapters/confluence';
import { pageJobKey } from '../adapters/jobKeys';
import { sqlRepo, type FactRepo, type PageVersionInfo } from '../adapters/repo';
import { ensureSchema } from '../adapters/sql';
import { scrubErrorText } from '../adapters/teamworkGraph';
import { cleanEdit, parseExtraction, planMerge } from '../core/facts';
import { storageToText, TRUNCATED_MARK } from '../core/pageText';
import { isSqlRateLimited, SchemaSettingUpError } from '../core/schema';
import type { ErrorReply, FactActionResult, FactEditPayload, FactIdPayload, FactList, FactStatus, SourceStatus } from '../core/views';
import { isLlmRateLimited, LlmOutputError } from '../llm';
import { runFactExtraction, type ChatToolFn } from '../llm/extract';

export const EXTRACT_QUEUE = 'extract';

export interface SourceContext {
  accountId?: string;
  extension?: { content?: { id?: string | number; title?: string }; space?: { id?: string | number } };
}

export interface SourceDeps {
  repo: FactRepo;
  canEdit: (pageId: string) => Promise<boolean>;
  /** Pushes an extraction job for the page; returns the job id. */
  enqueue: (pageId: string) => Promise<string>;
  ensure: () => Promise<void>;
}

const extractQueue = new Queue({ key: EXTRACT_QUEUE });

const defaultDeps: SourceDeps = {
  repo: sqlRepo,
  canEdit: canEditPage,
  enqueue: async (pageId) => {
    // One extraction per page at a time; a second mark waits for the first job. Keys span all queues of the install.
    const { jobId } = await extractQueue.push({ body: { pageId }, concurrency: { key: pageJobKey(pageId), limit: 1 } });
    return jobId;
  },
  ensure: ensureSchema,
};

const errorText = (err: unknown): string => scrubErrorText(err instanceof Error ? err.message : String(err));

const NOT_ALLOWED = 'You need edit permission on this page to do that.';
const EMPTY_COUNTS = { proposed: 0, confirmed: 0, rejected: 0 };

function pageIdOf(ctx: SourceContext): string | undefined {
  const id = ctx.extension?.content?.id;
  return id === undefined || String(id) === '' ? undefined : String(id);
}

/** Runs a resolver body: schema guard, page id from the context, scrubbed errors as `{ error }`. */
async function guarded<T>(ctx: SourceContext, deps: SourceDeps, what: string, body: (pageId: string) => Promise<T | ErrorReply>): Promise<T | ErrorReply> {
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

async function statusOf(pageId: string, canEdit: boolean, deps: SourceDeps): Promise<SourceStatus> {
  const source = (await deps.repo.getSource(pageId)) ?? null;
  const counts = source ? await deps.repo.countFacts(pageId) : EMPTY_COUNTS;
  return { pageId, canEdit, source, counts, notice: null };
}

/** Polled by the byline while `source.state` is `extracting`. A schema still being set up is a notice, not an error. */
export async function getSourceStatus(ctx: SourceContext, deps: SourceDeps = defaultDeps): Promise<SourceStatus | ErrorReply> {
  const pageId = pageIdOf(ctx);
  if (!pageId) return { error: 'Open a Confluence page to use Ripple.' };
  try {
    await deps.ensure();
    return await statusOf(pageId, await deps.canEdit(pageId), deps);
  } catch (err) {
    if (err instanceof SchemaSettingUpError) return { pageId, canEdit: false, source: null, counts: EMPTY_COUNTS, notice: err.message };
    console.warn('ripple load the source status failed', { pageId, error: errorText(err) });
    return { error: `Ripple could not load the source status: ${errorText(err)}` };
  }
}

/** FR-1: mark the page as source of truth (or re-extract it) and queue extraction. Edit permission required. */
export async function markSource(ctx: SourceContext, deps: SourceDeps = defaultDeps): Promise<SourceStatus | ErrorReply> {
  return guarded(ctx, deps, 'mark the page', async (pageId) => {
    if (!ctx.accountId || !(await deps.canEdit(pageId))) return { error: NOT_ALLOWED };
    const spaceId = ctx.extension?.space?.id;
    const title = ctx.extension?.content?.title;
    await deps.repo.markSource({ pageId, spaceId: spaceId === undefined ? null : String(spaceId), title: title ? title.slice(0, 255) : null, accountId: ctx.accountId });
    let jobId: string;
    try {
      jobId = await deps.enqueue(pageId);
    } catch (err) {
      // Without a job nothing would ever leave `extracting`; show the failure so the user can retry.
      const error = `Could not start the extraction: ${errorText(err)}`;
      console.warn('ripple mark: enqueue failed', { pageId, error });
      await deps.repo.failExtraction(pageId, error);
      return { error: `${error}. Try again in a minute.` };
    }
    await deps.repo.setExtractJob(pageId, jobId);
    await deps.repo.audit('source.marked', ctx.accountId, 'page', pageId, { jobId });
    console.info('ripple source marked', { pageId, jobId });
    return statusOf(pageId, true, deps);
  });
}

/** FR-1: release the source-of-truth status; its facts are deleted. Edit permission required. */
export async function unmarkSource(ctx: SourceContext, deps: SourceDeps = defaultDeps): Promise<SourceStatus | ErrorReply> {
  return guarded(ctx, deps, 'unmark the page', async (pageId) => {
    if (!ctx.accountId || !(await deps.canEdit(pageId))) return { error: NOT_ALLOWED };
    const counts = await deps.repo.countFacts(pageId);
    await deps.repo.unmarkSource(pageId);
    await deps.repo.audit('source.unmarked', ctx.accountId, 'page', pageId, { ...counts });
    console.info('ripple source unmarked', { pageId });
    return statusOf(pageId, true, deps);
  });
}

/** FR-3: facts of the page being viewed (anyone who can open the page may read them). */
export async function listFacts(ctx: SourceContext, deps: SourceDeps = defaultDeps): Promise<FactList | ErrorReply> {
  return guarded(ctx, deps, 'load the facts', async (pageId) => ({ pageId, facts: await deps.repo.listFacts(pageId) }));
}

/** Loads a fact of the viewed page and checks the reviewer may edit that page. */
async function reviewable(ctx: SourceContext, deps: SourceDeps, pageId: string, payload: Partial<FactIdPayload> | undefined) {
  const factId = typeof payload?.factId === 'string' ? payload.factId : '';
  if (!/^[0-9a-f-]{36}$/i.test(factId)) return { error: 'Missing or invalid fact id.' } as ErrorReply;
  if (!ctx.accountId || !(await deps.canEdit(pageId))) return { error: NOT_ALLOWED } as ErrorReply;
  const fact = await deps.repo.getFact(factId);
  // A fact of another page is "not found" here: the page id comes from the context, never from the payload.
  if (!fact || fact.sourcePageId !== pageId) return { error: 'That fact no longer exists. Reload the list.' } as ErrorReply;
  return { fact, actor: ctx.accountId };
}

async function review(ctx: SourceContext, deps: SourceDeps, payload: Partial<FactIdPayload> | undefined, status: FactStatus): Promise<FactActionResult | ErrorReply> {
  const verb = status === 'confirmed' ? 'confirm' : 'reject';
  return guarded(ctx, deps, `${verb} the fact`, async (pageId) => {
    const r = await reviewable(ctx, deps, pageId, payload);
    if ('error' in r) return r;
    await deps.repo.setFactStatus(r.fact.id, status, r.actor);
    await deps.repo.audit(`fact.${status}`, r.actor, 'fact', r.fact.id, { pageId, from: r.fact.status });
    const fact = await deps.repo.getFact(r.fact.id);
    return fact ? { fact } : { error: 'That fact no longer exists. Reload the list.' };
  });
}

export const confirmFact = (ctx: SourceContext, payload: Partial<FactIdPayload> | undefined, deps: SourceDeps = defaultDeps) => review(ctx, deps, payload, 'confirmed');
/** "Hapus" in the PRD: the fact is kept as `rejected` so the next extraction does not propose it again. */
export const rejectFact = (ctx: SourceContext, payload: Partial<FactIdPayload> | undefined, deps: SourceDeps = defaultDeps) => review(ctx, deps, payload, 'rejected');

/** FR-3 edit: the reviewer's values win over later extractions; an edited fact counts as confirmed. */
export async function editFact(ctx: SourceContext, payload: Partial<FactEditPayload> | undefined, deps: SourceDeps = defaultDeps): Promise<FactActionResult | ErrorReply> {
  return guarded(ctx, deps, 'edit the fact', async (pageId) => {
    const r = await reviewable(ctx, deps, pageId, payload);
    if ('error' in r) return r;
    const edit = cleanEdit(payload);
    if ('error' in edit) return edit;
    if (!(await deps.repo.editFact(r.fact.id, pageId, edit, r.actor))) {
      return { error: 'Another fact on this page already has the same subject, attribute and condition.' };
    }
    await deps.repo.audit('fact.edited', r.actor, 'fact', r.fact.id, { pageId, valueChanged: edit.value !== r.fact.value });
    const fact = await deps.repo.getFact(r.fact.id);
    return fact ? { fact } : { error: 'That fact no longer exists. Reload the list.' };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// `extract` queue consumer
// ---------------------------------------------------------------------------------------------------------------

export interface ExtractDeps {
  repo: FactRepo;
  page: (pageId: string) => Promise<SourcePage>;
  llm?: ChatToolFn;
  ensure: () => Promise<void>;
}

const defaultExtractDeps: ExtractDeps = { repo: sqlRepo, page: getSourcePage, ensure: ensureSchema };

/** Queue retries for transient failures (LLM/SQL rate limit, Confluence 429/5xx) before the source is marked failed. */
export const MAX_RETRIES = 4;

const backoff = (retryCount: number): number => 30 * 2 ** retryCount;

export type ExtractOutcome =
  | { status: 'done'; facts: number; inserted: number; updated: number; removed: number; dropped: number }
  | { status: 'skipped'; reason: string }
  | { status: 'retry'; seconds: number; reason: string }
  | { status: 'failed'; error: string };

/**
 * Reads the page as the app, asks the LLM for facts, keeps only facts whose quote is found verbatim in the page text
 * and merges them with the stored facts. The caller turns `retry` into an `InvocationError`.
 */
export async function runExtractJob(pageId: string, retryCount: number, deps: ExtractDeps = defaultExtractDeps): Promise<ExtractOutcome> {
  try {
    await deps.ensure();
  } catch (err) {
    if (err instanceof SchemaSettingUpError) return { status: 'retry', seconds: 60, reason: 'schema' };
    throw err;
  }
  if (!(await deps.repo.getSource(pageId))) return { status: 'skipped', reason: 'not a source (unmarked)' };
  try {
    const page = await deps.page(pageId);
    const text = storageToText(page.body);
    const { args, model } = await runFactExtraction(text, { pageId, title: page.title }, deps.llm);
    const parsed = parseExtraction(args, text);
    // The page may have been unmarked while the LLM ran: do not write facts for a page that is no longer a source.
    if (!(await deps.repo.getSource(pageId))) return { status: 'skipped', reason: 'unmarked during extraction' };
    const plan = planMerge(await deps.repo.storedFacts(pageId), parsed.facts);
    const info: PageVersionInfo = {
      title: page.title,
      spaceId: page.spaceId,
      version: page.version,
      versionAt: page.versionCreatedAt,
      truncated: text.endsWith(TRUNCATED_MARK),
    };
    await deps.repo.applyMerge(pageId, plan, info);
    if (!(await deps.repo.getSource(pageId))) {
      // Unmarked between the check and the writes: remove what this run just wrote (unmark is idempotent).
      await deps.repo.unmarkSource(pageId);
      return { status: 'skipped', reason: 'unmarked during extraction' };
    }
    await deps.repo.finishExtraction(pageId, info);
    const outcome = { status: 'done', facts: parsed.facts.length, inserted: plan.insert.length, updated: plan.update.length, removed: plan.remove.length, dropped: parsed.dropped.length } as const;
    const reasons = parsed.dropped.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.reason]: (acc[d.reason] ?? 0) + 1 }), {});
    console.info('ripple extract done', { pageId, version: page.version, model, ...outcome, droppedReasons: reasons });
    await deps.repo.audit('source.extracted', null, 'page', pageId, { version: page.version, facts: outcome.facts, dropped: outcome.dropped });
    return outcome;
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      if (isLlmRateLimited(err)) return { status: 'retry', seconds: backoff(retryCount), reason: 'llm-rate-limited' };
      if (err instanceof ConfluenceRetryableError) return { status: 'retry', seconds: backoff(retryCount), reason: `confluence-http-${err.status}` };
      if (isSqlRateLimited(err)) return { status: 'retry', seconds: 60, reason: 'sql-rate-limited' };
    }
    const error =
      err instanceof PageNotFoundError
        ? 'The page could not be read (deleted or not visible to Ripple).'
        : err instanceof LlmOutputError
          ? `The extraction model gave an unusable answer: ${errorText(err)}`
          : isLlmRateLimited(err)
            ? 'The extraction model is busy; mark the page again later.'
            : err instanceof ConfluenceRetryableError
              ? `Confluence did not answer (HTTP ${err.status}); mark the page again later.`
              : errorText(err);
    console.warn('ripple extract failed', { pageId, error });
    await deps.repo.failExtraction(pageId, error);
    return { status: 'failed', error };
  }
}
