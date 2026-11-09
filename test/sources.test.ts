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

import { randomUUID } from 'node:crypto';
import type { FactRepo, MarkInput } from '../src/adapters/repo';
import type { StoredFact } from '../src/core/facts';
import { SchemaSettingUpError } from '../src/core/schema';
import type { FactView, SourceView } from '../src/core/views';
import { LlmOutputError } from '../src/llm';
import type { ChatToolFn } from '../src/llm/extract';
import {
  confirmFact,
  editFact,
  getSourceStatus,
  listFacts,
  markSource,
  rejectFact,
  runExtractJob,
  unmarkSource,
  type ExtractDeps,
  type SourceContext,
  type SourceDeps,
} from '../src/surfaces/sources';
import { TRAVEL_POLICY_FACTS, TRAVEL_POLICY_STORAGE } from './fixtures/travelPolicy';

type Row = FactView & { sourcePageId: string; identityKey: string };

/** In-memory `FactRepo` with the same semantics as the SQL one. */
class FakeRepo implements FactRepo {
  sources = new Map<string, SourceView>();
  facts = new Map<string, Row>();
  audits: { action: string; actor: string | null; subjectId: string; detail?: Record<string, unknown> }[] = [];

  async getSource(pageId: string) {
    return this.sources.get(pageId);
  }
  async markSource(input: MarkInput) {
    const old = this.sources.get(input.pageId);
    this.sources.set(input.pageId, { pageId: input.pageId, title: old?.title ?? input.title, state: 'extracting', pageVersion: old?.pageVersion ?? null, markedAt: old?.markedAt ?? 'now', extractedAt: old?.extractedAt ?? null, error: null });
  }
  async setExtractJob() {}
  async finishExtraction(pageId: string, page: { title: string; version: number }) {
    const s = this.sources.get(pageId);
    if (s) this.sources.set(pageId, { ...s, state: 'ready', title: page.title, pageVersion: page.version, extractedAt: 'now', error: null });
  }
  async failExtraction(pageId: string, error: string) {
    const s = this.sources.get(pageId);
    if (s) this.sources.set(pageId, { ...s, state: 'error', error });
  }
  async unmarkSource(pageId: string) {
    for (const [id, f] of this.facts) if (f.sourcePageId === pageId) this.facts.delete(id);
    this.sources.delete(pageId);
  }
  private of(pageId: string) {
    return [...this.facts.values()].filter((f) => f.sourcePageId === pageId);
  }
  async listFacts(pageId: string) {
    return this.of(pageId);
  }
  async storedFacts(pageId: string): Promise<StoredFact[]> {
    return this.of(pageId).map((f) => ({ id: f.id, identityKey: f.identityKey, status: f.status, edited: f.edited, value: f.value, unit: f.unit }));
  }
  async countFacts(pageId: string) {
    const c = { proposed: 0, confirmed: 0, rejected: 0 };
    for (const f of this.of(pageId)) c[f.status]++;
    return c;
  }
  async getFact(id: string) {
    const f = this.facts.get(id);
    return f ? { ...f } : undefined;
  }
  async applyMerge(pageId: string, plan: Parameters<FactRepo['applyMerge']>[1], page: { version: number; versionAt: string | null }) {
    for (const id of plan.remove) this.facts.delete(id);
    for (const u of plan.update) {
      const f = this.facts.get(u.id);
      if (!f) continue;
      const fields = u.refreshOnly ? {} : { type: u.fact.type, subject: u.fact.subject, attribute: u.fact.attribute, value: u.fact.value, unit: u.fact.unit, condition: u.fact.condition, status: u.status, previousValue: u.previousValue ?? f.previousValue };
      this.facts.set(u.id, { ...f, ...fields, quote: u.fact.quote, pageVersion: page.version, effectiveSince: page.versionAt });
    }
    for (const x of plan.insert) {
      const id = randomUUID();
      this.facts.set(id, { id, sourcePageId: pageId, identityKey: x.identityKey, type: x.type, subject: x.subject, attribute: x.attribute, value: x.value, unit: x.unit, condition: x.condition, quote: x.quote, status: 'proposed', edited: false, previousValue: null, pageVersion: page.version, effectiveSince: page.versionAt });
    }
  }
  async setFactStatus(id: string, status: FactView['status']) {
    const f = this.facts.get(id);
    if (f) this.facts.set(id, { ...f, status });
  }
  async editFact(id: string, pageId: string, e: Parameters<FactRepo['editFact']>[2]) {
    if (this.of(pageId).some((f) => f.id !== id && f.identityKey === e.identityKey)) return false;
    const f = this.facts.get(id);
    if (f) this.facts.set(id, { ...f, subject: e.subject, attribute: e.attribute, value: e.value, unit: e.unit, condition: e.condition, identityKey: e.identityKey, edited: true, status: 'confirmed' });
    return true;
  }
  async audit(action: string, actor: string | null, _type: string, subjectId: string, detail?: Record<string, unknown>) {
    this.audits.push({ action, actor, subjectId, detail });
  }
}

