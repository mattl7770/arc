/**
 * Which meal a newly logged food joins (owner, device round 3, item 58: *"smart
 * combine for food logs in the same meal"*). Decided: a food logged within
 * about 45 minutes of a meal already logged that day goes INTO that meal, the
 * receipt says where it went, and Undo splits it back out
 * (docs/nutrition-subapp.md §21).
 *
 * Pure and DB-free, like `combine.ts`, whose plan the join then runs: this file
 * only picks the meal. The write is `combineMeals` and the Undo is
 * `uncombineMeals` — the round-8 mechanism, not a second one
 * (src/lib/nutrition/undo-offers.ts, `joinNearbyMealWithUndo`).
 *
 * ## The rules
 *
 * - **Within 45 minutes, inclusive**, either side of the new meal's time. "About
 *   45 minutes" needs one number; 45 is the number he gave. A meal timed later
 *   than the food counts too: a lunch he logged at 13:00 is the same lunch as
 *   a drink logged at 12:30 — and it stays the 13:00 Lunch, with its id and
 *   its rating: the join keeps the EXISTING meal (`keepId`), never the food's.
 * - **The same logical day.** A meal belongs to one day (`combine.ts` refuses
 *   two), and the day starts at his `dayStartsAt` (src/lib/db/date.ts), not at
 *   midnight. So the gap is measured in minutes since the day began: with the
 *   day starting at 04:00, 23:50 and 00:20 are thirty minutes apart on one day,
 *   while 03:50 and 04:10 are on two days and never join.
 * - **The nearest one.** Two candidates: the closer. A tie: the earlier, in the
 *   day list's own order (`mealListOrder`) — the meal a manual combine of the
 *   two would keep, so the two paths agree on which one it is.
 * - **Never an untimed meal** (nothing to measure) and **never one waiting on
 *   its estimate** (0057 — the plan refuses it, so offering it would only
 *   produce a refusal).
 */
import { dayStartMinutes } from '@/lib/db/date';

import { type CombinableMeal, mealListOrder } from './combine';

/** The window, in minutes, either side. Inclusive: 45 joins, 46 does not. */
export const AUTO_JOIN_MINUTES = 45;

/** `"HH:MM"` → minutes since the logical day began, or null for junk. */
export function minutesIntoDay(time: string, dayStartsAt?: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const start = dayStartMinutes(dayStartsAt);
  return (hours * 60 + minutes - start + 24 * 60) % (24 * 60);
}

/**
 * The meal `logged` should join, or null when none is near enough.
 *
 * `meals` is the day list (it may include `logged` itself, which is skipped).
 * `pending` holds the ids of meals still waiting on a queued estimate.
 */
export function mealToJoin<M extends CombinableMeal>(
  meals: readonly M[],
  logged: CombinableMeal,
  options: { pending?: ReadonlySet<string>; dayStartsAt?: string } = {}
): M | null {
  if (logged.time === null) return null;
  const at = minutesIntoDay(logged.time, options.dayStartsAt);
  if (at === null) return null;
  let best: { meal: M; gap: number } | null = null;
  for (const meal of meals) {
    if (meal.id === logged.id || meal.date !== logged.date || meal.time === null) continue;
    if (options.pending?.has(meal.id)) continue;
    const when = minutesIntoDay(meal.time, options.dayStartsAt);
    if (when === null) continue;
    const gap = Math.abs(when - at);
    if (gap > AUTO_JOIN_MINUTES) continue;
    if (
      best === null ||
      gap < best.gap ||
      (gap === best.gap && mealListOrder(meal, best.meal) < 0)
    ) {
      best = { meal, gap };
    }
  }
  return best?.meal ?? null;
}
