import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { listRecentSessions, weekSummary } from '@/lib/db/repositories/exercise';
import { getRoutine, listRoutines } from '@/lib/db/repositories/routines';
import { buildRecommendation } from '@/lib/db/repositories/training-recommend';
import type {
  MuscleFreshness,
  MuscleVolume,
  Recommendation,
  RecentSession,
  RoutineDetail,
  RoutineListItem,
  WeekSummary,
} from '@/lib/exercise/types';

export type TrainingHub = {
  week: WeekSummary;
  sessions: RecentSession[];
  /** The saved workouts (the `routines` tables carry them — UI renamed 2026-08-11). */
  routines: RoutineListItem[];
  ledger: MuscleFreshness[];
  volume: MuscleVolume[];
  recommendation: Recommendation;
  /** Re-read after a save/finish. */
  reload: () => void;
};

const read = () => {
  const db = getDb();
  const { ledger, volume, recommendation } = buildRecommendation(db);
  return {
    week: weekSummary(db),
    sessions: listRecentSessions(db, 6),
    routines: listRoutines(db),
    ledger,
    volume,
    recommendation,
  };
};

/**
 * The Exercise hub's data: this week's totals, recent sessions, routines,
 * programs, the muscle-freshness + weekly-volume ledgers, and today's
 * rule-based recommendation (program-aware). Same pattern as use-exercise /
 * use-data-overview — op-sqlite is synchronous, so the first read runs in the
 * useState initializer (no loading state) and useFocusEffect re-reads on focus
 * (returning from the logger/builder, and the freshness decay / Monday /
 * program-week rollover after backgrounding).
 */
export function useTrainingHub(): TrainingHub {
  const [state, setState] = useState(read);
  const reload = useCallback(() => setState(read()), []);
  useFocusEffect(reload);
  return { ...state, reload };
}

/**
 * One saved workout for the builder. `id` undefined (create) or unknown → null.
 * Mirror of useProtocol: seeds the form from the first read; the focus refresh
 * never clobbers in-progress edits because the editor copies into local state
 * once.
 */
export function useRoutine(id: string | undefined): RoutineDetail | null {
  const [detail, setDetail] = useState<RoutineDetail | null>(() =>
    id ? (getRoutine(getDb(), id) ?? null) : null
  );
  const reload = useCallback(() => {
    setDetail(id ? (getRoutine(getDb(), id) ?? null) : null);
  }, [id]);
  useFocusEffect(reload);
  return detail;
}
