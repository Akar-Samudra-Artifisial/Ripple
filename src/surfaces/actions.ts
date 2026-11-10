/**
 * M7: Rovo actions of the Fact Keeper agent. One shared function serves every action (`payload.context.moduleKey`
 * says which), which keeps the manifest small.
 *
 * Answers come only from confirmed facts of ready source pages the asking user can read (CQL as the user), and copies
 * only on pages they can read; nothing is guessed. Logs carry the action, ids and counts only (never a value, quote,
 * title or account id).
 */
import { pageLinkAsApp, visiblePageIds, type AppPageLink } from '../adapters/confluence';
import { sqlChangeRepo, type ChangeRepo } from '../adapters/changeRepo';
import { sqlProposalRepo, type ProposalRepo } from '../adapters/proposalRepo';
import { sqlFactSearch, type FactSearchRepo, type FoundFact } from '../adapters/repo';
import { sqlScanRepo, type ScanRepo } from '../adapters/scanRepo';
import { ensureSchema } from '../adapters/sql';
import { scrubErrorText } from '../adapters/teamworkGraph';
import { SchemaSettingUpError } from '../core/schema';
import { valueLabel } from '../core/valueLabel';
import type { CopyStatus, CopyView, ProposalState } from '../core/views';
import { notImplemented, type NotImplemented } from './stub';

export const ACTIONS = ['get-fact', 'find-copies', 'list-out-of-date', 'propose-updates', 'rollout-status'] as const;
export type ActionKey = (typeof ACTIONS)[number];

/** Rovo passes the action inputs plus `context` (with the action's `moduleKey`) in the payload. */
export interface ActionPayload {
  topic?: unknown;
  spaceKey?: unknown;
  owner?: unknown;
  context?: { moduleKey?: string };
}

/** Facts shown per answer (the best-scored ones). */
export const MAX_FACTS = 5;
/** Copies listed per fact or per listing; the rest are only counted. */
export const MAX_COPIES_LISTED = 20;
const MAX_TOPIC_WORDS = 5;

const STOPWORDS = new Set(
  'the and for what whats which where when who how much many our your you are is does did can could should would per with from about into that this there official value values fact facts current currently tell me show give find list copy copies page pages'.split(
    ' ',
  ),
);

/** Lowercase search words of a topic: letters and digits only, no stopwords, a plural "s" dropped, at most 5. */
export function topicWords(topic: string): string[] {
  const words = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => (w.length >= 3 || /^\d+$/.test(w)) && !STOPWORDS.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .map((w) => w.slice(0, 40));
  return [...new Set(words)].slice(0, MAX_TOPIC_WORDS);
}

/** Words of `words` found in the fact's subject, attribute, condition or value. */
export function factScore(f: Pick<FoundFact, 'subject' | 'attribute' | 'condition' | 'value'>, words: readonly string[]): number {
  const text = [f.subject, f.attribute, f.condition ?? '', f.value].join(' ').toLowerCase();
  return words.filter((w) => text.includes(w)).length;
}

/**
 * The best matches: facts with the top score, which must cover at least 60 % of the words (so one shared word such
 * as "travel" is not an answer). Empty when nothing matches well enough.
 */
export function bestFacts<T extends Pick<FoundFact, 'subject' | 'attribute' | 'condition' | 'value'>>(facts: readonly T[], words: readonly string[]): T[] {
  if (words.length === 0) return [];
  const scored = facts.map((f) => ({ f, s: factScore(f, words) }));
  const top = Math.max(0, ...scored.map((x) => x.s));
  if (top < Math.ceil(words.length * 0.6)) return [];
  return scored
    .filter((x) => x.s === top)
    .map((x) => x.f)
    .slice(0, MAX_FACTS);
}

export interface ActionCopy {
  pageTitle: string;
  pageUrl: string | null;
  status: CopyStatus;
  statedValue: string | null;
  reason: string;
}

