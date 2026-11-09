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

export type DropReason = 'invalid_shape' | 'unsupported_type' | 'quote_not_found' | 'value_not_in_quote' | 'duplicate_key' | 'over_limit';

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

/** For number facts: every number in the value must be written in the quote (guards against a mis-read value). */
function valueInQuote(value: string, quote: string): boolean {
  const inQuote = new Set(numbersIn(quote));
  return numbersIn(value).every((n) => inQuote.has(n));
}

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
    if (type === 'number' && !valueInQuote(value, quote)) {
      dropped.push({ index, reason: 'value_not_in_quote' });
      return;
    }
    const key = identityKey(subject, attribute, condition);
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
  const byKey = new Map(existing.map((f) => [f.identityKey, f]));
  const seen = new Set<string>();
  const plan: MergePlan = { insert: [], update: [], remove: [] };
  for (const fact of extracted) {
    seen.add(fact.identityKey);
    const old = byKey.get(fact.identityKey);
    if (!old) plan.insert.push(fact);
    else if (old.status === 'rejected') continue;
    else if (old.status === 'proposed' && !old.edited) plan.update.push({ id: old.id, fact, refreshOnly: false, status: 'proposed', previousValue: null });
    else if (old.edited || (sameText(old.value, fact.value) && sameText(old.unit, fact.unit))) {
      plan.update.push({ id: old.id, fact, refreshOnly: true, status: old.status, previousValue: null });
    } else plan.update.push({ id: old.id, fact, refreshOnly: false, status: 'proposed', previousValue: old.value });
  }
  for (const f of existing) if (!seen.has(f.identityKey) && f.status === 'proposed' && !f.edited) plan.remove.push(f.id);
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
  return { subject, attribute, value, unit, condition, identityKey: identityKey(subject, attribute, condition) };
}
