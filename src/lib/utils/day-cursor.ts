/**
 * **Paging through days, bounded.** The arithmetic and the words behind
 * {@link DayPicker} (src/components/ui/day-picker.tsx) — kept in a `.ts` module
 * of its own so the rules are testable headlessly (db/day-boundary.test.mjs §8)
 * rather than only observable through a rendered screen.
 *
 * ## Everything here routes through src/lib/db/date.ts
 *
 * No day is computed in this file. `shiftISODate` does the stepping and
 * `weekdayIndex` reads the weekday; the only thing added is the CLAMP and the
 * label tables. That is the standing rule — a second "today" computed anywhere
 * outside date.ts fails the source scan in db/day-boundary.test.mjs §5 — and it
 * matters more than usual for a picker, because the day it names *today* is the
 * LOGICAL one (the owner's configurable day boundary, B3): with a 04:00
 * boundary, 01:00 on Wednesday is still Tuesday, and a picker that printed
 * "Today" over Wednesday then would be naming a day the rest of the app says
 * has not started.
 *
 * ## The three bounds, and why only one of them is required
 *
 * `latest` is required and is the FORWARD bound the caller allows. It was a
 * synonym for the logical today until 2026-09-19 and is not one any more:
 *
 *   - the nutrition history still passes today, because the future holds no
 *     food log and a forward arrow onto an empty tomorrow is an invitation to
 *     log a meal on the wrong day;
 *   - the mission's Plan screen passes `today + MISSION_HORIZON_DAYS`, because
 *     a day ahead is a PLAN, and looking at one writes nothing
 *     (docs/spikes/mission-day-picker-and-future-checkoff.md).
 *
 * `today` is optional and defaults to `latest`, which is what keeps a caller
 * that never looks forward byte-identical. It is the day the WORDS are computed
 * against — *Today*, *Yesterday*, *Tomorrow* — and the day the way-home control
 * returns to. Separating the two is the whole of the change: conflated, "Back
 * to today" landed on the horizon.
 *
 * `earliest` is optional because not every caller has a floor — the nutrition
 * history sets it to the first day ever logged, so the cursor cannot wander back
 * through years of blank days that never existed.
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
  /**
   * The forward bound, inclusive — how far the caller allows the cursor to go.
   * The logical today for a screen that records the past; today + a horizon for
   * one that shows a plan. See the header.
   */
  latest: string;
  /**
   * The LOGICAL today (date.ts), when it is not `latest`. Optional, and
   * defaulting to `latest` is what makes every past-only caller unchanged: it
   * is only the words and the way home that read it.
   */
  today?: string;
  /** The back bound, inclusive. Null/undefined leaves the past open. */
  earliest?: string | null;
};

/**
 * The logical today a set of bounds names — `latest` unless the caller said
 * otherwise. One expression, read by the picker three times, because the
 * version of this feature that missed one of the three sent "Back to today" to
 * the far end of the horizon.
 */
export function boundsToday(bounds: DayBounds): string {
  return bounds.today ?? bounds.latest;
}

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
 * The picker's own chin: "Today", "Yesterday", "Tomorrow", then "Tue 9 Sep".
 *
 * The three adjacent days get words because that is what they are called;
 * anything else gets its weekday AND its date, because a bare weekday two weeks
 * either way is ambiguous and a bare date makes you count. The year is never
 * printed — a day picker is used within days of itself, and one that prints
 * 2026 on every row spends four characters saying nothing.
 *
 * *Tomorrow* arrived with the mission's Plan screen (2026-09-19), which is the
 * first caller whose `latest` is not today. {@link dayPhrase} deliberately did
 * NOT grow a forward form: its one caller never passes a future day, and its
 * weekday form ("on Wednesday") is ambiguous read forwards.
 */
export function dayLabel(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === shiftISODate(today, -1)) return 'Yesterday';
  if (date === shiftISODate(today, 1)) return 'Tomorrow';
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
