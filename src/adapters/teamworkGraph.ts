import api, { route } from '@forge/api';

/**
 * Teamwork Graph reads (Preview, read-only) plus the Confluence REST v2 page fallback, ported from the Ripple
 * prototype. Queries go through `asUser().requestTeamworkGraph()`, so they only run from resolvers (not from queue
 * consumers or scheduled triggers). A missing scope or query context returns `data: null`, not an error, so every
 * read is logged with its raw edge count, null nodes and (scrubbed) GraphQL errors.
 */

// Operation names must be `<company>_<operation>`; `first` is at most 25.
const ownersQuery = (operation: string, selection: string): string => `query ${operation}($id: ID!) {
  confluencePageOwners(id: $id, first: 25) {
    edges { node { ${selection} } }
    pageInfo { hasNextPage endCursor }
  }
}`;

export interface OwnerVariant {
  key: 'A' | 'B' | 'C';
  operation: string;
  selection: string;
}

/**
 * The edge `node` is a GraphQL union, so fields only resolve inside an inline fragment, and a field that fails to
 * resolve can null the whole (non-null) node. The prototype compares three selections; order is the preference:
 *  A — Tripwire's proven `confluencePageContributors` selection; B — the smallest; C — A plus `name`.
 */
export const OWNER_VARIANTS: readonly OwnerVariant[] = [
  { key: 'A', operation: 'ripple_pageOwnersA', selection: '__typename ... on AtlassianUser { id accountId }' },
  { key: 'B', operation: 'ripple_pageOwnersB', selection: '__typename ... on AtlassianUser { id }' },
  { key: 'C', operation: 'ripple_pageOwnersC', selection: '__typename ... on AtlassianUser { id accountId name }' },
];

export const ownersQueryFor = (v: OwnerVariant): string => ownersQuery(v.operation, v.selection);

