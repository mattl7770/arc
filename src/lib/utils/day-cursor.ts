/**
 * **Paging through days, bounded.** The arithmetic and the words behind
 * {@link DayPicker} (src/components/ui/day-picker.tsx) — kept in a `.ts` module
 * of its own so the rules are testable headlessly (db/day-boundary.test.mjs §9)
 * rather than only observable through a rendered screen.
 *
 * ## Everything here routes through src/lib/db/date.ts
 *
 * No day is computed in this file. `shiftISODate` does the stepping and
 * `weekdayIndex` reads the weekday; the only thing added is the CLAMP and the
 * label tables. That is the standing rule — a second "today" computed anywhere
 * outside date.ts fails the source scan in db/day-boundary.test.mjs §5 — and it
 * matters more than usual for a picker, because the bound it must respect is the
 * LOGICAL today (the owner's configurable day boundary, B3): with a 04:00
 * boundary, 01:00 on Wednesday is still Tuesday, and a picker that let you step
 * onto "Wednesday" then would be offering a day the rest of the app says has not
 * started.
 *
 * ## The two bounds, and why only one of them is optional
 *
 * `latest` is required and is always the logical today: the future holds no
 * food log, and a forward arrow onto an empty tomorrow is an invitation to log
 * a meal on the wrong day. `earliest` is optional because not every caller has
 * a floor — the nutrition history sets it to the first day ever logged, so the
 * cursor cannot wander back through years of blank days that never existed.
 *
 * {@link stepDay} CLAMPS rather than refusing, and {@link canStepBack} /
 * {@link canStepForward} are what the arrows read to draw themselves. Both
 * halves exist because a clamp alone gives a live-looking arrow that does
 * nothing, and a disabled arrow alone leaves a caller free to write a day past
 * the bound from some other path.
 *
 * ## Hermes has no `Intl`
 *
 * So the weekday and month names are literal tables, like the several others in
 * this codebase (Home's date eyebrow, the Coach's turn context). They are
 * SHORT + FULL because the picker and the authored empties need different
 * registers: the picker's chin says "Tue 9 Sep", and a sentence about a day says
 * "Nothing logged on Tuesday". A sentence with an abbreviation in it reads like
 * a log line, not like writing.
 */
import { shiftISODate, weekdayIndex } from '@/lib/db/date';

const WEEKDAYS_FULL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

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
] as const;

/** The bounds a cursor may not step outside. `earliest` omitted = no floor. */
export type DayBounds = {
  /** The forward bound, inclusive — always the LOGICAL today (date.ts). */
  latest: string;
  /** The back bound, inclusive. Null/undefined leaves the past open. */
  earliest?: string | null;
};

/** True when there is a day before `date` the cursor is allowed to reach. */
export function canStepBack(date: string, bounds: DayBounds): boolean {
  const floor = bounds.earliest;
  return floor == null || date > floor;
}

/** True when there is a day after `date` the cursor is allowed to reach. */
export function canStepForward(date: string, bounds: DayBounds): boolean {
  return date < bounds.latest;
}

/**
 * `date` moved by `delta` days and clamped into the bounds — the one function a
 * caller needs, and the reason a picker cannot land on tomorrow however many
 * times its arrow is tapped.
 *
 * Clamped rather than refused: a caller holding a day that is ALREADY out of
 * bounds (a screen left open across midnight, a stored cursor from before the
 * floor moved) gets pulled back inside rather than kept there. Both `YYYY-MM-DD`
 * comparisons are plain string comparisons, which is the whole reason the schema
 * stores dates that way.
 */
export function stepDay(date: string, delta: number, bounds: DayBounds): string {
  const next = delta === 0 ? date : shiftISODate(date, delta);
  if (next > bounds.latest) return bounds.latest;
  if (bounds.earliest != null && next < bounds.earliest) return bounds.earliest;
  return next;
}

/** "Tuesday" — the register a SENTENCE about a day uses. */
export function weekdayName(date: string): string {
  return WEEKDAYS_FULL[weekdayIndex(date)] ?? '';
}

/** "9 Sep" — parsed componentwise, never `new Date(string)` (the UTC-shift trap). */
function monthDay(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  if (!m || !d) return date;
  return `${d} ${MONTHS_SHORT[m - 1] ?? '?'}`;
}

/**
 * The picker's own chin: "Today", "Yesterday", then "Tue 9 Sep".
 *
 * Today and yesterday get words because that is what they are called; anything
 * older gets its weekday AND its date, because a bare weekday two weeks back is
 * ambiguous and a bare date makes you count. The year is never printed — a food
 * log is browsed within days of itself, and a picker that prints 2026 on every
 * row spends four characters saying nothing.
 */
export function dayLabel(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === shiftISODate(today, -1)) return 'Yesterday';
  return `${WEEKDAYS_SHORT[weekdayIndex(date)] ?? ''} ${monthDay(date)}`;
}

/**
 * How a SENTENCE names the day — "today", "yesterday", "Tuesday", "Tue 9 Sep".
 *
 * The weekday alone is used only inside the last week, where it is unambiguous:
 * "Nothing logged on Tuesday" is how a person says it, right up until there are
 * two Tuesdays in play. Past that it degrades to the picker's own form, which
 * always identifies exactly one day.
 *
 * Lowercase for today/yesterday and capitalised for a weekday, because that is
 * how each behaves mid-sentence — the caller composes "Nothing logged {phrase}"
 * and gets grammar either way.
 */
export function dayPhrase(date: string, today: string): string {
  if (date === today) return 'today';
  if (date === shiftISODate(today, -1)) return 'yesterday';
  if (date > shiftISODate(today, -7)) return `on ${weekdayName(date)}`;
  return `on ${WEEKDAYS_SHORT[weekdayIndex(date)] ?? ''} ${monthDay(date)}`;
}
