import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Requests made through the mocked `@forge/api` (adapter test only). */
const apiCalls: { path: string; method: string; body: unknown }[] = [];
let apiReply: { status: number; body: unknown } = { status: 200, body: {} };
/** Replies used first, in order, before `apiReply`. */
const apiQueue: { status: number; body: unknown }[] = [];

vi.mock('@forge/api', () => {
  const requestConfluence = async (path: string, init?: { method?: string; body?: string }) => {
    apiCalls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    const r = apiQueue.shift() ?? apiReply;
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  return {
    default: { asApp: () => ({ requestConfluence }), asUser: () => ({ requestConfluence }) },
    route: (s: TemplateStringsArray, ...v: unknown[]) => s.reduce((acc, part, i) => acc + part + (i < v.length ? String(v[i]) : ''), ''),
  };
});
/** Statements run through the mocked `@forge/sql` (repo test only); `sqlAffected` = affected rows of each. */
const sqlCalls: { statement: string; params: unknown[] }[] = [];
let sqlAffected = 1;
vi.mock('@forge/sql', () => ({
  migrationRunner: {},
  sql: {
    prepare: (statement: string) => ({
      bindParams: (...params: unknown[]) => ({
        execute: async () => {
          sqlCalls.push({ statement, params });
          return { rows: Object.assign([], { affectedRows: sqlAffected }) };
        },
      }),
    }),
  },
}));
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

import { demoConfluence, type DemoConfluence } from '../src/adapters/demoConfluence';
import { parseDemoState, sqlDemoRepo, type DemoRepo, type DemoState } from '../src/adapters/demoRepo';
import type { UserAccount } from '../src/adapters/confluenceUsers';
import type { UserResult } from '../src/adapters/confluence';
import { DEMO_MARKER, NIMBUS_ALL_PAGES, NIMBUS_EXPECTED, NIMBUS_PAGES, NIMBUS_SOURCE, NIMBUS_SPACES, TRAP_FORBIDDEN, TRAP_SLUG } from '../src/demo/nimbus';
import type { AdminCheck, DemoStatus, ErrorReply } from '../src/core/views';
import { checkDemoOwners, DEMO_LEASE_MS, DEMO_TOTAL, getDemoStatus, loadDemoData, removeDemoData, type DemoDeps } from '../src/surfaces/demo';

const CTX = { moduleKey: 'ripple-settings', accountId: '557058:admin-0000' };
const OWNERS = ['557058:aaaa-1111', '557058:bbbb-2222', '5b10a2844c20165700ede21g'];

/** In-memory Confluence: spaces by key, pages by space + title; counts every create. */
class FakeConfluence implements DemoConfluence {
  /** Space key → id and description. */
  spaces = new Map<string, { id: string; description: string }>();
  pages = new Map<string, string>();
  /** Page id → current owner (the admin for a new page). */
  pageOwner = new Map<string, string>();
  creates = 0;
  /** Owner changes actually made (a PUT). */
  owners: { pageId: string; owner: string }[] = [];
  failCreateSpace?: number;
  failOwner?: number;
  /** Runs once right before `createSpace` (a concurrent load / someone else creating the key). */
  beforeCreateSpace?: (key: string) => void;
  private next = 1000;

  async findSpace(key: string): Promise<UserResult<{ id: string; url: string; description: string } | null>> {
    const sp = this.spaces.get(key);
    return { ok: true, value: sp ? { id: sp.id, url: `https://x.atlassian.net/wiki/spaces/${key}`, description: sp.description } : null };
  }
  async createSpace(key: string, _name: string, description: string): Promise<UserResult<{ id: string; url: string }>> {
    const hook = this.beforeCreateSpace;
    this.beforeCreateSpace = undefined;
    hook?.(key);
    if (this.spaces.has(key)) return { ok: false, status: 400 };
    if (this.failCreateSpace) return { ok: false, status: this.failCreateSpace };
    this.creates++;
    const id = String(this.next++);
    this.spaces.set(key, { id, description });
    return { ok: true, value: { id, url: `https://x.atlassian.net/wiki/spaces/${key}` } };
  }
  async findPage(spaceId: string, title: string): Promise<UserResult<{ id: string; url: string } | null>> {
    const id = this.pages.get(`${spaceId}/${title}`);
    return { ok: true, value: id ? { id, url: `https://x.atlassian.net/wiki/pages/${id}` } : null };
  }
  async createPage(spaceId: string, title: string): Promise<UserResult<{ id: string; url: string }>> {
    this.creates++;
    const id = String(this.next++);
    this.pages.set(`${spaceId}/${title}`, id);
    this.pageOwner.set(id, CTX.accountId);
    return { ok: true, value: { id, url: `https://x.atlassian.net/wiki/pages/${id}` } };
  }
  async ensureOwner(pageId: string, owner: string): Promise<UserResult<true>> {
    if (this.pageOwner.get(pageId) === owner) return { ok: true, value: true };
    if (this.failOwner) return { ok: false, status: this.failOwner };
    this.pageOwner.set(pageId, owner);
    this.owners.push({ pageId, owner });
    return { ok: true, value: true };
  }
  /** Space keys whose deletion was requested. */
  deletes: string[] = [];
  failDelete?: number;
  /** Confluence deletes in the background: the space is still listed after the 202. */
  listedWhileDeleting = false;
  async deleteSpace(key: string): Promise<UserResult<'deleted' | 'gone'>> {
    if (this.failDelete) return { ok: false, status: this.failDelete };
    if (!this.spaces.has(key)) return { ok: true, value: 'gone' };
    this.deletes.push(key);
    if (!this.listedWhileDeleting) this.spaces.delete(key);
    return { ok: true, value: 'deleted' };
  }
}

let conf: FakeConfluence;
let stored: DemoState | undefined;
let admin: AdminCheck;
let clock: number;
/** Milliseconds every Confluence call advances the clock (for the budget). */
let tick: number;

/** Every write that reached the store. */
let writes: number;
/** Runs before each CAS write (to simulate another load or a crash). */
let beforeWrite: ((s: DemoState) => void) | undefined;
/** Accounts users-bulk knows; `usersFail` makes the lookup throw. */
let accounts: Map<string, UserAccount>;
let usersFail: boolean;
let usersCalls: string[][];
const active = (name: string): UserAccount => ({ name, accountType: 'atlassian', accountStatus: 'active' });

const copy = (s: DemoState): DemoState => JSON.parse(JSON.stringify(s)) as DemoState;
const repo: DemoRepo = {
  getDemoState: async () => (stored ? copy(stored) : undefined),
  createDemoState: async (s) => {
    if (stored) return false;
    writes++;
    stored = copy(s);
    return true;
  },
  replaceDemoState: async (s, expected) => {
    beforeWrite?.(s);
    if (!stored || stored.lease !== expected) return false;
    writes++;
    stored = copy(s);
    return true;
  },
};

function deps(): DemoDeps {
  const timed = new Proxy(conf, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        clock += tick;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  let lease = 0;
  return {
    confluence: timed,
    repo,
    admin: async () => admin,
    users: async (ids) => {
      usersCalls.push([...ids]);
      if (usersFail) throw new Error('Confluence users-bulk failed: HTTP 503');
      return new Map([...accounts].filter(([id]) => ids.includes(id)));
    },
    ensure: async () => undefined,
    now: () => clock,
    newLease: () => `lease-${++lease}`,
    newNonce: () => nonce,
    budgetMs: 18_000,
    removeSource: async (pageId) => {
      removedSources.push(pageId);
    },
  };
}
/** Source pages whose Ripple data `removeDemoData` deleted. */
let removedSources: string[];
/** Demo id a new load state gets. */
let nonce = 'nonce-1';
const TAG = `${DEMO_MARKER}. Ripple demo id: nonce-1.`;

const ok = <T extends object>(r: T | ErrorReply): T => {
  if ('error' in r) throw new Error(r.error);
  return r;
};

beforeEach(() => {
  conf = new FakeConfluence();
  stored = undefined;
  admin = 'admin';
  clock = 0;
  tick = 0;
  apiCalls.length = 0;
  apiQueue.length = 0;
  sqlCalls.length = 0;
  sqlAffected = 1;
  writes = 0;
  beforeWrite = undefined;
  accounts = new Map(OWNERS.map((id, i) => [id, active(`Owner ${i}`)]));
  usersFail = false;
  usersCalls = [];
  removedSources = [];
  nonce = 'nonce-1';
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('Nimbus Labs demo content', () => {
  it('has the agreed spaces, one source, 17 copy pages and 1 historical page', () => {
    expect(NIMBUS_SPACES.map((s) => s.key)).toEqual(['NLHR', 'NLONB', 'NLFIN', 'NLSALES', 'NLHELP']);
    expect(NIMBUS_SOURCE.space).toBe('NLHR');
    expect(NIMBUS_PAGES.filter((p) => p.kind === 'copy')).toHaveLength(NIMBUS_EXPECTED.copyPages);
    expect(NIMBUS_PAGES.filter((p) => p.kind === 'historical')).toHaveLength(1);
    expect(new Set(NIMBUS_ALL_PAGES.map((p) => p.title)).size).toBe(NIMBUS_ALL_PAGES.length);
    expect(DEMO_TOTAL).toBe(5 + 19);
  });

  it('every quote is verbatim on its page and names a subject CQL can find', () => {
    for (const p of NIMBUS_PAGES) {
      for (const m of p.mentions) {
        expect(p.storage).toContain(m.quote);
        expect(m.quote).toContain(m.statedValue.replace(' days', ''));
        expect(m.quote.toLowerCase()).toMatch(/per diem|expense claims|manager approval|economy class/);
      }
    }
  });

  it('user rule: the $40 training trap and its page never use a word like "international" or "external"', () => {
    const trap = NIMBUS_PAGES.find((p) => p.slug === TRAP_SLUG);
    expect(trap?.mentions).toEqual([expect.objectContaining({ fact: 'domestic', status: 'unsure', statedValue: '$40', quote: 'On training course days the per diem is $40 per day.' })]);
    expect(trap?.title).not.toMatch(TRAP_FORBIDDEN);
    expect(trap?.storage).not.toMatch(TRAP_FORBIDDEN);
    expect(trap?.mentions[0]?.statedCondition ?? '').not.toMatch(TRAP_FORBIDDEN);
    for (const word of ['international', 'International', 'external', 'internal', 'overseas', 'abroad']) expect(TRAP_FORBIDDEN.test(word)).toBe(true);
  });

  it('in-sync per diem sentences name the fact condition and never reframe it (only the trap does)', () => {
    const reframing = /conference|relocat|training|course|qbr|buddy|attendee|office|customer|first week|countr/i;
    for (const p of NIMBUS_PAGES) {
      for (const m of p.mentions.filter((x) => x.status === 'in_sync' && (x.fact === 'domestic' || x.fact === 'international'))) {
        expect(m.quote.toLowerCase()).toContain(m.fact);
        expect(m.quote).not.toMatch(reframing);
      }
    }
    // The 4 drifts stay as agreed.
    const drifts = NIMBUS_PAGES.flatMap((p) => p.mentions.filter((m) => m.status === 'drifted').map((m) => m.quote));
    expect(drifts).toEqual([
      'Expense claims must be submitted within 45 days after the trip ends.',
      'International travel: the per diem is $100 per day.',
      'For domestic customer visits the per diem is $65 per day.',
      'Trips over $2,500 require manager approval before booking.',
    ]);
  });

  it('the historical sentence is the agreed one', () => {
    const hist = NIMBUS_PAGES.find((p) => p.kind === 'historical');
    expect(hist?.mentions[0]?.quote).toBe('Last year the domestic per diem went up from $50 to $60 per day.');
  });
});

describe('getDemoStatus / loadDemoData', () => {
  it('only Jira administrators may load, fail closed; other modules are refused', async () => {
    admin = 'not_admin';
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'idle', canEdit: false, errorCode: 'not_allowed' });
    admin = 'check_failed';
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'idle', canEdit: false, errorCode: 'admin_check_failed' });
    admin = 'needs_auth';
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'idle', canEdit: false, errorCode: 'admin_needs_auth' });
    expect(ok(await checkDemoOwners(CTX, { ownerAccountIds: OWNERS }, deps()))).toMatchObject({ errorCode: 'admin_needs_auth', owners: [] });
    expect(usersCalls).toEqual([]);
    expect(conf.creates).toBe(0);
    expect(stored).toBeUndefined();
    expect(await loadDemoData({ ...CTX, moduleKey: 'ripple-byline' }, {}, deps())).toEqual({ error: 'Open Ripple settings to do that.' });
    expect(ok(await getDemoStatus(CTX, deps()))).toEqual({ state: 'idle', step: 0, total: DEMO_TOTAL, spaces: [], sourcePageUrl: null, canEdit: false, errorCode: null });
  });

  it('loads everything, then a second press creates nothing new', async () => {
    const done = ok(await loadDemoData(CTX, {}, deps()));
    expect(done).toMatchObject({ state: 'done', step: DEMO_TOTAL, canEdit: true, errorCode: null });
    expect(done.spaces.map((s) => s.key)).toEqual(['NLHR', 'NLONB', 'NLFIN', 'NLSALES', 'NLHELP']);
    expect(done.sourcePageUrl).toMatch(/\/wiki\/pages\/\d+$/);
    expect(conf.creates).toBe(DEMO_TOTAL);
    expect(conf.owners).toEqual([]);
    ok(await loadDemoData(CTX, {}, deps()));
    expect(conf.creates).toBe(DEMO_TOTAL);
    // A lost state (or a load from scratch) finds the spaces by key and the pages by title.
    stored = undefined;
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'done', step: DEMO_TOTAL });
    expect(conf.creates).toBe(DEMO_TOTAL);
  });

  it('stops at the time budget and resumes where it stopped', async () => {
    tick = 1_000;
    const first = ok(await loadDemoData(CTX, {}, deps()));
    expect(first.state).toBe('loading');
    expect(first.step).toBeGreaterThan(0);
    expect(first.step).toBeLessThan(DEMO_TOTAL);
    let calls = 1;
    let s = first;
    while (s.state === 'loading' && calls < 20) {
      clock = 0;
      s = ok(await loadDemoData(CTX, undefined, deps()));
      calls++;
    }
    expect(s.state).toBe('done');
    expect(calls).toBeGreaterThan(1);
    expect(conf.creates).toBe(DEMO_TOTAL);
    expect(ok(await getDemoStatus(CTX, deps()))).toMatchObject({ state: 'done', step: DEMO_TOTAL });
  });

  it('gives copy pages round robin to the owners; the source stays with the admin', async () => {
    ok(await loadDemoData(CTX, { ownerAccountIds: OWNERS }, deps()));
    expect(conf.owners).toHaveLength(NIMBUS_PAGES.length);
    expect(conf.owners.map((o) => o.owner)).toEqual(NIMBUS_PAGES.map((_, i) => OWNERS[i % OWNERS.length]));
    expect(conf.owners.some((o) => o.pageId === stored?.pages[NIMBUS_SOURCE.slug]?.id)).toBe(false);
  });

  it('rejects bad owner lists before creating anything', async () => {
    for (const bad of [['x'], ['557058:a b'], Array.from({ length: 7 }, (_, i) => `557058:user-${i}000`), 'nope', [42]]) {
      expect(ok(await loadDemoData(CTX, { ownerAccountIds: bad as string[] }, deps()))).toMatchObject({ errorCode: 'invalid_owner_ids', state: 'idle' });
    }
    expect(conf.creates).toBe(0);
  });

  it('a failed owner change keeps the page and goes on; the account id is never logged', async () => {
    conf.failOwner = 403;
    const s = ok(await loadDemoData(CTX, { ownerAccountIds: OWNERS }, deps()));
    expect(s).toMatchObject({ state: 'done', step: DEMO_TOTAL, errorCode: 'owner_change_failed' });
    expect(Object.values(stored?.pages ?? {}).filter((p) => p.ownerState === 'failed')).toHaveLength(NIMBUS_PAGES.length);
    expect(console.warn).toHaveBeenCalledWith('ripple demo: page owner change failed', expect.objectContaining({ error: 'owner_http_403' }));
    const logged = JSON.stringify([vi.mocked(console.warn).mock.calls, vi.mocked(console.info).mock.calls]);
    for (const id of OWNERS) expect(logged).not.toContain(id);
  });

  it('never uses a foreign space with a demo key; a marked space (or a race that made one) is reused', async () => {
    conf.spaces.set('NLHR', { id: '5', description: 'HR team space' });
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'failed', step: 0, errorCode: 'space_key_taken' });
    expect(conf.creates).toBe(0);
    expect(stored?.spaces).toEqual({});
    // Marked, but by another installation or without a demo id (8.33.0, state lost): not adopted.
    for (const description of [`People Ops. ${DEMO_MARKER}.`, `People Ops. ${DEMO_MARKER}. Ripple demo id: other-9.`]) {
      conf.spaces.set('NLHR', { id: '5', description });
      expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'failed', errorCode: 'foreign_space' });
      expect(stored?.spaces).toEqual({});
    }
    expect(conf.creates).toBe(0);
    // Created by an earlier load of this installation (not recorded, e.g. a crash): the demo id says it is ours.
    conf.spaces.set('NLHR', { id: '5', description: `People Ops. ${TAG}` });
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'done', errorCode: null });
    expect(stored?.spaces.NLHR?.id).toBe('5');
    // Every space Ripple creates carries the marker and the installation's demo id.
    for (const s of NIMBUS_SPACES) expect(s.description).toContain(DEMO_MARKER);
    expect(conf.spaces.get('NLFIN')?.description).toContain(TAG);
    expect(stored?.nonce).toBe('nonce-1');
  });

  it('a create that fails because the key appeared meanwhile follows the same marker rule', async () => {
    conf.beforeCreateSpace = (key) => conf.spaces.set(key, { id: '7', description: 'someone else' });
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'failed', errorCode: 'space_key_taken' });
    conf.spaces.clear();
    stored = undefined;
    conf.beforeCreateSpace = (key) => conf.spaces.set(key, { id: '8', description: TAG });
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'done', errorCode: null });
    expect((stored as DemoState | undefined)?.spaces.NLHR?.id).toBe('8');
  });

  it('a second call while another load holds the lease answers loading and writes nothing', async () => {
    clock = 1_000;
    stored = { state: 'loading', spaces: {}, pages: {}, ownerAccountIds: [], errorCode: null, lease: 'other', lockedUntil: clock + 10_000, rev: 4 };
    expect(ok(await loadDemoData(CTX, { ownerAccountIds: OWNERS, retryOwners: true }, deps()))).toMatchObject({ state: 'loading', errorCode: null });
    expect(ok(await getDemoStatus(CTX, deps()))).toMatchObject({ state: 'loading' });
    expect(writes).toBe(0);
    expect(conf.creates).toBe(0);
    expect(usersCalls).toEqual([]);
    // The lease expires (the other load crashed): this load takes it over.
    clock += DEMO_LEASE_MS;
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'done' });
    expect(stored).toMatchObject({ lease: '', lockedUntil: 0 });
  });

  it('a load whose lease was taken over stops at its next save', async () => {
    let n = 0;
    beforeWrite = () => {
      if (++n === 4 && stored) stored.lease = 'thief';
    };
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'loading' });
    expect(stored?.lease).toBe('thief');
    // The first insert and three space saves; the fourth save found another lease.
    expect(writes).toBe(4);
    // The fourth space was created but not recorded; the next load finds it by its marker.
    expect(conf.creates).toBe(4);
    expect(Object.keys(stored?.spaces ?? {})).toHaveLength(3);
  });

  it('two loads racing for a free state: only one inserts it', async () => {
    const first = repo.createDemoState;
    repo.createDemoState = async (s) => {
      stored = { ...s, lease: 'winner', lockedUntil: clock + 10_000 };
      return false;
    };
    try {
      expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'loading' });
      expect(conf.creates).toBe(0);
    } finally {
      repo.createDemoState = first;
    }
  });

  it('a page is saved as pending before its owner change; a crash in between is resumed', async () => {
    const real = conf.ensureOwner.bind(conf);
    conf.ensureOwner = async () => {
      throw new Error('runtime killed');
    };
    expect(await loadDemoData(CTX, { ownerAccountIds: OWNERS }, deps())).toEqual({ error: 'Ripple could not load the demo data.' });
    const first = NIMBUS_PAGES[0];
    expect(stored?.pages[first?.slug ?? '']).toMatchObject({ owner: OWNERS[0], ownerState: 'pending' });
    conf.ensureOwner = real;
    // The crashed load still holds the lease until it expires.
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'loading' });
    clock += DEMO_LEASE_MS;
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'done', errorCode: null });
    expect(conf.creates).toBe(DEMO_TOTAL);
    expect(conf.owners).toHaveLength(NIMBUS_PAGES.length);
    expect(Object.values(stored?.pages ?? {}).filter((p) => p.ownerState === 'done')).toHaveLength(NIMBUS_PAGES.length);
  });

  it('found pages get their slot owner when the owner differs (checked, not assumed)', async () => {
    ok(await loadDemoData(CTX, {}, deps()));
    expect(conf.owners).toEqual([]);
    stored = undefined;
    const someone = NIMBUS_PAGES[1];
    ok(await loadDemoData(CTX, { ownerAccountIds: OWNERS }, deps()));
    expect(conf.creates).toBe(DEMO_TOTAL);
    expect(conf.owners).toHaveLength(NIMBUS_PAGES.length);
    // A page already owned by its slot is left alone.
    const id = (stored as DemoState | undefined)?.pages[someone?.slug ?? '']?.id ?? '';
    conf.owners.length = 0;
    stored = undefined;
    conf.pageOwner.set(id, 'someone-else');
    ok(await loadDemoData(CTX, { ownerAccountIds: OWNERS }, deps()));
    expect(conf.owners).toEqual([{ pageId: id, owner: OWNERS[1] }]);
  });

  it('absent owners keep the earlier choice; retryOwners retries failed owner changes after done', async () => {
    tick = 1_000;
    expect(ok(await loadDemoData(CTX, { ownerAccountIds: OWNERS }, deps())).state).toBe('loading');
    clock = 0;
    tick = 0;
    conf.failOwner = 403;
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'done', errorCode: 'owner_change_failed' });
    expect(stored?.ownerAccountIds).toEqual(OWNERS);
    const ok1 = conf.owners.length;
    // Done: a plain press changes nothing.
    const w = writes;
    ok(await loadDemoData(CTX, {}, deps()));
    expect(writes).toBe(w);
    conf.failOwner = undefined;
    expect(ok(await loadDemoData(CTX, { retryOwners: true }, deps()))).toMatchObject({ state: 'done', errorCode: null });
    expect(conf.owners.length).toBe(NIMBUS_PAGES.length);
    expect(conf.owners.length).toBeGreaterThan(ok1);
    expect(conf.owners.map((o) => o.owner).sort()).toEqual(NIMBUS_PAGES.map((_, i) => OWNERS[i % OWNERS.length]).sort());
  });

  it('owners must be active Atlassian accounts (users-bulk); account ids are never logged', async () => {
    const [a, b, c] = OWNERS as [string, string, string];
    accounts.set(b, { name: 'Bot', accountType: 'app', accountStatus: 'active' });
    accounts.set(c, { name: 'Gone', accountType: 'atlassian', accountStatus: 'inactive' });
    expect(ok(await loadDemoData(CTX, { ownerAccountIds: OWNERS }, deps()))).toMatchObject({ state: 'idle', errorCode: 'owner_invalid' });
    accounts.delete(c);
    expect(ok(await checkDemoOwners(CTX, { ownerAccountIds: [a, c] }, deps()))).toEqual({ owners: [], pages: NIMBUS_PAGES.length, invalidAccountIds: [c], errorCode: 'owner_invalid' });
    usersFail = true;
    expect(ok(await loadDemoData(CTX, { ownerAccountIds: [a] }, deps()))).toMatchObject({ errorCode: 'owner_check_failed' });
    expect(conf.creates).toBe(0);
    expect(writes).toBe(0);
    usersFail = false;
    expect(ok(await checkDemoOwners(CTX, { ownerAccountIds: [a] }, deps()))).toEqual({ owners: [{ accountId: a, name: 'Owner 0' }], pages: NIMBUS_PAGES.length, invalidAccountIds: [], errorCode: null });
    expect(ok(await checkDemoOwners(CTX, { ownerAccountIds: Array.from({ length: 7 }, (_, i) => `557058:user-${i}000`) }, deps()))).toMatchObject({ errorCode: 'invalid_owner_ids' });
    admin = 'not_admin';
    expect(ok(await checkDemoOwners(CTX, { ownerAccountIds: [a] }, deps()))).toMatchObject({ errorCode: 'not_allowed' });
    const logged = JSON.stringify([vi.mocked(console.warn).mock.calls, vi.mocked(console.info).mock.calls]);
    for (const id of OWNERS) expect(logged).not.toContain(id);
  });

  it('a failed step is "failed" with an enum and resumes on the next press', async () => {
    conf.failCreateSpace = 403;
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'failed', step: 0, errorCode: 'space_create_http_403' });
    conf.failCreateSpace = undefined;
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'done', step: DEMO_TOTAL, errorCode: null });
  });
});

