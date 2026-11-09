import { router } from '@forge/bridge';
import { useCallback, useEffect, useState } from 'react';
import type { ProposalState, Rollout, RolloutItem } from '../../src/core/views';
import { call } from './bridge';
import { Alert, LoadingRows, errorOf } from './components';
import { PROPOSAL_STATUS_LABEL, proposalProblem } from './proposalText';

const POLL_MS = 5000;

/** Display order: what still needs someone first, finished last. */
const ORDER: readonly ProposalState[] = ['needs_manual', 'failed', 'proposed', 'approved', 'stale', 'applied', 'rejected'];
const OPEN: ReadonlySet<ProposalState> = new Set(['proposed', 'approved', 'stale']);

/**
 * Rollout tab (FR-8 progress on the source): per-status counts and every copy page with its proposal status, polled
 * while proposals are still open. States: loading rows → error + retry | empty | counts + list.
 */
export function RolloutTab({ changeId, onGone }: { changeId: string; onGone: () => void }) {
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

  const open = rollout ? rollout.items.some((i) => OPEN.has(i.status)) : false;
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
          </div>
          <ul className="rollout__counts" aria-label="Suggestions by status">
            {shownStates.map((s) => (
              <li key={s} className={`badge badge--proposal-${s}`}>
                {rollout.counts[s]} {PROPOSAL_STATUS_LABEL[s].toLowerCase()}
              </li>
            ))}
          </ul>
          <p className="muted source__meta">Page owners see the suggestion in the Ripple byline on their page and approve it there.</p>
          {items.length > 0 ? (
            <ul className="rollout__list" aria-label="Copy pages">
              {items.map((i) => (
                <RolloutRow key={i.proposalId} item={i} />
              ))}
            </ul>
          ) : null}
          {rollout.hiddenCount > 0 ? (
            <p className="muted copies__hidden">
              {rollout.hiddenCount} {rollout.hiddenCount === 1 ? 'copy is' : 'copies are'} in pages you can't view.
            </p>
          ) : null}
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

function RolloutRow({ item }: { item: RolloutItem }) {
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
      {problem ? <span className="muted rollout__problem">{problem}</span> : null}
    </li>
  );
}
