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
  /** True when the graph failed and the last good answer (≤24 h old) is shown instead; displayed like any answer. */
  stale?: boolean;
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
  /** M3: a detected change of this source's facts waits for confirmation (open `getPendingChange`). */
  pendingChange: PendingChangeFlag | null;
  /** M4: edit proposals waiting for a decision on this (copy) page; 0 when none or the lookup failed. */
  pendingProposals: number;
}

export interface PendingChangeFlag {
  id: string;
  /** Number of changed facts. */
  facts: number;
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

// ---------------------------------------------------------------------------------------------------------------
// M3: change detection (FR-7). Saving a source page queues a re-extraction; confirmed facts whose value changed form
// one pending change per source, which an editor of the source confirms (with a deadline) or dismisses.
// ---------------------------------------------------------------------------------------------------------------

export interface FactChangeView {
  factId: string;
  /** "Travel per diem · Amount per day · Domestic travel". */
  factLabel: string;
  oldValue: string;
  oldUnit: string | null;
  newValue: string;
  newUnit: string | null;
  /** Verbatim sentence of the new page version. */
  newQuote: string;
}

/** A page holding copies to update, with its owner (REST v2 `ownerId`, else `authorId`). */
export interface ChangePageView {
  pageId: string;
  pageTitle: string | null;
  pageUrl: string | null;
  spaceId: string | null;
  copies: number;
  owner: OwnerView;
}

export type TeamSource = 'teamwork_graph' | 'none' | 'unknown';

export interface ChangeSpaceView {
  spaceId: string;
  teams: TeamView[];
  /**
   * Where the teams came from; `none` = Teamwork Graph answered that no team is linked; `unknown` = the read failed
   * (an error such as a missing permission), so whether a team is linked is not known.
   */
  teamSource: TeamSource;
  /** True when the graph failed and the last good answer (≤24 h old) stands in; `teamSource` is then not `unknown`. */
  stale?: boolean;
}

export interface PendingChangeView {
  id: string;
  /** Source page version the change was read from. Send it back with `confirmChange`. */
  version: number;
  detectedAt: string | null;
  facts: FactChangeView[];
  /** Confirmed facts no longer found on the page (reported only, never deleted). */
  missingFacts: number;
  /** Copies to update on pages the viewer may open. */
  copies: number;
  pages: ChangePageView[];
  /** Copies to update on pages the viewer cannot open (NFR-3). */
  hiddenCount: number;
  /** Not propagated, shown for context. */
  unsure: number;
  historical: number;
  /** In-sync copies whose stated value could not be compared: not propagated automatically, check by hand. */
  needsCheck: number;
  /** Copies that already state the new value. */
  alreadyNew: number;
  spaces: ChangeSpaceView[];
  defaultDeadlineDays: number;
  /** `YYYY-MM-DD`, today + `defaultDeadlineDays` working days. */
  defaultDeadline: string;
  /** Edit permission on the source (required to confirm or dismiss). */
  canDecide: boolean;
  /** M5: a Jira project is set in Ripple settings; false = confirming creates no update tasks (show a note). */
  jiraConfigured: boolean;
}

/** Reply of `getPendingChange`; `change` is null when nothing waits. */
export interface PendingChangeReply {
  pageId: string;
  change: PendingChangeView | null;
}

export interface ChangeIdPayload {
  changeId: string;
  /** `PendingChangeView.version` the user reviewed; a change replaced by a newer version must be reviewed again. */
  version: number;
}

export interface ConfirmChangePayload extends ChangeIdPayload {
  /** Working days the copy owners get (1–30); default 5. */
  deadlineDays?: number;
}

/** Reply of `confirmChange` / `dismissChange`. */
export interface ChangeDecision {
  changeId: string;
  status: 'confirmed' | 'dismissed';
  factsUpdated: number;
  /** Copies that now count as drifted from the new value (confirm only). */
  copiesDrifted: number;
  deadline: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// M4: edit proposals per copy (FR-8). Copy-page resolvers take the page id from the context (the copy page being
// viewed); a proposal of another page is "gone". Writes run as the approving user.
// ---------------------------------------------------------------------------------------------------------------

export type ProposalState = 'proposed' | 'approved' | 'applied' | 'rejected' | 'stale' | 'needs_manual' | 'failed';

export interface ProposalView {
  id: string;
  changeId: string;
  status: ProposalState;
  /** The copy's current sentence and the sentence Ripple proposes (null when none could be made). */
  oldSentence: string | null;
  newSentence: string | null;
  oldValue: string | null;
  newValue: string | null;
  method: 'token' | 'llm' | null;
  /** Enum code when `needs_manual`/`failed`/`stale` (e.g. `crosses_markup`, `version_changed`, `forbidden`). */
  errorCode: string | null;
  /** Null when the viewer cannot open the source page (the card shows "An update from a source you can't view"). */
  sourcePageId: string | null;
  /** Null when the viewer cannot open the source page. */
  sourceTitle: string | null;
  /** True when the viewer cannot open the source page. */
  sourceHidden: boolean;
  /** "Subject · attribute" of the source fact; null when the source is hidden or the fact is gone. */
  factLabel: string | null;
  appliedVersion: number | null;
}

export interface ProposalList {
  pageId: string;
  /** The viewer may edit this page (approve/reject buttons). */
  canEdit: boolean;
  proposals: ProposalView[];
}

export interface ChangeIdOnlyPayload {
  changeId: string;
}

export interface ProposalIdPayload {
  proposalId: string;
}

export interface ApproveProposalPayload {
  proposalId: string;
  /** The user's own wording; must state the new value and not the old one. */
  editedSentence?: string;
}

export interface ProposalDecision {
  proposalId: string;
  /** Status after the call (`applied`, `stale`, `needs_manual`, `failed`, `rejected`, or `approved` while another call applies it). */
  status: ProposalState;
  errorCode: string | null;
  /** Page version saved by Ripple when applied. */
  version: number | null;
}

export interface ApproveAllResult {
  applied: number;
  stale: number;
  needsManual: number;
  failed: number;
  version: number | null;
}

export interface RolloutItem {
  proposalId: string;
  pageId: string;
  pageTitle: string | null;
  pageUrl: string | null;
  status: ProposalState;
  errorCode: string | null;
  /** Owner (or author) of the copy page as the viewer can read it; display name null when unknown. */
  owner: { accountId: string | null; displayName: string | null };
}

/** Reply of `getLatestChange`: the most recently confirmed change of the viewed source, or null. */
export interface LatestChangeReply {
  pageId: string;
  change: { changeId: string; version: number } | null;
}

/** Progress of a confirmed change over its copies (source page); pages the viewer cannot open are only counted. */
export interface Rollout {
  changeId: string;
  items: RolloutItem[];
  counts: Partial<Record<ProposalState, number>>;
  hiddenCount: number;
  /** M5: Jira update tasks of this change (one per copy-page owner). */
  issues: RolloutIssue[];
  /**
   * `not_configured`: no Jira project in Ripple settings; `pending`: being created (or not yet); `created`: every
   * owner who needs one has one (also when no owner needs one); `partial`: some failed or missing; `failed`: all failed.
   */
  issuesState: IssuesStateView;
}

export type IssuesStateView = 'not_configured' | 'pending' | 'created' | 'partial' | 'failed';

export interface RolloutIssue {
  /** Null when the owner's name is not visible to the viewer (no page of theirs the viewer can open). */
  ownerName: string | null;
  issueKey: string;
  issueUrl: string | null;
  /** `done`: Ripple closed it (every page of the owner updated, declined, superseded or reverted). */
  status: 'open' | 'done';
  pageCount: number;
}

// ---------------------------------------------------------------------------------------------------------------
// M5: settings (Confluence global settings page) and the Jira issue panel
// ---------------------------------------------------------------------------------------------------------------

export interface SettingsView {
  /** Jira project for update tasks; null = no issues are created. */
  jiraProjectKey: string | null;
  /** The viewer may save (Jira administrators). */
  canEdit: boolean;
  /** Result of the Jira admin check; `check_failed` = it could not be made (try again), not "not an admin". */
  adminCheck: AdminCheck;
}

export type AdminCheck = 'admin' | 'not_admin' | 'check_failed';

export interface SaveSettingsPayload {
  /** Project key (e.g. `OPS`); empty or null turns update tasks off. */
  jiraProjectKey: string | null;
}

export interface SaveSettingsResult {
  ok: boolean;
  /**
   * `invalid_key`, `not_allowed` (not a Jira admin), `admin_check_failed` (the admin check could not be made),
   * `project_not_found`, `jira_unavailable` (Ripple not installed in Jira), `jira_error`.
   */
  errorCode: 'invalid_key' | 'not_allowed' | 'admin_check_failed' | 'project_not_found' | 'jira_unavailable' | 'jira_error' | null;
}

/** Reply of `getApproval` (Jira issue panel, read-only); `task` is null for issues Ripple did not create. */
export interface ApprovalView {
  issueKey: string;
  task: {
    changeId: string;
    deadline: string | null;
    closed: boolean;
    /** Owner's pages; title null when the page may not be named to everyone (shown as "Page <id>"). */
    pages: { pageId: string; title: string | null; url: string | null; open: number; applied: number }[];
    morePages: number;
  } | null;
}

// ---------------------------------------------------------------------------------------------------------------
// M6: "Load demo data" (Ripple settings page, Jira administrators)
// ---------------------------------------------------------------------------------------------------------------

/** Progress of the Nimbus Labs demo data; `loadDemoData` loads in steps, the UI calls it again while `loading`. */
export interface DemoStatus {
  state: 'idle' | 'loading' | 'done' | 'failed';
  /** Spaces and pages created or found so far, out of `total`. */
  step: number;
  total: number;
  spaces: { key: string; name: string; url: string | null }[];
  /** The "Travel Policy" page to mark as the source (Ripple never marks it itself). */
  sourcePageUrl: string | null;
  /** The viewer may load the demo data (Jira administrators). */
  canEdit: boolean;
  /**
   * `not_allowed`, `admin_check_failed`, `invalid_owner_ids`, `owner_change_failed` (some pages kept the admin as
   * owner), or the failing step (`space_create_http_403`, `page_find_http_404`, …).
   */
  errorCode: string | null;
}

export interface LoadDemoPayload {
  /** Optional page owners (Atlassian account ids, at most 6), given out round robin; default: the caller. */
  ownerAccountIds?: string[];
}

/** Resolver name → payload and success reply. Every resolver may also answer `ErrorReply`. */
export interface ResolverContract {
  /** Proposals for the copy page being viewed. */
  listProposalsForPage: { payload: undefined; reply: ProposalList };
  /** Edit permission on the copy page; applies the edit as the user ("Updated by Ripple from <source>"). */
  approveProposal: { payload: ApproveProposalPayload; reply: ProposalDecision };
  rejectProposal: { payload: ProposalIdPayload; reply: ProposalDecision };
  /** Rejects the proposal and ignores the copy (not the same fact). */
  markNotSameFact: { payload: ProposalIdPayload; reply: ProposalDecision };
  /** Applies every open proposal of the page in one version. */
  approveAll: { payload: undefined; reply: ApproveAllResult };
  /** On the source page: proposals of one of its changes, with its Jira update tasks. */
  listRollout: { payload: ChangeIdOnlyPayload; reply: Rollout };
  /** Ripple settings page (Confluence global settings). */
  getSettings: { payload: undefined; reply: SettingsView };
  /** Jira administrators only; the project must exist and be visible to the app. */
  saveSettings: { payload: SaveSettingsPayload; reply: SaveSettingsResult };
  /** Jira issue panel: the update task's pages (read-only). */
  getApproval: { payload: undefined; reply: ApprovalView };
  /** M6, Ripple settings page: progress of the Nimbus Labs demo data. */
  getDemoStatus: { payload: undefined; reply: DemoStatus };
  /** Jira administrators only: creates (or resumes creating) the demo spaces and pages as the caller; idempotent. */
  loadDemoData: { payload: LoadDemoPayload; reply: DemoStatus };
  /** On the source page: the latest confirmed change (for the Rollout tab). */
  getLatestChange: { payload: undefined; reply: LatestChangeReply };
  getPendingChange: { payload: undefined; reply: PendingChangeReply };
  /** Edit permission on the source; sets the facts to their new values and records the deadline (M4 proposes edits). */
  confirmChange: { payload: ConfirmChangePayload; reply: ChangeDecision };
  dismissChange: { payload: ChangeIdPayload; reply: ChangeDecision };
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
