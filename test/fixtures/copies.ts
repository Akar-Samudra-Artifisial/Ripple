/**
 * Suggested copy pages for the M2 scan of the "Travel Policy" source (page 9502721 in the dev site, see
 * `travelPolicy.ts`): 2 in sync, 2 drifted, 1 historical and 1 trap with another condition (must NOT be drift).
 * `storage` can be pasted into Confluence pages for a live test (goal-verify); `judge` is what a well-behaved judge
 * returns for each mention (quotes verbatim) and `expect` is the copy status Ripple must store per fact.
 */
import type { CopyStatus } from '../../src/core/views';

/** Source facts by short key (values of page 9502721 / `TRAVEL_POLICY_FACTS`). */
export type FactKey = 'domestic' | 'international' | 'approval' | 'claims' | 'flight';

export const FACT_KEYS: Record<FactKey, { subject: string; condition: string | null }> = {
  domestic: { subject: 'Travel per diem', condition: 'Domestic travel' },
  international: { subject: 'Travel per diem', condition: 'International travel' },
  approval: { subject: 'Trip approval', condition: 'Before booking' },
  claims: { subject: 'Expense claims', condition: null },
  flight: { subject: 'Flight class', condition: 'Flights under 6 hours' },
};

export interface JudgeMention {
  fact: FactKey;
  same_fact: 'yes' | 'no' | 'unsure';
  mention: 'current' | 'historical' | 'example';
  stated_value: string;
  stated_unit: string | null;
  stated_condition: string | null;
  quote: string;
}

export interface CopyPageFixture {
  id: string;
  title: string;
  kind: 'in_sync' | 'drift' | 'historical' | 'trap';
  storage: string;
  judge: JudgeMention[];
  /** Status per fact after the scan; `null` = no copy row. */
  expect: Partial<Record<FactKey, CopyStatus | null>>;
}

export const SOURCE_PAGE_ID = '9502721';

export const COPY_PAGES: CopyPageFixture[] = [
  {
    id: '9600001',
    title: 'New joiner FAQ: travel',
    kind: 'in_sync',
    storage: `<h2>Travel</h2>
<p>Domestic trips: the per diem is $60 per day.</p>
<p>Submit expense claims within 30 days after the trip ends.</p>
<p>Questions go to People Ops.</p>`,
    judge: [
      { fact: 'domestic', same_fact: 'yes', mention: 'current', stated_value: '$60', stated_unit: 'per day', stated_condition: 'Domestic trips', quote: 'Domestic trips: the per diem is $60 per day.' },
      { fact: 'claims', same_fact: 'yes', mention: 'current', stated_value: '30 days', stated_unit: 'days', stated_condition: null, quote: 'Submit expense claims within 30 days after the trip ends.' },
    ],
    expect: { domestic: 'in_sync', claims: 'in_sync' },
  },
  {
    id: '9600002',
    title: 'Sales team travel guide',
    kind: 'in_sync',
    storage: `<h2>Before you book</h2>
<p>Trips over 2,000 USD need manager approval before booking.</p>
<p>Book economy class for flights under 6 hours.</p>
<p>International per diem: ninety dollars per day.</p>`,
    judge: [
      { fact: 'approval', same_fact: 'yes', mention: 'current', stated_value: '2,000 USD', stated_unit: 'USD', stated_condition: 'before booking', quote: 'Trips over 2,000 USD need manager approval before booking.' },
      { fact: 'flight', same_fact: 'yes', mention: 'current', stated_value: 'economy class', stated_unit: null, stated_condition: 'flights under 6 hours', quote: 'Book economy class for flights under 6 hours.' },
      { fact: 'international', same_fact: 'yes', mention: 'current', stated_value: 'ninety dollars', stated_unit: null, stated_condition: 'International', quote: 'International per diem: ninety dollars per day.' },
    ],
    expect: { approval: 'in_sync', flight: 'in_sync', international: 'in_sync' },
  },
  {
    id: '9600003',
    title: 'Engineering offsite checklist',
    kind: 'drift',
    storage: `<h2>Money</h2>
<ul><li><p>Per diem for domestic travel: $75 per day.</p></li>
<li><p>Book the venue two months ahead.</p></li></ul>`,
    judge: [
      { fact: 'domestic', same_fact: 'yes', mention: 'current', stated_value: '$75', stated_unit: 'per day', stated_condition: 'domestic travel', quote: 'Per diem for domestic travel: $75 per day.' },
    ],
    expect: { domestic: 'drifted' },
  },
  {
    id: '9600004',
    title: 'Finance FAQ',
    kind: 'drift',
    storage: `<h2>Expenses</h2>
<p>Expense claims must be submitted within 45 days after the trip ends.</p>
<p>Receipts can be photos.</p>`,
    judge: [
      { fact: 'claims', same_fact: 'yes', mention: 'current', stated_value: '45 days', stated_unit: 'days', stated_condition: null, quote: 'Expense claims must be submitted within 45 days after the trip ends.' },
    ],
    expect: { claims: 'drifted' },
  },
  {
    id: '9600005',
    title: 'Travel policy changelog',
    kind: 'historical',
    storage: `<h2>Changelog</h2>
<p>January 2026: the domestic per diem was raised from $50 to $60 per day.</p>`,
    judge: [
      { fact: 'domestic', same_fact: 'yes', mention: 'historical', stated_value: '$50', stated_unit: 'per day', stated_condition: 'domestic', quote: 'January 2026: the domestic per diem was raised from $50 to $60 per day.' },
    ],
    expect: { domestic: 'historical' },
  },
  {
    id: '9600006',
    title: 'Learning & Development budget',
    kind: 'trap',
    storage: `<h2>External training</h2>
<p>The per diem for external training is $40 per day.</p>
<p>Courses need approval from your lead.</p>`,
    // A sloppy judge says "yes"; Ripple still must not call it drift because the condition differs.
    judge: [
      { fact: 'domestic', same_fact: 'yes', mention: 'current', stated_value: '$40', stated_unit: 'per day', stated_condition: 'External training', quote: 'The per diem for external training is $40 per day.' },
    ],
    expect: { domestic: 'unsure' },
  },
];
