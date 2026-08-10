/**
 * The Coach's read tools — every way the model can look at the user's real
 * data (docs/ai-coach.md, "Tool set"). All readOnly: the service layer runs
 * these without confirmation. Each returns compact JSON in the user's CHOSEN
 * display units where a display convention exists (weight in lb or kg per their
 * Settings preference), with the unit named so the model never guesses.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import { listTodayEntries } from '@/lib/db/repositories/logs';
import { listMission } from '@/lib/db/repositories/mission';
import { getActiveMode } from '@/lib/db/repositories/day-modes';
import { activeExperiments, recentlyConcluded } from '@/lib/db/repositories/experiments';
import { weekSummary } from '@/lib/db/repositories/exercise';
import { listTodayMeals, todayTotals } from '@/lib/db/repositories/nutrition';
import { getCurrentVersion, listProtocols } from '@/lib/db/repositories/protocols';
import { isDueOn, listActiveReminders } from '@/lib/db/repositories/reminders';
import { listTodaySymptoms } from '@/lib/db/repositories/symptoms';
import { getPreferences } from '@/lib/db/repositories/user';
import { deviceLabel, pickDailyMetric } from '@/lib/db/repositories/wearables';
import { SAMPLE_METRICS, STATISTIC_METRICS } from '@/lib/health/mapping';
import { deriveReadiness } from '@/lib/home/readiness';
import { metricByKey, resolveDisplay, type MetricKey } from '@/lib/log/metrics';
import { getModeDefinition } from '@/lib/modes/registry';
import { parseProtocolContent } from '@/lib/protocols/content';
import type { BiomarkerRow } from '@/lib/db/types';
import type { UnitPreferences } from '@/lib/user/types';

import { computeInsights, dueRemindersFor, generateDailyBrief } from '../insights';
import {
  bodyDailySeries,
  isoDaysAgo,
  nutritionDailyTotals,
  round1,
  seriesStats,
  trainingDailyTotals,
  wearableArbitratedSeries,
  wearableDailySeries,
  wearableMetricInventory,
  type SeriesPoint,
  type WearableMetricPresence,
} from '../series';
import { retrievePassages } from '@/lib/rag/retrieve';
import { asRecord, daysWindow, optEnum, optString, reqString, type CoachTool } from './types';

const json = (value: unknown): string => JSON.stringify(value);

// --- The wearable metric catalog ---------------------------------------------
//
// `wearable_data.metric_type` is deliberately free text so a new vendor metric
// is never a migration (CLAUDE.md §9). A hardcoded enum of readable metrics
// therefore rots on contact with the next ingest — which is exactly how the
// Coach ended up blind to steps, sleep, energy and VO2max while the HealthKit
// pipeline was happily writing all of them.
//
// So the readable set is built in two layers and never typed out by hand:
//
//   1. DERIVED from the ingest specs themselves (src/lib/health/mapping.ts's
//      SAMPLE_METRICS + STATISTIC_METRICS, plus the sleep rows sleepDailyRows
//      emits and the manual-log wearable targets). Add a metric to the pipeline
//      and it is readable here with no edit to this file.
//   2. DISCOVERED from the data (SELECT DISTINCT metric_type). Anything present
//      that layer 1 does not describe still becomes readable, with its unit
//      taken from the rows and `inferred: true` flagged in the output so the
//      model knows the semantics were guessed rather than declared.

type WearableAgg =
  /** One winning source per day — the rule Home and the Data tab use. */
  | 'arbitrated'
  /** Genuinely accumulating: many rows a day that must be added up. */
  | 'sum';

type WearableMetricSpec = {
  metricType: string;
  label: string;
  /** The canonical unit stored in wearable_data.unit. */
  canonicalUnit: string;
  agg: WearableAgg;
  decimals: number;
  /** Minutes-valued: also rendered "7h 11m", never left as a raw minute count. */
  isDuration?: boolean;
  /**
   * True when today's value is a RUNNING TOTAL that keeps growing until
   * midnight (steps, energy burned, water). The same distinction insights.ts
   * calls `accumulating` — and it is NOT the same axis as {@link WearableAgg}.
   * `agg` says how to fold MANY ROWS into one day; this says whether that day,
   * once folded, is finished. Steps arbitrate to one source (agg 'arbitrated')
   * and still accumulate all day, which is exactly how a two-hour-old today of
   * 900 steps got averaged in beside seven complete 8,000-step days.
   *
   * False for whole-fact readings: an HRV sample, a night's sleep, a VO2max
   * estimate are each complete the moment they are written and must keep
   * counting today.
   */
  accumulating?: boolean;
  /** Dimensions the user has a Settings preference for. */
  display?: 'volume' | 'temperature';
  /** True when the spec was guessed from the rows, not declared by the pipeline. */
  inferred?: boolean;
};

/** Readable names for the pipeline's metric_types (the specs carry no label). */
const WEARABLE_LABELS: Record<string, string> = {
  hrv: 'HRV',
  rhr: 'Resting heart rate',
  respiratory_rate: 'Respiratory rate',
  spo2_pct: 'Blood oxygen',
  body_temp_c: 'Body temperature',
  wrist_temp_c: 'Sleeping wrist temperature',
  vo2max: 'VO2max',
  steps: 'Steps',
  active_energy_kcal: 'Active energy',
  resting_energy_kcal: 'Resting energy',
};

/** The sleep rows sleepDailyRows() emits, in the order a night reads. */
const SLEEP_METRICS: readonly (readonly [string, string])[] = [
  ['sleep_duration_min', 'Sleep (asleep)'],
  ['sleep_in_bed_min', 'Time in bed'],
  ['sleep_deep_min', 'Deep sleep'],
  ['sleep_rem_min', 'REM sleep'],
  ['sleep_core_min', 'Core sleep'],
  ['sleep_awake_min', 'Awake during the night'],
];

