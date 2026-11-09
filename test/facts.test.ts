import { describe, expect, it } from 'vitest';
import { cleanEdit, identityKey, MAX_FACTS, parseExtraction, planMerge, quoteInText, type ExtractedFact, type StoredFact } from '../src/core/facts';
import { storageToText } from '../src/core/pageText';
import { TRAVEL_POLICY_FACTS, TRAVEL_POLICY_STORAGE } from './fixtures/travelPolicy';

const text = storageToText(TRAVEL_POLICY_STORAGE);

describe('Travel Policy extraction', () => {
  it('keeps all five facts with verbatim quotes found in the page text', () => {
    const { facts, dropped } = parseExtraction({ facts: TRAVEL_POLICY_FACTS }, text);
    expect(dropped).toEqual([]);
    expect(facts.map((f) => [f.subject, f.value, f.unit, f.condition])).toEqual([
      ['Travel per diem', '60', 'USD', 'Domestic travel'],
      ['Travel per diem', '90', 'USD', 'International travel'],
      ['Trip approval', '2000', 'USD', 'Before booking'],
      ['Expense claims', '30', 'days after the trip ends', null],
      ['Flight class', 'economy class', null, 'Flights under 6 hours'],
    ]);
    for (const f of facts) expect(quoteInText(f.quote, text)).toBe(true);
  });

  it('page text drops macro parameters (prompt-injection title) but keeps the table and list text', () => {
    expect(text).not.toContain('Ignore previous instructions');
    expect(text).toContain('$60 per day');
    expect(text).toContain('within 30 days after');
  });

  it('rejects a fact whose quote is not on the page, even when the value is plausible', () => {
    const fake = { ...TRAVEL_POLICY_FACTS[0], quote: 'The per diem for domestic travel is $75 per day.' };
    const paraphrase = { ...TRAVEL_POLICY_FACTS[1], quote: 'International trips get $90 each day.' };
    const { facts, dropped } = parseExtraction({ facts: [fake, paraphrase, TRAVEL_POLICY_FACTS[2]] }, text);
    expect(facts).toHaveLength(1);
    expect(dropped).toEqual([
      { index: 0, reason: 'quote_not_found' },
      { index: 1, reason: 'quote_not_found' },
    ]);
  });

  it('rejects a number fact whose value is not written in its (real) quote', () => {
    const misread = { ...TRAVEL_POLICY_FACTS[0], value: '75' };
    expect(parseExtraction({ facts: [misread] }, text).dropped).toEqual([{ index: 0, reason: 'value_not_in_quote' }]);
  });

  it('dedups by identity key (subject + attribute + condition), ignoring case and punctuation', () => {
    const dup = { ...TRAVEL_POLICY_FACTS[0], subject: 'travel  PER DIEM', condition: 'domestic travel.' };
    const { facts, dropped } = parseExtraction({ facts: [TRAVEL_POLICY_FACTS[0], dup, TRAVEL_POLICY_FACTS[1]] }, text);
    expect(facts.map((f) => f.condition)).toEqual(['Domestic travel', 'International travel']);
    expect(dropped).toEqual([{ index: 1, reason: 'duplicate_key' }]);
    expect(identityKey('Travel per diem', 'Amount per day', 'Domestic travel')).toBe('travel per diem|amount per day|domestic travel');
    expect(identityKey('A', 'B', null)).not.toBe(identityKey('A', 'B', 'C'));
  });

  it('drops unsupported types, bad shapes and anything past 30 facts', () => {
    const base = TRAVEL_POLICY_FACTS[4];
    const { dropped } = parseExtraction({ facts: [{ ...base, type: 'opinion' }, { ...base, subject: '' }, { ...base, quote: 'economy' }, null] }, text);
    expect(dropped.map((d) => d.reason)).toEqual(['unsupported_type', 'invalid_shape', 'invalid_shape', 'invalid_shape']);
    const many = Array.from({ length: MAX_FACTS + 3 }, (_, i) => ({ ...base, attribute: `Rule ${i}` }));
    const capped = parseExtraction({ facts: many }, text);
    expect(capped.facts).toHaveLength(MAX_FACTS);
    expect(capped.dropped.filter((d) => d.reason === 'over_limit')).toHaveLength(3);
  });

  it('throws when the tool arguments have no facts array', () => {
    expect(() => parseExtraction({ items: [] }, text)).toThrow('no facts array');
  });
});

describe('planMerge', () => {
  const extracted = parseExtraction({ facts: TRAVEL_POLICY_FACTS }, text).facts;
  const [domestic, international, approval, claims] = extracted as [ExtractedFact, ExtractedFact, ExtractedFact, ExtractedFact];
  const stored = (f: ExtractedFact, over: Partial<StoredFact>): StoredFact => ({ id: `id-${f.condition}`, identityKey: f.identityKey, status: 'proposed', edited: false, value: f.value, unit: f.unit, ...over });

  it('inserts new keys, refreshes unchanged confirmed facts, re-proposes changed values and never revives rejected ones', () => {
    const plan = planMerge(
      [
        stored(domestic, { status: 'confirmed', value: '55' }),
        stored(international, { status: 'confirmed' }),
        stored(approval, { status: 'rejected' }),
        { id: 'gone', identityKey: 'old|fact|', status: 'proposed', edited: false, value: '1', unit: null },
        { id: 'kept', identityKey: 'old|confirmed|', status: 'confirmed', edited: false, value: '1', unit: null },
      ],
      [domestic, international, approval, claims],
    );
    expect(plan.insert.map((f) => f.subject)).toEqual(['Expense claims']);
    expect(plan.update).toEqual([
      expect.objectContaining({ id: 'id-Domestic travel', refreshOnly: false, status: 'proposed', previousValue: '55' }),
      expect.objectContaining({ id: 'id-International travel', refreshOnly: true, status: 'confirmed' }),
    ]);
    expect(plan.remove).toEqual(['gone']);
  });

  it('keeps a reviewer edit (refresh quote only)', () => {
    const plan = planMerge([stored(domestic, { status: 'confirmed', edited: true, value: '65' })], [domestic]);
    expect(plan.update).toEqual([expect.objectContaining({ refreshOnly: true, status: 'confirmed', previousValue: null })]);
  });
});

describe('cleanEdit', () => {
  it('trims input, nulls empty optionals and recomputes the identity key', () => {
    expect(cleanEdit({ factId: 'x', subject: ' Travel per diem ', attribute: 'Amount per day', value: '75', unit: '', condition: 'Domestic travel' })).toEqual({
      subject: 'Travel per diem',
      attribute: 'Amount per day',
      value: '75',
      unit: null,
      condition: 'Domestic travel',
      identityKey: 'travel per diem|amount per day|domestic travel',
    });
  });

  it('reports missing or oversized fields', () => {
    expect(cleanEdit({ subject: 'a', attribute: 'b', value: '' })).toEqual({ error: expect.stringContaining('Value is required') });
    expect(cleanEdit({ subject: 'a'.repeat(200), attribute: 'b', value: 'c' })).toEqual({ error: expect.stringContaining('Subject') });
    expect(cleanEdit(undefined)).toHaveProperty('error');
  });
});