export interface ActionFact {
  subject: string;
  attribute: string;
  /** Value with its unit ("$60 per day"). */
  value: string;
  condition: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  effectiveSince: string | null;
}

export interface FactAnswer {
  status: 'found' | 'not_found' | 'error';
  message: string;
  facts: (ActionFact & { outOfDateCopies?: ActionCopy[]; outOfDateCount?: number; copies?: ActionCopy[]; copyCount?: number })[];
}

export interface OutOfDateAnswer {
  status: 'found' | 'none' | 'error';
  message: string;
  copies: (ActionCopy & { fact: string; officialValue: string; sourceTitle: string | null })[];
  total: number;
}

export interface RolloutAnswer {
  status: 'found' | 'not_found' | 'error';
  message: string;
  rollouts: { fact: ActionFact; deadline: string | null; counts: Partial<Record<ProposalState, number>>; hiddenCount: number }[];
}

export interface ActionDeps {
  search: FactSearchRepo;
  scans: Pick<ScanRepo, 'copyPageIds' | 'listCopies'>;
  changes: Pick<ChangeRepo, 'confirmedChanges'>;
  proposals: Pick<ProposalRepo, 'listForChange'>;
  /** Pages the asking user can read (CQL as the user). */
  visible: (pageIds: readonly string[]) => Promise<Set<string>>;
  /** Absolute links as the app; only called for pages the user can read. */
  link: (pageId: string) => Promise<AppPageLink | null>;
  ensure: () => Promise<void>;
}

const defaultDeps: ActionDeps = {
  search: sqlFactSearch,
  scans: sqlScanRepo,
  changes: sqlChangeRepo,
  proposals: sqlProposalRepo,
  visible: visiblePageIds,
  link: pageLinkAsApp,
  ensure: ensureSchema,
};

const errorText = (err: unknown): string => scrubErrorText(err instanceof Error ? err.message : String(err));

/** `https://site/wiki` of a link (from its id-only URL), to make the relative copy links absolute. */
const wikiBase = (link: AppPageLink | null): string | null => {
  if (!link?.idUrl) return null;
  try {
    return `${new URL(link.idUrl).origin}/wiki`;
  } catch {
    return null;
  }
};

const toCopy = (c: CopyView, base: string | null): ActionCopy => ({
  pageTitle: c.pageTitle,
  pageUrl: c.pageUrl && base && c.pageUrl.startsWith('/') ? `${base}${c.pageUrl}` : null,
  status: c.status,
  statedValue: c.statedValue === null ? null : valueLabel(c.statedValue, c.statedUnit),
  reason: c.reason,
});

interface Located {
  fact: FoundFact;
  view: ActionFact;
  base: string | null;
}

/** The best confirmed facts for the topic on sources the user can read, with their source links. */
async function locate(topic: string, deps: ActionDeps): Promise<{ words: number; found: Located[] }> {
  const words = topicWords(topic);
  if (words.length === 0) return { words: 0, found: [] };
  const rows = await deps.search.searchConfirmedFacts(words);
  const sourceIds = [...new Set(rows.map((r) => r.sourcePageId))];
  const readable = sourceIds.length > 0 ? await deps.visible(sourceIds) : new Set<string>();
  const best = bestFacts(
    rows.filter((r) => readable.has(r.sourcePageId)),
    words,
  );
  const links = new Map<string, AppPageLink | null>();
  for (const id of new Set(best.map((f) => f.sourcePageId))) links.set(id, await deps.link(id));
  return {
    words: words.length,
    found: best.map((f) => {
      const link = links.get(f.sourcePageId) ?? null;
      return {
        fact: f,
        base: wikiBase(link),
        view: {
          subject: f.subject,
          attribute: f.attribute,
          value: valueLabel(f.value, f.unit),
          condition: f.condition,
          sourceTitle: link?.title || f.sourceTitle,
          sourceUrl: link?.url ?? link?.idUrl ?? null,
          effectiveSince: f.effectiveSince,
        },
      };
    }),
  };
}

