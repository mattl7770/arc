/**
 * Proactive trend detection — the deterministic half of the Coach's
 * intelligence (docs/ai-coach.md, "Proactive behaviors").
 *
 * Reads the real on-device data and computes notable movements as structured
 * {@link Insight}s: window-over-window trends ("HRV down 12% vs your 3-week
 * baseline"), logging gaps ("weight unlogged for 9 days"), symptom volume, and
 * a prior-day-training ↔ HRV correlation. Pure arithmetic over the
 * {@link Database} interface — no model call, fully deterministic, headless-
 * tested in db/insights.test.mjs — so every number the Coach cites from here
 * is a fact, not a generation.
 *
 * Consumed two ways, per the spec:
 *   - the `get_insights` Coach tool (the model reads these instead of eyeballing
 *     raw series), and
 *   - {@link generateDailyBrief}, the deterministic skeleton of the morning
 *     brief. (Wiring it into Home's brief card is an integrator step.)
 *
 * Thresholds are deliberately conservative — an insight that fires on noise
 * teaches the user to ignore the Coach. Each detector needs a minimum number
 * of observations before it will say anything.
 *
 * The metrics read here must track what the user's DEVICE actually produces,
 * not what a full wearable stack would. Reading only HRV and RHR made this
 * engine silent on a phone with no watch, which is the common case — see
 * {@link WEARABLE_TRENDS} and {@link wearableFloorLine}.
 */
import type { Database } from '@/lib/db/database';
import { metricByKey, resolveDisplay } from '@/lib/log/metrics';
import { listActiveReminders, isDueOn } from '@/lib/db/repositories/reminders';
import { getPreferences } from '@/lib/db/repositories/user';
import { todayISODate } from '@/lib/db/date';
import { deriveReadiness } from '@/lib/home/readiness';
import { getActiveMode } from '@/lib/db/repositories/day-modes';
import { getModeDefinition } from '@/lib/modes/registry';
import { activeExperiments } from '@/lib/db/repositories/experiments';
import { activeNutritionTargets } from '@/lib/db/repositories/nutrition';
import type { ReminderRow } from '@/lib/reminders/types';
import type { UnitPreferences } from '@/lib/user/types';
import {
  bodyDailySeries,
  endOfLocalDayUtc,
  isoDatePlusDays,
  isoDaysAgo,
  mean,
  nutritionDailyTotals,
  pearson,
  round1,
  trainingDailyTotals,
  wearableArbitratedSeries,
  wearableDailySeries,
  wearableMetricInventory,
  type SeriesPoint,
} from './series';
import { compareWindows, rCritical } from './stats';

export type InsightKind =
  'trend' | 'gap' | 'volume' | 'correlation' | 'readiness' | 'experiment' | 'target';

/** How the Coach should weight it: watch = act, good = reinforce, info = note. */
export type InsightTone = 'watch' | 'good' | 'info';

export type Insight = {
  /** Stable slug, e.g. "trend-hrv-down" — dedupe/testing key. */
  id: string;
  kind: InsightKind;
  tone: InsightTone;
  /** The domain it reads: 'hrv', 'weight', 'protein', 'training', … */
  metric: string;
  /** One quantified line, display units: "HRV down 12% vs your 3-week baseline". */
  headline: string;
  /** The numbers behind it — windows, averages, counts. */
  detail: string;
};

// Recent window = the last 7 calendar days (inclusive of today); baseline =
// the 21 days before that. Both need enough observations to mean anything.
const RECENT_DAYS = 7;
const BASELINE_DAYS = 21;
const MIN_POINTS_PER_WINDOW = 3;

/**
 * The two bars each metric must clear before a difference is worth a sentence:
 * the PRACTICAL one (`thresholdPct`) and the minimum observations per window
 * that {@link compareWindows} needs to estimate variance at all.
 *
 * Exported, and every spec below reads from it, because a SECOND surface now
 * fires on these gates: the periodic self-review's "Sleep & recovery" section
 * (src/lib/reports/assemble-self-review.ts) prints a direction word only when
 * the comparison would have fired here. That parity is the whole point — a
 * report saying "HRV down" over a week this engine considered ordinary is the
 * report manufacturing a trend, which is exactly what the two-bar gate exists
 * to prevent. Copying the numbers into the reports module would have made the
 * parity a coincidence maintained by hand; one object makes it structural, and
 * db/reports.test.mjs asserts the reports layer reads THIS object.
 *
 * Keyed by `TrendSpec.metric` (the domain slug), not by `wearable_data.metric_type`.
 * Declared here — above the specs — because they consume it at module
 * evaluation, and a `const` referenced before its declaration is a TDZ throw at
 * import time, not a hoist.
 */
