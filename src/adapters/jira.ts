/**
 * Jira REST as the app (M5 update tasks), ported from Tripwire's adapter. Jira is optional for Ripple: when it is not
 * installed on the site (or refuses the app) calls throw `JiraUnavailableError`.
 */
import api, { route, type APIResponse, type Route } from '@forge/api';
import { ISSUE_TAG, type AdfDoc } from '../core/changeIssues';
import { PROJECT_KEY } from './changeIssueRepo';

/** Jira replied with a non-2xx status. */
export class JiraError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

/**
 * Jira cannot be reached or refused the caller: the call failed before any HTTP status (Jira not installed, Forge
 * proxy error, user consent missing) or was refused (401/403). `reason` is a log-safe enum.
 */
export class JiraUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: string = 'unreachable',
  ) {
    super(message);
    this.name = 'JiraUnavailableError';
  }
}

/** Log-safe class of a Jira failure: `http_<status>`, `needs_auth`, `proxy_<status>`, `unreachable` or `error`. */
export function jiraErrorClass(err: unknown): string {
  if (err instanceof JiraError) return `http_${err.status}`;
  if (err instanceof JiraUnavailableError) return err.reason;
  return 'error';
}

/** Enum for a failure thrown by the Forge fetch itself (never its message). */
function fetchFailureReason(err: unknown): string {
  const e = err as { name?: unknown; status?: unknown } | null;
  if (e?.name === 'NEEDS_AUTHENTICATION_ERR') return 'needs_auth';
  if (typeof e?.status === 'number' && Number.isInteger(e.status)) return `proxy_${e.status}`;
  return 'unreachable';
}

type Method = 'GET' | 'POST' | 'PUT';

function messageOf(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string>; message?: string };
    const parts = [...(body.errorMessages ?? []), ...Object.entries(body.errors ?? {}).map(([k, v]) => `${k}: ${v}`), body.message].filter(Boolean);
    if (parts.length) return `Jira ${status}: ${parts.join('; ')}`;
  } catch {
    // not JSON
  }
  return `Jira ${status}: ${text.slice(0, 200) || 'no body'}`;
}

/**
 * Calls the Jira REST API as the app (default) or as the calling user (resolvers only). Throws JiraError for non-2xx
 * replies, JiraUnavailableError when Jira is unreachable or refuses the caller (401/403).
 */
