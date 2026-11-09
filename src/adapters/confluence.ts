import api, { route } from '@forge/api';

/** A page with its storage-format body, read as the app (queue consumers have no user). */
export interface SourcePage {
  id: string;
  title: string;
  spaceId: string;
  version: number;
  /** ISO date-time the current version was created ("effective since" of its facts). */
  versionCreatedAt: string | null;
  /** Version comment ("Updated by Ripple: …" for Ripple's own edits); null/absent when empty. */
  versionMessage?: string | null;
  body: string;
}

/** Thrown for 404: the page was deleted or the app cannot see it. */
export class PageNotFoundError extends Error {
  constructor(readonly pageId: string) {
    super(`Confluence page ${pageId} not found or not visible to the app`);
    this.name = 'PageNotFoundError';
  }
}

/** 429 or 5xx from Confluence: worth retrying later through the queue. */
export class ConfluenceRetryableError extends Error {
  constructor(
    readonly pageId: string,
    readonly status: number,
    resource = 'REST v2 page',
  ) {
    super(`Confluence ${resource} ${pageId} failed: HTTP ${status} (will retry)`);
    this.name = 'ConfluenceRetryableError';
  }
}

interface RawPage {
  id?: string | number;
  title?: string;
  spaceId?: string | number;
  version?: { number?: number; createdAt?: string; message?: string };
  body?: { storage?: { value?: string } };
}

/** REST v2 page with `body-format=storage`, as the app. Throws with the HTTP status (never the body) on failure. */
export async function getSourcePage(pageId: string): Promise<SourcePage> {
  const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${pageId}?body-format=storage`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) throw new PageNotFoundError(pageId);
  if (res.status === 429 || res.status >= 500) throw new ConfluenceRetryableError(pageId, res.status);
  if (!res.ok) throw new Error(`Confluence REST v2 page ${pageId} failed: HTTP ${res.status}`);
  const page = (await res.json()) as RawPage;
  return {
    id: String(page.id ?? pageId),
    title: page.title ?? '',
    spaceId: page.spaceId === undefined ? '' : String(page.spaceId),
    version: page.version?.number ?? 0,
    versionCreatedAt: page.version?.createdAt ?? null,
    versionMessage: page.version?.message ? page.version.message : null,
    body: page.body?.storage?.value ?? '',
  };
}

/** Space id of a page as the app (no body); null when the page cannot be read. Never throws. */
export async function pageSpaceIdAsApp(pageId: string): Promise<string | null> {
  try {
    const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${pageId}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const page = (await res.json()) as RawPage;
    return page.spaceId === undefined ? null : String(page.spaceId);
  } catch {
    return null;
  }
}

/** A page found by CQL. */
export interface SearchHit {
  pageId: string;
  title: string;
  /** Relative web link (`/spaces/…/pages/…`), when Confluence returns one. */
  url: string | null;
}

interface RawSearch {
  results?: { content?: { id?: string | number; type?: string; status?: string; title?: string; _links?: { webui?: string } }; url?: string; title?: string }[];
  _links?: { next?: string };
}

const SEARCH_PAGE_SIZE = 50;

type Requester = ReturnType<typeof api.asApp>;

/** CQL search (`GET /wiki/rest/api/search`), following cursors until `max` distinct pages. Never logs the CQL. */
async function cqlSearch(requester: Requester, cql: string, max: number): Promise<SearchHit[]> {
  const hits = new Map<string, SearchHit>();
  let cursor: string | undefined;
  while (hits.size < max) {
    const limit = Math.min(SEARCH_PAGE_SIZE, max - hits.size);
    const path =
      cursor === undefined
        ? route`/wiki/rest/api/search?cql=${cql}&limit=${String(limit)}&excerpt=none`
        : route`/wiki/rest/api/search?cql=${cql}&limit=${String(limit)}&excerpt=none&cursor=${cursor}`;
    const res = await requester.requestConfluence(path, { headers: { Accept: 'application/json' } });
    if (res.status === 429 || res.status >= 500) throw new ConfluenceRetryableError('search', res.status, 'CQL');
    // The body may echo the CQL (built from page text), so only the status goes into the error.
    if (!res.ok) throw new Error(`Confluence CQL search failed: HTTP ${res.status}`);
    const body = (await res.json()) as RawSearch;
    const results = body.results ?? [];
    for (const r of results) {
      const c = r.content;
      // Archived (or draft/trashed) pages are not copies anyone reads (PRD business rules); only `current` counts.
      if (!c || c.type !== 'page' || c.id === undefined || (c.status !== undefined && c.status !== 'current') || hits.size >= max) continue;
      const pageId = String(c.id);
      if (!hits.has(pageId)) hits.set(pageId, { pageId, title: c.title ?? r.title ?? '', url: c._links?.webui ?? r.url ?? null });
    }
    const next = body._links?.next;
    cursor = next ? (new URLSearchParams(next.split('?')[1] ?? '').get('cursor') ?? undefined) : undefined;
    if (results.length === 0 || !cursor) break;
  }
  return [...hits.values()];
}

/** Candidate pages as the app (queue consumers have no user); results are filtered per viewer when shown. */
export const searchPagesAsApp = (cql: string, max: number): Promise<SearchHit[]> => cqlSearch(api.asApp(), cql, max);

/**
 * The subset of `pageIds` the current user can see (CQL as the user only returns pages they may read). Resolvers
 * only. Ids are validated digits, so the CQL cannot be injected.
 */
export async function visiblePageIds(pageIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(pageIds)].filter((id) => /^\d{1,32}$/.test(id));
  const visible = new Set<string>();
  for (let i = 0; i < ids.length; i += SEARCH_PAGE_SIZE) {
    const batch = ids.slice(i, i + SEARCH_PAGE_SIZE);
    const hits = await cqlSearch(api.asUser(), `type = page AND id in (${batch.join(',')})`, batch.length);
    for (const h of hits) visible.add(h.pageId);
  }
  return visible;
}

/** A page as the current user reads it, for an edit (M4). */
export interface UserPage {
  title: string;
  version: number;
  body: string;
}

/** HTTP outcome of a user read/write; `status` only (the body may echo page text). */
export type UserResult<T> = { ok: true; value: T } | { ok: false; status: number };

/**
 * Title, version and storage body as the current user. Resolvers only. A response without a storage body is a
 * failure (writing back a body that was not returned would wipe the page).
 */
export async function getPageAsUser(pageId: string): Promise<UserResult<UserPage>> {
  const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}?body-format=storage`, { headers: { Accept: 'application/json' } });
  if (!res.ok) return { ok: false, status: res.status };
  const page = (await res.json()) as RawPage;
  const body = page.body?.storage?.value;
  const version = page.version?.number;
  if (typeof body !== 'string' || typeof version !== 'number') return { ok: false, status: 502 };
  return { ok: true, value: { title: page.title ?? '', version, body } };
}

