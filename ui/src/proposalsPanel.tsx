import { useCallback, useEffect, useState } from 'react';
import type { ApproveAllResult, ProposalDecision, ProposalList, ProposalView } from '../../src/core/views';
import { call } from './bridge';
import { Alert, errorOf, LoadingRows } from './components';

const STATUS_LABEL: Record<ProposalView['status'], string> = {
  proposed: 'Waiting for approval',
  approved: 'Applying…',
  applied: 'Applied',
  rejected: 'Rejected',
  stale: 'Page changed, proposing again',
  needs_manual: 'Needs a manual edit',
  failed: 'Failed',
};

function ProposalItem({ p, canEdit, busy, onAction }: { p: ProposalView; canEdit: boolean; busy: boolean; onAction: (name: string, payload: Record<string, unknown>) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(p.newSentence ?? '');
  const open = p.status === 'proposed';
  return (
    <li className="proposal">
      <p>
        <strong>{STATUS_LABEL[p.status]}</strong>
        {p.errorCode ? <span className="muted"> ({p.errorCode})</span> : null}
        {p.sourceTitle ? <span className="muted"> · from {p.sourceTitle}</span> : null}
      </p>
      {p.oldSentence ? <p className="muted">Now: {p.oldSentence}</p> : null}
      {p.newSentence && !editing ? <p>Proposed: {p.newSentence}</p> : null}
      {editing ? (
        <label>
          Your sentence
          <textarea className="proposal__edit" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
        </label>
      ) : null}
      {canEdit && open ? (
        <div className="proposal__actions">
          <button type="button" className="button button--primary" disabled={busy} onClick={() => onAction('approveProposal', editing ? { proposalId: p.id, editedSentence: text } : { proposalId: p.id })}>
            {editing ? 'Apply my sentence' : 'Approve'}
          </button>
          <button type="button" className="button button--subtle" disabled={busy} onClick={() => setEditing(!editing)}>
            {editing ? 'Cancel edit' : 'Edit'}
          </button>
          <button type="button" className="button" disabled={busy} onClick={() => onAction('rejectProposal', { proposalId: p.id })}>
            Reject
          </button>
          <button type="button" className="button button--subtle" disabled={busy} onClick={() => onAction('markNotSameFact', { proposalId: p.id })}>
            Not the same fact
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** M4: edit proposals for this (copy) page. Minimal; shown when the byline reports pending proposals. */
export function ProposalsPanel({ onChanged }: { onChanged?: () => void }) {
  const [list, setList] = useState<ProposalList>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(undefined);
    call<ProposalList>('listProposalsForPage')
      .then(setList)
      .catch((e: unknown) => setError(errorOf(e)));
  }, []);
  useEffect(load, [load]);

  const act = async (name: string, payload?: Record<string, unknown>) => {
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    try {
      if (name === 'approveAll') {
        const r = await call<ApproveAllResult>('approveAll');
        setNotice(`Applied ${r.applied}, stale ${r.stale}, needs manual edit ${r.needsManual}, failed ${r.failed}.`);
      } else {
        const r = await call<ProposalDecision>(name, payload);
        setNotice(`${STATUS_LABEL[r.status]}${r.errorCode ? ` (${r.errorCode})` : ''}.`);
      }
      onChanged?.();
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(false);
      load();
    }
  };

  if (!list && !error) return <LoadingRows label="Loading proposed edits…" />;
  const open = list?.proposals.filter((p) => p.status === 'proposed').length ?? 0;
  return (
    <section className="proposals" aria-label="Proposed edits">
      <h2>Proposed edits</h2>
      {error ? <Alert message={error} onRetry={load} /> : null}
      {notice ? (
        <p role="status" className="muted">
          {notice}
        </p>
      ) : null}
      {list && list.proposals.length === 0 ? <p className="muted">No proposed edits for this page.</p> : null}
      {list && !list.canEdit && open > 0 ? <p className="muted">You need edit permission on this page to approve.</p> : null}
      {list && list.canEdit && open > 1 ? (
        <button type="button" className="button button--primary" disabled={busy} onClick={() => void act('approveAll')}>
          Approve all ({open})
        </button>
      ) : null}
      <ul className="proposals__list">
        {list?.proposals.map((p) => (
          <ProposalItem key={p.id} p={p} canEdit={list.canEdit} busy={busy} onAction={(name, payload) => void act(name, payload)} />
        ))}
      </ul>
    </section>
  );
}
