import { InvocationError, InvocationErrorCode } from '@forge/events';
import { requestMigration, runMigrations } from '../adapters/sql';
import { scrubErrorText } from '../adapters/teamworkGraph';
import { handlePageUpdate, runDiffJob } from './changes';
import { runJudgeJob, runSearchJob, type ScanOutcome } from './copies';
import { runExtractJob } from './sources';
import { notImplemented } from './stub';

export { EXTRACT_QUEUE } from './sources';
export { JUDGE_QUEUE, SEARCH_QUEUE } from './copies';
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
  content?: { id?: string | number; version?: { number?: unknown; message?: unknown } };
}

/** `avi:confluence:updated:page`: queues change detection for source-of-truth pages (M3, see `handlePageUpdate`). */
export async function onPageEvent(event: PageEvent): Promise<void> {
  const raw = event.content?.id;
  const pageId = raw === undefined ? '' : String(raw);
  if (!/^\d{1,32}$/.test(pageId)) return;
  const v = event.content?.version;
  const version = typeof v?.number === 'number' && Number.isInteger(v.number) ? v.number : null;
  try {
    const outcome = await handlePageUpdate({ pageId, version, message: typeof v?.message === 'string' ? v.message : null });
    // Most saved pages are not sources: only queued diffs are logged.
    if (outcome.status === 'queued') console.info('ripple page update: diff queued', { pageId, version, jobId: outcome.jobId });
    else if (outcome.reason !== 'not a source') console.info('ripple page update ignored', { pageId, version, reason: outcome.reason });
  } catch (err) {
    console.warn('ripple page update failed', { pageId, error: scrubErrorText(err instanceof Error ? err.message : String(err)) });
  }
}

interface ExtractEvent {
  body?: { pageId?: unknown; kind?: unknown };
  retryContext?: { retryCount?: number };
}

/**
 * Consumer for `extract`: facts of one source page (body `{ pageId }`, see `runExtractJob`), or change detection
 * after the page was saved (body `{ pageId, kind: 'diff' }`, see `runDiffJob`).
 */
export async function extractFacts(event: ExtractEvent): Promise<InvocationError | void> {
  const pageId = event.body?.pageId;
  if (typeof pageId !== 'string' || !/^\d{1,32}$/.test(pageId)) {
    console.warn('ripple extract: ignoring event without a valid page id');
    return;
  }
  if (event.body?.kind === 'diff') {
    const diff = await runDiffJob(pageId, event.retryContext?.retryCount ?? 0);
    if (diff.status === 'retry') return retryLater(diff.seconds, diff.reason);
    if (diff.status === 'skipped') console.info('ripple diff skipped', { pageId, reason: diff.reason });
    return;
  }
  const outcome = await runExtractJob(pageId, event.retryContext?.retryCount ?? 0);
  if (outcome.status === 'retry') return retryLater(outcome.seconds, outcome.reason);
  if (outcome.status === 'skipped') console.info('ripple extract skipped', { pageId, reason: outcome.reason });
}

interface ScanEvent {
  body?: { scanId?: unknown };
  retryContext?: { retryCount?: number };
}

const UUID = /^[0-9a-f-]{36}$/i;

async function runScanConsumer(what: string, event: ScanEvent, run: (scanId: string, retryCount: number) => Promise<ScanOutcome>): Promise<InvocationError | void> {
  const scanId = event.body?.scanId;
  if (typeof scanId !== 'string' || !UUID.test(scanId)) {
    console.warn(`ripple ${what}: ignoring event without a valid scan id`);
    return;
  }
  const outcome = await run(scanId, event.retryContext?.retryCount ?? 0);
  if (outcome.status === 'retry') return retryLater(outcome.seconds, outcome.reason);
  if (outcome.status === 'skipped') console.info(`ripple ${what} skipped`, { scanId, reason: outcome.reason });
}

/** Consumer for `search`: CQL candidates of a scan (body `{ scanId }`), see `runSearchJob`. */
export const searchCopies = (event: ScanEvent): Promise<InvocationError | void> => runScanConsumer('search', event, (id, n) => runSearchJob(id, n));

/** Consumer for `judge`: judges the scan's candidate pages in batches (body `{ scanId }`), see `runJudgeJob`. */
export const judgeCandidates = (event: ScanEvent): Promise<InvocationError | void> => runScanConsumer('judge', event, (id, n) => runJudgeJob(id, n));

export async function demoJob(): Promise<void> {
  notImplemented(`${DEMO_QUEUE} consumer`);
}

/** Weekly trigger: reminders for overdue updates and periodic re-scan (P1). */
export async function weeklySweep(): Promise<void> {
  notImplemented('weekly sweep');
}
