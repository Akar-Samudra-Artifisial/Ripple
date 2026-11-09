import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyMigrations,
  isSqlRateLimited,
  migrateWithPacing,
  SchemaSettingUpError,
  schemaGuard,
  type Migration,
  type MigrationStore,
} from '../src/core/schema';

/** The error @forge/sql throws when the per-installation DDL limit is hit. */
function rateLimitError(): Error {
  return Object.assign(new Error('Limits for the current installation have been exceeded'), {
    name: 'ForgeSQLAPIError',
    code: 'RATE_LIMIT_EXCEEDED',
    responseDetails: { status: 429, statusText: 'Too Many Requests', traceId: null },
  });
}

const migrations: Migration[] = Array.from({ length: 30 }, (_, i) => ({ name: `v${String(i + 1).padStart(3, '0')}`, statement: `DDL ${i + 1}` }));

/** In-memory Forge SQL: no history table until created; DDL throws the rate-limit error after `ddlPerWindow` calls. */
function fakeStore(ddlPerWindow: number) {
  const state = { history: undefined as string[] | undefined, ddlCalls: 0, windowUsed: 0, executed: [] as string[] };
  const spendDdl = () => {
    state.ddlCalls += 1;
    if (state.windowUsed >= ddlPerWindow) throw rateLimitError();
    state.windowUsed += 1;
  };
  const store: MigrationStore = {
    applied: async () => (state.history ? [...state.history] : undefined),
    createHistory: async () => {
      spendDdl();
      state.history ??= [];
    },
    ddl: async (statement) => {
      spendDdl();
      state.executed.push(statement);
    },
    record: async (name) => {
      state.history!.push(name);
    },
  };
  return { state, store, resetWindow: () => (state.windowUsed = 0) };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('isSqlRateLimited', () => {
  it('matches the Forge SQL limit error, also wrapped as a MigrationExecutionError cause', () => {
    expect(isSqlRateLimited(rateLimitError())).toBe(true);
    expect(isSqlRateLimited(Object.assign(new Error('Failed to execute migration with name v017'), { cause: rateLimitError() }))).toBe(true);
    expect(isSqlRateLimited(new Error("Table 'x' doesn't exist"))).toBe(false);
    expect(isSqlRateLimited(undefined)).toBe(false);
  });
});

describe('applyMigrations', () => {
  it('stops at the DDL rate limit with the progress so far', async () => {
    const { store, state } = fakeStore(20);
    const err = await applyMigrations(store, migrations).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaSettingUpError);
    expect(err).toMatchObject({ applied: 19, total: 30 }); // 1 DDL creates the history table
    expect(state.history).toHaveLength(19);
  });

  it('spends no DDL when the schema is complete', async () => {
    const { store, state } = fakeStore(25);
    state.history = migrations.map((m) => m.name);
    expect(await applyMigrations(store, migrations)).toEqual([]);
    expect(state.ddlCalls).toBe(0);
  });

  it('rethrows SQL errors that are not the rate limit', async () => {
    const { store } = fakeStore(25);
    store.ddl = async () => {
      throw new Error('You have an error in your SQL syntax');
    };
    await expect(applyMigrations(store, migrations)).rejects.toThrow('SQL syntax');
  });
});

describe('migrateWithPacing (new install, DDL limit per minute)', () => {
  it('waits out the limit and finishes every migration in order', async () => {
    const { store, state, resetWindow } = fakeStore(20);
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
      resetWindow();
    });
    const result = await migrateWithPacing(store, migrations, { sleep, now: () => clock, deadline: 12 * 60_000, waitMs: 61_000 });
    expect(result).toEqual({ status: 'done', applied: 30, total: 30 });
    expect(state.history).toEqual(migrations.map((m) => m.name));
    expect(state.executed).toEqual(migrations.map((m) => m.statement));
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('reports pending (caller re-queues) when the deadline comes first', async () => {
    const { store } = fakeStore(5);
    let clock = 0;
    const sleep = async (ms: number) => {
      clock += ms; // the window never resets: still limited
    };
    const result = await migrateWithPacing(store, migrations, { sleep, now: () => clock, deadline: 130_000, waitMs: 61_000 });
    expect(result).toEqual({ status: 'pending', applied: 4, total: 30 });
  });
});

describe('schemaGuard (check only, no DDL)', () => {
  it('queues a migration run and throws SchemaSettingUpError while migrations are pending', async () => {
    let clock = 0;
    const status = vi.fn(async () => ({ applied: 12, total: 30 }));
    const request = vi.fn(async () => 'job-1');
    const ensure = schemaGuard(status, request, { now: () => clock, requestEveryMs: 60_000 });
    await expect(ensure()).rejects.toMatchObject({ name: 'SchemaSettingUpError', applied: 12, total: 30 });
    await expect(ensure()).rejects.toBeInstanceOf(SchemaSettingUpError);
    expect(request).toHaveBeenCalledTimes(1); // throttled
    clock = 60_000;
    await expect(ensure()).rejects.toBeInstanceOf(SchemaSettingUpError);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('remembers a complete schema and stops checking', async () => {
    const status = vi.fn(async () => ({ applied: 30, total: 30 }));
    const request = vi.fn(async () => 'job-1');
    const ensure = schemaGuard(status, request);
    await ensure();
    await ensure();
    expect(status).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });
});
