/**
 * Schema migration with Forge SQL's DDL rate limit in mind (25 DDL requests per minute per installation). A new
 * install has ~30 migrations, so it cannot finish in one go: only the `schema-migrate` queue consumer runs DDL, and
 * it waits a minute whenever the limit is hit. Resolvers and other callers only *check* the schema (plain SELECT,
 * no DDL) and report "setting up" until the consumer is done.
 */
export interface Migration {
  name: string;
  statement: string;
}

/** Where migrations run. `applied` must not use the DDL endpoint, so checking the schema never spends DDL quota. */
export interface MigrationStore {
  /** Names recorded as applied, or `undefined` when the history table cannot be read (new install). */
  applied(): Promise<string[] | undefined>;
  createHistory(): Promise<void>;
  ddl(statement: string): Promise<void>;
  record(name: string): Promise<void>;
}

export interface SchemaStatus {
  applied: number;
  total: number;
  pending: Migration[];
  historyMissing: boolean;
}

/** Thrown when the schema is not complete yet; resolvers turn it into a friendly "setting up" reply. */
export class SchemaSettingUpError extends Error {
  constructor(
    readonly applied: number,
    readonly total: number,
  ) {
    super(`Ripple is setting up its database (${applied}/${total} steps). This takes a minute or two after install; try again shortly.`);
    this.name = 'SchemaSettingUpError';
  }
}

const RATE_LIMIT_MESSAGE = 'Limits for the current installation have been exceeded';

/** True for Forge SQL's per-installation rate limit (HTTP 429 `RATE_LIMIT_EXCEEDED`), also when wrapped in `cause`. */
export function isSqlRateLimited(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const { code, message, responseDetails } = e as { code?: unknown; message?: unknown; responseDetails?: { status?: unknown } };
    if (code === 'RATE_LIMIT_EXCEEDED' || responseDetails?.status === 429) return true;
    if (typeof message === 'string' && message.includes(RATE_LIMIT_MESSAGE)) return true;
  }
  return false;
}

export async function schemaStatus(store: MigrationStore, migrations: readonly Migration[]): Promise<SchemaStatus> {
  const names = await store.applied();
  const done = new Set(names ?? []);
  const pending = migrations.filter((m) => !done.has(m.name));
  return { applied: migrations.length - pending.length, total: migrations.length, pending, historyMissing: names === undefined };
}

/**
 * Applies pending migrations in order and returns the names it ran. On the DDL rate limit it stops and throws
 * `SchemaSettingUpError` with the progress so far; any other error is rethrown. Re-reads the history before each
 * step, so two runs racing each other mostly skip what the other already did (every statement is IF NOT EXISTS).
 */
export async function applyMigrations(store: MigrationStore, migrations: readonly Migration[]): Promise<string[]> {
  const ran: string[] = [];
  let status = await schemaStatus(store, migrations);
  try {
    if (status.historyMissing) await store.createHistory();
    while (status.pending.length > 0) {
      const next = status.pending[0]!;
      await store.ddl(next.statement);
      await store.record(next.name);
      ran.push(next.name);
      status = await schemaStatus(store, migrations);
    }
    return ran;
  } catch (err) {
    if (!isSqlRateLimited(err)) throw err;
    const latest = await schemaStatus(store, migrations).catch(() => status);
    throw new SchemaSettingUpError(latest.applied, latest.total);
  }
}

export interface PacingOptions {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Stop waiting after this time (epoch ms); the caller re-queues the rest. */
  deadline: number;
  /** Wait after hitting the rate limit; the limit is per minute. */
  waitMs?: number;
}

/** Runs migrations to completion, waiting `waitMs` each time the DDL rate limit is hit, until `deadline`. */
export async function migrateWithPacing(
  store: MigrationStore,
  migrations: readonly Migration[],
  options: PacingOptions,
): Promise<{ status: 'done' | 'pending'; applied: number; total: number }> {
  const waitMs = options.waitMs ?? 61_000;
  for (;;) {
    try {
      await applyMigrations(store, migrations);
      return { status: 'done', applied: migrations.length, total: migrations.length };
    } catch (err) {
      if (!(err instanceof SchemaSettingUpError)) throw err;
      if (options.now() + waitMs > options.deadline) return { status: 'pending', applied: err.applied, total: err.total };
      console.info('ripple migrations: DDL rate limit reached, waiting', { applied: err.applied, total: err.total, waitMs });
      await options.sleep(waitMs);
    }
  }
}

/**
 * Check-only schema guard for resolvers, triggers and consumers: no DDL. Remembers "complete" per isolate. When
 * migrations are pending it asks for a migration run (at most once per `requestEveryMs` per isolate) and throws
 * `SchemaSettingUpError`.
 */
export function schemaGuard(
  status: () => Promise<{ applied: number; total: number }>,
  requestMigration: () => Promise<unknown>,
  options: { now?: () => number; requestEveryMs?: number } = {},
): () => Promise<void> {
  const now = options.now ?? Date.now;
  const every = options.requestEveryMs ?? 60_000;
  let ready = false;
  let lastRequest: number | undefined;
  return async () => {
    if (ready) return;
    const s = await status();
    if (s.applied >= s.total) {
      ready = true;
      return;
    }
    if (lastRequest === undefined || now() - lastRequest >= every) {
      lastRequest = now();
      await requestMigration().catch((err: unknown) => {
        lastRequest = undefined;
        console.warn('ripple migrations: could not queue a migration run', { error: err instanceof Error ? err.message : String(err) });
      });
    }
    throw new SchemaSettingUpError(s.applied, s.total);
  };
}
