import { router } from '@forge/bridge';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ApproveAllResult, ProposalDecision, ProposalList, ProposalView } from '../../src/core/views';
import { call } from './bridge';
import { Alert, LoadingRows, errorOf } from './components';
import { PROPOSAL_STATUS_LABEL, proposalProblem } from './proposalText';

type Action = 'approveProposal' | 'rejectProposal' | 'markNotSameFact';
const OPEN = (p: ProposalView) => p.status === 'proposed';

/** Splits `sentence` around the first case-insensitive occurrence of `value` so it can be highlighted. */
function splitAt(sentence: string, value: string | null): [string, string, string] | null {
  if (!value) return null;
  const i = sentence.toLowerCase().indexOf(value.toLowerCase());
  return i < 0 ? null : [sentence.slice(0, i), sentence.slice(i, i + value.length), sentence.slice(i + value.length)];
}

function Sentence({ text, value, kind }: { text: string; value: string | null; kind: 'old' | 'new' }) {
  const parts = splitAt(text, value);
  if (!parts) return <>{text}</>;
  const [before, hit, after] = parts;
  return (
    <>
      {before}
      {kind === 'old' ? (
        <del className="diff__old">
          <span className="sr-only">old value: </span>
          {hit}
        </del>
      ) : (
        <mark className="diff__new">
          <span className="sr-only">new value: </span>
          {hit}
        </mark>
      )}
      {after}
    </>
  );
}

/** Client-side check mirroring the backend rules that can be explained up front; the backend has the final say. */
function editProblem(text: string, p: ProposalView): string | null {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s === '') return 'Write the sentence as it should appear on the page.';
  if (/[\r\n]/.test(text)) return 'Keep it to one line.';
  if (/[<>]/.test(s)) return 'The sentence cannot contain < or >.';
  if (s.length > 2000) return 'Keep the sentence under 2,000 characters.';
  if (p.oldSentence && s.toLowerCase() === p.oldSentence.toLowerCase()) return 'This is the current sentence. Change it to state the new value.';
  if (p.newValue && !s.toLowerCase().includes(p.newValue.toLowerCase())) return `Include the new value (${p.newValue}).`;
  return null;
}

/**
 * M4 (FR-8) panel on a copy page: Ripple's suggested sentence edits with Approve / Edit / Reject / Not the same fact,
 * and Approve all. States: loading rows → error + retry | list. Each card shows its result (updated, declined,
 * needs manual edit, refreshing, failed); the last result is also announced in a live region.
 */
