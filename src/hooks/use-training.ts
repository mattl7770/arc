import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { listRecentSessions, weekSummary } from '@/lib/db/repositories/exercise';
import { getRoutine, listRoutines } from '@/lib/db/repositories/routines';
import { buildRecommendation } from '@/lib/db/repositories/training-recommend';
import type {
  MuscleFreshness,
  Recommendation,
  RecentSession,
  RoutineDetail,
  RoutineListItem,
  WeekSummary,
} from '@/lib/exercise/types';

export type TrainingHub = {
  week: WeekSummary;
  sessions: RecentSession[];
  routines: RoutineListItem[];
  ledger: MuscleFreshness[];
  recommendation: Recommendation;
  /** Re-read after a save/finish. */
  reload: () => void;
};

const read = () => {
  const db = getDb();
  const { ledger, recommendation } = buildRecommendation(db);
  return {
    week: weekSummary(db),
    sessions: listRecentSessions(db, 6),
    routines: listRoutines(db),
    ledger,
    recommendation,
  };
};

/**
 * The Exercise hub's data: this week's totals, recent sessions, routines, the
 * muscle-freshness ledger, and today's rule-based recommendation. Same pattern
 * as use-exercise / use-data-overview — op-sqlite is synchronous, so the first
 * read runs in the useState initializer (no loading state) and useFocusEffect
 * re-reads on focus (returning from the logger or the routine builder, and the
 * freshness decay/Monday rollover after backgrounding).
 */
export function useTrainingHub(): TrainingHub {
  const [state, setState] = useState(read);
  const reload = useCallback(() => setState(read()), []);
  useFocusEffect(reload);
  return { ...state, reload };
}

/**
 * One routine for the builder. `id` undefined (create) or unknown → null. Mirror
 * of useProtocol: seeds the form from the first read; the focus refresh never
 * clobbers in-progress edits because the editor copies into local state once.
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
