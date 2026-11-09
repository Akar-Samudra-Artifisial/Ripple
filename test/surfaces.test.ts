import { beforeEach, describe, expect, it, vi } from 'vitest';

const forge = vi.hoisted(() => ({ push: vi.fn(async () => ({ jobId: 'job-1' })) }));

vi.mock('@forge/api', () => ({ default: {}, route: (s: TemplateStringsArray) => s.join('') }));
vi.mock('@forge/resolver', () => ({
  default: class {
    define() {}
    getDefinitions() {
      return {};
    }
  },
}));
vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: {} }));
vi.mock('@forge/llm', () => ({ chat: vi.fn(), ForgeLlmError: class extends Error {} }));
vi.mock('@forge/events', () => ({
  Queue: class {
    push = forge.push;
  },
  InvocationError: class {
    constructor(readonly options: unknown) {}
  },
  InvocationErrorCode: { FUNCTION_UPSTREAM_RATE_LIMITED: 'FUNCTION_UPSTREAM_RATE_LIMITED' },
}));

import { LATEST_MIGRATION, MIGRATIONS } from '../src/core/migrations';
import { SchemaSettingUpError } from '../src/core/schema';
import { ACTIONS, factKeeperAction } from '../src/surfaces/actions';
import { onAppLifecycle, onPageEvent } from '../src/surfaces/background';
import { bylineStatus, schemaView, type BylineDeps } from '../src/surfaces/ui';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  forge.push.mockClear();
});

