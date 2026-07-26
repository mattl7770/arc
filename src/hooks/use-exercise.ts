import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { listRecentSessions, weekSummary } from '@/lib/db/repositories/exercise';
import type { RecentSession, WeekSummary } from '@/lib/exercise/types';

export type ExerciseOverview = {
  week: WeekSummary;
  sessions: RecentSession[];
  /** Re-read the week strip and session list — call after an in-screen save. */
  reload: () => void;
};

const read = () => ({ week: weekSummary(getDb()), sessions: listRecentSessions(getDb()) });

/**
 * The Exercise screen's data, backed by the on-device database.
 *
 * op-sqlite is synchronous, so the first read runs in the `useState`
 * initializer (no loading state). `useFocusEffect` re-reads whenever the screen
 * regains focus — returning from the workout logger — which also rolls the week
 * strip over if the Monday boundary passed while the app was backgrounded.
 */
export function useExercise(): ExerciseOverview {
  const [state, setState] = useState(read);

  const reload = useCallback(() => {
    setState(read());
  }, []);

  useFocusEffect(reload);

  return { ...state, reload };
}
