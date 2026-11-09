/**
 * M6 "Load demo data" (Ripple settings page, Jira administrators only): creates the Nimbus Labs spaces and pages of
 * `src/demo/nimbus.ts` as the caller. Loads in steps within a time budget per resolver call and keeps its progress in
 * the `settings` table, so the UI calls again until `done`, and a repeated load finds what it created before (spaces
 * by key carrying `DEMO_MARKER`, pages by title in those spaces) instead of creating it twice. A space with a demo key
 * that Ripple did not create is never used (`space_key_taken`). One load runs at a time (a lease in the state, taken
 * and checked with compare-and-swap). Logs carry ids, counts and enums only (never account ids).
 */
import { randomUUID } from 'node:crypto';
import { userAccounts, type UserAccount } from '../adapters/confluenceUsers';
import { demoConfluence, type DemoConfluence, type DemoRef, type DemoSpaceRef } from '../adapters/demoConfluence';
import { sqlDemoRepo, type DemoPage, type DemoRepo, type DemoState } from '../adapters/demoRepo';
import { sqlRepo } from '../adapters/repo';
import { scrubErrorText } from '../adapters/teamworkGraph';
import { DEMO_MARKER, NIMBUS_ALL_PAGES, NIMBUS_SOURCE, NIMBUS_SPACES, type NimbusPage, type NimbusSpace } from '../demo/nimbus';
import { SchemaSettingUpError } from '../core/schema';
import { adminErrorCode, type AdminCheck, type CheckDemoOwnersPayload, type DemoOwnersCheck, type DemoRemoveResult, type DemoStatus, type ErrorReply, type LoadDemoPayload } from '../core/views';
import { adminCheck, defaultSettingsDeps, SETTINGS_MODULE, type SettingsContext } from './changeIssues';

/** Time one `loadDemoData` call may spend before it returns `loading` (resolvers time out at 25 s). */
export const DEMO_BUDGET_MS = 18_000;
/** How long a load holds the lease: at least a resolver's 25 s timeout, so a crashed load frees it after that. */
export const DEMO_LEASE_MS = 25_000;
export const MAX_DEMO_OWNERS = 6;
/** Atlassian account ids (`557058:<uuid>`, 24 hex digits, …): letters, digits, `:` and `-` only. */
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9:-]{5,127}$/;
export const DEMO_TOTAL = NIMBUS_SPACES.length + NIMBUS_ALL_PAGES.length;
const OWNED_PAGES = NIMBUS_ALL_PAGES.filter((p) => p.kind !== 'source');

export interface DemoDeps {
  confluence: DemoConfluence;
  repo: DemoRepo;
  admin: (ctx: SettingsContext) => Promise<AdminCheck>;
  /** users-bulk as the caller; throws when the lookup fails. */
  users: (accountIds: readonly string[]) => Promise<Map<string, UserAccount>>;
  ensure: () => Promise<void>;
  now: () => number;
  newLease: () => string;
  budgetMs: number;
  /** Deletes Ripple's data of a source page (the `unmarkSource` path) and audits it; idempotent. */
  removeSource: (pageId: string, actor: string | null) => Promise<void>;
}

const defaultDemoDeps: DemoDeps = {
  confluence: demoConfluence,
  repo: sqlDemoRepo,
  admin: (ctx) => adminCheck(ctx, defaultSettingsDeps),
  users: (ids) => userAccounts(ids),
  ensure: defaultSettingsDeps.ensure,
  now: () => Date.now(),
  newLease: () => randomUUID(),
  budgetMs: DEMO_BUDGET_MS,
  removeSource: async (pageId, actor) => {
    if (!(await sqlRepo.getSource(pageId))) return;
    const counts = await sqlRepo.countFacts(pageId);
    await sqlRepo.unmarkSource(pageId);
    await sqlRepo.audit('source.unmarked', actor, 'page', pageId, { ...counts, reason: 'demo_removed' });
  },
};

const ownerErrors = (state: DemoState | undefined): number => Object.values(state?.pages ?? {}).filter((p) => p.ownerState === 'failed').length;

