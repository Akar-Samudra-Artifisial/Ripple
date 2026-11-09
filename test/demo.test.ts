import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Requests made through the mocked `@forge/api` (adapter test only). */
const apiCalls: { path: string; method: string; body: unknown }[] = [];
let apiReply: { status: number; body: unknown } = { status: 200, body: {} };

vi.mock('@forge/api', () => {
  const requestConfluence = async (path: string, init?: { method?: string; body?: string }) => {
    apiCalls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    return { status: apiReply.status, ok: apiReply.status >= 200 && apiReply.status < 300, json: async () => apiReply.body };
  };
  return {
    default: { asApp: () => ({ requestConfluence }), asUser: () => ({ requestConfluence }) },
    route: (s: TemplateStringsArray, ...v: unknown[]) => s.reduce((acc, part, i) => acc + part + (i < v.length ? String(v[i]) : ''), ''),
  };
});
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

import { demoConfluence, type DemoConfluence } from '../src/adapters/demoConfluence';
import type { DemoRepo, DemoState } from '../src/adapters/demoRepo';
import type { UserResult } from '../src/adapters/confluence';
import { NIMBUS_ALL_PAGES, NIMBUS_EXPECTED, NIMBUS_PAGES, NIMBUS_SOURCE, NIMBUS_SPACES, TRAP_FORBIDDEN, TRAP_SLUG } from '../src/demo/nimbus';
import type { AdminCheck, DemoStatus, ErrorReply } from '../src/core/views';
import { DEMO_TOTAL, getDemoStatus, loadDemoData, type DemoDeps } from '../src/surfaces/demo';

const CTX = { moduleKey: 'ripple-settings', accountId: '557058:admin-0000' };
const OWNERS = ['557058:aaaa-1111', '557058:bbbb-2222', '5b10a2844c20165700ede21g'];

/** In-memory Confluence: spaces by key, pages by space + title; counts every create. */
class FakeConfluence implements DemoConfluence {
  spaces = new Map<string, string>();
  pages = new Map<string, string>();
  creates = 0;
  owners: { pageId: string; owner: string }[] = [];
  failCreateSpace?: number;
  failOwner?: number;
  private next = 1000;

  async findSpace(key: string): Promise<UserResult<{ id: string; url: string } | null>> {
    const id = this.spaces.get(key);
    return { ok: true, value: id ? { id, url: `https://x.atlassian.net/wiki/spaces/${key}` } : null };
  }
  async createSpace(key: string): Promise<UserResult<{ id: string; url: string }>> {
    if (this.failCreateSpace) return { ok: false, status: this.failCreateSpace };
    this.creates++;
    const id = String(this.next++);
    this.spaces.set(key, id);
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
    return { ok: true, value: { id, url: `https://x.atlassian.net/wiki/pages/${id}` } };
  }
  async setOwner(pageId: string, _title: string, _storage: string, owner: string): Promise<UserResult<true>> {
    if (this.failOwner) return { ok: false, status: this.failOwner };
    this.owners.push({ pageId, owner });
    return { ok: true, value: true };
  }
}

let conf: FakeConfluence;
let stored: DemoState | undefined;
let admin: AdminCheck;
let clock: number;
/** Milliseconds every Confluence call advances the clock (for the budget). */
let tick: number;

const repo: DemoRepo = {
  getDemoState: async () => (stored ? (JSON.parse(JSON.stringify(stored)) as DemoState) : undefined),
  saveDemoState: async (s) => {
    stored = JSON.parse(JSON.stringify(s)) as DemoState;
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
  return { confluence: timed, repo, admin: async () => admin, ensure: async () => undefined, now: () => clock, budgetMs: 18_000 };
}

const ok = (r: DemoStatus | ErrorReply): DemoStatus => {
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
    expect(stored?.ownerErrors).toBe(NIMBUS_PAGES.length);
    expect(Object.values(stored?.pages ?? {}).filter((p) => p.ownerFailed)).toHaveLength(NIMBUS_PAGES.length);
    expect(console.warn).toHaveBeenCalledWith('ripple demo: page owner change failed', expect.objectContaining({ error: 'owner_http_403' }));
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

describe('demoConfluence adapter', () => {
  it('creates spaces with REST v1 and sets the owner with a v2 PUT (version 2, same title and body)', async () => {
    apiReply = { status: 200, body: { id: 77, _links: { base: 'https://x.atlassian.net/wiki', webui: '/spaces/NLHR' } } };
    expect(await demoConfluence.createSpace('NLHR', 'Nimbus Labs HR', 'd')).toEqual({ ok: true, value: { id: '77', url: 'https://x.atlassian.net/wiki/spaces/NLHR' } });
    expect(apiCalls[0]).toMatchObject({ path: '/wiki/rest/api/space', method: 'POST', body: { key: 'NLHR', name: 'Nimbus Labs HR' } });
    apiReply = { status: 403, body: { message: 'secret' } };
    expect(await demoConfluence.setOwner('9001', 'T', '<p>x</p>', OWNERS[0] ?? '')).toEqual({ ok: false, status: 403 });
    expect(apiCalls[1]).toMatchObject({ path: '/wiki/api/v2/pages/9001', method: 'PUT', body: { ownerId: OWNERS[0], title: 'T', version: { number: 2 } } });
  });
});
