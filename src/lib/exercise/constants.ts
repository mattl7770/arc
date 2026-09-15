/**
 * The training engine's tunable constants, in one place.
 *
 * Every number here is a modelling choice grounded in the research
 * (docs/exercise-subapp.md §4) but deliberately adjustable — labelled so a
 * future device-review or the Coach can retune without hunting through logic.
 * Pure data + a couple of pure lookups; no DB, no React, so the whole engine
 * stays headless-testable.
 */
import type { Mechanic, Muscle, MovementPattern } from './types';

// ---------------------------------------------------------------------------
// Muscle taxonomy — display + ordering
// ---------------------------------------------------------------------------

/** Human labels for the 16 muscle groups (ledger rows, exercise detail). */
export const MUSCLE_LABEL: Record<Muscle, string> = {
  chest: 'Chest',
  front_delts: 'Front delts',
  side_delts: 'Side delts',
  rear_delts: 'Rear delts',
  lats: 'Lats',
  upper_back: 'Upper back',
  lower_back: 'Lower back',
  traps: 'Traps',
  biceps: 'Biceps',
  triceps: 'Triceps',
  forearms: 'Forearms',
  quads: 'Quads',
  hamstrings: 'Hamstrings',
  glutes: 'Glutes',
  calves: 'Calves',
  abs: 'Abs',
};

/**
 * The muscles a session is anchored on when the user has no routines yet — the
 * "freshest muscle" fallback picks from these, so it recommends a real workout
 * (chest/back/legs/arms) rather than an odd choice like front delts or abs,
 * which are rarely trained directly and would always read as "freshest".
 */
export const ANCHOR_MUSCLES: Muscle[] = [
  'chest',
  'upper_back',
  'lats',
  'quads',
  'hamstrings',
  'glutes',
  'side_delts',
  'biceps',
  'triceps',
];

/** Head-to-toe display order for the freshness ledger. */
export const MUSCLE_ORDER: Muscle[] = [
  'chest',
  'upper_back',
  'lats',
  'lower_back',
  'front_delts',
  'side_delts',
  'rear_delts',
  'traps',
  'biceps',
  'triceps',
  'forearms',
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'abs',
];

// ---------------------------------------------------------------------------
// Recovery model
// ---------------------------------------------------------------------------

/**
 * Published per-muscle recovery windows in hours (docs/exercise-subapp.md §4.2):
 * large muscles ~72h, mid ~48h, small ~36h. The decay time constant is
 * window/3 (residual ≈ 5% at the window), so a muscle reads ~fresh once its
 * window has elapsed since a hard session.
 */
export const RECOVERY_HOURS: Record<Muscle, number> = {
  quads: 72,
  hamstrings: 72,
  glutes: 72,
  lats: 72,
  upper_back: 72,
  lower_back: 72,
  chest: 48,
  side_delts: 48,
  rear_delts: 48,
  front_delts: 48,
  traps: 48,
  triceps: 48,
  biceps: 36,
  calves: 36,
  forearms: 36,
  abs: 36,
};

/** τ = window / 3 (three time constants ≈ 95% decayed at the window). */
export const recoveryTauHours = (muscle: Muscle): number => RECOVERY_HOURS[muscle] / 3;

/**
 * The fatigue SCALE, in fractional working sets — the volume that takes a fresh
 * muscle to 1/e (37%). One hard working set on a primary muscle contributes
 * ~1.0 (role 1.0 × effort 1.0 at RIR 1-3), so eight of them read 37%, sixteen
 * read 14%, and twenty-four read 5%. Global, not per-muscle: size-based
 * recovery SPEED is already encoded in τ above, and a second per-muscle knob
 * here would be a number nothing could calibrate. Tunable.
 *
 * **It is a scale, not a ceiling — that rename is the 2026-08-14 fix.** It used
 * to be `FRESH_FULL`, the fatigue that drove freshness *to zero* through a
 * linear ramp `100 × (1 − min(1, F/8))`, and the `min` was the bug: eight
 * fractional sets and twenty-four read an identical 0, so a whole back day and
 * a warmup-and-leave both printed "spent". See the calibration table on
 * {@link freshnessFromFatigue} (src/lib/exercise/freshness.ts) for what a
 * session of N sets now reads.
 */
export const FRESH_SCALE = 8;

/** Freshness display buckets (percent). */
export const FRESH_THRESHOLDS = { fresh: 80, recovering: 50 } as const;

/**
 * Below this set-weighted freshness a recommended routine is flagged with a
 * caution rather than hidden — recovery PRIORITIZES, it never gates (FitBod's
 * rule: if a muscle must be trained, train it, just note the fatigue).
 */
export const ROUTINE_CAUTION = 60;

/** How far back to sum sets when computing fatigue (older sets have ~0 weight). */
export const FRESHNESS_LOOKBACK_DAYS = 14;

