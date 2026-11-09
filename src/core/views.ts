/**
 * Resolver reply shapes shared by the backend and the Custom UI (ui/src). Types only, no imports, so the UI bundle
 * never pulls in Forge runtime packages.
 */

/** Reply of a handler declared in the manifest but not built yet (M0 ships the final manifest with stubs). */
export interface NotImplemented {
  status: 'not_implemented';
  feature: string;
  message: string;
}

export interface TeamView {
  id: string;
  name: string;
}

export interface SchemaView {
  status: 'ready' | 'setting_up' | 'error';
  applied: number;
  total: number;
  latest: string;
  error?: string;
}

export interface SpaceTeamsView {
  spaceId: string | null;
  teams: TeamView[];
  /** False when the graph answered `data: null` (missing scope / query context) or the call failed. */
  dataPresent: boolean;
  errors: string[];
}

/** Page owner from Confluence REST v2 (`ownerId`, else `authorId`), named via users-bulk. */
export interface OwnerView {
  accountId: string | null;
  role: 'owner' | 'author' | null;
  /** Null when the name lookup failed or the profile is hidden; the UI then says "Unknown user". */
  displayName: string | null;
  errors: string[];
}

export interface BylineStatus {
  message: string;
  schema: SchemaView;
  owner: OwnerView;
  spaceTeams: SpaceTeamsView;
}

// ---------------------------------------------------------------------------------------------------------------
// M1: source of truth and fact review (FR-1..3). Resolver contract for the byline UI; the page id always comes from
// the Forge context (the page being viewed), never from the payload.
// ---------------------------------------------------------------------------------------------------------------

/** Supported fact types (PRD "Jenis fakta"): number+unit, date/deadline, closed list, name/term, yes/no rule. */
export type FactType = 'number' | 'date' | 'list' | 'name' | 'rule';
/** `proposed` = extracted, waiting for review; `rejected` facts are kept so re-extraction does not bring them back. */
export type FactStatus = 'proposed' | 'confirmed' | 'rejected';
/** `extracting` while the `extract` queue job runs; poll `getSourceStatus` until `ready` or `error`. */
export type SourceState = 'extracting' | 'ready' | 'error';

export interface FactView {
  id: string;
  type: FactType;
  subject: string;
  attribute: string;
  value: string;
  unit: string | null;
  condition: string | null;
  /** Verbatim sentence from the page, verified against the page text before the fact was saved. */
  quote: string;
  status: FactStatus;
  /** True once a reviewer changed subject/attribute/value/unit/condition; re-extraction then leaves it alone. */
  edited: boolean;
  /** Value before the page last changed it (confirmed facts only); propagation candidate for M2. */
  previousValue: string | null;
  pageVersion: number;
  /** ISO date-time of the page version the fact was read from ("Berlaku sejak"). */
  effectiveSince: string | null;
}

export interface FactCounts {
  proposed: number;
  confirmed: number;
  rejected: number;
}

export interface SourceView {
  pageId: string;
  title: string | null;
  state: SourceState;
  pageVersion: number | null;
  markedAt: string;
  extractedAt: string | null;
  /** Scrubbed reason when `state` is `error`. */
  error: string | null;
  /** True when the page was longer than Ripple reads (12,000 characters of text): facts past the cut are missing. */
  truncated?: boolean;
}

/** Reply of `getSourceStatus`, `markSource` and `unmarkSource`. */
export interface SourceStatus {
  pageId: string;
  /** Whether the viewing user may mark/unmark and review (edit permission on the page, checked server-side). */
  canEdit: boolean;
  /** Null when the page is not a source of truth. */
  source: SourceView | null;
  counts: FactCounts;
  /** Set when the database is still being set up; retry later. */
  notice: string | null;
}

/** Reply of `listFacts` (confirmed first, then proposed, then rejected). */
export interface FactList {
  pageId: string;
  facts: FactView[];
}

export interface FactIdPayload {
  factId: string;
}

/** `editFact`: every field is required; send the current value for fields that did not change. */
export interface FactEditPayload extends FactIdPayload {
  subject: string;
  attribute: string;
  value: string;
  unit: string | null;
  condition: string | null;
}

/** Reply of `confirmFact`, `editFact` and `rejectFact`. */
export interface FactActionResult {
  fact: FactView;
}

