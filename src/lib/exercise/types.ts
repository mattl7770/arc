/**
 * Types for the Exercise slice — row shapes mirroring the migrations plus the
 * view-models the screens and the rule-based engine consume.
 *
 * These live here (not in src/lib/db/types.ts) by the parallel-work convention:
 * feature slices keep their own types and the integrator reconciles the shared
 * type file afterwards. Keep the `Row` types in lockstep with the migrations
 * (0003 workouts/workout_sets, 0011 exercises/exercise_muscles, 0012 routines/
 * routine_exercises, 0013 the workout_sets/workouts enrichment, 0046
 * exercises.measures + workout_sets.distance_m).
 */
import type { LoadBasis } from './load-basis';
import type { Measures } from './measures';
import type { DateString, Timestamp, WearableDevice } from '@/lib/db/types';

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
  /**
   * When the session began (0054), or null when it has no knowable span — a
   * backdated log, a photo import, anything written before 0054. Only the live
   * logger writes it, and pairing with an ingested HealthKit session is the only
   * thing that reads it.
   */
  started_at: Timestamp | null;
  /**
   * Logged away from the usual gym (0055). 1 means the session's LOADS are not
   * comparable to the home baseline — it sets no record, steers no progression
   * and seeds no prefill — while the training itself still counts everywhere
   * that counts work rather than load. See the migration header.
   */
  away: 0 | 1;
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
  /** Canonical METRES (0046) — the km/mi toggle is a display concern. */
  distance_m: number | null;
  superset_group: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** Input for logging one session. Weight on sets is CANONICAL kg. */
export type LogWorkoutInput = {
  date: DateString;
  /**
   * Optional since 2026-08-14 — *"Workouts dont need names, remove this"*
   * (owner). Nothing in the app asks for one any more and nothing displays one.
   * `workouts.name` is still `text NOT NULL` in the schema, so the repository
   * writes `''` when no caller supplies a value; see {@link logWorkout} for why
   * the column was left dormant rather than rebuilt out of the table.
   */
  name?: string;
  kind: WorkoutKind;
  durationMin?: number | null;
  notes?: string | null;
  /** Set when the session was started from a routine (0013). */
  routineId?: string | null;
  /**
   * ISO instant the session began (0054). The live logger passes the instant it
   * really started; every other writer omits it, and omitted means "this session
   * has no knowable span", which is what keeps a backdated log from auto-pairing
   * with whatever the watch happened to record that day.
   */
  startedAt?: Timestamp | null;
  /**
   * Logged away from the usual gym (0055). Omitted means home, which is what
   * every caller but the live logger means: the Coach, the photo import and the
   * manual logger have no way to know, and guessing would be worse than the
   * truthful default.
   */
  away?: boolean;
};

/**
 * One set to persist under a workout (weight already converted to kg, distance
 * to metres). The fields beyond exercise/reps/weightKg are additive (0013,
 * 0046) and optional, so every existing caller of logWorkout/addSet stays
 * source-compatible.
 *
 * What lands is not always what is passed: `insertSet` nulls whatever the
 * exercise does not measure (0046 — "a set carries the fields its exercise
 * implies"), so reps handed in for a plank are dropped rather than stored.
 */
export type SetInput = {
  exercise: string;
  reps?: number | null;
  weightKg?: number | null;
  exerciseId?: string | null;
  setType?: SetType;
  rpe?: number | null;
  durationSec?: number | null;
  /** Canonical metres. */
  distanceM?: number | null;
  supersetGroup?: number | null;
};

/**
 * The ingested HealthKit session PAIRED to a manual one (0054), read through the
 * link rather than copied onto it.
 *
 * Every field here came from the watch, and the screens that print it say so by
 * name ("Garmin · 612 kcal · 8.4 km") — that is what makes it visibly
 * not-typed-by-you, the same rule `anchoredAt` applies to a hand-set freshness.
 * It is absent, never zeroed, when a session has no pair.
 */
export type PairedIngest = {
  /** `wearable_data.id` of the paired row. */
  wearableId: string;
  /** HealthKit's own activity label ("Running", "Strength training"). */
  activity: string | null;
  /** True duration in minutes as the watch measured it (pauses excluded). */
  durationMin: number;
  kcal: number | null;
  distanceKm: number | null;
  /**
   * Heart rate during the session, as HealthKit computed it (docs §15). Both or
   * neither: an average with no maximum is half a reading. Null when the watch
   * exported nothing ARC could use — an absence, never a zero.
   */
  avgHr: number | null;
  maxHr: number | null;
  /** The `source_device` bucket, for `deviceLabel`. */
  sourceDevice: WearableDevice;
  /**
   * HOW the two were matched — `'span'` from overlapping clocks, `'day'` from
   * the same day and a close duration (the 2026-09-21 rule, for the sessions
   * that carry no `started_at`), `'user'` by hand from the blank inbox.
   *
   * Derived at read time from what the link already stores; there is no column
   * for it. A `'day'` pair is the one worth SAYING on screen: it was made
   * without a clock, so it is the one the owner might want to break.
   */
  pairedBy: 'span' | 'day' | 'user';
};

