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
 * one downstream. Values arrive in the user's CHOSEN display units (their
 * Settings preference — lb or kg, in or cm, oz or ml) unless a unit is named;
 * conversion to canonical happens HERE, reading UnitPreferences via the metric
 * registry / exercise helpers exactly like the keypad — the model is never
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
import { addVersion, getCurrentVersion, getProtocolBySlug } from '@/lib/db/repositories/protocols';
import {
  completeReminder,
  createReminder,
  dismissReminder,
  listActiveReminders,
} from '@/lib/db/repositories/reminders';
import { setMode } from '@/lib/db/repositories/day-modes';
import {
  completeExperiment,
  createExperiment,
  getExperiment,
} from '@/lib/db/repositories/experiments';
import { logSymptom } from '@/lib/db/repositories/symptoms';
import { getPreferences } from '@/lib/db/repositories/user';
import { getModeDefinition, MODE_KEYS } from '@/lib/modes/registry';
import { lbToKg, setLineKg } from '@/lib/exercise/format';
import {
  isLoggableCanonical,
  metricByKey,
  resolveDisplay,
  roundToSpec,
  type MetricKey,
} from '@/lib/log/metrics';
import type { SetInput, WorkoutKind } from '@/lib/exercise/types';
import { normalizeItem, parseProtocolContent } from '@/lib/protocols/content';
import type { ProtocolItem } from '@/lib/protocols/types';

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

/**
 * Validated input → canonical value + display string, shared by summary/execute.
 *
 * An UNQUALIFIED value ("weight 80") is interpreted in the user's chosen display
 * unit (Settings › Units) via {@link resolveDisplay} — exactly like the keypad —
 * so a kg-preference user's "80" stores 80 kg, not 36 kg. An explicit `unit`
 * token in the call ("80 kg", "waist 90 cm") always wins over the preference.
 * The `db` handle carries the preference in; every call site already holds it.
 */
function parseMetricInput(
  input: Record<string, unknown>,
  db: Database
): {
  key: MetricKey;
  canonical: number;
  display: string;
} {
  const args = asRecord(input);
  const key = reqEnum(args, 'metric', METRIC_KEYS);
  const value = reqNumber(args, 'value');
  const unit = optString(args, 'unit')?.toLowerCase();
  const metric = metricByKey(key)!;
  const spec = resolveDisplay(metric, getPreferences(db).units);

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
    canonical = spec.toCanonical(value);
  }
  if (!isLoggableCanonical(metric, canonical)) {
    throw new Error(`${key} value out of loggable range.`);
  }
  const display = `${roundToSpec(spec, spec.fromCanonical(canonical))} ${spec.unit}`;
  return { key, canonical, display };
}

