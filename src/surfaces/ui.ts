import Resolver from '@forge/resolver';
import { ensureSchema } from '../adapters/sql';
import { asUserGraph, fetchPageMeta, readSpaceTeams, scrubErrorText, type GraphRequest, type PageMeta } from '../adapters/teamworkGraph';
import { LATEST_MIGRATION, MIGRATIONS } from '../core/migrations';
import { SchemaSettingUpError } from '../core/schema';
import type { BylineStatus, SchemaView, SpaceTeamsView } from '../core/views';
import { notImplemented } from './stub';

export type ResolverContext = {
  accountId?: string;
  cloudId?: string;
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
    if (err instanceof SchemaSettingUpError) return { status: 'setting_up', applied: err.applied, total: err.total, latest: LATEST_MIGRATION };
    console.warn('ripple byline: schema check failed', { error: errorText(err) });
    return { status: 'error', applied: 0, total, latest: LATEST_MIGRATION, error: errorText(err) };
  }
}

export interface BylineDeps {
  graph: (cloudId: string) => GraphRequest;
  pageMeta: (pageId: string) => Promise<PageMeta>;
  ensure: () => Promise<void>;
}

const defaultDeps: BylineDeps = { graph: asUserGraph, pageMeta: fetchPageMeta, ensure: ensureSchema };

/** Space id from the byline context, or from REST v2 when the context has none. */
async function spaceIdOf(ctx: ResolverContext, deps: BylineDeps): Promise<string> {
  const fromContext = ctx.extension?.space?.id;
  if (fromContext !== undefined && String(fromContext) !== '') return String(fromContext);
  const pageId = ctx.extension?.content?.id;
  if (pageId === undefined || String(pageId) === '') throw new Error('no page id in context');
  const spaceId = (await deps.pageMeta(String(pageId))).spaceId;
  if (!spaceId) throw new Error('page has no space id');
  return spaceId;
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
  let spaceTeams: SpaceTeamsView;
  if (!ctx.cloudId) {
    spaceTeams = { spaceId: null, teams: [], dataPresent: false, errors: ['no cloud id in context'] };
  } else {
    try {
      const spaceId = await spaceIdOf(ctx, deps);
      const read = await readSpaceTeams(deps.graph(ctx.cloudId), ctx.cloudId, spaceId);
      spaceTeams = { spaceId, teams: read.teams, dataPresent: read.dataPresent, errors: read.errors };
    } catch (err) {
      spaceTeams = { spaceId: null, teams: [], dataPresent: false, errors: [errorText(err)] };
    }
  }
  return { message: bylineMessage(schema), schema, spaceTeams };
}

const resolver = new Resolver();

resolver.define('getBylineStatus', ({ context }) => bylineStatus(context as ResolverContext));
resolver.define('getSettings', () => notImplemented('settings'));
resolver.define('getApproval', () => notImplemented('approval panel'));

export const handler = resolver.getDefinitions();
