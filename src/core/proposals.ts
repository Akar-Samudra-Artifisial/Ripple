/**
 * M4: the new sentence of a copy (FR-8). A deterministic number swap first; the model rewrites the sentence only when
 * that is not possible, and every rewrite (model or user) is validated before it can reach a page.
 */
import { sameNegation } from './changes';
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

/** Removes each word of `remove` once from `words`. */
function without(words: readonly string[], remove: readonly string[]): string[] {
  const out = [...words];
  for (const w of remove) {
    const i = out.indexOf(w);
    if (i >= 0) out.splice(i, 1);
  }
  return out;
}

/**
 * A new sentence is acceptable when the new value is in it and the old one is gone. `strict` (any generated
 * sentence) also requires the same negations and the same words apart from numbers, units and the value words, so a
 * rewrite cannot change anything else. A sentence the user typed only needs the value check.
 */
export function validateRewrite(oldSentence: string, newSentence: string, oldValue: ValueText, newValue: ValueText, strict: boolean): boolean {
  const s = newSentence.trim();
  if (s === '' || s.length > 2000 || /[<>]/.test(s) || /[\r\n]/.test(s)) return false;
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
  const a = without(plainWords(oldSentence), valueWordList(oldValue));
  const b = without(plainWords(s), valueWordList(newValue));
  return a.length === b.length && a.every((w, i) => w === b[i]);
}
