import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import {
  activeNutritionTargets,
  dailyIntakeSeries,
  dayFiberTotal,
  listTodayMeals,
  mealItemCounts,
  todayTotals,
  type DayIntakePoint,
} from '@/lib/db/repositories/nutrition';
import { checkedGroceryCount, openGroceryLineCount } from '@/lib/db/repositories/grocery';
import { recipeCount, recipesCookedSince } from '@/lib/db/repositories/recipes';
import type { DayTotals, MealRow, NutritionTargetsRow } from '@/lib/nutrition/types';

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
  /** meal_id → item count, for the "· N items" meta on itemized meals. */
  itemCounts: Record<string, number>;
  /** The target set governing today, or null until targets are first set. */
  targets: NutritionTargetsRow | null;
  /** The standing objects' live state — the Kitchen rows. */
  kitchen: KitchenCounts;
  /** The 14-day read the tab leads its "Over time" section with. */
  overTime: OverTime;
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

/** `date` minus `days`, as a local YYYY-MM-DD. */
function isoDaysBefore(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  at.setDate(at.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
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

function readToday(): Omit<NutritionDay, 'reload'> {
  const db = getDb();
  const date = todayISODate();
  const series = dailyIntakeSeries(db, OVER_TIME_DAYS, date);
  const kcal = series.map((p: DayIntakePoint) => p.kcal);
  const protein = series.map((p: DayIntakePoint) => p.protein_g);
  return {
    meals: listTodayMeals(db, date),
    totals: todayTotals(db, date),
    fiberTotal: dayFiberTotal(db, date),
    itemCounts: mealItemCounts(db, date),
    targets: activeNutritionTargets(db, date) ?? null,
    kitchen: readKitchen(db, date),
    overTime: {
      kcal,
      protein,
      avgKcal: meanPositive(kcal),
      avgProtein: meanPositive(protein),
      daysRecorded: series.filter((p: DayIntakePoint) => p.kcal > 0).length,
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
