import type { BylineStatus } from '../../src/core/views';
import { useRemote } from './bridge';
import { mount } from './mount';

/** M0 byline popup: readiness, database setup progress and the space's owning teams (Teamwork Graph). */
function Byline() {
  const { data, error, loading } = useRemote<BylineStatus>('getBylineStatus');
  if (loading) return <p className="muted">Loading…</p>;
  if (error || !data) return <p className="error">Ripple could not load: {error ?? 'no data'}</p>;
  const { schema, spaceTeams } = data;
  return (
    <>
      <h1 className="shell__title">{data.message}</h1>
      <p>
        Database:{' '}
        {schema.status === 'ready' ? (
          <span className="ok">ready ({schema.applied}/{schema.total} steps, {schema.latest})</span>
        ) : schema.status === 'setting_up' ? (
          <span>setting up ({schema.applied}/{schema.total} steps), try again in a minute</span>
        ) : (
          <span className="error">check failed: {schema.error}</span>
        )}
      </p>
      <p>Space owning team (via Teamwork Graph):</p>
      {spaceTeams.teams.length > 0 ? (
        <ul>
          {spaceTeams.teams.map((t) => (
            <li key={t.id}>{t.name}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">{spaceTeams.dataPresent ? 'No team is linked to this space.' : 'Teamwork Graph returned no data.'}</p>
      )}
      {spaceTeams.errors.length > 0 ? <p className="error">{spaceTeams.errors.join(' | ')}</p> : null}
    </>
  );
}

mount(
  <main className="shell">
    <Byline />
  </main>,
);
