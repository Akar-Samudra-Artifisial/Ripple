import { notImplemented, type NotImplemented } from './stub';

/**
 * Rovo actions of the Fact Keeper agent. One shared function serves every action (`context.moduleKey` says which),
 * which keeps the manifest small. Each action is a stub until M6.
 */
export const ACTIONS = ['get-fact', 'find-copies', 'list-out-of-date', 'propose-updates', 'rollout-status'] as const;

/** Rovo passes the action inputs plus `context` (with the action's `moduleKey`) in the payload. */
interface ActionPayload {
  context?: { moduleKey?: string };
}

export async function factKeeperAction(payload?: ActionPayload): Promise<NotImplemented> {
  const key = payload?.context?.moduleKey;
  return notImplemented(`Rovo action ${ACTIONS.find((a) => a === key) ?? 'unknown'}`);
}
