/**
 * Types for the Exercise slice — row shapes mirroring db/migrations/
 * 0003_exercise.sql plus the view-models the screen consumes.
 *
 * These live here (not in src/lib/db/types.ts) by the parallel-work convention:
 * three slices are being built at once, and the integrator reconciles the
 * shared type file afterwards. Keep the `Row` types in lockstep with the
 * migration, same as db/types.ts does for 0001.
 */
import type { DateString, Timestamp } from '@/lib/db/types';

/** workouts.kind — text + CHECK in the schema. */
export type WorkoutKind = 'strength' | 'cardio' | 'mobility' | 'other';

/** One `workouts` row, as a SELECT returns it. */
export type WorkoutRow = {
  id: string;
  date: DateString;
  name: string;
  kind: WorkoutKind;
  duration_min: number | null;
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** One `workout_sets` row, as a SELECT returns it. */
export type WorkoutSetRow = {
  id: string;
  workout_id: string;
  exercise: string;
  set_index: number | null;
  reps: number | null;
  weight_kg: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** Input for logging one session. Weight on sets is CANONICAL kg. */
export type LogWorkoutInput = {
  date: DateString;
  name: string;
  kind: WorkoutKind;
  durationMin?: number | null;
  notes?: string | null;
};

/** One set to persist under a workout (weight already converted to kg). */
export type SetInput = {
  exercise: string;
  reps?: number | null;
  weightKg?: number | null;
};

/** One row of the "Recent sessions" list — a workout plus its set count. */
export type RecentSession = {
  id: string;
  date: DateString;
  name: string;
  kind: WorkoutKind;
  durationMin: number | null;
  setCount: number;
  createdAt: Timestamp;
};

/** "This week" aggregates for the Exercise screen's stat strip. */
export type WeekSummary = {
  /**
   * Cardio minutes this Monday-start week. Until intensity tracking exists,
   * every cardio session counts toward Zone 2 — honest enough for a screen
   * whose cardio prescription *is* Zone 2.
   */
  zone2Min: number;
  /** Strength sessions this Monday-start week. */
  strengthSessions: number;
};
