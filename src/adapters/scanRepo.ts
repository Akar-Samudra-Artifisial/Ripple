import { randomUUID } from 'node:crypto';
import type { Judgement } from '../core/copies';
import type { CopyCounts, CopyStatus, CopyView, ScanState, ScanView } from '../core/views';
import { sqlInt } from '../core/schema';
import { execute, query } from './sql';

/** No progress for this long while running = stalled (a consumer died); `startScan` resumes it. */
export const STALL_SECONDS = 15 * 60;
/** Copies returned by one `listCopies` call (after the visibility filter). */
export const MAX_LISTED_COPIES = 500;

export interface ScanRow extends ScanView {
  sourcePageId: string;
  factCursor: number;
  /** Confirmed fact ids when the scan started, sorted; the search cursor indexes into it. Null for old scans. */
  factIds: string[] | null;
  /** Fact id → extra search phrases, decided once per scan; null until the search consumer set them. */
  terms: Record<string, string[]> | null;
  llmCalls: number;
  /** Facts whose synonyms came from the per-fact cache when the terms were set. */
  synonymsCached?: number;
}

export interface HitInput {
  factId: string;
  pageId: string;
  title: string;
  url: string | null;
}

export interface PendingPage {
  pageId: string;
  title: string;
  url: string | null;
  factIds: string[];
}

export interface CopyInput {
  factId: string;
  pageId: string;
  pageTitle: string;
  pageUrl: string | null;
  pageVersion: number | null;
  status: CopyStatus;
  statedValue: string;
  statedUnit: string | null;
  statedCondition: string | null;
  mention: string;
  quote: string;
  reason: string;
}

/** Saved judge result of one chunk (verified judgements only), reused when a page is judged again after a retry. */
export interface ChunkResult {
  judgements: Judgement[];
  dropped: number;
}

/** Storage of scans, candidate hits and copies (an in-memory fake implements it in tests). */
/** Synonyms generated once for a fact; reused while the fact's identity key (subject|attribute|condition) is `key`. */
export interface CachedTerms {
  key: string;
  terms: string[];
}

export interface ScanRepo {
  latestScan(sourcePageId: string): Promise<ScanRow | undefined>;
  getScan(scanId: string): Promise<ScanRow | undefined>;
  /** Undefined when the source already has a running scan (unique `active_source`). */
  createScan(sourcePageId: string, factIds: readonly string[], actor: string): Promise<string | undefined>;
  /** Bumps `updated_at` (resume of a stalled scan). */
  touchScan(scanId: string): Promise<void>;
  /** `synonymsCached`: facts whose terms came from the per-fact cache (summary log). */
  setTerms(scanId: string, terms: Record<string, string[]>, synonymsCached?: number): Promise<void>;
  /** Cached CQL synonyms per fact id (only facts that have them), with the identity key they were made for. */
  factSearchTerms(factIds: readonly string[]): Promise<Map<string, CachedTerms>>;
  saveFactSearchTerms(factId: string, cached: CachedTerms): Promise<void>;
  addLlmCalls(scanId: string, n: number): Promise<void>;
  /** Idempotent (a resumed batch inserts the same hits again). */
  addHits(scanId: string, hits: readonly HitInput[]): Promise<void>;
  /** Fact `factCursor - 1` is searched; stores the distinct candidate count. */
  advanceSearch(scanId: string, factCursor: number): Promise<void>;
  startJudging(scanId: string): Promise<void>;
  pendingPages(scanId: string, limit: number): Promise<PendingPage[]>;
  /** Distinct candidate pages per fact id (for the scan summary log; hits are removed when the scan finishes). */
  candidatesPerFact(scanId: string): Promise<Record<string, number>>;
  chunkResults(scanId: string, pageId: string): Promise<Map<string, ChunkResult>>;
  saveChunkResult(scanId: string, pageId: string, chunkHash: string, result: ChunkResult): Promise<void>;
  /**
   * Replaces the copies of one judged page (stale ones from earlier scans removed, `ignored`/`updated` kept) and
   * marks its hits done. Idempotent.
   */
  finishPage(scanId: string, sourcePageId: string, pageId: string, copies: readonly CopyInput[]): Promise<void>;
  /** The page could not be read or judged (e.g. 403): its hits are marked skipped and counted. */
  skipPage(scanId: string, pageId: string): Promise<void>;
  /**
   * Marks the scan done. A complete scan also removes copies an earlier scan found on pages this one no longer
   * found (except ignored/updated); a partial one (LLM call cap reached) keeps them.
   */
  finishScan(scanId: string, sourcePageId: string, partial: boolean): Promise<void>;
  failScan(scanId: string, error: string): Promise<void>;
  /** The source was unmarked during the scan: remove the scan and every copy of the source. */
  discardScan(scanId: string, sourcePageId: string): Promise<void>;
  /** Distinct pages holding copies of the source's confirmed facts. */
  copyPageIds(sourcePageId: string): Promise<string[]>;
  /** Copies of confirmed facts per status; only on `pageIds` when given. */
  countCopies(sourcePageId: string, pageIds?: readonly string[]): Promise<CopyCounts>;
  /** Copies of confirmed facts on `pageIds`; `status` omitted = `ALL_FILTER_STATUSES`. At most `MAX_LISTED_COPIES`. */
  listCopies(sourcePageId: string, status: CopyStatus | undefined, pageIds: readonly string[]): Promise<CopyView[]>;
}