describe('removeDemoData', () => {
  const KEYS = NIMBUS_SPACES.map((s) => s.key);

  it('only Jira administrators may remove, fail closed; other modules are refused; nothing is touched', async () => {
    ok(await loadDemoData(CTX, {}, deps()));
    const before = JSON.stringify(stored);
    for (const [a, code] of [
      ['not_admin', 'not_allowed'],
      ['check_failed', 'admin_check_failed'],
      ['needs_auth', 'admin_needs_auth'],
    ] as const) {
      admin = a;
      expect(ok(await removeDemoData(CTX, deps()))).toMatchObject({ errorCode: code, removedSpaces: [], status: { canEdit: false } });
    }
    expect(await removeDemoData({ ...CTX, moduleKey: 'ripple-byline' }, deps())).toEqual({ error: 'Open Ripple settings to do that.' });
    expect(conf.deletes).toEqual([]);
    expect(removedSources).toEqual([]);
    expect(JSON.stringify(stored)).toBe(before);
  });

  it('deletes the recorded, marked spaces and the source data, resets the state; the next load starts from scratch', async () => {
    ok(await loadDemoData(CTX, { ownerAccountIds: OWNERS }, deps()));
    const sourceId = stored?.pages[NIMBUS_SOURCE.slug]?.id;
    const r = ok(await removeDemoData(CTX, deps()));
    expect(r).toMatchObject({ removedSpaces: KEYS, keptSpaces: [], errorCode: null, status: { state: 'idle', step: 0, spaces: [], sourcePageUrl: null } });
    expect(conf.deletes).toEqual(KEYS);
    expect(removedSources).toEqual([sourceId]);
    expect(stored).toMatchObject({ state: 'removed', spaces: {}, pages: {}, ownerAccountIds: [], errorCode: null, lease: '', lockedUntil: 0 });
    expect(ok(await getDemoStatus(CTX, deps()))).toMatchObject({ state: 'idle', step: 0 });
    const created = conf.creates;
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'done', errorCode: null });
    expect(conf.creates - created).toBe(DEMO_TOTAL);
    expect(conf.owners.length).toBe(NIMBUS_PAGES.length); // owners of the earlier load are not reused
  });

  it('never deletes a space Ripple cannot prove it created; reports it and leaves it', async () => {
    ok(await loadDemoData(CTX, {}, deps()));
    // NLFIN replaced by someone else (other id); NLHELP lost its marker; NLONB marked but not recorded.
    conf.spaces.set('NLFIN', { id: '77', description: `Finance. ${TAG}` });
    conf.spaces.set('NLHELP', { id: stored?.spaces.NLHELP?.id ?? '', description: 'Help desk' });
    if (stored) delete stored.spaces.NLONB;
    const r = ok(await removeDemoData(CTX, deps()));
    expect(r).toMatchObject({ removedSpaces: ['NLHR', 'NLSALES'], keptSpaces: ['NLONB', 'NLFIN', 'NLHELP'], errorCode: null });
    expect(conf.deletes).toEqual(['NLHR', 'NLSALES']);
    expect([...conf.spaces.keys()].sort()).toEqual(['NLFIN', 'NLHELP', 'NLONB']);
    expect(stored).toMatchObject({ state: 'removed', spaces: {}, pages: {} });
    // The next load refuses the foreign key as before.
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'failed', errorCode: 'space_key_taken' });
  });

  it('is idempotent: gone spaces count as removed, a second press changes nothing, a failed delete resumes', async () => {
    ok(await loadDemoData(CTX, {}, deps()));
    conf.spaces.delete('NLONB'); // deleted by hand in Confluence
    conf.failDelete = 403;
    expect(ok(await removeDemoData(CTX, deps()))).toMatchObject({ errorCode: 'space_delete_http_403', status: { state: 'failed' } });
    expect(Object.keys(stored?.spaces ?? {}).sort()).toEqual(['NLFIN', 'NLHELP', 'NLHR', 'NLONB', 'NLSALES']);
    expect(stored?.lease).toBe('');
    conf.failDelete = undefined;
    expect(ok(await removeDemoData(CTX, deps()))).toMatchObject({ removedSpaces: ['NLHR', 'NLFIN', 'NLSALES', 'NLHELP'], errorCode: null });
    expect(removedSources).toHaveLength(2);
    const deletes = conf.deletes.length;
    expect(ok(await removeDemoData(CTX, deps()))).toMatchObject({ removedSpaces: [], keptSpaces: [], errorCode: null, status: { state: 'idle' } });
    expect(conf.deletes).toHaveLength(deletes);
    // Nothing loaded at all: nothing to remove.
    stored = undefined;
    expect(ok(await removeDemoData(CTX, deps()))).toMatchObject({ removedSpaces: [], errorCode: null, status: { state: 'idle' } });
  });

  it('a space Confluence is still deleting (202, still listed) is neither deleted twice nor reused by a load', async () => {
    ok(await loadDemoData(CTX, {}, deps()));
    conf.listedWhileDeleting = true;
    expect(ok(await removeDemoData(CTX, deps()))).toMatchObject({ removedSpaces: KEYS, errorCode: null });
    expect(ok(await removeDemoData(CTX, deps()))).toMatchObject({ removedSpaces: [], keptSpaces: [], errorCode: null });
    expect(conf.deletes).toEqual(KEYS);
    const created = conf.creates;
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'failed', errorCode: 'space_being_deleted' });
    expect(conf.creates).toBe(created);
    // Once Confluence is done, the load creates everything anew.
    conf.spaces.clear();
    expect(ok(await loadDemoData(CTX, {}, deps()))).toMatchObject({ state: 'done' });
    expect(conf.creates - created).toBe(DEMO_TOTAL);
  });

  it('demo id: a recorded space marked by another installation is kept; 8.33.0 spaces without an id are removed once recorded', async () => {
    ok(await loadDemoData(CTX, {}, deps()));
    const nlfin = conf.spaces.get('NLFIN');
    if (nlfin) nlfin.description = `Finance. ${DEMO_MARKER}. Ripple demo id: other-9.`;
    expect(ok(await removeDemoData(CTX, deps()))).toMatchObject({ removedSpaces: ['NLHR', 'NLONB', 'NLSALES', 'NLHELP'], keptSpaces: ['NLFIN'] });
    // Migration: a state of 8.36.0 (no demo id) with spaces created without one.
    conf.spaces.clear();
    stored = undefined;
    ok(await loadDemoData(CTX, {}, deps()));
    for (const sp of conf.spaces.values()) sp.description = sp.description.replace(' Ripple demo id: nonce-1.', '');
    delete (stored as DemoState | undefined)?.nonce;
    expect(ok(await removeDemoData(CTX, deps()))).toMatchObject({ removedSpaces: KEYS, keptSpaces: [], errorCode: null });
    // Without a recorded id, such a space is not ours.
    conf.spaces.set('NLHR', { id: '9', description: `People Ops. ${DEMO_MARKER}.` });
    stored = { state: 'done', spaces: { NLHR: { id: '8', url: null } }, pages: {}, ownerAccountIds: [], errorCode: null, lease: '', lockedUntil: 0, rev: 1 };
    expect(ok(await removeDemoData(CTX, deps()))).toMatchObject({ removedSpaces: [], keptSpaces: ['NLHR'] });
  });

  it('removes the source data only once NLHR is proven ours, and looks each space up again right before its DELETE', async () => {
    ok(await loadDemoData(CTX, {}, deps()));
    conf.spaces.set('NLHR', { id: '66', description: 'HR team space' });
    expect(ok(await removeDemoData(CTX, deps()))).toMatchObject({ keptSpaces: ['NLHR'] });
    expect(removedSources).toEqual([]);
    // Replaced between the ownership check and the DELETE: the second lookup sees another id, nothing is deleted.
    conf = new FakeConfluence();
    stored = undefined;
    ok(await loadDemoData(CTX, {}, deps()));
    const finds: string[] = [];
    const find = conf.findSpace.bind(conf);
    conf.findSpace = async (key: string) => {
      finds.push(key);
      if (key === 'NLSALES' && finds.filter((k) => k === key).length === 2) conf.spaces.set('NLSALES', { id: '55', description: TAG });
      return find(key);
    };
    expect(ok(await removeDemoData(CTX, deps()))).toMatchObject({ removedSpaces: ['NLHR', 'NLONB', 'NLFIN', 'NLHELP'], keptSpaces: ['NLSALES'] });
    expect(conf.deletes).not.toContain('NLSALES');
    expect(finds.filter((k) => k === 'NLHR')).toHaveLength(2);
  });

  it('waits while a load holds the lease; logs carry no space keys or account ids', async () => {
    clock = 1_000;
    stored = { state: 'loading', spaces: { NLHR: { id: '1', url: null } }, pages: {}, ownerAccountIds: OWNERS, errorCode: null, lease: 'other', lockedUntil: clock + 10_000, rev: 2, nonce: 'nonce-1' };
    conf.spaces.set('NLHR', { id: '1', description: TAG });
    expect(ok(await removeDemoData(CTX, deps()))).toMatchObject({ errorCode: 'demo_busy', status: { state: 'loading' } });
    expect(conf.deletes).toEqual([]);
    expect(writes).toBe(0);
    clock += DEMO_LEASE_MS;
    expect(ok(await removeDemoData(CTX, deps()))).toMatchObject({ removedSpaces: ['NLHR'], errorCode: null });
    const logged = JSON.stringify([vi.mocked(console.warn).mock.calls, vi.mocked(console.info).mock.calls]);
    for (const x of [...KEYS, ...OWNERS]) expect(logged).not.toContain(x);
  });
});

