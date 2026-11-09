import api, { route } from '@forge/api';

/**
 * Display names for account ids via Confluence REST v2 `POST /wiki/api/v2/users-bulk` (scope
 * `read:user:confluence`, up to 250 ids, body field `accountIds`). Runs as the current user, so profile
 * visibility settings apply. Custom UI has no `<User>` component (that is UI Kit only), and Teamwork Graph returns
 * null user nodes on our sites, so this is the name source for every Ripple surface.
 */
export const USERS_BULK_LIMIT = 250;

/** One users-bulk call; resolves to the parsed JSON body. Throws on a non-2xx response. */
export type UsersBulkRequest = (accountIds: string[]) => Promise<unknown>;

export const asUserUsersBulk: UsersBulkRequest = async (accountIds) => {
  const res = await api.asUser().requestConfluence(route`/wiki/api/v2/users-bulk`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountIds }),
  });
  if (!res.ok) throw new Error(`Confluence users-bulk failed: HTTP ${res.status}`);
  return res.json();
};

/** accountId → displayName from a users-bulk body; entries without both fields are skipped. */
export function parseUsersBulk(raw: unknown): Map<string, string> {
  const results = (raw as { results?: unknown } | null)?.results;
  const names = new Map<string, string>();
  if (!Array.isArray(results)) return names;
  for (const r of results as { accountId?: unknown; displayName?: unknown; publicName?: unknown }[]) {
    const name = typeof r?.displayName === 'string' && r.displayName !== '' ? r.displayName : typeof r?.publicName === 'string' ? r.publicName : '';
    if (typeof r?.accountId === 'string' && r.accountId !== '' && name !== '') names.set(r.accountId, name.slice(0, 120));
  }
  return names;
}

export interface UserAccount {
  name: string;
  /** `atlassian` | `app` | `customer` | `unknown`. */
  accountType: string;
  /** `active` | `inactive` | `closed` | `unknown`. */
  accountStatus: string;
}

/** accountId → name, type and status from a users-bulk body (missing type/status = `unknown`). */
export function parseUserAccounts(raw: unknown): Map<string, UserAccount> {
  const results = (raw as { results?: unknown } | null)?.results;
  const out = new Map<string, UserAccount>();
  if (!Array.isArray(results)) return out;
  const names = parseUsersBulk(raw);
  for (const r of results as { accountId?: unknown; accountType?: unknown; accountStatus?: unknown }[]) {
    if (typeof r?.accountId !== 'string' || r.accountId === '') continue;
    out.set(r.accountId, {
      name: names.get(r.accountId) ?? '',
      accountType: typeof r.accountType === 'string' ? r.accountType : 'unknown',
      accountStatus: typeof r.accountStatus === 'string' ? r.accountStatus : 'unknown',
    });
  }
  return out;
}

/** Accounts for at most `USERS_BULK_LIMIT` ids in one call; ids not returned are absent. Throws on HTTP failure. */
export async function userAccounts(accountIds: readonly string[], request: UsersBulkRequest = asUserUsersBulk): Promise<Map<string, UserAccount>> {
  const ids = [...new Set(accountIds.filter((id) => id !== ''))].slice(0, USERS_BULK_LIMIT);
  return ids.length ? parseUserAccounts(await request(ids)) : new Map();
}

/** Display names for `accountIds` (deduplicated, chunked by `USERS_BULK_LIMIT`). Ids not returned are absent. */
export async function displayNames(accountIds: readonly string[], request: UsersBulkRequest = asUserUsersBulk): Promise<Map<string, string>> {
  const ids = [...new Set(accountIds.filter((id) => id !== ''))];
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += USERS_BULK_LIMIT) {
    for (const [id, name] of parseUsersBulk(await request(ids.slice(i, i + USERS_BULK_LIMIT)))) names.set(id, name);
  }
  return names;
}
