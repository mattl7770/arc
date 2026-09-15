/**
 * What an INGESTED workout did to the body — the HealthKit activity type →
 * muscle table, pure and DB-free (backlog D3, docs/spikes/ingested-workouts.md
 * §3.A).
 *
 * The owner's words: *"a walking exercise… minorly effect the legs and not much
 * else"*; **strength-training-coded** workouts leave a blank for the user.
 *
 * ## Keyed on the raw int, never the label
 *
 * `src/lib/health/mapping.ts` states it: *"raw ints are the stable identity;
 * names have churned across SDK versions"*. A table keyed on "Walking" would
 * break silently on an SDK bump; a table keyed on 52 cannot.
 *
 * ## Three outcomes, and they MUST stay distinguishable
 *
 * | outcome | meaning | behaviour |
 * | --- | --- | --- |
 * | **inferred** | this type has an honest muscle answer | contributes fractional load, marked inferred |
 * | **blank** | strength-coded; ARC deliberately does not guess | contributes nothing and ASKS the owner |
 * | **refused** | ARC has no honest guess, and never will | contributes nothing and NEVER asks |
 *
 * Separating *refused* from *blank* is the honesty rule in operational form. A
 * HIIT session left "blank" would sit in an inbox forever asking a question ARC
 * cannot even frame — burpees or an assault bike are not the same body — and
 * "Other" is nothing at all. A stretch is not fatigue either, so yoga, mobility
 * and cooldowns contribute a real, deliberate zero rather than an absence.
 *
 * ## The numbers are ROLE WEIGHTS, not a second dose model
 *
 * Each entry is the weight one muscle carries in that activity, on exactly the
 * scale `exercise_muscles` already uses: **1.0 is a primary mover, 0.5 an
 * assist** (`ROLE_WEIGHT` in training-stats.ts). DURATION is applied afterwards
 * by 0046's endurance rule — {@link enduranceEffortWeight}, ten minutes per
 * working set, capped at {@link ENDURANCE_EFFORT_CAP} — which is the same
 * arithmetic a run LOGGED in ARC already gets.
 *
 * That shared scale is the point, and it is what a per-hour table of "fractional
 * sets" would have quietly broken: a 45-minute run ingested from the watch now
 * reads **exactly** as a 45-minute run typed into the logger does (quads 57,
 * calves/hamstrings 75 — the calibration pinned on `ENDURANCE_MINUTES_PER_SET`).
 * Two numbers for the same hour is precisely the second model the spike's
 * alternative (A) was rejected for.
 *
 * The cap comes free with the endurance rule: a six-hour walk reaches
 * `ENDURANCE_EFFORT_CAP` (18) × 0.25 = 4.5 units on the quads, which reads 57 —
 * a long day on the feet, not a leg day. No separate ceiling, because a second
 * ceiling is a second definition.
 *
 * Tunable. These weights are judgement, like the recovery windows and the
 * volume landmarks beside them; they are pinned in db/training-engine.test.mjs
 * so moving one is a visible decision rather than a drift.
 */
import type { Muscle } from './types';

/** One muscle an activity loads, at its role weight (1.0 primary, 0.5 assist). */
export type ActivityMuscle = { muscle: Muscle; roleWeight: number };

/** What ARC is willing to say about one HealthKit activity type. */
export type ActivityLoad =
  | { kind: 'inferred'; muscles: readonly ActivityMuscle[] }
  | { kind: 'blank' }
  | { kind: 'refused' };

const m = (muscle: Muscle, roleWeight: number): ActivityMuscle => ({ muscle, roleWeight });

/**
 * The table. Raw `HKWorkoutActivityType` values, matching `ACTIVITY_NAMES` in
 * src/lib/health/mapping.ts.
 *
 * Walking leads because it is the owner's own example and the one that sets the
 * tone for the rest: at 0.25 on the quads a 45-minute walk moves them from 100
 * to **87** — a dent you can see and would never train around. Everything else
 * is scaled against running, whose primaries sit at a full 1.0 because a run is
 * unambiguously a leg session.
 */
