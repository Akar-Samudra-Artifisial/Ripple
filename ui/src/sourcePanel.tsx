import { useCallback, useEffect, useState } from 'react';
import type { FactActionResult, FactEditPayload, FactList, FactView, SourceStatus } from '../../src/core/views';
import { call } from './bridge';

const POLL_MS = 3000;
const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** M1 minimal source-of-truth panel: mark/unmark, extraction status (polled), fact review. Design polish later. */
export function SourcePanel() {
  const [status, setStatus] = useState<SourceStatus>();
  const [facts, setFacts] = useState<FactView[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const loadFacts = useCallback(async () => setFacts((await call<FactList>('listFacts')).facts), []);
  const load = useCallback(async () => {
    const s = await call<SourceStatus>('getSourceStatus');
    setStatus(s);
    if (s.source?.state === 'ready') await loadFacts();
    else if (!s.source) setFacts([]);
    return s;
  }, [loadFacts]);

  useEffect(() => {
    load().catch((e: unknown) => setError(errorOf(e)));
  }, [load]);

  const extracting = status?.source?.state === 'extracting';
  useEffect(() => {
    if (!extracting) return;
    const timer = setInterval(() => load().catch((e: unknown) => setError(errorOf(e))), POLL_MS);
    return () => clearInterval(timer);
  }, [extracting, load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(false);
    }
  };

  const replaceFact = (fact: FactView) => setFacts((list) => list.map((f) => (f.id === fact.id ? fact : f)));
  const act = (name: 'confirmFact' | 'rejectFact', factId: string) =>
    run(async () => {
      replaceFact((await call<FactActionResult>(name, { factId })).fact);
      setStatus(await call<SourceStatus>('getSourceStatus'));
    });
  const save = (payload: FactEditPayload) =>
    run(async () => {
      replaceFact((await call<FactActionResult>('editFact', { ...payload })).fact);
      setStatus(await call<SourceStatus>('getSourceStatus'));
    });

  if (!status) return error ? <p className="error">{error}</p> : <p className="muted">Loading source status…</p>;
  if (status.notice) return <p className="muted">{status.notice}</p>;
  const { source, counts, canEdit } = status;

  return (
    <section className="source">
      {error ? <p className="error">{error}</p> : null}
      {!source ? (
        <>
          <p>This page is not a source of truth.</p>
          {canEdit ? (
            <button className="button button--primary" disabled={busy} onClick={() => run(async () => setStatus(await call<SourceStatus>('markSource')))}>
              Mark as source of truth
            </button>
          ) : (
            <p className="muted">Only people who can edit this page can mark it.</p>
          )}
        </>
      ) : (
        <>
          <p>
            <strong>Source of truth</strong> · {counts.confirmed + counts.proposed} facts ({counts.confirmed} confirmed, {counts.proposed} to review)
            {source.pageVersion !== null ? ` · page version ${source.pageVersion}` : ''}
          </p>
          {source.state === 'extracting' ? <p className="muted">Reading facts from this page… (this can take a minute)</p> : null}
          {source.state === 'error' ? <p className="error">Extraction failed: {source.error}</p> : null}
          {canEdit ? (
            <p className="actions">
              <button className="button" disabled={busy || extracting} onClick={() => run(async () => setStatus(await call<SourceStatus>('markSource')))}>
                Extract again
              </button>
              <button className="button" disabled={busy} onClick={() => run(async () => setStatus(await call<SourceStatus>('unmarkSource')))}>
                Unmark
              </button>
            </p>
          ) : null}
          {source.state === 'ready' && facts.length === 0 ? <p className="muted">No facts found on this page.</p> : null}
          <ul className="facts">
            {facts.map((f) => (
              <FactItem key={f.id} fact={f} canEdit={canEdit} busy={busy} onConfirm={() => act('confirmFact', f.id)} onReject={() => act('rejectFact', f.id)} onSave={save} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

interface FactItemProps {
  fact: FactView;
  canEdit: boolean;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
  onSave: (payload: FactEditPayload) => Promise<void>;
}

function FactItem({ fact, canEdit, busy, onConfirm, onReject, onSave }: FactItemProps) {
  const [draft, setDraft] = useState<FactEditPayload>();
  const field = (key: 'subject' | 'attribute' | 'value' | 'unit' | 'condition', label: string) => (
    <label className="field">
      {label}
      <input value={draft?.[key] ?? ''} onChange={(e) => setDraft((d) => (d ? { ...d, [key]: e.target.value } : d))} />
    </label>
  );
  return (
    <li className={`fact fact--${fact.status}`}>
      <div>
        <strong>
          {fact.subject} · {fact.attribute}
        </strong>
        {fact.condition ? <span className="muted"> ({fact.condition})</span> : null}: {fact.value}
        {fact.unit ? ` ${fact.unit}` : ''} <span className="badge">{fact.status}</span>
        {fact.edited ? <span className="badge">edited</span> : null}
      </div>
      {fact.previousValue ? <div className="muted">Was: {fact.previousValue}</div> : null}
      <blockquote className="quote">“{fact.quote}”</blockquote>
      {draft ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSave(draft).then(() => setDraft(undefined));
          }}
        >
          {field('subject', 'Subject')}
          {field('attribute', 'Attribute')}
          {field('value', 'Value')}
          {field('unit', 'Unit')}
          {field('condition', 'Condition')}
          <p className="actions">
            <button className="button button--primary" type="submit" disabled={busy}>
              Save
            </button>
            <button className="button" type="button" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </p>
        </form>
      ) : canEdit ? (
        <p className="actions">
          {fact.status !== 'confirmed' ? (
            <button className="button" disabled={busy} onClick={onConfirm}>
              Confirm
            </button>
          ) : null}
          <button
            className="button"
            disabled={busy}
            onClick={() => setDraft({ factId: fact.id, subject: fact.subject, attribute: fact.attribute, value: fact.value, unit: fact.unit, condition: fact.condition })}
          >
            Edit
          </button>
          {fact.status !== 'rejected' ? (
            <button className="button" disabled={busy} onClick={onReject}>
              Reject
            </button>
          ) : null}
        </p>
      ) : null}
    </li>
  );
}
