/**
 * The Coach's read tools — every way the model can look at the user's real
 * data (docs/ai-coach.md, "Tool set"). All readOnly: the service layer runs
 * these without confirmation. Each returns compact JSON in the user's CHOSEN
 * display units where a display convention exists (weight in lb or kg per their
 * Settings preference), with the unit named so the model never guesses.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import { countActiveMemories, listMemories } from '@/lib/db/repositories/coach-memory';
import { biomarkerSeries } from '@/lib/db/repositories/labs';
import { listTodayEntries } from '@/lib/db/repositories/logs';
import { listMission } from '@/lib/db/repositories/mission';
import { getActiveMode } from '@/lib/db/repositories/day-modes';
import { activeExperiments, recentlyConcluded } from '@/lib/db/repositories/experiments';
import { weekSummary } from '@/lib/db/repositories/exercise';
import { listTodayMeals, todayTotals } from '@/lib/db/repositories/nutrition';
import { getCurrentVersion, listProtocols } from '@/lib/db/repositories/protocols';
import { isDueOn, listActiveReminders } from '@/lib/db/repositories/reminders';
import { listTodaySymptoms } from '@/lib/db/repositories/symptoms';
import { buildRecommendation } from '@/lib/db/repositories/training-recommend';
import { getOrCreateUser, getPreferences } from '@/lib/db/repositories/user';
import { dailyMetricSeries } from '@/lib/db/repositories/wearables';
import { deriveReadiness } from '@/lib/home/readiness';
import { metricByKey, resolveDisplay, type MetricKey } from '@/lib/log/metrics';
import { getModeDefinition } from '@/lib/modes/registry';
import { parseProtocolContent } from '@/lib/protocols/content';
import type { BiomarkerRow } from '@/lib/db/types';

import { ageOn } from '../turn-context';

import { computeInsights, generateDailyBrief } from '../insights';
import {
  bodyDailySeries,
  endOfLocalDayUtc,
  isoDaysAgo,
  nutritionDailyTotals,
  round1,
  seriesStats,
  trainingDailyTotals,
  wearableDailySeries,
  type SeriesPoint,
} from '../series';
import { retrievePassages } from '@/lib/rag/retrieve';
import { searchUserHistory } from '../history-search';
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

// --- get_today_snapshot ------------------------------------------------------

const getTodaySnapshot: CoachTool = {
  name: 'get_today_snapshot',
  description:
    "Today's full picture: readiness (the same verdict the Home screen shows), the day's " +
    'mode, mission items (with ids) and status, meals eaten with macro totals, workouts, ' +
    'symptoms, ad-hoc captures, reminders due today, running experiments, and the user ' +
    "profile. Call this before answering anything about today ('how am I doing', " +
    "'what's left', 'what did I eat').",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  execute: (db, _input, context) => {
    const date = todayISODate(context.now);
    const mode = getActiveMode(db, date);
    const modeDef = getModeDefinition(mode);
    const meals = listTodayMeals(db, date);
    const totals = todayTotals(db, date);
    const units = getPreferences(db).units;
    const user = getOrCreateUser(db);
    const workouts = db.all<{
      name: string;
      kind: string;
      duration_min: number | null;
    }>('SELECT name, kind, duration_min FROM workouts WHERE date = ? ORDER BY created_at', [date]);

    // The SAME derivation Home renders (src/lib/home/readiness.ts), so the
    // Coach and the Home card can never disagree about the morning's facts.
    // This reports state — whether/how to act on a "caution" morning is a
    // judgment call, weighed against program, cause, schedule, and the user.
    const readiness = deriveReadiness(db, date);

    return json({
      date,
      profile: {
        age: ageOn(user.date_of_birth, date),
        sex: user.biological_sex,
      },
      readiness: readiness.hasSignal
        ? {
            verdict: readiness.readiness.level,
            label: readiness.readiness.label,
            detail: readiness.readiness.detail,
            pillars: Object.fromEntries(
              readiness.pillars.map((p) => [p.label.toLowerCase(), p.level])
            ),
          }
        : { verdict: 'unknown', label: 'No recovery signal yet', detail: null, pillars: null },
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
      // Item ids ride along so mission-level tools (and the ones coming) can
      // address a specific row — the user still only ever sees titles.
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
      workouts,
      symptoms: listTodaySymptoms(db, date).map((s) => ({
        time: s.time,
        name: s.name,
        severity: s.severity,
      })),
      // The Log feed also lists symptoms; they're already reported (structured)
      // in `symptoms` above, so drop them here rather than double-counting.
      // Units passed through so capture titles honor the user's preference.
      captures: listTodayEntries(db, context.now, units)
        .filter((e) => e.category !== 'Symptom')
        .map((e) => ({
          time: e.time,
          title: e.title,
          category: e.category,
        })),
      remindersDueToday: listActiveReminders(db)
        .filter((r) => isDueOn(r, date))
        .map((r) => ({ id: r.id, title: r.title, time: r.time, repeat: r.repeat })),
      experiments: activeExperiments(db, date).map((e) => ({
        id: e.id,
        title: e.title,
        intervention: e.intervention,
        metrics: e.metrics,
        daysLeft: e.daysLeft,
        ready: e.ready,
      })),
    });
  },
};

// --- get_metric_series -------------------------------------------------------

const SERIES_METRICS = [
  'weight',
  'body_fat',
  'waist',
  'hrv',
  'rhr',
  'water',
  'sleep',
  'sleep_deep',
  'steps',
  'active_energy',
] as const;
type SeriesMetric = (typeof SERIES_METRICS)[number];

/**
 * Metrics read straight off `wearable_data` with a fixed unit — no registry
 * descriptor, no unit-preference conversion (minutes are minutes everywhere).
 * These are the ingested Apple Health series the Coach was blind to before
 * 2026-08-08 (readiness runs on sleep the model couldn't read; create_experiment
 * pitched sleep metrics no tool could return).
 *
 * These read through dailyMetricSeries — the wearables repo's SOURCE-ARBITRATED
 * one-winner-per-day pick — because it is the exact series Home's readiness and
 * metric strip consume. Sleep is one row per (night, device), so on a
 * dual-writer night (watch 450 min + ring 380 min) a pooled average would hand
 * the Coach a number (415) that no surface in the app shows; arbitration keeps
 * the Coach and Home citing the same 450. Steps/energy are already one
 * HK-merged row per day, so arbitration is a no-op there.
 */
