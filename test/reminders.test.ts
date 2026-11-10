import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: (s: TemplateStringsArray) => s.join('') }));
vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: {} }));
vi.mock('@forge/events', () => ({ Queue: class {} }));

import type { ChangeIssueRow, ReminderRepo } from '../src/adapters/changeIssueRepo';
import type { ChangeRow } from '../src/adapters/changeRepo';
import { JiraError } from '../src/adapters/jira';
import type { ProposalRow } from '../src/adapters/proposalRepo';
import type { AdfDoc } from '../src/core/changeIssues';
import { deadlineState, dueReminders, itemOverdue, reminderBody } from '../src/core/reminders';
import { rolloutIssues } from '../src/surfaces/changeIssues';
import { remindOwners, runReminderSweep, type ReminderDeps } from '../src/surfaces/reminders';

const SOURCE = '9500001';
const CHANGE = 'aec7c919-1749-4c74-8d71-0694fd554e58';
const at = (iso: string) => new Date(iso);

describe('M7 deadline state', () => {
  it('on track before the deadline, due from it, late 3 working days later (weekends skipped)', () => {
    // Deadline Friday 2026-11-20: late from Wednesday 2026-11-25.
    expect(deadlineState('2026-11-20', at('2026-11-19T23:59:00Z'))).toBe('on_track');
    expect(deadlineState('2026-11-20', at('2026-11-20T00:00:00Z'))).toBe('due');
    expect(deadlineState('2026-11-20', at('2026-11-24T12:00:00Z'))).toBe('due');
    expect(deadlineState('2026-11-20', at('2026-11-25T00:00:00Z'))).toBe('late');
    expect(deadlineState(null, at('2026-11-25T00:00:00Z'))).toBeNull();
    expect(deadlineState('20-11-2026', at('2026-11-25T00:00:00Z'))).toBeNull();
  });

  it('automatic reminders due and the overdue marker of an item', () => {
    expect([dueReminders('on_track'), dueReminders('due'), dueReminders('late'), dueReminders(null)]).toEqual([0, 1, 2, 0]);
    expect(itemOverdue('proposed', 'late')).toBe('late');
    expect(itemOverdue('needs_manual', 'due')).toBe('due');
    expect(itemOverdue('applied', 'late')).toBeNull();
    expect(itemOverdue('rejected', 'late')).toBeNull();
    expect(itemOverdue('proposed', 'on_track')).toBeNull();
  });

  it('the reminder comment mentions the owner and names only counts and the deadline', () => {
    const doc = reminderBody({ ownerAccountId: 'owner-1', openPages: 2, deadline: '2026-11-20', state: 'late' });
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'mention', attrs: { id: 'owner-1' } },
        { type: 'text', text: ' Reminder from Ripple: 2 pages in this task still need your review in Confluence. These updates are late (deadline 2026-11-20).' },
      ],
    });
  });
});

/** In-memory `change_issues` with the SQL guards of `sqlReminderRepo` (status, cooldown, stage). */
class World {
  now = at('2026-11-20T09:00:00Z');
  rows: (ChangeIssueRow & { remindedMs: number | null; claim: string | null; claimedMs: number | null })[] = [];
  comments: { key: string; body: AdfDoc }[] = [];
  jiraFails = 0;
  /** Issue keys that are Done in Jira. */
  doneInJira = new Set<string>();
  /** Milliseconds the clock moves on per posted comment (time budget tests). */
  tick = 0;
  tokens = 0;
  /** The run is cut off between claim and record: the record never lands (the claim stays behind). */
  recordLost = false;
  canEdit = true;
  change: ChangeRow = {
    id: CHANGE,
    sourcePageId: SOURCE,
    status: 'confirmed',
    pageVersion: 4,
    factChanges: [],
    missingFactIds: [],
    impact: null,
    routing: {
      deadline: '2026-11-20',
      pages: [
        { pageId: 'A', spaceId: 'S1', ownerAccountId: 'owner-1', ownerRole: 'owner', copies: 1 },
        { pageId: 'B', spaceId: 'S1', ownerAccountId: 'owner-1', ownerRole: 'owner', copies: 1 },
        { pageId: 'C', spaceId: 'S2', ownerAccountId: 'owner-2', ownerRole: 'owner', copies: 1 },
      ],
      spaces: [],
      jiraProjectKey: 'OPS',
    },
    deadlineDays: 5,
    createdAt: null,
  } as unknown as ChangeRow;
  proposals = [
    { pageId: 'A', status: 'proposed' },
    { pageId: 'B', status: 'applied' },
    { pageId: 'C', status: 'proposed' },
  ] as ProposalRow[];