/**
 * Statuses of the "All" filter, its count and its list: the restatements of the facts plus historical mentions, so the
 * All count always equals the cards listed under All. The "N copies" headline counts the restatements only (no
 * historical); ignored matches have their own filter only.
 */
export const ALL_FILTER_STATUSES = ['in_sync', 'drifted', 'unsure', 'updated', 'historical'] as const;

export const EMPTY_COPY_COUNTS: CopyCounts = { in_sync: 0, drifted: 0, unsure: 0, historical: 0, ignored: 0, updated: 0 };

interface ScanDbRow {
  id: string;
  source_page_id: string;
  status: string;
  facts_total: number;
  fact_cursor: number;
  fact_ids: unknown;
  terms: unknown;
  candidates: number;
  pages_judged: number;
  pages_skipped: number | null;
  llm_calls: number | null;
  synonyms_cached?: number | null;
  partial: number | boolean | null;
  error: string | null;
  started_at: unknown;
  finished_at: unknown;
  idle_seconds: number | string | null;
}

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

const json = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);

function parseTerms(v: unknown): Record<string, string[]> | null {
  if (v === null || v === undefined) return null;
  const obj = json(v);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out: Record<string, string[]> = {};
  for (const [k, list] of Object.entries(obj)) if (Array.isArray(list)) out[k] = list.filter((t): t is string => typeof t === 'string');
  return out;
}

function parseIds(v: unknown): string[] | null {
  if (v === null || v === undefined) return null;
  const list = json(v);
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : null;
}

const RUNNING = new Set<ScanState>(['searching', 'judging']);

const toScan = (r: ScanDbRow): ScanRow => {
  const state = r.status as ScanState;
  return {
    id: r.id,
    sourcePageId: r.source_page_id,
    state,
    stalled: RUNNING.has(state) && Number(r.idle_seconds ?? 0) > STALL_SECONDS,
    factsTotal: Number(r.facts_total),
    factsSearched: Number(r.fact_cursor),
    factCursor: Number(r.fact_cursor),
    factIds: parseIds(r.fact_ids),
    terms: parseTerms(r.terms),
    candidates: Number(r.candidates),
    pagesJudged: Number(r.pages_judged),
    pagesSkipped: Number(r.pages_skipped ?? 0),
    llmCalls: Number(r.llm_calls ?? 0),
    synonymsCached: Number(r.synonyms_cached ?? 0),
    partial: Boolean(Number(r.partial ?? 0)),
    startedAt: iso(r.started_at) ?? '',
    finishedAt: iso(r.finished_at),
    error: r.error,
  };
};

const SCAN_COLUMNS =
  'id, source_page_id, status, facts_total, fact_cursor, fact_ids, terms, candidates, pages_judged, pages_skipped, llm_calls, synonyms_cached, partial, error, started_at, finished_at, TIMESTAMPDIFF(SECOND, updated_at, CURRENT_TIMESTAMP) AS idle_seconds';

interface CopyDbRow {
  id: string;
  fact_id: string;
  page_id: string;
  page_title: string | null;
  page_url: string | null;
  status: string;
  stated_value: string | null;
  stated_unit: string | null;
  stated_condition: string | null;
  quote: string;
  reason: string;
  judged_at: unknown;
  subject: string;
  attribute: string;
  fact_condition: string | null;
  value: string;
  unit: string | null;
}

