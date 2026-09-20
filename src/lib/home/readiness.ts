/**
 * Readiness derivation — the seam that replaces Home's mock readiness/pillars/
 * metrics with real `wearable_data` (docs/wearables-subapp.md §6).
 *
 * PURE over the {@link Database} interface (headless-tested in
 * db/readiness.test.mjs). Deterministic, documented thresholds — no model call;
 * the Coach interprets, this derives. Evidence gates everywhere: a verdict
 * needs a ≥{@link BASELINE_MIN_DAYS}-day baseline or it is `unknown`, and every
 * missing signal renders as an honest gap ("—"), never a fake number.
 *
 * Data comes through the wearables repo's source-arbitrated day picks, so a
 * manual keypad HRV counts when it is all there is, and an Apple Watch (or a
 * future ring) wins when both exist. **Strain is the exception and reads ARC's
 * own logged sets** (2026-08-25, owner: *"switch to ARC computing"*) — see
 * {@link strainVerdict}. Sleep and recovery still need a wearable; strain does
 * not need one at all.
 */
import type { Database } from '@/lib/db/database';
import { dayStartMinutes, getDayStartsAt, shiftISODate, todayISODate } from '@/lib/db/date';
import {
  currentTrip,
  isTimezoneChangedDay as timezoneChangedDayOnRecord,
} from '@/lib/db/repositories/day-meta';
import { formatUtcOffset } from '@/lib/timezone/classify';
import { baselineExclusionsIn, hasExclusionSource } from './baseline-exclusions';
import {
  dailyMetricSeries,
  deviceLabel,
  pickDailyMetric,
  type DailyMetricPoint,
} from '@/lib/db/repositories/wearables';
import { activeNutritionTargets, todayTotals } from '@/lib/db/repositories/nutrition';
import { dailyMuscleSetLoad } from '@/lib/db/repositories/training-stats';
import { getGoalDirection } from '@/lib/db/repositories/user';
import type { GoalDirection } from '@/lib/user/types';
import type { Metric, Pillar, Readiness, SignalLevel } from '@/types/home';

/** Days of history a baseline is computed over (today excluded). */
export const BASELINE_WINDOW_DAYS = 30;
/** Minimum baseline days before any verdict — n=2 baselines are noise. */
export const BASELINE_MIN_DAYS = 5;
/**
 * Prior LOGGED SESSIONS strain needs before it grades anything.
 *
 * Sessions, not days, because strain's baseline is "your usual session" and a
 * rest day teaches it nothing about that. Five is {@link BASELINE_MIN_DAYS}'s
 * argument applied to the right population: an n=2 idea of a usual session is
 * noise, and on a four-day-a-week split five sessions is a little over a
 * fortnight from a standing start.
 */
export const STRAIN_MIN_SESSIONS = 5;

/**
 * What Apple Health can deliver **in this binary** — three different facts that
 * an empty pillar cannot tell apart on its own, and which the reader needs
 * distinguished (00-design-spec.md §5: "no signal yet" and "not connected" are
 * not the same state).
 *
 *   - `unsupported` — the native module is not in this build. NOTHING can
 *     arrive, however well the vendor app is syncing into Apple Health. ARC was
 *     in this state from the pipeline being written (2026-07-29) until the
 *     owner's EAS rebuild (2026-08-25), which put `@kingstinct/react-native-
 *     healthkit` in the binary. It remains reachable — a dev client or a
 *     simulator build predating the module still lands here — so the state and
 *     its copy stay, but it should no longer be what the owner's phone reports.
 *   - `disconnected` — the module is here, the user has not switched sync on.
 *   - `connected` — sync is on; an empty metric is a real gap, not a wiring one.
 *
 * Passed IN rather than read here, so this module stays pure over
 * {@link Database} and never touches the native seam (a static native import
 * under a path Expo Router can reach is an app-startup crash).
 */
export type HealthLink = 'unsupported' | 'disconnected' | 'connected';

export type ReadinessOptions = {
  /** What the Apple Health link can deliver; defaults to `connected`. */
  link?: HealthLink;
  /** Local wall clock — injectable so the headless tests are deterministic. */
  now?: Date;
};

export type ReadinessView = {
  readiness: Readiness;
  pillars: Pillar[];
  metrics: Metric[];
  /** False when not a single wearable signal exists — Home's first-run state. */
  hasSignal: boolean;
  /**
   * How many days in the baseline window a STATUS barred (0061). Reported, not
   * merely applied: the owner's Q3(a) is "yes, while open — **and Home and the
   * Coach say how many days are excluded**", because a baselines change nobody
   * can see is the forgotten-open-status failure mode wearing a new hat. Zero
   * on the ordinary day, and Home's line prints the clause only above zero.
   *
   * It counts every status day, excusing or not — see
   * src/lib/home/baseline-exclusions.ts for why those are different questions.
   */
  excludedStatusDays: number;
  /**
   * Days of evidence Recovery is still short of a verdict — already computed
   * here for the pillar's own note, surfaced so Home's status line can escalate
   * from *"baselines exclude N status days"* to *"no recovery verdict until it
   * ends"* at the moment it stops being able to grade. Zero when it can.
   */
  recoveryDaysRemaining: number;
};

const LEVEL_ORDER: SignalLevel[] = ['optimal', 'good', 'caution', 'poor'];

function worse(a: SignalLevel, b: SignalLevel): SignalLevel {
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b;
}

function degrade(level: SignalLevel): SignalLevel {
  const index = LEVEL_ORDER.indexOf(level);
  return index === -1 ? level : (LEVEL_ORDER[Math.min(index + 1, 3)] ?? level);
}

/** HRV today/baseline ratio → recovery level (spec §6). */
export function hrvLevel(ratio: number): SignalLevel {
  if (ratio >= 0.97) return 'optimal';
  if (ratio >= 0.9) return 'good';
  if (ratio >= 0.8) return 'caution';
  return 'poor';
}

/** RHR delta (bpm over baseline) → level, when HRV is absent. */
export function rhrLevel(delta: number): SignalLevel {
  if (delta <= 0) return 'optimal';
  if (delta <= 3) return 'good';
  if (delta <= 7) return 'caution';
  return 'poor';
}

/** Asleep minutes → sleep level. */
export function sleepLevel(minutes: number): SignalLevel {
  if (minutes >= 450) return 'optimal';
  if (minutes >= 390) return 'good';
  if (minutes >= 330) return 'caution';
  return 'poor';
}

