/**
 * M6 "Load demo data" (Ripple settings page, Jira administrators only): creates the Nimbus Labs spaces and pages of
 * `src/demo/nimbus.ts` as the caller. Loads in steps within a time budget per resolver call and keeps its progress in
 * the `settings` table, so the UI calls again until `done`, and a repeated or concurrent load finds what exists
 * (spaces by key, pages by title) instead of creating it twice. Logs carry ids, counts and enums only.
 */
import { demoConfluence, type DemoConfluence, type DemoRef } from '../adapters/demoConfluence';
import { sqlDemoRepo, type DemoRepo, type DemoState } from '../adapters/demoRepo';
import { scrubErrorText } from '../adapters/teamworkGraph';
import { NIMBUS_ALL_PAGES, NIMBUS_SOURCE, NIMBUS_SPACES, type NimbusPage, type NimbusSpace } from '../demo/nimbus';
import { SchemaSettingUpError } from '../core/schema';
import type { AdminCheck, DemoStatus, ErrorReply, LoadDemoPayload } from '../core/views';
import { adminCheck, defaultSettingsDeps, SETTINGS_MODULE, type SettingsContext } from './changeIssues';

/** Time one `loadDemoData` call may spend before it returns `loading` (resolvers time out at 25 s). */
export const DEMO_BUDGET_MS = 18_000;
export const MAX_DEMO_OWNERS = 6;
/** Atlassian account ids (`557058:<uuid>`, 24 hex digits, …): letters, digits, `:` and `-` only. */
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9:-]{5,127}$/;
export const DEMO_TOTAL = NIMBUS_SPACES.length + NIMBUS_ALL_PAGES.length;

export interface DemoDeps {
  confluence: DemoConfluence;
  repo: DemoRepo;
  admin: (ctx: SettingsContext) => Promise<AdminCheck>;
  ensure: () => Promise<void>;
  now: () => number;
  budgetMs: number;
}

const defaultDemoDeps: DemoDeps = {
  confluence: demoConfluence,
  repo: sqlDemoRepo,
  admin: (ctx) => adminCheck(ctx, defaultSettingsDeps),
  ensure: defaultSettingsDeps.ensure,
  now: () => Date.now(),
  budgetMs: DEMO_BUDGET_MS,
};

function statusOf(state: DemoState | undefined, canEdit: boolean, errorCode: string | null = null): DemoStatus {
  const step = state ? Object.keys(state.spaces).length + Object.keys(state.pages).length : 0;
  const ownerCode = state?.state === 'done' && state.ownerErrors > 0 ? 'owner_change_failed' : null;
  return {
    state: state?.state ?? 'idle',
    step: Math.min(step, DEMO_TOTAL),
    total: DEMO_TOTAL,
    spaces: NIMBUS_SPACES.filter((s) => state?.spaces[s.key]).map((s) => ({ key: s.key, name: s.name, url: state?.spaces[s.key]?.url ?? null })),
    sourcePageUrl: state?.pages[NIMBUS_SOURCE.slug]?.url ?? null,
    canEdit,
    errorCode: errorCode ?? state?.errorCode ?? ownerCode,
  };
}

async function guard(ctx: SettingsContext, deps: DemoDeps, what: string, body: () => Promise<DemoStatus>): Promise<DemoStatus | ErrorReply> {
  if (ctx.moduleKey !== SETTINGS_MODULE) return { error: 'Open Ripple settings to do that.' };
  try {
    await deps.ensure();
    return await body();
  } catch (err) {
    if (err instanceof SchemaSettingUpError) return { error: err.message };
    console.warn(`ripple demo: ${what} failed`, { error: scrubErrorText(err instanceof Error ? err.message : String(err)) });
    return { error: `Ripple could not ${what}.` };
  }
}

export async function getDemoStatus(ctx: SettingsContext, deps: DemoDeps = defaultDemoDeps): Promise<DemoStatus | ErrorReply> {
  return guard(ctx, deps, 'read the demo data status', async () => {
    const state = await deps.repo.getDemoState();
    return statusOf(state, (await deps.admin(ctx)) === 'admin');
  });
}

/** Owner ids from the payload: undefined when absent, null when invalid (not an array, > 6, bad format). */
function ownerIds(payload: Partial<LoadDemoPayload> | undefined): string[] | undefined | null {
  const raw = payload?.ownerAccountIds;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_DEMO_OWNERS) return null;
  const ids = raw.map((x: unknown) => (typeof x === 'string' ? x.trim() : null));
  if (ids.some((x) => x === null || (x !== '' && !ACCOUNT_ID.test(x)))) return null;
  return [...new Set(ids.filter((x): x is string => !!x))];
}

type Step<T> = { ok: true; value: T } | { ok: false; code: string };

