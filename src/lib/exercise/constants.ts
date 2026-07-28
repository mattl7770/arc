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
 * Fatigue units that drive freshness to zero. One hard working set on a primary
 * muscle contributes ~1.0 (role 1.0 × effort 1.0 at RIR 1-3); ~8 fresh primary
 * sets fully spend a muscle. Global, not per-muscle: size-based recovery SPEED
 * is already encoded in τ above. Tunable.
 */
export const FRESH_FULL = 8;

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

// ---------------------------------------------------------------------------
// e1RM
// ---------------------------------------------------------------------------

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
