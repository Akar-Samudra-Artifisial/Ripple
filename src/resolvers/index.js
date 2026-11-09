import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

/*
 * Ripple prototype resolver.
 *
 * Reads the owners of the Confluence page that is open, first from the Teamwork Graph (Preview, read-only) curated
 * query `confluencePageOwners`, then, when the graph returns nothing, from Confluence REST v2 as a fallback.
 * The query shape, ARIs and the `X-Query-Context` header follow the Tripwire adapter that already works on
 * one-atlas-vyyd (Tripwire/tripwire/src/adapters/teamworkGraph.ts).
 *
 * Diagnostic mode: one click runs three variants of the owners query, because the first real test returned
 * `rawCount: 1` with the error "field at path '/confluencePageOwners/edges[0]/node' was declared as a non null
 * type, but ... returned a null value". The edge `node` is a GraphQL union (see the curated-queries docs), so
 * fields are only selectable inside an inline fragment; a field that fails to resolve inside the fragment can
 * null the whole (non-null) node. Comparing the variants shows which selection is safe.
 */

// Operation names must be `<company>_<operation>`; `first` is at most 25.
const ownersQuery = (operation, selection) => `query ${operation}($id: ID!) {
  confluencePageOwners(id: $id, first: 25) {
    edges { node { ${selection} } }
    pageInfo { hasNextPage endCursor }
  }
}`;

/**
 * Variants, in order of preference when several return owners:
 *  A — exactly what Tripwire selects on `confluencePageContributors` (proven on this site).
 *  B — the smallest selection: the union type name plus the user id (`id` must sit inside the fragment,
 *      a union has no fields of its own besides `__typename`).
 *  C — A plus `name` (the display-name field documented on the AtlassianUser object type).
 */
export const OWNER_VARIANTS = [
  { key: 'A', operation: 'ripple_pageOwnersA', selection: '__typename ... on AtlassianUser { id accountId }' },
  { key: 'B', operation: 'ripple_pageOwnersB', selection: '__typename ... on AtlassianUser { id }' },
  { key: 'C', operation: 'ripple_pageOwnersC', selection: '__typename ... on AtlassianUser { id accountId name }' },
];

export const pageAri = (cloudId, pageId) => `ari:cloud:confluence:${cloudId}:page/${pageId}`;
// Without this header the endpoint answers `data: null`.
export const queryContext = (cloudId) => `ari:cloud:platform::site/${cloudId}`;

const errorText = (err) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

// One JSON line per call so `forge logs` can be grepped; ids and counts only, no page content.
const log = (fields) => console.log(JSON.stringify({ app: 'ripple', ...fields }));

/** accountId from an `AtlassianUser` node: `accountId`, or the tail of its `ari:cloud:identity::user/<id>` id. */
const accountIdOf = (node) =>
  typeof node.accountId === 'string' && node.accountId !== '' ? node.accountId : (/user\/([^/]+)$/.exec(String(node.id ?? ''))?.[1] ?? '');

/**
 * Generic reader for a curated-query connection (`data.<field>.edges[].node`). `data` null (missing scope /
 * query context), an empty edge list and edges whose node came back null all yield no nodes, but stay
 * distinguishable via `dataPresent`, `rawCount` and `nullNodes`. `types` lists the union members received.
 */
export function parseConnection(body, field) {
  const errors = Array.isArray(body?.errors) ? body.errors.map((e) => String(e?.message ?? e).slice(0, 300)) : [];
  const connection = body?.data?.[field];
  const edges = Array.isArray(connection?.edges) ? connection.edges : [];
  const nodes = edges.map((e) => e?.node).filter((n) => n && typeof n === 'object');
  const types = [...new Set(nodes.map((n) => n.__typename ?? 'unknown'))];
  const hasNextPage = connection?.pageInfo?.hasNextPage === true;
  return { nodes, rawCount: edges.length, nullNodes: edges.length - nodes.length, types, dataPresent: !!connection, hasNextPage, errors };
}

/** Users (accountId + optional name) from `AtlassianUser` nodes; nodes without an id are dropped. */
const usersOf = (nodes) =>
  nodes
    .map((n) => ({ accountId: accountIdOf(n), name: typeof n.name === 'string' && n.name !== '' ? n.name : null, type: n.__typename ?? null }))
    .filter((o) => o.accountId !== '');

/** Owners plus diagnostics from a `confluencePageOwners` response. */
export function parseOwners(body) {
  const { nodes, ...rest } = parseConnection(body, 'confluencePageOwners');
  return { owners: usersOf(nodes), ...rest };
}