export const TREND_GATES = {
  // HRV is the noisiest thing ARC measures — day-to-day CV is commonly 5–15%,
  // so three readings a side is not a window, it's a coin flip.
  hrv: { thresholdPct: 5, minPerWindow: 5 },
  // RHR is far steadier than HRV (CV ~3–5%), and a rising resting heart rate is
  // an early illness/overreaching signal — holding it back for a fifth reading
  // delays something worth hearing. The t-test still guards it; this is only
  // the floor for estimating variance at all.
  rhr: { thresholdPct: 3, minPerWindow: 4 },
  weight: { thresholdPct: 1, minPerWindow: MIN_POINTS_PER_WINDOW },
  // Step counts are noisy day to day; a weekly average has to move a long way
  // before it means anything about behaviour rather than weather.
  steps: { thresholdPct: 15, minPerWindow: MIN_POINTS_PER_WINDOW },
  active_energy: { thresholdPct: 15, minPerWindow: MIN_POINTS_PER_WINDOW },
  // HealthKit estimates resting energy from body size and age, so it barely
  // moves — a real shift is worth noting but is never an instruction, hence a
  // higher bar than the metrics the user actually controls.
  resting_energy: { thresholdPct: 10, minPerWindow: MIN_POINTS_PER_WINDOW },
  sleep: { thresholdPct: 10, minPerWindow: MIN_POINTS_PER_WINDOW },
} as const satisfies Record<string, { thresholdPct: number; minPerWindow: number }>;

type TrendSpec = {
  metric: string;
  label: string;
  /** The PRACTICAL bar: a smaller move isn't worth a sentence even if real. */
  thresholdPct: number;
  /** Tone when the value moved up / down. */
  toneUp: InsightTone;
  toneDown: InsightTone;
  /** Canonical value → display string ("48 ms", "178.2 lb"). */
  format: (canonical: number) => string;
  /** Override the minimum observations per window (noisier metrics need more). */
  minPerWindow?: number;
};

// Format a canonical value in the user's chosen units (Settings › Units), so a
// brief cites "72.6 kg" to a kg user, not "160 lb". resolveDisplay is identity
// for hrv/rhr (no unit choice); weight follows the preference.
const fmtVia =
  (key: 'weight' | 'hrv' | 'rhr', units: UnitPreferences) =>
  (canonical: number): string => {
    const spec = resolveDisplay(metricByKey(key)!, units);
    return `${round1(spec.fromCanonical(canonical))} ${spec.unit}`;
  };

/** 431 → "7h 11m", 45 → "45m". Hermes has no Intl, so this is hand-rolled. */
function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const fmtCount = (unit: string) => (v: number) => `${Math.round(v)} ${unit}`;

/**
 * A wearable metric read through the SAME trend machinery as HRV.
 *
 * These exist because the engine used to read exactly two metrics, hrv and rhr.
 * On the owner's device — a phone with no watch — neither sensor exists and
 * neither ever will, so `get_insights` (the tool the system prompt tells the
 * model to reach for FIRST) returned an empty list on a month of daily step
 * data, and the brief then told someone logging every day that there was "not
 * enough logged". A bare step count is not an insight; a move against the
 * person's own baseline is, and that is exactly what {@link trendInsight}
 * already computes.
 *
 * Read with {@link wearableArbitratedSeries}, not the pooling read: these are
 * HealthKit day buckets, so two devices reporting the same day must arbitrate
 * to one winner rather than be summed (double-count) or averaged (blur).
 */
type WearableTrend = {
  spec: TrendSpec;
  /** The `wearable_data.metric_type` to read. */
  metricType: string;
  /**
   * True when the value ACCUMULATES through the day (steps, energy burned).
   * Today is then a partial total and must be dropped, or every morning reads
   * as a collapse. False for whole-fact metrics like a night's sleep.
   */
  accumulating: boolean;
};

const WEARABLE_TRENDS: readonly WearableTrend[] = [
  {
    metricType: 'steps',
    accumulating: true,
    spec: {
      metric: 'steps',
      label: 'Daily steps',
      ...TREND_GATES.steps,
      toneUp: 'good',
      toneDown: 'watch',
      format: fmtCount('steps'),
    },
  },
  {
    metricType: 'active_energy_kcal',
    accumulating: true,
    spec: {
      metric: 'active_energy',
      label: 'Active energy',
      ...TREND_GATES.active_energy,
      toneUp: 'good',
      toneDown: 'watch',
      format: fmtCount('kcal'),
    },
  },
  {
    metricType: 'resting_energy_kcal',
    accumulating: true,
    spec: {
      metric: 'resting_energy',
      // Info, not watch: this is an estimate the user does not control (see the
      // bar in TREND_GATES.resting_energy).
      label: 'Resting energy',
      ...TREND_GATES.resting_energy,
      toneUp: 'info',
      toneDown: 'info',
      format: fmtCount('kcal'),
    },
  },
  {
    metricType: 'sleep_duration_min',
    // A night is written once, against the wake day: a whole fact, not a
    // running total, so today's value counts like an HRV reading does.
    accumulating: false,
    spec: {
      metric: 'sleep',
      label: 'Sleep',
      ...TREND_GATES.sleep,
      toneUp: 'good',
      toneDown: 'watch',
      format: formatMinutes,
    },
  },
];

function splitWindows(points: SeriesPoint[], now: Date): { recent: number[]; baseline: number[] } {
  const recentStart = isoDaysAgo(now, RECENT_DAYS - 1);
  const baselineStart = isoDaysAgo(now, RECENT_DAYS + BASELINE_DAYS - 1);
  const recent: number[] = [];
  const baseline: number[] = [];
  for (const p of points) {
    if (p.date >= recentStart) recent.push(p.value);
    else if (p.date >= baselineStart) baseline.push(p.value);
  }
  return { recent, baseline };
}

