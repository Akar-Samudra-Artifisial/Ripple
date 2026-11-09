/**
 * M5: one Jira issue per copy-page owner per confirmed change (FR-9), created as the app at the end of the change's
 * propose job, and closed once every proposal on the owner's pages is applied or rejected. Jira is optional: without
 * a configured project nothing is created, and every Jira failure is logged (codes only) without failing the caller.
 *
 * Settings (Confluence global settings page): the Jira project key, saved by Jira administrators only.
 */
import { sqlChangeIssueRepo, PROJECT_KEY, type ChangeIssueRepo, type ChangeIssueRow, type CreatedIssueRef } from '../adapters/changeIssueRepo';
import { sha256, sqlChangeRepo, type ChangeRepo, type ChangeRow } from '../adapters/changeRepo';
import { pageIsOpen, pageLinkAsApp, type AppPageLink } from '../adapters/confluence';
import { JiraError, JiraUnavailableError, jira, type CreatedIssue, type JiraClient } from '../adapters/jira';
import { sqlProposalRepo, type ProposalRepo, type ProposalRow } from '../adapters/proposalRepo';
import { sqlRepo, type FactRepo } from '../adapters/repo';
import { ensureSchema } from '../adapters/sql';
import { scrubErrorText } from '../adapters/teamworkGraph';
import {
  closeKind,
  closingComment,
  dueDate,
  groupByOwner,
  ISSUE_LABELS,
  issueAdf,
  issuesMissing,
  issuesState,
  issueSummary,
  issueTag,
  MAX_ISSUE_PAGES,
  type IssueFact,
  type IssuePage,
  type IssuesState,
} from '../core/changeIssues';
import { valueLabel } from '../core/copies';
import { SchemaSettingUpError } from '../core/schema';
import type { ApprovalView, ErrorReply, RolloutIssue, SaveSettingsPayload, SaveSettingsResult, SettingsView } from '../core/views';

export const SETTINGS_MODULE = 'ripple-settings';
export const APPROVAL_MODULE = 'ripple-approval';

/** Error code of a Jira failure for logs and replies (never Jira's message, which may quote field values). */
export function jiraErrorCode(err: unknown): string {
  if (err instanceof JiraUnavailableError) return 'jira_unavailable';
  if (err instanceof JiraError) return err.status === 429 ? 'rate_limited' : `http_${err.status}`;
  return 'error';
}

export interface IssueDeps {
  repo: ChangeIssueRepo;
  jira: JiraClient;
  changes: Pick<ChangeRepo, 'getChange' | 'confirmedChanges'>;
  proposals: Pick<ProposalRepo, 'listForChange'>;
  facts: Pick<FactRepo, 'getSource' | 'listFacts'>;
  /** The page's title may be named to anyone (no read restriction). */
  isOpen: (pageId: string) => Promise<boolean>;
  /** Title and absolute URLs as the app; null when unreadable. */
  pageLink: (pageId: string) => Promise<AppPageLink | null>;
}

export const defaultIssueDeps: IssueDeps = {
  repo: sqlChangeIssueRepo,
  jira,
  changes: sqlChangeRepo,
  proposals: sqlProposalRepo,
  facts: sqlRepo,
  isOpen: pageIsOpen,
  pageLink: pageLinkAsApp,
};

export type CreateIssuesOutcome = { status: 'not_configured' } | { status: 'skipped'; reason: string } | { status: 'done'; created: number; failed: number; skipped: number; unowned: number };

const owned = (change: ChangeRow, owner: string): Set<string> => new Set((change.routing?.pages ?? []).filter((p) => p.ownerAccountId === owner).map((p) => p.pageId));

/** Fact lines for the proposals on these pages (label from the stored fact, values as the change states them). */
async function factLines(deps: IssueDeps, change: ChangeRow, rows: readonly ProposalRow[]): Promise<IssueFact[]> {
  const factIds = new Set(rows.map((p) => p.factId));
  const facts = new Map((await deps.facts.listFacts(change.sourcePageId)).map((f) => [f.id, f]));
  return change.factChanges
    .filter((c) => factIds.has(c.factId))
    .map((c) => {
      const f = facts.get(c.factId);
      return { label: f ? [f.subject, f.attribute].filter(Boolean).join(' · ') : 'Fact', oldValue: valueLabel(c.oldValue, c.oldUnit), newValue: valueLabel(c.newValue, c.newUnit) };
    });
}

