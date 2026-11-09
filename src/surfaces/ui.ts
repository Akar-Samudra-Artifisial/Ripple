import Resolver from '@forge/resolver';
import { ensureSchema } from '../adapters/sql';
import { displayNames } from '../adapters/confluenceUsers';
import { noSpaceTeamCache, spaceTeamsLookup, sqlSpaceTeamCache, type SpaceTeamCache } from '../adapters/spaceTeams';
import { asUserGraph, fetchPageMeta, ownersFromPage, scrubErrorText, siteOf, type GraphRequest, type PageMeta } from '../adapters/teamworkGraph';
import { LATEST_MIGRATION, MIGRATIONS } from '../core/migrations';
import { SchemaMigrationFailedError, SchemaSettingUpError } from '../core/schema';
import { confirmChange, dismissChange, getLatestChange, getPendingChange, healSource, pendingChangeFlag, type ChangeContext } from './changes';
import { getScanStatus, listCopies, startScan } from './copies';
import { approveAll, approveProposal, listProposalsForPage, listRollout, markNotSameFact, pendingProposalCount, rejectProposal } from './proposals';
import type { ApproveProposalPayload, ChangeIdOnlyPayload, ProposalIdPayload } from '../core/views';
import type { BylineStatus, ChangeIdPayload, ConfirmChangePayload, CopyListPayload, PendingChangeFlag, FactEditPayload, FactIdPayload, OwnerView, SchemaView, SpaceTeamsView } from '../core/views';
import { confirmFact, editFact, getSourceStatus, listFacts, markSource, rejectFact, unmarkSource, type SourceContext } from './sources';
import { getApproval, getSettings, saveSettings, type ApprovalContext, type SettingsContext } from './changeIssues';
import type { LoadDemoPayload, SaveSettingsPayload } from '../core/views';
import { getDemoStatus, loadDemoData } from './demo';

export type ResolverContext = {
  accountId?: string;
  cloudId?: string;
  /** `ari:cloud:<product>::site/<cloudId>`; the site id when `cloudId` is missing. */
  installContext?: string;
  moduleKey?: string;
  extension?: { content?: { id?: string | number }; space?: { id?: string | number } };
};

const errorText = (err: unknown): string => scrubErrorText(err instanceof Error ? err.message : String(err));

/** Schema progress without DDL; a pending schema queues a migration run (throttled by `ensureSchema`). */
export async function schemaView(ensure: () => Promise<void> = ensureSchema): Promise<SchemaView> {
  const total = MIGRATIONS.length;
  try {
    await ensure();
    return { status: 'ready', applied: total, total, latest: LATEST_MIGRATION };
  } catch (err) {
    if (err instanceof SchemaMigrationFailedError) return { status: 'error', applied: err.applied, total: err.total, latest: LATEST_MIGRATION, error: err.message };
    if (err instanceof SchemaSettingUpError) return { status: 'setting_up', applied: err.applied, total: err.total, latest: LATEST_MIGRATION };
    console.warn('ripple byline: schema check failed', { error: errorText(err) });
    return { status: 'error', applied: 0, total, latest: LATEST_MIGRATION, error: errorText(err) };
  }
}

export interface BylineDeps {
  graph: (cloudId: string) => GraphRequest;
  pageMeta: (pageId: string) => Promise<PageMeta>;
  names: (accountIds: readonly string[]) => Promise<Map<string, string>>;
  /** M3 pending change of the page; must not throw (null on failure). */
  pendingChange: (pageId: string) => Promise<PendingChangeFlag | null>;
  /** M4 proposals waiting on the page; must not throw (0 on failure). Absent = 0. */
  pendingProposals?: (pageId: string) => Promise<number>;
  /** Re-queues lost jobs of a source page (see `healSource`); must not throw. Absent = no heal. */
  heal?: (pageId: string, currentVersion: number | null) => Promise<unknown>;
  /** Last good space-teams answers (Forge SQL). Absent = no cache. */
  teamCache?: SpaceTeamCache;
  ensure: () => Promise<void>;
}

