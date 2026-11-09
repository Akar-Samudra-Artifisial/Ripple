/**
 * Forge SQL access for M4 proposals (one edit of one copy per confirmed change). Parameterised statements only; every
 * status change carries a status guard so a double click, a retry or a concurrent call converges.
 */
import { randomUUID } from 'node:crypto';
import type { ProposalErrorCode, ProposalMethod, ProposalStatus } from '../core/proposals';
import type { CopyStatus } from '../core/views';
import { execute, query } from './sql';

export interface ProposalRow {
  id: string;
  changeId: string;
  copyId: string;
  factId: string;
  sourcePageId: string;
  pageId: string;
  /** Version of the copy page the sentences were read from. */
  pageVersion: number | null;
  oldSentence: string | null;
  newSentence: string | null;
  oldValue: string | null;
  newValue: string | null;
  status: ProposalStatus;
  method: ProposalMethod | null;
  appliedVersion: number | null;
  appliedBy: string | null;
  errorCode: ProposalErrorCode | null;
}

/** What a proposal job writes for one copy. */
export interface ProposalDraft {
  changeId: string;
  copyId: string;
  factId: string;
  sourcePageId: string;
  pageId: string;
  pageVersion: number | null;
  oldSentence: string | null;
  newSentence: string | null;
  oldValue: string | null;
  newValue: string | null;
  status: 'proposed' | 'needs_manual' | 'failed';
  method: ProposalMethod | null;
  errorCode: ProposalErrorCode | null;
}

/** A copy as a proposal needs it. */
export interface CopyForProposal {
  id: string;
  factId: string;
  sourcePageId: string;
  pageId: string;
  status: CopyStatus;
  statedValue: string | null;
  statedUnit: string | null;
  quote: string;
}

export interface ProposalRepo {
  copiesByIds(ids: readonly string[]): Promise<CopyForProposal[]>;
  byChangeCopy(changeId: string, copyId: string): Promise<ProposalRow | undefined>;
  /**
   * New proposal for (change, copy); an existing `stale` one is refreshed in place. Any other existing proposal is
   * left alone (`written` false).
   */
  saveDraft(d: ProposalDraft): Promise<{ id: string; written: boolean; created: boolean }>;
  get(id: string): Promise<ProposalRow | undefined>;
  /** Proposals of a copy page, open ones first. */
  listForPage(pageId: string): Promise<ProposalRow[]>;
  listForChange(changeId: string): Promise<ProposalRow[]>;
  /** Proposals waiting for a decision on the page. */
  pendingCount(pageId: string): Promise<number>;
  /** proposed → approved (also an `approved` lock older than 5 minutes: an approval that died midway). */
  lock(id: string): Promise<boolean>;
  /** Status change guarded by the current status; false when the proposal is no longer in one of `from`. */
  setStatus(id: string, from: readonly ProposalStatus[], to: ProposalStatus, errorCode?: ProposalErrorCode | null): Promise<boolean>;
  markApplied(id: string, version: number, actor: string, newSentence: string): Promise<boolean>;
  /** After Ripple saved a version: open proposals of the page read at `fromVersion` move to `toVersion`. */
  rebase(ids: readonly string[], fromVersion: number, toVersion: number): Promise<number>;
  /** The copy now states the new value (sticky `updated`). */
  markCopyUpdated(copyId: string, value: string, unit: string | null, sentence: string, version: number): Promise<boolean>;
  /** Not the same fact: the copy is ignored (sticky). */
  ignoreCopy(copyId: string): Promise<boolean>;
  /** Open proposals of other (older) changes of these facts → `rejected` (`superseded`); returns how many. */
  supersedeOlder(sourcePageId: string, changeId: string, factIds: readonly string[]): Promise<number>;
  /**
   * Rate limit for queueing the stale proposals of (change, page) again: `now` at most once per 2 minutes, `delayed`
   * once within that window (the caller queues a delayed job), `skip` otherwise.
   */
  claimRequeue(changeId: string, pageId: string, sourcePageId: string): Promise<'now' | 'delayed' | 'skip'>;
}

