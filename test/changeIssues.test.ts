import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Replies of the mocked Jira REST API, in call order; each records its request. */
const jiraCalls: { path: string; method: string; body: unknown }[] = [];
let jiraReplies: { status: number; body: unknown }[] = [];
/** Calls made as the user (`asUser().requestJira`); they share the reply queue. A set `userThrows` is thrown once. */
const userCalls: { path: string; method: string }[] = [];
let userThrows: unknown;

vi.mock('@forge/api', () => {
  const reply = () => {
    const r = jiraReplies.shift() ?? { status: 500, body: {} };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => JSON.stringify(r.body) };
  };
  return {
    default: {
      asApp: () => ({
        requestJira: async (path: string, init: { method: string; body?: string }) => {
          jiraCalls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
          return reply();
        },
      }),
      asUser: () => ({
        requestJira: async (path: string, init: { method: string }) => {
          userCalls.push({ path, method: init.method });
          if (userThrows) {
            const e = userThrows;
            userThrows = undefined;
            throw e;
          }
          return reply();
        },
      }),
    },
    route: (s: TemplateStringsArray, ...v: unknown[]) => s.reduce((acc, part, i) => acc + part + (i < v.length ? String(v[i]) : ''), ''),
  };
});
vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: {} }));
vi.mock('@forge/events', () => ({ Queue: class {} }));
vi.mock('@forge/llm', () => ({ chat: vi.fn(), ForgeLlmError: class extends Error {} }));

import type { ChangeIssueRepo, ChangeIssueRow, JiraSettings } from '../src/adapters/changeIssueRepo';
import { parseJiraSettings } from '../src/adapters/changeIssueRepo';
import type { ChangeRow } from '../src/adapters/changeRepo';
import { sha256 } from '../src/adapters/changeRepo';
import { pageIdUrl } from '../src/adapters/confluence';
import { jira, JiraError, JiraUnavailableError, jiraErrorClass, type CreatedIssue, type CreateIssueInput, type JiraClient } from '../src/adapters/jira';
import type { ProposalRow } from '../src/adapters/proposalRepo';
import {
  closeKind,
  GENERIC_FACT_TEXT,
  groupByOwner,
  ISSUE_TAG,
  issueAdf,
  issuesMissing,
  issuesState,
  issueSummary,
  issueTag,
  type AdfDoc,
  type AdfNode,
  type IssueStatus,
} from '../src/core/changeIssues';
import { httpsUrl } from '../ui/src/links';
import { HEAL_EVERY_MS, healSource } from '../src/surfaces/changes';
import { createIssuesForChange, getApproval, getSettings, issuesNeeded, saveSettings, syncIssues, syncOtherChanges, type IssueDeps } from '../src/surfaces/changeIssues';

const SOURCE = '9600001';
const CHANGE = '11111111-1111-1111-1111-111111111111';
const OLDER = '22222222-2222-2222-2222-222222222222';

type StoredRow = ChangeIssueRow & { claimedAt: number; token: string };

class Store {
  settings: JiraSettings | undefined = { projectKey: 'OPS' };
  rows = new Map<string, StoredRow>();
  now = 0;
  tokens = 0;
  /** `complete` throws (SQL failure) this many more times. */
  completeFails = 0;
  /** Issues in Jira by their per-(change, owner) label (what the JQL search finds). */
  byLabel = new Map<string, CreatedIssue>();
  searches: { projectKey: string; label: string }[] = [];
  searchFails = false;
  transitionFails = false;
  proposals: Pick<ProposalRow, 'id' | 'changeId' | 'pageId' | 'factId' | 'status' | 'errorCode'>[] = [
    { id: 'p1', changeId: CHANGE, pageId: 'A', factId: 'f1', status: 'proposed', errorCode: null },
    { id: 'p2', changeId: CHANGE, pageId: 'B', factId: 'f1', status: 'needs_manual', errorCode: 'crosses_markup' },
    { id: 'p3', changeId: CHANGE, pageId: 'C', factId: 'f1', status: 'failed', errorCode: 'llm_failed' },
    { id: 'p4', changeId: CHANGE, pageId: 'D', factId: 'f1', status: 'proposed', errorCode: null },
    { id: 'p5', changeId: CHANGE, pageId: 'E', factId: 'f1', status: 'applied', errorCode: null },
  ];
  change: ChangeRow = {
    id: CHANGE,
    sourcePageId: SOURCE,
    status: 'confirmed',
    pageVersion: 5,
    factChanges: [{ factId: 'f1', oldValue: '$60', oldUnit: null, newValue: '$75', newUnit: 'per day', newQuote: 'q', version: 5, versionAt: null }],
    missingFactIds: [],
    impact: null,
    routing: {
      deadline: '2026-11-16',
      pages: [
        { pageId: 'A', spaceId: 'S1', ownerAccountId: 'owner-1', ownerRole: 'owner', copies: 1 },
        { pageId: 'B', spaceId: 'S1', ownerAccountId: 'owner-1', ownerRole: 'owner', copies: 1 },
        { pageId: 'C', spaceId: 'S2', ownerAccountId: 'owner-2', ownerRole: 'author', copies: 1 },
        { pageId: 'D', spaceId: 'S2', ownerAccountId: null, ownerRole: null, copies: 1 },
        { pageId: 'E', spaceId: 'S2', ownerAccountId: 'owner-3', ownerRole: 'owner', copies: 1 },
      ],
      spaces: [
        { spaceId: 'S1', teamIds: ['t1'], teamSource: 'teamwork_graph', teams: [{ id: 't1', name: 'People Ops' }] },
        { spaceId: 'S2', teamIds: [], teamSource: 'none' },
      ],
      jiraProjectKey: 'OPS',
    },
    deadlineDays: 5,
    createdAt: '2026-11-09T09:00:00Z',
    proposedAt: '2026-11-09T09:01:00Z',
  } as unknown as ChangeRow;
  open = new Set([SOURCE, 'A']);
  created: CreateIssueInput[] = [];
  comments: { key: string; body: AdfDoc }[] = [];
  transitions: string[] = [];
  createFails = false;
  /** Global Jira ADMINISTER of the calling user (`isCurrentUserAdmin`). */
  viewerIsAdmin = false;
  closeFails = false;