const defaultDeps: BylineDeps = {
  graph: asUserGraph,
  pageMeta: fetchPageMeta,
  names: (ids) => displayNames(ids),
  pendingChange: (id) => pendingChangeFlag(id),
  pendingProposals: (id) => pendingProposalCount(id),
  heal: (id, version) => healSource(id, version),
  teamCache: sqlSpaceTeamCache,
  ensure: ensureSchema,
};

/** Space id from the byline context, or from the REST v2 page when the context has none. */
async function spaceIdOf(ctx: ResolverContext, page: () => Promise<PageMeta>): Promise<string> {
  const fromContext = ctx.extension?.space?.id;
  if (fromContext !== undefined && String(fromContext) !== '') return String(fromContext);
  const spaceId = (await page()).spaceId;
  if (!spaceId) throw new Error('page has no space id');
  return spaceId;
}

/** Owner (else author) of the page from REST v2, with its display name from users-bulk. Never throws. */
async function ownerOf(page: () => Promise<PageMeta>, deps: BylineDeps): Promise<OwnerView> {
  let first;
  try {
    first = ownersFromPage(await page())[0];
  } catch (err) {
    return { accountId: null, role: null, displayName: null, errors: [errorText(err)] };
  }
  if (!first) return { accountId: null, role: null, displayName: null, errors: ['page has no owner or author'] };
  try {
    const names = await deps.names([first.accountId]);
    return { accountId: first.accountId, role: first.role, displayName: names.get(first.accountId) ?? null, errors: [] };
  } catch (err) {
    console.warn('ripple byline: owner name lookup failed', { error: errorText(err) });
    return { accountId: first.accountId, role: first.role, displayName: null, errors: [errorText(err)] };
  }
}

/** Headline of the byline popup; "ready" only when the database schema is complete. */
export function bylineMessage(schema: SchemaView): string {
  if (schema.status === 'ready') return 'Ripple is ready';
  if (schema.status === 'setting_up') return 'Ripple is setting up';
  return 'Ripple is unavailable: database check failed';
}

/** M0 byline: readiness, schema progress and the space's owning teams via Teamwork Graph. Never throws. */
export async function bylineStatus(ctx: ResolverContext, deps: BylineDeps = defaultDeps): Promise<BylineStatus> {
  const schema = await schemaView(deps.ensure);
  // REST v2 page, fetched at most once (owner and, when the context lacks it, the space id).
  const pageId = ctx.extension?.content?.id;
  let pagePromise: Promise<PageMeta> | undefined;
  const page = (): Promise<PageMeta> =>
    (pagePromise ??= pageId === undefined || String(pageId) === '' ? Promise.reject(new Error('no page id in context')) : deps.pageMeta(String(pageId)));
  const owner = await ownerOf(page, deps);
  let spaceTeams: SpaceTeamsView;
  const site = siteOf(ctx);
  if (!site) {
    spaceTeams = { spaceId: null, teams: [], dataPresent: false, errors: ['no cloud id in context'] };
  } else {
    try {
      // Only the space of the viewed page (from its context or the page read as the viewer).
      const spaceId = await spaceIdOf(ctx, page);
      const lookup = spaceTeamsLookup({ request: deps.graph(site.cloudId), cache: deps.teamCache ?? noSpaceTeamCache, cloudId: site.cloudId, cloudIdSource: site.source });
      const r = await lookup(spaceId);
      spaceTeams = { spaceId, teams: r.teams, dataPresent: r.dataPresent, errors: r.errors, ...(r.origin === 'stale' ? { stale: true } : {}) };
    } catch (err) {
      spaceTeams = { spaceId: null, teams: [], dataPresent: false, errors: [errorText(err)] };
    }
  }
  const onPage = schema.status === 'ready' && pageId !== undefined && String(pageId) !== '';
  const pendingChange = onPage ? await deps.pendingChange(String(pageId)) : null;
  const pendingProposals = onPage && deps.pendingProposals ? await deps.pendingProposals(String(pageId)) : 0;
  if (onPage && deps.heal) {
    const version = await page().then(
      (p) => p.version ?? null,
      () => null,
    );
    await deps.heal(String(pageId), version);
  }
  return { message: bylineMessage(schema), schema, owner, spaceTeams, pendingChange, pendingProposals };
}

