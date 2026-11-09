import api, { route } from '@forge/api';

/** A page with its storage-format body, read as the app (queue consumers have no user). */
export interface SourcePage {
  id: string;
  title: string;
  spaceId: string;
  version: number;
  /** ISO date-time the current version was created ("effective since" of its facts). */
  versionCreatedAt: string | null;
  body: string;
}

/** Thrown for 404: the page was deleted or the app cannot see it. */
export class PageNotFoundError extends Error {
  constructor(readonly pageId: string) {
    super(`Confluence page ${pageId} not found or not visible to the app`);
    this.name = 'PageNotFoundError';
  }
}

interface RawPage {
  id?: string | number;
  title?: string;
  spaceId?: string | number;
  version?: { number?: number; createdAt?: string };
  body?: { storage?: { value?: string } };
}

/** REST v2 page with `body-format=storage`, as the app. Throws with the HTTP status (never the body) on failure. */
export async function getSourcePage(pageId: string): Promise<SourcePage> {
  const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${pageId}?body-format=storage`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) throw new PageNotFoundError(pageId);
  if (!res.ok) throw new Error(`Confluence REST v2 page ${pageId} failed: HTTP ${res.status}`);
  const page = (await res.json()) as RawPage;
  return {
    id: String(page.id ?? pageId),
    title: page.title ?? '',
    spaceId: page.spaceId === undefined ? '' : String(page.spaceId),
    version: page.version?.number ?? 0,
    versionCreatedAt: page.version?.createdAt ?? null,
    body: page.body?.storage?.value ?? '',
  };
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
