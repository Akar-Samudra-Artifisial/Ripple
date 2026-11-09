import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { FactActionResult, FactEditPayload, FactList, FactStatus, FactType, FactView, SourceStatus } from '../../src/core/views';
import { call } from './bridge';
import { Alert, LoadingRows, TabPanel, Tabs, errorOf } from './components';
import { CopiesTab } from './copiesTab';
import { RolloutTab, forgetChange, recallChange } from './rollout';

const POLL_MS = 3000;

const STATUS_LABEL: Record<FactStatus, string> = { proposed: 'To review', confirmed: 'Confirmed', rejected: 'Rejected' };
const TYPE_LABEL: Record<FactType, string> = { number: 'Number', date: 'Date', list: 'List', name: 'Name', rule: 'Rule' };
const ACTION_DONE: Record<FactAction, string> = { confirmFact: 'Fact confirmed.', rejectFact: 'Fact rejected.', editFact: 'Changes saved.' };

type FactAction = 'confirmFact' | 'rejectFact' | 'editFact';
type SourceCall = 'markSource' | 'unmarkSource';

const formatDate = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
};

/**
 * Source-of-truth panel in the byline popup: mark/unmark, extraction progress (polled) and fact review.
 *
 * Render states: no `status` yet → "Loading source status…" (or error + retry); `notice` → setup message (polled);
 * no source → mark CTA; `extracting` → progress (polled); `error` → alert + "Try again"; `ready` with `facts`
 * undefined → "Loading facts…" (or error + retry); `ready` with `facts` loaded → list, or the empty message only when
 * the list is really empty. `facts` stays undefined until the first `listFacts` reply, so "No facts" never flashes.
 */
