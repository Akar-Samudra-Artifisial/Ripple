import { describe, expect, it, vi } from 'vitest';

const forge = vi.hoisted(() => ({ requestConfluence: vi.fn() }));

vi.mock('@forge/api', () => ({
  default: { asUser: () => ({ requestConfluence: forge.requestConfluence }) },
  route: (s: TemplateStringsArray) => s.join(''),
}));

import { asUserUsersBulk, displayNames, parseUsersBulk, USERS_BULK_LIMIT, type UsersBulkRequest } from '../src/adapters/confluenceUsers';

describe('asUserUsersBulk', () => {
  it('POSTs accountIds (not accountId) to the v2 users-bulk endpoint as the user', async () => {
    forge.requestConfluence.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    await asUserUsersBulk(['a1']);
    expect(forge.requestConfluence).toHaveBeenCalledWith('/wiki/api/v2/users-bulk', expect.objectContaining({ method: 'POST', body: '{"accountIds":["a1"]}' }));
  });

  it('throws with the HTTP status on failure', async () => {
    forge.requestConfluence.mockResolvedValue({ ok: false, status: 403 });
    await expect(asUserUsersBulk(['a1'])).rejects.toThrow('Confluence users-bulk failed: HTTP 403');
  });
});

describe('parseUsersBulk', () => {
  it('maps accountId to displayName, falling back to publicName and skipping incomplete entries', () => {
    const names = parseUsersBulk({
      results: [{ accountId: 'a1', displayName: 'Ana' }, { accountId: 'a2', displayName: '', publicName: 'Bo' }, { accountId: 'a3' }, { displayName: 'no id' }],
    });
    expect([...names]).toEqual([
      ['a1', 'Ana'],
      ['a2', 'Bo'],
    ]);
    expect(parseUsersBulk(null).size).toBe(0);
  });
});

describe('displayNames', () => {
  it('deduplicates ids and chunks requests by the bulk limit', async () => {
    const request = vi.fn<UsersBulkRequest>(async (ids) => ({ results: ids.map((accountId) => ({ accountId, displayName: `N-${accountId}` })) }));
    const ids = Array.from({ length: USERS_BULK_LIMIT + 1 }, (_, i) => `u${i}`);
    const names = await displayNames([...ids, 'u0', ''], request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toHaveLength(USERS_BULK_LIMIT);
    expect(names.size).toBe(USERS_BULK_LIMIT + 1);
    expect(names.get('u0')).toBe('N-u0');
  });
});