function humanize(metricType: string): string {
  const words = metricType.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function tempSpec(metricType: string): WearableMetricSpec {
  return {
    metricType,
    label: WEARABLE_LABELS[metricType] ?? humanize(metricType),
    canonicalUnit: 'c',
    agg: 'arbitrated',
    decimals: 2,
    display: 'temperature',
  };
}

/** Layer 1: everything the ingest pipeline is known to write. */
const DECLARED_WEARABLE_METRICS: readonly WearableMetricSpec[] = [
  ...SAMPLE_METRICS.map((spec): WearableMetricSpec =>
    spec.unit === 'c'
      ? tempSpec(spec.metricType)
      : {
          metricType: spec.metricType,
          label: WEARABLE_LABELS[spec.metricType] ?? humanize(spec.metricType),
          canonicalUnit: spec.unit,
          agg: 'arbitrated',
          decimals: spec.decimals,
        }
  ),
  ...STATISTIC_METRICS.map((spec): WearableMetricSpec => ({
    metricType: spec.metricType,
    label: WEARABLE_LABELS[spec.metricType] ?? humanize(spec.metricType),
    canonicalUnit: spec.unit,
    agg: 'arbitrated',
    decimals: spec.decimals,
    // A HealthKit *statistic* is a cumulative sum over the day (steps, active
    // energy, resting energy). One row per day, rewritten as the day grows, so
    // arbitration picks a single source — but today's number is still partial.
    accumulating: true,
  })),
  ...SLEEP_METRICS.map(([metricType, label]): WearableMetricSpec => ({
    metricType,
    label,
    canonicalUnit: 'min',
    agg: 'arbitrated',
    decimals: 0,
    isDuration: true,
  })),
  {
    // Many sessions a day, each its own row keyed by the HK sample UUID — this
    // one really does accumulate, unlike every day-bucketed metric above.
    metricType: 'workout',
    label: 'Workout minutes (Apple Health)',
    canonicalUnit: 'min',
    agg: 'sum',
    decimals: 1,
    isDuration: true,
  },
  {
    // Manual capture: one row per sip logged, so the day is a sum.
    metricType: 'water_ml',
    label: 'Water',
    canonicalUnit: 'ml',
    agg: 'sum',
    decimals: 0,
    display: 'volume',
  },
];

/** Layer 2: declared ∪ whatever the table actually holds today. */
function wearableCatalog(inventory: WearableMetricPresence[]): Map<string, WearableMetricSpec> {
  const catalog = new Map<string, WearableMetricSpec>(
    DECLARED_WEARABLE_METRICS.map((spec) => [spec.metricType, spec])
  );
  for (const row of inventory) {
    if (catalog.has(row.metricType)) continue;
    const unit = row.unit ?? '';
    catalog.set(row.metricType, {
      metricType: row.metricType,
      label: humanize(row.metricType),
      canonicalUnit: unit,
      // Unknown cadence: arbitration can only ever under-report, summing could
      // silently double a day. Prefer the claim that cannot be inflated.
      agg: 'arbitrated',
      decimals: 2,
      isDuration: unit === 'min',
      inferred: true,
    });
  }
  return catalog;
}

/** Friendly names the model is likely to reach for → the real metric_type. */
const METRIC_ALIASES: Record<string, string> = {
  water: 'water_ml',
  sleep: 'sleep_duration_min',
  sleep_min: 'sleep_duration_min',
  asleep: 'sleep_duration_min',
  deep_sleep: 'sleep_deep_min',
  rem_sleep: 'sleep_rem_min',
  core_sleep: 'sleep_core_min',
  time_in_bed: 'sleep_in_bed_min',
  in_bed: 'sleep_in_bed_min',
  active_energy: 'active_energy_kcal',
  active_calories: 'active_energy_kcal',
  resting_energy: 'resting_energy_kcal',
  calories_burned: 'active_energy_kcal',
  spo2: 'spo2_pct',
  oxygen_saturation: 'spo2_pct',
  body_temp: 'body_temp_c',
  wrist_temp: 'wrist_temp_c',
  vo2: 'vo2max',
  vo2_max: 'vo2max',
  workouts: 'workout',
  workout_minutes: 'workout',
  step_count: 'steps',
  heart_rate_variability: 'hrv',
  resting_heart_rate: 'rhr',
  respiration: 'respiratory_rate',
};

/** Body metrics keep their own path — they live in body_metrics, not wearables. */
const BODY_METRIC_KEYS = ['weight', 'body_fat', 'waist'] as const;

type WearableDisplaySpec = {
  unit: string;
  decimals: number;
  fromCanonical: (canonical: number) => number;
};

/**
 * How a wearable value should be reported for THIS user's Settings › Units.
 * Same contract the rest of the tool layer honours via resolveDisplay: the
 * Coach must never cite °F to a °C user, or oz to an ml user.
 */
function wearableDisplay(spec: WearableMetricSpec, units: UnitPreferences): WearableDisplaySpec {
  if (spec.display === 'volume') {
    const water = resolveDisplay(metricByKey('water')!, units);
    return { unit: water.unit, decimals: water.decimals, fromCanonical: water.fromCanonical };
  }
  if (spec.display === 'temperature') {
    return units.temperature === 'C'
      ? { unit: '°C', decimals: 1, fromCanonical: (c) => c }
      : { unit: '°F', decimals: 1, fromCanonical: (c) => c * 1.8 + 32 };
  }
  return {
    unit: spec.canonicalUnit,
    decimals: spec.decimals,
    fromCanonical: (v) => v,
  };
}

/** 431 → "7h 11m", 45 → "45m". Hermes has no Intl; this is hand-formatted. */
function formatDuration(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** The one place a canonical wearable value becomes a reportable object. */
function reportValue(
  spec: WearableMetricSpec,
  display: WearableDisplaySpec,
  canonical: number
): { value: number; unit: string; hm?: string } {
  return {
    value: roundTo(display.fromCanonical(canonical), display.decimals),
    unit: display.unit,
    ...(spec.isDuration ? { hm: formatDuration(canonical) } : {}),
  };
}

/**
 * Does today's value for this metric keep growing until midnight?
 *
 * Summing many rows into a day (agg 'sum': water sipped, workouts logged) is
 * accumulation by construction, so it needs no declaration. The declared flag
 * covers the day-bucketed totals that still arbitrate to one source — steps and
 * the energy metrics. A DISCOVERED metric (layer 2) declares neither and is
 * treated as a level reading: its cadence is unknown, and holding a real
 * same-day reading out of the statistics is the more damaging guess of the two,
 * given `inferred: true` already tells the model the semantics were assumed.
 */
function accumulatesThroughDay(spec: WearableMetricSpec): boolean {
  return spec.agg === 'sum' || spec.accumulating === true;
}

/** Everything get_metric_series will accept right now, for error text + discovery. */
function readableMetricNames(catalog: Map<string, WearableMetricSpec>): string[] {
  return [...BODY_METRIC_KEYS, ...catalog.keys()];
}

// --- get_today_snapshot ------------------------------------------------------

// The Coach only needs enough of the due set to lead the day; an un-dismissed
// one-off keeps surfacing forever (see isDueOn), so a user who ignores nudges
// can accumulate an unbounded tail of them. Cap it — but report `omitted` so the
// model knows the list is partial instead of confidently under-counting.
const SNAPSHOT_REMINDER_LIMIT = 10;

/**
 * The wearable signals whose ABSENCE is worth stating out loud. A missing step
 * count and a step count of zero are completely different claims about the
 * user's day, so these are reported by name in `wearables.noDataToday` rather
 * than silently omitted — the model must be able to say "Health hasn't synced
 * steps today" instead of quietly implying nothing happened.
 */
const CORE_WEARABLES: readonly string[] = [
  'steps',
  'sleep_duration_min',
  'hrv',
  'rhr',
  'active_energy_kcal',
];

/** Today's value for one wearable metric under its own aggregation rule. */
function wearableToday(
  db: Database,
  spec: WearableMetricSpec,
  date: string
): { value: number; source: string | null } | null {
  if (spec.agg === 'sum') {
    const point = wearableDailySeries(db, spec.metricType, date, 'sum').find(
      (p) => p.date === date
    );
    // Summed across every source by definition — no single device owns it.
    return point ? { value: point.value, source: null } : null;
  }
  const point = pickDailyMetric(db, spec.metricType, date);
  return point ? { value: point.value, source: deviceLabel(point.sourceDevice) } : null;
}

const getTodaySnapshot: CoachTool = {
  name: 'get_today_snapshot',
  description:
    "Today's full picture: mission items with status, meals eaten with macro totals, " +
    'workouts, symptoms, ad-hoc captures, reminders due today, TODAY’S WEARABLE DATA ' +
    '(steps, sleep with hours/minutes, HRV, resting HR, active/resting energy — whatever ' +
    'Apple Health has synced) and the derived `readiness` verdict + pillars, which is the ' +
    'exact same derivation the Home screen shows. Call this before answering anything ' +
    "about today ('how am I doing', 'what's left', 'what did I eat', 'how many steps', " +
    "'how did I sleep'). " +
    '`wearables.today` holds only metrics that HAVE a value today; `wearables.noDataToday` ' +
    'names the ones that do not — report those as missing/not synced, NEVER as zero, and ' +
    'NEVER as evidence that the sync is broken. `wearables.neverRecorded` narrows that to ' +
    'the ones this device has no sensor for at all (a phone with no watch has no HRV, ever) ' +
    '— those are a hardware fact, not a sync failure. ' +
    'ANYTHING PRESENT IN `wearables.today` HAS SYNCED. Never tell the user a metric has not ' +
    'synced while it carries a value there, whatever any other field says. ' +
    '`wearables.availableMetrics` lists every metric_type on the device, and every one of ' +
    'them can be passed to get_metric_series for history. ' +
    '`readiness.detail` describes the RECOVERY verdict only; when `readiness.level` is ' +
    '`unknown` it means recovery inputs are missing, never that Apple Health is off. ' +
    'In `remindersDueToday`, items are ranked with today’s own first and each carries its ' +
    'pinned `date` and `daysOverdue`: an un-dismissed one-off keeps surfacing past its day, ' +
    'so anything with daysOverdue > 0 is a carried-over obligation — say so, never present ' +
    'it as part of today’s plan.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  execute: (db, _input, context) => {
    const date = todayISODate(context.now);
    const mode = getActiveMode(db, date);
    const modeDef = getModeDefinition(mode);
    const meals = listTodayMeals(db, date);
    const totals = todayTotals(db, date);
    const workouts = db.all<{
      name: string;
      kind: string;
      duration_min: number | null;
    }>('SELECT name, kind, duration_min FROM workouts WHERE date = ? ORDER BY created_at', [date]);

    // Ranked today-first (dueRemindersFor), so the cap below drops the stalest
    // tail FIRST. It is not a guarantee today's own items survive: with more
    // than SNAPSHOT_REMINDER_LIMIT due on their own day the cap trims those too.
    // Either way remindersDueTodayOmitted always reports the count, so the
    // model is never silently handed a truncated list.
    const due = dueRemindersFor(db, date);

    // --- The wearables plane -------------------------------------------------
    // Discovered from the data, so a metric ingested tomorrow shows up here
    // without an edit. Values respect Settings › Units, durations read as
    // hours/minutes, and an absent metric is named rather than zeroed.
    const units = getPreferences(db).units;
    const inventory = wearableMetricInventory(db);
    const catalog = wearableCatalog(inventory);
    const todayWearables: Record<string, unknown> = {};
    for (const presence of inventory) {
      // max(date) < today ⇒ nothing today; skip the per-metric query entirely.
      if (presence.lastDate < date) continue;
      const spec = catalog.get(presence.metricType)!;
      const observed = wearableToday(db, spec, date);
      if (!observed) continue;
      todayWearables[presence.metricType] = {
        label: spec.label,
        ...reportValue(spec, wearableDisplay(spec, units), observed.value),
        ...(observed.source ? { source: observed.source } : {}),
        ...(spec.inferred ? { inferred: true } : {}),
      };
    }
    const noDataToday = CORE_WEARABLES.filter((m) => !(m in todayWearables));
    // "Nothing today" and "this device has never had one" are different facts,
    // and conflating them is how a phone-only user — no watch, so no HRV sensor,
    // ever — gets told their sync is broken by a metric that will never arrive.
    const neverRecorded = noDataToday.filter((m) => !inventory.some((r) => r.metricType === m));
    const syncedTodayCount = Object.keys(todayWearables).length;

    // The SAME derivation Home renders (src/lib/home/readiness.ts) — reused, not
    // recomputed, so the Coach and the Home screen can never disagree about
    // today's readiness. Its evidence gates hold here too: `unknown` means there
    // is not enough baseline yet, and must be reported as that, not as "poor".
    const view = deriveReadiness(db, date);

    // --- readiness.detail is UI COPY, and its fallback is a CALL TO ACTION ---
    //
    // THIS IS THE BUG the owner reported twice. deriveReadiness ends with
    // `detail = "Connect Apple Health in Settings to power readiness."` whenever
    // it has no usable RECOVERY input — no HRV or resting HR with a 30-day
    // baseline, and no sleep last night. On HOME that sentence sits under a
    // strip that is simultaneously rendering today's step count, so a human
    // reads it as "no recovery signal yet" and ignores it. Handed to a model as
    // a JSON field it reads as a flat assertion that Apple Health is not
    // connected — and the model dutifully tells the user nothing has synced,
    // while `wearables.today.steps` sits a few lines above it holding 8,432.
    // Home shows the steps; the Coach denies them. Same database, same day, one
    // sentence of interface copy in between.
    //
    // For a phone-only user (no watch ⇒ no HRV, no RHR, no sleep) that fallback
    // is not a first-run state at all: it is EVERY day, forever.
    //
    // A tool must never launder an interface instruction into a claim about the
    // data. `unknown` is exactly the state in which the fallback fires — the
    // verdict is the worse of recovery and sleep, and the three `detail`
    // branches above the fallback are true on precisely the conditions that
    // keep either of those from being `unknown` — so that is what to substitute
    // on. Derived, never string-matched: a copy edit in readiness.ts must not be
    // able to make this guard silently stop working.
    const readinessDetail =
      view.readiness.level === 'unknown'
        ? 'Readiness needs a recovery input — HRV or resting HR with a 30-day baseline, ' +
          "or last night's sleep — and today has none. This is about RECOVERY ONLY. It does " +
          'NOT mean Apple Health is disconnected, and it does NOT mean nothing synced: read ' +
          '`wearables.today` for what actually did' +
          (syncedTodayCount > 0 ? ` (${syncedTodayCount} metric(s) have values today).` : '.')
        : view.readiness.detail;

    return json({
      date,
      // The day's mode adapts plan/priorities/tone/adherence. When not Normal,
      // heroFocus + toneGuidance tell the Coach how to lead and speak, and
      // excusesSkips means a skipped item is the RIGHT call, not a miss.
      mode: {
        key: mode,
        label: modeDef.label,
        ...(modeDef.heroFocus ? { heroFocus: modeDef.heroFocus } : {}),
        ...(modeDef.coachTone ? { toneGuidance: modeDef.coachTone } : {}),
        excusesSkips: modeDef.excusesSkips,
      },
      mission: listMission(db, date).map((m) => ({
        title: m.title,
        status: m.status,
        scheduledTime: m.scheduledTime ?? null,
      })),
      meals: meals.map((m) => ({
        time: m.time,
        name: m.name,
        kcal: m.kcal,
        protein_g: m.protein_g,
      })),
      nutritionTotals: totals,
      workouts,
      symptoms: listTodaySymptoms(db, date).map((s) => ({
        time: s.time,
        name: s.name,
        severity: s.severity,
      })),
      // The Log feed also lists symptoms; they're already reported (structured)
      // in `symptoms` above, so drop them here rather than double-counting.
      captures: listTodayEntries(db, context.now)
        .filter((e) => e.category !== 'Symptom')
        .map((e) => ({
          time: e.time,
          title: e.title,
          category: e.category,
        })),
      remindersDueToday: due.slice(0, SNAPSHOT_REMINDER_LIMIT).map(({ reminder, daysOverdue }) => ({
        id: reminder.id,
        title: reminder.title,
        time: reminder.time,
        // The pinned day (null for a recurring or undated one), so an overdue
        // nudge is legible as months old rather than as one of today's.
        date: reminder.date,
        repeat: reminder.repeat,
        daysOverdue,
      })),
      remindersDueTodayOmitted: Math.max(0, due.length - SNAPSHOT_REMINDER_LIMIT),
      wearables: {
        today: todayWearables,
        // Named absences. "No steps row today" ≠ "0 steps today" — say the former.
        noDataToday,
        // Of those, the ones this device has NEVER recorded: a missing sensor,
        // not a missing sync. Saying "your HRV hasn't synced" every day to
        // someone who owns no HRV sensor is how the Coach loses their trust.
        neverRecorded,
        // Every metric_type on this device; all are valid get_metric_series input.
        availableMetrics: [...catalog.keys()].filter((m) =>
          inventory.some((row) => row.metricType === m)
        ),
        // Stated in ALL THREE cases, including the good one. It used to be
        // `undefined` when data existed — silence, next to a `noDataToday` list
        // and (before the fix above) a "Connect Apple Health" sentence. Nothing
        // in the payload ever affirmed that the sync was working, so every
        // ambiguity resolved toward "it isn't". Say the true thing out loud.
        note:
          inventory.length === 0
            ? 'No wearable data on this device at all — Apple Health has never synced (Settings › Apple Health).'
            : syncedTodayCount === 0
              ? 'Nothing synced for today yet — Apple Health may not have run since midnight. Say so; do not report zeros.'
              : `Apple Health IS connected and HAS synced today: ${syncedTodayCount} metric(s) in \`today\` carry real values — report them as fact. Names in \`noDataToday\` are missing for TODAY only and say nothing about the rest; names in \`neverRecorded\` have no sensor on this device at all.`,
      },
      // The SAME derivation Home renders for this day (src/lib/home/readiness.ts):
      // identical level, label and pillars, so the two surfaces can never
      // disagree about the verdict. `detail` alone is re-worded — it is Home's
      // on-screen copy, and its no-signal branch is an instruction to the user,
      // not a fact about the data. See the note above `readinessDetail`.
      readiness: {
        level: view.readiness.level,
        label: view.readiness.label,
        // Never Home's raw copy when the verdict is `unknown` — see above.
        detail: readinessDetail,
        pillars: view.pillars,
        // False ⇒ not one wearable signal exists; readiness is not a low score,
        // it is an absence. Never present `unknown` as a bad result.
        hasSignal: view.hasSignal,
      },
    });
  },
};

// --- get_metric_series -------------------------------------------------------

const getMetricSeries: CoachTool = {
  name: 'get_metric_series',
  description:
    'Daily history for ONE metric over the last N days, in the user’s display units, with ' +
    'min/avg/max. Call this whenever the user asks about a trend, a change, or "how has X ' +
    'been" — answer from these numbers only. ' +
    'Accepts BODY metrics (weight, body_fat, waist) AND every wearable metric_type Apple ' +
    'Health has synced: steps, sleep_duration_min, sleep_deep_min, sleep_rem_min, ' +
    'sleep_in_bed_min, sleep_awake_min, active_energy_kcal, resting_energy_kcal, hrv, rhr, ' +
    'respiratory_rate, spo2_pct, body_temp_c, wrist_temp_c, vo2max, workout, water_ml — ' +
    'plus anything else on the device. Friendly aliases work ("sleep", "water", "vo2max", ' +
    '"active_energy"). get_today_snapshot’s `wearables.availableMetrics` lists exactly what ' +
    'this device holds; an unknown name comes back as an error naming the valid set. ' +
    'Duration metrics carry an `hm` field ("7h 11m") — quote that, not raw minutes. ' +
    'ACCUMULATING metrics (steps, active/resting energy, water, workout minutes) build up ' +
    'through the day, so TODAY is a running total, not a finished day. For those, `stats` ' +
    'covers COMPLETE days only and today is reported separately as `todaySoFar` (also ' +
    'flagged `partial: true` in `points`). `statsBasis` and `statsExcludesToday` say which ' +
    'convention is in force — read them before quoting a number. Give both figures, e.g. ' +
    '"about 8,000 a day over the last week, 900 so far today"; NEVER average today into the ' +
    'daily figure, and never call `todaySoFar` a full day. Level metrics (HRV, sleep, ' +
    'weight, VO2max) are whole facts when written, so today counts normally there. ' +
    'When there is no data the result says `hasData: false` with empty points and null ' +
    'stats: report that as "no data", NEVER as zero. `stats` can also be null while ' +
    '`hasData` is true when the only day in the window is today and it is still ' +
    'accumulating — then there is no complete day to average; say so.',
  inputSchema: {
    type: 'object',
    properties: {
      metric: {
        type: 'string',
        description:
          'A body metric (weight, body_fat, waist) or a wearable metric_type ' +
          '(steps, sleep_duration_min, hrv, vo2max, …). See ' +
          'get_today_snapshot.wearables.availableMetrics for this device’s set.',
      },
      days: { type: 'integer', minimum: 1, maximum: 365, description: 'Window, default 30.' },
    },
    required: ['metric'],
    additionalProperties: false,
  },
  readOnly: true,
  execute: (db, input, context) => {
    const args = asRecord(input);
    const requested = reqString(args, 'metric').toLowerCase();
    const days = daysWindow(args, 30);
    const today = todayISODate(context.now);
    const since = isoDaysAgo(context.now, days - 1);
    const units = getPreferences(db).units;

    // --- Body metrics: their own table, their own display preferences --------
    if ((BODY_METRIC_KEYS as readonly string[]).includes(requested)) {
      const descriptor = metricByKey(requested as MetricKey)!;
      const target = descriptor.target as {
        kind: 'body';
        column: 'weight_kg' | 'body_fat_pct' | 'waist_cm';
      };
      // Report in the user's chosen unit (Settings › Units), matching what the
      // app shows and what the write path stores — the Coach must never cite lb
      // to a kg user. resolveDisplay is identity for the unit-less metrics.
      const spec = resolveDisplay(descriptor, units);
      const points = bodyDailySeries(db, target.column, since).map((p) => ({
        date: p.date,
        value: round1(spec.fromCanonical(p.value)),
      }));
      return json(
        seriesPayload({
          metric: requested,
          label: descriptor.label,
          source: 'body_metrics',
          unit: spec.unit,
          aggregation: 'daily average of that day’s measurements',
          days,
          points,
        })
      );
    }

    // --- Wearables: discovered, so a new metric_type needs no code change ----
    const inventory = wearableMetricInventory(db);
    const catalog = wearableCatalog(inventory);
    const metricType = METRIC_ALIASES[requested] ?? requested;
    const spec = catalog.get(metricType);
    if (!spec) {
      throw new Error(
        `Unknown metric "${requested}". Available on this device: ${readableMetricNames(catalog).join(', ')}.`
      );
    }

    const display = wearableDisplay(spec, units);
    const raw: SeriesPoint[] =
      spec.agg === 'sum'
        ? wearableDailySeries(db, metricType, since, 'sum')
        : wearableArbitratedSeries(db, metricType, since, today);
    // Today stays IN the points — the owner's steps so far today are real and
    // useful — but an accumulating today is flagged as partial, and held out of
    // the statistics below. See the note on `partialToday` in seriesPayload.
    const accumulating = accumulatesThroughDay(spec);
    const points = raw.map((p) => ({
      date: p.date,
      ...reportValue(spec, display, p.value),
      ...(accumulating && p.date === today ? { partial: true } : {}),
    }));

    const presence = inventory.find((row) => row.metricType === metricType);
    return json(
      seriesPayload({
        metric: metricType,
        label: spec.label,
        source: 'wearable_data',
        unit: display.unit,
        aggregation:
          spec.agg === 'sum'
            ? 'daily sum of every logged row'
            : 'one source per day, richest device first (same rule the Home screen uses)',
        days,
        points,
        isDuration: spec.isDuration === true,
        inferred: spec.inferred === true,
        // Only an accumulating metric has a partial today to hold out.
        partialDate: accumulating ? today : null,
        // A metric that exists but is silent in this window is a different
        // statement from one that has never been recorded — say which.
        lastRecorded: presence?.lastDate ?? null,
      })
    );
  },
};

/**
 * One day as reported. `unit` rides along on the wearable branch (reportValue
 * stamps it); `partial` marks the still-accumulating today that `stats`
 * deliberately leaves out.
 */
type SeriesReportPoint = {
  date: string;
  value: number;
  unit?: string;
  hm?: string;
  partial?: boolean;
};

type SeriesPayloadInput = {
  metric: string;
  label: string;
  source: 'body_metrics' | 'wearable_data';
  unit: string;
  aggregation: string;
  days: number;
  points: SeriesReportPoint[];
  isDuration?: boolean;
  inferred?: boolean;
  lastRecorded?: string | null;
  /**
   * Today's date when this metric ACCUMULATES through the day, else null.
   * That day is a running total, not a finished day, so it is excluded from
   * `stats` and reported on its own as `todaySoFar`. Null (or an absent point
   * for that date) leaves every day counting, which is correct for a level
   * metric — an HRV sample or a night's sleep is whole the moment it lands.
   */
  partialDate?: string | null;
};

/** Layer 2 of the catalog guessed this metric's semantics; say so. */
const INFERRED_NOTE =
  'This metric is not one ARC declares; its unit and daily aggregation were ' +
  'inferred from the stored rows. Say so if you quote it precisely.';

/**
 * The one shape both branches return. `hasData` is explicit and the note spells
 * absence out in words, because "0 points" read fast is exactly how a model
 * ends up telling someone they walked zero steps.
 *
 * **The notes are ADDITIVE, never alternative.** They describe two independent
 * facts — "the semantics were guessed" and "there is nothing in this window" —
 * and a DISCOVERED metric can easily be both: layer 2 of the catalog only sees
 * it because rows exist, and the requested window can still be empty. An
 * earlier cut made them two branches of one ternary, so exactly that case
 * dropped the absence sentence and its `lastRecorded` wording, leaving the
 * model an empty `points` array with nothing telling it that empty ≠ zero.
 * That is the confusion this whole payload exists to prevent, so absence is
 * stated FIRST and is never displaced.
 *
 * **`stats` covers COMPLETE days.** For an accumulating metric (`partialDate`
 * set) today is a running total: at 09:00 it is a fraction of a day, and
 * averaging it in drops `avg`, and usually owns `min` and `last` outright —
 * seven complete 8,000-step days plus a two-hour-old today reported avg 7,492.9
 * and min 900, which is not a fact about the user's week. Today is NOT dropped
 * from the data — the steps walked so far are real — it is moved to its own
 * labelled `todaySoFar` and flagged `partial: true` inside `points`, so the
 * model can say "8,000 a day over the last week; 900 so far today" instead of
 * blending the two. `statsBasis`/`statsExcludesToday` name which convention is
 * in force, so `points` and `stats` can never be silently read as the same set.
 */
function seriesPayload(input: SeriesPayloadInput): Record<string, unknown> {
  const partialToday =
    input.partialDate == null
      ? null
      : (input.points.find((p) => p.date === input.partialDate) ?? null);
  const statPoints = partialToday
    ? input.points.filter((p) => p.date !== input.partialDate)
    : input.points;
  const stats = seriesStats(statPoints);
  const noteForEmpty = () => {
    if (input.lastRecorded) {
      return `No ${input.label} recorded in the last ${input.days} days. The most recent value on record is from ${input.lastRecorded}. This is missing data, not a zero — do not report a value.`;
    }
    return `No ${input.label} has ever been recorded on this device. This is missing data, not a zero — do not report a value.`;
  };
  const notes: string[] = [];
  if (input.points.length === 0) notes.push(noteForEmpty());
  if (partialToday) {
    notes.push(
      `${input.label} accumulates through the day, so ${partialToday.date} is a RUNNING TOTAL, not a finished ` +
        'day. Every number in `stats` therefore covers COMPLETE days only — today is excluded from it and ' +
        'appears instead as `todaySoFar` (and as the `partial: true` entry in `points`). Never average today ' +
        'in, and never present `todaySoFar` as a full day.'
    );
    notes.push(
      stats === null
        ? `There is no COMPLETE day of ${input.label} in this window — the only data is today, still ` +
            'accumulating — so there is nothing to average yet. Say exactly that; do not report `todaySoFar` ' +
            'as a daily figure.'
        : `Cite the two separately, e.g. "${round1(stats.avg)} ${input.unit} a day over the last ` +
            `${stats.count} complete day(s); ${partialToday.value} ${input.unit} so far today".`
    );
  }
  if (input.inferred) notes.push(INFERRED_NOTE);
  return {
    metric: input.metric,
    label: input.label,
    source: input.source,
    unit: input.unit,
    aggregation: input.aggregation,
    days: input.days,
    hasData: input.points.length > 0,
    // Every day with data, today included. `partial: true` marks the one day
    // that `stats` deliberately leaves out.
    points: input.points,
    // Spelled out so `points` and `stats` can never be read as the same set.
    statsBasis: partialToday
      ? 'complete days only — today is still accumulating and is excluded (see `todaySoFar`)'
      : 'every day in `points`, today included',
    statsExcludesToday: partialToday !== null,
    stats:
      stats === null
        ? null
        : {
            count: stats.count,
            min: round1(stats.min),
            avg: round1(stats.avg),
            max: round1(stats.max),
            first: stats.first,
            last: stats.last,
            ...(input.isDuration ? { avgHm: formatDuration(stats.avg) } : {}),
          },
    // Today's real running total, kept — never silently dropped — but in its own
    // clearly-labelled place so it cannot be mistaken for a completed day.
    ...(partialToday
      ? {
          todaySoFar: {
            date: partialToday.date,
            value: partialToday.value,
            unit: input.unit,
            ...(partialToday.hm !== undefined ? { hm: partialToday.hm } : {}),
            partial: true,
            note: 'Real, and still climbing — the total so far today, not a finished day.',
          },
        }
      : {}),
    ...(input.lastRecorded !== undefined ? { lastRecorded: input.lastRecorded } : {}),
    ...(input.inferred ? { inferred: true } : {}),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

// --- get_training_summary ----------------------------------------------------

const getTrainingSummary: CoachTool = {
  name: 'get_training_summary',
  description:
    'Training over the last N days (default 28): per-day sessions/minutes, average weekly ' +
    'cardio-minute and strength-session RATES over that rolling window, and the most recent ' +
    'sessions. Also returns `thisWeek` — the CURRENT Monday-start calendar week (cardio ' +
    'minutes + strength sessions), which matches the Data tab\'s "this week" exactly. Use ' +
    '`thisWeek` for "this week" questions; the rolling `totals`/`weeklyRates` are "the last ' +
    'N days", never "this week". Call this for anything about workouts, training load, ' +
    'consistency, or recovery context.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 365, description: 'Window, default 28.' },
    },
    additionalProperties: false,
  },
  readOnly: true,
  execute: (db, input, context) => {
    const days = daysWindow(asRecord(input), 28);
    const since = isoDaysAgo(context.now, days - 1);
    const daily = trainingDailyTotals(db, since);
    // The Monday-start calendar week, from the SAME weekSummary the Data tab
    // renders as "Zone 2 · this week" — so the Coach and the Data tab can never
    // disagree on "this week". Distinct from the rolling `totals` below.
    const week = weekSummary(db, context.now);
    const totalMinutes = daily.reduce((a, d) => a + d.minutes, 0);
    const totalSessions = daily.reduce((a, d) => a + d.sessions, 0);
    const strengthSessions = daily.reduce((a, d) => a + d.strength_sessions, 0);
    const cardioMinutes = daily.reduce((a, d) => a + d.cardio_min, 0);
    const weeks = days / 7;

    const recent = db.all<{
      date: string;
      name: string;
      kind: string;
      duration_min: number | null;
    }>(
      `SELECT date, name, kind, duration_min FROM workouts
       WHERE date >= ? ORDER BY date DESC, created_at DESC LIMIT 10`,
      [since]
    );

    return json({
      days,
      // Monday-start calendar week to date — the "this week" number, matching
      // the Data tab. Use this (not `totals`) for "how's my training this week".
      thisWeek: {
        cardioMinutes: round1(week.zone2Min),
        strengthSessions: week.strengthSessions,
      },
      totals: {
        sessions: totalSessions,
        minutes: round1(totalMinutes),
        strengthSessions,
        cardioMinutes: round1(cardioMinutes),
      },
      // A sub-week window can't honestly be extrapolated to a weekly rate
      // (days=1 with one 60-min session would claim 420 min/week) — null it.
      weeklyRates:
        days < 7
          ? null
          : {
              sessions: round1(totalSessions / weeks),
              minutes: round1(totalMinutes / weeks),
              strengthSessions: round1(strengthSessions / weeks),
              cardioMinutes: round1(cardioMinutes / weeks),
            },
      perDay: daily,
      recentSessions: recent,
    });
  },
};

// --- get_nutrition_summary ---------------------------------------------------

const getNutritionSummary: CoachTool = {
  name: 'get_nutrition_summary',
  description:
    'Nutrition over the last N days (default 14): per-day kcal/protein/carbs/fat totals ' +
    'and averages across logged days. Call this for anything about diet, protein, ' +
    'calories, or eating patterns.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 365, description: 'Window, default 14.' },
    },
    additionalProperties: false,
  },
  readOnly: true,
  execute: (db, input, context) => {
    const days = daysWindow(asRecord(input), 14);
    const daily = nutritionDailyTotals(db, isoDaysAgo(context.now, days - 1));
    const loggedDays = daily.length;
    const avg = (pick: (d: (typeof daily)[number]) => number) =>
      loggedDays === 0 ? null : round1(daily.reduce((a, d) => a + pick(d), 0) / loggedDays);

    return json({
      days,
      loggedDays,
      perDay: daily,
      averagesAcrossLoggedDays: {
        kcal: avg((d) => d.kcal),
        protein_g: avg((d) => d.protein_g),
        carbs_g: avg((d) => d.carbs_g),
        fat_g: avg((d) => d.fat_g),
      },
    });
  },
};