/**
 * Listed pages: title and URL (with its title slug) only when the page may be named to anyone; otherwise
 * "Page <id>" linked by id only (`viewpage.action?pageId=`).
 */
async function issuePages(deps: IssueDeps, pageIds: readonly string[]): Promise<IssuePage[]> {
  const out: IssuePage[] = [];
  for (const pageId of pageIds.slice(0, MAX_ISSUE_PAGES)) {
    const link = await deps.pageLink(pageId);
    const open = link !== null && (await deps.isOpen(pageId));
    out.push(open ? { pageId, title: link.title, url: link.url } : { pageId, title: null, url: link?.idUrl ?? null });
  }
  return out;
}

/** Team names of the spaces of `openPageIds` only (pages that may be named), so no team is tied to a hidden page. */
function teamNames(change: ChangeRow, openPageIds: readonly string[]): string[] {
  const pageIds = new Set(openPageIds);
  const spaces = new Set((change.routing?.pages ?? []).filter((p) => pageIds.has(p.pageId)).map((p) => p.spaceId));
  const names = (change.routing?.spaces ?? []).filter((s) => spaces.has(s.spaceId)).flatMap((s) => (s.teams ?? []).map((t) => t.name));
  return [...new Set(names.filter((n) => n.trim() !== ''))];
}

/** Tries of recording a created issue on its claim. */
const COMPLETE_TRIES = 3;

/**
 * Records the created issue on the claim, retrying SQL failures. `lost`: another job took the claim over (it finds
 * the issue by label); `error`: still failing (the claim goes stale and the next claim finds the issue by label).
 */
async function completeWithRetry(repo: ChangeIssueRepo, changeId: string, owner: string, token: string, issue: CreatedIssueRef): Promise<'done' | 'lost' | 'error'> {
  for (let i = 1; ; i++) {
    try {
      return (await repo.complete(changeId, owner, token, issue)) ? 'done' : 'lost';
    } catch (err) {
      if (i >= COMPLETE_TRIES) {
        console.warn('ripple issue not recorded', { changeId, issueId: issue.id, tries: i, error: scrubErrorText(err instanceof Error ? err.message : String(err)) });
        return 'error';
      }
    }
  }
}

/**
 * Creates the missing issues of a confirmed change: one per owner of pages whose proposals need them. The row claim
 * makes a redelivered or concurrent job skip owners that already have (or are getting) an issue. Never throws.
 */
export async function createIssuesForChange(changeId: string, deps: IssueDeps = defaultIssueDeps): Promise<CreateIssuesOutcome> {
  try {
    const settings = await deps.repo.getJiraSettings();
    if (!settings) {
      console.info('ripple issues: no jira project', { changeId });
      return { status: 'not_configured' };
    }
    const change = await deps.changes.getChange(changeId);
    if (!change || change.status !== 'confirmed' || !change.routing) return { status: 'skipped', reason: 'change not confirmed' };
    const proposals = await deps.proposals.listForChange(changeId);
    const { groups, unowned } = groupByOwner(change.routing.pages, proposals);
    const out = { created: 0, failed: 0, skipped: 0, unowned };
    let source: { open: boolean; title: string | null } | undefined;
    for (const g of groups) {
      const token = await deps.repo.claim(changeId, g.ownerAccountId, change.sourcePageId, g.pageIds.length);
      if (!token) {
        out.skipped++;
        continue;
      }
      const label = issueTag(changeId, sha256(g.ownerAccountId));
      let issue: CreatedIssue;
      let reused = false;
      try {
        // An issue created by an earlier claim that died before recording it carries the same label: reuse it.
        const found = await deps.jira.findByLabel(settings.projectKey, label, g.ownerAccountId);
        if (found) {
          issue = found;
          reused = true;
        } else {
          if (source === undefined) {
            const open = await deps.isOpen(change.sourcePageId);
            source = { open, title: open ? ((await deps.facts.getSource(change.sourcePageId))?.title ?? null) : null };
          }
          const pages = new Set(g.pageIds);
          const listed = await issuePages(deps, g.pageIds);
          const description = issueAdf({
            ownerAccountId: g.ownerAccountId,
            facts: source.open
              ? await factLines(
                  deps,
                  change,
                  proposals.filter((p) => pages.has(p.pageId)),
                )
              : null,
            pages: listed,
            morePages: Math.max(0, g.pageIds.length - MAX_ISSUE_PAGES),
            teams: teamNames(
              change,
              listed.filter((p) => p.title !== null).map((p) => p.pageId),
            ),
            deadline: dueDate(change.routing.deadline) ?? null,
          });
          const due = dueDate(change.routing.deadline);
          issue = await deps.jira.createIssue({
            projectKey: settings.projectKey,
            summary: issueSummary(g.pageIds.length, source.title),
            description,
            labels: [...ISSUE_LABELS, label],
            assigneeAccountId: g.ownerAccountId,
            ...(due ? { duedate: due } : {}),
          });
        }
      } catch (err) {
        out.failed++;
        console.warn('ripple issue not created', { changeId, pages: g.pageIds.length, error: jiraErrorCode(err) });
        await deps.repo.fail(changeId, g.ownerAccountId, token).catch(() => undefined);
        continue;
      }
      // The issue exists now: never mark the claim failed (that would create a second one). If recording fails, the
      // claim goes stale and the next claim finds the issue by its label.
      const recorded = await completeWithRetry(deps.repo, changeId, g.ownerAccountId, token, issue);
      if (recorded === 'done') out.created++;
      else out.skipped++;
      console.info('ripple issue created', { changeId, issueId: issue.id, pages: g.pageIds.length, assigneeSet: issue.assigneeSet, dueSet: issue.dueSet, reused, recorded });
    }
    console.info('ripple issues done', { changeId, owners: groups.length, ...out });
    return { status: 'done', ...out };
  } catch (err) {
    console.warn('ripple issues failed', { changeId, error: scrubErrorText(err instanceof Error ? err.message : String(err)) });
    return { status: 'skipped', reason: 'error' };
  }
}