// ---------------------------------------------------------------------------
// Weekly volume landmarks (RP / Israetel, docs/exercise-subapp.md §1 research)
// ---------------------------------------------------------------------------

/** Per-muscle weekly hard-set landmarks, in fractional sets (primary 1.0 / secondary 0.5). */
export type VolumeLandmark = {
  /** Minimum Effective Volume — below this, growth stimulus is weak. */
  mev: number;
  /** Maximum Adaptive Volume — the top of the productive range to build toward. */
  mav: number;
  /** Maximum Recoverable Volume — at/over this, back off. */
  mrv: number;
};

/**
 * Published weekly-set landmarks per muscle (Renaissance Periodization). The
 * deltoid heads split because they diverge sharply: front delts saturate from
 * pressing (MEV ~0), side/rear need direct work. Muscles worked mostly
 * indirectly (lower back, forearms, abs, traps) carry a low direct MEV. These
 * are population starting points, not gospel — labelled tunable, and the engine
 * only uses them for coarse add/hold/cut guidance.
 */
export const VOLUME_LANDMARKS: Record<Muscle, VolumeLandmark> = {
  chest: { mev: 8, mav: 16, mrv: 22 },
  upper_back: { mev: 6, mav: 14, mrv: 20 },
  lats: { mev: 8, mav: 16, mrv: 25 },
  lower_back: { mev: 2, mav: 8, mrv: 12 },
  front_delts: { mev: 0, mav: 6, mrv: 12 },
  side_delts: { mev: 6, mav: 16, mrv: 25 },
  rear_delts: { mev: 6, mav: 16, mrv: 25 },
  traps: { mev: 0, mav: 16, mrv: 26 },
  biceps: { mev: 6, mav: 14, mrv: 20 },
  triceps: { mev: 4, mav: 12, mrv: 18 },
  forearms: { mev: 0, mav: 8, mrv: 14 },
  quads: { mev: 6, mav: 16, mrv: 20 },
  hamstrings: { mev: 4, mav: 12, mrv: 16 },
  glutes: { mev: 4, mav: 12, mrv: 20 },
  calves: { mev: 6, mav: 14, mrv: 20 },
  abs: { mev: 0, mav: 16, mrv: 22 },
};

/**
 * On a deload week the program cuts working volume to roughly this fraction of
 * normal (RP deload ≈ MV, about half of accumulation). Surfaced to the logger/
 * recommender; the per-exercise engine keeps the movements, just fewer sets.
 */
export const DELOAD_VOLUME_FRACTION = 0.5;

/**
 * Effort multiplier on a set's fatigue from proximity to failure. A submaximal
 * set (RIR > 4) costs less; a set to failure (RIR ≤ 0) costs more and extends
 * recovery (Morán-Navarro 2017). When RPE is absent, a 'failure'-typed set is
 * treated as failure, everything else as a normal hard set.
 */
export function effortWeight(rpe: number | null, isFailureType: boolean): number {
  if (rpe != null) {
    const rir = 10 - rpe;
    if (rir <= 0) return 1.25;
    if (rir > 4) return 0.5;
    return 1.0;
  }
  return isFailureType ? 1.25 : 1.0;
}

/**
 * Minutes of continuous ENDURANCE work that cost a muscle what one hard working
 * set costs it. Ten.
 *
 * This is the whole of B1's freshness answer and it exists because the default
 * — one row, one set — is wrong in the one direction that matters. Before 0046
 * a run could not record its duration at all; now it can, and treating a
 * 45-minute run as a single set of quads would tell the recovery model that
 * nothing much happened. The owner would then be shown a leg day the morning
 * after a long run, which is exactly the class of mistake the ledger exists to
 * prevent.
 *
 * Ten minutes is the calibration, not a derivation — running has no published
 * "sets" to convert from — and it is set by anchoring one reading the owner can
 * check against his own legs:
 *
 *   **A 45-minute run, no RPE, reads quads 57 and calves/hamstrings/glutes 75.**
 *
 * (4.5 effort units on the primary; 2.25 on the secondaries at role weight 0.5;
 * `freshnessFromFatigue` does the rest. Pinned in db/training-engine.test.mjs.)
 * Read against {@link FRESH_SCALE}'s own table, that puts a 45-minute run at
 * roughly a third of a twelve-set leg day, and lands it in the "recovering"
 * band rather than "fresh" — you would not squat heavy on it, and you would
 * train upper body without a second thought. Both of those are true.
 *
 * It is a SCALE, so it stays honest at the ends too: a 20-minute Zone 2 shuffle
 * costs 2 units (quads 78, a dent), and a three-hour long run hits the cap.
 * Tunable — this and {@link ENDURANCE_EFFORT_CAP} are the two numbers a device
 * review would move.
 */
export const ENDURANCE_MINUTES_PER_SET = 10;

