import { Queue } from '@forge/events';
import { migrationRunner, sql } from '@forge/sql';
import { MIGRATIONS } from '../core/migrations';
import {
  isSqlRateLimited,
  migrateWithPacing,
  sqlOp,
  schemaGuard,
  schemaStatus,
  type MigrationFailure,
  type MigrationStore,
  type SchemaStatus,
} from '../core/schema';

export const MIGRATE_QUEUE = 'schema-migrate';
const migrateQueue = new Queue({ key: MIGRATE_QUEUE });

/** Forge SQL migration history (the table `@forge/sql`'s `migrationRunner` uses). Reads go through the DML endpoint. */
const store: MigrationStore = {
  async applied() {
    try {
      const result = await sql.prepare<{ name: string }>('SELECT name FROM __migrations').execute();
      return (result.rows as { name: string }[]).map((r) => r.name);
    } catch (err) {
      // A new install has no history table yet; the migration run creates it. Errors other than "missing" surface
      // there too (the run would fail on its first statement).
      if (isSqlRateLimited(err)) throw err;
      return undefined;
    }
  },
  createHistory: () => migrationRunner.initialize(),
  ddl: async (statement) => {
    await sql.executeDDL(statement);
  },
  record: async (name) => {
    await sql.prepare('INSERT INTO __migrations (name) VALUES (?)').bindParams(name).execute();
  },
  // The failure lives in `settings` (v001), plain DML: it exists whenever a later step can fail.
  failure: async () => {
    const result = await sql.prepare<{ v: unknown }>('SELECT v FROM settings WHERE k = ?').bindParams(FAILURE_KEY).execute();
    return parseFailure((result.rows as { v: unknown }[])[0]?.v);
  },
  recordFailure: async (failure) => {
    await sql
      .prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)')
      .bindParams(FAILURE_KEY, JSON.stringify(failure))
      .execute();
  },
  clearFailure: async () => {
    await sql.prepare('DELETE FROM settings WHERE k = ?').bindParams(FAILURE_KEY).execute();
  },
};

const FAILURE_KEY = 'schema_migration_failure';

/** A stored `MigrationFailure` (JSON column: string or already parsed), or undefined when absent or malformed. */
export function parseFailure(raw: unknown): MigrationFailure | undefined {
  let v: unknown = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (!v || typeof v !== 'object') return undefined;
  const { migration, code, attempts } = v as Record<string, unknown>;
  if (typeof migration !== 'string' || typeof code !== 'string' || typeof attempts !== 'number') return undefined;
  return { migration, code, attempts };
}

/** Queues a migration run on the `schema-migrate` consumer (the only place that runs DDL). */
export async function requestMigration(reason: string): Promise<string> {
  const { jobId } = await migrateQueue.push({ body: { reason } });
  return jobId;
}

/**
 * Applies pending migrations, waiting out the DDL rate limit, for up to `budgetMs`. Only for the `schema-migrate`
 * consumer (900 s timeout).
 */
export function runMigrations(budgetMs: number) {
  return migrateWithPacing(store, MIGRATIONS, {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    deadline: Date.now() + budgetMs,
  });
}

/** Current schema progress (plain SELECT, no DDL). */
export const currentSchemaStatus = (): Promise<SchemaStatus> => schemaStatus(store, MIGRATIONS);

/**
 * Call before any code that touches SQL. Never runs DDL: while migrations are pending it queues a migration run and
 * throws `SchemaSettingUpError` (callers show "setting up" or retry later).
 */
export const ensureSchema = schemaGuard(guardStatus, () => requestMigration('pending'));

/** Progress plus the recorded failure, when it is about the next pending step (read only while steps are pending). */
async function guardStatus(): Promise<SchemaStatus & { failure?: MigrationFailure }> {
  const s = await currentSchemaStatus();
  if (s.pending.length === 0 || s.historyMissing) return s;
  const failure = await store.failure?.().catch(() => undefined);
  return failure && failure.migration === s.pending[0]?.name ? { ...s, failure } : s;
}

/** Tags a failed statement's error with its operation label (see `sqlErrorInfo`), keeping the error itself. */
function tagged(err: unknown, statement: string): unknown {
  if (err && typeof err === 'object' && !('sqlOp' in err)) {
    try {
      Object.defineProperty(err, 'sqlOp', { value: sqlOp(statement), enumerable: false });
    } catch {
      // A frozen error object only loses the label.
    }
  }
  return err;
}

/** Parameterised SELECT; never interpolate values into `statement` (inline LIMIT only via `sqlInt`). */
export async function query<Row>(statement: string, ...params: unknown[]): Promise<Row[]> {
  try {
    const result = await sql.prepare<Row>(statement).bindParams(...params).execute();
    return result.rows as Row[];
  } catch (err) {
    throw tagged(err, statement);
  }
}

/** Parameterised INSERT/UPDATE/DELETE; returns the number of affected rows. */
export async function execute(statement: string, ...params: unknown[]): Promise<number> {
  try {
    const result = await sql.prepare<{ affectedRows: number }>(statement).bindParams(...params).execute();
    const rows = result.rows as unknown as { affectedRows?: number };
    return rows.affectedRows ?? 0;
  } catch (err) {
    throw tagged(err, statement);
  }
}
