/**
 * Forge SQL access for M3 change detection: pending/decided changes of a source, the updated:page dedup table, the
 * copies a change affects and the writes of a confirmation. Parameterised statements only; writes carry status guards
 * so a repeated or concurrent call converges (Forge SQL has no multi-statement transactions here).
 */
import { createHash, randomUUID } from 'node:crypto';
import { dismissedValueText, type ChangeImpact, type CopyForImpact, type FactChange } from '../core/changes';
import type { CopyStatus, TeamSource } from '../core/views';
import { execute, query } from './sql';

export type ChangeState = 'pending' | 'confirmed' | 'dismissed' | 'superseded';

/** Who a confirmed change is routed to (M4 creates proposals / Jira issues from it). */
export interface ChangeRouting {
  deadline: string;
  pages: { pageId: string; spaceId: string | null; ownerAccountId: string | null; ownerRole: 'owner' | 'author' | null; copies: number }[];
  /** `unknown`: the teams could not be read at confirm time (no team ids recorded; resolve again before routing). */
  spaces: { spaceId: string; teamIds: string[]; teamSource: TeamSource }[];
}

export interface ChangeRow {
  id: string;
  sourcePageId: string;
  status: ChangeState;
  pageVersion: number;
  factChanges: FactChange[];
  missingFactIds: string[];
  impact: ChangeImpact | null;
  /** Set once confirmed. */
  routing: ChangeRouting | null;
  deadlineDays: number | null;
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
  /** Lets a redelivered event through again (the diff could not be queued). */
  releasePageEvent(pageId: string, version: number): Promise<void>;
  /**
   * Pending → `status`, only while the row still holds `version` (the version the user reviewed); false when it was
   * decided or replaced by a newer version meanwhile.
   */
  decide(changeId: string, version: number, status: 'confirmed' | 'dismissed', actor: string, deadlineDays: number | null, routing: ChangeRouting | null): Promise<boolean>;
  /** Sets a confirmed fact to its new value (old value kept in `previous_value`); false when the fact changed meanwhile. */
  applyFactChange(sourcePageId: string, change: FactChange): Promise<boolean>;
  /** After a confirmed change: copies stating the old value become drifted, drifted ones stating the new value in sync. */
  restatusCopies(toDrift: readonly string[], toSync: readonly string[]): Promise<number>;
  /** sha256 of the source text the last diff read; null before the first diff. */
  textHash(pageId: string): Promise<string | null>;
  setTextHash(pageId: string, hash: string): Promise<void>;
  /** `dismissalKey(factId, valueHash(value, unit))` of every value dismissed for the source. */
  dismissedValues(sourcePageId: string): Promise<Set<string>>;
  /** Remembers the new values of a dismissed change (repeat-safe). */
  saveDismissals(sourcePageId: string, changes: readonly FactChange[]): Promise<void>;
  /** The most recent confirmed changes of the source, newest decision first. */
  confirmedChanges(sourcePageId: string): Promise<ChangeRow[]>;
  /**
   * Undoes `applyFactChange` (old value and unit back, quote kept): only while the fact still holds the change's new
   * value with its old value as `previous_value`. Then the given copies drifted by that confirmation are in sync again.
   */
  revertFactChange(sourcePageId: string, change: FactChange, copyIds: readonly string[], changeId?: string): Promise<{ reverted: boolean; copies: number; proposals?: number }>;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export const valueHash = (value: string, unit: string | null): string => sha256(dismissedValueText(value, unit));
export const dismissalKey = (factId: string, hash: string): string => `${factId}:${hash}`;

/** page_events rows are only needed while Confluence may redeliver an event. */
export const PAGE_EVENT_RETENTION_DAYS = 30;

interface ChangeDbRow {
  id: string;
  source_page_id: string;
  status: string;
  page_version: number;
  fact_changes: unknown;
  missing_fact_ids: unknown;
  impact: unknown;
  routing: unknown;
  deadline_days: number | null;
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
  routing: (json(r.routing) as ChangeRouting | null) ?? null,
  deadlineDays: r.deadline_days === null || r.deadline_days === undefined ? null : Number(r.deadline_days),
  createdAt: iso(r.created_at),
});

const CHANGE_COLUMNS = 'id, source_page_id, status, page_version, fact_changes, missing_fact_ids, impact, routing, deadline_days, created_at';
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

const DRIFT_REASON = 'The official value changed; this copy states the old value.';
const SAME_REASON = 'Already states the new official value.';
/** Same text as the copy scan's in-sync reason (`src/core/copies.ts`). */
const RESTORED_REASON = 'Same value as the source.';
/** Confirmed changes read when looking for wording-only confirmations to undo. */
const CONFIRMED_CHANGES_READ = 20;

