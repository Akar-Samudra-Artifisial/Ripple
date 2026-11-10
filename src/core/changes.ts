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
 * The same numbers in the same order (at least one): "over $2,000" / "2000". A range, an extra number or swapped
 * numbers ("$60 … 30 days" → "$30 … 60 days") differ.
 */
export function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((n, i) => n === b[i]);
}

/** Negation words; a sentence that gains or loses one ("required" → "not required") changed its meaning. */
const NEGATIONS = new Set(['not', 'no', 'never', 'none', 'nor', 'without', 'tidak', 'bukan', 'tanpa', 'jangan', 'belum']);

const negations = (text: string): number => normaliseKeyPart(text.replace(/n't\b/gi, ' not')).split(' ').filter((w) => NEGATIONS.has(w)).length;

/** Both sentences carry the same number of negation words. */
export const sameNegation = (a: string, b: string): boolean => negations(a) === negations(b);

const allIn = (need: Iterable<string>, have: ReadonlySet<string>): boolean => [...need].every((w) => have.has(w));

/** Every word of a value without digits ("economy class") still in the sentence; false when the value has no words. */
export function valueWordsIn(value: string, quote: string): boolean {
  const need = words(value);
  return need.size > 0 && allIn(need, words(quote));
}

/** Words of a value besides numbers and units ("Trips over $2,000" → trips). */
const valueWords = (value: string, unit: string | null): string[] => normaliseValue(value, unit).words.filter((w) => !/\d/.test(w));

/** Same unit on both sides; a unit written on one side only is a change ("60" → "60 days"). */
const sameUnit = (a: string | null, b: string | null): boolean => a === b;

const PERIODS: readonly [RegExp, string][] = [
  [/\b(?:per|a|an|each|every)\s+(?:calendar\s+|working\s+|business\s+)?(?:day|night)s?\b|\/\s*(?:day|night|d)\b|\bdaily\b|\bper\s+hari\b|\/\s*hari\b|\bsehari\b|\bharian\b/i, 'day'],
  [/\b(?:per|a|an|each|every)\s+week\b|\/\s*(?:week|wk)\b|\bweekly\b|\bper\s+minggu\b|\/\s*minggu\b|\bmingguan\b/i, 'week'],
  [/\b(?:per|a|an|each|every)\s+month\b|\/\s*(?:month|mo)\b|\bmonthly\b|\bper\s+bulan\b|\/\s*bulan\b|\bbulanan\b/i, 'month'],
  [/\b(?:per|a|an|each|every)\s+(?:year|annum)\b|\/\s*(?:year|yr)\b|\b(?:yearly|annually|annual)\b|\bper\s+tahun\b|\/\s*tahun\b|\btahunan\b/i, 'year'],
  [/\b(?:per|a|an|each|every)\s+hour\b|\/\s*(?:hour|hr|h)\b|\bhourly\b|\bper\s+jam\b|\/\s*jam\b/i, 'hour'],
];

/** Rate period of a value or sentence ("$60 per day", "60/day", "per hari" → day); null when none is written. */
export function ratePeriod(text: string | null | undefined): string | null {
  const t = text ?? '';
  return PERIODS.find(([re]) => re.test(t))?.[1] ?? null;
}

/** Period of a fact: its value and unit, else its sentence. */
const periodOf = (v: Valued, quote: string | null | undefined): string | null => ratePeriod(`${v.value} ${v.unit ?? ''}`) ?? ratePeriod(quote);

/** Words that change what a number means ("30 days" → "30 business days", "$60" → "max $60"). */
const QUALIFIERS = new Set(['business', 'working', 'calendar', 'weekday', 'weekdays', 'net', 'gross', 'minimum', 'min', 'maximum', 'max', 'least', 'most', 'before', 'after', 'excluding', 'including', 'excl', 'incl', 'tax', 'kerja', 'minimal', 'maksimal', 'bersih', 'kotor']);

type Quoted = Valued & { quote?: string | null };

/**
 * Whether a matched confirmed fact really changed. The model's free-text value is not trusted on its own: a wording
 * change without another number or unit ("2000" USD → "Trips over $2,000", "economy class" → "economy class for
 * flights under 6 hours") is no change. No change when:
 * - the sentence is the same (whitespace/punctuation ignored);
 * - the value is the same (`sameValue`, a unit on one side only counts as a change);
 * - the sentence has the same words, negations, numbers in the same order and unit (only formatting changed);
 * - a value without digits: its words are still in the new sentence and no negation was added or removed;
 * - a value with digits: the same numbers in order, the same unit, no negation added or removed, and the words
 *   around the numbers are in the other version's sentence (so "15 January" → "15 February" is a change).
 * Dates and facts without a stored sentence keep the strict `sameValue`.
 */
export function factChanged(old: Quoted, now: Valued & { quote: string }): boolean {
  const oldQuote = old.quote ?? '';
  if (oldQuote.trim() === '') return !sameValue(old, now);
  if (sameText(oldQuote, now.quote)) return false;
  // The rate period is part of the unit: "$60 per day" → "$60 per week" is a change.
  if (periodOf(old, oldQuote) !== periodOf(now, now.quote)) return true;
  const negationOk = sameNegation(oldQuote, now.quote);
  const x = normaliseValue(old.value, old.unit);
  const y = normaliseValue(now.value, now.unit);
  // A unit the model left out of the value is taken from its sentence ("60" in "… $60 per day" is USD).
  const unitOld = x.unit ?? normaliseValue(oldQuote).unit;
  const unitNow = y.unit ?? normaliseValue(now.quote).unit;
  const q0 = normaliseValue(oldQuote);
  const q1 = normaliseValue(now.quote);
  // The value's number sits at the same place in both sentences ("$60 … 30 days" → "$30 … 60 days" moved it, even
  // when the model repeats "60").
  const p0 = x.numbers[0] === undefined ? -1 : q0.numbers.indexOf(x.numbers[0]);
  const p1 = y.numbers[0] === undefined ? -1 : q1.numbers.indexOf(y.numbers[0]);
  const placeOk = p0 === p1;
  // Same value: only a number found in both sentences at another place blocks it (not found = no evidence).
  if (negationOk && (placeOk || p0 < 0 || p1 < 0) && sameValue(old, now) && sameUnit(unitOld, unitNow)) return false;
  if (parseDate(old.value) !== undefined || parseDate(now.value) !== undefined) return !sameValue(old, now);
  if (!negationOk) return true;
  if (!/\d/.test(old.value)) return !valueWordsIn(old.value, now.quote);
  const w0 = words(oldQuote);
  const w1 = words(now.quote);
  if (sameNumbers(q0.numbers, q1.numbers) && sameUnit(q0.unit, q1.unit) && w0.size === w1.size && allIn(w0, w1)) return false;
  const wordsOk = allIn(valueWords(old.value, old.unit), w1) && allIn(valueWords(now.value, now.unit), w0);
  return !(sameNumbers(x.numbers, y.numbers) && sameUnit(unitOld, unitNow) && wordsOk && placeOk && p0 >= 0);
}

/**
 * Like `planMerge`, except for confirmed facts: a different value or unit (also on a reviewer-edited fact) becomes a
 * `FactChange` and the row is left untouched until the owner confirms; nothing is ever removed.
 */
export function planDiff(
  /** With the stored sentence when known (`factChanged` compares sentences, not only the model's value). */
  existing: readonly (StoredFact & { quote?: string | null })[],
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
      if (factChanged(old, u.fact)) {
        changes.push({ factId: old.id, oldValue: old.value, oldUnit: old.unit, newValue: u.fact.value, newUnit: u.fact.unit, newQuote: u.fact.quote, version, versionAt });
        continue;
      }
      // Same value written differently ("$60" / "60 USD", reworded value): refresh only, the stored value stays.
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

/**
 * A confirmed change that only reworded the value, judged conservatively because the old sentence is not stored with
 * the change (undoing a real confirmation is worse than keeping a wording-only one). All of:
 * - no date on either side, and no negation word in the new value or sentence;
 * - every word of the old value is in the new value and in the new sentence ("economy class" → "economy class for
 *   flights under 6 hours");
 * - values with digits: the same numbers in the same order and the same unit, also when only one side writes one
 *   ("60" → "60 days" is a real change).
 */
export function wordingOnlyChange(c: Pick<FactChange, 'oldValue' | 'oldUnit' | 'newValue' | 'newUnit' | 'newQuote'>): boolean {
  if (parseDate(c.oldValue) !== undefined || parseDate(c.newValue) !== undefined) return false;
  if (negations(c.newValue) > 0 || negations(c.newQuote) > 0 || negations(c.oldValue) > 0) return false;
  const oldWords = /\d/.test(c.oldValue) ? valueWords(c.oldValue, c.oldUnit) : [...words(c.oldValue)];
  const newValueWords = new Set([...words(c.newValue), ...valueWords(c.newValue, c.newUnit)]);
  if (!allIn(oldWords, newValueWords) || !allIn(oldWords, words(c.newQuote))) return false;
  if (!/\d/.test(c.oldValue)) return oldWords.length > 0;
  // A qualifier or rate period the new value adds is a real change ("30 days" → "30 business days").
  const oldAll = new Set([...words(`${c.oldValue} ${c.oldUnit ?? ''}`)]);
  if ([...words(`${c.newValue} ${c.newUnit ?? ''}`)].some((w) => QUALIFIERS.has(w) && !oldAll.has(w))) return false;
  if (ratePeriod(`${c.oldValue} ${c.oldUnit ?? ''}`) !== ratePeriod(`${c.newValue} ${c.newUnit ?? ''}`)) return false;
  const x = normaliseValue(c.oldValue, c.oldUnit);
  const y = normaliseValue(c.newValue, c.newUnit);
  return sameNumbers(x.numbers, y.numbers) && sameUnit(x.unit, y.unit);
}

export interface WordingRevert {
  changeId: string;
  change: FactChange;
  /** Copies the confirmation set to drifted for this fact (only those still drifted for that reason are restored). */
  copyIds: string[];
}

/**
 * Facts whose latest confirmed change (`confirmed` newest first) was wording only: their old value is restored. Only
 * the latest confirmed change of a fact counts; the change rows and their audit stay.
 */
export function wordingOnlyReverts(confirmed: readonly { id: string; factChanges: readonly FactChange[]; impact: ChangeImpact | null }[]): WordingRevert[] {
  const seen = new Set<string>();
  const out: WordingRevert[] = [];
  for (const row of confirmed) {
    for (const c of row.factChanges) {
      if (seen.has(c.factId)) continue;
      seen.add(c.factId);
      if (!wordingOnlyChange(c)) continue;
      const copyIds = (row.impact?.copies ?? []).filter((k) => k.factId === c.factId && k.status === 'in_sync').map((k) => k.copyId);
      out.push({ changeId: row.id, change: c, copyIds });
    }
  }
  return out;
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
/** Subject/attribute/condition word similarity above which a proposed fact of the same sentence is the same fact. */
const DUPLICATE_KEY_MATCH = 0.5;

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
  // Confirmed facts read in this version (stored and current wording). A proposed fact duplicates one only when it
  // has its sentence AND is the same fact: the same value (stored or read now), or the same condition with similar
  // subject/attribute words. Sibling facts of one sentence (domestic $60 / international $90) stay.
  const confirmedRead = [...assigned].filter(([, k]) => k.status === 'confirmed').map(([i, k]) => ({ k, e: extracted[i] }));
  const sameFact = (p: KnownFact, k: KnownFact, e: ExtractedFact | undefined): boolean =>
    sameValue(p, k) || (e !== undefined && sameValue(p, e)) || (sameText(p.condition, k.condition) && jaccard(keyWords(p), keyWords(k)) >= DUPLICATE_KEY_MATCH);
  const duplicates = known
    .filter(
      (p) =>
        p.status === 'proposed' &&
        !p.edited &&
        !taken.has(p.id) &&
        confirmedRead.some(({ k, e }) => (quoteSimilarity(k.quote, p.quote) >= QUOTE_MATCH || (e !== undefined && quoteSimilarity(e.quote, p.quote) >= QUOTE_MATCH)) && sameFact(p, k, e)),
    )
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
  /** `updated`: Ripple applied an earlier change there; compared again with this change like an in-sync copy. */
  status: 'in_sync' | 'drifted' | 'updated';
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
    else if (copy.status === 'in_sync' || copy.status === 'drifted' || copy.status === 'updated') {
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

/** Working-day deadlines live in `./deadline` (shared with the Custom UI); re-exported for existing callers. */
export { addWorkingDays } from './deadline';