interface ProposalDbRow {
  id: string;
  change_id: string;
  copy_id: string;
  fact_id: string;
  source_page_id: string;
  page_id: string;
  page_version_at_proposal: number | null;
  old_sentence: string | null;
  new_sentence: string | null;
  old_value: string | null;
  new_value: string | null;
  status: string;
  method: string | null;
  applied_version: number | null;
  applied_by: string | null;
  error_code: string | null;
}

const num = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

const toRow = (r: ProposalDbRow): ProposalRow => ({
  id: r.id,
  changeId: r.change_id,
  copyId: r.copy_id,
  factId: r.fact_id,
  sourcePageId: r.source_page_id,
  pageId: r.page_id,
  pageVersion: num(r.page_version_at_proposal),
  oldSentence: r.old_sentence,
  newSentence: r.new_sentence,
  oldValue: r.old_value,
  newValue: r.new_value,
  status: r.status as ProposalStatus,
  method: (r.method as ProposalMethod | null) ?? null,
  appliedVersion: num(r.applied_version),
  appliedBy: r.applied_by,
  errorCode: (r.error_code as ProposalErrorCode | null) ?? null,
});

const COLUMNS =
  'id, change_id, copy_id, fact_id, source_page_id, page_id, page_version_at_proposal, old_sentence, new_sentence, old_value, new_value, status, method, applied_version, applied_by, error_code';
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
/** Upper bound of proposals read per page / per change. */
const MAX_PAGE_PROPOSALS = 100;
const MAX_CHANGE_PROPOSALS = 500;
const OPEN_FIRST = "CASE status WHEN 'proposed' THEN 0 WHEN 'approved' THEN 1 WHEN 'stale' THEN 2 WHEN 'needs_manual' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END";
const UPDATED_REASON = 'Updated by Ripple to the new official value.';
const IGNORED_REASON = 'Marked as not the same fact.';
/** Stale proposals of one (change, page) are queued again at most once per window. */
export const REQUEUE_WINDOW_SECONDS = 120;