// --- Strain -------------------------------------------------------------------
//
// Until 2026-08-25 this pillar was `yesterday's active_energy_kcal ÷ the mean of
// the prior 29 days`, and the owner's fix is one sentence: *"switch to ARC
// computing"*. Active energy is a CALORIE-BURN proxy, and a hard resistance
// session burns few calories — so on the morning after a back day the muscle
// figure reported lats at 27% freshness while this pillar, three inches above it
// on the same screen, read `optimal / fresh`. Two readings of one body
// contradicting each other, and the wrong one was the one made of calories.
//
// Strain now reads ARC's own logged training volume (`dailyMuscleSetLoad`) —
// the SAME substrate the freshness engine reads, which is precisely why the two
// can no longer disagree. It needs no HealthKit and no network.

/**
 * Yesterday's load vs a usual day → strain level (low load = fresh).
 *
 * ## What the ratio is, and why the bands did not move
 *
 * The input is now `yesterday's role-weighted sets ÷ the mean over PRIOR
 * TRAINING DAYS in the window` (see {@link strainVerdict}), possibly raised by
 * the active-energy ratio. Training days, not calendar days: a mean that
 * averages rest days in makes every session look enormous — on a four-day split
 * a typical session would land at ~1.75× and read `poor` every single time it
 * happened, which is a thermometer that only knows one temperature. Over
 * training days the ratio has the property the bands were written for: **1.0 is
 * your average session.**
 *
 * That is what the retired energy ratio also meant, so these thresholds are
 * unchanged from the ones they were tuned to. The calibration below is the
 * specification — retuning means coming here and saying so — and the
 * representative days are pinned in db/readiness.test.mjs §6.
 *
 * At ~2.0 units per compound set (one primary + two secondaries), against a
 * baseline of a 12-set / 24-unit usual session:
 *
 *   - rest day, nothing logged .............. 0.00 → `optimal`
 *   - 6-set accessory day (9 units) ......... 0.38 → `optimal`
 *   - 12-set usual session (24 units) ....... 1.00 → `good`
 *   - 17-set back day (34 units) ............ 1.42 → `caution`
 *   - 25-set marathon (50 units) ............ 2.08 → `poor`
 *
 * The floor is genuinely reachable now in a way it never was for calories — a
 * rest day is exactly 0, where a resting body still burns half its average
 * active energy. That is the intended reading: a rest day IS low strain, and
 * accumulated fatigue is the muscle-freshness figure's job, not this pillar's.
 */
export function strainLevel(ratio: number): SignalLevel {
  if (ratio <= 0.75) return 'optimal';
  if (ratio <= 1.3) return 'good';
  if (ratio <= 1.7) return 'caution';
  return 'poor';
}

export type StrainInputs = {
  /** Role-weighted working sets logged for the graded day. 0 = nothing logged. */
  setsYesterday: number;
  /** Mean role-weighted sets over PRIOR training days; null under the gate. */
  setsBaseline: number | null;
  /** Prior training days inside the window — drives the evidence note. */
  priorSessions: number;
  /** Yesterday's active energy ÷ its own 30-day mean; null without a baseline. */
  energyRatio: number | null;
  /**
   * Was the energy mean taken over HOME days only — i.e. is an away day sitting
   * in the window (0060)? Names the cohort in the note, for the same reason
   * {@link baselineSentence} does: the sets baseline and the energy baseline are
   * two claims in one sentence, and they must not disagree about which days they
   * counted.
   *
   * **The SETS baseline is not filtered and this flag does not claim it is.**
   * `priorSessions` has a row only on days that were trained, so it already IS
   * the session population, and a travel week's sessions were real sessions. It
   * is the named exception to "every baseline excludes away days", not an
   * oversight.
   */
  energyHomeDaysOnly?: boolean;
};

/**
 * The strain pillar — graded on ARC's logged volume, with active energy allowed
 * to RAISE the reading and never to lower it.
 *
 * ## Why energy is still here, and exactly what it may do
 *
 * Sets cannot see a two-hour hike; calories cannot see a heavy triple. Each
 * instrument sees part of the load and neither sees all of it, so the honest
 * composite of the two is the LARGER — `max(setsRatio, energyRatio)` — not a
 * blend. A blend would average a hard lifting day's 1.0 against its unremarkable
 * 0.85 of calories and report 0.93, which is the retired defect wearing a new
 * coat.
 *
 * The `max` is one-directional by construction: it can only ever add strain the
 * sets could not see, and can never subtract strain the sets did see. That is
 * the whole argument for admitting it. It also quietly covers the session
 * someone trained and forgot to log — an unlogged hour in a gym is still a
 * calorie spike, so the pillar does not confidently report `optimal` at it.
 *
 * **ARC's volume is primary in the strict sense**: without a sets baseline
 * there is no verdict, even when a full year of active energy is sitting there.
 * Energy alone is the reading the owner rejected; it is a second opinion here,
 * never the first.
 */
export function strainVerdict(inputs: StrainInputs): { level: SignalLevel; note?: string } {
  const { setsYesterday, setsBaseline, priorSessions, energyRatio } = inputs;
  const energyHomeDaysOnly = inputs.energyHomeDaysOnly ?? false;

  if (setsBaseline === null || setsBaseline <= 0) {
    // Deliberately never mentions Apple Health. Strain reads ARC's own sets, so
    // an absent HealthKit module is not why this is blank, and saying it was
    // would send the reader to a switch that would change nothing.
    if (priorSessions === 0) return { level: 'unknown', note: 'no training logged in ARC yet' };
    const remaining = Math.max(0, STRAIN_MIN_SESSIONS - priorSessions);
    const sessions = remaining === 1 ? 'session' : 'sessions';
    return { level: 'unknown', note: `${remaining} more logged ${sessions} before a baseline` };
  }

  const setsRatio = setsYesterday / setsBaseline;
  const ratio = energyRatio === null ? setsRatio : Math.max(setsRatio, energyRatio);
  return {
    level: strainLevel(ratio),
    note: strainNote(setsYesterday, setsRatio, energyRatio, energyHomeDaysOnly),
  };
}

/**
 * What the strain reading rests on, in one clause — naming the input that
 * DECIDED the level, not merely the larger of the two.
 *
 * Energy takes the line only when it actually moved the verdict. Otherwise a
 * quiet rest day would read "active energy 30% below your 30-day baseline"
 * purely because 0.70 outranks a zero it agrees with, which explains a number
 * nobody asked about instead of the plain fact that nothing was trained.
 */
