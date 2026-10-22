/**
 * Night out, with its count of drinks — the one write behind the drinks
 * stepper (items 61/80, 2026-10-21).
 *
 * Two facts the user stated, recorded in the order the rail always records:
 * the STATUS first (bounded at today — Night out ends tonight, the owner's
 * Q4(a)), then the drinks as a meal on the day
 * (src/lib/db/repositories/nutrition.ts `setNightOutDrinks`). Each write is
 * atomic on its own; if the second fails, the status — the fact the rest of
 * the app accounts for — has still landed, which is the rail's rule.
 *
 * **And nothing else.** No mission row, no protocol, no reminder: this file
 * imports neither, and db/statuses.test.mjs §13 runs it against a planned day
 * and asserts every one of those tables is byte-for-byte what it was. What a
 * night of drinks should change about tomorrow is the Coach's call
 * (docs/information-architecture.md §Status).
 *
 * ## The morning after (2026-10-21 review)
 *
 * A night out crosses the day boundary. Opened again at 01:15 to change 4 to
 * 6, the stepper used to read TODAY — a new day with no record — so it opened
 * on the default, started a second Night out, wrote a second drinks meal and
 * sent the Coach a second sentence: 10 drinks recorded for 6 drunk. So the
 * stepper addresses {@link nightOutDay}: today's record when today has one,
 * else LAST night's, while it is still the morning after. There it re-counts
 * that day's row — no new status, no message — and readiness's "last night"
 * line, which reads yesterday's alcohol, shows the corrected count.
 *
 * Pure over {@link Database}, so the test drives exactly what the store does.
 */
import type { Database } from '@/lib/db/database';
import { shiftISODate } from '@/lib/db/date';
import { nightOutDrinks, setNightOutDrinks } from '@/lib/db/repositories/nutrition';
import { openStatusNamed, startStatus, statusesIn } from '@/lib/db/repositories/statuses';
import type { DrinkKind, DrinksInput } from '@/lib/nutrition/drinks';

export const NIGHT_OUT = 'night out';

/**
 * Until this local hour the morning after, a Night out started yesterday is
 * still the one the stepper re-counts. Noon, because a night out ends in the
 * small hours and its count is corrected on the way home or over the next
 * morning — the window the readiness "last night" line is read in — while a
 * Night out tapped in the afternoon is far likelier a new evening than a
 * correction of the last one. A wall-clock hour, not an offset from the day
 * boundary: "the morning after" is a time of day whatever the boundary is.
 */
export const NIGHT_OUT_CARRIES_UNTIL_HOUR = 12;

/**
 * The day whose Night out the stepper reads and writes: `today`, unless today
 * has no Night out at all — neither the status nor the stepper's drinks — and
 * it is before {@link NIGHT_OUT_CARRIES_UNTIL_HOUR} and yesterday has a Night
 * out STARTED that day. Then yesterday's: the night is still being counted.
 */
export function nightOutDay(db: Database, today: string, now: Date = new Date()): string {
  if (now.getHours() >= NIGHT_OUT_CARRIES_UNTIL_HOUR) return today;
  const isNightOut = (row: { label: string }) => row.label === NIGHT_OUT;
  if (statusesIn(db, today, today).some(isNightOut)) return today;
  if (nightOutDrinks(db, today) !== null) return today;
  const yesterday = shiftISODate(today, -1);
  const lastNight = statusesIn(db, yesterday, yesterday).some(
    (row) => isNightOut(row) && row.start_date === yesterday
  );
  return lastNight ? yesterday : today;
}

/**
 * Record Night out on `date` with `drinks`. Returns whether the status was
 * started by this call — the first save sends a sentence to the Coach; a
 * re-count later that evening is bookkeeping and sends nothing.
 */
export function recordNightOut(
  db: Database,
  date: string,
  drinks: DrinksInput
): { started: boolean } {
  const running = openStatusNamed(db, NIGHT_OUT, date);
  if (!running) {
    startStatus(db, { label: NIGHT_OUT, startDate: date, endDate: date, source: 'user' });
  }
  setNightOutDrinks(db, date, drinks);
  return { started: running === null };
}

/**
 * The stepper's Save: {@link recordNightOut} on today, or — the morning after
 * ({@link nightOutDay}) — a re-count of last night's row through
 * `setNightOutDrinks` on that day, which starts no status and so sends no
 * sentence. Returns the day written and whether a status was started.
 *
 * `target` is the night the stepper OPENED on ({@link nightOutStepper}), and
 * when given it is honoured rather than re-decided: opened at 11:59 on last
 * night's 4 and saved at 12:00:30, a fresh clock would read a new evening and
 * start a second Night out on top of the first (2026-10-21 fix round). The
 * save writes the night the panel said it would. Without one — a caller that
 * never showed a stepper — the night is decided now, as before.
 */
export function saveNightOutDrinks(
  db: Database,
  today: string,
  drinks: DrinksInput,
  now: Date = new Date(),
  target: NightOutTarget | null = null
): { date: string; started: boolean } {
  const date = target?.date ?? nightOutDay(db, today, now);
  const lastNight = target ? target.lastNight : date !== today;
  if (lastNight) {
    setNightOutDrinks(db, date, drinks);
    return { date, started: false };
  }
  return { date, ...recordNightOut(db, date, drinks) };
}

/** The night a stepper opened on: its day, and whether that is last night's
 *  (a re-count) rather than tonight's. */
export type NightOutTarget = { date: string; lastNight: boolean };

/** What the stepper opens on: the recorded count and kind, or null for none. */
export function recordedDrinks(
  db: Database,
  date: string
): { count: number; kind: DrinkKind } | null {
  const found = nightOutDrinks(db, date);
  return found ? { count: found.count, kind: found.kind } : null;
}

/**
 * What the stepper opens on, and for which night: the recorded drinks of
 * {@link nightOutDay}, and whether that is last night's (`lastNight`) — then
 * its Save is a re-count, whatever today's chip says. `date` is the day it
 * chose, which the Save hands back to {@link saveNightOutDrinks} as its target.
 */
export function nightOutStepper(
  db: Database,
  today: string,
  now: Date = new Date()
): { recorded: { count: number; kind: DrinkKind } | null } & NightOutTarget {
  const date = nightOutDay(db, today, now);
  return { recorded: recordedDrinks(db, date), date, lastNight: date !== today };
}
