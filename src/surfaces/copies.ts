/**
 * M2: copies of a source's facts on other pages (FR-4..6).
 *
 * Resolvers (`startScan`, `getScanStatus`, `listCopies`) only touch SQL and the queue. The `search` consumer runs
 * CQL per confirmed fact (ids fixed when the scan starts) as the app (a consumer has no user) and stores up to 200
 * candidate pages per fact; the `judge` consumer reads candidate pages as the app in small batches, sends only the
 * chunks that mention a fact to the LLM (a few at a time, capped per scan) and stores one status per fact and page.
 * Both resume from the last finished batch (cursor / pending hits / saved chunk results in Forge SQL) when re-queued,
 * retried or resumed by `startScan`. Because the app sees more than a given user, the resolvers list and count by
 * status only copies on pages the viewer can open (CQL as the user); the rest is one total (NFR-3).
 */
import { createHash } from 'node:crypto';
import { Queue } from '@forge/events';
import { canEditPage, ConfluenceRetryableError, getSourcePage, PageNotFoundError, searchPagesAsApp, visiblePageIds, type SearchHit, type SourcePage } from '../adapters/confluence';
import { sqlRepo, type FactRepo } from '../adapters/repo';
import { ALL_FILTER_STATUSES, EMPTY_COPY_COUNTS, sqlScanRepo, type ChunkResult, type CopyInput, type PendingPage, type ScanRepo, type ScanRow } from '../adapters/scanRepo';
import { ensureSchema } from '../adapters/sql';
import { scrubErrorText } from '../adapters/teamworkGraph';
import {
  buildCql,
  chunkPage,
  factTerms,
  judgeOutcome,
  MAX_CANDIDATES_PER_FACT,
  MAX_COPY_PAGE_CHARS,
  parseJudgement,
  parseTermSuggestions,
  settleSiblings,
  siblingsOf,
  strongest,
  type Chunk,
  type PageMention,
  type ScanFact,
} from '../core/copies';
import { identityKey } from '../core/facts';
import { storageToText } from '../core/pageText';
import { isSqlRateLimited, SchemaSettingUpError, sqlErrorInfo, type SqlErrorInfo } from '../core/schema';
import { COPY_STATUSES, type CopyList, type CopyListPayload, type CopyStatus, type ErrorReply, type ScanStatus, type ScanView } from '../core/views';
import { isLlmApiError, isLlmRateLimited, isLlmRetryable, LlmOutputError } from '../llm';
import type { ChatToolFn } from '../llm/extract';
import { judgeChunk, suggestSearchTerms } from '../llm/judge';
import type { SourceContext } from './sources';

export const SEARCH_QUEUE = 'search';
export const JUDGE_QUEUE = 'judge';
export type ScanQueue = typeof SEARCH_QUEUE | typeof JUDGE_QUEUE;

/** Candidate pages read per `pendingPages` call in the judge consumer. */
export const PAGES_PER_BATCH = 5;
/** Judge calls in flight at once for one page (keeps a burst of chunks below the LLM rate limit). */
export const JUDGE_CONCURRENCY = 2;
/** LLM calls per scan (synonyms + judge), across all runs. When reached the scan ends as `partial`. */
export const MAX_LLM_CALLS_PER_SCAN = 300;
/** Work per consumer run before it re-queues itself (the consumer timeout is 900 s). */
export const RUN_BUDGET_MS = 10 * 60 * 1000;
/** Queue retries for transient failures (LLM 429/5xx, SQL rate limit, Confluence 429/5xx) before the scan fails. */
export const MAX_RETRIES = 4;
const backoff = (retryCount: number): number => 30 * 2 ** retryCount;

const queues: Record<ScanQueue, Queue> = { search: new Queue({ key: SEARCH_QUEUE }), judge: new Queue({ key: JUDGE_QUEUE }) };

