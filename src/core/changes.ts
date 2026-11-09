/**
 * M3 (FR-7): change detection rules, pure so they can be tested without Forge. A re-extraction of a saved source page
 * is compared with the stored facts; confirmed facts whose value changed become one pending change (the owner
 * confirms before anything propagates), new facts are proposed as in M1, and facts no longer on the page are only
 * reported (never deleted automatically).
 */
import { compareValues, normaliseValue, parseDate } from './copies';
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

type Valued = { value: string; unit: string | null };

const sortedKey = (items: readonly (number | string)[]): string => [...new Set(items.map(String))].sort().join('|');
const YEAR = /\b\d{4}\b/g;

/**
 * Same text, or (values with digits only) the same value written differently: "$60" / "60 USD" / "60" (unit not
 * written), "2026-01-15" / "15 Jan 2026". Any change of shape counts as a change: a range ("60" → "60–90"), extra
 * numbers ("60, max 3 days"), another unit (USD → EUR) or other words. Stricter than `compareValues`, which tolerates
 * extra numbers in a copy.
 */
export function sameValue(a: Valued, b: Valued): boolean {
  if (sameText(a.value, b.value) && sameText(a.unit, b.unit)) return true;
  if (!/\d/.test(a.value) || !/\d/.test(b.value)) return false;
  const da = parseDate(a.value);
  const db = parseDate(b.value);
  if (da !== undefined || db !== undefined) {
    // One full date each (a second year means a range or another date).
    return da !== undefined && da !== 'ambiguous' && da === db && (a.value.match(YEAR) ?? []).length === 1 && (b.value.match(YEAR) ?? []).length === 1;
  }
  const x = normaliseValue(a.value, a.unit);
  const y = normaliseValue(b.value, b.unit);
  const unitOk = x.unit === y.unit || x.unit === null || y.unit === null;
  // Tokens with digits ("$60") are already covered by `numbers`.
  const words = (w: readonly string[]): string => sortedKey(w.filter((t) => !/\d/.test(t)));
  return x.numbers.length > 0 && x.numbers.length === y.numbers.length && sortedKey(x.numbers) === sortedKey(y.numbers) && unitOk && words(x.words) === words(y.words);
}

/**
 * Like `planMerge`, except for confirmed facts: a different value or unit (also on a reviewer-edited fact) becomes a
 * `FactChange` and the row is left untouched until the owner confirms; nothing is ever removed.
 */
export function planDiff(
  existing: readonly StoredFact[],
  extracted: readonly ExtractedFact[],
  version: number,
  versionAt: string | null = null,
  /** Proposed duplicates to delete (`matchFacts`); nothing else is ever removed. */
  remove: readonly string[] = [],
): DiffPlan {
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
  const removable = new Set(existing.filter((f) => f.status === 'proposed' && !f.edited && !matched.has(f.id)).map((f) => f.id));
  return { merge: { insert: plan.insert, update, remove: remove.filter((id) => removable.has(id)) }, changes, missing: missing.sort() };
}

// ---------------------------------------------------------------------------------------------------------------
// Matching a re-extraction to the stored facts without relying on the model's wording
// ---------------------------------------------------------------------------------------------------------------

/** A stored fact with the text matching needs. */
export interface KnownFact extends StoredFact {
  subject: string;
  attribute: string;
  condition: string | null;
  quote: string;
}

/** Quotes this similar (word Jaccard, numbers ignored) are the same sentence with another value. */
export const QUOTE_MATCH = 0.75;

const words = (text: string): Set<string> =>
  new Set(
    normaliseKeyPart(text)
      .split(' ')
      .filter((t) => t !== '' && !/\d/.test(t) && /\p{L}/u.test(t)),
  );

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const t of a) if (b.has(t)) both++;
  return both / (a.size + b.size - both);
};

/** Word similarity of two sentences with numbers, amounts and punctuation removed ("$60" vs "$75" is the same sentence). */
export const quoteSimilarity = (a: string, b: string): number => jaccard(words(a), words(b));

const keyWords = (f: { subject: string; attribute: string; condition: string | null }): Set<string> => words(`${f.subject} ${f.attribute} ${f.condition ?? ''}`);

/**
 * Proposed facts whose sentence is already covered by a confirmed fact: most likely a duplicate read with other
 * wording, so they are not offered to the model (it would name them instead of the confirmed fact).
 */
const shadowed = (k: KnownFact, known: readonly KnownFact[]): boolean =>
  k.status === 'proposed' && known.some((c) => c.status === 'confirmed' && quoteSimilarity(c.quote, k.quote) >= QUOTE_MATCH);

/** Facts listed in the diff prompt: confirmed ones and proposed ones that do not shadow a confirmed sentence. */
export const offeredFacts = (known: readonly KnownFact[]): KnownFact[] => known.filter((k) => k.status === 'confirmed' || (k.status === 'proposed' && !shadowed(k, known)));

export interface FactMatch {
  /** Extracted facts; matched ones carry the stored fact's subject/attribute/condition and key. */
  facts: ExtractedFact[];
  byId: number;
  byQuote: number;
  byKey: number;
  /** Unreviewed proposed facts that duplicate a confirmed fact's sentence (from an earlier, mismatched read). */
  duplicates: string[];
}

/**
 * Which stored fact each extracted fact is, independent of the model's wording:
 * 1. `existingFactId` named by the model, only an id offered in the prompt and each id once;
 * 2. the same sentence with other numbers (`quoteSimilarity` ≥ `QUOTE_MATCH`), confirmed facts first, then the fact
 *    with the same value, then the closest subject/attribute/condition words (one sentence can hold several facts);
 * 3. the identity key (original key first).
 * A matched fact keeps the stored key and wording, so a confirmed fact never gets a new key from new wording.
 */
