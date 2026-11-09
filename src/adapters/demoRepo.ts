/**
 * M6: progress of "Load demo data" in the `settings` table (key `demo`, no migration): ids and links of the created
 * spaces and pages, so a repeated or resumed load never creates them twice. Parameterised statements only.
 */
import { execute, query } from './sql';

export const DEMO_SETTINGS_KEY = 'demo';

export interface DemoState {
  state: 'loading' | 'done' | 'failed';
  /** Space key → id and link. */
  spaces: Record<string, { id: string; url: string | null }>;
  /** Page slug → id and link. `ownerFailed`: the owner change failed (the page stays with the admin). */
  pages: Record<string, { id: string; url: string | null; ownerFailed?: boolean }>;
  /** Owners for the copy pages (round robin); empty = the admin who pressed the button keeps them. */
  ownerAccountIds: string[];
  /** Log-safe enum of the last failure (`space_http_403`, …); null when none. */
  errorCode: string | null;
  /** Pages whose owner could not be changed. */
  ownerErrors: number;
}

export interface DemoRepo {
  getDemoState(): Promise<DemoState | undefined>;
  saveDemoState(state: DemoState): Promise<void>;
}

const parse = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);

export const sqlDemoRepo: DemoRepo = {
  async getDemoState() {
    const rows = await query<{ v: unknown }>('SELECT v FROM settings WHERE k = ?', DEMO_SETTINGS_KEY);
    const v = rows[0] ? (parse(rows[0].v) as Partial<DemoState> | null) : null;
    if (!v || (v.state !== 'loading' && v.state !== 'done' && v.state !== 'failed')) return undefined;
    return {
      state: v.state,
      spaces: v.spaces ?? {},
      pages: v.pages ?? {},
      ownerAccountIds: Array.isArray(v.ownerAccountIds) ? v.ownerAccountIds.filter((x): x is string => typeof x === 'string') : [],
      errorCode: typeof v.errorCode === 'string' ? v.errorCode : null,
      ownerErrors: typeof v.ownerErrors === 'number' ? v.ownerErrors : 0,
    };
  },

  async saveDemoState(state) {
    await execute('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', DEMO_SETTINGS_KEY, JSON.stringify(state));
  },
};
