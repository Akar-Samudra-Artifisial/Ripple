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
import type { ChangeRepo, ChangeRouting, ChangeRow, CopyForChange } from '../src/adapters/changeRepo';
import type { SourcePage } from '../src/adapters/confluence';
import type { FactRepo, PageVersionInfo } from '../src/adapters/repo';
import { addWorkingDays, computeImpact, planDiff, type ChangeImpact, type FactChange } from '../src/core/changes';
import { identityKey, type ExtractedFact, type MergePlan, type StoredFact } from '../src/core/facts';
import type { ChangeDecision, CopyStatus, ErrorReply, FactView, PendingChangeReply, SourceView } from '../src/core/views';
import type { ChatToolFn } from '../src/llm/extract';
import type { ToolSpec } from '../src/llm/index';
import { confirmChange, dismissChange, getPendingChange, handlePageUpdate, runDiffJob, type ChangeDeps, type DiffDeps, type TriggerDeps } from '../src/surfaces/changes';
import { COPY_PAGES, SOURCE_PAGE_ID, type FactKey } from './fixtures/copies';

const CHANGE_RE = /^[0-9a-f-]{36}$/i;

interface Row extends FactView {
  identityKey: string;
  originKey: string | null;
}

const fact = (id: string, subject: string, attribute: string, condition: string | null, value: string, unit: string | null, quote: string): Row => ({
  id,
  type: 'number',
  subject,
  attribute,
  value,
  unit,
  condition,
  quote,
  status: 'confirmed',
  edited: false,
  previousValue: null,
  pageVersion: 3,
  effectiveSince: null,
  identityKey: identityKey(subject, attribute, condition),
  originKey: identityKey(subject, attribute, condition),
});

const FACT_IDS: Record<FactKey, string> = {
  domestic: 'f-1-domestic',
  international: 'f-2-international',
  approval: 'f-3-approval',
  claims: 'f-4-claims',
  flight: 'f-5-flight',
};

const SENTENCES = {
  domestic: (v: string) => `Domestic travel: the per diem is ${v} per day.`,
  international: 'International travel: the per diem is $90 per day.',
  claims: 'Submit expense claims within 30 days after the trip ends.',
};

function initialFacts(): Row[] {
  return [
    fact(FACT_IDS.domestic, 'Travel per diem', 'Amount per day', 'Domestic travel', '$60', 'per day', SENTENCES.domestic('$60')),
    fact(FACT_IDS.international, 'Travel per diem', 'Amount per day', 'International travel', '$90', 'per day', SENTENCES.international),
    fact(FACT_IDS.claims, 'Expense claims', 'Deadline', null, '30 days', null, SENTENCES.claims),
    fact(FACT_IDS.flight, 'Flight class', 'Class', 'Flights under 6 hours', 'economy class', null, 'Book economy class for flights under 6 hours.'),
  ];
}

/** Extraction of a page version: domestic per diem `domestic`, the other facts unchanged; flight class gone. */
const extracted = (domestic: string) => ({
  facts: [
    { type: 'number', subject: 'Travel per diem', attribute: 'Amount per day', value: domestic, unit: 'per day', condition: 'Domestic travel', quote: SENTENCES.domestic(domestic) },
    { type: 'number', subject: 'Travel per diem', attribute: 'Amount per day', value: '$90', unit: 'per day', condition: 'International travel', quote: SENTENCES.international },
    { type: 'number', subject: 'Expense claims', attribute: 'Deadline', value: '30 days', unit: null, condition: null, quote: SENTENCES.claims },
  ],
});

const bodyOf = (domestic: string) => `<p>${SENTENCES.domestic(domestic)}</p><p>${SENTENCES.international}</p><p>${SENTENCES.claims}</p>`;

/** Copies of the last scan from the M2 fixture: the stored status and stated value per fact and page. */
function fixtureCopies(): (CopyForChange & { reason: string })[] {
  return COPY_PAGES.flatMap((p) =>
    Object.entries(p.expect)
      .filter(([, status]) => status)
      .map(([k, status]) => {
        const m = p.judge.find((j) => j.fact === k && (status === 'unsure' || j.same_fact !== 'no'));
        return {
          id: `c-${p.id}-${k}`,
          factId: FACT_IDS[k as FactKey],
          pageId: p.id,
          pageTitle: p.title,
          pageUrl: `/spaces/S/pages/${p.id}`,
          status: status as CopyStatus,
          statedValue: m?.stated_value ?? null,
          statedUnit: m?.stated_unit ?? null,
          reason: 'r',
        };
      }),
  );
}