// --- get_symptom_history -----------------------------------------------------

const getSymptomHistory: CoachTool = {
  name: 'get_symptom_history',
  description:
    'Symptoms over the last N days (default 30): each occurrence with severity and body ' +
    'area, plus counts by name. Call this when the user mentions feeling off, a recurring ' +
    'issue, or asks what correlates with a symptom.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 365, description: 'Window, default 30.' },
    },
    additionalProperties: false,
  },
  readOnly: true,
  execute: (db, input, context) => {
    const days = daysWindow(asRecord(input), 30);
    const since = isoDaysAgo(context.now, days - 1);
    const rows = db.all<{
      date: string;
      time: string | null;
      name: string;
      severity: number | null;
      body_area: string | null;
    }>(
      `SELECT date, time, name, severity, body_area FROM symptoms
       WHERE date >= ? ORDER BY date, (time IS NULL), time`,
      [since]
    );
    const counts = db.all<{ name: string; occurrences: number; avg_severity: number | null }>(
      `SELECT name, count(*) AS occurrences, avg(severity) AS avg_severity FROM symptoms
       WHERE date >= ? GROUP BY name ORDER BY occurrences DESC, name`,
      [since]
    );
    return json({ days, occurrences: rows, byName: counts });
  },
};

// --- get_biomarkers ----------------------------------------------------------