const PAGE = '1001';
const ctx: SourceContext = { accountId: 'acc-1', extension: { content: { id: PAGE }, space: { id: 7 } } };
let repo: FakeRepo;
let canEdit: ReturnType<typeof vi.fn<(pageId: string) => Promise<boolean>>>;
let enqueue: ReturnType<typeof vi.fn<(pageId: string) => Promise<string>>>;
let deps: SourceDeps;

const llmReturning = (facts: unknown[]): ChatToolFn => (async () => ({ args: { facts }, model: 'claude-sonnet-5' })) as unknown as ChatToolFn;
const extractDeps = (llm: ChatToolFn, body = TRAVEL_POLICY_STORAGE, version = 3): ExtractDeps => ({
  repo,
  llm,
  ensure: async () => undefined,
  page: async (id) => ({ id, title: 'Travel Policy', spaceId: '7', version, versionCreatedAt: '2026-11-01T10:00:00.000Z', body }),
});

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  repo = new FakeRepo();
  canEdit = vi.fn(async () => true);
  enqueue = vi.fn(async () => 'job-9');
  deps = { repo, canEdit, enqueue, ensure: async () => undefined };
});

describe('markSource / unmarkSource (FR-1)', () => {
  it('marks, queues extraction and audits for a user who can edit the page', async () => {
    const r = await markSource(ctx, deps);
    expect(r).toMatchObject({ pageId: PAGE, canEdit: true, source: { state: 'extracting' } });
    expect(enqueue).toHaveBeenCalledWith(PAGE);
    expect(canEdit).toHaveBeenCalledWith(PAGE);
    expect(repo.audits).toEqual([expect.objectContaining({ action: 'source.marked', actor: 'acc-1', subjectId: PAGE })]);
  });

  it('refuses mark and unmark without edit permission, and without a user', async () => {
    canEdit.mockResolvedValue(false);
    expect(await markSource(ctx, deps)).toEqual({ error: expect.stringContaining('edit permission') });
    expect(await unmarkSource(ctx, deps)).toEqual({ error: expect.stringContaining('edit permission') });
    canEdit.mockResolvedValue(true);
    expect(await markSource({ ...ctx, accountId: undefined }, deps)).toHaveProperty('error');
    expect(enqueue).not.toHaveBeenCalled();
    expect(repo.sources.size).toBe(0);
  });

  it('unmark deletes the source and its facts', async () => {
    await markSource(ctx, deps);
    await runExtractJob(PAGE, 0, extractDeps(llmReturning(TRAVEL_POLICY_FACTS)));
    const r = await unmarkSource(ctx, deps);
    expect(r).toMatchObject({ source: null, counts: { proposed: 0, confirmed: 0, rejected: 0 } });
    expect(repo.facts.size).toBe(0);
    expect(repo.audits.at(-1)).toMatchObject({ action: 'source.unmarked', detail: { proposed: 5 } });
  });

  it('getSourceStatus reports a schema still setting up as a notice', async () => {
    const r = await getSourceStatus(ctx, {
      ...deps,
      ensure: async () => {
        throw new SchemaSettingUpError(2, 4);
      },
    });
    expect(r).toMatchObject({ source: null, notice: expect.stringContaining('2/4') });
  });

  it('needs a page in the context', async () => {
    expect(await getSourceStatus({ accountId: 'a' }, deps)).toEqual({ error: expect.stringContaining('Open a Confluence page') });
  });
});

