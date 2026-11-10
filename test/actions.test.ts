import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: (s: TemplateStringsArray) => s.join('') }));
vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: {} }));
vi.mock('@forge/events', () => ({ Queue: class {} }));

import type { FoundFact } from '../src/adapters/repo';
import type { CopyView } from '../src/core/views';
import { bestFacts, factKeeperAction, topicWords, type ActionDeps } from '../src/surfaces/actions';

const SOURCE = '9100001';
const RESTRICTED = '9100002';

const fact = (id: string, source: string, condition: string, value: string): FoundFact => ({
  id,
  type: 'number',
  subject: 'Travel per diem',
  attribute: 'Amount per day',
  value,
  unit: 'per day',
  condition,
  quote: `The per diem for ${condition} is ${value} per day.`,
  status: 'confirmed',
  edited: false,
  previousValue: null,
  pageVersion: 3,
  effectiveSince: null,
  sourcePageId: source,
  sourceTitle: source === SOURCE ? 'Travel Policy' : 'Secret Policy',
});

const copy = (id: string, factId: string, pageId: string, status: CopyView['status'], statedValue: string, space = 'NLFIN'): CopyView => ({
  id,
  factId,
  factLabel: 'Travel per diem · Amount per day',
  officialValue: '$60',
  officialUnit: 'per day',
  pageId,
  pageTitle: `Page ${pageId}`,
  pageUrl: `/spaces/${space}/pages/${pageId}/x`,
  status,
  statedValue,
  statedUnit: 'per day',
  statedCondition: null,
  quote: `secret sentence ${statedValue}`,
  reason: 'Value differs',
  judgedAt: null,
});

const FACTS = [fact('f-dom', SOURCE, 'Domestic travel', '$60'), fact('f-int', SOURCE, 'International travel', '$90'), fact('f-hidden', RESTRICTED, 'Domestic travel', '$999')];
const COPIES = [copy('c1', 'f-dom', '700', 'drifted', '$65'), copy('c2', 'f-dom', '701', 'in_sync', '$60'), copy('c3', 'f-dom', '702', 'drifted', '$55'), copy('c4', 'f-int', '703', 'drifted', '$100', 'NLSALES')];
/** Pages the asking user can read: not the restricted source, not copy 702. */
const READABLE = new Set([SOURCE, '700', '701', '703']);

let deps: ActionDeps;
let logs: unknown[][];

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => void logs.push(a));
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logs.push(a));
  deps = {
    search: {
      searchConfirmedFacts: vi.fn(async (words: readonly string[]) => FACTS.filter((f) => words.some((w) => `${f.subject} ${f.attribute} ${f.condition} ${f.value}`.toLowerCase().includes(w)))),
      readySources: vi.fn(async () => [
        { pageId: SOURCE, title: 'Travel Policy' },
        { pageId: RESTRICTED, title: 'Secret Policy' },
      ]),
    },
    scans: {
      copyPageIds: vi.fn(async (s: string) => (s === SOURCE ? ['700', '701', '702', '703'] : ['704'])),
      listCopies: vi.fn(async (s: string, status: CopyView['status'] | undefined, pageIds: readonly string[]) =>
        s === SOURCE ? COPIES.filter((c) => (!status || c.status === status) && pageIds.includes(c.pageId)) : [],
      ),
    },
    changes: {
      confirmedChanges: vi.fn(async () => [
        {
          id: 'ch-1',
          sourcePageId: SOURCE,
          status: 'confirmed' as const,
          pageVersion: 4,
          factChanges: [{ factId: 'f-dom', oldValue: '$60', oldUnit: 'per day', newValue: '$75', newUnit: 'per day', newQuote: 'x', version: 4, versionAt: null }],
          missingFactIds: [],
          impact: null,
          routing: { deadline: '2026-11-20', pages: [], teams: [] } as never,
          deadlineDays: 5,
          createdAt: null,
        },
      ]),
    },
    proposals: {
      listForChange: vi.fn(async () => [{ pageId: '700', status: 'applied' }, { pageId: '701', status: 'proposed' }, { pageId: '702', status: 'proposed' }] as never),
    },
    visible: vi.fn(async (ids: readonly string[]) => new Set(ids.filter((id) => READABLE.has(id)))),
    link: vi.fn(async (id: string) => ({ title: 'Travel Policy', url: `https://site.atlassian.net/wiki/spaces/NLHR/pages/${id}/Travel+Policy`, idUrl: `https://site.atlassian.net/wiki/pages/viewpage.action?pageId=${id}` })),
    now: () => new Date('2026-11-25T09:00:00Z'),
    ensure: vi.fn(async () => undefined),
  };
});