  constructor() {
    for (const [owner, key] of [
      ['owner-1', 'OPS-1'],
      ['owner-2', 'OPS-2'],
    ] as const) {
      this.rows.push({ changeId: CHANGE, ownerAccountId: owner, sourcePageId: SOURCE, issueId: key, issueKey: key, issueUrl: null, assigneeSet: true, pageCount: 1, status: 'created', attempts: 1, commentSent: false, remindedAt: null, reminderCount: 0, autoReminders: 0, remindedMs: null, claim: null, claimedMs: null });
    }
  }

  row = (changeId: string, owner: string) => this.rows.find((x) => x.changeId === changeId && x.ownerAccountId === owner);

  snapshot = (): ChangeIssueRow[] => this.rows.map((r) => ({ ...r, remindedAt: r.remindedMs === null ? null : new Date(r.remindedMs).toISOString() }));

  reminders(): ReminderRepo {
    return {
      claimReminder: async (changeId, owner, stage) => {
        const r = this.row(changeId, owner);
        if (!r || r.status !== 'created' || !r.issueKey) return null;
        if (r.remindedMs !== null && this.now.getTime() - r.remindedMs < 20 * 3600 * 1000) return null;
        if (r.claim !== null && r.claimedMs !== null && this.now.getTime() - r.claimedMs < 16 * 60 * 1000) return null;
        if (stage !== null && (r.autoReminders ?? 0) >= stage) return null;
        r.claim = `tok-${++this.tokens}`;
        r.claimedMs = this.now.getTime();
        return r.claim;
      },
      confirmReminder: async (changeId, owner, token, stage) => {
        const r = this.row(changeId, owner);
        if (this.recordLost) throw new Error('cut off');
        if (!r || r.claim !== token) return false;
        r.remindedMs = this.now.getTime();
        r.reminderCount = (r.reminderCount ?? 0) + 1;
        if (stage !== null) r.autoReminders = Math.max(r.autoReminders ?? 0, stage);
        r.claim = null;
        r.claimedMs = null;
        return true;
      },
      releaseReminder: async (changeId, owner, token) => {
        const r = this.row(changeId, owner);
        if (r?.claim === token) Object.assign(r, { claim: null, claimedMs: null });
      },
      closeDone: async (changeId, owner, token) => {
        const r = this.row(changeId, owner);
        if (r?.status !== 'created' || r.claim !== token) return false;
        Object.assign(r, { status: 'closed', commentSent: true, claim: null, claimedMs: null });
        return true;
      },
      listOpenIssues: async (after) =>
        this.snapshot()
          .filter((r) => r.status === 'created')
          .sort((a, b) => (a.changeId === b.changeId ? (a.ownerAccountId < b.ownerAccountId ? -1 : 1) : a.changeId < b.changeId ? -1 : 1))
          .filter((r) => !after || r.changeId > after.changeId || (r.changeId === after.changeId && r.ownerAccountId > after.ownerAccountId))
          .slice(0, 200),
    };
  }

  deps(): ReminderDeps {
    return {
      issues: { listForChange: async (id) => this.snapshot().filter((r) => r.changeId === id) },
      reminders: this.reminders(),
      changes: { getChange: async (id) => (id === CHANGE ? this.change : undefined) },
      proposals: { listForChange: async () => this.proposals },
      jira: {
        addComment: async (key, body) => {
          if (this.jiraFails > 0) {
            this.jiraFails--;
            throw new JiraError(500, 'Jira 500: secret');
          }
          this.comments.push({ key, body });
          this.now = new Date(this.now.getTime() + this.tick);
        },
        issueIsDone: async (key) => this.doneInJira.has(key),
      },
      canEdit: async () => this.canEdit,
      now: () => this.now,
      ensure: async () => undefined,
    };
  }
}

const ctx = { accountId: 'viewer', extension: { content: { id: SOURCE } } };
let w: World;
let logs: unknown[][];

beforeEach(() => {
  w = new World();
  logs = [];
  vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => void logs.push(a));
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logs.push(a));
});

