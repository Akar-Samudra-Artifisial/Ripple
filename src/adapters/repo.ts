/**
 * Forge SQL access for sources, facts and audit rows. Parameterised statements only. Forge SQL has no multi-statement
 * transactions here, so writes are ordered to be safe to repeat (a retried extraction converges to the same rows).
 */
import { randomUUID } from 'node:crypto';
import type { CleanEdit, ExtractedFact, MergePlan, StoredFact } from '../core/facts';
import type { FactCounts, FactStatus, FactType, FactView, SourceState, SourceView } from '../core/views';
import { execute, query } from './sql';

export interface MarkInput {
  pageId: string;
  spaceId: string | null;
  title: string | null;
  accountId: string;
}

export interface PageVersionInfo {
  title: string;
  spaceId: string;
  version: number;
  versionAt: string | null;
  /** The page text was cut at the LLM input limit. */
  truncated: boolean;
}

/** Storage used by the resolvers and the `extract` consumer (an in-memory fake implements it in tests). */
export interface FactRepo {
  getSource(pageId: string): Promise<SourceView | undefined>;
  /** Creates the source row, or resets an existing one to `extracting`. */
  markSource(input: MarkInput): Promise<void>;
  setExtractJob(pageId: string, jobId: string): Promise<void>;
  finishExtraction(pageId: string, page: PageVersionInfo): Promise<void>;
  failExtraction(pageId: string, error: string): Promise<void>;
  /** Deletes the source row and all its facts. */
  unmarkSource(pageId: string): Promise<void>;
  listFacts(pageId: string): Promise<FactView[]>;
  storedFacts(pageId: string): Promise<StoredFact[]>;
  countFacts(pageId: string): Promise<FactCounts>;
  getFact(factId: string): Promise<(FactView & { sourcePageId: string; identityKey: string }) | undefined>;
  /**
   * Applies the plan with status guards (see `FactUpdate.from`): a fact reviewed after the plan was made keeps the
   * review, and a rejected fact is never changed.
   */
  applyMerge(pageId: string, plan: MergePlan, page: PageVersionInfo): Promise<void>;
  setFactStatus(factId: string, status: FactStatus, actor: string): Promise<void>;
  /** False when another fact of the page already has the edited identity key. */
  editFact(factId: string, pageId: string, edit: CleanEdit, actor: string): Promise<boolean>;
  audit(action: string, actor: string | null, subjectType: string, subjectId: string, detail?: Record<string, unknown>): Promise<void>;
}

interface SourceRow {
  page_id: string;
  title: string | null;
  status: string;
  page_version: number | null;
  marked_at: unknown;
  extracted_at: unknown;
  extract_error: string | null;
  text_truncated: number | boolean | null;
}

interface FactRow {
  id: string;
  source_page_id: string;
  identity_key: string;
  origin_key: string | null;
  fact_type: string;
  subject: string;
  attribute: string;
  value: string;
  unit: string | null;
  fact_condition: string | null;
  quote: string;
  status: string;
  edited: number | boolean;
  previous_value: string | null;
  page_version: number;
  effective_since: string | null;
}

const FACT_COLUMNS =
  'id, source_page_id, identity_key, origin_key, fact_type, subject, attribute, value, unit, fact_condition, quote, status, edited, previous_value, page_version, effective_since';

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

const toSource = (r: SourceRow): SourceView => ({
  pageId: r.page_id,
  title: r.title,
  state: r.status as SourceState,
  pageVersion: r.page_version === null ? null : Number(r.page_version),
  markedAt: iso(r.marked_at) ?? '',
  extractedAt: iso(r.extracted_at),
  error: r.extract_error,
  truncated: Boolean(Number(r.text_truncated ?? 0)),
});

const toFact = (r: FactRow): FactView => ({
  id: r.id,
  type: r.fact_type as FactType,
  subject: r.subject,
  attribute: r.attribute,
  value: r.value,
  unit: r.unit,
  condition: r.fact_condition,
  quote: r.quote,
  status: r.status as FactStatus,
  edited: Boolean(Number(r.edited)),
  previousValue: r.previous_value,
  pageVersion: Number(r.page_version),
  effectiveSince: r.effective_since,
});

const STATUS_ORDER = "CASE status WHEN 'confirmed' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END";

