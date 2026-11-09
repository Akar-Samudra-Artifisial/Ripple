/**
 * M5: one Jira issue per copy-page owner per confirmed change. Pure logic: which owner gets an issue for which pages,
 * the issue's summary and ADF body, when an issue can be closed and the state the Rollout tab shows.
 *
 * Every piece of text sits in an ADF `text` node (never HTML or markdown), so a page title or value cannot inject
 * markup into the Jira issue.
 */
import type { IssuesStateView } from './views';

/** `creating`: claimed by a job (the claim stops a second issue); `failed`: creation failed, claimable again. */
export type IssueStatus = 'creating' | 'created' | 'failed' | 'closed';

export type AdfMark = { type: 'link'; attrs: { href: string } };
export type AdfNode =
  | { type: 'text'; text: string; marks?: AdfMark[] }
  | { type: 'mention'; attrs: { id: string } }
  | { type: 'paragraph'; content: AdfNode[] }
  | { type: 'bulletList'; content: AdfNode[] }
  | { type: 'listItem'; content: AdfNode[] };

/** Atlassian Document Format document. */
export type AdfDoc = { type: 'doc'; version: 1; content: AdfNode[] };

export const ISSUE_LABELS = ['ripple', 'ripple-update'] as const;
/** Claims of a (change, owner) issue after which a failed one is not retried (heal, redelivered jobs). */
export const MAX_ISSUE_ATTEMPTS = 3;
/** The per-(change, owner) label: `ripple-c<8 hex of the change id>-<8 hex of sha256(owner account id)>`. */
export const ISSUE_TAG = /^ripple-c[0-9a-f]{8}-[0-9a-f]{8}$/;

/** The issue's unique label; `ownerHash` is the hex sha256 of the owner's account id (never the raw id). */
export function issueTag(changeId: string, ownerHash: string): string {
  const tag = `ripple-c${changeId.replace(/[^0-9a-fA-F]/g, '').slice(0, 8).toLowerCase()}-${ownerHash.slice(0, 8).toLowerCase()}`;
  if (!ISSUE_TAG.test(tag)) throw new Error('invalid issue tag input');
  return tag;
}

/** Issue body text when the source page may not be named (no fact label, no old/new value). */
export const GENERIC_FACT_TEXT = 'An official fact changed; open the pages below to review the proposed update.';
/** Pages listed in one issue; more are counted ("and N more"). */
export const MAX_ISSUE_PAGES = 20;

/** Proposal states that still need the owner: an issue is created for pages that have one. */
const NEEDS_OWNER = new Set(['proposed', 'needs_manual', 'failed']);
/** Proposal states that need nothing more (applied, or rejected incl. superseded / reverted / not the same fact). */
const CLOSED = new Set(['applied', 'rejected']);

export interface RoutedPage {
  pageId: string;
  spaceId: string | null;
  ownerAccountId: string | null;
}

export interface ProposalState {
  pageId: string;
  factId: string;
  status: string;
  errorCode: string | null;
}

export interface OwnerGroup {
  ownerAccountId: string;
  /** Pages of this owner with a proposal that needs them, in routing order. */
  pageIds: string[];
}

/**
 * One group per owner of pages with a proposal that needs them; pages without an owner get no issue and are only
 * counted (`unowned`). The confirming user gets an issue too when they own pages.
 */
export function groupByOwner(pages: readonly RoutedPage[], proposals: readonly ProposalState[]): { groups: OwnerGroup[]; unowned: number } {
  const needy = new Set(proposals.filter((p) => NEEDS_OWNER.has(p.status)).map((p) => p.pageId));
  const groups = new Map<string, string[]>();
  let unowned = 0;
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.pageId) || !needy.has(page.pageId)) continue;
    seen.add(page.pageId);
    if (!page.ownerAccountId) {
      unowned++;
      continue;
    }
    const list = groups.get(page.ownerAccountId) ?? [];
    list.push(page.pageId);
    groups.set(page.ownerAccountId, list);
  }
  return { groups: [...groups].map(([ownerAccountId, pageIds]) => ({ ownerAccountId, pageIds })), unowned };
}

/** Whitespace collapsed and clipped; never empty (ADF rejects an empty text node). */
export function clean(text: string, max: number, fallback = '-'): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const clipped = t.length > max ? `${t.slice(0, max - 1)}…` : t;
  return clipped === '' ? fallback : clipped;
}

/** "Update N pages for <source>"; the source title only when it may be named to anyone (`pageIsOpen`). */
export function issueSummary(pageCount: number, sourceTitle: string | null): string {
  const pages = `${pageCount} page${pageCount === 1 ? '' : 's'}`;
  const title = sourceTitle === null ? '' : clean(sourceTitle, 150, '');
  return title === '' ? `Update ${pages} for a changed official fact` : `Update ${pages} for ${title}`;
}

export interface IssueFact {
  label: string;
  oldValue: string;
  newValue: string;
}

export interface IssuePage {
  /** Title when the page may be named to anyone, else null ("Page <id>"). */
  title: string | null;
  pageId: string;
  /** Absolute https URL, or null when unknown. */
  url: string | null;
}

export interface IssueBodyInput {
  ownerAccountId: string;
  /** Null when the source page is not open: the body names no fact and no value (`GENERIC_FACT_TEXT`). */
  facts: readonly IssueFact[] | null;
  pages: readonly IssuePage[];
  /** Pages beyond the listed ones. */
  morePages: number;
  /** Team names of the spaces of open pages (Teamwork Graph); empty = no team line. */
  teams: readonly string[];
  /** `YYYY-MM-DD`, or null. */
  deadline: string | null;
}

