/**
 * The caffeine cut-off, read against the database (item 72): his rule from the
 * preferences blob, today's open timed Training rows, and when the food is
 * being logged. The arithmetic is src/lib/nutrition/caffeine-cutoff.ts; this
 * only gathers its inputs.
 *
 * **Read-only**, so the Coach's confirmation card can call it before the gate.
 * It does not arrive the day (`arriveDay` writes); a hand path that may be the
 * first touch of the day does that itself (src/lib/nutrition/
 * caffeine-confirm.ts).
 */
import type { Database } from '../database';
import { clockFromISO, dayStartMinutes, todayISODate } from '../date';
import {
  CAFFEINE_FLOOR_MG,
  type CaffeineItem,
  type CaffeineWarning,
  caffeineMgOf,
  caffeineWarning,
} from '@/lib/nutrition/caffeine-cutoff';

import { getMeal } from './nutrition';
import { openTimedTrainingRows } from './training-tick';
import { getCaffeineCutoff } from './user';

/** When a food is being logged: the meal's day and clock, the clock null for now. */
export type LogWhen = { date: string; time: string | null };

/** When `mealId` sits — what an add INTO that meal is logged at — or null if gone. */
export function mealWhen(db: Database, mealId: string): LogWhen | null {
  const meal = getMeal(db, mealId);
  return meal ? { date: meal.date, time: meal.time } : null;
}

/**
 * Whether logging `items` at `when` (null: now) breaks his cut-off — the
 * warning to show, or null. Only a log onto TODAY can: the rows measured
 * against are today's, and a meal dated another day is a record, not a coffee
 * about to be drunk. An untimed `when` is logged now.
 */
export function caffeineCheck(
  db: Database,
  items: readonly CaffeineItem[],
  when: LogWhen | null,
  options: { now?: Date; priorMg?: number } = {}
): CaffeineWarning | null {
  const rule = getCaffeineCutoff(db);
  if (!rule.enabled) return null;
  const now = options.now ?? new Date();
  const today = todayISODate(now);
  if ((when?.date ?? today) !== today) return null;
  const mg = caffeineMgOf(items);
  // Most logs carry no caffeine: skip the mission read for them.
  if (!(mg >= CAFFEINE_FLOOR_MG)) return null;
  return caffeineWarning({
    mg,
    priorMg: options.priorMg,
    logTime: when?.time ?? clockFromISO(now.toISOString()),
    rows: openTimedTrainingRows(db, today),
    ruleHours: rule.hours,
    dayStartMinutes: dayStartMinutes(),
  });
}