export function matchFacts(known: readonly KnownFact[], extracted: readonly ExtractedFact[], offeredIds: ReadonlySet<string>): FactMatch {
  const byIdMap = new Map(known.map((k) => [k.id, k]));
  const taken = new Set<string>();
  const assigned = new Map<number, KnownFact>();
  let byId = 0;
  let byQuote = 0;
  let byKey = 0;
  extracted.forEach((e, i) => {
    const k = e.existingFactId ? byIdMap.get(e.existingFactId) : undefined;
    if (!k || !offeredIds.has(k.id) || taken.has(k.id)) return;
    taken.add(k.id);
    assigned.set(i, k);
    byId++;
  });
  const pairs: { i: number; k: KnownFact; score: number; confirmed: number; value: number; key: number }[] = [];
  extracted.forEach((e, i) => {
    if (assigned.has(i)) return;
    for (const k of known) {
      if (taken.has(k.id)) continue;
      const score = quoteSimilarity(e.quote, k.quote);
      if (score < QUOTE_MATCH) continue;
      pairs.push({ i, k, score, confirmed: k.status === 'confirmed' ? 1 : 0, value: sameValue(e, k) ? 1 : 0, key: jaccard(keyWords(e), keyWords(k)) });
    }
  });
  pairs.sort((a, b) => b.score - a.score || b.confirmed - a.confirmed || b.value - a.value || b.key - a.key || (a.k.id < b.k.id ? -1 : a.k.id > b.k.id ? 1 : a.i - b.i));
  for (const p of pairs) {
    if (assigned.has(p.i) || taken.has(p.k.id)) continue;
    taken.add(p.k.id);
    assigned.set(p.i, p.k);
    byQuote++;
  }
  extracted.forEach((e, i) => {
    if (assigned.has(i)) return;
    const k = known.find((x) => !taken.has(x.id) && (x.originKey ?? x.identityKey) === e.identityKey) ?? known.find((x) => !taken.has(x.id) && x.identityKey === e.identityKey);
    if (!k) return;
    taken.add(k.id);
    assigned.set(i, k);
    byKey++;
  });
  // An unmatched fact with the key of a matched stored fact would take its place in `planMerge`: it is a second
  // reading of the same fact and is left out.
  const takenKeys = new Set(known.filter((k) => taken.has(k.id)).flatMap((k) => [k.identityKey, k.originKey ?? k.identityKey]));
  const facts = extracted.flatMap((e, i): ExtractedFact[] => {
    const k = assigned.get(i);
    const fact: ExtractedFact = { ...e };
    delete fact.existingFactId;
    if (k) return [{ ...fact, subject: k.subject, attribute: k.attribute, condition: k.condition, identityKey: k.originKey ?? k.identityKey }];
    return takenKeys.has(e.identityKey) ? [] : [fact];
  });
  // Sentences of confirmed facts read in this version (stored and current wording).
  const confirmedQuotes = [...assigned].filter(([, k]) => k.status === 'confirmed').flatMap(([i, k]) => [k.quote, extracted[i]?.quote ?? '']);
  const duplicates = known
    .filter((k) => k.status === 'proposed' && !k.edited && !taken.has(k.id) && confirmedQuotes.some((q) => quoteSimilarity(q, k.quote) >= QUOTE_MATCH))
    .map((k) => k.id)
    .sort();
  return { facts, byId, byQuote, byKey, duplicates };
}

/** Text a dismissed value is remembered by (hashed in SQL): the same value written the same way is not raised again. */
export const dismissedValueText = (value: string, unit: string | null): string => `${normaliseKeyPart(value)}|${normaliseKeyPart(unit)}`;

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
  /**
   * In-sync copies whose stated value is missing or cannot be compared with the old or new value: shown, never
   * propagated automatically (like `unsure`). Absent in impacts stored before it existed (read as 0).
   */
  needsCheck: number;
}

/** Which copies a confirmed change would update (PRD "Aturan propagasi"). `spaceOf` maps page id → space id. */
export function computeImpact(changes: readonly FactChange[], copies: readonly CopyForImpact[], spaceOf: ReadonlyMap<string, string | null>): ChangeImpact {
  const byFact = new Map(changes.map((c) => [c.factId, c]));
  const impact: ChangeImpact = { copies: [], alreadyNew: 0, syncCopyIds: [], unsure: 0, historical: 0, needsCheck: 0 };
  for (const copy of copies) {
    const change = byFact.get(copy.factId);
    if (!change) continue;
    if (copy.status === 'unsure') impact.unsure++;
    else if (copy.status === 'historical') impact.historical++;
    else if (copy.status === 'in_sync' || copy.status === 'drifted') {
      if (copy.statedValue === null) {
        impact.needsCheck++;
        continue;
      }
      const stated = { value: copy.statedValue, unit: copy.statedUnit };
      const vsNew = compareValues({ value: change.newValue, unit: change.newUnit }, stated);
      if (vsNew === 'same') {
        impact.alreadyNew++;
        if (copy.status === 'drifted') impact.syncCopyIds.push(copy.id);
        continue;
      }
      // An in-sync copy is only propagated when it provably states something else than the new value (or the old one).
      const propagate = copy.status === 'drifted' || vsNew === 'different' || compareValues({ value: change.oldValue, unit: change.oldUnit }, stated) === 'same';
      if (propagate) impact.copies.push({ copyId: copy.id, factId: copy.factId, pageId: copy.pageId, spaceId: spaceOf.get(copy.pageId) ?? null, status: copy.status });
      else impact.needsCheck++;
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
