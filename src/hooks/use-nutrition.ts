import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { shiftISODate, todayISODate } from '@/lib/db/date';
import {
  activeNutritionTargets,
  dailyIntakeSeries,
  dayFiberRecorded,
  dayFiberTotal,
  dayMicroTotals,
  firstMealDate,
  listTodayMeals,
  mealItemCounts,
  partialMealMetrics,
  todayTotals,
  type DayIntakePoint,
} from '@/lib/db/repositories/nutrition';
import { isTimezoneChangedDay } from '@/lib/db/repositories/day-meta';
import { checkedGroceryCount, openGroceryLineCount } from '@/lib/db/repositories/grocery';
import { pendingEstimateMealIds } from '@/lib/db/repositories/pending-estimates';
import { recipeCount, recipesCookedSince } from '@/lib/db/repositories/recipes';
import { getGoalDirection } from '@/lib/db/repositories/user';
import { countTotalsOnlyMeals } from '@/lib/nutrition/key-micro';
import type { Micros } from '@/lib/nutrition/micros';
import type { PartialMealMetrics } from '@/lib/nutrition/remaining';
import type { DayTotals, MealRow, NutritionTargetsRow } from '@/lib/nutrition/types';
import type { GoalDirection } from '@/lib/user/types';

/** The window the Eat tab's "Over time" section reads. Matches the History
 *  screen's default so the tab and the screen it opens agree on sight. */
export const OVER_TIME_DAYS = 14;

export type KitchenCounts = {
  recipes: number;
  /** Meals cooked from the book in the last 30 days — derived from meals.recipe_id. */
  cookedRecently: number;
  /** LINES the grocery screen will draw, not raw rows (see openGroceryLineCount). */
  groceryOpen: number;
  groceryInCart: number;
};

export type OverTime = {
  /** Oldest → newest, zero-filled; the sparkline's own series. */
  kcal: number[];
  protein: number[];
  /** Means over the days that actually recorded the metric, or null. */
  avgKcal: number | null;
  avgProtein: number | null;
  /** Days with any intake recorded, out of OVER_TIME_DAYS. */
  daysRecorded: number;
};

export type NutritionDay = {
  meals: MealRow[];
  totals: DayTotals;
  /** Day fiber summed from meal items (manual meals never record it). */
  fiberTotal: number;
  /**
   * The owner's three, for the row under the macro bars (2026-09-23): the
   * day's micro totals (sodium and caffeine are read off them), fiber as NULL
   * when no item recorded any, and how many meals were logged as totals only —
   * which add none of the three. See src/lib/nutrition/key-micro.ts.
   */
  keyMicros: { micros: Micros; fiberEaten: number | null; totalsOnlyMeals: number };
  /** The target set governing today, or null until targets are first set. */
  targets: NutritionTargetsRow | null;
  /** The meals whose numbers are owed by a QUEUED AI estimate (0057) — logged
   *  offline, waiting on a connection. The row says so instead of wearing the
   *  "Nothing recorded — tap to fill it in" line, which would be advice the
   *  user cannot act on. Empty on every ordinary day. */
  pendingEstimates: Set<string>;
  /** meal_id → metrics that meal is knowingly SHORT on (an item was never
   *  priced). The countdown refuses these the way it refuses a NULL. */
  partialMeals: PartialMealMetrics;
  /** The standing objects' live state — the Kitchen rows. */
  kitchen: KitchenCounts;
  /** The 14-day read the tab leads its "Over time" section with. */
  overTime: OverTime;
  /** `users.preferences.goals.direction`. The Today-grid bars are graded in the
   *  direction the user is actually going, through the same band table the Home
   *  pillar uses — over target is a good day while gaining (FB2). */
  direction: GoalDirection;
  /** D4 — today was not 24 hours long, so no bar may grade against a 24-hour
   *  target. The Home pillar withholds its verdict on such a day and these bars
   *  withhold theirs with it. */
  timezoneChanged: boolean;
  /** Re-read today's meals + totals — call after an in-screen save. */
  reload: () => void;
};

/** Mean over the days that actually recorded the metric — a day with no meals
 *  stores 0 and must not drag the average down. Null when nothing qualifies:
 *  no data, no number. Mirrors nutrition-history.tsx's `meanPositive`. */