export const sqlChangeRepo: ChangeRepo = {
  async claimPageEvent(pageId, version) {
    // Bounded table: events older than the retention are dropped on every insert.
    await execute(`DELETE FROM page_events WHERE created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${PAGE_EVENT_RETENTION_DAYS} DAY)`);
    return (await execute('INSERT IGNORE INTO page_events (page_id, version) VALUES (?, ?)', pageId, version)) > 0;
  },

  async releasePageEvent(pageId, version) {
    await execute('DELETE FROM page_events WHERE page_id = ? AND version = ?', pageId, version);
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

  async decide(changeId, version, status, actor, deadlineDays, routing) {
    const n = await execute(
      "UPDATE changes SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, deadline_days = ?, routing = ? WHERE id = ? AND status = 'pending' AND page_version = ?",
      status,
      actor,
      deadlineDays,
      routing ? JSON.stringify(routing) : null,
      changeId,
      version,
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
      // `updated` copies (Ripple applied an earlier change) state a value this change replaces again.
      n = await execute(`UPDATE copies SET status = 'drifted', reason = ? WHERE status IN ('in_sync', 'updated') AND id IN (${placeholders(toDrift.length)})`, DRIFT_REASON, ...toDrift);
    }
    if (toSync.length > 0) {
      await execute(`UPDATE copies SET status = 'in_sync', reason = ? WHERE status = 'drifted' AND id IN (${placeholders(toSync.length)})`, SAME_REASON, ...toSync);
    }
    return n;
  },

  async textHash(pageId) {
    const rows = await query<{ text_hash: string | null }>('SELECT text_hash FROM sources WHERE page_id = ?', pageId);
    return rows[0]?.text_hash ?? null;
  },

  async setTextHash(pageId, hash) {
    await execute('UPDATE sources SET text_hash = ? WHERE page_id = ?', hash, pageId);
  },

  async dismissedValues(sourcePageId) {
    const rows = await query<{ fact_id: string; value_hash: string }>('SELECT fact_id, value_hash FROM change_dismissals WHERE source_page_id = ?', sourcePageId);
    return new Set(rows.map((r) => dismissalKey(r.fact_id, r.value_hash)));
  },

  async saveDismissals(sourcePageId, changes) {
    for (const c of changes) {
      await execute('INSERT IGNORE INTO change_dismissals (fact_id, value_hash, source_page_id) VALUES (?, ?, ?)', c.factId, valueHash(c.newValue, c.newUnit), sourcePageId);
    }
  },

  async confirmedChanges(sourcePageId) {
    const rows = await query<ChangeDbRow>(
      `SELECT ${CHANGE_COLUMNS} FROM changes WHERE source_page_id = ? AND status = 'confirmed' ORDER BY decided_at DESC, id DESC LIMIT ${CONFIRMED_CHANGES_READ}`,
      sourcePageId,
    );
    return rows.map(toChange);
  },

  async revertFactChange(sourcePageId, c, copyIds, changeId) {
    const n = await execute(
      `UPDATE facts SET value = ?, unit = ?, previous_value = NULL
       WHERE id = ? AND source_page_id = ? AND status = 'confirmed' AND value = ? AND previous_value = ?`,
      c.oldValue,
      c.oldUnit,
      c.factId,
      sourcePageId,
      c.newValue,
      c.oldValue,
    );
    if (n === 0) return { reverted: false, copies: 0, proposals: 0 };
    // M4: open edit proposals of that confirmation would write the reverted value; applied ones stay as history.
    const proposals =
      changeId === undefined
        ? 0
        : await execute(
            "UPDATE proposals SET status = 'rejected', error_code = 'reverted' WHERE change_id = ? AND fact_id = ? AND status IN ('proposed', 'stale', 'needs_manual')",
            changeId,
            c.factId,
          );
    if (copyIds.length === 0) return { reverted: true, copies: 0, proposals };
    // Only copies still drifted for the reason the confirmation gave (a rescan may have re-judged them meanwhile).
    const copies = await execute(
      `UPDATE copies SET status = 'in_sync', reason = ? WHERE status = 'drifted' AND reason = ? AND fact_id = ? AND id IN (${placeholders(copyIds.length)})`,
      RESTORED_REASON,
      DRIFT_REASON,
      c.factId,
      ...copyIds,
    );
    return { reverted: true, copies, proposals };
  },
};