const BIOMARKER_CATEGORIES = [
  'cardiovascular',
  'metabolic',
  'hormone',
  'inflammation',
  'nutrient',
  'organ',
  'immune',
  'hematology',
  'cancer',
  'toxin',
  'other',
] as const;

const getBiomarkers: CoachTool = {
  name: 'get_biomarkers',
  description:
    'Lab results: the latest value per biomarker (optionally one category) with units, ' +
    'longevity-oriented optimal ranges, standard ranges, and measurement dates. Call this ' +
    'for anything about labs, bloodwork, ApoB, lipids, hormones, etc. If empty, say no ' +
    'labs are imported yet — never estimate a lab value.',
  inputSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: [...BIOMARKER_CATEGORIES] },
      biomarker: { type: 'string', description: 'Filter by slug or name substring.' },
    },
    additionalProperties: false,
  },
  readOnly: true,
  execute: (db, input) => {
    const args = asRecord(input);
    const category = optEnum(args, 'category', BIOMARKER_CATEGORIES);
    const nameFilter = optString(args, 'biomarker')?.toLowerCase();

    // Latest result per biomarker; biomarker metadata rides along.
    const rows = db.all<
      Pick<
        BiomarkerRow,
        'slug' | 'name' | 'category' | 'unit' | 'optimal_range_low' | 'optimal_range_high'
      > & {
        standard_range_low: number | null;
        standard_range_high: number | null;
        value: number | null;
        collected_at: string | null;
      }
    >(
      `SELECT b.slug, b.name, b.category, b.unit,
              b.optimal_range_low, b.optimal_range_high,
              b.standard_range_low, b.standard_range_high,
              r.value, r.collected_at
       FROM biomarkers b
       LEFT JOIN lab_results r ON r.id = (
         SELECT id FROM lab_results
         WHERE biomarker_id = b.id
         ORDER BY collected_at DESC, created_at DESC LIMIT 1
       )
       ORDER BY b.category, b.name`
    );

    const filtered = rows.filter(
      (row) =>
        (category === undefined || row.category === category) &&
        (nameFilter === undefined ||
          row.slug.toLowerCase().includes(nameFilter) ||
          row.name.toLowerCase().includes(nameFilter))
    );
    const withValues = filtered.filter((row) => row.value !== null);

    return json({
      biomarkersTracked: filtered.length,
      resultsAvailable: withValues.length,
      note:
        withValues.length === 0
          ? 'No lab results imported yet — the biomarker catalog exists but has no values.'
          : undefined,
      results: withValues,
    });
  },
};