/** `busy`: another load holds the lease (reported as `loading`). */
function statusOf(state: DemoState | undefined, canEdit: boolean, errorCode: string | null = null, busy = false): DemoStatus {
  const step = state ? Object.keys(state.spaces).length + Object.keys(state.pages).length : 0;
  const ownerCode = state?.state === 'done' && ownerErrors(state) > 0 ? 'owner_change_failed' : null;
  return {
    state: busy ? 'loading' : !state || state.state === 'removed' ? 'idle' : state.state,
    step: Math.min(step, DEMO_TOTAL),
    total: DEMO_TOTAL,
    spaces: NIMBUS_SPACES.filter((s) => state?.spaces[s.key]).map((s) => ({ key: s.key, name: s.name, url: state?.spaces[s.key]?.url ?? null })),
    sourcePageUrl: state?.pages[NIMBUS_SOURCE.slug]?.url ?? null,
    canEdit,
    errorCode: errorCode ?? (busy ? null : (state?.errorCode ?? ownerCode)),
  };
}

async function guard<T>(ctx: SettingsContext, deps: DemoDeps, what: string, body: () => Promise<T>): Promise<T | ErrorReply> {
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
    const busy = state !== undefined && state.lease !== '' && state.lockedUntil > deps.now();
    return statusOf(state, (await deps.admin(ctx)) === 'admin', null, busy);
  });
}

/** Owner ids from the payload: undefined when absent, null when invalid (not an array, > 6, bad format). */
function ownerIds(raw: unknown): string[] | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_DEMO_OWNERS) return null;
  const ids = raw.map((x: unknown) => (typeof x === 'string' ? x.trim() : null));
  if (ids.some((x) => x === null || (x !== '' && !ACCOUNT_ID.test(x)))) return null;
  return [...new Set(ids.filter((x): x is string => !!x))];
}

type OwnersResult = { ok: true; accounts: Map<string, UserAccount> } | { ok: false; code: 'owner_invalid' | 'owner_check_failed'; invalid: string[] };

/** Every owner must be an active Atlassian (human) account the caller can see; logs counts only. */
async function validateOwners(deps: DemoDeps, ids: string[]): Promise<OwnersResult> {
  if (ids.length === 0) return { ok: true, accounts: new Map() };
  let accounts: Map<string, UserAccount>;
  try {
    accounts = await deps.users(ids);
  } catch (err) {
    const status = /HTTP (\d{3})/.exec(err instanceof Error ? err.message : '')?.[1];
    console.warn('ripple demo: owner check failed', { error: status ? `users_http_${status}` : 'error', owners: ids.length });
    return { ok: false, code: 'owner_check_failed', invalid: [] };
  }
  const invalid = ids.filter((id) => {
    const a = accounts.get(id);
    return a?.accountType !== 'atlassian' || a.accountStatus !== 'active';
  });
  if (invalid.length > 0) {
    console.info('ripple demo: owners rejected', { owners: ids.length, invalid: invalid.length });
    return { ok: false, code: 'owner_invalid', invalid };
  }
  return { ok: true, accounts };
}

/** Looks the owners up for the UI's confirmation step; writes nothing. */
export async function checkDemoOwners(ctx: SettingsContext, payload: Partial<CheckDemoOwnersPayload> | undefined, deps: DemoDeps = defaultDemoDeps): Promise<DemoOwnersCheck | ErrorReply> {
  return guard(ctx, deps, 'check the owners', async () => {
    const reply = (errorCode: DemoOwnersCheck['errorCode'], invalidAccountIds: string[] = []): DemoOwnersCheck => ({ owners: [], pages: OWNED_PAGES.length, invalidAccountIds, errorCode });
    const admin = await deps.admin(ctx);
    if (admin !== 'admin') return reply(adminErrorCode(admin));
    const ids = ownerIds(payload?.ownerAccountIds);
    if (!ids) return reply('invalid_owner_ids');
    const v = await validateOwners(deps, ids);
    if (!v.ok) return reply(v.code, v.invalid);
    return { owners: ids.map((accountId) => ({ accountId, name: v.accounts.get(accountId)?.name || 'Unnamed user' })), pages: OWNED_PAGES.length, invalidAccountIds: [], errorCode: null };
  });
}

