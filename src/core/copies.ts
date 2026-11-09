/**
 * Copy search and judging rules (PRD "Aturan bisnis 2. Pencarian salinan" and "3. Penentuan status"), pure so they
 * can be tested without Forge: search terms and CQL per fact, chunks of a candidate page that mention a fact, value
 * normalisation, validation of the untrusted judge output (verbatim quote) and the status of each copy.
 */
import { FIELD_LIMITS, MIN_QUOTE_CHARS, normaliseKeyPart, quoteInText, valueInQuote } from './facts';
import type { CopyStatus, FactType } from './views';

/** PRD: at most 200 candidate pages per fact, by relevance. */
export const MAX_CANDIDATES_PER_FACT = 200;
/** Chunks sent to the judge per candidate page (highest scoring first). */
export const MAX_CHUNKS_PER_PAGE = 6;
export const MAX_CHUNK_CHARS = 1200;
/** Extra search phrases per fact (LLM synonyms). */
export const MAX_TERMS_PER_FACT = 4;
export const MAX_TERM_CHARS = 60;
/** Candidate page text read for chunking (much more than the source's LLM limit: only chunks go to the LLM). */
export const MAX_COPY_PAGE_CHARS = 100_000;

/** A confirmed fact of the source, as the scan needs it. */
export interface ScanFact {
  id: string;
  type: FactType;
  subject: string;
  attribute: string;
  value: string;
  unit: string | null;
  condition: string | null;
  previousValue: string | null;
  /** Position among the source's facts (extraction order); absent = position in the scan's fact list. */
  order?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Search terms and CQL
// ---------------------------------------------------------------------------------------------------------------

/** Words that say nothing about which fact a sentence states. */
const STOPWORDS = new Set(
  'the and for with from that this these those into onto per are was were has have had not all any each its our your their than then when what which who will shall must may can should about after before over under within between amount value number rate limit policy'.split(
    ' ',
  ),
);

/**
 * Letters, digits, spaces and `$ % . , -` only, so a term can never break out of a CQL string. A term without any
 * letter or digit ("--", "$ %") is empty: it would match everything or break the CQL parser.
 */
export function cleanTerm(term: string): string {
  const clean = term
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}$%., -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TERM_CHARS)
    .trim();
  return /[\p{L}\p{N}]/u.test(clean) ? clean : '';
}

export interface FactTerms {
  /** Phrases searched as exact phrases (subject and synonyms). */
  phrases: string[];
  /** Numbers of the current and previous value ("60", "2000"). */
  numbers: string[];
  /** Distinct words of the phrases, used to find chunks. */
  keywords: string[];
  /**
   * Word groups searched in any order or wording, each group's words all required (one CQL `AND` clause): the
   * distinctive words of the subject and of each synonym, two at a time when there are three. Never the value, so a
   * copy with a different value (drift) is found by what it is about: "Expense claim deadline" → [expense, claim],
   * [expense, deadline], [claim, deadline]; "Travel per diem" → [diem].
   */
  wordGroups: string[][];
}

/** Subject words too common to narrow a search on their own (a site's every page about travel says "travel"). */
const GENERIC_SEARCH_WORDS = new Set(['travel', 'trip', 'trips', 'policy', 'policies', 'company', 'employee', 'employees', 'staff', 'team', 'general', 'rule', 'rules', 'process', 'guide']);
const MAX_GROUP_SOURCE_WORDS = 3;
const MAX_WORD_GROUPS = 8;

const distinctiveWordsOf = (term: string): string[] =>
  [...new Set(normaliseKeyPart(cleanTerm(term)).split(' '))]
    .filter((w) => w.length >= 3 && /^[\p{L}\p{N}]+$/u.test(w) && !/^\d+$/.test(w) && !STOPWORDS.has(w) && !GENERIC_SEARCH_WORDS.has(w))
    .slice(0, MAX_GROUP_SOURCE_WORDS);

/** One group of up to two words, or every pair of three (a page may word one of the three differently). */
const groupsOf = (words: readonly string[]): string[][] => {
  if (words.length < 3) return words.length > 0 ? [[...words]] : [];
  const out: string[][] = [];
  for (let i = 0; i < words.length; i++) for (let k = i + 1; k < words.length; k++) out.push([words[i] as string, words[k] as string]);
  return out;
};

function wordGroupsOf(terms: readonly string[]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const g of terms.flatMap((t) => groupsOf(distinctiveWordsOf(t)))) {
    const key = [...g].sort().join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out.slice(0, MAX_WORD_GROUPS);
}