describe('migrations', () => {
  it('are uniquely named, versioned and idempotent', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    for (const m of MIGRATIONS) {
      expect(m.name).toMatch(/^v\d{3}[a-z]?_/);
      expect(m.statement).toMatch(/IF NOT EXISTS/);
      // One ADD per ALTER: multi-clause ALTER TABLE is not guaranteed on Forge SQL.
      if (/^\s*ALTER\s+TABLE/i.test(m.statement)) expect(m.statement.match(/\bADD\b/gi) ?? []).toHaveLength(1);
      expect(m.statement.trim()).not.toMatch(/;\s*\S/); // one statement per migration
    }
  });

  it('use only IF NOT EXISTS forms the Forge SQL (TiDB) grammar accepts', () => {
    // Accepted: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, ADD INDEX/KEY IF NOT EXISTS,
    // CREATE [UNIQUE] INDEX IF NOT EXISTS name ON table. TiDB rejects IF NOT EXISTS after
    // ADD UNIQUE / ADD PRIMARY KEY / ADD CONSTRAINT / ADD FULLTEXT (ER_PARSE_ERROR 1064, dev 8.7.0).
    const accepted = [
      /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+\w+\s*\(/i,
      /^ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+\w+\s/i,
      /^ALTER\s+TABLE\s+\w+\s+ADD\s+(?:INDEX|KEY)\s+IF\s+NOT\s+EXISTS\s+\w+\s*\(/i,
      /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+\w+\s*\(/i,
    ];
    for (const m of MIGRATIONS) {
      const s = m.statement.trim();
      expect(accepted.some((re) => re.test(s)), `${m.name}: ${s.slice(0, 80)}`).toBe(true);
      expect(s, m.name).not.toMatch(/\bADD\s+(?:UNIQUE|PRIMARY|CONSTRAINT|FULLTEXT|SPATIAL)\b[^(]*\bIF\s+NOT\s+EXISTS/i);
    }
  });

  it('are listed in order', () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual(['v001_create_settings', 'v002_create_audit', 'v003_create_sources', 'v004_create_facts', 'v005_facts_origin_key', 'v006_sources_text_truncated',
      'v007_create_scan_jobs',
      'v008_create_scan_hits',
      'v009_create_copies',
      'v010_scan_jobs_fact_ids',
      'v011_scan_jobs_llm_calls',
      'v012_scan_jobs_partial',
      'v013_scan_jobs_pages_skipped',
      'v014_scan_jobs_active_source',
      'v015_scan_jobs_active_unique',
      'v016_create_scan_chunks',
      'v017_create_changes',
      'v018_create_page_events',
      'v019_facts_search_terms',
      'v020_scan_jobs_synonyms_cached',
    ]);
    expect(LATEST_MIGRATION).toBe('v020_scan_jobs_synonyms_cached');
  });
});

describe('schemaView', () => {
  it('reports ready, setting up and errors', async () => {
    expect(await schemaView(async () => undefined)).toEqual({ status: 'ready', applied: 20, total: 20, latest: LATEST_MIGRATION });
    expect(
      await schemaView(async () => {
        throw new SchemaSettingUpError(1, 4);
      }),
    ).toMatchObject({ status: 'setting_up', applied: 1, total: 4 });
    expect(
      await schemaView(async () => {
        throw new Error('db down');
      }),
    ).toMatchObject({ status: 'error', error: 'db down' });
  });
});

describe('bylineStatus', () => {
  const graphWith = (body: unknown) => () => async () => ({ body });
  const deps = (over: Partial<BylineDeps> = {}): BylineDeps => ({
    graph: graphWith({ data: { atlassianTeamsBySpace: { edges: [{ node: { id: 't1', displayName: 'Platform Team' } }] } } }),
    pageMeta: vi.fn(async () => ({ spaceId: '99', ownerId: 'owner-1', authorId: 'author-1' })),
    names: vi.fn(async () => new Map([['owner-1', 'Ana Owner']])),
    pendingChange: async () => null,
    ensure: async () => undefined,
    ...over,
  });

  it('shows "Ripple is ready" with the space team from the context space id', async () => {
    const d = deps();
    const r = await bylineStatus({ cloudId: 'c1', extension: { content: { id: 5 }, space: { id: 7 } } }, d);
    expect(r.message).toBe('Ripple is ready');
    expect(r.schema.status).toBe('ready');
    expect(r.spaceTeams).toEqual({ spaceId: '7', teams: [{ id: 't1', name: 'Platform Team' }], dataPresent: true, errors: [] });
    expect(d.pageMeta).toHaveBeenCalledTimes(1); // owner only; the space id came from the context
  });

  it('names the page owner from REST v2 ownerId via users-bulk', async () => {
    const d = deps();
    const r = await bylineStatus({ cloudId: 'c1', extension: { content: { id: 5 } } }, d);
    expect(r.owner).toEqual({ accountId: 'owner-1', role: 'owner', displayName: 'Ana Owner', errors: [] });
    expect(d.names).toHaveBeenCalledWith(['owner-1']);
    expect(d.pageMeta).toHaveBeenCalledTimes(1); // shared by owner and space id lookups
  });

  it('keeps the owner id when the name lookup fails or the name is hidden', async () => {
    const failing = await bylineStatus(
      { cloudId: 'c1', extension: { content: { id: 5 } } },
      deps({
        names: async () => {
          throw new Error('Confluence users-bulk failed: HTTP 403');
        },
      }),
    );
    expect(failing.owner).toEqual({ accountId: 'owner-1', role: 'owner', displayName: null, errors: ['Confluence users-bulk failed: HTTP 403'] });
    const hidden = await bylineStatus({ cloudId: 'c1', extension: { content: { id: 5 } } }, deps({ names: async () => new Map() }));
    expect(hidden.owner.displayName).toBeNull();
  });

  it('falls back to the REST v2 page for the space id', async () => {
    const d = deps();
    const r = await bylineStatus({ cloudId: 'c1', extension: { content: { id: 5 } } }, d);
    expect(d.pageMeta).toHaveBeenCalledWith('5');
    expect(r.spaceTeams.spaceId).toBe('99');
  });

  it('never throws: missing cloud id or a failed page lookup become errors', async () => {
    expect((await bylineStatus({}, deps())).spaceTeams.errors).toEqual(['no cloud id in context']);
    const failing = deps({
      pageMeta: async () => {
        throw new Error('Confluence REST v2 page 5 failed: HTTP 404');
      },
    });
    const r = await bylineStatus({ cloudId: 'c1', extension: { content: { id: 5 } } }, failing);
    expect(r.spaceTeams).toMatchObject({ spaceId: null, teams: [], errors: ['Confluence REST v2 page 5 failed: HTTP 404'] });
  });

  it('does not claim "ready" while the schema is setting up or the check failed', async () => {
    const setting = await bylineStatus(
      { cloudId: 'c1', extension: { space: { id: 7 } } },
      deps({
        ensure: async () => {
          throw new SchemaSettingUpError(1, 2);
        },
      }),
    );
    expect(setting.message).toBe('Ripple is setting up');
    const failed = await bylineStatus(
      { cloudId: 'c1', extension: { space: { id: 7 } } },
      deps({
        ensure: async () => {
          throw new Error('db down');
        },
      }),
    );
    expect(failed.message).toBe('Ripple is unavailable: database check failed');
    expect(failed.schema).toMatchObject({ status: 'error', error: 'db down' });
  });

  it('flags data: null from the graph', async () => {
    const r = await bylineStatus({ cloudId: 'c1', extension: { space: { id: 7 } } }, deps({ graph: graphWith({ data: null }) }));
    expect(r.spaceTeams).toMatchObject({ teams: [], dataPresent: false });
  });
});

describe('background and Rovo stubs', () => {
  it('queues a migration on install/upgrade', async () => {
    await onAppLifecycle({ eventType: 'avi:forge:installed:app' });
    expect(forge.push).toHaveBeenCalledWith({ body: { reason: 'avi:forge:installed:app' } });
  });

  it('page events never throw; actions reply "not implemented"', async () => {
    // The schema check fails here (SQL is mocked away): the trigger logs and returns instead of throwing.
    await expect(onPageEvent({ eventType: 'avi:confluence:updated:page', content: { id: 1 } })).resolves.toBeUndefined();
    await expect(onPageEvent({ eventType: 'avi:confluence:updated:page', content: { id: 'x' } })).resolves.toBeUndefined();
    for (const key of ACTIONS) {
      expect(await factKeeperAction({ context: { moduleKey: key } })).toMatchObject({ status: 'not_implemented', feature: `Rovo action ${key}` });
    }
  });
});