export function SourcePanel() {
  const [status, setStatus] = useState<SourceStatus>();
  /** Undefined until the first `listFacts` reply for a ready source. */
  const [facts, setFacts] = useState<FactView[]>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<SourceCall>();
  const [tab, setTab] = useState<'facts' | 'copies' | 'rollout'>('facts');
  const tabsId = useId();
  /** Last change confirmed from this browser (the contract has no lookup for it); enables the Rollout tab. */
  const [rolloutId, setRolloutId] = useState<string | null>(null);
  const pageId = status?.pageId;
  useEffect(() => {
    setRolloutId(pageId ? recallChange(pageId) : null);
  }, [pageId]);
  const dropRollout = useCallback(() => {
    if (pageId) forgetChange(pageId);
    setRolloutId(null);
    setTab('facts');
  }, [pageId]);

  const load = useCallback(async () => {
    const s = await call<SourceStatus>('getSourceStatus');
    // Fetch the facts before committing a `ready` status so status and list render together.
    const list = s.source?.state === 'ready' ? (await call<FactList>('listFacts')).facts : undefined;
    setStatus(s);
    if (list) setFacts(list);
    else if (!s.source) setFacts(undefined);
    setError(undefined);
    return s;
  }, []);
  const reload = useCallback(() => {
    setError(undefined);
    load().catch((e: unknown) => setError(errorOf(e)));
  }, [load]);

  useEffect(() => {
    reload();
  }, [reload]);

  const polling = status?.source?.state === 'extracting' || Boolean(status?.notice);
  const extracting = status?.source?.state === 'extracting';
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => load().catch((e: unknown) => setError(errorOf(e))), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, load]);

  const runSource = useCallback(async (name: SourceCall) => {
    setPending(name);
    setError(undefined);
    try {
      const s = await call<SourceStatus>(name);
      setStatus(s);
      if (!s.source) setFacts(undefined);
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setPending(undefined);
    }
  }, []);

  const runFact = useCallback(async (name: FactAction, payload: FactEditPayload | { factId: string }) => {
    const { fact } = await call<FactActionResult>(name, { ...payload });
    setFacts((list) => list?.map((f) => (f.id === fact.id ? fact : f)));
    call<SourceStatus>('getSourceStatus')
      .then(setStatus)
      .catch(() => undefined);
    return ACTION_DONE[name];
  }, []);

  if (!status) {
    return (
      <section className="source" aria-label="Source of truth">
        {error ? (
          <Alert message={`Could not load the source status: ${error}`} onRetry={reload} />
        ) : (
          <p className="muted" role="status">
            Loading source status…
          </p>
        )}
      </section>
    );
  }
  if (status.notice) {
    return (
      <section className="source" aria-label="Source of truth">
        <p className="muted" role="status">
          {status.notice}
        </p>
      </section>
    );
  }

  const { source, counts, canEdit } = status;
  const busy = pending !== undefined;

  if (!source) {
    return (
      <section className="source source--empty" aria-labelledby="source-heading">
        <h2 id="source-heading" className="source__heading">
          Not a source of truth
        </h2>
        <p className="muted">Mark this page as the official source. Ripple reads its facts, shows each one with the exact sentence it came from, and lets you confirm them.</p>
        {error ? <Alert message={error} /> : null}
        {canEdit ? (
          <button type="button" className="button button--primary" disabled={busy} aria-busy={pending === 'markSource'} onClick={() => void runSource('markSource')}>
            {pending === 'markSource' ? 'Marking…' : 'Mark as source of truth'}
          </button>
        ) : (
          <p className="muted">Only people who can edit this page can mark it.</p>
        )}
      </section>
    );
  }

  const total = counts.confirmed + counts.proposed;
  return (
    <section className="source" aria-labelledby="source-heading">
      <header className="source__header">
        <h2 id="source-heading" className="source__heading">
          Source of truth
        </h2>
        {source.state === 'ready' ? (
          <p className="source__summary">
            <span>
              {total} {total === 1 ? 'fact' : 'facts'}
            </span>
            <span className="badge badge--confirmed">{counts.confirmed} confirmed</span>
            {counts.proposed > 0 ? <span className="badge badge--proposed">{counts.proposed} to review</span> : null}
            {counts.rejected > 0 ? <span className="badge badge--rejected">{counts.rejected} rejected</span> : null}
          </p>
        ) : null}
        {source.pageVersion !== null ? <p className="muted source__meta">Read from page version {source.pageVersion}</p> : null}
      </header>

      {error && !(source.state === 'ready' && facts === undefined) ? <Alert message={error} /> : null}
      {source.truncated ? <p className="muted source__meta">This page is long, so Ripple read only its first part. Facts further down may be missing.</p> : null}

      {source.state === 'extracting' ? <Extracting /> : null}
      {source.state === 'error' ? (
        <Alert
          message={`Ripple could not read the facts on this page. ${source.error ?? ''}`.trim()}
          onRetry={canEdit ? () => void runSource('markSource') : undefined}
          retryLabel={pending === 'markSource' ? 'Retrying…' : 'Try again'}
          retryDisabled={busy}
        />
      ) : null}

      {source.state === 'ready' ? (
        <Tabs
          idPrefix={tabsId}
          label="Source of truth views"
          selected={tab}
          onSelect={setTab}
          tabs={[
            { id: 'facts', label: `Facts (${total})` },
            { id: 'copies', label: 'Copies' },
            ...(rolloutId ? [{ id: 'rollout' as const, label: 'Rollout' }] : []),
          ]}
        />
      ) : null}

      {source.state === 'ready' && tab === 'copies' ? (
        <TabPanel idPrefix={tabsId} id="copies">
          <CopiesTab canEdit={canEdit} confirmed={counts.confirmed} onShowFacts={() => setTab('facts')} />
        </TabPanel>
      ) : source.state === 'ready' && tab === 'rollout' && rolloutId ? (
        <TabPanel idPrefix={tabsId} id="rollout">
          <RolloutTab changeId={rolloutId} onGone={dropRollout} />
        </TabPanel>
      ) : (
        <FactsList facts={facts} ready={source.state === 'ready'} error={error} canEdit={canEdit} onRetry={reload} onAction={runFact} tabsId={tabsId} />
      )}

      {canEdit ? <SourceActions extracting={extracting} pending={pending} onRun={runSource} /> : null}
    </section>
  );
}

interface FactsListProps {
  facts: FactView[] | undefined;
  ready: boolean;
  error: string | undefined;
  canEdit: boolean;
  tabsId: string;
  onRetry: () => void;
  onAction: FactCardProps['onAction'];
}

