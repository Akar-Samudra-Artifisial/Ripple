/**
 * M6 demo data: the Nimbus Labs scenario that "Load demo data" creates (five spaces, the official "Travel Policy" and
 * its copies). Shared by the loader and the tests, which check the expected counts below through the real scan and
 * impact code with a simulated judge.
 *
 * Copy facts: 14 domestic per diem copies (13 in sync, 1 drifted $65) and 8 copies of the other facts (5 in sync,
 * 3 drifted: claims 45 days, approval $2,500, international $100), one trap (training per diem $40, unsure) and one
 * historical mention. The trap page never uses a word like "international" / "external" (see `TRAP_FORBIDDEN`) so the
 * judge maps its card to the domestic per diem. Every in-sync per diem sentence names the fact's condition
 * ("domestic", "international") and nothing that narrows it (conferences, relocation, …); page context stays in the
 * sentences around it, so a live judge has no reason to answer "different condition". The loader finds pages by
 * title, so changed content reaches Confluence only after "Remove demo data" and a new load.
 */

export type NimbusFactKey = 'domestic' | 'international' | 'approval' | 'claims' | 'flight';
export type NimbusSpaceKey = 'NLHR' | 'NLONB' | 'NLFIN' | 'NLSALES' | 'NLHELP';

/**
 * Fixed text in the description of every space the demo loader creates: an existing space with a demo key is reused
 * only when its description carries it (or the load recorded the space), never a foreign space with the same key.
 */
export const DEMO_MARKER = 'Created by Ripple demo data';

export interface NimbusSpace {
  key: NimbusSpaceKey;
  name: string;
  /** Contains `DEMO_MARKER`. */
  description: string;
}

export const NIMBUS_SPACES: readonly NimbusSpace[] = [
  { key: 'NLHR', name: 'Nimbus Labs HR', description: 'People Ops policies of Nimbus Labs. Created by Ripple demo data.' },
  { key: 'NLONB', name: 'Nimbus Labs Onboarding', description: 'Guides for new joiners at Nimbus Labs. Created by Ripple demo data.' },
  { key: 'NLFIN', name: 'Nimbus Labs Finance FAQ', description: 'Answers from the Nimbus Labs Finance team. Created by Ripple demo data.' },
  { key: 'NLSALES', name: 'Nimbus Labs Sales Playbook', description: 'How the Nimbus Labs sales team works. Created by Ripple demo data.' },
  { key: 'NLHELP', name: 'Nimbus Labs IT & HR Help Center', description: 'Knowledge base articles for Nimbus Labs employees. Created by Ripple demo data.' },
];

/** What a careful judge reports for one sentence, and the copy status Ripple must store for it. */
export interface NimbusMention {
  fact: NimbusFactKey;
  status: 'in_sync' | 'drifted' | 'unsure' | 'historical';
  /** The sentence, verbatim on the page (plain text: no markup, entities or apostrophes). */
  quote: string;
  statedValue: string;
  statedUnit: string | null;
  statedCondition: string | null;
}

export interface NimbusPage {
  /** Stable id of the page in the demo state. */
  slug: string;
  space: NimbusSpaceKey;
  title: string;
  kind: 'source' | 'copy' | 'historical';
  /** Confluence storage format. */
  storage: string;
  mentions: readonly NimbusMention[];
}

const p = (text: string): string => `<p>${text}</p>`;
const faq = (question: string, answer: string): string => `<h2>${question}</h2>${p(answer)}`;
const m = (fact: NimbusFactKey, status: NimbusMention['status'], quote: string, statedValue: string, statedUnit: string | null, statedCondition: string | null): NimbusMention => ({
  fact,
  status,
  quote,
  statedValue,
  statedUnit,
  statedCondition,
});

/** The official source (marked as source by the juror in the demo video, never by the loader). */
export const NIMBUS_SOURCE: NimbusPage = {
  slug: 'travel-policy',
  space: 'NLHR',
  title: 'Travel Policy',
  kind: 'source',
  storage: [
    p('Nimbus Labs wants work travel to be simple, fair and safe. This page is the official travel policy and is owned by People Ops.'),
    '<h2>Per diem</h2>',
    '<table><tbody><tr><th>Trip</th><th>Per diem</th></tr>',
    '<tr><td>Domestic travel</td><td>The per diem for domestic travel is $60 per day.</td></tr>',
    '<tr><td>International travel</td><td>The per diem for international travel is $90 per day.</td></tr>',
    '</tbody></table>',
    '<h2>Approval and claims</h2>',
    '<ul><li><p>Trips over $2,000 require manager approval before booking.</p></li>',
    '<li><p>Expense claims must be submitted within 30 days after the trip ends.</p></li></ul>',
    '<h2>Flights</h2>',
    p('Book economy class for flights under 6 hours.'),
    p('Questions about this policy go to People Ops in the #travel channel.'),
  ].join(''),
  mentions: [],
};