function strainNote(
  setsYesterday: number,
  setsRatio: number,
  energyRatio: number | null,
  energyHomeDaysOnly: boolean
): string {
  if (
    energyRatio !== null &&
    energyRatio > setsRatio &&
    strainLevel(energyRatio) !== strainLevel(setsRatio)
  ) {
    return `active energy ${baselineSentence(energyRatio, energyHomeDaysOnly)}`;
  }
  // Not "a rest day": ARC knows nothing was LOGGED, which is a different fact.
  if (setsYesterday === 0) return 'no training logged yesterday';
  return `${fmtRatio(setsRatio)}× your usual session`;
}

// --- Nutrition ----------------------------------------------------------------
//
// Reworked twice. Until 2026-08-14 the pillar was `todayTotals(db, today)
// .mealCount > 0 ? 'good' : 'unknown'` — logging ONE meal scored 'good', which
// is a fact about whether the app was opened. What replaced it graded against
// the versioned targets (`nutrition_targets`, 0015) but only two things could
// fire before 20:00 — a >10% overshoot and a met protein target — so on an
// ordinary day the cell showed a page-coloured mark and an em-dash from waking
// until dinner. The owner's verdict (2026-09-14): *"It provides almost no value
// right now; it only triggers late in the day and doesn't take in account my
// full goal (currently, exceeding my calorie goal is a good thing)."*
//
// C7 answers both halves: direction-aware bands (below) and an expected-by-now
// PACE curve, so the pillar transmits from mid-morning and says in words what
// pace it graded against. Design and the alternatives rejected:
// docs/spikes/nutrition-verdict.md (Model A, approved).

/**
 * Band tolerances as fractions off target — `[optimal, good, caution]`, and
 * anything past the third is `poor`. Each direction gets a LOOSE side (the way
 * it is deliberately moving) and a TIGHT side (the way it is not).
 *
 * The owner's decision, in his numbers: **while gaining, +20% is optimal, +35%
 * is still good, +50% is caution, beyond that is poor** — and mirrored for
 * cutting, where under target is the point and over target is the fault.
 * `maintain` is symmetric and is EXACTLY the `Math.abs` band this pillar graded
 * with before C7, which is what makes `maintain` the no-change default.
 *
 * Two judgment calls inside {@link LOOSE}, both deliberate and both the owner's:
 *
 *   - **The loose side is not unbounded.** A 3,700-kcal day on a 2,400 target is
 *     a binge whatever the goal, and a pillar that says `optimal` to anything
 *     above target has stopped being an instrument. The line is +50%.
 *   - **The loose side still punishes a large miss in its own direction.** A 40%
 *     deficit is not a good cutting day. The band is wide, not one-sided.
 *
 * This table is the SPECIFICATION — retuning means coming here and saying so,
 * the discipline {@link strainLevel}'s ladder already sets — and it is pinned
 * row by row in db/readiness.test.mjs §10.
 */
type Tolerance = readonly [optimal: number, good: number, caution: number];
const LOOSE: Tolerance = [0.2, 0.35, 0.5];
const TIGHT: Tolerance = [0.02, 0.1, 0.2];
const EVEN: Tolerance = [0.1, 0.2, 0.3];

const KCAL_BANDS: Record<GoalDirection, { under: Tolerance; over: Tolerance }> = {
  gain: { under: TIGHT, over: LOOSE },
  cut: { under: LOOSE, over: TIGHT },
  maintain: { under: EVEN, over: EVEN },
};

/**
 * A band edge is a specification, not a float accident: `1.1 - 1` is
 * `0.10000000000000009` in IEEE-754, so a ratio of exactly 1.10 would fall out
 * of a `<= 0.10` band and grade one step worse than the table says. Every band
 * comparison here is slack by this much.
 */
const BAND_EPSILON = 1e-9;

/**
 * Intake vs target → level, **in the direction the user is actually going**.
 *
 * The `Math.abs` this replaced was the owner's second complaint entire: a
 * bulking day at 2,800 against a 2,400 target — a good day — graded `good` at
 * best and `poor` at 3,200. The same ratio of 1.17 now reads `caution` while
 * cutting, `good` while maintaining and `optimal` while gaining, which is his
 * sentence made arithmetic.
 *
 * `ratio` is the projected end-of-day ratio, not raw intake ÷ target — see
 * {@link paceRatio}. At the day's close the two are identical, which is why the
 * table above can be read as a plain statement about a finished day.
 */
export function kcalLevel(ratio: number, direction: GoalDirection = 'maintain'): SignalLevel {
  const band = KCAL_BANDS[direction];
  const off = ratio - 1;
  const tolerance = off < 0 ? band.under : band.over;
  const magnitude = Math.abs(off);
  if (magnitude <= tolerance[0] + BAND_EPSILON) return 'optimal';
  if (magnitude <= tolerance[1] + BAND_EPSILON) return 'good';
  if (magnitude <= tolerance[2] + BAND_EPSILON) return 'caution';
  return 'poor';
}

/**
 * Protein vs target → level. One-sided on purpose, unlike calories: overshooting
 * a protein target is not a failure in ANY of the three directions, so there is
 * no upper band and no direction argument.
 */
export function proteinLevel(ratio: number): SignalLevel {
  if (ratio >= 1 - BAND_EPSILON) return 'optimal';
  if (ratio >= 0.85 - BAND_EPSILON) return 'good';
  if (ratio >= 0.7 - BAND_EPSILON) return 'caution';
  return 'poor';
}

/**
 * The share of the day's target a normal day has taken by each hour — the pace
 * curve, **linearly interpolated between these anchors and nowhere else**.
 *
 * The owner's numbers: ~15% eaten by 10:00, ~40% by 13:00, ~85% by 19:00. The
 * fourth anchor closes the day: at 21:00 the whole target is expected, and
 * `expected === 1` is what "the day is closed" means everywhere below — the flat
 * `NUTRITION_DAY_CLOSE_HOUR = 20` gate this replaced is gone.
 *
 * **Before the first anchor there is no grade.** The denominator would be zero
 * and a verdict built on it would be invented; the pillar says so in words
 * instead (`nothing expected yet — the pace clock starts at 10:00`). That is the
 * same refusal the Eat tab's own hero makes (src/lib/nutrition/remaining.ts).
 *
 * **The curve is an assumption and the note always names it.** It assumes a
 * three-meal day with lunch around one and dinner around seven; a fast or a
 * late-dinner day reads behind pace for a few hours and recovers by evening. The
 * note states the number it graded against precisely so that reading is
 * reversible by eye rather than by reverse-engineering. Like {@link strainLevel}
 * these anchors are the specification: retuning means editing this table.
 */
