import type { NotImplemented } from '../../src/core/views';
import { useRemote } from './bridge';

/** Shared view for surfaces declared in the manifest but not built yet. */
export function Placeholder({ title, resolver }: { title: string; resolver: string }) {
  const { data, error, loading } = useRemote<NotImplemented>(resolver);
  return (
    <main className="shell">
      <h1 className="shell__title">{title}</h1>
      {loading ? <p className="muted">Loading…</p> : <p className={error ? 'error' : 'muted'}>{error ?? data?.message}</p>}
    </main>
  );
}