/**
 * A fired trend plus the raw magnitude behind it. The percentage is kept
 * alongside the {@link Insight} rather than only baked into its prose so
 * {@link foldActivityPair} can merge two related trends without re-parsing a
 * sentence for its own number.
 */
type TrendResult = { insight: Insight; changePct: number };

function trendResult(spec: TrendSpec, points: SeriesPoint[], now: Date): TrendResult | null {
  const { recent, baseline } = splitWindows(points, now);
  // Two bars, not one: the move must be big enough to matter AND bigger than
  // this user's own noise (src/lib/ai/stats.ts). A threshold alone fired on a
  // couple of ordinary mornings — HRV varies 5–15% day to day for most people.
  const comparison = compareWindows(
    recent,
    baseline,
    spec.thresholdPct,
    spec.minPerWindow ?? MIN_POINTS_PER_WINDOW
  );
  if (!comparison || !comparison.significant) return null;

  const { recentMean, baselineMean, changePct } = comparison;
  const up = changePct > 0;
  return {
    changePct,
    insight: {
      id: `trend-${spec.metric}-${up ? 'up' : 'down'}`,
      kind: 'trend',
      tone: up ? spec.toneUp : spec.toneDown,
      metric: spec.metric,
      headline: `${spec.label} ${up ? 'up' : 'down'} ${round1(Math.abs(changePct))}% vs your 3-week baseline`,
      // The last clause is earned, not decoration: the detector cleared Welch's
      // t as well as the percentage bar (compareWindows above), so the move
      // really is outside this user's own day-to-day spread.
      detail:
        `Averaged ${spec.format(recentMean)} over the last ${RECENT_DAYS} days ` +
        `(${recent.length} readings) vs ${spec.format(baselineMean)} over the prior ` +
        `${BASELINE_DAYS} days (${baseline.length} readings). The gap is larger than ` +
        `your normal day-to-day variation.`,
    },
  };
}

function trendInsight(spec: TrendSpec, points: SeriesPoint[], now: Date): Insight | null {
  return trendResult(spec, points, now)?.insight ?? null;
}

/**
 * Steps and active energy are ONE behaviour measured twice: a week of walking
 * less moves both, by construction. Emitted separately they were near-duplicate
 * clauses, and {@link generateDailyBrief} shows only the top three — so two of
 * Home's three lines were spent telling the user the same thing once each.
 *
 * When both fired the same direction over the same window, they collapse into a
 * single activity insight carrying BOTH magnitudes in the headline and both
 * window averages in the detail, so `get_insights` still surfaces every number
 * the detectors found while the brief spends one line on one fact. When they
 * diverge (steps up, energy down) that is a genuinely different observation and
 * both stand.
 */
function foldActivityPair(results: Map<string, TrendResult>): Insight[] {
  const steps = results.get('steps');
  const energy = results.get('active_energy');
  const together = steps && energy && steps.changePct > 0 === energy.changePct > 0;
  const out: Insight[] = [];
  for (const [metric, result] of results) {
    if (together && metric === 'active_energy') continue;
    if (together && metric === 'steps') {
      const up = steps!.changePct > 0;
      out.push({
        id: `trend-activity-${up ? 'up' : 'down'}`,
        kind: 'trend',
        tone: steps!.insight.tone,
        metric: 'activity',
        headline:
          `Daily activity ${up ? 'up' : 'down'} — steps ${round1(Math.abs(steps!.changePct))}%, ` +
          `active energy ${round1(Math.abs(energy!.changePct))}% vs your 3-week baseline`,
        detail: `${steps!.insight.detail} ${energy!.insight.detail}`,
      });
      continue;
    }
    out.push(result.insight);
  }
  return out;
}

