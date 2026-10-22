/**
 * Garmin Personal API responses → `wearable_data` rows. PURE: no fetch, no
 * database, no clock — db/garmin.test.mjs pins every mapper against fixtures
 * built from Garmin's published OpenAPI schemas (2026-10-21).
 *
 * ## The row contract (docs/wearables-subapp.md §26)
 *
 *   - `source_device = 'garmin'` (allowed by 0021's CHECK; no migration).
 *   - `source_raw_id = 'gp:<metric_type>:<calendarDate>'`, so a re-fetch of a
 *     day UPDATES its row. Garmin hands back `calendarDate` itself, so there is
 *     no timezone guessing here: the day is the one Garmin filed it under.
 *   - The `gp:` prefix is load-bearing twice: the Apple Health re-window prune
 *     deletes only `hk:*` rows, so it can never remove these; and the dedup
 *     below tells a Garmin-API row from the same band's rows arriving through
 *     Apple Health (`hk:*`, also bucketed `garmin`).
 *   - **Every figure the Coach should read is its own `metric_type`.** HRV
 *     status and baseline are not metadata on the `hrv` row: nothing in the
 *     Coach or on Home reads wearable metadata (garmin-all-data.md §2).
 *
 * ## What maps from where
 *
 * | metric_type | endpoint | field |
 * |---|---|---|
 * | `hrv` (ms, RMSSD) | hrv daily | `lastNightAvg` |
 * | `hrv_weekly_avg` (ms) | hrv daily | `weeklyAvg` |
 * | `hrv_status` (code) | hrv daily | `status`: 1 poor · 2 low · 3 unbalanced · 4 balanced |
 * | `hrv_baseline_low` / `hrv_baseline_high` (ms) | hrv daily | `baseline.balancedLow` / `balancedUpper` |
 * | `sleep_duration_min`, `sleep_deep_min`, `sleep_core_min` (Garmin "light"), `sleep_rem_min`, `sleep_awake_min` | sleep | `*SleepSeconds` ÷ 60 |
 * | `sleep_score` (score) | sleep | `sleepScores.overall.value` |
 * | `spo2_pct`, `spo2_lowest_pct` | sleep | `averageSpO2Value`, `lowestSpO2Value` |
 * | `respiratory_rate` (brpm) | sleep | `averageRespirationValue` |
 * | `rhr` (bpm) | daily summaries | `heartRate.restingValue` |
 * | `stress_avg` (score) | daily summaries | `stress.avgLevel` |
 * | `body_battery_high` / `body_battery_low` | daily summaries | `bodyBattery.maxValue` / `minValue` |
 * | `body_battery_wake` | Body Battery report | the reading at the end of the night's SLEEP event |
 * | `vo2max` (ml/kg/min) | activity search | `vO2MaxValue`, the day's latest activity |
 *
 * One endpoint per metric, on purpose: two endpoints writing one raw id would
 * flip the stored value back and forth depending on which chunk a pass fetched.
 * SpO2 and respiration are overnight figures, read from the sleep record.
 *
 * Values outside a physiological or documented range are dropped, never
 * clamped: Garmin uses negative sentinels for "not enough data".
 */
import type { WearableUpsert } from '@/lib/db/repositories/wearables';

export const GARMIN_RAW_PREFIX = 'gp:';
/** The metadata every Garmin-API row carries. Stable, so a re-fetch is a no-op. */
const VIA = 'garmin_personal_api';

export function garminRawId(metricType: string, date: string): string {
  return `${GARMIN_RAW_PREFIX}${metricType}:${date}`;
}

/** Garmin's HRV status as a number, because `wearable_data.value` is `real NOT NULL`. */
export const HRV_STATUS_CODES: Readonly<Record<string, number>> = {
  POOR: 1,
  LOW: 2,
  UNBALANCED: 3,
  BALANCED: 4,
};