/** Numbers written in `text`, with thousands separators of either style ("2,000", "2.000" → 2000). */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d{1,3}(?:[.,]\d{3})+(?!\d)|\d+(?:[.,]\d+)?/g)) {
    const raw = m[0];
    const grouped = /^\d{1,3}(?:[.,]\d{3})+$/.test(raw);
    const n = grouped ? Number(raw.replace(/[.,]/g, '')) : Number(raw.replace(',', '.'));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const keywordsOf = (phrases: readonly string[]): string[] => [
  ...new Set(
    phrases
      .flatMap((p) => normaliseKeyPart(p).split(' '))
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)),
  ),
];

/** Search terms of a fact: its subject, the extra phrases (LLM synonyms) and the numbers of its current/previous value. */
export function factTerms(fact: ScanFact, extra: readonly string[] = []): FactTerms {
  const phrases: string[] = [];
  for (const p of [fact.subject, ...extra.slice(0, MAX_TERMS_PER_FACT)]) {
    const t = cleanTerm(p);
    if (t.length >= 3 && !phrases.some((x) => x.toLowerCase() === t.toLowerCase())) phrases.push(t);
  }
  const numbers = [...new Set([...numbersIn(fact.value), ...numbersIn(fact.previousValue ?? '')].map(String))];
  return { phrases, numbers, keywords: keywordsOf([...phrases, fact.attribute]), wordGroups: wordGroupsOf(phrases) };
}

/**
 * CQL for the candidates of one fact: current pages (archived pages are not returned by default) other than the
 * source, without the `ripple-ignore` label, that contain a phrase of the fact, all words of one of its word groups
 * or one of its numbers. Results come
 * back by relevance, so the first 200 are the best candidates.
 */
export function buildCql(sourcePageId: string, terms: FactTerms): string {
  if (!/^\d{1,32}$/.test(sourcePageId)) throw new Error('invalid source page id');
  const clauses = [
    ...terms.phrases.map((p) => `text ~ "\\"${p}\\""`),
    // Distinctive words of the subject/synonyms in any order or wording, without the value (finds drifted copies).
    ...terms.wordGroups.map((g) => (g.length > 1 ? `(${g.map((w) => `text ~ "${w}"`).join(' AND ')})` : `text ~ "${g[0]}"`)),
    // Bare numbers of 3+ digits only: "60" alone matches too many pages to help relevance. 4+ digits also as
    // written with a thousands separator ("2,000"), which the index keeps as one token.
    ...terms.numbers
      .filter((n) => n.length >= 3)
      .flatMap((n) => (/^\d{4,}$/.test(n) ? [n, Number(n).toLocaleString('en-US')] : [n]))
      .map((n) => `text ~ "${n}"`),
  ];
  if (clauses.length === 0) throw new Error('fact has no search terms');
  return `type = page AND id != ${sourcePageId} AND label != "ripple-ignore" AND (${clauses.join(' OR ')})`;
}

