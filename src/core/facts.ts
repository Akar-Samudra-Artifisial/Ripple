/**
 * Fact extraction rules (PRD "Aturan bisnis 1. Ekstraksi fakta"), pure so they can be tested without Forge:
 * validate the untrusted LLM output, keep only supported fact types whose quote is found verbatim in the page,
 * deduplicate by identity key (subject + attribute + condition), cap at 30, and plan how a new extraction merges
 * with the facts already stored for the page.
 */
import type { FactEditPayload, FactStatus, FactType } from './views';

export const MAX_FACTS = 30;
export const FACT_TYPES: readonly FactType[] = ['number', 'date', 'list', 'name', 'rule'];
/** Column sizes in `v004_create_facts`; longer values are rejected, not truncated (a cut quote would not verify). */
export const FIELD_LIMITS = { subject: 160, attribute: 160, value: 300, unit: 40, condition: 160, quote: 600 } as const;
/** Shorter quotes ("$60") prove nothing about the fact's context. */
export const MIN_QUOTE_CHARS = 12;

export interface ExtractedFact {
  type: FactType;
  subject: string;
  attribute: string;
  value: string;
  unit: string | null;
  condition: string | null;
  quote: string;
  identityKey: string;
}

export type DropReason = 'invalid_shape' | 'unsupported_type' | 'quote_not_found' | 'value_not_in_quote' | 'key_too_long' | 'duplicate_key' | 'over_limit';

export interface ParsedExtraction {
  facts: ExtractedFact[];
  /** Index into the LLM's `facts` array and why it was dropped (for logs; no content). */
  dropped: { index: number; reason: DropReason }[];
}

function normaliseForQuote(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
}

/** True when `quote` appears in `text`, ignoring case, whitespace, curly quotes, dashes and a trailing full stop. */
export function quoteInText(quote: string, text: string): boolean {
  const q = normaliseForQuote(quote);
  return q.length > 0 && normaliseForQuote(text).includes(q);
}

/** One part of an identity key: case, punctuation and spacing do not matter. */
export function normaliseKeyPart(part: string | null | undefined): string {
  return (part ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$€£%]+/gu, ' ')
    .trim();
}

export const identityKey = (subject: string, attribute: string, condition: string | null): string =>
  [subject, attribute, condition].map(normaliseKeyPart).join('|');

/** Numbers written in `text` ("$2,000" → 2000). */
function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter(Number.isFinite);
}

/** Words of at least 3 letters/digits, after key normalisation. */
const wordsIn = (text: string): string[] => normaliseKeyPart(text).split(' ').filter((w) => w.length >= 3);

/**
 * The value must be grounded in its own quote (guards against a mis-read or invented value):
 * - `number`: at least one number in the value, and every number in it is written in the quote ("2000" ↔ "$2,000");
 * - other types: numbers in the value must be in the quote; a value without numbers needs all of its words
 *   (3+ characters, at least one) in the quote ("economy class" ↔ "Book economy class …"). "yes" is never grounded.
 */
export function valueInQuote(type: FactType, value: string, quote: string): boolean {
  const inQuote = new Set(numbersIn(quote));
  const numbers = numbersIn(value);
  if (!numbers.every((n) => inQuote.has(n))) return false;
  if (numbers.length > 0) return true;
  if (type === 'number') return false;
  const quoteText = normaliseKeyPart(quote);
  const words = wordsIn(value);
  return words.length > 0 && words.every((w) => quoteText.includes(w));
}

/** Column size of `facts.identity_key` / `facts.origin_key`; longer keys are rejected, never truncated. */
export const MAX_KEY_CHARS = 400;

const sameText = (a: string | null, b: string | null): boolean => normaliseKeyPart(a) === normaliseKeyPart(b);

/** Trimmed string within `max` characters; `undefined` when missing, empty or too long. */
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  return t !== '' && t.length <= max ? t : undefined;
}

/** Optional string: null/"" → null; `undefined` when present but invalid. */
function optionalText(v: unknown, max: number): string | null | undefined {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  return text(v, max);
}

/**
 * Validates the `record_facts` arguments against the page text. Throws when the arguments have no `facts` array
 * (the whole extraction is unusable); individual bad facts are dropped and reported in `dropped`.
 */
export function parseExtraction(raw: unknown, pageText: string): ParsedExtraction {
  const items = (raw as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(items)) throw new Error('extraction result has no facts array');
  const facts: ExtractedFact[] = [];
  const dropped: ParsedExtraction['dropped'] = [];
  const keys = new Set<string>();
  items.forEach((item: unknown, index) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const subject = text(r.subject, FIELD_LIMITS.subject);
    const attribute = text(r.attribute, FIELD_LIMITS.attribute);
    const value = text(r.value, FIELD_LIMITS.value);
    const unit = optionalText(r.unit, FIELD_LIMITS.unit);
    const condition = optionalText(r.condition, FIELD_LIMITS.condition);
    const quote = text(r.quote, FIELD_LIMITS.quote);
    if (!subject || !attribute || !value || !quote || unit === undefined || condition === undefined || quote.length < MIN_QUOTE_CHARS) {
      dropped.push({ index, reason: 'invalid_shape' });
      return;
    }
    if (!FACT_TYPES.includes(r.type as FactType)) {
      dropped.push({ index, reason: 'unsupported_type' });
      return;
    }
    const type = r.type as FactType;
    if (!quoteInText(quote, pageText)) {
      dropped.push({ index, reason: 'quote_not_found' });
      return;
    }
    if (!valueInQuote(type, value, quote)) {
      dropped.push({ index, reason: 'value_not_in_quote' });
      return;
    }
    const key = identityKey(subject, attribute, condition);
    if (key.length > MAX_KEY_CHARS) {
      dropped.push({ index, reason: 'key_too_long' });
      return;
    }
    if (keys.has(key)) {
      dropped.push({ index, reason: 'duplicate_key' });
      return;
    }
    if (facts.length >= MAX_FACTS) {
      dropped.push({ index, reason: 'over_limit' });
      return;
    }
    keys.add(key);
    facts.push({ type, subject, attribute, value, unit, condition, quote, identityKey: key });
  });
  return { facts, dropped };
}

