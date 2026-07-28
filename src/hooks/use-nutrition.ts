import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import {
  activeNutritionTargets,
  dayFiberTotal,
  listTodayMeals,
  mealItemCounts,
  todayTotals,
} from '@/lib/db/repositories/nutrition';
import type { DayTotals, MealRow, NutritionTargetsRow } from '@/lib/nutrition/types';

export type NutritionDay = {
  meals: MealRow[];
  totals: DayTotals;
  /** Day fiber summed from meal items (manual meals never record it). */
  fiberTotal: number;
  /** meal_id → item count, for the "· N items" meta on itemized meals. */
  itemCounts: Record<string, number>;
  /** The target set governing today, or null until targets are first set. */
  targets: NutritionTargetsRow | null;
  /** Re-read today's meals + totals — call after an in-screen save. */
  reload: () => void;
};

function readToday(): Omit<NutritionDay, 'reload'> {
  const db = getDb();
  const date = todayISODate();
  return {
    meals: listTodayMeals(db, date),
    totals: todayTotals(db, date),
    fiberTotal: dayFiberTotal(db, date),
    itemCounts: mealItemCounts(db, date),
    targets: activeNutritionTargets(db, date) ?? null,
  };
}

/**
 * The Nutrition screen's day view, backed by the on-device database.
 *
 * Same shape as use-log-feed: op-sqlite is synchronous, so the first read runs
 * in the `useState` initializer (no loading state), and `useFocusEffect`
 * re-reads whenever the screen regains focus — returning from food search /
 * meal detail / the targets editor after a write, or rolling over to a new day
 * if midnight passed while the app was backgrounded.
 */
export function useNutrition(): NutritionDay {
  const [state, setState] = useState(readToday);

  const reload = useCallback(() => {
    setState(readToday());
  }, []);

  useFocusEffect(reload);

  return { ...state, reload };
}
