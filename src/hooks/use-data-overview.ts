import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { bodySeries, latestBody } from '@/lib/db/repositories/body';
import { weeklyTrainingSeries, weekSummary } from '@/lib/db/repositories/exercise';
import { missionAdherence, missionDailySeries } from '@/lib/db/repositories/mission';
import { dailyIntakeSeries, todayTotals } from '@/lib/db/repositories/nutrition';
import { listTodaySymptoms, symptomDailySeries } from '@/lib/db/repositories/symptoms';
import { getPreferences } from '@/lib/db/repositories/user';
import { waterDaySeries } from '@/lib/db/repositories/water';
import { metricByBodyColumn, metricByKey, resolveDisplay, roundToSpec } from '@/lib/log/metrics';

/**
 * The Data tab's "Standing Ledger" view model, backed by the on-device database.
 *
 * Same shape as use-log-feed / use-nutrition: op-sqlite is synchronous, so the
 * first read runs in the `useState` initializer (no loading state), and
 * `useFocusEffect` re-reads whenever the tab regains focus — returning from a
 * sub-app (weight keypad, Nutrition, Exercise, Symptom) after logging, or just
 * switching back. That also rolls the "today"/"this week" figures over if a day
 * or Monday boundary passed while the app was backgrounded.
 *
 * All view-model shaping lives here so the screen is pure presentation: each
 * trend arrives with its sparkline series, a formatted headline, and an honest
 * empty flag (a domain with no data in its window says so instead of drawing a
 * misleading flat line).
 */

/** Which sub-app a trend row drills into — the screen maps this to a route. */
export type TrendKey = 'mission' | 'weight' | 'water' | 'nutrition' | 'training' | 'symptoms';

export interface DataTrend {
  key: TrendKey;
  /** Serif domain name. */
  name: string;
  /** Tiny descriptor under the name. */
  sub: string;
  /** Sparkline series (oldest -> newest); ignored when `empty`. */
  spark: number[];
  /**
   * How the sparkline scales. 'zero' (default) anchors bars at zero — right for
   * counts/durations. 'auto' scales to the series' own min..max — needed for
   * interval metrics like weight that cluster far from zero and would otherwise
   * render as a flat block.
   */
  sparkBaseline: 'zero' | 'auto';
  /** Mono headline value (already formatted). */
  value: string;
  /** Unit shown muted after the value; '' when the value stands alone. */
  unit: string;
  /** A date/context qualifier (e.g. "Jul 24" for the latest weight), or null. */
  qualifier: string | null;
  /** No data in this domain's window — render `emptyLabel` instead of a flat line. */
  empty: boolean;
  /** Quiet first-run invite shown in place of the sparkline + headline. */
  emptyLabel: string;
}

/**
 * `biomarkers` is deliberately NOT here. This hook used to load the whole
 * 65-marker catalogue alongside the trends, because the Data tab drew both. It
 * no longer does — the biomarker list moved to app/labs.tsx on 2026-08-11, at
 * the owner's instruction, and that screen loads it itself.
 *
 * The read was left in place for a while after its consumer went away, which is
 * the expensive kind of leftover: it ran on **every focus of the Data tab**,
 * including the return trip from Labs, so opening the list and coming back
 * executed the same 65-row scan twice — a full table scan plus 65 correlated
 * subqueries, each needing a temp B-tree because the subquery's
 * `created_at DESC, id DESC` tie-breakers are not in the index. Cheap on 65
 * rows; entirely wasted regardless, and a field on a public interface that
 * nothing reads is how the next screen ends up reading it by accident.
 */
export interface DataOverviewState {
  trends: DataTrend[];
}

