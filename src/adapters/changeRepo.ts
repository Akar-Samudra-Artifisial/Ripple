/**
 * Forge SQL access for M3 change detection: pending/decided changes of a source, the updated:page dedup table, the
 * copies a change affects and the writes of a confirmation. Parameterised statements only; writes carry status guards
 * so a repeated or concurrent call converges (Forge SQL has no multi-statement transactions here).
 */
import { randomUUID } from 'node:crypto';
import type { ChangeImpact, CopyForImpact, FactChange } from '../core/changes';
import type { CopyStatus } from '../core/views';
import { execute, query } from './sql';

export type ChangeState = 'pending' | 'confirmed' | 'dismissed' | 'superseded';

/** Who a confirmed change is routed to (M4 creates proposals / Jira issues from it). */
export interface ChangeRouting {
  deadline: string;
  pages: { pageId: string; spaceId: string | null; ownerAccountId: string | null; ownerRole: 'owner' | 'author' | null; copies: number }[];
  spaces: { spaceId: string; teamIds: string[]; teamSource: 'teamwork_graph' | 'none' }[];
}

export interface ChangeRow {
  id: string;
  sourcePageId: string;
  status: ChangeState;
  pageVersion: number;
  factChanges: FactChange[];
  missingFactIds: string[];
  impact: ChangeImpact | null;
  createdAt: string | null;
}

export interface CopyForChange extends CopyForImpact {
  pageTitle: string | null;
  pageUrl: string | null;
}

export interface ChangeRepo {
  /** True the first time a page version is seen (INSERT IGNORE); false for a redelivered event. */
  claimPageEvent(pageId: string, version: number): Promise<boolean>;
  pendingChange(sourcePageId: string): Promise<ChangeRow | undefined>;
  getChange(changeId: string): Promise<ChangeRow | undefined>;
  /**
   * At most one pending change per source: an existing pending row is replaced in place (same id, the newest
   * version's content); otherwise a new row is inserted. Returns the id.
   */
  savePending(sourcePageId: string, version: number, changes: readonly FactChange[], missing: readonly string[], impact: ChangeImpact): Promise<{ id: string; replaced: boolean }>;
  /** The page no longer changes any confirmed value: an older pending change is superseded. */
  supersedePending(sourcePageId: string): Promise<number>;
  /** Copies of the last scan(s) for these facts of the source. */
  copiesForFacts(sourcePageId: string, factIds: readonly string[]): Promise<CopyForChange[]>;
  /** Pending → `status`; false when the change was decided meanwhile. */
  decide(changeId: string, status: 'confirmed' | 'dismissed', actor: string, deadlineDays: number | null, routing: ChangeRouting | null): Promise<boolean>;
  /** Sets a confirmed fact to its new value (old value kept in `previous_value`); false when the fact changed meanwhile. */
  applyFactChange(sourcePageId: string, change: FactChange): Promise<boolean>;
  /** After a confirmed change: copies stating the old value become drifted, drifted ones stating the new value in sync. */
  restatusCopies(toDrift: readonly string[], toSync: readonly string[]): Promise<number>;
}

interface ChangeDbRow {
  id: string;
  source_page_id: string;
  status: string;
  page_version: number;
  fact_changes: unknown;
  missing_fact_ids: unknown;
  impact: unknown;
  created_at: unknown;
}

const json = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

const toChange = (r: ChangeDbRow): ChangeRow => ({
  id: r.id,
  sourcePageId: r.source_page_id,
  status: r.status as ChangeState,
  pageVersion: Number(r.page_version),
  factChanges: (json(r.fact_changes) as FactChange[] | null) ?? [],
  missingFactIds: (json(r.missing_fact_ids) as string[] | null) ?? [],
  impact: (json(r.impact) as ChangeImpact | null) ?? null,
  createdAt: iso(r.created_at),
});

const CHANGE_COLUMNS = 'id, source_page_id, status, page_version, fact_changes, missing_fact_ids, impact, created_at';
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

const DRIFT_REASON = 'The official value changed; this copy states the old value.';
const SAME_REASON = 'Already states the new official value.';

