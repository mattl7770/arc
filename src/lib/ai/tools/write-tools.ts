/**
 * The Coach's write tools — logging on the user's behalf and managing
 * reminders (docs/ai-coach.md, "Tool set"). None are readOnly, so the service
 * layer surfaces EVERY call here to the user for confirmation before execute
 * runs; `confirmSummary` is the one line the confirmation card shows, and it
 * must carry everything consequential about the write — what, how much, and
 * (when not today) which day — so the user never approves blind.
 *
 * Each wraps an existing repository write — the same code paths the capture
 * screens use — so a Coach-logged meal is indistinguishable from a hand-logged
 * one downstream. Values arrive in the user's display units (weight in lb)
 * unless a unit is named; conversion to canonical happens HERE via the metric
 * registry / exercise helpers, exactly like the keypad — the model is never
 * trusted to convert units itself.
 *
 * Every log tool takes an optional "YYYY-MM-DD" `date` for backdating
 * ("yesterday I did 40 min zone 2"); omitted means today. The confirmation
 * line shows a backdate explicitly.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import { logCapture, logMetric, logNote } from '@/lib/db/repositories/logs';
import { logWorkout } from '@/lib/db/repositories/exercise';
import { logMeal } from '@/lib/db/repositories/nutrition';
import {
  completeReminder,
  createReminder,
  dismissReminder,
  listActiveReminders,
} from '@/lib/db/repositories/reminders';
import { logSymptom } from '@/lib/db/repositories/symptoms';
import { kgToLb, lbToKg, setLine } from '@/lib/exercise/format';
import { isLoggableCanonical, metricByKey, roundDisplay, type MetricKey } from '@/lib/log/metrics';
import type { SetInput, WorkoutKind } from '@/lib/exercise/types';

import {
  asRecord,
  optDate,
  optEnum,
  optNumber,
  optString,
  optTime,
  reqEnum,
  reqNumber,
  reqString,
  type CoachTool,
} from './types';

const json = (value: unknown): string => JSON.stringify(value);

/** The local day a log lands on: an explicit backdate, else today. */
function logDate(args: Record<string, unknown>, now: Date): string {
  return optDate(args, 'date') ?? todayISODate(now);
}

/** " · 2026-07-25" when the write is backdated; empty for today. */
function dateSuffix(args: Record<string, unknown>): string {
  const date = optDate(args, 'date');
  return date ? ` · ${date}` : '';
}

/** The shared optional-date schema property for log tools. */
const DATE_PROPERTY = {
  date: {
    type: 'string',
    description:
      '"YYYY-MM-DD" — pass when the user reports a PAST event ("yesterday…"); omit for today.',
  },
} as const;

// --- log_metric --------------------------------------------------------------

const METRIC_KEYS = ['weight', 'body_fat', 'waist', 'hrv', 'rhr', 'water'] as const;

/** Validated input → canonical value + display string, shared by summary/execute. */
function parseMetricInput(input: Record<string, unknown>): {
  key: MetricKey;
  canonical: number;
  display: string;
} {
  const args = asRecord(input);
  const key = reqEnum(args, 'metric', METRIC_KEYS);
  const value = reqNumber(args, 'value');
  const unit = optString(args, 'unit')?.toLowerCase();
  const metric = metricByKey(key)!;

  let canonical: number;
  if (unit !== undefined) {
    const convert = metric.units?.[unit];
    if (!convert) {
      throw new Error(
        `"unit" ${unit} is not valid for ${key}; use ${Object.keys(metric.units ?? {}).join('/') || metric.displayUnit}.`
      );
    }
    canonical = convert(value);
  } else {
    canonical = metric.toCanonical(value);
  }
  if (!isLoggableCanonical(metric, canonical)) {
    throw new Error(`${key} value out of loggable range.`);
  }
  const display = `${roundDisplay(metric, metric.fromCanonical(canonical))} ${metric.displayUnit}`;
  return { key, canonical, display };
}

