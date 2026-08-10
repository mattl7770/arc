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
import type { ReminderRow } from '@/lib/reminders/types';
import type { UnitPreferences } from '@/lib/user/types';
import {
  bodyDailySeries,
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

export type InsightKind = 'trend' | 'gap' | 'volume' | 'correlation';

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

type TrendSpec = {
  metric: string;
  label: string;
  /** Fires when |change| ≥ this percent. */
  thresholdPct: number;
  /** Tone when the value moved up / down. */
  toneUp: InsightTone;
  toneDown: InsightTone;
  /** Canonical value → display string ("48 ms", "178.2 lb"). */
  format: (canonical: number) => string;
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
      // Step counts are noisy day to day; a weekly average has to move a long
      // way before it means anything about behaviour rather than weather.
      thresholdPct: 15,
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
      thresholdPct: 15,
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
      // HealthKit estimates this from body size and age, so it barely moves.
      // A real shift is worth noting but is never an instruction: info, not
      // watch, and a higher bar than the metrics the user actually controls.
      label: 'Resting energy',
      thresholdPct: 10,
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
      thresholdPct: 10,
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
  if (recent.length < MIN_POINTS_PER_WINDOW || baseline.length < MIN_POINTS_PER_WINDOW) {
    return null;
  }
  const recentAvg = mean(recent)!;
  const baselineAvg = mean(baseline)!;
  if (baselineAvg === 0) return null;
  const changePct = ((recentAvg - baselineAvg) / Math.abs(baselineAvg)) * 100;
  if (Math.abs(changePct) < spec.thresholdPct) return null;

  const up = changePct > 0;
  return {
    changePct,
    insight: {
      id: `trend-${spec.metric}-${up ? 'up' : 'down'}`,
      kind: 'trend',
      tone: up ? spec.toneUp : spec.toneDown,
      metric: spec.metric,
      headline: `${spec.label} ${up ? 'up' : 'down'} ${round1(Math.abs(changePct))}% vs your 3-week baseline`,
      detail:
        `Averaged ${spec.format(recentAvg)} over the last ${RECENT_DAYS} days ` +
        `(${recent.length} readings) vs ${spec.format(baselineAvg)} over the prior ` +
        `${BASELINE_DAYS} days (${baseline.length} readings).`,
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
  const hrv = wearableDailySeries(db, 'hrv', since, 'avg');
  const rhr = wearableDailySeries(db, 'rhr', since, 'avg');
  const weight = bodyDailySeries(db, 'weight_kg', since);

  const trends: [TrendSpec, SeriesPoint[]][] = [
    [
      {
        metric: 'hrv',
        label: 'HRV',
        thresholdPct: 5,
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
        thresholdPct: 3,
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
        thresholdPct: 1,
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
  const nutrition = nutritionDailyTotals(db, since).filter((d) => d.date < today);
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
  const training = trainingDailyTotals(db, since);
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

  // --- Logging gaps ----------------------------------------------------------
  const lastWeight = weight.length > 0 ? weight[weight.length - 1]! : undefined;
  const allTimeLastWeight =
    lastWeight ??
    db.get<SeriesPoint>(
      `SELECT substr(measured_at, 1, 10) AS date, weight_kg AS value FROM body_metrics
       WHERE weight_kg IS NOT NULL ORDER BY measured_at DESC LIMIT 1`
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
  const symptomRecent = db.get<{ c: number }>('SELECT count(*) c FROM symptoms WHERE date >= ?', [
    symptomRecentStart,
  ]);
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
  if (xs.length < 8) return null;
  const r = pearson(xs, ys);
  if (r === null || Math.abs(r) < 0.5) return null;

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
      `correlate at r = ${Math.round(r * 100) / 100}. Correlation, not causation — worth watching.`,
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
  for (const insight of insights.slice(0, 3)) {
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
    const floor = wearableFloorLine(db, now);
    if (floor) {
      return (
        `Nothing has moved far enough from your baseline to flag. What I can see: ${floor}. ` +
        'Log weight, meals and training to widen what I can read.'
      );
    }
    return (
      'No notable movements in your data yet. That usually means not enough logged, ' +
      'not that nothing is happening. Keep the cadence: weight, meals, training.'
    );
  }
  return parts.join(' ');
}
