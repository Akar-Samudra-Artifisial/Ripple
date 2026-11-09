/**
 * M6: progress of "Load demo data" in the `settings` table (key `demo`, no migration): ids and links of the created
 * spaces and pages, so a repeated or resumed load never creates them twice. Parameterised statements only.
 *
 * One load at a time: the loader takes a lease (`lease` token + `lockedUntil`) with a compare-and-swap on the stored
 * `$.lease` (the JSON value itself is never compared as text: TiDB normalises JSON). Every later save checks the token
 * again, so a load whose lease was taken over stops instead of overwriting the other one.
 */
import { execute, query } from './sql';

export const DEMO_SETTINGS_KEY = 'demo';

/** `pending`: saved before the owner change (a crash in between is resumed); `failed`: kept by the admin. */
export type DemoOwnerState = 'pending' | 'done' | 'failed';

export interface DemoPage {
  id: string;
  url: string | null;
  /** Owner slot this page was (or is being) given to; absent = the admin keeps it. */
  owner?: string;
  ownerState?: DemoOwnerState;
}

export interface DemoState {
  state: 'loading' | 'done' | 'failed';
  /** Space key → id and link. */
  spaces: Record<string, { id: string; url: string | null }>;
  /** Page slug → id, link and owner progress. */
  pages: Record<string, DemoPage>;
  /** Owners for the copy pages (round robin); empty = the admin who pressed the button keeps them. */
  ownerAccountIds: string[];
  /** Log-safe enum of the last failure (`space_http_403`, …); null when none. */
  errorCode: string | null;
  /** Token of the load holding the lease; '' = free. */
  lease: string;
  /** Epoch ms until which `lease` is held. */
  lockedUntil: number;
  /** Bumped on every save, so a compare-and-swap UPDATE always changes the row (affected rows = 1). */
  rev: number;
}

export interface DemoRepo {
  getDemoState(): Promise<DemoState | undefined>;
  /** Inserts the first state; false when a row exists already (another load was first). */
  createDemoState(state: DemoState): Promise<boolean>;
  /** Replaces the state only while the stored lease is still `expectedLease`; false when it is not (lease lost). */
  replaceDemoState(state: DemoState, expectedLease: string): Promise<boolean>;
}

const parse = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);
const OWNER_STATES: readonly unknown[] = ['pending', 'done', 'failed'];

function parsePage(raw: unknown): DemoPage | null {
  const p = raw as { id?: unknown; url?: unknown; owner?: unknown; ownerState?: unknown; ownerFailed?: unknown } | null;
  if (typeof p?.id !== 'string') return null;
  const page: DemoPage = { id: p.id, url: typeof p.url === 'string' ? p.url : null };
  if (typeof p.owner === 'string') page.owner = p.owner;
  if (OWNER_STATES.includes(p.ownerState)) page.ownerState = p.ownerState as DemoOwnerState;
  else if (p.ownerFailed === true) page.ownerState = 'failed'; // M6 rows before the owner states
  return page;
}

export function parseDemoState(raw: unknown): DemoState | undefined {
  const v = raw as Partial<Record<keyof DemoState, unknown>> | null;
  if (!v || (v.state !== 'loading' && v.state !== 'done' && v.state !== 'failed')) return undefined;
  const pages: Record<string, DemoPage> = {};
  for (const [slug, p] of Object.entries((v.pages as Record<string, unknown> | undefined) ?? {})) {
    const page = parsePage(p);
    if (page) pages[slug] = page;
  }
  return {
    state: v.state,
    spaces: (v.spaces as DemoState['spaces'] | undefined) ?? {},
    pages,
    ownerAccountIds: Array.isArray(v.ownerAccountIds) ? v.ownerAccountIds.filter((x): x is string => typeof x === 'string') : [],
    errorCode: typeof v.errorCode === 'string' ? v.errorCode : null,
    lease: typeof v.lease === 'string' ? v.lease : '',
    lockedUntil: typeof v.lockedUntil === 'number' ? v.lockedUntil : 0,
    rev: typeof v.rev === 'number' ? v.rev : 0,
  };
}

export const sqlDemoRepo: DemoRepo = {
  async getDemoState() {
    const rows = await query<{ v: unknown }>('SELECT v FROM settings WHERE k = ?', DEMO_SETTINGS_KEY);
    return rows[0] ? parseDemoState(parse(rows[0].v)) : undefined;
  },

  async createDemoState(state) {
    return (await execute('INSERT IGNORE INTO settings (k, v) VALUES (?, ?)', DEMO_SETTINGS_KEY, JSON.stringify(state))) === 1;
  },

  async replaceDemoState(state, expectedLease) {
    const n = await execute(
      "UPDATE settings SET v = ? WHERE k = ? AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(v, '$.lease')), '') = ?",
      JSON.stringify(state),
      DEMO_SETTINGS_KEY,
      expectedLease,
    );
    return n > 0;
  },
};
