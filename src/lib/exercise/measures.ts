/**
 * What an exercise MEASURES — the vocabulary behind migration 0046, pure and
 * DB-free so the loggers, the engine, the Coach's tools and the headless tests
 * all read the same four words.
 *
 * Owner, 2026-09-14 (backlog B1): *"Distance instead of reps for running
 * workouts… time for some exercises i.e. planks."* A set used to be reps × load
 * and nothing else. Now the exercise declares which of **reps · load · time ·
 * distance** its sets carry, and every screen that draws a set row, every stat
 * that reduces one, and every tool that writes one asks this module.
 *
 * ## The canonical form
 *
 * `exercises.measures` is the comma-joined subset in the fixed order
 * `reps,load,time,distance` — "reps,load" for a bench press, "time" for a
 * plank, "time,distance" for a run, "load,distance" for a farmer's carry. The
 * fixed order is what makes the column a CHECK'd enum rather than free text:
 * there is exactly one spelling of each of the fifteen non-empty subsets, so
 * equality works and the CHECK is total over a closed domain — no future
 * migration can need a sixteenth value, because the domain closes at four
 * measures.
 */
import type { LoggingType } from './types';

/** The four things a set can record. */
export type Measure = 'reps' | 'load' | 'time' | 'distance';

/**
 * The canonical subset string stored in `exercises.measures`. All fifteen
 * non-empty subsets, in the order `reps,load,time,distance` — the literal union
 * so a typo is a type error, and the exact list migration 0046's CHECK holds.
 */
export type Measures =
  | 'reps'
  | 'load'
  | 'time'
  | 'distance'
  | 'reps,load'
  | 'reps,time'
  | 'reps,distance'
  | 'load,time'
  | 'load,distance'
  | 'time,distance'
  | 'reps,load,time'
  | 'reps,load,distance'
  | 'reps,time,distance'
  | 'load,time,distance'
  | 'reps,load,time,distance';

/**
 * Every legal value of `exercises.measures` — all fifteen non-empty subsets, in
 * the CHECK's own order, which is also where the canonical `reps,load,time,
 * distance` ordering is encoded. Nothing constructs one of these by joining;
 * they are written as literals here, in the migration, and nowhere else.
 */
export const ALL_MEASURES: readonly Measures[] = [
  'reps',
  'load',
  'time',
  'distance',
  'reps,load',
  'reps,time',
  'reps,distance',
  'load,time',
  'load,distance',
  'time,distance',
  'reps,load,time',
  'reps,load,distance',
  'reps,time,distance',
  'load,time,distance',
  'reps,load,time,distance',
];

/**
 * What a movement measures when nothing says otherwise — the shape every set in
 * ARC had before 0046, and the column's own ALTER default.
 */
export const DEFAULT_MEASURES: Measures = 'reps,load';

const MEASURES_SET: ReadonlySet<string> = new Set(ALL_MEASURES);

/**
 * Read a stored value back. TOTAL: anything unrecognised — a row written by a
 * future build, a corrupted draft, a JSON payload off the model — reads as
 * {@link DEFAULT_MEASURES} rather than throwing. This runs inside `useState`
 * initialisers on the logger's mount path, where a throw means an un-openable
 * screen.
 */
export function asMeasures(raw: unknown): Measures {
  return typeof raw === 'string' && MEASURES_SET.has(raw) ? (raw as Measures) : DEFAULT_MEASURES;
}

/** Does this movement record `measure`? */
export function hasMeasure(measures: Measures, measure: Measure): boolean {
  // Substring is not enough on its own ('reps' is inside nothing else, but a
  // future measure could be inside another), so match on the split tokens.
  return measureList(measures).includes(measure);
}

/** The measures as an ordered array — the form the loggers render columns from. */
export function measureList(measures: Measures): Measure[] {
  return measures.split(',') as Measure[];
}