/** Facts tab body; wrapped in its tab panel only when the tabs are shown (source ready). */
function FactsList({ facts, ready, error, canEdit, tabsId, onRetry, onAction }: FactsListProps) {
  const body = (
    <>
      {ready && facts === undefined ? error ? <Alert message={`Could not load the facts: ${error}`} onRetry={onRetry} /> : <LoadingRows label="Loading facts…" /> : null}
      {ready && facts?.length === 0 ? (
        <p className="empty">No facts were found on this page. Facts are numbers, dates, lists, names and yes/no rules stated in the text.</p>
      ) : null}
      {facts && facts.length > 0 ? (
        <ul className="facts" aria-label="Facts on this page">
          {facts.map((f) => (
            <FactCard key={f.id} fact={f} canEdit={canEdit} onAction={onAction} />
          ))}
        </ul>
      ) : null}
    </>
  );
  return ready ? (
    <TabPanel idPrefix={tabsId} id="facts">
      {body}
    </TabPanel>
  ) : (
    body
  );
}

function Extracting() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="progress">
      <p role="status" className="progress__label">
        Reading facts from this page…
      </p>
      <div className="progress__track" role="progressbar" aria-label="Extracting facts" aria-valuetext="In progress">
        <div className="progress__bar" />
      </div>
      <p className="muted progress__hint">
        {seconds}s elapsed · this usually takes under a minute. You can close this and come back.
      </p>
    </div>
  );
}