/** Validates the LLM's synonym suggestions: `{ facts: [{ fact: n, terms: [...] }] }` → fact id → terms. */
export function parseTermSuggestions(args: unknown, factIds: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const list = (args as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const { fact, terms } = (item ?? {}) as { fact?: unknown; terms?: unknown };
    const id = typeof fact === 'number' && Number.isInteger(fact) ? factIds[fact - 1] : undefined;
    if (!id || !Array.isArray(terms)) continue;
    const clean = terms.filter((t): t is string => typeof t === 'string').map(cleanTerm).filter((t) => t.length >= 3);
    out[id] = [...new Set(clean)].slice(0, MAX_TERMS_PER_FACT);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------------------------------------------

export interface Chunk {
  /** First line of the chunk among the page's non-blank lines, for logs only. */
  firstLine: number;
  text: string;
  /** Facts whose terms appear in the chunk (only these are judged against it). */
  factIds: string[];
  score: number;
}

/** How strongly a line points at a fact: phrase 3, keyword 1 each, a number of the fact 1. 0 = no mention. */
function lineScore(line: string, terms: FactTerms): number {
  const norm = ` ${normaliseKeyPart(line)} `;
  let score = 0;
  for (const p of terms.phrases) if (norm.includes(` ${normaliseKeyPart(p)} `)) score += 3;
  for (const k of terms.keywords) if (norm.includes(` ${k} `)) score += 1;
  const nums = new Set(numbersIn(line).map(String));
  if (terms.numbers.some((n) => nums.has(n))) score += 1;
  return score;
}

/**
 * Splits a candidate page (plain text, one paragraph / list item / table row per line) into chunks around lines that
 * mention a fact: the line, two lines before (heading or "Changelog" context) and one after, merged when they
 * overlap and cut at `MAX_CHUNK_CHARS`. Keeps the `max` best scoring chunks, in page order.
 */
export function chunkPage(text: string, facts: readonly { id: string; terms: FactTerms }[], max = MAX_CHUNKS_PER_PAGE): Chunk[] {
  // Blank lines carry no context; dropping them keeps the "2 lines before" a heading or sentence.
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const hits = new Map<number, { factIds: Set<string>; score: number }>();
  lines.forEach((line, i) => {
    for (const f of facts) {
      const s = lineScore(line, f.terms);
      if (s === 0) continue;
      const h = hits.get(i) ?? { factIds: new Set<string>(), score: 0 };
      h.factIds.add(f.id);
      h.score += s;
      hits.set(i, h);
    }
  });
  const chunks: Chunk[] = [];
  let current: { from: number; to: number; factIds: Set<string>; score: number } | undefined;
  const flush = () => {
    if (!current) return;
    const body = lines.slice(current.from, current.to + 1).join('\n').trim();
    if (body) chunks.push({ firstLine: current.from, text: body.slice(0, MAX_CHUNK_CHARS), factIds: [...current.factIds], score: current.score });
    current = undefined;
  };
  const size = (from: number, to: number) => lines.slice(from, to + 1).join('\n').length;
  for (const [i, h] of [...hits.entries()].sort((a, b) => a[0] - b[0])) {
    const from = Math.max(0, i - 2);
    const to = Math.min(lines.length - 1, i + 1);
    if (current && from <= current.to + 1 && size(current.from, to) <= MAX_CHUNK_CHARS) {
      current.to = Math.max(current.to, to);
      h.factIds.forEach((id) => current?.factIds.add(id));
      current.score += h.score;
      continue;
    }
    flush();
    current = { from, to, factIds: new Set(h.factIds), score: h.score };
  }
  flush();
  return chunks
    .map((c, order) => ({ c, order }))
    .sort((a, b) => b.c.score - a.c.score || a.order - b.order)
    .slice(0, max)
    .sort((a, b) => a.order - b.order)
    .map((x) => x.c);
}

// ---------------------------------------------------------------------------------------------------------------
// Value normalisation
// ---------------------------------------------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const MULTIPLIERS: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };

/** "two thousand", "forty-five", "sixty" → number; undefined when the text has no number words. */
function wordsToNumber(text: string): number | undefined {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of text.toLowerCase().split(/[\s-]+/)) {
    if (w in NUMBER_WORDS) {
      current += NUMBER_WORDS[w] ?? 0;
      seen = true;
    } else if (w in MULTIPLIERS && seen) {
      const m = MULTIPLIERS[w] ?? 1;
      if (m >= 1000) {
        total += (current || 1) * m;
        current = 0;
      } else current = (current || 1) * m;
    } else if (seen && w !== 'and') break;
  }
  return seen ? total + current : undefined;
}

const UNIT_PATTERNS: [RegExp, string][] = [
  [/(?:us\$|\$|\busd\b|\bdollars?\b)/i, 'USD'],
  [/(?:€|\beur\b|\beuros?\b)/i, 'EUR'],
  [/(?:£|\bgbp\b|\bpounds?\b)/i, 'GBP'],
  [/(?:\brp\b|\bidr\b|\brupiah\b)/i, 'IDR'],
  [/(?:%|\bpercent\b|\bper cent\b|\bpersen\b)/i, '%'],
  [/\b(?:days?|hari)\b/i, 'days'],
  [/\b(?:weeks?|minggu)\b/i, 'weeks'],
  [/\b(?:months?|bulan)\b/i, 'months'],
  [/\b(?:hours?|hrs?|jam)\b/i, 'hours'],
  [/\b(?:years?|tahun)\b/i, 'years'],
];

const UNIT_WORDS = /\b(?:us|usd|dollars?|eur|euros?|gbp|pounds?|rp|idr|rupiah|percent|per cent|persen|days?|hari|weeks?|minggu|months?|bulan|hours?|hrs?|jam|years?|tahun)\b/gi;

export interface NormalisedValue {
  numbers: number[];
  /** Canonical unit ("USD", "days", "%"), or null when none is written. */
  unit: string | null;
  /** Remaining words (3+ characters, no unit or number words), for non-numeric values. */
  words: string[];
}

/** Canonical unit of `text`; "per day" / "per trip" is a rate, not the unit ("$60 per day" → USD, "60 per day" → none). */
const canonicalUnit = (text: string): string | null => {
  const withoutRate = text.replace(/\bper\s+(?!cent\b)\p{L}+/giu, ' ');
  return UNIT_PATTERNS.find(([re]) => re.test(withoutRate))?.[1] ?? null;
};

/**
 * "$60", "60 USD", "USD 60", "sixty dollars" → { numbers: [60], unit: 'USD' }; "1.000" and "1,000" → 1000;
 * "30 hari" and "30 days" → days. `unit` (the fact's unit column) is used when the value itself has none.
 */
export function normaliseValue(value: string, unit: string | null = null): NormalisedValue {
  const text = value.normalize('NFKC');
  let numbers = numbersIn(text);
  const k = /(\d+(?:[.,]\d+)?)\s*k\b/i.exec(text);
  if (k?.[1]) numbers = [Number(k[1].replace(',', '.')) * 1000];
  if (numbers.length === 0) {
    const fromWords = wordsToNumber(text);
    if (fromWords !== undefined) numbers = [fromWords];
  }
  const words = normaliseKeyPart(text.replace(UNIT_WORDS, ' '))
    .split(' ')
    .filter((w) => w.length >= 3 && !(w in NUMBER_WORDS) && !(w in MULTIPLIERS) && !/^\d/.test(w) && !STOPWORDS.has(w));
  return { numbers, unit: canonicalUnit(text) ?? (unit ? canonicalUnit(unit) : null), words };
}

export type ValueComparison = 'same' | 'different' | 'unknown';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8, agu: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, des: 12,
};

