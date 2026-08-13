/**
 * Pure helpers for re-timing a logged meal — the owner's "introduce
 * functionality to change the time of a meal" (2026-08-12).
 *
 * DB-free and native-free so both the meal-detail editor and the headless
 * suites can import them. They exist as a module rather than as private
 * functions on the screen for exactly one reason: **the schema's GLOB CHECKs
 * do not validate a clock.** `time text CHECK (time GLOB
 * '[0-9][0-9]:[0-9][0-9]')` (0002_nutrition.sql) accepts `99:99` happily — it
 * checks the SHAPE, not the hours. Whatever guards a typed hour has to live in
 * TypeScript, and anything that guards a write wants a test.
 *
 * Kept in the Nutrition family's own folder rather than shared, matching the
 * standing split in this codebase (src/lib/nutrition/format.ts: "the Data-tab
 * keeps its own local formatters; these are the Nutrition family's").
 * {@link mealDayLabel} therefore reads like `src/lib/exercise/format.ts`'s
 * `dayLabel` without importing it — pulling an exercise formatter into a
 * nutrition screen would drag `@/lib/log/metrics` and `@/lib/user/types` across
 * a domain boundary to save nine lines.
 */
import type { DateString, TimeString } from '@/lib/db/types';

/**
 * Hand-rolled names, indexed to match `getDay()` (Sunday-first) and
 * `getMonth()`. Hermes ships without Intl, so `toLocaleDateString(undefined,
 * {…})` silently ignores its options object on device and returns a different
 * shape than the web logic-check preview shows. Same reason, same fix as
 * src/lib/exercise/format.ts and src/components/home/date-eyebrow.tsx.
 */
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const MONTH_SHORT = [
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
] as const;

/**
 * `YYYY-MM-DD` → a local `Date` at midnight. Split into components rather than
 * `new Date(string)`, which some runtimes read as UTC midnight and would shift
 * the day for anyone west of Greenwich (the note on `localDaysList` in
 * src/lib/db/date.ts).
 */
function parseLocalDate(date: DateString): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function toISODate(at: Date): DateString {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * `date` moved by `days` on the LOCAL calendar, as `YYYY-MM-DD`. `Date` handles
 * month ends, year ends and DST for us; the point of going through it rather
 * than doing arithmetic on the string is that 2026-02-28 + 1 is not 2026-02-29.
 */
export function shiftDay(date: DateString, days: number): DateString {
  const at = parseLocalDate(date);
  at.setDate(at.getDate() + days);
  return toISODate(at);
}

/**
 * How the day the meal is being moved to should read: "Today", "Yesterday", or
 * an unambiguous "Sat 9 Aug" — with the year appended once it leaves the
 * current one, because "9 Aug" on a screen that can step backwards forever is
 * not a date, it is a guess.
 *
 * Fuller than the Exercise list's equivalent on purpose. There a label
 * annotates a row you already have; here it is the only readout of a value you
 * are about to WRITE, and a bare weekday would let a slipped tap look right.
 */
export function mealDayLabel(date: DateString, today: DateString): string {
  if (date === today) return 'Today';
  if (date === shiftDay(today, -1)) return 'Yesterday';
  const when = parseLocalDate(date);
  const stem = `${WEEKDAY_SHORT[when.getDay()] ?? ''} ${when.getDate()} ${MONTH_SHORT[when.getMonth()] ?? ''}`;
  const thisYear = parseLocalDate(today).getFullYear();
  return when.getFullYear() === thisYear ? stem : `${stem} ${when.getFullYear()}`;
}

/**
 * Whether `time` is a clock a meal can actually have been eaten at: the
 * schema's `HH:MM` shape AND real hours and minutes. NULL passes — an untimed
 * meal is a supported state (0002_nutrition.sql: "a meal logged after the fact
 * may have no meaningful clock time; the day list sorts untimed meals last").
 *
 * This is the check the CHECK cannot make. `23:59` and `99:99` are the same
 * string to GLOB `[0-9][0-9]:[0-9][0-9]`.
 */
export function isValidClock(time: string | null): time is TimeString | null {
  if (time === null) return true;
  if (!/^\d{2}:\d{2}$/.test(time)) return false;
  const hours = Number(time.slice(0, 2));
  const minutes = Number(time.slice(3, 5));
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

/**
 * What two typed fields amount to. Three outcomes, not two — and the third is
 * the point: **clearing a meal's time is a legitimate edit, not a failed one**,
 * so `none` and `invalid` must not collapse into the same null. A `none` saves
 * (the schema's `time` is nullable and the day list sorts untimed meals last);
 * an `invalid` disables Save and says so.
 */
export type ParsedClock =
  | { kind: 'time'; value: TimeString }
  /** Both fields empty — an untimed meal, which is a real state. */
  | { kind: 'none' }
  /** Typed, but not a clock. Save is inert and the screen explains. */
  | { kind: 'invalid' };

/**
 * Two typed fields → a storable `HH:MM`.
 *
 * Tolerates the shapes a number pad actually produces: "8" and "08" are both
 * eight o'clock, and a blank minute field reads as :00. Forcing the user to
 * type a leading zero so a GLOB will accept the string is the app leaking its
 * schema onto the person using it.
 */
export function parseClockParts(hourText: string, minuteText: string): ParsedClock {
  const h = hourText.trim();
  const m = minuteText.trim();
  if (h === '' && m === '') return { kind: 'none' };
  if (!/^\d{1,2}$/.test(h) || !/^\d{0,2}$/.test(m)) return { kind: 'invalid' };
  const hours = Number(h);
  const minutes = m === '' ? 0 : Number(m);
  if (hours > 23 || minutes > 59) return { kind: 'invalid' };
  const clock = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return { kind: 'time', value: clock as TimeString };
}

/** A stored `HH:MM` split back into the two editor fields; an untimed meal
 *  opens the editor empty rather than pre-filled with a time it never had. */
export function partsFromClock(time: TimeString | null): { hour: string; minute: string } {
  if (time === null || !isValidClock(time)) return { hour: '', minute: '' };
  return { hour: time.slice(0, 2), minute: time.slice(3, 5) };
}