export type DataOverview = DataOverviewState & {
  /** Re-read every series — call after an in-app capture. */
  reload: () => void;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO instant -> "Jul 24" in local time (no Intl — Hermes-safe). */
function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()}`;
}

/** 1840 -> "1,840", hand-rolled so the thousands comma doesn't lean on Intl. */
function fmtInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function read(): DataOverviewState {
  const db = getDb();
  const today = todayISODate();
  const now = new Date();
  // Display-only unit preference (storage stays canonical kg); the weight
  // headline renders in the user's chosen unit via the resolved DisplaySpec.
  const units = getPreferences(db).units;

  // Mission — how much of each day's plan actually got done. First row on the
  // tab because it is the only trend measuring the app's own daily loop: every
  // other row measures the body, this one measures the execution.
  //
  // **The sparkline is a COUNT, not a rate.** A rate needs a denominator, and a
  // day that planned nothing has none — zero-filling it would draw a fortnight
  // of 0% for someone who was never asked to do anything. Completed-per-day is
  // honestly zero on such a day, so the bars stay truthful and zero-anchored
  // like every other count series here.
  //
  // The headline is today's `done of planned`, and the qualifier carries the
  // window's adherence — computed over days that HAD a plan (missionAdherence),
  // so it is the same refusal one level up.
  const missionPoints = missionDailySeries(db, 14, today);
  const missionToday = missionPoints[missionPoints.length - 1] ?? {
    date: today,
    planned: 0,
    completed: 0,
    skipped: 0,
  };
  const adherence = missionAdherence(missionPoints);
  const mission: DataTrend = {
    key: 'mission',
    name: 'Mission',
    sub: 'Completed · last 14 days',
    spark: missionPoints.map((p) => p.completed),
    sparkBaseline: 'zero',
    // No denominator, no fraction: on a day with no plan the headline is the
    // bare count of what was done, never "0 of 0".
    value: String(missionToday.completed),
    unit: missionToday.planned > 0 ? `of ${missionToday.planned}` : '',
    qualifier: adherence !== null ? `${Math.round(adherence * 100)}% · 14 d` : null,
    // Keyed on whether ANY day in the window carried a plan — a fortnight with
    // no protocols has no completion history to draw, and a flat row of zero
    // bars would read as fourteen days of failure.
    empty: missionPoints.every((p) => p.planned === 0),
    emptyLabel: 'No plan yet — build a protocol',
  };

  // Weight — latest reading is the headline; the 30-day series is the trend.
  const weightLatest = latestBody(db, 'weight_kg');
  const weightPoints = bodySeries(db, 'weight_kg', 30, now);
  const weightMetric = metricByBodyColumn('weight_kg');
  let weightValue = '—';
  let weightUnit = '';
  let weightQualifier: string | null = null;
  if (weightLatest && weightMetric) {
    const spec = resolveDisplay(weightMetric, units);
    weightValue = roundToSpec(spec, spec.fromCanonical(weightLatest.value)).toFixed(spec.decimals);
    weightUnit = spec.unit;
    weightQualifier = shortDate(weightLatest.measuredAt);
  }
  const weight: DataTrend = {
    key: 'weight',
    name: 'Weight',
    sub: 'Last 30 days',
    spark: weightPoints.map((p) => p.value),
    // Weight clusters far from zero, so scale the bars to the series' own range.
    sparkBaseline: 'auto',
    value: weightValue,
    unit: weightUnit,
    qualifier: weightQualifier,
    // A single old reading still gives a headline; only a never-logged metric
    // has nothing to show.
    empty: weightLatest === null,
    emptyLabel: 'Log weight to start a trend',
  };

  // Water — today's intake is the headline; the last 14 days are the trend.
  //
  // The window is 14 to agree with app/water.tsx, which this row opens: a
  // sparkline over one period drilling into a screen that judges another makes
  // the two disagree about the same fortnight (the rule mission-history records).
  //
  // Rendered in the user's chosen volume unit, never hardcoded ml — storage is
  // canonical ml and oz/ml is a live setting (app/settings-units.tsx).
  const waterPoints = waterDaySeries(db, 14, today);
  const waterToday = waterPoints[waterPoints.length - 1] ?? { date: today, ml: 0, entries: 0 };
  const waterMetric = metricByKey('water');
  const waterSpec = waterMetric ? resolveDisplay(waterMetric, units) : null;
  const water: DataTrend = {
    key: 'water',
    name: 'Water',
    sub: 'Intake today',
    spark: waterPoints.map((p) => p.ml),
    sparkBaseline: 'zero',
    // THREE states, not two, because "nothing yet today" and "0 oz today" are
    // different facts and only one of them is true. A row that has drawn a
    // fortnight of bars cannot claim the empty label — the user HAS logged water
    // — but neither may it print a confident 0 for a day that simply has not
    // started. So the headline goes to an em-dash and the qualifier says why.
    value:
      waterToday.entries > 0 && waterSpec
        ? fmtInt(roundToSpec(waterSpec, waterSpec.fromCanonical(waterToday.ml)))
        : '—',
    unit: waterToday.entries > 0 && waterSpec ? waterSpec.unit : '',
    qualifier: waterToday.entries === 0 ? 'none logged today' : null,
    // Keyed on the ENTRY COUNT across the window, not on today's millilitres. A
    // day can only ever hold captures of a positive amount, so `ml === 0` means
    // "nothing logged" — and a fortnight of that must say so rather than print a
    // confident 0 oz beside a flat row of bars.
    empty: waterPoints.every((p) => p.entries === 0),
    emptyLabel: 'No water logged yet',
  };

  // Nutrition — today's energy is the headline; the last 7 days are the trend.
  const intakeTotals = todayTotals(db, today);
  const intakePoints = dailyIntakeSeries(db, 7, today);
  const nutrition: DataTrend = {
    key: 'nutrition',
    name: 'Nutrition',
    sub: 'Energy today',
    spark: intakePoints.map((p) => p.kcal),
    sparkBaseline: 'zero',
    value: fmtInt(intakeTotals.kcal),
    unit: 'kcal',
    qualifier: null,
    // Keyed on meal COUNT, not the kcal sum: a meal saved with only a name (kcal
    // NULL) is a real record that must not read as "No meals yet".
    empty: intakePoints.every((p) => p.mealCount === 0),
    emptyLabel: 'No meals yet',
  };

  // Training — this week's Zone 2 is the headline; the last 6 weeks are the trend.
  const week = weekSummary(db, now);
  const trainingPoints = weeklyTrainingSeries(db, 6, now);
  const training: DataTrend = {
    key: 'training',
    name: 'Training',
    sub: 'Zone 2 · this week',
    spark: trainingPoints.map((p) => p.zone2Min),
    sparkBaseline: 'zero',
    value: String(Math.round(week.zone2Min)),
    unit: 'min',
    qualifier: null,
    // Keyed on total workout COUNT: a week of only mobility/other sessions has
    // real workouts but zero Zone-2 minutes and zero strength sessions.
    empty: trainingPoints.every((p) => p.workoutCount === 0),
    emptyLabel: 'Nothing logged this week',
  };

  // Symptoms — today's count is the headline; the last 14 days are the trend.
  const todaySymptoms = listTodaySymptoms(db, today);
  const symptomPoints = symptomDailySeries(db, 14, today);
  const symptoms: DataTrend = {
    key: 'symptoms',
    name: 'Symptoms',
    sub: 'Last 14 days',
    spark: symptomPoints.map((p) => p.count),
    sparkBaseline: 'zero',
    value: String(todaySymptoms.length),
    unit: 'today',
    qualifier: null,
    empty: symptomPoints.every((p) => p.count === 0),
    // Window-accurate: `empty` covers the whole 14-day series (matches `sub`).
    emptyLabel: 'None in 14 days',
  };

  return {
    // Water sits beside the other body readings, after Weight: it is a daily
    // behaviour like Nutrition, and the order runs execution → body → intake.
    trends: [mission, weight, water, nutrition, training, symptoms],
  };
}

export function useDataOverview(): DataOverview {
  const [state, setState] = useState(read);

  const reload = useCallback(() => {
    setState(read());
  }, []);

  useFocusEffect(reload);

  return { ...state, reload };
}
