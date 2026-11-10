/**
 * M7 (PRD "Tenggat dan pengingat"): a copy owner is reminded when the deadline of a confirmed change arrives and
 * again 3 working days later; from then on their open pages are **late**. Pure logic: the deadline state, how many
 * automatic reminders are due, and the reminder comment (ADF, text nodes only: no titles or values).
 */
import { addWorkingDays } from './changes';
import type { AdfDoc } from './changeIssues';
import type { DeadlineState, ProposalState } from './views';

/** Working days after the deadline at which the second reminder goes out and the pages count as late. */
export const LATE_AFTER_WORKING_DAYS = 3;
/** At most one reminder (manual or automatic) per owner issue in this many hours. */
export const REMINDER_COOLDOWN_HOURS = 20;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * `on_track` before the deadline (a `YYYY-MM-DD` UTC date), `due` from the deadline day, `late` from 3 working days
 * after it. Null without a (valid) deadline.
 */
export function deadlineState(deadline: string | null | undefined, now: Date): DeadlineState | null {
  if (!deadline || !DAY.test(deadline)) return null;
  const start = new Date(`${deadline}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  const today = dayOf(now);
  if (today >= addWorkingDays(start, LATE_AFTER_WORKING_DAYS)) return 'late';
  return today >= deadline ? 'due' : 'on_track';
}

/** Automatic reminders an owner should have had by now: 1 at the deadline, 2 once late. */
export function dueReminders(state: DeadlineState | null): number {
  return state === 'late' ? 2 : state === 'due' ? 1 : 0;
}

/** The owner still has to act on this proposal (not applied or rejected). */
export const isOpenProposal = (status: ProposalState): boolean => status !== 'applied' && status !== 'rejected';

/** Overdue marker of one rollout item: only for open proposals once the deadline has arrived. */
export function itemOverdue(status: ProposalState, state: DeadlineState | null): 'due' | 'late' | null {
  if (!isOpenProposal(status)) return null;
  return state === 'due' || state === 'late' ? state : null;
}

/** Reminder comment on the owner's update task: a mention, the open page count and the deadline. */
export function reminderBody(input: { ownerAccountId: string; openPages: number; deadline: string | null; state: DeadlineState | null }): AdfDoc {
  const pages = `${input.openPages} page${input.openPages === 1 ? '' : 's'}`;
  const when = input.deadline && DAY.test(input.deadline) ? input.deadline : null;
  const status =
    input.state === 'late'
      ? `These updates are late${when ? ` (deadline ${when})` : ''}.`
      : input.state === 'due'
        ? `The deadline${when ? ` (${when})` : ''} has arrived.`
        : when
          ? `The deadline is ${when}.`
          : '';
  const text = `Reminder from Ripple: ${pages} in this task still ${input.openPages === 1 ? 'needs' : 'need'} your review in Confluence. ${status}`.trim();
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: input.ownerAccountId } }, { type: 'text', text: ` ${text}` }] }],
  };
}