/**
 * `logging_type` → `measures`. The ONE mapping, shared by migration 0046's
 * backfill (pass 1, in SQL) and by every write path that creates an exercise
 * (the picker's New-exercise form, AI search, the Coach). Keeping the derivation
 * in one place is what stops the two columns drifting: `logging_type` still
 * distinguishes bodyweight from weighted from assisted, which `measures`
 * deliberately does not, so it stays authored and `measures` stays derived.
 */
export const MEASURES_FOR_LOGGING_TYPE: Record<LoggingType, Measures> = {
  weight_reps: 'reps,load',
  bodyweight_reps: 'reps',
  weighted_bodyweight: 'reps,load',
  assisted_bodyweight: 'reps,load',
  duration: 'time',
  weight_duration: 'load,time',
  distance_duration: 'time,distance',
};

/**
 * Whether a set of this movement is ENDURANCE work — time and distance with no
 * load and no reps. Running, cycling, rowing, swimming, walking.
 *
 * This is the one predicate the freshness model branches on, and it keys on the
 * measures rather than on a separate cardio flag or on `movement_pattern`,
 * because the measures are the honest signal: a movement you cover ground in,
 * for a length of time, carrying nothing, is dosed by DURATION. A plank
 * ('time') is one set of abs no matter how long it is held; a heavy carry
 * ('load,distance') is one set of forearms; a 45-minute run is not one set of
 * quads. See `enduranceEffortWeight` in ./constants.ts for what it costs.
 */
export function isEnduranceMeasures(measures: Measures): boolean {
  return (
    hasMeasure(measures, 'time') &&
    hasMeasure(measures, 'distance') &&
    !hasMeasure(measures, 'load') &&
    !hasMeasure(measures, 'reps')
  );
}

/**
 * Whether a set of this movement can carry a max signal — it records both a
 * load and the reps performed under it. e1RM, personal-record weights and the
 * double-progression engine all require this, and nothing else does.
 *
 * A plank can never set an estimated 1RM. That was already true arithmetically
 * (`countsForE1rm` rejects a null weight or null reps), but stating it as a
 * property of the MOVEMENT is what lets the screens hide an e1RM panel that
 * would only ever read "—", and what keeps the progression engine from offering
 * to add 2.5 kg to a run.
 */
export function isLoadedRepsMeasures(measures: Measures): boolean {
  return hasMeasure(measures, 'reps') && hasMeasure(measures, 'load');
}

/** The four measurable values of one set, canonical (kg, seconds, metres). */
export type MeasuredFields = {
  reps: number | null;
  weightKg: number | null;
  durationSec: number | null;
  distanceM: number | null;
};

/**
 * Keep only the fields `measures` declares; NULL the rest.
 *
 * The rule "a set carries the fields its exercise implies" (0046) has exactly
 * one implementation and this is it, because it has two callers that MUST
 * agree: `insertSet`, which decides what is stored, and the Coach's
 * `log_workout` card, which tells the owner what is about to be stored. When
 * they disagreed — the card printed "Plank 3 × 45 lb" and the repository then
 * dropped both — the confirmation was a promise about a row that would never
 * exist, which is worse than either behaviour on its own.
 */
export function maskByMeasures(measures: Measures, fields: MeasuredFields): MeasuredFields {
  return {
    reps: hasMeasure(measures, 'reps') ? fields.reps : null,
    weightKg: hasMeasure(measures, 'load') ? fields.weightKg : null,
    durationSec: hasMeasure(measures, 'time') ? fields.durationSec : null,
    distanceM: hasMeasure(measures, 'distance') ? fields.distanceM : null,
  };
}

const MEASURE_LABEL: Record<Measure, string> = {
  reps: 'Reps',
  load: 'Load',
  time: 'Time',
  distance: 'Distance',
};

/**
 * What the picker and the detail screen print so the owner knows what he will
 * be asked to type before he picks the movement: "Reps · Load", "Time",
 * "Time · Distance". Label voice, not mono — these are names, not measurements.
 */
export function measuresLabel(measures: Measures): string {
  return measureList(measures)
    .map((m) => MEASURE_LABEL[m])
    .join(' · ');
}
