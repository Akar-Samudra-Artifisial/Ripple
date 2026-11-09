/**
 * M2: copies of a source's facts on other pages (FR-4..6).
 *
 * Resolvers (`startScan`, `getScanStatus`, `listCopies`) only touch SQL and the queue. The `search` consumer runs
 * CQL per confirmed fact as the app (a consumer has no user) and stores up to 200 candidate pages per fact; the
 * `judge` consumer reads candidate pages as the app in small batches, sends only the chunks that mention a fact to
 * the LLM and stores one status per fact and page. Both resume from the last finished batch (cursor / pending hits
 * in Forge SQL) when re-queued, retried or resumed by `startScan`. Because the app sees more than a given user,
 * `listCopies` shows only pages the viewer can open (CQL as the user) and counts the rest.
 */
import { Queue } from '@forge/events';
import { canEditPage, ConfluenceRetryableError, getSourcePage, PageNotFoundError, searchPagesAsApp, visiblePageIds, type SearchHit, type SourcePage } from '../adapters/confluence';
import { sqlRepo, type FactRepo } from '../adapters/repo';
import { EMPTY_COPY_COUNTS, sqlScanRepo, type CopyInput, type PendingPage, type ScanRepo, type ScanRow } from '../adapters/scanRepo';
import { ensureSchema } from '../adapters/sql';
import { scrubErrorText } from '../adapters/teamworkGraph';
import {
  buildCql,
  chunkPage,
  decideStatus,
  factTerms,
  MAX_CANDIDATES_PER_FACT,
  MAX_COPY_PAGE_CHARS,
  parseJudgement,
  parseTermSuggestions,
  siblingsOf,
  strongest,
  type ScanFact,
} from '../core/copies';
import { storageToText } from '../core/pageText';
import { isSqlRateLimited, SchemaSettingUpError } from '../core/schema';
import { COPY_STATUSES, type CopyList, type CopyListPayload, type CopyStatus, type ErrorReply, type ScanStatus, type ScanView } from '../core/views';
import { isLlmRateLimited, LlmOutputError } from '../llm';
import type { ChatToolFn } from '../llm/extract';
import { judgeChunk, suggestSearchTerms } from '../llm/judge';
import type { SourceContext } from './sources';

export const SEARCH_QUEUE = 'search';
export const JUDGE_QUEUE = 'judge';
export type ScanQueue = typeof SEARCH_QUEUE | typeof JUDGE_QUEUE;

/** Candidate pages read per `pendingPages` call in the judge consumer. */
export const PAGES_PER_BATCH = 5;
/** Work per consumer run before it re-queues itself (the consumer timeout is 900 s). */
export const RUN_BUDGET_MS = 10 * 60 * 1000;
/** Queue retries for transient failures (LLM/SQL rate limit, Confluence 429/5xx) before the scan is marked failed. */
export const MAX_RETRIES = 4;
const backoff = (retryCount: number): number => 30 * 2 ** retryCount;

const queues: Record<ScanQueue, Queue> = { search: new Queue({ key: SEARCH_QUEUE }), judge: new Queue({ key: JUDGE_QUEUE }) };

/** One run per scan at a time, across both queues (concurrency keys span all queues of the install). */
async function pushScan(queue: ScanQueue, scanId: string): Promise<string> {
  const { jobId } = await queues[queue].push({ body: { scanId }, concurrency: { key: `scan-${scanId}`, limit: 1 } });
  return jobId;
}

const errorText = (err: unknown): string => scrubErrorText(err instanceof Error ? err.message : String(err));
const NOT_ALLOWED = 'You need edit permission on this page to do that.';

/** Confirmed facts of the source, in a stable order (the search cursor indexes into it). */
async function scanFactsOf(facts: FactRepo, sourcePageId: string): Promise<ScanFact[]> {
  return (await facts.listFacts(sourcePageId))
    .filter((f) => f.status === 'confirmed')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((f) => ({ id: f.id, type: f.type, subject: f.subject, attribute: f.attribute, value: f.value, unit: f.unit, condition: f.condition, previousValue: f.previousValue }));
}

const scanView = (s: ScanRow): ScanView => ({
  id: s.id,
  state: s.state,
  stalled: s.stalled,
  factsTotal: s.factsTotal,
  factsSearched: s.factsSearched,
  candidates: s.candidates,
  pagesJudged: s.pagesJudged,
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
    console.warn(`ripple ${what} failed`, { pageId, error: errorText(err) });
    return { error: `Ripple could not ${what}: ${errorText(err)}` };
  }
}

async function scanStatusOf(pageId: string, canEdit: boolean, deps: CopyDeps): Promise<ScanStatus> {
  const scan = await deps.scans.latestScan(pageId);
  return { pageId, canEdit, scan: scan ? scanView(scan) : null, counts: scan ? await deps.scans.countCopies(pageId) : { ...EMPTY_COPY_COUNTS } };
}

