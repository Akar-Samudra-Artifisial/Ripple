/**
 * Schema migration with Forge SQL's DDL rate limit in mind (25 DDL requests per minute per installation). The schema
 * grows append-only and a new install can exceed that limit in one go, so only the `schema-migrate` queue consumer runs DDL, and
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

/**
 * Integer for an inline `LIMIT`/`OFFSET`: Forge SQL (TiDB) rejects bound LIMIT parameters (`LIMIT ?` →
 * ER_WRONG_ARGUMENTS). Truncates and clamps to [min, max]; throws on non-finite input so only a number reaches SQL.
 */
export function sqlInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) throw new Error('sqlInt: not a finite number');
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Label of one of our own statements for logs ("SELECT scan_hits", "INSERT copies"); never contains values. */
export function sqlOp(statement: string): string {
  const s = statement.replace(/\s+/g, ' ').trim();
  const verb = (s.split(' ')[0] ?? '?').toUpperCase();
  const table = /\b(?:FROM|INTO|UPDATE|TABLE)\s+`?(\w+)/i.exec(s)?.[1] ?? '?';
  return `${verb} ${table}`;
}

export interface SqlErrorInfo {
  op?: string;
  code?: string;
  errno?: number;
  sqlState?: string;
  /** MySQL message with quoted values masked ('…' → '?') and cut to 160 characters. */
  sqlMessage?: string;
}

/**
 * Safe details of a Forge SQL error for logs: the operation label (set by the SQL adapter), the MySQL error code and a
 * masked message from `context.debug`. Undefined for errors that are not SQL errors.
 */
export function sqlErrorInfo(err: unknown): SqlErrorInfo | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { sqlOp?: unknown; code?: unknown; context?: { debug?: { code?: unknown; errno?: unknown; sqlState?: unknown; sqlMessage?: unknown } } };
  const debug = e.context?.debug;
  if (e.sqlOp === undefined && !debug) return undefined;
  const info: SqlErrorInfo = {};
  if (typeof e.sqlOp === 'string') info.op = e.sqlOp;
  const code = typeof debug?.code === 'string' ? debug.code : typeof e.code === 'string' ? e.code : undefined;
  if (code) info.code = code;
  if (typeof debug?.errno === 'number') info.errno = debug.errno;
  if (typeof debug?.sqlState === 'string') info.sqlState = debug.sqlState;
  if (typeof debug?.sqlMessage === 'string') info.sqlMessage = debug.sqlMessage.replace(/'[^']*'/g, "'?'").slice(0, 160);
  return info;
}

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