const isoDate = (y: number, m: number, d: number): string | undefined =>
  m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : undefined;

/**
 * Simple date parsing: "2026-01-15", "15/01/2026", "15.01.2026", "January 15, 2026", "15 Jan 2026" → "2026-01-15".
 * `ambiguous` for "03/04/2026" (day/month order unknown); undefined when the text has no full date.
 */
export function parseDate(text: string): string | 'ambiguous' | undefined {
  const t = text.toLowerCase();
  let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(t);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    if (a > 12) return isoDate(y, b, a);
    if (b > 12 || a === b) return isoDate(y, a, b);
    return 'ambiguous';
  }
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(\p{L}{3,})\.?,?\s+(\d{4})\b/u.exec(t);
  const dayFirst = m && MONTHS[m[2]?.slice(0, 3) ?? ''];
  if (m && dayFirst) return isoDate(Number(m[3]), dayFirst, Number(m[1]));
  m = /\b(\p{L}{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/u.exec(t);
  const monthFirst = m && MONTHS[m[1]?.slice(0, 3) ?? ''];
  if (m && monthFirst) return isoDate(Number(m[3]), monthFirst, Number(m[2]));
  return undefined;
}

/** Factor to turn a number in `from` into `to`; only cheap, exact conversions (weeks ↔ days). */
const UNIT_FACTORS: Record<string, number> = { 'weeks>days': 7, 'days>weeks': 1 / 7 };

/**
 * Compares a stated value with the official one after normalisation.
 * - Dates: both must parse to the same day; a date that cannot be parsed (or is ambiguous) → `unknown`.
 * - Numbers: `same` when every official number is among the stated ones ("$60 per day (max 3 days)"); `different`
 *   only when the stated value has no extra numbers; otherwise `unknown`. Different units are converted when cheap
 *   (2 weeks = 14 days); other unit mismatches (USD vs EUR) → `unknown`.
 * - Text: same words, or one contains the other ("economy" ≈ "economy class").
 * `unknown` = cannot be compared reliably; the PRD drops such candidates.
 */
export function compareValues(official: { value: string; unit: string | null }, stated: { value: string; unit: string | null }): ValueComparison {
  const od = parseDate(official.value);
  const sd = parseDate(stated.value);
  if (od !== undefined || sd !== undefined) {
    if (od === undefined || sd === undefined || od === 'ambiguous' || sd === 'ambiguous') {
      return normaliseKeyPart(official.value) === normaliseKeyPart(stated.value) ? 'same' : 'unknown';
    }
    return od === sd ? 'same' : 'different';
  }
  const o = normaliseValue(official.value, official.unit);
  const s = normaliseValue(stated.value, stated.unit);
  if (o.numbers.length > 0) {
    if (s.numbers.length === 0) return 'unknown';
    let statedNumbers = s.numbers;
    if (o.unit && s.unit && o.unit !== s.unit) {
      const factor = UNIT_FACTORS[`${s.unit}>${o.unit}`];
      if (factor === undefined) return 'unknown';
      statedNumbers = s.numbers.map((n) => Math.round(n * factor * 1000) / 1000);
    }
    if (o.numbers.every((n) => statedNumbers.includes(n))) return 'same';
    return s.numbers.length <= o.numbers.length ? 'different' : 'unknown';
  }
  if (o.words.length === 0 || s.words.length === 0) return 'unknown';
  const ow = new Set(o.words);
  const sw = new Set(s.words);
  return [...sw].every((w) => ow.has(w)) || [...ow].every((w) => sw.has(w)) ? 'same' : 'different';
}

/** Display form of a value with its unit ("45 days", "$60"). */
export const valueLabel = (value: string, unit: string | null): string => (unit && !value.toLowerCase().includes(unit.toLowerCase()) ? `${value} ${unit}` : value);

// ---------------------------------------------------------------------------------------------------------------
// Judge output
// ---------------------------------------------------------------------------------------------------------------

export type SameFact = 'yes' | 'no' | 'unsure';
export type Mention = 'current' | 'historical' | 'example';

export interface Judgement {
  factId: string;
  sameFact: SameFact;
  mention: Mention;
  statedValue: string;
  statedUnit: string | null;
  statedCondition: string | null;
  /** Verified to appear verbatim in the chunk (and so in the copy page). */
  quote: string;
  /** The judge's fixed reason code (`other` when outside the enum); absent in results saved before it existed. */
  reasonCode?: ReasonCode;
}

/** Fixed reason codes of the judge's `reason_code` field; the only judge wording ever logged. */
export const JUDGE_REASON_CODES = ['no_mention', 'value_matches', 'value_differs', 'different_condition', 'sibling_fact', 'different_subject', 'historical', 'ambiguous'] as const;
export type ReasonCode = (typeof JUDGE_REASON_CODES)[number] | 'other';

export const parseReasonCode = (v: unknown): ReasonCode => JUDGE_REASON_CODES.find((x) => x === v) ?? 'other';

export type JudgeDropReason = 'invalid_shape' | 'unknown_fact' | 'quote_not_found' | 'value_not_in_quote' | 'duplicate_fact';

const SAME_FACT: readonly SameFact[] = ['yes', 'no', 'unsure'];
const MENTIONS: readonly Mention[] = ['current', 'historical', 'example'];

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max ? v.trim() : undefined);
const optStr = (v: unknown, max: number): string | null | undefined => (v === null || v === undefined || v === '' ? null : str(v, max));