export const PAGE_CONTRIBUTORS_QUERY = `query ripple_pageContributors($id: ID!) {
  confluencePageContributors(id: $id, first: 25) {
    edges { node { __typename ... on AtlassianUser { id accountId } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Teams linked to a Confluence space (Team links → Add Confluence space). An unlinked space answers 0 edges. */
export const SPACE_TEAMS_QUERY = `query ripple_spaceTeams($spaceAri: ID!) {
  atlassianTeamsBySpace(spaceAri: $spaceAri, first: 25) {
    edges { node { __typename ... on AtlassianTeam { id displayName } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const pageAri = (cloudId: string, pageId: string): string => `ari:cloud:confluence:${cloudId}:page/${pageId}`;
export const spaceAri = (cloudId: string, spaceId: string): string => `ari:cloud:confluence:${cloudId}:space/${spaceId}`;
/** Value of the `X-Query-Context` header; without it the endpoint answers `data: null`. */
export const queryContext = (cloudId: string): string => `ari:cloud:platform::site/${cloudId}`;

const ERROR_TEXT_LIMIT = 200;
const MAX_LOGGED_ERRORS = 3;

/**
 * Error text safe for logs and UI: ARIs (which can carry account ids) and bare account ids are replaced before the
 * text is cut to `ERROR_TEXT_LIMIT` characters.
 */
export function scrubErrorText(text: string): string {
  return text
    .replace(/ari:cloud:[^\s'"`,)\]}]+/gi, '<ari>')
    .replace(/\b\d{5,7}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<accountId>')
    .replace(/\b[0-9a-f]{24}\b/gi, '<accountId>')
    .slice(0, ERROR_TEXT_LIMIT);
}

const errorText = (err: unknown): string => scrubErrorText(err instanceof Error ? err.message : String(err));

/** Diagnostics of one connection read. `dataPresent: false` means missing scope/context, not "no relations". */
export interface GraphMeta {
  rawCount: number;
  nullNodes: number;
  types: string[];
  dataPresent: boolean;
  hasNextPage: boolean;
  errors: string[];
}

type Node = Record<string, unknown>;

interface GraphBody {
  data?: Record<string, { edges?: ({ node?: Node | null } | null)[] | null; pageInfo?: { hasNextPage?: unknown } | null } | null> | null;
  errors?: { message?: unknown }[];
}

/** Nodes of `data.<field>.edges[].node` plus diagnostics; null nodes are counted, never silently dropped. */
export function parseConnection(raw: unknown, field: string): { nodes: Node[] } & GraphMeta {
  const body = (raw && typeof raw === 'object' ? raw : {}) as GraphBody;
  const all = Array.isArray(body.errors) ? body.errors : [];
  const errors = all.slice(0, MAX_LOGGED_ERRORS).map((e) => (typeof e?.message === 'string' ? scrubErrorText(e.message) : 'error without message'));
  const connection = body.data?.[field];
  const edges = Array.isArray(connection?.edges) ? connection.edges : [];
  const nodes = edges.map((e) => e?.node).filter((n): n is Node => !!n && typeof n === 'object');
  const types = [...new Set(nodes.map((n) => (typeof n.__typename === 'string' ? n.__typename : 'unknown')))];
  return {
    nodes,
    rawCount: edges.length,
    nullNodes: edges.length - nodes.length,
    types,
    dataPresent: !!connection,
    hasNextPage: connection?.pageInfo?.hasNextPage === true,
    errors,
  };
}

export interface GraphUser {
  accountId: string;
  name: string | null;
}

export interface Team {
  id: string;
  name: string;
}

/** accountId from an `AtlassianUser` node: `accountId`, or the tail of its `ari:cloud:identity::user/<id>` id. */
function accountIdOf(node: Node): string {
  if (typeof node.accountId === 'string' && node.accountId !== '') return node.accountId;
  return /user\/([^/]+)$/.exec(typeof node.id === 'string' ? node.id : '')?.[1] ?? '';
}

/** Users from `AtlassianUser` nodes, deduplicated by accountId; nodes without an id are dropped. */
function usersOf(nodes: Node[]): GraphUser[] {
  const seen = new Set<string>();
  const users: GraphUser[] = [];
  for (const n of nodes) {
    const accountId = accountIdOf(n);
    if (accountId === '' || seen.has(accountId)) continue;
    seen.add(accountId);
    users.push({ accountId, name: typeof n.name === 'string' && n.name !== '' ? n.name : null });
  }
  return users;
}

export function parseOwners(raw: unknown): { owners: GraphUser[] } & GraphMeta {
  const { nodes, ...meta } = parseConnection(raw, 'confluencePageOwners');
  return { owners: usersOf(nodes), ...meta };
}

export function parseContributors(raw: unknown): { contributors: GraphUser[] } & GraphMeta {
  const { nodes, ...meta } = parseConnection(raw, 'confluencePageContributors');
  return { contributors: usersOf(nodes), ...meta };
}

export function parseSpaceTeams(raw: unknown): { teams: Team[] } & GraphMeta {
  const { nodes, ...meta } = parseConnection(raw, 'atlassianTeamsBySpace');
  const teams = nodes
    .filter((n) => typeof n.id === 'string' && n.id !== '')
    .map((n) => ({ id: String(n.id), name: typeof n.displayName === 'string' && n.displayName !== '' ? n.displayName.slice(0, 120) : 'Unnamed team' }));
  return { teams, ...meta };
}

/** Diagnostics used when the request itself failed (no body to parse). */
const failedMeta = (message: string): GraphMeta => ({ rawCount: 0, nullNodes: 0, types: [], dataPresent: false, hasNextPage: false, errors: [message] });

/** One graph request: the parsed JSON body, or the exact failure reason. Never throws. */
export type GraphRequest = (query: string, variables: Record<string, unknown>, operation: string) => Promise<{ body: unknown } | { failure: string }>;

/** `requestTeamworkGraph` as the current user with the site query context. Resolver only. */
export function asUserGraph(cloudId: string): GraphRequest {
  return async (query, variables, operation) => {
    try {
      const res = await api.asUser().requestTeamworkGraph(query, variables, operation, undefined, { 'X-Query-Context': queryContext(cloudId) });
      const text = await res.text();
      if (!res.ok) return { failure: `HTTP ${res.status}: ${scrubErrorText(text)}` };
      try {
        return { body: JSON.parse(text) as unknown };
      } catch {
        return { failure: `non-JSON response: ${scrubErrorText(text)}` };
      }
    } catch (err) {
      return { failure: `threw: ${errorText(err)}` };
    }
  };
}

/** One structured line per read; counts, page/space ids and scrubbed errors only (no names, account ids or content). */
function logRead(op: string, fields: Record<string, unknown>, meta: GraphMeta, count: number): void {
  console.info('ripple twg', {
    op,
    ...fields,
    count,
    rawCount: meta.rawCount,
    nullNodes: meta.nullNodes,
    types: meta.types,
    dataPresent: meta.dataPresent,
    errors: meta.errors,
  });
}

export type OwnersRead = { key: OwnerVariant['key']; owners: GraphUser[] } & GraphMeta;

/** Runs every owner variant one after another (a per-user rate limit cannot skew the comparison). */
export async function readPageOwners(request: GraphRequest, cloudId: string, pageId: string): Promise<OwnersRead[]> {
  const results: OwnersRead[] = [];
  for (const v of OWNER_VARIANTS) {
    const r = await request(ownersQueryFor(v), { id: pageAri(cloudId, pageId) }, v.operation);
    const read: OwnersRead = 'failure' in r ? { key: v.key, owners: [], ...failedMeta(r.failure) } : { key: v.key, ...parseOwners(r.body) };
    logRead(v.operation, { pageId }, read, read.owners.length);
    results.push(read);
  }
  return results;
}

export async function readContributors(request: GraphRequest, cloudId: string, pageId: string): Promise<{ contributors: GraphUser[] } & GraphMeta> {
  const r = await request(PAGE_CONTRIBUTORS_QUERY, { id: pageAri(cloudId, pageId) }, 'ripple_pageContributors');
  const read = 'failure' in r ? { contributors: [], ...failedMeta(r.failure) } : parseContributors(r.body);
  logRead('ripple_pageContributors', { pageId }, read, read.contributors.length);
  return read;
}

export async function readSpaceTeams(request: GraphRequest, cloudId: string, spaceId: string): Promise<{ teams: Team[] } & GraphMeta> {
  const r = await request(SPACE_TEAMS_QUERY, { spaceAri: spaceAri(cloudId, spaceId) }, 'ripple_spaceTeams');
  const read = 'failure' in r ? { teams: [], ...failedMeta(r.failure) } : parseSpaceTeams(r.body);
  logRead('ripple_spaceTeams', { spaceId }, read, read.teams.length);
  return read;
}

/**
 * Picks the owner variant to use: most owners wins; ties keep the order of OWNER_VARIANTS, except that a variant
 * carrying names beats one that does not. Null when no variant returned owners.
 */
export function pickBest<T extends { owners: GraphUser[] }>(results: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of results) {
    if (r.owners.length === 0) continue;
    const named = r.owners.some((o) => o.name);
    const bestNamed = best ? best.owners.some((o) => o.name) : false;
    if (!best || r.owners.length > best.owners.length || (r.owners.length === best.owners.length && named && !bestNamed)) best = r;
  }
  return best;
}

/** The REST v2 page fields Ripple routes on. */
export interface PageMeta {
  spaceId?: string;
  ownerId?: string;
  authorId?: string;
}

/** Page metadata from Confluence REST v2 as the current user. Throws with the HTTP status on failure. */
export async function fetchPageMeta(pageId: string): Promise<PageMeta> {
  const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Confluence REST v2 page ${pageId} failed: HTTP ${res.status}`);
  const page = (await res.json()) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : v === undefined || v === null ? undefined : String(v));
  return { spaceId: str(page.spaceId), ownerId: str(page.ownerId), authorId: str(page.authorId) };
}

/** Owner then author of a REST v2 page (the routing fallback when the graph gives no owners). */
export function ownersFromPage(page: PageMeta): { accountId: string; role: 'owner' | 'author' }[] {
  const ids = [...new Set([page.ownerId, page.authorId].filter((x): x is string => typeof x === 'string' && x !== ''))];
  return ids.map((accountId) => ({ accountId, role: accountId === page.ownerId ? 'owner' : 'author' }));
}