describe('demoConfluence adapter', () => {
  it('creates spaces with REST v1 and sets the owner with a v2 PUT (version 2, same title and body)', async () => {
    apiReply = { status: 200, body: { id: 77, _links: { base: 'https://x.atlassian.net/wiki', webui: '/spaces/NLHR' } } };
    expect(await demoConfluence.createSpace('NLHR', 'Nimbus Labs HR', 'd')).toEqual({ ok: true, value: { id: '77', url: 'https://x.atlassian.net/wiki/spaces/NLHR' } });
    expect(apiCalls[0]).toMatchObject({ path: '/wiki/rest/api/space', method: 'POST', body: { key: 'NLHR', name: 'Nimbus Labs HR' } });
    expect(apiCalls[0]?.body).toMatchObject({ description: { plain: { value: 'd' } } });
    // The owner change reads the page first and saves the body as read (an edit made meanwhile is kept).
    apiQueue.push({ status: 200, body: { ownerId: CTX.accountId, title: 'T', version: { number: 3 }, body: { storage: { value: '<p>edited</p>' } } } });
    apiReply = { status: 403, body: { message: 'secret' } };
    expect(await demoConfluence.ensureOwner('9001', OWNERS[0] ?? '')).toEqual({ ok: false, status: 403 });
    expect(apiCalls[1]).toMatchObject({ path: '/wiki/api/v2/pages/9001?body-format=storage', method: 'GET' });
    expect(apiCalls[2]).toMatchObject({ path: '/wiki/api/v2/pages/9001', method: 'PUT', body: { ownerId: OWNERS[0], title: 'T', version: { number: 4 }, body: { value: '<p>edited</p>' } } });
    // Already the owner: no write.
    apiQueue.push({ status: 200, body: { ownerId: OWNERS[0], title: 'T', version: { number: 4 }, body: { storage: { value: 'x' } } } });
    expect(await demoConfluence.ensureOwner('9001', OWNERS[0] ?? '')).toEqual({ ok: true, value: true });
    expect(apiCalls).toHaveLength(4);
  });

  it('finds a space by key with its plain description (the demo marker)', async () => {
    apiReply = { status: 200, body: { results: [{ id: 5, key: 'NLHR', description: { plain: { value: `x ${DEMO_MARKER}` } }, _links: { webui: '/spaces/NLHR' } }], _links: { base: 'https://x.atlassian.net/wiki' } } };
    expect(await demoConfluence.findSpace('NLHR')).toEqual({ ok: true, value: { id: '5', url: 'https://x.atlassian.net/wiki/spaces/NLHR', description: `x ${DEMO_MARKER}` } });
    expect(apiCalls[0]?.path).toBe('/wiki/api/v2/spaces?keys=NLHR&description-format=plain&limit=1');
  });

  it('deletes a space with REST v1 DELETE: 202 long task → deleted, 404 → gone, other → status', async () => {
    apiQueue.push({ status: 202, body: { id: 'task-1' } }, { status: 404, body: {} }, { status: 403, body: {} });
    expect(await demoConfluence.deleteSpace('NLHR')).toEqual({ ok: true, value: 'deleted' });
    expect(await demoConfluence.deleteSpace('NLHR')).toEqual({ ok: true, value: 'gone' });
    expect(await demoConfluence.deleteSpace('NLHR')).toEqual({ ok: false, status: 403 });
    expect(apiCalls.map((c) => [c.method, c.path])).toEqual(Array.from({ length: 3 }, () => ['DELETE', '/wiki/rest/api/space/NLHR']));
  });

  it('parses the removed state, the ids of spaces being deleted and the demo id', () => {
    expect(parseDemoState({ state: 'removed', spaces: {}, pages: {}, deletedSpaceIds: ['1', 2, '3'], nonce: 'n-1' })).toMatchObject({ state: 'removed', deletedSpaceIds: ['1', '3'], nonce: 'n-1' });
    expect(parseDemoState({ state: 'done', spaces: {}, pages: {}, nonce: 7 })).not.toHaveProperty('nonce');
  });
});