  repo(): ChangeIssueRepo {
    const key = (c: string, o: string) => `${c}|${o}`;
    return {
      claim: async (changeId, owner, sourcePageId, pageCount) => {
        const row = this.rows.get(key(changeId, owner));
        const token = `tok-${++this.tokens}`;
        if (!row) {
          this.rows.set(key(changeId, owner), {
            changeId,
            ownerAccountId: owner,
            sourcePageId,
            issueId: null,
            issueKey: null,
            issueUrl: null,
            assigneeSet: false,
            pageCount,
            status: 'creating',
            attempts: 1,
            commentSent: false,
            claimedAt: this.now,
            token,
          });
          return token;
        }
        if ((row.status === 'failed' && row.attempts < 3) || (row.status === 'creating' && this.now - row.claimedAt > 300)) {
          Object.assign(row, { status: 'creating', claimedAt: this.now, pageCount, token, attempts: row.attempts + 1 });
          return token;
        }
        return null;
      },
      complete: async (changeId, owner, token, issue) => {
        if (this.completeFails > 0) {
          this.completeFails--;
          throw new Error('sql down');
        }
        const row = this.rows.get(key(changeId, owner));
        if (row?.status !== 'creating' || row.token !== token) return false;
        Object.assign(row, { status: 'created', issueId: issue.id, issueKey: issue.key, issueUrl: issue.url, assigneeSet: issue.assigneeSet });
        return true;
      },
      fail: async (changeId, owner, token) => {
        const row = this.rows.get(key(changeId, owner));
        if (row?.status === 'creating' && row.token === token) row.status = 'failed';
      },
      markCommentSent: async (changeId, owner) => {
        const row = this.rows.get(key(changeId, owner));
        if (row?.status === 'closed') row.commentSent = true;
      },
      listForChange: async (changeId) => [...this.rows.values()].filter((r) => r.changeId === changeId),
      byIssueKey: async (k) => [...this.rows.values()].find((r) => r.issueKey === k),
      setStatus: async (changeId, owner, from, to) => {
        const row = this.rows.get(key(changeId, owner));
        if (row?.status !== from) return false;
        row.status = to;
        return true;
      },
      getJiraSettings: async () => this.settings,
      saveJiraSettings: async (s) => {
        this.settings = s ?? undefined;
      },
    };
  }

  jira(): JiraClient {
    return {
      getProject: async (k) => (k === 'OPS' ? { id: '1', key: 'OPS' } : undefined),
      isCurrentUserAdmin: async () => this.viewerIsAdmin,
      createIssue: async (input) => {
        if (this.createFails) throw new JiraError(500, 'Jira 500: boom');
        this.created.push(input);
        const n = this.created.length;
        const issue = { id: `10${n}`, key: `OPS-${n}`, url: `https://x.atlassian.net/browse/OPS-${n}`, assigneeSet: true, dueSet: true };
        const tag = input.labels.find((l) => l.startsWith('ripple-c'));
        if (tag) this.byLabel.set(tag, issue);
        return issue;
      },
      findByLabel: async (projectKey, label) => {
        if (this.searchFails) throw new JiraError(500, 'Jira 500: search');
        this.searches.push({ projectKey, label });
        return this.byLabel.get(label);
      },
      transitionToDone: async (k) => {
        if (this.closeFails || this.transitionFails) throw new JiraUnavailableError('down');
        this.transitions.push(k);
        return true;
      },
      addComment: async (k, body) => {
        if (this.closeFails) throw new JiraUnavailableError('down');
        this.comments.push({ key: k, body });
      },
    };
  }

  deps(): IssueDeps {
    return {
      repo: this.repo(),
      jira: this.jira(),
      changes: { getChange: async (id) => (id === this.change.id ? this.change : undefined), confirmedChanges: async () => [this.change] },
      proposals: { listForChange: async (id) => this.proposals.filter((p) => p.changeId === id) as ProposalRow[] },
      facts: {
        getSource: async () => ({ pageId: SOURCE, title: 'Travel Policy', state: 'ready', pageVersion: 5, markedAt: '', extractedAt: null, error: null }),
        listFacts: async () => [{ id: 'f1', subject: 'Domestic per diem', attribute: 'amount' } as Awaited<ReturnType<IssueDeps['facts']['listFacts']>>[number]],
      },
      isOpen: async (id) => this.open.has(id),
      pageLink: async (id) => ({ title: `Title ${id}`, url: `https://x.atlassian.net/wiki/spaces/K/pages/${id}/Title+${id}`, idUrl: `https://x.atlassian.net/wiki/pages/viewpage.action?pageId=${id}` }),
    };
  }
}

let store: Store;

