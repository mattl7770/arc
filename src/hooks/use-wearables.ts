import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import {
  dailyMetricSeries,
  deviceLabel,
  getHealthSyncState,
  latestMetric,
  recentWearableWorkouts,
  type WearableWorkout,
} from '@/lib/db/repositories/wearables';
import { getPreferences, isHealthSyncEnabled } from '@/lib/db/repositories/user';
import { isHealthKitSupported } from '@/lib/health/healthkit';
import { subscribeHealthSync } from '@/lib/health/sync';

/**
 * The Data-tab wearable history view model (docs/wearables-subapp.md §7):
 * per-metric 30-day sparklines + latest values with source labels, grouped
 * Recovery / Sleep / Activity, plus recent ingested workouts and the sync
 * footer state. Same read pattern as use-data-overview (synchronous initial
 * read, re-read on focus) plus a health-sync subscription so a finishing
 * background sync refreshes an already-open screen.
 */

export interface WearableMetricRow {
  key: string;
  /** Serif name. */
  name: string;
  /** Tiny descriptor under the name ("30 days"). */
  sub: string;
  /** Sparkline series, oldest → newest; empty when the metric has no data. */
  spark: number[];
  sparkBaseline: 'zero' | 'auto';
  /** Mono headline (already formatted); '—' when empty. */
  value: string;
  /** Muted unit after the value ('' when the value stands alone). */
  unit: string;
  /** Source + date qualifier ("Apple Watch · Jul 29"), or null. */
  qualifier: string | null;
  empty: boolean;
}

export interface WearableSection {
  title: string;
  rows: WearableMetricRow[];
}

export interface WearablesOverview {
  /** Whether the native module is in this binary. False on web/node, and on
   * any build predating the module — it landed in the owner's 2026-08-25 EAS
   * build. */
  supported: boolean;
  enabled: boolean;
  lastSyncedAt: string | null;
  sections: WearableSection[];
  workouts: WearableWorkout[];
  /** True when not a single wearable row exists yet. */
  allEmpty: boolean;
  reload: () => void;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-07-29" → "Jul 29" (componentwise — never new Date(string) for days). */
function shortDay(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1] ?? ''} ${d ?? ''}`;
}

function fmtInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtSleep(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

type MetricSpec = {
  key: string;
  name: string;
  sparkBaseline: 'zero' | 'auto';
  /** canonical value → [display value string, unit label]. */
  format: (value: number, fahrenheit: boolean) => [string, string];
};

const cToF = (c: number) => (c * 9) / 5 + 32;

const RECOVERY: MetricSpec[] = [
  { key: 'hrv', name: 'HRV', sparkBaseline: 'auto', format: (v) => [String(Math.round(v)), 'ms'] },
  {
    key: 'rhr',
    name: 'Resting HR',
    sparkBaseline: 'auto',
    format: (v) => [String(Math.round(v)), 'bpm'],
  },
  {
    key: 'respiratory_rate',
    name: 'Respiratory rate',
    sparkBaseline: 'auto',
    format: (v) => [v.toFixed(1), 'br/min'],
  },
  {
    key: 'spo2_pct',
    name: 'Blood oxygen',
    sparkBaseline: 'auto',
    format: (v) => [v.toFixed(1), '%'],
  },
  {
    key: 'wrist_temp_c',
    name: 'Wrist temperature',
    sparkBaseline: 'auto',
    format: (v, f) => (f ? [cToF(v).toFixed(1), '°F'] : [v.toFixed(1), '°C']),
  },
];

const SLEEP: MetricSpec[] = [
  {
    key: 'sleep_duration_min',
    name: 'Sleep',
    sparkBaseline: 'zero',
    format: (v) => [fmtSleep(v), ''],
  },
  {
    key: 'sleep_deep_min',
    name: 'Deep',
    sparkBaseline: 'zero',
    format: (v) => [String(Math.round(v)), 'min'],
  },
  {
    key: 'sleep_rem_min',
    name: 'REM',
    sparkBaseline: 'zero',
    format: (v) => [String(Math.round(v)), 'min'],
  },
];

const ACTIVITY: MetricSpec[] = [
  { key: 'steps', name: 'Steps', sparkBaseline: 'zero', format: (v) => [fmtInt(v), ''] },
  {
    key: 'active_energy_kcal',
    name: 'Active energy',
    sparkBaseline: 'zero',
    format: (v) => [fmtInt(v), 'kcal'],
  },
  {
    key: 'vo2max',
    name: 'VO₂max',
    sparkBaseline: 'auto',
    format: (v) => [v.toFixed(1), 'ml/kg·min'],
  },
];

function read(): Omit<WearablesOverview, 'reload'> {
  const db = getDb();
  const today = todayISODate();
  const fahrenheit = getPreferences(db).units.temperature === 'F';

  const buildRow = (spec: MetricSpec): WearableMetricRow => {
    const series = dailyMetricSeries(db, spec.key, 30, today);
    const latest = latestMetric(db, spec.key);
    const empty = latest === null;
    let value = '—';
    let unit = '';
    let qualifier: string | null = null;
    if (latest) {
      [value, unit] = spec.format(latest.value, fahrenheit);
      qualifier = `${deviceLabel(latest.sourceDevice)} · ${shortDay(latest.date)}`;
    }
    return {
      key: spec.key,
      name: spec.name,
      sub: 'Last 30 days',
      spark: series.map((p) => p.value),
      sparkBaseline: spec.sparkBaseline,
      value,
      unit,
      qualifier,
      empty,
    };
  };

  const sections: WearableSection[] = [
    { title: 'Recovery', rows: RECOVERY.map(buildRow) },
    { title: 'Sleep', rows: SLEEP.map(buildRow) },
    { title: 'Activity', rows: ACTIVITY.map(buildRow) },
  ];

  const workouts = recentWearableWorkouts(db, 8);
  const allEmpty = workouts.length === 0 && sections.every((s) => s.rows.every((r) => r.empty));

  return {
    supported: isHealthKitSupported(),
    enabled: isHealthSyncEnabled(db),
    lastSyncedAt: getHealthSyncState(db).lastSyncedAt,
    sections,
    workouts,
    allEmpty,
  };
}

export function useWearables(): WearablesOverview {
  const [state, setState] = useState(read);

  const reload = useCallback(() => {
    setState(read());
  }, []);

  useFocusEffect(reload);
  useEffect(() => subscribeHealthSync(reload), [reload]);

  return { ...state, reload };
}