type Step<T> = { ok: true; value: T } | { ok: false; code: string };

const ours = (s: DemoSpaceRef): Step<DemoRef> => (s.description.includes(DEMO_MARKER) ? { ok: true, value: { id: s.id, url: s.url } } : { ok: false, code: 'space_key_taken' });

/**
 * Finds the space by key, else creates it (its description carries `DEMO_MARKER`); a failed create is looked up again
 * (a concurrent load made it). A found space without the marker belongs to someone else: `space_key_taken`.
 */
async function ensureSpace(c: DemoConfluence, s: NimbusSpace, deleted: ReadonlySet<string>): Promise<Step<DemoRef>> {
  const found = await c.findSpace(s.key);
  if (!found.ok) return { ok: false, code: `space_find_http_${found.status}` };
  if (found.value && deleted.has(found.value.id)) return { ok: false, code: 'space_being_deleted' };
  if (found.value) return ours(found.value);
  const created = await c.createSpace(s.key, s.name, s.description);
  if (created.ok) return { ok: true, value: created.value };
  const again = await c.findSpace(s.key);
  if (again.ok && again.value && deleted.has(again.value.id)) return { ok: false, code: 'space_being_deleted' };
  return again.ok && again.value ? ours(again.value) : { ok: false, code: `space_create_http_${created.status}` };
}

/** Pages are only looked up in spaces Ripple created (recorded or marked), so a found page is a demo page. */
async function ensurePage(c: DemoConfluence, spaceId: string, p: NimbusPage): Promise<Step<DemoRef>> {
  const found = await c.findPage(spaceId, p.title);
  if (!found.ok) return { ok: false, code: `page_find_http_${found.status}` };
  if (found.value) return { ok: true, value: found.value };
  const created = await c.createPage(spaceId, p.title, p.storage);
  if (created.ok) return { ok: true, value: created.value };
  const again = await c.findPage(spaceId, p.title);
  return again.ok && again.value ? { ok: true, value: again.value } : { ok: false, code: `page_create_http_${created.status}` };
}

/** Another load took the lease over (ours expired): stop without writing. */
class DemoLeaseLost extends Error {}

/**
 * Creates the next spaces and pages until done, a step fails (`failed`, resumable by pressing again) or the budget is
 * spent (`loading`). Copy and history pages go round robin to the owners (the source stays with the caller); each
 * page is saved as `pending` before its owner change, so a crash in between is resumed. A failed owner change keeps
 * the page with the caller and is counted, never fatal; `retryOwners` tries those again (also after `done`).
 */