const toCopy = (r: CopyDbRow): CopyView => ({
  id: r.id,
  factId: r.fact_id,
  factLabel: [r.subject, r.attribute, r.fact_condition].filter(Boolean).join(' · '),
  officialValue: r.value,
  officialUnit: r.unit,
  pageId: r.page_id,
  pageTitle: r.page_title ?? '',
  pageUrl: r.page_url,
  status: r.status as CopyStatus,
  statedValue: r.stated_value,
  statedUnit: r.stated_unit,
  statedCondition: r.stated_condition,
  quote: r.quote,
  reason: r.reason,
  judgedAt: iso(r.judged_at),
});

const STATUS_ORDER = "CASE c.status WHEN 'drifted' THEN 0 WHEN 'unsure' THEN 1 WHEN 'in_sync' THEN 2 WHEN 'updated' THEN 3 WHEN 'historical' THEN 4 ELSE 5 END";
/** Copies the owner settled; a rescan never changes or removes them. */
const STICKY = "('ignored', 'updated')";
/** Statuses the "All" list leaves out (shown under their own filter): see `ALL_FILTER_STATUSES`. */
const NOT_IN_ALL = "'ignored'";
/** Copies of facts that are still confirmed (a rejected or removed fact's copies are not shown or counted). */
const CONFIRMED_JOIN = "JOIN facts f ON f.id = c.fact_id AND f.status = 'confirmed'";
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');
const isDuplicateKey = (err: unknown): boolean => err instanceof Error && /duplicate entry|\b1062\b/i.test(err.message);

