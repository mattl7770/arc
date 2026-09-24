import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { listRecentSessions, weekSummary } from '@/lib/db/repositories/exercise';
import { getRoutine, listRoutines } from '@/lib/db/repositories/routines';
import { buildRecommendation } from '@/lib/db/repositories/training-recommend';
import { readWorkoutDraft } from '@/lib/db/repositories/workout-drafts';
import {
  pendingIngestedStrength,
  type IngestedWorkout,
} from '@/lib/db/repositories/workout-ingest';
import {
  parseLiveDraft,
  parseManualDraft,
  type LiveDraft,
  type ManualDraft,
} from '@/lib/exercise/draft';
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
  /**
   * Strength-coded sessions Apple Health recorded that ARC has no log for
   * (0054) — the blanks the owner is asked to fill. Empty on any device with no
   * watch, and on every device where the sessions are already paired.
   */
  blanks: IngestedWorkout[];
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
    blanks: pendingIngestedStrength(db),
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

export type WorkoutDrafts = {
  /** An unfinished structured session (app/workout-live.tsx), or null. */
  live: LiveDraft | null;
  /** An unfinished free-form session (app/workout-log.tsx), or null. */
  manual: ManualDraft | null;
  /** When either was last written — the "in progress since" the card shows. */
  updatedAt: string | null;
  /** Re-read after resuming, finishing or discarding. */
  reload: () => void;
};

const readDrafts = (): Omit<WorkoutDrafts, 'reload'> => {
  const db = getDb();
  const liveRow = readWorkoutDraft(db, 'live');
  const manualRow = readWorkoutDraft(db, 'manual');
  const live = liveRow ? parseLiveDraft(liveRow.value) : null;
  const manual = manualRow ? parseManualDraft(manualRow.value) : null;
  // Any live draft that parses is a session to come back to, typed into or not
  // (`liveSessionOpen`, 2026-09-23: leaving the logger keeps a session from its
  // first exercise). `parseLiveDraft` is the same gate the logger's Resume
  // reads through, so the card and the screen cannot disagree.
  const resumableLive = live;
  const stamps = [
    resumableLive ? liveRow?.updatedAt : null,
    manual ? manualRow?.updatedAt : null,
  ].filter((s): s is string => typeof s === 'string');
  return {
    live: resumableLive,
    manual,
    // ISO-8601 text sorts chronologically, so the newest is just the max.
    updatedAt: stamps.length > 0 ? stamps.reduce((a, b) => (a > b ? a : b)) : null,
  };
};

/**
 * The unfinished sessions waiting to be resumed (`workout_drafts`, 0045) — what
 * the hub's **Session in progress** card is drawn from.
 *
 * Read on focus like every other hub read, which is exactly when it matters:
 * coming back to the app after iOS killed it mid-workout lands on this screen,
 * and the card has to be there on the first frame. Empty-safe; a device that
 * has never abandoned a session reads two nulls.
 */
export function useWorkoutDrafts(): WorkoutDrafts {
  const [state, setState] = useState(readDrafts);
  const reload = useCallback(() => setState(readDrafts()), []);
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
