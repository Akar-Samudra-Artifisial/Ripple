import { randomUUID } from 'node:crypto';
import type { CopyCounts, CopyStatus, CopyView, ScanState, ScanView } from '../core/views';
import { execute, query } from './sql';

/** No progress for this long while running = stalled (a consumer died); `startScan` resumes it. */
export const STALL_SECONDS = 15 * 60;

export interface ScanRow extends ScanView {
  sourcePageId: string;
  factCursor: number;
  /** Fact id → extra search phrases, decided once per scan; null until the search consumer set them. */
  terms: Record<string, string[]> | null;
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

/** Storage of scans, candidate hits and copies (an in-memory fake implements it in tests). */
export interface ScanRepo {
  latestScan(sourcePageId: string): Promise<ScanRow | undefined>;
  getScan(scanId: string): Promise<ScanRow | undefined>;
  createScan(sourcePageId: string, factsTotal: number, actor: string): Promise<string>;
  /** Bumps `updated_at` (resume of a stalled scan). */
  touchScan(scanId: string): Promise<void>;
  setTerms(scanId: string, terms: Record<string, string[]>): Promise<void>;
  /** Idempotent (a resumed batch inserts the same hits again). */
  addHits(scanId: string, hits: readonly HitInput[]): Promise<void>;
  /** Fact `factCursor - 1` is searched; stores the distinct candidate count. */
  advanceSearch(scanId: string, factCursor: number): Promise<void>;
  startJudging(scanId: string): Promise<void>;
  pendingPages(scanId: string, limit: number): Promise<PendingPage[]>;
  /** Saves the copies of one judged page and marks its hits done (idempotent; `ignored`/`updated` copies are kept). */
  finishPage(scanId: string, sourcePageId: string, pageId: string, copies: readonly CopyInput[]): Promise<void>;
  /** Marks the scan done and removes copies an earlier scan found but this one did not (except ignored/updated). */
  finishScan(scanId: string, sourcePageId: string): Promise<void>;
  failScan(scanId: string, error: string): Promise<void>;
  countCopies(sourcePageId: string): Promise<CopyCounts>;
  listCopies(sourcePageId: string, status?: CopyStatus): Promise<CopyView[]>;
}

export const EMPTY_COPY_COUNTS: CopyCounts = { in_sync: 0, drifted: 0, unsure: 0, historical: 0, ignored: 0, updated: 0 };

interface ScanDbRow {
  id: string;
  source_page_id: string;
  status: string;
  facts_total: number;
  fact_cursor: number;
  terms: unknown;
  candidates: number;
  pages_judged: number;
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

function parseTerms(v: unknown): Record<string, string[]> | null {
  if (v === null || v === undefined) return null;
  const obj: unknown = typeof v === 'string' ? JSON.parse(v) : v;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out: Record<string, string[]> = {};
  for (const [k, list] of Object.entries(obj)) if (Array.isArray(list)) out[k] = list.filter((t): t is string => typeof t === 'string');
  return out;
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
    terms: parseTerms(r.terms),
    candidates: Number(r.candidates),
    pagesJudged: Number(r.pages_judged),
    startedAt: iso(r.started_at) ?? '',
    finishedAt: iso(r.finished_at),
    error: r.error,
  };
};

const SCAN_COLUMNS =
  'id, source_page_id, status, facts_total, fact_cursor, terms, candidates, pages_judged, error, started_at, finished_at, TIMESTAMPDIFF(SECOND, updated_at, CURRENT_TIMESTAMP) AS idle_seconds';

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

export const sqlScanRepo: ScanRepo = {
  async latestScan(sourcePageId) {
    const rows = await query<ScanDbRow>(`SELECT ${SCAN_COLUMNS} FROM scan_jobs WHERE source_page_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`, sourcePageId);
    return rows[0] ? toScan(rows[0]) : undefined;
  },

  async getScan(scanId) {
    const rows = await query<ScanDbRow>(`SELECT ${SCAN_COLUMNS} FROM scan_jobs WHERE id = ?`, scanId);
    return rows[0] ? toScan(rows[0]) : undefined;
  },

  async createScan(sourcePageId, factsTotal, actor) {
    const id = randomUUID();
    await execute("INSERT INTO scan_jobs (id, source_page_id, status, facts_total, requested_by) VALUES (?, ?, 'searching', ?, ?)", id, sourcePageId, factsTotal, actor);
    return id;
  },

  async touchScan(scanId) {
    await execute('UPDATE scan_jobs SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', scanId);
  },

  async setTerms(scanId, terms) {
    await execute('UPDATE scan_jobs SET terms = ? WHERE id = ?', JSON.stringify(terms), scanId);
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
      "SELECT DISTINCT page_id FROM scan_hits WHERE scan_id = ? AND status = 'pending' ORDER BY page_id LIMIT ?",
      scanId,
      limit,
    );
    if (pages.length === 0) return [];
    const ids = pages.map((p) => p.page_id);
    const rows = await query<{ page_id: string; fact_id: string; title: string | null; page_url: string | null }>(
      `SELECT page_id, fact_id, title, page_url FROM scan_hits WHERE scan_id = ? AND status = 'pending' AND page_id IN (${ids.map(() => '?').join(', ')})`,
      scanId,
      ...ids,
    );
    return ids.map((pageId) => {
      const own = rows.filter((r) => r.page_id === pageId);
      return { pageId, title: own[0]?.title ?? '', url: own[0]?.page_url ?? null, factIds: [...new Set(own.map((r) => r.fact_id))] };
    });
  },

  async finishPage(scanId, sourcePageId, pageId, copies) {
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
  },

  async finishScan(scanId, sourcePageId) {
    await execute(`DELETE FROM copies WHERE source_page_id = ? AND scan_id <> ? AND status NOT IN ${STICKY}`, sourcePageId, scanId);
    await execute("UPDATE scan_jobs SET status = 'done', finished_at = CURRENT_TIMESTAMP, error = NULL WHERE id = ?", scanId);
    await execute('DELETE FROM scan_hits WHERE scan_id = ?', scanId);
  },

  async failScan(scanId, error) {
    await execute("UPDATE scan_jobs SET status = 'error', error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", error.slice(0, 255), scanId);
  },

  async countCopies(sourcePageId) {
    const rows = await query<{ status: string; n: number | string }>('SELECT status, COUNT(*) AS n FROM copies WHERE source_page_id = ? GROUP BY status', sourcePageId);
    const counts: CopyCounts = { ...EMPTY_COPY_COUNTS };
    for (const r of rows) if (r.status in counts) counts[r.status as CopyStatus] = Number(r.n);
    return counts;
  },

  async listCopies(sourcePageId, status) {
    const filter = status ? 'AND c.status = ?' : "AND c.status <> 'historical'";
    const rows = await query<CopyDbRow>(
      `SELECT c.id, c.fact_id, c.page_id, c.page_title, c.page_url, c.status, c.stated_value, c.stated_unit, c.stated_condition, c.quote, c.reason,
         c.judged_at, f.subject, f.attribute, f.fact_condition, f.value, f.unit
       FROM copies c JOIN facts f ON f.id = c.fact_id
       WHERE c.source_page_id = ? ${filter}
       ORDER BY ${STATUS_ORDER}, c.page_title, c.id LIMIT 500`,
      ...(status ? [sourcePageId, status] : [sourcePageId]),
    );
    return rows.map(toCopy);
  },
};
