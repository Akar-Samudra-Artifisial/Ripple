/**
 * M3 (FR-7): change detection rules, pure so they can be tested without Forge. A re-extraction of a saved source page
 * is compared with the stored facts; confirmed facts whose value changed become one pending change (the owner
 * confirms before anything propagates), new facts are proposed as in M1, and facts no longer on the page are only
 * reported (never deleted automatically).
 */
import { compareValues } from './copies';
import { planMerge, normaliseKeyPart, type ExtractedFact, type MergePlan, type StoredFact } from './facts';
import type { CopyStatus } from './views';

/** Version comment Ripple writes on its own edits (M5); such versions never start change detection (no loops). */
export const RIPPLE_VERSION_PREFIX = 'Updated by Ripple';
/** PRD: owners have 5 working days by default. */
export const DEFAULT_DEADLINE_DAYS = 5;
export const MAX_DEADLINE_DAYS = 30;

export const isRippleVersion = (message: string | null | undefined): boolean => (message ?? '').trim().startsWith(RIPPLE_VERSION_PREFIX);

/** A confirmed fact whose value the page now states differently. */
export interface FactChange {
  factId: string;
  oldValue: string;
  oldUnit: string | null;
  newValue: string;
  newUnit: string | null;
  /** Verbatim sentence of the new version, verified against its text. */
  newQuote: string;
  version: number;
  /** ISO date-time the new version was created (the fact's new "effective since"). */
  versionAt: string | null;
}

export interface DiffPlan {
  /** What still merges as in M1: new facts (proposed), proposed facts re-read, unchanged confirmed facts refreshed. */
  merge: MergePlan;
  changes: FactChange[];
  /** Confirmed facts not found in the new version (logged and stored, never deleted). */
  missing: string[];
}

const sameText = (a: string | null, b: string | null): boolean => normaliseKeyPart(a) === normaliseKeyPart(b);

/** Same text, or (values with digits only) the same number/date by the copy comparison rules ("$60" / "60 USD"). */
const sameValue = (a: { value: string; unit: string | null }, b: { value: string; unit: string | null }): boolean =>
  (sameText(a.value, b.value) && sameText(a.unit, b.unit)) || (/\d/.test(a.value) && /\d/.test(b.value) && compareValues(a, b) === 'same');

/**
 * Like `planMerge`, except for confirmed facts: a different value or unit (also on a reviewer-edited fact) becomes a
 * `FactChange` and the row is left untouched until the owner confirms; nothing is ever removed.
 */
export function planDiff(existing: readonly StoredFact[], extracted: readonly ExtractedFact[], version: number, versionAt: string | null = null): DiffPlan {
  const plan = planMerge(existing, extracted);
  const byId = new Map(existing.map((f) => [f.id, f]));
  const changes: FactChange[] = [];
  const update: MergePlan['update'] = [];
  const matched = new Set<string>();
  for (const u of plan.update) {
    matched.add(u.id);
    const old = byId.get(u.id);
    if (old && u.from === 'confirmed') {
      if (!sameValue(old, u.fact)) {
        changes.push({ factId: old.id, oldValue: old.value, oldUnit: old.unit, newValue: u.fact.value, newUnit: u.fact.unit, newQuote: u.fact.quote, version, versionAt });
        continue;
      }
      // Same value written differently ("$60" / "60 USD"): refresh only, never back to proposed.
      update.push({ ...u, refreshOnly: true, status: 'confirmed', previousValue: null });
      continue;
    }
    update.push(u);
  }
  const missing = existing.filter((f) => f.status === 'confirmed' && !matched.has(f.id)).map((f) => f.id);
  changes.sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0));
  return { merge: { insert: plan.insert, update, remove: [] }, changes, missing: missing.sort() };
}

/** A copy from the last scan, as far as impact needs it. */
export interface CopyForImpact {
  id: string;
  factId: string;
  pageId: string;
  status: CopyStatus;
  statedValue: string | null;
  statedUnit: string | null;
}

export interface ImpactCopy {
  copyId: string;
  factId: string;
  pageId: string;
  /** Null when the page could not be read as the app. */
  spaceId: string | null;
  status: 'in_sync' | 'drifted';
}

export interface ChangeImpact {
  /** Copies to update: in sync with the old value, or drifted, unless they already state the new value. */
  copies: ImpactCopy[];
  /** Copies that already state the new value (nothing to do). */
  alreadyNew: number;
  /** Drifted copies that already state the new value: in sync once the change is confirmed. */
  syncCopyIds: string[];
  /** Shown, never propagated. */
  unsure: number;
  historical: number;
}

/** Which copies a confirmed change would update (PRD "Aturan propagasi"). `spaceOf` maps page id → space id. */
export function computeImpact(changes: readonly FactChange[], copies: readonly CopyForImpact[], spaceOf: ReadonlyMap<string, string | null>): ChangeImpact {
  const byFact = new Map(changes.map((c) => [c.factId, c]));
  const impact: ChangeImpact = { copies: [], alreadyNew: 0, syncCopyIds: [], unsure: 0, historical: 0 };
  for (const copy of copies) {
    const change = byFact.get(copy.factId);
    if (!change) continue;
    if (copy.status === 'unsure') impact.unsure++;
    else if (copy.status === 'historical') impact.historical++;
    else if (copy.status === 'in_sync' || copy.status === 'drifted') {
      const stated = copy.statedValue === null ? 'unknown' : compareValues({ value: change.newValue, unit: change.newUnit }, { value: copy.statedValue, unit: copy.statedUnit });
      if (stated === 'same') {
        impact.alreadyNew++;
        if (copy.status === 'drifted') impact.syncCopyIds.push(copy.id);
      } else impact.copies.push({ copyId: copy.id, factId: copy.factId, pageId: copy.pageId, spaceId: spaceOf.get(copy.pageId) ?? null, status: copy.status });
    }
  }
  impact.copies.sort((a, b) => (a.pageId === b.pageId ? (a.copyId < b.copyId ? -1 : 1) : a.pageId < b.pageId ? -1 : 1));
  return impact;
}

/** `start` plus `days` working days (Mon–Fri), as a `YYYY-MM-DD` date (UTC). */
export function addWorkingDays(start: Date, days: number): string {
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  let left = Math.max(0, Math.trunc(days));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}
