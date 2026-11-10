/**
 * M4: the new sentence of a copy (FR-8). A deterministic number swap first; the model rewrites the sentence only when
 * that is not possible, and every rewrite (model or user) is validated before it can reach a page.
 */
import { ratePeriod, sameNegation } from './changes';
import { normaliseValue, numbersIn } from './copies';
import { normaliseKeyPart } from './facts';

export type ProposalStatus = 'proposed' | 'approved' | 'applied' | 'rejected' | 'stale' | 'needs_manual' | 'failed';
export type ProposalMethod = 'token' | 'llm';
export const PROPOSAL_ERROR_CODES = [
  'quote_not_found',
  'sentence_ambiguous',
  'value_ambiguous',
  'value_not_found',
  'crosses_markup',
  'validation_failed',
  'llm_failed',
  'page_not_readable',
  'forbidden',
  'not_found',
  'conflict',
  'version_changed',
  'http_error',
  // Rejected without a user decision: a newer confirmed change replaced the value, or the confirmation was undone.
  'superseded',
  'reverted',
] as const;
export type ProposalErrorCode = (typeof PROPOSAL_ERROR_CODES)[number];

/** Codes where the text cannot be replaced safely (the copy needs a manual edit), as opposed to a failure. */
export const MANUAL_CODES: ReadonlySet<ProposalErrorCode> = new Set(['quote_not_found', 'sentence_ambiguous', 'value_ambiguous', 'value_not_found', 'crosses_markup']);

export interface ValueText {
  value: string;
  unit: string | null;
}

const NUMBER_TOKEN = /\d{1,3}(?:[.,]\d{3})+(?!\d)|\d+(?:[.,]\d+)?/g;

const parseToken = (raw: string): number => (/^\d{1,3}(?:[.,]\d{3})+$/.test(raw) ? Number(raw.replace(/[.,]/g, '')) : Number(raw.replace(',', '.')));

/** `n` written like `like` ("2,000" → "2,500"; "2.000" → "2.500"; "1,5" → "2,5"). */
function formatLike(n: number, like: string): string {
  const grouped = /^\d{1,3}([.,])\d{3}/.exec(like);
  if (grouped && Number.isInteger(n) && n >= 1000) {
    const en = n.toLocaleString('en-US');
    return grouped[1] === '.' ? en.replace(/,/g, '.') : en;
  }
  const s = String(n);
  return /^\d+,\d+$/.test(like) ? s.replace('.', ',') : s;
}

/** Unit of a value, or of the sentence when the value names none. */
const unitOf = (v: ValueText, sentence: string): string | null => normaliseValue(v.value, v.unit).unit ?? normaliseValue(sentence).unit;

/**
 * Swaps the one number of the old value for the one number of the new value, written in the same style, when the
 * unit stays the same and the old number occurs exactly once in the sentence. Undefined otherwise (model rewrite).
 */
export function replaceValueToken(sentence: string, oldValue: ValueText, newValue: ValueText): string | undefined {
  const oldNums = normaliseValue(oldValue.value, oldValue.unit).numbers;
  const newNums = normaliseValue(newValue.value, newValue.unit).numbers;
  if (oldNums.length !== 1 || newNums.length !== 1) return undefined;
  const oldUnit = unitOf(oldValue, sentence);
  const newUnit = normaliseValue(newValue.value, newValue.unit).unit ?? oldUnit;
  if (oldUnit !== newUnit) return undefined;
  const hits = [...sentence.matchAll(NUMBER_TOKEN)].filter((m) => parseToken(m[0]) === oldNums[0]);
  if (hits.length !== 1) return undefined;
  const hit = hits[0] as RegExpMatchArray;
  const at = hit.index as number;
  return `${sentence.slice(0, at)}${formatLike(newNums[0] as number, hit[0])}${sentence.slice(at + hit[0].length)}`;
}

const count = (list: readonly number[], n: number): number => list.filter((x) => x === n).length;

const isUnitWord = (w: string): boolean => normaliseValue(w).unit !== null;

/** Sentence words without numbers, currency symbols and unit words. */
const plainWords = (s: string): string[] =>
  normaliseKeyPart(s.replace(/[$€£%]/g, ' '))
    .split(' ')
    .filter((w) => w !== '' && !/\d/.test(w) && !isUnitWord(w));

const valueWordList = (v: ValueText): string[] => plainWords(v.value);

