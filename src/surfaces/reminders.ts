/**
 * M7 (FR-11/12, PRD "Tenggat dan pengingat"): reminders to copy owners, as a comment on their Jira update task (as
 * the app, mentioning the owner). Manual: the source page's "Remind" button (`remindOwners`, edit permission on the
 * source). Automatic: the daily sweep, once when the deadline arrives and once when the pages are late (3 working
 * days later). One reminder per task per 20 hours; a claim on the row lets one caller through, and a Jira failure
 * undoes it. No Teamwork Graph (no user in a trigger). Logs carry ids, enums and counts only.
 */
import { sqlChangeIssueRepo, sqlReminderRepo, SWEEP_ISSUES_READ, type ChangeIssueRepo, type ChangeIssueRow, type IssueCursor, type ReminderRepo } from '../adapters/changeIssueRepo';
import { sqlChangeRepo, type ChangeRepo, type ChangeRow } from '../adapters/changeRepo';
import { canEditPage } from '../adapters/confluence';
import { jira, type JiraClient } from '../adapters/jira';
import { sqlProposalRepo, type ProposalRepo, type ProposalRow } from '../adapters/proposalRepo';
import { ensureSchema } from '../adapters/sql';
import { scrubErrorText } from '../adapters/teamworkGraph';
import { deadlineState, dueReminders, isOpenProposal, reminderBody } from '../core/reminders';
import { SchemaSettingUpError } from '../core/schema';
import type { ErrorReply, RemindOwnersPayload, RemindOwnersResult } from '../core/views';
import { jiraErrorCode, owned } from './changeIssues';
import type { SourceContext } from './sources';

export interface ReminderDeps {
  issues: Pick<ChangeIssueRepo, 'listForChange'>;
  reminders: ReminderRepo;
  changes: Pick<ChangeRepo, 'getChange'>;
  proposals: Pick<ProposalRepo, 'listForChange'>;
  jira: Pick<JiraClient, 'addComment' | 'issueIsDone'>;
  canEdit: (pageId: string) => Promise<boolean>;
  now: () => Date;
  ensure: () => Promise<void>;
}

export const defaultReminderDeps: ReminderDeps = {
  issues: sqlChangeIssueRepo,
  reminders: sqlReminderRepo,
  changes: sqlChangeRepo,
  proposals: sqlProposalRepo,
  jira,
  canEdit: canEditPage,
  now: () => new Date(),
  ensure: ensureSchema,
};

const UUID = /^[0-9a-f-]{36}$/i;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{1,9}-\d{1,12}$/;

const openPagesOf = (change: ChangeRow, row: ChangeIssueRow, proposals: readonly ProposalRow[]): number => {
  const pages = owned(change, row.ownerAccountId);
  return new Set(proposals.filter((p) => pages.has(p.pageId) && isOpenProposal(p.status)).map((p) => p.pageId)).size;
};

type SendOutcome = 'reminded' | 'skipped' | 'done' | { failed: string };

const errText = (err: unknown): string => scrubErrorText(err instanceof Error ? err.message : String(err));

/**
 * Claims, checks and posts one reminder, then records it. The claim is dropped whenever nothing was posted (Jira
 * failure, issue already Done), so the reminder stage is never used up without a comment; a run cut off between claim
 * and record leaves a claim that goes stale (`REMINDER_CLAIM_STALE_SECONDS`). Never throws.
 */
async function remindOne(deps: ReminderDeps, change: ChangeRow, row: ChangeIssueRow, openPages: number, autoStage: number | null, now: Date): Promise<SendOutcome> {
  if (!row.issueKey || openPages === 0) return 'skipped';
  let token: string | null;
  try {
    token = await deps.reminders.claimReminder(change.id, row.ownerAccountId, autoStage);
  } catch (err) {
    return { failed: `sql: ${errText(err)}`.slice(0, 120) };
  }
  if (!token) return 'skipped';
  const release = async (): Promise<void> => {
    try {
      await deps.reminders.releaseReminder(change.id, row.ownerAccountId, token);
    } catch (err) {
      console.warn('ripple reminder: release failed', { changeId: change.id, issueId: row.issueId, error: errText(err) });
    }
  };
  try {
    // Done in Jira (closed by hand): no reminder; the task is closed here too.
    if (await deps.jira.issueIsDone(row.issueKey)) {
      const closed = await deps.reminders.closeDone(change.id, row.ownerAccountId, token);
      if (!closed) await release();
      return 'done';
    }
    const deadline = change.routing?.deadline ?? null;
    await deps.jira.addComment(row.issueKey, reminderBody({ ownerAccountId: row.ownerAccountId, openPages, deadline, state: deadlineState(deadline, now) }));
  } catch (err) {
    await release();
    return { failed: jiraErrorCode(err) };
  }
  try {
    if (!(await deps.reminders.confirmReminder(change.id, row.ownerAccountId, token, autoStage))) console.warn('ripple reminder: claim lost before record', { changeId: change.id, issueId: row.issueId });
  } catch (err) {
    console.warn('ripple reminder: record failed', { changeId: change.id, issueId: row.issueId, error: errText(err) });
  }
  return 'reminded';
}

/**
 * "Remind" on the source page's Rollout: posts a reminder on the open tasks of the change (one task when `issueKey`
 * is given) whose owner still has open pages. Edit permission on the source; the change must belong to it.
 */