/** One row of the "Recent sessions" list — a workout plus its set count. */
export type RecentSession = {
  id: string;
  date: DateString;
  /**
   * The stored `workouts.name`. Retained on the type because sessions logged
   * before 2026-08-14 (and any the Coach names) still carry one, but NOTHING
   * renders it — the list titles itself off {@link RecentSession.movements},
   * which is what a session actually was. See `sessionTitle` in
   * src/lib/exercise/format.ts.
   */
  name: string;
  kind: WorkoutKind;
  durationMin: number | null;
  setCount: number;
  /**
   * The distinct movements in the session, in the order they were performed —
   * the honest answer to "what was this workout", now that no one names them.
   * Empty for a session with no sets (cardio, mobility).
   */
  movements: string[];
  /**
   * Logged away from the usual gym (0055). The list SAYS so, because a session
   * whose numbers read low and does not say why is the confusion this feature
   * exists to remove.
   */
  away: boolean;
  createdAt: Timestamp;
  /** The watch's record of this same session (0054), when one is linked. */
  ingested?: PairedIngest;
};

/** One stored set, as the past-workout editor loads it back. */
export type StoredSet = {
  id: string;
  exercise: string;
  exerciseId: string | null;
  setIndex: number | null;
  reps: number | null;
  weightKg: number | null;
  rpe: number | null;
  setType: SetType;
  durationSec: number | null;
  /** Canonical metres (0046). */
  distanceM: number | null;
  supersetGroup: number | null;
};

/** A past session opened for viewing or editing: its row plus its sets, in order. */
export type WorkoutDetail = {
  id: string;
  date: DateString;
  kind: WorkoutKind;
  durationMin: number | null;
  notes: string | null;
  routineId: string | null;
  /** Logged away from the usual gym (0055) — editable after the fact. */
  away: boolean;
  createdAt: Timestamp;
  sets: StoredSet[];
  /** The watch's record of this same session (0054), when one is linked. */
  ingested?: PairedIngest;
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
  /**
   * What a set of this movement records (0046) — the authority the loggers,
   * the stats and the Coach's tools all read. `logging_type` stays because it
   * still separates bodyweight from weighted from assisted; `measures` is
   * derived from it on write (src/lib/exercise/measures.ts).
   */
  measures: Measures;
  unilateral: 0 | 1;
  instructions: string | null;
  is_custom: 0 | 1;
  /** Who authored this entry (0056). NULL on rows written before it existed. */
  source: ExerciseSource | null;
  /**
   * The OWNER's correction of what a weight figure counts (0062), or NULL for
   * ARC's own reading of the row (`deriveLoadBasis`). Never a stored copy of
   * the derivation — see the migration header.
   */
  load_basis: LoadBasis | null;
  archived: 0 | 1;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/**
 * Who wrote a catalog entry's facts (0056) — distinct from `is_custom`, which
 * only says whether the row shipped with the app.
 *
 * The distinction earns its keep because a row's muscles feed freshness, weekly
 * volume and the body figure: a movement the owner typed into the
 * three-field New-exercise form and one a model authored — aliases, secondary
 * muscles, pattern, mechanic and `measures` — are both custom, and are not
 * equally trustworthy. When a definition looks wrong two months from now, the
 * first question is who put it there. Same rule as `recipe_ingredients
 * .resolved_by` (0034).
 */
export type ExerciseSource = 'seed' | 'user' | 'ai';

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
  /** What a set of this movement records (0046). */
  measures: Measures;
  unilateral: boolean;
  isCustom: boolean;
  /** Who authored it (0056) — `'ai'` is the one the picker marks. */
  source: ExerciseSource | null;
  /**
   * What this movement's weight figure counts (0062) — the owner's correction
   * when there is one, ARC's reading otherwise; null when the movement records
   * no load. The one value every screen and payload reads.
   */
  loadBasis: LoadBasis | null;
  /** ARC's own reading, whatever the owner set — what the chooser offers to go back to. */
  loadBasisDerived: LoadBasis | null;
  /** True when {@link loadBasis} is the owner's correction rather than ARC's reading. */
  loadBasisSetByOwner: boolean;
  primaryMuscles: Muscle[];
  secondaryMuscles: Muscle[];
};