/** A stored fact, as far as merging needs it. */
export interface StoredFact {
  id: string;
  identityKey: string;
  /** Key as first extracted; survives reviewer edits so re-extraction still matches the fact. Null on old rows. */
  originKey: string | null;
  status: FactStatus;
  edited: boolean;
  value: string;
  unit: string | null;
}

export interface FactUpdate {
  id: string;
  fact: ExtractedFact;
  /** Only refresh quote and page version; keep subject/attribute/value/unit/condition and status. */
  refreshOnly: boolean;
  /**
   * Status the row had when the plan was made. The store applies a full update only while the row still has it and
   * is unedited, so a review that lands during extraction wins; a refresh never touches a rejected row.
   */
  from: FactStatus;
  status: FactStatus;
  previousValue: string | null;
}

export interface MergePlan {
  insert: ExtractedFact[];
  update: FactUpdate[];
  /** Proposed (never reviewed) facts that are no longer on the page. */
  remove: string[];
}

/**
 * How a new extraction changes the stored facts of a page:
 * - new key → insert as `proposed`;
 * - `proposed` → overwrite with the new reading;
 * - `confirmed` with the same value/unit, or edited by a reviewer → refresh the quote and page version only;
 * - `confirmed` with a different value → new value, back to `proposed`, old value kept in `previousValue` (M2);
 * - `rejected` → untouched, so a rejected fact never comes back;
 * - stored but not extracted: `proposed` is removed; reviewed facts are kept (M2 asks the owner).
 */
export function planMerge(existing: readonly StoredFact[], extracted: readonly ExtractedFact[]): MergePlan {
  // Match on the original (extracted) key first, so an edit of subject/attribute/condition does not duplicate the
  // fact on the next extraction; then on the current key.
  const byKey = new Map<string, StoredFact>();
  for (const f of existing) byKey.set(f.originKey ?? f.identityKey, f);
  for (const f of existing) if (!byKey.has(f.identityKey)) byKey.set(f.identityKey, f);
  const matched = new Set<string>();
  const plan: MergePlan = { insert: [], update: [], remove: [] };
  for (const fact of extracted) {
    const old = byKey.get(fact.identityKey);
    if (!old) {
      plan.insert.push(fact);
      continue;
    }
    if (matched.has(old.id)) continue;
    matched.add(old.id);
    const from = old.status;
    if (old.status === 'rejected') continue;
    if (old.status === 'proposed' && !old.edited) plan.update.push({ id: old.id, fact, refreshOnly: false, from, status: 'proposed', previousValue: null });
    else if (old.edited || (sameText(old.value, fact.value) && sameText(old.unit, fact.unit))) {
      plan.update.push({ id: old.id, fact, refreshOnly: true, from, status: old.status, previousValue: null });
    } else plan.update.push({ id: old.id, fact, refreshOnly: false, from, status: 'proposed', previousValue: old.value });
  }
  for (const f of existing) if (!matched.has(f.id) && f.status === 'proposed' && !f.edited) plan.remove.push(f.id);
  return plan;
}

export interface CleanEdit {
  subject: string;
  attribute: string;
  value: string;
  unit: string | null;
  condition: string | null;
  identityKey: string;
}

/** Validates an `editFact` payload; returns an error message for the UI instead of throwing. */
export function cleanEdit(payload: Partial<FactEditPayload> | undefined): CleanEdit | { error: string } {
  const p = payload ?? {};
  const subject = text(p.subject, FIELD_LIMITS.subject);
  const attribute = text(p.attribute, FIELD_LIMITS.attribute);
  const value = text(p.value, FIELD_LIMITS.value);
  const unit = optionalText(p.unit, FIELD_LIMITS.unit);
  const condition = optionalText(p.condition, FIELD_LIMITS.condition);
  if (!subject) return { error: `Subject is required (at most ${FIELD_LIMITS.subject} characters).` };
  if (!attribute) return { error: `Attribute is required (at most ${FIELD_LIMITS.attribute} characters).` };
  if (!value) return { error: `Value is required (at most ${FIELD_LIMITS.value} characters).` };
  if (unit === undefined) return { error: `Unit must be text of at most ${FIELD_LIMITS.unit} characters.` };
  if (condition === undefined) return { error: `Condition must be text of at most ${FIELD_LIMITS.condition} characters.` };
  const key = identityKey(subject, attribute, condition);
  if (key.length > MAX_KEY_CHARS) return { error: 'Subject, attribute and condition are too long together; shorten them.' };
  return { subject, attribute, value, unit, condition, identityKey: key };
}
