/**
 * Space teams with a per-space cache in Forge SQL and a per-invocation memo. Teamwork Graph intermittently refuses a
 * read ("User is not permitted to query this organization"), so the last good answer of a space is kept: fresh for
 * `SPACE_TEAMS_FRESH_SECONDS`, and served (marked `stale`) for up to `SPACE_TEAMS_STALE_SECONDS` when the graph
 * fails. Only complete, non-empty answers are stored: never errors, never "no teams" (it may only reflect the
 * caller's limited graph access) and never a list with more pages.
 *
 * The cache is shared by every user of the installation. Callers only ask for spaces of pages the viewer can see
 * (byline: the viewed page; change panel: copies filtered by `visible`), so a cached name is never shown for a space
 * the viewer has no page in.
 */
import { query, execute } from './sql';
import { readSpaceTeams, scrubErrorText, type CloudIdSource, type GraphRequest, type ReadSpaceTeamsOptions, type SpaceTeamsRead, type Team } from './teamworkGraph';

export const SPACE_TEAMS_FRESH_SECONDS = 10 * 60;
export const SPACE_TEAMS_STALE_SECONDS = 24 * 3600;

export interface CachedTeams {
  teams: Team[];
  ageSeconds: number;
}

export interface SpaceTeamCache {
  get(spaceId: string): Promise<CachedTeams | undefined>;
  put(spaceId: string, teams: readonly Team[]): Promise<void>;
}

/** Teams from a stored row; anything malformed is dropped (an empty list stays empty). */
function teamsFromJson(raw: unknown): Team[] | undefined {
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((t): t is { id: string; name: string } => !!t && typeof t === 'object' && typeof (t as Team).id === 'string' && typeof (t as Team).name === 'string')
    .map((t) => ({ id: t.id, name: t.name }));
}

export const sqlSpaceTeamCache: SpaceTeamCache = {
  async get(spaceId) {
    const rows = await query<{ teams_json: unknown; age_seconds: unknown }>(
      'SELECT teams_json, TIMESTAMPDIFF(SECOND, fetched_at, CURRENT_TIMESTAMP) AS age_seconds FROM space_team_cache WHERE space_id = ?',
      spaceId,
    );
    const row = rows[0];
    if (!row) return undefined;
    const teams = teamsFromJson(row.teams_json);
    const ageSeconds = Number(row.age_seconds);
    return teams && Number.isFinite(ageSeconds) ? { teams, ageSeconds: Math.max(0, ageSeconds) } : undefined;
  },
  async put(spaceId, teams) {
    await execute(
      'INSERT INTO space_team_cache (space_id, teams_json, fetched_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE teams_json = VALUES(teams_json), fetched_at = CURRENT_TIMESTAMP',
      spaceId,
      JSON.stringify(teams.map((t) => ({ id: t.id, name: t.name }))),
    );
  },
};

/** No cache (tests and callers without SQL). */
export const noSpaceTeamCache: SpaceTeamCache = { get: async () => undefined, put: async () => undefined };

/**
 * `live`: read from the graph now; `cached`: fresh cache entry; `stale`: the graph failed and an older entry (≤24 h)
 * stands in; `unknown`: no data at all (the only state shown as "Team unavailable").
 */
export type SpaceTeamsOrigin = 'live' | 'cached' | 'stale' | 'unknown';

export interface SpaceTeamsResult {
  teams: Team[];
  origin: SpaceTeamsOrigin;
  dataPresent: boolean;
  /** Scrubbed graph errors; empty unless `origin` is `unknown`. */
  errors: string[];
}

export interface SpaceTeamsDeps {
  request: GraphRequest;
  cache: SpaceTeamCache;
  cloudId: string;
  cloudIdSource: CloudIdSource;
  read?: typeof readSpaceTeams;
  readOptions?: Omit<ReadSpaceTeamsOptions, 'cloudIdSource'>;
}

const errorText = (err: unknown): string => scrubErrorText(err instanceof Error ? err.message : String(err));

/**
 * Space-teams lookup for one resolver invocation: each space is resolved once (calls for the same space share one
 * promise). Never rejects; a cache failure only skips the cache.
 */
export function spaceTeamsLookup(deps: SpaceTeamsDeps): (spaceId: string) => Promise<SpaceTeamsResult> {
  const memo = new Map<string, Promise<SpaceTeamsResult>>();
  const read = deps.read ?? readSpaceTeams;
  const resolve = async (spaceId: string): Promise<SpaceTeamsResult> => {
    let cached: CachedTeams | undefined;
    try {
      cached = await deps.cache.get(spaceId);
    } catch (err) {
      console.warn('ripple space teams: cache read failed', { spaceId, error: errorText(err) });
    }
    if (cached && cached.ageSeconds < SPACE_TEAMS_FRESH_SECONDS) return { teams: cached.teams, origin: 'cached', dataPresent: true, errors: [] };
    let live: SpaceTeamsRead;
    try {
      live = await read(deps.request, deps.cloudId, spaceId, { ...deps.readOptions, cloudIdSource: deps.cloudIdSource });
    } catch (err) {
      live = { teams: [], rawCount: 0, nullNodes: 0, types: [], dataPresent: false, hasNextPage: false, errors: [errorText(err)], errorClass: 'gql_other', attempts: 0 };
    }
    if (live.errorClass === null) {
      // Shared cache: only a complete, non-empty answer is stored. An empty one may only mean this user's graph
      // access is limited, and a partial page (`hasNextPage`) is not the space's full list.
      if (live.teams.length > 0 && !live.hasNextPage) {
        try {
          await deps.cache.put(spaceId, live.teams);
        } catch (err) {
          console.warn('ripple space teams: cache write failed', { spaceId, error: errorText(err) });
        }
      }
      return { teams: live.teams, origin: 'live', dataPresent: true, errors: [] };
    }
    if (cached && cached.ageSeconds <= SPACE_TEAMS_STALE_SECONDS) {
      console.info('ripple space teams: stale cache used', { spaceId, ageSeconds: cached.ageSeconds, errorClass: live.errorClass });
      return { teams: cached.teams, origin: 'stale', dataPresent: true, errors: [] };
    }
    return { teams: [], origin: 'unknown', dataPresent: false, errors: live.errors.length > 0 ? live.errors : ['Teamwork Graph returned no data'] };
  };
  return (spaceId) => {
    let p = memo.get(spaceId);
    if (!p) {
      p = resolve(spaceId);
      memo.set(spaceId, p);
    }
    return p;
  };
}