const page = (slug: string, space: NimbusSpaceKey, title: string, kind: 'copy' | 'historical', storage: string[], mentions: NimbusMention[]): NimbusPage => ({
  slug,
  space,
  title,
  kind,
  storage: storage.join(''),
  mentions,
});

const D1 = 'On domestic trips you receive a per diem of $60 per day.';
const C1 = 'Expense claims are due within 30 days after the trip ends.';
const TRAP = 'On training course days the per diem is $40 per day.';
const D3 = 'For domestic travel, People Ops pays a per diem of $60 per day.';
const HIST = 'Last year the domestic per diem went up from $50 to $60 per day.';
const D5 = 'Every domestic trip comes with a per diem of $60 per day.';
const D6 = 'Yes. For domestic travel the per diem is $60 per day.';
const D7 = 'On domestic trips you get the per diem of $60 per day.';
const D8 = 'Explain that domestic trips come with a per diem of $60 per day.';
const A8 = 'Remind new hires that trips over $2,000 need manager approval before booking.';
const C9 = 'Expense claims must be submitted within 45 days after the trip ends.';
const D9 = 'No. Meals on domestic trips are covered by the per diem of $60 per day.';
const D10 = 'Per diem for domestic travel: $60 per day.';
const I10 = 'International travel: the per diem is $100 per day.';
const D11 = 'Meals on domestic travel are paid from the per diem of $60 per day, not with the corporate card.';
const C12 = 'Remind your team that expense claims are due within 30 days after the trip ends.';
const D13 = 'For domestic customer visits the per diem is $65 per day.';
const A13 = 'Trips over $2,500 require manager approval before booking.';
const D14 = 'On domestic trips, plan for the per diem of $60 per day.';
const I15 = 'For international travel, the per diem is $90 per day.';
const D15 = 'Domestic travel has a per diem of $60 per day.';
const D16 = 'For domestic travel the per diem is $60 per day, paid with your next salary.';
const D17 = 'Domestic trips come with a per diem of $60 per day, so you do not need to book meals.';
const F18 = 'Flights under 6 hours are booked in economy class.';

/** Slug of the trap page (training per diem $40: unsure, mapped to the domestic per diem). */
export const TRAP_SLUG = 'hr-training-courses';
/** Words the trap sentence and its page must never contain (they would steer the judge to another fact). */
export const TRAP_FORBIDDEN = /intern|extern|overseas|abroad|foreign/i;

