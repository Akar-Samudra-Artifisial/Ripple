import { describe, expect, it, vi } from 'vitest';

const requestConfluence = vi.fn();
vi.mock('@forge/api', () => ({ default: { asApp: () => ({ requestConfluence }), asUser: () => ({ requestConfluence }) }, route: (s: TemplateStringsArray) => s.join('') }));

import { searchPagesAsApp } from '../src/adapters/confluence';

describe('searchPagesAsApp', () => {
  it('keeps current pages only (archived, draft and trashed pages are not copies)', async () => {
    requestConfluence.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({
        results: [
          { content: { id: '1', type: 'page', status: 'current', title: 'Live' } },
          { content: { id: '2', type: 'page', status: 'archived', title: 'Old' } },
          { content: { id: '3', type: 'page', status: 'draft', title: 'Draft' } },
          { content: { id: '4', type: 'blogpost', status: 'current', title: 'Blog' } },
          { content: { id: '5', type: 'page', title: 'No status' } },
        ],
      }),
    });
    expect((await searchPagesAsApp('type = page', 10)).map((h) => h.pageId)).toEqual(['1', '5']);
  });
});