/** Polled by the Copies tab while a scan runs. Counts include copies on pages the viewer cannot open. */
export async function getScanStatus(ctx: SourceContext, deps: CopyDeps = defaultDeps): Promise<ScanStatus | ErrorReply> {
  return guarded(ctx, deps, 'load the scan status', async (pageId) => scanStatusOf(pageId, await deps.canEdit(pageId), deps));
}

/**
 * FR-4: start a copy scan of the viewed source page (edit permission, source ready, at least one confirmed fact).
 * A running scan is returned as is; a stalled one (no progress for 15 minutes) is resumed from its last batch.
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

    const scanId = await deps.scans.createScan(pageId, facts.length, ctx.accountId);
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

/** FR-6: copies of the viewed source's facts, on pages the viewer may open (NFR-3); the rest only as a count. */
export async function listCopies(ctx: SourceContext, payload: Partial<CopyListPayload> | undefined, deps: CopyDeps = defaultDeps): Promise<CopyList | ErrorReply> {
  const raw = payload?.status;
  if (raw !== undefined && !COPY_STATUSES.includes(raw as CopyStatus)) return { error: 'Unknown copy status filter.' };
  const status = raw as CopyStatus | undefined;
  return guarded(ctx, deps, 'load the copies', async (pageId) => {
    const all = await deps.scans.listCopies(pageId, status);
    const visible = all.length > 0 ? await deps.visible(all.map((c) => c.pageId)) : new Set<string>();
    const copies = all.filter((c) => visible.has(c.pageId));
    return { pageId, copies, hiddenCount: all.length - copies.length };
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
    if (err instanceof ConfluenceRetryableError) return { status: 'retry', seconds: backoff(retryCount), reason: `confluence-http-${err.status}` };
    if (isSqlRateLimited(err)) return { status: 'retry', seconds: 60, reason: 'sql-rate-limited' };
  }
  const error = isLlmRateLimited(err)
    ? 'The model is busy; start the search again later.'
    : err instanceof ConfluenceRetryableError
      ? `Confluence did not answer (HTTP ${err.status}); start the search again later.`
      : errorText(err);
  console.warn(`ripple ${what} failed`, { scanId, error });
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

/** Search phrases per fact from the LLM (once per scan). A failed suggestion only means fewer terms. */
async function termsFor(facts: readonly ScanFact[], deps: ScanJobDeps): Promise<Record<string, string[]>> {
  try {
    const { args } = await suggestSearchTerms(facts, deps.llm);
    return parseTermSuggestions(args, facts.map((f) => f.id));
  } catch (err) {
    if (isLlmRateLimited(err)) throw err;
    console.warn('ripple search: no synonym terms', { error: errorText(err) });
    return {};
  }
}

/**
 * `search` consumer: CQL per confirmed fact from the scan's cursor, at most 200 candidate pages per fact (the source
 * page itself excluded). Re-queues itself when the run budget is used up; then queues the judge.
 */
export async function runSearchJob(scanId: string, retryCount: number, deps: ScanJobDeps = defaultJobDeps, budgetMs = RUN_BUDGET_MS): Promise<ScanOutcome> {
  const opened = await openScan(scanId, 'searching', deps);
  if (!isScan(opened)) return asOutcome(opened);
  const scan = opened;
  const deadline = deps.now() + budgetMs;
  try {
    if (!(await deps.facts.getSource(scan.sourcePageId))) {
      await deps.scans.failScan(scanId, 'The page is no longer a source of truth.');
      return { status: 'failed', error: 'source unmarked' };
    }
    const facts = await scanFactsOf(deps.facts, scan.sourcePageId);
    if (facts.length === 0) {
      await deps.scans.failScan(scanId, 'No confirmed facts to search for.');
      return { status: 'failed', error: 'no confirmed facts' };
    }
    let terms = scan.terms;
    if (!terms) {
      terms = await termsFor(facts, deps);
      await deps.scans.setTerms(scanId, terms);
    }
    let searched = 0;
    for (let i = scan.factCursor; i < facts.length; i++) {
      if (deps.now() > deadline) {
        await deps.push(SEARCH_QUEUE, scanId);
        return { status: 'continued', detail: { searched, cursor: i } };
      }
      const fact = facts[i] as ScanFact;
      const cql = buildCql(scan.sourcePageId, factTerms(fact, terms[fact.id] ?? []));
      const hits = (await deps.search(cql, MAX_CANDIDATES_PER_FACT)).filter((h) => h.pageId !== scan.sourcePageId).slice(0, MAX_CANDIDATES_PER_FACT);
      await deps.scans.addHits(scanId, hits.map((h) => ({ factId: fact.id, ...h })));
      await deps.scans.advanceSearch(scanId, i + 1);
      searched++;
      console.info('ripple search fact', { scanId, fact: i + 1, of: facts.length, hits: hits.length });
    }
    await deps.scans.startJudging(scanId);
    await deps.push(JUDGE_QUEUE, scanId);
    return { status: 'done', detail: { searched, facts: facts.length } };
  } catch (err) {
    return failOrRetry('search', scanId, retryCount, err, deps);
  }
}

/** Judges one candidate page: chunks that mention its facts → LLM → verified quotes → one status per fact. */
async function judgePage(scan: ScanRow, page: PendingPage, facts: readonly ScanFact[], deps: ScanJobDeps): Promise<{ copies: number; dropped: number }> {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const pageFacts = page.factIds.map((id) => byId.get(id)).filter((f): f is ScanFact => f !== undefined);
  if (pageFacts.length === 0 || page.pageId === scan.sourcePageId) {
    await deps.scans.finishPage(scan.id, scan.sourcePageId, page.pageId, []);
    return { copies: 0, dropped: 0 };
  }
  let copyPage: SourcePage;
  try {
    copyPage = await deps.page(page.pageId);
  } catch (err) {
    if (!(err instanceof PageNotFoundError)) throw err;
    await deps.scans.finishPage(scan.id, scan.sourcePageId, page.pageId, []);
    return { copies: 0, dropped: 0 };
  }
  const text = storageToText(copyPage.body, MAX_COPY_PAGE_CHARS);
  const terms = scan.terms ?? {};
  const chunks = chunkPage(
    text,
    pageFacts.map((f) => ({ id: f.id, terms: factTerms(f, terms[f.id] ?? []) })),
  );
  const title = copyPage.title || page.title;
  let dropped = 0;
  const found = new Map<string, CopyInput[]>();
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const chunkFacts = chunk.factIds.map((id) => byId.get(id)).filter((f): f is ScanFact => f !== undefined);
      try {
        const { args } = await judgeChunk(chunkFacts, chunk.text, title, deps.llm);
        return { chunkFacts, parsed: parseJudgement(args, chunk.text, chunkFacts.map((f) => f.id)) };
      } catch (err) {
        if (isLlmRateLimited(err) || err instanceof ConfluenceRetryableError) throw err;
        // An unusable answer for one chunk loses that chunk only.
        if (!(err instanceof LlmOutputError) && !(err instanceof Error && err.message.startsWith('judge output'))) throw err;
        console.warn('ripple judge: unusable answer for a chunk', { scanId: scan.id, pageId: page.pageId, line: chunk.firstLine, error: errorText(err) });
        dropped++;
        return undefined;
      }
    }),
  );
  for (const r of results) {
    if (!r) continue;
    dropped += r.parsed.dropped.length;
    for (const j of r.parsed.judgements) {
      const fact = byId.get(j.factId);
      if (!fact) continue;
      const decision = decideStatus(fact, j, siblingsOf(fact, facts));
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
  }
  const copies = [...found.values()].map((list) => strongest(list)).filter((c): c is CopyInput => c !== undefined);
  await deps.scans.finishPage(scan.id, scan.sourcePageId, page.pageId, copies);
  return { copies: copies.length, dropped };
}