function SourceActions({ extracting, pending, onRun }: { extracting: boolean; pending: SourceCall | undefined; onRun: (name: SourceCall) => Promise<void> }) {
  const [confirmUnmark, setConfirmUnmark] = useState(false);
  const busy = pending !== undefined;
  if (confirmUnmark) {
    return (
      <div className="source__footer" role="group" aria-label="Confirm unmark">
        <p className="source__confirm">Stop treating this page as the source of truth? Ripple will stop tracking its facts.</p>
        <div className="actions">
          <button
            type="button"
            className="button button--danger"
            disabled={busy}
            onClick={() => void onRun('unmarkSource').then(() => setConfirmUnmark(false))}
          >
            {pending === 'unmarkSource' ? 'Unmarking…' : 'Unmark'}
          </button>
          <button type="button" className="button button--subtle" disabled={busy} onClick={() => setConfirmUnmark(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="source__footer actions">
      <button type="button" className="button button--subtle" disabled={busy || extracting} onClick={() => void onRun('markSource')}>
        {pending === 'markSource' ? 'Starting…' : 'Extract again'}
      </button>
      <button type="button" className="button button--subtle" disabled={busy} onClick={() => setConfirmUnmark(true)}>
        Unmark as source
      </button>
    </div>
  );
}

interface FactCardProps {
  fact: FactView;
  canEdit: boolean;
  onAction: (name: FactAction, payload: FactEditPayload | { factId: string }) => Promise<string>;
}

type DraftKey = 'subject' | 'attribute' | 'value' | 'unit' | 'condition';

function FactCard({ fact, canEdit, onAction }: FactCardProps) {
  const [draft, setDraft] = useState<FactEditPayload>();
  const [pending, setPending] = useState<FactAction>();
  const [feedback, setFeedback] = useState<string>('');
  const [error, setError] = useState<string>();
  const editButton = useRef<HTMLButtonElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const headingId = `${id}-title`;

  const editing = draft !== undefined;
  useEffect(() => {
    if (editing) firstInput.current?.focus();
  }, [editing]);

  const run = async (name: FactAction, payload: FactEditPayload | { factId: string }) => {
    setPending(name);
    setError(undefined);
    setFeedback('');
    try {
      setFeedback(await onAction(name, payload));
      // Confirm/Reject hide the button that was pressed; keep keyboard focus inside the card.
      if (name !== 'editFact') requestAnimationFrame(() => editButton.current?.focus());
      return true;
    } catch (e) {
      setError(errorOf(e));
      return false;
    } finally {
      setPending(undefined);
    }
  };

  const closeEditor = () => {
    setDraft(undefined);
    requestAnimationFrame(() => editButton.current?.focus());
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const clean: FactEditPayload = {
      ...draft,
      subject: draft.subject.trim(),
      attribute: draft.attribute.trim(),
      value: draft.value.trim(),
      unit: draft.unit?.trim() || null,
      condition: draft.condition?.trim() || null,
    };
    void run('editFact', clean).then((ok) => ok && closeEditor());
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeEditor();
    }
  };

  const field = (key: DraftKey, label: string, required: boolean) => (
    <label className="field">
      <span className="field__label">
        {label}
        {required ? null : <span className="muted"> (optional)</span>}
      </span>
      <input
        ref={key === 'subject' ? firstInput : undefined}
        className="field__input"
        value={draft?.[key] ?? ''}
        required={required}
        onChange={(e) => setDraft((d) => (d ? { ...d, [key]: e.target.value } : d))}
      />
    </label>
  );

  const busy = pending !== undefined;
  const since = formatDate(fact.effectiveSince);

  return (
    <li className={`fact fact--${fact.status}`} aria-labelledby={headingId}>
      <div className="fact__top">
        <span className="fact__type">{TYPE_LABEL[fact.type]}</span>
        <span className={`badge badge--${fact.status}`}>{STATUS_LABEL[fact.status]}</span>
        {fact.edited ? <span className="badge">Edited</span> : null}
      </div>
      <h3 id={headingId} className="fact__title">
        {fact.subject}
        <span className="fact__attr"> · {fact.attribute}</span>
      </h3>
      <dl className="fact__grid">
        <dt>Value</dt>
        <dd className="fact__value">
          {fact.value}
          {fact.unit ? ` ${fact.unit}` : ''}
        </dd>
        {fact.condition ? (
          <>
            <dt>When</dt>
            <dd>{fact.condition}</dd>
          </>
        ) : null}
        {fact.previousValue ? (
          <>
            <dt>Was</dt>
            <dd className="fact__previous">{fact.previousValue}</dd>
          </>
        ) : null}
      </dl>
      <figure className="quote">
        <blockquote className="quote__text">{fact.quote}</blockquote>
        <figcaption className="quote__caption">
          From this page · version {fact.pageVersion}
          {since ? ` · since ${since}` : ''}
        </figcaption>
      </figure>

      {draft ? (
        <form className="fact__form" onSubmit={submit} onKeyDown={onKeyDown} aria-label={`Edit ${fact.subject} ${fact.attribute}`}>
          {field('subject', 'Subject', true)}
          {field('attribute', 'Attribute', true)}
          <div className="fact__form-row">
            {field('value', 'Value', true)}
            {field('unit', 'Unit', false)}
          </div>
          {field('condition', 'Condition', false)}
          <div className="actions">
            <button className="button button--primary" type="submit" disabled={busy}>
              {pending === 'editFact' ? 'Saving…' : 'Save'}
            </button>
            <button className="button button--subtle" type="button" disabled={busy} onClick={closeEditor}>
              Cancel
            </button>
          </div>
        </form>
      ) : canEdit ? (
        <div className="actions" role="group" aria-label={`Review ${fact.subject} ${fact.attribute}`}>
          {fact.status !== 'confirmed' ? (
            <button type="button" className="button button--primary" disabled={busy} onClick={() => void run('confirmFact', { factId: fact.id })}>
              {pending === 'confirmFact' ? 'Confirming…' : 'Confirm'}
            </button>
          ) : null}
          <button
            ref={editButton}
            type="button"
            className="button"
            disabled={busy}
            onClick={() => {
              setFeedback('');
              setDraft({ factId: fact.id, subject: fact.subject, attribute: fact.attribute, value: fact.value, unit: fact.unit, condition: fact.condition });
            }}
          >
            Edit
          </button>
          {fact.status !== 'rejected' ? (
            <button type="button" className="button button--subtle" disabled={busy} onClick={() => void run('rejectFact', { factId: fact.id })}>
              {pending === 'rejectFact' ? 'Rejecting…' : 'Reject'}
            </button>
          ) : null}
        </div>
      ) : null}

      <p className="fact__feedback" role="status">
        {feedback}
      </p>
      {error ? <Alert message={error} /> : null}
    </li>
  );
}
