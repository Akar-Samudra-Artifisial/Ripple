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

/** Resolver name → payload and success reply. Every resolver may also answer `ErrorReply`. */
export interface ResolverContract {
  getBylineStatus: { payload: undefined; reply: BylineStatus };
  getSourceStatus: { payload: undefined; reply: SourceStatus };
  markSource: { payload: undefined; reply: SourceStatus };
  unmarkSource: { payload: undefined; reply: SourceStatus };
  listFacts: { payload: undefined; reply: FactList };
  confirmFact: { payload: FactIdPayload; reply: FactActionResult };
  rejectFact: { payload: FactIdPayload; reply: FactActionResult };
  editFact: { payload: FactEditPayload; reply: FactActionResult };
}