/** In-memory store with the SQL semantics of `sqlRepo` (the parts change detection uses) and `sqlChangeRepo`. */
class Store {
  sources = new Map<string, SourceView>([[SOURCE_PAGE_ID, { pageId: SOURCE_PAGE_ID, title: 'Travel Policy', state: 'ready', pageVersion: 3, markedAt: 'now', extractedAt: 'now', error: null }]]);
  facts: Row[] = initialFacts();
  audits: { action: string; detail?: Record<string, unknown> }[] = [];
  merges: MergePlan[] = [];
  events = new Set<string>();
  changes = new Map<string, ChangeRow & { routing: ChangeRouting | null; deadlineDays: number | null }>();
  copies = fixtureCopies();
  private n = 0;

  factRepo(): FactRepo {
    return {
      getSource: async (id: string) => this.sources.get(id),
      storedFacts: async (): Promise<StoredFact[]> => this.facts.map((f) => ({ id: f.id, identityKey: f.identityKey, originKey: f.originKey, status: f.status, edited: f.edited, value: f.value, unit: f.unit })),
      listFacts: async () => this.facts.map((f) => ({ ...f })),
      applyMerge: async (_id: string, plan: MergePlan, page: PageVersionInfo) => {
        this.merges.push(plan);
        for (const u of plan.update) {
          const f = this.facts.find((x) => x.id === u.id);
          if (!f || f.status === 'rejected') continue;
          if (u.refreshOnly) Object.assign(f, { quote: u.fact.quote, pageVersion: page.version });
          else if (f.status === u.from && !f.edited) Object.assign(f, { value: u.fact.value, unit: u.fact.unit, status: u.status, pageVersion: page.version });
        }
        for (const i of plan.insert) this.facts.push({ ...fact(`f-new-${this.facts.length}`, i.subject, i.attribute, i.condition, i.value, i.unit, i.quote), status: 'proposed' });
      },
      finishExtraction: async (id: string, page: PageVersionInfo) => {
        const s = this.sources.get(id);
        if (s) s.pageVersion = page.version;
      },
      audit: async (action: string, _actor: string | null, _t: string, _s: string, detail?: Record<string, unknown>) => {
        this.audits.push({ action, detail });
      },
    } as unknown as FactRepo;
  }

