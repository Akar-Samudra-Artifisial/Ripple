import { view } from '@forge/bridge';
import { useCallback, useEffect, useState } from 'react';
import type { BylineStatus } from '../../src/core/views';
import { call } from './bridge';
import { CHANGE_MODAL_VIEW, ChangeModalView, ChangePanel } from './changePanel';
import { mount } from './mount';
import { ProposalsPanel } from './proposalsPanel';
import { SourcePanel } from './sourcePanel';

const SETUP_POLL_MS = 3000;
/** Give up polling after this long; the user can retry. Migrations normally finish well within it. */
const SETUP_TIMEOUT_MS = 3 * 60 * 1000;

interface BylineState {
  data?: BylineStatus;
  error?: string;
  timedOut: boolean;
}

/**
 * Loads the byline status and, while the database is `setting_up`, polls every 3 s (one request at a time) until it is
 * `ready` or `error`, the popup unmounts, or the timeout passes. `retry()` starts a fresh round.
 */
function useBylineStatus(): BylineState & { retry: () => void } {
  const [state, setState] = useState<BylineState>({ timedOut: false });
  const [round, setRound] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + SETUP_TIMEOUT_MS;
    const tick = async () => {
      try {
        const data = await call<BylineStatus>('getBylineStatus');
        if (!alive) return;
        const settingUp = data.schema.status === 'setting_up';
        const timedOut = settingUp && Date.now() >= deadline;
        setState({ data, timedOut });
        if (settingUp && !timedOut) timer = setTimeout(() => void tick(), SETUP_POLL_MS);
      } catch (e) {
        if (alive) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), timedOut: false }));
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [round]);

  const retry = useCallback(() => {
    setState((s) => ({ data: s.data, timedOut: false }));
    setRound((r) => r + 1);
  }, []);
  return { ...state, retry };
}

/** Byline popup: readiness, database setup progress (polled while not ready), owner/team and the source-of-truth panel. */
function Byline() {
  const { data, error, timedOut, retry } = useBylineStatus();
  /** Bumped after a change is confirmed/dismissed so the source panel reloads facts and copies. */
  const [revision, setRevision] = useState(0);
  const onDecided = useCallback(() => setRevision((r) => r + 1), []);
  if (error) {
    return (
      <div className="alert" role="alert">
        <p className="alert__text">Ripple could not load: {error}</p>
        <button type="button" className="button" onClick={retry}>
          Retry
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <p className="muted" role="status">
        Loading…
      </p>
    );
  }
  const { schema, spaceTeams, owner } = data;
  const ownerName = owner.displayName ?? (owner.accountId ? 'Unknown user' : 'none');
  const teamsUnknown = spaceTeams.teams.length === 0 && spaceTeams.errors.length > 0;
  const teamNames = spaceTeams.teams.length > 0 ? spaceTeams.teams.map((t) => t.name).join(', ') : teamsUnknown ? 'unavailable' : 'none';
  return (
    <>
      <h1 className={schema.status === 'error' ? 'shell__title error' : 'shell__title'}>{data.message}</h1>
      {schema.status === 'setting_up' && !timedOut ? (
        <div className="progress">
          <p role="status" className="progress__label">
            Setting up the database ({schema.applied}/{schema.total} steps)…
          </p>
          <div className="progress__track" role="progressbar" aria-label="Database setup" aria-valuemin={0} aria-valuemax={schema.total} aria-valuenow={schema.applied}>
            <div className="progress__fill" style={{ width: `${schema.total > 0 ? (schema.applied / schema.total) * 100 : 0}%` }} />
          </div>
          <p className="muted progress__hint">This refreshes on its own; Ripple opens as soon as setup is done.</p>
        </div>
      ) : null}
      {schema.status === 'setting_up' && timedOut ? (
        <div className="alert" role="alert">
          <p className="alert__text">
            Database setup is taking longer than expected ({schema.applied}/{schema.total} steps).
          </p>
          <button type="button" className="button" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}
      {schema.status === 'error' ? (
        <div className="alert" role="alert">
          <p className="alert__text">Database check failed: {schema.error}</p>
          <button type="button" className="button" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}
      {schema.status === 'ready' && data.pendingChange ? <ChangePanel onDecided={onDecided} /> : null}
      {schema.status === 'ready' && data.pendingProposals > 0 ? <ProposalsPanel /> : null}
      <p>
        <strong>Owner: {ownerName}</strong> · Team: {teamNames} <span className="muted">(via Teamwork Graph)</span>
      </p>
      {owner.errors.length > 0 ? <p className="error">{owner.errors.join(' | ')}</p> : null}
      {/* Teamwork Graph error texts stay in the logs; the page shows a generic message. */}
      {teamsUnknown ? (
        <p className="muted">Team unavailable, try again.</p>
      ) : spaceTeams.teams.length === 0 ? (
        <p className="muted">{spaceTeams.dataPresent ? 'No team is linked to this space.' : 'Teamwork Graph returned no data.'}</p>
      ) : null}
      {schema.status === 'ready' ? <SourcePanel key={revision} /> : null}
    </>
  );
}

/**
 * The byline resource also serves the change-review modal (opened with `Modal` and no `resource`, so the manifest is
 * unchanged); `extension.modal.view` tells the two apart.
 */
function Root() {
  const [isModal, setIsModal] = useState<boolean>();
  useEffect(() => {
    view
      .getContext()
      .then((ctx) => {
        const modal: unknown = ctx.extension.modal;
        setIsModal(typeof modal === 'object' && modal !== null && (modal as { view?: unknown }).view === CHANGE_MODAL_VIEW);
      })
      .catch(() => setIsModal(false));
  }, []);
  if (isModal === undefined) {
    return (
      <p className="muted" role="status">
        Loading…
      </p>
    );
  }
  return isModal ? <ChangeModalView /> : <Byline />;
}

mount(
  <main className="shell">
    <Root />
  </main>,
);
