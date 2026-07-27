/**
 * Display formatting for the Screenings slice — category labels, cadence text,
 * relative due phrasing, and appointment date/time. All hand-rolled string
 * building: Hermes has no Intl, so nothing here may reach for it (same
 * constraint as src/hooks/use-data-overview.ts).
 */
import type { DateString } from '@/lib/db/types';
import type { ScreeningCategory } from './types';

/** Chip/order source for the form; labels for rows. 'derm' reads as Skin. */
export const SCREENING_CATEGORIES: ScreeningCategory[] = [
  'imaging',
  'bloodwork',
  'exam',
  'dental',
  'vision',
  'derm',
  'cardio',
  'other',
];

export const CATEGORY_LABELS: Record<ScreeningCategory, string> = {
  imaging: 'Imaging',
  bloodwork: 'Bloodwork',
  exam: 'Exam',
  dental: 'Dental',
  vision: 'Vision',
  derm: 'Skin',
  cardio: 'Cardio',
  other: 'Other',
};

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
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "YYYY-MM-DD" -> a local Date at midnight (never `new Date(string)` — UTC shift). */
function parseDay(date: DateString): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

/** Whole calendar days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: DateString, b: DateString): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);
}

/** "Every year" / "Every 6 mo" / "Every 10 yr" / "One-off". */
export function cadenceLabel(intervalMonths: number | null): string {
  if (intervalMonths == null) return 'One-off';
  if (intervalMonths === 12) return 'Every year';
  if (intervalMonths % 12 === 0) return `Every ${intervalMonths / 12} yr`;
  if (intervalMonths === 1) return 'Every month';
  return `Every ${intervalMonths} mo`;
}

/** A day count as the shortest honest unit: "3 days", "5 wk", "8 mo", "2 yr". */
function spanText(days: number): string {
  if (days < 14) return days === 1 ? '1 day' : `${days} days`;
  if (days < 70) return `${Math.round(days / 7)} wk`;
  if (days < 550) return `${Math.round(days / 30.44)} mo`;
  return `${Math.round(days / 365.25)} yr`;
}

/** Relative due phrase: "Due today" / "In 3 wk" / "Overdue 3 wk". */
export function dueLabel(nextDue: DateString, today: DateString): string {
  const diff = daysBetween(today, nextDue);
  if (diff === 0) return 'Due today';
  if (diff > 0) return `In ${spanText(diff)}`;
  return `Overdue ${spanText(-diff)}`;
}

/** "Mar 12" within a year of today, "Mar 2036" beyond — ledger-dated, no noise. */
export function dueDateText(nextDue: DateString, today: DateString): string {
  const d = parseDay(nextDue);
  if (Math.abs(daysBetween(today, nextDue)) < 365) {
    return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
  }
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/** "YYYY-MM-DD" -> "Mar 12, 2036" — the forms' unambiguous full date. */
export function dayTextLong(date: DateString): string {
  const d = parseDay(date);
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * True iff `text` is a real calendar day in YYYY-MM-DD shape. The DB GLOB only
 * checks digits, so the form rejects 2026-02-31 here via a Date round-trip.
 */
export function isValidDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(y!, m! - 1, d!);
  return date.getFullYear() === y && date.getMonth() === m! - 1 && date.getDate() === d;
}

/** ISO instant -> local "Wed, Aug 12" ("Today"/"Tomorrow" when it is). */
export function apptDateText(iso: string, today: DateString): string {
  const d = new Date(iso);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
  const diff = daysBetween(today, day);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  const base = `${WEEKDAYS_SHORT[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === parseDay(today).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** ISO instant -> local 12-hour "2:30 PM" (no Intl). */
export function apptTimeText(iso: string): string {
  const d = new Date(iso);
  const h12 = ((d.getHours() + 11) % 12) + 1;
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${h12}:${mm} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
