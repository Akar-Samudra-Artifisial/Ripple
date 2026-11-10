/**
 * Change deadlines (PRD "Tenggat dan pengingat": default 5 working days). One rule for the confirm modal, the stored
 * routing (Rollout, reminders) and the Jira `duedate`: count Mon–Fri working days from the confirmer's calendar day.
 * Pure and dependency-free, so the Custom UI bundles the same code.
 */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A valid `YYYY-MM-DD` as UTC midnight, else null. */
function parseDay(day: string): Date | null {
  const m = ISO_DAY.exec(day);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === day ? d : null;
}

/** `start` (a `YYYY-MM-DD` day, or the UTC day of a Date) plus `days` working days (Mon–Fri), as `YYYY-MM-DD`. */
export function addWorkingDays(start: Date | string, days: number): string {
  const from = typeof start === 'string' ? parseDay(start) : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  if (!from) throw new Error('addWorkingDays: start is not a YYYY-MM-DD day');
  let left = Math.max(0, Math.trunc(days));
  while (left > 0) {
    from.setUTCDate(from.getUTCDate() + 1);
    const wd = from.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return from.toISOString().slice(0, 10);
}

/** The local calendar day of `d` (browser time zone) as `YYYY-MM-DD`; what the UI sends as `today`. */
export function localDay(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The day a confirmation counts from: the confirmer's local day when given and plausible (time zones lie within one
 * day of UTC, UTC−12…UTC+14), else the UTC day of `now`.
 */
export function confirmDay(clientDay: unknown, now: Date): string {
  const utc = now.toISOString().slice(0, 10);
  if (typeof clientDay !== 'string') return utc;
  const d = parseDay(clientDay);
  const u = parseDay(utc);
  return d && u && Math.abs(d.getTime() - u.getTime()) <= DAY_MS ? clientDay : utc;
}
