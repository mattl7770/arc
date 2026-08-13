/**
 * Types for the Exercise slice — row shapes mirroring the migrations plus the
 * view-models the screens and the rule-based engine consume.
 *
 * These live here (not in src/lib/db/types.ts) by the parallel-work convention:
 * feature slices keep their own types and the integrator reconciles the shared
 * type file afterwards. Keep the `Row` types in lockstep with the migrations
 * (0003 workouts/workout_sets, 0011 exercises/exercise_muscles, 0012 routines/
 * routine_exercises, 0013 the workout_sets/workouts enrichment).
 */
import type { DateString, Timestamp } from '@/lib/db/types';

// ---------------------------------------------------------------------------
// workouts / workout_sets (0003, enriched by 0013)
// ---------------------------------------------------------------------------

/** workouts.kind — text + CHECK in the schema. */
export type WorkoutKind = 'strength' | 'cardio' | 'mobility' | 'other';

/** workout_sets.set_type — warmup/failure/drop feed stats differently (0013). */
export type SetType = 'normal' | 'warmup' | 'failure' | 'drop';

/** One `workouts` row, as a SELECT returns it (routine_id added in 0013). */
export type WorkoutRow = {
  id: string;
  date: DateString;
  name: string;
  kind: WorkoutKind;
  duration_min: number | null;
  notes: string | null;
  routine_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** One `workout_sets` row, as a SELECT returns it (0013 columns included). */
export type WorkoutSetRow = {
  id: string;
  workout_id: string;
  exercise: string;
  set_index: number | null;
  reps: number | null;
  weight_kg: number | null;
  exercise_id: string | null;
  set_type: SetType;
  rpe: number | null;
  duration_sec: number | null;
  superset_group: number | null;
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
  /** Set when the session was started from a routine (0013). */
  routineId?: string | null;
};

/**
 * One set to persist under a workout (weight already converted to kg). The
 * fields beyond exercise/reps/weightKg are additive (0013) and optional, so
 * every existing caller of logWorkout/addSet stays source-compatible.
 */
export type SetInput = {
  exercise: string;
  reps?: number | null;
  weightKg?: number | null;
  exerciseId?: string | null;
  setType?: SetType;
  rpe?: number | null;
  durationSec?: number | null;
  supersetGroup?: number | null;
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

// ---------------------------------------------------------------------------
// exercise catalog (0011)
// ---------------------------------------------------------------------------

export type Equipment =
  | 'barbell'
  | 'dumbbell'
  | 'kettlebell'
  | 'cable'
  | 'machine'
  | 'smith'
  | 'bodyweight'
  | 'band'
  | 'ez_bar'
  | 'trap_bar'
  | 'plate'
  | 'medicine_ball'
  | 'suspension'
  | 'bench'
  | 'pullup_bar'
  | 'other';

export type MovementPattern =
  | 'squat'
  | 'hinge'
  | 'lunge'
  | 'push_h'
  | 'push_v'
  | 'pull_h'
  | 'pull_v'
  | 'carry'
  | 'rotation'
  | 'core'
  | 'locomotion';

export type Mechanic = 'compound' | 'isolation';

/** How a set of this movement is logged — drives which fields the row shows. */
export type LoggingType =
  | 'weight_reps'
  | 'bodyweight_reps'
  | 'weighted_bodyweight'
  | 'assisted_bodyweight'
  | 'duration'
  | 'weight_duration'
  | 'distance_duration';

export type Muscle =
  | 'chest'
  | 'front_delts'
  | 'side_delts'
  | 'rear_delts'
  | 'lats'
  | 'upper_back'
  | 'lower_back'
  | 'traps'
  | 'biceps'
  | 'triceps'
  | 'forearms'
  | 'quads'
  | 'hamstrings'
  | 'glutes'
  | 'calves'
  | 'abs';

export type MuscleRole = 'primary' | 'secondary';

/** One `exercises` row, as a SELECT returns it. */
export type ExerciseRow = {
  id: string;
  name: string;
  aliases: string | null;
  equipment: Equipment;
  movement_pattern: MovementPattern | null;
  mechanic: Mechanic | null;
  logging_type: LoggingType;
  unilateral: 0 | 1;
  instructions: string | null;
  is_custom: 0 | 1;
  archived: 0 | 1;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** One `exercise_muscles` row. */
export type ExerciseMuscleRow = {
  id: string;
  exercise_id: string;
  muscle: Muscle;
  role: MuscleRole;
  created_at: Timestamp;
};

/** One muscle worked by an exercise, in view form. */
export type MuscleInvolvement = { muscle: Muscle; role: MuscleRole };

/** A catalog exercise for pickers/detail: the row, decoded, with its muscles. */
export type CatalogExercise = {
  id: string;
  name: string;
  aliases: string[];
  equipment: Equipment;
  movementPattern: MovementPattern | null;
  mechanic: Mechanic | null;
  loggingType: LoggingType;
  unilateral: boolean;
  isCustom: boolean;
  primaryMuscles: Muscle[];
  secondaryMuscles: Muscle[];
};

/** Fields for creating a custom exercise (the picker's "New exercise" form). */
export type NewExercise = {
  name: string;
  equipment: Equipment;
  loggingType: LoggingType;
  movementPattern?: MovementPattern | null;
  mechanic?: Mechanic | null;
  unilateral?: boolean;
  primaryMuscles: Muscle[];
  secondaryMuscles?: Muscle[];
  /** Short how-to steps (AI search writes these; the manual form leaves them off). */
  instructions?: string[];
};

/** Filters the catalog picker can apply (all optional / AND-combined). */
export type CatalogFilter = {
  search?: string;
  muscle?: Muscle;
  equipment?: Equipment;
};

// ---------------------------------------------------------------------------
// routines (0012)
// ---------------------------------------------------------------------------

/** One `routines` row. */
export type RoutineRow = {
  id: string;
  name: string;
  notes: string | null;
  archived: 0 | 1;
  last_started_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** One `routine_exercises` row. */
export type RoutineExerciseRow = {
  id: string;
  routine_id: string;
  exercise_id: string;
  position: number;
  target_sets: number;
  rep_low: number | null;
  rep_high: number | null;
  rest_sec: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** A routine in the hub list: identity + a compact exercise summary. */
export type RoutineListItem = {
  id: string;
  name: string;
  exerciseCount: number;
  totalSets: number;
  lastStartedAt: Timestamp | null;
};

/** One line of a routine, joined to its exercise, for the builder/detail. */
export type RoutineExerciseDetail = {
  id: string;
  exerciseId: string;
  exerciseName: string;
  position: number;
  targetSets: number;
  repLow: number | null;
  repHigh: number | null;
  restSec: number | null;
  primaryMuscles: Muscle[];
};

/** A routine plus its ordered exercises, for the builder + logger prefill. */
export type RoutineDetail = {
  id: string;
  name: string;
  notes: string | null;
  archived: boolean;
  exercises: RoutineExerciseDetail[];
};

/** One exercise line as the builder saves it (position is the array order). */
export type RoutineExerciseInput = {
  exerciseId: string;
  targetSets: number;
  repLow: number | null;
  repHigh: number | null;
  restSec: number | null;
};

/** Everything one routine Save writes. */
export type RoutineInput = {
  name: string;
  notes: string | null;
  exercises: RoutineExerciseInput[];
};

// ---------------------------------------------------------------------------
// engine view-models (src/lib/exercise/{e1rm,freshness,progression,recommend})
// ---------------------------------------------------------------------------

/**
 * One completed set reduced to what the engine needs: which muscles (with
 * fractional role weight), when, how hard. `whenIso` is the workout's created_at
 * (a real instant), `weightKg`/`reps`/`rpe` may be null for bodyweight/timed work.
 */
export type EngineSet = {
  exerciseId: string | null;
  weightKg: number | null;
  reps: number | null;
  rpe: number | null;
  setType: SetType;
  whenIso: Timestamp;
};

/** A set carrying the muscle it hit + its fractional weight, for freshness. */
export type MuscleLoad = {
  muscle: Muscle;
  roleWeight: number;
  reps: number | null;
  rpe: number | null;
  weightKg: number | null;
  setType: SetType;
  whenIso: Timestamp;
};

/**
 * A hand-set freshness assertion (migration 0036): "as of `anchoredAt`, this
 * muscle was `freshness` percent recovered". Not a value that persists — an
 * anchor the recovery model proceeds from. See the migration for why the
 * obvious flat override rots and this does not.
 */
export type FreshnessAnchor = {
  muscle: Muscle;
  /** 0-100, as asserted. */
  freshness: number;
  /** The instant the assertion is about (ISO-8601, SQLite-stamped). */
  anchoredAt: Timestamp;
};

/** Per-muscle freshness for the ledger. */
export type MuscleFreshness = {
  muscle: Muscle;
  /** 0-100; 100 = fully recovered. */
  freshness: number;
  /** Display bucket derived from the score. */
  state: 'fresh' | 'recovering' | 'fatigued';
  /** Whole hours since this muscle was last worked, or null if never. */
  hoursSinceLast: number | null;
  /**
   * Set when a hand-set anchor is part of THIS reading — the flag that keeps an
   * asserted number and a derived one from wearing the same face (the rule
   * `resolved_by` applies to recipe lines, 0034). Null once the anchor ages out
   * of the lookback window, because at that point it is no longer what the
   * reading rests on.
   */
  anchoredAt: Timestamp | null;
};

/** A per-exercise estimated 1RM data point (for the detail sparkline). */
export type E1rmPoint = { date: DateString; e1rm: number };

/** Personal records for one exercise, all in canonical kg. */
export type PersonalRecords = {
  /** Heaviest single working set's load. */
  maxWeightKg: number | null;
  /** Best estimated 1RM across working sets. */
  bestE1rmKg: number | null;
  /** Best single-set volume (weight × reps). */
  bestSetVolumeKg: number | null;
};

/** The progression suggestion for one exercise next session. */
export type ProgressionSuggestion = {
  kind: 'progress' | 'hold' | 'deload' | 'find_weight';
  /** Suggested working weight in kg, or null when there's no basis yet. */
  targetWeightKg: number | null;
  /** Suggested rep target (top of range on progress). */
  targetReps: number | null;
  /** One-line human rationale. */
  note: string;
};

/** One exercise inside a recommended session. */
export type RecommendedExercise = {
  exerciseId: string;
  name: string;
  primaryMuscles: Muscle[];
  /** Mean freshness of this exercise's primary muscles (0-100). */
  freshness: number;
  suggestion: ProgressionSuggestion;
  /**
   * Working sets planned for this exercise — the routine line's target, or
   * null for a fallback pick with no routine behind it. Carries the volume
   * dial's effect when one is applied (see {@link RecommendInput.volumeScale}).
   */
  targetSets?: number | null;
};

/** When the recommendation comes from an active program, the week context. */
export type ProgramContext = {
  programId: string;
  programName: string;
  /** 1-based current week and the program's total length. */
  week: number;
  weeks: number;
  weekKind: WeekKind;
};

/** The "Train today" recommendation. */
export type Recommendation =
  | {
      kind: 'routine';
      routineId: string;
      routineName: string;
      /** 0-100 set-weighted freshness of the routine's primary muscles. */
      freshness: number;
      /** True when freshness is low — shown as a caution, never hidden. */
      caution: boolean;
      exercises: RecommendedExercise[];
      why: string;
      /** Present when this session is the one an active program scheduled today. */
      program?: ProgramContext;
    }
  | {
      kind: 'muscles';
      /** The freshest muscle groups to train, with suggested movements. */
      muscles: Muscle[];
      exercises: RecommendedExercise[];
      why: string;
    }
  | {
      /** An active program scheduled a rest day today (or a whole deload/rest week). */
      kind: 'rest';
      why: string;
      program?: ProgramContext;
    }
  | {
      kind: 'empty';
      why: string;
    };

// ---------------------------------------------------------------------------
// periodization vestige (0020)
//
// Programs were retired 2026-08-11 (owner call: one flat list of saved
// workouts beats the routines/programs pair). The 0020 tables stay in the
// schema, dormant; the repo/screens/tests are deleted. What survives here is
// exactly what the Recommendation union still names — ProgramContext and its
// WeekKind — because the Coach's get_training_recommendation tool renders
// `'program' in recommendation` and the type arms stay for it, even though
// nothing produces them today.
// ---------------------------------------------------------------------------

/** A week that differs from plain accumulation (kept for ProgramContext). */
export type WeekKind = 'accumulation' | 'deload' | 'test';

// ---------------------------------------------------------------------------
// weekly volume vs landmarks (engine: volume.ts)
// ---------------------------------------------------------------------------

/** Where a muscle's weekly volume sits against its landmarks. */
export type VolumeStatus = 'under' | 'optimal' | 'approaching' | 'over';

/** One muscle's weekly volume verdict. */
export type MuscleVolume = {
  muscle: Muscle;
  /** Fractional weekly sets (primary 1.0, secondary 0.5). */
  sets: number;
  mev: number;
  mav: number;
  mrv: number;
  status: VolumeStatus;
  /** Short add/hold/cut guidance. */
  guidance: string;
};
