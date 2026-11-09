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
import { dismissalKey, valueHash, type ChangeRepo, type ChangeRouting, type ChangeRow, type CopyForChange } from '../src/adapters/changeRepo';
import type { SourcePage } from '../src/adapters/confluence';
import type { FactRepo, PageVersionInfo } from '../src/adapters/repo';
import { addWorkingDays, computeImpact, factChanged, matchFacts, planDiff, wordingOnlyChange, type ChangeImpact, type FactChange, type KnownFact } from '../src/core/changes';
import { identityKey, type ExtractedFact, type MergePlan, type StoredFact } from '../src/core/facts';
import type { ChangeDecision, CopyStatus, ErrorReply, FactView, PendingChangeReply, SourceView } from '../src/core/views';
import type { ChatToolFn } from '../src/llm/extract';
import type { ToolSpec } from '../src/llm/index';
import { SchemaSettingUpError } from '../src/core/schema';
import { confirmChange, dismissChange, getLatestChange, getPendingChange, handlePageUpdate, healSource, runDiffJob, SCHEMA_DEFER_SECONDS, type ChangeDeps, type HealDeps, type DiffDeps, type TriggerDeps } from '../src/surfaces/changes';
import { COPY_PAGES, SOURCE_PAGE_ID, type FactKey } from './fixtures/copies';
import { TRAVEL_POLICY_FACTS, TRAVEL_POLICY_STORAGE } from './fixtures/travelPolicy';

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
  changes = new Map<string, ChangeRow>();
  copies = fixtureCopies();
  textHashes = new Map<string, string>();
  dismissals: { sourcePageId: string; factId: string; valueHash: string }[] = [];
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
        this.facts = this.facts.filter((f) => !(plan.remove.includes(f.id) && f.status === 'proposed' && !f.edited));
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
      releasePageEvent: async (pageId, version) => {
        this.events.delete(`${pageId}:${version}`);
      },
      decide: async (id, version, status, _actor, deadlineDays, routing) => {
        const c = this.changes.get(id);
        if (!c || c.status !== 'pending' || c.pageVersion !== version) return false;
        Object.assign(c, { status, deadlineDays, routing });
        return true;
      },
      textHash: async (pageId) => this.textHashes.get(pageId) ?? null,
      setTextHash: async (pageId, hash) => {
        this.textHashes.set(pageId, hash);
      },
      dismissedValues: async (sourcePageId) => new Set(this.dismissals.filter((d) => d.sourcePageId === sourcePageId).map((d) => dismissalKey(d.factId, d.valueHash))),
      saveDismissals: async (sourcePageId, factChanges) => {
        for (const c of factChanges) {
          const valueHashOf = valueHash(c.newValue, c.newUnit);
          if (!this.dismissals.some((d) => d.factId === c.factId && d.valueHash === valueHashOf)) this.dismissals.push({ sourcePageId, factId: c.factId, valueHash: valueHashOf });
        }
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
      confirmedChanges: async (sourcePageId) => [...this.changes.values()].filter((c) => c.sourcePageId === sourcePageId && c.status === 'confirmed').reverse(),
      revertFactChange: async (sourcePageId, c: FactChange, copyIds) => {
        const f = this.facts.find((x) => x.id === c.factId && x.status === 'confirmed' && x.value === c.newValue && x.previousValue === c.oldValue);
        if (!f || sourcePageId !== SOURCE_PAGE_ID) return { reverted: false, copies: 0 };
        Object.assign(f, { value: c.oldValue, unit: c.oldUnit, previousValue: null });
        let copies = 0;
        for (const k of this.copies) if (copyIds.includes(k.id) && k.factId === c.factId && k.status === 'drifted') (k.status = 'in_sync'), copies++;
        return { reverted: true, copies };
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

describe('healSource (jobs that were never delivered)', () => {
  const NOW = Date.parse('2026-11-09T09:50:00Z');
  const change = (id: string, copies: number, createdAt = '2026-11-09T09:39:04Z') =>
    ({ id, status: 'confirmed', createdAt, impact: { copies: Array.from({ length: copies }, (_, i) => ({ copyId: `c-${i}` })) } }) as unknown as ChangeRow;
  const healDeps = (over: Partial<HealDeps> = {}) => {
    const queued: string[] = [];
    const deps: HealDeps = {
      facts: { getSource: async () => ({ pageId: '9502721', title: null, state: 'ready', pageVersion: 11, markedAt: '', extractedAt: null, error: null }) },
      changes: { confirmedChanges: async () => [change('ch-v11', 1), change('ch-old', 1, '2026-10-01T00:00:00Z'), change('ch-none', 0)] },
      proposalCount: async () => 0,
      enqueueDiff: async (pageId, version) => {
        queued.push(`diff ${pageId} v${version}`);
        return 'job-diff';
      },
      enqueuePropose: async (pageId, changeId) => {
        queued.push(`propose ${pageId} ${changeId}`);
        return 'job-propose';
      },
      now: () => NOW,
      ...over,
    };
    return { deps, queued };
  };

  it('queues the lost v12 diff and the propose job of a recent confirmed change without proposals', async () => {
    const { deps, queued } = healDeps();
    expect(await healSource('9502721', 12, deps)).toEqual({ diffJob: 'job-diff', proposeJobs: 1 });
    expect(queued).toEqual(['diff 9502721 v12', 'propose 9502721 ch-v11']);
    // Throttled per page: a second byline open right after queues nothing.
    expect(await healSource('9502721', 12, deps)).toBeNull();
  });

  it('queues nothing when the version was read and every change has proposals', async () => {
    const { deps, queued } = healDeps({ proposalCount: async () => 1, now: () => NOW + 10 * 60_000 });
    expect(await healSource('9502721', 11, deps)).toEqual({ diffJob: null, proposeJobs: 0 });
    expect(queued).toEqual([]);
  });

  it('M5: re-queues a change with proposals only when an owner issue is missing (recent changes only)', async () => {
    const asked: string[] = [];
    const { deps, queued } = healDeps({
      proposalCount: async () => 2,
      issuesNeeded: async (c) => {
        asked.push(c.id);
        return c.id === 'ch-v11';
      },
      now: () => NOW + 20 * 60_000,
    });
    expect(await healSource('9502721', 11, deps)).toEqual({ diffJob: null, proposeJobs: 1 });
    expect(queued).toEqual(['propose 9502721 ch-v11']);
    // The old change (> 7 days) and the change without copies are never checked.
    expect(asked).toEqual(['ch-v11']);
  });

  it('ignores pages that are not a source and never throws', async () => {
    const { deps, queued } = healDeps({ facts: { getSource: async () => undefined } });
    expect(await healSource('123', 5, deps)).toBeNull();
    const broken = healDeps({
      facts: {
        getSource: async () => {
          throw new Error('db down');
        },
      },
    });
    expect(await healSource('456', 5, broken.deps)).toBeNull();
    expect(queued).toEqual([]);
  });
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

  it('releases the claim when the diff cannot be queued, so the redelivered event is not a duplicate', async () => {
    const pushes: string[] = [];
    const failing: TriggerDeps = {
      ...triggerDeps(pushes),
      enqueueDiff: async () => {
        throw new Error('queue unavailable');
      },
    };
    await expect(handlePageUpdate({ pageId: SOURCE_PAGE_ID, version: 4, message: null }, failing)).rejects.toThrow('queue unavailable');
    expect(store.events.size).toBe(0);
    expect(await handlePageUpdate({ pageId: SOURCE_PAGE_ID, version: 4, message: null }, triggerDeps(pushes))).toEqual({ status: 'queued', jobId: 'job-1' });
  });

  it('ignores pages that are not a source', async () => {
    const pushes: string[] = [];
    expect(await handlePageUpdate({ pageId: '123', version: 2, message: null }, triggerDeps(pushes))).toEqual({ status: 'ignored', reason: 'not a source' });
    expect(pushes).toEqual([]);
    expect(store.events.size).toBe(0);
  });

  it('queues the diff with a delay instead of dropping the edit while the schema is not ready', async () => {
    const queued: { pageId: string; version: number | null; delaySeconds?: number }[] = [];
    const deps: TriggerDeps = {
      ...triggerDeps([]),
      ensure: async () => {
        throw new SchemaSettingUpError(24, 25);
      },
      enqueueDiff: async (pageId, version, options) => {
        queued.push({ pageId, version, delaySeconds: options?.delaySeconds });
        return 'job-later';
      },
    };
    expect(await handlePageUpdate({ pageId: SOURCE_PAGE_ID, version: 9, message: null }, deps)).toEqual({ status: 'deferred', jobId: 'job-later' });
    expect(await handlePageUpdate({ pageId: SOURCE_PAGE_ID, version: 10, message: 'Updated by Ripple: per diem' }, deps)).toEqual({ status: 'ignored', reason: 'ripple edit' });
    expect(queued).toEqual([{ pageId: SOURCE_PAGE_ID, version: 9, delaySeconds: SCHEMA_DEFER_SECONDS }]);
    expect(store.events.size).toBe(0); // no SQL claim before the schema is ready
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
      needsCheck: 0,
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

  it('a human edit (v5) followed by a Ripple edit (v6) before the job ran is still diffed', async () => {
    // The trigger queued the job for the human v5; the latest version is Ripple's v6 with the human change in it.
    const r = await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(6, '$75', { page: async () => page(6, '$75', 'Updated by Ripple from Other Source') }));
    expect(r).toMatchObject({ status: 'done', changed: 1 });
    expect(llmCalls).toBe(1);
    // A Ripple-only version with the text already read is skipped without the model.
    const again = await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(7, '$75', { page: async () => page(7, '$75', 'Updated by Ripple') }));
    expect(again).toEqual({ status: 'skipped', reason: 'text unchanged' });
    expect(llmCalls).toBe(1);
  });

  it('skips a version already read, without calling the LLM', async () => {
    const old = await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(3, '$75'));
    expect(old).toEqual({ status: 'skipped', reason: 'version already read' });
    expect(llmCalls).toBe(0);
    expect(store.changes.size).toBe(0);
  });

  it('a failure before the change is stored leaves the version unread, so the retry records the change', async () => {
    const failing = store.changeRepo();
    failing.savePending = async () => {
      throw new Error('SQL write failed');
    };
    expect(await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(4, '$75', { changes: failing }))).toMatchObject({ status: 'failed' });
    expect(store.sources.get(SOURCE_PAGE_ID)?.pageVersion).toBe(3);
    expect(store.textHashes.size).toBe(0);
    const spaceFails = await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(4, '$75', { spaceOf: async () => Promise.reject(new Error('HTTP 500')) }));
    expect(spaceFails).toMatchObject({ status: 'failed' });
    expect(store.sources.get(SOURCE_PAGE_ID)?.pageVersion).toBe(3);
    const retry = await runDiffJob(SOURCE_PAGE_ID, 1, diffDeps(4, '$75'));
    expect(retry).toMatchObject({ status: 'done', changed: 1 });
    expect([...store.changes.values()]).toEqual([expect.objectContaining({ status: 'pending', pageVersion: 4 })]);
    expect(store.sources.get(SOURCE_PAGE_ID)?.pageVersion).toBe(4);
  });

  it('a new version with the same text (title or label edit) does not call the LLM', async () => {
    await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(4, '$75'));
    expect(llmCalls).toBe(1);
    const renamed = await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(5, '$75', { page: async () => ({ ...page(5, '$75'), title: 'Travel Policy 2026' }) }));
    expect(renamed).toEqual({ status: 'skipped', reason: 'text unchanged' });
    expect(llmCalls).toBe(1);
    expect(store.sources.get(SOURCE_PAGE_ID)?.pageVersion).toBe(5);
    // The pending change of version 4 is kept; new text is read again.
    expect([...store.changes.values()]).toEqual([expect.objectContaining({ status: 'pending', pageVersion: 4 })]);
    await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(6, '$80'));
    expect(llmCalls).toBe(2);
  });

  it('skips a page that is not a source', async () => {
    store.sources.clear();
    expect(await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(4, '$75'))).toEqual({ status: 'skipped', reason: 'not a source' });
    expect(llmCalls).toBe(0);
  });
});

