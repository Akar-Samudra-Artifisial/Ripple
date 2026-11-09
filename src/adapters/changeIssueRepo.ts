/**
 * Forge SQL access for M5 Jira issues (one per copy-page owner per confirmed change) and the Jira settings. The row
 * is created as a claim (`creating`) before Jira is called, so a redelivered or concurrent job never creates a second
 * issue; every status change carries a status guard. Parameterised statements only.
 */
import { randomUUID } from 'node:crypto';
import { MAX_ISSUE_ATTEMPTS, type IssueStatus } from '../core/changeIssues';
import { execute, query } from './sql';

/** A `creating` claim older than this belongs to a job that died; another job may take it over. */
export const ISSUE_CLAIM_STALE_SECONDS = 5 * 60;

export interface ChangeIssueRow {
  changeId: string;
  ownerAccountId: string;
  sourcePageId: string;
  issueId: string | null;
  issueKey: string | null;
  issueUrl: string | null;
  assigneeSet: boolean;
  pageCount: number;
  status: IssueStatus;
  /** Claims so far (each one is a try to create the issue). */
  attempts: number;
  /** The closing comment was posted (not posted again when the transition is retried). */
  commentSent: boolean;
}

export interface CreatedIssueRef {
  id: string;
  key: string;
  url: string;
  assigneeSet: boolean;
}

export interface JiraSettings {
  projectKey: string;
}

export interface ChangeIssueRepo {
  /**
   * The claim token when this call owns the (change, owner) issue: a new row, a `failed` one with fewer than
   * `MAX_ISSUE_ATTEMPTS` claims, or a stale `creating` claim. Null otherwise. Every claim counts one attempt.
   */
  claim(changeId: string, ownerAccountId: string, sourcePageId: string, pageCount: number): Promise<string | null>;
  /** The claimed row now has its issue; false when the claim (token) was taken over meanwhile. */
  complete(changeId: string, ownerAccountId: string, token: string, issue: CreatedIssueRef): Promise<boolean>;
  /** Creating the issue failed: the claim is released (`failed`); only by the holder of the token. */
  fail(changeId: string, ownerAccountId: string, token: string): Promise<void>;
  /** The closing comment of a `closed` row was posted. */
  markCommentSent(changeId: string, ownerAccountId: string): Promise<void>;
  listForChange(changeId: string): Promise<ChangeIssueRow[]>;
  byIssueKey(issueKey: string): Promise<ChangeIssueRow | undefined>;
  /** Moves the row `from` → `to`; false when its status moved on meanwhile (another caller closes it). */
  setStatus(changeId: string, ownerAccountId: string, from: IssueStatus, to: IssueStatus): Promise<boolean>;
  getJiraSettings(): Promise<JiraSettings | undefined>;
  /** Null removes the setting (no issues are created). */
  saveJiraSettings(settings: JiraSettings | null): Promise<void>;
}

interface IssueDbRow {
  change_id: string;
  owner_account_id: string;
  source_page_id: string;
  issue_id: string | null;
  issue_key: string | null;
  issue_url: string | null;
  assignee_set: number | boolean | null;
  page_count: number | string | null;
  status: string;
  attempts: number | string | null;
  comment_sent: number | boolean | null;
}

const COLUMNS = 'change_id, owner_account_id, source_page_id, issue_id, issue_key, issue_url, assignee_set, page_count, status, attempts, comment_sent';
const flag = (v: number | boolean | null): boolean => v === true || Number(v) === 1;
const STATUSES: readonly IssueStatus[] = ['creating', 'created', 'failed', 'closed'];

const toRow = (r: IssueDbRow): ChangeIssueRow => ({
  changeId: r.change_id,
  ownerAccountId: r.owner_account_id,
  sourcePageId: r.source_page_id,
  issueId: r.issue_id,
  issueKey: r.issue_key,
  issueUrl: r.issue_url,
  assigneeSet: flag(r.assignee_set),
  pageCount: Number(r.page_count ?? 0),
  status: (STATUSES as readonly string[]).includes(r.status) ? (r.status as IssueStatus) : 'failed',
  attempts: Number(r.attempts ?? 0) || 0,
  commentSent: flag(r.comment_sent),
});