/**
 * The most fatigue one endurance set may contribute, in fractional working sets.
 *
 * Eighteen, reached at three hours, and the ceiling matters for two reasons.
 * Without one, the 10-hour bound on `workout_sets.duration_sec` would permit 60
 * units, and `freshnessFromFatigue` would round to **0** — a number the model
 * promises never to print, because a real muscle never is at zero. And 18 sits
 * deliberately BELOW the ~44 units a hand-asserted "Spent" implies
 * (`ANCHOR_FLOOR_PERCENT`, freshness.ts), so nothing the app infers on its own
 * can ever out-assert what the user said about his own body.
 */
export const ENDURANCE_EFFORT_CAP = 18;

/**
 * The effort weight of one ENDURANCE set — time + distance with no load (see
 * `isEnduranceMeasures`). Duration is the dose; RPE still scales it, through the
 * same {@link effortWeight} knob every other set uses, so an easy 45-minute jog
 * (RPE 5 → RIR 5 → 0.5) costs half a hard 45-minute tempo.
 *
 * A set with NO duration falls back to the ordinary per-set weight rather than
 * to zero: a run someone logged as distance-only still happened, and reading it
 * as free is a worse error than reading it as one set.
 */
export function enduranceEffortWeight(
  durationSec: number | null,
  rpe: number | null,
  isFailureType: boolean
): number {
  const effort = effortWeight(rpe, isFailureType);
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) return effort;
  const sets = durationSec / 60 / ENDURANCE_MINUTES_PER_SET;
  return Math.min(ENDURANCE_EFFORT_CAP, sets * effort);
}

// ---------------------------------------------------------------------------
// e1RM
// ---------------------------------------------------------------------------

/**
 * The shortest piece that may set a PACE record, in metres. 400 m — one lap —
 * is the shortest distance at which a pace is a training fact rather than an
 * artefact of the start. Below it, a sprint's pace would own the record for
 * every distance forever (see `PersonalRecords.bestPaceSecPerKm`).
 */
export const PACE_PR_MIN_M = 400;

/** Sets above this rep count carry too much noise to estimate 1RM from. */
export const E1RM_REP_CAP = 12;
/** A set with more reps-in-reserve than this says nothing about a max. */
export const E1RM_MAX_RIR = 4;
/** Ignore capability older than this when suggesting loads. */
export const CAPABILITY_WINDOW_DAYS = 42;

// ---------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------

const LB_PER_KG = 2.2046226218;
const lb = (pounds: number) => pounds / LB_PER_KG;

/** Default working rep range by mechanic (double-progression bounds). */
export const REP_RANGE: Record<Mechanic, { low: number; high: number }> = {
  compound: { low: 6, high: 10 },
  isolation: { low: 8, high: 15 },
};

/** Lower-body patterns take the bigger jump; everything else the small one. */
const LOWER_PATTERNS: ReadonlySet<MovementPattern> = new Set(['squat', 'hinge', 'lunge']);

/**
 * The smallest load bump to suggest, in kg, from the movement (StrongLifts
 * numbers, ACSM 2-for-2 spirit): lower-body compounds +5 lb, everything else
 * +2.5 lb. Machines/cables often can't hit 2.5 lb — the plate-rounding in the
 * screen snaps the displayed target, this is just the nominal step.
 */
export function progressionIncrementKg(
  pattern: MovementPattern | null,
  mechanic: Mechanic | null
): number {
  const big = pattern != null && LOWER_PATTERNS.has(pattern) && mechanic !== 'isolation';
  return big ? lb(5) : lb(2.5);
}

/** Consecutive stalled sessions before suggesting a deload. */
export const STALL_SESSIONS = 3;
/** Deload cuts the working weight by this fraction. */
export const DELOAD_FRACTION = 0.1;

// ---------------------------------------------------------------------------
// Rest + warmups
// ---------------------------------------------------------------------------

/** Standard Olympic bar, kg — the floor a barbell warmup ramps from. */
export const BAR_KG = 20;

/**
 * Rest seconds to pre-fill after a set, by how heavy/compound it is (2024
 * Bayesian meta-analysis: ≥60 s matters, >90 s marginal; heavy work wants more).
 */
export function restSecFor(mechanic: Mechanic | null, reps: number | null): number {
  if (mechanic === 'isolation') return 90;
  if (reps != null && reps <= 6) return 180;
  return 150;
}

/** Warmup ramp as fractions of the working weight (Starting Strength scheme). */
export const WARMUP_RAMP: { pct: number; reps: number }[] = [
  { pct: 0.5, reps: 5 },
  { pct: 0.7, reps: 3 },
  { pct: 0.85, reps: 2 },
];

/** Below this multiple of the bar, a warmup ramp isn't worth generating. */
export const WARMUP_MIN_WORK_MULTIPLE = 1.5;
