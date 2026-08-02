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
 * fractional role weight), when, how hard. `whenIso` is a real instant: the
 * workout's created_at when that instant falls on the day the session was
 * performed (the live-logged case), else local noon of `workouts.date` (a
 * backdated entry, whose created_at is the insertion time, not the training
 * time). `weightKg`/`reps`/`rpe` may be null for bodyweight/timed work.
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

/** Per-muscle freshness for the ledger. */
export type MuscleFreshness = {
  muscle: Muscle;
  /** 0-100; 100 = fully recovered. */
  freshness: number;
  /** Display bucket derived from the score. */
  state: 'fresh' | 'recovering' | 'fatigued';
  /** Whole hours since this muscle was last worked, or null if never. */
  hoursSinceLast: number | null;
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
// programs / periodization (0020)
// ---------------------------------------------------------------------------

/** program_weeks.kind — a week that differs from plain accumulation. */
export type WeekKind = 'accumulation' | 'deload' | 'test';

/** ISO weekday, 1=Mon … 7=Sun (the program schedule's convention). */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** One `programs` row. */
export type ProgramRow = {
  id: string;
  name: string;
  notes: string | null;
  weeks: number;
  active_start: DateString | null;
  archived: 0 | 1;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** One `program_days` row (a weekday → routine in the repeating split). */
export type ProgramDayRow = {
  id: string;
  program_id: string;
  dow: number;
  routine_id: string;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** One `program_weeks` row (a non-accumulation week marker). */
export type ProgramWeekRow = {
  id: string;
  program_id: string;
  week: number;
  kind: WeekKind;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** One weekday of a program's split, joined to its routine name. */
export type ProgramDay = {
  dow: Weekday;
  routineId: string;
  routineName: string;
};

/** A program in the hub list. */
export type ProgramListItem = {
  id: string;
  name: string;
  weeks: number;
  trainingDays: number;
  /** True when this program is the one currently running. */
  active: boolean;
  /** 1-based current week of the running instance, or null when inactive/finished. */
  currentWeek: number | null;
};

/** A program plus its split + week kinds, for the builder. */
export type ProgramDetail = {
  id: string;
  name: string;
  notes: string | null;
  weeks: number;
  activeStart: DateString | null;
  days: ProgramDay[];
  /** kind per week 1..weeks (accumulation unless overridden). */
  weekKinds: WeekKind[];
};

/** One weekday assignment the builder saves. */
export type ProgramDayInput = { dow: Weekday; routineId: string };

/** Everything one program Save writes. */
export type ProgramInput = {
  name: string;
  notes: string | null;
  weeks: number;
  days: ProgramDayInput[];
  /** kind per week, length === weeks (index 0 = week 1). */
  weekKinds: WeekKind[];
};

/** What an active program has scheduled for a given day. */
export type ScheduledSession =
  | {
      kind: 'train';
      program: ProgramContext;
      routineId: string;
      routineName: string;
    }
  | {
      kind: 'rest';
      program: ProgramContext;
    };

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