describe('sqlDemoRepo', () => {
  it('takes and checks the lease with compare-and-swap on $.lease (never the JSON text)', async () => {
    const state = { state: 'loading', spaces: {}, pages: {}, ownerAccountIds: [], errorCode: null, lease: 'lease-2', lockedUntil: 5, rev: 3 } as DemoState;
    expect(await sqlDemoRepo.replaceDemoState(state, 'lease-1')).toBe(true);
    expect(sqlCalls[0]?.statement).toBe("UPDATE settings SET v = ? WHERE k = ? AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(v, '$.lease')), '') = ?");
    expect(sqlCalls[0]?.params).toEqual([JSON.stringify(state), 'demo', 'lease-1']);
    sqlAffected = 0;
    expect(await sqlDemoRepo.replaceDemoState(state, 'lease-1')).toBe(false);
    expect(await sqlDemoRepo.createDemoState(state)).toBe(false);
    expect(sqlCalls[2]?.statement).toBe('INSERT IGNORE INTO settings (k, v) VALUES (?, ?)');
  });

  it('reads M6 rows: ownerFailed becomes a failed owner state, no lease = free', () => {
    const s = parseDemoState({ state: 'done', spaces: {}, pages: { a: { id: '1', url: null, ownerFailed: true }, b: { id: '2', url: 'u' } }, ownerAccountIds: ['x'], errorCode: null, ownerErrors: 1 });
    expect(s).toEqual({ state: 'done', spaces: {}, pages: { a: { id: '1', url: null, ownerState: 'failed' }, b: { id: '2', url: 'u' } }, ownerAccountIds: ['x'], errorCode: null, lease: '', lockedUntil: 0, rev: 0 });
  });
});
