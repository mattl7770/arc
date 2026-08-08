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
  wearableDailySeries,
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

function trendInsight(spec: TrendSpec, points: SeriesPoint[], now: Date): Insight | null {
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
    id: `trend-${spec.metric}-${up ? 'up' : 'down'}`,
    kind: 'trend',
    tone: up ? spec.toneUp : spec.toneDown,
    metric: spec.metric,
    headline: `${spec.label} ${up ? 'up' : 'down'} ${round1(Math.abs(changePct))}% vs your 3-week baseline`,
    detail:
      `Averaged ${spec.format(recentAvg)} over the last ${RECENT_DAYS} days ` +
      `(${recent.length} readings) vs ${spec.format(baselineAvg)} over the prior ` +
      `${BASELINE_DAYS} days (${baseline.length} readings).`,
  };
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
    return (
      'No notable movements in your data yet — that usually means not enough logged, ' +
      'not that nothing is happening. Keep the cadence: weight, meals, training.'
    );
  }
  return parts.join(' ');
}