// --- list_reminders ----------------------------------------------------------

const listRemindersTool: CoachTool = {
  name: 'list_reminders',
  description:
    'Every active reminder (title, time, repeat cadence, who created it). Call this ' +
    'before setting a reminder (avoid duplicates) and when asked what is scheduled.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  execute: (db, _input, context) => {
    const today = todayISODate(context.now);
    return json({
      reminders: listActiveReminders(db).map((r) => ({
        id: r.id,
        title: r.title,
        time: r.time,
        date: r.date,
        repeat: r.repeat,
        createdBy: r.created_by,
        dueToday: isDueOn(r, today),
      })),
    });
  },
};

// --- get_insights ------------------------------------------------------------

const getInsights: CoachTool = {
  name: 'get_insights',
  description:
    'Precomputed, deterministic insights over all data: window-over-window trends, ' +
    'logging gaps, symptom volume, and correlations — each with the exact numbers. ' +
    'Call this FIRST for open questions ("how am I doing", "anything I should know"), ' +
    'and cite its numbers rather than recomputing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  execute: (db, _input, context) =>
    json({
      insights: computeInsights(db, context.now),
      briefLine: generateDailyBrief(db, context.now),
    }),
};

// --- get_protocols -----------------------------------------------------------

const getProtocols: CoachTool = {
  name: 'get_protocols',
  description:
    'The user’s protocols — supplement stacks, routines, training blocks — each with its live ' +
    'version number and current items (title, scheduled_time, dose). Call this before proposing ' +
    'a change with update_protocol (you must know the current items to submit the complete new ' +
    'list), and whenever the user asks what is in a stack or routine.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  execute: (db) =>
    json({
      protocols: listProtocols(db).map((p) => {
        const version = getCurrentVersion(db, p.id);
        return {
          slug: p.slug,
          name: p.name,
          type: p.type,
          isActive: p.isActive,
          versionNumber: p.versionNumber,
          items: parseProtocolContent(version?.content ?? null).items.map((item) => ({
            title: item.title,
            scheduled_time: item.scheduled_time,
            dose: item.dose,
          })),
        };
      }),
    }),
};