/** The 18 pages besides the source: 17 copy pages and 1 historical page, in load order. */
export const NIMBUS_PAGES: readonly NimbusPage[] = [
  page('hr-handbook', 'NLHR', 'Employee Handbook: Travel and Expenses', 'copy', [p('This section of the handbook sums up what you need to know before a work trip.'), p(D1), p(C1), p('Keep your receipts until Finance has paid you.')], [
    m('domestic', 'in_sync', D1, '$60', 'per day', 'domestic trips'),
    m('claims', 'in_sync', C1, '30 days', 'days', null),
  ]),
  page(TRAP_SLUG, 'NLHR', 'Learning and Development: Training Courses', 'copy', [
    p('Nimbus Labs pays for courses that help you grow in your role.'),
    p('Book a course through the learning portal and tell your team lead the dates.'),
    p(TRAP),
    p('Course fees are paid directly by People Ops.'),
  ], [m('domestic', 'unsure', TRAP, '$40', 'per day', 'training course days')]),
  page('hr-relocation', 'NLHR', 'Relocation Guide', 'copy', [p('Moving to a new office is a big step, and People Ops is here to help. Your trip to the new office is booked as domestic travel.'), p(D3), p('Ask People Ops for the moving checklist.')], [
    m('domestic', 'in_sync', D3, '$60', 'per day', 'domestic travel'),
  ]),
  page('hr-policy-history', 'NLHR', 'Travel Policy History', 'historical', [p('This page records how the travel policy has changed over time.'), p(HIST), p('Questions about older rules go to People Ops.')], [
    m('domestic', 'historical', HIST, '$50', 'per day', 'domestic'),
  ]),
  page('onb-first-week', 'NLONB', 'Your First Week at Nimbus Labs', 'copy', [p('Welcome to Nimbus Labs! Here is what your first week looks like. You may visit another office.'), p(D5), p('Your laptop is ready at the front desk on day one.')], [
    m('domestic', 'in_sync', D5, '$60', 'per day', 'domestic trip'),
  ]),
  page('onb-new-joiner-faq', 'NLONB', 'New Joiner FAQ', 'copy', [faq('Do I get money for meals when I travel?', D6), faq('Where do I find the holiday calendar?', 'It is pinned in the #general channel.')], [
    m('domestic', 'in_sync', D6, '$60', 'per day', 'domestic travel'),
  ]),
  page('onb-buddy-guide', 'NLONB', 'Onboarding Buddy Guide', 'copy', [p('Buddies help new hires find their way during the first month. You may visit your buddy in another city.'), p(D7), p('Meet your buddy at least once a week.')], [
    m('domestic', 'in_sync', D7, '$60', 'per day', 'domestic trips'),
  ]),
  page('onb-manager-checklist', 'NLONB', 'Manager Onboarding Checklist', 'copy', [p('Use this checklist in the first two weeks of a new hire.'), `<ul><li>${p(D8)}</li><li>${p(A8)}</li></ul>`], [
    m('domestic', 'in_sync', D8, '$60', 'per day', 'domestic trips'),
    m('approval', 'in_sync', A8, '$2,000', 'USD', 'before booking'),
  ]),
  page('fin-expense-faq', 'NLFIN', 'Expense Claims FAQ', 'copy', [faq('How long do I have to submit?', C9), faq('Do I need receipts for meals?', D9)], [
    m('claims', 'drifted', C9, '45 days', 'days', null),
    m('domestic', 'in_sync', D9, '$60', 'per day', 'domestic trips'),
  ]),
  page('fin-per-diem-rates', 'NLFIN', 'Per Diem Rates', 'copy', [p('Finance updates these rates when the travel policy changes.'), `<ul><li>${p(D10)}</li><li>${p(I10)}</li></ul>`], [
    m('domestic', 'in_sync', D10, '$60', 'per day', 'domestic travel'),
    m('international', 'drifted', I10, '$100', 'per day', 'International travel'),
  ]),
  page('fin-corporate-card', 'NLFIN', 'Corporate Card Guide', 'copy', [p('Use the corporate card for flights, hotels and conference tickets.'), p(D11)], [
    m('domestic', 'in_sync', D11, '$60', 'per day', 'domestic travel'),
  ]),
  page('fin-month-end', 'NLFIN', 'Month-End Close Checklist', 'copy', [p('Finance closes the books on the third working day of each month.'), p(C12)], [m('claims', 'in_sync', C12, '30 days', 'days', null)]),
  page('sales-travel-guide', 'NLSALES', 'Sales Team Travel Guide', 'copy', [p('Customer visits are the heart of our sales motion, so plan them well.'), p(D13), p(A13)], [
    m('domestic', 'drifted', D13, '$65', 'per day', 'domestic customer visits'),
    m('approval', 'drifted', A13, '$2,500', 'USD', 'before booking'),
  ]),
  page('sales-qbr-prep', 'NLSALES', 'Quarterly Business Review Prep', 'copy', [p('A QBR is our chance to show customers the value they get from Nimbus Labs. Budget the travel of each attendee.'), p(D14)], [
    m('domestic', 'in_sync', D14, '$60', 'per day', 'domestic trips'),
  ]),
  page('sales-conference-playbook', 'NLSALES', 'Conference Playbook', 'copy', [p('Conferences help us meet many prospects in a few days.'), p(I15), p(D15)], [
    m('international', 'in_sync', I15, '$90', 'per day', 'international travel'),
    m('domestic', 'in_sync', D15, '$60', 'per day', 'domestic travel'),
  ]),
  page('help-per-diem', 'NLHELP', 'FAQ: How much is the per diem?', 'copy', [faq('How much is the per diem?', D16), p('This article is maintained by the IT and HR Help Center.')], [
    m('domestic', 'in_sync', D16, '$60', 'per day', 'domestic travel'),
  ]),
  page('help-booking-travel', 'NLHELP', 'FAQ: How do I book work travel?', 'copy', [faq('How do I book work travel?', 'Book flights and hotels in the travel tool.'), faq('Do I book meals too?', D17)], [
    m('domestic', 'in_sync', D17, '$60', 'per day', 'domestic trips'),
  ]),
  page('help-flight-class', 'NLHELP', 'FAQ: Which flight class can I book?', 'copy', [faq('Which flight class can I book?', F18), p('Longer flights follow the rules on the Travel Policy page.')], [
    m('flight', 'in_sync', F18, 'economy class', null, 'flights under 6 hours'),
  ]),
];

/** What the demo must show once the juror marks "Travel Policy" as the source and the scan finishes. */
export const NIMBUS_EXPECTED = {
  copyPages: 17,
  /** "23 copies" (in sync + drifted + unsure; the historical mention is not a copy). */
  copies: 23,
  /** "4 out of date". */
  outOfDate: 4,
  inSync: 18,
  unsure: 1,
  historical: 1,
  /** Copies of the domestic per diem: the $60 → $75 change modal shows "14 copies". */
  domesticCopies: 14,
} as const;

/** Every page the loader creates, source first. */
export const NIMBUS_ALL_PAGES: readonly NimbusPage[] = [NIMBUS_SOURCE, ...NIMBUS_PAGES];
