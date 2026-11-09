import { Modal, router, view } from '@forge/bridge';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ChangeDecision, ChangePageView, ChangeSpaceView, PendingChangeReply, PendingChangeView } from '../../src/core/views';
import { call } from './bridge';
import { Alert, LoadingRows, errorOf } from './components';
import { rememberChange } from './rollout';

/** Value sent in the modal context so the byline resource renders the change review instead of the byline. */
export const CHANGE_MODAL_VIEW = 'ripple-change-review';

const DEADLINE_CHOICES = [2, 3, 5, 7, 10, 15, 20, 30] as const;

const withUnit = (value: string, unit: string | null): string => (unit && !value.includes(unit) ? `${value} ${unit}` : value);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const spaceKeyOf = (url: string | null): string | null => (url ? (/\/spaces\/([^/]+)\//.exec(url)?.[1] ?? null) : null);
const ownerName = (p: ChangePageView): string => p.owner.displayName ?? (p.owner.accountId ? 'Unknown user' : 'No owner');

/** Today + n working days (Mon–Fri; public holidays are not known to the UI). */
function addWorkingDays(days: number, from = new Date()): Date {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}
const formatDay = (d: Date): string => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const formatIsoDay = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : formatDay(d);
};

interface SpaceGroup {
  spaceId: string | null;
  key: string | null;
  space: ChangeSpaceView | undefined;
  pages: ChangePageView[];
}

function groupBySpace(change: PendingChangeView): SpaceGroup[] {
  const groups = new Map<string, SpaceGroup>();
  for (const p of change.pages) {
    const id = p.spaceId ?? '';
    const g = groups.get(id) ?? { spaceId: p.spaceId, key: null, space: change.spaces.find((s) => s.spaceId === p.spaceId), pages: [] };
    g.key ??= spaceKeyOf(p.pageUrl);
    g.pages.push(p);
    groups.set(id, g);
  }
  return [...groups.values()];
}

function ownerCount(pages: ChangePageView[]): number {
  return new Set(pages.map((p) => p.owner.accountId ?? `name:${ownerName(p)}`)).size;
}

type Mode = 'inline' | 'modal';

/**
 * Inline entry point in the byline popup. The full review also renders here (works without a modal); "Open larger
 * view" opens the same resource in a Forge modal (no manifest change: `Modal` without `resource` reuses this one).
 */
export function ChangePanel({ onDecided }: { onDecided?: () => void }) {
  return <ChangeReview mode="inline" onDecided={onDecided} />;
}

/** Rendered by the byline resource when it is opened as a modal (`extension.modal.view === CHANGE_MODAL_VIEW`). */
export function ChangeModalView() {
  return <ChangeReview mode="modal" />;
}

interface ChangeReviewProps {
  mode: Mode;
  onDecided?: () => void;
}

/**
 * M3 (FR-7) propagation confirmation. States: loading rows → (error + retry) | nothing pending | review → sending →
 * success / error. Nothing is sent before "Send update proposals" is pressed.
 */
function ChangeReview({ mode, onDecided }: ChangeReviewProps) {
  const [change, setChange] = useState<PendingChangeView | null>();
  const [loadError, setLoadError] = useState<string>();
  const [error, setError] = useState<string>();
  const [days, setDays] = useState(5);
  const [pending, setPending] = useState<'confirmChange' | 'dismissChange'>();
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [done, setDone] = useState<ChangeDecision>();
  const [pageId, setPageId] = useState<string>();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const result = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setLoadError(undefined);
    call<PendingChangeReply>('getPendingChange')
      .then((r) => {
        setPageId(r.pageId);
        setChange(r.change);
        if (r.change) setDays(r.change.defaultDeadlineDays);
      })
      .catch((e: unknown) => setLoadError(errorOf(e)));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (mode === 'modal' && change) heading.current?.focus();
  }, [mode, change]);
  useEffect(() => {
    if (done) result.current?.focus();
  }, [done]);

  const decide = async (action: 'confirmChange' | 'dismissChange') => {
    if (!change) return;
    setPending(action);
    setError(undefined);
    try {
      const payload = action === 'confirmChange' ? { changeId: change.id, deadlineDays: days, version: change.version } : { changeId: change.id, version: change.version };
      const decision = await call<ChangeDecision>(action, payload);
      if (decision.status === 'confirmed' && pageId) rememberChange(pageId, decision.changeId);
      setDone(decision);
      onDecided?.();
    } catch (e) {
      const message = errorOf(e);
      setError(message);
      // A newer page version replaced the reviewed change: show the latest one.
      if (message.includes('Review it again')) load();
    } finally {
      setPending(undefined);
      setConfirmDismiss(false);
    }
  };

  const close = () => void view.close(done ? { decided: done.status } : undefined).catch(() => undefined);
  const openModal = () => {
    void new Modal({
      size: 'large',
      title: 'Source page changed',
      context: { view: CHANGE_MODAL_VIEW },
      // The modal may have confirmed/dismissed the change: refresh it and the source panel.
      onClose: () => {
        load();
        onDecided?.();
      },
    })
      .open()
      .catch((e: unknown) => setError(`Could not open the larger view: ${errorOf(e)}`));
  };

  if (change === undefined) {
    return (
      <section className={`change change--${mode}`} aria-label="Source change">
        {loadError ? <Alert message={`Could not load the change: ${loadError}`} onRetry={load} /> : <LoadingRows label="Loading the change…" />}
      </section>
    );
  }

  if (done) {
    const confirmed = done.status === 'confirmed';
    const due = formatIsoDay(done.deadline);
    return (
      <section className={`change change--${mode} change--done`} aria-label="Source change">
        <div className="change__result" role="status" tabIndex={-1} ref={result}>
          <p className="change__result-title">{confirmed ? 'Confirmed. Update proposals will be prepared' : 'Dismissed. No update proposals will be prepared'}</p>
          <p className="muted">
            {confirmed
              ? `${plural(done.factsUpdated, 'fact now has its', 'facts now have their')} new value. ${plural(done.copiesDrifted, 'copy is', 'copies are')} out of date${due ? `; owners have until ${due}` : ''}.`
              : 'The facts keep their confirmed values.'}
          </p>
        </div>
        {mode === 'modal' ? (
          <div className="actions">
            <button type="button" className="button button--primary" onClick={close}>
              Close
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  if (change === null) {
    if (mode === 'inline') return null;
    return (
      <section className="change change--modal" aria-label="Source change">
        <p className="empty">Nothing is waiting for review. The change may already have been confirmed or dismissed.</p>
        <div className="actions">
          <button type="button" className="button" onClick={close}>
            Close
          </button>
        </div>
      </section>
    );
  }

  const groups = groupBySpace(change);
  const owners = ownerCount(change.pages);
  const busy = pending !== undefined;
  const dueDate = formatDay(addWorkingDays(days));
  const deadlineId = `${headingId}-deadline`;
  const notIncluded: string[] = [
    change.unsure > 0 ? `${plural(change.unsure, 'unsure copy', 'unsure copies')} (needs a human check)` : '',
    change.needsCheck > 0 ? `${plural(change.needsCheck, 'copy', 'copies')} whose value could not be compared (check by hand)` : '',
    change.hiddenCount > 0 ? `${plural(change.hiddenCount, 'copy', 'copies')} in pages you can't view` : '',
    change.alreadyNew > 0 ? `${plural(change.alreadyNew, 'copy', 'copies')} already showing the new value` : '',
    change.historical > 0 ? `${plural(change.historical, 'historical mention', 'historical mentions')}` : '',
  ].filter(Boolean);

  return (
    <section className={`change change--${mode}`} aria-labelledby={headingId}>
      <header className="change__header">
        <p className="change__eyebrow">Version {change.version} saved</p>
        <h2 id={headingId} className="change__title" tabIndex={-1} ref={heading}>
          {plural(change.facts.length, 'fact changed', 'facts changed')}
        </h2>
        <p className="change__summary">
          <strong>{plural(change.copies, 'copy', 'copies')}</strong> affected across <strong>{plural(change.pages.length, 'page', 'pages')}</strong> owned by{' '}
          <strong>{plural(owners, 'person', 'people')}</strong>.
        </p>
      </header>

      <ul className="change__facts" aria-label="Changed facts">
        {change.facts.map((f) => (
          <li key={f.factId} className="change__fact">
            <p className="change__fact-label">{f.factLabel}</p>
            <p className="change__values">
              <del className="change__old">
                <span className="sr-only">Old value: </span>
                {withUnit(f.oldValue, f.oldUnit)}
              </del>
              <span aria-hidden="true" className="change__arrow">
                →
              </span>
              <ins className="change__new">
                <span className="sr-only">New value: </span>
                {withUnit(f.newValue, f.newUnit)}
              </ins>
            </p>
            <blockquote className="quote__text change__quote">{f.newQuote}</blockquote>
          </li>
        ))}
      </ul>
      {change.missingFacts > 0 ? (
        <p className="muted change__note">{plural(change.missingFacts, 'confirmed fact is', 'confirmed facts are')} no longer on the page. Ripple keeps them and does not propagate anything for them.</p>
      ) : null}

      {groups.length > 0 ? (
        <details className="change__owners" open={mode === 'modal'}>
          <summary>
            Who will be asked ({plural(change.pages.length, 'page', 'pages')}, {plural(groups.length, 'space', 'spaces')})
          </summary>
          <ul className="change__spaces">
            {groups.map((g) => (
              <li key={g.spaceId ?? 'none'} className="change__space">
                <div className="change__space-head">
                  <span className="change__space-name">{g.key ? `Space ${g.key}` : 'Unknown space'}</span>
                  {g.space && g.space.teamSource === 'teamwork_graph' && g.space.teams.length > 0 ? (
                    <>
                      <span className="change__team">{g.space.teams.map((t) => t.name).join(', ')}</span>
                      <span className="badge badge--twg">via Teamwork Graph</span>
                    </>
                  ) : g.space?.teamSource === 'unknown' ? (
                    <span className="muted change__team">Team unavailable, try again</span>
                  ) : (
                    <span className="muted change__team">No team linked</span>
                  )}
                </div>
                <ul className="change__pages">
                  {g.pages.map((p) => (
                    <li key={p.pageId} className="change__page">
                      <a
                        className="copy__link"
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          void router.open({ target: 'contentView', contentId: p.pageId });
                        }}
                      >
                        {p.pageTitle ?? `Page ${p.pageId}`}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                      <span className="muted">
                        {' '}
                        · {ownerName(p)} · {plural(p.copies, 'copy', 'copies')}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="muted change__note">Owning team resolved via Teamwork Graph for each space.</p>
        </details>
      ) : (
        <p className="muted change__note">No copies on pages you can view need this update.</p>
      )}

      {notIncluded.length > 0 ? <p className="muted change__note">Not included: {notIncluded.join(' · ')}.</p> : null}

      {error ? <Alert message={error} /> : null}

      {change.canDecide ? (
        confirmDismiss ? (
          <div className="change__actions" role="group" aria-label="Confirm dismiss">
            <p className="source__confirm">Treat this as not a real change? The facts keep their confirmed values and no proposals are prepared.</p>
            <div className="actions">
              <button type="button" className="button button--danger" disabled={busy} onClick={() => void decide('dismissChange')}>
                {pending === 'dismissChange' ? 'Dismissing…' : 'Dismiss change'}
              </button>
              <button type="button" className="button button--subtle" disabled={busy} onClick={() => setConfirmDismiss(false)}>
                Back
              </button>
            </div>
          </div>
        ) : (
          <div className="change__actions">
            <label className="field change__deadline" htmlFor={deadlineId}>
              <span className="field__label">Deadline for page owners</span>
              <select id={deadlineId} className="field__input" value={days} disabled={busy} onChange={(e) => setDays(Number(e.target.value))}>
                {[...new Set<number>([...DEADLINE_CHOICES, change.defaultDeadlineDays])]
                  .sort((a, b) => a - b)
                  .map((d) => (
                    <option key={d} value={d}>
                      {plural(d, 'working day', 'working days')}
                      {d === change.defaultDeadlineDays ? ' (default)' : ''}
                    </option>
                  ))}
              </select>
              <span className="muted change__due">Due {dueDate}</span>
            </label>
            <p className="muted change__note">Nothing is sent until you press Send update proposals.</p>
            <div className="actions">
              <button type="button" className="button button--primary" disabled={busy} aria-busy={pending === 'confirmChange'} onClick={() => void decide('confirmChange')}>
                {pending === 'confirmChange' ? 'Confirming…' : 'Send update proposals'}
              </button>
              <button type="button" className="button button--subtle" disabled={busy} onClick={() => setConfirmDismiss(true)}>
                Not a real change
              </button>
              {mode === 'inline' ? (
                <button type="button" className="button button--subtle" disabled={busy} onClick={openModal}>
                  Open larger view
                </button>
              ) : null}
            </div>
          </div>
        )
      ) : (
        <p className="muted change__note">Only people who can edit this page can send update proposals.</p>
      )}
    </section>
  );
}
