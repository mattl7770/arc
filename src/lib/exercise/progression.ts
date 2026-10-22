/**
 * Progressive overload — pure, DB-free, offline.
 *
 * Dynamic double progression (docs/exercise-subapp.md §4.3): hold the load until
 * the top of the rep range is reached, then add the smallest sensible jump and
 * reset to the bottom. A run of sessions with no new best and reps stuck below
 * the top triggers a deload suggestion (StrongLifts' 3-stall rule). The engine
 * returns a raw kg target + an action; the screen renders the number in the
 * user's unit and snaps it to real plates.
 *
 * ## One stall rule, two readers (item 87, 2026-10-21)
 *
 * "Did this session advance?" ({@link sessionAdvanced}) and "is the lift
 * stalled?" ({@link isStalled}) live here, and both the engine's deload branch
 * and the overload mark (`overloadMarkOf`, src/lib/exercise/records.ts) ask
 * them, so a lift marked **Stalled** is exactly a lift the engine deloads
 * (docs/spikes/pr-vs-overload.md). The old test was "did any of the last three
 * sessions beat the one before it", which a zig-zag (7, 6, 7 reps at one load)
 * passes forever while getting nowhere: the rebound beat its dip. An advance
 * has to beat EACH of the up-to-three sessions before it, a new high-water mark.
 */
import { ADVANCE_E1RM_PCT, ADVANCE_WINDOW, DELOAD_FRACTION, STALL_SESSIONS } from './constants';
import { epley, effectiveReps } from './e1rm';
import type { ProgressionSuggestion } from './types';

/**
 * One prior session's best working set for an exercise (oldest → newest).
 *
 * `durationSec` / `distanceM` (0046) ride along for the history list on
 * app/exercise-detail.tsx, which renders the same rows. The progression engine
 * below ignores them entirely and that is correct: double progression is a
 * statement about load and reps, and there is no honest way to "add 2.5 kg" to
 * a run. A movement with no loaded history returns 'find_weight' — see
 * `progressionFor` in training-recommend.ts, which does not even ask.
 */
export type SessionTopSet = {
  /**
   * The session this was the best of — how the detail screen's history joins
   * a row to its ADVANCED mark (`advancedSessionIds`). Optional: the engine below never
   * reads it, and a hand-built fixture has no workout to name.
   */
  workoutId?: string;
  date: string;
  weightKg: number | null;
  reps: number | null;
  rpe: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
  /**
   * The session was logged away from the usual gym (0055). The engine below
   * ignores such a session entirely — see {@link suggestProgression}. Optional
   * so a caller with no opinion (a test fixture, a hand-built input) means
   * "home", which is what every session meant before the column existed.
   */
  away?: boolean;
};

export type ProgressionInput = {
  /** Best working set per past session, oldest → newest. */
  sessions: SessionTopSet[];
  repRange: { low: number; high: number };
  /** The smallest load bump to suggest, kg (from progressionIncrementKg). */
  incrementKg: number;
};

/**
 * A comparable "strength" for a set: the effort-adjusted e1RM (Epley on reps +
 * RIR). Zero without a load or a rep count; a bodyweight set is judged on its
 * reps, which {@link advanceRule} compares directly.
 */
export function sessionStrength(s: SessionTopSet): number {
  if (s.weightKg == null || s.reps == null) return 0;
  return epley(s.weightKg, effectiveReps(s.reps, s.rpe));
}

/** Two loads closer than this are the same plates (a kg/lb round trip drifts). */
const LOAD_EPS = 0.01;
const EPS = 1e-6;

type RepRange = { low: number; high: number };

/**
 * The sessions the stall rule compares: home only (0055), with reps, and with
 * a load unless the movement is done for reps alone. `repsOnly` is the mark's
 * case for a push-up, or a pull-up never logged with added weight; the engine
 * never passes it, because it has no load step to offer such a movement.
 */
export function comparableSessions(
  sessions: readonly SessionTopSet[],
  repsOnly = false
): SessionTopSet[] {
  return sessions.filter(
    (s) => s.away !== true && s.reps != null && (repsOnly || s.weightKg != null)
  );
}

/**
 * Which rule makes `a` beat `b`, or null when it does not
 * (docs/spikes/pr-vs-overload.md, "The mark, defined"). A missing load is
 * zero, so a movement done for reps alone is judged by rule 2 alone.
 *
 *   1. **More load, held in range**: the double-progression jump. Its e1RM
 *      usually drops (reps reset to the bottom), and it is still an advance.
 *   2. **More reps at the same load**, without a lower effort-adjusted e1RM: a
 *      grinder at RPE 10 does not out-rank a clean set at RPE 7.
 *   3. **e1RM up by at least {@link ADVANCE_E1RM_PCT}%**: a lighter load for
 *      many more reps, or the same set at a lower RPE.
 */
export function advanceRule(
  a: SessionTopSet,
  b: SessionTopSet,
  repRange: RepRange
): 1 | 2 | 3 | null {
  const aw = a.weightKg ?? 0;
  const bw = b.weightKg ?? 0;
  const ar = a.reps ?? 0;
  const br = b.reps ?? 0;
  const as = sessionStrength(a);
  const bs = sessionStrength(b);
  if (aw > bw + LOAD_EPS && ar >= repRange.low) return 1;
  if (Math.abs(aw - bw) <= LOAD_EPS && ar > br && as >= bs - EPS) return 2;
  if (bs > 0 && as >= bs * (1 + ADVANCE_E1RM_PCT / 100) - EPS) return 3;
  return null;
}

