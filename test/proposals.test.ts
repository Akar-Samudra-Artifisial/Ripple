import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: (s: TemplateStringsArray) => s.join('') }));
vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: {} }));
vi.mock('@forge/llm', () => ({ chat: vi.fn(), ForgeLlmError: class extends Error {} }));
vi.mock('@forge/events', () => ({
  Queue: class {
    push = vi.fn();
  },
  InvocationError: class {
    constructor(readonly options: unknown) {}
  },
  InvocationErrorCode: { FUNCTION_UPSTREAM_RATE_LIMITED: 'FUNCTION_UPSTREAM_RATE_LIMITED' },
}));

import type { Message } from '@forge/llm';
import type { ChangeRow, CopyForChange } from '../src/adapters/changeRepo';
import type { SourcePage, UserPage, UserResult } from '../src/adapters/confluence';
import type { CopyForProposal, ProposalDraft, ProposalRepo, ProposalRow } from '../src/adapters/proposalRepo';
import type { FactChange } from '../src/core/changes';
import { replaceValueToken, validateRewrite, type ProposalStatus } from '../src/core/proposals';
import type { ApproveAllResult, ErrorReply, ProposalDecision, ProposalList, Rollout, SourceView } from '../src/core/views';
import type { ChatToolFn } from '../src/llm/extract';
import type { ToolSpec } from '../src/llm/index';
import type { FactRepo } from '../src/adapters/repo';

type FactWithSource = NonNullable<Awaited<ReturnType<FactRepo['getFact']>>>;
import { handlePageUpdate } from '../src/surfaces/changes';
import {
  approveAll,
  approveProposal,
  listProposalsForPage,
  listRollout,
  markNotSameFact,
  rejectProposal,
  runProposeJob,
  versionMessage,
  type ProposalDeps,
  type ProposeDeps,
} from '../src/surfaces/proposals';

const SOURCE = '9600001';
const PAGE_A = '9700001';
const PAGE_B = '9700002';
const CHANGE_ID = '11111111-1111-4111-8111-111111111111';
const FACT = 'f-1-domestic';
const cid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const S1 = 'Domestic trips get a per diem of $60 per day.';
const S2 = 'Meals on domestic trips are capped at $60 a day.';
const S3 = 'The daily allowance at home is sixty dollars.';
const S4 = 'Our home travel allowance is sixty USD.';

const FC: FactChange = {
  factId: FACT,
  oldValue: '$60',
  oldUnit: 'per day',
  newValue: '$75',
  newUnit: 'per day',
  newQuote: 'Domestic travel: the per diem is $75 per day.',
  version: 5,
  versionAt: null,
} as FactChange;

interface Copy extends CopyForProposal {
  pageTitle: string;
}

/** In-memory `ProposalRepo` with the status guards of `sqlProposalRepo`. */
class Store {
  proposals: ProposalRow[] = [];
  audits: { action: string; actor: string | null; detail?: Record<string, unknown> }[] = [];
  copies: Copy[] = [
    { id: cid(1), factId: FACT, sourcePageId: SOURCE, pageId: PAGE_A, status: 'drifted', statedValue: '$60', statedUnit: null, quote: S1, pageTitle: 'Onboarding' },
    { id: cid(2), factId: FACT, sourcePageId: SOURCE, pageId: PAGE_A, status: 'drifted', statedValue: '$60', statedUnit: null, quote: S2, pageTitle: 'Onboarding' },
    { id: cid(3), factId: FACT, sourcePageId: SOURCE, pageId: PAGE_B, status: 'drifted', statedValue: 'sixty dollars', statedUnit: null, quote: S3, pageTitle: 'Handbook' },
    { id: cid(4), factId: FACT, sourcePageId: SOURCE, pageId: PAGE_B, status: 'drifted', statedValue: 'sixty USD', statedUnit: null, quote: S4, pageTitle: 'Handbook' },
  ];
  pages = new Map<string, { title: string; version: number; body: string }>([
    [PAGE_A, { title: 'Onboarding', version: 7, body: `<h1>Welcome</h1><p>${S1}</p><p>Meals on <strong>domestic</strong> trips are capped at &#36;60&nbsp;a day.</p>` }],
    [PAGE_B, { title: 'Handbook', version: 2, body: `<p>${S3}</p><p>${S4}</p>` }],
  ]);
  change: ChangeRow = {
    id: CHANGE_ID,
    sourcePageId: SOURCE,
    status: 'confirmed',
    pageVersion: 5,
    factChanges: [FC],
    missingFactIds: [],
    impact: {
      copies: this.copies.map((c) => ({ copyId: c.id, factId: FACT, pageId: c.pageId, spaceId: 'S', status: 'drifted' })),
      alreadyNew: 0,
      syncCopyIds: [],
      unsure: 0,
      historical: 0,
      needsCheck: 0,
    },
    routing: null,
    deadlineDays: 5,
    createdAt: null,
  };
  puts: { pageId: string; title: string; body: string; version: number; message: string }[] = [];
  enqueued: { changeId: string; copyPageId?: string; delaySeconds?: number }[] = [];
  /** Current official value of FACT (a newer confirmed change moves it on). */
  fact = { value: '$75', unit: 'per day' as string | null, status: 'confirmed' as 'confirmed' | 'rejected' };
  sourceOpen = true;
  requeues = new Map<string, { delayed: boolean; recent: boolean }>();
  putStatus: number | null = null;
  private n = 0;

