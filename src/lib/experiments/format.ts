/**
 * Display formatting for the Experiments slice — the window label, status text,
 * and the "where is this up to" phrase. All hand-rolled string building: Hermes
 * has no Intl, so nothing here may reach for it (same constraint as
 * src/lib/screenings/format.ts).
 */
import type { ExperimentStatus } from '@/lib/db/repositories/experiments';

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "2026-08-01" → "Aug 1". Split on '-', never `new Date(string)` (UTC-shift trap). */
export function shortDate(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  if (!m || !d) return date;
  return `${MONTHS_SHORT[m - 1] ?? '?'} ${d}`;
}

/** "Aug 1 → Aug 14" — the experiment's inclusive window. */
export function windowLabel(startDate: string, endDate: string): string {
  return `${shortDate(startDate)} → ${shortDate(endDate)}`;
}

export const STATUS_LABELS: Record<ExperimentStatus, string> = {
  active: 'Running',
  completed: 'Concluded',
  abandoned: 'Abandoned',
};

/**
 * Where a running experiment is up to. `ready` (its window has closed) is the
 * call to action; otherwise it counts down. Workflow state, not biology — the
 * caller renders it in neutral ink, never a signal colour.
 */
export function progressPhrase(args: { ready: boolean; daysLeft: number }): string {
  if (args.ready) return 'Ready to read out';
  if (args.daysLeft === 0) return 'Last day';
  return `${args.daysLeft} ${args.daysLeft === 1 ? 'day' : 'days'} left`;
}