/** Error reply of any resolver; `call()` in ui/src/bridge.ts throws it as an Error with this message. */
export interface ErrorReply {
  error: string;
}

// ---------------------------------------------------------------------------------------------------------------
// M2: copies of the source's facts on other pages (FR-4..6). Search and judging run in the `search` and `judge`
// queue consumers; the UI starts a scan and polls `getScanStatus`.
// ---------------------------------------------------------------------------------------------------------------

/**
 * PRD "Status salinan": `in_sync` Sesuai, `drifted` Menyimpang, `unsure` Tidak pasti (e.g. another condition),
 * `ignored` Diabaikan (owner: not the same fact), `updated` Diperbarui. `historical` = the page mentions the fact as
 * past/changelog text; never drift, listed only on request.
 */
export type CopyStatus = 'in_sync' | 'drifted' | 'unsure' | 'historical' | 'ignored' | 'updated';
export const COPY_STATUSES: readonly CopyStatus[] = ['in_sync', 'drifted', 'unsure', 'historical', 'ignored', 'updated'];

/** `searching`: CQL per fact; `judging`: candidate pages are read and judged in batches; `done`/`error` are final. */
export type ScanState = 'searching' | 'judging' | 'done' | 'error';

export interface ScanView {
  id: string;
  state: ScanState;
  /** No progress for 15 minutes while running; `startScan` resumes it from the last batch. */
  stalled: boolean;
  factsTotal: number;
  factsSearched: number;
  /** Distinct candidate pages found by CQL (at most 200 per fact). */
  candidates: number;
  pagesJudged: number;
  /** Candidate pages that could not be read or judged (e.g. no access for the app); not counted as copies. */
  pagesSkipped?: number;
  /** True when the scan stopped at the per-scan LLM call cap: some candidate pages were not checked. */
  partial?: boolean;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export type CopyCounts = Record<CopyStatus, number>;

/** Reply of `getScanStatus` and `startScan`. Counts cover all copies, also those on pages the viewer cannot open. */
export interface ScanStatus {
  pageId: string;
  canEdit: boolean;
  scan: ScanView | null;
  counts: CopyCounts;
}

export interface CopyView {
  id: string;
  factId: string;
  /** "Travel per diem · Amount per day · Domestic travel". */
  factLabel: string;
  officialValue: string;
  officialUnit: string | null;
  pageId: string;
  pageTitle: string;
  /** Relative Confluence link (`/spaces/…/pages/…`); prefix with the site URL. */
  pageUrl: string | null;
  status: CopyStatus;
  statedValue: string | null;
  statedUnit: string | null;
  statedCondition: string | null;
  /** Verbatim sentence from the copy page, verified against its text. */
  quote: string;
  /** Short reason for the status, e.g. "Value differs: 45 days vs 30 days". */
  reason: string;
  judgedAt: string | null;
}

/** `listCopies` payload; `status` omitted = everything except `historical`. */
export interface CopyListPayload {
  status?: CopyStatus;
}

/** Reply of `listCopies`: only pages the viewer may open; the rest are counted in `hiddenCount` (NFR-3). */
export interface CopyList {
  pageId: string;
  copies: CopyView[];
  hiddenCount: number;
}

/** Resolver name → payload and success reply. Every resolver may also answer `ErrorReply`. */
export interface ResolverContract {
  getScanStatus: { payload: undefined; reply: ScanStatus };
  /** Starts a scan (edit permission; source ready with ≥1 confirmed fact), or resumes a stalled one. */
  startScan: { payload: undefined; reply: ScanStatus };
  listCopies: { payload: CopyListPayload; reply: CopyList };
  getBylineStatus: { payload: undefined; reply: BylineStatus };
  getSourceStatus: { payload: undefined; reply: SourceStatus };
  markSource: { payload: undefined; reply: SourceStatus };
  unmarkSource: { payload: undefined; reply: SourceStatus };
  listFacts: { payload: undefined; reply: FactList };
  confirmFact: { payload: FactIdPayload; reply: FactActionResult };
  rejectFact: { payload: FactIdPayload; reply: FactActionResult };
  editFact: { payload: FactEditPayload; reply: FactActionResult };
}
