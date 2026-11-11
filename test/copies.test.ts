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
import { JUDGE_SYSTEM_PROMPT, JUDGE_TOOL } from '../src/llm/judge';
import type { SearchHit } from '../src/adapters/confluence';
import type { FactRepo } from '../src/adapters/repo';
import { EMPTY_COPY_COUNTS, type CachedTerms, type ChunkResult, type CopyInput, type HitInput, type PendingPage, type ScanRepo, type ScanRow } from '../src/adapters/scanRepo';
import {
  buildCql,
  chunkPage,
  cleanTerm,
  compareValues,
  decideStatus,
  factTerms,
  JUDGE_REASON_CODES,
  judgeOutcome,
  MAX_CANDIDATES_PER_FACT,
  normaliseValue,
  parseJudgement,
  parseReasonCode,
  sameCondition,
  settleSiblings,
  siblingsOf,
  parseTermSuggestions,
  strongest,
  type Judgement,
  type ScanFact,
} from '../src/core/copies';
import type { CopyStatus, CopyView, FactView, SourceView } from '../src/core/views';
import type { ChatToolFn } from '../src/llm/extract';
import type { ToolSpec } from '../src/llm/index';
import { getScanStatus, JUDGE_CONCURRENCY, JUDGE_QUEUE, listCopies, MAX_LLM_CALLS_PER_SCAN, runJudgeJob, runSearchJob, SEARCH_QUEUE, startScan, type CopyDeps, type ScanJobDeps, type ScanQueue } from '../src/surfaces/copies';
import type { SourceContext } from '../src/surfaces/sources';
import { COPY_PAGES, FACT_KEYS, SOURCE_PAGE_ID, type FactKey, type JudgeMention } from './fixtures/copies';
import { TRAVEL_POLICY_FACTS } from './fixtures/travelPolicy';
import { NIMBUS_EXPECTED, NIMBUS_PAGES, NIMBUS_SOURCE, TRAP_SLUG, type NimbusMention } from '../src/demo/nimbus';

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
  quote: f.quote,
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
    // Source (insert) order, like the real query; the scan keeps it as `order` and sorts by id itself.
    return [...FACTS].map((f) => ({ ...f, quote: 'q', status: this.status, edited: false, pageVersion: 3, effectiveSince: null }));
  }
  async audit(action: string) {
    this.audits.push(action);
  }
}

