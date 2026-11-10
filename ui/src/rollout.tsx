import { router } from '@forge/bridge';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DeadlineState, IssuesStateView, ProposalState, RemindOwnersResult, Rollout, RolloutIssue, RolloutItem } from '../../src/core/views';
import { call } from './bridge';
import { Alert, LoadingRows, errorOf } from './components';
import { httpsUrl } from './links';
import { PROPOSAL_STATUS_LABEL, proposalProblem } from './proposalText';

const POLL_MS = 5000;

/** Display order: what still needs someone first, finished last. */
const ORDER: readonly ProposalState[] = ['needs_manual', 'failed', 'proposed', 'approved', 'stale', 'applied', 'rejected'];
const OPEN: ReadonlySet<ProposalState> = new Set(['proposed', 'approved', 'stale']);

/**
 * Rollout tab (FR-8 progress on the source): per-status counts and every copy page with its proposal status, polled
 * while proposals are still open. States: loading rows → error + retry | empty | counts + list.
 */
/** `YYYY-MM-DD` (UTC day) → "14 Nov 2026"; null when missing or malformed. */
export function formatDeadline(day: string | null): string | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const formatMoment = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Overdue badge (the text carries the meaning; colour only reinforces it). */
function OverdueBadge({ overdue, deadline }: { overdue: 'due' | 'late' | null; deadline: string | null }) {
  if (overdue === 'late') return <span className="badge badge--late">Late</span>;
  if (overdue === 'due') return <span className="badge badge--due">{deadline ? `Due ${deadline}` : 'Due'}</span>;
  return null;
}

/** Deadline line of the Rollout header: the date, whether it has arrived, and how many copies are late. */
function DeadlineSummary({ deadline, state, lateCount }: { deadline: string | null; state: DeadlineState | null; lateCount: number }) {
  if (!deadline && lateCount === 0) return null;
  const text = !deadline ? null : state === 'late' ? `Deadline ${deadline} has passed` : state === 'due' ? `Deadline ${deadline} has arrived` : `Due ${deadline}`;
  const tone = state === 'late' ? 'badge--late' : state === 'due' ? 'badge--due' : 'badge--deadline';
  return (
    <p className="rollout__deadline">
      {text ? <span className={`badge ${tone}`}>{text}</span> : null}
      {lateCount > 0 ? <span className="badge badge--late">{plural(lateCount, 'copy late', 'copies late')}</span> : null}
    </p>
  );
}

export function RolloutTab({ changeId, canEdit, onGone }: { changeId: string; canEdit: boolean; onGone: () => void }) {
  const [rollout, setRollout] = useState<Rollout>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const r = await call<Rollout>('listRollout', { changeId });
      setRollout(r);
      setError(undefined);
    } catch (e) {
      const message = errorOf(e);
      if (message.includes('does not belong')) onGone();
      setError(message);
    }
  }, [changeId, onGone]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep polling while proposals are open or the Jira tasks are still being created.
  const open = rollout ? rollout.items.some((i) => OPEN.has(i.status)) || rollout.issuesState === 'pending' : false;
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, load]);

  if (!rollout) return error ? <Alert message={`Could not load the rollout: ${error}`} onRetry={() => void load()} /> : <LoadingRows label="Loading rollout…" />;

  const total = rollout.items.length + rollout.hiddenCount;
  const applied = rollout.counts.applied ?? 0;
  const pct = total > 0 ? Math.round((applied / total) * 100) : 0;
  const items = [...rollout.items].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const shownStates = ORDER.filter((s) => (rollout.counts[s] ?? 0) > 0);
  const deadline = formatDeadline(rollout.deadline);

  return (
    <div className="rollout">
      {error ? <Alert message={error} onRetry={() => void load()} /> : null}
      {total === 0 ? (
        <p className="empty">No update suggestions were made for this change. Copies may already show the new value.</p>
      ) : (
        <>
          <div className="rollout__head">
            <p className="copies__count">
              <strong>
                {applied} of {total} {total === 1 ? 'copy' : 'copies'} updated
              </strong>
            </p>
            <div className="progress__track" role="progressbar" aria-label="Copies updated" aria-valuemin={0} aria-valuemax={total} aria-valuenow={applied}>
              <div className="progress__fill progress__fill--success" style={{ width: `${pct}%` }} />
            </div>
            <DeadlineSummary deadline={deadline} state={rollout.deadlineState} lateCount={rollout.lateCount} />
          </div>
          <ul className="rollout__counts" aria-label="Suggestions by status">
            {shownStates.map((s) => (
              <li key={s} className={`badge badge--proposal-${s}`}>
                {rollout.counts[s]} {PROPOSAL_STATUS_LABEL[s].toLowerCase()}
              </li>
            ))}
          </ul>
          {items.length > 0 ? (
            <ul className="rollout__list" aria-label="Copy pages">
              {items.map((i) => (
                <RolloutRow key={i.proposalId} item={i} deadline={deadline} />
              ))}
            </ul>
          ) : null}
          {rollout.hiddenCount > 0 ? (
            <p className="muted copies__hidden">
              {rollout.hiddenCount} {rollout.hiddenCount === 1 ? 'copy is' : 'copies are'} in pages you can't view.
            </p>
          ) : null}
          <JiraTasks changeId={changeId} canEdit={canEdit} deadline={deadline} state={rollout.issuesState} issues={rollout.issues} onReminded={load} />
        </>
      )}
      <div className="actions">
        <button type="button" className="button button--subtle" onClick={() => void load()}>
          Refresh
        </button>
      </div>
    </div>
  );
}