export const sqlScanRepo: ScanRepo = {
  async latestScan(sourcePageId) {
    const rows = await query<ScanDbRow>(`SELECT ${SCAN_COLUMNS} FROM scan_jobs WHERE source_page_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`, sourcePageId);
    return rows[0] ? toScan(rows[0]) : undefined;
  },

  async getScan(scanId) {
    const rows = await query<ScanDbRow>(`SELECT ${SCAN_COLUMNS} FROM scan_jobs WHERE id = ?`, scanId);
    return rows[0] ? toScan(rows[0]) : undefined;
  },

  async createScan(sourcePageId, factIds, actor) {
    const id = randomUUID();
    try {
      await execute(
        "INSERT INTO scan_jobs (id, source_page_id, status, facts_total, fact_ids, requested_by, active_source) VALUES (?, ?, 'searching', ?, ?, ?, ?)",
        id,
        sourcePageId,
        factIds.length,
        JSON.stringify(factIds),
        actor,
        sourcePageId,
      );
    } catch (err) {
      if (isDuplicateKey(err)) return undefined;
      throw err;
    }
    return id;
  },

  async touchScan(scanId) {
    await execute('UPDATE scan_jobs SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', scanId);
  },

  async setTerms(scanId, terms, synonymsCached = 0) {
    await execute('UPDATE scan_jobs SET terms = ?, synonyms_cached = ? WHERE id = ?', JSON.stringify(terms), synonymsCached, scanId);
  },

  async factSearchTerms(factIds) {
    const out = new Map<string, CachedTerms>();
    if (factIds.length === 0) return out;
    const rows = await query<{ id: string; search_terms: unknown }>(
      `SELECT id, search_terms FROM facts WHERE search_terms IS NOT NULL AND id IN (${factIds.map(() => '?').join(', ')})`,
      ...factIds,
    );
    for (const r of rows) {
      const v = json(r.search_terms) as { key?: unknown; terms?: unknown } | null;
      if (v && typeof v.key === 'string' && Array.isArray(v.terms)) out.set(r.id, { key: v.key, terms: v.terms.filter((t): t is string => typeof t === 'string') });
    }
    return out;
  },

  async saveFactSearchTerms(factId, cached) {
    await execute('UPDATE facts SET search_terms = ? WHERE id = ?', JSON.stringify(cached), factId);
  },

  async addLlmCalls(scanId, n) {
    await execute('UPDATE scan_jobs SET llm_calls = llm_calls + ? WHERE id = ?', n, scanId);
  },

  async addHits(scanId, hits) {
    for (const h of hits) {
      await execute(
        'INSERT IGNORE INTO scan_hits (scan_id, fact_id, page_id, title, page_url) VALUES (?, ?, ?, ?, ?)',
        scanId,
        h.factId,
        h.pageId,
        h.title.slice(0, 255),
        h.url ? h.url.slice(0, 500) : null,
      );
    }
  },

  async advanceSearch(scanId, factCursor) {
    const rows = await query<{ n: number | string }>('SELECT COUNT(DISTINCT page_id) AS n FROM scan_hits WHERE scan_id = ?', scanId);
    await execute('UPDATE scan_jobs SET fact_cursor = ?, candidates = ? WHERE id = ?', factCursor, Number(rows[0]?.n ?? 0), scanId);
  },

  async startJudging(scanId) {
    await execute("UPDATE scan_jobs SET status = 'judging' WHERE id = ? AND status = 'searching'", scanId);
  },

  async pendingPages(scanId, limit) {
    const pages = await query<{ page_id: string }>(
      // Inline LIMIT: Forge SQL (TiDB) rejects a bound `LIMIT ?` (ER_WRONG_ARGUMENTS).
      `SELECT DISTINCT page_id FROM scan_hits WHERE scan_id = ? AND status = 'pending' ORDER BY page_id LIMIT ${sqlInt(limit, 1, 100)}`,
      scanId,
    );
    if (pages.length === 0) return [];
    const ids = pages.map((p) => p.page_id);
    const rows = await query<{ page_id: string; fact_id: string; title: string | null; page_url: string | null }>(
      `SELECT page_id, fact_id, title, page_url FROM scan_hits WHERE scan_id = ? AND status = 'pending' AND page_id IN (${placeholders(ids.length)})`,
      scanId,
      ...ids,
    );
    return ids.map((pageId) => {
      const own = rows.filter((r) => r.page_id === pageId);
      return { pageId, title: own[0]?.title ?? '', url: own[0]?.page_url ?? null, factIds: [...new Set(own.map((r) => r.fact_id))] };
    });
  },

  async candidatesPerFact(scanId) {
    const rows = await query<{ fact_id: string; n: number | string }>('SELECT fact_id, COUNT(DISTINCT page_id) AS n FROM scan_hits WHERE scan_id = ? GROUP BY fact_id', scanId);
    return Object.fromEntries(rows.map((r) => [r.fact_id, Number(r.n)]));
  },

  async chunkResults(scanId, pageId) {
    const rows = await query<{ chunk_hash: string; result: unknown }>('SELECT chunk_hash, result FROM scan_chunks WHERE scan_id = ? AND page_id = ?', scanId, pageId);
    const out = new Map<string, ChunkResult>();
    for (const r of rows) {
      const v = json(r.result) as Partial<ChunkResult> | null;
      if (v && Array.isArray(v.judgements)) out.set(r.chunk_hash, { judgements: v.judgements, dropped: Number(v.dropped ?? 0) });
    }
    return out;
  },

  async saveChunkResult(scanId, pageId, chunkHash, result) {
    await execute(
      'INSERT INTO scan_chunks (scan_id, page_id, chunk_hash, result) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE result = VALUES(result)',
      scanId,
      pageId,
      chunkHash,
      JSON.stringify(result),
    );
  },

  async finishPage(scanId, sourcePageId, pageId, copies) {
    await execute(`DELETE FROM copies WHERE source_page_id = ? AND page_id = ? AND scan_id <> ? AND status NOT IN ${STICKY}`, sourcePageId, pageId, scanId);
    for (const c of copies) {
      await execute(
        `INSERT INTO copies (id, source_page_id, fact_id, page_id, page_title, page_url, page_version, status, stated_value, stated_unit,
           stated_condition, mention, quote, reason, scan_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           page_title = IF(status IN ${STICKY}, page_title, VALUES(page_title)),
           page_url = IF(status IN ${STICKY}, page_url, VALUES(page_url)),
           page_version = IF(status IN ${STICKY}, page_version, VALUES(page_version)),
           stated_value = IF(status IN ${STICKY}, stated_value, VALUES(stated_value)),
           stated_unit = IF(status IN ${STICKY}, stated_unit, VALUES(stated_unit)),
           stated_condition = IF(status IN ${STICKY}, stated_condition, VALUES(stated_condition)),
           mention = IF(status IN ${STICKY}, mention, VALUES(mention)),
           quote = IF(status IN ${STICKY}, quote, VALUES(quote)),
           reason = IF(status IN ${STICKY}, reason, VALUES(reason)),
           judged_at = IF(status IN ${STICKY}, judged_at, CURRENT_TIMESTAMP),
           scan_id = VALUES(scan_id),
           status = IF(status IN ${STICKY}, status, VALUES(status))`,
        randomUUID(),
        sourcePageId,
        c.factId,
        c.pageId,
        c.pageTitle.slice(0, 255),
        c.pageUrl ? c.pageUrl.slice(0, 500) : null,
        c.pageVersion,
        c.status,
        c.statedValue,
        c.statedUnit,
        c.statedCondition,
        c.mention,
        c.quote,
        c.reason.slice(0, 255),
        scanId,
      );
    }
    const updated = await execute("UPDATE scan_hits SET status = 'done' WHERE scan_id = ? AND page_id = ? AND status = 'pending'", scanId, pageId);
    if (updated > 0) await execute('UPDATE scan_jobs SET pages_judged = pages_judged + 1 WHERE id = ?', scanId);
    await execute('DELETE FROM scan_chunks WHERE scan_id = ? AND page_id = ?', scanId, pageId);
  },

  async skipPage(scanId, pageId) {
    const updated = await execute("UPDATE scan_hits SET status = 'skipped' WHERE scan_id = ? AND page_id = ? AND status = 'pending'", scanId, pageId);
    if (updated > 0) await execute('UPDATE scan_jobs SET pages_skipped = pages_skipped + 1 WHERE id = ?', scanId);
    await execute('DELETE FROM scan_chunks WHERE scan_id = ? AND page_id = ?', scanId, pageId);
  },

  async finishScan(scanId, sourcePageId, partial) {
    if (!partial) await execute(`DELETE FROM copies WHERE source_page_id = ? AND scan_id <> ? AND status NOT IN ${STICKY}`, sourcePageId, scanId);
    await execute(
      "UPDATE scan_jobs SET status = 'done', partial = ?, finished_at = CURRENT_TIMESTAMP, error = NULL, active_source = NULL WHERE id = ?",
      partial ? 1 : 0,
      scanId,
    );
    await execute('DELETE FROM scan_hits WHERE scan_id = ?', scanId);
    await execute('DELETE FROM scan_chunks WHERE scan_id = ?', scanId);
  },

  async failScan(scanId, error) {
    await execute("UPDATE scan_jobs SET status = 'error', error = ?, finished_at = CURRENT_TIMESTAMP, active_source = NULL WHERE id = ?", error.slice(0, 255), scanId);
  },

  async discardScan(scanId, sourcePageId) {
    await execute('DELETE FROM copies WHERE source_page_id = ?', sourcePageId);
    await execute('DELETE FROM scan_hits WHERE scan_id = ?', scanId);
    await execute('DELETE FROM scan_chunks WHERE scan_id = ?', scanId);
    await execute('DELETE FROM scan_jobs WHERE id = ?', scanId);
  },

  async copyPageIds(sourcePageId) {
    const rows = await query<{ page_id: string }>(`SELECT DISTINCT c.page_id FROM copies c ${CONFIRMED_JOIN} WHERE c.source_page_id = ?`, sourcePageId);
    return rows.map((r) => r.page_id);
  },

  async countCopies(sourcePageId, pageIds) {
    const counts: CopyCounts = { ...EMPTY_COPY_COUNTS };
    if (pageIds && pageIds.length === 0) return counts;
    const pageFilter = pageIds ? `AND c.page_id IN (${placeholders(pageIds.length)})` : '';
    const rows = await query<{ status: string; n: number | string }>(
      `SELECT c.status, COUNT(*) AS n FROM copies c ${CONFIRMED_JOIN} WHERE c.source_page_id = ? ${pageFilter} GROUP BY c.status`,
      sourcePageId,
      ...(pageIds ?? []),
    );
    for (const r of rows) if (r.status in counts) counts[r.status as CopyStatus] = Number(r.n);
    return counts;
  },

  async listCopies(sourcePageId, status, pageIds) {
    if (pageIds.length === 0) return [];
    const filter = status ? 'AND c.status = ?' : `AND c.status NOT IN (${NOT_IN_ALL})`;
    const rows = await query<CopyDbRow>(
      `SELECT c.id, c.fact_id, c.page_id, c.page_title, c.page_url, c.status, c.stated_value, c.stated_unit, c.stated_condition, c.quote, c.reason,
         c.judged_at, f.subject, f.attribute, f.fact_condition, f.value, f.unit
       FROM copies c ${CONFIRMED_JOIN}
       WHERE c.source_page_id = ? ${filter} AND c.page_id IN (${placeholders(pageIds.length)})
       ORDER BY ${STATUS_ORDER}, c.page_title, c.id LIMIT ${MAX_LISTED_COPIES}`,
      sourcePageId,
      ...(status ? [status] : []),
      ...pageIds,
    );
    return rows.map(toCopy);
  },
};