/** One run per scan at a time, across both queues (concurrency keys span all queues of the install). */
async function pushScan(queue: ScanQueue, scanId: string): Promise<string> {
  const { jobId } = await queues[queue].push({ body: { scanId }, concurrency: { key: `scan-${scanId}`, limit: 1 } });
  return jobId;
}

const errorText = (err: unknown): string => scrubErrorText(err instanceof Error ? err.message : String(err));
/** Operation + MySQL error code of a failed statement for logs, with the message scrubbed too. */
const sqlDetails = (err: unknown): SqlErrorInfo | undefined => {
  const info = sqlErrorInfo(err);
  return info?.sqlMessage ? { ...info, sqlMessage: scrubErrorText(info.sqlMessage) } : info;
};
const NOT_ALLOWED = 'You need edit permission on this page to do that.';

/** Confirmed facts of the source, in a stable order (by id). */
async function scanFactsOf(facts: FactRepo, sourcePageId: string): Promise<ScanFact[]> {
  // listFacts keeps the insert (extraction) order within a status: that is the fact's order in the source.
  return (await facts.listFacts(sourcePageId))
    .filter((f) => f.status === 'confirmed')
    .map((f, order) => ({ id: f.id, type: f.type, subject: f.subject, attribute: f.attribute, value: f.value, unit: f.unit, condition: f.condition, previousValue: f.previousValue, order }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const scanView = (s: ScanRow): ScanView => ({
  id: s.id,
  state: s.state,
  stalled: s.stalled,
  factsTotal: s.factsTotal,
  factsSearched: s.factsSearched,
  candidates: s.candidates,
  pagesJudged: s.pagesJudged,
  pagesSkipped: s.pagesSkipped ?? 0,
  partial: s.partial ?? false,
  startedAt: s.startedAt,
  finishedAt: s.finishedAt,
  error: s.error,
});

// ---------------------------------------------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------------------------------------------

export interface CopyDeps {
  facts: FactRepo;
  scans: ScanRepo;
  canEdit: (pageId: string) => Promise<boolean>;
  /** Page ids the viewing user may open (CQL as the user). */
  visible: (pageIds: readonly string[]) => Promise<Set<string>>;
  push: (queue: ScanQueue, scanId: string) => Promise<string>;
  ensure: () => Promise<void>;
}

const defaultDeps: CopyDeps = { facts: sqlRepo, scans: sqlScanRepo, canEdit: canEditPage, visible: visiblePageIds, push: pushScan, ensure: ensureSchema };

function pageIdOf(ctx: SourceContext): string | undefined {
  const id = ctx.extension?.content?.id;
  return id === undefined || String(id) === '' ? undefined : String(id);
}

async function guarded<T>(ctx: SourceContext, deps: CopyDeps, what: string, body: (pageId: string) => Promise<T | ErrorReply>): Promise<T | ErrorReply> {
  const pageId = pageIdOf(ctx);
  if (!pageId) return { error: 'Open a Confluence page to use Ripple.' };
  try {
    await deps.ensure();
    return await body(pageId);
  } catch (err) {
    if (err instanceof SchemaSettingUpError) return { error: err.message };
    console.warn(`ripple ${what} failed`, { pageId, error: errorText(err), sql: sqlDetails(err) });
    return { error: `Ripple could not ${what}: ${errorText(err)}` };
  }
}

/** Pages holding copies of the source, split by whether the viewer may open them (NFR-3). */
async function copyPagesFor(sourcePageId: string, deps: CopyDeps): Promise<{ visible: string[]; hidden: string[] }> {
  const all = await deps.scans.copyPageIds(sourcePageId);
  if (all.length === 0) return { visible: [], hidden: [] };
  const seen = await deps.visible(all);
  return { visible: all.filter((id) => seen.has(id)), hidden: all.filter((id) => !seen.has(id)) };
}

/** Status counts cover only copies on pages the viewer may open; restricted ones are never broken down by status. */
async function scanStatusOf(pageId: string, canEdit: boolean, deps: CopyDeps): Promise<ScanStatus> {
  const scan = await deps.scans.latestScan(pageId);
  if (!scan) return { pageId, canEdit, scan: null, counts: { ...EMPTY_COPY_COUNTS } };
  const { visible } = await copyPagesFor(pageId, deps);
  return { pageId, canEdit, scan: scanView(scan), counts: await deps.scans.countCopies(pageId, visible) };
}

/** Polled by the Copies tab while a scan runs. */
export async function getScanStatus(ctx: SourceContext, deps: CopyDeps = defaultDeps): Promise<ScanStatus | ErrorReply> {
  return guarded(ctx, deps, 'load the scan status', async (pageId) => scanStatusOf(pageId, await deps.canEdit(pageId), deps));
}

/**
 * FR-4: start a copy scan of the viewed source page (edit permission, source ready, at least one confirmed fact).
 * A running scan is returned as is (also when another request created it a moment ago: one running scan per source
 * is enforced by a unique key); a stalled one (no progress for 15 minutes) is resumed from its last batch.
 */
export async function startScan(ctx: SourceContext, deps: CopyDeps = defaultDeps): Promise<ScanStatus | ErrorReply> {
  return guarded(ctx, deps, 'start the copy search', async (pageId) => {
    if (!ctx.accountId || !(await deps.canEdit(pageId))) return { error: NOT_ALLOWED };
    const source = await deps.facts.getSource(pageId);
    if (!source) return { error: 'Mark this page as the source of truth first.' };
    if (source.state !== 'ready') return { error: 'Wait until Ripple has read the facts on this page.' };
    const facts = await scanFactsOf(deps.facts, pageId);
    if (facts.length === 0) return { error: 'Confirm at least one fact before searching for copies.' };

    const latest = await deps.scans.latestScan(pageId);
    if (latest && (latest.state === 'searching' || latest.state === 'judging')) {
      if (!latest.stalled) return scanStatusOf(pageId, true, deps);
      await deps.scans.touchScan(latest.id);
      const jobId = await deps.push(latest.state === 'searching' ? SEARCH_QUEUE : JUDGE_QUEUE, latest.id);
      await deps.facts.audit('scan.resumed', ctx.accountId, 'page', pageId, { scanId: latest.id, jobId, state: latest.state });
      console.info('ripple scan resumed', { pageId, scanId: latest.id, state: latest.state });
      return scanStatusOf(pageId, true, deps);
    }

    const scanId = await deps.scans.createScan(
      pageId,
      facts.map((f) => f.id),
      ctx.accountId,
    );
    if (!scanId) return scanStatusOf(pageId, true, deps); // a concurrent click created it
    let jobId: string;
    try {
      jobId = await deps.push(SEARCH_QUEUE, scanId);
    } catch (err) {
      const error = `Could not start the copy search: ${errorText(err)}`;
      console.warn('ripple scan: enqueue failed', { pageId, scanId, error });
      await deps.scans.failScan(scanId, error);
      return { error: `${error}. Try again in a minute.` };
    }
    await deps.facts.audit('scan.started', ctx.accountId, 'page', pageId, { scanId, jobId, facts: facts.length });
    console.info('ripple scan started', { pageId, scanId, facts: facts.length });
    return scanStatusOf(pageId, true, deps);
  });
}

/**
 * FR-6: copies of the viewed source's facts on pages the viewer may open (NFR-3). The visibility filter runs before
 * the row limit, so the list and the counts agree; copies on other pages are one total (`hiddenCount`, allowed by
 * NFR-3: "sisanya ditampilkan sebagai jumlah") for the same status filter.
 */
export async function listCopies(ctx: SourceContext, payload: Partial<CopyListPayload> | undefined, deps: CopyDeps = defaultDeps): Promise<CopyList | ErrorReply> {
  const raw = payload?.status;
  if (raw !== undefined && !COPY_STATUSES.includes(raw as CopyStatus)) return { error: 'Unknown copy status filter.' };
  const status = raw as CopyStatus | undefined;
  return guarded(ctx, deps, 'load the copies', async (pageId) => {
    const { visible, hidden } = await copyPagesFor(pageId, deps);
    const copies = await deps.scans.listCopies(pageId, status, visible);
    let hiddenCount = 0;
    if (hidden.length > 0) {
      const counts = await deps.scans.countCopies(pageId, hidden);
      hiddenCount = status ? counts[status] : ALL_FILTER_STATUSES.reduce((n, s) => n + counts[s], 0);
    }
    return { pageId, copies, hiddenCount };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// `search` and `judge` queue consumers
// ---------------------------------------------------------------------------------------------------------------

export interface ScanJobDeps {
  facts: FactRepo;
  scans: ScanRepo;
  search: (cql: string, max: number) => Promise<SearchHit[]>;
  page: (pageId: string) => Promise<SourcePage>;
  llm?: ChatToolFn;
  push: (queue: ScanQueue, scanId: string) => Promise<string>;
  ensure: () => Promise<void>;
  now: () => number;
}

const defaultJobDeps: ScanJobDeps = {
  facts: sqlRepo,
  scans: sqlScanRepo,
  search: searchPagesAsApp,
  page: getSourcePage,
  push: pushScan,
  ensure: ensureSchema,
  now: Date.now,
};

export type ScanOutcome =
  | { status: 'done'; detail: Record<string, number> }
  | { status: 'continued'; detail: Record<string, number> }
  | { status: 'skipped'; reason: string }
  | { status: 'retry'; seconds: number; reason: string }
  | { status: 'failed'; error: string };

async function failOrRetry(what: string, scanId: string, retryCount: number, err: unknown, deps: ScanJobDeps): Promise<ScanOutcome> {
  if (retryCount < MAX_RETRIES) {
    if (isLlmRateLimited(err)) return { status: 'retry', seconds: backoff(retryCount), reason: 'llm-rate-limited' };
    if (isLlmRetryable(err)) return { status: 'retry', seconds: backoff(retryCount), reason: 'llm-unavailable' };
    if (err instanceof ConfluenceRetryableError) return { status: 'retry', seconds: backoff(retryCount), reason: `confluence-http-${err.status}` };
    if (isSqlRateLimited(err)) return { status: 'retry', seconds: 60, reason: 'sql-rate-limited' };
  }
  const error = isLlmRetryable(err)
    ? 'The model is busy; start the search again later.'
    : err instanceof ConfluenceRetryableError
      ? `Confluence did not answer (HTTP ${err.status}); start the search again later.`
      : errorText(err);
  console.warn(`ripple ${what} failed`, { scanId, error, sql: sqlDetails(err) });
  await deps.scans.failScan(scanId, error);
  return { status: 'failed', error };
}

/** Loads the scan in `state`; anything else (unknown, finished, other phase) is skipped. */
async function openScan(scanId: string, state: 'searching' | 'judging', deps: ScanJobDeps): Promise<ScanRow | { status: 'skipped' | 'retry'; reason: string; seconds?: number }> {
  try {
    await deps.ensure();
  } catch (err) {
    if (err instanceof SchemaSettingUpError) return { status: 'retry', seconds: 60, reason: 'schema' };
    throw err;
  }
  const scan = await deps.scans.getScan(scanId);
  if (!scan) return { status: 'skipped', reason: 'unknown scan' };
  if (scan.state !== state) return { status: 'skipped', reason: `scan is ${scan.state}` };
  return scan;
}

const isScan = (x: ScanRow | { status: string }): x is ScanRow => 'sourcePageId' in x;
const asOutcome = (x: { status: 'skipped' | 'retry'; reason: string; seconds?: number }): ScanOutcome =>
  x.status === 'retry' ? { status: 'retry', seconds: x.seconds ?? 60, reason: x.reason } : { status: 'skipped', reason: x.reason };

/** The source was unmarked while the scan ran: nothing of it may stay behind. */
async function discardUnmarked(scan: ScanRow, deps: ScanJobDeps): Promise<ScanOutcome> {
  await deps.scans.discardScan(scan.id, scan.sourcePageId);
  console.info('ripple scan discarded: source unmarked', { scanId: scan.id });
  return { status: 'skipped', reason: 'source unmarked' };
}

/** Search phrases per fact from the LLM. Undefined when the suggestion failed (fewer terms, nothing cached). */
async function termsFor(facts: readonly ScanFact[], deps: ScanJobDeps): Promise<Record<string, string[]> | undefined> {
  try {
    const { args } = await suggestSearchTerms(facts, deps.llm);
    return parseTermSuggestions(args, facts.map((f) => f.id));
  } catch (err) {
    if (isLlmRetryable(err)) throw err;
    console.warn('ripple search: no synonym terms', { error: errorText(err) });
    return undefined;
  }
}

/**
 * Synonyms per fact: reused from the per-fact cache while the fact's subject/attribute/condition are unchanged, so
 * repeated scans search with the same CQL; one LLM call only for facts without (current) cached terms.
 */
async function stableTerms(scanId: string, facts: readonly ScanFact[], deps: ScanJobDeps): Promise<{ terms: Record<string, string[]>; cached: number }> {
  const cache = await deps.scans.factSearchTerms(facts.map((f) => f.id));
  const terms: Record<string, string[]> = {};
  const missing: { fact: ScanFact; key: string }[] = [];
  for (const fact of facts) {
    const key = identityKey(fact.subject, fact.attribute, fact.condition);
    const hit = cache.get(fact.id);
    if (hit && hit.key === key) terms[fact.id] = hit.terms;
    else missing.push({ fact, key });
  }
  const cached = facts.length - missing.length;
  if (missing.length === 0) return { terms, cached };
  let fresh: Record<string, string[]> | undefined;
  try {
    fresh = await termsFor(
      missing.map((m) => m.fact),
      deps,
    );
  } finally {
    await deps.scans.addLlmCalls(scanId, 1);
  }
  for (const { fact, key } of missing) {
    const got = fresh?.[fact.id] ?? [];
    terms[fact.id] = got;
    // An empty answer is not cached: the next scan asks again instead of searching without synonyms forever.
    if (got.length > 0) await deps.scans.saveFactSearchTerms(fact.id, { key, terms: got });
  }
  return { terms, cached };
}

/**
 * `search` consumer: CQL per fact of the scan (ids fixed when it started; facts no longer confirmed are skipped) from
 * the cursor, at most 200 candidate pages per fact (the source page itself excluded). Re-queues itself when the run
 * budget is used up; then queues the judge.
 */
export async function runSearchJob(scanId: string, retryCount: number, deps: ScanJobDeps = defaultJobDeps, budgetMs = RUN_BUDGET_MS): Promise<ScanOutcome> {
  const opened = await openScan(scanId, 'searching', deps);
  if (!isScan(opened)) return asOutcome(opened);
  const scan = opened;
  const deadline = deps.now() + budgetMs;
  try {
    if (!(await deps.facts.getSource(scan.sourcePageId))) return await discardUnmarked(scan, deps);
    const current = await scanFactsOf(deps.facts, scan.sourcePageId);
    const byId = new Map(current.map((f) => [f.id, f]));
    const ids = scan.factIds ?? current.map((f) => f.id);
    const facts = ids.map((id) => byId.get(id)).filter((f): f is ScanFact => f !== undefined);
    if (facts.length === 0) {
      await deps.scans.failScan(scanId, 'No confirmed facts to search for.');
      return { status: 'failed', error: 'no confirmed facts' };
    }
    let terms = scan.terms;
    if (!terms) {
      const stable = await stableTerms(scanId, facts, deps);
      terms = stable.terms;
      await deps.scans.setTerms(scanId, terms, stable.cached);
    }
    let searched = 0;
    for (let i = scan.factCursor; i < ids.length; i++) {
      if (deps.now() > deadline) {
        await deps.push(SEARCH_QUEUE, scanId);
        return { status: 'continued', detail: { searched, cursor: i } };
      }
      const fact = byId.get(ids[i] as string);
      if (fact) {
        const cql = buildCql(scan.sourcePageId, factTerms(fact, terms[fact.id] ?? []));
        const hits = (await deps.search(cql, MAX_CANDIDATES_PER_FACT)).filter((h) => h.pageId !== scan.sourcePageId).slice(0, MAX_CANDIDATES_PER_FACT);
        await deps.scans.addHits(scanId, hits.map((h) => ({ factId: fact.id, ...h })));
        searched++;
        console.info('ripple search fact', { scanId, fact: i + 1, of: ids.length, hits: hits.length });
      }
      await deps.scans.advanceSearch(scanId, i + 1);
    }
    await deps.scans.startJudging(scanId);
    await deps.push(JUDGE_QUEUE, scanId);
    return { status: 'done', detail: { searched, facts: ids.length } };
  } catch (err) {
    return failOrRetry('search', scanId, retryCount, err, deps);
  }
}

/** Stable key of a chunk (its text and facts), so a saved result is reused only for the same input. */
const chunkKey = (chunk: Chunk): string => createHash('sha256').update(`${chunk.factIds.join(',')}\n${chunk.text}`).digest('hex');

/** Runs `fn` over `items`, at most `limit` at a time. Stops taking new items after a failure, waits for the rest. */
async function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (rejected) throw rejected.reason;
}

const isUnusableAnswer = (err: unknown): boolean => err instanceof LlmOutputError || (err instanceof Error && err.message.startsWith('judge output'));

type PageResult = { kind: 'done'; copies: number; dropped: number } | { kind: 'skipped' } | { kind: 'capped' } | { kind: 'gone' };

/** LLM calls of the scan so far (shared by the pages of one run). */
interface LlmBudget {
  used: number;
}

/** Writes the copies of a page, unless the source was unmarked meanwhile (then the caller discards the scan). */
async function savePage(scan: ScanRow, pageId: string, copies: readonly CopyInput[], dropped: number, deps: ScanJobDeps): Promise<PageResult> {
  if (!(await deps.facts.getSource(scan.sourcePageId))) return { kind: 'gone' };
  await deps.scans.finishPage(scan.id, scan.sourcePageId, pageId, copies);
  return { kind: 'done', copies: copies.length, dropped };
}

async function skipPage(scan: ScanRow, pageId: string, why: string, deps: ScanJobDeps): Promise<PageResult> {
  console.warn('ripple judge: page skipped', { scanId: scan.id, pageId, error: why });
  await deps.scans.skipPage(scan.id, pageId);
  return { kind: 'skipped' };
}

/**
 * Judges one candidate page: chunks that mention its facts → LLM (results saved per chunk, so a retry continues with
 * the chunks not judged yet) → verified quotes → one status per fact. A page the app cannot read (e.g. 403) or the
 * model refuses (non-retryable LLM error) is skipped, not the whole scan.
 */
async function judgePage(scan: ScanRow, page: PendingPage, facts: readonly ScanFact[], budget: LlmBudget, deps: ScanJobDeps): Promise<PageResult> {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const pageFacts = page.factIds.map((id) => byId.get(id)).filter((f): f is ScanFact => f !== undefined);
  if (pageFacts.length === 0 || page.pageId === scan.sourcePageId) return savePage(scan, page.pageId, [], 0, deps);
  let copyPage: SourcePage;
  try {
    copyPage = await deps.page(page.pageId);
  } catch (err) {
    if (err instanceof PageNotFoundError) return savePage(scan, page.pageId, [], 0, deps);
    if (err instanceof ConfluenceRetryableError || isSqlRateLimited(err)) throw err;
    return skipPage(scan, page.pageId, errorText(err), deps);
  }
  const text = storageToText(copyPage.body, MAX_COPY_PAGE_CHARS);
  const terms = scan.terms ?? {};
  const chunks = chunkPage(
    text,
    pageFacts.map((f) => ({ id: f.id, terms: factTerms(f, terms[f.id] ?? []) })),
  );
  const title = copyPage.title || page.title;
  const saved = await deps.scans.chunkResults(scan.id, page.pageId);
  const results: ChunkResult[] = [];
  const todo: { chunk: Chunk; key: string }[] = [];
  for (const chunk of chunks) {
    const key = chunkKey(chunk);
    const done = saved.get(key);
    if (done) results.push(done);
    else todo.push({ chunk, key });
  }

  let capped = false;
  let refused: string | undefined;
  let calls = 0;
  const dropReasons: Record<string, number> = {};
  try {
    await forEachLimit(todo, JUDGE_CONCURRENCY, async ({ chunk, key }) => {
      if (capped || refused !== undefined) return;
      if (budget.used >= MAX_LLM_CALLS_PER_SCAN) {
        capped = true;
        return;
      }
      budget.used++;
      calls++;
      const chunkFacts = chunk.factIds.map((id) => byId.get(id)).filter((f): f is ScanFact => f !== undefined);
      let result: ChunkResult;
      try {
        const { args } = await judgeChunk(chunkFacts, chunk.text, title, deps.llm);
        const parsed = parseJudgement(
          args,
          chunk.text,
          chunkFacts.map((f) => f.id),
        );
        result = { judgements: parsed.judgements, dropped: parsed.dropped.length };
        for (const d of parsed.dropped) dropReasons[d.reason] = (dropReasons[d.reason] ?? 0) + 1;
      } catch (err) {
        if (isLlmRetryable(err)) throw err;
        if (isUnusableAnswer(err)) {
          // An unusable answer for one chunk loses that chunk only.
          console.warn('ripple judge: unusable answer for a chunk', { scanId: scan.id, pageId: page.pageId, line: chunk.firstLine, error: errorText(err) });
          result = { judgements: [], dropped: 1 };
          dropReasons.unusable_answer = (dropReasons.unusable_answer ?? 0) + 1;
        } else if (isLlmApiError(err)) {
          refused = errorText(err);
          return;
        } else throw err;
      }
      await deps.scans.saveChunkResult(scan.id, page.pageId, key, result);
      results.push(result);
    });
  } finally {
    if (calls > 0) await deps.scans.addLlmCalls(scan.id, calls);
  }
  if (refused !== undefined) return skipPage(scan, page.pageId, refused, deps);
  if (capped) return { kind: 'capped' };

  let dropped = 0;
  const found = new Map<string, CopyInput[]>();
  // Per fact of this page: why it did or did not become a copy (ids and outcome labels only, for the page log).
  const chunked = new Set(chunks.flatMap((c) => c.factIds));
  const outcomes = new Map<string, string[]>(pageFacts.map((f) => [f.id, chunked.has(f.id) ? [] : ['no_chunk']]));
  const reasonCodes = new Map<string, string[]>();
  const mentions: PageMention[] = [];
  for (const r of results) {
    dropped += r.dropped;
    for (const j of r.judgements) {
      const fact = byId.get(j.factId);
      if (!fact) continue;
      mentions.push({ fact, judgement: j, ...judgeOutcome(fact, j, siblingsOf(fact, facts)) });
    }
  }
  for (const { fact, judgement: j, decision, reason } of settleSiblings(mentions, facts)) {
    outcomes.get(fact.id)?.push(decision ? decision.status : (reason ?? 'not_copy'));
    // Enum value only (anything else was parsed to "other"): never the judge's free text.
    reasonCodes.set(fact.id, [...(reasonCodes.get(fact.id) ?? []), j.reasonCode ?? 'other']);
    if (!decision) continue;
    const list = found.get(fact.id) ?? [];
    list.push({
      factId: fact.id,
      pageId: page.pageId,
      pageTitle: title,
      pageUrl: page.url,
      pageVersion: copyPage.version || null,
      status: decision.status,
      statedValue: j.statedValue,
      statedUnit: j.statedUnit,
      statedCondition: j.statedCondition,
      mention: j.mention,
      quote: j.quote,
      reason: decision.reason,
    });
    found.set(fact.id, list);
  }
  const copies = [...found.values()].map((list) => strongest(list)).filter((c): c is CopyInput => c !== undefined);
  console.info('ripple judge page', {
    scanId: scan.id,
    pageId: page.pageId,
    chunks: chunks.length,
    facts: [...outcomes].map(([factId, list]) => ({
      factId,
      outcome: list.length > 0 ? list.join('+') : 'no_match',
      // No judged mention (no chunk or nothing reported) is "no_mention", so every entry has an enum reason code.
      reasonCode: reasonCodes.get(factId)?.join('+') ?? 'no_mention',
    })),
    dropped,
    dropReasons,
  });
  return savePage(scan, page.pageId, copies, dropped, deps);
}

/**
 * `judge` consumer: judges pending candidate pages in batches of 5 until none are left (then finishes the scan), the
 * run budget is used up (then re-queues itself) or the per-scan LLM call cap is reached (then finishes the scan as
 * partial). A page is marked done only after its copies are saved, so a retry or resume continues with the first
 * unfinished page (and its saved chunk results).
 */
export async function runJudgeJob(scanId: string, retryCount: number, deps: ScanJobDeps = defaultJobDeps, budgetMs = RUN_BUDGET_MS): Promise<ScanOutcome> {
  const opened = await openScan(scanId, 'judging', deps);
  if (!isScan(opened)) return asOutcome(opened);
  const scan = opened;
  const deadline = deps.now() + budgetMs;
  const budget: LlmBudget = { used: scan.llmCalls };
  let pages = 0;
  let copies = 0;
  let dropped = 0;
  let skipped = 0;
  let partial = false;
  try {
    if (!(await deps.facts.getSource(scan.sourcePageId))) return await discardUnmarked(scan, deps);
    const facts = await scanFactsOf(deps.facts, scan.sourcePageId);
    judging: for (;;) {
      const batch = await deps.scans.pendingPages(scanId, PAGES_PER_BATCH);
      if (batch.length === 0) break;
      for (const page of batch) {
        if (deps.now() > deadline) {
          await deps.push(JUDGE_QUEUE, scanId);
          console.info('ripple judge continued', { scanId, pages, copies, dropped, skipped });
          return { status: 'continued', detail: { pages, copies, dropped, skipped } };
        }
        const r = await judgePage(scan, page, facts, budget, deps);
        if (r.kind === 'gone') return await discardUnmarked(scan, deps);
        if (r.kind === 'capped') {
          partial = true;
          break judging;
        }
        pages++;
        if (r.kind === 'skipped') skipped++;
        else {
          copies += r.copies;
          dropped += r.dropped;
        }
      }
    }
    const perFact = await deps.scans.candidatesPerFact(scanId);
    const final = await deps.scans.getScan(scanId);
    await deps.scans.finishScan(scanId, scan.sourcePageId, partial);
    const counts = await deps.scans.countCopies(scan.sourcePageId);
    // One summary line per scan: ids and counts only.
    console.info('ripple scan summary', {
      scanId,
      candidatesPerFact: (scan.factIds ?? Object.keys(perFact)).map((id) => perFact[id] ?? 0),
      candidates: final?.candidates ?? scan.candidates,
      pagesJudged: final?.pagesJudged ?? pages,
      pagesSkipped: final?.pagesSkipped ?? skipped,
      llmCalls: budget.used,
      synonymsCached: final?.synonymsCached ?? scan.synonymsCached ?? 0,
      partial,
      dropped,
      counts,
    });
    await deps.facts.audit('scan.finished', null, 'page', scan.sourcePageId, { scanId, partial, skipped, ...counts });
    return { status: 'done', detail: { pages, copies, dropped, skipped, partial: partial ? 1 : 0 } };
  } catch (err) {
    return failOrRetry('judge', scanId, retryCount, err, deps);
  }
}