const ISSUES_NOTE: Record<IssuesStateView, string> = {
  not_configured: 'No Jira project set. Choose one in Ripple settings.',
  pending: 'Creating Jira tasks…',
  created: 'One Jira task per page owner.',
  partial: 'Some Jira tasks could not be created. Owners without a task still see the suggestion on their page.',
  failed: 'Ripple could not create Jira tasks for this change. Owners still see the suggestion on their page.',
};

/**
 * M5 Jira tasks of the change: one row per owner that actually has an issue; the note says what happened to the rest
 * (never claims a task or notification that does not exist).
 */
interface JiraTasksProps {
  changeId: string;
  canEdit: boolean;
  deadline: string | null;
  state: IssuesStateView;
  issues: readonly RolloutIssue[];
  onReminded: () => Promise<void>;
}

/** Honest summary of a `remindOwners` reply: only reminders actually posted count as sent. */
function reminderMessage(r: RemindOwnersResult): { tone: 'ok' | 'warning'; text: string } {
  const parts: string[] = [];
  if (r.reminded > 0) parts.push(`Reminded ${plural(r.reminded, 'owner', 'owners')} on their Jira task.`);
  if (r.skipped > 0)
    parts.push(
      r.reminded > 0
        ? `${plural(r.skipped, 'owner was', 'owners were')} skipped: reminded recently or nothing open.`
        : 'Already reminded recently. Ripple sends at most one reminder per owner every 20 hours.',
    );
  if (r.failed > 0) parts.push(`${plural(r.failed, 'reminder', 'reminders')} could not be posted in Jira${r.errorCode ? ` (${r.errorCode})` : ''}. Try again later.`);
  if (parts.length === 0) parts.push('No owner has open pages to be reminded about.');
  return { tone: r.reminded > 0 && r.failed === 0 ? 'ok' : 'warning', text: parts.join(' ') };
}