describe('M7 remindOwners (Rollout "Remind")', () => {
  it('gate: source page context, edit permission, a valid change of this page', async () => {
    expect(await remindOwners({}, { changeId: CHANGE }, w.deps())).toEqual({ error: expect.stringContaining('Open a Confluence page') });
    expect(await remindOwners(ctx, { changeId: 'nope' }, w.deps())).toEqual({ error: 'Missing or invalid change id.' });
    expect(await remindOwners(ctx, { changeId: CHANGE, issueKey: 'x; drop' }, w.deps())).toEqual({ error: 'Invalid issue key.' });
    expect(await remindOwners({ extension: { content: { id: '9500002' } } }, { changeId: CHANGE }, w.deps())).toEqual({ error: 'This change does not belong to this page.' });
    w.canEdit = false;
    expect(await remindOwners(ctx, { changeId: CHANGE }, w.deps())).toEqual({ error: expect.stringContaining('edit permission') });
    expect(w.comments).toEqual([]);
  });

  it('reminds each owner with open pages once, then rate-limits for 20 hours (idempotent repeat clicks)', async () => {
    expect(await remindOwners(ctx, { changeId: CHANGE }, w.deps())).toEqual({ changeId: CHANGE, reminded: 2, skipped: 0, failed: 0, errorCode: null });
    expect(w.comments.map((c) => c.key)).toEqual(['OPS-1', 'OPS-2']);
    expect(await remindOwners(ctx, { changeId: CHANGE }, w.deps())).toMatchObject({ reminded: 0, skipped: 2 });
    w.now = at('2026-11-21T04:00:00Z'); // 19 h later
    expect(await remindOwners(ctx, { changeId: CHANGE, issueKey: 'OPS-1' }, w.deps())).toMatchObject({ reminded: 0, skipped: 1 });
    w.now = at('2026-11-21T06:00:00Z'); // 21 h later
    expect(await remindOwners(ctx, { changeId: CHANGE, issueKey: 'OPS-1' }, w.deps())).toMatchObject({ reminded: 1, skipped: 0 });
    expect(w.comments).toHaveLength(3);
    expect(w.rows[0]?.reminderCount).toBe(2);
  });

  it('skips owners with nothing open and closed tasks; an unknown task is an error', async () => {
    w.proposals = [{ pageId: 'A', status: 'applied' }, { pageId: 'C', status: 'proposed' }] as ProposalRow[];
    expect(await remindOwners(ctx, { changeId: CHANGE }, w.deps())).toMatchObject({ reminded: 1, skipped: 1 });
    expect(w.comments.map((c) => c.key)).toEqual(['OPS-2']);
    expect(await remindOwners(ctx, { changeId: CHANGE, issueKey: 'OPS-9' }, w.deps())).toEqual({ error: 'This update task is not open.' });
  });

  it('a Jira failure undoes the claim so a retry can send; the reply and logs carry codes only', async () => {
    w.jiraFails = 1;
    expect(await remindOwners(ctx, { changeId: CHANGE, issueKey: 'OPS-1' }, w.deps())).toEqual({ changeId: CHANGE, reminded: 0, skipped: 0, failed: 1, errorCode: 'http_500' });
    expect(w.rows[0]).toMatchObject({ reminderCount: 0, remindedMs: null, claim: null, autoReminders: 0 });
    expect(await remindOwners(ctx, { changeId: CHANGE, issueKey: 'OPS-1' }, w.deps())).toMatchObject({ reminded: 1 });
    const text = JSON.stringify(logs);
    for (const leak of ['owner-1', 'secret', 'viewer']) expect(text).not.toContain(leak);
  });
});

describe('M7 Rollout: Late and Remind data per owner task', () => {
  it('open pages, overdue state, reminders and canRemind', async () => {
    const repo = { listForChange: async () => w.snapshot(), getJiraSettings: async () => ({ projectKey: 'OPS' }) };
    const late = await rolloutIssues(w.change, w.proposals, new Map(), repo, at('2026-11-25T09:00:00Z'));
    expect(late.issues.map((i) => [i.issueKey, i.openPages, i.overdue, i.canRemind])).toEqual([
      ['OPS-1', 1, 'late', true],
      ['OPS-2', 1, 'late', true],
    ]);
    w.rows[0]!.remindedMs = at('2026-11-25T08:00:00Z').getTime();
    w.rows[0]!.reminderCount = 1;
    const after = await rolloutIssues(w.change, w.proposals, new Map(), repo, at('2026-11-25T09:00:00Z'));
    expect(after.issues[0]).toMatchObject({ remindedAt: '2026-11-25T08:00:00.000Z', reminderCount: 1, canRemind: false });
    const early = await rolloutIssues(w.change, w.proposals, new Map(), repo, at('2026-11-18T09:00:00Z'));
    expect(early.issues.map((i) => i.overdue)).toEqual([null, null]);
  });
});