/** Removes each item of `remove` once from `items`. */
function without<T>(items: readonly T[], remove: readonly T[]): T[] {
  const out = [...items];
  for (const w of remove) {
    const i = out.indexOf(w);
    if (i >= 0) out.splice(i, 1);
  }
  return out;
}

const sameMultiset = <T>(a: readonly T[], b: readonly T[]): boolean => a.length === b.length && without(a, b).length === 0;

/** Canonical units written in a text, in order ("$60 per day" → [USD, days]; "sixty dollars" → [USD]). */
const unitTokens = (s: string): string[] =>
  normaliseKeyPart(s.replace(/\$/g, ' usd ').replace(/€/g, ' eur ').replace(/£/g, ' gbp ').replace(/%/g, ' percent '))
    .split(' ')
    .filter((w) => w !== '')
    .flatMap((w) => {
      const unit = normaliseValue(w).unit;
      return unit === null ? [] : [unit];
    });

/** XML 1.0 forbids these in a page body (C0 controls other than tab/CR/LF, U+FFFE/U+FFFF, lone surrogates). */
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Longest sentence accepted from the model or the user. */
export const MAX_SENTENCE_CHARS = 2000;

/**
 * A new sentence is acceptable when the new value is in it and the old one is gone. `strict` (any generated
 * sentence) also requires the same negations and the same words apart from numbers, units and the value words, so a
 * rewrite cannot change anything else. A sentence the user typed only needs the value check.
 */
export function validateRewrite(oldSentence: string, newSentence: string, oldValue: ValueText, newValue: ValueText, strict: boolean): boolean {
  if (newSentence.length > MAX_SENTENCE_CHARS) return false;
  const s = newSentence.trim();
  if (s === '' || /[<>]/.test(s) || /[\r\n]/.test(s) || XML_INVALID.test(s)) return false;
  if (normaliseKeyPart(s) === normaliseKeyPart(oldSentence)) return false;
  const oldNums = normaliseValue(oldValue.value, oldValue.unit).numbers;
  const newNums = normaliseValue(newValue.value, newValue.unit).numbers;
  const before = numbersIn(oldSentence);
  const after = numbersIn(s);
  if (newNums.length > 0) {
    if (!newNums.every((n) => count(after, n) >= 1)) return false;
  } else {
    const need = valueWordList(newValue);
    const have = new Set(plainWords(s));
    if (need.length === 0 || !need.every((w) => have.has(w))) return false;
  }
  if (oldNums.length > 0) {
    // Gone: the old number occurs less often than before (unless the new value states it too).
    if (!oldNums.every((n) => newNums.includes(n) || count(after, n) === 0 || count(after, n) < count(before, n))) return false;
  } else {
    const gone = valueWordList(oldValue).filter((w) => !valueWordList(newValue).includes(w));
    const have = new Set(plainWords(s));
    if (gone.length === 0 || gone.every((w) => have.has(w))) return false;
  }
  if (!strict) return true;
  if (!sameNegation(oldSentence, s)) return false;
  // Every other number stays: the numbers besides the value are the same multiset before and after.
  if (!sameMultiset(without(after, newNums), without(before, oldNums))) return false;
  // Units and rate periods besides the value's own stay ("per day" never becomes "per week" in passing).
  const valueUnits = [...unitTokens(`${oldValue.value} ${oldValue.unit ?? ''}`), ...unitTokens(`${newValue.value} ${newValue.unit ?? ''}`)];
  if (!sameMultiset(without(unitTokens(s), valueUnits), without(unitTokens(oldSentence), valueUnits))) return false;
  const valuePeriodChanged = ratePeriod(`${oldValue.value} ${oldValue.unit ?? ''}`) !== ratePeriod(`${newValue.value} ${newValue.unit ?? ''}`);
  if (!valuePeriodChanged && ratePeriod(s) !== ratePeriod(oldSentence)) return false;
  // The value's own words. When value plus unit carry the same words on both sides ("$60 per day" stated as one
  // value, "$75" with unit "per day"), exactly that list is removed from both sentences, so no other word can change.
  const unitWords = (v: ValueText): string[] => [...new Set(plainWords(`${v.value} ${v.unit ?? ''}`))];
  const [oldWords, newWords] = sameMultiset(unitWords(oldValue), unitWords(newValue)) ? [unitWords(oldValue), unitWords(newValue)] : [valueWordList(oldValue), valueWordList(newValue)];
  const a = without(plainWords(oldSentence), oldWords);
  const b = without(plainWords(s), newWords);
  return a.length === b.length && a.every((w, i) => w === b[i]);
}
