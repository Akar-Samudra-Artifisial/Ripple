import type { BylineStatus } from '../../src/core/views';
import { useRemote } from './bridge';
import { mount } from './mount';
import { SourcePanel } from './sourcePanel';

/** Byline popup: readiness, database setup progress (only while not ready), owner/team and the source-of-truth panel. */
function Byline() {
  const { data, error, loading } = useRemote<BylineStatus>('getBylineStatus');
  if (loading) return <p className="muted">Loading…</p>;
  if (error || !data) return <p className="error">Ripple could not load: {error ?? 'no data'}</p>;
  const { schema, spaceTeams, owner } = data;
  const ownerName = owner.displayName ?? (owner.accountId ? 'Unknown user' : 'none');
  const teamNames = spaceTeams.teams.length > 0 ? spaceTeams.teams.map((t) => t.name).join(', ') : 'none';
  return (
    <>
      <h1 className={schema.status === 'error' ? 'shell__title error' : 'shell__title'}>{data.message}</h1>
      {schema.status === 'ready' ? null : (
        <p role="status">
          Database:{' '}
          {schema.status === 'setting_up' ? (
            <span>setting up ({schema.applied}/{schema.total} steps), try again in a minute</span>
          ) : (
            <span className="error">check failed: {schema.error}</span>
          )}
        </p>
      )}
      <p>
        <strong>Owner: {ownerName}</strong> · Team: {teamNames} <span className="muted">(via Teamwork Graph)</span>
      </p>
      {owner.errors.length > 0 ? <p className="error">{owner.errors.join(' | ')}</p> : null}
      {spaceTeams.teams.length === 0 ? (
        <p className="muted">{spaceTeams.dataPresent ? 'No team is linked to this space.' : 'Teamwork Graph returned no data.'}</p>
      ) : null}
      {spaceTeams.errors.length > 0 ? <p className="error">{spaceTeams.errors.join(' | ')}</p> : null}
      {schema.status === 'ready' ? <SourcePanel /> : null}
    </>
  );
}

mount(
  <main className="shell">
    <Byline />
  </main>,
);
