import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { listTodayMeals, todayTotals } from '@/lib/db/repositories/nutrition';
import type { DayTotals, MealRow } from '@/lib/nutrition/types';

export type NutritionDay = {
  meals: MealRow[];
  totals: DayTotals;
  /** Re-read today's meals + totals — call after an in-screen save. */
  reload: () => void;
};

function readToday(): { meals: MealRow[]; totals: DayTotals } {
  const db = getDb();
  const date = todayISODate();
  return { meals: listTodayMeals(db, date), totals: todayTotals(db, date) };
}

/**
 * The Nutrition screen's day view, backed by the on-device database.
 *
 * Same shape as use-log-feed: op-sqlite is synchronous, so the first read runs
 * in the `useState` initializer (no loading state), and `useFocusEffect`
 * re-reads whenever the screen regains focus — which also rolls the view over
 * to a new day if midnight passed while the app was backgrounded.
 */
export function useNutrition(): NutritionDay {
  const [state, setState] = useState(readToday);

  const reload = useCallback(() => {
    setState(readToday());
  }, []);

  useFocusEffect(reload);

  return { ...state, reload };
}
