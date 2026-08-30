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
import { countActiveMemories, listMemories } from '@/lib/db/repositories/coach-memory';
import { biomarkerSeries } from '@/lib/db/repositories/labs';
import { latestBody } from '@/lib/db/repositories/body';
import { buildRecommendation } from '@/lib/db/repositories/training-recommend';
import { getActiveMode } from '@/lib/db/repositories/day-modes';
import { activeExperiments, recentlyConcluded } from '@/lib/db/repositories/experiments';
import { weekSummary } from '@/lib/db/repositories/exercise';
import {
  activeNutritionTargets,
  dayFiberTotal,
  listTodayMeals,
  nutritionHistory,
  partialMealMetrics,
  todayTotals,
} from '@/lib/db/repositories/nutrition';
import { getCurrentVersion, listProtocols } from '@/lib/db/repositories/protocols';
import { isDueOn, listActiveReminders } from '@/lib/db/repositories/reminders';
import {
  dueScreenings,
  listScreenings,
  pastScheduledAppointments,
  upcomingAppointments,
} from '@/lib/db/repositories/screenings';
import { listTodaySymptoms } from '@/lib/db/repositories/symptoms';
import { getOrCreateUser, getPreferences } from '@/lib/db/repositories/user';
import { deviceLabel, pickDailyMetric } from '@/lib/db/repositories/wearables';
import { isAccumulatingMetric } from '@/lib/health/accumulating';
import { SAMPLE_METRICS, STATISTIC_METRICS } from '@/lib/health/mapping';
import { deriveReadiness } from '@/lib/home/readiness';
import { metricByKey, resolveDisplay, type MetricKey } from '@/lib/log/metrics';
import { getModeDefinition } from '@/lib/modes/registry';
import { cadenceText } from '@/lib/protocols/cadence';
import { parseProtocolContent } from '@/lib/protocols/content';
import { phaseOn } from '@/lib/protocols/phase';
import type { BiomarkerRow } from '@/lib/db/types';
import {
  DAY_METRIC_LABELS,
  dayFigure,
  unguardedNote,
  type DayMetric,
} from '@/lib/nutrition/remaining';
import type { MealRow, NutritionTargetsRow } from '@/lib/nutrition/types';
import type { UnitPreferences } from '@/lib/user/types';

