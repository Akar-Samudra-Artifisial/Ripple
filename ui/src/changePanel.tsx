import { useCallback, useEffect, useState } from 'react';
import type { ChangeDecision, PendingChangeReply, PendingChangeView } from '../../src/core/views';
import { call } from './bridge';
import { Alert, errorOf } from './components';

const label = (value: string, unit: string | null): string => (unit ? `${value} ${unit}` : value);

/**
 * M3 (FR-7), minimal: the pending change of this source with the copies it affects, their owners and teams, and
 * Confirm / Dismiss for editors. Shown inline in the byline popup (no Forge modal, so no manifest change).
 */
export function ChangePanel({ onDecided }: { onDecided?: () => void }) {
  const [change, setChange] = useState<PendingChangeView | null | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [days, setDays] = useState(5);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ChangeDecision>();

  const load = useCallback(() => {
    setError(undefined);
    call<PendingChangeReply>('getPendingChange')
      .then((r) => {
        setChange(r.change);
        if (r.change) setDays(r.change.defaultDeadlineDays);
      })
      .catch((e: unknown) => setError(errorOf(e)));
  }, []);
  useEffect(load, [load]);

  const decide = async (action: 'confirmChange' | 'dismissChange') => {
    if (!change) return;
    setBusy(true);
    setError(undefined);
    try {
      const payload = action === 'confirmChange' ? { changeId: change.id, deadlineDays: days, version: change.version } : { changeId: change.id };
      setDone(await call<ChangeDecision>(action, payload));
      onDecided?.();
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <Alert message={error} onRetry={load} />;
  if (done) {
    return (
      <p role="status" className="muted">
        {done.status === 'confirmed' ? `Change confirmed: ${done.factsUpdated} fact(s) updated, ${done.copiesDrifted} copy(ies) now out of date. Deadline ${done.deadline}.` : 'Change dismissed.'}
      </p>
    );
  }
  if (!change) return null;
  return (
    <section className="alert" aria-label="Source change">
      <h2 className="shell__title">This source changed (version {change.version})</h2>
      <ul>
        {change.facts.map((f) => (
          <li key={f.factId}>
            <strong>{f.factLabel}</strong>: {label(f.oldValue, f.oldUnit)} → {label(f.newValue, f.newUnit)}
          </li>
        ))}
      </ul>
      <p>
        {change.copies} copies on {change.pages.length} pages to update
        {change.hiddenCount > 0 ? ` (+${change.hiddenCount} on pages you cannot open)` : ''}. Not updated: {change.unsure} unsure, {change.historical} historical, {change.alreadyNew} already
        current.
        {change.missingFacts > 0 ? ` ${change.missingFacts} fact(s) are no longer on the page.` : ''}
      </p>
      {change.pages.length > 0 ? (
        <ul>
          {change.pages.map((p) => (
            <li key={p.pageId}>
              {p.pageTitle ?? p.pageId} · owner {p.owner.displayName ?? (p.owner.accountId ? 'Unknown user' : 'none')} · {p.copies} copies
            </li>
          ))}
        </ul>
      ) : null}
      {change.spaces.length > 0 ? (
        <p className="muted">
          Teams:{' '}
          {change.spaces.map((s) => (s.teams.length > 0 ? s.teams.map((t) => t.name).join(', ') : `none for space ${s.spaceId}`)).join(' · ')} (via Teamwork Graph)
        </p>
      ) : null}
      {change.canDecide ? (
        <p>
          <label>
            Deadline (working days){' '}
            <input type="number" min={1} max={30} value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </label>{' '}
          <button type="button" className="button button--primary" disabled={busy} onClick={() => void decide('confirmChange')}>
            Confirm change
          </button>{' '}
          <button type="button" className="button button--subtle" disabled={busy} onClick={() => void decide('dismissChange')}>
            Dismiss
          </button>
        </p>
      ) : (
        <p className="muted">Only editors of this page can confirm the change.</p>
      )}
    </section>
  );
}