describe('extract consumer (FR-2)', () => {
  it('stores the five Travel Policy facts as proposed, with page version and effective date', async () => {
    await markSource(ctx, deps);
    const out = await runExtractJob(PAGE, 0, extractDeps(llmReturning(TRAVEL_POLICY_FACTS)));
    expect(out).toMatchObject({ status: 'done', facts: 5, inserted: 5, dropped: 0 });
    const status = await getSourceStatus(ctx, deps);
    expect(status).toMatchObject({ source: { state: 'ready', pageVersion: 3, title: 'Travel Policy' }, counts: { proposed: 5 } });
    const list = await listFacts(ctx, deps);
    if ('error' in list) throw new Error(list.error);
    expect(list.facts.map((f) => `${f.value} ${f.unit ?? ''}`.trim())).toEqual(['60 USD', '90 USD', '2000 USD', '30 days after the trip ends', 'economy class']);
    expect(list.facts.every((f) => f.status === 'proposed' && f.pageVersion === 3 && f.effectiveSince === '2026-11-01T10:00:00.000Z')).toBe(true);
  });

  it('never stores a fact whose quote is not on the page', async () => {
    await markSource(ctx, deps);
    const fake = { ...TRAVEL_POLICY_FACTS[0], value: '75', quote: 'The per diem for domestic travel is $75 per day.' };
    const out = await runExtractJob(PAGE, 0, extractDeps(llmReturning([fake, TRAVEL_POLICY_FACTS[1]])));
    expect(out).toMatchObject({ status: 'done', facts: 1, dropped: 1 });
    expect([...repo.facts.values()].map((f) => f.value)).toEqual(['90']);
  });

  it('re-extraction keeps confirmed facts and dedups by identity key', async () => {
    await markSource(ctx, deps);
    await runExtractJob(PAGE, 0, extractDeps(llmReturning(TRAVEL_POLICY_FACTS)));
    const first = [...repo.facts.values()];
    await repo.setFactStatus(first[0]!.id, 'confirmed');
    await runExtractJob(PAGE, 0, extractDeps(llmReturning([...TRAVEL_POLICY_FACTS, { ...TRAVEL_POLICY_FACTS[0], subject: 'TRAVEL per diem' }]), TRAVEL_POLICY_STORAGE, 4));
    expect(repo.facts.size).toBe(5);
    expect(repo.facts.get(first[0]!.id)).toMatchObject({ status: 'confirmed', pageVersion: 4 });
  });

  it('skips pages that were unmarked before the job ran', async () => {
    expect(await runExtractJob(PAGE, 0, extractDeps(llmReturning([])))).toEqual({ status: 'skipped', reason: 'not a source (unmarked)' });
  });

  it('retries on LLM 429 with backoff, then fails the source', async () => {
    await markSource(ctx, deps);
    const busy = (async () => {
      throw Object.assign(new (await import('@forge/llm')).ForgeLlmError('busy'), { status: 429 });
    }) as unknown as ChatToolFn;
    expect(await runExtractJob(PAGE, 1, extractDeps(busy))).toEqual({ status: 'retry', seconds: 60, reason: 'llm-rate-limited' });
    expect(await runExtractJob(PAGE, 4, extractDeps(busy))).toMatchObject({ status: 'failed' });
    expect(repo.sources.get(PAGE)).toMatchObject({ state: 'error', error: expect.stringContaining('busy') });
  });

  it('marks the source as failed on an unusable model answer, and waits for the schema', async () => {
    await markSource(ctx, deps);
    const bad = (async () => {
      throw new LlmOutputError('LLM did not call record_facts (no tool call)');
    }) as unknown as ChatToolFn;
    expect(await runExtractJob(PAGE, 0, extractDeps(bad))).toMatchObject({ status: 'failed', error: expect.stringContaining('unusable answer') });
    const notReady: ExtractDeps = {
      ...extractDeps(bad),
      ensure: async () => {
        throw new SchemaSettingUpError(1, 4);
      },
    };
    expect(await runExtractJob(PAGE, 0, notReady)).toEqual({ status: 'retry', seconds: 60, reason: 'schema' });
  });
});

describe('fact review (FR-3)', () => {
  async function extracted(): Promise<FactView[]> {
    await markSource(ctx, deps);
    await runExtractJob(PAGE, 0, extractDeps(llmReturning(TRAVEL_POLICY_FACTS)));
    const list = await listFacts(ctx, deps);
    if ('error' in list) throw new Error(list.error);
    return list.facts;
  }

  it('confirms, rejects and edits with audit rows', async () => {
    const [a, b, c] = (await extracted()) as [FactView, FactView, FactView];
    expect(await confirmFact(ctx, { factId: a.id }, deps)).toMatchObject({ fact: { id: a.id, status: 'confirmed' } });
    expect(await rejectFact(ctx, { factId: b.id }, deps)).toMatchObject({ fact: { id: b.id, status: 'rejected' } });
    const edited = await editFact(ctx, { factId: c.id, subject: c.subject, attribute: c.attribute, value: '2500', unit: 'USD', condition: c.condition }, deps);
    expect(edited).toMatchObject({ fact: { value: '2500', edited: true, status: 'confirmed' } });
    expect(repo.audits.map((x) => x.action).slice(-3)).toEqual(['fact.confirmed', 'fact.rejected', 'fact.edited']);
  });

  it('rejects an edit that collides with another fact identity key', async () => {
    const [a, b] = (await extracted()) as [FactView, FactView];
    const r = await editFact(ctx, { factId: b.id, subject: a.subject, attribute: a.attribute, value: '1', unit: null, condition: a.condition }, deps);
    expect(r).toEqual({ error: expect.stringContaining('same subject, attribute and condition') });
  });

  it('refuses review without edit permission, for another page, or with a bad id', async () => {
    const [a] = (await extracted()) as [FactView];
    canEdit.mockResolvedValue(false);
    expect(await confirmFact(ctx, { factId: a.id }, deps)).toEqual({ error: expect.stringContaining('edit permission') });
    canEdit.mockResolvedValue(true);
    const other: SourceContext = { ...ctx, extension: { content: { id: '2002' } } };
    expect(await rejectFact(other, { factId: a.id }, deps)).toEqual({ error: expect.stringContaining('no longer exists') });
    expect(await confirmFact(ctx, { factId: 'nope' }, deps)).toEqual({ error: 'Missing or invalid fact id.' });
    expect(repo.facts.get(a.id)?.status).toBe('proposed');
  });

  it('turns repository failures into a scrubbed error reply', async () => {
    const failing = { ...deps, repo: Object.assign(new FakeRepo(), { listFacts: async () => Promise.reject(new Error('db down for 557058:12345678-1234-1234-1234-123456789abc')) }) };
    expect(await listFacts(ctx, failing)).toEqual({ error: 'Ripple could not load the facts: db down for <accountId>' });
  });
});
