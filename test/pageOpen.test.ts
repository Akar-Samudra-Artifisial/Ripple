import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Mocked Confluence REST replies by path; every request is recorded. */
let replies: Record<string, { status: number; body: unknown }> = {};
const paths: string[] = [];

vi.mock('@forge/api', () => {
  const requestConfluence = async (path: string) => {
    paths.push(path);
    const r = replies[path] ?? { status: 404, body: {} };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  return {
    default: { asApp: () => ({ requestConfluence }), asUser: () => ({ requestConfluence }) },
    route: (s: TemplateStringsArray, ...v: unknown[]) => s.reduce((acc, part, i) => acc + part + (i < v.length ? String(v[i]) : ''), ''),
  };
});

import { pageIsOpen, pageOpenness } from '../src/adapters/confluence';

const PAGE = '9502721';
const PARENT = '9500001';
const HOME = '9400001';
const none = { status: 200, body: { restrictions: { user: { size: 0, results: [] }, group: { size: 0, results: [] } } } };
const restrict = (id: string) => `/wiki/rest/api/content/${id}/restriction/byOperation/read?expand=restrictions.user,restrictions.group`;
const v2 = (id: string) => `/wiki/api/v2/pages/${id}`;

/** An open page in space 42: page → parent → space homepage (no parent), as REST v2 answers. */
function openSite(): void {
  replies = {
    [v2(PAGE)]: { status: 200, body: { id: PAGE, spaceId: '42', parentId: PARENT, parentType: 'page' } },
    [v2(PARENT)]: { status: 200, body: { id: PARENT, spaceId: '42', parentId: HOME, parentType: 'page' } },
    [v2(HOME)]: { status: 200, body: { id: HOME, spaceId: '42', parentId: null, parentType: null } },
    '/wiki/api/v2/spaces/42': { status: 200, body: { id: '42' } },
    [restrict(PAGE)]: none,
    [restrict(PARENT)]: none,
    [restrict(HOME)]: none,
  };
}

beforeEach(() => {
  paths.length = 0;
  openSite();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('pageOpenness (Jira issue titles / version messages)', () => {
  it('walks up through REST v2 parentId and checks every level; no ancestors endpoint (v1 gone, v2 lacks scope)', async () => {
    expect(await pageOpenness(PAGE)).toEqual({ open: true });
    expect(paths).toEqual([v2(PAGE), '/wiki/api/v2/spaces/42', restrict(PAGE), v2(PARENT), restrict(PARENT), v2(HOME), restrict(HOME)]);
    expect(paths.some((p) => p.includes('ancestors'))).toBe(false);
    expect(await pageIsOpen(PAGE)).toBe(true);
    expect(console.info).not.toHaveBeenCalled();
  });

  it('stays fail-closed for a restricted page or ancestor (not logged as a failure)', async () => {
    replies[restrict(PAGE)] = { status: 200, body: { restrictions: { user: { size: 1, results: [{}] } } } };
    expect(await pageOpenness(PAGE)).toEqual({ open: false, reason: 'restricted' });
    openSite();
    replies[restrict(HOME)] = { status: 200, body: { restrictions: { group: { results: [{}] } } } };
    expect(await pageOpenness(PAGE)).toEqual({ open: false, reason: 'ancestor_restricted' });
    expect(await pageIsOpen(PAGE)).toBe(false);
    expect(console.info).not.toHaveBeenCalled();
  });

  it('410 / 404 and other failing steps are closed with an enum reason, logged without any body', async () => {
    replies[restrict(PAGE)] = { status: 410, body: { message: 'secret detail' } };
    expect(await pageOpenness(PAGE)).toEqual({ open: false, reason: 'restrictions_http_410' });
    expect(await pageIsOpen(PAGE)).toBe(false);
    expect(console.info).toHaveBeenCalledWith('ripple page open check failed', { pageId: PAGE, reason: 'restrictions_http_410' });
    openSite();
    delete replies[v2(PARENT)];
    expect(await pageOpenness(PAGE)).toEqual({ open: false, reason: 'parent_http_404' });
    openSite();
    replies[v2(PAGE)] = { status: 404, body: {} };
    expect(await pageOpenness(PAGE)).toEqual({ open: false, reason: 'page_http_404' });
    openSite();
    replies['/wiki/api/v2/spaces/42'] = { status: 404, body: {} };
    expect(await pageOpenness(PAGE)).toEqual({ open: false, reason: 'space_http_404' });
    expect(await pageOpenness('x1')).toEqual({ open: false, reason: 'bad_id' });
  });

  it('a folder (or other non-page) parent and a tree deeper than 20 levels count as restricted', async () => {
    replies[v2(PARENT)] = { status: 200, body: { id: PARENT, spaceId: '42', parentId: '777', parentType: 'folder' } };
    expect(await pageOpenness(PAGE)).toEqual({ open: false, reason: 'parent_not_page' });
    // A chain of 25 pages: 1 → 2 → … → 25.
    replies = { '/wiki/api/v2/spaces/42': { status: 200, body: {} } };
    for (let i = 1; i <= 25; i++) {
      replies[v2(String(i))] = { status: 200, body: { id: String(i), spaceId: '42', parentId: String(i + 1), parentType: 'page' } };
      replies[restrict(String(i))] = none;
    }
    paths.length = 0;
    expect(await pageOpenness('1')).toEqual({ open: false, reason: 'too_deep' });
    expect(paths.filter((p) => p.startsWith('/wiki/api/v2/pages/'))).toHaveLength(21);
  });
});
