/**
 * M6 "Load demo data": Confluence calls as the admin who pressed the button (resolvers only). Spaces are created with
 * REST v1 `POST /wiki/rest/api/space` (`write:confluence-space`; v2 space creation needs a scope Ripple does not
 * have), pages with REST v2 (`write:page:confluence`). Every call returns the HTTP status only, never a body.
 */
import api, { route } from '@forge/api';
import type { UserResult } from './confluence';

export interface DemoRef {
  id: string;
  /** Absolute link (`_links.base` + `webui`); null when Confluence returned none. */
  url: string | null;
}

export interface DemoSpaceRef extends DemoRef {
  /** Plain-text description ('' when none): tells a space Ripple created (`DEMO_MARKER`) from a foreign one. */
  description: string;
}

export interface DemoConfluence {
  findSpace(key: string): Promise<UserResult<DemoSpaceRef | null>>;
  createSpace(key: string, name: string, description: string): Promise<UserResult<DemoRef>>;
  findPage(spaceId: string, title: string): Promise<UserResult<DemoRef | null>>;
  createPage(spaceId: string, title: string, storage: string): Promise<UserResult<DemoRef>>;
  /**
   * Makes `ownerAccountId` the owner of the page: reads it (owner, title, current body, version) and, only when the
   * owner differs, saves the next version with the same title and the body as read (so edits made meanwhile are kept).
   */
  ensureOwner(pageId: string, ownerAccountId: string): Promise<UserResult<true>>;
}

interface Links {
  base?: string;
  webui?: string;
}

const json = { Accept: 'application/json' };
const send = { Accept: 'application/json', 'Content-Type': 'application/json' };
const link = (base: string | undefined, webui: string | undefined): string | null => (base && webui ? `${base}${webui}` : null);

export const demoConfluence: DemoConfluence = {
  async findSpace(key) {
    const res = await api.asUser().requestConfluence(route`/wiki/api/v2/spaces?keys=${key}&description-format=plain&limit=1`, { headers: json });
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as {
      results?: { id?: string | number; key?: string; description?: { plain?: { value?: unknown } } | null; _links?: Links }[];
      _links?: Links;
    };
    const space = body.results?.find((s) => s.key === key);
    if (!space || space.id === undefined) return { ok: true, value: null };
    const description = space.description?.plain?.value;
    return { ok: true, value: { id: String(space.id), url: link(body._links?.base, space._links?.webui), description: typeof description === 'string' ? description : '' } };
  },

  async createSpace(key, name, description) {
    const res = await api.asUser().requestConfluence(route`/wiki/rest/api/space`, {
      method: 'POST',
      headers: send,
      body: JSON.stringify({ key, name, description: { plain: { value: description, representation: 'plain' } } }),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as { id?: string | number; _links?: Links };
    if (body.id === undefined) return { ok: false, status: 502 };
    return { ok: true, value: { id: String(body.id), url: link(body._links?.base, body._links?.webui) } };
  },

  async findPage(spaceId, title) {
    const res = await api.asUser().requestConfluence(route`/wiki/api/v2/spaces/${spaceId}/pages?title=${title}&status=current&limit=1`, { headers: json });
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as { results?: { id?: string | number; title?: string; _links?: Links }[]; _links?: Links };
    const page = body.results?.find((r) => r.title === title);
    if (!page || page.id === undefined) return { ok: true, value: null };
    return { ok: true, value: { id: String(page.id), url: link(body._links?.base, page._links?.webui) } };
  },

  async createPage(spaceId, title, storage) {
    const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages`, {
      method: 'POST',
      headers: send,
      body: JSON.stringify({ spaceId, status: 'current', title, body: { representation: 'storage', value: storage } }),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const page = (await res.json()) as { id?: string | number; _links?: Links };
    if (page.id === undefined) return { ok: false, status: 502 };
    return { ok: true, value: { id: String(page.id), url: link(page._links?.base, page._links?.webui) } };
  },

  async ensureOwner(pageId, ownerAccountId) {
    const user = api.asUser();
    const got = await user.requestConfluence(route`/wiki/api/v2/pages/${pageId}?body-format=storage`, { headers: json });
    if (!got.ok) return { ok: false, status: got.status };
    const page = (await got.json()) as { ownerId?: unknown; title?: unknown; version?: { number?: unknown }; body?: { storage?: { value?: unknown } } };
    if (page.ownerId === ownerAccountId) return { ok: true, value: true };
    const version = page.version?.number;
    const storage = page.body?.storage?.value;
    if (typeof page.title !== 'string' || typeof version !== 'number' || typeof storage !== 'string') return { ok: false, status: 502 };
    const res = await user.requestConfluence(route`/wiki/api/v2/pages/${pageId}`, {
      method: 'PUT',
      headers: send,
      body: JSON.stringify({
        id: pageId,
        status: 'current',
        title: page.title,
        ownerId: ownerAccountId,
        body: { representation: 'storage', value: storage },
        version: { number: version + 1, message: 'Ripple demo data: page owner' },
      }),
    });
    return res.ok ? { ok: true, value: true } : { ok: false, status: res.status };
  },
};