export const sqlProposalRepo: ProposalRepo = {
  async copiesByIds(ids) {
    if (ids.length === 0) return [];
    const rows = await query<{ id: string; fact_id: string; source_page_id: string; page_id: string; status: string; stated_value: string | null; stated_unit: string | null; quote: string }>(
      `SELECT id, fact_id, source_page_id, page_id, status, stated_value, stated_unit, quote FROM copies WHERE id IN (${placeholders(ids.length)})`,
      ...ids,
    );
    return rows.map((r) => ({
      id: r.id,
      factId: r.fact_id,
      sourcePageId: r.source_page_id,
      pageId: r.page_id,
      status: r.status as CopyStatus,
      statedValue: r.stated_value,
      statedUnit: r.stated_unit,
      quote: r.quote,
    }));
  },

  async byChangeCopy(changeId, copyId) {
    const rows = await query<ProposalDbRow>(`SELECT ${COLUMNS} FROM proposals WHERE change_id = ? AND copy_id = ?`, changeId, copyId);
    return rows[0] ? toRow(rows[0]) : undefined;
  },

  async saveDraft(d) {
    const fields = [d.pageVersion, d.oldSentence, d.newSentence, d.oldValue, d.newValue, d.status, d.method, d.errorCode];
    const existing = await this.byChangeCopy(d.changeId, d.copyId);
    if (existing) {
      if (existing.status !== 'stale') return { id: existing.id, written: false, created: false };
      const n = await execute(
        `UPDATE proposals SET page_version_at_proposal = ?, old_sentence = ?, new_sentence = ?, old_value = ?, new_value = ?, status = ?, method = ?, error_code = ?
         WHERE id = ? AND status = 'stale'`,
        ...fields,
        existing.id,
      );
      return { id: existing.id, written: n > 0, created: false };
    }
    const id = randomUUID();
    const n = await execute(
      `INSERT IGNORE INTO proposals (id, change_id, copy_id, fact_id, source_page_id, page_id, page_version_at_proposal, old_sentence, new_sentence, old_value, new_value, status, method, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      d.changeId,
      d.copyId,
      d.factId,
      d.sourcePageId,
      d.pageId,
      ...fields,
    );
    return { id, written: n > 0, created: n > 0 };
  },

  async get(id) {
    const rows = await query<ProposalDbRow>(`SELECT ${COLUMNS} FROM proposals WHERE id = ?`, id);
    return rows[0] ? toRow(rows[0]) : undefined;
  },

  async listForPage(pageId) {
    const rows = await query<ProposalDbRow>(`SELECT ${COLUMNS} FROM proposals WHERE page_id = ? ORDER BY ${OPEN_FIRST}, created_at DESC, id LIMIT ${MAX_PAGE_PROPOSALS}`, pageId);
    return rows.map(toRow);
  },

  async listForChange(changeId) {
    const rows = await query<ProposalDbRow>(`SELECT ${COLUMNS} FROM proposals WHERE change_id = ? ORDER BY page_id, id LIMIT ${MAX_CHANGE_PROPOSALS}`, changeId);
    return rows.map(toRow);
  },

  async pendingCount(pageId) {
    const rows = await query<{ n: number }>("SELECT COUNT(*) AS n FROM proposals WHERE page_id = ? AND status = 'proposed'", pageId);
    return Number(rows[0]?.n ?? 0);
  },

  async lock(id) {
    const n = await execute(
      `UPDATE proposals SET status = 'approved', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND (status = 'proposed' OR (status = 'approved' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 5 MINUTE)))`,
      id,
    );
    return n > 0;
  },

  async setStatus(id, from, to, errorCode = null) {
    if (from.length === 0) return false;
    const n = await execute(`UPDATE proposals SET status = ?, error_code = ? WHERE id = ? AND status IN (${placeholders(from.length)})`, to, errorCode, id, ...from);
    return n > 0;
  },

  async markApplied(id, version, actor, newSentence) {
    const n = await execute(
      "UPDATE proposals SET status = 'applied', applied_version = ?, applied_by = ?, new_sentence = ?, error_code = NULL WHERE id = ? AND status = 'approved'",
      version,
      actor,
      newSentence,
      id,
    );
    return n > 0;
  },

  async rebase(ids, fromVersion, toVersion) {
    if (ids.length === 0) return 0;
    return execute(
      `UPDATE proposals SET page_version_at_proposal = ? WHERE status = 'proposed' AND page_version_at_proposal = ? AND id IN (${placeholders(ids.length)})`,
      toVersion,
      fromVersion,
      ...ids,
    );
  },

  async markCopyUpdated(copyId, value, unit, sentence, version) {
    const n = await execute(
      "UPDATE copies SET status = 'updated', stated_value = ?, stated_unit = ?, quote = ?, page_version = ?, reason = ? WHERE id = ? AND status IN ('in_sync', 'drifted')",
      value.slice(0, 300),
      unit === null ? null : unit.slice(0, 40),
      sentence,
      version,
      UPDATED_REASON,
      copyId,
    );
    return n > 0;
  },

  async ignoreCopy(copyId) {
    const n = await execute("UPDATE copies SET status = 'ignored', reason = ? WHERE id = ? AND status IN ('in_sync', 'drifted', 'unsure')", IGNORED_REASON, copyId);
    return n > 0;
  },

  async supersedeOlder(sourcePageId, changeId, factIds) {
    if (factIds.length === 0) return 0;
    return execute(
      `UPDATE proposals SET status = 'rejected', error_code = 'superseded'
       WHERE source_page_id = ? AND change_id <> ? AND status IN ('proposed', 'stale', 'needs_manual') AND fact_id IN (${placeholders(factIds.length)})`,
      sourcePageId,
      changeId,
      ...factIds,
    );
  },

  async claimRequeue(changeId, pageId, sourcePageId) {
    const inserted = await execute('INSERT IGNORE INTO propose_requeues (change_id, page_id, source_page_id) VALUES (?, ?, ?)', changeId, pageId, sourcePageId);
    if (inserted > 0) return 'now';
    const renewed = await execute(
      `UPDATE propose_requeues SET requeued_at = CURRENT_TIMESTAMP, delay_queued = 0
       WHERE change_id = ? AND page_id = ? AND requeued_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${REQUEUE_WINDOW_SECONDS} SECOND)`,
      changeId,
      pageId,
    );
    if (renewed > 0) return 'now';
    const delayed = await execute('UPDATE propose_requeues SET delay_queued = 1 WHERE change_id = ? AND page_id = ? AND delay_queued = 0', changeId, pageId);
    return delayed > 0 ? 'delayed' : 'skip';
  },
};