/** Finds the space by key, else creates it; a failed create is looked up again (a concurrent load made it). */
async function ensureSpace(c: DemoConfluence, s: NimbusSpace): Promise<Step<DemoRef>> {
  const found = await c.findSpace(s.key);
  if (!found.ok) return { ok: false, code: `space_find_http_${found.status}` };
  if (found.value) return { ok: true, value: found.value };
  const created = await c.createSpace(s.key, s.name, s.description);
  if (created.ok) return { ok: true, value: created.value };
  const again = await c.findSpace(s.key);
  return again.ok && again.value ? { ok: true, value: again.value } : { ok: false, code: `space_create_http_${created.status}` };
}

async function ensurePage(c: DemoConfluence, spaceId: string, p: NimbusPage): Promise<Step<{ ref: DemoRef; created: boolean }>> {
  const found = await c.findPage(spaceId, p.title);
  if (!found.ok) return { ok: false, code: `page_find_http_${found.status}` };
  if (found.value) return { ok: true, value: { ref: found.value, created: false } };
  const created = await c.createPage(spaceId, p.title, p.storage);
  if (created.ok) return { ok: true, value: { ref: created.value, created: true } };
  const again = await c.findPage(spaceId, p.title);
  return again.ok && again.value ? { ok: true, value: { ref: again.value, created: false } } : { ok: false, code: `page_create_http_${created.status}` };
}

/**
 * Creates the next spaces and pages until done, a step fails (`failed`, resumable by pressing again) or the budget is
 * spent (`loading`). Copy and history pages go round robin to `ownerAccountIds` (the source stays with the caller); a
 * failed owner change keeps the page with the caller and is counted, never fatal.
 */
export async function loadDemoData(ctx: SettingsContext, payload: Partial<LoadDemoPayload> | undefined, deps: DemoDeps = defaultDemoDeps): Promise<DemoStatus | ErrorReply> {
  return guard(ctx, deps, 'load the demo data', async () => {
    const started = deps.now();
    const current = await deps.repo.getDemoState();
    const admin = await deps.admin(ctx);
    if (admin !== 'admin') return statusOf(current, false, admin === 'not_admin' ? 'not_allowed' : 'admin_check_failed');
    const owners = ownerIds(payload);
    if (owners === null) return statusOf(current, true, 'invalid_owner_ids');
    if (current?.state === 'done') return statusOf(current, true);

    const state: DemoState = current ?? { state: 'loading', spaces: {}, pages: {}, ownerAccountIds: [], errorCode: null, ownerErrors: 0 };
    state.state = 'loading';
    state.errorCode = null;
    if (owners !== undefined) state.ownerAccountIds = owners;
    const fail = async (code: string): Promise<DemoStatus> => {
      state.state = 'failed';
      state.errorCode = code;
      await deps.repo.saveDemoState(state);
      console.warn('ripple demo: load step failed', { error: code, step: Object.keys(state.spaces).length + Object.keys(state.pages).length });
      return statusOf(state, true);
    };
    const spent = (): boolean => deps.now() - started >= deps.budgetMs;

    for (const s of NIMBUS_SPACES) {
      if (state.spaces[s.key]) continue;
      if (spent()) return pause(deps, state);
      const r = await ensureSpace(deps.confluence, s);
      if (!r.ok) return fail(r.code);
      state.spaces[s.key] = { id: r.value.id, url: r.value.url };
      await deps.repo.saveDemoState(state);
    }
    const copies = NIMBUS_ALL_PAGES.filter((p) => p.kind !== 'source');
    for (const p of NIMBUS_ALL_PAGES) {
      if (state.pages[p.slug]) continue;
      if (spent()) return pause(deps, state);
      const space = state.spaces[p.space];
      if (!space) return fail('space_missing');
      const r = await ensurePage(deps.confluence, space.id, p);
      if (!r.ok) return fail(r.code);
      const entry: DemoState['pages'][string] = { id: r.value.ref.id, url: r.value.ref.url };
      const owner = p.kind === 'source' || state.ownerAccountIds.length === 0 ? undefined : state.ownerAccountIds[copies.indexOf(p) % state.ownerAccountIds.length];
      if (r.value.created && owner !== undefined && owner !== ctx.accountId) {
        const set = await deps.confluence.setOwner(entry.id, p.title, p.storage, owner);
        if (!set.ok) {
          entry.ownerFailed = true;
          state.ownerErrors += 1;
          console.warn('ripple demo: page owner change failed', { pageId: entry.id, error: `owner_http_${set.status}` });
        }
      }
      state.pages[p.slug] = entry;
      await deps.repo.saveDemoState(state);
    }
    state.state = 'done';
    await deps.repo.saveDemoState(state);
    console.info('ripple demo: loaded', { spaces: Object.keys(state.spaces).length, pages: Object.keys(state.pages).length, owners: state.ownerAccountIds.length, ownerErrors: state.ownerErrors });
    return statusOf(state, true);
  });
}

async function pause(deps: DemoDeps, state: DemoState): Promise<DemoStatus> {
  await deps.repo.saveDemoState(state);
  return statusOf(state, true);
}