const run = (moduleKey: string, inputs: Record<string, unknown>) => factKeeperAction({ ...inputs, context: { moduleKey } }, {}, deps);

describe('M7 Rovo Fact Keeper', () => {
  it('turns a question into search words', () => {
    expect(topicWords("What's the per diem for domestic travel?")).toEqual(['diem', 'domestic', 'travel']);
    expect(topicWords('expense claims %_ deadline')).toEqual(['expense', 'claim', 'deadline']);
    expect(topicWords('the per for')).toEqual([]);
  });

  it('a single shared word is not an answer', () => {
    expect(bestFacts([fact('a', SOURCE, 'Domestic travel', '$60')], ['refund', 'window', 'travel'])).toEqual([]);
  });

  it('get-fact: answers with the confirmed value, condition, source link and out-of-date copies the user can open', async () => {
    const r = await run('get-fact', { topic: 'domestic per diem' });
    expect(r).toMatchObject({ status: 'found' });
    if (!('facts' in r)) throw new Error('no facts');
    expect(r.facts).toHaveLength(1);
    const [f] = r.facts;
    expect(f).toMatchObject({ value: '$60 per day', condition: 'Domestic travel', sourceTitle: 'Travel Policy', sourceUrl: expect.stringContaining(`/pages/${SOURCE}/`), outOfDateCount: 1 });
    expect(f?.outOfDateCopies).toEqual([expect.objectContaining({ pageTitle: 'Page 700', statedValue: '$65 per day', pageUrl: 'https://site.atlassian.net/wiki/spaces/NLFIN/pages/700/x' })]);
  });

  it('get-fact: never answers from a source page the user cannot read', async () => {
    const r = await run('get-fact', { topic: 'domestic per diem' });
    expect(JSON.stringify(r)).not.toContain('$999');
    expect(JSON.stringify(r)).not.toContain('Secret Policy');
    expect(deps.link).not.toHaveBeenCalledWith(RESTRICTED);
    READABLE.delete(SOURCE);
    try {
      expect(await run('get-fact', { topic: 'domestic per diem' })).toMatchObject({ status: 'not_found', facts: [] });
    } finally {
      READABLE.add(SOURCE);
    }
  });

  it('get-fact: no matching fact → not_found, nothing made up', async () => {
    expect(await run('get-fact', { topic: 'refund window' })).toMatchObject({ status: 'not_found', facts: [] });
    expect(await run('get-fact', { topic: '' })).toMatchObject({ status: 'not_found' });
    expect(await run('get-fact', {})).toMatchObject({ status: 'not_found' });
  });

  it('find-copies lists every readable copy with its status', async () => {
    const r = await run('find-copies', { topic: 'international per diem' });
    if (!('facts' in r)) throw new Error('no facts');
    expect(r.facts.map((f) => f.copies?.map((c) => c.status))).toEqual([['drifted']]);
  });

  it('list-out-of-date: readable drifted copies, filtered by space key', async () => {
    const all = await run('list-out-of-date', {});
    expect(all).toMatchObject({ status: 'found', total: 2 });
    const sales = await run('list-out-of-date', { spaceKey: 'nlsales', owner: 'someone' });
    expect(sales).toMatchObject({ status: 'found', total: 1, message: expect.stringContaining('not supported') });
    expect(await run('list-out-of-date', { spaceKey: 'NLHELP' })).toMatchObject({ status: 'none', total: 0 });
    expect(await run('list-out-of-date', { spaceKey: 'bad key)' })).toMatchObject({ status: 'error' });
  });

  it('rollout-status counts only readable pages and gives the deadline', async () => {
    const r = await run('rollout-status', { topic: 'domestic per diem' });
    expect(r).toMatchObject({ status: 'found', rollouts: [{ deadline: '2026-11-20', deadlineState: 'late', lateCount: 1, counts: { applied: 1, proposed: 1 }, hiddenCount: 1 }] });
    expect(await run('rollout-status', { topic: 'international per diem' })).toMatchObject({ status: 'not_found' });
  });

  it('propose-updates stays on the source page; unknown actions are refused', async () => {
    expect(await run('propose-updates', { topic: 'x' })).toMatchObject({ status: 'not_implemented' });
    expect(await run('nope', {})).toMatchObject({ status: 'not_implemented' });
  });

  it('a failure is an error reply, and logs carry no value, quote, title or account id', async () => {
    deps.search.searchConfirmedFacts = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await run('get-fact', { topic: 'domestic per diem' })).toMatchObject({ status: 'error', facts: [] });
    await run('list-out-of-date', {});
    const text = JSON.stringify(logs);
    for (const leak of ['$60', '$65', 'secret sentence', 'Travel Policy', 'Page 700', 'diem']) expect(text).not.toContain(leak);
  });
});
