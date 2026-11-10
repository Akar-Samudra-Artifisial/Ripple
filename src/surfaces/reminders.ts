/**
 * M7 (FR-11/12, PRD "Tenggat dan pengingat"): reminders to copy owners, as a comment on their Jira update task (as
 * the app, mentioning the owner). Manual: the source page's "Remind" button (`remindOwners`, edit permission on the
 * source). Automatic: the daily sweep, once when the deadline arrives and once when the pages are late (3 working
 * days later). One reminder per task per 20 hours; a claim on the row lets one caller through, and a Jira failure
 * undoes it. No Teamwork Graph (no user in a trigger). Logs carry ids, enums and counts only.
 */
import { sqlChangeIssueRepo, sqlReminderRepo, type ChangeIssueRepo, type ChangeIssueRow, type ReminderRepo } from '../adapters/changeIssueRepo';
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
  jira: Pick<JiraClient, 'addComment'>;
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

type SendOutcome = 'reminded' | 'skipped' | { failed: string };

/** Claims, posts and (on failure) releases one reminder. Never throws. */
async function remindOne(deps: ReminderDeps, change: ChangeRow, row: ChangeIssueRow, openPages: number, autoStage: number | null, now: Date): Promise<SendOutcome> {
  if (!row.issueKey || openPages === 0) return 'skipped';
  if (!(await deps.reminders.claimReminder(change.id, row.ownerAccountId, autoStage))) return 'skipped';
  try {
    const deadline = change.routing?.deadline ?? null;
    await deps.jira.addComment(row.issueKey, reminderBody({ ownerAccountId: row.ownerAccountId, openPages, deadline, state: deadlineState(deadline, now) }));
    return 'reminded';
  } catch (err) {
    const code = jiraErrorCode(err);
    try {
      await deps.reminders.releaseReminder(change.id, row.ownerAccountId, { reminderCount: row.reminderCount ?? 0, autoReminders: row.autoReminders ?? 0 });
    } catch (releaseErr) {
      console.warn('ripple reminder: release failed', { changeId: change.id, issueId: row.issueId, error: scrubErrorText(releaseErr instanceof Error ? releaseErr.message : String(releaseErr)) });
    }
    return { failed: code };
  }
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
      else if (outcome === 'skipped') result.skipped++;
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
  failed: number;
}

/**
 * Daily sweep: automatic reminders for the open tasks whose change is due (stage 1) or late (stage 2) and whose owner
 * still has open pages; each stage is sent once per task (`auto_reminders`). Never throws.
 */
export async function runReminderSweep(deps: ReminderDeps = defaultReminderDeps): Promise<SweepOutcome> {
  const out: SweepOutcome = { changes: 0, reminded: 0, skipped: 0, failed: 0 };
  try {
    await deps.ensure();
    const now = deps.now();
    const byChange = new Map<string, ChangeIssueRow[]>();
    for (const r of await deps.reminders.listOpenIssues()) byChange.set(r.changeId, [...(byChange.get(r.changeId) ?? []), r]);
    for (const [changeId, rows] of byChange) {
      try {
        const change = await deps.changes.getChange(changeId);
        if (!change || change.status !== 'confirmed') continue;
        const stage = dueReminders(deadlineState(change.routing?.deadline, now));
        const todo = rows.filter((r) => (r.autoReminders ?? 0) < stage);
        if (todo.length === 0) continue;
        out.changes++;
        const proposals = await deps.proposals.listForChange(changeId);
        for (const row of todo) {
          const outcome = await remindOne(deps, change, row, openPagesOf(change, row, proposals), stage, now);
          if (outcome === 'reminded') out.reminded++;
          else if (outcome === 'skipped') out.skipped++;
          else out.failed++;
        }
      } catch (err) {
        out.failed++;
        console.warn('ripple reminder sweep: change failed', { changeId, error: scrubErrorText(err instanceof Error ? err.message : String(err)) });
      }
    }
  } catch (err) {
    const error = err instanceof SchemaSettingUpError ? 'schema_setting_up' : scrubErrorText(err instanceof Error ? err.message : String(err));
    console.warn('ripple reminder sweep failed', { error });
  }
  console.info('ripple reminder sweep', { ...out });
  return out;
}