function meanPositive(values: number[]): number | null {
  const present = values.filter((v) => v > 0);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

/** `date` minus `days`, as a local YYYY-MM-DD (src/lib/db/date.ts). */
function isoDaysBefore(date: string, days: number): string {
  return shiftISODate(date, -days);
}

const EMPTY_KITCHEN: KitchenCounts = {
  recipes: 0,
  cookedRecently: 0,
  groceryOpen: 0,
  groceryInCart: 0,
};

/**
 * The recipe/grocery counts, guarded.
 *
 * These are the ONLY reads on this screen that touch tables introduced after
 * the app shipped (0031/0032). They run synchronously inside the Eat TAB ROOT's
 * first render, so a database that somehow has not reached those versions would
 * throw where there is no screen above to catch it — taking the tab, not a
 * sub-screen. Degrading to zeroes costs one authored empty line and cannot
 * crash the tab.
 */
function readKitchen(db: ReturnType<typeof getDb>, today: string): KitchenCounts {
  try {
    return {
      recipes: recipeCount(db),
      cookedRecently: recipesCookedSince(db, isoDaysBefore(today, 30)),
      groceryOpen: openGroceryLineCount(db),
      groceryInCart: checkedGroceryCount(db),
    };
  } catch (error) {
    console.warn('[nutrition] kitchen counts unavailable', error);
    return EMPTY_KITCHEN;
  }
}

/**
 * Which of today's meals are waiting on a queued estimate (0057).
 *
 * Guarded for the same reason readKitchen is: this runs synchronously in the
 * Eat TAB ROOT's first render, and a database that has not reached 0057 would
 * throw where there is no screen above to catch it. An empty set costs the
 * placeholder its one authored line; a throw costs the tab.
 */
function readPendingEstimates(db: ReturnType<typeof getDb>, today: string): Set<string> {
  try {
    return pendingEstimateMealIds(db, today);
  } catch (error) {
    console.warn('[nutrition] pending estimates unavailable', error);
    return new Set();
  }
}

function readToday(): Omit<NutritionDay, 'reload'> {
  const db = getDb();
  const date = todayISODate();
  const series = dailyIntakeSeries(db, OVER_TIME_DAYS, date);
  const kcal = series.map((p: DayIntakePoint) => p.kcal);
  const protein = series.map((p: DayIntakePoint) => p.protein_g);
  const meals = listTodayMeals(db, date);
  return {
    meals,
    totals: todayTotals(db, date),
    fiberTotal: dayFiberTotal(db, date),
    keyMicros: {
      micros: dayMicroTotals(db, date),
      fiberEaten: dayFiberRecorded(db, date),
      totalsOnlyMeals: countTotalsOnlyMeals(meals, mealItemCounts(db, date)),
    },
    targets: activeNutritionTargets(db, date) ?? null,
    partialMeals: partialMealMetrics(db, date),
    pendingEstimates: readPendingEstimates(db, date),
    // Two indexed reads the bars' grade needs, and nothing else uses. Both are
    // the same ones Home's nutrition pillar takes (src/lib/home/readiness.ts),
    // so the tab and the pillar are graded off identical inputs.
    direction: getGoalDirection(db),
    timezoneChanged: isTimezoneChangedDay(db, date),
    kitchen: readKitchen(db, date),
    overTime: {
      kcal,
      protein,
      avgKcal: meanPositive(kcal),
      avgProtein: meanPositive(protein),
      daysRecorded: series.filter((p: DayIntakePoint) => p.mealCount > 0).length,
    },
  };
}

/**
 * The Eat tab's whole day view, backed by the on-device database.
 *
 * Same shape as use-log-feed: op-sqlite is synchronous, so the first read runs
 * in the `useState` initializer (no loading state), and `useFocusEffect`
 * re-reads whenever the screen regains focus — returning from food search /
 * meal detail / the targets editor after a write, coming back from the recipe
 * book or the grocery list, or rolling over to a new day if midnight passed
 * while the app was backgrounded.
 *
 * The refresh also matters across TABS: the Coach's add_grocery_items,
 * complete_grocery_items, log_recipe and save_recipe tools all mutate what the
 * Kitchen rows count, from a different tab, while this screen stays mounted.
 *
 * Cost per focus is one grouped series query plus the day reads and four
 * counts — all indexed, all synchronous, none of them a scan of `recipes`.
 */
export function useNutrition(): NutritionDay {
  const [state, setState] = useState(readToday);

  const reload = useCallback(() => {
    setState(readToday());
  }, []);

  useFocusEffect(reload);

  return { ...state, reload };
}

// --- One PAST day, for the history screen's day view (C1) --------------------

/** One day's food log — the subset of {@link NutritionDay} that is about a day
 *  rather than about the kitchen or the fortnight. */
export type NutritionDayView = {
  /** The day this describes, `YYYY-MM-DD`. Echoed back so a render can never
   *  draw one day's meals under another day's heading. */
  date: string;
  meals: MealRow[];
  itemCounts: Record<string, number>;
  /** The targets that governed THAT day — not today's. */
  targets: NutritionTargetsRow | null;
  partialMeals: PartialMealMetrics;
  /** The first day ever logged, or null — the day picker's back bound. */
  recordStart: string | null;
};

/**
 * Read one day, whichever day it is.
 *
 * Every read is already keyed by `date` (the repository has taken one since the
 * day view shipped), so browsing the past costs the same four indexed queries
 * today costs. The one thing this does NOT reuse from {@link useNutrition} is
 * the Kitchen counts and the 14-day series: neither is about a day, and a
 * picker that re-ran them on every arrow tap would be paying for a section it
 * is not moving.
 *
 * **`activeNutritionTargets(db, date)` is the point of the whole hook.** Targets
 * are versioned (0015), so a Tuesday two weeks ago is judged against the targets
 * that governed it — not against the ones set since. A history screen that
 * applied today's targets to an old day would silently re-judge a closed day,
 * which is the same mistake the day boundary refuses to make when it re-attributes
 * nothing (src/lib/db/date.ts).
 */
export function readNutritionDay(date: string): NutritionDayView {
  const db = getDb();
  return {
    date,
    meals: listTodayMeals(db, date),
    itemCounts: mealItemCounts(db, date),
    targets: activeNutritionTargets(db, date) ?? null,
    partialMeals: partialMealMetrics(db, date),
    recordStart: firstMealDate(db),
  };
}