export function ProposalsPanel({ onChanged }: { onChanged?: () => void }) {
  const [list, setList] = useState<ProposalList>();
  const [loadError, setLoadError] = useState<string>();
  const [running, setRunning] = useState<string>();
  const [announce, setAnnounce] = useState('');
  const [bulk, setBulk] = useState<ApproveAllResult>();
  const [bulkError, setBulkError] = useState<string>();
  const [notSame, setNotSame] = useState<ReadonlySet<string>>(new Set());
  const headingId = useId();

  const load = useCallback(async () => {
    try {
      setList(await call<ProposalList>('listProposalsForPage'));
      setLoadError(undefined);
    } catch (e) {
      setLoadError(errorOf(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /** One action at a time across the panel (prevents double submits and racing page versions). */
  const act = useCallback(
    async (action: Action, payload: { proposalId: string; editedSentence?: string }): Promise<void> => {
      setRunning(payload.proposalId);
      setBulk(undefined);
      try {
        const r = await call<ProposalDecision>(action, payload);
        if (action === 'markNotSameFact') setNotSame((s) => new Set(s).add(r.proposalId));
        setAnnounce(r.status === 'applied' ? `Updated. Version ${r.version ?? ''} saved.` : `${PROPOSAL_STATUS_LABEL[r.status]}.`);
        await load();
        onChanged?.();
      } finally {
        setRunning(undefined);
      }
    },
    [load, onChanged],
  );

  const approveAll = async () => {
    setRunning('all');
    setBulkError(undefined);
    try {
      const r = await call<ApproveAllResult>('approveAll');
      setBulk(r);
      setAnnounce(r.applied > 0 ? `Updated ${r.applied} sentences. Version ${r.version ?? ''} saved.` : 'No sentence was updated.');
      await load();
      onChanged?.();
    } catch (e) {
      setBulkError(errorOf(e));
    } finally {
      setRunning(undefined);
    }
  };

  if (!list) {
    return (
      <section className="proposals" aria-label="Ripple suggests an update">
        {loadError ? <Alert message={`Could not load the suggestions: ${loadError}`} onRetry={() => void load()} /> : <LoadingRows label="Loading suggestions…" />}
      </section>
    );
  }

  const open = list.proposals.filter(OPEN);
  const ordered = [...open, ...list.proposals.filter((p) => !OPEN(p))];
  const busy = running !== undefined;

  return (
    <section className="proposals" aria-labelledby={headingId}>
      <header className="proposals__header">
        <h2 id={headingId} className="change__title">
          Ripple suggests an update
        </h2>
        <p className="muted source__meta">
          {open.length > 0
            ? `${open.length} ${open.length === 1 ? 'sentence on this page states' : 'sentences on this page state'} an old value from a source of truth.`
            : 'No suggestions are waiting.'}
        </p>
      </header>

      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {loadError ? <Alert message={`Could not refresh the suggestions: ${loadError}`} onRetry={() => void load()} /> : null}

      {!list.canEdit && open.length > 0 ? <p className="muted">Only people who can edit this page can approve.</p> : null}

      {list.canEdit && open.length > 1 ? (
        <div className="proposals__bulk">
          <button type="button" className="button button--primary" disabled={busy} aria-busy={running === 'all'} onClick={() => void approveAll()}>
            {running === 'all' ? 'Updating…' : `Approve all (${open.length})`}
          </button>
          <span className="muted source__meta">One new page version with every change.</span>
        </div>
      ) : null}
      {bulkError ? <Alert message={bulkError} /> : null}
      {bulk ? <BulkResult result={bulk} /> : null}

      {ordered.length === 0 ? <p className="empty">No suggestions for this page.</p> : null}
      <ul className="proposals__list">
        {ordered.map((p) => (
          <ProposalCard key={p.id} p={p} canEdit={list.canEdit} busy={busy} running={running === p.id} notSame={notSame.has(p.id)} onAction={act} />
        ))}
      </ul>

      {list.canEdit && open.length > 0 ? <p className="muted source__meta">Ripple will save a new page version as you, labelled Updated by Ripple.</p> : null}
    </section>
  );
}

function ReloadButton() {
  return (
    <button type="button" className="button" onClick={() => void router.reload().catch(() => undefined)}>
      Reload page
    </button>
  );
}

function BulkResult({ result }: { result: ApproveAllResult }) {
  const rest = [
    result.stale > 0 ? `${result.stale} being refreshed because the page changed` : '',
    result.needsManual > 0 ? `${result.needsManual} need a manual edit` : '',
    result.failed > 0 ? `${result.failed} failed` : '',
  ].filter(Boolean);
  return (
    <div className={`result ${result.applied > 0 ? 'result--success' : 'result--warning'}`}>
      <p className="result__title">{result.applied > 0 ? `Updated ${result.applied} ${result.applied === 1 ? 'sentence' : 'sentences'}. Version ${result.version ?? '?'} saved.` : 'No sentence was updated.'}</p>
      {rest.length > 0 ? <p className="muted">{rest.join(' · ')}.</p> : null}
      {result.applied > 0 ? <ReloadButton /> : null}
    </div>
  );
}

interface CardProps {
  p: ProposalView;
  canEdit: boolean;
  busy: boolean;
  running: boolean;
  notSame: boolean;
  onAction: (action: Action, payload: { proposalId: string; editedSentence?: string }) => Promise<void>;
}

function ProposalCard({ p, canEdit, busy, running, notSame, onAction }: CardProps) {
  const [draft, setDraft] = useState<string>();
  const [pendingAction, setPendingAction] = useState<Action>();
  const [error, setError] = useState<string>();
  const [hint, setHint] = useState<string>();
  const result = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const open = OPEN(p);
  const wasOpen = useRef(open);

  // When the card leaves `proposed` its buttons disappear: move focus to the result instead of losing it.
  useEffect(() => {
    if (wasOpen.current && !open) result.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const editing = draft !== undefined;
  useEffect(() => {
    if (editing) textarea.current?.focus();
  }, [editing]);

  const run = async (action: Action, editedSentence?: string) => {
    setPendingAction(action);
    setError(undefined);
    try {
      await onAction(action, editedSentence === undefined ? { proposalId: p.id } : { proposalId: p.id, editedSentence });
      setDraft(undefined);
    } catch (e) {
      const message = errorOf(e);
      setError(editedSentence !== undefined ? `Ripple can't use this sentence. ${message}` : message);
    } finally {
      setPendingAction(undefined);
    }
  };

  const closeEdit = () => {
    setDraft(undefined);
    setHint(undefined);
    requestAnimationFrame(() => editButton.current?.focus());
  };

  const submitEdit = (e: FormEvent) => {
    e.preventDefault();
    if (draft === undefined) return;
    const problem = editProblem(draft, p);
    setHint(problem ?? undefined);
    if (!problem) void run('approveProposal', draft.replace(/\s+/g, ' ').trim());
  };

  const label = (a: Action, idle: string, active: string) => (running && pendingAction === a ? active : idle);

  return (
    <li className={`proposal proposal--${p.status}`}>
      <div className="fact__top">
        <span className="fact__type">
          {p.sourceTitle ? (
            <>
              From{' '}
              <a
                className="copy__link"
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  void router.open({ target: 'contentView', contentId: p.sourcePageId });
                }}
              >
                {p.sourceTitle}
                <span className="sr-only"> (source of truth, opens in a new tab)</span>
              </a>
            </>
          ) : (
            'From a source of truth you can’t view'
          )}
        </span>
        <span className={`badge badge--proposal-${p.status}`}>{notSame ? 'Not the same fact' : PROPOSAL_STATUS_LABEL[p.status]}</span>
      </div>

      {p.oldValue || p.newValue ? (
        <p className="change__values proposal__values">
          {p.oldValue ? (
            <del className="change__old">
              <span className="sr-only">Old value: </span>
              {p.oldValue}
            </del>
          ) : null}
          <span aria-hidden="true" className="change__arrow">
            →
          </span>
          {p.newValue ? (
            <ins className="change__new">
              <span className="sr-only">New value: </span>
              {p.newValue}
            </ins>
          ) : null}
        </p>
      ) : null}

      <div className="diff">
        {p.oldSentence ? (
          <div className="diff__row diff__row--old">
            <span className="diff__label">On this page</span>
            <blockquote className="quote__text">
              <Sentence text={p.oldSentence} value={p.oldValue} kind="old" />
            </blockquote>
          </div>
        ) : null}
        {p.newSentence && !editing ? (
          <div className="diff__row diff__row--new">
            <span className="diff__label">Suggested</span>
            <blockquote className="quote__text">
              <Sentence text={p.newSentence} value={p.newValue} kind="new" />
            </blockquote>
          </div>
        ) : null}
      </div>

      {editing ? (
        <form
          className="proposal__form"
          onSubmit={submitEdit}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            closeEdit();
          }}
        >
          <label className="field" htmlFor={`${id}-text`}>
            <span className="field__label">Your sentence</span>
            <textarea
              id={`${id}-text`}
              ref={textarea}
              className="field__input proposal__textarea"
              value={draft}
              maxLength={2000}
              aria-describedby={`${id}-help`}
              aria-invalid={hint ? true : undefined}
              onChange={(e) => {
                setDraft(e.target.value);
                setHint(undefined);
              }}
            />
          </label>
          <p id={`${id}-help`} className={hint ? 'field__error' : 'muted source__meta'}>
            {hint ?? `State the new value${p.newValue ? ` (${p.newValue})` : ''} and not the old one.`}
          </p>
          <div className="actions">
            <button type="submit" className="button button--primary" disabled={busy}>
              {label('approveProposal', 'Approve my sentence', 'Updating…')}
            </button>
            <button
              type="button"
              className="button button--subtle"
              disabled={busy}
              onClick={closeEdit}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {open && canEdit && !editing ? (
        <div className="actions" role="group" aria-label="Decide on this suggestion">
          <button type="button" className="button button--primary" disabled={busy || !p.newSentence} onClick={() => void run('approveProposal')}>
            {label('approveProposal', 'Approve', 'Updating…')}
          </button>
          <button ref={editButton} type="button" className="button" disabled={busy} onClick={() => setDraft(p.newSentence ?? p.oldSentence ?? '')}>
            Edit
          </button>
          <button type="button" className="button button--subtle" disabled={busy} onClick={() => void run('rejectProposal')}>
            {label('rejectProposal', 'Reject', 'Rejecting…')}
          </button>
          <button type="button" className="button button--subtle" disabled={busy} onClick={() => void run('markNotSameFact')}>
            {label('markNotSameFact', 'Not the same fact', 'Saving…')}
          </button>
        </div>
      ) : null}

      {error ? <Alert message={error} /> : null}

      <div ref={result} tabIndex={-1} className="proposal__result">
        <Outcome p={p} notSame={notSame} />
      </div>
    </li>
  );
}

function Outcome({ p, notSame }: { p: ProposalView; notSame: boolean }) {
  const [copied, setCopied] = useState<'yes' | 'no'>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(p.newSentence ?? '');
      setCopied('yes');
    } catch {
      setCopied('no');
    }
  };
  switch (p.status) {
    case 'applied':
      return (
        <div className="result result--success">
          <p className="result__title">Updated. Version {p.appliedVersion ?? '?'} saved.</p>
          <p className="muted">Reload the page to see the new sentence.</p>
          <ReloadButton />
        </div>
      );
    case 'approved':
      return <p className="muted">Applying the edit…</p>;
    case 'rejected':
      return <p className="muted">{notSame ? 'Marked as not the same fact. Ripple will leave this sentence alone.' : 'Declined. The page stays as it is.'}</p>;
    case 'stale':
      return (
        <div className="result result--info">
          <p className="result__title">The page changed since this suggestion was made.</p>
          <p className="muted">A fresh suggestion is being prepared.</p>
        </div>
      );
    case 'needs_manual':
      return (
        <div className="result result--warning">
          <p className="result__title">Ripple couldn't edit this sentence safely</p>
          <p className="muted">{proposalProblem(p.status, p.errorCode)} Edit the page yourself with the new sentence.</p>
          {p.newSentence ? (
            <>
              <div className="actions">
                <button type="button" className="button" onClick={() => void copy()}>
                  Copy new sentence
                </button>
              </div>
              {copied === 'yes' ? <p className="ok source__meta">Copied.</p> : null}
              {copied === 'no' ? (
                <label className="field">
                  <span className="field__label">Copying is blocked here. Select the sentence and copy it:</span>
                  <textarea className="field__input proposal__textarea" readOnly value={p.newSentence} onFocus={(e) => e.currentTarget.select()} />
                </label>
              ) : null}
            </>
          ) : null}
        </div>
      );
    case 'failed':
      return (
        <div className="result result--danger">
          <p className="result__title">Ripple could not update this sentence.</p>
          <p className="muted">{proposalProblem(p.status, p.errorCode)}</p>
        </div>
      );
    default:
      return null;
  }
}