export const PACE_ANCHORS = [
  { at: '10:00', share: 0.15 },
  { at: '13:00', share: 0.4 },
  { at: '19:00', share: 0.85 },
  { at: '21:00', share: 1 },
] as const;

/** `"HH:MM"` → minutes past local midnight. The anchors are authored, so this cannot fail. */
function clockMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** A `Date` → its local `"HH:MM"`. Hermes has no `Intl`; this is the whole formatter. */
function fmtClock(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/**
 * How much of the day's target is expected by `now` — 0 before the first anchor,
 * 1 once the day has closed, interpolated in between.
 *
 * **Measured from the user's day boundary, not from midnight** (B3). The anchors
 * are wall-clock MEAL times and stay where they are; what the boundary decides is
 * where the day *starts*, and therefore which side of the last anchor a small-
 * hours instant falls on. With a 04:00 boundary, 02:00 is 22 hours into the
 * logical day and the eating day is over (`1`), where a naive wall-clock reading
 * would call it 0 and go quiet on a day that has already finished.
 *
 * A boundary LATER than the first anchor cannot be rebased onto a curve of meal
 * times — a day that starts after breakfast has none — and is read as midnight.
 * Nothing in the app can produce one today; the clamp is here so the
 * interpolation can never run over a non-monotonic anchor list.
 */
export function expectedDayFraction(now: Date, dayStartsAt: string = getDayStartsAt()): number {
  const first = clockMinutes(PACE_ANCHORS[0].at);
  const boundary = dayStartMinutes(dayStartsAt);
  const base = boundary <= first ? boundary : 0;
  const offsetOf = (hhmm: string) => (clockMinutes(hhmm) - base + 1440) % 1440;

  const elapsed = (now.getHours() * 60 + now.getMinutes() - base + 1440) % 1440;
  if (elapsed < offsetOf(PACE_ANCHORS[0].at)) return 0;
  for (let i = 1; i < PACE_ANCHORS.length; i++) {
    const prev = PACE_ANCHORS[i - 1]!;
    const next = PACE_ANCHORS[i]!;
    const from = offsetOf(prev.at);
    const to = offsetOf(next.at);
    if (elapsed <= to) {
      return prev.share + ((elapsed - from) / (to - from)) * (next.share - prev.share);
    }
  }
  return 1;
}

/**
 * **The projected end-of-day ratio if the rest of the day goes to plan** —
 * `(eaten + the share still expected) ÷ target`. The one number both halves of
 * the pillar are graded on.
 *
 * ## Why not the obvious `eaten ÷ expected-by-now`
 *
 * Because its denominator is tiny in the morning and the ratio explodes. A
 * 700-kcal breakfast on a 2,400 target at 10:00 is 1.94× the 360 kcal expected
 * by then, which lands in `poor` in every direction — a thermometer that only
 * knows one temperature, which is the exact defect {@link strainLevel} was
 * rewritten to escape when its baseline averaged rest days in. A 700-kcal
 * breakfast is not a bad day; it is a breakfast.
 *
 * Measuring the gap as a share of the DAY's budget instead keeps one constant
 * denominator all day, which is the scale the bands above were written for: the
 * same breakfast reads +14% of the day's budget ahead, `good` on maintain and
 * `optimal` on gain. And at the close (`expected === 1`) the whole expression
 * collapses to `eaten ÷ target`, so the band table means exactly what it says
 * about a finished day.
 */
export function paceRatio(eaten: number, target: number, expected: number): number {
  return (eaten + target * (1 - expected)) / target;
}

/** A target is usable only if it is a positive number — a 0 target is no target. */
function usableTarget(value: number | null | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null;
}

/**
 * One step BETTER, and only from a borderline reading. `optimal` has nowhere to
 * go; `poor` is not borderline and does not get rescued — which is the surviving
 * half of the old rule that *"a hit protein target cannot paper over a 900-kcal
 * overshoot"*.
 */
function lift(level: SignalLevel): SignalLevel {
  if (level === 'good') return 'optimal';
  if (level === 'caution') return 'good';
  return level;
}

/**
 * Deviation within this share of the day's budget reads as "on pace" in the
 * note — a twentieth, so ~120 kcal on a 2,400 target.
 *
 * It is a WORD, not a band: the level comes from {@link kcalLevel} and this only
 * decides whether the sentence opens "On pace" or "Behind pace". 120 kcal is
 * inside the resolution of the logging itself (a portion estimate is ±10% on its
 * own), so calling that difference a direction of travel would be reading noise
 * aloud.
 */
const ON_PACE_BAND = 0.05;

export type NutritionTotals = { kcal: number; protein_g: number; mealCount: number };
export type NutritionTargets = { kcal: number | null; protein_g: number | null };

export type NutritionInputs = {
  totals: NutritionTotals;
  targets: NutritionTargets | null;
  /** From `users.preferences.goals.direction`; `maintain` when unset. */
  direction: GoalDirection;
  /** {@link expectedDayFraction} — 0 before the first anchor, 1 once closed. */
  expected: number;
  /** Local wall clock `"HH:MM"` — the note names the hour it graded against. */
  clock: string;
  /**
   * D4 seam. A day the device changed timezone on is 23, 25 or 31 hours long and
   * its target is not the target it was set for; see
   * {@link isTimezoneChangedDay}.
   */
  timezoneChanged?: boolean;
};

/**
 * The nutrition pillar — graded against the user's targets, in the direction he
 * is going, at the pace a normal day keeps.
 *
 * ## The states it must keep apart
 *
 *   - **Timezone changed today.** A 31-hour day cannot be judged against a
 *     24-hour target, so it is not judged at all (docs/spikes/timezone-days.md
 *     §5, owner Q2(b): *"better quiet than clever"*). Checked first — it
 *     outranks everything below, because every one of those readings would be
 *     computed off the wrong denominator.
 *   - **No targets set.** Nothing to grade against, so it says so rather than
 *     inventing a denominator. `nutrition_targets` deliberately seeds no default
 *     row (0015), so this is the honest first-run state, and the fix is one tap
 *     into the targets screen — which the note names.
 *   - **Nothing logged.** Not a grade either, and it reads differently once the
 *     day has closed.
 *   - **Before the pace clock starts.** No denominator yet; see
 *     {@link PACE_ANCHORS}.
 *   - **Graded**, from the first anchor to the end of the day.
 *
 * ## How calories and protein combine — the owner's rule, exactly
 *
 * Calories are the budget and protein is the floor, so the calorie level leads
 * and protein weighs on it in one of two directions:
 *
 *   1. **Protein hit → lift one step.** A projected protein ratio of ≥1 (at the
 *      close, literally the day's target met) raises a *borderline* calorie
 *      reading one step: `good` → `optimal`, `caution` → `good`. It cannot make
 *      `poor` anything else — a day 50% short on calories is not rescued by a
 *      protein shake, which is the one thing the pre-C7 rule got wrong when it
 *      returned a bare `optimal` for protein-met-at-13:00 on 1,200 of 2,400 kcal.
 *   2. **Protein missed → cap.** The pillar takes `worse(calories, protein)`,
 *      the same `worse()` every other pillar and the top-line verdict use. A met
 *      calorie budget built on 60 g of protein is not an optimal day.
 *
 * Carbs, fat and fiber are deliberately NOT graded here — a four-way `worse()`
 * reads amber on almost every real day, and a pillar that is always amber is a
 * pillar nobody reads. Composition belongs on the Eat tab's bars, where it can
 * be seen without being judged.
 */
export function nutritionVerdict(inputs: NutritionInputs): { level: SignalLevel; note?: string } {
  const { totals, targets, direction, expected, clock } = inputs;

  const kcalTarget = usableTarget(targets?.kcal);
  const proteinTarget = usableTarget(targets?.protein_g);

  // The day was not 24 hours long (D4). Show the numbers, withhold the verdict:
  // a 24-hour target judged against a 29-hour day is wrong by the length of the
  // flight, and a scaled target would invent a number the owner never set.
  if (inputs.timezoneChanged) {
    const figures =
      kcalTarget !== null && totals.mealCount > 0
        ? `${fmtInt(totals.kcal)} / ${fmtInt(kcalTarget)} kcal · `
        : '';
    return { level: 'unknown', note: `${figures}timezone changed today — not graded` };
  }

  if (kcalTarget === null && proteinTarget === null) {
    return { level: 'unknown', note: 'no daily targets set yet (Eat › Targets)' };
  }

  const closed = expected >= 1;
  if (totals.mealCount === 0) {
    return { level: 'unknown', note: closed ? 'nothing logged today' : 'nothing logged yet' };
  }
  if (expected <= 0) {
    return {
      level: 'unknown',
      note: `nothing expected yet — the pace clock starts at ${PACE_ANCHORS[0].at}`,
    };
  }

  const kcalRatio = kcalTarget === null ? null : paceRatio(totals.kcal, kcalTarget, expected);
  const proteinRatio =
    proteinTarget === null ? null : paceRatio(totals.protein_g, proteinTarget, expected);
  const kcal = kcalRatio === null ? null : kcalLevel(kcalRatio, direction);
  const protein = proteinRatio === null ? null : proteinLevel(proteinRatio);

  let level: SignalLevel;
  let proteinEffect: 'lift' | 'cap' | null = null;
  if (kcal === null) {
    level = protein!;
  } else if (protein === null) {
    level = kcal;
  } else if (protein === 'optimal') {
    level = lift(kcal);
    proteinEffect = level === kcal ? null : 'lift';
  } else {
    level = worse(kcal, protein);
    proteinEffect = level === kcal ? null : 'cap';
  }

  const clauses: string[] = [
    kcalTarget !== null
      ? paceClause(totals.kcal, kcalTarget, expected, closed, clock, 'kcal')
      : paceClause(totals.protein_g, proteinTarget!, expected, closed, clock, 'g protein'),
  ];
  if (kcalRatio !== null) {
    const named = directionClause(kcalRatio, direction);
    if (named) clauses.push(named);
  }
  if (proteinEffect !== null && proteinTarget !== null) {
    clauses.push(proteinClause(totals.protein_g, proteinTarget, proteinEffect, closed));
  }
  return { level, note: clauses.join(' · ') };
}

/**
 * What was eaten against what was expected by now, in the owner's own wording —
 * *"On pace — 1,140 of ~1,250 expected by 13:00"*.
 *
 * The `~` is not decoration: the expected figure is a point on an assumed curve
 * and printing it bare would claim a precision the curve does not have. Once the
 * day has closed there is nothing approximate left, so the clause switches to
 * the flat day figure and drops the tilde with it.
 */
function paceClause(
  eaten: number,
  target: number,
  expected: number,
  closed: boolean,
  clock: string,
  unit: string
): string {
  const expectedNow = target * expected;
  const deviation = (eaten - expectedNow) / target;
  const lead =
    Math.abs(deviation) <= ON_PACE_BAND
      ? closed
        ? 'On target'
        : 'On pace'
      : deviation > 0
        ? closed
          ? 'Over target'
          : 'Ahead of pace'
        : closed
          ? 'Under target'
          : 'Behind pace';
  return closed
    ? `${lead} — ${fmtInt(eaten)} of ${fmtInt(target)} ${unit} for the day`
    : `${lead} — ${fmtInt(eaten)} of ~${fmtInt(expectedNow)} expected by ${clock}`;
}

/**
 * The direction, named **only when it changed the reading** — `strainNote`'s
 * discipline, which names the input that decided the level rather than merely
 * the one that exists. A cutting day that grades the same as a maintaining one
 * has nothing to say about cutting.
 */
function directionClause(ratio: number, direction: GoalDirection): string | null {
  if (direction === 'maintain') return null;
  if (kcalLevel(ratio, direction) === kcalLevel(ratio, 'maintain')) return null;
  const over = ratio > 1;
  if (direction === 'gain') {
    return over ? 'ahead of target, which is the point while gaining' : 'behind target on a gain';
  }
  return over ? 'ahead of target on a cut' : 'behind target, which is the point while cutting';
}

/** Protein's effect on the level, with the numbers behind it. Printed only when it had one. */
function proteinClause(
  eaten: number,
  target: number,
  effect: 'lift' | 'cap',
  closed: boolean
): string {
  const figure = `protein ${fmtInt(eaten)} of ${fmtInt(target)} g`;
  if (effect === 'lift') {
    return `${figure} — ${closed ? 'met' : 'ahead'}, which lifts this a step`;
  }
  return `${figure} — behind, which caps this`;
}

/**
 * Whether the device changed timezone on `date` — **the D4 seam, and false
 * until D4 lands**.
 *
 * On a marked day the nutrition verdict goes quiet rather than grading: an
 * eastbound flight makes a 23-hour day and a westbound one a 25- or 31-hour day,
 * and a 24-hour calorie target judged against either is wrong by the length of
 * the flight. The owner chose quiet over clever (docs/spikes/timezone-days.md
 * §7 Q2(b)) — a scaled target would invent a number he never set.
 *
 * D4 landed the same day (migration `0053`, `src/lib/db/repositories/day-meta.ts`):
 * the foreground observer records each zone change, DST discarded at the
 * observer so there is no `kind` column for a reader to forget to filter. This
 * export is kept as the seam the verdict was written against — one name, and
 * the answer comes from the record.
 */
export function isTimezoneChangedDay(db: Database, date: string): boolean {
  return timezoneChangedDayOnRecord(db, date);
}

/** No day is excluded — the shared empty set, so the common path allocates none. */
const NO_EXCLUDED_DAYS: ReadonlySet<string> = new Set();

/**
 * The points a baseline is entitled to average — strictly before `date`, minus
 * the days ARC knows were not normal days.
 *
 * A BASELINE is a claim about what a normal day looks like for this person, so
 * a day ARC knows was not one gets no vote on it. **What counts as "not one" is
 * not decided here** — the set arrives already resolved from
 * src/lib/home/baseline-exclusions.ts, which is the one place the sources are
 * named (a seam day, an away day, and whatever is added next). This function's
 * only job is to honour it.
 *
 * The size of the distortion is why this is worth a filter rather than a shrug:
 * on HRV a long day perturbs a 30-day mean by ~3%, but on `steps` and
 * `active_energy_kcal` it is ~20% inflation before you count that an airport day
 * can be triple the step count — and active energy feeds the strain pillar's
 * `energyRatio`. An away day distorts differently and worse: it is a perfectly
 * ordinary 24 hours, so it perturbs nothing on its own and simply sits in the
 * window for a month afterwards holding the home mean down.
 *
 * **Excluded, never deleted.** The day's own reading still renders in the
 * metrics strip and still stands in every trend window (those are fixed-length
 * by construction and a long day genuinely contained more; saying so is true).
 * It is only barred from deciding what "normal" means.
 */
function baselinePoints(
  points: DailyMetricPoint[],
  date: string,
  excluded: ReadonlySet<string>
): DailyMetricPoint[] {
  return points.filter((p) => p.date < date && !excluded.has(p.date));
}

/** Mean of the points a baseline may use; null under the evidence gate. */
function baselineBefore(
  points: DailyMetricPoint[],
  date: string,
  excluded: ReadonlySet<string> = NO_EXCLUDED_DAYS
): number | null {
  const prior = baselinePoints(points, date, excluded);
  if (prior.length < BASELINE_MIN_DAYS) return null;
  return prior.reduce((sum, p) => sum + p.value, 0) / prior.length;
}

function pointOn(points: DailyMetricPoint[], date: string): DailyMetricPoint | null {
  return points.find((p) => p.date === date) ?? null;
}

/** "1840" → "1,840" without Intl (Hermes-safe; same as use-data-overview). */
function fmtInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 432 → "7h 12m". */
function fmtSleep(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

/** "+4" / "−2" style signed delta. */
function fmtDelta(delta: number): string {
  const rounded = Math.round(delta);
  return rounded >= 0 ? `+${rounded}` : `−${Math.abs(rounded)}`;
}

/** 1.4166 → "1.4". `toFixed`, not `Intl` — Hermes has no `Intl`. */
function fmtRatio(ratio: number): string {
  return ratio.toFixed(1);
}

/**
 * "14% below your 30-day baseline" | "at your 30-day baseline" | above.
 *
 * `homeDaysOnly` appends the cohort, and ONLY while an away day is actually
 * sitting in the window (0060). A baseline computed over home days is not the
 * same claim as one computed over every day, and a reader comparing this
 * morning's reading against it is entitled to know which one it is — but on the
 * 340-odd days a year where the two are identical, saying so would be noise
 * about a distinction that made no difference.
 */
function baselineSentence(ratio: number, homeDaysOnly = false): string {
  const cohort = homeDaysOnly ? ' (home days)' : '';
  const pct = Math.round(Math.abs(1 - ratio) * 100);
  if (pct < 1) return `at your 30-day baseline${cohort}`;
  return ratio < 1
    ? `${pct}% below your 30-day baseline${cohort}`
    : `${pct}% above your 30-day baseline${cohort}`;
}

/** `n` local days before a YYYY-MM-DD (src/lib/db/date.ts is the arithmetic). */
function daysBefore(date: string, n: number): string {
  return shiftISODate(date, -n);
}

/** The local day before a YYYY-MM-DD. */
function dayBefore(date: string): string {
  return daysBefore(date, 1);
}

const VERDICT_LABEL: Record<SignalLevel, string> = {
  optimal: 'Primed',
  good: 'Ready',
  caution: 'Recovery low',
  poor: 'Back off today',
  unknown: 'No recovery signal yet',
};

/**
 * How many more days of history a baseline still needs. Zero once the
 * {@link BASELINE_MIN_DAYS} gate is cleared.
 *
 * This is the direct answer to the owner's *"do some of them just need a week or
 * two of data before they start transmitting?"* — no wearable metric here needs
 * a fortnight. A baseline needs five prior days, so a verdict appears on the
 * SIXTH day of readings.
 *
 * Strain is no longer one of these: it counts SESSIONS, not days
 * ({@link STRAIN_MIN_SESSIONS}), so on a four-day split it is a little over a
 * fortnight — the one place the answer to that question is now "yes, about
 * two weeks", and only because a rest day genuinely teaches it nothing.
 */
export function baselineDaysRemaining(
  points: DailyMetricPoint[],
  date: string,
  excluded: ReadonlySet<string> = NO_EXCLUDED_DAYS
): number {
  // The SAME cohort `baselineBefore` averages, or the wait it reports would be
  // over a different population than the gate it is reporting on — and a user
  // who flew would be told "0 more days" on a morning that still has no verdict.
  const prior = baselinePoints(points, date, excluded).length;
  return Math.max(0, BASELINE_MIN_DAYS - prior);
}

/**
 * Why a derived pillar has no verdict — the authored half of an empty cell.
 *
 * The order matters: a wiring problem outranks a data problem. Telling someone
 * they need "5 more days of HRV" when the native module is not even in the
 * binary would be a true sentence pointing at the wrong thing, and they would
 * wait five days for nothing.
 */
function evidenceNote(opts: {
  link: HealthLink;
  hasHistory: boolean;
  daysRemaining: number;
  hasCurrent: boolean;
  /** What the signal is called: 'HRV or resting HR', 'activity', 'sleep'. */
  signal: string;
  /** What the current reading would cover: 'today', 'yesterday', 'last night'. */
  period: string;
  /**
   * The home offset a trip is currently away from (`"UTC−8"`), when one is open
   * AND the baseline is still filling. Undefined on every ordinary day.
   */
  pausedAwayFrom?: string;
}): string {
  if (!opts.hasHistory) {
    if (opts.link === 'unsupported') return 'Apple Health is not connected in this build';
    if (opts.link === 'disconnected') return 'Apple Health sync is switched off';
    return `no ${opts.signal} has arrived yet`;
  }
  if (opts.daysRemaining > 0) {
    const days = opts.daysRemaining === 1 ? 'day' : 'days';
    // Never let a number sit still unexplained. A baseline that is filtered to
    // home days can go BACKWARDS while a trip is open — the window keeps moving
    // and the days arriving into it do not count — so a reader watching "2 more
    // days" hold at 2 for a fortnight is owed the reason rather than left to
    // conclude the sync is broken. The clause names the OFFSET, not the person:
    // ARC observed a zone, and it cannot tell a flight from a Settings change.
    const wait =
      opts.pausedAwayFrom === undefined
        ? `${opts.daysRemaining} more ${days} of ${opts.signal} before a baseline`
        : `${opts.daysRemaining} more home ${days} of ${opts.signal} before a baseline` +
          ` — paused while away from ${opts.pausedAwayFrom}`;
    return wait;
  }
  return `no ${opts.signal} reading ${opts.period}`;
}

/** Derive the whole Home readiness view for `today`. */
export function deriveReadiness(
  db: Database,
  today: string = todayISODate(),
  options: ReadinessOptions = {}
): ReadinessView {
  const link: HealthLink = options.link ?? 'connected';
  const now = options.now ?? new Date();
  // --- Raw signals, source-arbitrated per day ------------------------------
  const hrvSeries = dailyMetricSeries(db, 'hrv', BASELINE_WINDOW_DAYS + 1, today);
  const rhrSeries = dailyMetricSeries(db, 'rhr', BASELINE_WINDOW_DAYS + 1, today);
  const hrvToday = pointOn(hrvSeries, today);
  const rhrToday = pointOn(rhrSeries, today);
  // The days that get no vote in any baseline, from every source ARC has —
  // resolved ONCE for the whole window and shared by every baseline below.
  //
  // Two sources today: a day the device's timezone changed on (D4, `24 + Δ`
  // hours long) and an away day inside a derived trip (0060, an ordinary 24
  // hours lived under someone else's sun). They are unioned behind one helper on
  // purpose — this call site used to hold the first predicate inline, and a
  // second one beside it is how a "days that don't count" rule ends up spelled
  // three different ways. A new source is a key in
  // src/lib/home/baseline-exclusions.ts and nothing here.
  const exclusions = baselineExclusionsIn(
    db,
    shiftISODate(today, -BASELINE_WINDOW_DAYS - 1),
    today,
    today
  );
  const oddDays = exclusions.days;
  // Is a baseline below computed over home days only? Drives the cohort clause
  // in the copy, and nothing else.
  const homeDaysOnly = hasExclusionSource(exclusions, 'away');
  const hrvBaseline = baselineBefore(hrvSeries, today, oddDays);
  const rhrBaseline = baselineBefore(rhrSeries, today, oddDays);

  const sleepToday = pickDailyMetric(db, 'sleep_duration_min', today);
  const deepToday = pickDailyMetric(db, 'sleep_deep_min', today);

  // Strain grades the day already COMPLETED, so its whole window ends
  // yesterday: both halves read the same BASELINE_WINDOW_DAYS days.
  const yesterday = dayBefore(today);
  const energySeries = dailyMetricSeries(db, 'active_energy_kcal', BASELINE_WINDOW_DAYS, yesterday);
  const energyYesterday = pointOn(energySeries, yesterday);
  const energyBaseline = baselineBefore(energySeries, yesterday, oddDays);

  const setLoad = dailyMuscleSetLoad(
    db,
    daysBefore(yesterday, BASELINE_WINDOW_DAYS - 1),
    yesterday
  );
  // Only trained days have a row, so this IS the session population.
  const priorSessions = setLoad.filter((d) => d.date < yesterday);
  const setsYesterday = setLoad.find((d) => d.date === yesterday)?.sets ?? 0;
  const setsBaseline =
    priorSessions.length >= STRAIN_MIN_SESSIONS
      ? priorSessions.reduce((sum, d) => sum + d.sets, 0) / priorSessions.length
      : null;

  const stepsToday = pickDailyMetric(db, 'steps', today);

  // WEARABLE signals only, and logged sets are deliberately not among them even
  // though strain now derives from them: this flag is what
  // `turn-context.ts`/`read-tools.ts` read to say "no wearable signal yet", and
  // flipping it true for someone with no watch would make Home's `detail`
  // ("Apple Health is connected but no readings have arrived") ride along beside
  // a strain reading that never wanted a wearable. The Coach reads training load
  // through `get_training_recommendation`, which is the fuller version of it.
  const hasSignal =
    hrvSeries.length > 0 ||
    rhrSeries.length > 0 ||
    sleepToday !== null ||
    stepsToday !== null ||
    energySeries.length > 0;

  // --- Pillars ---------------------------------------------------------------
  const hrvRatio = hrvToday && hrvBaseline ? hrvToday.value / hrvBaseline : null;
  const rhrDelta = rhrToday && rhrBaseline !== null ? rhrToday.value - rhrBaseline : null;

  let recovery: SignalLevel = 'unknown';
  if (hrvRatio !== null) {
    recovery = hrvLevel(hrvRatio);
    // An elevated resting HR corroborates suppression — degrade one level.
    if (rhrDelta !== null && rhrDelta >= 5) recovery = degrade(recovery);
  } else if (rhrDelta !== null) {
    recovery = rhrLevel(rhrDelta);
  }

  const sleep: SignalLevel = sleepToday ? sleepLevel(sleepToday.value) : 'unknown';
  const strain = strainVerdict({
    setsYesterday,
    setsBaseline,
    priorSessions: priorSessions.length,
    energyRatio:
      energyYesterday && energyBaseline !== null && energyBaseline > 0
        ? energyYesterday.value / energyBaseline
        : null,
    energyHomeDaysOnly: homeDaysOnly,
  });

  const targets = activeNutritionTargets(db, today);
  const nutrition = nutritionVerdict({
    totals: todayTotals(db, today),
    targets: targets ? { kcal: targets.kcal, protein_g: targets.protein_g } : null,
    direction: getGoalDirection(db),
    // The ambient day boundary (B3) — the same one that decided `today` above.
    expected: expectedDayFraction(now),
    clock: fmtClock(now),
    timezoneChanged: isTimezoneChangedDay(db, today),
  });

  // Recovery reads HRV first and falls back to RHR, so its evidence gap is
  // whichever of the two is FURTHEST along — reporting the HRV wait when RHR is
  // one day from a verdict would overstate how long is left.
  const recoveryDaysRemaining = Math.min(
    baselineDaysRemaining(hrvSeries, today, oddDays),
    baselineDaysRemaining(rhrSeries, today, oddDays)
  );
  // The open trip, read once — the home offset the evidence note names while a
  // baseline is paused. Null on a seam day and on every day at home.
  const trip = currentTrip(db, today);

  const pillars: Pillar[] = [
    {
      label: 'Sleep',
      level: sleep,
      note:
        sleep === 'unknown'
          ? evidenceNote({
              link,
              hasHistory: sleepToday !== null,
              daysRemaining: 0,
              hasCurrent: false,
              signal: 'sleep',
              period: 'last night',
            })
          : undefined,
    },
    {
      label: 'Recovery',
      level: recovery,
      note:
        recovery === 'unknown'
          ? evidenceNote({
              link,
              hasHistory: hrvSeries.length > 0 || rhrSeries.length > 0,
              daysRemaining: recoveryDaysRemaining,
              hasCurrent: hrvToday !== null || rhrToday !== null,
              signal: 'HRV or resting heart rate',
              period: 'today',
              ...(trip ? { pausedAwayFrom: formatUtcOffset(trip.homeOffsetMin) } : {}),
            })
          : undefined,
    },
    { label: 'Nutrition', level: nutrition.level, note: nutrition.note },
    { label: 'Strain', level: strain.level, note: strain.note },
  ];

  // --- Verdict -----------------------------------------------------------------
  const verdict = worse(recovery, sleep);
  let detail: string;
  if (hrvToday && hrvRatio !== null) {
    detail = `HRV ${Math.round(hrvToday.value)} ms · ${baselineSentence(hrvRatio, homeDaysOnly)}`;
  } else if (rhrToday && rhrDelta !== null) {
    detail = `Resting HR ${Math.round(rhrToday.value)} bpm · ${fmtDelta(rhrDelta)} bpm vs your 30-day baseline`;
  } else if (sleepToday) {
    detail = `${fmtSleep(sleepToday.value)} asleep last night`;
  } else if (hasSignal) {
    // Something HAS arrived — steps, active energy, or an HRV reading still
    // short of its 5-day baseline — just nothing that grades into a recovery or
    // sleep verdict yet. Falling through to the link branches here would print
    // "no readings have arrived" while the metrics strip below is simultaneously
    // showing the number that did (00-design-spec §5: the copy must never deny
    // data the screen is displaying).
    detail = 'Readings arriving — building your baseline.';
  } else if (link === 'unsupported') {
    // Runtime-derived, so it is true whenever it renders — but after the owner's
    // 2026-08-25 rebuild it should no longer render on his phone. Pointing at
    // the Settings toggle here would be a lie the user could act on and get
    // nothing from: the switch is there, the native module is not, so no amount
    // of vendor syncing into Apple Health can reach ARC.
    detail =
      'Apple Health cannot be read in this build — the HealthKit module rides the next app build. Whatever your watch or ring is syncing into Apple Health is safe there and will land here once it does.';
  } else if (link === 'disconnected') {
    detail = 'Connect Apple Health in Settings to power readiness.';
  } else {
    detail =
      'Apple Health is connected but no readings have arrived. Check Settings → Privacy & Security → Health → ARC — iOS never tells apps whether read access was granted.';
  }

  const readiness: Readiness = {
    level: verdict,
    label: VERDICT_LABEL[verdict],
    detail,
  };

  // --- Metrics strip --------------------------------------------------------------
  const metrics: Metric[] = [
    {
      id: 'sleep',
      label: 'Sleep',
      value: sleepToday ? fmtSleep(sleepToday.value) : '—',
      detail: sleepToday
        ? deepToday
          ? `Deep ${Math.round(deepToday.value)}m`
          : deviceLabel(sleepToday.sourceDevice)
        : 'No data yet',
      level: sleep,
    },
    {
      id: 'hrv',
      label: 'HRV',
      value: hrvToday ? `${Math.round(hrvToday.value)} ms` : '—',
      detail: hrvToday
        ? hrvRatio !== null
          ? baselineSentence(hrvRatio).replace(' your 30-day', '')
          : 'no baseline yet'
        : 'No data yet',
      level: hrvRatio !== null ? hrvLevel(hrvRatio) : 'unknown',
    },
    {
      id: 'rhr',
      label: 'Resting HR',
      value: rhrToday ? `${Math.round(rhrToday.value)} bpm` : '—',
      detail: rhrToday
        ? rhrDelta !== null
          ? `${fmtDelta(rhrDelta)} vs baseline`
          : 'no baseline yet'
        : 'No data yet',
      level: rhrDelta !== null ? rhrLevel(rhrDelta) : 'unknown',
    },
    {
      id: 'steps',
      label: 'Steps',
      value: stepsToday ? fmtInt(stepsToday.value) : '—',
      detail: stepsToday ? 'today' : 'No data yet',
      level: 'unknown',
    },
  ];

  return {
    readiness,
    pillars,
    metrics,
    hasSignal,
    // Read off the map the exclusions helper already built — NOT recounted, and
    // not a second query. `days` stays the only thing a baseline filters on;
    // `bySource` exists for exactly this, copy that has to name the reason.
    excludedStatusDays: exclusions.bySource.get('status')?.size ?? 0,
    recoveryDaysRemaining,
  };
}