const logMetricTool: CoachTool = {
  name: 'log_metric',
  description:
    'Log one body/vital measurement: weight, body_fat, waist, hrv, rhr, or water. ' +
    "The value is in the user's chosen display unit for that metric (their Settings " +
    'preference — e.g. weight lb OR kg, waist in OR cm, water oz OR ml; hrv ms, rhr ' +
    'bpm, body_fat %) unless "unit" names another. Pass the number exactly as the user ' +
    'said it — the app reads their unit preference and converts. Use when the user ' +
    'states a measurement ("weight was 178 this morning").',
  inputSchema: {
    type: 'object',
    properties: {
      metric: { type: 'string', enum: [...METRIC_KEYS] },
      value: { type: 'number' },
      unit: {
        type: 'string',
        description: 'Optional explicit unit token ("kg", "cm", "ml") — overrides the preference.',
      },
      ...DATE_PROPERTY,
    },
    required: ['metric', 'value'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db) => {
    const { key, display } = parseMetricInput(input, db);
    return `Log ${metricByKey(key)!.label.toLowerCase()} ${display}${dateSuffix(asRecord(input))}`;
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const { key, canonical, display } = parseMetricInput(input, db);
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
 * Sets arrive in the user's weight unit by default (their Settings preference —
 * lb or kg), which an explicit per-set `unit` overrides; conversion to canonical
 * kg happens here, never in the model, and the display line renders back in the
 * same preferred unit (setLineKg) so the confirmation card matches the app.
 */
function parseSets(input: Record<string, unknown>, db: Database): ParsedSet[] {
  const raw = input['sets'];
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('"sets" must be an array.');
  const units = getPreferences(db).units;
  return raw.map((entry) => {
    const set = asRecord(entry);
    const exercise = reqString(set, 'exercise');
    const reps = optNumber(set, 'reps') ?? null;
    const weight = optNumber(set, 'weight') ?? null;
    const unit = optEnum(set, 'unit', SET_UNITS) ?? units.weight;
    const weightKg = weight == null ? null : unit === 'kg' ? weight : lbToKg(weight);
    return {
      exercise,
      reps,
      weightKg,
      displayLine: `${exercise} ${setLineKg(reps, weightKg, units)}`,
    };
  });
}

const logWorkoutTool: CoachTool = {
  name: 'log_workout',
  description:
    'Log a training session: name, kind (strength/cardio/mobility/other), duration in ' +
    'minutes, and optional strength sets [{exercise, reps, weight, unit}] — set weight ' +
    "is in the user's default weight unit unless `unit` names one (lb/kg); pass it " +
    'exactly as the user said it. Use when the user reports a workout.',
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
            weight: {
              type: 'number',
              minimum: 0,
              description: "In `unit` (default = the user's weight-unit setting).",
            },
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
  confirmSummary: (input, db) => {
    const args = asRecord(input);
    const name = reqString(args, 'name');
    const duration = optNumber(args, 'duration_min');
    const sets = parseSets(args, db);
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
      parseSets(args, db).map(({ exercise, reps, weightKg }) => ({ exercise, reps, weightKg }))
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

// --- update_protocol (versioned stack / routine edit) ------------------------

/**
 * The COMPLETE new item list, validated and canonicalized through the same
 * normalizeItem the editor uses (so a Coach-written version is byte-identical
 * to a hand-edited one). Throws with the offending index so the model can fix a
 * bad item rather than silently dropping it.
 */
function parseProtocolItems(input: Record<string, unknown>): ProtocolItem[] {
  const raw = input['items'];
  if (!Array.isArray(raw)) {
    throw new Error('"items" must be an array — the COMPLETE new item list for this version.');
  }
  return raw.map((entry, i) => {
    const item = asRecord(entry);
    if (typeof item['title'] !== 'string' || item['title'].trim().length === 0) {
      throw new Error(`items[${i}].title must be a non-empty string.`);
    }
    return normalizeItem({
      title: item['title'],
      scheduled_time: optTime(item, 'scheduled_time') ?? null,
      dose: optString(item, 'dose') ?? null,
      notes: optString(item, 'notes') ?? null,
    });
  });
}

/** Resolve the slug → protocol, with a message that points the model at the fix. */
function requireProtocol(db: Database, slug: string) {
  const protocol = getProtocolBySlug(db, slug);
  if (!protocol) {
    throw new Error(`No protocol with slug "${slug}". Call get_protocols first for valid slugs.`);
  }
  return protocol;
}

const updateProtocolTool: CoachTool = {
  name: 'update_protocol',
  description:
    'Save a NEW version of a protocol (supplement stack, routine, training block), addressed by ' +
    'its slug from get_protocols. Protocols are versioned like code: this NEVER edits the live ' +
    'version — it writes a new one and makes it live, preserving the old. "items" MUST be the ' +
    'COMPLETE new list: call get_protocols first, then include every item you are keeping plus ' +
    'your change — anything omitted is dropped from the stack. Each item: title, optional ' +
    'scheduled_time "HH:MM", optional dose ("400 mg"), optional notes. Use when the user agrees ' +
    'to a stack/routine change ("add magnesium to my evening stack").',
  inputSchema: {
    type: 'object',
    properties: {
      protocol_slug: { type: 'string', description: 'The slug from get_protocols.' },
      items: {
        type: 'array',
        description: 'The COMPLETE new item list (kept items + the change), not just the delta.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            scheduled_time: { type: 'string', description: '24h "HH:MM", omit for any time.' },
            dose: { type: 'string', description: 'e.g. "400 mg", "2 caps".' },
            notes: { type: 'string' },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
      change_notes: { type: 'string', description: 'One line: what changed and why.' },
    },
    required: ['protocol_slug', 'items', 'change_notes'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db) => {
    const args = asRecord(input);
    const protocol = requireProtocol(db, reqString(args, 'protocol_slug'));
    const items = parseProtocolItems(args);
    const wasCount = parseProtocolContent(getCurrentVersion(db, protocol.id)?.content ?? null).items
      .length;
    const notes = optString(args, 'change_notes');
    // "(was N)" makes a destructive replace visible — the user must never approve
    // a stack-wipe thinking it's an add.
    return (
      `Update "${protocol.name}": ${items.length} item${items.length === 1 ? '' : 's'} ` +
      `(was ${wasCount})${notes ? ` — ${notes}` : ''}`
    );
  },
  execute: (db, input) => {
    const args = asRecord(input);
    const protocol = requireProtocol(db, reqString(args, 'protocol_slug'));
    const items = parseProtocolItems(args);
    const versionId = addVersion(
      db,
      protocol.id,
      { items },
      optString(args, 'change_notes') ?? null,
      'ai'
    );
    const version = getCurrentVersion(db, protocol.id);
    return json({
      updated: true,
      protocol: protocol.slug,
      versionId,
      versionNumber: version?.version_number ?? null,
      itemCount: items.length,
    });
  },
};

// --- set_mode (Normal / Travel / Sick / Deload / Social / Custom) ------------

const setModeTool: CoachTool = {
  name: 'set_mode',
  description:
    "Set the day's mode — normal, travel, sick, deload, social, or custom — so the plan, " +
    "priorities, tone, and adherence adapt (docs/information-architecture.md). 'until' gives an " +
    "end date (a whole trip); omit for just today; 'normal' resets. The mode reshapes the mission " +
    'the next time a day is generated (today if not yet generated, plus every future day in ' +
    'range) and excuses skips where appropriate — a skipped workout in Sick mode is NOT a miss. ' +
    'Use when the user says their day is off-normal ("traveling this week", "coming down with ' +
    'something", "deload week", "night out").',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: [...MODE_KEYS] },
      until: {
        type: 'string',
        description: '"YYYY-MM-DD" end date (inclusive); omit for just today.',
      },
      note: { type: 'string', description: 'Optional context, e.g. "red-eye to Tokyo".' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input) => {
    const args = asRecord(input);
    const mode = reqEnum(args, 'mode', MODE_KEYS);
    const until = optDate(args, 'until');
    if (mode === 'normal') return 'Reset to Normal mode';
    return `Set ${getModeDefinition(mode).label} mode${until ? ` through ${until}` : ' for today'}`;
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const mode = reqEnum(args, 'mode', MODE_KEYS);
    const startDate = todayISODate(context.now);
    const until = optDate(args, 'until');
    if (until !== undefined && until < startDate) {
      throw new Error(
        `"until" (${until}) is before today (${startDate}) — a mode can't end in the past.`
      );
    }
    // 'normal' is a RESET: open-ended (endDate null) so it ends an earlier
    // range/open-ended mode for today AND every following day, not just today.
    // Any other mode: omitted `until` = just today; an explicit `until` bounds a
    // range. Open-ended non-normal ("until turned off") stays a Home-control
    // affordance — the model always bounds a mode it sets.
    const endDate = mode === 'normal' ? null : (until ?? startDate);
    const id = setMode(db, { mode, startDate, endDate, note: optString(args, 'note') ?? null });
    return json({ set: true, mode, from: startDate, until: endDate, id });
  },
};

// --- create_experiment / complete_experiment (n-of-1) ------------------------

/** Validate the metrics-to-watch: a non-empty array of non-empty strings. */
function parseMetricsArray(input: Record<string, unknown>): string[] {
  const raw = input['metrics'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('"metrics" must be a non-empty array of metric names to watch.');
  }
  return raw.map((m, i) => {
    if (typeof m !== 'string' || m.trim().length === 0) {
      throw new Error(`metrics[${i}] must be a non-empty string.`);
    }
    return m.trim();
  });
}

const createExperimentTool: CoachTool = {
  name: 'create_experiment',
  description:
    'Design an n-of-1 experiment: a title, the hypothesis, the ONE intervention being changed, ' +
    'the metrics to watch, a duration in days, and optionally the success criteria. It starts ' +
    'TODAY and runs for the duration; later you read those metrics (get_metric_series) and close ' +
    'it with complete_experiment. Use when the user wants to test something ("does magnesium ' +
    'improve my sleep?"). Keep it to ONE change so the readout is attributable.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      hypothesis: { type: 'string' },
      intervention: {
        type: 'string',
        description: 'The single change, e.g. "400 mg magnesium glycinate at night".',
      },
      metrics: {
        type: 'array',
        items: { type: 'string' },
        description: 'Metrics to watch, e.g. ["HRV", "sleep score"].',
      },
      duration_days: { type: 'integer', minimum: 3 },
      success_criteria: { type: 'string', description: 'What would confirm the hypothesis.' },
    },
    required: ['name', 'hypothesis', 'intervention', 'metrics', 'duration_days'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input) => {
    const args = asRecord(input);
    const name = reqString(args, 'name');
    const days = reqNumber(args, 'duration_days');
    return `Start experiment "${name}" — ${Math.round(days)} days`;
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const metrics = parseMetricsArray(args);
    const durationDays = reqNumber(args, 'duration_days');
    if (!Number.isInteger(durationDays) || durationDays < 3) {
      throw new Error('"duration_days" must be an integer of at least 3.');
    }
    const id = createExperiment(db, {
      title: reqString(args, 'name'),
      hypothesis: reqString(args, 'hypothesis'),
      intervention: reqString(args, 'intervention'),
      metrics,
      startDate: todayISODate(context.now),
      durationDays,
      successCriteria: optString(args, 'success_criteria') ?? null,
    });
    return json({ created: true, id, durationDays });
  },
};

/** Resolve an experiment id → its row, with a message pointing at the fix. */
function requireExperiment(db: Database, id: string) {
  const exp = getExperiment(db, id);
  if (!exp) throw new Error(`No experiment with id ${id}. Call get_experiments first.`);
  return exp;
}

const completeExperimentTool: CoachTool = {
  name: 'complete_experiment',
  description:
    'Conclude an active experiment (get its id from get_experiments): record the one-line ' +
    'conclusion — did the hypothesis hold? — and optional outcome_notes on how the watched ' +
    'metrics moved. Read the metrics first (get_metric_series). Use when an experiment has ended.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      conclusion: { type: 'string', description: 'The verdict, e.g. "HRV up 9% — supported".' },
      outcome_notes: { type: 'string', description: 'How the metrics moved, the readout.' },
    },
    required: ['id', 'conclusion'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db) =>
    `Conclude experiment "${requireExperiment(db, reqString(asRecord(input), 'id')).title}"`,
  execute: (db, input) => {
    const args = asRecord(input);
    const exp = requireExperiment(db, reqString(args, 'id'));
    if (exp.status !== 'active') {
      throw new Error(`Experiment "${exp.title}" is already ${exp.status} — nothing to conclude.`);
    }
    completeExperiment(db, exp.id, {
      conclusion: reqString(args, 'conclusion'),
      outcomeNotes: optString(args, 'outcome_notes') ?? null,
    });
    return json({ completed: true, id: exp.id, title: exp.title });
  },
};

export const WRITE_TOOLS: CoachTool[] = [
  logMetricTool,
  logMealTool,
  logWorkoutTool,
  logSymptomTool,
  logCaptureTool,
  logNoteTool,
  updateProtocolTool,
  setModeTool,
  createExperimentTool,
  completeExperimentTool,
  setReminderTool,
  completeReminderTool,
  dismissReminderTool,
];