const WEARABLE_DIRECT: Partial<
  Record<SeriesMetric, { metricType: string; unit: string; label: string }>
> = {
  sleep: { metricType: 'sleep_duration_min', unit: 'min', label: 'sleep duration' },
  sleep_deep: { metricType: 'sleep_deep_min', unit: 'min', label: 'deep sleep' },
  steps: { metricType: 'steps', unit: 'steps', label: 'steps' },
  active_energy: { metricType: 'active_energy_kcal', unit: 'kcal', label: 'active energy' },
};

function loadSeries(
  db: Database,
  metric: SeriesMetric,
  since: string,
  until: string,
  days: number,
  now: Date
): SeriesPoint[] {
  const direct = WEARABLE_DIRECT[metric];
  if (direct) {
    // Same window as [since, until]: dailyMetricSeries selects
    // date > until - days AND date <= until, and since = until - (days - 1).
    return dailyMetricSeries(db, direct.metricType, days, until).map((p) => ({
      date: p.date,
      value: p.value,
    }));
  }
  const descriptor = metricByKey(metric as MetricKey)!;
  const target = descriptor.target;
  // body_metrics is an INSTANT column — bound it at the end of the local day,
  // never with a date string (see bodyDailySeries).
  if (target.kind === 'body') {
    return bodyDailySeries(db, target.column, since, endOfLocalDayUtc(now));
  }
  if (target.kind === 'wearable') {
    return wearableDailySeries(
      db,
      target.metricType,
      since,
      metric === 'water' ? 'sum' : 'avg',
      until
    );
  }
  return [];
}

