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
const none = { status: 200, body: { restrictions: { user: { size: 0, results: [] }, group: { size: 0, results: [] } } } };
const restrict = (path: string) => `/wiki/rest/api/content/${path}/restriction/byOperation/read?expand=restrictions.user,restrictions.group`;

/** An open page in space 42 under one parent page, as the live site answers. */
function openSite(): void {
  replies = {
    [`/wiki/api/v2/pages/${PAGE}`]: { status: 200, body: { id: PAGE, spaceId: '42' } },
    '/wiki/api/v2/spaces/42': { status: 200, body: { id: '42' } },
    [`/wiki/rest/api/content/${PAGE}?expand=ancestors`]: { status: 200, body: { id: PAGE, ancestors: [{ id: PARENT }] } },
    [restrict(PAGE)]: none,
    [restrict(PARENT)]: none,
  };
}

beforeEach(() => {
  paths.length = 0;
  openSite();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('pageOpenness (Jira issue titles / version messages)', () => {
  it('an unrestricted page in a readable space is open; ancestors come from REST v1 (no v2 ancestors scope)', async () => {
    expect(await pageOpenness(PAGE)).toEqual({ open: true });
    expect(paths).toContain(`/wiki/rest/api/content/${PAGE}?expand=ancestors`);
    expect(paths.some((p) => p.includes('/wiki/api/v2/pages/') && p.includes('/ancestors'))).toBe(false);
    expect(paths).toContain(restrict(PARENT));
    expect(await pageIsOpen(PAGE)).toBe(true);
    expect(console.info).not.toHaveBeenCalled();
  });

  it('stays fail-closed for a restricted page or ancestor (not logged as a failure)', async () => {
    replies[restrict(PAGE)] = { status: 200, body: { restrictions: { user: { size: 1, results: [{}] } } } };
    expect(await pageOpenness(PAGE)).toEqual({ open: false, reason: 'restricted' });
    openSite();
    replies[restrict(PARENT)] = { status: 200, body: { restrictions: { group: { results: [{}] } } } };
    expect(await pageOpenness(PAGE)).toEqual({ open: false, reason: 'ancestor_restricted' });
    expect(await pageIsOpen(PAGE)).toBe(false);
    expect(console.info).not.toHaveBeenCalled();
  });

  it('a failing step is closed with an enum reason, logged without any body', async () => {
    replies[`/wiki/rest/api/content/${PAGE}?expand=ancestors`] = { status: 403, body: { message: 'secret detail' } };
    expect(await pageOpenness(PAGE)).toEqual({ open: false, reason: 'ancestors_http_403' });
    expect(await pageIsOpen(PAGE)).toBe(false);
    expect(console.info).toHaveBeenCalledWith('ripple page open check failed', { pageId: PAGE, reason: 'ancestors_http_403' });
    openSite();
    replies['/wiki/api/v2/spaces/42'] = { status: 404, body: {} };
    expect(await pageOpenness(PAGE)).toEqual({ open: false, reason: 'space_http_404' });
    openSite();
    replies[restrict(PARENT)] = { status: 401, body: {} };
    expect(await pageOpenness(PAGE)).toEqual({ open: false, reason: 'restrictions_http_401' });
    openSite();
    replies[`/wiki/rest/api/content/${PAGE}?expand=ancestors`] = { status: 200, body: { ancestors: Array.from({ length: 21 }, (_, i) => ({ id: String(i + 1) })) } };
    expect(await pageOpenness(PAGE)).toEqual({ open: false, reason: 'too_deep' });
    expect(await pageOpenness('x1')).toEqual({ open: false, reason: 'bad_id' });
  });
});