/** Copies of each located fact on pages the user can read (`status` omitted: everything but ignored). */
async function copiesOf(found: readonly Located[], status: CopyStatus | undefined, deps: ActionDeps): Promise<Map<string, CopyView[]>> {
  const bySource = new Map<string, CopyView[]>();
  for (const sourceId of new Set(found.map((l) => l.fact.sourcePageId))) {
    const pageIds = await deps.scans.copyPageIds(sourceId);
    const seen = pageIds.length > 0 ? [...(await deps.visible(pageIds))] : [];
    bySource.set(sourceId, seen.length > 0 ? await deps.scans.listCopies(sourceId, status, seen) : []);
  }
  const byFact = new Map<string, CopyView[]>();
  for (const l of found) byFact.set(l.fact.id, (bySource.get(l.fact.sourcePageId) ?? []).filter((c) => c.factId === l.fact.id));
  return byFact;
}

const NOT_FOUND = 'No confirmed official fact matches this topic on a source page you can open. Do not guess a value.';

const topicOf = (payload: ActionPayload | undefined): string => (typeof payload?.topic === 'string' ? payload.topic.slice(0, 300) : '');

export async function getFact(payload: ActionPayload | undefined, deps: ActionDeps = defaultDeps): Promise<FactAnswer> {
  const { words, found } = await locate(topicOf(payload), deps);
  const drifted = await copiesOf(found, 'drifted', deps);
  console.info('ripple fact keeper', { action: 'get-fact', words, facts: found.length });
  if (found.length === 0) return { status: 'not_found', message: NOT_FOUND, facts: [] };
  return {
    status: 'found',
    message: 'Official confirmed values from their source-of-truth pages. Mention out-of-date copies when there are any.',
    facts: found.map((l) => {
      const ood = drifted.get(l.fact.id) ?? [];
      return { ...l.view, outOfDateCount: ood.length, outOfDateCopies: ood.slice(0, MAX_COPIES_LISTED).map((c) => toCopy(c, l.base)) };
    }),
  };
}

export async function findCopies(payload: ActionPayload | undefined, deps: ActionDeps = defaultDeps): Promise<FactAnswer> {
  const { words, found } = await locate(topicOf(payload), deps);
  const all = await copiesOf(found, undefined, deps);
  console.info('ripple fact keeper', { action: 'find-copies', words, facts: found.length });
  if (found.length === 0) return { status: 'not_found', message: NOT_FOUND, facts: [] };
  return {
    status: 'found',
    message: 'Pages you can open that restate each official fact, with their status (in_sync, drifted = out of date, unsure, updated, historical).',
    facts: found.map((l) => {
      const copies = all.get(l.fact.id) ?? [];
      return { ...l.view, copyCount: copies.length, copies: copies.slice(0, MAX_COPIES_LISTED).map((c) => toCopy(c, l.base)) };
    }),
  };
}

const SPACE_KEY = /^[A-Za-z0-9~_-]{1,255}$/;