export async function loadDemoData(ctx: SettingsContext, payload: Partial<LoadDemoPayload> | undefined, deps: DemoDeps = defaultDemoDeps): Promise<DemoStatus | ErrorReply> {
  return guard(ctx, deps, 'load the demo data', async () => {
    const started = deps.now();
    const current = await deps.repo.getDemoState();
    const admin = await deps.admin(ctx);
    if (admin !== 'admin') return statusOf(current, false, adminErrorCode(admin));
    const owners = ownerIds(payload?.ownerAccountIds);
    if (owners === null) return statusOf(current, true, 'invalid_owner_ids');
    const retry = payload?.retryOwners === true;
    if (current && current.lease !== '' && current.lockedUntil > started) return statusOf(current, true, null, true);
    if (current?.state === 'done' && !retry) return statusOf(current, true);
    if (owners && owners.length > 0) {
      const v = await validateOwners(deps, owners);
      if (!v.ok) return statusOf(current, true, v.code);
    }

    // Take the lease: insert the first state, or swap the stored one while its (expired or free) lease is unchanged.
    const lease = deps.newLease();
    const state: DemoState = {
      ...(current ?? { spaces: {}, pages: {}, ownerAccountIds: [], rev: 0 }),
      state: 'loading',
      errorCode: null,
      lease,
      lockedUntil: started + DEMO_LEASE_MS,
      rev: (current?.rev ?? 0) + 1,
    };
    if (owners !== undefined) state.ownerAccountIds = owners;
    const taken = current ? await deps.repo.replaceDemoState(state, current.lease) : await deps.repo.createDemoState(state);
    if (!taken) return statusOf(await deps.repo.getDemoState(), true, null, true);

    const save = async (): Promise<void> => {
      state.rev += 1;
      if (!(await deps.repo.replaceDemoState(state, lease))) throw new DemoLeaseLost();
    };
    /** Saves with the lease freed (pause, failure, done). */
    const release = async (): Promise<DemoStatus> => {
      state.lease = '';
      state.lockedUntil = 0;
      await save();
      return statusOf(state, true);
    };
    const fail = async (code: string): Promise<DemoStatus> => {
      state.state = 'failed';
      state.errorCode = code;
      console.warn('ripple demo: load step failed', { error: code, step: Object.keys(state.spaces).length + Object.keys(state.pages).length });
      return release();
    };
    const spent = (): boolean => deps.now() - started >= deps.budgetMs;

    try {
      for (const s of NIMBUS_SPACES) {
        if (state.spaces[s.key]) continue;
        if (spent()) return await release();
        const r = await ensureSpace(deps.confluence, s, new Set(state.deletedSpaceIds ?? []));
        if (!r.ok) return await fail(r.code);
        state.spaces[s.key] = { id: r.value.id, url: r.value.url };
        await save();
      }
      const n = state.ownerAccountIds.length;
      for (const p of NIMBUS_ALL_PAGES) {
        const slot = p.kind === 'source' || n === 0 ? undefined : state.ownerAccountIds[OWNED_PAGES.indexOf(p) % n];
        let entry: DemoPage | undefined = state.pages[p.slug];
        const ownerWork = (e: DemoPage): boolean => slot !== undefined && (e.owner !== slot || e.ownerState === 'pending' || (retry && e.ownerState === 'failed'));
        if (entry && !ownerWork(entry)) continue;
        if (spent()) return await release();
        if (!entry) {
          const space = state.spaces[p.space];
          if (!space) return await fail('space_missing');
          const r = await ensurePage(deps.confluence, space.id, p);
          if (!r.ok) return await fail(r.code);
          entry = { id: r.value.id, url: r.value.url, ...(slot !== undefined ? { owner: slot, ownerState: 'pending' as const } : {}) };
          state.pages[p.slug] = entry;
          await save(); // before the owner change: a crash after it is resumed as `pending`
        } else if (entry.ownerState !== 'pending' || entry.owner !== slot) {
          entry.owner = slot;
          entry.ownerState = 'pending';
          await save();
        }
        if (slot === undefined) continue;
        // Found and created pages alike: the page's current ownerId is read and only changed when it differs.
        const set = await deps.confluence.ensureOwner(entry.id, slot);
        entry.ownerState = set.ok ? 'done' : 'failed';
        if (!set.ok) console.warn('ripple demo: page owner change failed', { pageId: entry.id, error: `owner_http_${set.status}` });
        await save();
      }
      state.state = 'done';
      state.errorCode = null;
      const reply = await release();
      console.info('ripple demo: loaded', { spaces: Object.keys(state.spaces).length, pages: Object.keys(state.pages).length, owners: n, ownerErrors: ownerErrors(state) });
      return reply;
    } catch (err) {
      if (!(err instanceof DemoLeaseLost)) throw err;
      console.info('ripple demo: lease lost, stopped', { step: Object.keys(state.spaces).length + Object.keys(state.pages).length });
      return statusOf(await deps.repo.getDemoState(), true, null, true);
    }
  });
}

/**
 * "Remove demo data" (Jira administrators, same gate as the load): deletes only the demo spaces Ripple created, i.e.
 * recorded in the demo state with the same id AND carrying `DEMO_MARKER` in their description; any other space with a
 * demo key is left alone and reported in `keptSpaces`. First the Ripple data of the demo source goes (the
 * `unmarkSource` path), then the spaces (REST v1 DELETE as the caller, a background task in Confluence), then the
 * state is reset to `removed` (pages, spaces and owners empty) so the next load starts from scratch. Holds the load
 * lease meanwhile. Idempotent: a space already gone counts as removed; a failed step keeps what is left recorded and
 * pressing again continues. Logs counts and enums only.
 */