/** Fields for creating a custom exercise (the picker's "New exercise" form). */
export type NewExercise = {
  name: string;
  /**
   * Search synonyms, stored as the JSON array `exercises.aliases` (0011) and
   * ranked by the matcher exactly as the seeded rows' aliases are.
   *
   * Nothing wrote this column before C12: the seed planted aliases and the
   * picker's manual form never asked for any, so a custom "Landmine Press"
   * answered to precisely one spelling and nothing else. The AI entry supplies
   * them, which is most of what makes an AI-authored movement findable again
   * next month.
   */
  aliases?: string[];
  equipment: Equipment;
  loggingType: LoggingType;
  /**
   * What a set of this movement records. Omitted means "derive it from
   * `loggingType`" (MEASURES_FOR_LOGGING_TYPE), which is what every form does;
   * pass it explicitly only when the movement measures something logging_type
   * cannot express — a carry's load + distance, say.
   */
  measures?: Measures;
  movementPattern?: MovementPattern | null;
  mechanic?: Mechanic | null;
  unilateral?: boolean;
  primaryMuscles: Muscle[];
  secondaryMuscles?: Muscle[];
  /** Short how-to steps (the AI entry writes these; the manual form leaves them off). */
  instructions?: string[];
  /**
   * Who authored these facts (0056). Omitted means `'user'` — the manual form,
   * which is the only other thing that creates a row. A model-authored entry
   * passes `'ai'` explicitly, and is never written without the owner tapping
   * Save.
   */
  source?: ExerciseSource;
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
  /**
   * What the set's exercise measures (0046), and how long the set lasted.
   *
   * Both OPTIONAL, and the default is the pre-0046 behaviour — one set costs
   * one working set. They only matter for ENDURANCE work (time + distance, no
   * load), where duration is the dose: a 45-minute run is not one set of quads.
   * See `enduranceEffortWeight` in ./constants.ts for the weight and its
   * calibration.
   */
  measures?: Measures | null;
  durationSec?: number | null;
  /**
   * WHERE this load came from (0054). `'set'` — the default, so every existing
   * construction site is untouched — means the owner logged the set. `'ingested'`
   * means ARC INFERRED it from a HealthKit workout's activity type, and nobody
   * typed anything.
   *
   * It exists for the rule 0034 wrote down: the danger is *"a number of unknown
   * origin entering the rollup … wearing the same face as a number the user
   * asserted"*. A 45-minute walk genuinely fatigues the legs and the recovery
   * model should know it — but the ledger has to be able to say which half of
   * its reading was measured and which was guessed, which is what
   * {@link MuscleFreshness.inferredShare} carries out to the screens.
   */
  origin?: 'set' | 'ingested';
};

/**
 * A hand-set freshness assertion (migration 0037): "as of `anchoredAt`, this
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
  /**
   * The fraction of THIS reading's fatigue that came from an INFERRED load —
   * a HealthKit workout ARC read a muscle table against, rather than a set the
   * owner logged (0054). 0 when every contribution was typed, 1 when none was.
   *
   * It sits beside {@link anchoredAt} and is read the same way: both say what
   * the number rests on, because a derived figure and an asserted one must not
   * wear the same face. A muscle at 100 has no fatigue to apportion, so it
   * reports 0 — "nothing inferred", which is true.
   */
  inferredShare: number;
};

/**
 * A per-exercise estimated 1RM data point (for the detail sparkline).
 *
 * `away` (0055) marks a point whose session was logged away from the usual gym.
 * It is present on the CHART and absent from every baseline: hiding it would be
 * a different lie from awarding it a record — the session happened and the
 * owner will look for it. Omitted rather than `false` on a home point, so the
 * flag reads as a mark rather than a column.
 */
export type E1rmPoint = { date: DateString; e1rm: number; away?: true };

/**
 * Personal records for one exercise. Loads are canonical kg, distances metres,
 * times seconds.
 *
 * Which three mean anything depends on what the movement measures (0046): the
 * load records are null for a plank and the time/distance records are null for
 * a bench press, because no set ever carried the column. The detail screen
 * picks the trio to show from `measures`, not from which happen to be non-null,
 * so a movement with no history still shows the right three em-dashes.
 */
export type PersonalRecords = {
  /** Heaviest single working set's load. */
  maxWeightKg: number | null;
  /** Best estimated 1RM across working sets. */
  bestE1rmKg: number | null;
  /** Best single-set volume (weight × reps). */
  bestSetVolumeKg: number | null;
  /**
   * Best single-SESSION volume for this movement — Σ weight × reps over one
   * workout's working sets (2026-09-23, Fitbod's "max volume"). In the logged
   * basis, like every figure here: a per-hand movement's volume is per hand.
   */
  bestSessionVolumeKg: number | null;
  /** Most reps in one working set, at any load — the push-up record. */
  bestReps: number | null;
  /** Most reps across one session's working sets — what a bodyweight day adds up to. */
  bestSessionReps: number | null;
  /** Longest single working set, seconds — the plank record. */
  bestDurationSec: number | null;
  /** Farthest single working set, metres. */
  bestDistanceM: number | null;
  /**
   * Fastest pace, seconds per kilometre, over sets carrying BOTH a duration and
   * a distance of at least `PACE_PR_MIN_M` (./constants.ts). Short pieces are
   * excluded on purpose: a 20-metre sprint has a stunning pace and says nothing
   * about a 10 km, so letting one set the record would make it unreadable.
   */
  bestPaceSecPerKm: number | null;
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
