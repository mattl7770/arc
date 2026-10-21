import { dayStartMinutes, shiftISODate } from '@/lib/db/date';
import { expectedDayFraction, ON_PACE_BAND } from '@/lib/home/readiness';

import { fmtInt } from './format';

/**
 * **Today's intake by the hour, against the shape of his own days** — the model
 * under the Eat tab's intake curve (item 95, owner, 2026-10-21):
 *
 * > *"calorie goal could be graph with range: overall day goal is +-10% range to
 * > be good, graph showing calories and maybe protein by hour for the day vs
 * > where it should be? goal intelligently adjusts throughout the day based on
 * > what has been eated, etc"*
 *
 * Pure and DB-free (db/charts.test.mjs pins it); src/hooks/use-nutrition.ts reads
 * the meals and app/nutrition.tsx draws the result.
 *
 * ## The expected curve is LEARNED (owner's decision)
 *
 * From the {@link CURVE_WINDOW_DAYS} logical days before today, every day that
 * has timed intake contributes its own cumulative curve — the share of THAT
 * day's total eaten by the start of each hour of the logical day — and the
 * expected curve is the MEDIAN of those, hour by hour. The median, not the mean:
 * one late dinner or one fasted morning should not bend the curve for everyone
 * else. A pointwise median of non-decreasing curves is itself non-decreasing, so
 * the result is a real cumulative curve and needs no repair.
 *
 * Today is excluded — the curve is what a day of his USUALLY looks like, and
 * judging today against a curve built partly from today would grade it against
 * itself.
 *
 * **Fewer than {@link CURVE_MIN_DAYS} days → the default shape, said so.** Six
 * days of meal times is not a habit. The default is not invented here: it is
 * {@link expectedDayFraction}, the owner's own pace anchors (~15% by 10:00, ~40%
 * by 13:00, ~85% by 19:00, all of it by 21:00) that the Home pillar and the Eat
 * tab's bars already grade against. So the only two curves this screen can show
 * are his own days or the assumption the rest of the app is already making.
 *
 * ## Hours of the LOGICAL day
 *
 * Every meal is bucketed by minutes since the user's day boundary, not since
 * midnight. Under a 04:00 boundary a 01:30 snack was filed under the PREVIOUS
 * day (its `date` says so — `logicalDate` decided that when it was logged), and
 * here it lands in that day's 22nd hour, at the end of the curve where it was
 * eaten, never at the start of the day it does not belong to.
 *
 * A meal with no time has no hour. On a past day it is left out of that day's
 * shape (its share of the day is unknown, so the shares are of the TIMED total);
 * on today it is still eaten, so it counts in every figure and is drawn as a
 * step at "now" — the one instant it is certainly before.
 *
 * ## "Intelligently adjusts" — what adjusts, and what does not
 *
 * **The goal does not move.** `nutrition_targets` is a versioned daily number
 * (0015) and nothing in ARC models a goal that drifts within a day; inventing one
 * here would put a target on screen the owner never set. What adjusts as the day
 * is eaten is everything measured AGAINST the goal: what is left, the range of
 * further intake that would still land the day inside ±10% ({@link landingRange}),
 * and the pace — today's running total against the curve at this minute
 * ({@link intakePace}).
 *
 * ## ±10%, and when it applies
 *
 * Within ±{@link DAY_BAND} of the goal is on target at day's end, edges
 * inclusive ({@link bandStatus}). Before the expected curve reaches 1 the day
 * is not over, so the word is PACE (on pace / ahead / behind, with Home's own
 * {@link ON_PACE_BAND} as the threshold); once the curve has closed it is the
 * band (in range / under / over).
 */

export const CURVE_WINDOW_DAYS = 28;
export const CURVE_MIN_DAYS = 7;
export const DAY_BAND = 0.1;

const HOURS = 24;
const MINUTES_PER_DAY = 1440;
/** Same slack readiness.ts gives its band edges: `1.1 - 1` is not 0.1 in IEEE-754. */
const EPSILON = 1e-9;

export type CurveMetric = 'kcal' | 'protein_g';

/** The columns of a `meals` row this model reads. */
export type CurveMeal = {
  date: string;
  time: string | null;
  kcal: number | null;
  protein_g: number | null;
};

export type ExpectedCurve = {
  /**
   * 25 entries: the share of the day's goal expected by the START of each hour
   * of the logical day — `shares[0]` is 0 at the boundary, `shares[24]` is 1 at
   * the next one.
   */
  shares: number[];
  /** Whose shape this is — his own days, or the app's default assumption. */
  source: 'learned' | 'default';
  /** Days with timed intake in the window — what was learned from, or how
   *  short of {@link CURVE_MIN_DAYS} it fell. */
  days: number;
};

/**
 * `"HH:MM"` → minutes since the day boundary (0–1439), or null for a missing or
 * malformed clock. Strict: the schema's GLOB checks the shape and not the hours
 * (src/lib/nutrition/meal-time.ts), so `99:99` must not land on a chart.
 */