  repo(): ProposalRepo {
    const find = (id: string) => this.proposals.find((p) => p.id === id);
    return {
      copiesByIds: async (ids) => this.copies.filter((c) => ids.includes(c.id)).map(({ pageTitle: _t, ...c }) => ({ ...c })),
      byChangeCopy: async (changeId, copyId) => this.proposals.find((p) => p.changeId === changeId && p.copyId === copyId),
      saveDraft: async (d: ProposalDraft) => {
        const existing = this.proposals.find((p) => p.changeId === d.changeId && p.copyId === d.copyId);
        if (existing) {
          if (existing.status !== 'stale') return { id: existing.id, written: false, created: false };
          Object.assign(existing, { ...d, appliedVersion: null, appliedBy: null });
          return { id: existing.id, written: true, created: false };
        }
        const id = `aaaaaaaa-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
        this.proposals.push({ id, ...d, appliedVersion: null, appliedBy: null });
        return { id, written: true, created: true };
      },
      get: async (id) => {
        const p = find(id);
        return p ? { ...p } : undefined;
      },
      listForPage: async (pageId) => this.proposals.filter((p) => p.pageId === pageId).map((p) => ({ ...p })),
      listForChange: async (changeId) => this.proposals.filter((p) => p.changeId === changeId).map((p) => ({ ...p })),
      pendingCount: async (pageId) => this.proposals.filter((p) => p.pageId === pageId && p.status === 'proposed').length,
      lock: async (id) => {
        const p = find(id);
        if (!p || p.status !== 'proposed') return false;
        p.status = 'approved';
        return true;
      },
      setStatus: async (id, from, to, errorCode = null) => {
        const p = find(id);
        if (!p || !from.includes(p.status)) return false;
        p.status = to;
        p.errorCode = errorCode;
        return true;
      },
      markApplied: async (id, version, actor, sentence) => {
        const p = find(id);
        if (!p || p.status !== 'approved') return false;
        Object.assign(p, { status: 'applied', appliedVersion: version, appliedBy: actor, newSentence: sentence, errorCode: null });
        return true;
      },
      rebase: async (ids, from, to) => {
        let k = 0;
        for (const p of this.proposals) if (ids.includes(p.id) && p.status === 'proposed' && p.pageVersion === from) (p.pageVersion = to), k++;
        return k;
      },
      markCopyUpdated: async (copyId, value, unit, sentence, version) => {
        const c = this.copies.find((x) => x.id === copyId);
        if (!c || (c.status !== 'drifted' && c.status !== 'in_sync')) return false;
        Object.assign(c, { status: 'updated', statedValue: value, statedUnit: unit, quote: sentence, version });
        return true;
      },
      ignoreCopy: async (copyId) => {
        const c = this.copies.find((x) => x.id === copyId);
        if (!c) return false;
        c.status = 'ignored';
        return true;
      },
      supersedeOlder: async (sourcePageId, changeId, factIds) => {
        let k = 0;
        for (const p of this.proposals)
          if (p.sourcePageId === sourcePageId && p.changeId !== changeId && factIds.includes(p.factId) && ['proposed', 'stale', 'needs_manual'].includes(p.status)) {
            Object.assign(p, { status: 'rejected', errorCode: 'superseded' });
            k++;
          }
        return k;
      },
      claimRequeue: async (changeId, pageId) => {
        const key = `${changeId}:${pageId}`;
        const row = this.requeues.get(key);
        if (!row || !row.recent) {
          this.requeues.set(key, { delayed: false, recent: true });
          return 'now';
        }
        if (!row.delayed) {
          row.delayed = true;
          return 'delayed';
        }
        return 'skip';
      },
    };
  }

  facts() {
    return {
      audit: async (action: string, actor: string | null, _t: string, _id: string, detail?: Record<string, unknown>) => {
        this.audits.push({ action, actor, detail });
      },
      getSource: async (id: string): Promise<SourceView | undefined> =>
        id === SOURCE ? { pageId: SOURCE, title: 'Travel Policy', state: 'ready', pageVersion: 5, markedAt: 'now', extractedAt: 'now', error: null } : undefined,
      getFact: async (id: string) =>
        id === FACT ? ({ id, subject: 'Domestic per diem', attribute: 'amount', ...this.fact, sourcePageId: SOURCE, identityKey: 'k' } as unknown as FactWithSource) : undefined,
    };
  }

  changes() {
    return {
      getChange: async (id: string) => (id === this.change.id ? this.change : undefined),
      copiesForFacts: async (): Promise<CopyForChange[]> =>
        this.copies.map((c) => ({ id: c.id, factId: c.factId, pageId: c.pageId, pageTitle: c.pageTitle, pageUrl: `/p/${c.pageId}`, status: c.status, statedValue: c.statedValue, statedUnit: c.statedUnit })),
    };
  }
}

let store: Store;

/** Model answers per sentence (S3/S4 are words, so the number swap does not apply). */
function llm(answers: Record<string, string>): ChatToolFn & { calls: number } {
  const fn = (async <T,>(messages: Message[], tool: ToolSpec) => {
    fn.calls++;
    expect(tool.name).toBe('rewrite_sentence');
    const content = String(messages[1]?.content);
    const key = Object.keys(answers).find((s) => content.includes(s));
    return { args: { sentence: key ? answers[key] : '' } as T, model: 'm' };
  }) as ChatToolFn & { calls: number };
  fn.calls = 0;
  return fn;
}

const GOOD_LLM = { [S3]: 'The daily allowance at home is 75 dollars.', [S4]: 'Our whole travel allowance is 75 USD.' };

function proposeDeps(model: ChatToolFn = llm(GOOD_LLM)): ProposeDeps {
  return {
    changes: store.changes(),
    proposals: store.repo(),
    facts: store.facts(),
    page: async (pageId): Promise<SourcePage> => {
      const p = store.pages.get(pageId);
      if (!p) throw new Error('no page');
      return { id: pageId, title: p.title, spaceId: 'S', version: p.version, versionCreatedAt: null, body: p.body };
    },
    llm: model,
    ensure: async () => undefined,
  };
}

function deps(over: Partial<ProposalDeps> = {}): ProposalDeps {
  return {
    proposals: store.repo(),
    changes: store.changes(),
    facts: store.facts(),
    canEdit: async () => true,
    visible: async (ids) => new Set(ids),
    getPage: async (pageId): Promise<UserResult<UserPage>> => {
      const p = store.pages.get(pageId);
      return p ? { ok: true, value: { ...p } } : { ok: false, status: 404 };
    },
    updatePage: async (pageId, page): Promise<UserResult<number>> => {
      if (store.putStatus !== null) return { ok: false, status: store.putStatus };
      store.puts.push({ pageId, ...page });
      const p = store.pages.get(pageId);
      if (p) Object.assign(p, { body: page.body, version: page.version });
      return { ok: true, value: page.version };
    },
    enqueuePropose: async (_s, changeId, target) => {
      store.enqueued.push({ changeId, ...target });
      return 'job';
    },
    sourceIsOpen: async () => store.sourceOpen,
    names: async (ids) => new Map(ids.map((id) => [id, `Name of ${id}`])),
    ensure: async () => undefined,
    ...over,
  };
}

const ctx = (pageId: string, accountId = 'acc-1') => ({ accountId, extension: { content: { id: pageId } } });
const byCopy = (n: number) => store.proposals.find((p) => p.copyId === cid(n)) as ProposalRow;
const isError = (r: unknown): r is ErrorReply => typeof r === 'object' && r !== null && 'error' in r;

beforeEach(() => {
  store = new Store();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('replaceValueToken / validateRewrite', () => {
  const o = { value: '$60', unit: null };
  const n = { value: '$75', unit: 'per day' };
  it('swaps the one number in its own style, else leaves it to the model', () => {
    expect(replaceValueToken(S1, o, n)).toBe('Domestic trips get a per diem of $75 per day.');
    expect(replaceValueToken('Trips over $2,000 need approval.', { value: '$2,000', unit: null }, { value: '$2500', unit: null })).toBe('Trips over $2,500 need approval.');
    expect(replaceValueToken(S3, { value: 'sixty dollars', unit: null }, n)).toBeUndefined();
    expect(replaceValueToken('Pay $60 within 60 days.', o, n)).toBeUndefined();
    expect(replaceValueToken(S1, o, { value: '€75', unit: null })).toBeUndefined();
  });
  it('accepts only the value change (strict) or any sentence with the new value and without the old one (user)', () => {
    expect(validateRewrite(S3, GOOD_LLM[S3] as string, { value: 'sixty dollars', unit: null }, n, true)).toBe(true);
    expect(validateRewrite(S4, GOOD_LLM[S4] as string, { value: 'sixty USD', unit: null }, n, true)).toBe(false);
    expect(validateRewrite(S1, 'Domestic trips get a per diem of $60 or $75 per day.', o, n, true)).toBe(false);
    // Rehearsal: the judge stated the copy's value as "$60 per day" (rate inside the value) → the token swap is valid.
    const d9 = 'No. Meals on domestic trips are covered by the per diem of $60 per day.';
    const d9New = 'No. Meals on domestic trips are covered by the per diem of $75 per day.';
    for (const stated of [{ value: '$60 per day', unit: null }, { value: '$60 per day', unit: 'per day' }, { value: '$60', unit: 'per day' }]) {
      expect(replaceValueToken(d9, stated, n)).toBe(d9New);
      expect(validateRewrite(d9, d9New, stated, n, true)).toBe(true);
      expect(validateRewrite(d9, 'No. Meals on international trips are covered by the per diem of $75 per day.', stated, n, true)).toBe(false);
      expect(validateRewrite(d9, 'Yes. Meals on domestic trips are covered by the per diem of $75 per day.', stated, n, true)).toBe(false);
      // A model rewrite that changes any other word ("per" → "each", "covered" → "paid") is still rejected.
      expect(validateRewrite(d9, 'No. Meals on domestic trips are covered by the per diem of $75 each day.', stated, n, true)).toBe(false);
      expect(validateRewrite(d9, 'No. Meals on domestic trips are paid by the per diem of $75 per day.', stated, n, true)).toBe(false);
    }
    expect(validateRewrite(S1, 'Domestic trips do not get a per diem of $75 per day.', o, n, true)).toBe(false);
    expect(validateRewrite(S1, 'From May, domestic trips pay $75 daily.', o, n, false)).toBe(true);
    expect(validateRewrite(S1, 'From May, domestic trips pay $60 daily.', o, n, false)).toBe(false);
    expect(validateRewrite(S1, 'Pay <b>$75</b>.', o, n, false)).toBe(false);
  });
});

describe('runProposeJob', () => {
  it('proposes per copy: token swap, model fallback, failed validation, idempotent on redelivery', async () => {
    const model = llm(GOOD_LLM);
    const r = await runProposeJob(CHANGE_ID, undefined, 0, proposeDeps(model));
    expect(r).toEqual({ status: 'done', created: 4, proposed: 3, needsManual: 0, failed: 1, skipped: 0 });
    expect(byCopy(1)).toMatchObject({ status: 'proposed', method: 'token', newSentence: 'Domestic trips get a per diem of $75 per day.', pageVersion: 7, oldValue: '$60', newValue: '$75 per day' });
    expect(byCopy(2)).toMatchObject({ status: 'proposed', method: 'token', newSentence: 'Meals on domestic trips are capped at $75 a day.' });
    expect(byCopy(3)).toMatchObject({ status: 'proposed', method: 'llm', newSentence: GOOD_LLM[S3] });
    // The model also changed "home" → "whole": refused.
    expect(byCopy(4)).toMatchObject({ status: 'failed', method: 'llm', errorCode: 'validation_failed', newSentence: null });
    expect(model.calls).toBe(2);
    expect(store.audits.map((a) => a.action).sort()).toEqual(['proposal.created', 'proposal.created', 'proposal.created', 'proposal.failed']);
    // Logs carry ids and counts only.
    expect(JSON.stringify((console.info as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('$75');

    const again = await runProposeJob(CHANGE_ID, undefined, 0, proposeDeps(model));
    expect(again).toMatchObject({ status: 'done', created: 0, skipped: 4 });
    expect(store.proposals).toHaveLength(4);
    expect(model.calls).toBe(2);
  });

  it('M5: a full run creates the change issues afterwards; a re-propose of one page does not', async () => {
    const issued: string[] = [];
    const base = proposeDeps();
    const d = {
      ...base,
      changes: { ...base.changes, markProposed: async (id: string) => void issued.push(`marked ${id}`) },
      createIssues: async (id: string) => void issued.push(id),
    };
    await runProposeJob(CHANGE_ID, undefined, 0, d);
    await runProposeJob(CHANGE_ID, { copyPageId: PAGE_A }, 0, d);
    await runProposeJob(CHANGE_ID, cid(1), 0, d);
    // The run is marked finished before the issues are created (the heal waits for the mark); scoped runs do neither.
    expect(issued).toEqual([`marked ${CHANGE_ID}`, CHANGE_ID]);
  });

  it('needs a manual edit when the sentence is gone, split by markup or the change is not confirmed', async () => {
    store.pages.set(PAGE_A, { title: 'Onboarding', version: 7, body: `<p>Domestic trips get a per diem of $<em>6</em>0 per day.</p><p>${S2}</p><p>${S2}</p>` });
    store.copies[0] = { ...(store.copies[0] as Copy), quote: S1 };
    await runProposeJob(CHANGE_ID, undefined, 0, proposeDeps());
    expect(byCopy(1)).toMatchObject({ status: 'needs_manual', errorCode: 'crosses_markup' });
    expect(byCopy(2)).toMatchObject({ status: 'needs_manual', errorCode: 'sentence_ambiguous' });
    store.change.status = 'pending';
    expect(await runProposeJob(CHANGE_ID, undefined, 0, proposeDeps())).toEqual({ status: 'skipped', reason: 'change not confirmed' });
  });
});

describe('proposal resolvers', () => {
  beforeEach(async () => {
    await runProposeJob(CHANGE_ID, undefined, 0, proposeDeps());
  });

  it('approve applies the edit as the user with the Ripple version message; the copy is updated', async () => {
    const r = (await approveProposal(ctx(PAGE_A), { proposalId: byCopy(1).id }, deps())) as ProposalDecision;
    expect(r).toEqual({ proposalId: byCopy(1).id, status: 'applied', errorCode: null, version: 8 });
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]).toMatchObject({ pageId: PAGE_A, title: 'Onboarding', version: 8, message: 'Updated by Ripple from Travel Policy' });
    expect(store.puts[0]?.body).toBe('<h1>Welcome</h1><p>Domestic trips get a per diem of $75 per day.</p><p>Meals on <strong>domestic</strong> trips are capped at &#36;60&nbsp;a day.</p>');
    expect(byCopy(1)).toMatchObject({ status: 'applied', appliedVersion: 8, appliedBy: 'acc-1' });
    expect(store.copies[0]).toMatchObject({ status: 'updated', statedValue: '$75', quote: 'Domestic trips get a per diem of $75 per day.' });
    expect(store.audits.at(-1)).toMatchObject({ action: 'proposal.applied', actor: 'acc-1' });
    // The other proposal of the page follows to the saved version (its sentence is untouched).
    expect(byCopy(2)).toMatchObject({ status: 'proposed', pageVersion: 8 });
    const second = (await approveProposal(ctx(PAGE_A), { proposalId: byCopy(2).id }, deps())) as ProposalDecision;
    expect(second.status).toBe('applied');
    expect(store.pages.get(PAGE_A)?.body).toContain('capped at &#36;75&nbsp;a day');
  });

  it('a double approve applies once', async () => {
    const id = byCopy(1).id;
    const [a, b] = await Promise.all([approveProposal(ctx(PAGE_A), { proposalId: id }, deps()), approveProposal(ctx(PAGE_A), { proposalId: id }, deps())]);
    expect(store.puts).toHaveLength(1);
    expect([(a as ProposalDecision).status, (b as ProposalDecision).status].sort()).toEqual(['applied', 'approved']);
    const c = (await approveProposal(ctx(PAGE_A), { proposalId: id }, deps())) as ProposalDecision;
    expect(c).toMatchObject({ status: 'applied', version: 8 });
    expect(store.puts).toHaveLength(1);
  });

  it('a page saved by someone else makes the proposal stale and proposes it again; 409 too', async () => {
    const page = store.pages.get(PAGE_A);
    if (page) page.version = 9;
    const r = (await approveProposal(ctx(PAGE_A), { proposalId: byCopy(1).id }, deps())) as ProposalDecision;
    expect(r).toMatchObject({ status: 'stale', errorCode: 'version_changed' });
    expect(store.puts).toHaveLength(0);
    expect(store.enqueued).toEqual([{ changeId: CHANGE_ID, copyPageId: PAGE_A }]);
    expect(store.audits.at(-1)?.action).toBe('proposal.stale');
    // Re-proposed from the new version: the stale row is refreshed.
    await runProposeJob(CHANGE_ID, { copyPageId: PAGE_A }, 0, proposeDeps());
    expect(byCopy(1)).toMatchObject({ status: 'proposed', pageVersion: 9 });

    store.putStatus = 409;
    const conflict = (await approveProposal(ctx(PAGE_A), { proposalId: byCopy(1).id }, deps())) as ProposalDecision;
    expect(conflict).toMatchObject({ status: 'stale', errorCode: 'conflict' });
    // Copy 2 was read at version 7: stale as well.
    expect(await approveProposal(ctx(PAGE_A), { proposalId: byCopy(2).id }, deps())).toMatchObject({ status: 'stale', errorCode: 'version_changed' });
    await runProposeJob(CHANGE_ID, cid(1), 0, proposeDeps());
    store.putStatus = 403;
    const forbidden = (await approveProposal(ctx(PAGE_A), { proposalId: byCopy(1).id }, deps())) as ProposalDecision;
    expect(forbidden).toMatchObject({ status: 'failed', errorCode: 'forbidden' });
  });

  it('reject and not-the-same-fact', async () => {
    expect(await rejectProposal(ctx(PAGE_A), { proposalId: byCopy(1).id }, deps())).toMatchObject({ status: 'rejected' });
    expect(store.copies[0]?.status).toBe('drifted');
    expect(await markNotSameFact(ctx(PAGE_A), { proposalId: byCopy(2).id }, deps())).toMatchObject({ status: 'rejected' });
    expect(store.copies[1]?.status).toBe('ignored');
    expect(store.audits.at(-1)).toMatchObject({ action: 'proposal.rejected', detail: { reason: 'not_same_fact' } });
    // Rejected proposals cannot be approved.
    expect(await approveProposal(ctx(PAGE_A), { proposalId: byCopy(1).id }, deps())).toMatchObject({ status: 'rejected' });
    expect(store.puts).toHaveLength(0);
  });

  it('applies an edited sentence after validating it', async () => {
    const bad = await approveProposal(ctx(PAGE_A), { proposalId: byCopy(1).id, editedSentence: 'Domestic trips get $60 per day.' }, deps());
    expect(isError(bad)).toBe(true);
    const own = 'Domestic trips get a per diem of USD 75 per calendar day.';
    const r = (await approveProposal(ctx(PAGE_A), { proposalId: byCopy(1).id, editedSentence: own }, deps())) as ProposalDecision;
    expect(r.status).toBe('applied');
    expect(store.pages.get(PAGE_A)?.body).toContain(`<p>${own}</p>`);
    expect(byCopy(1).newSentence).toBe(own);
    expect(store.audits.map((a) => a.action)).toContain('proposal.edited');
  });

  it('only on its own page, by an editor', async () => {
    expect(await approveProposal(ctx(PAGE_B), { proposalId: byCopy(1).id }, deps())).toEqual({ error: expect.stringContaining('no longer exists') });
    expect(await approveProposal(ctx(PAGE_A), { proposalId: byCopy(1).id }, deps({ canEdit: async () => false }))).toEqual({ error: expect.stringContaining('edit permission') });
    expect(await approveProposal(ctx(PAGE_A), { proposalId: 'x' }, deps())).toEqual({ error: 'Missing or invalid proposal id.' });
    expect(await rejectProposal(ctx(PAGE_B), { proposalId: byCopy(1).id }, deps())).toEqual({ error: expect.stringContaining('no longer exists') });
    expect(store.puts).toHaveLength(0);
    expect(byCopy(1).status).toBe('proposed');
  });

  it('approveAll saves every open proposal of the page in one version; mismatched versions go stale', async () => {
    const r = (await approveAll(ctx(PAGE_A), deps())) as ApproveAllResult;
    expect(r).toEqual({ applied: 2, stale: 0, needsManual: 0, failed: 0, version: 8 });
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]?.body).toContain('per diem of $75 per day');
    expect(store.puts[0]?.body).toContain('capped at &#36;75&nbsp;a day');

    const page = store.pages.get(PAGE_B);
    if (page) page.version = 3;
    const b = (await approveAll(ctx(PAGE_B), deps())) as ApproveAllResult;
    expect(b).toMatchObject({ applied: 0, stale: 1 });
    expect(store.puts).toHaveLength(1);
  });

  it('lists proposals on the copy page and the rollout on the source with a hidden count', async () => {
    const list = (await listProposalsForPage(ctx(PAGE_A), deps({ visible: async () => new Set() }))) as ProposalList;
    expect(list.canEdit).toBe(true);
    expect(list.proposals.map((p) => p.status)).toEqual(['proposed', 'proposed']);
    expect(list.proposals[0]?.sourceTitle).toBeNull();
    const rollout = (await listRollout(ctx(SOURCE), { changeId: CHANGE_ID }, deps({ visible: async () => new Set([PAGE_A]) }))) as Rollout;
    expect(rollout.items.map((i) => i.pageId)).toEqual([PAGE_A, PAGE_A]);
    expect(rollout.hiddenCount).toBe(2);
    expect(rollout.counts).toEqual({ proposed: 2 });
    expect(await listRollout(ctx(PAGE_A), { changeId: CHANGE_ID }, deps())).toEqual({ error: expect.stringContaining('does not belong') });
  });

  it('M5: decisions sync the change issues; the rollout carries its issues', async () => {
    const synced: string[][] = [];
    const d = deps({ syncIssues: async (ids) => void synced.push([...ids]) });
    await rejectProposal(ctx(PAGE_A), { proposalId: byCopy(1).id }, d);
    await markNotSameFact(ctx(PAGE_A), { proposalId: byCopy(2).id }, d);
    await approveProposal(ctx(PAGE_B), { proposalId: byCopy(3).id }, d);
    await approveAll(ctx(PAGE_B), d);
    expect(synced).toEqual([[CHANGE_ID], [CHANGE_ID], [CHANGE_ID]]);
    expect(((await listRollout(ctx(SOURCE), { changeId: CHANGE_ID }, deps())) as Rollout).issuesState).toBe('not_configured');
    const issues = {
      getJiraSettings: async () => ({ projectKey: 'OPS' }),
      listForChange: async () => [
        { changeId: CHANGE_ID, ownerAccountId: 'acc-owner', sourcePageId: SOURCE, issueId: '1', issueKey: 'OPS-1', issueUrl: 'https://x/browse/OPS-1', assigneeSet: true, pageCount: 1, status: 'closed' as const, attempts: 1, commentSent: true },
      ],
    };
    const rollout = (await listRollout(ctx(SOURCE), { changeId: CHANGE_ID }, deps({ issues }))) as Rollout;
    expect(rollout.issues).toEqual([{ ownerName: null, issueKey: 'OPS-1', issueUrl: 'https://x/browse/OPS-1', status: 'done', pageCount: 1, openPages: 0, overdue: null, remindedAt: null, reminderCount: 0, canRemind: false }]);
  });
});

describe('M4 review fixes', () => {
  beforeEach(async () => {
    await runProposeJob(CHANGE_ID, undefined, 0, proposeDeps());
  });

  it('rejects an approval as superseded when a newer change moved the value or the change is no longer confirmed', async () => {
    store.fact.value = '$80';
    const r = (await approveProposal(ctx(PAGE_A), { proposalId: byCopy(1).id }, deps())) as ProposalDecision;
    expect(r).toMatchObject({ status: 'rejected', errorCode: 'superseded' });
    expect(store.puts).toHaveLength(0);
    expect(store.copies[0]?.status).toBe('drifted');
    expect(store.audits.at(-1)?.action).toBe('proposal.superseded');

    store.fact.value = '$75';
    store.change.status = 'superseded';
    expect(await approveProposal(ctx(PAGE_A), { proposalId: byCopy(2).id }, deps())).toMatchObject({ status: 'rejected', errorCode: 'superseded' });
    store.change.status = 'confirmed';
    store.fact.value = '$80';
    const all = (await approveAll(ctx(PAGE_B), deps())) as ApproveAllResult;
    expect(all).toMatchObject({ applied: 0, version: null });
    expect(store.puts).toHaveLength(0);
  });

  it('a failed edit of the user goes back to proposed with the error code', async () => {
    store.pages.set(PAGE_A, { title: 'Onboarding', version: 7, body: `<p>Domestic trips get a per diem of $<em>6</em>0 per day.</p><p>${S2}</p>` });
    const own = 'Domestic trips get a per diem of USD 75 per calendar day.';
    const r = (await approveProposal(ctx(PAGE_A), { proposalId: byCopy(1).id, editedSentence: own }, deps())) as ProposalDecision;
    expect(r).toMatchObject({ status: 'proposed', errorCode: 'crosses_markup' });
    expect(byCopy(1)).toMatchObject({ status: 'proposed', errorCode: 'crosses_markup', newSentence: 'Domestic trips get a per diem of $75 per day.' });
    expect(store.puts).toHaveLength(0);
  });

  it('an exception while reading or saving releases the lock', async () => {
    const boom = deps({
      getPage: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(isError(await approveProposal(ctx(PAGE_A), { proposalId: byCopy(1).id }, boom))).toBe(true);
    expect(byCopy(1).status).toBe('proposed');
    const saveBoom = deps({
      updatePage: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(isError(await approveAll(ctx(PAGE_A), saveBoom))).toBe(true);
    expect([byCopy(1).status, byCopy(2).status]).toEqual(['proposed', 'proposed']);
    // Approvable again afterwards.
    expect(await approveProposal(ctx(PAGE_A), { proposalId: byCopy(1).id }, deps())).toMatchObject({ status: 'applied' });
  });

  it('caps the edited sentence before any parsing', async () => {
    const long = `Domestic trips get $75 per day. ${'x'.repeat(5000)}`;
    expect(await approveProposal(ctx(PAGE_A), { proposalId: byCopy(1).id, editedSentence: long }, deps())).toEqual({ error: expect.stringContaining('new value') });
    expect(byCopy(1).status).toBe('proposed');
  });

  it('names the source in the version message only when it is unrestricted; approveAll with several sources is generic', async () => {
    store.sourceOpen = false;
    await approveProposal(ctx(PAGE_A), { proposalId: byCopy(1).id }, deps());
    expect(store.puts[0]?.message).toBe('Updated by Ripple');
    store.sourceOpen = true;
    await approveAll(ctx(PAGE_B), deps());
    expect(store.puts[1]?.message).toBe('Updated by Ripple from Travel Policy');
    expect(versionMessage(null)).toBe('Updated by Ripple');
  });

  it('shows a generic card for a source the viewer cannot open; editors still see the new sentence', async () => {
    const hidden = (await listProposalsForPage(ctx(PAGE_A), deps({ visible: async () => new Set() }))) as ProposalList;
    expect(hidden.proposals[0]).toMatchObject({ sourceHidden: true, sourcePageId: null, sourceTitle: null, factLabel: null, newSentence: 'Domestic trips get a per diem of $75 per day.' });
    const reader = (await listProposalsForPage(ctx(PAGE_A), deps({ visible: async () => new Set(), canEdit: async () => false }))) as ProposalList;
    expect(reader.proposals[0]).toMatchObject({ sourceHidden: true, newSentence: null, newValue: null });
    const shown = (await listProposalsForPage(ctx(PAGE_A), deps())) as ProposalList;
    expect(shown.proposals[0]).toMatchObject({ sourceHidden: false, sourcePageId: SOURCE, sourceTitle: 'Travel Policy', factLabel: 'Domestic per diem · amount' });
  });

  it('rollout items carry the page owner', async () => {
    store.change.routing = { deadline: '2026-11-16', pages: [{ pageId: PAGE_A, spaceId: 'S', ownerAccountId: 'acc-owner', ownerRole: 'owner', copies: 2 }] } as never;
    const rollout = (await listRollout(ctx(SOURCE), { changeId: CHANGE_ID }, deps())) as Rollout;
    expect(rollout.items.find((i) => i.pageId === PAGE_A)?.owner).toEqual({ accountId: 'acc-owner', displayName: 'Name of acc-owner' });
    expect(rollout.items.find((i) => i.pageId === PAGE_B)?.owner).toEqual({ accountId: null, displayName: null });
  });

  it('goStale queues one job per (change, page), then one delayed follow-up, then nothing within the window', async () => {
    const page = store.pages.get(PAGE_A);
    if (page) page.version = 9;
    await approveAll(ctx(PAGE_A), deps());
    expect(store.enqueued).toEqual([{ changeId: CHANGE_ID, copyPageId: PAGE_A }]);
    await runProposeJob(CHANGE_ID, { copyPageId: PAGE_A }, 0, proposeDeps());
    if (page) page.version = 10;
    await approveAll(ctx(PAGE_A), deps());
    expect(store.enqueued[1]).toEqual({ changeId: CHANGE_ID, copyPageId: PAGE_A, delaySeconds: 120 });
    await runProposeJob(CHANGE_ID, { copyPageId: PAGE_A }, 0, proposeDeps());
    if (page) page.version = 11;
    await approveAll(ctx(PAGE_A), deps());
    expect(store.enqueued).toHaveLength(2);
  });
});

describe('validateRewrite (review fixes)', () => {
  const o = { value: '$60', unit: 'per day' };
  const n = { value: '$75', unit: 'per day' };
  const s = 'Pay $60 per day for up to 3 days.';
  it('rejects a rewrite that changes another number, a unit or the rate period', () => {
    expect(validateRewrite(s, 'Pay $75 per day for up to 3 days.', o, n, true)).toBe(true);
    expect(validateRewrite(s, 'Pay $75 per day for up to 5 days.', o, n, true)).toBe(false);
    expect(validateRewrite(s, 'Pay $75 per day for up to 3 weeks.', o, n, true)).toBe(false);
    expect(validateRewrite(s, 'Pay $75 per week for up to 3 days.', o, n, true)).toBe(false);
  });
  it('rejects XML-invalid control characters and over-long sentences', () => {
    expect(validateRewrite(s, 'Pay $75 per day\u0007 for up to 3 days.', o, n, false)).toBe(false);
    expect(validateRewrite(s, `Pay $75 per day. ${'x'.repeat(2000)}`, o, n, false)).toBe(false);
  });
});

describe('Ripple edits do not trigger change detection', () => {
  it('the version message is recognised by the updated:page trigger', async () => {
    const message = versionMessage('Travel\nPolicy');
    expect(message).toBe('Updated by Ripple from Travel Policy');
    const out = await handlePageUpdate(
      { pageId: SOURCE, version: 6, message },
      {
        facts: { getSource: async () => ({ pageId: SOURCE }) } as never,
        changes: { claimPageEvent: async () => true } as never,
        enqueueDiff: async () => 'job',
        ensure: async () => undefined,
      },
    );
    expect(out).toEqual({ status: 'ignored', reason: 'ripple edit' });
  });
});

// Keeps the status union and the store in step (a new status needs a guard above).
const _statuses: ProposalStatus[] = ['proposed', 'approved', 'applied', 'rejected', 'stale', 'needs_manual', 'failed'];
void _statuses;