const logMetricTool: CoachTool = {
  name: 'log_metric',
  description:
    'Log one body/vital measurement: weight, body_fat, waist, hrv, rhr, or water. ' +
    "Value is in the metric's display unit (weight lb, waist in, water oz, hrv ms, " +
    'rhr bpm, body_fat %) unless "unit" names another (kg, cm, ml, l…). Use when the ' +
    'user states a measurement ("weight was 178 this morning").',
  inputSchema: {
    type: 'object',
    properties: {
      metric: { type: 'string', enum: [...METRIC_KEYS] },
      value: { type: 'number' },
      unit: { type: 'string', description: 'Optional explicit unit token, e.g. "kg".' },
      ...DATE_PROPERTY,
    },
    required: ['metric', 'value'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input) => {
    const { key, display } = parseMetricInput(input);
    return `Log ${metricByKey(key)!.label.toLowerCase()} ${display}${dateSuffix(asRecord(input))}`;
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const { key, canonical, display } = parseMetricInput(input);
    logMetric(db, logDate(args, context.now), key, canonical);
    return json({ logged: true, metric: key, value: display });
  },
};

// --- log_meal ----------------------------------------------------------------

const logMealTool: CoachTool = {
  name: 'log_meal',
  description:
    'Log an eaten meal with optional macros (kcal, protein_g, carbs_g, fat_g) and ' +
    'wall-clock time. Use when the user describes food they ate; estimate macros only ' +
    'if asked, and say so.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'e.g. "Salmon, rice, broccoli"' },
      time: { type: 'string', description: '24h "HH:MM", omit if unknown.' },
      kcal: { type: 'number', minimum: 0 },
      protein_g: { type: 'number', minimum: 0 },
      carbs_g: { type: 'number', minimum: 0 },
      fat_g: { type: 'number', minimum: 0 },
      notes: { type: 'string' },
      ...DATE_PROPERTY,
    },
    required: ['name'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input) => {
    const args = asRecord(input);
    const name = reqString(args, 'name');
    // Everything consequential goes on the card — approving writes ALL of it.
    const macros = [
      ['kcal', optNumber(args, 'kcal'), 'kcal'],
      ['protein', optNumber(args, 'protein_g'), 'g protein'],
      ['carbs', optNumber(args, 'carbs_g'), 'g carbs'],
      ['fat', optNumber(args, 'fat_g'), 'g fat'],
    ]
      .filter(([, value]) => value != null)
      .map(([, value, unit]) => `${Math.round(value as number)} ${unit}`)
      .join(', ');
    return `Log meal "${name}"${macros ? ` · ${macros}` : ''}${dateSuffix(args)}`;
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const id = logMeal(db, {
      date: logDate(args, context.now),
      time: optTime(args, 'time') ?? null,
      name: reqString(args, 'name'),
      kcal: optNumber(args, 'kcal') ?? null,
      protein_g: optNumber(args, 'protein_g') ?? null,
      carbs_g: optNumber(args, 'carbs_g') ?? null,
      fat_g: optNumber(args, 'fat_g') ?? null,
      notes: optString(args, 'notes') ?? null,
    });
    return json({ logged: true, id });
  },
};

// --- log_workout -------------------------------------------------------------

const WORKOUT_KINDS: readonly WorkoutKind[] = ['strength', 'cardio', 'mobility', 'other'];
const SET_UNITS = ['lb', 'kg'] as const;

type ParsedSet = SetInput & { displayLine: string };

/**
 * Sets arrive in DISPLAY units (lb by default, like everything the user says
 * out loud); conversion to canonical kg happens here, never in the model.
 */
function parseSets(input: Record<string, unknown>): ParsedSet[] {
  const raw = input['sets'];
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('"sets" must be an array.');
  return raw.map((entry) => {
    const set = asRecord(entry);
    const exercise = reqString(set, 'exercise');
    const reps = optNumber(set, 'reps') ?? null;
    const weight = optNumber(set, 'weight') ?? null;
    const unit = optEnum(set, 'unit', SET_UNITS) ?? 'lb';
    const weightKg = weight == null ? null : unit === 'kg' ? weight : lbToKg(weight);
    const weightLb = weightKg == null ? null : Math.round(kgToLb(weightKg) * 10) / 10;
    return { exercise, reps, weightKg, displayLine: `${exercise} ${setLine(reps, weightLb)}` };
  });
}

