/**
 * The Log tab's data layer: ad-hoc captures in, today's running record out.
 *
 * Captures made through the Log tab (a free note, a keypad metric, a parsed
 * command) are "ad-hoc" — distinct from the planned/mission entries Home shows.
 * The two live in different places:
 *   - notes and generic metrics → `log_entries`, marked `value.adhoc = true` so
 *     `listMission` (Home) filters them out and this feed filters them *in*;
 *   - body metrics (weight/body-fat/waist) → `body_metrics` (canonical kg/cm);
 *   - other numeric metrics (water/HRV/RHR) → `wearable_data` (canonical ml/…),
 *     `source_device = 'manual'`, so a smart bottle or Apple Health can later
 *     add rows to the same metric_type without a migration.
 *
 * Everything crosses through the metric registry (src/lib/log/metrics.ts), so
 * units and persistence targets are defined once.
 */
import type { Database } from '../database';
import { localDayUtcRange, clockFromISO, todayISODate } from '../date';
import { newId } from '../id';
import { getOrCreateDailyLog } from './mission';
import type { BodyMetricRow, LogEntryRow, WearableDataRow } from '../types';
import {
  formatCanonical,
  formatMeasured,
  metricByBodyColumn,
  metricByKey,
  metricByWearableType,
  resolveDisplay,
  type MetricDescriptor,
  type MetricKey,
} from '@/lib/log/metrics';
import type { UnitPreferences } from '@/lib/user/types';
import type { LogFeedItem } from '@/types/log';

const nowISO = () => new Date().toISOString();

/**
 * A UTC ISO instant at LOCAL noon of a `YYYY-MM-DD` — how a backdated body
 * metric gets stamped onto its intended day. Noon (not midnight) keeps the
 * reading inside the local day for any UTC offset within ±12h, so a consumer
 * that reads it back through a LOCAL-day window (localDayUtcRange) always lands
 * it on `date`.
 *
 * It is NOT flip-proof for its own UTC-date portion: at an offset beyond +12h
 * (New Zealand DST +13, Chatham +13:45, Kiribati +14) local noon falls on the
 * PREVIOUS UTC date, and at exactly −12h on the NEXT. A consumer that buckets by
 * substr(measured_at,1,10) instead of a local window therefore attributes the
 * reading to the wrong calendar day at those extremes. Bucket backdated body
 * readings through a local window, not the raw UTC date. (See logMetric.)
 */
function dayInstant(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 12, 0, 0, 0).toISOString();
}

/** Save a free-text note (a log with no metric bucket, written for the Coach). */
export function logNote(db: Database, date: string, text: string): string {
  const log = getOrCreateDailyLog(db, date);
  const id = newId(db);
  db.run(
    `INSERT INTO log_entries
       (id, daily_log_id, type, title, status, completed_at, value, source)
     VALUES (?, ?, 'note', ?, 'completed', ?, ?, 'manual')`,
    [id, log.id, text, nowISO(), JSON.stringify({ adhoc: true })]
  );
  return id;
}

/**
 * Persist one keypad/parsed metric at its canonical value, routing to the table
 * the registry names. `date` is the local day (for the wearable `date` column);
 * body metrics stamp a UTC `measured_at`.
 */
export function logMetric(
  db: Database,
  date: string,
  metricKey: MetricKey,
  canonical: number
): void {
  const metric = metricByKey(metricKey);
  if (!metric) throw new Error(`logMetric: unknown metric "${metricKey}"`);
  const target = metric.target;

  if (target.kind === 'body') {
    // Column comes from the registry (a fixed union), not user input.
    // body_metrics has no `date` column — only a UTC `measured_at`. For TODAY we
    // stamp the real instant (preserves time-of-day + ordering); for a BACKDATE
    // (the Coach forwards one when the user reports a past event) we stamp local
    // noon of that day, so a LOCAL-day window read (localDayUtcRange) lands the
    // reading on the intended day for any timezone — not silently on today,
    // which would corrupt the daily series. A consumer that instead slices
    // substr(measured_at,1,10) only agrees within ±12h of UTC; beyond that local
    // noon flips to an adjacent UTC date (see dayInstant), so day-bucket readers
    // should go through a local window rather than the raw UTC date.
    const measuredAt = date === todayISODate() ? nowISO() : dayInstant(date);
    db.run(
      `INSERT INTO body_metrics (id, measured_at, ${target.column}, source) VALUES (?, ?, ?, 'manual')`,
      [newId(db), measuredAt, canonical]
    );
    return;
  }

  if (target.kind === 'wearable') {
    db.run(
      `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device)
       VALUES (?, ?, ?, ?, ?, 'manual')`,
      [newId(db), date, target.metricType, canonical, target.canonicalUnit]
    );
    return;
  }

  // Generic: no dedicated table — a log_entries row of type 'metric'.
  const log = getOrCreateDailyLog(db, date);
  db.run(
    `INSERT INTO log_entries
       (id, daily_log_id, type, title, status, completed_at, value, source)
     VALUES (?, ?, 'metric', ?, 'completed', ?, ?, 'manual')`,
    [
      newId(db),
      log.id,
      formatCanonical(metric, canonical),
      nowISO(),
      JSON.stringify({ adhoc: true, metricKey, canonical }),
    ]
  );
}