const resolver = new Resolver();

resolver.define('getBylineStatus', ({ context }) => bylineStatus(context as ResolverContext));
// M1 (FR-1..3); contract in src/core/views.ts `ResolverContract`.
resolver.define('getSourceStatus', ({ context }) => getSourceStatus(context as SourceContext));
resolver.define('markSource', ({ context }) => markSource(context as SourceContext));
resolver.define('unmarkSource', ({ context }) => unmarkSource(context as SourceContext));
resolver.define('listFacts', ({ context }) => listFacts(context as SourceContext));
resolver.define('confirmFact', ({ context, payload }) => confirmFact(context as SourceContext, payload as Partial<FactIdPayload>));
resolver.define('rejectFact', ({ context, payload }) => rejectFact(context as SourceContext, payload as Partial<FactIdPayload>));
resolver.define('editFact', ({ context, payload }) => editFact(context as SourceContext, payload as Partial<FactEditPayload>));
// M2 (FR-4..6).
resolver.define('getScanStatus', ({ context }) => getScanStatus(context as SourceContext));
resolver.define('startScan', ({ context }) => startScan(context as SourceContext));
resolver.define('listCopies', ({ context, payload }) => listCopies(context as SourceContext, payload as Partial<CopyListPayload>));
// M3 (FR-7).
resolver.define('getPendingChange', ({ context }) => getPendingChange(context as ChangeContext));
resolver.define('getLatestChange', ({ context }) => getLatestChange(context as ChangeContext));
resolver.define('confirmChange', ({ context, payload }) => confirmChange(context as ChangeContext, payload as Partial<ConfirmChangePayload>));
resolver.define('dismissChange', ({ context, payload }) => dismissChange(context as ChangeContext, payload as Partial<ChangeIdPayload>));
// M4 (FR-8): copy-page proposals; `listRollout` on the source page.
resolver.define('listProposalsForPage', ({ context }) => listProposalsForPage(context as SourceContext));
resolver.define('approveProposal', ({ context, payload }) => approveProposal(context as SourceContext, payload as Partial<ApproveProposalPayload>));
resolver.define('rejectProposal', ({ context, payload }) => rejectProposal(context as SourceContext, payload as Partial<ProposalIdPayload>));
resolver.define('markNotSameFact', ({ context, payload }) => markNotSameFact(context as SourceContext, payload as Partial<ProposalIdPayload>));
resolver.define('approveAll', ({ context }) => approveAll(context as SourceContext));
resolver.define('listRollout', ({ context, payload }) => listRollout(context as SourceContext, payload as Partial<ChangeIdOnlyPayload>));
// M5: Jira project for update tasks (Confluence global settings) and the read-only Jira issue panel.
resolver.define('getSettings', ({ context }) => getSettings(context as SettingsContext));
resolver.define('saveSettings', ({ context, payload }) => saveSettings(context as SettingsContext, payload as Partial<SaveSettingsPayload>));
resolver.define('getApproval', ({ context }) => getApproval(context as ApprovalContext));
// M6: "Load demo data" on the settings page (Jira administrators).
resolver.define('getDemoStatus', ({ context }) => getDemoStatus(context as SettingsContext));
resolver.define('loadDemoData', ({ context, payload }) => loadDemoData(context as SettingsContext, payload as Partial<LoadDemoPayload>));

export const handler = resolver.getDefinitions();