export const sqlChangeRepo: ChangeRepo = {
  async claimPageEvent(pageId, version) {
    return (await execute('INSERT IGNORE INTO page_events (page_id, version) VALUES (?, ?)', pageId, version)) > 0;
  },

  async pendingChange(sourcePageId) {
    const rows = await query<ChangeDbRow>(
      `SELECT ${CHANGE_COLUMNS} FROM changes WHERE source_page_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1`,
      sourcePageId,
    );
    return rows[0] ? toChange(rows[0]) : undefined;
  },

  async getChange(changeId) {
    const rows = await query<ChangeDbRow>(`SELECT ${CHANGE_COLUMNS} FROM changes WHERE id = ?`, changeId);
    return rows[0] ? toChange(rows[0]) : undefined;
  },

  async savePending(sourcePageId, version, changes, missing, impact) {
    const existing = await this.pendingChange(sourcePageId);
    const body = [JSON.stringify(changes), JSON.stringify(missing), JSON.stringify(impact)];
    if (existing) {
      const n = await execute(
        "UPDATE changes SET page_version = ?, fact_changes = ?, missing_fact_ids = ?, impact = ? WHERE id = ? AND status = 'pending'",
        version,
        ...body,
        existing.id,
      );
      if (n > 0) return { id: existing.id, replaced: true };
    }
    const id = randomUUID();
    await execute(
      "INSERT INTO changes (id, source_page_id, status, page_version, fact_changes, missing_fact_ids, impact) VALUES (?, ?, 'pending', ?, ?, ?, ?)",
      id,
      sourcePageId,
      version,
      ...body,
    );
    return { id, replaced: false };
  },

  async supersedePending(sourcePageId) {
    return execute("UPDATE changes SET status = 'superseded' WHERE source_page_id = ? AND status = 'pending'", sourcePageId);
  },

  async copiesForFacts(sourcePageId, factIds) {
    if (factIds.length === 0) return [];
    const rows = await query<{
      id: string;
      fact_id: string;
      page_id: string;
      page_title: string | null;
      page_url: string | null;
      status: string;
      stated_value: string | null;
      stated_unit: string | null;
    }>(
      `SELECT id, fact_id, page_id, page_title, page_url, status, stated_value, stated_unit FROM copies
       WHERE source_page_id = ? AND fact_id IN (${placeholders(factIds.length)}) ORDER BY page_id, id`,
      sourcePageId,
      ...factIds,
    );
    return rows.map((r) => ({
      id: r.id,
      factId: r.fact_id,
      pageId: r.page_id,
      pageTitle: r.page_title,
      pageUrl: r.page_url,
      status: r.status as CopyStatus,
      statedValue: r.stated_value,
      statedUnit: r.stated_unit,
    }));
  },

  async decide(changeId, status, actor, deadlineDays, routing) {
    const n = await execute(
      "UPDATE changes SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, deadline_days = ?, routing = ? WHERE id = ? AND status = 'pending'",
      status,
      actor,
      deadlineDays,
      routing ? JSON.stringify(routing) : null,
      changeId,
    );
    return n > 0;
  },

  async applyFactChange(sourcePageId, c) {
    const n = await execute(
      `UPDATE facts SET value = ?, unit = ?, quote = ?, previous_value = ?, page_version = ?, effective_since = ?
       WHERE id = ? AND source_page_id = ? AND status = 'confirmed' AND value = ?`,
      c.newValue,
      c.newUnit,
      c.newQuote,
      c.oldValue,
      c.version,
      c.versionAt,
      c.factId,
      sourcePageId,
      c.oldValue,
    );
    return n > 0;
  },

  async restatusCopies(toDrift, toSync) {
    let n = 0;
    // Status guards: sticky ignored/updated copies and copies re-judged meanwhile are left alone.
    if (toDrift.length > 0) {
      n = await execute(`UPDATE copies SET status = 'drifted', reason = ? WHERE status = 'in_sync' AND id IN (${placeholders(toDrift.length)})`, DRIFT_REASON, ...toDrift);
    }
    if (toSync.length > 0) {
      await execute(`UPDATE copies SET status = 'in_sync', reason = ? WHERE status = 'drifted' AND id IN (${placeholders(toSync.length)})`, SAME_REASON, ...toSync);
    }
    return n;
  },
};
