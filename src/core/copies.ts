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

/** Letters, digits, spaces and `$ % . , -` only, so a term can never break out of a CQL string. */
export function cleanTerm(term: string): string {
  return term
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}$%., -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TERM_CHARS)
    .trim();
}

export interface FactTerms {
  /** Phrases searched as exact phrases (subject and synonyms). */
  phrases: string[];
  /** Numbers of the current and previous value ("60", "2000"). */
  numbers: string[];
  /** Distinct words of the phrases, used to find chunks. */
  keywords: string[];
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
  return { phrases, numbers, keywords: keywordsOf([...phrases, fact.attribute]) };
}

/**
 * CQL for the candidates of one fact: current pages (archived pages are not returned by default) other than the
 * source, without the `ripple-ignore` label, that contain a phrase of the fact or one of its numbers. Results come
 * back by relevance, so the first 200 are the best candidates.
 */
export function buildCql(sourcePageId: string, terms: FactTerms): string {
  if (!/^\d{1,32}$/.test(sourcePageId)) throw new Error('invalid source page id');
  const clauses = [
    ...terms.phrases.map((p) => `text ~ "\\"${p}\\""`),
    // Bare numbers of 3+ digits only: "60" alone matches too many pages to help relevance.
    ...terms.numbers.filter((n) => n.length >= 3).map((n) => `text ~ "${n}"`),
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

const canonicalUnit = (text: string): string | null => UNIT_PATTERNS.find(([re]) => re.test(text))?.[1] ?? null;

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

/**
 * Compares a stated value with the official one after normalisation. Numbers: same set of numbers, and units equal
 * when both are known. Text: same words, or one contains the other ("economy" ≈ "economy class"). `unknown` when
 * the stated value cannot be parsed the same way (the PRD drops such candidates).
 */
export function compareValues(official: { value: string; unit: string | null }, stated: { value: string; unit: string | null }): ValueComparison {
  const o = normaliseValue(official.value, official.unit);
  const s = normaliseValue(stated.value, stated.unit);
  if (o.numbers.length > 0) {
    if (s.numbers.length === 0) return 'unknown';
    const same = o.numbers.length === s.numbers.length && o.numbers.every((n) => s.numbers.includes(n));
    if (!same) return 'different';
    return o.unit && s.unit && o.unit !== s.unit ? 'different' : 'same';
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
}

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
    judgements.push({ factId, sameFact, mention, statedValue, statedUnit, statedCondition, quote });
  });
  return { judgements, dropped };
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

/** Same condition, or the copy states none. Only false when both are stated and share no distinctive word. */
export function sameCondition(fact: ScanFact, statedCondition: string | null): boolean {
  if (!fact.condition || !statedCondition) return true;
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
  if (j.sameFact === 'no' || j.mention === 'example') return null;
  if (j.mention === 'historical') return { status: 'historical', reason: 'Past value (historical mention); not checked.' };
  if (!sameCondition(fact, j.statedCondition)) {
    return { status: 'unsure', reason: `Different condition: "${j.statedCondition}" vs "${fact.condition}".` };
  }
  const cmp = compareValues({ value: fact.value, unit: fact.unit }, { value: j.statedValue, unit: j.statedUnit });
  if (cmp === 'unknown') return null;
  if (j.sameFact === 'unsure') return { status: 'unsure', reason: 'Ripple is not sure this is the same fact.' };
  if (cmp === 'same') return { status: 'in_sync', reason: 'Same value as the source.' };
  const stated = valueLabel(j.statedValue, j.statedUnit);
  const official = valueLabel(fact.value, fact.unit);
  if (HISTORICAL_CUE.test(j.quote)) return { status: 'unsure', reason: `Looks like a past value (${stated}); please check.` };
  const sibling = siblings.find((s) => s.id !== fact.id && compareValues({ value: s.value, unit: s.unit }, { value: j.statedValue, unit: j.statedUnit }) === 'same');
  if (sibling && !j.statedCondition) return { status: 'unsure', reason: `Value matches the fact for "${sibling.condition ?? 'another case'}".` };
  return { status: 'drifted', reason: `Value differs: ${stated} vs ${official} on the source.` };
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