export function minuteOfLogicalDay(time: string | null, dayStartsAt: string): number | null {
  if (time === null) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return (h * 60 + m - dayStartMinutes(dayStartsAt) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** A meal's value, rounded per ROW the way `sumRounded` rounds the day's ledger
 *  (src/lib/nutrition/remaining.ts) — so the running total this draws ends on
 *  exactly the figure the Today corner prints, never one off it. NULL, negative
 *  and non-finite contribute nothing. */
function valueOf(meal: CurveMeal, metric: CurveMetric): number {
  const v = meal[metric];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/** One day's timed intake by hour of the logical day — 24 buckets. Untimed
 *  meals and NULL values contribute nothing. */
export function hourlyTotals(
  meals: CurveMeal[],
  metric: CurveMetric,
  dayStartsAt: string
): number[] {
  const buckets = new Array<number>(HOURS).fill(0);
  for (const meal of meals) {
    const minute = minuteOfLogicalDay(meal.time, dayStartsAt);
    if (minute === null) continue;
    const hour = Math.floor(minute / 60);
    buckets[hour] = (buckets[hour] ?? 0) + valueOf(meal, metric);
  }
  return buckets;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The default shape: the owner's pace anchors (src/lib/home/readiness.ts),
 * sampled at the start of each hour of the logical day. Running-max'd so a
 * boundary placed after the first anchor (which `expectedDayFraction` reads as
 * midnight) still yields a cumulative curve.
 */
export function defaultCurve(dayStartsAt: string, days = 0): ExpectedCurve {
  const boundary = dayStartMinutes(dayStartsAt);
  const shares: number[] = [0];
  for (let h = 1; h < HOURS; h++) {
    const at = new Date(2000, 0, 1, 0, boundary + h * 60, 0, 0);
    shares.push(Math.max(shares[h - 1]!, expectedDayFraction(at, dayStartsAt)));
  }
  shares.push(1);
  return { shares, source: 'default', days };
}

/**
 * The expected cumulative curve for `metric`, learned from the
 * {@link CURVE_WINDOW_DAYS} logical days before `today` — or the default shape,
 * labelled as such, when fewer than {@link CURVE_MIN_DAYS} of them have timed
 * intake. `meals` may hold any days; only the window is read.
 */
export function learnCurve(
  meals: CurveMeal[],
  metric: CurveMetric,
  today: string,
  dayStartsAt: string
): ExpectedCurve {
  const window = new Set<string>();
  for (let k = 1; k <= CURVE_WINDOW_DAYS; k++) window.add(shiftISODate(today, -k));

  const byDate = new Map<string, CurveMeal[]>();
  for (const meal of meals) {
    if (!window.has(meal.date)) continue;
    const list = byDate.get(meal.date) ?? [];
    list.push(meal);
    byDate.set(meal.date, list);
  }

  const dayCurves: number[][] = [];
  for (const dayMeals of byDate.values()) {
    const buckets = hourlyTotals(dayMeals, metric, dayStartsAt);
    const total = buckets.reduce((a, b) => a + b, 0);
    if (total <= 0) continue;
    const curve = [0];
    let running = 0;
    for (let h = 0; h < HOURS; h++) {
      running += buckets[h]!;
      curve.push(running / total);
    }
    curve[HOURS] = 1;
    dayCurves.push(curve);
  }

  if (dayCurves.length < CURVE_MIN_DAYS) return defaultCurve(dayStartsAt, dayCurves.length);
  const shares: number[] = [];
  for (let h = 0; h <= HOURS; h++) shares.push(median(dayCurves.map((c) => c[h]!)));
  return { shares, source: 'learned', days: dayCurves.length };
}

/** The curve's share at `minute` of the logical day, linear within the hour. */
export function expectedShareAt(curve: ExpectedCurve, minute: number): number {
  if (minute <= 0) return curve.shares[0]!;
  if (minute >= MINUTES_PER_DAY) return 1;
  const h = Math.floor(minute / 60);
  const frac = (minute - h * 60) / 60;
  const a = curve.shares[h]!;
  const b = curve.shares[h + 1]!;
  return a + frac * (b - a);
}

/** Minutes since the boundary for an instant — "now" on the same axis as the meals. */
export function minuteOfNow(now: Date, dayStartsAt: string): number {
  return (
    (now.getHours() * 60 + now.getMinutes() - dayStartMinutes(dayStartsAt) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY
  );
}

export type IntakeStep = { minute: number; kcal: number; protein_g: number };

export type TodayIntake = {
  /** The running total after each timed meal, in eating order; meals at one
   *  minute merge into one step. Starts with nothing — the line's first point
   *  is the caller's to place at the axis start. */
  steps: IntakeStep[];
  /** Meals with no clock time: eaten, counted, drawn at now. */
  untimed: { count: number; kcal: number; protein_g: number };
  /** Everything eaten today, timed or not — the figure the hero's ledger shows. */
  total: { kcal: number; protein_g: number };
};

export function todayIntake(meals: CurveMeal[], dayStartsAt: string): TodayIntake {
  const timed: { minute: number; kcal: number; protein_g: number }[] = [];
  const untimed = { count: 0, kcal: 0, protein_g: 0 };
  for (const meal of meals) {
    const minute = minuteOfLogicalDay(meal.time, dayStartsAt);
    const kcal = valueOf(meal, 'kcal');
    const protein = valueOf(meal, 'protein_g');
    if (minute === null) {
      untimed.count += 1;
      untimed.kcal += kcal;
      untimed.protein_g += protein;
    } else {
      timed.push({ minute, kcal, protein_g: protein });
    }
  }
  timed.sort((a, b) => a.minute - b.minute);
  const steps: IntakeStep[] = [];
  let kcal = 0;
  let protein = 0;
  for (const t of timed) {
    kcal += t.kcal;
    protein += t.protein_g;
    const last = steps[steps.length - 1];
    if (last && last.minute === t.minute) {
      last.kcal = kcal;
      last.protein_g = protein;
    } else {
      steps.push({ minute: t.minute, kcal, protein_g: protein });
    }
  }
  return {
    steps,
    untimed,
    total: { kcal: kcal + untimed.kcal, protein_g: protein + untimed.protein_g },
  };
}

/**
 * The hours the chart spans, as `[start, end]` minutes of the logical day on
 * whole hours: from an hour before eating usually starts (or today's first
 * meal, or now, whichever is earliest) to an hour after the curve closes (or
 * today's last meal, or now). The small hours of a 24-hour axis are empty on
 * nearly every day, and drawing them would spend a third of the width on sleep.
 */
export function chartWindow(
  curve: ExpectedCurve,
  steps: IntakeStep[],
  nowMinute: number
): [number, number] {
  let first = HOURS;
  let last = 0;
  for (let h = 0; h < HOURS; h++) {
    if (curve.shares[h + 1]! > 0.005) {
      first = h;
      break;
    }
  }
  for (let h = 0; h <= HOURS; h++) {
    if (curve.shares[h]! >= 0.995) {
      last = h;
      break;
    }
  }
  const nowHour = Math.floor(nowMinute / 60);
  for (const step of steps) {
    const h = Math.floor(step.minute / 60);
    first = Math.min(first, h);
    last = Math.max(last, h + 1);
  }
  first = Math.min(first, nowHour);
  last = Math.max(last, nowHour + 1);
  return [Math.max(0, first - 1) * 60, Math.min(HOURS, last + 1) * 60];
}

export type BandStatus = 'under' | 'in' | 'over';

/** Where a finished day sits against ±{@link DAY_BAND} of its goal — edges in. */
export function bandStatus(eaten: number, goal: number): BandStatus {
  const off = eaten / goal - 1;
  if (off < -DAY_BAND - EPSILON) return 'under';
  if (off > DAY_BAND + EPSILON) return 'over';
  return 'in';
}

/** How much MORE would land the day inside the band: `[min, max]`, each
 *  floored at 0. `max === 0` means the day is already past the band's top. */
export function landingRange(eaten: number, goal: number): { min: number; max: number } {
  return {
    min: Math.max(0, goal * (1 - DAY_BAND) - eaten),
    max: Math.max(0, goal * (1 + DAY_BAND) - eaten),
  };
}

export type PaceWord = 'on pace' | 'ahead' | 'behind' | 'in range' | 'under' | 'over';

export type IntakePace = {
  word: PaceWord;
  /** The curve's figure at this minute: goal × expected share. */
  expectedNow: number;
  /** Eaten minus `expectedNow` — or minus the goal once the curve has closed. */
  delta: number;
  /** True once the expected curve has reached 1: the band speaks, not the pace. */
  closed: boolean;
};

export function intakePace(eaten: number, goal: number, expectedShare: number): IntakePace {
  const expectedNow = goal * expectedShare;
  const closed = expectedShare >= 1 - EPSILON;
  if (closed) {
    const status = bandStatus(eaten, goal);
    return {
      word: status === 'in' ? 'in range' : status,
      expectedNow,
      delta: eaten - goal,
      closed,
    };
  }
  const deviation = (eaten - expectedNow) / goal;
  const word: PaceWord =
    Math.abs(deviation) <= ON_PACE_BAND + EPSILON ? 'on pace' : deviation > 0 ? 'ahead' : 'behind';
  return { word, expectedNow, delta: eaten - expectedNow, closed };
}

/**
 * The folded line's words — the one sentence the Eat tab shows until the chart
 * is opened. Whole kcal (or g), with the deviation named in the direction it
 * runs: "on pace", "180 kcal ahead", "240 kcal behind", and once the curve has
 * closed, "in range", "300 kcal under range", "250 kcal over range".
 */
export function paceWords(pace: IntakePace, unit: string): string {
  const amount = `${fmtInt(Math.abs(pace.delta))} ${unit}`;
  switch (pace.word) {
    case 'on pace':
    case 'in range':
      return pace.word;
    case 'ahead':
    case 'behind':
      return `${amount} ${pace.word}`;
    case 'under':
    case 'over':
      return `${amount} ${pace.word} range`;
  }
}

/** A minute of the logical day → its wall clock `"HH:MM"`. Hermes has no Intl. */
export function clockAt(minute: number, dayStartsAt: string): string {
  const clock =
    (((dayStartMinutes(dayStartsAt) + Math.round(minute)) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  return `${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}`;
}