/**
 * Closes the change's open issues whose owner has nothing left to do: a comment (updated / superseded / reverted,
 * once: `comment_sent`), then a transition to Done. The status flip `created` → `closed` lets one caller through; a
 * Jira failure puts it back so a later call tries again. Never throws.
 */
export async function syncIssues(changeId: string, deps: IssueDeps = defaultIssueDeps): Promise<number> {
  let closed = 0;
  try {
    const rows = (await deps.repo.listForChange(changeId)).filter((r) => r.status === 'created' && r.issueKey);
    if (rows.length === 0) return 0;
    const change = await deps.changes.getChange(changeId);
    if (!change) return 0;
    const proposals = await deps.proposals.listForChange(changeId);
    for (const row of rows) {
      const pages = owned(change, row.ownerAccountId);
      const kind = closeKind(proposals.filter((p) => pages.has(p.pageId)));
      if (!kind || !row.issueKey) continue;
      if (!(await deps.repo.setStatus(changeId, row.ownerAccountId, 'created', 'closed'))) continue;
      try {
        // The comment goes out once: a transition that failed after it is retried without a second comment.
        if (!row.commentSent) {
          await deps.jira.addComment(row.issueKey, closingComment(kind));
          await deps.repo.markCommentSent(changeId, row.ownerAccountId).catch((err: unknown) => {
            console.warn('ripple issue comment not recorded', { changeId, issueId: row.issueId, error: scrubErrorText(err instanceof Error ? err.message : String(err)) });
          });
        }
        const done = await deps.jira.transitionToDone(row.issueKey);
        closed++;
        console.info('ripple issue closed', { changeId, issueId: row.issueId, kind, transitioned: done });
      } catch (err) {
        console.warn('ripple issue not closed', { changeId, issueId: row.issueId, kind, error: jiraErrorCode(err) });
        await deps.repo.setStatus(changeId, row.ownerAccountId, 'closed', 'created').catch(() => false);
      }
    }
  } catch (err) {
    console.warn('ripple issue sync failed', { changeId, error: scrubErrorText(err instanceof Error ? err.message : String(err)) });
  }
  return closed;
}

/** `syncIssues` for each change (deduplicated). Never throws. */
export async function syncIssuesOf(changeIds: readonly string[], deps: IssueDeps = defaultIssueDeps): Promise<void> {
  for (const id of new Set(changeIds)) await syncIssues(id, deps);
}

/** `syncIssues` for the source's other confirmed changes (after a newer change superseded their proposals). Never throws. */
export async function syncOtherChanges(sourcePageId: string, exceptChangeId: string, deps: IssueDeps = defaultIssueDeps): Promise<void> {
  try {
    const ids = (await deps.changes.confirmedChanges(sourcePageId)).map((c) => c.id).filter((id) => id !== exceptChangeId);
    await syncIssuesOf(ids, deps);
  } catch (err) {
    console.warn('ripple issue sync failed', { sourcePageId, error: scrubErrorText(err instanceof Error ? err.message : String(err)) });
  }
}