/** Contributors plus diagnostics from a `confluencePageContributors` response, deduplicated by accountId. */
export function parseContributors(body) {
  const { nodes, ...rest } = parseConnection(body, 'confluencePageContributors');
  const seen = new Set();
  const contributors = usersOf(nodes).filter((u) => (seen.has(u.accountId) ? false : seen.add(u.accountId)));
  return { contributors, ...rest };
}

/** Teams plus diagnostics from an `atlassianTeamsBySpace` response. */
export function parseSpaceTeams(body) {
  const { nodes, ...rest } = parseConnection(body, 'atlassianTeamsBySpace');
  const teams = nodes
    .filter((n) => typeof n.id === 'string' && n.id !== '')
    .map((n) => ({ id: n.id, name: typeof n.displayName === 'string' && n.displayName !== '' ? n.displayName.slice(0, 120) : 'Unnamed team' }));
  return { teams, ...rest };
}

/** Diagnostics shape used when the request itself failed (no body to parse). */
const failed = (message) => ({ nodes: [], rawCount: 0, nullNodes: 0, types: [], dataPresent: false, hasNextPage: false, errors: [message] });

/**
 * Sends one curated query as the current user with the site query context and returns the parsed JSON body,
 * or `{ failure }` with the exact reason (HTTP status + body snippet, non-JSON, or thrown error). Never throws.
 */