/** The capture types the Log-tab Supplement/Therapy sheet writes. */
export type CaptureType = 'supplement' | 'therapy' | 'medication';

/** Display category for each ad-hoc `log_entries.type` shown in the feed. */
const CAPTURE_CATEGORY: Record<string, string> = {
  supplement: 'Supplements',
  medication: 'Medications',
  therapy: 'Therapies',
  meal: 'Nutrition',
  workout: 'Training',
  habit: 'Routine',
};

/**
 * Persist a Supplement / Therapy / Medication capture as an ad-hoc `log_entries`
 * row. `title` is the display line (e.g. "Creatine · 5 g", "Sauna · 20 min");
 * marked `adhoc` so it stays off Home's mission and in the Log feed.
 */
export function logCapture(
  db: Database,
  date: string,
  type: CaptureType,
  title: string,
  opts: { protocol?: boolean } = {}
): string {
  const log = getOrCreateDailyLog(db, date);
  const id = newId(db);
  db.run(
    `INSERT INTO log_entries
       (id, daily_log_id, type, title, status, completed_at, value, source)
     VALUES (?, ?, ?, ?, 'completed', ?, ?, 'manual')`,
    [
      id,
      log.id,
      type,
      title.trim(),
      nowISO(),
      JSON.stringify({ adhoc: true, ...(opts.protocol ? { protocol: true } : {}) }),
    ]
  );
  return id;
}

/** Generic-metric payload stashed in `log_entries.value`. */
type GenericMetricValue = { metricKey?: string; canonical?: number };

function parseValue(value: string | null): GenericMetricValue {
  if (!value) return {};
  try {
    return JSON.parse(value) as GenericMetricValue;
  } catch {
    return {};
  }
}

/**
 * Today's running record for the Log tab, newest first — a union of the three
 * capture tables. Only ad-hoc captures appear (the planned mission lives on
 * Home). The local `date` and the body-metrics UTC range are both derived from
 * the single `now` argument, so they can't disagree; `now` is injectable so the
 * headless tests are deterministic.
 */
export function listTodayEntries(
  db: Database,
  now: Date = new Date(),
  units?: UnitPreferences
): LogFeedItem[] {
  const date = todayISODate(now);
  const { startUtc, endUtc } = localDayUtcRange(now);
  const rows: (LogFeedItem & { sortKey: string })[] = [];

  // 1) Ad-hoc log_entries — notes and generic metrics.
  const logRows = db.all<LogEntryRow>(
    `SELECT le.* FROM log_entries le
       JOIN daily_logs dl ON dl.id = le.daily_log_id
     WHERE dl.date = ? AND json_extract(le.value, '$.adhoc') = 1`,
    [date]
  );
  for (const r of logRows) {
    if (r.type === 'note') {
      rows.push({
        id: r.id,
        time: clockFromISO(r.created_at),
        title: r.title,
        category: 'Note',
        note: true,
        sortKey: r.created_at,
      });
    } else if (r.type === 'metric') {
      const extras = parseValue(r.value);
      const metric = extras.metricKey ? metricByKey(extras.metricKey) : undefined;
      const title =
        metric && typeof extras.canonical === 'number'
          ? formatForUnits(metric, extras.canonical, units)
          : r.title;
      rows.push({
        id: r.id,
        time: clockFromISO(r.created_at),
        title,
        category: metric?.label ?? 'Metric',
        sortKey: r.created_at,
      });
    } else {
      // Capture types (supplement / therapy / medication) — the title carries
      // the display line already.
      rows.push({
        id: r.id,
        time: clockFromISO(r.created_at),
        title: r.title,
        category: CAPTURE_CATEGORY[r.type] ?? 'Logged',
        sortKey: r.created_at,
      });
    }
  }

  // 2) Manual wearable metrics — water, HRV, RHR.
  const wearableRows = db.all<WearableDataRow>(
    `SELECT * FROM wearable_data WHERE date = ? AND source_device = 'manual'`,
    [date]
  );
  for (const r of wearableRows) {
    const metric = metricByWearableType(r.metric_type);
    const title = metric
      ? formatForUnits(metric, r.value, units)
      : `${r.value}${r.unit ? ` ${r.unit}` : ''}`;
    rows.push({
      id: r.id,
      time: clockFromISO(r.created_at),
      title,
      category: metric?.label ?? r.metric_type,
      sortKey: r.created_at,
    });
  }

  // 3) Manual body metrics — one row can carry more than one measurement.
  const bodyRows = db.all<BodyMetricRow>(
    `SELECT * FROM body_metrics
     WHERE source = 'manual' AND measured_at >= ? AND measured_at < ?`,
    [startUtc, endUtc]
  );
  const BODY_COLUMNS = ['weight_kg', 'body_fat_pct', 'waist_cm'] as const;
  for (const r of bodyRows) {
    for (const column of BODY_COLUMNS) {
      const value = r[column];
      if (value == null) continue;
      const metric = metricByBodyColumn(column);
      rows.push({
        id: `${r.id}:${column}`,
        time: clockFromISO(r.created_at),
        title: metric ? formatForUnits(metric, value, units) : String(value),
        category: metric?.label ?? column,
        sortKey: r.created_at,
      });
    }
  }

  // 4) Symptoms — their own table (0004), keyed on the local `date` column.
  const symptomRows = db.all<{
    id: string;
    name: string;
    severity: number | null;
    created_at: string;
  }>(`SELECT id, name, severity, created_at FROM symptoms WHERE date = ?`, [date]);
  for (const r of symptomRows) {
    const sev = r.severity != null ? ` · ${r.severity}/10` : '';
    rows.push({
      id: r.id,
      time: clockFromISO(r.created_at),
      title: `${r.name}${sev}`,
      category: 'Symptom',
      sortKey: r.created_at,
    });
  }

  // Newest first by insertion time.
  rows.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
  return rows.map(({ sortKey: _sortKey, ...item }) => item);
}

