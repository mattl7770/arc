import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { bodySeries, latestBody } from '@/lib/db/repositories/body';
import type { BiomarkerRange } from '@/lib/db/repositories/biomarkers';
import { listBiomarkerRanges } from '@/lib/db/repositories/biomarkers';
import { weeklyTrainingSeries, weekSummary } from '@/lib/db/repositories/exercise';
import { dailyIntakeSeries, todayTotals } from '@/lib/db/repositories/nutrition';
import { listTodaySymptoms, symptomDailySeries } from '@/lib/db/repositories/symptoms';
import { getPreferences } from '@/lib/db/repositories/user';
import { metricByBodyColumn, resolveDisplay, roundToSpec } from '@/lib/log/metrics';

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
export type TrendKey = 'weight' | 'nutrition' | 'training' | 'symptoms';

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

export interface DataOverviewState {
  trends: DataTrend[];
  biomarkers: BiomarkerRange[];
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
    trends: [weight, nutrition, training, symptoms],
    biomarkers: listBiomarkerRanges(db),
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