/** In-memory `ScanRepo` with the SQL semantics (idempotent hits, sticky ignored/updated copies, one running scan per source). */
class FakeScans implements ScanRepo {
  scans = new Map<string, ScanRow>();
  hits: (HitInput & { scanId: string; status: 'pending' | 'done' | 'skipped' })[] = [];
  copies = new Map<string, CopyInput & { sourcePageId: string; scanId: string }>();
  chunks = new Map<string, ChunkResult>();
  active = new Map<string, string>();
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
  async createScan(sourcePageId: string, factIds: readonly string[], _actor: string) {
    if (this.active.has(sourcePageId)) return undefined;
    const id = `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
    this.active.set(sourcePageId, id);
    this.scans.set(id, {
      id,
      sourcePageId,
      state: 'searching',
      stalled: false,
      factsTotal: factIds.length,
      factsSearched: 0,
      factCursor: 0,
      factIds: [...factIds],
      terms: null,
      candidates: 0,
      pagesJudged: 0,
      pagesSkipped: 0,
      llmCalls: 0,
      partial: false,
      startedAt: 'now',
      finishedAt: null,
      error: null,
    });
    return id;
  }
  private patch(id: string, p: Partial<ScanRow>) {
    const s = this.scans.get(id);
    if (s) this.scans.set(id, { ...s, ...p });
  }
  private release(id: string) {
    for (const [k, v] of this.active) if (v === id) this.active.delete(k);
  }
  async touchScan() {}
  searchTerms = new Map<string, CachedTerms>();
  async setTerms(id: string, terms: Record<string, string[]>, synonymsCached = 0) {
    this.patch(id, { terms, synonymsCached });
  }
  async factSearchTerms(factIds: readonly string[]) {
    return new Map([...this.searchTerms].filter(([id]) => factIds.includes(id)));
  }
  async saveFactSearchTerms(factId: string, cached: CachedTerms) {
    this.searchTerms.set(factId, cached);
  }
  async addLlmCalls(id: string, n: number) {
    const s = this.scans.get(id);
    if (s) this.patch(id, { llmCalls: s.llmCalls + n });
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
  async candidatesPerFact(scanId: string) {
    const out: Record<string, Set<string>> = {};
    for (const h of this.hits) if (h.scanId === scanId) (out[h.factId] ??= new Set()).add(h.pageId);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.size]));
  }
  async pendingPages(scanId: string, limit: number): Promise<PendingPage[]> {
    const pending = this.hits.filter((h) => h.scanId === scanId && h.status === 'pending');
    const ids = [...new Set(pending.map((h) => h.pageId))].sort().slice(0, limit);
    return ids.map((pageId) => {
      const own = pending.filter((h) => h.pageId === pageId);
      return { pageId, title: own[0]?.title ?? '', url: own[0]?.url ?? null, factIds: own.map((h) => h.factId) };
    });
  }
  async chunkResults(scanId: string, pageId: string) {
    const out = new Map<string, ChunkResult>();
    for (const [k, v] of this.chunks) if (k.startsWith(`${scanId}|${pageId}|`)) out.set(k.split('|')[2] as string, v);
    return out;
  }
  async saveChunkResult(scanId: string, pageId: string, hash: string, result: ChunkResult) {
    this.chunks.set(`${scanId}|${pageId}|${hash}`, JSON.parse(JSON.stringify(result)) as ChunkResult);
  }
  private dropChunks(scanId: string, pageId?: string) {
    for (const k of [...this.chunks.keys()]) if (k.startsWith(pageId ? `${scanId}|${pageId}|` : `${scanId}|`)) this.chunks.delete(k);
  }
  private markHits(scanId: string, pageId: string, status: 'done' | 'skipped'): number {
    let changed = 0;
    for (const h of this.hits) if (h.scanId === scanId && h.pageId === pageId && h.status === 'pending') (h.status = status), changed++;
    return changed;
  }
  async finishPage(scanId: string, sourcePageId: string, pageId: string, copies: readonly CopyInput[]) {
    for (const c of copies) {
      const key = `${c.factId}|${c.pageId}`;
      const old = this.copies.get(key);
      if (old && (old.status === 'ignored' || old.status === 'updated')) this.copies.set(key, { ...old, scanId });
      else this.copies.set(key, { ...c, sourcePageId, scanId });
    }
    const s = this.scans.get(scanId);
    if (s && this.markHits(scanId, pageId, 'done') > 0) this.patch(scanId, { pagesJudged: s.pagesJudged + 1 });
    this.dropChunks(scanId, pageId);
  }
  async skipPage(scanId: string, pageId: string) {
    const s = this.scans.get(scanId);
    if (s && this.markHits(scanId, pageId, 'skipped') > 0) this.patch(scanId, { pagesSkipped: (s.pagesSkipped ?? 0) + 1 });
    this.dropChunks(scanId, pageId);
  }
  async finishScan(scanId: string, sourcePageId: string, partial: boolean) {
    if (!partial) for (const [k, c] of this.copies) if (c.sourcePageId === sourcePageId && c.scanId !== scanId && c.status !== 'ignored' && c.status !== 'updated') this.copies.delete(k);
    this.patch(scanId, { state: 'done', finishedAt: 'now', partial });
    this.release(scanId);
    this.hits = this.hits.filter((h) => h.scanId !== scanId);
    this.dropChunks(scanId);
  }
  async failScan(id: string, error: string) {
    this.patch(id, { state: 'error', error });
    this.release(id);
  }
  async discardScan(scanId: string, sourcePageId: string) {
    for (const [k, c] of this.copies) if (c.sourcePageId === sourcePageId) this.copies.delete(k);
    this.hits = this.hits.filter((h) => h.scanId !== scanId);
    this.dropChunks(scanId);
    this.scans.delete(scanId);
    this.release(scanId);
  }
  /** Copies of facts still confirmed (the SQL joins `facts`); tests set `unconfirmed` to drop a fact. */
  unconfirmed = new Set<string>();
  private live(sourcePageId: string) {
    return [...this.copies.values()].filter((c) => c.sourcePageId === sourcePageId && !this.unconfirmed.has(c.factId));
  }
  async copyPageIds(sourcePageId: string) {
    return [...new Set(this.live(sourcePageId).map((c) => c.pageId))];
  }
  async countCopies(sourcePageId: string, pageIds?: readonly string[]) {
    const counts = { ...EMPTY_COPY_COUNTS };
    for (const c of this.live(sourcePageId)) if (!pageIds || pageIds.includes(c.pageId)) counts[c.status]++;
    return counts;
  }
  async listCopies(sourcePageId: string, status: CopyStatus | undefined, pageIds: readonly string[]): Promise<CopyView[]> {
    return this.live(sourcePageId)
      .filter((c) => pageIds.includes(c.pageId) && (status ? c.status === status : c.status !== 'ignored'))
      .map((c) => ({ id: `${c.factId}|${c.pageId}`, factId: c.factId, factLabel: '', officialValue: '', officialUnit: null, pageId: c.pageId, pageTitle: c.pageTitle, pageUrl: c.pageUrl, status: c.status, statedValue: c.statedValue, statedUnit: c.statedUnit, statedCondition: c.statedCondition, quote: c.quote, reason: c.reason, judgedAt: null }));
  }
  statusOf(k: FactKey, pageId: string): CopyStatus | null {
    return this.copies.get(`${factId(k)}|${pageId}`)?.status ?? null;
  }
}

const MENTIONS = COPY_PAGES.flatMap((p) => p.judge);
const FACT_LINE = /^(\d+)\. (.+?) \| .+? \| official value: .+? \| condition: (.+)$/gm;

/** Fake LLM: synonyms for the terms call; for a chunk, the fixture mentions whose quote is in it (numbered as in the prompt). */
function fakeLlm(
  calls: { tool: string; chunk?: string }[],
  override?: (chunk: string) => unknown,
  tweak?: (m: JudgeMention) => JudgeMention,
  extra: readonly JudgeMention[] = [],
): ChatToolFn {
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
    const mentions = [...MENTIONS, ...extra]
      .filter((x) => chunk.includes(x.quote) && numbers.has(x.fact))
      .map((x) => (tweak ? tweak(x) : x))
      .map(({ fact: k, ...rest }) => ({ fact: numbers.get(k), ...rest }));
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

async function newScan(): Promise<string> {
  const id = await scans.createScan(SOURCE_PAGE_ID, FACTS.map((f) => f.id), 'acc-1');
  if (!id) throw new Error('a scan is already running');
  return id;
}

/** Runs a scan to the end (each consumer re-run as the queue would). */
async function fullScan(deps: ScanJobDeps = jobDeps()): Promise<string> {
  const scanId = await newScan();
  expect((await runSearchJob(scanId, 0, deps)).status).toBe('done');
  expect((await runJudgeJob(scanId, 0, deps)).status).toBe('done');
  return scanId;
}

// ---------------------------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------------------------

/**
 * Rough model of Confluence `text ~` for the CQL from `buildCql`: word match with plural -s (Confluence stems English
 * words), quoted phrases as phrases, groups in parentheses all required.
 */
function cqlMatches(cql: string, html: string, opts: { withoutNumbers?: boolean } = {}): boolean {
  const text = ` ${html.replace(/<[^>]+>/g, ' ').toLowerCase().replace(/[^\p{L}\p{N},]+/gu, ' ').replace(/,(?!\d)/g, ' ')} `;
  const has = (term: string) => [term, `${term}s`].some((t) => text.includes(` ${t.toLowerCase()} `));
  const clauses = (/AND \((.*)\)$/.exec(cql)?.[1]?.split(' OR ') ?? []).filter((c) => !opts.withoutNumbers || !/^text ~ "[\d,]+"$/.test(c));
  return clauses.some((c) =>
    c
      .replace(/^\(|\)$/g, '')
      .split(' AND ')
      .every((t) => has(/^text ~ "(?:\\")?(.*?)(?:\\")?"$/.exec(t)?.[1] ?? '\u0000')),
  );
}

describe('CQL builder', () => {
  it('searches phrases and long numbers, excludes the source and ripple-ignore pages', () => {
    const cql = buildCql(SOURCE_PAGE_ID, factTerms(fact('approval'), ['manager sign off']));
    expect(cql).toBe(
      'type = page AND id != 9502721 AND label != "ripple-ignore" AND (text ~ "\\"Trip approval\\"" OR text ~ "\\"manager sign off\\"" OR text ~ "approval" OR (text ~ "manager" AND text ~ "sign") OR (text ~ "manager" AND text ~ "off") OR (text ~ "sign" AND text ~ "off") OR text ~ "2000" OR text ~ "2,000")',
    );
    // "60" alone is too common to search.
    expect(buildCql(SOURCE_PAGE_ID, factTerms(fact('domestic')))).not.toContain('text ~ "60"');
  });

  it('cannot be broken out of by quotes or CQL operators in terms, and rejects bad page ids', () => {
    expect(cleanTerm('meal "allowance") OR space = X')).toBe('meal allowance OR space X');
    const cql = buildCql(SOURCE_PAGE_ID, factTerms(fact('domestic'), ['daily "allowance" ) OR type = blog']));
    expect(cql).toContain('text ~ "\\"daily allowance OR type blog\\""');
    expect(cql.match(/(?<!\\)"/g)?.length).toBe(20); // label value + 2 phrase clauses + 7 single-word clauses (diem, 3 pairs of daily/allowance/type)
    // Word clauses hold one letter/digit word each, so no operator survives into them.
    for (const m of cql.matchAll(/text ~ "([^"\\]*)"/g)) expect(m[1]).toMatch(/^[\p{L}\p{N},]+$/u);
    expect(() => buildCql('12 OR 1=1', factTerms(fact('domestic')))).toThrow('invalid source page id');
  });

  it('also searches word groups of the subject, so a copy without the exact subject phrase is found', () => {
    expect(factTerms(fact('domestic')).wordGroups).toEqual([['diem']]);
    expect(factTerms(fact('approval')).wordGroups).toEqual([['approval']]);
    expect(factTerms(fact('flight')).wordGroups).toEqual([['flight', 'class']]);
    expect(factTerms({ ...fact('claims'), subject: 'Expense claim deadline' }).wordGroups).toEqual([
      ['expense', 'claim'],
      ['expense', 'deadline'],
      ['claim', 'deadline'],
    ]);
    expect(buildCql(SOURCE_PAGE_ID, factTerms(fact('flight')))).toContain(' OR (text ~ "flight" AND text ~ "class")');
    // Synonyms add their own groups (capped, never the value).
    expect(factTerms(fact('domestic'), ['daily allowance']).wordGroups).toEqual([['diem'], ['daily', 'allowance']]);
  });

  it('finds every fixture copy by subject words alone, also the drifted ones (value not searched)', () => {
    for (const page of COPY_PAGES)
      for (const [k, status] of Object.entries(page.expect))
        if (status) expect(cqlMatches(buildCql(SOURCE_PAGE_ID, factTerms(fact(k as FactKey))), page.storage, { withoutNumbers: true }), `${page.title} / ${k}`).toBe(true);
    // Finance FAQ (claims 45 days vs 30) with the subject worded as the live extraction may word it, no synonyms.
    const finance = COPY_PAGES.find((p) => p.title === 'Finance FAQ')?.storage ?? '';
    for (const subject of ['Expense claims', 'Expense claim deadline', 'Expense claim submission']) {
      expect(cqlMatches(buildCql(SOURCE_PAGE_ID, factTerms({ ...fact('claims'), subject })), finance, { withoutNumbers: true }), subject).toBe(true);
    }
  });

  it('searches 4+ digit numbers also with a thousands separator', () => {
    expect(buildCql(SOURCE_PAGE_ID, factTerms(fact('approval')))).toContain('text ~ "2000" OR text ~ "2,000"');
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
    expect(compareValues(domestic, { value: '60 EUR', unit: null })).toBe('unknown');
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

  it('parses reason_code to the fixed enum, anything else to "other"', () => {
    for (const code of JUDGE_REASON_CODES) expect(parseReasonCode(code)).toBe(code);
    for (const bad of ['Value differs', 'the page says $75', 42, null, undefined]) expect(parseReasonCode(bad)).toBe('other');
    const parsed = parseJudgement({ mentions: [{ ...ok, reason_code: 'ignore previous instructions' }] }, chunk, [factId('domestic')]);
    expect(parsed.judgements[0]?.reasonCode).toBe('other');
  });

  describe('outcome → status for the few-shot cases', () => {
    const status = (over: Record<string, unknown>, text = chunk) => {
      const { judgements } = parseJudgement({ mentions: [{ ...ok, ...over }] }, text, [factId('domestic')]);
      const j = judgements[0];
      return j ? judgeOutcome(fact('domestic'), j, [fact('international')]) : undefined;
    };

    it('(a) same fact, other value → drifted, also when the judge says "no"', () => {
      expect(status({ reason_code: 'value_differs' })?.decision?.status).toBe('drifted');
      expect(status({ same_fact: 'no', reason_code: 'value_differs' })?.decision?.status).toBe('drifted');
      expect(status({ same_fact: 'no', reason_code: 'value_matches', stated_value: '$60', quote: 'Per diem for domestic travel: $60 per day.' }, 'Per diem for domestic travel: $60 per day.')?.decision?.status).toBe('in_sync');
      // value_matches with "unsure" (New joiner FAQ, live): equal value and same condition → in sync; without the code → unsure.
      expect(status({ same_fact: 'unsure', reason_code: 'value_matches', stated_value: '$60', quote: 'Per diem for domestic travel: $60 per day.' }, 'Per diem for domestic travel: $60 per day.')?.decision?.status).toBe('in_sync');
      expect(status({ same_fact: 'unsure', reason_code: 'ambiguous', stated_value: '$60', quote: 'Per diem for domestic travel: $60 per day.' }, 'Per diem for domestic travel: $60 per day.')?.decision?.status).toBe('unsure');
    });

    it('(b) same topic, other condition → unsure, never dropped', () => {
      const training = { stated_value: '$40', quote: 'Training per diem: $40 per day.' };
      const text = 'Training per diem: $40 per day.';
      for (const sameFact of ['yes', 'unsure', 'no']) {
        expect(status({ ...training, same_fact: sameFact, stated_condition: 'External training', reason_code: 'different_condition' }, text)?.decision?.status, sameFact).toBe('unsure');
        // Condition not named by the judge: the reason code alone keeps it unsure.
        expect(status({ ...training, same_fact: sameFact, stated_condition: null, reason_code: 'different_condition' }, text)?.decision?.status, `${sameFact} / no condition`).toBe('unsure');
      }
    });

    it('a sentence naming a sibling fact\'s condition is no copy of this fact (sibling_fact), a condition the source lacks is unsure', () => {
      const intl = (over: Partial<Judgement>) => judgeOutcome(fact('international'), judgement('international', { statedValue: '$75', quote: 'q', ...over }), [fact('domestic')]);
      expect(intl({ sameFact: 'unsure', statedCondition: 'domestic travel', reasonCode: 'different_condition' })).toEqual({ decision: null, reason: 'sibling_fact' });
      expect(intl({ sameFact: 'no', statedCondition: null, reasonCode: 'sibling_fact' })).toEqual({ decision: null, reason: 'sibling_fact' });
      expect(intl({ sameFact: 'no', statedCondition: 'External training', reasonCode: 'different_condition' }).decision?.status).toBe('unsure');
    });

    it('settleSiblings: one sentence gives one card per sibling group', () => {
      const m = (k: FactKey, status: CopyStatus | null, statedValue: string, quote = 'Per diem: $75 per day.') => ({
        fact: fact(k),
        judgement: judgement(k, { statedValue, quote }),
        decision: status ? { status, reason: 'r' } : null,
      });
      const settled = (items: ReturnType<typeof m>[]) => settleSiblings(items, FACTS).map((i) => i.decision?.status ?? i.reason);
      expect(settled([m('domestic', 'drifted', '$75'), m('international', 'unsure', '$75')])).toEqual(['drifted', 'sibling_fact']);
      // Both unsure (training $40): the preferred fact wins (no condition first, then source order: domestic before international).
      expect(settled([m('international', 'unsure', '$40'), m('domestic', 'unsure', '$40')])).toEqual(['sibling_fact', 'unsure']);
      // Source order (last resort, for values that cannot be compared) comes from `order` when set, not from the list.
      const reordered = FACTS.map((f) => ({ ...f, order: f.id === factId('international') ? 0 : 1 }));
      expect(settleSiblings([m('international', 'unsure', 'varies'), m('domestic', 'unsure', 'varies')], reordered).map((i) => i.decision?.status ?? i.reason)).toEqual(['unsure', 'sibling_fact']);
      // A comparable value goes to the nearest fact before source order ($40: $60 domestic, not $90 international).
      expect(settleSiblings([m('international', 'unsure', '$40'), m('domestic', 'unsure', '$40')], reordered).map((i) => i.decision?.status ?? i.reason)).toEqual(['sibling_fact', 'unsure']);
      expect(settleSiblings([m('international', 'unsure', '$85'), m('domestic', 'unsure', '$85')], FACTS).map((i) => i.decision?.status ?? i.reason)).toEqual(['unsure', 'sibling_fact']);
      // A sentence naming a fact's condition prefers that fact over the nearest value.
      expect(settled([m('domestic', 'unsure', '$85', 'International trainees: $85 per day.'), m('international', 'unsure', '$85', 'International trainees: $85 per day.')])).toEqual(['sibling_fact', 'unsure']);
      // A sibling without a condition (general rule) is preferred over source order.
      const general = FACTS.map((f) => (f.id === factId('international') ? { ...f, condition: null } : f));
      expect(settleSiblings([m('domestic', 'unsure', '$40'), m('international', 'unsure', '$40')], general).map((i) => i.decision?.status ?? i.reason)).toEqual(['sibling_fact', 'unsure']);
      // Other quotes and unrelated facts are untouched.
      expect(settled([m('domestic', 'drifted', '$75'), m('international', 'unsure', '$75', 'Abroad: $75.'), m('claims', 'unsure', '$75')])).toEqual(['drifted', 'unsure', 'unsure']);
    });

    it('settleSiblings, live shape of 12c67ab: the judge names only the international per diem for the training sentence → one unsure card on the preferred fact', () => {
      const text = 'The per diem for external training is $40 per day.';
      const intl = judgement('international', { sameFact: 'no', statedValue: '$40', statedUnit: 'per day', statedCondition: 'External training', quote: text, reasonCode: 'different_condition' });
      const only = settleSiblings([{ fact: fact('international'), judgement: intl, ...judgeOutcome(fact('international'), intl, [fact('domestic')]) }], FACTS);
      expect(only.map((i) => [i.fact.id, i.decision?.status ?? i.reason])).toEqual([
        [factId('international'), 'sibling_fact'],
        [factId('domestic'), 'unsure'],
      ]);
      expect(only[1]?.judgement.factId).toBe(factId('domestic'));
      // Quotes trimmed differently per fact still count as one sentence: one card per sentence per page.
      const dom = judgement('domestic', { sameFact: 'unsure', statedValue: '$40', statedUnit: 'per day', statedCondition: 'External training', quote: 'per diem for external training is $40 per day', reasonCode: 'different_condition' });
      const both = settleSiblings(
        [
          { fact: fact('international'), judgement: intl, ...judgeOutcome(fact('international'), intl, [fact('domestic')]) },
          { fact: fact('domestic'), judgement: dom, ...judgeOutcome(fact('domestic'), dom, [fact('international')]) },
        ],
        FACTS,
      );
      expect(both.filter((i) => i.decision).map((i) => [i.fact.id, i.decision?.status])).toEqual([[factId('domestic'), 'unsure']]);
      // A card from the fact's own condition (judge unsure which fact) is never moved to a sibling.
      const own = judgement('international', { sameFact: 'unsure', statedValue: '$40', statedCondition: 'International travel', quote: text, reasonCode: 'ambiguous' });
      expect(settleSiblings([{ fact: fact('international'), judgement: own, ...judgeOutcome(fact('international'), own, [fact('domestic')]) }], FACTS).map((i) => [i.fact.id, i.decision?.status])).toEqual([[factId('international'), 'unsure']]);
    });

    it('settleSiblings, live shape of 0fa94e9 (Nimbus trap): "$40 on training course days" goes to the $60 domestic fact even when the source order puts international first', () => {
      const text = 'On training course days the per diem is $40 per day.';
      // Facts of one extraction share created_at: the order by id is random, so international may come first.
      const facts = FACTS.map((f, i) => ({ ...f, order: f.id === factId('international') ? 0 : f.id === factId('domestic') ? 1 : i }));
      const mention = (k: FactKey, j: Judgement) => ({ fact: fact(k), judgement: j, ...judgeOutcome(fact(k), j, siblingsOf(fact(k), facts)) });
      const judged = (k: FactKey, over: Partial<Judgement> = {}) =>
        judgement(k, { sameFact: 'unsure', statedValue: '$40', statedUnit: 'per day', statedCondition: 'Training course days', quote: text, reasonCode: 'different_condition', ...over });
      const cards = (items: ReturnType<typeof mention>[]) => settleSiblings(items, facts).filter((i) => i.decision).map((i) => [i.fact.id, i.decision?.status]);
      const domesticCard = [[factId('domestic'), 'unsure']];
      // The judge answers unsure / different_condition for both facts.
      expect(cards([mention('international', judged('international')), mention('domestic', judged('domestic'))])).toEqual(domesticCard);
      expect(cards([mention('domestic', judged('domestic')), mention('international', judged('international'))])).toEqual(domesticCard);
      // Only for international ("no", different_condition, with or without a condition).
      expect(cards([mention('international', judged('international', { sameFact: 'no' }))])).toEqual(domesticCard);
      expect(cards([mention('international', judged('international', { sameFact: 'no', statedCondition: null }))])).toEqual(domesticCard);
      // International unsure, domestic answered as "the sibling's" (dropped): the card still moves to domestic.
      const dropped = mention('domestic', judged('domestic', { sameFact: 'no', statedCondition: null, reasonCode: 'sibling_fact' }));
      expect(dropped.reason).toBe('sibling_fact');
      expect(cards([mention('international', judged('international')), dropped])).toEqual(domesticCard);
    });

    it('sibling_fact counts only when the source has a sibling; otherwise the mention stays (unsure, never lost)', () => {
      const claims = (over: Partial<Judgement>) => judgeOutcome(fact('claims'), judgement('claims', { statedValue: '45 days', statedUnit: 'days', quote: 'q', reasonCode: 'sibling_fact', ...over }), siblingsOf(fact('claims'), FACTS));
      expect(siblingsOf(fact('claims'), FACTS)).toEqual([]);
      for (const sameFact of ['yes', 'no', 'unsure'] as const) expect(claims({ sameFact }).decision?.status, sameFact).toBe('unsure');
      expect(claims({ mention: 'historical' }).decision?.status).toBe('historical');
      // With a real sibling it is still dropped.
      expect(judgeOutcome(fact('domestic'), judgement('domestic', { statedValue: '$90', quote: 'q', reasonCode: 'sibling_fact' }), [fact('international')])).toEqual({ decision: null, reason: 'sibling_fact' });
    });

    it('"no" with a stated condition is unsure only for reason_code different_condition', () => {
      const training = { stated_value: '$40', quote: 'Training per diem: $40 per day.', same_fact: 'no', stated_condition: 'External training' };
      const text = 'Training per diem: $40 per day.';
      for (const code of ['different_subject', 'ambiguous', 'other', 'made up']) expect(status({ ...training, reason_code: code }, text), code).toEqual({ decision: null, reason: 'not_same_fact' });
      expect(status({ ...training, reason_code: 'different_condition' }, text)?.decision?.status).toBe('unsure');
    });

    it('(c) another topic → not a copy', () => {
      expect(status({ same_fact: 'no', stated_condition: null, reason_code: 'different_subject' })).toEqual({ decision: null, reason: 'not_same_fact' });
      expect(status({ same_fact: 'no', stated_condition: null, reason_code: 'other' })).toEqual({ decision: null, reason: 'not_same_fact' });
    });

    it('(d) past value → historical, even when the judge calls it current', () => {
      const text = 'In 2024 the per diem was raised from $50 to $60.';
      const past = { stated_value: '$50', stated_condition: null, quote: text };
      expect(status({ ...past, mention: 'historical', reason_code: 'historical' }, text)?.decision?.status).toBe('historical');
      expect(status({ ...past, reason_code: 'historical' }, text)?.decision?.status).toBe('historical');
    });
  });
});

describe('judge prompt', () => {
  it('has the few-shot cases and never asks for "no" because the value differs', () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain('Never "no" just because the value differs');
    for (const code of ['"value_differs"', '"different_condition"', '"different_subject"', '"historical"']) expect(JUDGE_SYSTEM_PROMPT).toContain(`reason_code ${code}`);
    expect(JUDGE_SYSTEM_PROMPT).not.toMatch(/is "no" or "unsure"/);
    // Few-shot examples are made up, not the test pages.
    expect(JUDGE_SYSTEM_PROMPT).not.toMatch(/External training|\$40|within 45 days|per diem for domestic/i);
    const schema = JUDGE_TOOL.parameters as { properties: { mentions: { items: { required: string[]; properties: { reason_code: { enum: string[] } } } } } };
    expect(schema.properties.mentions.items.required).toContain('reason_code');
    expect(schema.properties.mentions.items.properties.reason_code.enum).toEqual([...JUDGE_REASON_CODES]);
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
    // "no" with reason_code different_condition: still unsure (L&D budget page), not dropped.
    expect(judgeOutcome(fact('domestic'), judgement('domestic', { sameFact: 'no', statedValue: '$40', statedCondition: 'External training', quote: 'x', reasonCode: 'different_condition' }), siblings).decision?.status).toBe('unsure');
    // An unrelated "no" (same condition or none, or a value of another kind) is not a copy.
    expect(judgeOutcome(fact('domestic'), judgement('domestic', { sameFact: 'no', statedValue: '$40', statedCondition: null, quote: 'x' }))).toEqual({ decision: null, reason: 'not_same_fact' });
    expect(judgeOutcome(fact('domestic'), judgement('domestic', { sameFact: 'no', statedValue: 'economy', statedCondition: 'External training', quote: 'x' }))).toEqual({ decision: null, reason: 'not_same_fact' });
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

  it('logs one summary line per scan with counts only', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const scanId = await fullScan();
      const line = info.mock.calls.find((c) => c[0] === 'ripple scan summary');
      expect(line?.[1]).toMatchObject({
        scanId,
        candidatesPerFact: expect.any(Array),
        candidates: COPY_PAGES.length,
        pagesJudged: COPY_PAGES.length,
        pagesSkipped: 0,
        llmCalls: expect.any(Number),
        partial: false,
        counts: expect.objectContaining({ in_sync: 5, drifted: 2 }),
      });
      expect((line?.[1] as { candidatesPerFact: number[] }).candidatesPerFact).toHaveLength(FACTS.length);
      expect(JSON.stringify(line?.[1])).not.toMatch(/accountId|per diem|\$60/i);
    } finally {
      info.mockRestore();
    }
  });

  it('logs the outcome of every fact on every judged page (ids and labels only)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      // The real judge answers "no" for the training per diem (another condition), as its prompt tells it to.
      await fullScan(jobDeps({ llm: fakeLlm(llmCalls, undefined, (m) => (m.stated_condition === 'External training' ? { ...m, same_fact: 'no', reason_code: 'different_condition' } : m)) }));
      const pageLog = (title: string) => {
        const id = COPY_PAGES.find((p) => p.title === title)?.id;
        return info.mock.calls.find((c) => c[0] === 'ripple judge page' && (c[1] as { pageId: string }).pageId === id)?.[1] as { facts: { factId: string; outcome: string }[]; dropReasons: Record<string, number> };
      };
      expect(pageLog('Finance FAQ').facts).toContainEqual({ factId: factId('claims'), outcome: 'drifted', reasonCode: 'other' });
      const training = COPY_PAGES.find((p) => p.kind === 'trap' && p.expect.domestic === 'unsure');
      expect(pageLog(training?.title ?? '').facts).toContainEqual({ factId: factId('domestic'), outcome: 'unsure', reasonCode: 'different_condition' });
      expect(scans.statusOf('domestic', training?.id ?? '')).toBe('unsure');
      const logged = JSON.stringify(info.mock.calls.filter((c) => c[0] === 'ripple judge page'));
      expect(logged).not.toMatch(/acc-1|per diem|\$40|External training/i);
    } finally {
      info.mockRestore();
    }
  });

  it('live-like judge answers (reason codes; "no" for a different value or condition) still give the expected status for every fixture page', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const expected = (m: JudgeMention) => COPY_PAGES.find((p) => p.judge.includes(m))?.expect[m.fact];
      const live = (m: JudgeMention): JudgeMention => {
        const status = expected(m);
        // Observed live: "no" for the 45 vs 30 days claims copy, and "no" without a condition for the training per diem.
        if (status === 'drifted' && m.fact === 'claims') return { ...m, same_fact: 'no', reason_code: 'value_differs' };
        if (status === 'unsure') return { ...m, same_fact: 'no', stated_condition: null, reason_code: 'different_condition' };
        if (status === 'historical') return { ...m, reason_code: 'historical' };
        return { ...m, reason_code: status === 'drifted' ? 'value_differs' : status === 'in_sync' ? 'value_matches' : 'free text from the model' };
      };
      await fullScan(jobDeps({ llm: fakeLlm(llmCalls, undefined, live) }));
      for (const p of COPY_PAGES) for (const [k, status] of Object.entries(p.expect)) expect(scans.statusOf(k as FactKey, p.id), `${p.title} / ${k}`).toBe(status);
      const logged = info.mock.calls.filter((c) => c[0] === 'ripple judge page').map((c) => c[1] as { facts: { reasonCode?: string }[] });
      const codes = new Set(logged.flatMap((l) => l.facts.map((f) => f.reasonCode)).filter(Boolean));
      expect([...codes].every((c) => /^[a-z_+]+$/.test(c ?? ''))).toBe(true);
      expect(codes).toContain('value_differs');
      expect(codes).toContain('different_condition');
    } finally {
      info.mockRestore();
    }
  });

  it('live run of 3de69c9: value_matches stays in sync, sibling facts get no unsure card, only the training per diem is unsure', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const page = (title: string) => COPY_PAGES.find((p) => p.title === title) as (typeof COPY_PAGES)[number];
      const quoteOf = (title: string, k: FactKey) => page(title).judge.find((m) => m.fact === k)?.quote ?? '';
      const offsite = page('Engineering offsite checklist');
      const training = COPY_PAGES.find((p) => p.kind === 'trap' && p.expect.domestic === 'unsure') as (typeof COPY_PAGES)[number];
      const offsiteQuote = quoteOf(offsite.title, 'domestic');
      const trainingQuote = quoteOf(training.title, 'domestic');
      // What the live judge also answered: the same sentence for the sibling (international) per diem.
      const extra: JudgeMention[] = [
        { fact: 'international', same_fact: 'unsure', mention: 'current', stated_value: '$75', stated_unit: 'per day', stated_condition: null, quote: offsiteQuote, reason_code: 'different_condition' },
        { fact: 'international', same_fact: 'no', mention: 'current', stated_value: '$40', stated_unit: 'per day', stated_condition: 'External training', quote: trainingQuote, reason_code: 'different_condition' },
      ];
      const live = (m: JudgeMention): JudgeMention => {
        if (extra.includes(m)) return m;
        const status = COPY_PAGES.find((p) => p.judge.includes(m))?.expect[m.fact];
        // New joiner FAQ claims (30 days): the judge said value_matches but left same_fact at "unsure".
        if (status === 'in_sync' && m.fact === 'claims') return { ...m, same_fact: 'unsure', reason_code: 'value_matches' };
        if (status === 'unsure') return { ...m, same_fact: 'no', reason_code: 'different_condition' };
        if (status === 'historical') return { ...m, reason_code: 'historical' };
        return { ...m, reason_code: status === 'drifted' ? 'value_differs' : 'value_matches' };
      };
      await fullScan(jobDeps({ llm: fakeLlm(llmCalls, undefined, live, extra) }));
      for (const p of COPY_PAGES)
        for (const k of KEYS) expect(scans.statusOf(k, p.id), `${p.title} / ${k}`).toBe(p.expect[k] ?? null);
      const logs = info.mock.calls.filter((c) => c[0] === 'ripple judge page').map((c) => c[1] as { pageId: string; facts: { factId: string; outcome: string; reasonCode: string }[] });
      const offsiteLog = logs.find((l) => l.pageId === offsite.id);
      expect(offsiteLog?.facts).toContainEqual({ factId: factId('international'), outcome: 'sibling_fact', reasonCode: 'different_condition' });
      // Every fact entry has an enum reason code, also without any judged mention.
      for (const l of logs) for (const f of l.facts) expect(f.reasonCode).toMatch(/^[a-z_+]+$/);
      expect(logs.some((l) => l.facts.some((f) => f.outcome === 'no_match' && f.reasonCode === 'no_mention'))).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it('live run of 12c67ab: the judge names only the international per diem for the training sentence → domestic unsure only', async () => {
    const live = (m: JudgeMention): JudgeMention => {
      const status = COPY_PAGES.find((p) => p.judge.includes(m))?.expect[m.fact];
      if (status === 'unsure') return { ...m, fact: 'international', same_fact: 'no', reason_code: 'different_condition' };
      if (status === 'historical') return { ...m, reason_code: 'historical' };
      return { ...m, reason_code: status === 'drifted' ? 'value_differs' : 'value_matches' };
    };
    await fullScan(jobDeps({ llm: fakeLlm(llmCalls, undefined, live) }));
    for (const p of COPY_PAGES) for (const k of KEYS) expect(scans.statusOf(k, p.id), `${p.title} / ${k}`).toBe(p.expect[k] ?? null);
  });

  it('keeps at most 200 candidates per fact', async () => {
    const many = async (cql: string, max: number): Promise<SearchHit[]> => {
      searchCalls.push({ cql, max });
      return Array.from({ length: 250 }, (_, i) => ({ pageId: String(800000 + i), title: `P${i}`, url: null }));
    };
    const scanId = await newScan();
    await runSearchJob(scanId, 0, jobDeps({ search: many }));
    expect(searchCalls.every((c) => c.max === MAX_CANDIDATES_PER_FACT)).toBe(true);
    for (const f of FACTS) expect(scans.hits.filter((h) => h.factId === f.id)).toHaveLength(MAX_CANDIDATES_PER_FACT);
    expect(scans.scans.get(scanId)?.candidates).toBe(200);
  });

  it('resumes the search from the fact cursor after the run budget is used up', async () => {
    const scanId = await newScan();
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

  /** Synonyms for every fact of the terms call (the default fake answers for fact 1 only). */
  const allTerms = (async (messages: Message[], tool: ToolSpec) => {
    if (tool.name !== 'record_search_terms') return fakeLlm(llmCalls)(messages, tool);
    llmCalls.push({ tool: tool.name });
    return { args: { facts: FACTS.map((_, i) => ({ fact: i + 1, terms: [`synonym ${i + 1}`] })) }, model: 'claude-sonnet-5' };
  }) as unknown as ChatToolFn;

  it('generates CQL synonyms once per fact and reuses them in the next scan (stable candidates)', async () => {
    const first = await newScan();
    await runSearchJob(first, 0, jobDeps({ llm: allTerms }));
    const firstCql = searchCalls.map((c) => c.cql);
    expect(llmCalls.filter((c) => c.tool === 'record_search_terms')).toHaveLength(1);
    expect(scans.searchTerms.size).toBe(FACTS.length);
    expect(scans.scans.get(first)?.synonymsCached).toBe(0);
    await scans.finishScan(first, SOURCE_PAGE_ID, false);

    searchCalls.length = 0;
    const second = await newScan();
    await runSearchJob(second, 0, jobDeps({ llm: allTerms }));
    expect(llmCalls.filter((c) => c.tool === 'record_search_terms')).toHaveLength(1);
    expect(scans.scans.get(second)?.synonymsCached).toBe(FACTS.length);
    expect(searchCalls.map((c) => c.cql)).toEqual(firstCql);

    // An edited subject/attribute/condition (key no longer matches) regenerates only that fact's terms.
    const one = FACTS[0]?.id as string;
    scans.searchTerms.set(one, { key: 'stale|key|', terms: ['old'] });
    await scans.finishScan(second, SOURCE_PAGE_ID, false);
    const third = await newScan();
    await runSearchJob(third, 0, jobDeps({ llm: allTerms }));
    expect(llmCalls.filter((c) => c.tool === 'record_search_terms')).toHaveLength(2);
    expect(scans.scans.get(third)?.synonymsCached).toBe(FACTS.length - 1);
    expect(scans.searchTerms.get(one)?.key).not.toBe('stale|key|');
  });

  it('does not cache an empty synonym answer: the next scan asks again for those facts only', async () => {
    const first = await newScan();
    await runSearchJob(first, 0, jobDeps()); // terms for fact 1 only
    expect(scans.searchTerms.size).toBe(1);
    await scans.finishScan(first, SOURCE_PAGE_ID, false);
    const second = await newScan();
    await runSearchJob(second, 0, jobDeps());
    expect(llmCalls.filter((c) => c.tool === 'record_search_terms')).toHaveLength(2);
    expect(scans.scans.get(second)?.synonymsCached).toBe(1);
  });

  it('does not cache synonyms when the suggestion fails', async () => {
    const failing = (async (messages: Message[], tool: ToolSpec) => {
      if (tool.name === 'record_search_terms') throw new Error('bad output');
      return fakeLlm(llmCalls)(messages, tool);
    }) as ChatToolFn;
    const scanId = await newScan();
    await runSearchJob(scanId, 0, jobDeps({ llm: failing }));
    expect(scans.searchTerms.size).toBe(0);
  });

  it('resumes judging with the first unfinished page and reads no page twice', async () => {
    const scanId = await newScan();
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
    const scanId = await newScan();
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
    const scanId = await newScan();
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
    // "All" lists the historical mention too (its chip counts it), never ignored matches.
    expect(reply.copies.filter((c) => c.status === 'historical').map((c) => c.pageId)).toEqual(['9600005']);
    const historical = await listCopies(ctx, { status: 'historical' }, copyDeps());
    expect('copies' in historical && historical.copies.map((c) => c.pageId)).toEqual(['9600005']);
    expect(await listCopies(ctx, { status: 'bogus' as CopyStatus }, copyDeps())).toEqual({ error: 'Unknown copy status filter.' });
    const status = await getScanStatus(ctx, copyDeps());
    expect(status).toMatchObject({ scan: { state: 'done' }, counts: { drifted: 2 } });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// M2 review fixes
// ---------------------------------------------------------------------------------------------------------------

describe('M2 review: judging rules', () => {
  it('W1: a copy that narrows a fact without a condition is unsure, not drift', () => {
    const claims = fact('claims');
    const training = judgement('claims', { statedValue: '45 days', statedCondition: 'External training', quote: 'External training claims are due within 45 days.' });
    expect(decideStatus(claims, training)?.status).toBe('unsure');
    // Repeating words of the fact itself ("after the trip ends") is not a new condition.
    const same = judgement('claims', { statedValue: '45 days', statedCondition: 'after the trip ends', quote: 'Claims are due within 45 days after the trip ends.' });
    expect(decideStatus(claims, same)?.status).toBe('drifted');
  });

  it('rehearsal: the Expense Claims FAQ sentence (45 days) is drift even when the judge says unsure + value_differs', () => {
    const claims = fact('claims');
    const quote = 'Expense claims must be submitted within 45 days after the trip ends.';
    for (const statedCondition of [null, 'after the trip ends', 'submitted after the trip ends', 'submitted within 45 days after the trip ends']) {
      for (const [statedValue, statedUnit] of [['45 days', 'days'], ['45', 'days after the trip ends']] as const) {
        const j = judgement('claims', { sameFact: 'unsure', reasonCode: 'value_differs', statedValue, statedUnit, statedCondition, quote });
        expect(decideStatus(claims, j)?.status, `${statedCondition} / ${statedValue}`).toBe('drifted');
      }
    }
    // Words the source sentence does not use still narrow the fact.
    const training = judgement('claims', { sameFact: 'unsure', reasonCode: 'value_differs', statedValue: '45 days', statedUnit: 'days', statedCondition: 'External training', quote: 'External training claims must be submitted within 45 days after the trip ends.' });
    expect(decideStatus(claims, training)?.status).toBe('unsure');
    expect(sameCondition(claims, 'filed by contractors', [])).toBe(false);
  });

  it('review: the source sentence counts only without siblings (multi-clause sentence, sibling condition)', () => {
    const quote = 'Domestic travel is $60 per day and international travel is $90 per day.';
    const general: ScanFact = { id: 'g', type: fact('domestic').type, subject: 'Per diem', attribute: 'Daily amount', value: '$60', unit: 'per day', condition: null, previousValue: null, quote };
    const intl: ScanFact = { ...general, id: 'i', value: '$90', condition: 'international travel' };
    for (const [statedValue, statedCondition] of [['$100', 'international travel'], ['$45', 'international travel'], ['$100', 'international trips']] as const) {
      const j: Judgement = { factId: 'g', sameFact: 'unsure', mention: 'current', reasonCode: 'value_differs', statedValue, statedUnit: 'per day', statedCondition, quote: `The per diem for international travel is ${statedValue} per day.` };
      expect(sameCondition(general, statedCondition, [intl])).toBe(false);
      expect(decideStatus(general, j, [intl])?.status, `${statedValue} ${statedCondition}`).not.toBe('drifted');
      // No sibling list (page-level checks) → the sentence is not used either.
      expect(sameCondition(general, statedCondition)).toBe(false);
    }
    // The claims fact has no siblings: C9 stays drift.
    const claims = fact('claims');
    const c9 = judgement('claims', { sameFact: 'unsure', reasonCode: 'value_differs', statedValue: '45 days', statedUnit: 'days', statedCondition: 'submitted after the trip ends', quote: 'Expense claims must be submitted within 45 days after the trip ends.' });
    expect(decideStatus(claims, c9, siblingsOf(claims, FACTS))?.status).toBe('drifted');
  });

  it('rehearsal: a past mention tied to another condition or subject is not a copy; a plain past value stays historical', () => {
    const approval = fact('approval');
    for (const reasonCode of ['different_condition', 'different_subject'] as const) {
      for (const sameFact of ['yes', 'unsure', 'no'] as const) {
        const r = judgeOutcome(approval, judgement('approval', { sameFact, mention: 'historical', reasonCode, statedValue: '$1,000', quote: 'Until 2019, trips over $1,000 for contractors needed VP approval.' }));
        expect(r, `${reasonCode} ${sameFact}`).toEqual({ decision: null, reason: 'not_same_fact' });
      }
    }
    const past = judgeOutcome(approval, judgement('approval', { mention: 'historical', reasonCode: 'historical', statedValue: '$1,500', quote: 'The approval limit was $1,500 until 2025.' }));
    expect(past.decision?.status).toBe('historical');
  });

  it('W2: extra numbers next to the official one are accepted; dates are parsed or unknown', () => {
    const domestic = { value: '60', unit: 'USD' };
    expect(compareValues(domestic, { value: '$60 per day (max 3 days)', unit: null })).toBe('same');
    expect(compareValues(domestic, { value: '$75 per day (max 3 days)', unit: null })).toBe('unknown');
    expect(compareValues(domestic, { value: '$75 per day', unit: null })).toBe('different');
    const date = { value: '2026-01-15', unit: null };
    expect(compareValues(date, { value: 'January 15, 2026', unit: null })).toBe('same');
    expect(compareValues(date, { value: '15 Jan 2026', unit: null })).toBe('same');
    expect(compareValues(date, { value: '15/02/2026', unit: null })).toBe('different');
    expect(compareValues({ value: '2026-03-04', unit: null }, { value: '03/04/2026', unit: null })).toBe('unknown');
    expect(compareValues(date, { value: 'mid January', unit: null })).toBe('unknown');
  });

  it('W3: different units are converted when cheap (weeks/days), otherwise unknown', () => {
    const deadline = { value: '14', unit: 'days' };
    expect(compareValues(deadline, { value: '2 weeks', unit: null })).toBe('same');
    expect(compareValues(deadline, { value: '3 weeks', unit: null })).toBe('different');
    expect(compareValues({ value: '30', unit: 'days' }, { value: '1 month', unit: null })).toBe('unknown');
    expect(compareValues({ value: '60', unit: 'USD' }, { value: '60 EUR', unit: null })).toBe('unknown');
  });

  it('S1: a term without letters or digits is empty', () => {
    expect(cleanTerm('--')).toBe('');
    expect(cleanTerm('$ %')).toBe('');
    expect(cleanTerm('"$60"')).toBe('$60');
    expect(parseTermSuggestions({ facts: [{ fact: 1, terms: ['---', '. , .', 'meal allowance'] }] }, ['a'])).toEqual({ a: ['meal allowance'] });
  });

  it('S2: the quote is checked for past values and invented conditions', () => {
    const chunk = 'Changelog\nThe per diem was raised from $50 to $60 per day.\nPreviously the training budget was $500, now $800.\nPer diem: $75 per day.';
    const base = { fact: 1, same_fact: 'yes', mention: 'current', stated_unit: null, stated_condition: null };
    const { judgements } = parseJudgement(
      {
        mentions: [
          { ...base, stated_value: '$50', quote: 'The per diem was raised from $50 to $60 per day.' },
          { ...base, fact: 2, stated_value: '$500', quote: 'Previously the training budget was $500, now $800.' },
          { ...base, fact: 3, stated_value: '$75', stated_condition: 'weekend trips', quote: 'Per diem: $75 per day.' },
          { ...base, fact: 4, stated_value: '$75', quote: 'Per diem: $75 per day.' },
        ],
      },
      chunk,
      ['a', 'b', 'c', 'd'],
    );
    expect(judgements.map((j) => [j.factId, j.mention, j.sameFact])).toEqual([
      ['a', 'historical', 'yes'],
      ['b', 'current', 'unsure'],
      ['c', 'current', 'unsure'],
      ['d', 'current', 'yes'],
    ]);
  });
});

/** A page whose fact mentions are far apart, so each becomes its own chunk. */
const SPREAD_PAGE = '9700001';
const SPREAD_LINES = ['Domestic trips: the per diem is $60 per day.', 'Expense claims are due within 30 days after the trip ends.', 'Trips over 2,000 USD need manager approval before booking.'];
const spreadBody = SPREAD_LINES.map((l) => `<p>${l}</p>${Array.from({ length: 8 }, (_, i) => `<p>Filler line ${i} about the office.</p>`).join('')}`).join('');
const spreadDeps = (over: Partial<ScanJobDeps> = {}): ScanJobDeps =>
  jobDeps({
    search: async () => [{ pageId: SPREAD_PAGE, title: 'Spread', url: null }],
    page: async (id) => {
      pageReads.push(id);
      return { id, title: 'Spread', spaceId: '7', version: 1, versionCreatedAt: null, body: spreadBody };
    },
    ...over,
  });

describe('M2 review: consumers', () => {
  it('W4: a page the app cannot read (403) or the model refuses is skipped, not the whole scan', async () => {
    const page = jobDeps().page;
    const deps = jobDeps({
      page: async (id) => {
        if (id === '9600003') throw new Error('Confluence REST v2 page 9600003 failed: HTTP 403');
        return page(id);
      },
    });
    const scanId = await fullScan(deps);
    expect(scans.scans.get(scanId)).toMatchObject({ state: 'done', pagesSkipped: 1, pagesJudged: COPY_PAGES.length - 1 });
    expect(scans.statusOf('domestic', '9600003')).toBeNull();
    expect(scans.statusOf('claims', '9600004')).toBe('drifted');

    const refusing = fakeLlm(llmCalls);
    const refused = (async (m: Message[], t: ToolSpec) => {
      if (String(m[1]?.content ?? '').includes('Finance FAQ')) throw Object.assign(new ForgeLlmError('bad request'), { status: 400 });
      return (refusing as unknown as (m: Message[], t: ToolSpec) => Promise<unknown>)(m, t);
    }) as unknown as ChatToolFn;
    const second = await fullScan(jobDeps({ llm: refused }));
    expect(scans.scans.get(second)).toMatchObject({ state: 'done', pagesSkipped: 1 });
  });

  it('W4: an LLM 5xx is retried, then fails the scan', async () => {
    const down = (async (_m: Message[], tool: ToolSpec) => {
      if (tool.name === 'record_search_terms') return { args: { facts: [] }, model: 'm' };
      throw Object.assign(new ForgeLlmError('upstream'), { status: 503 });
    }) as unknown as ChatToolFn;
    const scanId = await newScan();
    await runSearchJob(scanId, 0, jobDeps());
    expect(await runJudgeJob(scanId, 0, jobDeps({ llm: down }))).toMatchObject({ status: 'retry', reason: 'llm-unavailable' });
    expect(await runJudgeJob(scanId, 4, jobDeps({ llm: down }))).toMatchObject({ status: 'failed' });
  });

  it('W5: judge calls are limited in parallel and a retry continues with the chunks not judged yet', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let failClaims = true;
    const base = fakeLlm(llmCalls, () => ({ mentions: [] }));
    const llm = (async (m: Message[], t: ToolSpec) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      if (t.name !== 'record_search_terms' && failClaims && String(m[1]?.content ?? '').includes('Expense claims are due')) {
        failClaims = false;
        throw Object.assign(new ForgeLlmError('rate limited'), { status: 429 });
      }
      return (base as unknown as (m: Message[], t: ToolSpec) => Promise<unknown>)(m, t);
    }) as unknown as ChatToolFn;
    const scanId = await newScan();
    await runSearchJob(scanId, 0, spreadDeps({ llm }));
    llmCalls.length = 0;
    expect(await runJudgeJob(scanId, 0, spreadDeps({ llm }))).toMatchObject({ status: 'retry' });
    const firstRun = llmCalls.map((c) => c.chunk ?? '');
    expect(firstRun.some((c) => c.includes(SPREAD_LINES[0] as string))).toBe(true);
    llmCalls.length = 0;
    expect((await runJudgeJob(scanId, 1, spreadDeps({ llm }))).status).toBe('done');
    const secondRun = llmCalls.map((c) => c.chunk ?? '');
    expect(secondRun.some((c) => c.includes(SPREAD_LINES[0] as string))).toBe(false); // saved, not judged again
    expect(secondRun.some((c) => c.includes(SPREAD_LINES[1] as string))).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(JUDGE_CONCURRENCY);
    expect(scans.chunks.size).toBe(0);
  });

  it('W5: the per-scan LLM call cap ends the scan as partial and keeps earlier copies', async () => {
    await fullScan();
    const before = scans.copies.size;
    const scanId = await newScan();
    await runSearchJob(scanId, 0, jobDeps());
    await scans.addLlmCalls(scanId, MAX_LLM_CALLS_PER_SCAN - 2 - (scans.scans.get(scanId)?.llmCalls ?? 0));
    llmCalls.length = 0;
    const r = await runJudgeJob(scanId, 0, jobDeps());
    expect(r).toMatchObject({ status: 'done', detail: { partial: 1 } });
    expect(llmCalls).toHaveLength(2);
    expect(scans.scans.get(scanId)).toMatchObject({ state: 'done', partial: true, llmCalls: MAX_LLM_CALLS_PER_SCAN });
    expect(scans.copies.size).toBe(before);
  });

  it('W6: the search uses the fact ids fixed when the scan started', async () => {
    const id = await scans.createScan(SOURCE_PAGE_ID, [factId('claims'), 'f-9-removed', factId('domestic')], 'acc-1');
    if (!id) throw new Error('no scan');
    expect(await runSearchJob(id, 0, jobDeps())).toEqual({ status: 'done', detail: { searched: 2, facts: 3 } });
    expect(searchCalls).toHaveLength(2);
    expect(searchCalls[0]?.cql).toContain('Expense claims');
    expect(scans.scans.get(id)?.factCursor).toBe(3);
  });

  it('W7: a source unmarked during the scan stops it and leaves nothing behind', async () => {
    const scanId = await newScan();
    await runSearchJob(scanId, 0, jobDeps());
    const page = jobDeps().page;
    const deps = jobDeps({
      page: async (id) => {
        facts.sources.clear();
        return page(id);
      },
    });
    expect(await runJudgeJob(scanId, 0, deps)).toEqual({ status: 'skipped', reason: 'source unmarked' });
    expect(scans.copies.size).toBe(0);
    expect(scans.scans.has(scanId)).toBe(false);
    expect(scans.hits).toEqual([]);
  });
});

describe('M2 review: resolvers', () => {
  it('W8: two concurrent starts give one running scan', async () => {
    const [a, b] = await Promise.all([startScan(ctx, copyDeps()), startScan(ctx, copyDeps())]);
    expect(scans.scans.size).toBe(1);
    expect(pushes).toHaveLength(1);
    const ids = [a, b].map((r) => ('scan' in r ? r.scan?.id : undefined));
    expect(ids[0]).toBeDefined();
    expect(ids[0]).toBe(ids[1]);
  });

  it('W9 + NFR-3: status counts and the list cover visible pages only; the rest is one total', async () => {
    await fullScan();
    const visible = async (ids: readonly string[]) => new Set(ids.filter((id) => id !== '9600003'));
    const status = await getScanStatus(ctx, copyDeps({ visible }));
    expect(status).toMatchObject({ counts: { drifted: 1, in_sync: 5, unsure: 1, historical: 1 } });
    const list = vi.spyOn(scans, 'listCopies');
    const all = await listCopies(ctx, undefined, copyDeps({ visible }));
    expect(list.mock.calls[0]?.[2]).not.toContain('9600003'); // filtered before the row limit
    expect(all).toMatchObject({ hiddenCount: 1 });
    expect(await listCopies(ctx, { status: 'drifted' }, copyDeps({ visible }))).toMatchObject({ hiddenCount: 1 });
    expect(await listCopies(ctx, { status: 'in_sync' }, copyDeps({ visible }))).toMatchObject({ hiddenCount: 0 });
    // Copies of a fact that is no longer confirmed are neither listed nor counted.
    scans.unconfirmed.add(factId('claims'));
    const after = await getScanStatus(ctx, copyDeps());
    expect(after).toMatchObject({ counts: { drifted: 1, in_sync: 4 } });
  });
});

describe('M6 Nimbus Labs demo data through the scan rules (simulated judge)', () => {
  /** What a careful judge answers for one demo sentence; the trap sentence is also judged against the international per diem. */
  const judged = (n: NimbusMention): Judgement[] => {
    const base = { statedValue: n.statedValue, statedUnit: n.statedUnit, statedCondition: n.statedCondition, quote: n.quote };
    if (n.status === 'historical') return [judgement(n.fact, { ...base, mention: 'historical', reasonCode: 'historical' })];
    if (n.status === 'unsure') {
      return [
        judgement('domestic', { ...base, sameFact: 'unsure', reasonCode: 'different_condition' }),
        judgement('international', { ...base, sameFact: 'no', reasonCode: 'different_condition' }),
      ];
    }
    return [judgement(n.fact, { ...base, reasonCode: n.status === 'in_sync' ? 'value_matches' : 'value_differs' })];
  };
  const pageResults = (p: (typeof NIMBUS_PAGES)[number]) => {
    const items = p.mentions.flatMap(judged).map((j) => {
      const f = FACTS.find((x) => x.id === j.factId) as ScanFact;
      return { fact: f, judgement: j, ...judgeOutcome(f, j, siblingsOf(f, FACTS)) };
    });
    return settleSiblings(items, FACTS).filter((i) => i.decision);
  };

  it('the demo source states the five Travel Policy facts verbatim', () => {
    for (const f of TRAVEL_POLICY_FACTS) expect(NIMBUS_SOURCE.storage).toContain(f.quote);
  });

  it('every sentence gets the status the demo expects; the trap is one unsure card on the domestic per diem', () => {
    for (const p of NIMBUS_PAGES) {
      const got = pageResults(p).map((i) => [i.fact.id, i.decision?.status]);
      expect(got, p.slug).toEqual(p.mentions.map((m) => [factId(m.fact), m.status]));
    }
    const trap = pageResults(NIMBUS_PAGES.find((p) => p.slug === TRAP_SLUG) as (typeof NIMBUS_PAGES)[number]);
    expect(trap.map((i) => [i.fact.id, i.decision?.status])).toEqual([[factId('domestic'), 'unsure']]);
  });

  it('gallery runs: both drift sentences mirror their source sentence and are drift for judge "yes" and "unsure"', () => {
    const sales = NIMBUS_PAGES.find((p) => p.slug === 'sales-travel-guide') as (typeof NIMBUS_PAGES)[number];
    const faq = NIMBUS_PAGES.find((p) => p.slug === 'fin-expense-faq') as (typeof NIMBUS_PAGES)[number];
    const a13 = sales.mentions.find((m) => m.fact === 'approval') as NimbusMention;
    const c9 = faq.mentions.find((m) => m.fact === 'claims') as NimbusMention;
    const d13 = sales.mentions.find((m) => m.fact === 'domestic') as NimbusMention;
    const d9 = faq.mentions.find((m) => m.fact === 'domestic') as NimbusMention;
    // Live extraction variants of the source facts (threshold/booking condition, unit inside the value or not).
    const approvals = [fact('approval'), { ...fact('approval'), condition: 'Trips over $2,000' }, { ...fact('approval'), condition: null, value: '$2,000', unit: null }];
    const claimsFacts = [fact('claims'), { ...fact('claims'), value: '30 days', unit: 'days', condition: 'after the trip ends' }];
    const cases: [ScanFact[], NimbusMention, string[], [string, string | null][], (string | null)[]][] = [
      [approvals, a13, [a13.quote, `${d13.quote} ${a13.quote}`], [['$2,500', null], ['$2,500', 'USD'], ['2500', 'USD']], [null, 'over $2,500', 'Trips over $2,500', 'before booking']],
      [claimsFacts, c9, [c9.quote, `How long do I have to submit? ${c9.quote}`, `${c9.quote} Do I need receipts for meals? ${d9.quote}`], [['45 days', 'days'], ['45', null], ['45', 'days after the trip ends']], [null, 'after the trip ends', 'submitted within 45 days after the trip ends']],
    ];
    for (const [facts, m, quotes, values, conditions] of cases) {
      for (const f of facts) for (const quote of quotes) for (const [statedValue, statedUnit] of values) for (const statedCondition of conditions) for (const sameFact of ['yes', 'unsure'] as const) {
        const j = judgement(m.fact as FactKey, { sameFact, reasonCode: 'value_differs', statedValue, statedUnit, statedCondition, quote });
        expect(judgeOutcome(f, j, siblingsOf(f, FACTS)).decision?.status, `${m.fact} ${sameFact} ${statedValue}|${statedUnit} c=${statedCondition} q=${quote}`).toBe('drifted');
      }
    }
    // Not a mirror: other wording, another currency or no currency sign, a condition the sentence lacks, a past value,
    // two numbers in the sentence, another reason code.
    const approval = fact('approval');
    const unsure = (over: Partial<Judgement>) => judgeOutcome(approval, judgement('approval', { sameFact: 'unsure', reasonCode: 'value_differs', statedValue: '$2,500', statedUnit: 'USD', statedCondition: null, quote: a13.quote, ...over }), []).decision?.status;
    expect(unsure({ quote: 'Trips over $2,500 require manager approval before booking, except conferences.' })).toBe('unsure');
    expect(unsure({ quote: 'Trips over €2,500 require manager approval before booking.', statedValue: '€2,500', statedUnit: 'EUR' })).not.toBe('drifted');
    expect(unsure({ quote: 'Trips over 2,500 require manager approval before booking.', statedUnit: null, statedValue: '2,500' })).toBe('unsure');
    expect(unsure({ statedCondition: 'external contractors' })).toBe('unsure');
    expect(unsure({ quote: 'Trips over $2,500 require manager approval before booking within 3 days.' })).toBe('unsure');
    expect(unsure({ reasonCode: 'ambiguous' })).toBe('unsure');
    expect(unsure({ quote: 'Until 2025, trips over $2,500 require manager approval before booking.' })).toBe('unsure');
    const claimsUnsure = judgeOutcome(fact('claims'), judgement('claims', { sameFact: 'unsure', reasonCode: 'value_differs', statedValue: '45 days', statedUnit: 'days', statedCondition: 'External training', quote: 'External training claims must be submitted within 45 days after the trip ends.' }), []).decision?.status;
    expect(claimsUnsure).toBe('unsure');
  });

  it('live shape of 8.34.0 (Sales Team Travel Guide): approval $2,500 judged unsure / value_differs is drifted only when the quote proves it', () => {
    const sales = NIMBUS_PAGES.find((p) => p.slug === 'sales-travel-guide');
    const a13 = sales?.mentions.find((m) => m.fact === 'approval') as NimbusMention;
    expect(a13.quote).toBe('Trips over $2,500 require manager approval before booking.');
    const approval = fact('approval');
    const status = (over: Partial<Judgement>, f: ScanFact = approval) =>
      judgeOutcome(f, judgement('approval', { sameFact: 'unsure', reasonCode: 'value_differs', statedValue: a13.statedValue, statedUnit: a13.statedUnit, statedCondition: a13.statedCondition, quote: a13.quote, ...over }), siblingsOf(f, FACTS)).decision?.status;
    // The simulated judge always answered "yes" for drifted sentences, so the Nimbus test never saw this answer.
    expect(status({})).toBe('drifted');
    expect(status({ statedCondition: null })).toBe('drifted');
    // The live fact may keep its threshold as the condition: "$2,000" is the fact's own value, not a narrowing.
    const threshold = { ...approval, condition: 'Trips over $2,000' };
    expect(sameCondition(threshold, 'trips over $2,500')).toBe(true);
    expect(status({ statedCondition: 'trips over $2,500' }, threshold)).toBe('drifted');
    expect(sameCondition({ ...approval, condition: 'Flights over $2,000 for contractors' }, 'trips over $2,500')).toBe(false);
    // Negative: another condition, another unit, a past value, no subject word, other answers.
    expect(status({ statedCondition: 'external contractors', quote: 'External contractors over $2,500 need manager approval.' })).toBe('unsure');
    expect(status({ statedCondition: 'trips over $2,500 for external contractors' }, threshold)).toBe('unsure');
    expect(status({ statedValue: '€2,500', statedUnit: 'EUR', quote: 'Trips over €2,500 need manager approval before booking.' })).not.toBe('drifted');
    expect(status({ statedValue: '2,500', statedUnit: null, quote: 'Trips over 2,500 need manager approval before booking.' })).toBe('unsure');
    expect(status({ statedUnit: null, statedValue: '2,500', quote: 'Trips over 2,500 need manager approval before booking.' }, { ...approval, unit: null })).not.toBe('drifted');
    expect(status({ quote: 'Manager approval for trips was $2,500.', statedCondition: null })).toBe('unsure');
    expect(status({ quote: 'Anything over $2,500 needs a second signature.', statedCondition: null })).toBe('unsure');
    expect(status({ statedCondition: 'before boarding' })).toBe('unsure');
    expect(status({ reasonCode: 'ambiguous' })).toBe('unsure');
    expect(status({ mention: 'historical' })).toBe('historical');
    // Review: limit/scope wording must match the fact's sentence ("over"/"under" are stopwords in sameCondition).
    expect(status({ quote: 'Trips under $2,500 need manager approval before booking.' })).toBe('unsure');
    expect(status({ quote: 'Trips up to $2,500 need manager approval before booking.' })).toBe('unsure');
    expect(status({ quote: 'Only trips over $2,500 need manager approval before booking.' })).toBe('unsure');
    expect(status({ quote: 'Trips over $2,500 need manager approval before booking, except conferences.' })).toBe('unsure');
    expect(status({ statedCondition: null, quote: 'Trips up to $2,500 for executives need manager approval before booking.' })).toBe('unsure');
    expect(status({ statedCondition: null, quote: 'Trips over $2,500 for executives need manager approval before booking.' })).toBe('unsure');
    expect(status({ quote: 'Trips above $2,500 need manager approval before booking.' })).toBe('drifted');
    // More than one number in the sentence: not provable.
    expect(status({ quote: 'Trips over $2,500 need manager approval before booking, up to 3 per month.' })).toBe('unsure');
    expect(status({ quote: 'Trips over $2,500 need manager approval 2 weeks before booking.' })).toBe('unsure');
    // Rate: the unit check drops "per day", so the rates are compared here.
    const domestic = fact('domestic');
    const perDiem = (quote: string, statedUnit: string | null = 'per day') =>
      judgeOutcome(domestic, judgement('domestic', { sameFact: 'unsure', reasonCode: 'value_differs', statedValue: '$75', statedUnit, statedCondition: 'domestic travel', quote }), siblingsOf(domestic, FACTS)).decision?.status;
    expect(perDiem('The per diem for domestic travel is $75 per day.')).toBe('drifted');
    expect(perDiem('The per diem for domestic travel is $75 per week.', 'per week')).toBe('unsure');
    expect(perDiem('The per diem for domestic travel is $75 per trip.', 'per trip')).toBe('unsure');
    expect(perDiem('The per diem for domestic travel is $75.', null)).toBe('unsure');
    // Every drifted demo sentence stays drifted when the judge hedges with unsure / value_differs.
    for (const m of NIMBUS_PAGES.flatMap((p) => p.mentions).filter((x) => x.status === 'drifted')) {
      const f = fact(m.fact);
      const j = judgement(m.fact, { sameFact: 'unsure', reasonCode: 'value_differs', statedValue: m.statedValue, statedUnit: m.statedUnit, statedCondition: m.statedCondition, quote: m.quote });
      expect(judgeOutcome(f, j, siblingsOf(f, FACTS)).decision?.status, m.quote).toBe('drifted');
    }
  });

  it('byline counts: "23 copies, 4 out of date"; the historical mention is not a copy', () => {
    const statuses = NIMBUS_PAGES.flatMap((p) => pageResults(p).map((i) => i.decision?.status));
    const count = (s: CopyStatus) => statuses.filter((x) => x === s).length;
    expect(count('in_sync')).toBe(NIMBUS_EXPECTED.inSync);
    expect(count('drifted')).toBe(NIMBUS_EXPECTED.outOfDate);
    expect(count('unsure')).toBe(NIMBUS_EXPECTED.unsure);
    expect(count('historical')).toBe(NIMBUS_EXPECTED.historical);
    expect(count('in_sync') + count('drifted') + count('unsure')).toBe(NIMBUS_EXPECTED.copies);
    expect(NIMBUS_EXPECTED).toMatchObject({ copies: 23, outOfDate: 4 });
  });
});
