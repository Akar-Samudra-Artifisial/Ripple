import { router } from '@forge/bridge';
import { useCallback, useEffect, useState } from 'react';
import type { CopyList, CopyStatus, CopyView, ScanStatus } from '../../src/core/views';
import { call } from './bridge';

const POLL_MS = 3000;
const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const COPY_LABEL: Record<CopyStatus, string> = {
  in_sync: 'In sync',
  drifted: 'Drifted',
  unsure: 'Unsure',
  historical: 'Historical',
  ignored: 'Ignored',
  updated: 'Updated',
};
/** Filters offered in the tab; `all` = everything except historical mentions. */
const FILTERS: ('all' | CopyStatus)[] = ['all', 'drifted', 'unsure', 'in_sync', 'historical'];

/**
 * Copies tab (FR-4..6): starts / resumes a copy scan, polls its progress and lists copies of the confirmed facts on
 * other pages. Copies on pages the viewer cannot open are only counted.
 */
export function CopiesTab({ canEdit, confirmed }: { canEdit: boolean; confirmed: number }) {
  const [status, setStatus] = useState<ScanStatus>();
  const [list, setList] = useState<CopyList>();
  const [filter, setFilter] = useState<'all' | CopyStatus>('all');
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    const s = await call<ScanStatus>('getScanStatus');
    setStatus(s);
    if (s.scan?.state === 'done') setList(await call<CopyList>('listCopies', filter === 'all' ? {} : { status: filter }));
    setError(undefined);
  }, [filter]);

  useEffect(() => {
    load().catch((e: unknown) => setError(errorOf(e)));
  }, [load]);

  const running = status?.scan?.state === 'searching' || status?.scan?.state === 'judging';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => load().catch((e: unknown) => setError(errorOf(e))), POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const start = async () => {
    setStarting(true);
    setError(undefined);
    try {
      setStatus(await call<ScanStatus>('startScan'));
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setStarting(false);
    }
  };

  if (!status) {
    return error ? (
      <p className="alert" role="alert">
        {error}
      </p>
    ) : (
      <p className="muted" role="status">
        Loading copies…
      </p>
    );
  }

  const { scan, counts } = status;
  const canStart = canEdit && confirmed > 0 && (!running || scan?.stalled === true);
  const label = !scan ? 'Find copies' : running ? 'Resume scan' : 'Rescan';

  return (
    <div className="copies">
      {scan?.state === 'done' ? (
        <p className="source__summary">
          <span className="badge badge--rejected">{counts.drifted} drifted</span>
          <span className="badge badge--proposed">{counts.unsure} unsure</span>
          <span className="badge badge--confirmed">{counts.in_sync} in sync</span>
          {counts.historical > 0 ? <span className="badge">{counts.historical} historical</span> : null}
        </p>
      ) : null}

      {running ? (
        <p role="status" className="muted">
          {scan?.state === 'searching'
            ? `Searching Confluence… ${scan.factsSearched}/${scan.factsTotal} facts`
            : `Checking pages… ${scan?.pagesJudged ?? 0}/${scan?.candidates ?? 0}`}
          {scan?.stalled ? ' (stalled)' : ''}
        </p>
      ) : null}
      {scan?.state === 'error' ? (
        <p className="alert" role="alert">
          The last scan failed: {scan.error}
        </p>
      ) : null}
      {!scan ? <p className="muted">Ripple searches other pages for these facts and checks whether they still match.</p> : null}
      {confirmed === 0 ? <p className="muted">Confirm at least one fact to search for copies.</p> : null}
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {canStart ? (
        <div className="actions">
          <button type="button" className="button button--primary" disabled={starting} onClick={() => void start()}>
            {starting ? 'Starting…' : label}
          </button>
        </div>
      ) : null}

      {scan?.state === 'done' ? (
        <>
          <div className="actions" role="group" aria-label="Filter copies">
            {FILTERS.map((f) => (
              <button key={f} type="button" className={`button ${filter === f ? 'button--primary' : 'button--subtle'}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : COPY_LABEL[f]}
              </button>
            ))}
          </div>
          {list && list.copies.length === 0 ? <p className="empty">No copies to show.</p> : null}
          {list && list.copies.length > 0 ? (
            <ul className="facts" aria-label="Copies">
              {list.copies.map((c) => (
                <CopyCard key={c.id} copy={c} />
              ))}
            </ul>
          ) : null}
          {list && list.hiddenCount > 0 ? (
            <p className="muted">
              {list.hiddenCount} more {list.hiddenCount === 1 ? 'copy is' : 'copies are'} on pages you cannot open.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function CopyCard({ copy }: { copy: CopyView }) {
  const stated = copy.statedValue ? `${copy.statedValue}${copy.statedUnit && !copy.statedValue.includes(copy.statedUnit) ? ` ${copy.statedUnit}` : ''}` : '';
  return (
    <li className="fact">
      <div className="fact__top">
        <span className={`badge badge--copy-${copy.status}`}>{COPY_LABEL[copy.status]}</span>
        <span className="fact__type">{copy.factLabel}</span>
      </div>
      <h3 className="fact__title">
        <button type="button" className="button button--subtle" onClick={() => void router.open({ target: 'contentView', contentId: copy.pageId })}>
          {copy.pageTitle || `Page ${copy.pageId}`}
        </button>
      </h3>
      <dl className="fact__grid">
        <dt>Says</dt>
        <dd className="fact__value">{stated}</dd>
        <dt>Source</dt>
        <dd>
          {copy.officialValue}
          {copy.officialUnit ? ` ${copy.officialUnit}` : ''}
        </dd>
      </dl>
      <figure className="quote">
        <blockquote className="quote__text">{copy.quote}</blockquote>
        <figcaption className="quote__caption">{copy.reason}</figcaption>
      </figure>
    </li>
  );
}