/**
 * Validates the judge's `record_mentions` arguments for one chunk. `factIds[n-1]` is fact number `n` in the prompt.
 * Every kept judgement has a quote found verbatim in the chunk and a stated value written in that quote; the rest are
 * dropped (fake or paraphrased quotes never reach the copies table).
 */
export function parseJudgement(args: unknown, chunkText: string, factIds: readonly string[]): { judgements: Judgement[]; dropped: { index: number; reason: JudgeDropReason }[] } {
  const list = (args as { mentions?: unknown } | null)?.mentions;
  if (!Array.isArray(list)) throw new Error('judge output has no mentions array');
  const judgements: Judgement[] = [];
  const dropped: { index: number; reason: JudgeDropReason }[] = [];
  const seen = new Set<string>();
  list.forEach((raw, index) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    const factId = typeof m.fact === 'number' && Number.isInteger(m.fact) ? factIds[m.fact - 1] : undefined;
    const sameFact = SAME_FACT.find((x) => x === m.same_fact);
    const mention = MENTIONS.find((x) => x === m.mention);
    const statedValue = str(m.stated_value, FIELD_LIMITS.value);
    const statedUnit = optStr(m.stated_unit, FIELD_LIMITS.unit);
    const statedCondition = optStr(m.stated_condition, FIELD_LIMITS.condition);
    const quote = str(m.quote, FIELD_LIMITS.quote);
    if (!sameFact || !mention || !statedValue || statedUnit === undefined || statedCondition === undefined || !quote) {
      dropped.push({ index, reason: 'invalid_shape' });
      return;
    }
    if (!factId) {
      dropped.push({ index, reason: 'unknown_fact' });
      return;
    }
    if (quote.length < MIN_QUOTE_CHARS || !quoteInText(quote, chunkText)) {
      dropped.push({ index, reason: 'quote_not_found' });
      return;
    }
    // "sixty dollars" is grounded when written as-is; "60" when the number is in the quote.
    if (!quoteInText(statedValue, quote) && !valueInQuote('rule', statedValue, quote)) {
      dropped.push({ index, reason: 'value_not_in_quote' });
      return;
    }
    if (seen.has(factId)) {
      dropped.push({ index, reason: 'duplicate_fact' });
      return;
    }
    seen.add(factId);
    const reasonCode = parseReasonCode(m.reason_code);
    judgements.push(groundJudgement(reconcileReason({ factId, sameFact, mention, statedValue, statedUnit, statedCondition, quote, reasonCode }), chunkText));
  });
  return { judgements, dropped };
}

/**
 * Makes `same_fact`/`mention` agree with the more specific reason code (models often answer "no" because the value
 * differs, which is exactly drift):
 * - `value_differs` / `value_matches` with "no" → "yes" (same fact; the value is compared by Ripple, and the
 *   condition is still checked by `groundJudgement` / `sameCondition`);
 * - `different_condition` with "yes" → "unsure" (never in sync or drift); with "no" it stays "no" and
 *   `judgeOutcome` keeps it as unsure;
 * - `historical` → mention "historical" (a past value is never drift).
 */
