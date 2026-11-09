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

import { ForgeLlmError, type Message } from '@forge/llm';
import type { SearchHit } from '../src/adapters/confluence';
import type { FactRepo } from '../src/adapters/repo';
import { EMPTY_COPY_COUNTS, type CopyInput, type HitInput, type PendingPage, type ScanRepo, type ScanRow } from '../src/adapters/scanRepo';
import {
  buildCql,
  chunkPage,
  cleanTerm,
  compareValues,
  decideStatus,
  factTerms,
  MAX_CANDIDATES_PER_FACT,
  normaliseValue,
  parseJudgement,
  strongest,
  type Judgement,
  type ScanFact,
} from '../src/core/copies';
import type { CopyStatus, CopyView, FactView, SourceView } from '../src/core/views';
import type { ChatToolFn } from '../src/llm/extract';
import type { ToolSpec } from '../src/llm/index';
import { getScanStatus, JUDGE_QUEUE, listCopies, runJudgeJob, runSearchJob, SEARCH_QUEUE, startScan, type CopyDeps, type ScanJobDeps, type ScanQueue } from '../src/surfaces/copies';
import type { SourceContext } from '../src/surfaces/sources';
import { COPY_PAGES, FACT_KEYS, SOURCE_PAGE_ID, type FactKey } from './fixtures/copies';
import { TRAVEL_POLICY_FACTS } from './fixtures/travelPolicy';

// ---------------------------------------------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------------------------------------------

const KEYS: FactKey[] = ['domestic', 'international', 'approval', 'claims', 'flight'];
const factId = (k: FactKey): string => `f-${KEYS.indexOf(k) + 1}-${k}`;
const FACTS: ScanFact[] = TRAVEL_POLICY_FACTS.map((f, i) => ({
  id: factId(KEYS[i] as FactKey),
  type: f.type as ScanFact['type'],
  subject: f.subject,
  attribute: f.attribute,
  value: f.value,
  unit: f.unit,
  condition: f.condition,
  previousValue: null,
}));
const fact = (k: FactKey): ScanFact => FACTS[KEYS.indexOf(k)] as ScanFact;

const judgement = (k: FactKey, over: Partial<Judgement>): Judgement => ({
  factId: factId(k),
  sameFact: 'yes',
  mention: 'current',
  statedValue: '',
  statedUnit: null,
  statedCondition: null,
  quote: '',
  ...over,
});

/** `FactRepo` subset the scan uses: one ready source with the five Travel Policy facts. */
class FakeFacts {
  sources = new Map<string, SourceView>([[SOURCE_PAGE_ID, { pageId: SOURCE_PAGE_ID, title: 'Travel Policy', state: 'ready', pageVersion: 3, markedAt: 'now', extractedAt: 'now', error: null }]]);
  status: FactView['status'] = 'confirmed';
  audits: string[] = [];
  async getSource(pageId: string) {
    return this.sources.get(pageId);
  }
  async listFacts(pageId: string): Promise<FactView[]> {
    if (!this.sources.has(pageId)) return [];
    // Reverse order on purpose: the scan sorts by id itself.
    return [...FACTS].reverse().map((f) => ({ ...f, quote: 'q', status: this.status, edited: false, pageVersion: 3, effectiveSince: null }));
  }
  async audit(action: string) {
    this.audits.push(action);
  }
}

/** In-memory `ScanRepo` with the SQL semantics (idempotent hits, sticky ignored/updated copies). */
class FakeScans implements ScanRepo {
  scans = new Map<string, ScanRow>();
  hits: (HitInput & { scanId: string; status: 'pending' | 'done' })[] = [];
  copies = new Map<string, CopyInput & { sourcePageId: string; scanId: string }>();
  private n = 0;
  stall = false;