/** Every insight the current data supports, most actionable first. */
export function computeInsights(db: Database, now: Date = new Date()): Insight[] {
  const since = isoDaysAgo(now, RECENT_DAYS + BASELINE_DAYS);
  const insights: Insight[] = [];
  const today = todayISODate(now);
  const units = getPreferences(db).units;
  // Accumulating metrics (per-day totals: protein, training minutes) exclude
  // today — the day is still being written, and a partial total would read as
  // a drop every single morning. Their windows anchor on yesterday instead.
  // Level metrics (HRV, RHR, weight) keep today: a reading is a whole fact.
  const accNow = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  // --- Metric trends ---------------------------------------------------------
  // Closed windows [since, today]: a future-dated row (clock skew, a
  // mis-entered backdate) must never contaminate the recent averages.
  const hrv = wearableDailySeries(db, 'hrv', since, 'avg', today);
  const rhr = wearableDailySeries(db, 'rhr', since, 'avg', today);
  // body_metrics is bounded on the INSTANT (see bodyDailySeries) — a local-day
  // date string would drop an evening weigh-in west of UTC.
  const weight = bodyDailySeries(db, 'weight_kg', since, endOfLocalDayUtc(now));

  const trends: [TrendSpec, SeriesPoint[]][] = [
    [
      {
        metric: 'hrv',
        label: 'HRV',
        ...TREND_GATES.hrv,
        toneUp: 'good',
        toneDown: 'watch',
        format: fmtVia('hrv', units),
      },
      hrv,
    ],
    [
      {
        metric: 'rhr',
        label: 'Resting HR',
        ...TREND_GATES.rhr,
        toneUp: 'watch',
        toneDown: 'good',
        format: fmtVia('rhr', units),
      },
      rhr,
    ],
    [
      {
        metric: 'weight',
        label: 'Weight',
        ...TREND_GATES.weight,
        toneUp: 'info',
        toneDown: 'info',
        format: fmtVia('weight', units),
      },
      weight,
    ],
  ];
  for (const [spec, points] of trends) {
    const insight = trendInsight(spec, points, now);
    if (insight) insights.push(insight);
  }

  // --- Wearable trends a phone alone produces --------------------------------
  // Steps, energy and sleep sync from HealthKit with no watch attached, so this
  // is the only branch that says anything at all on the owner's device.
  // Keyed by spec.metric, in WEARABLE_TRENDS order, so the fold below is
  // deterministic and does not depend on sort stability.
  const wearableTrends = new Map<string, TrendResult>();
  for (const { spec, metricType, accumulating } of WEARABLE_TRENDS) {
    const series = wearableArbitratedSeries(db, metricType, since, today);
    const points = accumulating ? series.filter((p) => p.date < today) : series;
    const result = trendResult(spec, points, accumulating ? accNow : now);
    if (result) wearableTrends.set(spec.metric, result);
  }
  for (const insight of foldActivityPair(wearableTrends)) insights.push(insight);

  // --- Nutrition trends (per logged day, full days only) ---------------------
  const nutrition = nutritionDailyTotals(db, since, today).filter((d) => d.date < today);
  const proteinPoints = nutrition.map((d) => ({ date: d.date, value: d.protein_g }));
  const proteinTrend = trendInsight(
    {
      metric: 'protein',
      label: 'Protein intake',
      thresholdPct: 10,
      toneUp: 'good',
      toneDown: 'watch',
      format: (v) => `${round1(v)} g/day`,
    },
    proteinPoints,
    accNow
  );
  if (proteinTrend) insights.push(proteinTrend);

  // --- Training volume (weekly-rate comparison, full days only) --------------
  const training = trainingDailyTotals(db, since, today);
  const trainingDays = training.filter((d) => d.date < today);
  const accRecentStart = isoDaysAgo(accNow, RECENT_DAYS - 1);
  const recentTraining = trainingDays.filter((d) => d.date >= accRecentStart);
  const baselineTraining = trainingDays.filter((d) => d.date < accRecentStart);
  const recentMin = recentTraining.reduce((a, d) => a + d.minutes, 0);
  const recentSessions = recentTraining.reduce((a, d) => a + d.sessions, 0);
  const baselineMin = baselineTraining.reduce((a, d) => a + d.minutes, 0);
  const baselineSessions = baselineTraining.reduce((a, d) => a + d.sessions, 0);
  // Divide by the weeks the baseline actually covers, not a fixed 3 — a user
  // 14 days into logging would otherwise look like they tripled their volume.
  const baselineSpanDays =
    baselineTraining.length > 0
      ? Math.min(BASELINE_DAYS, Math.max(7, daysBetween(baselineTraining[0]!.date, accRecentStart)))
      : 0;
  const baselineWeeks = baselineSpanDays / 7;
  const baselineWeeklyMin = baselineWeeks > 0 ? baselineMin / baselineWeeks : 0;
  const baselineWeeklySessions = baselineWeeks > 0 ? baselineSessions / baselineWeeks : 0;
  if (baselineTraining.length >= MIN_POINTS_PER_WINDOW && baselineWeeklyMin > 0) {
    const changePct = ((recentMin - baselineWeeklyMin) / baselineWeeklyMin) * 100;
    const sessionsChangePct =
      baselineWeeklySessions > 0
        ? ((recentSessions - baselineWeeklySessions) / baselineWeeklySessions) * 100
        : 0;
    // "Down" needs the session count to agree — sessions logged without a
    // duration total 0 minutes, and that data gap must not read as a collapse.
    const fires = changePct >= 25 || (changePct <= -25 && sessionsChangePct <= -25);
    if (fires) {
      const up = changePct > 0;
      insights.push({
        id: `trend-training-${up ? 'up' : 'down'}`,
        kind: 'trend',
        tone: up ? 'good' : 'watch',
        metric: 'training',
        headline: `Training volume ${up ? 'up' : 'down'} ${round1(Math.abs(changePct))}% vs your recent weekly average`,
        detail:
          `${round1(recentMin)} min over the last ${RECENT_DAYS} full days vs a weekly average of ` +
          `${round1(baselineWeeklyMin)} min across the ${baselineSpanDays} days before that.`,
      });
    }
  }

  // --- Nutrition vs the user's OWN targets -----------------------------------
  //
  // Every other detector measures self-relative movement, which means a user
  // sitting 40 g under their protein target with a perfectly flat trend
  // produces nothing, forever — the exact judgment a coach exists to make.
  // Targets are the user's own (Nutrition › Targets), so this is measuring
  // them against what they decided, never against a number ARC invented.
  const targets = activeNutritionTargets(db, today);
  const fullNutritionDays = nutrition.filter((d) => d.meals > 0);
  if (targets?.protein_g != null && fullNutritionDays.length >= 5) {
    const recentDays = fullNutritionDays.filter(
      (d) => d.date >= isoDaysAgo(accNow, RECENT_DAYS - 1)
    );
    if (recentDays.length >= 4) {
      const avgProtein = mean(recentDays.map((d) => d.protein_g))!;
      const shortfall = targets.protein_g - avgProtein;
      // 10% under, sustained across the window — not one light day.
      if (shortfall > targets.protein_g * 0.1) {
        insights.push({
          id: 'target-protein-under',
          kind: 'target',
          tone: 'watch',
          metric: 'protein',
          headline: `Protein running ${round1(shortfall)} g/day under your target`,
          detail:
            `Averaged ${round1(avgProtein)} g across ${recentDays.length} logged days vs your ` +
            `${round1(targets.protein_g)} g target. Your target, not a default.`,
        });
      }
    }
  }

  // --- Logging gaps ----------------------------------------------------------
  const lastWeight = weight.length > 0 ? weight[weight.length - 1]! : undefined;
  const allTimeLastWeight =
    lastWeight ??
    db.get<SeriesPoint>(
      // Bounded at the end of the local day (on the instant, like every other
      // body_metrics read): a genuinely future-dated row would otherwise make
      // daysSince negative and silence this detector forever.
      `SELECT substr(measured_at, 1, 10) AS date, weight_kg AS value FROM body_metrics
       WHERE weight_kg IS NOT NULL AND measured_at < ?
       ORDER BY measured_at DESC LIMIT 1`,
      [endOfLocalDayUtc(now)]
    );
  if (allTimeLastWeight) {
    const daysSince = daysBetween(allTimeLastWeight.date, todayISODate(now));
    if (daysSince > 7) {
      insights.push({
        id: 'gap-weight',
        kind: 'gap',
        tone: 'watch',
        metric: 'weight',
        headline: `Weight unlogged for ${daysSince} days`,
        detail: `Last reading ${fmtVia('weight', units)(allTimeLastWeight.value)} on ${allTimeLastWeight.date}. Trend reads need a cadence.`,
      });
    }
  }

  // --- Symptom volume --------------------------------------------------------
  const symptomRecentStart = isoDaysAgo(now, RECENT_DAYS - 1);
  const symptomBaselineStart = isoDaysAgo(now, RECENT_DAYS + BASELINE_DAYS - 1);
  // Bounded at today like every other window — a future-dated symptom row
  // must not inflate the recent count.
  const symptomRecent = db.get<{ c: number }>(
    'SELECT count(*) c FROM symptoms WHERE date >= ? AND date <= ?',
    [symptomRecentStart, today]
  );
  const symptomBaseline = db.get<{ c: number }>(
    'SELECT count(*) c FROM symptoms WHERE date >= ? AND date < ?',
    [symptomBaselineStart, symptomRecentStart]
  );
  const recentSymptoms = symptomRecent?.c ?? 0;
  const baselineWeeklySymptoms = (symptomBaseline?.c ?? 0) / (BASELINE_DAYS / 7);
  if (recentSymptoms >= 3 && recentSymptoms > baselineWeeklySymptoms * 1.5) {
    insights.push({
      id: 'volume-symptoms-up',
      kind: 'volume',
      tone: 'watch',
      metric: 'symptoms',
      headline: `${recentSymptoms} symptoms logged in the last ${RECENT_DAYS} days — above your baseline`,
      detail:
        `${recentSymptoms} in the last ${RECENT_DAYS} days vs a weekly average of ` +
        `${round1(baselineWeeklySymptoms)} over the prior ${BASELINE_DAYS} days.`,
    });
  }

  // --- Today's readiness -----------------------------------------------------
  // The SAME derivation Home renders (src/lib/home/readiness.ts), surfaced as
  // an insight so the brief, get_insights, and the Home card can never disagree
  // about the morning. It STATES the verdict and its evidence; it prescribes
  // nothing — what a caution morning should mean for the day is a judgment
  // call the Coach makes with the user, weighing the cause, the program phase,
  // and what today's session actually is.
  const readiness = deriveReadiness(db, today);
  const level = readiness.readiness.level;
  if (readiness.hasSignal && (level === 'caution' || level === 'poor')) {
    const weak = readiness.pillars
      .filter((p) => p.level === 'caution' || p.level === 'poor')
      .map((p) => p.label.toLowerCase());
    // Deliberately NOT Home's verdict label here: that copy ("Back off today")
    // is an instruction, and handing the model a pre-baked instruction is the
    // one thing this layer must not do. State the level and the evidence; the
    // Home label rides in `detail` so the two surfaces stay traceable to each
    // other without the engine deciding the day.
    insights.push({
      id: `readiness-${level}`,
      kind: 'readiness',
      tone: 'watch',
      metric: 'readiness',
      headline:
        level === 'poor'
          ? 'Recovery is well below your baseline today'
          : 'Recovery is below your baseline today',
      detail:
        `${readiness.readiness.detail}.` +
        (weak.length > 0
          ? ` Weakest ${weak.length === 1 ? 'pillar' : 'pillars'}: ${weak.join(', ')}.`
          : '') +
        ` Home shows this as "${readiness.readiness.label}".`,
    });
  }

  // --- Experiments: the improvement loop, surfaced without being asked -------
  // A readout that only happens if the model spontaneously calls
  // get_experiments in a chat the user happened to start is not a loop. These
  // put the running experiment where the brief and get_insights will see it.
  for (const experiment of activeExperiments(db, today)) {
    if (experiment.ready) {
      insights.push({
        id: `experiment-ready-${experiment.id}`,
        kind: 'experiment',
        tone: 'watch',
        metric: 'experiments',
        headline: `Experiment "${experiment.title}" is ready to read out`,
        detail:
          `It ran ${experiment.start_date} → ${experiment.end_date} testing: ${experiment.intervention}. ` +
          `Watched: ${experiment.metrics.join(', ')}.` +
          (experiment.success_criteria ? ` Success criteria: ${experiment.success_criteria}.` : ''),
      });
    } else if (experiment.daysLeft === 0) {
      insights.push({
        id: `experiment-last-day-${experiment.id}`,
        kind: 'experiment',
        tone: 'info',
        metric: 'experiments',
        headline: `Last day of experiment "${experiment.title}"`,
        detail: `Window closes tonight (${experiment.end_date}); it reads out tomorrow.`,
      });
    }
  }

  // --- Correlation: HRV vs prior-day training load ---------------------------
  const correlation = hrvTrainingCorrelation(hrv, training);
  if (correlation) insights.push(correlation);

  // Actionable first: watch, then good, then info; stable within a tone.
  const rank: Record<InsightTone, number> = { watch: 0, good: 1, info: 2 };
  return insights.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

/** Whole days between two YYYY-MM-DD dates (UTC arithmetic — DST-proof). */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

function hrvTrainingCorrelation(
  hrv: SeriesPoint[],
  training: { date: string; minutes: number }[]
): Insight | null {
  const trainingByDate = new Map(training.map((d) => [d.date, d.minutes]));
  const xs: number[] = []; // prior-day training minutes
  const ys: number[] = []; // HRV
  for (const point of hrv) {
    // A day with no workout row is a REST day (0 minutes), not missing data —
    // skipping it would blind the detector to the exact train/rest contrast
    // it exists to catch. (No workouts at all → zero variance → pearson null.)
    xs.push(trainingByDate.get(isoDatePlusDays(point.date, -1)) ?? 0);
    ys.push(point.value);
  }
  // n ≥ 14 AND |r| past the α = 0.05 critical value for that n. The old gate
  // (n ≥ 8, |r| ≥ 0.5) is p ≈ 0.20 — it would tell roughly one in five users
  // with no real effect that their training suppresses their recovery.
  if (xs.length < 14) return null;
  // Rest days are legitimately 0-minute pairs, but a series that is almost all
  // zeros lets one hard day drive the whole correlation.
  if (xs.filter((minutes) => minutes > 0).length < 3) return null;
  const r = pearson(xs, ys);
  if (r === null || Math.abs(r) < rCritical(xs.length)) return null;

  const negative = r < 0;
  return {
    id: `correlation-hrv-training-${negative ? 'neg' : 'pos'}`,
    kind: 'correlation',
    tone: negative ? 'watch' : 'info',
    metric: 'hrv',
    headline: negative
      ? 'Bigger training days are followed by lower HRV'
      : 'Bigger training days are followed by higher HRV',
    detail:
      `Across ${xs.length} day pairs, prior-day training minutes and next-morning HRV ` +
      `correlate at r = ${Math.round(r * 100) / 100} (past the p<0.05 bar for this many pairs). ` +
      `Correlation, not causation — worth watching.`,
  };
}

/**
 * How much evidence the detectors actually have, for honest cold-start copy.
 *
 * A new user gets nothing from the detectors for their first ~10 days, and the
 * old brief filled that silence with "that usually means not enough logged" —
 * an accusation, and factually wrong for someone logging diligently. This is
 * what lets the brief say which situation it is actually in.
 */
type Evidence = { hrvDays: number; weightDays: number; loggedNutritionDays: number };

function gatherEvidence(db: Database, now: Date): Evidence {
  const since = isoDaysAgo(now, RECENT_DAYS + BASELINE_DAYS);
  const today = todayISODate(now);
  return {
    hrvDays: wearableDailySeries(db, 'hrv', since, 'avg', today).length,
    weightDays: bodyDailySeries(db, 'weight_kg', since, endOfLocalDayUtc(now)).length,
    loggedNutritionDays: nutritionDailyTotals(db, since, today).length,
  };
}

/**
 * An active reminder that {@link isDueOn} surfaces today, with how late it is.
 *
 * `daysOverdue` is 0 for everything that genuinely belongs to today — every
 * recurring reminder, a one-off pinned to today, and an undated legacy one-off
 * (no floor, so no age can honestly be claimed). It is positive only for a
 * one-off whose pinned day has passed and which the user has neither completed
 * nor dismissed: those keep surfacing by design (see `isDueOn`), but they are
 * NOT today's plan and must never be presented as such.
 */
export type DueReminder = { reminder: ReminderRow; daysOverdue: number };

/**
 * Today's due reminders, ranked so today's actual plan comes first.
 *
 * The ordering is the whole point. `listActiveReminders` sorts by CLOCK TIME
 * only, which is right for a list of everything but wrong the moment a caller
 * truncates: an overdue one-off pinned at 06:00 months ago would outrank
 * today's real daily and weekly reminders unconditionally, and any `slice`
 * would drop the genuine ones. So: on-their-day items first (in their existing
 * clock order), then overdue one-offs, oldest nag first. Ties fall back to the
 * source index, so the result is fully deterministic and does not depend on
 * `Array.prototype.sort` stability.
 *
 * Shared by {@link generateDailyBrief} and the `get_today_snapshot` tool so the
 * Home brief and the Coach model rank and cap the same set the same way.
 */
export function dueRemindersFor(db: Database, today: string): DueReminder[] {
  const due = listActiveReminders(db)
    .filter((r) => isDueOn(r, today))
    .map((reminder, index) => ({
      reminder,
      index,
      daysOverdue:
        reminder.repeat === 'once' && reminder.date != null && reminder.date < today
          ? daysBetween(reminder.date, today)
          : 0,
    }));
  due.sort(
    (a, b) =>
      Number(a.daysOverdue > 0) - Number(b.daysOverdue > 0) ||
      b.daysOverdue - a.daysOverdue ||
      a.index - b.index
  );
  return due.map(({ reminder, daysOverdue }) => ({ reminder, daysOverdue }));
}

/**
 * A day count as the shortest honest unit — "1 day", "12 days", "5 wk", "4 mo".
 * Hand-rolled: Hermes has no Intl, so nothing here may reach for it. Same
 * thresholds as the Screenings ledger's span text, so "3 wk overdue" means the
 * same thing everywhere in the app.
 */
function ageText(days: number): string {
  if (days < 14) return days === 1 ? '1 day' : `${days} days`;
  if (days < 70) return `${Math.round(days / 7)} wk`;
  if (days < 550) return `${Math.round(days / 30.44)} mo`;
  return `${Math.round(days / 365.25)} yr`;
}

/** How many of each kind of reminder the brief names before it starts counting. */
const BRIEF_ON_DECK = 3;
const BRIEF_OVERDUE = 2;

const reminderText = (r: ReminderRow): string => (r.time ? `${r.title} (${r.time})` : r.title);

/** "A · B, and 3 more" — names the first `limit`, counts the rest rather than hiding it. */
function joinNamed(items: string[], limit: number): string {
  const named = items.slice(0, limit).join(' · ');
  const rest = items.length - limit;
  return rest > 0 ? `${named}, and ${rest} more` : named;
}

/**
 * What the brief names when nothing crossed a threshold, in the order a day
 * reads. Each clause is a plain average over the reading window — not an
 * insight, deliberately, just proof that the data is being read.
 *
 * `accumulating` carries the same meaning and the same consequence as it does
 * on {@link WearableTrend}: today's steps are a running total, not a day, so
 * they are excluded from BOTH the average and the day count. A stated daily
 * average that silently includes a two-hour-old day is a fabricated number —
 * the "no data, no number" rule broken from the other direction.
 */
const BRIEF_FLOOR_METRICS: readonly {
  metricType: string;
  accumulating: boolean;
  describe: (avg: number) => string;
}[] = [
  {
    metricType: 'steps',
    accumulating: true,
    describe: (v) => `steps averaged ${Math.round(v)} a day`,
  },
  {
    metricType: 'sleep_duration_min',
    accumulating: false,
    describe: (v) => `sleep averaged ${formatMinutes(v)}`,
  },
  {
    metricType: 'active_energy_kcal',
    accumulating: true,
    describe: (v) => `active energy averaged ${Math.round(v)} kcal a day`,
  },
  { metricType: 'hrv', accumulating: false, describe: (v) => `HRV averaged ${round1(v)} ms` },
  {
    metricType: 'rhr',
    accumulating: false,
    describe: (v) => `resting HR averaged ${round1(v)} bpm`,
  },
];

/**
 * The last {@link RECENT_DAYS} days of wearable data as a sentence fragment, or
 * null when the device genuinely holds no wearable data at all.
 *
 * This is the test the empty brief keys on. Keying on "no insights" was the bug:
 * a month of steps with a flat baseline produces no insight, and the brief then
 * claimed nothing had been logged. Absence of a TREND is not absence of DATA.
 */
function wearableFloorLine(db: Database, now: Date): string | null {
  const today = todayISODate(now);
  // A level metric (a night's sleep, an HRV reading) is a whole fact the moment
  // it is written, so its window is the last 7 days INCLUDING today. An
  // accumulating one reads the last 7 COMPLETE days and drops today — the same
  // rule WEARABLE_TRENDS applies, anchored one day back so 7 of 7 stays
  // reachable rather than being permanently short a day.
  const levelSince = isoDaysAgo(now, RECENT_DAYS - 1);
  const completeSince = isoDaysAgo(now, RECENT_DAYS);
  const clauses: string[] = [];
  for (const metric of BRIEF_FLOOR_METRICS) {
    const series = wearableArbitratedSeries(
      db,
      metric.metricType,
      metric.accumulating ? completeSince : levelSince,
      today
    );
    const points = metric.accumulating ? series.filter((p) => p.date < today) : series;
    if (points.length === 0) continue;
    const avg = mean(points.map((p) => p.value))!;
    const window = metric.accumulating ? 'full days' : 'days';
    clauses.push(`${metric.describe(avg)} (${points.length} of the last ${RECENT_DAYS} ${window})`);
  }
  if (clauses.length > 0) return clauses.join(' · ');

  // Rows exist but none inside the window, or only metrics with no phrasing
  // above. Still not "nothing logged" — say what is actually on the device.
  const inventory = wearableMetricInventory(db);
  if (inventory.length === 0) return null;
  const last = inventory.reduce((a, b) => (a.lastDate >= b.lastDate ? a : b));
  const held = `Apple Health holds ${inventory.length} metric${inventory.length === 1 ? '' : 's'} on this device, last synced ${last.lastDate}`;
  // Data DID arrive inside the window; it was only today's still-accumulating
  // total, which no average may quote. Saying "nothing in the last 7 days"
  // after naming a sync date of today contradicts itself.
  if (last.lastDate >= levelSince) {
    return `${held}, but only today’s running totals — nothing complete enough to average yet`;
  }
  return `${held}, but nothing in the last ${RECENT_DAYS} days`;
}

/**
 * The deterministic morning brief: top insights + today's reminders, composed
 * without a model call, so the brief is real even offline. The Coach may
 * rewrite it in voice; the numbers come from here.
 *
 * Three distinct empty states, because they call for three different things:
 * STABLE (plenty of data, nothing moving) is good news and should be said as
 * such; BUILDING (data arriving, not enough for a baseline yet) should say how
 * far along it is; SPARSE (genuinely under-logged) is the only one that earns
 * a nudge about cadence.
 *
 * Overdue one-offs get their own clause with their age, never the "On deck
 * today" line. Home is sacred (CLAUDE.md §5) and answers "what should I do
 * right now" — a months-old un-dismissed nudge is a real obligation, so it is
 * not dropped, but it cannot be allowed to evict today's actual plan or to
 * masquerade as it.
 */
export function generateDailyBrief(db: Database, now: Date = new Date()): string {
  const insights = computeInsights(db, now);
  const today = todayISODate(now);
  const due = dueRemindersFor(db, today);
  const onDeck = due.filter((d) => d.daysOverdue === 0);
  const overdue = due.filter((d) => d.daysOverdue > 0);

  const parts: string[] = [];
  // Readiness is excluded here on purpose: every surface that renders the brief
  // renders the readiness verdict right beside it (Home's strip, the Coach
  // screen's card, the per-turn context block's own Readiness line), so
  // repeating it would spend the brief's three lines saying what is already on
  // screen. It stays in computeInsights for get_insights, which has no such
  // neighbouring surface.
  for (const insight of insights.filter((i) => i.kind !== 'readiness').slice(0, 3)) {
    parts.push(`${insight.headline}.`);
  }
  if (onDeck.length > 0) {
    parts.push(
      `On deck today: ${joinNamed(
        onDeck.map((d) => reminderText(d.reminder)),
        BRIEF_ON_DECK
      )}.`
    );
  }
  if (overdue.length > 0) {
    const named = overdue.map(
      (d) => `${reminderText(d.reminder)} — ${ageText(d.daysOverdue)} overdue`
    );
    parts.push(`Still open: ${joinNamed(named, BRIEF_OVERDUE)}.`);
  }
  if (parts.length === 0) {
    const evidence = gatherEvidence(db, now);
    const tracked = Math.max(evidence.hrvDays, evidence.weightDays, evidence.loggedNutritionDays);
    const mode = getActiveMode(db, today);
    // What the watch alone can show. It grounds every branch below: a synced
    // wearable is real data even when nothing has been logged by hand, and
    // "nothing to report" reads very differently with a number attached.
    const floor = wearableFloorLine(db, now);

    // Sick / Travel / Social excuse the day. Nagging about logging cadence then
    // contradicts the mode system's whole premise (home-screen.md:110).
    if (getModeDefinition(mode).excusesSkips) {
      return `${getModeDefinition(mode).label} day. Nothing in your data needs attention. Look after the basics.`;
    }
    if (tracked === 0) {
      return floor
        ? `Nothing logged by hand yet. What I can see: ${floor}. Add weight, meals and training to widen what I can read.`
        : 'Nothing logged yet. Start with today: weight, what you eat, and any training. Trends need a few days of anything at all.';
    }
    // The detectors need ~10 days (a 7-day window against a 21-day baseline,
    // with a real minimum in each). Say where they are, not that they failed.
    if (tracked < 10) {
      return `Baseline building. ${tracked} day${tracked === 1 ? '' : 's'} of data so far. Trends need about ten. Keep the cadence and they will start showing up.`;
    }
    return floor
      ? `Everything is holding steady. No trend, gap, or symptom pattern worth flagging today. What I can see: ${floor}.`
      : 'Everything is holding steady. No trend, gap, or symptom pattern worth flagging today. Stable is the goal, not the absence of news.';
  }
  return parts.join(' ');
}