import { computeInsights, dueRemindersFor, generateDailyBrief } from '../insights';
import {
  bodyDailySeries,
  endOfLocalDayUtc,
  isoDaysAgo,
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
import {
  getRecipe,
  isResolved,
  listIngredients,
  listRecipes,
  parseSteps,
  recipeCookStats,
  recipeNutrition,
} from '@/lib/db/repositories/recipes';
import { listCheckedGroceryItems, listOpenGroceryItems } from '@/lib/db/repositories/grocery';
import { CATEGORY_LABELS } from '@/lib/grocery/categories';
import { searchUserHistory } from '../history-search';
import { ageOn } from '../turn-context';
import {
  asRecord,
  daysWindow,
  optEnum,
  optNumber,
  optString,
  reqString,
  type CoachTool,
} from './types';

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
  /** Many rows a day that must be added up (sips logged, sessions logged). */
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
  // NO `accumulating` FLAG HERE, deliberately. Whether a folded day is
  // FINISHED is a different axis from `agg` (which folds it), and it is
  // answered by {@link isAccumulatingMetric} — the app's one declaration, in
  // lib/health/accumulating.ts. This spec used to be one of four places each
  // holding its own copy of that answer.
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
 * Delegated, not decided: {@link isAccumulatingMetric} is the app's one
 * declaration (lib/health/accumulating.ts), shared with the insight trends, the
 * brief's floor line and the self-review. This used to read
 * `spec.agg === 'sum' || spec.accumulating === true`, i.e. it re-derived half
 * the answer from a flag only this file set. The `agg === 'sum'` half was true
 * and remains true — summing many rows into a day IS accumulation — so it is
 * preserved as an assertion (db/health-mapping.test.mjs §13) rather than as a
 * second rule that a new `agg: 'sum'` spec could satisfy here and nowhere else.
 */
function accumulatesThroughDay(spec: WearableMetricSpec): boolean {
  return isAccumulatingMetric(spec.metricType);
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

// --- Daily nutrition targets (0015) ------------------------------------------
//
// THE BUG THIS EXISTS FOR (owner report, 2026-08-11). Asked "what do you think
// of my nutrition goals for today?", the Coach answered: *"I don't actually have
// a 'nutrition goals' setting to check against — nothing in your profile or
// protocols defines a kcal/protein/carb target."* Every word of that is false.
// `nutrition_targets` has shipped since 0015, the owner edits it at
// app/nutrition-targets.tsx, and app/nutrition.tsx draws its whole macro grid
// from it. The Coach simply had no tool that read the table, and turned its own
// blindness into a claim about the product.
//
// Targets are therefore NOT a tool of their own: they are a field of the day.
// "What's left?" is a today question, so the answer belongs in the payload the
// model already fetches for today rather than behind a second round-trip that
// only gets made once the model already suspects targets exist — which is
// exactly the thing it did not suspect. The absent case is stated in words for
// the same reason: "no targets are set" and "ARC has no targets feature" have to
// be impossible to confuse.
//
// The arithmetic is not re-derived here. dayFigure/unguardedNote are the SAME
// functions the Eat tab counts down with (src/lib/nutrition/remaining.ts), so
// the Coach and the screen can never disagree about what is left — including
// their refusal to subtract when a meal was logged without numbers.

/** The macros a remainder can be computed from, in display order. */
const TARGET_METRICS: readonly DayMetric[] = ['kcal', 'protein_g', 'carbs_g', 'fat_g'];

/**
 * Today's targets and what is left of each, or an explicit "not set".
 *
 * `remaining: null` on a metric that HAS a target means the day cannot support
 * a subtraction (a meal was logged with no value for it, or with a total known
 * to be short), and `note` says which meals and why. That is the screen's own
 * fallback, carried through rather than papered over with a confident number.
 */
function todayTargetsPayload(
  db: Database,
  date: string,
  meals: MealRow[]
): Record<string, unknown> {
  const targets = activeNutritionTargets(db, date);
  if (!targets) {
    return {
      set: false,
      note:
        'The user has NOT set daily targets. This is an unset setting, not a missing feature: ' +
        'ARC ships nutrition targets (Eat › Daily targets), and you can set them yourself with ' +
        'set_nutrition_targets. Say they are not set — never that ARC has no target to check ' +
        'against.',
    };
  }
  const partial = partialMealMetrics(db, date);
  const progress: Record<string, unknown> = {};
  for (const metric of TARGET_METRICS) {
    const target = targets[metric];
    if (target == null || target <= 0) continue;
    const figure = dayFigure(meals, metric, target, partial);
    progress[metric] = {
      label: DAY_METRIC_LABELS[metric],
      target,
      eaten: figure.eaten,
      remaining: figure.mode === 'remaining' ? figure.remaining : null,
    };
  }
  // Fiber is deliberately outside the countdown model (see remaining.ts): it is
  // summed from meal ITEMS, so a hand-typed meal contributes none by
  // construction and every mixed day would under-report. Reported as eaten-vs-
  // target with that stated, never as a remainder.
  const fiberTarget = targets.fiber_g;
  const fiber =
    fiberTarget != null && fiberTarget > 0
      ? {
          label: 'fiber',
          target: fiberTarget,
          eaten: round1(dayFiberTotal(db, date)),
          remaining: null,
          note: 'Fiber counts only itemized meals, so this total is a floor, not a full day.',
        }
      : undefined;
  const unguarded = unguardedNote(meals, targets, partial);
  return {
    set: true,
    since: targets.effective_date,
    setBy: targets.created_by === 'ai' ? 'you (the Coach)' : 'the user',
    ...(targets.notes ? { targetNotes: targets.notes } : {}),
    progress,
    ...(fiber ? { fiber } : {}),
    ...(unguarded ? { note: unguarded } : {}),
  };
}

/** The identity of a target set, for "did the targets change in this window?". */
function targetKey(t: NutritionTargetsRow | NutritionHistoryTarget | null | undefined): string {
  if (!t) return 'none';
  return [t.kcal, t.protein_g, t.carbs_g, t.fat_g, t.fiber_g].join('/');
}

type NutritionHistoryTarget = {
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
};

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
    // TRIMMED 2026-08-11 (db/coach-eval.test.mjs §6: "the next addition trims").
    // Everything cut was either restated by the system prompt's cached rails
    // (absence is not zero, quote the returned units) or stated AT RUNTIME by
    // the payload itself — `wearables.note` now affirms a working sync in words,
    // and `readiness.detail` is rewritten in the execute below. What stays is
    // only what the field names cannot carry.
    "Today's full picture: mission items with ids and status, meals with macro totals, the " +
    "day's NUTRITION TARGETS and what is left of each, workouts, symptoms, captures, " +
    "reminders due, today's Apple Health numbers, and the `readiness` verdict + pillars Home " +
    'is showing. Call this before answering anything about today. ANYTHING PRESENT IN ' +
    '`wearables.today` HAS SYNCED, whatever another field says; `wearables.neverRecorded` is ' +
    'the subset this device has no sensor for at all — hardware, not a sync failure. ' +
    '`readiness` is about RECOVERY only. A reminder with `daysOverdue` > 0 is carried over, ' +
    "not part of today's plan. `nutritionTargets.set: false` means the user has not set " +
    'targets — an unset setting, never a missing feature.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  execute: (db, _input, context) => {
    const date = todayISODate(context.now);
    const mode = getActiveMode(db, date);
    const modeDef = getModeDefinition(mode);
    const meals = listTodayMeals(db, date);
    const totals = todayTotals(db, date);
    // Movements, not a name: sessions have no names since 2026-08-14 (owner),
    // and "Lat Pulldown, Barbell Row" tells the model far more about the day
    // than "Back A" ever did. `group_concat(DISTINCT …)` uses SQLite's default
    // comma separator, which is why the result is split rather than passed on.
    const workouts = db
      .all<{ movements: string | null; kind: string; duration_min: number | null }>(
        `SELECT w.kind, w.duration_min,
                (SELECT group_concat(DISTINCT s.exercise) FROM workout_sets s
                  WHERE s.workout_id = w.id AND s.set_type != 'warmup') AS movements
         FROM workouts w WHERE w.date = ? ORDER BY w.created_at`,
        [date]
      )
      .map((w) => ({
        kind: w.kind,
        duration_min: w.duration_min,
        movements: (w.movements ?? '').split(',').filter((m) => m.trim() !== ''),
      }));

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
    const user = getOrCreateUser(db);
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
      // Age and sex, so age-dependent reasoning (and every reference range) is
      // right from the first token instead of after a question.
      profile: { age: ageOn(user.date_of_birth, date), sex: user.biological_sex },
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
      // The id rides along because adjust_today addresses rows BY id — without
      // it the Coach can see the day but cannot change it. The user still only
      // ever sees titles.
      mission: listMission(db, date).map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        scheduledTime: m.scheduledTime ?? null,
        category: m.category,
        ...(m.why ? { why: m.why } : {}),
      })),
      meals: meals.map((m) => ({
        time: m.time,
        name: m.name,
        kcal: m.kcal,
        protein_g: m.protein_g,
      })),
      nutritionTotals: totals,
      // What the day is being judged AGAINST — the field whose absence made the
      // Coach deny the feature existed. Always present: either the live target
      // set with what is left of each, or an explicit `set: false` that says
      // unset, not unsupported. See todayTargetsPayload.
      nutritionTargets: todayTargetsPayload(db, date, meals),
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
      // Running experiments, so the improvement loop is visible without a
      // second call. `ready` means the window has CLOSED and a readout is owed.
      experiments: activeExperiments(db, date).map((e) => ({
        id: e.id,
        title: e.title,
        intervention: e.intervention,
        metrics: e.metrics,
        daysLeft: e.daysLeft,
        ready: e.ready,
      })),
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
    // Trimmed twice. 2026-08-10 cut the 17-name metric enumeration (discoverable
    // at runtime via `wearables.availableMetrics`, and an unknown name already
    // errors WITH the valid set). 2026-08-11 cut the accumulation doctrine, for
    // the same reason and with better cover: the PAYLOAD states it at runtime,
    // in the exact case it applies, through `statsBasis`, `statsExcludesToday`,
    // `todaySoFar.note` and a `note` that spells out how to cite both figures.
    // Repeating all of it here billed ~350 tokens on every request — including
    // every request about a level metric, where none of it is even true.
    'Daily history for ONE metric over the last N days, in the user’s display units, with ' +
    'min/avg/max. Call this for any trend, change, or "how has X been". Takes body metrics ' +
    '(weight, body_fat, waist) and any wearable metric_type on the device, plus friendly ' +
    'aliases ("sleep", "vo2max"); an unknown name errors WITH the valid set. Quote the `hm` ' +
    'field ("7h 11m"), never raw minutes. READ THE PAYLOAD’S OWN `note`, `statsBasis` and ' +
    '`todaySoFar` before quoting: for a metric that accumulates through the day, `stats` is ' +
    'COMPLETE days only and today is reported apart — cite both, never average today in.',
  inputSchema: {
    type: 'object',
    properties: {
      metric: {
        type: 'string',
        description:
          'A body metric or a wearable metric_type; ' +
          'get_today_snapshot.wearables.availableMetrics lists this device’s set.',
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
      // Closed at the end of the LOCAL day, as a UTC instant. Without the bound
      // a future-dated row (clock skew, a bad import) lands in the series and
      // moves the average; with a naive `substr(measured_at,1,10) <= today`
      // bound instead, an evening weigh-in west of UTC — already carrying
      // tomorrow's UTC date — would be dropped from the user's own series.
      const points = bodyDailySeries(db, target.column, since, endOfLocalDayUtc(context.now)).map(
        (p) => ({
          date: p.date,
          value: round1(spec.fromCanonical(p.value)),
        })
      );
      return json(
        seriesPayload({
          metric: requested,
          label: descriptor.label,
          source: 'body_metrics',
          unit: spec.unit,
          aggregation: 'daily average of that day’s measurements',
          days,
          points,
          // A body metric with older readings than the window is missing IN THIS
          // WINDOW, not never recorded. Sourced from the true last row (same
          // date derivation bodyDailySeries uses, substr(measured_at,1,10)) so
          // an empty-but-historied window yields the softer "most recent value
          // on record is from <date>" note, matching the wearable branch.
          lastRecorded: latestBody(db, target.column)?.measuredAt.slice(0, 10) ?? null,
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
    // The "this week" ≠ "last N days" rule lives in the system prompt, cached
    // once for the whole registry (2026-08-11 trim).
    'Training over the last N days (default 28): per-day sessions/minutes, average weekly ' +
    'rates over that rolling window, the most recent sessions, and `thisWeek` — the current ' +
    'Monday-start calendar week. Call this for anything about workouts, training load, ' +
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

    // Movements rather than a name — see the note in get_today_snapshot.
    const recent = db
      .all<{
        date: string;
        movements: string | null;
        kind: string;
        duration_min: number | null;
      }>(
        `SELECT w.date, w.kind, w.duration_min,
                (SELECT group_concat(DISTINCT s.exercise) FROM workout_sets s
                  WHERE s.workout_id = w.id AND s.set_type != 'warmup') AS movements
         FROM workouts w
         WHERE w.date >= ? ORDER BY w.date DESC, w.created_at DESC LIMIT 10`,
        [since]
      )
      .map((w) => ({
        date: w.date,
        kind: w.kind,
        duration_min: w.duration_min,
        movements: (w.movements ?? '').split(',').filter((m) => m.trim() !== ''),
      }));

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
    'Nutrition over the last N days (default 14): per-day kcal/protein/carbs/fat/fiber ' +
    'totals, averages across logged days, and the DAILY TARGETS those days were judged ' +
    'against. Call this for anything about diet, protein, calories, eating patterns, or ' +
    'target adherence. `targets: null` means the user has not set targets — an unset ' +
    'setting, not a missing feature; offer set_nutrition_targets.',
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
    const today = todayISODate(context.now);
    // nutritionHistory over the hand-rolled aggregate: it is the SAME read the
    // Nutrition history screen renders, so it carries fiber (summed from item
    // snapshots) and resolves each day's own governing target — "was I under in
    // March?" is answered against March's numbers, not today's. It zero-fills
    // every day in the window, so logged days are filtered back out here to
    // keep `perDay`/`loggedDays` meaning exactly what they meant before.
    const history = nutritionHistory(db, days, today);
    const logged = history.filter((d) => d.mealCount > 0);
    const loggedDays = logged.length;
    const avg = (pick: (d: (typeof logged)[number]) => number) =>
      loggedDays === 0 ? null : round1(logged.reduce((a, d) => a + pick(d), 0) / loggedDays);

    const current = activeNutritionTargets(db, today);
    const currentKey = targetKey(current);
    return json({
      days,
      loggedDays,
      // Reported ONCE, not on all 14 rows — a per-day copy of an unchanged
      // target set is pure payload cost. A day governed by a DIFFERENT set
      // carries its own `target`, so a mid-window change is never hidden.
      targets: current
        ? {
            since: current.effective_date,
            setBy: current.created_by === 'ai' ? 'you (the Coach)' : 'the user',
            kcal: current.kcal,
            protein_g: current.protein_g,
            carbs_g: current.carbs_g,
            fat_g: current.fat_g,
            fiber_g: current.fiber_g,
          }
        : null,
      ...(current
        ? {}
        : {
            targetsNote:
              'The user has not set daily targets. ARC supports them (Eat › Daily targets) ' +
              'and you can set them with set_nutrition_targets — say they are unset, never ' +
              'that there is nothing to judge against.',
          }),
      perDay: logged.map((d) => ({
        date: d.date,
        kcal: d.kcal,
        protein_g: d.protein_g,
        carbs_g: d.carbs_g,
        fat_g: d.fat_g,
        // Item-sourced, so a hand-typed meal contributes none — a floor, not a
        // total. Only worth reporting when something recorded it.
        ...(d.fiber_g > 0 ? { fiber_g: round1(d.fiber_g) } : {}),
        ...(targetKey(d.target) === currentKey ? {} : { target: d.target }),
      })),
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
    'longevity-oriented optimal ranges, standard ranges, and measurement dates. Call this for ' +
    'anything about labs, bloodwork, ApoB, lipids or hormones. Empty means no labs are ' +
    'imported yet.',
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
    'version number and its phases of items (title, time, dose, cadence). Call this before ' +
    'proposing a change with update_protocol (you must know the current content to submit the ' +
    'complete new one), and whenever the user asks what is in a stack or routine.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  // The OUTPUT costs nothing against the schema budget, so it carries
  // everything the model needs to write a correct update back: each item's
  // cadence in the same terse vocabulary `update_protocol` accepts, and — for a
  // phased protocol — which phase is live TODAY, so an answer about "what am I
  // taking" is about now rather than about the whole document.
  execute: (db, _input, context) => {
    const today = todayISODate(context.now);
    return json({
      protocols: listProtocols(db).map((p) => {
        const content = parseProtocolContent(getCurrentVersion(db, p.id)?.content ?? null);
        const state = phaseOn(content, p.startedOn ?? today, today);
        return {
          slug: p.slug,
          name: p.name,
          type: p.type,
          isActive: p.isActive,
          versionNumber: p.versionNumber,
          ...(state.kind === 'running'
            ? content.phases.length > 1
              ? { livePhase: state.window.index + 1, dayOfPhase: state.window.dayInPhase + 1 }
              : {}
            : { status: state.kind === 'ended' ? 'ended' : 'not started yet' }),
          phases: content.phases.map((phase) => ({
            ...(phase.title ? { title: phase.title } : {}),
            ...(phase.duration_days === null ? {} : { duration_days: phase.duration_days }),
            items: phase.items.map((item) => ({
              title: item.title,
              scheduled_time: item.scheduled_time,
              dose: item.dose,
              cadence: cadenceText(item.cadence),
            })),
          })),
        };
      }),
    });
  },
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

// --- get_training_recommendation ----------------------------------------------

const getTrainingRecommendation: CoachTool = {
  name: 'get_training_recommendation',
  description:
    "The training engine's computed state and today's recommended session: per-muscle " +
    'freshness, weekly volume vs MEV/MAV/MRV landmarks, program week (and whether it is a ' +
    'deload), and per-exercise progression targets. Call it before advising on training, ' +
    'programming, or progression. It reports numbers; it does not decide.',
  inputSchema: {
    type: 'object',
    properties: {
      volume_scale: {
        type: 'number',
        minimum: 0.1,
        maximum: 1.5,
        description:
          'Working-set multiplier, once YOU have decided the session should be lighter or ' +
          'harder (0.6 = 60%). Previews only — changes nothing. Omit for the plan as written.',
      },
    },
    additionalProperties: false,
  },
  readOnly: true,
  execute: (db, input, context) => {
    const volumeScale = optNumber(asRecord(input), 'volume_scale');
    const { ledger, volume, recommendation } = buildRecommendation(db, context.now, {
      ...(volumeScale !== undefined ? { volumeScale } : {}),
    });
    const units = getPreferences(db).units;
    const weightSpec = resolveDisplay(metricByKey('weight')!, units);
    const fmtTarget = (kg: number | null) =>
      kg == null ? null : `${round1(weightSpec.fromCanonical(kg))} ${weightSpec.unit}`;

    const exercises =
      'exercises' in recommendation
        ? recommendation.exercises.map((e) => ({
            name: e.name,
            freshness: e.freshness,
            sets: e.targetSets ?? null,
            target: {
              kind: e.suggestion.kind,
              weight: fmtTarget(e.suggestion.targetWeightKg),
              reps: e.suggestion.targetReps,
              note: e.suggestion.note,
            },
          }))
        : undefined;

    return json({
      ...(volumeScale !== undefined
        ? {
            volumeScaleApplied: volumeScale,
            note: 'Sets below already reflect the volume_scale you passed — this is a preview, nothing was changed.',
          }
        : {}),
      recommendation: {
        kind: recommendation.kind,
        why: recommendation.why,
        ...('routineName' in recommendation
          ? {
              routineName: recommendation.routineName,
              freshness: recommendation.freshness,
              caution: recommendation.caution,
            }
          : {}),
        ...('program' in recommendation && recommendation.program
          ? {
              program: {
                name: recommendation.program.programName,
                week: recommendation.program.week,
                weeks: recommendation.program.weeks,
                weekKind: recommendation.program.weekKind,
              },
            }
          : {}),
        ...(exercises ? { exercises } : {}),
      },
      muscleFreshness: ledger.map((m) => ({
        muscle: m.muscle,
        freshness: m.freshness,
        state: m.state,
      })),
      // Only muscles with any tracked volume this week — 16 zero rows is noise.
      weeklyVolume: volume
        .filter((v) => v.sets > 0)
        .map((v) => ({
          muscle: v.muscle,
          weeklySets: round1(v.sets),
          mev: v.mev,
          mav: v.mav,
          mrv: v.mrv,
          status: v.status,
          guidance: v.guidance,
        })),
    });
  },
};

// --- get_biomarker_history -----------------------------------------------------

const getBiomarkerHistory: CoachTool = {
  name: 'get_biomarker_history',
  description:
    'Every recorded lab value for ONE biomarker over time, oldest first, with its ' +
    "longevity-oriented optimal range — the trend behind get_biomarkers' latest-only " +
    'view. Call this for "how has my ApoB moved", comparing lab reports, or judging ' +
    'whether an intervention shifted a marker. Identify the biomarker by slug or name ' +
    '(from get_biomarkers); an ambiguous name returns the candidates instead of guessing.',
  inputSchema: {
    type: 'object',
    properties: {
      biomarker: { type: 'string', description: 'Slug or name, e.g. "apob" or "ApoB".' },
    },
    required: ['biomarker'],
    additionalProperties: false,
  },
  readOnly: true,
  execute: (db, input) => {
    const query = reqString(asRecord(input), 'biomarker');
    const needle = query.toLowerCase();
    const all = db.all<
      Pick<BiomarkerRow, 'slug' | 'name' | 'unit' | 'optimal_range_low' | 'optimal_range_high'> & {
        standard_range_low: number | null;
        standard_range_high: number | null;
      }
    >(
      `SELECT slug, name, unit, optimal_range_low, optimal_range_high,
              standard_range_low, standard_range_high
       FROM biomarkers ORDER BY name`
    );

    // Exact slug, then exact name (case-insensitive), then a UNIQUE substring
    // match — never a guess between two candidates (the labs discipline:
    // "Testosterone" is a substring of "Testosterone, Free").
    const exact =
      all.find((b) => b.slug.toLowerCase() === needle) ??
      all.find((b) => b.name.toLowerCase() === needle);
    const candidates = exact
      ? [exact]
      : all.filter(
          (b) => b.slug.toLowerCase().includes(needle) || b.name.toLowerCase().includes(needle)
        );

    if (candidates.length === 0) {
      return json({ found: false, note: `No biomarker matches "${query}".` });
    }
    if (candidates.length > 1) {
      return json({
        found: false,
        note: `"${query}" is ambiguous — name one of these exactly.`,
        candidates: candidates.map((b) => ({ slug: b.slug, name: b.name })),
      });
    }

    const marker = candidates[0]!;
    const results = biomarkerSeries(db, marker.slug);
    return json({
      found: true,
      slug: marker.slug,
      name: marker.name,
      unit: marker.unit,
      optimalRange: { low: marker.optimal_range_low, high: marker.optimal_range_high },
      standardRange: { low: marker.standard_range_low, high: marker.standard_range_high },
      resultCount: results.length,
      note: results.length === 0 ? 'No lab results recorded for this biomarker yet.' : undefined,
      results: results.map((r) => ({ value: r.value, collectedAt: r.collectedAt })),
    });
  },
};

// --- get_memories --------------------------------------------------------------

const getMemories: CoachTool = {
  name: 'get_memories',
  description:
    'Every durable fact you have stored about the user, with ids (the same list that opens ' +
    'your context block). Call this when you need an id to forget one, or to check whether ' +
    'you already know something before proposing to remember it again.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  execute: (db) => {
    // EVERY active memory, not the prompt's 40. This tool is the escape hatch
    // the context block points at when it says some are hidden — capping it at
    // the same number would make that instruction a dead end. It is an explicit
    // read, so it costs tokens only when the Coach decides it needs them.
    const memories = listMemories(db, MEMORY_READ_LIMIT);
    const total = countActiveMemories(db);
    return json({
      total,
      showing: memories.length,
      note:
        total > memories.length
          ? `Only the ${memories.length} most recent of ${total} are listed; use search_history to search the rest by text.`
          : undefined,
      memories: memories.map((m) => ({
        id: m.id,
        content: m.content,
        category: m.category,
        since: m.created_at.slice(0, 10),
      })),
    });
  },
};

/** Hard ceiling on one get_memories read — generous, but not unbounded. */
const MEMORY_READ_LIMIT = 200;

// --- search_history ------------------------------------------------------------

const searchHistory: CoachTool = {
  name: 'search_history',
  description:
    // Corrected AND trimmed 2026-08-12 (0035). "ARC's curated longevity
    // reference" named only the shipped pack; the knowledge base now has two
    // owners and the user's own entries rank ABOVE it. How to read a conflict
    // between them lives once in the system prompt's cached
    // Memory-and-knowledge bullet, so it is not restated here.
    'Keyword search over everything the user has written — past turns, day-log notes, ' +
    'protocol change notes, experiments, your memories — AND the knowledge base: their own ' +
    'entries plus ARC’s shipped reference. Use it to recall something specific ("have we ' +
    'tried magnesium?") or to ground an explanation. Literal matching, not semantic: try ' +
    'their own wording. Cite the source on every hit.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to look for, e.g. "magnesium sleep".' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 15.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  readOnly: true,
  execute: (db, input) => {
    const args = asRecord(input);
    const query = reqString(args, 'query');
    const limit = optNumber(args, 'limit') ?? 15;
    const hits = searchUserHistory(db, query, Math.min(50, Math.max(1, Math.round(limit))));
    return json({
      query,
      matches: hits.length,
      note:
        hits.length === 0
          ? 'Nothing in the user’s history or the ARC reference matches those words. Say so — do not guess what they said, and answer from general knowledge only if you flag that it is not ARC-specific.'
          : undefined,
      results: hits,
    });
  },
};

// --- get_recipes / get_recipe / get_grocery_list (docs/recipes-grocery.md §6) --

/** round1 for nullable per-macro values (null = honest "—", stays null). */
const round1OrNull = (v: number | null): number | null => (v === null ? null : round1(v));

/** Tolerant parse of a recipe's tags JSON → string array. */
function parseTags(tagsJson: string | null): string[] {
  if (tagsJson === null) return [];
  try {
    const raw: unknown = JSON.parse(tagsJson);
    return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

const getRecipesTool: CoachTool = {
  name: 'get_recipes',
  description:
    "The user's recipe book, as summaries — and where recipe_id comes from. " +
    'perServingKcal is null when the nutrition is incomplete.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Title search; omit for the whole book.' },
      favorite_only: { type: 'boolean' },
      limit: { type: 'number', description: 'Default 10, cap 25.' },
    },
    additionalProperties: false,
  },
  readOnly: true,
  execute: (db, input) => {
    const args = asRecord(input);
    const query = optString(args, 'query') ?? '';
    const favoriteOnly = args.favorite_only === true;
    const rawLimit = optNumber(args, 'limit');
    const limit = Math.min(Math.max(Math.trunc(rawLimit ?? 10), 1), 25);
    const all = listRecipes(db, query, { favoriteOnly, limit: 1000 });
    const shown = all.slice(0, limit).map((r) => ({
      id: r.recipe.id,
      title: r.recipe.title,
      servings: r.recipe.servings,
      perServingKcal: r.perServingKcal === null ? null : Math.round(r.perServingKcal),
      nutritionComplete: r.nutritionComplete,
      ingredientCount: r.ingredientCount,
      timesCooked: r.timesCooked,
      lastCooked: r.lastCooked,
      tags: parseTags(r.recipe.tags),
    }));
    return json({ recipes: shown, omitted: all.length - shown.length });
  },
};

const getRecipeTool: CoachTool = {
  name: 'get_recipe',
  description:
    'One recipe in full: ingredient lines with their ids and resolution state, steps, and ' +
    'per-serving nutrition (null where it is not computed).',
  inputSchema: {
    type: 'object',
    properties: { recipe_id: { type: 'string' } },
    required: ['recipe_id'],
    additionalProperties: false,
  },
  readOnly: true,
  execute: (db, input) => {
    const id = reqString(asRecord(input), 'recipe_id');
    const recipe = getRecipe(db, id);
    if (!recipe) throw new Error('No recipe with that id — call get_recipes to see the book.');
    const nutrition = recipeNutrition(db, id);
    const stats = recipeCookStats(db, id);
    const per = nutrition.perServing;
    return json({
      id: recipe.id,
      title: recipe.title,
      servings: recipe.servings,
      totalWeightG: recipe.total_weight_g,
      prepMin: recipe.prep_min,
      cookMin: recipe.cook_min,
      source: {
        kind: recipe.source,
        url: recipe.source_url,
        platform: recipe.source_platform,
        author: recipe.source_author,
      },
      ingredients: listIngredients(db, id).map((line) => ({
        id: line.id,
        raw: line.raw_text,
        qty: line.qty,
        unit: line.unit,
        name: line.name,
        grams: line.grams,
        resolved: isResolved(line),
        negligible: line.negligible === 1,
      })),
      steps: parseSteps(recipe.steps),
      nutrition: {
        complete: nutrition.complete,
        unresolvedCount: nutrition.unresolvedCount,
        perServing: {
          kcal: per.kcal === null ? null : Math.round(per.kcal),
          protein_g: round1OrNull(per.protein_g),
          carbs_g: round1OrNull(per.carbs_g),
          fat_g: round1OrNull(per.fat_g),
          fiber_g: round1OrNull(per.fiber_g),
        },
      },
      timesCooked: stats.timesCooked,
      lastCooked: stats.lastCooked,
      notes: recipe.notes,
    });
  },
};

const getGroceryListTool: CoachTool = {
  name: 'get_grocery_list',
  description: 'The standing grocery list: open items with their ids and categories.',
  inputSchema: {
    type: 'object',
    properties: {
      include_checked: { type: 'boolean', description: 'Also return what is in the cart.' },
    },
    additionalProperties: false,
  },
  readOnly: true,
  execute: (db, input) => {
    const args = asRecord(input);
    const open = listOpenGroceryItems(db);
    const recipeTitles = new Map<string, string>();
    for (const item of open) {
      if (item.recipe_id && !recipeTitles.has(item.recipe_id)) {
        recipeTitles.set(
          item.recipe_id,
          getRecipe(db, item.recipe_id)?.title ?? 'a deleted recipe'
        );
      }
    }
    const sections: { category: string; items: unknown[] }[] = [];
    for (const item of open) {
      const label = CATEGORY_LABELS[item.category] ?? item.category;
      let section = sections.find((s) => s.category === label);
      if (!section) {
        section = { category: label, items: [] };
        sections.push(section);
      }
      section.items.push({
        id: item.id,
        name: item.name,
        qty: item.qty_text,
        forRecipe: item.recipe_id ? (recipeTitles.get(item.recipe_id) ?? null) : null,
      });
    }
    const checked =
      args.include_checked === true
        ? listCheckedGroceryItems(db, 20).map((i) => ({ id: i.id, name: i.name }))
        : undefined;
    return json({
      openCount: open.length,
      sections,
      ...(checked ? { inCart: checked } : {}),
    });
  },
};

// --- get_screenings (0007: preventive ledger + medical calendar) -------------
//
// The second domain the 2026-08-11 coverage census found the Coach blind to,
// and the one where blindness is most expensive. `screenings` and
// `appointments` have shipped since 0007, with three screens behind them
// (app/screenings.tsx, screening-form, appointment-form), and NO tool read
// either. Asked "am I due for anything?" the Coach had exactly the material it
// had for nutrition targets: nothing, and no way to know that nothing was its
// own gap. Preventive cadence is the highest-leverage thing in a longevity
// system to be wrong about by omission.
//
// One tool, not three: the ledger, what is due, and the calendar are one answer
// to one question, and three narrow tools would cost three schemas for it.

/** "Sat 8 Aug, 09:30" for an ISO instant, in LOCAL time. Hand-formatted:
 *  Hermes ships no Intl, so toLocaleString is unavailable on device. */
function humanInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = `${WEEKDAY_SHORT[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day}, ${hh}:${mm}`;
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Bookings whose day passed with nobody closing them out — capped, because an
 * ignored one stays 'scheduled' forever and the tail is unbounded. */
const STALE_APPOINTMENT_LIMIT = 5;

const getScreeningsTool: CoachTool = {
  name: 'get_screenings',
  description:
    'The preventive-health ledger and medical calendar: every tracked screening with its ' +
    'cadence, when it was last done and when it is next due (`status` overdue/due/scheduled/' +
    'untracked), plus upcoming appointments and any booking whose date passed without being ' +
    'closed out. Call this for "am I due for anything", "when was my last colonoscopy", ' +
    'bloodwork timing, or any question about check-ups, scans and doctor visits. An empty ' +
    'ledger means the user has tracked none — ARC does track them (Data › Screenings); never ' +
    'report the feature as missing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  execute: (db, _input, context) => {
    const today = todayISODate(context.now);
    const nowIso = context.now.toISOString();
    // dueScreenings owns the overdue/due boundary (its default 30-day horizon is
    // what the Screenings screen groups by) — reused, not reimplemented, so the
    // Coach and the ledger can never disagree about what "due" means.
    const dueById = new Map(dueScreenings(db, today).map((s) => [s.id, s.dueStatus]));
    const screenings = listScreenings(db).map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      intervalMonths: s.interval_months,
      lastCompleted: s.last_completed,
      nextDue: s.next_due,
      // 'untracked' is a real, distinct state: a one-off with nothing scheduled
      // after it. Reporting it as "not due" would imply a cadence that is not
      // there, which is how a colonoscopy quietly stops being tracked.
      status: dueById.get(s.id) ?? (s.next_due === null ? 'untracked' : 'scheduled'),
      ...(s.notes ? { notes: s.notes } : {}),
    }));
    const upcoming = upcomingAppointments(db, nowIso).map((a) => ({
      id: a.id,
      title: a.title,
      when: humanInstant(a.scheduled_at),
      scheduledAt: a.scheduled_at,
      provider: a.provider,
      forScreening: a.screening_name,
    }));
    const stale = pastScheduledAppointments(db, nowIso)
      .slice(0, STALE_APPOINTMENT_LIMIT)
      .map((a) => ({
        id: a.id,
        title: a.title,
        when: humanInstant(a.scheduled_at),
        forScreening: a.screening_name,
      }));
    return json({
      screenings,
      upcomingAppointments: upcoming,
      // Worth raising unasked: a booking that came and went unclosed is either a
      // visit the ledger never learned about (log_screening_done fixes it) or an
      // appointment that was missed.
      ...(stale.length > 0
        ? {
            pastBookingsStillOpen: stale,
            note:
              'These bookings are still marked scheduled although their date has passed. Ask ' +
              'whether the visit happened; if it did, log_screening_done stamps the linked ' +
              'screening and rolls its cadence.',
          }
        : {}),
      ...(screenings.length === 0 && upcoming.length === 0
        ? {
            emptyNote:
              'The user has not tracked any screenings or appointments yet. ARC supports both ' +
              '(Data › Screenings) — say none are recorded, never that ARC does not track them.',
          }
        : {}),
    });
  },
};

/**
 * search_knowledge is deliberately NOT here. It needs the on-device embedder
 * (Phase 6 #25), which has no native build yet, so every call returns
 * `available: false` — a few hundred tokens of schema on every single request
 * advertising a dead end, and an invitation for the model to try it and then
 * apologise. search_history covers the same ground today by keyword, over both
 * the user's own writing AND the curated corpus. Re-register this the day the
 * embedder ships.
 */
export const UNREGISTERED_READ_TOOLS: CoachTool[] = [searchKnowledge];

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
  getExperiments,
  getTrainingRecommendation,
  getBiomarkerHistory,
  getScreeningsTool,
  getMemories,
  searchHistory,
  getRecipesTool,
  getRecipeTool,
  getGroceryListTool,
];