/** Code → word, for screens. */
export const HRV_STATUS_WORDS: Readonly<Record<number, string>> = {
  1: 'Poor',
  2: 'Low',
  3: 'Unbalanced',
  4: 'Balanced',
};

export type GarminMetricSpec = {
  metricType: string;
  /** What the Coach and the screens call it. */
  label: string;
  unit: string;
  decimals: number;
  /**
   * Set when the value is a CODE, not a quantity: code → word. The Coach's
   * catalog then counts days per status and never averages the codes.
   */
  categories?: Readonly<Record<number, string>>;
};

/**
 * The metric types ONLY the Garmin link writes. The types it shares with
 * Apple Health (hrv, rhr, sleep_*, spo2_pct, respiratory_rate, vo2max) are
 * declared by the HealthKit pipeline already. The Coach's catalog reads this
 * list (src/lib/ai/tools/read-tools.ts), so each arrives labelled rather than
 * guessed.
 */
export const GARMIN_API_METRICS: readonly GarminMetricSpec[] = [
  {
    metricType: 'hrv_status',
    label: 'Garmin HRV status (1 poor, 2 low, 3 unbalanced, 4 balanced)',
    unit: 'code',
    decimals: 0,
    categories: HRV_STATUS_WORDS,
  },
  { metricType: 'hrv_weekly_avg', label: 'Garmin HRV 7-day average', unit: 'ms', decimals: 0 },
  {
    metricType: 'hrv_baseline_low',
    label: 'Garmin HRV balanced range, low end',
    unit: 'ms',
    decimals: 0,
  },
  {
    metricType: 'hrv_baseline_high',
    label: 'Garmin HRV balanced range, high end',
    unit: 'ms',
    decimals: 0,
  },
  { metricType: 'sleep_score', label: 'Garmin sleep score (0–100)', unit: 'score', decimals: 0 },
  {
    metricType: 'spo2_lowest_pct',
    label: 'Lowest blood oxygen overnight',
    unit: 'pct',
    decimals: 0,
  },
  {
    metricType: 'stress_avg',
    label: 'Garmin stress, day average (0–100)',
    unit: 'score',
    decimals: 0,
  },
  { metricType: 'body_battery_high', label: 'Body Battery high', unit: 'score', decimals: 0 },
  { metricType: 'body_battery_low', label: 'Body Battery low', unit: 'score', decimals: 0 },
  { metricType: 'body_battery_wake', label: 'Body Battery at wake', unit: 'score', decimals: 0 },
];

/**
 * Metrics Apple Health can ALSO supply, mapped to the HealthKit row that
 * decides whether the Garmin-API row is written (see {@link dropHealthSupplied}).
 * The whole sleep family hangs on `sleep_duration_min`, so one night is never
 * assembled from two sources. `hrv` is deliberately absent: Garmin never writes
 * HRV to Apple Health, and the Garmin reading is preferred where both exist.
 */
export const HEALTH_SUPPLIED_BY: Readonly<Record<string, string>> = {
  rhr: 'rhr',
  sleep_duration_min: 'sleep_duration_min',
  sleep_deep_min: 'sleep_duration_min',
  sleep_core_min: 'sleep_duration_min',
  sleep_rem_min: 'sleep_duration_min',
  sleep_awake_min: 'sleep_duration_min',
  spo2_pct: 'spo2_pct',
  respiratory_rate: 'respiratory_rate',
  vo2max: 'vo2max',
};