function reconcileReason(j: Judgement): Judgement {
  const out = { ...j };
  if (out.sameFact === 'no' && out.mention === 'current' && (j.reasonCode === 'value_differs' || j.reasonCode === 'value_matches')) out.sameFact = 'yes';
  if (out.sameFact === 'yes' && j.reasonCode === 'different_condition') out.sameFact = 'unsure';
  if (j.reasonCode === 'historical' && out.mention === 'current') out.mention = 'historical';
  return out;
}

/** "from $50 to $60", "dari $50 menjadi $60": the number after "from" is the old value. */
const FROM_TO = /\b(?:from|dari)\s+(\S+(?:\s+\p{L}+)?)\s+(?:to|menjadi|ke)\b/giu;
/** "previously $50", "was $50", "used to be 50 days": the number right after the cue is a past value. */
const PAST_VALUE = /\b(?:previously|formerly|used to be|was|sebelumnya)\s+(?:\p{L}+\s+){0,2}?(\S*\d[\d.,]*)/giu;

/**
 * Checks the judge's reading against the quote itself (the LLM is not trusted):
 * - stated value is the old side of "from X to Y" → `historical`;
 * - stated value follows "previously" / "was" → `sameFact: unsure` (a past value is never drift);
 * - stated condition with no word in the excerpt (invented) → `sameFact: unsure`.
 */