describe('M7 reminder sweep (daily trigger)', () => {
  it('sends nothing before the deadline, once at the deadline, once more when late, never twice per stage', async () => {
    w.now = at('2026-11-19T09:00:00Z');
    expect(await runReminderSweep(w.deps())).toEqual({ changes: 0, reminded: 0, skipped: 0, done: 0, failed: 0, truncated: false });
    w.now = at('2026-11-20T09:00:00Z');
    expect(await runReminderSweep(w.deps())).toMatchObject({ reminded: 2 });
    w.now = at('2026-11-23T09:00:00Z'); // still due: stage 1 already sent
    expect(await runReminderSweep(w.deps())).toMatchObject({ changes: 0, reminded: 0 });
    w.now = at('2026-11-25T09:00:00Z'); // late
    expect(await runReminderSweep(w.deps())).toMatchObject({ reminded: 2 });
    w.now = at('2026-11-26T09:00:00Z');
    expect(await runReminderSweep(w.deps())).toMatchObject({ changes: 0, reminded: 0 });
    expect(w.comments).toHaveLength(4);
    expect(w.rows.map((r) => r.autoReminders)).toEqual([2, 2]);
  });

  it('respects a manual reminder sent within 20 hours and skips owners with nothing open', async () => {
    await remindOwners(ctx, { changeId: CHANGE, issueKey: 'OPS-1' }, w.deps());
    w.proposals = [{ pageId: 'A', status: 'proposed' }, { pageId: 'C', status: 'rejected' }] as ProposalRow[];
    w.now = at('2026-11-20T10:00:00Z');
    expect(await runReminderSweep(w.deps())).toMatchObject({ reminded: 0, skipped: 2 });
    expect(w.comments).toHaveLength(1);
  });

  it('never throws, and logs counts only', async () => {
    const deps = w.deps();
    deps.reminders.listOpenIssues = async () => {
      throw new Error('sql down');
    };
    await expect(runReminderSweep(deps)).resolves.toEqual({ changes: 0, reminded: 0, skipped: 0, done: 0, failed: 0, truncated: false });
    w.now = at('2026-11-25T09:00:00Z');
    await runReminderSweep(w.deps());
    expect(JSON.stringify(logs)).not.toMatch(/owner-|OPS-/);
  });
});

describe('M7 review fixes: claim before comment, Done in Jira, budget and paging', () => {
  it('a failed automatic comment leaves the stage unsent, so the next run sends it', async () => {
    w.jiraFails = 2;
    expect(await runReminderSweep(w.deps())).toMatchObject({ reminded: 0, failed: 2 });
    expect(w.rows.map((r) => [r.autoReminders, r.reminderCount, r.claim])).toEqual([
      [0, 0, null],
      [0, 0, null],
    ]);
    expect(await runReminderSweep(w.deps())).toMatchObject({ reminded: 2 });
    expect(w.rows.map((r) => r.autoReminders)).toEqual([1, 1]);
  });

  it('a run cut off before the record leaves a claim that blocks for 16 minutes, then goes stale', async () => {
    w.recordLost = true;
    expect(await remindOwners(ctx, { changeId: CHANGE, issueKey: 'OPS-1' }, w.deps())).toMatchObject({ reminded: 1 });
    w.recordLost = false;
    expect(w.rows[0]).toMatchObject({ autoReminders: 0, reminderCount: 0, claim: 'tok-1' });
    w.now = at('2026-11-20T09:10:00Z');
    expect(await runReminderSweep(w.deps())).toMatchObject({ reminded: 1, skipped: 1 });
    w.now = at('2026-11-20T09:20:00Z');
    expect(await runReminderSweep(w.deps())).toMatchObject({ reminded: 1 });
    expect(w.rows.map((r) => r.autoReminders)).toEqual([1, 1]);
  });

  it('a task already Done in Jira gets no reminder and is closed here', async () => {
    w.doneInJira.add('OPS-1');
    expect(await runReminderSweep(w.deps())).toMatchObject({ reminded: 1, done: 1 });
    expect(w.comments.map((c) => c.key)).toEqual(['OPS-2']);
    expect(w.rows[0]).toMatchObject({ status: 'closed', commentSent: true, claim: null, reminderCount: 0 });
    expect(await remindOwners(ctx, { changeId: CHANGE, issueKey: 'OPS-1' }, w.deps())).toEqual({ error: 'This update task is not open.' });
  });

  it('reads every open task in keyset pages and stops at the time budget', async () => {
    for (let i = 0; i < 450; i++) {
      w.change.routing?.pages.push({ pageId: `P${i}`, spaceId: 'S1', ownerAccountId: `o-${String(i).padStart(3, '0')}`, ownerRole: 'owner', copies: 1 } as never);
      w.proposals.push({ pageId: `P${i}`, status: 'proposed' } as ProposalRow);
      w.rows.push({ ...w.rows[0]!, ownerAccountId: `o-${String(i).padStart(3, '0')}`, issueKey: `OPS-${100 + i}` });
    }
    const all = await runReminderSweep(w.deps());
    expect(all).toMatchObject({ reminded: 452, truncated: false });
    w.now = at('2026-11-25T09:00:00Z');
    w.tick = 60 * 1000; // one minute per comment
    const cut = await runReminderSweep(w.deps(), 5 * 60 * 1000);
    expect(cut).toMatchObject({ reminded: 5, truncated: true });
  });
});