const ACTIVITY_MUSCLES: Record<number, readonly ActivityMuscle[]> = {
  // 52 Walking — "minorly effect the legs and not much else" (owner).
  52: [m('quads', 0.25), m('calves', 0.25), m('glutes', 0.2), m('hamstrings', 0.15)],
  // 24 Hiking — a walk with a gradient and a pack; the posterior chain works.
  24: [
    m('quads', 0.8),
    m('calves', 0.7),
    m('glutes', 0.7),
    m('hamstrings', 0.4),
    m('lower_back', 0.2),
  ],
  // 37 Running.
  37: [m('calves', 1.0), m('quads', 1.0), m('hamstrings', 0.7), m('glutes', 0.6), m('abs', 0.2)],
  // 13 Cycling — quad-dominant, and the calves barely feature.
  13: [m('quads', 1.0), m('glutes', 0.5), m('calves', 0.3), m('hamstrings', 0.3)],
  // 35 Rowing — the one cardio movement that is genuinely a pull.
  35: [
    m('lats', 0.8),
    m('upper_back', 0.8),
    m('quads', 0.7),
    m('biceps', 0.4),
    m('glutes', 0.4),
    m('lower_back', 0.4),
    m('hamstrings', 0.3),
  ],
  // 46 Swimming — upper body, and the legs are close enough to nothing to omit.
  46: [
    m('lats', 0.8),
    m('front_delts', 0.7),
    m('upper_back', 0.6),
    m('triceps', 0.5),
    m('chest', 0.4),
    m('abs', 0.3),
  ],
  // 16 Elliptical — a run with the impact taken out, so: less.
  16: [m('quads', 0.6), m('glutes', 0.4), m('calves', 0.4), m('hamstrings', 0.3)],
  // 44 Stair climbing / 68 Stairs — glutes share the lead with the quads.
  44: [m('quads', 0.9), m('glutes', 0.9), m('calves', 0.6), m('hamstrings', 0.4)],
  68: [m('quads', 0.9), m('glutes', 0.9), m('calves', 0.6), m('hamstrings', 0.4)],
  // 60 XC skiing — the only endurance type with a real triceps cost.
  60: [
    m('quads', 0.8),
    m('triceps', 0.6),
    m('lats', 0.6),
    m('glutes', 0.5),
    m('upper_back', 0.4),
    m('calves', 0.4),
  ],
  // 64 Jump rope — calves, and then a long way down to anything else.
  64: [m('calves', 1.0), m('quads', 0.5), m('front_delts', 0.2), m('forearms', 0.2)],
  // 9 Climbing — grip and pull; the legs push more than climbers admit.
  9: [
    m('lats', 1.0),
    m('forearms', 1.0),
    m('biceps', 0.8),
    m('upper_back', 0.6),
    m('abs', 0.5),
    m('quads', 0.4),
  ],
  // 61 Downhill skiing — an isometric quad day with a core bill.
  61: [m('quads', 0.9), m('glutes', 0.5), m('calves', 0.4), m('abs', 0.3)],
};

/**
 * Strength-coded types — the owner's instruction, verbatim: these *"leave a
 * blank for the user"*. They contribute NOTHING and they ASK.
 *
 * Core training (59) is the debatable one — "abs, primary" is tempting — but a
 * session coded `Core training` on a Garmin is frequently a whole circuit, so it
 * goes in the blank bucket with the other two rather than inventing an ab day.
 */
const BLANK_ACTIVITIES: ReadonlySet<number> = new Set([
  50, // Strength training
  20, // Functional strength
  59, // Core training
]);

/**
 * Types ARC refuses, and the two kinds of refusal are worth naming even though
 * they behave identically (both contribute zero, neither ever asks):
 *
 *   **An explicit zero** — a real fact, not an absence. 62 Flexibility, 33 Prep
 *   & recovery, 80 Cooldown, 29 Mind & body, 57 Yoga, 66 Pilates. A stretch is
 *   not fatigue, and pretending otherwise would depress a freshness figure the
 *   owner would then, correctly, stop trusting.
 *
 *   **No honest guess** — 63 HIIT, 28 Martial arts, 73 Mixed cardio, 11 Cross
 *   training, 69 Step training, 3000 Other. Anything unmapped lands here too, by
 *   {@link activityLoad}'s fall-through, which is what makes the table safe
 *   against an SDK that adds a type ARC has never heard of.
 */
const REFUSED_ACTIVITIES: ReadonlySet<number> = new Set([
  62,
  33,
  80,
  29,
  57,
  66, // an explicit zero
  63,
  28,
  73,
  11,
  69,
  3000, // no honest guess
]);

/**
 * Shorter than this and an ingested session contributes nothing — a floor, in
 * minutes.
 *
 * Ten, and it is not about the arithmetic: a four-minute walk already scores
 * 0.1 fatigue units on the quads, which rounds to no visible change. It is
 * about VOLUME of rows. HealthKit emits a workout object for every few minutes
 * the Watch decides you were moving, so a device holding the 90-day backfill has
 * hundreds of them, and every one would otherwise be a row the blank inbox and
 * the ledger have to reason about.
 */
export const INFERRED_MIN_MINUTES = 10;

/**
 * What ARC will say about one HealthKit activity type. Total: an unmapped raw
 * value is `refused`, never a guess and never a question.
 */
export function activityLoad(activityTypeRaw: number): ActivityLoad {
  const muscles = ACTIVITY_MUSCLES[activityTypeRaw];
  if (muscles) return { kind: 'inferred', muscles };
  if (BLANK_ACTIVITIES.has(activityTypeRaw)) return { kind: 'blank' };
  // REFUSED_ACTIVITIES is enumerated for documentation, not for the decision:
  // the fall-through already refuses everything it lists. Keeping the set means
  // the refusals a human chose are visible next to the ones nobody chose.
  return { kind: 'refused' };
}

/** Every raw activity type this table answers for — the headless tests' fixture. */
export const INFERRED_ACTIVITY_TYPES: readonly number[] = Object.keys(ACTIVITY_MUSCLES).map(Number);

/** The refusals stated by hand (as opposed to reached by fall-through). */
export const REFUSED_ACTIVITY_TYPES: readonly number[] = [...REFUSED_ACTIVITIES];

/** The strength-coded types that leave the owner a blank. */
export const BLANK_ACTIVITY_TYPES: readonly number[] = [...BLANK_ACTIVITIES];