/**
 * Whether `latest` advanced on the sessions before it (oldest to newest): it
 * beats EACH of the last {@link ADVANCE_WINDOW} of them. With nothing before
 * it, it did: the first session is the first best. "Each of three" is what
 * stops a rebound counting: 7, 6, 7 beats the 6 and not the first 7.
 */
export function sessionAdvanced(
  latest: SessionTopSet,
  before: readonly SessionTopSet[],
  repRange: RepRange
): boolean {
  return before.slice(-ADVANCE_WINDOW).every((b) => advanceRule(latest, b, repRange) != null);
}

/** Per session, oldest to newest: whether it advanced on the ones before it. */
export function advancedFlags(sessions: readonly SessionTopSet[], repRange: RepRange): boolean[] {
  return sessions.map((s, i) => sessionAdvanced(s, sessions.slice(0, i), repRange));
}

/**
 * Sessions since the last one that advanced: 0 when the latest did. The first
 * session always advanced, so this is at most `sessions.length - 1` (and 0 for
 * no sessions at all).
 */
export function sinceBestOf(sessions: readonly SessionTopSet[], repRange: RepRange): number {
  const flags = advancedFlags(sessions, repRange);
  return flags.length === 0 ? 0 : flags.length - 1 - flags.lastIndexOf(true);
}

/**
 * THE stall rule: the engine's deload and the mark's **Stalled**, one
 * predicate. At least {@link STALL_SESSIONS} comparable sessions, no new best
 * in the last `STALL_SESSIONS - 1` of them, and every one of the last
 * `STALL_SESSIONS` below the top of the range. A lift that reached the top
 * recently is not stalled: its next step is a load jump. Pass
 * {@link comparableSessions}.
 */
export function isStalled(sessions: readonly SessionTopSet[], repRange: RepRange): boolean {
  if (sessions.length < STALL_SESSIONS) return false;
  const belowTop = sessions.slice(-STALL_SESSIONS).every((s) => (s.reps ?? 0) < repRange.high);
  return belowTop && sinceBestOf(sessions, repRange) >= STALL_SESSIONS - 1;
}

/**
 * Suggest the next session's load + reps for one exercise from its history.
 * No loaded history → 'find_weight' (honest: converges in ~2 sessions anyway).
 *
 * ## Away sessions do not steer anything (0055)
 *
 * They are filtered out of `loaded` before a single branch below runs, and the
 * STALL branch is why. Three weeks away from home on stiffer machines produces
 * exactly its input — `STALL_SESSIONS` sessions with no strength gain and reps
 * below the top of the range — so ARC would recommend a 10% deload on a lift
 * that never stalled. That is the false regression the owner asked for this
 * feature to prevent, and it is the one place in the engine where an
 * incomparable load does real damage rather than merely reading oddly.
 *
 * Filtering here rather than at the caller is deliberate: this is the branch
 * with the failure mode, the filter is one predicate, and a future caller
 * cannot reintroduce the bug by handing the engine an unfiltered history.
 * `exerciseSessionTopsFrom` therefore keeps away sessions and marks them, which
 * is what lets the detail screen's History list still show them.
 */
export function suggestProgression(input: ProgressionInput): ProgressionSuggestion {
  const { repRange, incrementKg } = input;
  const loaded = comparableSessions(input.sessions);

  if (loaded.length === 0) {
    return {
      kind: 'find_weight',
      targetWeightKg: null,
      targetReps: repRange.low,
      note: 'Find a working weight — aim for the bottom of the range.',
    };
  }

  const last = loaded[loaded.length - 1]!;
  const lastWeight = last.weightKg as number;
  const lastReps = last.reps as number;
  const rir = last.rpe == null ? null : 10 - last.rpe;

  // Top of range reached with a rep in reserve → add load, reset reps.
  if (lastReps >= repRange.high && (rir == null || rir >= 1)) {
    return {
      kind: 'progress',
      targetWeightKg: lastWeight + incrementKg,
      targetReps: repRange.low,
      note: 'Top of range hit — add a small jump, reset to the bottom.',
    };
  }

  // Stall: no new best lately and still short of the top of the range → back
  // off and rebuild. `isStalled` is the mark's Stalled too, so the two cannot
  // disagree (item 87); a zig-zag at one load now lands here.
  if (isStalled(loaded, repRange)) {
    return {
      kind: 'deload',
      targetWeightKg: lastWeight * (1 - DELOAD_FRACTION),
      targetReps: repRange.low,
      note: `Stalled ${STALL_SESSIONS} sessions — drop ~${Math.round(DELOAD_FRACTION * 100)}% and rebuild.`,
    };
  }

  // Otherwise hold the load and chase one more rep toward the top.
  return {
    kind: 'hold',
    targetWeightKg: lastWeight,
    targetReps: Math.min(lastReps + 1, repRange.high),
    note: 'Hold the load — add a rep toward the top of the range.',
  };
}
