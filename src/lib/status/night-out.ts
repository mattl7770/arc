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
 * Pure over {@link Database}, so the test drives exactly what the store does.
 */
import type { Database } from '@/lib/db/database';
import { nightOutDrinks, setNightOutDrinks } from '@/lib/db/repositories/nutrition';
import { openStatusNamed, startStatus } from '@/lib/db/repositories/statuses';
import type { DrinkKind, DrinksInput } from '@/lib/nutrition/drinks';

export const NIGHT_OUT = 'night out';

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

/** What the stepper opens on: the recorded count and kind, or null for none. */
export function recordedDrinks(
  db: Database,
  date: string
): { count: number; kind: DrinkKind } | null {
  const found = nightOutDrinks(db, date);
  return found ? { count: found.count, kind: found.kind } : null;
}