/**
 * Saves `body` as the current user (they become a contributor) as version `version` with `message`; returns the saved
 * version. Resolvers only. 409 = someone saved another version first.
 */
export async function updatePageAsUser(pageId: string, page: { title: string; body: string; version: number; message: string }): Promise<UserResult<number>> {
  const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: pageId,
      status: 'current',
      title: page.title,
      body: { representation: 'storage', value: page.body },
      version: { number: page.version, message: page.message },
    }),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const saved = (await res.json()) as RawPage;
  return { ok: true, value: saved.version?.number ?? page.version };
}

/** Ancestors checked for inherited read restrictions; a deeper page is treated as restricted. */
const MAX_RESTRICTION_ANCESTORS = 20;

interface RawRestrictions {
  restrictions?: { user?: { size?: number; results?: unknown[] }; group?: { size?: number; results?: unknown[] } };
}

const restrictedBy = (r: RawRestrictions): boolean => {
  const n = (x: { size?: number; results?: unknown[] } | undefined): number => Math.max(x?.size ?? 0, x?.results?.length ?? 0);
  return n(r.restrictions?.user) + n(r.restrictions?.group) > 0;
};

/**
 * True when the page's title may be named to anyone (version messages): the app reads its space, and neither the
 * page nor any ancestor has a read restriction (REST v1 `restriction/byOperation/read`, as the app). Any failure
 * counts as restricted. Space permissions themselves cannot be read with the app's scopes.
 */
export async function pageIsOpen(pageId: string): Promise<boolean> {
  try {
    const app = api.asApp();
    const json = { headers: { Accept: 'application/json' } };
    const pageRes = await app.requestConfluence(route`/wiki/api/v2/pages/${pageId}`, json);
    if (!pageRes.ok) return false;
    const page = (await pageRes.json()) as RawPage;
    if (page.spaceId === undefined) return false;
    const spaceRes = await app.requestConfluence(route`/wiki/api/v2/spaces/${String(page.spaceId)}`, json);
    if (!spaceRes.ok) return false;
    const ancRes = await app.requestConfluence(route`/wiki/api/v2/pages/${pageId}/ancestors?limit=${String(MAX_RESTRICTION_ANCESTORS + 1)}`, json);
    if (!ancRes.ok) return false;
    const ancestors = ((await ancRes.json()) as { results?: { id?: string | number }[] }).results ?? [];
    if (ancestors.length > MAX_RESTRICTION_ANCESTORS) return false;
    for (const id of [pageId, ...ancestors.map((a) => String(a.id ?? ''))]) {
      if (!/^\d{1,32}$/.test(id)) return false;
      const res = await app.requestConfluence(route`/wiki/rest/api/content/${id}/restriction/byOperation/read?expand=restrictions.user,restrictions.group`, json);
      if (!res.ok || restrictedBy((await res.json()) as RawRestrictions)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the current user may edit the page (`update` among its permitted operations). Runs as the user, so only
 * call it from resolvers. 401/403/404 mean "no"; other failures throw.
 */
export async function canEditPage(pageId: string): Promise<boolean> {
  const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}/operations`, { headers: { Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403 || res.status === 404) return false;
  if (!res.ok) throw new Error(`Confluence page ${pageId} operations failed: HTTP ${res.status}`);
  const body = (await res.json()) as { operations?: { operation?: string }[] };
  return (body.operations ?? []).some((o) => o.operation === 'update');
}