beforeEach(() => {
  store = new Store();
  jiraCalls.length = 0;
  userCalls.length = 0;
  userThrows = undefined;
  jiraReplies = [];
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

/** Every string in the document sits in a `text` node (or a mention id / link href attribute). */
function strings(node: unknown, path = ''): string[] {
  if (typeof node === 'string') return [path];
  if (Array.isArray(node)) return node.flatMap((n, i) => strings(n, `${path}[${i}]`));
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  return [];
}

describe('grouping and content (pure)', () => {
  it('groups pages with open proposals per owner; pages without an owner are only counted', () => {
    const r = groupByOwner(store.change.routing?.pages ?? [], store.proposals);
    expect(r).toEqual({
      groups: [
        { ownerAccountId: 'owner-1', pageIds: ['A', 'B'] },
        { ownerAccountId: 'owner-2', pageIds: ['C'] },
      ],
      unowned: 1,
    });
  });

  it('summary names the source only when it is open', () => {
    expect(issueSummary(2, 'Travel Policy')).toBe('Update 2 pages for Travel Policy');
    expect(issueSummary(1, null)).toBe('Update 1 page for a changed official fact');
    expect(issueSummary(3, '  ')).toBe('Update 3 pages for a changed official fact');
  });

  it('ADF: mention, fact bullets, linked pages, team line; text only inside text nodes', () => {
    const doc = issueAdf({
      ownerAccountId: 'owner-1',
      facts: [{ label: 'Per diem · amount', oldValue: '$60', newValue: '$75' }],
      pages: [
        { pageId: 'A', title: '<b>Onboarding</b>', url: 'https://x.atlassian.net/wiki/a' },
        { pageId: 'B', title: null, url: 'javascript:alert(1)' },
      ],
      morePages: 0,
      teams: ['People Ops'],
      deadline: '2026-11-16',
    });
    const allowed = /(\.text|\.type|\.attrs\.id|\.attrs\.href)$/;
    expect(strings(doc).filter((p) => !allowed.test(p))).toEqual([]);
    const texts: string[] = [];
    const walk = (n: AdfNode | AdfDoc): void => {
      if (n.type === 'text') texts.push(n.text);
      if ('content' in n) n.content.forEach(walk);
    };
    walk(doc);
    expect(texts).toContain('Per diem · amount: $60 → $75');
    expect(texts).toContain('<b>Onboarding</b>');
    expect(texts).toContain('Page B');
    expect(texts).toContain('Team: People Ops (via Teamwork Graph)');
    expect(JSON.stringify(doc)).toContain('"type":"mention","attrs":{"id":"owner-1"}');
    // Only https links.
    expect(JSON.stringify(doc)).not.toContain('javascript:');
  });

  it('closes only when every proposal is applied or rejected; why from the reasons', () => {
    const p = (status: string, errorCode: string | null = null) => ({ pageId: 'A', factId: 'f', status, errorCode });
    expect(closeKind([p('applied'), p('proposed')])).toBeNull();
    expect(closeKind([])).toBeNull();
    expect(closeKind([p('applied'), p('rejected')])).toBe('updated');
    expect(closeKind([p('rejected', 'superseded')])).toBe('superseded');
    expect(closeKind([p('rejected', 'reverted'), p('rejected', 'superseded')])).toBe('reverted');
  });

  it('issuesState and issuesMissing', () => {
    const row = (ownerAccountId: string, status: IssueStatus) => ({ ownerAccountId, status });
    expect(issuesState(false, [], ['o1'])).toBe('not_configured');
    expect(issuesState(true, [], ['o1'])).toBe('pending');
    expect(issuesState(true, [row('o1', 'created')], ['o1', 'o2'])).toBe('partial');
    expect(issuesState(true, [row('o1', 'created'), row('o2', 'failed')], ['o1', 'o2'])).toBe('partial');
    expect(issuesState(true, [row('o1', 'failed')], ['o1'])).toBe('failed');
    expect(issuesState(true, [row('o1', 'closed'), row('o2', 'created')], ['o2'])).toBe('created');
    const pages = store.change.routing?.pages ?? [];
    expect(issuesMissing(pages, store.proposals, [])).toBe(true);
    expect(issuesMissing(pages, store.proposals, [row('owner-1', 'created'), row('owner-2', 'failed')])).toBe(true);
    expect(issuesMissing(pages, store.proposals, [row('owner-1', 'created'), row('owner-2', 'creating')])).toBe(false);
    // Heal stops after 3 failed attempts.
    expect(issuesMissing(pages, store.proposals, [row('owner-1', 'created'), { ...row('owner-2', 'failed'), attempts: 2 }])).toBe(true);
    expect(issuesMissing(pages, store.proposals, [row('owner-1', 'created'), { ...row('owner-2', 'failed'), attempts: 3 }])).toBe(false);
  });

  it('parses stored settings strictly', () => {
    expect(parseJiraSettings('{"projectKey":"OPS"}')).toEqual({ projectKey: 'OPS' });
    expect(parseJiraSettings({ projectKey: 'ops' })).toBeUndefined();
    expect(parseJiraSettings('nope')).toBeUndefined();
  });
});

describe('createIssuesForChange', () => {
  it('one issue per owner, assigned with due date and labels; redelivery creates no duplicate', async () => {
    const r = await createIssuesForChange(CHANGE, store.deps());
    expect(r).toEqual({ status: 'done', created: 2, failed: 0, skipped: 0, unowned: 1 });
    expect(store.created.map((c) => [c.assigneeAccountId, c.summary, c.duedate, c.labels])).toEqual([
      ['owner-1', 'Update 2 pages for Travel Policy', '2026-11-16', ['ripple', 'ripple-update', issueTag(CHANGE, sha256('owner-1'))]],
      ['owner-2', 'Update 1 page for Travel Policy', '2026-11-16', ['ripple', 'ripple-update', issueTag(CHANGE, sha256('owner-2'))]],
    ]);
    // Searched by its label (in the configured project) before each create.
    expect(store.searches).toEqual([
      { projectKey: 'OPS', label: issueTag(CHANGE, sha256('owner-1')) },
      { projectKey: 'OPS', label: issueTag(CHANGE, sha256('owner-2')) },
    ]);
    // Page titles only for open pages; team line only where the routing has team names.
    const first = JSON.stringify(store.created[0]?.description);
    expect(first).toContain('Title A');
    expect(first).toContain('Page B');
    expect(first).toContain('Team: People Ops');
    expect(JSON.stringify(store.created[1]?.description)).not.toContain('Team:');
    expect([...store.rows.values()].map((x) => [x.ownerAccountId, x.status, x.issueKey, x.pageCount])).toEqual([
      ['owner-1', 'created', 'OPS-1', 2],
      ['owner-2', 'created', 'OPS-2', 1],
    ]);
    expect(await createIssuesForChange(CHANGE, store.deps())).toMatchObject({ created: 0, skipped: 2 });
    expect(store.created).toHaveLength(2);
    // Logs carry ids, counts and codes only.
    const logs = JSON.stringify([(console.info as ReturnType<typeof vi.fn>).mock.calls, (console.warn as ReturnType<typeof vi.fn>).mock.calls]);
    for (const secret of ['owner-1', 'Travel Policy', '$75', 'People Ops']) expect(logs).not.toContain(secret);
  });

  it('hides the source title when the source is restricted', async () => {
    store.open = new Set(['A']);
    await createIssuesForChange(CHANGE, store.deps());
    expect(store.created[0]?.summary).toBe('Update 2 pages for a changed official fact');
  });

  it('a concurrent claim is skipped; a stale or failed claim is taken over', async () => {
    await store.repo().claim(CHANGE, 'owner-1', SOURCE, 2);
    expect(await createIssuesForChange(CHANGE, store.deps())).toMatchObject({ created: 1, skipped: 1 });
    store.now = 301;
    expect(await createIssuesForChange(CHANGE, store.deps())).toMatchObject({ created: 1, skipped: 1 });
    expect(store.created.map((c) => c.assigneeAccountId)).toEqual(['owner-2', 'owner-1']);
  });

  it('a Jira failure marks the claim failed (claimable again) and never throws', async () => {
    store.createFails = true;
    expect(await createIssuesForChange(CHANGE, store.deps())).toMatchObject({ created: 0, failed: 2 });
    expect([...store.rows.values()].map((x) => x.status)).toEqual(['failed', 'failed']);
    store.createFails = false;
    expect(await createIssuesForChange(CHANGE, store.deps())).toMatchObject({ created: 2 });
  });

  it('the per-owner label is deterministic, unique per change and owner, and carries no raw account id', () => {
    const a = issueTag(CHANGE, sha256('owner-1'));
    expect(a).toMatch(ISSUE_TAG);
    expect(a).toBe(`ripple-c11111111-${sha256('owner-1').slice(0, 8)}`);
    expect(a).not.toContain('owner');
    expect(issueTag(CHANGE, sha256('owner-2'))).not.toBe(a);
    expect(issueTag(OLDER, sha256('owner-1'))).not.toBe(a);
    expect(() => issueTag('zz', 'zz')).toThrow();
  });

  it('a recording (SQL) failure after Jira created the issue never marks it failed; the next claim reuses it by label', async () => {
    store.completeFails = 3;
    expect(await createIssuesForChange(CHANGE, store.deps())).toMatchObject({ created: 1, failed: 0, skipped: 1 });
    const row = () => [...store.rows.values()].find((r) => r.ownerAccountId === 'owner-1');
    expect(row()?.status).toBe('creating');
    expect(store.created).toHaveLength(2);
    // Heal / redelivery after the claim went stale: the issue is found by its label, not created again.
    store.now = 301;
    expect(await createIssuesForChange(CHANGE, store.deps())).toMatchObject({ created: 1, skipped: 1 });
    expect(store.created).toHaveLength(2);
    expect(row()).toMatchObject({ status: 'created', issueKey: 'OPS-1', attempts: 2 });
  });

  it('a transient recording failure is retried', async () => {
    store.completeFails = 2;
    expect(await createIssuesForChange(CHANGE, store.deps())).toMatchObject({ created: 2, failed: 0 });
    expect([...store.rows.values()].map((r) => r.status)).toEqual(['created', 'created']);
  });

  it('a failed claim is reclaimed after a search; an issue already in Jira is reused', async () => {
    store.createFails = true;
    await createIssuesForChange(CHANGE, store.deps());
    // The issue exists in Jira (created by a job whose reply was lost) although the row says failed.
    store.byLabel.set(issueTag(CHANGE, sha256('owner-1')), { id: '900', key: 'OPS-900', url: 'https://x.atlassian.net/browse/OPS-900', assigneeSet: true, dueSet: true });
    store.createFails = false;
    expect(await createIssuesForChange(CHANGE, store.deps())).toMatchObject({ created: 2 });
    expect(store.created.map((c) => c.assigneeAccountId)).toEqual(['owner-2']);
    expect([...store.rows.values()].map((r) => [r.ownerAccountId, r.issueKey])).toEqual([
      ['owner-1', 'OPS-900'],
      ['owner-2', 'OPS-1'],
    ]);
  });

  it('a failing search creates nothing (no blind create) and releases the claim', async () => {
    store.searchFails = true;
    expect(await createIssuesForChange(CHANGE, store.deps())).toMatchObject({ created: 0, failed: 2 });
    expect(store.created).toHaveLength(0);
    expect([...store.rows.values()].map((r) => r.status)).toEqual(['failed', 'failed']);
  });

  it('a claim taken over meanwhile is not completed or failed by the old job (token)', async () => {
    const r = store.repo();
    const old = await r.claim(CHANGE, 'owner-1', SOURCE, 2);
    store.now = 301;
    const fresh = await r.claim(CHANGE, 'owner-1', SOURCE, 2);
    expect(old).not.toBe(fresh);
    const issue = { id: '1', key: 'OPS-1', url: 'https://x/browse/OPS-1', assigneeSet: true };
    expect(await r.complete(CHANGE, 'owner-1', old ?? '', issue)).toBe(false);
    await r.fail(CHANGE, 'owner-1', old ?? '');
    expect(store.rows.get(`${CHANGE}|owner-1`)?.status).toBe('creating');
    expect(await r.complete(CHANGE, 'owner-1', fresh ?? '', issue)).toBe(true);
  });

  it('after 3 failed attempts heal stops and the Rollout state is failed', async () => {
    store.createFails = true;
    for (let i = 0; i < 3; i++) await createIssuesForChange(CHANGE, store.deps());
    expect([...store.rows.values()].map((r) => [r.status, r.attempts])).toEqual([
      ['failed', 3],
      ['failed', 3],
    ]);
    expect(await issuesNeeded(store.change, store.deps())).toBe(false);
    expect(await createIssuesForChange(CHANGE, store.deps())).toMatchObject({ created: 0, failed: 0, skipped: 2 });
    expect(issuesState(true, [...store.rows.values()], ['owner-1', 'owner-2'])).toBe('failed');
  });

  it('privacy: a restricted source gives a generic body (no fact label, no values); hidden pages link by id only', async () => {
    store.open = new Set(['A']);
    await createIssuesForChange(CHANGE, store.deps());
    const body = JSON.stringify(store.created[0]?.description);
    expect(body).toContain(GENERIC_FACT_TEXT);
    for (const secret of ['Domestic per diem', '$60', '$75', 'What changed']) expect(body).not.toContain(secret);
    // Open page A: title and slugged link; hidden page B: "Page B" with the id-only link (no title slug).
    expect(body).toContain('Title+A');
    expect(body).not.toContain('Title+B');
    expect(body).not.toContain('Title B');
    expect(body).toContain('viewpage.action?pageId=B');
  });

  it('privacy: team names only for spaces of open pages', async () => {
    store.open = new Set([SOURCE]);
    await createIssuesForChange(CHANGE, store.deps());
    expect(JSON.stringify(store.created[0]?.description)).not.toContain('People Ops');
    expect(JSON.stringify(store.created[0]?.description)).not.toContain('Team:');
  });

  it('pageIdUrl: site origin + viewpage.action, https and numeric ids only', () => {
    expect(pageIdUrl('https://x.atlassian.net/wiki', '123')).toBe('https://x.atlassian.net/wiki/pages/viewpage.action?pageId=123');
    expect(pageIdUrl('http://x.atlassian.net/wiki', '123')).toBeNull();
    expect(pageIdUrl('https://x.atlassian.net/wiki', '12&x=1')).toBeNull();
    expect(pageIdUrl(undefined, '123')).toBeNull();
  });

  it('without a Jira project nothing is created and the log says so', async () => {
    store.settings = undefined;
    expect(await createIssuesForChange(CHANGE, store.deps())).toEqual({ status: 'not_configured' });
    expect(store.rows.size).toBe(0);
    expect(console.info).toHaveBeenCalledWith('ripple issues: no jira project', { changeId: CHANGE });
  });
});

describe('closing issues', () => {
  beforeEach(async () => {
    await createIssuesForChange(CHANGE, store.deps());
  });
  const set = (id: string, status: string, errorCode: string | null = null) => Object.assign(store.proposals.find((p) => p.id === id) ?? {}, { status, errorCode });

  it('closes an owner issue once all their proposals are applied or rejected (comment + Done), once', async () => {
    set('p1', 'applied');
    expect(await syncIssues(CHANGE, store.deps())).toBe(0);
    set('p2', 'rejected');
    expect(await syncIssues(CHANGE, store.deps())).toBe(1);
    expect(store.transitions).toEqual(['OPS-1']);
    expect(JSON.stringify(store.comments[0]?.body)).toContain('updated or declined');
    expect(await syncIssues(CHANGE, store.deps())).toBe(0);
    expect(store.transitions).toEqual(['OPS-1']);
  });

  it('superseded and reverted proposals close with their own comment (via the source sync)', async () => {
    set('p1', 'rejected', 'superseded');
    set('p2', 'rejected', 'superseded');
    set('p3', 'rejected', 'reverted');
    await syncOtherChanges(SOURCE, OLDER, store.deps());
    expect(store.transitions).toEqual(['OPS-1', 'OPS-2']);
    expect(JSON.stringify(store.comments[0]?.body)).toContain('newer change');
    expect(JSON.stringify(store.comments[1]?.body)).toContain('was undone');
  });

  it('a Jira failure while closing leaves the issue open for the next sync', async () => {
    set('p3', 'rejected');
    store.closeFails = true;
    expect(await syncIssues(CHANGE, store.deps())).toBe(0);
    expect([...store.rows.values()].find((r) => r.ownerAccountId === 'owner-2')?.status).toBe('created');
    store.closeFails = false;
    expect(await syncIssues(CHANGE, store.deps())).toBe(1);
  });

  it('a transition that fails after the comment is retried without a second comment', async () => {
    set('p3', 'rejected');
    store.transitionFails = true;
    expect(await syncIssues(CHANGE, store.deps())).toBe(0);
    const row = () => [...store.rows.values()].find((r) => r.ownerAccountId === 'owner-2');
    expect(row()).toMatchObject({ status: 'created', commentSent: true });
    expect(store.comments).toHaveLength(1);
    store.transitionFails = false;
    expect(await syncIssues(CHANGE, store.deps())).toBe(1);
    expect(store.comments).toHaveLength(1);
    expect(store.transitions).toEqual(['OPS-2']);
  });
});

describe('which changes get issues (live regression, dev 8.29.0)', () => {
  const NOW = Date.parse('2026-11-09T11:00:00Z');
  const routing = (jiraProjectKey?: string) => ({
    deadline: '2026-11-16',
    pages: [
      { pageId: 'A', spaceId: 'S1', ownerAccountId: 'owner-1', ownerRole: 'owner', copies: 1 },
      { pageId: 'B', spaceId: 'S1', ownerAccountId: 'owner-1', ownerRole: 'owner', copies: 1 },
      { pageId: 'E', spaceId: 'S2', ownerAccountId: 'owner-3', ownerRole: 'owner', copies: 1 },
    ],
    spaces: [],
    ...(jiraProjectKey ? { jiraProjectKey } : {}),
  });

  it('old change without project → project set → heal → confirm → heal 2x: exactly one issue, for the newest change', async () => {
    // A change confirmed (and proposed) before any Jira project was set; page E still has an open (failed) proposal.
    const old = { ...store.change, id: OLDER, routing: routing(), createdAt: '2026-11-09T10:00:00Z', proposedAt: '2026-11-09T10:01:00Z', impact: { copies: [{ copyId: 'c1' }] } } as unknown as ChangeRow;
    store.settings = undefined;
    store.proposals = [
      { id: 'o1', changeId: OLDER, pageId: 'A', factId: 'f1', status: 'proposed', errorCode: null },
      { id: 'o2', changeId: OLDER, pageId: 'E', factId: 'f1', status: 'failed', errorCode: 'quote_not_found' },
    ];
    const all = new Map<string, ChangeRow>([[OLDER, old]]);
    const order: string[] = [OLDER]; // newest decision first
    const base = store.deps();
    const deps: IssueDeps = {
      ...base,
      changes: {
        getChange: async (id) => all.get(id),
        confirmedChanges: async () => order.map((id) => all.get(id)).filter((c): c is ChangeRow => c?.status === 'confirmed'),
      },
    };
    const jobs: string[] = [];
    let now = NOW;
    const heal = () => {
      now += HEAL_EVERY_MS + 1;
      return healSource(SOURCE, null, {
        facts: { getSource: async () => ({ pageId: SOURCE, title: 'Travel Policy', state: 'ready', pageVersion: 13, markedAt: '', extractedAt: null, error: null }) },
        changes: deps.changes,
        proposalCount: async (id) => store.proposals.filter((p) => p.changeId === id).length,
        enqueueDiff: async () => 'diff',
        // The propose job: proposals exist already here; it marks the run done, then creates the issues.
        enqueuePropose: async (_page, id) => {
          jobs.push(id);
          const c = all.get(id);
          if (c) c.proposedAt = new Date(now).toISOString();
          await createIssuesForChange(id, deps);
          return 'job';
        },
        issuesNeeded: (c) => issuesNeeded(c, deps),
        now: () => now,
      });
    };

    await heal();
    store.settings = { projectKey: 'OPS' };
    await heal();
    // Even a propose job of the old change (e.g. queued by the old heal) creates no issue: not wanted.
    expect(await createIssuesForChange(OLDER, deps)).toEqual({ status: 'skipped', reason: 'issues_not_wanted' });
    expect(store.created).toHaveLength(0);

    // Confirm v13 with the project set: the routing records it; the older proposals are superseded.
    const fresh = { ...store.change, routing: routing('OPS'), createdAt: new Date(now).toISOString(), proposedAt: null, impact: { copies: [{ copyId: 'c2' }] } } as unknown as ChangeRow;
    all.set(CHANGE, fresh);
    order.unshift(CHANGE);
    Object.assign(store.proposals[0] ?? {}, { status: 'rejected', errorCode: 'superseded' });
    store.proposals.push(
      { id: 'n1', changeId: CHANGE, pageId: 'A', factId: 'f1', status: 'proposed', errorCode: null },
      { id: 'n2', changeId: CHANGE, pageId: 'B', factId: 'f1', status: 'proposed', errorCode: null },
      { id: 'n3', changeId: CHANGE, pageId: 'E', factId: 'f1', status: 'applied', errorCode: null },
    );
    // The propose job is still running (proposals saved, run not finished): the heal creates nothing.
    expect(await heal()).toEqual({ diffJob: null, proposeJobs: 0 });
    expect(await createIssuesForChange(CHANGE, deps)).toEqual({ status: 'skipped', reason: 'proposals_pending' });
    // The job finishes.
    fresh.proposedAt = new Date(now).toISOString();
    expect(await createIssuesForChange(CHANGE, deps)).toMatchObject({ status: 'done', created: 1 });
    expect(await heal()).toEqual({ diffJob: null, proposeJobs: 0 });
    expect(await heal()).toEqual({ diffJob: null, proposeJobs: 0 });

    expect(jobs).toEqual([]);
    expect(store.created).toHaveLength(1);
    expect(store.created[0]?.assigneeAccountId).toBe('owner-1');
    expect([...store.rows.values()].map((r) => [r.changeId, r.ownerAccountId, r.pageCount])).toEqual([[CHANGE, 'owner-1', 2]]);
    // The older change's open page E never gets an issue: not the newest change.
    old.routing = routing('OPS') as unknown as ChangeRow['routing'];
    expect(await createIssuesForChange(OLDER, deps)).toEqual({ status: 'skipped', reason: 'not_latest_change' });
    expect(await issuesNeeded(old, deps)).toBe(false);
  });

  it('changes of different facts of one source each get their issues; only a newer change of the SAME fact supersedes', async () => {
    const fc = (factId: string) => [{ factId, oldValue: '$60', oldUnit: null, newValue: '$75', newUnit: null, newQuote: 'q', version: 5, versionAt: null }];
    const a = { ...store.change, id: OLDER, factChanges: fc('f1') } as ChangeRow;
    const b = { ...store.change, id: CHANGE, factChanges: fc('f2') } as ChangeRow;
    const all = new Map<string, ChangeRow>([
      [CHANGE, b],
      [OLDER, a],
    ]);
    const base = store.deps();
    const deps: IssueDeps = { ...base, changes: { getChange: async (id) => all.get(id), confirmedChanges: async () => [b, a] } };
    store.proposals = [
      { id: 'pa', changeId: OLDER, pageId: 'A', factId: 'f1', status: 'proposed', errorCode: null },
      { id: 'pb', changeId: CHANGE, pageId: 'B', factId: 'f2', status: 'proposed', errorCode: null },
    ] as typeof store.proposals;
    expect(await createIssuesForChange(OLDER, deps)).toMatchObject({ status: 'done', created: 1 });
    expect(await createIssuesForChange(CHANGE, deps)).toMatchObject({ status: 'done', created: 1 });
    expect(store.created).toHaveLength(2);
    // A newer change that also touches f1 makes A stale.
    b.factChanges = [...fc('f2'), ...fc('f1')];
    expect(await createIssuesForChange(OLDER, deps)).toEqual({ status: 'skipped', reason: 'not_latest_change' });
  });

  it('a change confirmed with the project gets its issues from the first full propose job (heal queues it when lost)', async () => {
    store.change = { ...store.change, proposedAt: null } as ChangeRow;
    expect(await issuesNeeded(store.change, store.deps())).toBe(false);
    expect(await createIssuesForChange(CHANGE, store.deps())).toEqual({ status: 'skipped', reason: 'proposals_pending' });
    store.change.proposedAt = '2026-11-09T09:05:00Z';
    expect(await issuesNeeded(store.change, store.deps())).toBe(true);
    expect(await createIssuesForChange(CHANGE, store.deps())).toMatchObject({ status: 'done', created: 2 });
  });
});

describe('heal check', () => {
  it('needs the job when an owner has no issue or a failed one, only with a project', async () => {
    expect(await issuesNeeded(store.change, store.deps())).toBe(true);
    await createIssuesForChange(CHANGE, store.deps());
    expect(await issuesNeeded(store.change, store.deps())).toBe(false);
    store.settings = undefined;
    store.rows.clear();
    expect(await issuesNeeded(store.change, store.deps())).toBe(false);
  });
});

describe('settings and approval panel', () => {
  const sdeps = () => ({ repo: store.repo(), jira: store.jira(), ensure: async () => undefined });
  const ctx = (accountId: string, moduleKey = 'ripple-settings') => ({ accountId, moduleKey });

  it('anyone on the settings page reads; only Jira admins save an existing project', async () => {
    expect(await getSettings(ctx('user'), sdeps())).toEqual({ jiraProjectKey: 'OPS', canEdit: false, adminCheck: 'not_admin' });
    expect(await saveSettings(ctx('user'), { jiraProjectKey: 'OPS' }, sdeps())).toEqual({ ok: false, errorCode: 'not_allowed' });
    store.viewerIsAdmin = true;
    expect(await getSettings(ctx('admin'), sdeps())).toEqual({ jiraProjectKey: 'OPS', canEdit: true, adminCheck: 'admin' });
    expect(await getSettings(ctx('admin', 'ripple-byline'), sdeps())).toEqual({ error: expect.any(String) });
    expect(await saveSettings(ctx('admin'), { jiraProjectKey: 'bad key' }, sdeps())).toEqual({ ok: false, errorCode: 'invalid_key' });
    expect(await saveSettings(ctx('admin'), { jiraProjectKey: 'NOPE' }, sdeps())).toEqual({ ok: false, errorCode: 'project_not_found' });
    expect(await saveSettings(ctx('admin'), { jiraProjectKey: ' ops ' }, sdeps())).toEqual({ ok: true, errorCode: null });
    expect(store.settings).toEqual({ projectKey: 'OPS' });
    expect(await saveSettings(ctx('admin'), { jiraProjectKey: '' }, sdeps())).toEqual({ ok: true, errorCode: null });
    expect(store.settings).toBeUndefined();
  });

  it('a Jira that is not reachable fails closed, told apart from "not an admin"', async () => {
    const d = { ...sdeps(), jira: { ...store.jira(), isCurrentUserAdmin: async () => Promise.reject(new JiraUnavailableError('no jira')) } };
    expect(await getSettings(ctx('admin'), d)).toEqual({ jiraProjectKey: 'OPS', canEdit: false, adminCheck: 'check_failed' });
    expect(await saveSettings(ctx('admin'), { jiraProjectKey: 'OPS' }, d)).toEqual({ ok: false, errorCode: 'admin_check_failed' });
  });

  it("the real admin check reads the caller's own ADMINISTER as the user; 401/403/500/no consent fail closed as check_failed", async () => {
    const d = { ...sdeps(), jira };
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const admin = (have: boolean) => ({ status: 200, body: { permissions: { ADMINISTER: { key: 'ADMINISTER', havePermission: have } } } });

    jiraReplies = [admin(true)];
    expect(await getSettings(ctx('acc-admin'), d)).toEqual({ jiraProjectKey: 'OPS', canEdit: true, adminCheck: 'admin' });
    expect(userCalls).toEqual([{ path: '/rest/api/3/mypermissions?permissions=ADMINISTER', method: 'GET' }]);
    expect(jiraCalls).toEqual([]);
    jiraReplies = [admin(false)];
    expect(await getSettings(ctx('acc-user'), d)).toEqual({ jiraProjectKey: 'OPS', canEdit: false, adminCheck: 'not_admin' });
    jiraReplies = [admin(false)];
    expect(await saveSettings(ctx('acc-user'), { jiraProjectKey: 'OPS' }, d)).toEqual({ ok: false, errorCode: 'not_allowed' });

    for (const status of [401, 403, 500]) {
      info.mockClear();
      jiraReplies = [{ status, body: { errorMessages: ['secret detail'] } }];
      expect(await getSettings(ctx('acc-admin'), d)).toEqual({ jiraProjectKey: 'OPS', canEdit: false, adminCheck: 'check_failed' });
      jiraReplies = [{ status, body: {} }];
      expect(await saveSettings(ctx('acc-admin'), { jiraProjectKey: 'OPS' }, d)).toEqual({ ok: false, errorCode: 'admin_check_failed' });
      expect(info).toHaveBeenCalledWith('ripple settings: Jira admin check failed', expect.objectContaining({ errorClass: `http_${status}` }));
      expect(JSON.stringify(info.mock.calls)).not.toContain('secret detail');
    }

    // The user has not granted consent (Forge NEEDS_AUTHENTICATION_ERR): its own class, still fail-closed.
    info.mockClear();
    userThrows = Object.assign(new Error('needs auth'), { name: 'NEEDS_AUTHENTICATION_ERR', status: 401 });
    expect(await getSettings(ctx('acc-admin'), d)).toMatchObject({ canEdit: false, adminCheck: 'needs_auth' });
    userThrows = Object.assign(new Error('needs auth'), { name: 'NEEDS_AUTHENTICATION_ERR', status: 401 });
    expect(await saveSettings(ctx('acc-admin'), { jiraProjectKey: 'XYZ' }, d)).toEqual({ ok: false, errorCode: 'admin_needs_auth' });
    expect(info).toHaveBeenCalledWith('ripple settings: Jira admin check failed', expect.objectContaining({ errorClass: 'needs_auth' }));
    expect(store.settings).toEqual({ projectKey: 'OPS' });
    info.mockRestore();
  });

  it('the issue panel lists the pages of a Ripple issue, null for other issues', async () => {
    await createIssuesForChange(CHANGE, store.deps());
    const d = { ...store.deps(), ensure: async () => undefined };
    const r = await getApproval({ moduleKey: 'ripple-approval', extension: { issue: { key: 'OPS-1' } } }, d);
    expect(r).toMatchObject({
      issueKey: 'OPS-1',
      task: {
        changeId: CHANGE,
        closed: false,
        pages: [
          { pageId: 'A', title: 'Title A', url: 'https://x.atlassian.net/wiki/spaces/K/pages/A/Title+A', open: 1 },
          // Not open: no title and the id-only link (no title slug).
          { pageId: 'B', title: null, url: 'https://x.atlassian.net/wiki/pages/viewpage.action?pageId=B', open: 1 },
        ],
      },
    });
    expect(await getApproval({ moduleKey: 'ripple-approval', extension: { issue: { key: 'OPS-99' } } }, d)).toEqual({ issueKey: 'OPS-99', task: null });
    expect(await getApproval({ moduleKey: 'ripple-approval', extension: { issue: { key: 'x"' } } }, d)).toEqual({ error: expect.any(String) });
  });
});

describe('Jira adapter', () => {
  const input: CreateIssueInput = {
    projectKey: 'OPS',
    summary: 's',
    description: { type: 'doc', version: 1, content: [] },
    labels: ['ripple'],
    assigneeAccountId: 'owner-1',
    duedate: '2026-11-16',
  };
  const types = { status: 200, body: { issueTypes: [{ id: '3', name: 'Task' }] } };
  const created = { status: 201, body: { id: '100', key: 'OPS-1', self: 'https://x.atlassian.net/rest/api/3/issue/100' } };

  it('retries without the assignee, then without the due date, when Jira rejects them', async () => {
    jiraReplies = [
      types,
      { status: 400, body: { errors: { assignee: 'User cannot be assigned issues.' } } },
      { status: 400, body: { errors: { duedate: "Field 'duedate' cannot be set. It is not on the appropriate screen, or unknown." } } },
      created,
    ];
    const r = await jira.createIssue(input);
    expect(r).toEqual({ id: '100', key: 'OPS-1', url: 'https://x.atlassian.net/browse/OPS-1', assigneeSet: false, dueSet: false });
    const posts = jiraCalls.filter((c) => c.method === 'POST').map((c) => Object.keys((c.body as { fields: object }).fields).sort());
    expect(posts[0]).toEqual(expect.arrayContaining(['assignee', 'duedate']));
    expect(posts[1]).not.toContain('assignee');
    expect(posts[2]).not.toContain('duedate');
  });

  it('other 400s are not retried; a missing project is undefined', async () => {
    jiraReplies = [types, { status: 400, body: { errors: { summary: 'too long' } } }];
    await expect(jira.createIssue(input)).rejects.toBeInstanceOf(JiraError);
    jiraReplies = [{ status: 404, body: { errorMessages: ['No project'] } }];
    expect(await jira.getProject('NOPE')).toBeUndefined();
    jiraReplies = [{ status: 403, body: {} }];
    await expect(jira.getProject('OPS')).rejects.toBeInstanceOf(JiraUnavailableError);
  });

  it('isCurrentUserAdmin reads mypermissions?permissions=ADMINISTER as the user; 401/403 and 500 are distinguishable errors', async () => {
    jiraReplies = [{ status: 200, body: { permissions: { ADMINISTER: { havePermission: true } } } }];
    expect(await jira.isCurrentUserAdmin()).toBe(true);
    expect(userCalls).toEqual([{ path: '/rest/api/3/mypermissions?permissions=ADMINISTER', method: 'GET' }]);
    expect(jiraCalls).toEqual([]);
    jiraReplies = [{ status: 200, body: { permissions: { ADMINISTER: { havePermission: false } } } }];
    expect(await jira.isCurrentUserAdmin()).toBe(false);
    // A truthy non-boolean or a missing entry is not "yes".
    jiraReplies = [{ status: 200, body: { permissions: { ADMINISTER: { havePermission: 'true' } } } }];
    expect(await jira.isCurrentUserAdmin()).toBe(false);
    jiraReplies = [{ status: 200, body: {} }];
    expect(await jira.isCurrentUserAdmin()).toBe(false);
    for (const status of [401, 403]) {
      jiraReplies = [{ status, body: {} }];
      const err = await jira.isCurrentUserAdmin().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JiraUnavailableError);
      expect(jiraErrorClass(err)).toBe(`http_${status}`);
    }
    jiraReplies = [{ status: 500, body: {} }];
    const err = await jira.isCurrentUserAdmin().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect(jiraErrorClass(err)).toBe('http_500');
    userThrows = Object.assign(new Error('needs auth'), { name: 'NEEDS_AUTHENTICATION_ERR' });
    expect(jiraErrorClass(await jira.isCurrentUserAdmin().catch((e: unknown) => e))).toBe('needs_auth');
  });

  it('findByLabel: JQL search as the app with validated, quoted values', async () => {
    const label = issueTag(CHANGE, sha256('owner-1'));
    jiraReplies = [{ status: 200, body: { issues: [{ id: 100, key: 'OPS-7', self: 'https://x.atlassian.net/rest/api/3/issue/100', fields: { assignee: { accountId: 'owner-1' }, duedate: null } }] } }];
    expect(await jira.findByLabel('OPS', label, 'owner-1')).toEqual({ id: '100', key: 'OPS-7', url: 'https://x.atlassian.net/browse/OPS-7', assigneeSet: true, dueSet: false });
    expect(jiraCalls[0]).toEqual({
      path: '/rest/api/3/search/jql',
      method: 'POST',
      body: { jql: `project = "OPS" AND labels = "${label}" ORDER BY created ASC`, fields: ['assignee', 'duedate'], maxResults: 1 },
    });
    jiraReplies = [{ status: 200, body: { issues: [] } }];
    expect(await jira.findByLabel('OPS', label, 'owner-1')).toBeUndefined();
    jiraCalls.length = 0;
    await expect(jira.findByLabel('OPS', 'ripple" OR project = "X', 'owner-1')).rejects.toBeInstanceOf(JiraError);
    await expect(jira.findByLabel('OPS" OR x="', label, 'owner-1')).rejects.toBeInstanceOf(JiraError);
    expect(jiraCalls).toEqual([]);
  });
});

describe('UI links', () => {
  it('httpsUrl only lets absolute https URLs through to router.open', () => {
    expect(httpsUrl('https://x.atlassian.net/browse/OPS-1')).toBe('https://x.atlassian.net/browse/OPS-1');
    for (const bad of ['javascript:alert(1)', 'http://x', '//x.atlassian.net', '/wiki/x', 'https://x y', '', null, undefined]) expect(httpsUrl(bad)).toBeNull();
  });
});