export async function removeDemoData(ctx: SettingsContext, deps: DemoDeps = defaultDemoDeps): Promise<DemoRemoveResult | ErrorReply> {
  return guard(ctx, deps, 'remove the demo data', async () => {
    const started = deps.now();
    const current = await deps.repo.getDemoState();
    const reply = (status: DemoStatus, errorCode: string | null, removedSpaces: string[] = [], keptSpaces: string[] = []): DemoRemoveResult => ({ status, removedSpaces, keptSpaces, errorCode });
    const admin = await deps.admin(ctx);
    if (admin !== 'admin') {
      const code = adminErrorCode(admin);
      return reply(statusOf(current, false, code), code);
    }
    const busy = (): DemoRemoveResult => reply(statusOf(current, true, null, true), 'demo_busy');
    if (current && current.lease !== '' && current.lockedUntil > started) return busy();

    const lease = deps.newLease();
    const state: DemoState = {
      ...(current ?? { state: 'removed', spaces: {}, pages: {}, ownerAccountIds: [], errorCode: null, rev: 0 }),
      lease,
      lockedUntil: started + DEMO_LEASE_MS,
      rev: (current?.rev ?? 0) + 1,
    };
    const taken = current ? await deps.repo.replaceDemoState(state, current.lease) : await deps.repo.createDemoState(state);
    if (!taken) return busy();
    const save = async (): Promise<void> => {
      state.rev += 1;
      if (!(await deps.repo.replaceDemoState(state, lease))) throw new DemoLeaseLost();
    };

    const removed: string[] = [];
    const kept: string[] = [];
    const deleted = new Set(state.deletedSpaceIds ?? []);
    let failure: string | null = null;
    try {
      const sourceId = state.pages[NIMBUS_SOURCE.slug]?.id;
      if (sourceId) await deps.removeSource(sourceId, ctx.accountId ?? null);
      for (const s of NIMBUS_SPACES) {
        const recorded = state.spaces[s.key];
        const found = await deps.confluence.findSpace(s.key);
        if (!found.ok) {
          failure = `space_find_http_${found.status}`;
          break;
        }
        const space = found.value;
        if (space && deleted.has(space.id)) continue; // asked before, Confluence is still deleting it
        if (space && !(recorded && recorded.id === space.id && space.description.includes(DEMO_MARKER))) {
          kept.push(s.key);
          continue;
        }
        if (space) {
          const r = await deps.confluence.deleteSpace(s.key);
          if (!r.ok) {
            failure = `space_delete_http_${r.status}`;
            break;
          }
          if (r.value === 'deleted') deleted.add(space.id);
          removed.push(s.key);
        }
        if (!recorded) continue;
        delete state.spaces[s.key];
        for (const p of NIMBUS_ALL_PAGES) if (p.space === s.key) delete state.pages[p.slug];
        state.deletedSpaceIds = [...deleted];
        await save();
      }
      if (failure) {
        state.state = 'failed';
        state.errorCode = failure;
        console.warn('ripple demo: remove step failed', { error: failure, removed: removed.length, kept: kept.length });
      } else {
        Object.assign(state, { state: 'removed', spaces: {}, pages: {}, ownerAccountIds: [], errorCode: null, deletedSpaceIds: [...deleted] });
        console.info('ripple demo: removed', { removed: removed.length, kept: kept.length });
      }
      state.lease = '';
      state.lockedUntil = 0;
      await save();
      return reply(statusOf(state, true), failure, removed, kept);
    } catch (err) {
      if (!(err instanceof DemoLeaseLost)) throw err;
      console.info('ripple demo: lease lost, remove stopped', { removed: removed.length });
      return reply(statusOf(await deps.repo.getDemoState(), true, null, true), 'demo_busy', removed, kept);
    }
  });
}
