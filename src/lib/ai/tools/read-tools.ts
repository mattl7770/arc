/**
 * The Coach's read tools — every way the model can look at the user's real
 * data (docs/ai-coach.md, "Tool set"). All readOnly: the service layer runs
 * these without confirmation. Each returns compact JSON in the user's CHOSEN
 * display units where a display convention exists (weight in lb or kg per their
 * Settings preference), with the unit named so the model never guesses.
 */
import type { Database } from '@/lib/db/database';
import { shiftISODate, todayISODate } from '@/lib/db/date';
import { listTodayEntries } from '@/lib/db/repositories/logs';
import { completedAheadOf, listMission } from '@/lib/db/repositories/mission';
import { countActiveMemories, listMemories } from '@/lib/db/repositories/coach-memory';
import { biomarkerSeries } from '@/lib/db/repositories/labs';
import { latestBody } from '@/lib/db/repositories/body';
import { buildRecommendation } from '@/lib/db/repositories/training-recommend';
import { exerciseLoadBases } from '@/lib/db/repositories/exercise-catalog';
import { openStatuses } from '@/lib/db/repositories/statuses';
import { activeExperiments, recentlyConcluded } from '@/lib/db/repositories/experiments';
import { weekSummary } from '@/lib/db/repositories/exercise';
import {
  activeNutritionTargets,
  dayFiberRecorded,
  dayMicroTotals,
  listTodayMeals,
  mealItemCounts,
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
import { latestScreenTime } from '@/lib/db/repositories/screen-time';
import { listTodaySymptoms } from '@/lib/db/repositories/symptoms';
import {
  getGoalDirection,
  getOrCreateUser,
  getPreferences,
  getWaterTarget,
} from '@/lib/db/repositories/user';
import { deviceLabel, pickDailyMetric } from '@/lib/db/repositories/wearables';
import {
  pairedIngestForMany,
  unpairedIngestedSessions,
  unpairedWorkoutDailyMinutes,
} from '@/lib/db/repositories/workout-ingest';
import { isAccumulatingMetric } from '@/lib/health/accumulating';
import { SAMPLE_METRICS, STATISTIC_METRICS } from '@/lib/health/mapping';
import { deriveReadiness } from '@/lib/home/readiness';
import { metricByKey, resolveDisplay, type MetricKey } from '@/lib/log/metrics';
import { cadenceText } from '@/lib/protocols/cadence';
import { parseProtocolContent } from '@/lib/protocols/content';
import { phaseOn } from '@/lib/protocols/phase';
import { SCREEN_TIME_METRIC } from '@/lib/screen-time/entry';
import type { BiomarkerRow } from '@/lib/db/types';
import {
  DAY_METRIC_LABELS,
  dayFigure,
  unguardedNote,
  type DayMetric,
} from '@/lib/nutrition/remaining';
import { countTotalsOnlyMeals, totalsOnlyNote } from '@/lib/nutrition/key-micro';
import { MICROS } from '@/lib/nutrition/micros';
import type { MealRow, NutritionTargetsRow } from '@/lib/nutrition/types';
import type { UnitPreferences } from '@/lib/user/types';

import { EXPERIMENT_ABANDON_NOTE, RECURRING_REMINDER_NOTE } from '../domains/status-domains';
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
    //
    // The label says "not logged in ARC" because since 0054 that is literally
    // what the number is: a session PAIRED to one the owner logged is subtracted
    // here, since get_training_summary already counts it from `workouts` with
    // its sets and its kind. Before pairing existed the same hour appeared in
    // both tools and nothing could reconcile them. See `accumulatedSeries`.
    metricType: 'workout',
    label: 'Workout minutes (Apple Health, not logged in ARC)',
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
  {
    // The day's total off Settings › Screen Time, typed on Log or sent by a
    // Shortcut (docs/screen-time.md). ONE row per day by construction
    // (repositories/screen-time.ts replaces), so arbitration has nothing to
    // pick between. Declared rather than left to discovery so the label says
    // what the number is — self-reported, from another app's screen — and
    // `hm` carries "3h 20m" instead of an inferred bare minute count.
    metricType: SCREEN_TIME_METRIC,
    label: 'Screen time (daily total, self-reported)',
    canonicalUnit: 'min',
    agg: 'arbitrated',
    decimals: 0,
    isDuration: true,
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
  screen_time: SCREEN_TIME_METRIC,
  screentime: SCREEN_TIME_METRIC,
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
  // target with that stated, never as a remainder. `eaten` is NULL when no
  // item today recorded fiber (2026-09-23) — the same figure `keyMicros.fiber_g`
  // and the Eat tab carry, so the payload never holds a 0 beside a null for
  // one day's fiber.
  const fiberTarget = targets.fiber_g;
  const fiberEaten = fiberTarget != null && fiberTarget > 0 ? dayFiberRecorded(db, date) : null;
  const fiber =
    fiberTarget != null && fiberTarget > 0
      ? {
          label: 'fiber',
          target: fiberTarget,
          eaten: fiberEaten == null ? null : round1(fiberEaten),
          remaining: null,
          note:
            fiberEaten == null
              ? 'No item logged today recorded fiber: eaten is null, which is not recorded, not 0 g.'
              : 'Fiber counts only itemized meals, so this total is a floor, not a full day.',
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

/**
 * Sodium, caffeine and fiber for the day — the three the Eat tab now prints
 * under its macro bars (2026-09-23), from the same repository reads and the
 * same references (`MICROS`), so the Coach and the screen cannot disagree.
 * Payload, not schema: the tool's description and inputSchema do not move, so
 * the cached-prefix ceilings (db/coach-eval.test.mjs §6) do not either.
 *
 * NULL is "nothing logged today recorded it" and never a zero, and every
 * figure is a floor: only foods carry these, so a meal typed in as totals adds
 * none — which the note says, on a day it is true. Undefined on a day with no
 * meals, like the screen's row.
 */
function todayKeyMicrosPayload(
  db: Database,
  date: string,
  meals: MealRow[]
): Record<string, unknown> | undefined {
  if (meals.length === 0) return undefined;
  const micros = dayMicroTotals(db, date);
  const fiber = dayFiberRecorded(db, date);
  const fiberTarget = activeNutritionTargets(db, date)?.fiber_g ?? null;
  const limit = (key: 'sodium_mg' | 'caffeine_mg') =>
    MICROS.find((m) => m.key === key)?.reference ?? null;
  const totalsOnly = totalsOnlyNote(countTotalsOnlyMeals(meals, mealItemCounts(db, date)));
  return {
    sodium_mg: micros.sodium_mg == null ? null : Math.round(micros.sodium_mg),
    sodiumLimit_mg: limit('sodium_mg'),
    caffeine_mg: micros.caffeine_mg == null ? null : Math.round(micros.caffeine_mg),
    caffeineLimit_mg: limit('caffeine_mg'),
    fiber_g: fiber == null ? null : round1(fiber),
    fiberTarget_g: fiberTarget != null && fiberTarget > 0 ? fiberTarget : null,
    note:
      'Summed from logged foods only: null is not recorded, not zero, and each figure is a ' +
      'floor. The limits are general guidance for healthy adults (FDA), not targets the user set.' +
      (totalsOnly ? ` ${totalsOnly}` : ''),
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

/**
 * The daily series for an ACCUMULATING wearable metric — and the one place the
 * ingested-workout de-duplication is applied.
 *
 * `workout` rows are the only metric in `wearable_data` that can describe the
 * same event as a row in another table: a session the owner logged in ARC and
 * the watch also recorded. `get_training_summary` counts that session from
 * `workouts`, where it carries sets, a kind and a duration the owner stands
 * behind, so counting the watch's copy here as well made one hour of training
 * appear in two tools with nothing able to tell (the defect migration 0054 was
 * written for). {@link unpairedWorkoutDailyMinutes} subtracts exactly the paired
 * rows and nothing else.
 *
 * It lives here — one function, both call sites (today's snapshot and the series
 * tool) — because a second reader that forgot the subtraction would put the
 * defect straight back.
 */
function accumulatedSeries(
  db: Database,
  metricType: string,
  sinceDate: string,
  untilDate?: string
): SeriesPoint[] {
  return metricType === 'workout'
    ? unpairedWorkoutDailyMinutes(db, sinceDate, untilDate)
    : wearableDailySeries(db, metricType, sinceDate, 'sum', untilDate);
}

/** Today's value for one wearable metric under its own aggregation rule. */
function wearableToday(
  db: Database,
  spec: WearableMetricSpec,
  date: string
): { value: number; source: string | null } | null {
  if (spec.agg === 'sum') {
    const point = accumulatedSeries(db, spec.metricType, date).find((p) => p.date === date);
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
    const statuses = openStatuses(db, date);
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
      // Screen time shares the table but is not a sync: it is typed or sent by
      // a Shortcut, and it has its own `screenTime` field below. Counted here
      // it would let `note` tell the model Apple Health "HAS synced today" on
      // the strength of a number the owner typed.
      if (presence.metricType === SCREEN_TIME_METRIC) continue;
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
      // What the user has SAID about the day (0061) — the fact, with no
      // directive and no tone attached. `mode` used to sit here carrying a
      // heroFocus and a toneGuidance the registry wrote; a status has neither,
      // because what today should become is the model's call on this turn.
      // Omitted entirely on an ordinary day rather than sent as an empty array.
      ...(statuses.length > 0
        ? {
            statuses: statuses.map((row) => ({
              label: row.label,
              since: row.start_date,
              until: row.end_date,
              excusesSkips: row.excuses === 1,
              source: row.source,
            })),
          }
        : {}),
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
        // The day a completion was actually recorded, and ONLY when it differs
        // from today: a row ticked ahead on the Plan screen, or a past row
        // backfilled. Omitted on every ordinary tick, so the usual day carries
        // no field at all. Payload, not schema — see `ahead` below.
        ...(m.doneOn !== undefined && m.doneOn !== date ? { doneOn: m.doneOn } : {}),
      })),
      // What is already ticked off days that have NOT happened (the Plan
      // screen, 2026-09-19). Omitted when empty, which is every database that
      // has never used the feature — and deliberately a bare list of facts
      // with no rule attached about whether early is good. That is judgment,
      // and judgment lives in the model, not in a description sentence.
      //
      // TOKEN DELTA: zero, by construction. Nothing about this tool's
      // description or `inputSchema` moves, and the Coach's cached prefix is
      // what the two ceilings in db/coach-eval.test.mjs §6 guard.
      ...(() => {
        const ahead = completedAheadOf(db, date);
        return ahead.length > 0 ? { ahead } : {};
      })(),
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
      // The owner's three, as the Eat tab draws them under its macro bars.
      // Omitted on a day with no meals. See todayKeyMicrosPayload.
      ...(() => {
        const keyMicros = todayKeyMicrosPayload(db, date, meals);
        return keyMicros ? { keyMicros } : {};
      })(),
      // The two SETTINGS the day is judged by that no other field carries, and
      // both were blind spots of the `nutritionTargets` class: the Home
      // nutrition pillar grades an over-target day as a fault while cutting and
      // as the point while gaining (home/readiness.ts `kcalLevel`), and the
      // water screen shows no denominator at all until a goal exists. Payload,
      // so neither costs the schema budget anything.
      //
      // `waterTarget` is `null` rather than omitted, exactly as
      // `nutritionTargets.set: false` is explicit: unset is a setting the user
      // has not chosen, never a feature ARC lacks. It is reported in the user's
      // Settings › Units volume, like every other value here.
      goalDirection: getGoalDirection(db),
      waterTarget: ((): { value: number; unit: string } | null => {
        const ml = getWaterTarget(db);
        if (ml === null) return null;
        const display = resolveDisplay(metricByKey('water')!, units);
        return { value: roundTo(display.fromCanonical(ml), display.decimals), unit: display.unit };
      })(),
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
        note: inventory.every((row) => row.metricType === SCREEN_TIME_METRIC)
          ? 'No wearable data on this device at all — Apple Health has never synced (Settings › Apple Health).'
          : syncedTodayCount === 0
            ? 'Nothing synced for today yet — Apple Health may not have run since midnight. Say so; do not report zeros.'
            : `Apple Health IS connected and HAS synced today: ${syncedTodayCount} metric(s) in \`today\` carry real values — report them as fact. Names in \`noDataToday\` are missing for TODAY only and say nothing about the rest; names in \`neverRecorded\` have no sensor on this device at all.`,
      },
      // Screen time (2026-09-25, docs/screen-time.md) — the day's total the
      // owner typed or a Shortcut sent. Its OWN field, not only a
      // `wearables.today` entry, because the number is usually filed the
      // morning after: today has none at breakfast, and yesterday's is the
      // one worth having. So: the latest day on record if it is yesterday or
      // today, with its date and where it came from; `partial` when it is
      // today's, which is a so-far figure. Omitted otherwise, like `ahead`;
      // older days are one get_metric_series('screen_time') away.
      //
      // TOKEN DELTA: zero. Payload only — no description or schema moved, so
      // neither ceiling in db/coach-eval.test.mjs §6 does.
      ...(() => {
        const latest = latestScreenTime(db, date);
        if (!latest || latest.date < shiftISODate(date, -1)) return {};
        return {
          screenTime: {
            date: latest.date,
            value: latest.minutes,
            unit: 'min',
            hm: formatDuration(latest.minutes),
            source: latest.via === 'shortcuts' ? 'Shortcuts automation' : 'typed by the user',
            ...(latest.date === date ? { partial: true } : {}),
          },
        };
      })(),
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
      // TRIMMED BY C14, third of the three payments for retire_knowledge_entry.
      // Its description was "A body metric or a wearable metric_type;
      // get_today_snapshot.wearables.availableMetrics lists this device's set."
      // The first clause is the tool description's own first clause, six words
      // later and less specific (that one NAMES the three body metrics). The
      // second offered a discovery path the tool description already beats:
      // "an unknown name errors WITH the valid set" costs no extra call and
      // arrives exactly when the model needs it, whereas availableMetrics is a
      // second round trip to learn the same thing.
      metric: { type: 'string' },
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
        ? accumulatedSeries(db, metricType, since)
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
            ? metricType === 'workout'
              ? 'daily sum of Apple Health sessions NOT also logged in ARC (those are in get_training_summary)'
              : 'daily sum of every logged row'
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
    // "(default 28)" is gone from here: the `days` property one line below says
    // "Window, default 28." verbatim. Textbook fact-then-restatement, and the
    // cheapest half of what the away sentence costs.
    'Training over the last N days: per-day sessions/minutes, average weekly ' +
    'rates over that rolling window, the most recent sessions, and `thisWeek` — the current ' +
    'Monday-start calendar week. Call this for anything about workouts, training load, ' +
    'consistency, or recovery context. ' +
    // The owner's actual ask in C13 — *"ARC can adjust intelligently"* — and it
    // needs no arithmetic at all, only this sentence. Without it the Coach
    // reads a travel week's lighter loads as a decline and says so, which is
    // the complaint the whole feature exists to answer.
    '`away: true` means a different gym — those loads are not comparable, so never ' +
    'call them a regression.',
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
    const recent = db.all<{
      id: string;
      date: string;
      movements: string | null;
      kind: string;
      duration_min: number | null;
      set_seconds: number | null;
      set_metres: number | null;
      away: 0 | 1;
    }>(
      // The two roll-ups are B1's (0046): a session whose sets carry a clock
      // and a distance has content the movement names alone cannot report —
      // "Treadmill Run" says nothing about whether it was 3 km or 15. Summed
      // over the session's working sets, which is what "how far did I run on
      // Tuesday" means when a run is logged as intervals.
      // `w.id` is selected but never emitted: it is the join key for the
      // ingest link (0054), read for the whole page in one statement below
      // rather than the N+1 this layer refuses.
      `SELECT w.id, w.date, w.kind, w.duration_min, w.away,
                (SELECT group_concat(DISTINCT s.exercise) FROM workout_sets s
                  WHERE s.workout_id = w.id AND s.set_type != 'warmup') AS movements,
                (SELECT sum(s.duration_sec) FROM workout_sets s
                  WHERE s.workout_id = w.id AND s.set_type != 'warmup') AS set_seconds,
                (SELECT sum(s.distance_m) FROM workout_sets s
                  WHERE s.workout_id = w.id AND s.set_type != 'warmup') AS set_metres
         FROM workouts w
         WHERE w.date >= ? ORDER BY w.date DESC, w.created_at DESC LIMIT 10`,
      [since]
    );
    // The watch's record of these same sessions, one statement for the page.
    const pairs = pairedIngestForMany(
      db,
      recent.map((w) => w.id)
    );
    const recentSessions = recent.map((w) => {
      const pair = pairs.get(w.id);
      return {
        date: w.date,
        kind: w.kind,
        duration_min: w.duration_min,
        movements: (w.movements ?? '').split(',').filter((m) => m.trim() !== ''),
        // Omitted rather than nulled: most sessions are lifts, and ten sessions
        // each carrying two explicit nulls is twenty tokens of "no".
        ...(w.set_seconds != null ? { setSeconds: Math.round(w.set_seconds) } : {}),
        ...(w.set_metres != null ? { setMetres: Math.round(w.set_metres) } : {}),
        // 0055, and omitted rather than nulled for the same reason as the two
        // above: almost every session is at the usual gym, and ten rows each
        // carrying `"away": false` is twenty tokens of "no". Result fields cost
        // nothing against the schema budget — this is payload, not schema.
        ...(w.away === 1 ? { away: true } : {}),
        // What the watch measured (docs §15). Omitted on the same rule, and
        // deliberately UNEXPLAINED in the tool description: the fields are
        // self-describing, and the judgment — what 142 means for this person at
        // this load — belongs in the model, not in a sentence pre-empting it.
        // The turn context carries the owner's age when a birth date is set and
        // says "profile not filled in" when it is not, so the model knows to
        // ask rather than assume.
        ...(pair?.avgHr != null && pair.maxHr != null
          ? { hr: { avg: pair.avgHr, max: pair.maxHr } }
          : {}),
        // HOW the watch's record was matched to this session, and only when the
        // answer is the weak one (2026-09-21). A span pair shares a clock and
        // needs no caveat; a DAY pair was made from the date and a close
        // duration because the log carried no start time, so the model should
        // hold the calories and heart rate on this row a little more loosely.
        // Omitted otherwise, the rule this payload applies throughout.
        ...(pair?.pairedBy === 'day' ? { watchPairedBy: 'same day' } : {}),
      };
    });

    // Apple Health sessions with NO ARC log (0054). Same cap as recentSessions
    // — ten is what a model can use; a hundred is a bill.
    const ingested = unpairedIngestedSessions(db, since, 10);

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
      recentSessions,
      // The other half of the 0054 de-duplication. `totals` and `recentSessions`
      // above come from `workouts` — the sessions the owner logged. These are
      // the ones ONLY the watch knows about: real training, with no sets and no
      // ARC row, and deliberately not folded into the totals above (a HealthKit
      // session has no `kind`, so adding its minutes to `cardioMinutes` would be
      // a guess). A session recorded by BOTH is absent here and present above,
      // exactly once — which is the whole point of the pairing.
      //
      // Omitted entirely when there are none, which is the common case on a
      // device with no watch: an empty array is a sentence the model has to read
      // to learn nothing.
      ...(ingested.length > 0
        ? {
            ingestedSessions: ingested.map((s) => ({
              date: s.date,
              activity: s.activity ?? 'Workout',
              minutes: round1(s.durationMin),
              source: deviceLabel(s.sourceDevice),
              ...(s.kcal != null ? { kcal: Math.round(s.kcal) } : {}),
              ...(s.distanceKm != null ? { km: round1(s.distanceKm) } : {}),
              ...(s.avgHr != null && s.maxHr != null ? { hr: { avg: s.avgHr, max: s.maxHr } } : {}),
            })),
            ingestedNote:
              'Apple Health sessions with no ARC log — already EXCLUDED from totals and ' +
              'recentSessions above, so never add them to those numbers.',
          }
        : {}),
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
  // ## The recurring rail lives HERE now, not in a tool description
  //
  // `complete_reminder` carried it — "recurring reminders cannot be completed;
  // use dismiss_reminder only to END it" — and that tool folded into
  // `edit_record` on 2026-09-19. A generic tool's description cannot hold
  // domain prose without becoming a second copy of the registry, and the system
  // prompt has single-digit headroom, so the rail rides the payload that hands
  // out the ids instead. This read always precedes the write: the id comes from
  // here.
  //
  // Emitted only when it is TRUE of this device — a user with no recurring
  // reminder pays nothing to be told a rule about them — which is the
  // `get_screenings` precedent for a conditional result field. Result fields
  // are not in the ceiling budget; descriptions are. The belt is the card-time
  // throw in the reminders domain, so a model that skips the read meets a
  // refusal rather than an approved write.
  execute: (db, _input, context) => {
    const today = todayISODate(context.now);
    const reminders = listActiveReminders(db);
    return json({
      reminders: reminders.map((r) => ({
        id: r.id,
        title: r.title,
        time: r.time,
        date: r.date,
        repeat: r.repeat,
        createdBy: r.created_by,
        dueToday: isDueOn(r, today),
      })),
      ...(reminders.some((r) => r.repeat !== 'once') ? { note: RECURRING_REMINDER_NOTE } : {}),
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
  //
  // ## `notes` is here because leaving it out was DESTRUCTIVE (2026-09-19)
  //
  // `update_protocol` is a complete replacement — "anything you omit is
  // DROPPED", stated once in the system prompt — and it takes each item's
  // `notes` from the call or writes null. This tool did not emit `notes`, so
  // every Coach edit re-sent every item without a field the model had never
  // seen, and **every rationale line in the protocol was silently erased**.
  // That is the `why` the generator stamps on each mission row and the italic
  // line Home's hero prints: a dose tweak the user approved wiped the reasons
  // off his whole stack, with nothing on screen to say so.
  //
  // Emitting it is the entire fix, and it costs the schema budget nothing. The
  // model now re-sends a note exactly as it re-sends a dose, the complete-set
  // sentence becomes TRUE for this field, and a deliberate rewording becomes
  // possible — which inheriting the note by id (the shape `remind` uses) would
  // have made impossible. `remind`'s exception is justified BY its invisibility
  // to the model; emitting `notes` removes that justification here.
  //
  // `carryOver`, `checkoffMode` and `startedOn` join it for the adjacent
  // reason: they are what a protocol's plan MEANS — whether a miss is still
  // owed tomorrow, whether an every-N clock re-bases on when it was done, and
  // where the phase clock is anchored — and the model was answering questions
  // about all three blind. Each is OMITTED at its default, so a device running
  // the defaults carries no "no": three fields × six protocols of nothing.
  //
  // What is deliberately NOT emitted: a per-item `nextOn`. It is ~9 tokens ×
  // every item × every call for a figure the model can derive from the cadence,
  // `startedOn` and `checkoffMode` — which it now has. Judgment stays in the
  // model rather than being precomputed into its context.
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
          // Omitted at their defaults — carry off, strict clock, no anchor —
          // so a device that has never touched them pays nothing to say so.
          ...(p.carryOver ? { carryOver: true } : {}),
          ...(p.checkoffMode === 'strict' ? {} : { checkoffMode: p.checkoffMode }),
          ...(p.startedOn ? { startedOn: p.startedOn } : {}),
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
              // Omitted when empty rather than nulled, so a protocol with no
              // rationale lines carries no "no" on every item of every call.
              ...(item.notes ? { notes: item.notes } : {}),
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
    'concluded ones with their verdicts. Call before closing one (you need the id), or when ' +
    'the user asks how an experiment is going.',
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
    // The abandon-not-conclude rail, moved out of `abandon_experiment`'s
    // description when that tool folded into `edit_record` — see the same
    // argument on `list_reminders` above. Emitted only when there is a running
    // experiment the rule could apply to.
    return json({
      active,
      ...(completed ? { completed } : {}),
      ...(active.length > 0 ? { note: EXPERIMENT_ABANDON_NOTE } : {}),
    });
  },
};

// --- get_training_recommendation ----------------------------------------------

const getTrainingRecommendation: CoachTool = {
  name: 'get_training_recommendation',
  description:
    // TRIMMED 2026-09-14 (C13), and it is the `log_workout.name` class again: a
    // description advertising a fact the app no longer has. "program week (and
    // whether it is a deload)" named a `recommendation.program` field that
    // CANNOT appear — programs were retired on 2026-08-11, the recommender's
    // schedule branch was deleted, and `buildRecommendation` contains no
    // mention of a program. (The dormant type arm and the guarded spread in
    // `execute` stay, per the note in exercise/types.ts; what goes is the
    // promise, because a model told to expect a field that never arrives reads
    // its absence as a fact about the user's training.) Pays for the away-gym
    // sentence on get_training_summary above.
    "The training engine's computed state and today's recommended session: per-muscle " +
    'freshness, weekly volume vs MEV/MAV/MRV landmarks, and per-exercise progression ' +
    'targets. Call it before advising on training, programming, or progression. It ' +
    'reports numbers; it does not decide.',
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

    // What each target weight COUNTS (0062) — a 22.5 kg dumbbell-press target
    // is one dumbbell. Payload, not schema, so it costs the §6 ceilings nothing;
    // omitted on a movement that records no load.
    const bases = exerciseLoadBases(
      db,
      'exercises' in recommendation ? recommendation.exercises.map((e) => e.exerciseId) : []
    );
    const exercises =
      'exercises' in recommendation
        ? recommendation.exercises.map((e) => ({
            name: e.name,
            freshness: e.freshness,
            sets: e.targetSets ?? null,
            ...(bases.get(e.exerciseId) != null ? { loadBasis: bases.get(e.exerciseId) } : {}),
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
    'bloodwork timing, or any question about check-ups, scans and doctor visits.',
  // TRIMMED BY C14 to pay for retire_knowledge_entry. The cut sentence — "An
  // empty ledger means the user has tracked none — ARC does track them (Data ›
  // Screenings); never report the feature as missing" — is stated AT RUNTIME by
  // the payload itself, in the exact and only case where it is true: `execute`
  // below emits `emptyNote` with that instruction, in those words, when both
  // lists come back empty. Billing it on every request about screenings the
  // user DOES track is the same duplication the 2026-08-11 get_metric_series
  // and get_today_snapshot trims removed.
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
