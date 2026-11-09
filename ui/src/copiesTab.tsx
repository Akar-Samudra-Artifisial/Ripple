import { router, view } from '@forge/bridge';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { CopyCounts, CopyList, CopyStatus, CopyView, ScanStatus, ScanView } from '../../src/core/views';
import { call } from './bridge';
import { Alert, LoadingRows, errorOf } from './components';

const POLL_MS = 3000;

/** Blameless labels (PRD): "out of date", never "wrong". */
const COPY_LABEL: Record<CopyStatus, string> = {
  drifted: 'Out of date',
  unsure: 'Unsure',
  in_sync: 'In sync',
  updated: 'Updated',
  ignored: 'Ignored',
  historical: 'Historical',
};
/** Out-of-date copies first (PRD "Tab Copies"). */
const ORDER: readonly CopyStatus[] = ['drifted', 'unsure', 'in_sync', 'updated', 'ignored', 'historical'];

type Filter = 'all' | CopyStatus;
interface LoadedList {
  filter: Filter;
  data: CopyList;
}

/** Statuses counted as copies in the headline ("23 copies"); a historical mention is not a copy. */
const COPY_STATUSES_COUNTED: readonly CopyStatus[] = ['in_sync', 'drifted', 'unsure', 'updated'];
/** Statuses of the "All" list and its chip: the copies plus historical mentions (ignored matches have their own filter). */
const ALL_STATUSES: readonly CopyStatus[] = [...COPY_STATUSES_COUNTED, 'historical'];
const totalOf = (c: CopyCounts): number => COPY_STATUSES_COUNTED.reduce((n, s) => n + c[s], 0);
/** Card label; a historical mention is shown but never compared. */
const cardLabel = (s: CopyStatus): string => (s === 'historical' ? 'Historical mention — not checked' : COPY_LABEL[s]);
const withUnit = (value: string | null, unit: string | null): string => (value ? (unit && !value.includes(unit) ? `${value} ${unit}` : value) : '—');
const spaceOf = (url: string | null): string | null => (url ? (/\/spaces\/([^/]+)\//.exec(url)?.[1] ?? null) : null);
const formatDateTime = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

interface CopiesTabProps {
  canEdit: boolean;
  /** Confirmed facts on the source; a scan needs at least one. */
  confirmed: number;
  onShowFacts: () => void;
}

/**
 * Copies tab (FR-4..6). Render states: no `status` yet → loading rows (or error + retry); no confirmed facts and no
 * scan → "Confirm facts to scan for copies"; no scan → intro + "Find copies"; `searching`/`judging` → progress (polled,
 * stalled → resume); `error` → alert + "Try again"; `done` → counts, filters and the list. The list for the selected
 * filter shows loading rows until its first reply, so "No copies" only appears for a real empty reply.
 */
export function CopiesTab({ canEdit, confirmed, onShowFacts }: CopiesTabProps) {
  const [status, setStatus] = useState<ScanStatus>();
  const [list, setList] = useState<LoadedList>();
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [siteUrl, setSiteUrl] = useState<string>();
  const request = useRef(0);

  useEffect(() => {
    view
      .getContext()
      .then((ctx) => setSiteUrl(ctx.siteUrl.replace(/\/$/, '')))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    const id = ++request.current;
    const s = await call<ScanStatus>('getScanStatus');
    // Fetch the list before committing a `done` status so counts and list render together.
    const data = s.scan?.state === 'done' ? await call<CopyList>('listCopies', filter === 'all' ? {} : { status: filter }) : undefined;
    if (id !== request.current) return; // a newer load (e.g. another filter) superseded this one
    setStatus(s);
    if (data) setList({ filter, data });
    setError(undefined);
  }, [filter]);
  const reload = useCallback(() => {
    setError(undefined);
    load().catch((e: unknown) => setError(errorOf(e)));
  }, [load]);

  useEffect(() => {
    reload();
  }, [reload]);

  const running = status?.scan?.state === 'searching' || status?.scan?.state === 'judging';
  const stalled = running && status?.scan?.stalled === true;
  useEffect(() => {
    if (!running || stalled) return;
    const timer = setInterval(() => load().catch((e: unknown) => setError(errorOf(e))), POLL_MS);
    return () => clearInterval(timer);
  }, [running, stalled, load]);

  const start = useCallback(async () => {
    setStarting(true);
    setError(undefined);
    try {
      setStatus(await call<ScanStatus>('startScan'));
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setStarting(false);
    }
  }, []);

  if (!status) {
    return error ? <Alert message={`Could not load the copies: ${error}`} onRetry={reload} /> : <LoadingRows label="Loading copies…" />;
  }

  const { scan, counts } = status;
  const mayScan = canEdit && confirmed > 0;
  const startLabel = (idle: string) => (starting ? 'Starting…' : idle);

  if (!scan) {
    if (confirmed === 0) {
      return (
        <div className="empty empty--action">
          <p className="empty__title">Confirm facts to scan for copies</p>
          <p>Ripple only searches for facts you have confirmed, so other pages are compared with values you trust.</p>
          <button type="button" className="button" onClick={onShowFacts}>
            Review facts
          </button>
        </div>
      );
    }
    return (
      <div className="empty empty--action">
        <p className="empty__title">Find where these facts are repeated</p>
        <p>
          Ripple searches Confluence for pages that restate the {confirmed} confirmed {confirmed === 1 ? 'fact' : 'facts'}, even in different words, and checks whether
          each one still matches this page.
        </p>
        {error ? <Alert message={error} /> : null}
        {canEdit ? (
          <button type="button" className="button button--primary" disabled={starting} onClick={() => void start()}>
            {startLabel('Find copies')}
          </button>
        ) : (
          <p className="muted">Only people who can edit this page can start a search.</p>
        )}
      </div>
    );
  }

  return (
    <div className="copies">
      {error ? <Alert message={error} /> : null}

      {running ? <ScanProgress scan={scan} /> : null}
      {stalled ? (
        <Alert
          tone="warning"
          message="The search stopped making progress."
          onRetry={canEdit ? () => void start() : undefined}
          retryLabel={startLabel('Resume search')}
          retryDisabled={starting}
        />
      ) : null}
      {scan.state === 'error' ? (
        <Alert
          message={`The last search failed. ${scan.error ?? ''}`.trim()}
          onRetry={mayScan ? () => void start() : undefined}
          retryLabel={startLabel('Try again')}
          retryDisabled={starting}
        />
      ) : null}

      {scan.state === 'done' ? (
        <DoneView scan={scan} counts={counts} filter={filter} list={list} siteUrl={siteUrl} onFilter={setFilter} onRetry={reload} hasError={Boolean(error)} />
      ) : null}

      {scan.state === 'done' && canEdit ? (
        <div className="source__footer actions">
          {confirmed > 0 ? (
            <button type="button" className="button button--subtle" disabled={starting} onClick={() => void start()}>
              {startLabel('Rescan')}
            </button>
          ) : (
            <p className="muted">Confirm at least one fact to search again.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ScanProgress({ scan }: { scan: ScanView }) {
  const searching = scan.state === 'searching';
  const done = searching ? scan.factsSearched : scan.pagesJudged;
  const total = searching ? scan.factsTotal : scan.candidates;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const label = searching ? `Searching Confluence for copies (${done}/${total} facts)` : `Checking ${total} ${total === 1 ? 'page' : 'pages'} for drift (${done}/${total})`;
  return (
    <div className="progress">
      <p className="progress__label" role="status">
        Step {searching ? 1 : 2} of 2 · {label}…
      </p>
      <div className="progress__track" role="progressbar" aria-label={searching ? 'Searching for copies' : 'Checking pages'} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <div className="progress__fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="muted progress__hint">Large spaces can take a few minutes. You can close this and come back.</p>
    </div>
  );
}

interface DoneViewProps {
  scan: ScanView;
  counts: CopyCounts;
  filter: Filter;
  list: LoadedList | undefined;
  siteUrl: string | undefined;
  hasError: boolean;
  onFilter: (f: Filter) => void;
  onRetry: () => void;
}

function DoneView({ scan, counts, filter, list, siteUrl, hasError, onFilter, onRetry }: DoneViewProps) {
  const total = totalOf(counts);
  const finished = formatDateTime(scan.finishedAt);
  const filters: { id: Filter; label: string; count: number }[] = [
    // "All" lists exactly what its count counts: the copies and the historical mentions.
    { id: 'all', label: 'All', count: total + counts.historical },
    ...ORDER.filter((s) => counts[s] > 0 || s === 'drifted').map((s) => ({ id: s, label: COPY_LABEL[s], count: counts[s] })),
  ];
  const current = list && list.filter === filter ? list.data : undefined;
  const copies = current ? [...current.copies].filter((c) => filter !== 'all' || ALL_STATUSES.includes(c.status)).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)) : undefined;

  return (
    <>
      <div className="copies__headline">
        <p className="copies__count">
          <strong>
            {total} {total === 1 ? 'copy' : 'copies'}
          </strong>
          {counts.drifted > 0 ? <span className="badge badge--copy-drifted">{counts.drifted} out of date</span> : <span className="badge badge--copy-in_sync">All in sync</span>}
        </p>
        <p className="muted source__meta">
          {scan.candidates} {scan.candidates === 1 ? 'page' : 'pages'} checked{finished ? ` · last scan ${finished}` : ''}
        </p>
      </div>

      {total > 0 || counts.historical > 0 || counts.ignored > 0 ? (
        <div className="chips" role="group" aria-label="Filter copies by status">
          {filters.map((f) => (
            <button key={f.id} type="button" className={`chip${f.id === 'drifted' && f.count > 0 ? ' chip--danger' : ''}`} aria-pressed={filter === f.id} onClick={() => onFilter(f.id)}>
              {f.label} <span className="chip__count">{f.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {copies === undefined ? (
        hasError ? <Alert message="Could not load the copies." onRetry={onRetry} /> : <LoadingRows label="Loading copies…" />
      ) : copies.length === 0 ? (
        <p className="empty">
          {filter === 'all'
            ? total === 0
              ? 'No copies found. None of the pages Ripple checked restate these facts.'
              : 'No copies to show here.'
            : `No ${COPY_LABEL[filter].toLowerCase()} copies.`}
        </p>
      ) : (
        <ul className="facts" aria-label="Copies">
          {copies.map((c) => (
            <CopyCard key={c.id} copy={c} siteUrl={siteUrl} />
          ))}
        </ul>
      )}

      {current && current.hiddenCount > 0 ? (
        <p className="muted copies__hidden">
          {current.hiddenCount} {current.hiddenCount === 1 ? 'copy is' : 'copies are'} in pages you can't view.
        </p>
      ) : null}
    </>
  );
}

function CopyCard({ copy, siteUrl }: { copy: CopyView; siteUrl: string | undefined }) {
  const space = spaceOf(copy.pageUrl);
  const href = siteUrl && copy.pageUrl ? `${siteUrl}${copy.pageUrl.startsWith('/wiki') ? '' : '/wiki'}${copy.pageUrl}` : undefined;
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    void router.open({ target: 'contentView', contentId: copy.pageId });
  };
  const differs = copy.status === 'drifted';
  const historical = copy.status === 'historical';
  return (
    <li className={`fact copy copy--${copy.status}`}>
      <div className="fact__top">
        <span className="fact__type">{copy.factLabel}</span>
        <span className={`badge badge--copy-${copy.status}`}>{cardLabel(copy.status)}</span>
      </div>
      <h3 className="fact__title">
        <a className="copy__link" href={href ?? '#'} target="_blank" rel="noopener noreferrer" onClick={open}>
          {copy.pageTitle || `Page ${copy.pageId}`}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        {space ? <span className="fact__attr"> · {space}</span> : null}
      </h3>
      <dl className="copy__compare">
        <div className={`copy__side${differs ? ' copy__side--drifted' : ''}`}>
          <dt>{historical ? 'Past value on this page' : 'This page says'}</dt>
          <dd className="fact__value">{withUnit(copy.statedValue, copy.statedUnit)}</dd>
          {copy.statedCondition ? <dd className="muted copy__when">When {copy.statedCondition}</dd> : null}
        </div>
        <div className="copy__side">
          <dt>Source says</dt>
          <dd className="fact__value">{withUnit(copy.officialValue, copy.officialUnit)}</dd>
        </div>
      </dl>
      <figure className="quote">
        <blockquote className="quote__text">{copy.quote}</blockquote>
        <figcaption className="quote__caption">{copy.reason}</figcaption>
      </figure>
    </li>
  );
}
