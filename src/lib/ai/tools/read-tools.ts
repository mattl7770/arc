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
import { weekSummary } from '@/lib/db/repositories/exercise';
import { listTodayMeals, todayTotals } from '@/lib/db/repositories/nutrition';
import { getCurrentVersion, listProtocols } from '@/lib/db/repositories/protocols';
import { isDueOn, listActiveReminders } from '@/lib/db/repositories/reminders';
import { listTodaySymptoms } from '@/lib/db/repositories/symptoms';
import { getPreferences } from '@/lib/db/repositories/user';
import { metricByKey, resolveDisplay, type MetricKey } from '@/lib/log/metrics';
import { parseProtocolContent } from '@/lib/protocols/content';
import type { BiomarkerRow } from '@/lib/db/types';

import { computeInsights, generateDailyBrief } from '../insights';
import {
  bodyDailySeries,
  isoDaysAgo,
  nutritionDailyTotals,
  round1,
  seriesStats,
  trainingDailyTotals,
  wearableDailySeries,
  type SeriesPoint,
} from '../series';
import { retrievePassages } from '@/lib/rag/retrieve';
import { asRecord, daysWindow, optEnum, optString, reqString, type CoachTool } from './types';

const json = (value: unknown): string => JSON.stringify(value);

// --- get_today_snapshot ------------------------------------------------------

const getTodaySnapshot: CoachTool = {
  name: 'get_today_snapshot',
  description:
    "Today's full picture: mission items with status, meals eaten with macro totals, " +
    'workouts, symptoms, ad-hoc captures, and reminders due today. Call this before ' +
    "answering anything about today ('how am I doing', 'what's left', 'what did I eat').",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  execute: (db, _input, context) => {
    const date = todayISODate(context.now);
    const meals = listTodayMeals(db, date);
    const totals = todayTotals(db, date);
    const workouts = db.all<{
      name: string;
      kind: string;
      duration_min: number | null;
    }>('SELECT name, kind, duration_min FROM workouts WHERE date = ? ORDER BY created_at', [date]);

    return json({
      date,
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
      remindersDueToday: listActiveReminders(db)
        .filter((r) => isDueOn(r, date))
        .map((r) => ({ id: r.id, title: r.title, time: r.time, repeat: r.repeat })),
    });
  },
};

// --- get_metric_series -------------------------------------------------------

const SERIES_METRICS = ['weight', 'body_fat', 'waist', 'hrv', 'rhr', 'water'] as const;
type SeriesMetric = (typeof SERIES_METRICS)[number];

function loadSeries(db: Database, metric: SeriesMetric, since: string): SeriesPoint[] {
  const descriptor = metricByKey(metric)!;
  const target = descriptor.target;
  if (target.kind === 'body') return bodyDailySeries(db, target.column, since);
  if (target.kind === 'wearable') {
    return wearableDailySeries(db, target.metricType, since, metric === 'water' ? 'sum' : 'avg');
  }
  return [];
}

const getMetricSeries: CoachTool = {
  name: 'get_metric_series',
  description:
    'Daily history for one metric (weight, body_fat, waist, hrv, rhr, water) over the ' +
    'last N days, in display units, with min/avg/max. Call this whenever the user asks ' +
    'about a trend, a change, or "how has X been" — answer from these numbers only.',
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
    const descriptor = metricByKey(metric as MetricKey)!;
    // Report in the user's chosen unit (Settings › Units), matching what the app
    // shows and what the write path stores — the Coach must never cite lb to a
    // kg user. resolveDisplay is identity for the unit-less metrics.
    const spec = resolveDisplay(descriptor, getPreferences(db).units);

    const points = loadSeries(db, metric, isoDaysAgo(context.now, days - 1)).map((p) => ({
      date: p.date,
      value: round1(spec.fromCanonical(p.value)),
    }));
    const stats = seriesStats(points);
    return json({
      metric,
      unit: spec.unit,
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
];