function groundJudgement(j: Judgement, chunkText: string): Judgement {
  const stated = new Set(numbersIn(j.statedValue));
  const hasStated = (text: string | undefined) => stated.size > 0 && numbersIn(text ?? '').some((n) => stated.has(n));
  const out = { ...j };
  if (out.mention === 'current') {
    if ([...j.quote.matchAll(FROM_TO)].some((m) => hasStated(m[1]))) out.mention = 'historical';
    else if ([...j.quote.matchAll(PAST_VALUE)].some((m) => hasStated(m[1]))) out.sameFact = out.sameFact === 'no' ? 'no' : 'unsure';
  }
  if (out.statedCondition && out.sameFact === 'yes') {
    const chunk = ` ${normaliseKeyPart(chunkText)} `;
    const words = normaliseKeyPart(out.statedCondition)
      .split(' ')
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    if (words.length > 0 && !words.some((w) => chunk.includes(` ${w}`))) out.sameFact = 'unsure';
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------------------------

/** Wording of past values in changelogs and notes; a "drift" quote with one of these is only `unsure`. */
const HISTORICAL_CUE =
  /\b(?:previously|formerly|used to be|was (?:raised|increased|reduced|lowered|changed|updated)|(?:increased|raised|reduced|lowered|changed|went up|went down) from|until (?:19|20)\d\d|before (?:19|20)\d\d|in (?:19|20)\d\d (?:it|the)|last year|old (?:rate|value|policy|limit)|sebelumnya|dulu|naik dari|turun dari)\b/i;

/** Words of a condition that tell it apart (not words of the subject/attribute or filler). */
function distinctiveWords(condition: string, fact: ScanFact): string[] {
  const common = new Set([...normaliseKeyPart(`${fact.subject} ${fact.attribute}`).split(' '), 'travel', 'trip', 'trips', 'all', 'any']);
  const words = normaliseKeyPart(condition)
    .split(' ')
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const distinct = words.filter((w) => !common.has(w));
  return distinct.length > 0 ? distinct : words;
}

/** Words a condition may repeat without narrowing the fact ("after the trip ends" for a claims deadline). */
const CONDITION_FILLER = new Set(['travel', 'trip', 'trips', 'all', 'any', 'every', 'always', 'end', 'ends', 'employee', 'employees', 'staff', 'company']);

const stems = (w: string): string[] => [w, w.replace(/s$/, ''), `${w}s`];

/**
 * Same condition, or the copy states none. When both are stated: false when they share no distinctive word. When
 * the source fact has no condition: false when the copy narrows it to something new ("External training"), using
 * only words that are not already part of the fact.
 */
export function sameCondition(fact: ScanFact, statedCondition: string | null): boolean {
  if (!statedCondition) return true;
  if (!fact.condition) {
    const known = new Set(normaliseKeyPart(`${fact.subject} ${fact.attribute} ${fact.value} ${fact.unit ?? ''}`).split(' '));
    const extra = normaliseKeyPart(statedCondition)
      .split(' ')
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !CONDITION_FILLER.has(w) && !/^\d/.test(w) && !stems(w).some((x) => known.has(x)));
    return extra.length === 0;
  }
  const stated = new Set(normaliseKeyPart(statedCondition).split(' '));
  return distinctiveWords(fact.condition, fact).some((w) => stated.has(w) || stated.has(w.replace(/s$/, '')) || stated.has(`${w}s`));
}

export interface CopyDecision {
  status: CopyStatus;
  reason: string;
}

/**
 * PRD status table. `siblings` = other facts of the source with the same subject and attribute (e.g. the
 * international per diem when judging the domestic one): a copy without a condition whose value equals a sibling's is
 * `unsure`, not drift. Returns null when the mention is not a copy (not the same fact, an example, or a value that
 * cannot be compared).
 */
export function decideStatus(fact: ScanFact, j: Judgement, siblings: readonly ScanFact[] = []): CopyDecision | null {
  return judgeOutcome(fact, j, siblings).decision;
}

/** Why a judged mention is not a copy (for logs). */
export type NotCopyReason = 'not_same_fact' | 'example' | 'value_not_comparable' | 'sibling_fact';

/**
 * True when the mention belongs to another fact of the same source with the same subject and attribute (a sibling,
 * e.g. the domestic per diem when judging the international one): the stated condition is the sibling's, not this
 * fact's. Sibling mentions are no copy of this fact; only a condition the source does not cover is "different".
 */
function isSiblingMention(fact: ScanFact, j: Judgement, siblings: readonly ScanFact[]): boolean {
  // The judge's own "sibling_fact" counts only when the source really has a sibling (see `judgeOutcome` otherwise).
  if (j.reasonCode === 'sibling_fact') return siblings.some((s) => s.id !== fact.id);
  if (!j.statedCondition || sameCondition(fact, j.statedCondition)) return false;
  return siblings.some((s) => s.id !== fact.id && s.condition !== null && sameCondition(s, j.statedCondition));
}

/**
 * `decideStatus` plus the reason when the mention is not a copy. The judge is told to answer "no" for a different
 * condition (e.g. per diem for external training vs domestic travel); such a current mention with a comparable value
 * is still reported as `unsure` (PRD: different condition → unsure), only an unrelated "no" is dropped.
 */
export function judgeOutcome(fact: ScanFact, judged: Judgement, siblings: readonly ScanFact[] = []): { decision: CopyDecision | null; reason?: NotCopyReason } {
  if (judged.mention === 'example') return { decision: null, reason: 'example' };
  if (isSiblingMention(fact, judged, siblings)) return { decision: null, reason: 'sibling_fact' };
  // "sibling_fact" without any sibling in the source: the judge is unsure which fact it is (never dropped, never drift).
  const j: Judgement = judged.reasonCode === 'sibling_fact' && judged.mention === 'current' ? { ...judged, sameFact: 'unsure', reasonCode: 'ambiguous' } : judged;
  if (j.sameFact === 'no') {
    // Only the judge's explicit "different_condition" keeps a "no" as unsure; a stated condition alone does not
    // (with different_subject / ambiguous / other the sentence is about something else).
    const otherCondition = j.mention === 'current' && j.reasonCode === 'different_condition';
    if (!otherCondition || compareValues({ value: fact.value, unit: fact.unit }, { value: j.statedValue, unit: j.statedUnit }) === 'unknown') {
      return { decision: null, reason: 'not_same_fact' };
    }
    // Same topic, another condition: unsure, also when the judge named no condition.
    if (sameCondition(fact, j.statedCondition)) return { decision: { status: 'unsure', reason: 'Same topic under a different condition; please check.' } };
  }
  const decision = statusOf(fact, j, siblings);
  return decision ? { decision } : { decision: null, reason: 'value_not_comparable' };
}

function statusOf(fact: ScanFact, j: Judgement, siblings: readonly ScanFact[]): CopyDecision | null {
  if (j.mention === 'historical') return { status: 'historical', reason: 'Past value (historical mention); not checked.' };
  if (!sameCondition(fact, j.statedCondition)) {
    return { status: 'unsure', reason: fact.condition ? `Different condition: "${j.statedCondition}" vs "${fact.condition}".` : `Only for "${j.statedCondition}"; the source has no condition.` };
  }
  const cmp = compareValues({ value: fact.value, unit: fact.unit }, { value: j.statedValue, unit: j.statedUnit });
  if (cmp === 'unknown') return null;
  // The judge's own "value_matches" with an equal value and no other condition is in sync, also when it (or the
  // quote check) left same_fact at "unsure": an equal value cannot be drift.
  const matches = cmp === 'same' && j.reasonCode === 'value_matches' && j.mention === 'current';
  if (j.sameFact === 'unsure' && !matches) return { status: 'unsure', reason: 'Ripple is not sure this is the same fact.' };
  if (cmp === 'same') return { status: 'in_sync', reason: 'Same value as the source.' };
  const stated = valueLabel(j.statedValue, j.statedUnit);
  const official = valueLabel(fact.value, fact.unit);
  if (HISTORICAL_CUE.test(j.quote)) return { status: 'unsure', reason: `Looks like a past value (${stated}); please check.` };
  const sibling = siblings.find((s) => s.id !== fact.id && compareValues({ value: s.value, unit: s.unit }, { value: j.statedValue, unit: j.statedUnit }) === 'same');
  if (sibling && !j.statedCondition) return { status: 'unsure', reason: `Value matches the fact for "${sibling.condition ?? 'another case'}".` };
  return { status: 'drifted', reason: `Value differs: ${stated} vs ${official} on the source.` };
}

/** One judged mention on a page with its outcome (see `settleSiblings`). */
export interface PageMention {
  fact: ScanFact;
  judgement: Judgement;
  decision: CopyDecision | null;
  reason?: NotCopyReason;
}

/** Same sentence on a page: equal after normalising, or one quote contains the other (the judge trims differently). */
function sameSentence(a: string, b: string): boolean {
  const x = normaliseKeyPart(a);
  const y = normaliseKeyPart(b);
  return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
}

/** True when the unsure card comes from a condition other than the fact's own. */
const otherConditionCard = (i: PageMention): boolean =>
  i.judgement.reasonCode === 'different_condition' || (i.judgement.statedCondition !== null && !sameCondition(i.fact, i.judgement.statedCondition));

/**
 * Page-level guard so one sentence gives at most one card per sibling family (facts with the same subject and
 * attribute, other condition):
 * - an `unsure` whose sibling got in sync / drifted / historical from the same sentence is dropped (the sentence is
 *   about the sibling: "$75 for domestic trips" is no unsure international copy);
 * - the remaining `unsure` cards of a family for one sentence become one card, on the preferred fact of the family:
 *   the fact without a condition (general rule) first, then the fact's order in the source. A card for a condition
 *   the source lacks ("$40 for external training") moves to that fact even when the judge named only a sibling, if
 *   the preferred fact has no mention of that sentence and the card stays unsure for it; otherwise the preferred fact
 *   among the mentioned ones keeps it.
 * Dropped mentions get reason `sibling_fact`; a moved card is appended. Mentions of unrelated facts are untouched.
 */
export function settleSiblings(items: readonly PageMention[], facts: readonly ScanFact[]): PageMention[] {
  const out = items.map((i) => ({ ...i }));
  const drop = (i: PageMention) => {
    i.decision = null;
    i.reason = 'sibling_fact';
  };
  const rank = (f: ScanFact): [number, number] => {
    const at = facts.findIndex((x) => x.id === f.id);
    const known = facts[at] ?? f;
    return [known.condition === null ? 0 : 1, known.order ?? at];
  };
  const before = (a: ScanFact, b: ScanFact) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] !== rb[0] ? ra[0] < rb[0] : ra[1] !== rb[1] ? ra[1] < rb[1] : a.id < b.id;
  };
  const family = (f: ScanFact) => new Set([f.id, ...siblingsOf(f, facts).map((s) => s.id)]);
  const moved: PageMention[] = [];
  for (const u of out) {
    if (u.decision?.status !== 'unsure') continue;
    const ids = family(u.fact);
    if (ids.size < 2) continue;
    const group = out.filter((o) => ids.has(o.fact.id) && sameSentence(o.judgement.quote, u.judgement.quote));
    if (group.some((o) => o.decision && o.decision.status !== 'unsure')) {
      for (const o of group) if (o.decision?.status === 'unsure') drop(o);
      continue;
    }
    const unsure = group.filter((o) => o.decision?.status === 'unsure');
    const keep = unsure.reduce((b, o) => (before(o.fact, b.fact) ? o : b));
    for (const o of unsure) if (o !== keep) drop(o);
    const target = facts.filter((f) => ids.has(f.id)).reduce((b, f) => (before(f, b) ? f : b));
    if (target.id === keep.fact.id || !otherConditionCard(keep) || group.some((o) => o.fact.id === target.id)) continue;
    const judgement = { ...keep.judgement, factId: target.id };
    const outcome = judgeOutcome(target, judgement, siblingsOf(target, facts));
    if (outcome.decision?.status !== 'unsure') continue;
    moved.push({ fact: target, judgement, ...outcome });
    drop(keep);
  }
  return [...out, ...moved];
}

const RANK: Record<CopyStatus, number> = { drifted: 5, in_sync: 4, unsure: 3, historical: 2, updated: 1, ignored: 0 };

/** One status per fact and page: a drifted mention wins, then in sync, unsure, historical. */
export function strongest<T extends { status: CopyStatus }>(decisions: readonly T[]): T | undefined {
  return decisions.reduce<T | undefined>((best, d) => (!best || RANK[d.status] > RANK[best.status] ? d : best), undefined);
}

/** Facts with the same subject and attribute as `fact` (identity without the condition). */
export function siblingsOf(fact: ScanFact, all: readonly ScanFact[]): ScanFact[] {
  const key = (f: ScanFact) => `${normaliseKeyPart(f.subject)}|${normaliseKeyPart(f.attribute)}`;
  return all.filter((f) => f.id !== fact.id && key(f) === key(fact));
}
