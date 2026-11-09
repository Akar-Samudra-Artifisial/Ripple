import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: (s: TemplateStringsArray) => s.join('') }));

import {
  OWNER_VARIANTS,
  ownersFromPage,
  pageAri,
  parseConnection,
  parseContributors,
  parseOwners,
  parseSpaceTeams,
  pickBest,
  queryContext,
  readPageOwners,
  readSpaceTeams,
  scrubErrorText,
  spaceAri,
  type GraphRequest,
  type GraphUser,
} from '../src/adapters/teamworkGraph';

const ACCOUNT = '5b10ac8d82e05b22cc7d4ef5';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('ARIs and query context', () => {
  it('builds the page, space and site ARIs the graph expects', () => {
    expect(pageAri('c1', '42')).toBe('ari:cloud:confluence:c1:page/42');
    expect(spaceAri('c1', '7')).toBe('ari:cloud:confluence:c1:space/7');
    expect(queryContext('c1')).toBe('ari:cloud:platform::site/c1');
  });

  it('uses company-prefixed operation names that appear in their query', () => {
    for (const v of OWNER_VARIANTS) expect(v.operation).toMatch(/^ripple_/);
  });
});

describe('parseConnection', () => {
  it('counts null nodes and union types instead of dropping them silently', () => {
    const r = parseConnection(
      { data: { confluencePageOwners: { edges: [{ node: { __typename: 'AtlassianUser', id: 'x' } }, { node: null }], pageInfo: { hasNextPage: true } } } },
      'confluencePageOwners',
    );
    expect(r).toMatchObject({ rawCount: 2, nullNodes: 1, types: ['AtlassianUser'], dataPresent: true, hasNextPage: true, errors: [] });
  });

  it('reports data: null (missing scope or query context) as dataPresent false', () => {
    expect(parseConnection({ data: null }, 'confluencePageOwners')).toMatchObject({ rawCount: 0, dataPresent: false });
  });

  it('keeps GraphQL errors next to data, scrubbed of ARIs', () => {
    const r = parseConnection({ data: { f: { edges: [] } }, errors: [{ message: 'bad ari:cloud:confluence:c1:page/1' }] }, 'f');
    expect(r.errors).toEqual(['bad <ari>']);
    expect(r.dataPresent).toBe(true);
  });
});

describe('parsers', () => {
  it('reads owners from accountId or the identity ARI tail, deduplicated', () => {
    const r = parseOwners({
      data: {
        confluencePageOwners: {
          edges: [
            { node: { __typename: 'AtlassianUser', id: `ari:cloud:identity::user/${ACCOUNT}` } },
            { node: { __typename: 'AtlassianUser', accountId: ACCOUNT, name: 'Ana' } },
            { node: { __typename: 'AtlassianUser', accountId: 'other', name: 'Bo' } },
          ],
        },
      },
    });
    expect(r.owners).toEqual([
      { accountId: ACCOUNT, name: null },
      { accountId: 'other', name: 'Bo' },
    ]);
  });

  it('reads contributors', () => {
    const r = parseContributors({ data: { confluencePageContributors: { edges: [{ node: { accountId: 'a' } }, { node: { id: 'no-user' } }] } } });
    expect(r.contributors).toEqual([{ accountId: 'a', name: null }]);
  });

  it('reads space teams, naming unnamed ones', () => {
    const r = parseSpaceTeams({ data: { atlassianTeamsBySpace: { edges: [{ node: { id: 't1', displayName: 'Platform Team' } }, { node: { id: 't2' } }, { node: { displayName: 'no id' } }] } } });
    expect(r.teams).toEqual([
      { id: 't1', name: 'Platform Team' },
      { id: 't2', name: 'Unnamed team' },
    ]);
  });
});

describe('pickBest', () => {
  const users = (n: number, named = false): GraphUser[] => Array.from({ length: n }, (_, i) => ({ accountId: `u${i}`, name: named ? `N${i}` : null }));

  it('returns null when no variant has owners', () => {
    expect(pickBest([{ owners: [] }, { owners: [] }])).toBeNull();
  });

  it('prefers more owners, then named owners on a tie, then the first variant', () => {
    const a = { key: 'A', owners: users(1) };
    const b = { key: 'B', owners: users(2) };
    const c = { key: 'C', owners: users(2, true) };
    expect(pickBest([a, b])).toBe(b);
    expect(pickBest([a, b, c])).toBe(c);
    expect(pickBest([b, { key: 'D', owners: users(2) }])).toBe(b);
  });
});

describe('ownersFromPage', () => {
  it('lists owner then author, once each', () => {
    expect(ownersFromPage({ ownerId: 'o', authorId: 'a' })).toEqual([
      { accountId: 'o', role: 'owner' },
      { accountId: 'a', role: 'author' },
    ]);
    expect(ownersFromPage({ ownerId: 'o', authorId: 'o' })).toEqual([{ accountId: 'o', role: 'owner' }]);
    expect(ownersFromPage({})).toEqual([]);
  });
});

describe('scrubErrorText', () => {
  it('removes ARIs and account ids and caps the length', () => {
    const text = scrubErrorText(`user ${ACCOUNT} and 557058:12345678-1234-1234-1234-123456789abc at ari:cloud:identity::user/x ${'z'.repeat(400)}`);
    expect(text).not.toContain(ACCOUNT);
    expect(text).toContain('<accountId> and <accountId> at <ari>');
    expect(text.length).toBeLessThanOrEqual(200);
  });

  it('removes prefixed account ids with a 5 to 7 digit prefix', () => {
    const uuid = '12345678-1234-1234-1234-123456789abc';
    expect(scrubErrorText(`a 12345:${uuid} b 1234567:${uuid}`)).toBe('a <accountId> b <accountId>');
  });
});

describe('reads', () => {
  it('runs every owner variant in order and turns request failures into errors', async () => {
    const request = vi.fn<GraphRequest>(async (_q, _v, operation) =>
      operation === 'ripple_pageOwnersB' ? { failure: 'HTTP 500: boom' } : { body: { data: { confluencePageOwners: { edges: [{ node: { accountId: 'u1' } }] } } } },
    );
    const results = await readPageOwners(request, 'c1', '42');
    expect(request.mock.calls.map((c) => c[2])).toEqual(['ripple_pageOwnersA', 'ripple_pageOwnersB', 'ripple_pageOwnersC']);
    expect(request.mock.calls[0]?.[1]).toEqual({ id: 'ari:cloud:confluence:c1:page/42' });
    expect(results.map((r) => r.owners.length)).toEqual([1, 0, 1]);
    expect(results[1]?.errors).toEqual(['HTTP 500: boom']);
  });

  it('reads space teams with the space ARI', async () => {
    const request = vi.fn<GraphRequest>(async () => ({ body: { data: { atlassianTeamsBySpace: { edges: [{ node: { id: 't1', displayName: 'Platform Team' } }] } } } }));
    const r = await readSpaceTeams(request, 'c1', '7');
    expect(request).toHaveBeenCalledWith(expect.stringContaining('atlassianTeamsBySpace'), { spaceAri: 'ari:cloud:confluence:c1:space/7' }, 'ripple_spaceTeams');
    expect(r.teams).toEqual([{ id: 't1', name: 'Platform Team' }]);
  });
});