  changeRepo(): ChangeRepo {
    return {
      claimPageEvent: async (pageId, version) => {
        const k = `${pageId}:${version}`;
        if (this.events.has(k)) return false;
        this.events.add(k);
        return true;
      },
      pendingChange: async (sourcePageId) => [...this.changes.values()].find((c) => c.sourcePageId === sourcePageId && c.status === 'pending'),
      getChange: async (id) => this.changes.get(id),
      savePending: async (sourcePageId, version, factChanges, missing, impact) => {
        const existing = [...this.changes.values()].find((c) => c.sourcePageId === sourcePageId && c.status === 'pending');
        if (existing) {
          Object.assign(existing, { pageVersion: version, factChanges: [...factChanges], missingFactIds: [...missing], impact });
          return { id: existing.id, replaced: true };
        }
        const id = `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
        this.changes.set(id, { id, sourcePageId, status: 'pending', pageVersion: version, factChanges: [...factChanges], missingFactIds: [...missing], impact, createdAt: 'now', routing: null, deadlineDays: null });
        return { id, replaced: false };
      },
      supersedePending: async (sourcePageId) => {
        let n = 0;
        for (const c of this.changes.values()) if (c.sourcePageId === sourcePageId && c.status === 'pending') (c.status = 'superseded'), n++;
        return n;
      },
      copiesForFacts: async (sourcePageId, factIds) => (sourcePageId === SOURCE_PAGE_ID ? this.copies.filter((c) => factIds.includes(c.factId)) : []),
      decide: async (id, status, _actor, deadlineDays, routing) => {
        const c = this.changes.get(id);
        if (!c || c.status !== 'pending') return false;
        Object.assign(c, { status, deadlineDays, routing });
        return true;
      },
      applyFactChange: async (sourcePageId, c: FactChange) => {
        const f = this.facts.find((x) => x.id === c.factId && x.status === 'confirmed' && x.value === c.oldValue);
        if (!f || sourcePageId !== SOURCE_PAGE_ID) return false;
        Object.assign(f, { value: c.newValue, unit: c.newUnit, quote: c.newQuote, previousValue: c.oldValue, pageVersion: c.version });
        return true;
      },
      restatusCopies: async (toDrift, toSync) => {
        let n = 0;
        for (const c of this.copies) {
          if (toDrift.includes(c.id) && c.status === 'in_sync') (c.status = 'drifted'), n++;
          if (toSync.includes(c.id) && c.status === 'drifted') c.status = 'in_sync';
        }
        return n;
      },
    };
  }
}

let store: Store;
let llmCalls = 0;

function extractLlm(domestic: string): ChatToolFn {
  return (async (_m: Message[], tool: ToolSpec) => {
    llmCalls++;
    expect(tool.name).toBe('record_facts');
    return { args: extracted(domestic), model: 'm' };
  }) as ChatToolFn;
}

const page = (version: number, domestic: string, versionMessage: string | null = null): SourcePage => ({
  id: SOURCE_PAGE_ID,
  title: 'Travel Policy',
  spaceId: '7',
  version,
  versionCreatedAt: '2026-11-09T10:00:00.000Z',
  versionMessage,
  body: bodyOf(domestic),
});

const diffDeps = (version: number, domestic: string, over: Partial<DiffDeps> = {}): DiffDeps => ({
  facts: store.factRepo(),
  changes: store.changeRepo(),
  page: async () => page(version, domestic),
  spaceOf: async (id) => `S-${id}`,
  llm: extractLlm(domestic),
  ensure: async () => undefined,
  ...over,
});

beforeEach(() => {
  store = new Store();
  llmCalls = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('updated:page trigger', () => {
  const triggerDeps = (pushes: string[]): TriggerDeps => ({
    facts: store.factRepo(),
    changes: store.changeRepo(),
    enqueueDiff: async (pageId) => {
      pushes.push(pageId);
      return 'job-1';
    },
    ensure: async () => undefined,
  });

  it('queues a diff for a saved source page once per version (redelivery deduplicated)', async () => {
    const pushes: string[] = [];
    expect(await handlePageUpdate({ pageId: SOURCE_PAGE_ID, version: 4, message: null }, triggerDeps(pushes))).toEqual({ status: 'queued', jobId: 'job-1' });
    expect(await handlePageUpdate({ pageId: SOURCE_PAGE_ID, version: 4, message: null }, triggerDeps(pushes))).toEqual({ status: 'ignored', reason: 'duplicate event' });
    expect(pushes).toEqual([SOURCE_PAGE_ID]);
  });

  it('ignores pages that are not a source', async () => {
    const pushes: string[] = [];
    expect(await handlePageUpdate({ pageId: '123', version: 2, message: null }, triggerDeps(pushes))).toEqual({ status: 'ignored', reason: 'not a source' });
    expect(pushes).toEqual([]);
    expect(store.events.size).toBe(0);
  });

  it('ignores versions saved by Ripple ("Updated by Ripple")', async () => {
    const pushes: string[] = [];
    expect(await handlePageUpdate({ pageId: SOURCE_PAGE_ID, version: 5, message: 'Updated by Ripple: per diem' }, triggerDeps(pushes))).toEqual({ status: 'ignored', reason: 'ripple edit' });
    expect(pushes).toEqual([]);
  });
});

describe('diff consumer', () => {
  it('$60 → $75: one pending change with the impact from the copies of the last scan', async () => {
    const r = await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(4, '$75'));
    expect(r).toMatchObject({ status: 'done', changed: 1, copies: 1, missing: 1, inserted: 0 });
    const changes = [...store.changes.values()];
    expect(changes).toHaveLength(1);
    const c = changes[0] as ChangeRow;
    expect(c.id).toMatch(CHANGE_RE);
    expect(c.status).toBe('pending');
    expect(c.pageVersion).toBe(4);
    expect(c.factChanges).toEqual([
      { factId: FACT_IDS.domestic, oldValue: '$60', oldUnit: 'per day', newValue: '$75', newUnit: 'per day', newQuote: SENTENCES.domestic('$75'), version: 4, versionAt: '2026-11-09T10:00:00.000Z' },
    ]);
    expect(c.missingFactIds).toEqual([FACT_IDS.flight]);
    // FAQ (in sync at $60) must be updated; the drifted page already says $75; history and the $40 training trap are shown only.
    expect(c.impact).toEqual({
      copies: [{ copyId: 'c-9600001-domestic', factId: FACT_IDS.domestic, pageId: '9600001', spaceId: 'S-9600001', status: 'in_sync' }],
      alreadyNew: 1,
      syncCopyIds: ['c-9600003-domestic'],
      unsure: 1,
      historical: 1,
    });
    // Nothing changes until the owner confirms; the flight fact is kept.
    const dom = store.facts.find((f) => f.id === FACT_IDS.domestic);
    expect(dom).toMatchObject({ value: '$60', status: 'confirmed' });
    expect(store.facts.find((f) => f.id === FACT_IDS.flight)?.status).toBe('confirmed');
    expect(store.merges[0]?.remove).toEqual([]);
    expect(store.audits.map((a) => a.action)).toEqual(['change.detected']);
  });

  it('replaces an older pending change in place, and supersedes it when the value is back', async () => {
    await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(4, '$75'));
    const id = [...store.changes.keys()][0];
    await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(5, '$80'));
    expect([...store.changes.keys()]).toEqual([id]);
    expect(store.changes.get(id as string)).toMatchObject({ status: 'pending', pageVersion: 5, factChanges: [expect.objectContaining({ newValue: '$80' })] });
    const back = await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(6, '$60'));
    expect(back).toMatchObject({ status: 'done', changeId: null, changed: 0 });
    expect(store.changes.get(id as string)?.status).toBe('superseded');
  });

  it('records no change when no value changed', async () => {
    const r = await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(4, '$60'));
    expect(r).toMatchObject({ status: 'done', changeId: null, changed: 0 });
    expect(store.changes.size).toBe(0);
    expect(store.facts.filter((f) => f.status === 'confirmed')).toHaveLength(4);
  });

  it('skips a version saved by Ripple and a version already read, without calling the LLM', async () => {
    const ripple = await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(4, '$75', { page: async () => page(4, '$75', 'Updated by Ripple: 1 fact') }));
    expect(ripple).toEqual({ status: 'skipped', reason: 'ripple edit' });
    const old = await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(3, '$75'));
    expect(old).toEqual({ status: 'skipped', reason: 'version already read' });
    expect(llmCalls).toBe(0);
    expect(store.changes.size).toBe(0);
  });

  it('skips a page that is not a source', async () => {
    store.sources.clear();
    expect(await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(4, '$75'))).toEqual({ status: 'skipped', reason: 'not a source' });
    expect(llmCalls).toBe(0);
  });
});

describe('planDiff / computeImpact / addWorkingDays', () => {
  const stored = (over: Partial<StoredFact> = {}): StoredFact => ({ id: 'a', identityKey: 'x|y|', originKey: 'x|y|', status: 'confirmed', edited: false, value: '$60', unit: 'per day', ...over });
  const ex = (value: string, unit: string | null = 'per day'): ExtractedFact => ({ type: 'number', subject: 'x', attribute: 'y', value, unit, condition: null, quote: `x y is ${value} per day`, identityKey: 'x|y|' });

  it('a reviewer-edited confirmed fact still reports a changed value', () => {
    expect(planDiff([stored({ edited: true })], [ex('$75')], 2).changes).toHaveLength(1);
  });

  it('the same number written differently only refreshes (never back to proposed)', () => {
    const plan = planDiff([stored()], [ex('60', 'per day')], 2);
    expect(plan.changes).toEqual([]);
    expect(plan.merge.update).toEqual([expect.objectContaining({ refreshOnly: true, status: 'confirmed' })]);
  });

  it('a copy without a stated value is propagated (cannot be shown to match)', () => {
    const change: FactChange = { factId: 'a', oldValue: '$60', oldUnit: null, newValue: '$75', newUnit: null, newQuote: 'q', version: 2, versionAt: null };
    const impact: ChangeImpact = computeImpact([change], [{ id: 'c', factId: 'a', pageId: '1', status: 'drifted', statedValue: null, statedUnit: null }], new Map());
    expect(impact.copies).toEqual([{ copyId: 'c', factId: 'a', pageId: '1', spaceId: null, status: 'drifted' }]);
  });

  it('counts working days (Mon–Fri)', () => {
    expect(addWorkingDays(new Date('2026-11-06T15:00:00Z'), 5)).toBe('2026-11-13'); // Friday → next Friday
    expect(addWorkingDays(new Date('2026-11-09T09:00:00Z'), 5)).toBe('2026-11-16'); // Monday → next Monday
  });
});

describe('change resolvers', () => {
  const ctx = { accountId: 'acc-1', cloudId: 'cloud-1', extension: { content: { id: SOURCE_PAGE_ID } } };
  const teams = { data: { atlassianTeamsBySpace: { edges: [{ node: { id: 'team-1', displayName: 'People Ops' } }] } } };
  const changeDeps = (over: Partial<ChangeDeps> = {}): ChangeDeps => ({
    facts: store.factRepo(),
    changes: store.changeRepo(),
    canEdit: async () => true,
    visible: async (ids) => new Set(ids),
    pageMeta: async (id) => ({ spaceId: `S-${id}`, ownerId: `owner-${id}` }),
    names: async (ids) => new Map(ids.map((id) => [id, `Name ${id}`])),
    graph: () => async () => ({ body: teams }),
    ensure: async () => undefined,
    now: () => new Date('2026-11-09T09:00:00Z'),
    ...over,
  });
  const pendingId = async (): Promise<string> => {
    await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(4, '$75'));
    return [...store.changes.keys()][0] as string;
  };

  it('getPendingChange: facts old → new, copy pages with owners, teams per space, 5 working days', async () => {
    const id = await pendingId();
    const r = (await getPendingChange(ctx, changeDeps())) as PendingChangeReply;
    expect(r.change).toMatchObject({
      id,
      version: 4,
      facts: [{ factId: FACT_IDS.domestic, factLabel: 'Travel per diem · Amount per day · Domestic travel', oldValue: '$60', newValue: '$75' }],
      missingFacts: 1,
      copies: 1,
      hiddenCount: 0,
      unsure: 1,
      historical: 1,
      alreadyNew: 1,
      pages: [{ pageId: '9600001', pageTitle: 'New joiner FAQ: travel', spaceId: 'S-9600001', copies: 1, owner: { accountId: 'owner-9600001', role: 'owner', displayName: 'Name owner-9600001' } }],
      spaces: [{ spaceId: 'S-9600001', teams: [{ id: 'team-1', name: 'People Ops' }], teamSource: 'teamwork_graph' }],
      defaultDeadlineDays: 5,
      defaultDeadline: '2026-11-16',
      canDecide: true,
    });
  });

  it('getPendingChange hides pages the viewer cannot open (count only) and reports no teams as "none"', async () => {
    await pendingId();
    const r = (await getPendingChange(ctx, changeDeps({ visible: async () => new Set(), canEdit: async () => false }))) as PendingChangeReply;
    expect(r.change).toMatchObject({ copies: 0, pages: [], hiddenCount: 1, spaces: [], canDecide: false });
    const none = (await getPendingChange(ctx, changeDeps({ graph: () => async () => ({ body: { data: { atlassianTeamsBySpace: { edges: [] } } } }) }))) as PendingChangeReply;
    expect(none.change?.spaces).toEqual([{ spaceId: 'S-9600001', teams: [], teamSource: 'none' }]);
    expect(((await getPendingChange({ ...ctx, extension: { content: { id: '42' } } }, changeDeps())) as PendingChangeReply).change).toBeNull();
  });

  it('confirmChange needs edit permission on the source', async () => {
    const id = await pendingId();
    expect(await confirmChange(ctx, { changeId: id }, changeDeps({ canEdit: async () => false }))).toEqual({ error: expect.stringContaining('edit permission') });
    expect(await confirmChange({ ...ctx, accountId: undefined }, { changeId: id }, changeDeps())).toEqual({ error: expect.stringContaining('edit permission') });
    expect(store.changes.get(id)?.status).toBe('pending');
    expect(store.facts.find((f) => f.id === FACT_IDS.domestic)?.value).toBe('$60');
  });

  it('confirmChange sets the new value, keeps the old one, restatuses copies and audits owner/team sources', async () => {
    const id = await pendingId();
    expect(await confirmChange(ctx, { changeId: id, deadlineDays: 31 }, changeDeps())).toEqual({ error: expect.stringContaining('1 to 30') });
    expect(await confirmChange(ctx, { changeId: id, version: 3 }, changeDeps())).toEqual({ error: expect.stringContaining('changed again') });
    const r = (await confirmChange(ctx, { changeId: id, deadlineDays: 3, version: 4 }, changeDeps())) as ChangeDecision;
    expect(r).toEqual({ changeId: id, status: 'confirmed', factsUpdated: 1, copiesDrifted: 1, deadline: '2026-11-12' });
    expect(store.facts.find((f) => f.id === FACT_IDS.domestic)).toMatchObject({ value: '$75', previousValue: '$60', status: 'confirmed', pageVersion: 4 });
    expect(store.copies.find((c) => c.id === 'c-9600001-domestic')?.status).toBe('drifted');
    expect(store.copies.find((c) => c.id === 'c-9600003-domestic')?.status).toBe('in_sync');
    expect(store.copies.find((c) => c.id === 'c-9600006-domestic')?.status).toBe('unsure');
    const row = store.changes.get(id);
    expect(row).toMatchObject({ status: 'confirmed', deadlineDays: 3 });
    expect(row?.routing).toEqual({
      deadline: '2026-11-12',
      pages: [{ pageId: '9600001', spaceId: 'S-9600001', ownerAccountId: 'owner-9600001', ownerRole: 'owner', copies: 1 }],
      spaces: [{ spaceId: 'S-9600001', teamIds: ['team-1'], teamSource: 'teamwork_graph' }],
    });
    const audit = store.audits.find((a) => a.action === 'change.confirmed');
    expect(audit?.detail).toMatchObject({ factsUpdated: 1, deadlineDays: 3, ownerSource: { owner: 1 }, teamSource: { teamwork_graph: 1 } });
    // Decided: a second confirm or a dismiss finds nothing pending.
    expect(await confirmChange(ctx, { changeId: id }, changeDeps())).toEqual({ error: expect.stringContaining('already decided') });
    expect(await dismissChange(ctx, { changeId: id }, changeDeps())).toEqual({ error: expect.stringContaining('already decided') });
  });

  it('dismissChange: permission, then dismissed with an audit row; facts unchanged', async () => {
    const id = await pendingId();
    expect(await dismissChange(ctx, { changeId: id }, changeDeps({ canEdit: async () => false }))).toEqual({ error: expect.stringContaining('edit permission') });
    expect(await dismissChange(ctx, { changeId: 'nope' }, changeDeps())).toEqual({ error: 'Missing or invalid change id.' });
    // A change of another page is "gone" from this page's context.
    expect(await dismissChange({ ...ctx, extension: { content: { id: '42' } } }, { changeId: id }, changeDeps())).toEqual({ error: expect.stringContaining('already decided') });
    const r = (await dismissChange(ctx, { changeId: id }, changeDeps())) as ChangeDecision | ErrorReply;
    expect(r).toEqual({ changeId: id, status: 'dismissed', factsUpdated: 0, copiesDrifted: 0, deadline: null });
    expect(store.changes.get(id)?.status).toBe('dismissed');
    expect(store.facts.find((f) => f.id === FACT_IDS.domestic)?.value).toBe('$60');
    expect(store.audits.map((a) => a.action)).toContain('change.dismissed');
  });
});