async function request<T>(method: Method, path: Route, body?: unknown, as: 'app' | 'user' = 'app'): Promise<T> {
  let res: APIResponse;
  try {
    res = await (as === 'user' ? api.asUser() : api.asApp()).requestJira(path, {
      method,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new JiraUnavailableError(`Jira request failed: ${err instanceof Error ? err.message : String(err)}`, fetchFailureReason(err));
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new JiraUnavailableError(messageOf(res.status, text), `http_${res.status}`);
  if (!res.ok) throw new JiraError(res.status, messageOf(res.status, text));
  return (text ? JSON.parse(text) : undefined) as T;
}

interface IssueTypeMeta {
  id: string;
  name: string;
  subtask?: boolean;
}

export interface CreateIssueInput {
  projectKey: string;
  summary: string;
  description: AdfDoc;
  labels: string[];
  assigneeAccountId?: string;
  /** `YYYY-MM-DD`. */
  duedate?: string;
}

export interface CreatedIssue {
  id: string;
  key: string;
  url: string;
  /** False when Jira refused the assignee and the issue was created unassigned. */
  assigneeSet: boolean;
  dueSet: boolean;
}

/** The fields a 400 reply rejects among those that may be left out (assignee, due date). */
export function rejectedOptionalFields(err: unknown): { assignee: boolean; duedate: boolean } {
  if (!(err instanceof JiraError) || err.status !== 400) return { assignee: false, duedate: false };
  return { assignee: /assignee/i.test(err.message), duedate: /duedate|due date/i.test(err.message) };
}

export interface JiraClient {
  /** Undefined when the project does not exist (or the app cannot see it). */
  getProject(key: string): Promise<{ id: string; key: string } | undefined>;
  /**
   * True when the calling user holds the global Jira ADMINISTER permission: `GET /rest/api/3/mypermissions` as the
   * user (their own permissions; `read:jira-work`, no permission needed). Resolvers only.
   */
  isCurrentUserAdmin(): Promise<boolean>;
  createIssue(input: CreateIssueInput): Promise<CreatedIssue>;
  /**
   * The issue of the project carrying Ripple's per-(change, owner) label (`ISSUE_TAG`), or undefined. Used before
   * creating, so an issue created by a job that died before recording it is reused instead of duplicated.
   */
  findByLabel(projectKey: string, label: string, assigneeAccountId: string): Promise<CreatedIssue | undefined>;
  /** Moves the issue to a Done-category status; false when the workflow offers no such transition. */
  transitionToDone(key: string): Promise<boolean>;
  addComment(key: string, body: AdfDoc): Promise<void>;
}

export const jira: JiraClient = {
  async getProject(key) {
    try {
      const p = await request<{ id: string | number; key: string }>('GET', route`/rest/api/3/project/${key}`);
      return { id: String(p.id), key: p.key };
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return undefined;
      throw err;
    }
  },

  // Not `POST /permissions/check` as the app: per the Jira docs, checking another user's permissions needs the caller
  // (here the app user, not a Jira administrator) to hold Administer Jira, so the check failed closed for real admins.
  async isCurrentUserAdmin() {
    const body = await request<{ permissions?: { ADMINISTER?: { havePermission?: unknown } } }>('GET', route`/rest/api/3/mypermissions?permissions=ADMINISTER`, undefined, 'user');
    return body?.permissions?.ADMINISTER?.havePermission === true;
  },

  async createIssue(input) {
    const issuetype = { id: await taskTypeId(input.projectKey) };
    let withAssignee = input.assigneeAccountId !== undefined;
    let withDue = input.duedate !== undefined;
    // At most three tries: as asked, then without each optional field Jira rejected (not on the screen, no permission).
    for (let attempt = 0; ; attempt++) {
      const fields = {
        project: { key: input.projectKey },
        issuetype,
        summary: input.summary,
        description: input.description,
        labels: input.labels,
        ...(withAssignee && input.assigneeAccountId ? { assignee: { accountId: input.assigneeAccountId } } : {}),
        ...(withDue && input.duedate ? { duedate: input.duedate } : {}),
      };
      try {
        const created = await request<{ id: string | number; key: string; self: string }>('POST', route`/rest/api/3/issue`, { fields });
        return { id: String(created.id), key: created.key, url: `${new URL(created.self).origin}/browse/${created.key}`, assigneeSet: withAssignee, dueSet: withDue };
      } catch (err) {
        const rejected = rejectedOptionalFields(err);
        const dropAssignee = withAssignee && rejected.assignee;
        const dropDue = withDue && rejected.duedate;
        if (attempt >= 2 || (!dropAssignee && !dropDue)) throw err;
        console.warn('ripple jira: optional field rejected, creating without it', { assignee: dropAssignee, duedate: dropDue });
        if (dropAssignee) withAssignee = false;
        if (dropDue) withDue = false;
      }
    }
  },

  async findByLabel(projectKey, label, assigneeAccountId) {
    // Both values are validated, so the quoted JQL literals cannot be broken out of.
    if (!PROJECT_KEY.test(projectKey) || !ISSUE_TAG.test(label)) throw new JiraError(400, 'Invalid project key or label for the issue search');
    const body = await request<{ issues?: { id: string | number; key: string; self: string; fields?: { assignee?: { accountId?: string } | null; duedate?: string | null } }[] }>(
      'POST',
      route`/rest/api/3/search/jql`,
      { jql: `project = "${projectKey}" AND labels = "${label}" ORDER BY created ASC`, fields: ['assignee', 'duedate'], maxResults: 1 },
    );
    const found = body.issues?.[0];
    if (!found) return undefined;
    return {
      id: String(found.id),
      key: found.key,
      url: `${new URL(found.self).origin}/browse/${found.key}`,
      assigneeSet: found.fields?.assignee?.accountId === assigneeAccountId,
      dueSet: typeof found.fields?.duedate === 'string',
    };
  },

  async transitionToDone(key) {
    const body = await request<{ transitions?: { id: string; to?: { statusCategory?: { key?: string } } }[] }>('GET', route`/rest/api/3/issue/${key}/transitions`);
    const done = (body.transitions ?? []).find((t) => t.to?.statusCategory?.key === 'done');
    if (!done) return false;
    await request('POST', route`/rest/api/3/issue/${key}/transitions`, { transition: { id: done.id } });
    return true;
  },

  async addComment(key, body) {
    await request('POST', route`/rest/api/3/issue/${key}/comment`, { body });
  },
};

/** Issue type for update tasks: Task, else Story, else the first non-subtask type of the project. */
async function taskTypeId(projectKey: string): Promise<string> {
  const body = await request<{ issueTypes?: IssueTypeMeta[]; values?: IssueTypeMeta[] }>('GET', route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes`);
  const types = (body.issueTypes ?? body.values ?? []).filter((t) => !t.subtask);
  const pick = types.find((t) => t.name === 'Task') ?? types.find((t) => t.name === 'Story') ?? types[0];
  if (!pick) throw new JiraError(400, `Jira project ${projectKey} has no issue type that can be created`);
  return String(pick.id);
}