export async function remindOwners(ctx: SourceContext, payload: Partial<RemindOwnersPayload> | undefined, deps: ReminderDeps = defaultReminderDeps): Promise<RemindOwnersResult | ErrorReply> {
  const raw = ctx.extension?.content?.id;
  const pageId = raw === undefined || String(raw) === '' ? undefined : String(raw);
  if (!pageId) return { error: 'Open a Confluence page to use Ripple.' };
  const changeId = payload?.changeId;
  if (typeof changeId !== 'string' || !UUID.test(changeId)) return { error: 'Missing or invalid change id.' };
  const issueKey = payload?.issueKey;
  if (issueKey !== undefined && (typeof issueKey !== 'string' || !ISSUE_KEY.test(issueKey))) return { error: 'Invalid issue key.' };
  try {
    await deps.ensure();
    if (!(await deps.canEdit(pageId))) return { error: 'You need edit permission on this page to send reminders.' };
    const change = await deps.changes.getChange(changeId);
    if (!change || change.sourcePageId !== pageId || change.status !== 'confirmed') return { error: 'This change does not belong to this page.' };
    const rows = (await deps.issues.listForChange(changeId)).filter((r) => r.status === 'created' && r.issueKey && (issueKey === undefined || r.issueKey === issueKey));
    if (issueKey !== undefined && rows.length === 0) return { error: 'This update task is not open.' };
    const proposals = await deps.proposals.listForChange(changeId);
    const now = deps.now();
    const result: RemindOwnersResult = { changeId, reminded: 0, skipped: 0, failed: 0, errorCode: null };
    for (const row of rows) {
      const outcome = await remindOne(deps, change, row, openPagesOf(change, row, proposals), null, now);
      if (outcome === 'reminded') result.reminded++;
      else if (outcome === 'skipped' || outcome === 'done') result.skipped++;
      else {
        result.failed++;
        result.errorCode ??= outcome.failed;
      }
    }
    console.info('ripple reminders sent', { mode: 'manual', ...result });
    return result;
  } catch (err) {
    if (err instanceof SchemaSettingUpError) return { error: err.message };
    const error = scrubErrorText(err instanceof Error ? err.message : String(err));
    console.warn('ripple remind owners failed', { pageId, changeId, error });
    return { error: `Ripple could not send reminders: ${error}` };
  }
}

export interface SweepOutcome {
  changes: number;
  reminded: number;
  skipped: number;
  /** Tasks found Done in Jira and closed here (no reminder). */
  done: number;
  failed: number;
  /** The time budget ran out before every open task was looked at (the next run starts over). */
  truncated: boolean;
}

/** Time budget of one sweep; the function times out after 900 s (`weekly-sweep` in manifest.yml). */
export const SWEEP_BUDGET_MS = 12 * 60 * 1000;

/**
 * Daily sweep: automatic reminders for the open tasks whose change is due (stage 1) or late (stage 2) and whose owner
 * still has open pages; each stage is sent once per task (`auto_reminders`). Every open task is read (keyset pages)
 * until the time budget runs out. Never throws.
 */
export async function runReminderSweep(deps: ReminderDeps = defaultReminderDeps, budgetMs: number = SWEEP_BUDGET_MS): Promise<SweepOutcome> {
  const out: SweepOutcome = { changes: 0, reminded: 0, skipped: 0, done: 0, failed: 0, truncated: false };
  const started = deps.now().getTime();
  const overBudget = (): boolean => deps.now().getTime() - started >= budgetMs;
  try {
    await deps.ensure();
    const now = deps.now();
    const loaded = new Map<string, { change: ChangeRow; stage: number; proposals: readonly ProposalRow[] | null } | null>();
    let after: IssueCursor | undefined;
    for (;;) {
      if (overBudget()) {
        out.truncated = true;
        break;
      }
      const page = await deps.reminders.listOpenIssues(after);
      for (const row of page) {
        if (overBudget()) {
          out.truncated = true;
          break;
        }
        try {
          let entry = loaded.get(row.changeId);
          if (entry === undefined) {
            const change = await deps.changes.getChange(row.changeId);
            entry = change && change.status === 'confirmed' ? { change, stage: dueReminders(deadlineState(change.routing?.deadline, now)), proposals: null } : null;
            loaded.set(row.changeId, entry);
          }
          if (!entry || (row.autoReminders ?? 0) >= entry.stage) continue;
          if (entry.proposals === null) {
            entry.proposals = await deps.proposals.listForChange(row.changeId);
            out.changes++;
          }
          const outcome = await remindOne(deps, entry.change, row, openPagesOf(entry.change, row, entry.proposals), entry.stage, now);
          if (outcome === 'reminded') out.reminded++;
          else if (outcome === 'skipped') out.skipped++;
          else if (outcome === 'done') out.done++;
          else out.failed++;
        } catch (err) {
          out.failed++;
          console.warn('ripple reminder sweep: task failed', { changeId: row.changeId, issueId: row.issueId, error: errText(err) });
        }
      }
      const last = page[page.length - 1];
      if (out.truncated || !last || page.length < SWEEP_ISSUES_READ) break;
      after = { changeId: last.changeId, ownerAccountId: last.ownerAccountId };
    }
  } catch (err) {
    console.warn('ripple reminder sweep failed', { error: err instanceof SchemaSettingUpError ? 'schema_setting_up' : errText(err) });
  }
  console.info('ripple reminder sweep', { ...out });
  return out;
}
