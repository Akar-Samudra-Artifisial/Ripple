import type { NotImplemented } from '../core/views';

export type { NotImplemented };

/** Logs that a stub ran (so `forge logs` shows the wiring works) and returns the "not implemented" reply. */
export function notImplemented(feature: string, fields: Record<string, unknown> = {}): NotImplemented {
  console.info('ripple stub', { feature, ...fields });
  return { status: 'not_implemented', feature, message: `Ripple: ${feature} is not implemented yet.` };
}