/**
 * `judge` consumer: judges pending candidate pages in batches of 5 until none are left (then finishes the scan) or the
 * run budget is used up (then re-queues itself). A page is marked done only after its copies are saved, so a retry
 * or resume continues with the first unfinished page.
 */
export async function runJudgeJob(scanId: string, retryCount: number, deps: ScanJobDeps = defaultJobDeps, budgetMs = RUN_BUDGET_MS): Promise<ScanOutcome> {
  const opened = await openScan(scanId, 'judging', deps);
  if (!isScan(opened)) return asOutcome(opened);
  const scan = opened;
  const deadline = deps.now() + budgetMs;
  let pages = 0;
  let copies = 0;
  let dropped = 0;
  try {
    if (!(await deps.facts.getSource(scan.sourcePageId))) {
      await deps.scans.failScan(scanId, 'The page is no longer a source of truth.');
      return { status: 'failed', error: 'source unmarked' };
    }
    const facts = await scanFactsOf(deps.facts, scan.sourcePageId);
    for (;;) {
      const batch = await deps.scans.pendingPages(scanId, PAGES_PER_BATCH);
      if (batch.length === 0) break;
      for (const page of batch) {
        if (deps.now() > deadline) {
          await deps.push(JUDGE_QUEUE, scanId);
          console.info('ripple judge continued', { scanId, pages, copies, dropped });
          return { status: 'continued', detail: { pages, copies, dropped } };
        }
        const r = await judgePage(scan, page, facts, deps);
        pages++;
        copies += r.copies;
        dropped += r.dropped;
      }
    }
    await deps.scans.finishScan(scanId, scan.sourcePageId);
    const counts = await deps.scans.countCopies(scan.sourcePageId);
    console.info('ripple scan done', { scanId, pages, copies, dropped, ...counts });
    await deps.facts.audit('scan.finished', null, 'page', scan.sourcePageId, { scanId, ...counts });
    return { status: 'done', detail: { pages, copies, dropped } };
  } catch (err) {
    return failOrRetry('judge', scanId, retryCount, err, deps);
  }
}