// --- Safe readers -----------------------------------------------------------

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function num(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function day(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = value.slice(0, 10);
  return DATE_SHAPE.test(date) ? date : null;
}

/** A list from either a bare array, a `data` envelope, or one object. */
function list(body: unknown, field?: string): Json[] {
  const source = field ? (obj(body)?.[field] ?? body) : body;
  if (Array.isArray(source)) return source.map(obj).filter((x): x is Json => x !== null);
  const single = obj(source);
  return single ? [single] : [];
}

/**
 * A Garmin GMT timestamp → epoch ms. The spec gives these as epoch
 * milliseconds in some places and "ISO 8601 without GMT offset or Z" in
 * others; a zoneless string is UTC by its own field name.
 */
export function gmtMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim().replace(' ', 'T');
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`;
  const ms = Date.parse(zoned);
  return Number.isNaN(ms) ? null : ms;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function row(
  date: string,
  metricType: string,
  value: number,
  unit: string,
  extra: { start?: string | null; end?: string | null; meta?: Json } = {}
): WearableUpsert {
  return {
    date,
    metricType,
    value,
    unit,
    sourceDevice: 'garmin',
    sourceRawId: garminRawId(metricType, date),
    startTime: extra.start ?? null,
    endTime: extra.end ?? null,
    metadata: { via: VIA, ...(extra.meta ?? {}) },
  };
}

// --- HRV --------------------------------------------------------------------

/**
 * `/hrv-service/hrv/daily/{from}/{to}` (`{hrvSummaries: [...]}`), or the
 * single-date `{hrvSummary}` shape. A night Garmin has no HRV for is simply
 * absent — the range answers 204 when it has none at all, which the client
 * turns into `null` and this into no rows.
 */
export function hrvRows(body: unknown): WearableUpsert[] {
  const summaries = [...list(body, 'hrvSummaries'), ...list(obj(body)?.hrvSummary)].filter(
    (s) => 'calendarDate' in s
  );
  const rows: WearableUpsert[] = [];
  for (const summary of summaries) {
    const date = day(summary.calendarDate);
    if (date === null) continue;
    const nightly = num(summary.lastNightAvg, 1, 400);
    if (nightly !== null) rows.push(row(date, 'hrv', nightly, 'ms', { meta: { method: 'rmssd' } }));
    const weekly = num(summary.weeklyAvg, 1, 400);
    if (weekly !== null) rows.push(row(date, 'hrv_weekly_avg', weekly, 'ms'));
    const status =
      typeof summary.status === 'string' ? HRV_STATUS_CODES[summary.status] : undefined;
    if (status !== undefined) rows.push(row(date, 'hrv_status', status, 'code'));
    const baseline = obj(summary.baseline);
    const low = num(baseline?.balancedLow, 1, 400);
    const high = num(baseline?.balancedUpper, 1, 400);
    if (low !== null) rows.push(row(date, 'hrv_baseline_low', low, 'ms'));
    if (high !== null) rows.push(row(date, 'hrv_baseline_high', high, 'ms'));
  }
  return rows;
}

// --- Sleep ------------------------------------------------------------------

/**
 * `/sleep-service/sleep/dailySleepSummariesByDate` (an array of DailySleepDTO)
 * or `/dailySleep` (one). A stage row is written only when Garmin measured
 * sleep that night; REM only from a REM-capable device, because its 0 there
 * means "cannot tell", not "none" (the same 0 ≠ unknown rule as the HealthKit
 * stages, docs/wearables-subapp.md §3). A night with no score gets the rest of
 * its rows and no `sleep_score` row.
 */
export function sleepRows(body: unknown): WearableUpsert[] {
  const rows: WearableUpsert[] = [];
  for (const night of list(body)) {
    const date = day(night.calendarDate);
    if (date === null) continue;
    const asleep = num(night.sleepTimeSeconds, 1, 86_400);
    const startMs = gmtMs(night.sleepStartTimestampGMT);
    const endMs = gmtMs(night.sleepEndTimestampGMT);
    // Bounds that run backwards would fail wearable_data's start <= end CHECK
    // and take the whole batch with them; the minutes stand without them.
    const ordered = startMs !== null && endMs !== null && endMs >= startMs;
    const start = ordered ? iso(startMs) : null;
    const end = ordered ? iso(endMs) : null;
    if (asleep !== null) {
      rows.push(row(date, 'sleep_duration_min', asleep / 60, 'min', { start, end }));
      const stages: [string, unknown][] = [
        ['sleep_deep_min', night.deepSleepSeconds],
        ['sleep_core_min', night.lightSleepSeconds],
        ['sleep_awake_min', night.awakeSleepSeconds],
      ];
      if (night.deviceRemCapable !== false) stages.push(['sleep_rem_min', night.remSleepSeconds]);
      for (const [metricType, seconds] of stages) {
        const value = num(seconds, 0, 86_400);
        if (value !== null) rows.push(row(date, metricType, value / 60, 'min', { start, end }));
      }
    }
    const score = num(obj(obj(night.sleepScores)?.overall)?.value, 0, 100);
    if (score !== null) rows.push(row(date, 'sleep_score', score, 'score'));
    const spo2 = num(night.averageSpO2Value, 50, 100);
    if (spo2 !== null) rows.push(row(date, 'spo2_pct', spo2, 'pct'));
    const lowest = num(night.lowestSpO2Value, 50, 100);
    if (lowest !== null) rows.push(row(date, 'spo2_lowest_pct', lowest, 'pct'));
    const respiration = num(night.averageRespirationValue, 1, 60);
    if (respiration !== null) rows.push(row(date, 'respiratory_rate', respiration, 'brpm'));
  }
  return rows;
}

// --- Daily summaries --------------------------------------------------------

/**
 * `/usersummary-service/v2/dailysummaries` (`{data: [UserDailySummaryV2DTO]}`).
 * A day with `includesWellnessData: false` carries no wellness figures, so it
 * writes nothing. Stress is Garmin's 0–100 scale (negative = not enough data);
 * Body Battery is documented as 5–100.
 */
export function dailySummaryRows(body: unknown): WearableUpsert[] {
  const rows: WearableUpsert[] = [];
  for (const summary of list(body, 'data')) {
    const date = day(summary.calendarDate);
    if (date === null || summary.includesWellnessData === false) continue;
    const resting = num(obj(summary.heartRate)?.restingValue, 20, 200);
    if (resting !== null) rows.push(row(date, 'rhr', resting, 'bpm'));
    const stress = num(obj(summary.stress)?.avgLevel, 0, 100);
    if (stress !== null) rows.push(row(date, 'stress_avg', stress, 'score'));
    const battery = obj(summary.bodyBattery);
    const high = num(battery?.maxValue, 0, 100);
    const low = num(battery?.minValue, 0, 100);
    if (high !== null) rows.push(row(date, 'body_battery_high', high, 'score'));
    if (low !== null) rows.push(row(date, 'body_battery_low', low, 'score'));
  }
  return rows;
}

// --- Body Battery at wake ---------------------------------------------------

/** How far from the wake instant a reading may sit and still be "at wake". */
const WAKE_READING_TOLERANCE_MS = 2 * 60 * 60 * 1000;

/**
 * `/wellness-service/wellness/bodyBattery/reports/daily` — one report per day.
 * Wake is the end of the day's longest SLEEP event (start + duration); the
 * figure is the first reading at or after it, else the last one before it,
 * within two hours either way. A day with no SLEEP event, or no reading near
 * it, writes nothing rather than a guess.
 */
export function bodyBatteryRows(body: unknown): WearableUpsert[] {
  const rows: WearableUpsert[] = [];
  for (const report of list(body)) {
    const date = day(report.date);
    if (date === null) continue;
    let wake: number | null = null;
    let longest = 0;
    for (const event of list(report.bodyBatteryActivityEvent)) {
      if (event.eventType !== 'SLEEP') continue;
      const start = gmtMs(event.eventStartTimeGmt);
      const duration = num(event.durationInMilliseconds, 1, 86_400_000);
      if (start === null || duration === null || duration <= longest) continue;
      longest = duration;
      wake = start + duration;
    }
    if (wake === null) continue;
    const descriptors = list(report.bodyBatteryValueDescriptorDTOList);
    const columnOf = (key: string) => {
      const found = descriptors.find((d) => d.bodyBatteryValueDescriptorKey === key);
      return typeof found?.bodyBatteryValueDescriptorIndex === 'number'
        ? found.bodyBatteryValueDescriptorIndex
        : null;
    };
    const tsCol = columnOf('timestamp');
    const levelCol = columnOf('bodyBatteryLevel');
    if (tsCol === null || levelCol === null || !Array.isArray(report.bodyBatteryValuesArray))
      continue;
    const readings: { at: number; level: number }[] = [];
    for (const entry of report.bodyBatteryValuesArray as unknown[]) {
      if (!Array.isArray(entry)) continue;
      const at = gmtMs(entry[tsCol]);
      const level = num(entry[levelCol], 0, 100);
      if (at !== null && level !== null) readings.push({ at, level });
    }
    readings.sort((a, b) => a.at - b.at);
    const after = readings.find((r) => r.at >= wake! && r.at - wake! <= WAKE_READING_TOLERANCE_MS);
    const before = [...readings]
      .reverse()
      .find((r) => r.at < wake! && wake! - r.at <= WAKE_READING_TOLERANCE_MS);
    const pick = after ?? before;
    if (pick)
      rows.push(
        row(date, 'body_battery_wake', pick.level, 'score', { meta: { wakeAt: iso(wake) } })
      );
  }
  return rows;
}

// --- VO2 max ----------------------------------------------------------------

/**
 * `/activitylist-service/activities/search/activities` — VO2 max is a figure
 * Garmin attaches to an activity, so the day is the activity's LOCAL start
 * date, and two on one day keep the later one.
 */
export function activityVo2Rows(body: unknown): WearableUpsert[] {
  const latest = new Map<string, { at: string; value: number }>();
  for (const activity of list(body)) {
    const local = typeof activity.startTimeLocal === 'string' ? activity.startTimeLocal : null;
    const date = day(local);
    const value = num(activity.vO2MaxValue, 10, 100);
    if (date === null || local === null || value === null) continue;
    const current = latest.get(date);
    if (!current || local > current.at) latest.set(date, { at: local, value });
  }
  return [...latest.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, { value }]) => row(date, 'vo2max', value, 'ml_kg_min'));
}

// --- Apple Health dedup -----------------------------------------------------

/** `metric|date` keys of Apple Health (`hk:`) rows the Garmin Connect app wrote (`garmin`). */
export type HealthSuppliedKeys = ReadonlySet<string>;

/**
 * Split a batch into rows to write and rows Apple Health already supplies.
 *
 * The rule is the one the 2026-09-25 plan set: sleep, resting HR and the other
 * shared figures stay on the `hk:` rows when the Garmin Connect app has put
 * them in Apple Health for that day, so a day never carries two `garmin` rows
 * for one metric (a tie the read side's source priority cannot break). The
 * Garmin-API row fills the day when Garmin Connect sent nothing. Another
 * device's `hk:` row is a different reading and does not suppress it: source
 * priority arbitrates that on read. HRV and every Garmin-only figure always
 * pass.
 * `drop` is returned so the caller can delete a `gp:` row an earlier pass
 * wrote before HealthKit's row arrived. Pure.
 */
export function dropHealthSupplied(
  rows: readonly WearableUpsert[],
  healthKeys: HealthSuppliedKeys
): { keep: WearableUpsert[]; drop: WearableUpsert[] } {
  const keep: WearableUpsert[] = [];
  const drop: WearableUpsert[] = [];
  for (const candidate of rows) {
    const decider = HEALTH_SUPPLIED_BY[candidate.metricType];
    if (decider !== undefined && healthKeys.has(`${decider}|${candidate.date}`))
      drop.push(candidate);
    else keep.push(candidate);
  }
  return { keep, drop };
}