describe('diff matching does not depend on the model wording (live bug on 9502721)', () => {
  const TP_IDS = TRAVEL_POLICY_FACTS.map((_, i) => `tp-${i + 1}`);
  const tpRow = (f: (typeof TRAVEL_POLICY_FACTS)[number], id: string, quote = f.quote): Row => ({
    ...fact(id, f.subject, f.attribute, f.condition, f.value, f.unit, quote),
    type: f.type as Row['type'],
    pageVersion: 1,
  });
  /** A model answer with other subject/attribute wording for the first 4 facts and `domestic` as the per diem. */
  const reworded = (domestic: string, ids?: readonly (string | null)[]) => ({
    facts: TRAVEL_POLICY_FACTS.map((f, i) => ({
      ...f,
      ...(i < 4 ? { subject: `${f.subject} rules`, attribute: `${f.attribute} limit` } : {}),
      ...(i === 0 ? { value: domestic.slice(1), quote: f.quote.replace('$60', domestic) } : {}),
      ...(ids ? { existing_fact_id: ids[i] ?? null } : {}),
    })),
  });
  const prompts: string[] = [];
  const llm = (answer: unknown): ChatToolFn =>
    (async (messages: Message[], tool: ToolSpec) => {
      llmCalls++;
      prompts.push(String(messages[1]?.content ?? ''));
      expect(tool.parameters).toMatchObject({ properties: { facts: { items: { required: expect.arrayContaining(['existing_fact_id']) } } } });
      return { args: answer, model: 'm' };
    }) as ChatToolFn;
  const tpDeps = (version: number, domestic: string, answer: unknown): DiffDeps => ({
    ...diffDeps(version, domestic),
    page: async () => ({ ...page(version, domestic), body: TRAVEL_POLICY_STORAGE.replace('$60', domestic) }),
    llm: llm(answer),
  });
  const doneLog = () => (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => c[0] === 'ripple diff done').at(-1)?.[1];

  beforeEach(() => {
    prompts.length = 0;
    store.facts = TRAVEL_POLICY_FACTS.map((f, i) => tpRow(f, TP_IDS[i] as string));
    store.copies = [];
    const s = store.sources.get(SOURCE_PAGE_ID);
    if (s) s.pageVersion = 1;
  });

  it('new wording for 4 facts + $60 → $75: one change, nothing inserted, stored wording and keys kept', async () => {
    const r = await runDiffJob(SOURCE_PAGE_ID, 0, tpDeps(2, '$75', reworded('$75')));
    expect(r).toMatchObject({ status: 'done', changed: 1, inserted: 0, missing: 0 });
    expect([...store.changes.values()][0]?.factChanges).toEqual([expect.objectContaining({ factId: 'tp-1', oldValue: '60', newValue: '75' })]);
    expect(store.facts).toHaveLength(5);
    expect(store.facts.map((f) => f.subject)).toEqual(TRAVEL_POLICY_FACTS.map((f) => f.subject));
    expect(doneLog()).toMatchObject({ matchedById: 0, matchedByQuote: 5, matchedByKey: 0, duplicatesRemoved: 0 });
    // The stored facts are offered to the model by id.
    expect(prompts[0]).toContain('<<<KNOWN\ntp-1 | Travel per diem | Amount per day | Domestic travel | The per diem for domestic travel is $60 per day.');
  });

  it('ignores an existing_fact_id of another source or named twice; the quote fallback still matches', async () => {
    const r = await runDiffJob(SOURCE_PAGE_ID, 0, tpDeps(2, '$75', reworded('$75', ['tp-1', 'f-other-source', 'tp-1', null, 'tp-5'])));
    expect(r).toMatchObject({ status: 'done', changed: 1, inserted: 0 });
    expect(doneLog()).toMatchObject({ matchedById: 2, matchedByQuote: 3, matchedByKey: 0 });
    expect(store.facts.map((f) => f.id)).toEqual(TP_IDS);
  });

  it('falls back to the identity key when neither id nor quote matches', async () => {
    const answer = { facts: TRAVEL_POLICY_FACTS.map((f) => (f.subject === 'Flight class' ? { ...f, quote: 'Book economy class for flights under 6 hours.' } : f)) };
    store.facts = store.facts.map((f) => (f.id === 'tp-5' ? { ...f, quote: 'Economy only on short flights, please.' } : f));
    await runDiffJob(SOURCE_PAGE_ID, 0, tpDeps(2, '$60', answer));
    expect(doneLog()).toMatchObject({ matchedByQuote: 4, matchedByKey: 1, inserted: 0 });
  });

  it('recovers the live state: proposed duplicates of an earlier mismatched read are removed, then a change is found', async () => {
    // State after the buggy v2: 5 confirmed facts plus 4 proposed copies with the new wording (domestic at $75).
    const v2 = reworded('$75').facts.slice(0, 4);
    store.facts.push(...v2.map((f, i) => ({ ...tpRow(f, `dup-${i + 1}`), status: 'proposed' as const, pageVersion: 2 })));
    const s = store.sources.get(SOURCE_PAGE_ID);
    if (s) s.pageVersion = 2;
    // v3: back to $60 → no change, duplicates cleaned; they are not offered to the model.
    const v3 = await runDiffJob(SOURCE_PAGE_ID, 0, tpDeps(3, '$60', reworded('$60')));
    expect(v3).toMatchObject({ status: 'done', changeId: null, changed: 0, inserted: 0 });
    expect(doneLog()).toMatchObject({ duplicatesRemoved: 4 });
    expect(prompts[0]).not.toContain('dup-');
    expect(store.facts.map((f) => f.id)).toEqual(TP_IDS);
    // v4: $75 again → one change.
    const v4 = await runDiffJob(SOURCE_PAGE_ID, 0, tpDeps(4, '$75', reworded('$75')));
    expect(v4).toMatchObject({ status: 'done', changed: 1, inserted: 0 });
    expect(store.facts).toHaveLength(5);
  });

  /** Live v3/v4 answer: unchanged sentences, but approval and flight class with other value wording. */
  const rewordedValues = (domestic: string) => ({
    facts: TRAVEL_POLICY_FACTS.map((f, i) => ({
      ...f,
      existing_fact_id: TP_IDS[i] ?? null,
      ...(i === 0 ? { value: domestic.slice(1), quote: f.quote.replace('$60', domestic) } : {}),
      ...(f.subject === 'Trip approval' ? { value: 'Trips over $2,000', unit: null } : {}),
      ...(f.subject === 'Flight class' ? { value: 'economy class for flights under 6 hours' } : {}),
    })),
  });

  it('unchanged sentences with reworded values: no change; $60 → $75 is exactly one change (live v3/v4)', async () => {
    const v2 = await runDiffJob(SOURCE_PAGE_ID, 0, tpDeps(2, '$60', rewordedValues('$60')));
    expect(v2).toMatchObject({ status: 'done', changeId: null, changed: 0, inserted: 0 });
    const v3 = await runDiffJob(SOURCE_PAGE_ID, 0, tpDeps(3, '$75', rewordedValues('$75')));
    expect(v3).toMatchObject({ status: 'done', changed: 1, inserted: 0 });
    expect([...store.changes.values()][0]?.factChanges).toEqual([expect.objectContaining({ factId: 'tp-1', oldValue: '60', newValue: '75' })]);
    // The stored values keep their wording.
    expect(store.facts.find((f) => f.id === 'tp-3')).toMatchObject({ value: '2000', unit: 'USD' });
    expect(store.facts.find((f) => f.id === 'tp-5')).toMatchObject({ value: 'economy class' });
  });

  it('undoes a confirmed wording-only change (old value back, its drifted copies in sync), keeps the real one and the audit', async () => {
    // Live state after confirming v4: approval and flight class hold the reworded values, domestic $75.
    const set = (id: string, value: string, unit: string | null, previousValue: string, quote?: string) => {
      const f = store.facts.find((x) => x.id === id);
      if (f) Object.assign(f, { value, unit, previousValue, pageVersion: 4, ...(quote ? { quote } : {}) });
    };
    set('tp-1', '75', 'USD', '60', TRAVEL_POLICY_FACTS[0]?.quote.replace('$60', '$75'));
    set('tp-3', 'Trips over $2,000', null, '2000');
    set('tp-5', 'economy class for flights under 6 hours', null, 'economy class');
    const fc = (factId: string, oldValue: string, oldUnit: string | null, newValue: string, newUnit: string | null, newQuote: string): FactChange => ({ factId, oldValue, oldUnit, newValue, newUnit, newQuote, version: 4, versionAt: null });
    const q = (i: number) => TRAVEL_POLICY_FACTS[i]?.quote ?? '';
    const impactCopy = (copyId: string, factId: string) => ({ copyId, factId, pageId: '9600001', spaceId: '6979587', status: 'in_sync' as const });
    store.changes.set('ch-1', {
      id: 'ch-1',
      sourcePageId: SOURCE_PAGE_ID,
      status: 'confirmed',
      pageVersion: 4,
      factChanges: [fc('tp-1', '60', 'USD', '75', 'USD', q(0).replace('$60', '$75')), fc('tp-3', '2000', 'USD', 'Trips over $2,000', null, q(2)), fc('tp-5', 'economy class', null, 'economy class for flights under 6 hours', null, q(4))],
      missingFactIds: [],
      impact: { copies: [impactCopy('k-1', 'tp-1'), impactCopy('k-3', 'tp-3')], alreadyNew: 0, syncCopyIds: [], unsure: 0, historical: 0, needsCheck: 0 },
      routing: null,
      deadlineDays: 5,
      createdAt: 'now',
    });
    const copy = (id: string, factId: string) => ({ id, factId, pageId: '9600001', pageTitle: 't', pageUrl: null, status: 'drifted' as CopyStatus, statedValue: null, statedUnit: null, reason: 'r' });
    store.copies = [copy('k-1', 'tp-1'), copy('k-3', 'tp-3')];
    const s = store.sources.get(SOURCE_PAGE_ID);
    if (s) s.pageVersion = 4;

    const v5 = await runDiffJob(SOURCE_PAGE_ID, 0, tpDeps(5, '$75', rewordedValues('$75')));
    expect(v5).toMatchObject({ status: 'done', changeId: null, changed: 0, inserted: 0 });
    expect(store.facts.find((f) => f.id === 'tp-1')).toMatchObject({ value: '75', previousValue: '60' });
    expect(store.facts.find((f) => f.id === 'tp-3')).toMatchObject({ value: '2000', unit: 'USD', previousValue: null });
    expect(store.facts.find((f) => f.id === 'tp-5')).toMatchObject({ value: 'economy class', previousValue: null });
    expect(store.copies.map((c) => [c.id, c.status])).toEqual([
      ['k-1', 'drifted'],
      ['k-3', 'in_sync'],
    ]);
    expect(store.changes.get('ch-1')?.status).toBe('confirmed');
    const reverted = store.audits.filter((a) => a.action === 'change.fact_reverted');
    expect(reverted.map((a) => a.detail?.factId)).toEqual(['tp-3', 'tp-5']);
    // Guarded: a later version does not undo anything twice.
    await runDiffJob(SOURCE_PAGE_ID, 0, tpDeps(6, '$75', rewordedValues('$75')));
    expect(store.audits.filter((a) => a.action === 'change.fact_reverted')).toHaveLength(2);
  });

  it('removes a proposed duplicate of a confirmed fact, but never a proposed sibling fact of the same sentence', () => {
    const quote = 'Domestic travel is $60 per day and international travel is $90 per day.';
    const k = (id: string, status: 'confirmed' | 'proposed', subject: string, condition: string, value: string): KnownFact => ({
      id,
      identityKey: `${subject}|amount|${condition}`.toLowerCase(),
      originKey: null,
      status,
      edited: false,
      value,
      unit: null,
      subject,
      attribute: 'Amount',
      condition,
      quote,
    });
    const known = [
      k('dom', 'confirmed', 'Per diem', 'Domestic', '$60'),
      // Sibling: other condition and value.
      k('intl', 'proposed', 'Per diem', 'International', '$90'),
      // Duplicate reads of the domestic fact: other wording, same condition / same value.
      k('dup-key', 'proposed', 'Per diem rules', 'Domestic', '$75'),
      k('dup-value', 'proposed', 'Daily allowance', 'Home trips', '$60'),
    ];
    const read: ExtractedFact = { type: 'number', subject: 'Per diem', attribute: 'Amount', value: '$60', unit: null, condition: 'Domestic', quote, identityKey: 'per diem|amount|domestic', existingFactId: 'dom' };
    expect(matchFacts(known, [read], new Set(['dom'])).duplicates).toEqual(['dup-key', 'dup-value']);
  });

  it('a failing undo of wording-only confirmations does not block the diff', async () => {
    const changes = { ...store.changeRepo(), confirmedChanges: async () => Promise.reject(new Error('SQL timeout')) };
    const r = await runDiffJob(SOURCE_PAGE_ID, 0, { ...tpDeps(2, '$75', rewordedValues('$75')), changes });
    expect(r).toMatchObject({ status: 'done', changed: 1 });
    expect(console.warn).toHaveBeenCalledWith('ripple diff: undoing wording-only confirmations failed', { pageId: SOURCE_PAGE_ID, error: 'SQL timeout' });
  });

  it('keeps several facts of one sentence apart (same quote): value, then wording decide', () => {
    const quote = 'Domestic travel is $60 per day and international travel is $90 per day.';
    const known: KnownFact[] = [
      { id: 'd', identityKey: 'per diem|amount|domestic', originKey: null, status: 'confirmed', edited: false, value: '$60', unit: null, subject: 'Per diem', attribute: 'Amount', condition: 'Domestic', quote },
      { id: 'i', identityKey: 'per diem|amount|international', originKey: null, status: 'confirmed', edited: false, value: '$90', unit: null, subject: 'Per diem', attribute: 'Amount', condition: 'International', quote },
    ];
    const newQuote = quote.replace('$60', '$75');
    const ex = (value: string, condition: string): ExtractedFact => ({ type: 'number', subject: 'Daily allowance', attribute: 'Rate', value, unit: null, condition, quote: newQuote, identityKey: `daily allowance|rate|${condition.toLowerCase()}` });
    const m = matchFacts(known, [ex('$75', 'Domestic trips'), ex('$90', 'International trips')], new Set());
    expect(m.facts.map((f) => f.identityKey)).toEqual(['per diem|amount|domestic', 'per diem|amount|international']);
    expect(planDiff(known, m.facts, 2).changes.map((c) => c.factId)).toEqual(['d']);
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

  it('a copy without a comparable stated value needs a check and is never propagated automatically', () => {
    const change: FactChange = { factId: 'a', oldValue: '$60', oldUnit: null, newValue: '$75', newUnit: null, newQuote: 'q', version: 2, versionAt: null };
    const copy = (id: string, status: CopyStatus, statedValue: string | null) => ({ id, factId: 'a', pageId: '1', status, statedValue, statedUnit: null });
    const impact: ChangeImpact = computeImpact(
      [change],
      [
        copy('null-sync', 'in_sync', null),
        copy('null-drift', 'drifted', null),
        // Another currency: unknown against both $60 and $75.
        copy('unknown', 'in_sync', '€60'),
        copy('old', 'in_sync', '$60'),
        copy('other', 'drifted', '$50'),
      ],
      new Map(),
    );
    expect(impact.needsCheck).toBe(3);
    expect(impact.copies.map((c) => c.copyId)).toEqual(['old', 'other']);
  });

  it('a copy Ripple already updated is compared with the next change like an in-sync copy', () => {
    const next: FactChange = { factId: 'a', oldValue: '$75', oldUnit: null, newValue: '$80', newUnit: null, newQuote: 'q', version: 3, versionAt: null };
    const impact = computeImpact(
      [next],
      [
        { id: 'upd-old', factId: 'a', pageId: '1', status: 'updated', statedValue: '$75', statedUnit: null },
        { id: 'upd-new', factId: 'a', pageId: '1', status: 'updated', statedValue: '$80', statedUnit: null },
      ],
      new Map(),
    );
    expect(impact.copies.map((c) => [c.copyId, c.status])).toEqual([['upd-old', 'updated']]);
    expect(impact.alreadyNew).toBe(1);
  });

  it('a change of value shape is a change: range, extra numbers, other unit; formatting alone is not', () => {
    const changed = (from: string, to: string, fromUnit: string | null = null, toUnit: string | null = null) =>
      planDiff([stored({ value: from, unit: fromUnit })], [ex(to, toUnit)], 2).changes.length === 1;
    expect(changed('60', '60–90')).toBe(true);
    expect(changed('60', '60-90')).toBe(true);
    expect(changed('60', '60, max 3 days')).toBe(true);
    expect(changed('60 USD', '60 EUR')).toBe(true);
    expect(changed('60 days', '60 weeks')).toBe(true);
    expect(changed('15 Jan 2026', '15 Jan 2026 – 20 Jan 2027')).toBe(true);
    expect(changed('$60', '60 USD')).toBe(false);
    expect(changed('$1,000', '$1000')).toBe(false);
    expect(changed('2026-01-15', '15 Jan 2026')).toBe(false);
  });

  it('factChanged: only the value tokens of the sentence count, not the model wording of the value', () => {
    const approval = 'Trips over $2,000 require manager approval before booking.';
    const old = { value: '2000', unit: 'USD', quote: approval };
    expect(factChanged(old, { value: '$2,000', unit: null, quote: approval })).toBe(false);
    expect(factChanged(old, { value: '2000 USD', unit: null, quote: 'Trips over $2,000 need a manager approval before booking.' })).toBe(false);
    expect(factChanged(old, { value: 'over $2,000', unit: null, quote: 'Trips over $2,000 need a manager approval before booking.' })).toBe(false);
    expect(factChanged(old, { value: '$2,500', unit: null, quote: approval.replace('2,000', '2,500') })).toBe(true);
    expect(factChanged(old, { value: '2000 EUR', unit: null, quote: 'Trips over 2,000 EUR require manager approval before booking.' })).toBe(true);
    const domestic = { value: '60', unit: 'USD', quote: 'The per diem for domestic travel is $60 per day.' };
    expect(factChanged(domestic, { value: '75', unit: 'USD', quote: 'The per diem for domestic travel is $75 per day.' })).toBe(true);
    expect(factChanged(domestic, { value: '60–90', unit: 'USD', quote: 'The per diem for domestic travel is $60–90 per day.' })).toBe(true);
    const flight = { value: 'economy class', unit: null, quote: 'Book economy class for flights under 6 hours.' };
    expect(factChanged(flight, { value: 'economy class for flights under 6 hours', unit: null, quote: flight.quote })).toBe(false);
    expect(factChanged(flight, { value: 'economy class only', unit: null, quote: 'Always book economy class for flights under 6 hours.' })).toBe(false);
    expect(factChanged(flight, { value: 'business class', unit: null, quote: 'Book business class for flights under 6 hours.' })).toBe(true);
    // Dates keep the strict comparison (same day number, other month).
    expect(factChanged({ value: '15 January 2026', unit: null, quote: 'Valid from 15 January 2026.' }, { value: '15 February 2026', unit: null, quote: 'Valid from 15 February 2026.' })).toBe(true);
    // No stored sentence: strict `sameValue`.
    expect(factChanged({ value: '2000', unit: 'USD' }, { value: '$2,000 per booking', unit: null, quote: approval })).toBe(true);
  });

  it('factChanged after review: number order, other words, negation and a unit on one side are changes', () => {
    // Swapped numbers, even when the model repeats the old value.
    const both = { value: '60', unit: 'USD', quote: 'The per diem is $60 and claims are due within 30 days.' };
    const swapped = 'The per diem is $30 and claims are due within 60 days.';
    expect(factChanged(both, { value: '60', unit: 'USD', quote: swapped })).toBe(true);
    expect(factChanged(both, { value: '30', unit: 'USD', quote: swapped })).toBe(true);
    // Same day number, other month (no year: not a date).
    expect(factChanged({ value: '15 January', unit: null, quote: 'Claims close on 15 January.' }, { value: '15 February', unit: null, quote: 'Claims close on 15 February.' })).toBe(true);
    // Negation added to a sentence of a value without digits.
    const approval = { value: 'required', unit: null, quote: 'Manager approval is required for trips abroad.' };
    expect(factChanged(approval, { value: 'not required', unit: null, quote: 'Manager approval is not required for trips abroad.' })).toBe(true);
    expect(factChanged(approval, { value: 'required', unit: null, quote: "Manager approval isn't required for trips abroad." })).toBe(true);
    expect(factChanged(approval, { value: 'approval required', unit: null, quote: 'For trips abroad, manager approval is required.' })).toBe(false);
    // A unit on one side only.
    expect(factChanged({ value: '60', unit: null, quote: 'Claims close 60 after the trip.' }, { value: '60 days', unit: null, quote: 'Claims close 60 days after the trip.' })).toBe(true);
    // Formatting and reordered context stay no change.
    const perDiem = { value: '60', unit: 'USD', quote: 'The per diem for domestic travel is $60 per day.' };
    expect(factChanged(perDiem, { value: '$60', unit: null, quote: 'For domestic travel, the per diem is $60 per day.' })).toBe(false);
    expect(factChanged(perDiem, { value: '60', unit: null, quote: 'For domestic travel the per diem is $60 per day.' })).toBe(false);
  });

  it('wordingOnlyChange (undo) is conservative: a unit on one side, a negation or other words keep the confirmation', () => {
    const c = (oldValue: string, oldUnit: string | null, newValue: string, newUnit: string | null, newQuote: string) => wordingOnlyChange({ oldValue, oldUnit, newValue, newUnit, newQuote });
    // Live cases: undone.
    expect(c('2000', 'USD', 'Trips over $2,000', null, 'Trips over $2,000 require manager approval before booking.')).toBe(true);
    expect(c('economy class', null, 'economy class for flights under 6 hours', null, 'Book economy class for flights under 6 hours.')).toBe(true);
    // Real changes: kept.
    expect(c('60', null, '60 days', null, 'Claims close 60 days after the trip.')).toBe(false);
    expect(c('60', 'USD', '60', null, 'The per diem is 60 per day.')).toBe(false);
    expect(c('required', null, 'not required', null, 'Manager approval is not required.')).toBe(false);
    expect(c('15 January', null, '15 February', null, 'Claims close on 15 February.')).toBe(false);
    expect(c('60', 'USD', '75', 'USD', 'The per diem is $75 per day.')).toBe(false);
    expect(c('economy class', null, 'business class', null, 'Book business class.')).toBe(false);
    // A qualifier or a rate period added to the value is a real change.
    expect(c('30 days', null, '30 business days', null, 'Refunds are paid within 30 business days.')).toBe(false);
    expect(c('60', 'USD per day', '60', 'USD per week', 'The allowance is $60 per week.')).toBe(false);
  });

  it('the rate period is part of the unit: per day → per week (and per hari → per minggu) is a change', () => {
    const day = { value: '$60', unit: 'per day', quote: 'The allowance is $60 per day.' };
    expect(factChanged(day, { value: '$60', unit: 'per week', quote: 'The allowance is $60 per week.' })).toBe(true);
    expect(factChanged(day, { value: '$60', unit: '/day', quote: 'The allowance is $60/day.' })).toBe(false);
    const hari = { value: 'Rp100.000', unit: 'per hari', quote: 'Uang makan Rp100.000 per hari.' };
    expect(factChanged(hari, { value: 'Rp100.000', unit: 'per minggu', quote: 'Uang makan Rp100.000 per minggu.' })).toBe(true);
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

  it('teams come from the space of each copy page, not from the source space', async () => {
    // Source in space 7 (PLAT); the copy page is in ACCORD (6979587). pageMeta would say PLAT: the copy space wins.
    await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(4, '$75', { spaceOf: async () => '6979587' }));
    const asked: unknown[] = [];
    const graph = () => async (_q: string, variables: Record<string, unknown>) => {
      asked.push(variables.spaceAri);
      const name = String(variables.spaceAri).endsWith('/6979587') ? 'Accord Team' : 'Platform Team';
      return { body: { data: { atlassianTeamsBySpace: { edges: [{ node: { id: name, displayName: name } }] } } } };
    };
    const r = (await getPendingChange(ctx, changeDeps({ graph, pageMeta: async (id) => ({ spaceId: '7', ownerId: `owner-${id}` }) }))) as PendingChangeReply;
    expect(r.change?.pages.map((p) => p.spaceId)).toEqual(['6979587']);
    expect(r.change?.spaces).toEqual([{ spaceId: '6979587', teams: [{ id: 'Accord Team', name: 'Accord Team' }], teamSource: 'teamwork_graph' }]);
    expect(asked).toEqual(['ari:cloud:confluence:cloud-1:space/6979587']);
  });

  it('a failed team read is "unknown", not "no team"; confirm reads it again and records unknown without team ids', async () => {
    const failed = { body: { errors: [{ message: 'User is not permitted to query this organization' }], data: null } };
    const id = await pendingId();
    const r = (await getPendingChange(ctx, changeDeps({ graph: () => async () => failed }))) as PendingChangeReply;
    expect(r.change?.spaces).toEqual([{ spaceId: 'S-9600001', teams: [], teamSource: 'unknown' }]);
    const thrown = (await getPendingChange(ctx, changeDeps({ graph: () => async () => Promise.reject(new Error('HTTP 503')) }))) as PendingChangeReply;
    expect(thrown.change?.spaces[0]?.teamSource).toBe('unknown');
    // Confirm: the first read fails, the second one finds the team.
    let calls = 0;
    const flaky = () => async () => (++calls === 1 ? failed : { body: teams });
    await confirmChange(ctx, { changeId: id, version: 4 }, changeDeps({ graph: flaky }));
    expect(calls).toBe(2);
    expect(store.changes.get(id)?.routing?.spaces).toEqual([{ spaceId: 'S-9600001', teamIds: ['team-1'], teamSource: 'teamwork_graph', teams: [{ id: 'team-1', name: 'People Ops' }] }]);
  });

  it('confirm with teams still unreadable records them as unknown', async () => {
    const id = await pendingId();
    const failed = { body: { errors: [{ message: 'denied' }], data: null } };
    await confirmChange(ctx, { changeId: id, version: 4 }, changeDeps({ graph: () => async () => failed }));
    expect(store.changes.get(id)?.routing?.spaces).toEqual([{ spaceId: 'S-9600001', teamIds: [], teamSource: 'unknown', teams: [] }]);
    expect(store.audits.find((a) => a.action === 'change.confirmed')?.detail).toMatchObject({ teamSource: { unknown: 1 } });
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
    expect(await confirmChange(ctx, { changeId: id, version: 4 }, changeDeps({ canEdit: async () => false }))).toEqual({ error: expect.stringContaining('edit permission') });
    expect(await confirmChange({ ...ctx, accountId: undefined }, { changeId: id, version: 4 }, changeDeps())).toEqual({ error: expect.stringContaining('edit permission') });
    expect(await confirmChange(ctx, { changeId: id }, changeDeps())).toEqual({ error: 'Missing or invalid page version.' });
    expect(store.changes.get(id)?.status).toBe('pending');
    expect(store.facts.find((f) => f.id === FACT_IDS.domestic)?.value).toBe('$60');
  });

  it('confirmChange sets the new value, keeps the old one, restatuses copies and audits owner/team sources', async () => {
    const id = await pendingId();
    expect(await confirmChange(ctx, { changeId: id, version: 4, deadlineDays: 31 }, changeDeps())).toEqual({ error: expect.stringContaining('1 to 30') });
    expect(await confirmChange(ctx, { changeId: id, version: 3 }, changeDeps())).toEqual({ error: expect.stringContaining('Review it again') });
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
      spaces: [{ spaceId: 'S-9600001', teamIds: ['team-1'], teamSource: 'teamwork_graph', teams: [{ id: 'team-1', name: 'People Ops' }] }],
    });
    const audit = store.audits.find((a) => a.action === 'change.confirmed');
    expect(audit?.detail).toMatchObject({ factsUpdated: 1, deadlineDays: 3, ownerSource: { owner: 1 }, teamSource: { teamwork_graph: 1 } });
    // Decided: a repeated confirm (double click) succeeds without doing anything twice; a dismiss finds nothing pending.
    const audits = store.audits.length;
    expect(await confirmChange(ctx, { changeId: id, version: 4 }, changeDeps())).toEqual({ changeId: id, status: 'confirmed', factsUpdated: 0, copiesDrifted: 0, deadline: '2026-11-12' });
    expect(store.audits).toHaveLength(audits);
    expect(await dismissChange(ctx, { changeId: id, version: 4 }, changeDeps())).toEqual({ error: expect.stringContaining('already decided') });
  });

  it('confirm rejects open proposals of older changes as superseded; getLatestChange returns the confirmed change', async () => {
    const id = await pendingId();
    expect(await getLatestChange(ctx, changeDeps())).toEqual({ pageId: SOURCE_PAGE_ID, change: null });
    const superseded: { changeId: string; factIds: readonly string[] }[] = [];
    const deps = changeDeps({
      supersedeProposals: async (_s, changeId, factIds) => {
        superseded.push({ changeId, factIds });
        return 2;
      },
    });
    await confirmChange(ctx, { changeId: id, version: 4 }, deps);
    expect(superseded).toEqual([{ changeId: id, factIds: [FACT_IDS.domestic] }]);
    expect(store.audits.find((a) => a.action === 'proposal.superseded')?.detail).toMatchObject({ proposals: 2 });
    expect(await getLatestChange(ctx, changeDeps())).toEqual({ pageId: SOURCE_PAGE_ID, change: { changeId: id, version: 4 } });
    expect(await getLatestChange({ ...ctx, extension: {} }, changeDeps())).toEqual({ error: expect.any(String) });
  });

  it('confirm of a change replaced by a newer version meanwhile: "review it again", nothing applied', async () => {
    const id = await pendingId();
    // The user reviewed version 4 ($75); version 5 ($80) replaces the row before they click.
    await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(5, '$80'));
    expect(await confirmChange(ctx, { changeId: id, version: 4 }, changeDeps())).toEqual({ error: expect.stringContaining('Review it again') });
    expect(await dismissChange(ctx, { changeId: id, version: 4 }, changeDeps())).toEqual({ error: expect.stringContaining('Review it again') });
    expect(store.changes.get(id)).toMatchObject({ status: 'pending', pageVersion: 5 });
    expect(store.facts.find((f) => f.id === FACT_IDS.domestic)?.value).toBe('$60');
    // The version check is also in the status flip (a diff landing between read and write).
    const base = changeDeps();
    const racing: ChangeDeps = {
      ...base,
      changes: {
        ...base.changes,
        decide: async (...args) => {
          await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(6, '$85'));
          return base.changes.decide(...args);
        },
      },
    };
    expect(await confirmChange(ctx, { changeId: id, version: 5 }, racing)).toEqual({ error: expect.stringContaining('Review it again') });
    expect(store.changes.get(id)).toMatchObject({ status: 'pending', pageVersion: 6 });
    expect(store.facts.find((f) => f.id === FACT_IDS.domestic)?.value).toBe('$60');
  });

  it('confirm after a failure between the status flip and the copy updates: the repeat finishes the work', async () => {
    const id = await pendingId();
    const base = changeDeps();
    const crashing: ChangeDeps = {
      ...base,
      changes: {
        ...base.changes,
        restatusCopies: async () => {
          throw new Error('SQL down');
        },
      },
    };
    expect(await confirmChange(ctx, { changeId: id, version: 4 }, crashing)).toEqual({ error: expect.stringContaining('SQL down') });
    expect(store.changes.get(id)?.status).toBe('confirmed');
    expect(store.facts.find((f) => f.id === FACT_IDS.domestic)?.value).toBe('$75');
    expect(store.copies.find((c) => c.id === 'c-9600001-domestic')?.status).toBe('in_sync');
    // The retry: facts are already applied (factsUpdated 0) but the copy stating $60 still becomes drifted.
    const r = (await confirmChange(ctx, { changeId: id, version: 4 }, changeDeps())) as ChangeDecision;
    expect(r).toMatchObject({ status: 'confirmed', factsUpdated: 0, copiesDrifted: 1 });
    expect(store.copies.find((c) => c.id === 'c-9600001-domestic')?.status).toBe('drifted');
    expect(store.copies.find((c) => c.id === 'c-9600003-domestic')?.status).toBe('in_sync');
  });

  it('confirm routes every affected copy, also on pages the confirming user cannot open', async () => {
    const id = await pendingId();
    const visible = vi.fn(async () => new Set<string>());
    const r = (await confirmChange(ctx, { changeId: id, version: 4 }, changeDeps({ visible, pageMeta: async () => Promise.reject(new Error('HTTP 404')) }))) as ChangeDecision;
    expect(r).toMatchObject({ status: 'confirmed', copiesDrifted: 1 });
    expect(visible).not.toHaveBeenCalled();
    expect(store.changes.get(id)?.routing?.pages).toEqual([{ pageId: '9600001', spaceId: 'S-9600001', ownerAccountId: null, ownerRole: null, copies: 1 }]);
    expect(store.copies.find((c) => c.id === 'c-9600001-domestic')?.status).toBe('drifted');
  });

  it('dismissChange: permission, then dismissed with an audit row; facts unchanged', async () => {
    const id = await pendingId();
    expect(await dismissChange(ctx, { changeId: id, version: 4 }, changeDeps({ canEdit: async () => false }))).toEqual({ error: expect.stringContaining('edit permission') });
    expect(await dismissChange(ctx, { changeId: 'nope', version: 4 }, changeDeps())).toEqual({ error: 'Missing or invalid change id.' });
    expect(await dismissChange(ctx, { changeId: id }, changeDeps())).toEqual({ error: 'Missing or invalid page version.' });
    // A change of another page is "gone" from this page's context.
    expect(await dismissChange({ ...ctx, extension: { content: { id: '42' } } }, { changeId: id, version: 4 }, changeDeps())).toEqual({ error: expect.stringContaining('already decided') });
    const r = (await dismissChange(ctx, { changeId: id, version: 4 }, changeDeps())) as ChangeDecision | ErrorReply;
    expect(r).toEqual({ changeId: id, status: 'dismissed', factsUpdated: 0, copiesDrifted: 0, deadline: null });
    expect(store.changes.get(id)?.status).toBe('dismissed');
    expect(store.facts.find((f) => f.id === FACT_IDS.domestic)?.value).toBe('$60');
    expect(store.audits.map((a) => a.action)).toContain('change.dismissed');
  });

  it('a dismissed value is not raised again by a later edit; another value still is', async () => {
    const id = await pendingId();
    await dismissChange(ctx, { changeId: id, version: 4 }, changeDeps());
    // Version 5: the page still says $75 plus an unrelated edit (new text, so the LLM reads it).
    const again = await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(5, '$75', { page: async () => ({ ...page(5, '$75'), body: `${bodyOf('$75')}<p>Ask Finance.</p>` }) }));
    expect(again).toMatchObject({ status: 'done', changeId: null, changed: 0 });
    expect([...store.changes.values()].filter((c) => c.status === 'pending')).toHaveLength(0);
    const other = await runDiffJob(SOURCE_PAGE_ID, 0, diffDeps(6, '$80'));
    expect(other).toMatchObject({ status: 'done', changed: 1 });
    expect([...store.changes.values()].find((c) => c.status === 'pending')?.factChanges[0]?.newValue).toBe('$80');
  });
});