// --- search_knowledge --------------------------------------------------------

const SEARCH_SCOPES = ['all', 'knowledge', 'memory'] as const;

const searchKnowledge: CoachTool = {
  name: 'search_knowledge',
  description:
    'Retrieve passages, by semantic similarity to a query, from the curated longevity knowledge ' +
    'base AND the user’s own history (past days, notes, insights, protocol changes). Call this to ' +
    'ground an explanation in evidence ("why does ApoB matter?") or to recall the user’s own past ' +
    '("have we tried magnesium before?"). Every passage carries a citation — cite it; never state ' +
    'a retrieved fact without its source. NOTE: the on-device knowledge base ships with a future ' +
    'app update — if the result says it is unavailable, tell the user plainly and answer from the ' +
    'other tools; NEVER invent a passage or citation.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for, in natural language.' },
      scope: {
        type: 'string',
        enum: [...SEARCH_SCOPES],
        description: 'Which corpus to search: all (default), knowledge, or memory.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  readOnly: true,
  execute: async (db, input) => {
    const args = asRecord(input);
    const query = reqString(args, 'query');
    const scope = optEnum(args, 'scope', SEARCH_SCOPES) ?? 'all';
    const result = await retrievePassages(db, query, {
      corpora: scope === 'all' ? undefined : [scope],
    });
    if (!result.available) {
      return json({ available: false, note: result.reason, passages: [] });
    }
    return json({
      available: true,
      passages: result.passages.map((p) => ({
        citation: p.citation,
        corpus: p.corpus,
        text: p.text,
      })),
    });
  },
};

