import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: (s: TemplateStringsArray) => s.join('') }));
vi.mock('@forge/events', () => ({ Queue: class {} }));
vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: {} }));

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
  classifyGraphError,
  parseRetryAfter,
  scrubErrorText,
  siteOf,
  SPACE_TEAMS_ATTEMPTS,
  SPACE_TEAMS_JITTER_MS,
  SPACE_TEAMS_RETRY_AFTER_CAP_MS,
  spaceAri,
  type GraphRequest,
  type SpaceTeamsRead,
  type GraphUser,
} from '../src/adapters/teamworkGraph';
import { SPACE_TEAMS_FRESH_SECONDS, SPACE_TEAMS_STALE_SECONDS, spaceTeamsLookup, type CachedTeams, type SpaceTeamCache } from '../src/adapters/spaceTeams';

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

  const denied = { body: { data: null, errors: [{ message: 'User is not permitted to query this organization' }] } };
  const ok = { body: { data: { atlassianTeamsBySpace: { edges: [{ node: { id: 't1', displayName: 'Platform Team' } }] } } } };

  it('retries a space-teams read without data with 300/800 ms plus jitter and stops at attempt 3', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const opts = { sleep, random: () => 0.5, now: () => 0 };
    const request = vi.fn<GraphRequest>().mockResolvedValueOnce(denied).mockResolvedValueOnce(ok);
    const r = await readSpaceTeams(request, 'c1', '7', opts);
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([300 + 0.5 * SPACE_TEAMS_JITTER_MS]);
    expect(r).toMatchObject({ teams: [{ id: 't1', name: 'Platform Team' }], errorClass: null, attempts: 2 });

    sleep.mockClear();
    const always = vi.fn<GraphRequest>(async () => denied);
    const failed = await readSpaceTeams(always, 'c1', '7', opts);
    expect(always).toHaveBeenCalledTimes(SPACE_TEAMS_ATTEMPTS);
    expect(SPACE_TEAMS_ATTEMPTS).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([400, 900]); // no wait after the last attempt
    expect(failed).toMatchObject({ errorClass: 'gql_not_permitted', attempts: 3, dataPresent: false });

    const empty = vi.fn<GraphRequest>(async () => ({ body: { data: { atlassianTeamsBySpace: { edges: [] } } } }));
    expect(await readSpaceTeams(empty, 'c1', '7', opts)).toMatchObject({ teams: [], errorClass: null });
    expect(empty).toHaveBeenCalledTimes(1); // "no teams" is an answer, not a failure
  });

  it('honours Retry-After (capped) and stops when the next wait would pass the time budget', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const throttled = vi.fn<GraphRequest>(async () => ({ failure: 'HTTP 429: slow down', status: 429, retryAfterMs: 1000 }));
    await readSpaceTeams(throttled, 'c1', '7', { sleep, now: () => 0 });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 1000]);

    sleep.mockClear();
    const long = vi.fn<GraphRequest>(async () => ({ failure: 'HTTP 503: busy', status: 503, retryAfterMs: 60_000 }));
    const r = await readSpaceTeams(long, 'c1', '7', { sleep, now: () => 0 });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([SPACE_TEAMS_RETRY_AFTER_CAP_MS, SPACE_TEAMS_RETRY_AFTER_CAP_MS]);
    expect(r.errorClass).toBe('http_5xx');

    sleep.mockClear();
    let clock = 0;
    const slow = vi.fn<GraphRequest>(async () => {
      clock += 3500; // each request takes 3.5 s
      return denied;
    });
    await readSpaceTeams(slow, 'c1', '7', { sleep, now: () => clock, random: () => 0 });
    // 3.5 s + 300 ms fits the 4 s budget; after the second attempt (7 s) no third one starts.
    expect(slow).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([300]);
  });

  it('logs the error class, attempt, cloud id source and Retry-After presence only (no error text, ARI or cloud id)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const request = vi.fn<GraphRequest>().mockResolvedValueOnce({ failure: 'HTTP 429: ari:cloud:confluence:c1:space/7', status: 429, retryAfterMs: 10 }).mockResolvedValueOnce(ok);
    await readSpaceTeams(request, 'cloud-123', '7', { sleep: async () => undefined, cloudIdSource: 'install' });
    expect(info.mock.calls.map((c) => c[1])).toEqual([
      { op: 'ripple_spaceTeams', spaceId: '7', attempt: 1, count: 0, dataPresent: false, errorClass: 'http_429', cloudIdSource: 'install', retryAfter: true },
      { op: 'ripple_spaceTeams', spaceId: '7', attempt: 2, count: 1, dataPresent: true, errorClass: null, cloudIdSource: 'install', retryAfter: false },
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/ari:cloud|cloud-123|not permitted|HTTP 429/);
  });

  it('classifies failed reads', () => {
    const meta = (errors: string[], dataPresent = false) => ({ errors, dataPresent });
    const f = (status?: number, network?: boolean) => ({ failure: 'x', ...(status !== undefined ? { status } : {}), ...(network ? { network } : {}) });
    expect(classifyGraphError(f(401), meta(['x']))).toBe('http_401');
    expect(classifyGraphError(f(403), meta(['x']))).toBe('http_403');
    expect(classifyGraphError(f(429), meta(['x']))).toBe('http_429');
    expect(classifyGraphError(f(502), meta(['x']))).toBe('http_5xx');
    expect(classifyGraphError(f(400), meta(['x']))).toBe('http_other');
    expect(classifyGraphError(f(undefined, true), meta(['x']))).toBe('network');
    expect(classifyGraphError({ body: {} }, meta(['User is not permitted to query this organization']))).toBe('gql_not_permitted');
    expect(classifyGraphError({ body: {} }, meta(['Rate limit exceeded']))).toBe('gql_rate_limited');
    expect(classifyGraphError({ body: {} }, meta(['Something else']))).toBe('gql_other');
    expect(classifyGraphError({ body: {} }, meta([]))).toBe('gql_other'); // data: null without errors
    expect(classifyGraphError({ body: {} }, meta(['partial'], true))).toBeNull();
  });

  it('parses Retry-After and the site id of the install context', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('Mon, 09 Nov 2026 10:00:03 GMT', Date.parse('2026-11-09T10:00:00Z'))).toBe(3000);
    expect(siteOf({ cloudId: 'c1', installContext: 'ari:cloud:confluence::site/11111111-2222' })).toEqual({ cloudId: 'c1', source: 'context' });
    expect(siteOf({ installContext: 'ari:cloud:confluence::site/11111111-2222' })).toEqual({ cloudId: '11111111-2222', source: 'install' });
    expect(siteOf({ installContext: 'nonsense' })).toBeUndefined();
  });
});