function JiraTasks({ changeId, canEdit, deadline, state, issues, onReminded }: JiraTasksProps) {
  const headingId = useId();
  const [running, setRunning] = useState<string>();
  const runningRef = useRef(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'warning'; text: string }>();
  const [remindError, setRemindError] = useState<string>();

  /** One reminder request at a time; the ref guards double clicks before the disabled state renders. */
  const remind = async (issueKey?: string) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(issueKey ?? 'all');
    setResult(undefined);
    setRemindError(undefined);
    try {
      const r = await call<RemindOwnersResult>('remindOwners', issueKey ? { changeId, issueKey } : { changeId });
      setResult(reminderMessage(r));
      await onReminded();
    } catch (e) {
      setRemindError(`Could not send reminders: ${errorOf(e)}`);
    } finally {
      runningRef.current = false;
      setRunning(undefined);
    }
  };

  const openTasks = issues.filter((i) => i.status === 'open' && i.openPages > 0);
  const remindable = openTasks.filter((i) => i.canRemind).length;
  const busy = running !== undefined;
  const note = state === 'created' && issues.length === 0 ? 'No Jira tasks were needed for this change.' : ISSUES_NOTE[state];
  const tone = state === 'partial' || state === 'failed' ? ' jira__note--warning' : '';
  return (
    <section className="jira" aria-labelledby={headingId}>
      <h3 id={headingId} className="jira__title">
        Jira tasks
      </h3>
      <p className={`muted source__meta jira__note${tone}`} role="status">
        {note}
      </p>
      {canEdit && openTasks.length > 0 ? (
        <div className="jira__remind">
          <button type="button" className="button" disabled={busy || remindable === 0} aria-busy={running === 'all'} onClick={() => void remind()}>
            {running === 'all' ? 'Sending reminders…' : remindable > 0 ? `Remind owners (${remindable})` : 'Remind owners'}
          </button>
          <span className="muted source__meta">
            {remindable > 0 ? 'Posts a reminder on each open Jira task, at most one per owner every 20 hours.' : 'Every owner with open pages was reminded in the last 20 hours.'}
          </span>
        </div>
      ) : null}
      <div aria-live="polite" className="jira__result">
        {result ? <p className={`source__meta ${result.tone === 'ok' ? 'ok' : 'jira__note--warning'}`}>{result.text}</p> : null}
      </div>
      {remindError ? <Alert message={remindError} /> : null}
      {issues.length > 0 ? (
        <ul className="rollout__list" aria-label="Jira tasks by owner">
          {issues.map((i) => {
            const url = httpsUrl(i.issueUrl);
            return (
              <li key={i.issueKey} className="rollout__row jira__row">
                <span className="jira__owner">{i.ownerName ?? "Owner you can't view"}</span>
                <span aria-hidden="true" className="muted">
                  ·
                </span>
                {url ? (
                  <a
                    className="copy__link jira__key"
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      e.preventDefault();
                      void router.open(url).catch(() => undefined);
                    }}
                  >
                    {i.issueKey}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <span className="jira__key">{i.issueKey}</span>
                )}
                <span className={`badge ${i.status === 'done' ? 'badge--proposal-applied' : 'badge--proposal-proposed'}`}>{i.status === 'done' ? 'Done' : 'Open'}</span>
                <OverdueBadge overdue={i.overdue} deadline={deadline} />
                <span className="muted source__meta">
                  {i.status === 'open' && i.openPages > 0 ? `${i.openPages} of ${plural(i.pageCount, 'page', 'pages')} open` : plural(i.pageCount, 'page', 'pages')}
                </span>
                {i.remindedAt ? (
                  <span className="muted source__meta jira__reminded">
                    Reminded {formatMoment(i.remindedAt) ?? 'recently'}
                    {i.reminderCount > 1 ? ` · ${i.reminderCount} reminders` : ''}
                  </span>
                ) : null}
                {canEdit && i.canRemind ? (
                  <button
                    type="button"
                    className="button button--subtle jira__remind-one"
                    disabled={busy}
                    aria-busy={running === i.issueKey}
                    aria-label={`Remind ${i.ownerName ?? 'the owner'} on ${i.issueKey}`}
                    onClick={() => void remind(i.issueKey)}
                  >
                    {running === i.issueKey ? 'Sending…' : 'Remind'}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="muted source__meta">Owners approve each suggestion in the Ripple byline on their Confluence page.</p>
    </section>
  );
}

function RolloutRow({ item, deadline }: { item: RolloutItem; deadline: string | null }) {
  const problem = item.status === 'needs_manual' || item.status === 'failed' ? proposalProblem(item.status, item.errorCode) : null;
  return (
    <li className="rollout__row">
      <a
        className="copy__link rollout__page"
        href="#"
        onClick={(e) => {
          e.preventDefault();
          void router.open({ target: 'contentView', contentId: item.pageId });
        }}
      >
        {item.pageTitle ?? `Page ${item.pageId}`}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      <span className="muted rollout__owner">Owner: {item.owner.displayName ?? (item.owner.accountId ? 'Unknown user' : 'none')}</span>
      <span className={`badge badge--proposal-${item.status}`}>{PROPOSAL_STATUS_LABEL[item.status]}</span>
      <OverdueBadge overdue={item.overdue} deadline={deadline} />
      {problem ? <span className="muted rollout__problem">{problem}</span> : null}
    </li>
  );
}