// --- get_experiments ---------------------------------------------------------

const getExperiments: CoachTool = {
  name: 'get_experiments',
  description:
    "The user's n-of-1 experiments: ACTIVE ones (each with daysLeft, and ready=true once its " +
    'window has closed and it is time to read out) and, when include_completed is set, recent ' +
    'concluded ones with their verdicts. Call before concluding one (complete_experiment needs ' +
    'the id), or when the user asks how an experiment is going.',
  inputSchema: {
    type: 'object',
    properties: { include_completed: { type: 'boolean' } },
    additionalProperties: false,
  },
  readOnly: true,
  execute: (db, input, context) => {
    const today = todayISODate(context.now);
    const active = activeExperiments(db, today).map((e) => ({
      id: e.id,
      title: e.title,
      hypothesis: e.hypothesis,
      intervention: e.intervention,
      metrics: e.metrics,
      startDate: e.start_date,
      endDate: e.end_date,
      daysLeft: e.daysLeft,
      ready: e.ready,
      successCriteria: e.success_criteria,
    }));
    const completed =
      asRecord(input)['include_completed'] === true
        ? recentlyConcluded(db, 5).map((e) => ({
            id: e.id,
            title: e.title,
            conclusion: e.conclusion,
            endDate: e.end_date,
          }))
        : undefined;
    return json({ active, ...(completed ? { completed } : {}) });
  },
};

export const READ_TOOLS: CoachTool[] = [
  getTodaySnapshot,
  getMetricSeries,
  getTrainingSummary,
  getNutritionSummary,
  getSymptomHistory,
  getBiomarkers,
  getProtocols,
  listRemindersTool,
  getInsights,
  searchKnowledge,
  getExperiments,
];