  async latestScan(sourcePageId: string) {
    const all = [...this.scans.values()].filter((s) => s.sourcePageId === sourcePageId);
    const s = all[all.length - 1];
    return s ? { ...s, stalled: this.stall && (s.state === 'searching' || s.state === 'judging') } : undefined;
  }
  async getScan(id: string) {
    const s = this.scans.get(id);
    return s ? { ...s } : undefined;
  }
  async createScan(sourcePageId: string, factsTotal: number, _actor: string) {
    const id = `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
    this.scans.set(id, { id, sourcePageId, state: 'searching', stalled: false, factsTotal, factsSearched: 0, factCursor: 0, terms: null, candidates: 0, pagesJudged: 0, startedAt: 'now', finishedAt: null, error: null });
    return id;
  }
  private patch(id: string, p: Partial<ScanRow>) {
    const s = this.scans.get(id);
    if (s) this.scans.set(id, { ...s, ...p });
  }
  async touchScan() {}
  async setTerms(id: string, terms: Record<string, string[]>) {
    this.patch(id, { terms });
  }
  async addHits(scanId: string, hits: readonly HitInput[]) {
    for (const h of hits) if (!this.hits.some((x) => x.scanId === scanId && x.factId === h.factId && x.pageId === h.pageId)) this.hits.push({ ...h, scanId, status: 'pending' });
  }
  async advanceSearch(id: string, cursor: number) {
    this.patch(id, { factCursor: cursor, factsSearched: cursor, candidates: new Set(this.hits.filter((h) => h.scanId === id).map((h) => h.pageId)).size });
  }
  async startJudging(id: string) {
    this.patch(id, { state: 'judging' });
  }
  async pendingPages(scanId: string, limit: number): Promise<PendingPage[]> {
    const pending = this.hits.filter((h) => h.scanId === scanId && h.status === 'pending');
    const ids = [...new Set(pending.map((h) => h.pageId))].sort().slice(0, limit);
    return ids.map((pageId) => {
      const own = pending.filter((h) => h.pageId === pageId);
      return { pageId, title: own[0]?.title ?? '', url: own[0]?.url ?? null, factIds: own.map((h) => h.factId) };
    });
  }
  async finishPage(scanId: string, sourcePageId: string, pageId: string, copies: readonly CopyInput[]) {
    for (const c of copies) {
      const key = `${c.factId}|${c.pageId}`;
      const old = this.copies.get(key);
      if (old && (old.status === 'ignored' || old.status === 'updated')) this.copies.set(key, { ...old, scanId });
      else this.copies.set(key, { ...c, sourcePageId, scanId });
    }
    let changed = 0;
    for (const h of this.hits) if (h.scanId === scanId && h.pageId === pageId && h.status === 'pending') (h.status = 'done'), changed++;
    const s = this.scans.get(scanId);
    if (s && changed > 0) this.patch(scanId, { pagesJudged: s.pagesJudged + 1 });
  }
  async finishScan(scanId: string, sourcePageId: string) {
    for (const [k, c] of this.copies) if (c.sourcePageId === sourcePageId && c.scanId !== scanId && c.status !== 'ignored' && c.status !== 'updated') this.copies.delete(k);
    this.patch(scanId, { state: 'done', finishedAt: 'now' });
    this.hits = this.hits.filter((h) => h.scanId !== scanId);
  }
  async failScan(id: string, error: string) {
    this.patch(id, { state: 'error', error });
  }
  async countCopies(sourcePageId: string) {
    const counts = { ...EMPTY_COPY_COUNTS };
    for (const c of this.copies.values()) if (c.sourcePageId === sourcePageId) counts[c.status]++;
    return counts;
  }
  async listCopies(sourcePageId: string, status?: CopyStatus): Promise<CopyView[]> {
    return [...this.copies.values()]
      .filter((c) => c.sourcePageId === sourcePageId && (status ? c.status === status : c.status !== 'historical'))
      .map((c) => ({ id: `${c.factId}|${c.pageId}`, factId: c.factId, factLabel: '', officialValue: '', officialUnit: null, pageId: c.pageId, pageTitle: c.pageTitle, pageUrl: c.pageUrl, status: c.status, statedValue: c.statedValue, statedUnit: c.statedUnit, statedCondition: c.statedCondition, quote: c.quote, reason: c.reason, judgedAt: null }));
  }
  statusOf(k: FactKey, pageId: string): CopyStatus | null {
    return this.copies.get(`${factId(k)}|${pageId}`)?.status ?? null;
  }
}

const MENTIONS = COPY_PAGES.flatMap((p) => p.judge);
const FACT_LINE = /^(\d+)\. (.+?) \| .+? \| official value: .+? \| condition: (.+)$/gm;

/** Fake LLM: synonyms for the terms call; for a chunk, the fixture mentions whose quote is in it (numbered as in the prompt). */
function fakeLlm(calls: { tool: string; chunk?: string }[], override?: (chunk: string) => unknown): ChatToolFn {
  return (async (messages: Message[], tool: ToolSpec) => {
    const user = String(messages[1]?.content ?? '');
    if (tool.name === 'record_search_terms') {
      calls.push({ tool: tool.name });
      return { args: { facts: [{ fact: 1, terms: ['daily allowance', 'meal "allowance"'] }] }, model: 'claude-sonnet-5' };
    }
    const chunk = user.split('<<<PAGE\n')[1]?.split('\nPAGE>>>')[0] ?? '';
    calls.push({ tool: tool.name, chunk });
    if (override) return { args: override(chunk), model: 'claude-sonnet-5' };
    const numbers = new Map<FactKey, number>();
    for (const m of user.matchAll(FACT_LINE)) {
      const condition = m[3] === '(always)' ? null : m[3];
      const key = KEYS.find((k) => FACT_KEYS[k].subject === m[2] && FACT_KEYS[k].condition === condition);
      if (key) numbers.set(key, Number(m[1]));
    }
    const mentions = MENTIONS.filter((x) => chunk.includes(x.quote) && numbers.has(x.fact)).map(({ fact: k, ...rest }) => ({ fact: numbers.get(k), ...rest }));
    return { args: { mentions }, model: 'claude-sonnet-5' };
  }) as unknown as ChatToolFn;
}

const PAGES = new Map(COPY_PAGES.map((p) => [p.id, p]));
const ctx: SourceContext = { accountId: 'acc-1', extension: { content: { id: SOURCE_PAGE_ID } } };

let facts: FakeFacts;
let scans: FakeScans;
let pushes: { queue: ScanQueue; scanId: string }[];
let llmCalls: { tool: string; chunk?: string }[];
let searchCalls: { cql: string; max: number }[];
let pageReads: string[];
let clock: number;

/** CQL fake: every fixture page plus the source page itself (which must never become a copy). */
const searchAll = async (cql: string, max: number): Promise<SearchHit[]> => {
  searchCalls.push({ cql, max });
  return [{ pageId: SOURCE_PAGE_ID, title: 'Travel Policy', url: null }, ...COPY_PAGES.map((p) => ({ pageId: p.id, title: p.title, url: `/spaces/T/pages/${p.id}` }))];
};

const jobDeps = (over: Partial<ScanJobDeps> = {}): ScanJobDeps => ({
  facts: facts as unknown as FactRepo,
  scans,
  search: searchAll,
  page: async (id) => {
    pageReads.push(id);
    const p = PAGES.get(id);
    if (!p) throw new Error(`unexpected page read ${id}`);
    return { id, title: p.title, spaceId: '7', version: 2, versionCreatedAt: null, body: p.storage };
  },
  llm: fakeLlm(llmCalls),
  push: async (queue, scanId) => {
    pushes.push({ queue, scanId });
    return 'job-1';
  },
  ensure: async () => undefined,
  now: () => ++clock,
  ...over,
});

const copyDeps = (over: Partial<CopyDeps> = {}): CopyDeps => ({
  facts: facts as unknown as FactRepo,
  scans,
  canEdit: async () => true,
  visible: async (ids) => new Set(ids),
  push: async (queue, scanId) => {
    pushes.push({ queue, scanId });
    return 'job-1';
  },
  ensure: async () => undefined,
  ...over,
});

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  facts = new FakeFacts();
  scans = new FakeScans();
  pushes = [];
  llmCalls = [];
  searchCalls = [];
  pageReads = [];
  clock = 0;
});

/** Runs a scan to the end (each consumer re-run as the queue would). */
async function fullScan(deps: ScanJobDeps = jobDeps()): Promise<string> {
  const scanId = await scans.createScan(SOURCE_PAGE_ID, FACTS.length, 'acc-1');
  expect((await runSearchJob(scanId, 0, deps)).status).toBe('done');
  expect((await runJudgeJob(scanId, 0, deps)).status).toBe('done');
  return scanId;
}

// ---------------------------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------------------------

describe('CQL builder', () => {
  it('searches phrases and long numbers, excludes the source and ripple-ignore pages', () => {
    const cql = buildCql(SOURCE_PAGE_ID, factTerms(fact('approval'), ['manager sign off']));
    expect(cql).toBe(
      'type = page AND id != 9502721 AND label != "ripple-ignore" AND (text ~ "\\"Trip approval\\"" OR text ~ "\\"manager sign off\\"" OR text ~ "2000")',
    );
    // "60" alone is too common to search.
    expect(buildCql(SOURCE_PAGE_ID, factTerms(fact('domestic')))).not.toContain('text ~ "60"');
  });

  it('cannot be broken out of by quotes or CQL operators in terms, and rejects bad page ids', () => {
    expect(cleanTerm('meal "allowance") OR space = X')).toBe('meal allowance OR space X');
    const cql = buildCql(SOURCE_PAGE_ID, factTerms(fact('domestic'), ['daily "allowance" ) OR type = blog']));
    expect(cql).toContain('text ~ "\\"daily allowance OR type blog\\""');
    expect(cql.match(/(?<!\\)"/g)?.length).toBe(6); // label value + the two text ~ "…" clauses
    expect(() => buildCql('12 OR 1=1', factTerms(fact('domestic')))).toThrow('invalid source page id');
  });

  it('adds the previous value as a search number', () => {
    expect(factTerms({ ...fact('approval'), previousValue: '1,500' }).numbers).toEqual(['2000', '1500']);
  });
});

describe('chunkPage', () => {
  const terms = FACTS.map((f) => ({ id: f.id, terms: factTerms(f) }));

  it('keeps lines that mention a fact with their heading context, tagged with the facts', () => {
    const text = ['Welcome to the team', 'Lunch is at noon', 'Benefits', '', 'Domestic trips: the per diem is $60 per day.', 'Bring a laptop', 'x', 'y', 'z', 'Expense claims are due within 30 days.'].join('\n');
    const chunks = chunkPage(text, terms);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toBe('Lunch is at noon\nBenefits\nDomestic trips: the per diem is $60 per day.\nBring a laptop');
    expect(chunks[0]?.factIds).toContain(factId('domestic'));
    expect(chunks[1]?.factIds).toEqual([factId('claims')]);
  });

  it('returns nothing for unrelated text, caps chunk size and count', () => {
    expect(chunkPage('Office plants need water.\nThe wifi password is on the fridge.', terms)).toEqual([]);
    const long = Array.from({ length: 60 }, (_, i) => `Expense claims rule ${i} ${'pad '.repeat(40)}`).join('\n');
    const chunks = chunkPage(long, terms);
    expect(chunks.length).toBeLessThanOrEqual(6);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1200);
  });
});

describe('value normalisation', () => {
  it('reads money in any common form', () => {
    for (const v of ['$60', '60 USD', 'USD 60', 'sixty dollars', 'US$60.00'.replace('.00', '')]) expect(normaliseValue(v)).toMatchObject({ numbers: [60], unit: 'USD' });
    expect(normaliseValue('2,000')).toMatchObject({ numbers: [2000] });
    expect(normaliseValue('2.000')).toMatchObject({ numbers: [2000] });
    expect(normaliseValue('two thousand dollars')).toMatchObject({ numbers: [2000], unit: 'USD' });
    expect(normaliseValue('$2k')).toMatchObject({ numbers: [2000] });
    expect(normaliseValue('30 hari')).toMatchObject({ numbers: [30], unit: 'days' });
  });

  it('compares numbers, units and text values', () => {
    const domestic = { value: '60', unit: 'USD' };
    expect(compareValues(domestic, { value: 'sixty dollars', unit: null })).toBe('same');
    expect(compareValues(domestic, { value: '$75', unit: null })).toBe('different');
    expect(compareValues(domestic, { value: '60 EUR', unit: null })).toBe('different');
    expect(compareValues({ value: '30', unit: 'days after the trip ends' }, { value: '30 hari', unit: null })).toBe('same');
    expect(compareValues({ value: 'economy class', unit: null }, { value: 'economy', unit: null })).toBe('same');
    expect(compareValues({ value: 'economy class', unit: null }, { value: 'business class', unit: null })).toBe('different');
    expect(compareValues(domestic, { value: 'the usual amount', unit: null })).toBe('unknown');
  });
});

describe('parseJudgement', () => {
  const chunk = 'Money\nPer diem for domestic travel: $75 per day.';
  const ok = { fact: 1, same_fact: 'yes', mention: 'current', stated_value: '$75', stated_unit: null, stated_condition: 'domestic travel', quote: 'Per diem for domestic travel: $75 per day.' };

  it('keeps a mention with a verbatim quote', () => {
    const { judgements, dropped } = parseJudgement({ mentions: [ok] }, chunk, [factId('domestic')]);
    expect(dropped).toEqual([]);
    expect(judgements[0]).toMatchObject({ factId: factId('domestic'), statedValue: '$75', quote: ok.quote });
  });

  it('rejects a fake or paraphrased quote, a value missing from the quote and unknown facts', () => {
    const { judgements, dropped } = parseJudgement(
      {
        mentions: [
          { ...ok, quote: 'Domestic per diem is $75 per day.' },
          { ...ok, stated_value: '$80' },
          { ...ok, fact: 9 },
          { ...ok, mention: 'maybe' },
        ],
      },
      chunk,
      [factId('domestic')],
    );
    expect(judgements).toEqual([]);
    expect(dropped.map((d) => d.reason)).toEqual(['quote_not_found', 'value_not_in_quote', 'unknown_fact', 'invalid_shape']);
    expect(() => parseJudgement({}, chunk, [])).toThrow('judge output has no mentions array');
  });
});

describe('decideStatus', () => {
  const siblings = [fact('international')];

  it('in sync and drift', () => {
    expect(decideStatus(fact('domestic'), judgement('domestic', { statedValue: '$60', quote: 'Per diem: $60' }), siblings)?.status).toBe('in_sync');
    expect(decideStatus(fact('domestic'), judgement('domestic', { statedValue: '$75', statedCondition: 'domestic travel', quote: 'Per diem: $75' }), siblings)).toEqual({
      status: 'drifted',
      reason: 'Value differs: $75 vs 60 USD on the source.',
    });
  });

  it('historical mentions are never drift', () => {
    expect(decideStatus(fact('domestic'), judgement('domestic', { mention: 'historical', statedValue: '$50', quote: 'was raised from $50 to $60' }))?.status).toBe('historical');
    // Judge says "current" but the quote reads like a changelog: only unsure.
    expect(decideStatus(fact('domestic'), judgement('domestic', { statedValue: '$50', quote: 'Until 2025 the per diem was $50.' }))?.status).toBe('unsure');
    expect(decideStatus(fact('domestic'), judgement('domestic', { statedValue: '$50', quote: 'Previously the per diem was $50.' }))?.status).toBe('unsure');
  });

  it('a different condition (training per diem $40) is never drift', () => {
    for (const sameFact of ['yes', 'unsure'] as const) {
      const d = decideStatus(fact('domestic'), judgement('domestic', { sameFact, statedValue: '$40', statedCondition: 'External training', quote: 'The per diem for external training is $40 per day.' }), siblings);
      expect(d?.status).toBe('unsure');
    }
    expect(decideStatus(fact('domestic'), judgement('domestic', { sameFact: 'no', statedValue: '$40', statedCondition: 'External training', quote: 'x' }))).toBeNull();
    // The international value without a condition is not a domestic drift.
    expect(decideStatus(fact('domestic'), judgement('domestic', { statedValue: '$90', quote: 'Per diem is $90 per day.' }), siblings)?.status).toBe('unsure');
  });

  it('drops examples and values that cannot be compared; strongest picks drift first', () => {
    expect(decideStatus(fact('domestic'), judgement('domestic', { mention: 'example', statedValue: '$75', quote: 'x' }))).toBeNull();
    expect(decideStatus(fact('domestic'), judgement('domestic', { statedValue: 'the usual amount', quote: 'x' }))).toBeNull();
    expect(strongest([{ status: 'historical' as CopyStatus }, { status: 'drifted' as CopyStatus }, { status: 'in_sync' as CopyStatus }])?.status).toBe('drifted');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Consumers
// ---------------------------------------------------------------------------------------------------------------

describe('copy scan (search + judge consumers)', () => {
  it('stores the expected status for every fixture page and never the source page', async () => {
    const scanId = await fullScan();
    for (const p of COPY_PAGES) for (const [k, status] of Object.entries(p.expect)) expect(scans.statusOf(k as FactKey, p.id), `${p.title} / ${k}`).toBe(status);
    expect([...scans.copies.values()].some((c) => c.pageId === SOURCE_PAGE_ID)).toBe(false);
    expect(pageReads).not.toContain(SOURCE_PAGE_ID);
    expect(searchCalls.every((c) => c.cql.includes(`id != ${SOURCE_PAGE_ID}`))).toBe(true);
    expect(await scans.countCopies(SOURCE_PAGE_ID)).toEqual({ ...EMPTY_COPY_COUNTS, in_sync: 5, drifted: 2, historical: 1, unsure: 1 });
    expect(scans.scans.get(scanId)).toMatchObject({ state: 'done', candidates: COPY_PAGES.length, pagesJudged: COPY_PAGES.length });
    // Synonyms from the terms call are cleaned and searched for fact 1 (sorted by id).
    expect(searchCalls[0]?.cql).toContain('text ~ "\\"meal allowance\\""');
    expect(facts.audits).toContain('scan.finished');
  });

  it('keeps at most 200 candidates per fact', async () => {
    const many = async (cql: string, max: number): Promise<SearchHit[]> => {
      searchCalls.push({ cql, max });
      return Array.from({ length: 250 }, (_, i) => ({ pageId: String(800000 + i), title: `P${i}`, url: null }));
    };
    const scanId = await scans.createScan(SOURCE_PAGE_ID, FACTS.length, 'acc-1');
    await runSearchJob(scanId, 0, jobDeps({ search: many }));
    expect(searchCalls.every((c) => c.max === MAX_CANDIDATES_PER_FACT)).toBe(true);
    for (const f of FACTS) expect(scans.hits.filter((h) => h.factId === f.id)).toHaveLength(MAX_CANDIDATES_PER_FACT);
    expect(scans.scans.get(scanId)?.candidates).toBe(200);
  });

  it('resumes the search from the fact cursor after the run budget is used up', async () => {
    const scanId = await scans.createScan(SOURCE_PAGE_ID, FACTS.length, 'acc-1');
    const first = await runSearchJob(scanId, 0, jobDeps(), 2);
    expect(first).toEqual({ status: 'continued', detail: { searched: 2, cursor: 2 } });
    expect(pushes).toEqual([{ queue: SEARCH_QUEUE, scanId }]);
    expect(scans.scans.get(scanId)?.factCursor).toBe(2);
    const second = await runSearchJob(scanId, 0, jobDeps());
    expect(second).toEqual({ status: 'done', detail: { searched: 3, facts: 5 } });
    expect(searchCalls).toHaveLength(5);
    expect(llmCalls.filter((c) => c.tool === 'record_search_terms')).toHaveLength(1);
    expect(pushes[1]).toEqual({ queue: JUDGE_QUEUE, scanId });
  });

  it('resumes judging with the first unfinished page and reads no page twice', async () => {
    const scanId = await scans.createScan(SOURCE_PAGE_ID, FACTS.length, 'acc-1');
    await runSearchJob(scanId, 0, jobDeps());
    pushes = [];
    const first = await runJudgeJob(scanId, 0, jobDeps(), 3);
    expect(first.status).toBe('continued');
    expect(pushes).toEqual([{ queue: JUDGE_QUEUE, scanId }]);
    const readFirst = pageReads.length;
    expect(readFirst).toBeGreaterThan(0);
    expect(readFirst).toBeLessThan(COPY_PAGES.length);
    expect((await runJudgeJob(scanId, 0, jobDeps())).status).toBe('done');
    expect(new Set(pageReads).size).toBe(pageReads.length);
    expect(pageReads).toHaveLength(COPY_PAGES.length);
    expect(scans.statusOf('claims', '9600004')).toBe('drifted');
  });

  it('drops a mention whose quote is not on the page', async () => {
    const fake = fakeLlm(llmCalls, () => ({ mentions: [{ fact: 1, same_fact: 'yes', mention: 'current', stated_value: '$99', stated_unit: null, stated_condition: null, quote: 'The per diem is $99 for everyone.' }] }));
    await fullScan(jobDeps({ llm: fake }));
    expect(scans.copies.size).toBe(0);
  });

  it('retries on an LLM rate limit and fails the scan after the retries', async () => {
    const limited = (async (_m: Message[], tool: ToolSpec) => {
      if (tool.name === 'record_search_terms') return { args: { facts: [] }, model: 'm' };
      throw Object.assign(new ForgeLlmError('rate limited'), { status: 429 });
    }) as unknown as ChatToolFn;
    const scanId = await scans.createScan(SOURCE_PAGE_ID, FACTS.length, 'acc-1');
    await runSearchJob(scanId, 0, jobDeps());
    expect(await runJudgeJob(scanId, 0, jobDeps({ llm: limited }))).toMatchObject({ status: 'retry', reason: 'llm-rate-limited' });
    expect(await runJudgeJob(scanId, 4, jobDeps({ llm: limited }))).toMatchObject({ status: 'failed' });
    expect(scans.scans.get(scanId)?.state).toBe('error');
  });

  it('a rescan keeps ignored copies and drops copies no longer found', async () => {
    await fullScan();
    const ignored = scans.copies.get(`${factId('domestic')}|9600006`);
    if (ignored) ignored.status = 'ignored';
    scans.copies.set(`${factId('flight')}|1234`, { ...(ignored as CopyInput & { sourcePageId: string; scanId: string }), factId: factId('flight'), pageId: '1234', status: 'drifted' });
    await fullScan();
    expect(scans.statusOf('domestic', '9600006')).toBe('ignored');
    expect(scans.statusOf('flight', '1234')).toBeNull();
  });

  it('skips events of finished or unknown scans', async () => {
    const scanId = await fullScan();
    expect(await runSearchJob(scanId, 0, jobDeps())).toEqual({ status: 'skipped', reason: 'scan is done' });
    expect(await runJudgeJob('00000000-0000-4000-8000-999999999999', 0, jobDeps())).toEqual({ status: 'skipped', reason: 'unknown scan' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------------------------------------------

describe('startScan / getScanStatus / listCopies', () => {
  it('starts a scan for an editor and queues the search', async () => {
    const reply = await startScan(ctx, copyDeps());
    expect(reply).toMatchObject({ pageId: SOURCE_PAGE_ID, canEdit: true, scan: { state: 'searching', factsTotal: 5 } });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.queue).toBe(SEARCH_QUEUE);
    expect(facts.audits).toContain('scan.started');
    // A second click while it runs does not start another scan.
    await startScan(ctx, copyDeps());
    expect(scans.scans.size).toBe(1);
  });

  it('refuses without edit permission, without a source or without confirmed facts', async () => {
    expect(await startScan(ctx, copyDeps({ canEdit: async () => false }))).toEqual({ error: 'You need edit permission on this page to do that.' });
    facts.status = 'proposed';
    expect(await startScan(ctx, copyDeps())).toEqual({ error: 'Confirm at least one fact before searching for copies.' });
    facts.sources.clear();
    expect(await startScan(ctx, copyDeps())).toEqual({ error: 'Mark this page as the source of truth first.' });
    expect(pushes).toEqual([]);
  });

  it('resumes a stalled scan in its current phase', async () => {
    const scanId = await scans.createScan(SOURCE_PAGE_ID, 5, 'acc-1');
    await scans.startJudging(scanId);
    scans.stall = true;
    await startScan(ctx, copyDeps());
    expect(pushes).toEqual([{ queue: JUDGE_QUEUE, scanId }]);
    expect(scans.scans.size).toBe(1);
    expect(facts.audits).toContain('scan.resumed');
  });

  it('lists only copies on pages the viewer can open and counts the rest', async () => {
    await fullScan();
    const visible = vi.fn(async (ids: readonly string[]) => new Set(ids.filter((id) => id !== '9600003')));
    const reply = await listCopies(ctx, undefined, copyDeps({ visible }));
    if ('error' in reply) throw new Error(reply.error);
    expect(reply.hiddenCount).toBe(1);
    expect(reply.copies.map((c) => c.pageId)).not.toContain('9600003');
    expect(reply.copies.some((c) => c.status === 'historical')).toBe(false);
    const historical = await listCopies(ctx, { status: 'historical' }, copyDeps());
    expect('copies' in historical && historical.copies.map((c) => c.pageId)).toEqual(['9600005']);
    expect(await listCopies(ctx, { status: 'bogus' as CopyStatus }, copyDeps())).toEqual({ error: 'Unknown copy status filter.' });
    const status = await getScanStatus(ctx, copyDeps());
    expect(status).toMatchObject({ scan: { state: 'done' }, counts: { drifted: 2 } });
  });
});
