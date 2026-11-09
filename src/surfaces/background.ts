import { InvocationError, InvocationErrorCode } from '@forge/events';
import { requestMigration, runMigrations } from '../adapters/sql';
import { notImplemented } from './stub';

export const EXTRACT_QUEUE = 'extract';
export const SEARCH_QUEUE = 'search';
export const JUDGE_QUEUE = 'judge';
export const DEMO_QUEUE = 'demo-seed';

const SCHEMA_RETRY_SECONDS = 60;
/** Migration budget per consumer run; the consumer timeout is 900 s (manifest.yml). */
const MIGRATE_BUDGET_MS = 12 * 60 * 1000;

/** Asks the queue to redeliver the event after `seconds`. */
export function retryLater(seconds: number, reason: string): InvocationError {
  // retryData must be set: the Forge runtime measures its serialised size and fails when it is undefined.
  return new InvocationError({
    retryAfter: seconds,
    retryReason: InvocationErrorCode.FUNCTION_UPSTREAM_RATE_LIMITED,
    retryData: { reason },
  });
}

/** Install / upgrade: queue the schema migration (only the `schema-migrate` consumer runs DDL). */
export async function onAppLifecycle(event: { eventType?: string }): Promise<void> {
  const jobId = await requestMigration(event.eventType ?? 'lifecycle');
  console.info('ripple migrations: queued', { eventType: event.eventType, jobId });
}

/** Consumer for `schema-migrate`: waits out the Forge SQL DDL rate limit and re-queues itself if out of time. */
export async function migrateSchema(): Promise<InvocationError | void> {
  const result = await runMigrations(MIGRATE_BUDGET_MS);
  console.info('ripple migrations', result);
  if (result.status === 'pending') return retryLater(SCHEMA_RETRY_SECONDS, 'schema');
}

interface PageEvent {
  eventType?: string;
  content?: { id?: string | number };
}

/** `avi:confluence:updated:page`: will queue fact re-extraction for source-of-truth pages (M2). */
export async function onPageEvent(event: PageEvent): Promise<void> {
  notImplemented('page change detection', { eventType: event.eventType, pageId: event.content?.id !== undefined ? String(event.content.id) : undefined });
}

export async function extractFacts(): Promise<void> {
  notImplemented(`${EXTRACT_QUEUE} consumer`);
}

export async function searchCopies(): Promise<void> {
  notImplemented(`${SEARCH_QUEUE} consumer`);
}

export async function judgeCandidates(): Promise<void> {
  notImplemented(`${JUDGE_QUEUE} consumer`);
}

export async function demoJob(): Promise<void> {
  notImplemented(`${DEMO_QUEUE} consumer`);
}

/** Weekly trigger: reminders for overdue updates and periodic re-scan (P1). */
export async function weeklySweep(): Promise<void> {
  notImplemented('weekly sweep');
}