describe('spaceTeamsLookup (cache and dedup)', () => {
  const T = [{ id: 't1', name: 'Platform Team' }];
  const read = (r: Partial<SpaceTeamsRead>) => vi.fn(async (): Promise<SpaceTeamsRead> => ({ teams: [], rawCount: 0, nullNodes: 0, types: [], dataPresent: true, hasNextPage: false, errors: [], errorClass: null, attempts: 1, ...r }));
  const memCache = (entry?: CachedTeams) => {
    const puts: [string, readonly { id: string; name: string }[]][] = [];
    const cache: SpaceTeamCache = { get: vi.fn(async () => entry), put: vi.fn(async (s, t) => void puts.push([s, t])) };
    return { cache, puts };
  };
  const lookupWith = (cache: SpaceTeamCache, r: ReturnType<typeof read>) => spaceTeamsLookup({ request: vi.fn(), cache, cloudId: 'c1', cloudIdSource: 'context', read: r });

  it('fresh cache hit: no graph read', async () => {
    const { cache } = memCache({ teams: T, ageSeconds: SPACE_TEAMS_FRESH_SECONDS - 1 });
    const r = read({ teams: [] });
    expect(await lookupWith(cache, r)('7')).toEqual({ teams: T, origin: 'cached', dataPresent: true, errors: [] });
    expect(r).not.toHaveBeenCalled();
  });

  it('miss: reads the graph and stores a complete, non-empty answer only', async () => {
    const { cache, puts } = memCache();
    expect(await lookupWith(cache, read({ teams: T }))('7')).toMatchObject({ teams: T, origin: 'live' });
    // "No teams" may only mean this user's graph access is limited: shown, never stored for other users.
    expect(await lookupWith(cache, read({ teams: [] }))('8')).toMatchObject({ teams: [], origin: 'live', dataPresent: true });
    // A list with more pages is not the space's full list: shown, not stored.
    expect(await lookupWith(cache, read({ teams: T, hasNextPage: true }))('9')).toMatchObject({ teams: T, origin: 'live' });
    expect(puts).toEqual([['7', T]]);
  });

  it('an empty answer does not overwrite a cached team list', async () => {
    const old = memCache({ teams: T, ageSeconds: SPACE_TEAMS_FRESH_SECONDS + 1 });
    expect(await lookupWith(old.cache, read({ teams: [] }))('7')).toMatchObject({ teams: [], origin: 'live' });
    expect(old.puts).toEqual([]);
  });

  it('expired entry and a failing graph: the stale entry (≤24 h) is shown without errors; errors are never stored', async () => {
    const failing = read({ dataPresent: false, errors: ['User is not permitted to query this organization'], errorClass: 'gql_not_permitted', attempts: 3 });
    const old = memCache({ teams: T, ageSeconds: 3600 });
    expect(await lookupWith(old.cache, failing)('7')).toEqual({ teams: T, origin: 'stale', dataPresent: true, errors: [] });
    expect(old.puts).toEqual([]);

    const tooOld = memCache({ teams: T, ageSeconds: SPACE_TEAMS_STALE_SECONDS + 1 });
    expect(await lookupWith(tooOld.cache, failing)('7')).toMatchObject({ teams: [], origin: 'unknown', dataPresent: false });
    const none = memCache();
    expect(await lookupWith(none.cache, failing)('7')).toMatchObject({ origin: 'unknown', errors: ['User is not permitted to query this organization'] });
    expect(tooOld.puts).toEqual([]);
    expect(none.puts).toEqual([]);
  });

  it('a broken cache only skips the cache', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cache: SpaceTeamCache = {
      get: async () => {
        throw new Error('no table');
      },
      put: async () => {
        throw new Error('no table');
      },
    };
    expect(await lookupWith(cache, read({ teams: T }))('7')).toMatchObject({ teams: T, origin: 'live' });
  });

  it('dedups: one read per space per invocation, also for concurrent calls', async () => {
    const { cache } = memCache();
    const r = read({ teams: T });
    const lookup = lookupWith(cache, r);
    const [a, b] = await Promise.all([lookup('7'), lookup('7')]);
    await lookup('7');
    await lookup('8');
    expect(a).toBe(b);
    expect(r).toHaveBeenCalledTimes(2);
    expect(cache.get).toHaveBeenCalledTimes(2);
    // A new invocation reads again (the memo lives per request).
    await lookupWith(cache, r)('7');
    expect(r).toHaveBeenCalledTimes(3);
  });
});