const logWorkoutTool: CoachTool = {
  name: 'log_workout',
  description:
    'Log a training session: name, kind (strength/cardio/mobility/other), duration in ' +
    'minutes, and optional strength sets [{exercise, reps, weight, unit}] — set weight ' +
    'is in lb unless unit is "kg"; pass it exactly as the user said it. Use when the ' +
    'user reports a workout.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'e.g. "Upper A", "Zone 2 ride"' },
      kind: { type: 'string', enum: [...WORKOUT_KINDS] },
      duration_min: { type: 'number', minimum: 0 },
      notes: { type: 'string' },
      sets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            exercise: { type: 'string' },
            reps: { type: 'number', minimum: 0 },
            weight: { type: 'number', minimum: 0, description: 'In `unit` (default lb).' },
            unit: { type: 'string', enum: [...SET_UNITS] },
          },
          required: ['exercise'],
          additionalProperties: false,
        },
      },
      ...DATE_PROPERTY,
    },
    required: ['name', 'kind'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input) => {
    const args = asRecord(input);
    const name = reqString(args, 'name');
    const duration = optNumber(args, 'duration_min');
    const sets = parseSets(args);
    const parts = [
      `Log workout "${name}"`,
      ...(duration != null ? [`${Math.round(duration)} min`] : []),
      ...sets.map((s) => s.displayLine),
    ];
    return parts.join(' · ') + dateSuffix(args);
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const id = logWorkout(
      db,
      {
        date: logDate(args, context.now),
        name: reqString(args, 'name'),
        kind: reqEnum(args, 'kind', WORKOUT_KINDS),
        durationMin: optNumber(args, 'duration_min') ?? null,
        notes: optString(args, 'notes') ?? null,
      },
      parseSets(args).map(({ exercise, reps, weightKg }) => ({ exercise, reps, weightKg }))
    );
    return json({ logged: true, id });
  },
};

// --- log_symptom -------------------------------------------------------------

const logSymptomTool: CoachTool = {
  name: 'log_symptom',
  description:
    'Log a symptom (headache, brain fog, GI, pain…) with optional 1–10 severity, body ' +
    'area, time, and note. Use when the user reports feeling off.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      severity: { type: 'integer', minimum: 1, maximum: 10 },
      body_area: { type: 'string' },
      time: { type: 'string', description: '24h "HH:MM", omit if unknown.' },
      notes: { type: 'string' },
      ...DATE_PROPERTY,
    },
    required: ['name'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input) => {
    const args = asRecord(input);
    const name = reqString(args, 'name');
    const severity = optNumber(args, 'severity');
    return `Log symptom "${name}"${severity != null ? ` · ${severity}/10` : ''}${dateSuffix(args)}`;
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const severity = optNumber(args, 'severity');
    if (severity !== undefined && (!Number.isInteger(severity) || severity < 1 || severity > 10)) {
      throw new Error('"severity" must be an integer from 1 to 10.');
    }
    const id = logSymptom(db, {
      date: logDate(args, context.now),
      time: optTime(args, 'time') ?? null,
      name: reqString(args, 'name'),
      severity: severity ?? null,
      bodyArea: optString(args, 'body_area') ?? null,
      notes: optString(args, 'notes') ?? null,
    });
    return json({ logged: true, id });
  },
};

// --- log_capture (supplement / medication / therapy) -------------------------

const CAPTURE_TYPES = ['supplement', 'medication', 'therapy'] as const;

const logCaptureTool: CoachTool = {
  name: 'log_capture',
  description:
    'Log a supplement, medication, or therapy taken/done, as one display line — e.g. ' +
    '"Creatine · 5 g", "Sauna · 20 min". Use when the user says they took or did one.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [...CAPTURE_TYPES] },
      title: { type: 'string', description: 'Display line, e.g. "Magnesium · 400 mg".' },
      ...DATE_PROPERTY,
    },
    required: ['type', 'title'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input) => {
    const args = asRecord(input);
    return `Log ${reqEnum(args, 'type', CAPTURE_TYPES)}: ${reqString(args, 'title')}${dateSuffix(args)}`;
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const id = logCapture(
      db,
      logDate(args, context.now),
      reqEnum(args, 'type', CAPTURE_TYPES),
      reqString(args, 'title')
    );
    return json({ logged: true, id });
  },
};

// --- log_note ----------------------------------------------------------------

const logNoteTool: CoachTool = {
  name: 'log_note',
  description:
    'Save a free-text note to the day\'s log ("slept badly, 3am wake"). Use when the ' +
    'user says something worth remembering that fits no structured tool.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' }, ...DATE_PROPERTY },
    required: ['text'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input) => {
    const args = asRecord(input);
    return `Save note: "${reqString(args, 'text')}"${dateSuffix(args)}`;
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const id = logNote(db, logDate(args, context.now), reqString(args, 'text'));
    return json({ logged: true, id });
  },
};