/** Heal: the change needs its propose job again to create missing (or failed) issues. False on any failure. */
export async function issuesNeeded(change: ChangeRow, deps: Pick<IssueDeps, 'repo' | 'proposals'> = defaultIssueDeps): Promise<boolean> {
  try {
    if (!change.routing || !(await deps.repo.getJiraSettings())) return false;
    const rows = await deps.repo.listForChange(change.id);
    return issuesMissing(change.routing.pages, await deps.proposals.listForChange(change.id), rows);
  } catch {
    return false;
  }
}

/** Jira project configured; false on failure (callers only show a note). */
export async function jiraConfigured(repo: Pick<ChangeIssueRepo, 'getJiraSettings'> = sqlChangeIssueRepo): Promise<boolean> {
  try {
    return (await repo.getJiraSettings()) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Issues of a change for the Rollout tab. Owner names only for owners the caller already resolved (owners of pages
 * the viewer can open); issue keys and links for every issue (Jira checks access itself).
 */
export async function rolloutIssues(
  change: ChangeRow,
  proposals: readonly ProposalRow[],
  names: ReadonlyMap<string, string>,
  repo: Pick<ChangeIssueRepo, 'listForChange' | 'getJiraSettings'> = sqlChangeIssueRepo,
): Promise<{ issues: RolloutIssue[]; issuesState: IssuesState }> {
  const [rows, settings] = await Promise.all([repo.listForChange(change.id), repo.getJiraSettings()]);
  const expected = groupByOwner(change.routing?.pages ?? [], proposals).groups.map((g) => g.ownerAccountId);
  const issues = rows
    .filter((r): r is ChangeIssueRow & { issueKey: string } => r.issueKey !== null && (r.status === 'created' || r.status === 'closed'))
    .map((r) => ({ ownerName: names.get(r.ownerAccountId) ?? null, issueKey: r.issueKey, issueUrl: r.issueUrl, status: r.status === 'closed' ? ('done' as const) : ('open' as const), pageCount: r.pageCount }));
  return { issues, issuesState: issuesState(settings !== undefined, rows, expected) };
}

// ---------------------------------------------------------------------------------------------------------------
// Settings (Confluence global settings) and the Jira issue panel
// ---------------------------------------------------------------------------------------------------------------

export interface SettingsContext {
  accountId?: string;
  moduleKey?: string;
}

export interface SettingsDeps {
  repo: Pick<ChangeIssueRepo, 'getJiraSettings' | 'saveJiraSettings'>;
  jira: Pick<JiraClient, 'isAdmin' | 'getProject'>;
  ensure: () => Promise<void>;
}

const defaultSettingsDeps: SettingsDeps = { repo: sqlChangeIssueRepo, jira, ensure: ensureSchema };

/**
 * Who may change the settings: Jira administrators (global ADMINISTER, checked as the app for the calling account),
 * on Ripple's settings page only. The Confluence admin check (`/wiki/rest/api/user/current?expand=operations`)
 * needs a scope Ripple does not have, and the global settings page is not limited to admins. Fails closed: a refused
 * (401/403) or failed check is `jira_unavailable` / `jira_error`, never "yes".
 */
async function adminCheck(ctx: SettingsContext, deps: SettingsDeps): Promise<'yes' | 'no' | 'jira_unavailable' | 'jira_error'> {
  if (ctx.moduleKey !== SETTINGS_MODULE || !ctx.accountId) return 'no';
  try {
    return (await deps.jira.isAdmin(ctx.accountId)) ? 'yes' : 'no';
  } catch (err) {
    const code = jiraErrorCode(err);
    console.info('ripple settings: Jira admin check failed', { error: code });
    return code === 'jira_unavailable' ? 'jira_unavailable' : 'jira_error';
  }
}

async function settingsGuard<T>(ctx: SettingsContext, deps: SettingsDeps, what: string, body: () => Promise<T | ErrorReply>): Promise<T | ErrorReply> {
  if (ctx.moduleKey !== SETTINGS_MODULE) return { error: 'Open Ripple settings to do that.' };
  try {
    await deps.ensure();
    return await body();
  } catch (err) {
    if (err instanceof SchemaSettingUpError) return { error: err.message };
    console.warn(`ripple ${what} failed`, { error: scrubErrorText(err instanceof Error ? err.message : String(err)) });
    return { error: `Ripple could not ${what}.` };
  }
}

export async function getSettings(ctx: SettingsContext, deps: SettingsDeps = defaultSettingsDeps): Promise<SettingsView | ErrorReply> {
  return settingsGuard(ctx, deps, 'load the settings', async () => ({
    jiraProjectKey: (await deps.repo.getJiraSettings())?.projectKey ?? null,
    canEdit: (await adminCheck(ctx, deps)) === 'yes',
  }));
}

/** Saves the Jira project key (an empty key turns issues off); the project must exist and be visible to the app. */
export async function saveSettings(ctx: SettingsContext, payload: Partial<SaveSettingsPayload> | undefined, deps: SettingsDeps = defaultSettingsDeps): Promise<SaveSettingsResult | ErrorReply> {
  return settingsGuard(ctx, deps, 'save the settings', async () => {
    const raw = payload?.jiraProjectKey;
    if (raw !== null && raw !== undefined && (typeof raw !== 'string' || raw.length > 20)) return { ok: false, errorCode: 'invalid_key' };
    // Fails closed: a Jira that refuses the check (403) or errors never lets the save through.
    const admin = await adminCheck(ctx, deps);
    if (admin !== 'yes') return { ok: false, errorCode: admin === 'no' ? 'not_allowed' : admin };
    const key = (raw ?? '').trim().toUpperCase();
    if (key === '') {
      await deps.repo.saveJiraSettings(null);
      console.info('ripple settings: jira project cleared');
      return { ok: true, errorCode: null };
    }
    if (!PROJECT_KEY.test(key)) return { ok: false, errorCode: 'invalid_key' };
    try {
      if (!(await deps.jira.getProject(key))) return { ok: false, errorCode: 'project_not_found' };
    } catch (err) {
      const code = jiraErrorCode(err);
      console.warn('ripple settings: project check failed', { error: code });
      return { ok: false, errorCode: code === 'jira_unavailable' ? 'jira_unavailable' : 'jira_error' };
    }
    await deps.repo.saveJiraSettings({ projectKey: key });
    console.info('ripple settings: jira project saved');
    return { ok: true, errorCode: null };
  });
}

export interface ApprovalContext {
  moduleKey?: string;
  extension?: { issue?: { key?: string } };
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]{1,9}-\d{1,10}$/;

/**
 * Jira issue panel (read-only): the pages of a Ripple update task with their progress. Titles only for pages that
 * may be named to anyone (as in the issue body); null for issues Ripple did not create.
 */
export async function getApproval(ctx: ApprovalContext, deps: IssueDeps & { ensure: () => Promise<void> } = { ...defaultIssueDeps, ensure: ensureSchema }): Promise<ApprovalView | ErrorReply> {
  if (ctx.moduleKey !== APPROVAL_MODULE) return { error: 'Open a Jira issue to see its Ripple update.' };
  const issueKey = ctx.extension?.issue?.key;
  if (typeof issueKey !== 'string' || !ISSUE_KEY.test(issueKey)) return { error: 'Missing or invalid issue key.' };
  try {
    await deps.ensure();
    const row = await deps.repo.byIssueKey(issueKey);
    if (!row) return { issueKey, task: null };
    const change = await deps.changes.getChange(row.changeId);
    if (!change) return { issueKey, task: null };
    const pages = owned(change, row.ownerAccountId);
    const proposals = (await deps.proposals.listForChange(row.changeId)).filter((p) => pages.has(p.pageId));
    const pageIds = [...new Set(proposals.map((p) => p.pageId))];
    const listed = await issuePages(deps, pageIds);
    return {
      issueKey,
      task: {
        changeId: row.changeId,
        deadline: change.routing?.deadline ?? null,
        closed: row.status === 'closed',
        pages: listed.map((p) => {
          const mine = proposals.filter((x) => x.pageId === p.pageId);
          return {
            pageId: p.pageId,
            title: p.title,
            url: p.url,
            open: mine.filter((x) => x.status !== 'applied' && x.status !== 'rejected').length,
            applied: mine.filter((x) => x.status === 'applied').length,
          };
        }),
        morePages: Math.max(0, pageIds.length - listed.length),
      },
    };
  } catch (err) {
    if (err instanceof SchemaSettingUpError) return { error: err.message };
    console.warn('ripple approval panel failed', { error: scrubErrorText(err instanceof Error ? err.message : String(err)) });
    return { error: 'Ripple could not load this update task.' };
  }
}