async function requestGraph(cloudId, query, variables, operation) {
  try {
    const res = await api.asUser().requestTeamworkGraph(query, variables, operation, undefined, { 'X-Query-Context': queryContext(cloudId) });
    const text = await res.text();
    if (!res.ok) return { failure: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    try {
      return { body: JSON.parse(text) };
    } catch {
      return { failure: `non-JSON response: ${text.slice(0, 200)}` };
    }
  } catch (err) {
    return { failure: `threw: ${errorText(err)}` };
  }
}

/** Runs one owners variant; never throws (failures become `errors`). */
async function runVariant(variant, cloudId, pageId) {
  const r = await requestGraph(cloudId, ownersQuery(variant.operation, variant.selection), { id: pageAri(cloudId, pageId) }, variant.operation);
  if (r.failure) {
    const { nodes, ...rest } = failed(r.failure);
    return { owners: nodes, ...rest };
  }
  return parseOwners(r.body);
}

// Same selection as Tripwire's PAGE_CONTRIBUTORS_QUERY (proven on this site). Tripwire reads no edge metadata
// (no contribution count / last-updated), so "main contributor" here is simply the first edge returned.
export const PAGE_CONTRIBUTORS_QUERY = `query ripple_pageContributors($id: ID!) {
  confluencePageContributors(id: $id, first: 25) {
    edges { node { __typename ... on AtlassianUser { id accountId } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Node selection follows Tripwire's USER_TEAMS_QUERY (`... on AtlassianTeam { id displayName }`).
export const SPACE_TEAMS_QUERY = `query ripple_spaceTeams($spaceAri: ID!) {
  atlassianTeamsBySpace(spaceAri: $spaceAri, first: 25) {
    edges { node { __typename ... on AtlassianTeam { id displayName } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Confluence space ARI, same resource-owner/site shape as the page ARI above.
export const spaceAri = (cloudId, spaceId) => `ari:cloud:confluence:${cloudId}:space/${spaceId}`;

async function contributorsFromGraph(cloudId, pageId) {
  const r = await requestGraph(cloudId, PAGE_CONTRIBUTORS_QUERY, { id: pageAri(cloudId, pageId) }, 'ripple_pageContributors');
  if (r.failure) {
    const { nodes, ...rest } = failed(r.failure);
    return { contributors: nodes, ...rest };
  }
  return parseContributors(r.body);
}

async function spaceTeamsFromGraph(cloudId, spaceId) {
  const r = await requestGraph(cloudId, SPACE_TEAMS_QUERY, { spaceAri: spaceAri(cloudId, spaceId) }, 'ripple_spaceTeams');
  if (r.failure) {
    const { nodes, ...rest } = failed(r.failure);
    return { teams: nodes, ...rest };
  }
  return parseSpaceTeams(r.body);
}

/**
 * Picks the variant to use for the owner list: most owners wins; ties keep the order of OWNER_VARIANTS, except
 * that a variant that also carries names is preferred over one that does not.
 */
export function pickBest(results) {
  let best = null;
  for (const r of results) {
    if (r.owners.length === 0) continue;
    const named = r.owners.some((o) => o.name);
    const bestNamed = best ? best.owners.some((o) => o.name) : false;
    if (!best || r.owners.length > best.owners.length || (r.owners.length === best.owners.length && named && !bestNamed)) best = r;
  }
  return best;
}

/**
 * Page metadata from Confluence REST v2 as the current user (`ownerId`, `authorId`, `spaceId`). Fetched lazily
 * and at most once per click: it is only needed for the owner fallback and when the context has no space id.
 */
async function fetchPage(pageId) {
  const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Confluence REST v2 page ${pageId} failed: HTTP ${res.status}`);
  return res.json();
}

/** Owner (and author) account ids of a REST v2 page, used when the graph gave no owners. */
function ownersFromPage(page) {
  const ids = [...new Set([page.ownerId, page.authorId].filter((x) => typeof x === 'string' && x !== ''))];
  return ids.map((accountId) => ({ accountId, name: null, role: accountId === page.ownerId ? 'owner' : 'author' }));
}

const resolver = new Resolver();

resolver.define('getPageOwners', async (req) => {
  const pageId = String(req.context?.extension?.content?.id ?? '');
  const cloudId = req.context?.cloudId;
  if (!pageId || !cloudId) {
    log({ op: 'getPageOwners', pageId, cloudId: !!cloudId, error: 'missing page or cloud id in context' });
    return { source: 'none', owners: [], variants: [], errors: ['missing page or cloud id in context'] };
  }

  // The variants run one after another (not in parallel) so a per-user rate limit cannot skew the comparison.
  const variants = [];
  for (const v of OWNER_VARIANTS) {
    const r = { key: v.key, selection: v.selection, ...(await runVariant(v, cloudId, pageId)) };
    log({
      op: 'confluencePageOwners',
      variant: v.key,
      pageId,
      owners: r.owners.length,
      rawCount: r.rawCount,
      nullNodes: r.nullNodes,
      types: r.types,
      dataPresent: r.dataPresent,
      errors: r.errors,
    });
    variants.push(r);
  }

  // REST v2 page, fetched at most once and only when needed (space id missing from context, or owner fallback).
  let pagePromise;
  const page = () => (pagePromise ??= fetchPage(pageId));

  // Contributors of the page (Tripwire's proven selection). The first edge is shown as "main contributor".
  const contributors = await contributorsFromGraph(cloudId, pageId);
  log({
    op: 'confluencePageContributors',
    pageId,
    count: contributors.contributors.length,
    rawCount: contributors.rawCount,
    nullNodes: contributors.nullNodes,
    types: contributors.types,
    hasNextPage: contributors.hasNextPage,
    dataPresent: contributors.dataPresent,
    errors: contributors.errors,
  });

  // Teams linked to the page's space. The byline context usually carries the space id; REST v2 is the backup.
  let spaceId = String(req.context?.extension?.space?.id ?? '');
  let spaceTeams;
  if (!spaceId) {
    try {
      spaceId = String((await page()).spaceId ?? '');
    } catch (err) {
      spaceTeams = { ...failed(`space id lookup failed: ${errorText(err)}`), teams: [] };
    }
  }
  if (!spaceTeams) {
    if (spaceId) {
      spaceTeams = await spaceTeamsFromGraph(cloudId, spaceId);
    } else {
      spaceTeams = { ...failed('no space id in context or REST page'), teams: [] };
    }
  }
  delete spaceTeams.nodes;
  log({
    op: 'atlassianTeamsBySpace',
    pageId,
    spaceId,
    count: spaceTeams.teams.length,
    rawCount: spaceTeams.rawCount,
    nullNodes: spaceTeams.nullNodes,
    types: spaceTeams.types,
    dataPresent: spaceTeams.dataPresent,
    errors: spaceTeams.errors,
  });

  const extra = { contributors, spaceTeams: { spaceId, ...spaceTeams } };

  const best = pickBest(variants);
  if (best) {
    log({ op: 'getPageOwners', pageId, source: 'twg', variant: best.key, owners: best.owners.length });
    return { source: 'twg', variant: best.key, owners: best.owners, variants, ...extra };
  }

  try {
    const owners = ownersFromPage(await page());
    log({ op: 'getPageOwners', pageId, source: 'rest', owners: owners.length });
    return { source: 'rest', owners, variants, ...extra };
  } catch (err) {
    const message = errorText(err);
    log({ op: 'getPageOwners', pageId, source: 'none', owners: 0, error: message });
    return { source: 'none', owners: [], variants, errors: [message], ...extra };
  }
});

export const handler = resolver.getDefinitions();