const getMetricSeries: CoachTool = {
  name: 'get_metric_series',
  description:
    'Daily history for one metric (weight, body_fat, waist, hrv, rhr, water, sleep ' +
    '[minutes asleep], sleep_deep [minutes], steps, active_energy [kcal]) over the last ' +
    'N days, in display units, with min/avg/max. Call this whenever the user asks about ' +
    'a trend, a change, or "how has X been" — and to read out an experiment watching ' +
    'sleep or activity — answer from these numbers only.',
  inputSchema: {
    type: 'object',
    properties: {
      metric: { type: 'string', enum: [...SERIES_METRICS] },
      days: { type: 'integer', minimum: 1, maximum: 365, description: 'Window, default 30.' },
    },
    required: ['metric'],
    additionalProperties: false,
  },
  readOnly: true,
  execute: (db, input, context) => {
    const args = asRecord(input);
    const metric = optEnum(args, 'metric', SERIES_METRICS);
    if (!metric) throw new Error(`"metric" must be one of: ${SERIES_METRICS.join(', ')}.`);
    const days = daysWindow(args, 30);
    const since = isoDaysAgo(context.now, days - 1);
    const today = todayISODate(context.now);

    const direct = WEARABLE_DIRECT[metric];
    // Registry metrics report in the user's chosen unit (Settings › Units),
    // matching what the app shows and what the write path stores — the Coach
    // must never cite lb to a kg user. Wearable-direct metrics have one fixed
    // unit (min/steps/kcal) and skip conversion entirely.
    const spec = direct
      ? null
      : resolveDisplay(metricByKey(metric as MetricKey)!, getPreferences(db).units);

    const points = loadSeries(db, metric, since, today, days, context.now).map((p) => ({
      date: p.date,
      value: round1(spec ? spec.fromCanonical(p.value) : p.value),
    }));
    const stats = seriesStats(points);
    return json({
      metric,
      unit: direct ? direct.unit : spec!.unit,
      days,
      points,
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
            },
    });
  },
};

// --- get_training_summary ----------------------------------------------------

const getTrainingSummary: CoachTool = {
  name: 'get_training_summary',
  description:
    'Training over the last N days (default 28): per-day sessions/minutes, average weekly ' +
    'cardio-minute and strength-session rates over that rolling window, and recent sessions. ' +
    '`thisWeek` is the CURRENT Monday-start calendar week — use it for "this week" questions; ' +
    'the rolling `totals`/`weeklyRates` are "the last N days", never "this week". Call it for ' +
    'anything about workouts, training load, or consistency.',
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
    const today = todayISODate(context.now);
    const daily = trainingDailyTotals(db, since, today);
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
       WHERE date >= ? AND date <= ? ORDER BY date DESC, created_at DESC LIMIT 10`,
      [since, today]
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
    const daily = nutritionDailyTotals(
      db,
      isoDaysAgo(context.now, days - 1),
      todayISODate(context.now)
    );
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
    const today = todayISODate(context.now);
    const rows = db.all<{
      date: string;
      time: string | null;
      name: string;
      severity: number | null;
      body_area: string | null;
    }>(
      `SELECT date, time, name, severity, body_area FROM symptoms
       WHERE date >= ? AND date <= ? ORDER BY date, (time IS NULL), time`,
      [since, today]
    );
    const counts = db.all<{ name: string; occurrences: number; avg_severity: number | null }>(
      `SELECT name, count(*) AS occurrences, avg(severity) AS avg_severity FROM symptoms
       WHERE date >= ? AND date <= ? GROUP BY name ORDER BY occurrences DESC, name`,
      [since, today]
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
          ? `Only the ${memories.length} most recent of ${total} are listed; use recall to search the rest by text.`
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
    "Keyword search over the user's own written history — past turns, day-log notes, protocol " +
    "change notes, experiment hypotheses and verdicts, your memories — AND ARC's curated " +
    'longevity reference. Use it to recall something specific ("have we tried magnesium?") and ' +
    'to ground an explanation in ARC doctrine rather than general knowledge ("why does ApoB ' +
    'matter?"). Literal matching, not semantic — try the user\'s own wording. Cite the source ' +
    'and date on every hit.',
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
  getTrainingRecommendation,
  getNutritionSummary,
  getSymptomHistory,
  getBiomarkers,
  getBiomarkerHistory,
  getProtocols,
  listRemindersTool,
  getInsights,
  getMemories,
  searchHistory,
  getExperiments,
];

/**
 * search_knowledge is deliberately NOT registered (2026-08-08).
 *
 * Its retrieval path cannot return a passage on any device: the embedder is a
 * hardcoded null pending an ONNX runtime and its own EAS build, and no corpus
 * has been ingested. Advertising it burned a round-trip per call to learn
 * "not available yet" and taught the model to distrust the registry — exactly
 * what stubs.ts warns about. `search_history` covers recall over the user's
 * own words today; this graduates back into READ_TOOLS when the embedder and
 * a corpus actually ship (docs/coach-intelligence-review.md §4 Phase 6).
 */
export const UNREGISTERED_READ_TOOLS: CoachTool[] = [searchKnowledge];