// --- set_reminder ------------------------------------------------------------

const REPEATS = ['once', 'daily', 'weekly'] as const;

const setReminderTool: CoachTool = {
  name: 'set_reminder',
  description:
    'Create a reminder that surfaces in the app: title, optional 24h "HH:MM" time, ' +
    'optional "YYYY-MM-DD" date (one-offs: the day it applies; weekly: the anchor ' +
    'weekday), repeat once/daily/weekly. Use when the user asks to be reminded, or ' +
    'propose one yourself when a logging gap warrants a nudge. Check list_reminders ' +
    'first to avoid duplicates. Note: in-app surfacing only — OS push notifications ' +
    'are not wired yet; say so if the user expects a phone alert.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Imperative, e.g. "Take magnesium".' },
      time: { type: 'string', description: '24h "HH:MM".' },
      date: { type: 'string', description: '"YYYY-MM-DD".' },
      repeat: { type: 'string', enum: [...REPEATS] },
      notes: { type: 'string' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input) => {
    const args = asRecord(input);
    const title = reqString(args, 'title');
    const time = optTime(args, 'time');
    const repeat = optEnum(args, 'repeat', REPEATS) ?? 'once';
    const cadence = repeat === 'once' ? '' : ` · ${repeat}`;
    return `Set reminder "${title}"${time ? ` at ${time}` : ''}${cadence}${dateSuffix(args)}`;
  },
  execute: (db, input) => {
    const args = asRecord(input);
    const repeat = optEnum(args, 'repeat', REPEATS) ?? 'once';
    const date = optDate(args, 'date');
    if (repeat === 'weekly' && date === undefined) {
      throw new Error('A weekly reminder needs a "date" anchoring its weekday.');
    }
    const id = createReminder(db, {
      title: reqString(args, 'title'),
      time: optTime(args, 'time') ?? null,
      date: date ?? null,
      repeat,
      createdBy: 'ai',
      notes: optString(args, 'notes') ?? null,
    });
    return json({ created: true, id });
  },
};

// --- complete_reminder / dismiss_reminder ------------------------------------

function requireActiveReminder(db: Database, id: string) {
  const match = listActiveReminders(db).find((r) => r.id === id);
  if (!match) throw new Error(`No active reminder with id ${id}. Call list_reminders first.`);
  return match;
}

const completeReminderTool: CoachTool = {
  name: 'complete_reminder',
  description:
    'Mark an active ONE-OFF reminder done (the user did the thing). Get the id from ' +
    'list_reminders. Recurring (daily/weekly) reminders cannot be completed — doing a ' +
    'recurring one today needs no write at all; use dismiss_reminder only to END it.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  readOnly: false,
  // The card must name what a model-chosen id actually points at.
  confirmSummary: (input, db) =>
    `Mark reminder "${requireActiveReminder(db, reqString(asRecord(input), 'id')).title}" done`,
  execute: (db, input) => {
    const id = reqString(asRecord(input), 'id');
    const reminder = requireActiveReminder(db, id);
    if (reminder.repeat !== 'once') {
      throw new Error(
        `"${reminder.title}" repeats ${reminder.repeat} — completing would end it permanently. ` +
          'Nothing to write for today; use dismiss_reminder only if the user wants it gone.'
      );
    }
    completeReminder(db, id);
    return json({ completed: true, id, title: reminder.title });
  },
};

const dismissReminderTool: CoachTool = {
  name: 'dismiss_reminder',
  description:
    'Turn a reminder off permanently (the way a daily/weekly one ends, or a one-off is ' +
    'cancelled). Get the id from list_reminders. Use when the user asks to stop it.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db) =>
    `Dismiss reminder "${requireActiveReminder(db, reqString(asRecord(input), 'id')).title}"`,
  execute: (db, input) => {
    const id = reqString(asRecord(input), 'id');
    const reminder = requireActiveReminder(db, id);
    dismissReminder(db, id);
    return json({ dismissed: true, id, title: reminder.title });
  },
};

export const WRITE_TOOLS: CoachTool[] = [
  logMetricTool,
  logMealTool,
  logWorkoutTool,
  logSymptomTool,
  logCaptureTool,
  logNoteTool,
  setReminderTool,
  completeReminderTool,
  dismissReminderTool,
];