const SETTINGS_KEY = 'jira';
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

/** A stored `JiraSettings` (JSON column: string or already parsed), or undefined when absent or malformed. */
export function parseJiraSettings(raw: unknown): JiraSettings | undefined {
  let v: unknown = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  const key = v && typeof v === 'object' ? (v as { projectKey?: unknown }).projectKey : undefined;
  return typeof key === 'string' && PROJECT_KEY.test(key) ? { projectKey: key } : undefined;
}

export const sqlChangeIssueRepo: ChangeIssueRepo = {
  async claim(changeId, ownerAccountId, sourcePageId, pageCount) {
    const token = randomUUID();
    const inserted = await execute(
      "INSERT IGNORE INTO change_issues (change_id, owner_account_id, source_page_id, page_count, status, claim_token, attempts) VALUES (?, ?, ?, ?, 'creating', ?, 1)",
      changeId,
      ownerAccountId,
      sourcePageId,
      pageCount,
      token,
    );
    if (inserted > 0) return token;
    const taken = await execute(
      `UPDATE change_issues SET status = 'creating', claim_token = ?, attempts = attempts + 1, page_count = ?, updated_at = CURRENT_TIMESTAMP
       WHERE change_id = ? AND owner_account_id = ?
         AND ((status = 'failed' AND attempts < ${MAX_ISSUE_ATTEMPTS}) OR (status = 'creating' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${ISSUE_CLAIM_STALE_SECONDS} SECOND)))`,
      token,
      pageCount,
      changeId,
      ownerAccountId,
    );
    return taken > 0 ? token : null;
  },

  async complete(changeId, ownerAccountId, token, issue) {
    const n = await execute(
      "UPDATE change_issues SET status = 'created', issue_id = ?, issue_key = ?, issue_url = ?, assignee_set = ? WHERE change_id = ? AND owner_account_id = ? AND status = 'creating' AND claim_token = ?",
      issue.id,
      issue.key,
      issue.url,
      issue.assigneeSet ? 1 : 0,
      changeId,
      ownerAccountId,
      token,
    );
    return n > 0;
  },

  async fail(changeId, ownerAccountId, token) {
    await execute("UPDATE change_issues SET status = 'failed' WHERE change_id = ? AND owner_account_id = ? AND status = 'creating' AND claim_token = ?", changeId, ownerAccountId, token);
  },

  async markCommentSent(changeId, ownerAccountId) {
    await execute("UPDATE change_issues SET comment_sent = 1 WHERE change_id = ? AND owner_account_id = ? AND status = 'closed'", changeId, ownerAccountId);
  },

  async listForChange(changeId) {
    const rows = await query<IssueDbRow>(`SELECT ${COLUMNS} FROM change_issues WHERE change_id = ? ORDER BY created_at, owner_account_id`, changeId);
    return rows.map(toRow);
  },

  async byIssueKey(issueKey) {
    const rows = await query<IssueDbRow>(`SELECT ${COLUMNS} FROM change_issues WHERE issue_key = ?`, issueKey);
    const first = rows[0];
    return first ? toRow(first) : undefined;
  },

  async setStatus(changeId, ownerAccountId, from, to) {
    const n = await execute('UPDATE change_issues SET status = ? WHERE change_id = ? AND owner_account_id = ? AND status = ?', to, changeId, ownerAccountId, from);
    return n > 0;
  },

  async getJiraSettings() {
    const rows = await query<{ v: unknown }>('SELECT v FROM settings WHERE k = ?', SETTINGS_KEY);
    return parseJiraSettings(rows[0]?.v);
  },

  async saveJiraSettings(settings) {
    if (settings === null) {
      await execute('DELETE FROM settings WHERE k = ?', SETTINGS_KEY);
      return;
    }
    await execute('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', SETTINGS_KEY, JSON.stringify({ projectKey: settings.projectKey }));
  },
};