export async function listOutOfDate(payload: ActionPayload | undefined, deps: ActionDeps = defaultDeps): Promise<OutOfDateAnswer> {
  const space = typeof payload?.spaceKey === 'string' && payload.spaceKey.trim() !== '' ? payload.spaceKey.trim() : null;
  if (space !== null && !SPACE_KEY.test(space)) return { status: 'error', message: 'The space key is not valid.', copies: [], total: 0 };
  const sources = await deps.search.readySources();
  const readable = sources.length > 0 ? await deps.visible(sources.map((s) => s.pageId)) : new Set<string>();
  const shown: OutOfDateAnswer['copies'] = [];
  let total = 0;
  for (const s of sources.filter((x) => readable.has(x.pageId))) {
    const pageIds = await deps.scans.copyPageIds(s.pageId);
    const seen = pageIds.length > 0 ? [...(await deps.visible(pageIds))] : [];
    if (seen.length === 0) continue;
    const marker = space ? `/spaces/${space.toLowerCase()}/` : null;
    const drifted = (await deps.scans.listCopies(s.pageId, 'drifted', seen)).filter((c) => !marker || (c.pageUrl ?? '').toLowerCase().includes(marker));
    if (drifted.length === 0) continue;
    total += drifted.length;
    const base = wikiBase(await deps.link(s.pageId));
    for (const c of drifted) {
      if (shown.length >= MAX_COPIES_LISTED) break;
      shown.push({ ...toCopy(c, base), fact: c.factLabel, officialValue: valueLabel(c.officialValue, c.officialUnit), sourceTitle: s.title });
    }
  }
  const ownerNote = typeof payload?.owner === 'string' && payload.owner.trim() !== '' ? ' Filtering by owner is not supported, so copies of every owner are listed.' : '';
  console.info('ripple fact keeper', { action: 'list-out-of-date', sources: readable.size, total, space: space !== null });
  if (total === 0) return { status: 'none', message: `No out-of-date copies on pages you can open${space ? ' in this space' : ''}.${ownerNote}`, copies: [], total: 0 };
  return { status: 'found', message: `Copies that state a different value than their source of truth (${total} in total).${ownerNote}`, copies: shown, total };
}

export async function rolloutStatus(payload: ActionPayload | undefined, deps: ActionDeps = defaultDeps): Promise<RolloutAnswer> {
  const { words, found } = await locate(topicOf(payload), deps);
  const rollouts: RolloutAnswer['rollouts'] = [];
  for (const l of found) {
    const change = (await deps.changes.confirmedChanges(l.fact.sourcePageId)).find((c) => c.factChanges.some((fc) => fc.factId === l.fact.id));
    if (!change) continue;
    const rows = await deps.proposals.listForChange(change.id);
    const seen = rows.length > 0 ? await deps.visible([...new Set(rows.map((r) => r.pageId))]) : new Set<string>();
    const counts: Partial<Record<ProposalState, number>> = {};
    for (const r of rows.filter((x) => seen.has(x.pageId))) counts[r.status] = (counts[r.status] ?? 0) + 1;
    rollouts.push({ fact: l.view, deadline: change.routing?.deadline ?? null, counts, hiddenCount: rows.filter((x) => !seen.has(x.pageId)).length });
  }
  console.info('ripple fact keeper', { action: 'rollout-status', words, facts: found.length, rollouts: rollouts.length });
  if (found.length === 0) return { status: 'not_found', message: NOT_FOUND, rollouts: [] };
  if (rollouts.length === 0) return { status: 'not_found', message: 'This fact has no confirmed change, so there is no rollout.', rollouts: [] };
  return { status: 'found', message: 'Progress of the latest confirmed change of each fact over the copies you can open.', rollouts };
}

type Reply = FactAnswer | OutOfDateAnswer | RolloutAnswer | NotImplemented;

export async function factKeeperAction(payload?: ActionPayload, _context?: unknown, deps: ActionDeps = defaultDeps): Promise<Reply> {
  const key = ACTIONS.find((a) => a === payload?.context?.moduleKey);
  if (!key) return notImplemented('Rovo action unknown');
  if (key === 'propose-updates') return notImplemented(`Rovo action ${key}`, { hint: 'source page' });
  try {
    await deps.ensure();
    if (key === 'get-fact') return await getFact(payload, deps);
    if (key === 'find-copies') return await findCopies(payload, deps);
    if (key === 'list-out-of-date') return await listOutOfDate(payload, deps);
    return await rolloutStatus(payload, deps);
  } catch (err) {
    const settingUp = err instanceof SchemaSettingUpError;
    console.warn('ripple fact keeper failed', { action: key, error: settingUp ? 'schema_setting_up' : errorText(err) });
    return { status: 'error', message: settingUp ? 'Ripple is still setting up. Try again in a minute.' : 'Ripple could not answer right now. Do not guess a value.', facts: [] };
  }
}