export const sqlRepo: FactRepo = {
  async getSource(pageId) {
    const rows = await query<SourceRow>(
      'SELECT page_id, title, status, page_version, marked_at, extracted_at, extract_error, text_truncated FROM sources WHERE page_id = ?',
      pageId,
    );
    return rows[0] ? toSource(rows[0]) : undefined;
  },

  async markSource({ pageId, spaceId, title, accountId }) {
    await execute(
      `INSERT INTO sources (page_id, space_id, title, status, marked_by) VALUES (?, ?, ?, 'extracting', ?)
       ON DUPLICATE KEY UPDATE status = 'extracting', extract_error = NULL`,
      pageId,
      spaceId,
      title,
      accountId,
    );
  },

  async setExtractJob(pageId, jobId) {
    await execute('UPDATE sources SET extract_job = ? WHERE page_id = ?', jobId, pageId);
  },

  async finishExtraction(pageId, page) {
    await execute(
      `UPDATE sources SET status = 'ready', title = ?, space_id = ?, page_version = ?, page_version_at = ?, text_truncated = ?,
       extracted_at = CURRENT_TIMESTAMP, extract_error = NULL WHERE page_id = ?`,
      page.title.slice(0, 255),
      page.spaceId,
      page.version,
      page.versionAt,
      page.truncated ? 1 : 0,
      pageId,
    );
  },

  async failExtraction(pageId, error) {
    await execute("UPDATE sources SET status = 'error', extract_error = ? WHERE page_id = ?", error.slice(0, 255), pageId);
  },

  async unmarkSource(pageId) {
    // Facts first: a retry after a failure in between still finds the source row and finishes the job.
    await execute('DELETE FROM facts WHERE source_page_id = ?', pageId);
    await execute('DELETE FROM sources WHERE page_id = ?', pageId);
  },

  async listFacts(pageId) {
    const rows = await query<FactRow>(`SELECT ${FACT_COLUMNS} FROM facts WHERE source_page_id = ? ORDER BY ${STATUS_ORDER}, created_at, id`, pageId);
    return rows.map(toFact);
  },

  async storedFacts(pageId) {
    const rows = await query<FactRow>(`SELECT ${FACT_COLUMNS} FROM facts WHERE source_page_id = ?`, pageId);
    return rows.map((r) => ({ id: r.id, identityKey: r.identity_key, originKey: r.origin_key, status: r.status as FactStatus, edited: Boolean(Number(r.edited)), value: r.value, unit: r.unit }));
  },

  async countFacts(pageId) {
    const rows = await query<{ status: string; n: number | string }>('SELECT status, COUNT(*) AS n FROM facts WHERE source_page_id = ? GROUP BY status', pageId);
    const counts: FactCounts = { proposed: 0, confirmed: 0, rejected: 0 };
    for (const r of rows) if (r.status === 'proposed' || r.status === 'confirmed' || r.status === 'rejected') counts[r.status] = Number(r.n);
    return counts;
  },

  async getFact(factId) {
    const rows = await query<FactRow>(`SELECT ${FACT_COLUMNS} FROM facts WHERE id = ?`, factId);
    const r = rows[0];
    return r ? { ...toFact(r), sourcePageId: r.source_page_id, identityKey: r.identity_key } : undefined;
  },

  async applyMerge(pageId, plan, page) {
    for (const id of plan.remove) await execute("DELETE FROM facts WHERE id = ? AND status = 'proposed' AND edited = 0", id);
    for (const u of plan.update) {
      if (u.refreshOnly) {
        await execute(
          "UPDATE facts SET quote = ?, page_version = ?, effective_since = ? WHERE id = ? AND status <> 'rejected'",
          u.fact.quote,
          page.version,
          page.versionAt,
          u.id,
        );
      } else {
        await execute(
          `UPDATE facts SET fact_type = ?, subject = ?, attribute = ?, value = ?, unit = ?, fact_condition = ?, quote = ?, status = ?,
           previous_value = COALESCE(?, previous_value), page_version = ?, effective_since = ?, reviewed_by = NULL, reviewed_at = NULL
           WHERE id = ? AND status = ? AND status <> 'rejected' AND edited = 0`,
          u.fact.type,
          u.fact.subject,
          u.fact.attribute,
          u.fact.value,
          u.fact.unit,
          u.fact.condition,
          u.fact.quote,
          u.status,
          u.previousValue,
          page.version,
          page.versionAt,
          u.id,
          u.from,
        );
      }
    }
    for (const f of plan.insert) await insertFact(pageId, f, page);
  },

  async setFactStatus(factId, status, actor) {
    await execute('UPDATE facts SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?', status, actor, factId);
  },

  async editFact(factId, pageId, edit, actor) {
    const clash = await query<{ id: string }>('SELECT id FROM facts WHERE source_page_id = ? AND identity_key = ? AND id <> ?', pageId, edit.identityKey, factId);
    if (clash.length > 0) return false;
    await execute(
      `UPDATE facts SET subject = ?, attribute = ?, value = ?, unit = ?, fact_condition = ?, identity_key = ?, edited = 1, status = 'confirmed',
       reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      edit.subject,
      edit.attribute,
      edit.value,
      edit.unit,
      edit.condition,
      edit.identityKey,
      actor,
      factId,
    );
    return true;
  },

  async audit(action, actor, subjectType, subjectId, detail) {
    await execute(
      'INSERT INTO audit (id, action, actor_account_id, subject_type, subject_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
      randomUUID(),
      action,
      actor,
      subjectType,
      subjectId,
      detail ? JSON.stringify(detail) : null,
    );
  },
};

/** Insert keyed on (page, identity key); a duplicate from a concurrent run is ignored. */
async function insertFact(pageId: string, f: ExtractedFact, page: PageVersionInfo): Promise<void> {
  await execute(
    `INSERT IGNORE INTO facts (id, source_page_id, identity_key, origin_key, fact_type, subject, attribute, value, unit, fact_condition, quote, status, page_version, effective_since)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    randomUUID(),
    pageId,
    f.identityKey,
    f.identityKey,
    f.type,
    f.subject,
    f.attribute,
    f.value,
    f.unit,
    f.condition,
    f.quote,
    page.version,
    page.versionAt,
  );
}