const text = (t: string, marks?: AdfMark[]): AdfNode => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const bullets = (items: AdfNode[][]): AdfNode => ({ type: 'bulletList', content: items.map((c) => ({ type: 'listItem', content: [para(...c)] })) });

const isHttps = (url: string | null): url is string => url !== null && /^https:\/\/[^\s]+$/.test(url) && url.length <= 2000;

/** The issue body: who, what changed, which pages (with links), the team and the deadline. */
export function issueAdf(input: IssueBodyInput): AdfDoc {
  const due = input.deadline ? ` by ${input.deadline}` : '';
  const content: AdfNode[] = [
    para({ type: 'mention', attrs: { id: input.ownerAccountId } }, text(` an official fact changed in Confluence. Please update the pages you own${due}.`)),
    ...(input.facts === null
      ? [para(text(GENERIC_FACT_TEXT))]
      : [para(text('What changed:')), bullets(input.facts.map((f) => [text(`${clean(f.label, 200)}: ${clean(f.oldValue, 200)} → ${clean(f.newValue, 200)}`)]))]),
    para(text('Pages to update:')),
    bullets(
      input.pages.map((p) => {
        const name = p.title === null ? `Page ${p.pageId}` : clean(p.title, 200, `Page ${p.pageId}`);
        return [isHttps(p.url) ? text(name, [{ type: 'link', attrs: { href: p.url } }]) : text(name)];
      }),
    ),
  ];
  if (input.morePages > 0) content.push(para(text(`And ${input.morePages} more page${input.morePages === 1 ? '' : 's'}.`)));
  if (input.teams.length > 0) content.push(para(text(`Team: ${clean(input.teams.join(', '), 300)} (via Teamwork Graph)`)));
  content.push(para(text("Open each page in Confluence to review and approve Ripple's proposed edit. This task closes when every page is done.")));
  return { type: 'doc', version: 1, content };
}

export type CloseKind = 'updated' | 'superseded' | 'reverted';

/**
 * Whether the owner's issue can close: every proposal on their pages is applied or rejected. The comment says why:
 * all replaced by a newer change (`superseded`), undone (`reverted`, possibly with superseded ones), else `updated`.
 * Null while any proposal is open, or when there is none.
 */
export function closeKind(proposals: readonly ProposalState[]): CloseKind | null {
  if (proposals.length === 0 || proposals.some((p) => !CLOSED.has(p.status))) return null;
  if (proposals.every((p) => p.status === 'rejected' && p.errorCode === 'superseded')) return 'superseded';
  if (proposals.every((p) => p.status === 'rejected' && (p.errorCode === 'superseded' || p.errorCode === 'reverted'))) return 'reverted';
  return 'updated';
}

const CLOSE_TEXT: Record<CloseKind, string> = {
  updated: 'All pages in this task were updated or declined in Confluence. Closed by Ripple.',
  superseded: 'A newer change of the official fact replaced this one, so these edits are no longer needed. Closed by Ripple.',
  reverted: 'The change of the official fact was undone, so these edits are no longer needed. Closed by Ripple.',
};

export function closingComment(kind: CloseKind): AdfDoc {
  return { type: 'doc', version: 1, content: [para(text(CLOSE_TEXT[kind]))] };
}

export type IssuesState = IssuesStateView;

/**
 * Rollout state of a change's issues: `expectedOwners` are the owners that need one now (`groupByOwner`). With no
 * owner needing an issue and none created, the state is `created` (nothing left to create).
 */
export function issuesState(configured: boolean, rows: readonly { ownerAccountId: string; status: IssueStatus }[], expectedOwners: readonly string[]): IssuesState {
  if (rows.length === 0) return !configured ? 'not_configured' : expectedOwners.length > 0 ? 'pending' : 'created';
  const done = rows.filter((r) => r.status === 'created' || r.status === 'closed').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const creating = rows.filter((r) => r.status === 'creating').length;
  const have = new Set(rows.map((r) => r.ownerAccountId));
  const missing = configured ? expectedOwners.filter((o) => !have.has(o)).length : 0;
  if (creating > 0) return 'pending';
  if (failed > 0) return done > 0 ? 'partial' : 'failed';
  if (missing > 0) return 'partial';
  return 'created';
}

/**
 * True when an owner needs an issue that does not exist yet (no row) or whose creation failed fewer than
 * `MAX_ISSUE_ATTEMPTS` times: heal queues the job. After that the Rollout shows `failed` and heal stops.
 */
export function issuesMissing(pages: readonly RoutedPage[], proposals: readonly ProposalState[], rows: readonly { ownerAccountId: string; status: IssueStatus; attempts?: number }[]): boolean {
  const byOwner = new Map(rows.map((r) => [r.ownerAccountId, r]));
  return groupByOwner(pages, proposals).groups.some((g) => {
    const row = byOwner.get(g.ownerAccountId);
    return row === undefined || (row.status === 'failed' && (row.attempts ?? 0) < MAX_ISSUE_ATTEMPTS);
  });
}

/** A `YYYY-MM-DD` date Jira accepts as `duedate`, else undefined. */
export function dueDate(deadline: string | null | undefined): string | undefined {
  return typeof deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : undefined;
}
