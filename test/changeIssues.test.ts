import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Replies of the mocked Jira REST API, in call order; each records its request. */
const jiraCalls: { path: string; method: string; body: unknown }[] = [];
let jiraReplies: { status: number; body: unknown }[] = [];

vi.mock('@forge/api', () => ({
  default: {
    asApp: () => ({
      requestJira: async (path: string, init: { method: string; body?: string }) => {
        jiraCalls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
        const r = jiraReplies.shift() ?? { status: 500, body: {} };
        return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => JSON.stringify(r.body) };
      },
    }),
  },
  route: (s: TemplateStringsArray, ...v: unknown[]) => s.reduce((acc, part, i) => acc + part + (i < v.length ? String(v[i]) : ''), ''),
}));
vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: {} }));
vi.mock('@forge/events', () => ({ Queue: class {} }));

import type { ChangeIssueRepo, ChangeIssueRow, JiraSettings } from '../src/adapters/changeIssueRepo';
import { parseJiraSettings } from '../src/adapters/changeIssueRepo';
import type { ChangeRow } from '../src/adapters/changeRepo';
import { jira, JiraError, JiraUnavailableError, type CreateIssueInput, type JiraClient } from '../src/adapters/jira';
import type { ProposalRow } from '../src/adapters/proposalRepo';
import { closeKind, groupByOwner, issueAdf, issuesMissing, issuesState, issueSummary, type AdfDoc, type AdfNode, type IssueStatus } from '../src/core/changeIssues';
import { createIssuesForChange, getApproval, getSettings, issuesNeeded, saveSettings, syncIssues, syncOtherChanges, type IssueDeps } from '../src/surfaces/changeIssues';

const SOURCE = '9600001';
const CHANGE = '11111111-1111-1111-1111-111111111111';
const OLDER = '22222222-2222-2222-2222-222222222222';

class Store {
  settings: JiraSettings | undefined = { projectKey: 'OPS' };
  rows = new Map<string, ChangeIssueRow & { claimedAt: number }>();
  now = 0;
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
    },
    deadlineDays: 5,
    createdAt: '2026-11-09T09:00:00Z',
  } as unknown as ChangeRow;
  open = new Set([SOURCE, 'A']);
  created: CreateIssueInput[] = [];
  comments: { key: string; body: AdfDoc }[] = [];
  transitions: string[] = [];
  createFails = false;
  closeFails = false;

  repo(): ChangeIssueRepo {
    const key = (c: string, o: string) => `${c}|${o}`;
    return {
      claim: async (changeId, owner, sourcePageId, pageCount) => {
        const row = this.rows.get(key(changeId, owner));
        if (!row) {
          this.rows.set(key(changeId, owner), { changeId, ownerAccountId: owner, sourcePageId, issueId: null, issueKey: null, issueUrl: null, assigneeSet: false, pageCount, status: 'creating', claimedAt: this.now });
          return true;
        }
        if (row.status === 'failed' || (row.status === 'creating' && this.now - row.claimedAt > 300)) {
          Object.assign(row, { status: 'creating', claimedAt: this.now, pageCount });
          return true;
        }
        return false;
      },
      complete: async (changeId, owner, issue) => {
        const row = this.rows.get(key(changeId, owner));
        if (row?.status === 'creating') Object.assign(row, { status: 'created', issueId: issue.id, issueKey: issue.key, issueUrl: issue.url, assigneeSet: issue.assigneeSet });
      },
      fail: async (changeId, owner) => {
        const row = this.rows.get(key(changeId, owner));
        if (row?.status === 'creating') row.status = 'failed';
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
      isAdmin: async (id) => id === 'admin',
      createIssue: async (input) => {
        if (this.createFails) throw new JiraError(500, 'Jira 500: boom');
        this.created.push(input);
        const n = this.created.length;
        return { id: `10${n}`, key: `OPS-${n}`, url: `https://x.atlassian.net/browse/OPS-${n}`, assigneeSet: true, dueSet: true };
      },
      transitionToDone: async (k) => {
        if (this.closeFails) throw new JiraUnavailableError('down');
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
      pageLink: async (id) => ({ title: `Title ${id}`, url: `https://x.atlassian.net/wiki/spaces/K/pages/${id}` }),
    };
  }
}

let store: Store;

beforeEach(() => {
  store = new Store();
  jiraCalls.length = 0;
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
      ['owner-1', 'Update 2 pages for Travel Policy', '2026-11-16', ['ripple', 'ripple-update']],
      ['owner-2', 'Update 1 page for Travel Policy', '2026-11-16', ['ripple', 'ripple-update']],
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
    expect(await getSettings(ctx('user'), sdeps())).toEqual({ jiraProjectKey: 'OPS', canEdit: false });
    expect(await getSettings(ctx('admin'), sdeps())).toEqual({ jiraProjectKey: 'OPS', canEdit: true });
    expect(await getSettings(ctx('admin', 'ripple-byline'), sdeps())).toEqual({ error: expect.any(String) });
    expect(await saveSettings(ctx('user'), { jiraProjectKey: 'OPS' }, sdeps())).toEqual({ ok: false, errorCode: 'not_allowed' });
    expect(await saveSettings(ctx('admin'), { jiraProjectKey: 'bad key' }, sdeps())).toEqual({ ok: false, errorCode: 'invalid_key' });
    expect(await saveSettings(ctx('admin'), { jiraProjectKey: 'NOPE' }, sdeps())).toEqual({ ok: false, errorCode: 'project_not_found' });
    expect(await saveSettings(ctx('admin'), { jiraProjectKey: ' ops ' }, sdeps())).toEqual({ ok: true, errorCode: null });
    expect(store.settings).toEqual({ projectKey: 'OPS' });
    expect(await saveSettings(ctx('admin'), { jiraProjectKey: '' }, sdeps())).toEqual({ ok: true, errorCode: null });
    expect(store.settings).toBeUndefined();
  });

  it('a Jira that is not reachable fails closed', async () => {
    const d = { ...sdeps(), jira: { ...store.jira(), isAdmin: async () => Promise.reject(new JiraUnavailableError('no jira')) } };
    expect(await getSettings(ctx('admin'), d)).toMatchObject({ canEdit: false });
  });

  it('the issue panel lists the pages of a Ripple issue, null for other issues', async () => {
    await createIssuesForChange(CHANGE, store.deps());
    const d = { ...store.deps(), ensure: async () => undefined };
    const r = await getApproval({ moduleKey: 'ripple-approval', extension: { issue: { key: 'OPS-1' } } }, d);
    expect(r).toMatchObject({ issueKey: 'OPS-1', task: { changeId: CHANGE, closed: false, pages: [{ pageId: 'A', title: 'Title A', open: 1 }, { pageId: 'B', title: null, open: 1 }] } });
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
});