/**
 * Render a canonical value for the keypad's "recent" line, honouring the user's
 * unit preference when supplied. `units` is optional and backward-compatible:
 * omitting it (the headless tests do) keeps the metric's fixed display unit via
 * `formatCanonical`, so existing output is unchanged; passing it resolves a
 * preference-aware DisplaySpec so "logged today" / "Last …" read in the chosen
 * unit (lb↔kg, oz↔ml, in↔cm).
 */
function formatForUnits(
  metric: MetricDescriptor,
  canonical: number,
  units?: UnitPreferences
): string {
  return units
    ? formatMeasured(resolveDisplay(metric, units), canonical)
    : formatCanonical(metric, canonical);
}

/**
 * A short "recent" line for the keypad drill-in: today's total for water, else
 * the last stored reading. Empty-safe. `units` (optional) renders the numbers in
 * the user's chosen unit; when omitted the metric's fixed display unit is used.
 */
export function recentSummary(
  db: Database,
  metricKey: MetricKey,
  date: string,
  units?: UnitPreferences
): string {
  const metric = metricByKey(metricKey);
  if (!metric) return '';

  if (metricKey === 'water') {
    // Total intake for the day across ALL sources (manual + a future smart
    // bottle / Apple Health) — deliberately broader than the Log feed, which
    // lists only manual captures. "How much have I had today" wants the total.
    const row = db.get<{ total: number | null }>(
      `SELECT sum(value) total FROM wearable_data WHERE metric_type = 'water_ml' AND date = ?`,
      [date]
    );
    const ml = row?.total ?? 0;
    if (!ml) return 'No water logged yet today';
    return `${formatForUnits(metric, ml, units)} logged today`;
  }

  const target = metric.target;
  let last: { value: number; at: string } | undefined;

  if (target.kind === 'body') {
    last = db.get<{ value: number; at: string }>(
      `SELECT ${target.column} value, measured_at at FROM body_metrics
       WHERE ${target.column} IS NOT NULL ORDER BY measured_at DESC LIMIT 1`
    );
  } else if (target.kind === 'wearable') {
    last = db.get<{ value: number; at: string }>(
      `SELECT value, created_at at FROM wearable_data
       WHERE metric_type = ? ORDER BY created_at DESC LIMIT 1`,
      [target.metricType]
    );
  } else {
    const row = db.get<{ value: string | null; at: string }>(
      `SELECT value, created_at at FROM log_entries
       WHERE type = 'metric' AND json_extract(value, '$.metricKey') = ?
       ORDER BY created_at DESC LIMIT 1`,
      [metricKey]
    );
    if (row) {
      const canonical = parseValue(row.value).canonical;
      if (typeof canonical === 'number') last = { value: canonical, at: row.at };
    }
  }

  if (!last) {
    const auto = target.kind === 'wearable' ? ' — usually auto from Apple Health' : '';
    return `No readings yet${auto}`;
  }
  return `Last ${formatForUnits(metric, last.value, units)}`;
}
