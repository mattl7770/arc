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
 *
 * A day can also be DERIVED rather than given — set_reminder pins the day of a
 * bare-time one-off, which is tomorrow once that clock time has gone by. Those
 * summaries take the turn's `context` (the third `confirmSummary` argument,
 * REQUIRED — see tools/types.ts) so they resolve the day off the very same
 * clock `execute` will, and name it on the card instead of letting the user
 * approve "at 09:00" and get a row dated tomorrow.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import { logCapture, logMetric, logNote } from '@/lib/db/repositories/logs';
import { logWorkout } from '@/lib/db/repositories/exercise';
import { resolveExerciseByName } from '@/lib/db/repositories/exercise-catalog';
import {
  activeNutritionTargets,
  logMeal,
  setNutritionTargets,
} from '@/lib/db/repositories/nutrition';
import {
  addMonthsClamped,
  getScreening,
  markScreeningDone,
} from '@/lib/db/repositories/screenings';
import { addVersion, getCurrentVersion, getProtocolBySlug } from '@/lib/db/repositories/protocols';
import { KNOWLEDGE_SECTIONS, saveKnowledgeEntry } from '@/lib/db/repositories/knowledge';
import {
  completeReminder,
  createReminder,
  dismissReminder,
  listActiveReminders,
  resolveOneOffDay,
} from '@/lib/db/repositories/reminders';
import { modesSupersededFrom, setMode } from '@/lib/db/repositories/day-modes';
import {
  addGroceryItems,
  addRecipeToGroceryList,
  checkGroceryItem,
  getGroceryItem,
} from '@/lib/db/repositories/grocery';
import {
  createRecipe,
  getRecipe,
  listIngredients,
  logRecipe,
  portionFactor,
  recipeNutrition,
} from '@/lib/db/repositories/recipes';
import { catalogResolveRecipe } from '@/lib/recipes/estimate';
import type { RecipePortion } from '@/lib/recipes/types';
import {
  abandonExperiment,
  completeExperiment,
  createExperiment,
  getExperiment,
} from '@/lib/db/repositories/experiments';
import {
  findMemories,
  forgetMemory,
  getMemory,
  rememberFact,
} from '@/lib/db/repositories/coach-memory';
import {
  generateMissionForDay,
  rederiveMissionForDay,
} from '@/lib/db/repositories/mission-generate';
import {
  getOrCreateDailyLog,
  insertMissionItem,
  listMission,
  moveMissionItem,
  removeMissionItem,
  setMissionStatus,
} from '@/lib/db/repositories/mission';
import { logSymptom } from '@/lib/db/repositories/symptoms';
import { getPreferences } from '@/lib/db/repositories/user';
import { getModeDefinition, MODE_KEYS, type ModeKey } from '@/lib/modes/registry';
import { syncAndReportForReminder } from '@/lib/notifications/reminders';
import { lbToKg, setLineKg } from '@/lib/exercise/format';
import {
  isLoggableCanonical,
  metricByKey,
  resolveDisplay,
  roundToSpec,
  type MetricKey,
} from '@/lib/log/metrics';
import type { LogEntryType } from '@/lib/db/types';
import type { SetInput, WorkoutKind } from '@/lib/exercise/types';
import { newId } from '@/lib/db/id';
import { parseCadenceText } from '@/lib/protocols/cadence';
import {
  allItems,
  DAILY,
  normalizeContent,
  parseProtocolContent,
  validateContent,
} from '@/lib/protocols/content';
import type { Cadence, ProtocolContent } from '@/lib/protocols/types';

import {
  asRecord,
  optDate,
  optEnum,
  optNumber,
  optPastDate,
  optString,
  optTime,
  reqEnum,
  reqNumber,
  reqString,
  type CoachTool,
} from './types';

const json = (value: unknown): string => JSON.stringify(value);

/** The local day a log lands on: an explicit backdate (never future), else today. */
function logDate(args: Record<string, unknown>, now: Date): string {
  return optPastDate(args, 'date', now) ?? todayISODate(now);
}

/**
 * The log tools' date suffix: validates the future bound at CARD time, not
 * just at execute — a knowable failure must never cost the user an Approve
 * tap (the model mis-parses "next Tuesday", the card shows it, the user
 * approves, execute throws, and the model re-asks: two cards for one fact).
 * A confirmSummary throw becomes a pre-gate is_error the model corrects from.
 */
function pastDateSuffix(args: Record<string, unknown>, now?: Date): string {
  const date = optPastDate(args, 'date', now ?? new Date());
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
    'Log one body/vital measurement: weight, body_fat, waist, hrv, rhr, or water. Values are ' +
    'in the user\'s display units unless "unit" names another. Use when the user states a ' +
    'measurement ("weight was 178 this morning").',
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
  confirmSummary: (input, db, context) => {
    const { key, display } = parseMetricInput(input, db);
    return `Log ${metricByKey(key)!.label.toLowerCase()} ${display}${pastDateSuffix(asRecord(input), context?.now)}`;
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const { key, canonical, display } = parseMetricInput(input, db);
    logMetric(db, logDate(args, context.now), key, canonical);
    return json({ logged: true, metric: key, value: display });
  },
};

// --- log_meal ----------------------------------------------------------------

/**
 * The four optional macros, each rejected if negative — the `meals` table
 * enforces CHECK(kcal IS NULL OR kcal >= 0) (and the same for every macro) since
 * 0002, so a negative would pass the card and only blow up at INSERT. Shared by
 * summary and execute so the card can never show a value execute then rejects.
 */
function parseMealMacros(args: Record<string, unknown>): {
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
} {
  const read = (key: string): number | null => {
    const value = optNumber(args, key);
    if (value !== undefined && value < 0) throw new Error(`"${key}" cannot be negative.`);
    return value ?? null;
  };
  return {
    kcal: read('kcal'),
    protein_g: read('protein_g'),
    carbs_g: read('carbs_g'),
    fat_g: read('fat_g'),
  };
}

const logMealTool: CoachTool = {
  name: 'log_meal',
  // TRIMMED 2026-08-26 to pay for save_knowledge_entry's `section`
  // (db/coach-eval.test.mjs §6: "the next addition trims"). What went was a
  // sentence enumerating this schema's OWN property names — "(kcal, protein_g,
  // carbs_g, fat_g) and wall-clock time" — which the properties directly below
  // it declare, `time` with its own format description. A description that
  // recites its schema is the same duplication class as a description that
  // recites a system-prompt rail.
  description:
    'Log an eaten meal, macros optional. Use when the user describes food they ate; ' +
    'estimate macros only if asked, and say so.',
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
  confirmSummary: (input, _db, context) => {
    const args = asRecord(input);
    const name = reqString(args, 'name');
    // Validate exactly what execute enforces — negative macros (the meals CHECK)
    // and a malformed time — so an approvable card can never carry a value the
    // INSERT then rejects.
    const values = parseMealMacros(args);
    optTime(args, 'time');
    // Everything consequential goes on the card — approving writes ALL of it.
    const macros = [
      ['kcal', values.kcal, 'kcal'],
      ['protein', values.protein_g, 'g protein'],
      ['carbs', values.carbs_g, 'g carbs'],
      ['fat', values.fat_g, 'g fat'],
    ]
      .filter(([, value]) => value != null)
      .map(([, value, unit]) => `${Math.round(value as number)} ${unit}`)
      .join(', ');
    return `Log meal "${name}"${macros ? ` · ${macros}` : ''}${pastDateSuffix(args, context?.now)}`;
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const id = logMeal(db, {
      date: logDate(args, context.now),
      time: optTime(args, 'time') ?? null,
      name: reqString(args, 'name'),
      ...parseMealMacros(args),
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
 * Resolve a spoken exercise name to a catalog id — the identity every piece of
 * engine intelligence (e1RM, freshness, volume, progression) keys on. A set
 * stored with a NULL exercise_id is invisible to all of it, so the more the
 * user logged through the Coach, the blinder "Train today" got (the 2026-08-08
 * review's self-defeating loop).
 *
 * It delegates to the ONE matcher (`resolveExerciseByName`) rather than keeping
 * its own, and that is the 2026-08-14 fix. The copy that used to live here
 * matched on strict exact name or alias, which is why the loop was never really
 * closed: people write their logs in plurals, so "lat pulldowns" and "barbell
 * rows" resolved to nothing and a whole Coach-logged back day left the body
 * figure almost untouched. The shared resolver de-pluralises and keeps the
 * labs-pipeline discipline — a UNIQUE match resolves, anything ambiguous stays
 * null rather than guessing, so "Press" is still null (pinned by §27 of
 * db/coach-tools.test.mjs) and "Bench" never becomes "Bench Press" while a
 * "Bench Dip" also exists.
 *
 * Kept as a named local because `unmatchedExercises` in the tool result must be
 * computed from exactly the answer the row will be given.
 */
function resolveExerciseId(db: Database, name: string): string | null {
  return resolveExerciseByName(db, name);
}

/**
 * Sets arrive in the user's weight unit by default (their Settings preference —
 * lb or kg), which an explicit per-set `unit` overrides; conversion to canonical
 * kg happens here, never in the model, and the display line renders back in the
 * same preferred unit (setLineKg) so the confirmation card matches the app.
 * Each set also resolves its catalog exercise_id (see resolveExerciseId).
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
      exerciseId: resolveExerciseId(db, exercise),
      reps,
      weightKg,
      displayLine: `${exercise} ${setLineKg(reps, weightKg, units)}`,
    };
  });
}

const logWorkoutTool: CoachTool = {
  name: 'log_workout',
  // TRIMMED 2026-08-26, same trade and same duplication class as log_meal
  // above: "name, kind (strength/cardio/mobility/other), duration in minutes,
  // and optional strength sets" listed four properties the schema declares one
  // line below, and inlined `kind`'s enum verbatim beside the enum itself.
  description: 'Log a training session, sets optional. Use when the user reports a workout.',
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
              description: "In `unit`; defaults to the user's weight unit.",
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
  confirmSummary: (input, db, context) => {
    const args = asRecord(input);
    const name = reqString(args, 'name');
    // execute requires a valid kind (reqEnum); check it here so a bad or missing
    // enum fails before the approve, not after.
    reqEnum(args, 'kind', WORKOUT_KINDS);
    const duration = optNumber(args, 'duration_min');
    const sets = parseSets(args, db);
    const parts = [
      `Log workout "${name}"`,
      ...(duration != null ? [`${Math.round(duration)} min`] : []),
      ...sets.map((s) => s.displayLine),
    ];
    return parts.join(' · ') + pastDateSuffix(args, context?.now);
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const sets = parseSets(args, db);
    const id = logWorkout(
      db,
      {
        date: logDate(args, context.now),
        name: reqString(args, 'name'),
        kind: reqEnum(args, 'kind', WORKOUT_KINDS),
        durationMin: optNumber(args, 'duration_min') ?? null,
        notes: optString(args, 'notes') ?? null,
      },
      sets.map(({ exercise, exerciseId, reps, weightKg }) => ({
        exercise,
        exerciseId,
        reps,
        weightKg,
      }))
    );
    // Unmatched names still log (free-text sets are valid) but stay invisible
    // to e1RM/freshness/progression — tell the model so it can tell the user.
    const unmatched = [...new Set(sets.filter((s) => !s.exerciseId).map((s) => s.exercise))];
    return json({
      logged: true,
      id,
      ...(unmatched.length > 0
        ? {
            unmatchedExercises: unmatched,
            note:
              'These set names did not uniquely match the exercise catalog, so they will not ' +
              'count toward strength progression/freshness. Suggest the exact catalog name ' +
              'next time.',
          }
        : {}),
    });
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
  confirmSummary: (input, _db, context) => {
    const args = asRecord(input);
    const name = reqString(args, 'name');
    const severity = optNumber(args, 'severity');
    // Match execute's guards at CARD time — a severity of 5.5 or a malformed
    // time must fail before the user approves, not after.
    if (severity !== undefined && (!Number.isInteger(severity) || severity < 1 || severity > 10)) {
      throw new Error('"severity" must be an integer from 1 to 10.');
    }
    optTime(args, 'time');
    return `Log symptom "${name}"${severity != null ? ` · ${severity}/10` : ''}${pastDateSuffix(args, context?.now)}`;
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
  confirmSummary: (input, _db, context) => {
    const args = asRecord(input);
    return `Log ${reqEnum(args, 'type', CAPTURE_TYPES)}: ${reqString(args, 'title')}${pastDateSuffix(args, context?.now)}`;
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
  confirmSummary: (input, _db, context) => {
    const args = asRecord(input);
    return `Save note: "${reqString(args, 'text')}"${pastDateSuffix(args, context?.now)}`;
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const id = logNote(db, logDate(args, context.now), reqString(args, 'text'));
    return json({ logged: true, id });
  },
};

// --- set_reminder ------------------------------------------------------------

const REPEATS = ['once', 'daily', 'weekly'] as const;

/** Weekday / month names spelled out by hand: Hermes ships no `Intl`, so
 * `toLocaleDateString` is unavailable on device. Sunday-first, matching getDay(). */
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_NAMES = [
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

/** "Sat 8 Aug" for a validated "YYYY-MM-DD". Split componentwise and fed to the
 * Date CONSTRUCTOR — never `new Date('2026-08-08')`, which some runtimes read as
 * UTC midnight and would print the wrong weekday west of Greenwich. */
function humanDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${WEEKDAY_NAMES[new Date(y, m - 1, d).getDay()]} ${d} ${MONTH_NAMES[m - 1]}`;
}

/**
 * The day part of a reminder's confirmation line: empty when the reminder lands
 * TODAY (nothing to warn about), otherwise the day named plainly —
 * " · tomorrow (Sat 8 Aug)". This is the whole point of threading `context`
 * into `confirmSummary`: approving "at 09:00" at 22:00 writes a row dated
 * tomorrow, and the card has to say so.
 *
 * Relative wording is only used for a one-off, where the date IS the day the
 * thing happens. A weekly's date is an anchor picking a weekday, so it is
 * printed as the ISO day plus its weekday and nothing else.
 */
function reminderDaySuffix(date: string | null, repeat: string, now: Date): string {
  if (date == null) return '';
  if (repeat !== 'once') return ` · ${date} (${humanDay(date)})`;
  const dayFrom = (offset: number) =>
    todayISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  if (date === dayFrom(0)) return '';
  if (date === dayFrom(1)) return ` · tomorrow (${humanDay(date)})`;
  if (date === dayFrom(-1)) return ` · yesterday (${humanDay(date)})`;
  return ` · ${date} (${humanDay(date)})`;
}

const setReminderTool: CoachTool = {
  name: 'set_reminder',
  description:
    // Compressed 2026-08-10 (token budget), then again 2026-08-11. The one-off
    // pinning rule and the notification-reporting rule are still load-bearing —
    // they have MOVED, into the system prompt's Reminders bullet, which is
    // cached once for the whole registry rather than restated per tool. Only
    // the shape of this call stays here.
    'Create a reminder: title, optional "HH:MM" time, optional "YYYY-MM-DD" date, repeat ' +
    'once/daily/weekly (weekly needs a date to anchor its weekday). Use when asked, or propose ' +
    'one when a logging gap warrants a nudge. Check list_reminders first to avoid duplicates.',
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
  // Takes `context` because the day is DERIVED, not just passed: a bare-time
  // one-off is pinned as it saves, and after that clock time has gone by the
  // day it pins to is TOMORROW. Resolving it here through the very function
  // createReminder uses, against the SAME CoachToolContext instance execute
  // receives, is what keeps the card and the row from disagreeing. `context` is
  // required (see tools/types.ts): the service reads the clock once per tool
  // call, so there is no second read for the two to drift apart across however
  // long the user takes to approve.
  confirmSummary: (input, _db, context) => {
    const args = asRecord(input);
    const title = reqString(args, 'title');
    const time = optTime(args, 'time');
    const repeat = optEnum(args, 'repeat', REPEATS) ?? 'once';
    // execute refuses a weekly with no anchoring date (createReminder can't pick
    // a weekday without one); enforce it HERE so that refusal never rides in on
    // a card the user is invited to approve.
    if (repeat === 'weekly' && optDate(args, 'date') === undefined) {
      throw new Error('A weekly reminder needs a "date" anchoring its weekday.');
    }
    const now = context.now;
    const day =
      optDate(args, 'date') ?? (repeat === 'once' && time ? resolveOneOffDay(time, now) : null);
    const cadence = repeat === 'once' ? '' : ` · ${repeat}`;
    const when = reminderDaySuffix(day, repeat, now);
    return `Set reminder "${title}"${time ? ` at ${time}` : ''}${cadence}${when}`;
  },
  // Async because the honest answer isn't knowable until the OS has been asked:
  // whether a notification exists depends on the running binary, the permission
  // grant and the clock. So we resync and report the OBSERVED outcome rather
  // than letting the description promise one (see notifications/reminders.ts).
  // `date` in the result is read back off the SAVED ROW, not off the input, so
  // it reports the day a bare-time one-off was actually pinned to (today or
  // tomorrow — createReminder resolves it once, against context.now).
  execute: async (db, input, context) => {
    const args = asRecord(input);
    const repeat = optEnum(args, 'repeat', REPEATS) ?? 'once';
    const date = optDate(args, 'date');
    if (repeat === 'weekly' && date === undefined) {
      throw new Error('A weekly reminder needs a "date" anchoring its weekday.');
    }
    const id = createReminder(
      db,
      {
        title: reqString(args, 'title'),
        time: optTime(args, 'time') ?? null,
        date: date ?? null,
        repeat,
        createdBy: 'ai',
        notes: optString(args, 'notes') ?? null,
      },
      context.now
    );
    const saved = listActiveReminders(db).find((r) => r.id === id);
    const notification = await syncAndReportForReminder(db, id, context.now);
    return json({ created: true, id, repeat, date: saved?.date ?? null, notification });
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
 * The COMPLETE new content — ordered phases of items — validated and
 * canonicalized through the same `normalizeContent` + `validateContent` the
 * editor uses, so a Coach-written version is byte-identical to a hand-edited
 * one and a document the editor would refuse cannot arrive by tool instead.
 *
 * Every throw names the offending path (`phases[1].items[3].cadence`) and, for
 * a cadence, the vocabulary — so the model can fix the call rather than have a
 * broken protocol persisted or an item silently dropped.
 *
 * **Item ids are inherited by title from the live content.** The tool contract
 * is a complete replacement, so the model re-sends every item it is keeping;
 * minting fresh ids for those would reset each item's identity, which is what
 * an N-per-week quota counts on and what the version diff matches by. Matched
 * as a MULTISET, because a stack may legitimately list the same title twice.
 */
function parseProtocolContentInput(
  db: Database,
  input: Record<string, unknown>,
  live: ProtocolContent
): ProtocolContent {
  const raw = input['phases'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      '"phases" must be a non-empty array — the COMPLETE new content. One phase is the normal case.'
    );
  }

  const inherited = new Map<string, string[]>();
  for (const item of allItems(live)) {
    const key = item.title.trim().toLowerCase();
    inherited.set(key, [...(inherited.get(key) ?? []), item.id]);
  }
  const idFor = (title: string): string =>
    inherited.get(title.trim().toLowerCase())?.shift() ?? newId(db);

  const content = normalizeContent({
    phases: raw.map((entry, p) => {
      const phase = asRecord(entry);
      const items = phase['items'];
      if (!Array.isArray(items)) {
        throw new Error(`phases[${p}].items must be an array of items.`);
      }
      return {
        // Phases are matched to the live ones by POSITION, which is the only
        // stable thing about them — a phase has no natural key, and its title
        // is optional.
        id: live.phases[p]?.id ?? newId(db),
        title: optString(phase, 'title') ?? null,
        duration_days: optNumber(phase, 'duration_days') ?? null,
        items: items.map((raw2, i) => {
          const item = asRecord(raw2);
          if (typeof item['title'] !== 'string' || item['title'].trim().length === 0) {
            throw new Error(`phases[${p}].items[${i}].title must be a non-empty string.`);
          }
          return {
            id: idFor(item['title']),
            title: item['title'],
            scheduled_time: optTime(item, 'scheduled_time') ?? null,
            dose: optString(item, 'dose') ?? null,
            notes: optString(item, 'notes') ?? null,
            cadence: parseCadence(optString(item, 'cadence'), `phases[${p}].items[${i}]`),
          };
        }),
      };
    }),
  });

  const invalid = validateContent(content);
  if (invalid) throw new Error(invalid);
  return content;
}

/** A cadence phrase, or the failure the model can act on. Absent means daily. */
function parseCadence(text: string | undefined, path: string): Cadence {
  if (text === undefined) return DAILY;
  const cadence = parseCadenceText(text);
  if (cadence === null) {
    throw new Error(
      `${path}.cadence "${text}" is not readable. Use: daily | mon,wed,fri | every 3 days | 3/week.`
    );
  }
  return cadence;
}

/** Resolve the slug → protocol, with a message that points the model at the fix. */
function requireProtocol(db: Database, slug: string) {
  const protocol = getProtocolBySlug(db, slug);
  if (!protocol) {
    throw new Error(`No protocol with slug "${slug}". Call get_protocols first for valid slugs.`);
  }
  return protocol;
}

/** The live content of the protocol a call names, for id inheritance + counts. */
const liveContentOf = (db: Database, protocolId: string): ProtocolContent =>
  parseProtocolContent(getCurrentVersion(db, protocolId)?.content ?? null);

const updateProtocolTool: CoachTool = {
  name: 'update_protocol',
  description:
    // The COMPLETE-SET rule and its "anything omitted is dropped" consequence
    // live once, in the system prompt's VERSIONED SETS bullet, which governs
    // this tool and set_nutrition_targets together (2026-08-11 trim).
    //
    // `apply_today` is GONE (2026-08-25): a protocol edit now always reaches
    // today, by the owner's call, so the flag had one legal value and cost the
    // model a decision it could get wrong in only one direction.
    'Save a new version of a protocol by its slug from get_protocols. "phases" is the COMPLETE ' +
    'new content; it takes effect today.',
  inputSchema: {
    type: 'object',
    properties: {
      protocol_slug: { type: 'string', description: 'From get_protocols.' },
      phases: {
        type: 'array',
        description: 'Ordered; usually one.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'e.g. "Loading". Omit if single-phase.' },
            duration_days: {
              type: 'integer',
              description: 'Required except on the LAST phase, which then runs on.',
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  scheduled_time: { type: 'string', description: '"HH:MM" 24h.' },
                  dose: { type: 'string', description: 'e.g. "400 mg".' },
                  notes: { type: 'string' },
                  cadence: {
                    type: 'string',
                    description:
                      'daily (default) | mon,wed,fri | every 3 days | 3/week (any 3 days).',
                  },
                },
                required: ['title'],
                additionalProperties: false,
              },
            },
          },
          required: ['items'],
          additionalProperties: false,
        },
      },
      change_notes: { type: 'string', description: 'What changed and why.' },
    },
    required: ['protocol_slug', 'phases', 'change_notes'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db) => {
    const args = asRecord(input);
    const protocol = requireProtocol(db, reqString(args, 'protocol_slug'));
    const live = liveContentOf(db, protocol.id);
    const count = allItems(parseProtocolContentInput(db, args, live)).length;
    const wasCount = allItems(live).length;
    const notes = optString(args, 'change_notes');
    // "(was N)" makes a destructive replace visible — the user must never
    // approve a stack-wipe thinking it is an add. WHEN it lands is
    // consequential too: approving "add magnesium" and seeing nothing on
    // today's mission reads as a broken promise, so the card says the day.
    return (
      `Update "${protocol.name}": ${count} item${count === 1 ? '' : 's'} ` +
      `(was ${wasCount})${notes ? ` — ${notes}` : ''} · applies to today's plan now`
    );
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const protocol = requireProtocol(db, reqString(args, 'protocol_slug'));
    const content = parseProtocolContentInput(db, args, liveContentOf(db, protocol.id));
    const versionId = addVersion(
      db,
      protocol.id,
      content,
      optString(args, 'change_notes') ?? null,
      'ai'
    );
    const version = getCurrentVersion(db, protocol.id);
    // The edit reaches TODAY, through the same diff a mode change uses:
    // untouched machine-made rows follow the new content, and everything the
    // user has already acted on is preserved.
    const rederived = rederiveMissionForDay(db, todayISODate(context.now));
    return json({
      updated: true,
      protocol: protocol.slug,
      versionId,
      versionNumber: version?.version_number ?? null,
      itemCount: allItems(content).length,
      effective: 'today',
      missionAdded: rederived.added,
      missionRemoved: rederived.removed,
    });
  },
};

// --- remember / forget (durable coach memory, 0028) --------------------------

const MEMORY_CATEGORIES = ['preference', 'constraint', 'context', 'goal'] as const;

const rememberTool: CoachTool = {
  name: 'remember',
  description:
    // The what-not-to-remember rail lives in the system prompt's Memory bullet.
    'Store ONE durable fact so you still know it next conversation: a preference, a constraint ' +
    'or adverse reaction ("magnesium citrate upsets his stomach"), stable context, or a goal. ' +
    'One sentence per call; the user sees and can delete every memory.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The fact, one sentence.' },
      category: { type: 'string', enum: [...MEMORY_CATEGORIES] },
    },
    required: ['content', 'category'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input) => {
    const args = asRecord(input);
    const content = reqString(args, 'content');
    // execute requires a valid category (reqEnum); validate it here so a missing
    // or non-enum category fails before the card is approved.
    reqEnum(args, 'category', MEMORY_CATEGORIES);
    return `Remember: "${content}"`;
  },
  execute: (db, input) => {
    const args = asRecord(input);
    const content = reqString(args, 'content');
    const before = findMemories(db, content, 1);
    const id = rememberFact(db, {
      content,
      category: reqEnum(args, 'category', MEMORY_CATEGORIES),
      source: 'coach',
    });
    // Re-remembering the same line returns the existing row; say so rather
    // than implying a new fact was added.
    const alreadyKnown = before.some((m) => m.id === id);
    return json({ remembered: true, id, alreadyKnown });
  },
};

const forgetTool: CoachTool = {
  name: 'forget',
  description:
    'Forget one durable memory by its id (ids come with the memories in your context block, ' +
    'and from get_memories). Use when the user says something is no longer true or asks you ' +
    'to drop it. The memory is archived, not destroyed — the user can still see it in ' +
    'Settings. Prefer forgetting a stale fact over silently accumulating contradictions.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db) => {
    const id = reqString(asRecord(input), 'id');
    const memory = getMemory(db, id);
    if (!memory) throw new Error(`No memory with id ${id}. Call get_memories first.`);
    return `Forget: "${memory.content}"`;
  },
  execute: (db, input) => {
    const id = reqString(asRecord(input), 'id');
    const memory = getMemory(db, id);
    if (!memory) throw new Error(`No memory with id ${id}. Call get_memories first.`);
    const forgotten = forgetMemory(db, id);
    return json({
      forgotten,
      id,
      ...(forgotten ? {} : { note: 'That memory was already forgotten.' }),
    });
  },
};

// --- adjust_today (mission surgery, one card) --------------------------------

const ADJUST_ACTIONS = ['complete', 'skip', 'add', 'move', 'remove'] as const;
type AdjustAction = (typeof ADJUST_ACTIONS)[number];

const ADJUST_TYPES: readonly LogEntryType[] = [
  'habit',
  'meal',
  'workout',
  'supplement',
  'medication',
  'therapy',
  'metric',
  'note',
];

type AdjustOp = {
  action: AdjustAction;
  id?: string;
  title?: string;
  type?: LogEntryType;
  scheduledTime?: string | null;
  why?: string;
};

/** Validate the ops array; every op is checked before ANY of them runs. */
function parseAdjustOps(input: Record<string, unknown>): AdjustOp[] {
  const raw = input['ops'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('"ops" must be a non-empty array of adjustments.');
  }
  return raw.map((entry, i) => {
    const op = asRecord(entry);
    const action = reqEnum(op, 'action', ADJUST_ACTIONS);
    const id = optString(op, 'id');
    const title = optString(op, 'title');
    if (action === 'add') {
      if (!title) throw new Error(`ops[${i}]: "add" needs a "title".`);
    } else if (!id) {
      throw new Error(
        `ops[${i}]: "${action}" needs the item's "id" from get_today_snapshot's mission list.`
      );
    }
    // "move" with no time is a real intent (untimed = any time today), so the
    // key's PRESENCE is what distinguishes it from "not supplied".
    const hasTime = Object.prototype.hasOwnProperty.call(op, 'scheduled_time');
    return {
      action,
      ...(id ? { id } : {}),
      ...(title ? { title } : {}),
      ...(optEnum(op, 'type', ADJUST_TYPES) ? { type: optEnum(op, 'type', ADJUST_TYPES) } : {}),
      ...(hasTime ? { scheduledTime: optTime(op, 'scheduled_time') ?? null } : {}),
      ...(optString(op, 'why') ? { why: optString(op, 'why') } : {}),
    };
  });
}

/** Resolve an op's id to its current row for the confirmation card. */
function missionItemById(db: Database, date: string, id: string) {
  return listMission(db, date).find((m) => m.id === id);
}

const adjustTodayTool: CoachTool = {
  name: 'adjust_today',
  description:
    "Restructure TODAY's mission in one batch: complete / skip / move / remove items by their id " +
    'from get_today_snapshot, and add new ones. One confirmation covers the batch. Today only — ' +
    'edit the protocol to change future days.',
  inputSchema: {
    type: 'object',
    properties: {
      ops: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: [...ADJUST_ACTIONS] },
            id: { type: 'string', description: "Every action but 'add'." },
            title: { type: 'string', description: "'add' only." },
            type: {
              type: 'string',
              enum: [...ADJUST_TYPES],
              description: "'add' only, default habit.",
            },
            scheduled_time: { type: 'string', description: '"HH:MM" 24h; move or add.' },
            why: { type: 'string', description: "One line; 'add' only." },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
    },
    required: ['ops'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db, context) => {
    const date = todayISODate(context?.now ?? new Date());
    const ops = parseAdjustOps(asRecord(input));
    // Every op is named on the ONE card, resolved to real titles — a batch the
    // user approves must be as legible as a single write.
    const parts = ops.map((op) => {
      const current = op.id ? missionItemById(db, date, op.id) : undefined;
      const name = current?.title ?? op.title ?? op.id ?? 'item';
      switch (op.action) {
        case 'complete':
          return `complete "${name}"`;
        case 'skip':
          return `skip "${name}"`;
        case 'remove':
          return `remove "${name}"`;
        case 'move':
          return `move "${name}" → ${op.scheduledTime ?? 'any time'}`;
        case 'add':
          return `add "${op.title}"${op.scheduledTime ? ` at ${op.scheduledTime}` : ''}`;
      }
    });
    return `Today: ${parts.join(' · ')}`;
  },
  execute: (db, input, context) => {
    const date = todayISODate(context.now);
    const ops = parseAdjustOps(asRecord(input));

    // Make sure the day EXISTS before adjusting it. `ensureTodaySeeded` normally
    // does this when Home first renders, but the Coach tab can be the first
    // thing opened — and then an `add` created the daily_log and a planned row,
    // which made the seed guard (`countMissionEntries > 0`) skip generation
    // permanently. The user's whole protocol-driven day vanished, replaced by
    // the one item the Coach added. Idempotent, so this is a no-op the other
    // 99% of the time.
    generateMissionForDay(db, date);

    const log = getOrCreateDailyLog(db, date);
    const applied: string[] = [];
    const rejected: { op: string; reason: string }[] = [];

    // One transaction: a partially-applied batch would leave the day in a
    // state the user never approved.
    db.transaction(() => {
      for (const op of ops) {
        if (op.action === 'add') {
          insertMissionItem(db, log.id, op.type ?? 'habit', {
            id: 'generated-on-insert',
            title: op.title!,
            status: 'pending',
            category: CATEGORY_FOR_TYPE[op.type ?? 'habit'],
            ...(op.scheduledTime ? { scheduledTime: op.scheduledTime } : {}),
            ...(op.why ? { why: op.why } : {}),
          });
          applied.push(`added "${op.title}"`);
          continue;
        }

        const current = missionItemById(db, date, op.id!);
        if (!current) {
          rejected.push({ op: `${op.action} ${op.id}`, reason: 'no such mission item today' });
          continue;
        }
        if (op.action === 'complete' || op.action === 'skip') {
          const target = op.action === 'complete' ? 'completed' : 'skipped';
          if (current.status === target) {
            // Idempotent, and deliberately NOT re-run: re-completing would
            // restamp completed_at to now, moving a 06:40 workout to 21:00 in
            // the record because the Coach batched it twice.
            applied.push(`"${current.title}" was already ${target}`);
          } else if (current.status === 'completed' || current.status === 'skipped') {
            // Flipping a settled row throws away when it happened (setMissionStatus
            // nulls completed_at for any non-completed status). Execution history
            // is not the Coach's to rewrite — the user can correct it in the UI.
            rejected.push({
              op: `${op.action} ${current.title}`,
              reason: `already ${current.status} today — its record stands; change it on the mission if that's wrong`,
            });
          } else {
            setMissionStatus(db, op.id!, target);
            applied.push(`${op.action}d "${current.title}"`);
          }
        } else if (op.action === 'move') {
          if (moveMissionItem(db, log.id, op.id!, op.scheduledTime ?? null)) {
            applied.push(`moved "${current.title}"`);
          } else {
            rejected.push({
              op: `move ${current.title}`,
              reason: 'only a pending planned item can be moved',
            });
          }
        } else if (removeMissionItem(db, log.id, op.id!)) {
          applied.push(`removed "${current.title}"`);
        } else {
          rejected.push({
            op: `remove ${current.title}`,
            reason:
              'already completed or skipped — its history is preserved; skip it instead of removing',
          });
        }
      }
    });

    return json({
      adjusted: true,
      applied,
      ...(rejected.length > 0 ? { rejected } : {}),
      mission: listMission(db, date).map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        scheduledTime: m.scheduledTime ?? null,
      })),
    });
  },
};

/** Display category for an added item, matching the mission's own mapping. */
const CATEGORY_FOR_TYPE: Record<LogEntryType, string> = {
  habit: 'Routine',
  meal: 'Nutrition',
  workout: 'Training',
  supplement: 'Supplements',
  medication: 'Medications',
  therapy: 'Therapies',
  metric: 'Metrics',
  note: 'Notes',
};

// --- set_mode (Normal / Travel / Sick / Deload / Social / Custom) ------------

/**
 * Validate and resolve a set_mode call into the window it will actually write.
 *
 * Shared by `confirmSummary` and `execute` deliberately: when only execute
 * validated, an out-of-range window produced a perfectly reasonable-looking
 * confirmation card that threw the moment the user approved it. Whatever the
 * card says must be what happens — including the case where it can't.
 */
function resolveModeWindow(
  args: Record<string, unknown>,
  today: string
): { mode: ModeKey; startDate: string; endDate: string | null } {
  const mode = reqEnum(args, 'mode', MODE_KEYS);
  const from = optDate(args, 'from');
  if (from !== undefined && from < today) {
    throw new Error(
      `"from" (${from}) is in the past — a mode can only be set for today or a future day.`
    );
  }
  const startDate = from ?? today;
  const until = optDate(args, 'until');
  if (until !== undefined && until < startDate) {
    throw new Error(
      `"until" (${until}) is before the start (${startDate}) — a mode can't end before it begins.`
    );
  }
  // 'normal' is a RESET: open-ended (endDate null) so it ends an earlier
  // range/open-ended mode for today AND every following day, not just today.
  // Any other mode: omitted `until` = just today; an explicit `until` bounds a
  // range. Open-ended non-normal ("until turned off") stays a Home-control
  // affordance — the model always bounds a mode it sets.
  return { mode, startDate, endDate: mode === 'normal' ? null : (until ?? startDate) };
}

const setModeTool: CoachTool = {
  name: 'set_mode',
  description:
    "Set a day's mode so the plan, priorities, tone and adherence adapt — it reshapes the " +
    'mission and excuses skips the mode expects. Use when the user says a day is off-normal ' +
    '("traveling next week", "coming down with something", "deload week", "night out"). ' +
    "'normal' resets, and also cancels any mode already scheduled from that day on.",
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: [...MODE_KEYS] },
      from: { type: 'string', description: '"YYYY-MM-DD"; omit for today. Never past.' },
      until: { type: 'string', description: '"YYYY-MM-DD" inclusive; omit for one day.' },
      note: { type: 'string', description: 'e.g. "red-eye to Tokyo".' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db, context) => {
    // Resolve through the SAME function execute uses, so a window the tool will
    // refuse can never reach a card the user is invited to approve. (A card is
    // a promise: "press yes and this happens".)
    const args = asRecord(input);
    const { mode, startDate, endDate } = resolveModeWindow(
      args,
      todayISODate(context?.now ?? new Date())
    );
    const today = todayISODate(context?.now ?? new Date());
    const ahead = startDate > today;

    if (mode === 'normal') {
      // Name what the reset CANCELS. Stored open-ended and newest-wins, it also
      // clears modes scheduled for days that haven't arrived — the user has to
      // see that before approving, not discover it next Monday at the airport.
      const superseded = modesSupersededFrom(db, startDate).filter((r) => r.mode !== 'normal');
      const cancelled =
        superseded.length > 0
          ? ` — also cancels ${superseded
              .map((r) => `${getModeDefinition(r.mode).label} (${r.start_date})`)
              .join(', ')}`
          : '';
      return `Reset to Normal mode${ahead ? ` from ${startDate}` : ''}${cancelled}`;
    }

    const label = getModeDefinition(mode).label;
    // Name the actual span — approving "Travel mode" must never silently mean
    // "starting right now" when the user meant Monday.
    if (ahead) return `Set ${label} mode ${startDate}${endDate ? ` through ${endDate}` : ''}`;
    return `Set ${label} mode${endDate && endDate !== startDate ? ` through ${endDate}` : ' for today'}`;
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const today = todayISODate(context.now);
    const { mode, startDate, endDate } = resolveModeWindow(args, today);
    const id = setMode(db, { mode, startDate, endDate, note: optString(args, 'note') ?? null });
    // Re-shape today to match, exactly as the Home control does — otherwise the
    // same intent through two surfaces gives two outcomes: the user says "I'm
    // coming down with something", the Coach sets Sick, and today's workout
    // stays on the mission with no rest/fluids items. Preserves logged work.
    //
    // A FUTURE-dated mode has nothing to reshape yet: that day generates under
    // the mode when it seeds (planForDay reads getActiveMode for its own date).
    const rederived = startDate === today ? rederiveMissionForDay(db, startDate) : undefined;
    return json({
      set: true,
      mode,
      from: startDate,
      until: endDate,
      id,
      ...(rederived
        ? { missionAdded: rederived.added, missionRemoved: rederived.removed }
        : { note: `Scheduled — ${startDate}'s mission will generate under this mode.` }),
    });
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
    'Design an n-of-1 experiment: title, hypothesis, the ONE intervention being changed, metrics ' +
    'to watch, duration in days, optional success criteria. Starts TODAY. Keep it to ONE change ' +
    'so the readout is attributable.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      hypothesis: { type: 'string' },
      intervention: { type: 'string', description: 'e.g. "400 mg magnesium at night".' },
      metrics: {
        type: 'array',
        items: { type: 'string' },
        // The readable-name list is not repeated here: the result WARNS, by
        // name, about any metric get_metric_series cannot return (see
        // `unreadableMetrics` below), which is the same information delivered
        // only in the case where it matters.
        description: 'Prefer names get_metric_series can read back.',
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
    // Validate everything execute requires, so the card can't promise an
    // experiment execute then refuses: an integer duration ≥ 3, a non-empty
    // metrics array, and the two required prose fields.
    if (!Number.isInteger(days) || days < 3) {
      throw new Error('"duration_days" must be an integer of at least 3.');
    }
    parseMetricsArray(args);
    reqString(args, 'hypothesis');
    reqString(args, 'intervention');
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
    // Warn at CREATE time about metrics no tool can read, rather than letting
    // readout day arrive with nothing to measure (the schema's own old example
    // — "sleep score" — was exactly this trap).
    const unreadable = metrics.filter((m) => !isReadableSeries(m));
    return json({
      created: true,
      id,
      durationDays,
      ...(unreadable.length > 0
        ? {
            unreadableMetrics: unreadable,
            note:
              'These are not series get_metric_series can return, so their readout will be ' +
              'qualitative. Tell the user, and consider watching a readable metric alongside.',
          }
        : {}),
    });
  },
};

/**
 * Metrics get_metric_series can actually return, normalised loosely (the model
 * writes "HRV", "hrv", "resting HR"). This only WARNS — experiment metrics are
 * free text on purpose, since some things are worth watching qualitatively.
 */
const READABLE_SERIES: Record<string, true> = {
  weight: true,
  body_fat: true,
  bodyfat: true,
  waist: true,
  hrv: true,
  rhr: true,
  resting_hr: true,
  restinghr: true,
  water: true,
  sleep: true,
  sleep_duration: true,
  sleep_deep: true,
  deep_sleep: true,
  steps: true,
  active_energy: true,
};

function isReadableSeries(metric: string): boolean {
  return (
    READABLE_SERIES[
      metric
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
    ] === true
  );
}

const abandonExperimentTool: CoachTool = {
  name: 'abandon_experiment',
  description:
    'Abandon a running experiment that can no longer produce an honest answer — the user ' +
    'stopped following the intervention, life intervened, or the design turned out wrong. Get ' +
    'the id from get_experiments. Use this INSTEAD of concluding it: a verdict with no adherence ' +
    'behind it is worse than no verdict, and an abandoned experiment can simply be re-run later.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      reason: { type: 'string', description: 'One line: why it cannot be read out.' },
    },
    required: ['id', 'reason'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db) => {
    const args = asRecord(input);
    const experiment = requireExperiment(db, reqString(args, 'id'));
    return `Abandon experiment "${experiment.title}" — ${reqString(args, 'reason')}`;
  },
  execute: (db, input) => {
    const args = asRecord(input);
    const experiment = requireExperiment(db, reqString(args, 'id'));
    if (experiment.status !== 'active') {
      throw new Error(`Experiment "${experiment.title}" is already ${experiment.status}.`);
    }
    abandonExperiment(db, experiment.id, reqString(args, 'reason'));
    return json({ abandoned: true, id: experiment.id, title: experiment.title });
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

// --- Grocery + recipes (docs/recipes-grocery.md §6) ---------------------------

/** Pluralize the card copy without an Intl dependency. */
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** " · milk (2) · eggs" card fragment, capped so a big batch stays readable. */
function itemListForCard(names: string[], cap: number = 8): string {
  const shown = names.slice(0, cap).join(' · ');
  const more = names.length - Math.min(names.length, cap);
  return more > 0 ? `${shown} +${more} more` : shown;
}

type GroceryToolItem = { name: string; qty?: string };

/** Validate add_grocery_items' batch: 1..30 items, each a non-empty name. */
function parseGroceryItems(input: Record<string, unknown>): GroceryToolItem[] {
  const raw = input.items;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('"items" must be a non-empty array — batch every add into ONE call.');
  }
  if (raw.length > 30) throw new Error('"items" is capped at 30 per call.');
  return raw.map((entry) => {
    const e = asRecord(entry);
    return { name: reqString(e, 'name'), qty: optString(e, 'qty') };
  });
}

const addGroceryItemsTool: CoachTool = {
  name: 'add_grocery_items',
  description:
    'Add items to the standing grocery list. BATCH into ONE call and pass "qty" whenever you ' +
    'know it. For an existing recipe use add_recipe_to_grocery_list instead.',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Up to 30.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            // Owner report, 2026-08-12: the Coach specified a dinner down to
            // "300 g ribeye steak" and then added a quantity-less "ribeye
            // steak" to the list. It knew the number and dropped it, which
            // sends the user to the shop to re-decide something already
            // decided. The schema now names an amount rather than "free text".
            qty: { type: 'string', description: 'Amount, e.g. "2 L", "300 g", "1 bag".' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input) => {
    const items = parseGroceryItems(asRecord(input));
    const names = items.map((i) => (i.qty ? `${i.name} (${i.qty})` : i.name));
    return `Add ${plural(items.length, 'item')} to the grocery list: ${itemListForCard(names)}`;
  },
  execute: (db, input) => {
    const items = parseGroceryItems(asRecord(input));
    const ids = addGroceryItems(
      db,
      items.map((i) => ({ name: i.name, qty_text: i.qty ?? null, source: 'coach' as const }))
    );
    return json({ added: ids.length });
  },
};

/** Resolve a grocery-item id → its row; the card never shows a blind id. */
function requireGroceryItem(db: Database, id: string) {
  const item = getGroceryItem(db, id);
  if (!item) throw new Error(`No grocery item "${id}" — call get_grocery_list for current ids.`);
  return item;
}

/** Validate a 1..30 array of id strings. */
function parseIdArray(input: Record<string, unknown>, key: string): string[] {
  const raw = input[key];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`"${key}" must be a non-empty array of ids.`);
  }
  if (raw.length > 30) throw new Error(`"${key}" is capped at 30 per call.`);
  return raw.map((v) => {
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`"${key}" entries must be ids.`);
    return v.trim();
  });
}

const completeGroceryItemsTool: CoachTool = {
  name: 'complete_grocery_items',
  description: 'Check items off the list, by id, batched. A soft state, never a delete.',
  inputSchema: {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'string' } } },
    required: ['ids'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db) => {
    const ids = parseIdArray(asRecord(input), 'ids');
    const names = ids.map((id) => requireGroceryItem(db, id).name);
    return `Check off ${plural(ids.length, 'item')}: ${itemListForCard(names)}`;
  },
  execute: (db, input) => {
    const ids = parseIdArray(asRecord(input), 'ids');
    for (const id of ids) {
      requireGroceryItem(db, id);
      checkGroceryItem(db, id);
    }
    return json({ checked: ids.length });
  },
};

/** Resolve a recipe id → its row, with a message that points the model at the fix. */
function requireRecipe(db: Database, id: string) {
  const recipe = getRecipe(db, id);
  if (!recipe) throw new Error('No recipe with that id — call get_recipes to see the book.');
  return recipe;
}

const addRecipeToGroceryListTool: CoachTool = {
  name: 'add_recipe_to_grocery_list',
  description: "A recipe's ingredients onto the list, minus any excluded ingredient ids.",
  inputSchema: {
    type: 'object',
    properties: {
      recipe_id: { type: 'string' },
      exclude: {
        type: 'array',
        description: 'Ingredient ids (from get_recipe) the user already has.',
        items: { type: 'string' },
      },
    },
    required: ['recipe_id'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db) => {
    const args = asRecord(input);
    const recipe = requireRecipe(db, reqString(args, 'recipe_id'));
    const exclude = new Set(Array.isArray(args.exclude) ? (args.exclude as string[]) : []);
    const include = listIngredients(db, recipe.id).filter((l) => !exclude.has(l.id));
    if (include.length === 0) {
      throw new Error('Nothing to add — every ingredient is excluded (or the recipe has none).');
    }
    return `Add ${plural(include.length, 'ingredient')} from "${recipe.title}" to the grocery list`;
  },
  execute: (db, input) => {
    const args = asRecord(input);
    const recipe = requireRecipe(db, reqString(args, 'recipe_id'));
    const exclude = new Set(Array.isArray(args.exclude) ? (args.exclude as string[]) : []);
    const includeIds = listIngredients(db, recipe.id)
      .filter((l) => !exclude.has(l.id))
      .map((l) => l.id);
    const ids = addRecipeToGroceryList(db, recipe.id, includeIds);
    return json({ added: ids.length, recipe: recipe.title });
  },
};

/**
 * log_recipe's portion argument: servings XOR grams; NEITHER → 1 serving.
 * Validation throws BEFORE the card renders (grams needs a recorded cooked
 * weight — portionFactor's corrective error names the fix).
 */
function parseRecipePortion(args: Record<string, unknown>): RecipePortion {
  const servings = optNumber(args, 'servings');
  const grams = optNumber(args, 'grams');
  if (servings !== undefined && grams !== undefined) {
    throw new Error('Log by "servings" OR "grams", not both.');
  }
  if (grams !== undefined) {
    if (grams <= 0) throw new Error('"grams" must be > 0.');
    return { grams };
  }
  if (servings !== undefined && servings <= 0) throw new Error('"servings" must be > 0.');
  return { servings: servings ?? 1 };
}

const logRecipeTool: CoachTool = {
  name: 'log_recipe',
  description:
    'Log a cooked recipe as a meal: servings XOR grams (default 1 serving). A result with ' +
    'uncountedIngredients > 0 is a KNOWN UNDERCOUNT.',
  inputSchema: {
    type: 'object',
    properties: {
      recipe_id: { type: 'string' },
      servings: { type: 'number' },
      grams: { type: 'number', description: 'Cooked grams eaten; needs total_weight_g.' },
      date: { type: 'string', description: 'YYYY-MM-DD; omit for today.' },
      time: { type: 'string', description: 'HH:MM.' },
    },
    required: ['recipe_id'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db, context) => {
    const args = asRecord(input);
    const recipe = requireRecipe(db, reqString(args, 'recipe_id'));
    const portion = parseRecipePortion(args);
    const factor = portionFactor(recipe, portion);
    // execute parses the time (optTime throws on a malformed "HH:MM"); validate
    // it here too so a bad time never rides in on an approvable card.
    optTime(args, 'time');
    // Fully validate BEFORE the card: a recipe with nothing loggable (no lines,
    // or all-negligible) must refuse here, never after the user approves.
    const loggable = listIngredients(db, recipe.id).filter((l) => l.negligible === 0);
    if (loggable.length === 0) {
      throw new Error('That recipe has no ingredient lines to log.');
    }
    const nutrition = recipeNutrition(db, recipe.id);
    const portionLabel =
      'grams' in portion ? `${portion.grams} g` : plural(portion.servings, 'serving');
    const kcalNote =
      nutrition.complete && nutrition.perServing.kcal !== null
        ? ` (~${Math.round(nutrition.perServing.kcal * recipe.servings * factor)} kcal)`
        : ` (nutrition incomplete — ${plural(nutrition.unresolvedCount, 'ingredient')} uncounted)`;
    return `Log ${portionLabel} of "${recipe.title}"${kcalNote}${pastDateSuffix(args, context?.now)}`;
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const recipeId = reqString(args, 'recipe_id');
    requireRecipe(db, recipeId);
    const result = logRecipe(db, recipeId, parseRecipePortion(args), {
      date: logDate(args, context.now),
      time: optTime(args, 'time') ?? null,
    });
    if (!result) throw new Error('That recipe has no ingredient lines to log.');
    return json({
      logged: true,
      mealId: result.mealId,
      uncountedIngredients: result.uncountedCount,
    });
  },
};

type RecipeToolIngredient = { raw: string; qty?: number; unit?: string; name?: string };

/** Validate save_recipe's ingredient lines: 1..40, each with a raw line. */
function parseRecipeIngredients(input: Record<string, unknown>): RecipeToolIngredient[] {
  const raw = input.ingredients;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('"ingredients" must be a non-empty array.');
  }
  if (raw.length > 40) throw new Error('"ingredients" is capped at 40 lines.');
  return raw.map((entry) => {
    const e = asRecord(entry);
    const qty = optNumber(e, 'qty');
    if (qty !== undefined && qty <= 0) throw new Error('ingredient "qty" must be > 0.');
    return {
      raw: reqString(e, 'raw'),
      qty,
      unit: optString(e, 'unit'),
      name: optString(e, 'name'),
    };
  });
}

/** Validate an optional array of step strings. */
function parseStepsArray(input: Record<string, unknown>): string[] {
  const raw = input.steps;
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('"steps" must be an array of strings.');
  return raw.map((s) => {
    if (typeof s !== 'string' || s.trim() === '') {
      throw new Error('"steps" entries must be non-empty strings.');
    }
    return s.trim();
  });
}

const saveRecipeTool: CoachTool = {
  name: 'save_recipe',
  description:
    'Save a new recipe. Lines are priced automatically (catalog now, estimate on open) — ' +
    'never tell the user to link anything.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      servings: { type: 'number', description: 'Default 1.' },
      ingredients: {
        type: 'array',
        description: 'Up to 40 lines as written, e.g. "200 g chicken thighs".',
        items: {
          type: 'object',
          properties: {
            raw: { type: 'string' },
            qty: { type: 'number' },
            unit: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['raw'],
          additionalProperties: false,
        },
      },
      steps: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
    },
    required: ['title', 'ingredients'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input) => {
    const args = asRecord(input);
    const title = reqString(args, 'title');
    const servings = optNumber(args, 'servings') ?? 1;
    if (servings <= 0) throw new Error('"servings" must be > 0.');
    const ingredients = parseRecipeIngredients(args);
    parseStepsArray(args);
    return `Save recipe "${title}" — ${plural(ingredients.length, 'ingredient')}, ${plural(servings, 'serving')}`;
  },
  execute: (db, input) => {
    const args = asRecord(input);
    const servings = optNumber(args, 'servings') ?? 1;
    if (servings <= 0) throw new Error('"servings" must be > 0.');
    const id = createRecipe(db, {
      title: reqString(args, 'title'),
      source: 'ai',
      servings,
      steps: parseStepsArray(args),
      notes: optString(args, 'notes') ?? null,
      ingredients: parseRecipeIngredients(args).map((i) => ({
        raw_text: i.raw,
        qty: i.qty ?? undefined,
        unit: i.unit ?? undefined,
        name: i.name ?? undefined,
      })),
    });
    // The deterministic pricing pass, immediately (0034). Offline, free, and
    // the reason this tool no longer has to warn about "not computed": every
    // line stating a weight that matches a catalog food exactly is priced
    // before the confirmation message is even written. The rest are priced by
    // the model pass when the recipe is opened.
    const priced = catalogResolveRecipe(db, id);
    return json({
      saved: true,
      id,
      pricedFromCatalog: priced.resolved,
      awaitingEstimate: priced.remaining,
    });
  },
};

// --- set_nutrition_targets (0015: the versioned daily target set) ------------
//
// THE OWNER-REPORTED HOLE. The Coach told the owner *"nothing in your profile or
// protocols defines a kcal/protein/carb target"* about a feature they use, and
// then offered — in the same breath — "tell me a target and I'll track
// adherence", which it had no way to honour. The read half is fixed in
// read-tools.ts (get_today_snapshot.nutritionTargets); this is the offer.
//
// Targets are APPEND-ONLY versions, exactly like protocol_versions: saving
// inserts a row effective today and never mutates the past, so "was I under in
// March?" is still judged against March's numbers. That is also why this is a
// COMPLETE SET, not a patch — the same rule update_protocol enforces, for the
// same reason: a version means the whole thing, and a metric omitted from the
// new version has no target from today on. Approving that has to be legible, so
// the card names every drop by name.
//
// created_by is 'ai' by construction, which is what the targets screen renders
// as "set by Coach". A user reading Eat › Daily targets must be able to see
// whose numbers those are.

/** The five target columns, in the order the editor screen lays them out. */
const TARGET_FIELDS = ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g'] as const;
type TargetField = (typeof TARGET_FIELDS)[number];

const TARGET_LABELS: Record<TargetField, string> = {
  kcal: 'kcal',
  protein_g: 'g protein',
  carbs_g: 'g carbs',
  fat_g: 'g fat',
  fiber_g: 'g fiber',
};

/** "2400 kcal", "180 g protein" — integers stay integers, no Intl. */
function targetPart(field: TargetField, value: number): string {
  const n = Math.round(value * 10) / 10;
  return field === 'kcal' ? `${n} kcal` : `${n} ${TARGET_LABELS[field]}`;
}

function renderTargetSet(values: Partial<Record<TargetField, number | null>>): string {
  const parts = TARGET_FIELDS.filter((f) => values[f] != null && values[f]! > 0).map((f) =>
    targetPart(f, values[f]!)
  );
  return parts.length > 0 ? parts.join(' · ') : 'nothing';
}

/**
 * Validated target set, shared by summary and execute.
 *
 * Every value must be POSITIVE, not merely non-negative, even though the schema
 * CHECK allows 0 on the macros. That is the targets screen's own rule and it is
 * load-bearing: `dayFigure` (src/lib/nutrition/remaining.ts) treats a
 * non-positive target as NO target — it is what a progress rule divides by — so
 * a stored 0 would be user intent that every reader silently discards. Omitting
 * the field is the same intent, stated the way the app already reads.
 */
function parseTargets(input: Record<string, unknown>): Partial<Record<TargetField, number>> {
  const args = asRecord(input);
  const out: Partial<Record<TargetField, number>> = {};
  for (const field of TARGET_FIELDS) {
    const value = optNumber(args, field);
    if (value === undefined) continue;
    if (value <= 0) {
      throw new Error(
        `"${field}" must be greater than 0 — omit it to drop that target, never send 0.`
      );
    }
    out[field] = value;
  }
  if (Object.keys(out).length === 0) {
    throw new Error(
      'Set at least one of kcal, protein_g, carbs_g, fat_g, fiber_g. This is the COMPLETE new ' +
        'target set, so an empty call would mean "no targets at all".'
    );
  }
  return out;
}

const setNutritionTargetsTool: CoachTool = {
  name: 'set_nutrition_targets',
  description:
    "The user's daily nutrition targets — kcal, protein_g, carbs_g, fat_g, fiber_g — as the " +
    'COMPLETE new set (see VERSIONED SETS). Use when the user states a goal ("I want 180 g of ' +
    'protein a day") or agrees to one you proposed. Omit a value to have no target for it.',
  inputSchema: {
    type: 'object',
    properties: {
      kcal: { type: 'number', exclusiveMinimum: 0 },
      protein_g: { type: 'number', exclusiveMinimum: 0 },
      carbs_g: { type: 'number', exclusiveMinimum: 0 },
      fat_g: { type: 'number', exclusiveMinimum: 0 },
      fiber_g: { type: 'number', exclusiveMinimum: 0 },
      notes: { type: 'string', description: 'One line: why these numbers.' },
    },
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db, context) => {
    const args = asRecord(input);
    const next = parseTargets(args);
    const current = activeNutritionTargets(db, todayISODate(context.now));
    const parts = [`Set daily targets: ${renderTargetSet(next)}`];
    if (current) {
      const before = renderTargetSet(current);
      const after = renderTargetSet(next);
      if (before !== after) parts.push(`was ${before}`);
      // A DROP is the one consequence approving this can hide: the user says
      // "make it 180 g protein", the model sends protein alone, and the kcal
      // target they have been eating to for months is gone. Name it.
      const dropped = TARGET_FIELDS.filter(
        (f) => current[f] != null && current[f]! > 0 && next[f] === undefined
      );
      if (dropped.length > 0) {
        parts.push(
          `drops the ${dropped.map((f) => (f === 'kcal' ? 'kcal' : TARGET_LABELS[f].slice(2))).join(' and ')} target${dropped.length === 1 ? '' : 's'}`
        );
      }
    }
    return parts.join(' — ');
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const next = parseTargets(args);
    const today = todayISODate(context.now);
    const id = setNutritionTargets(db, {
      effective_date: today,
      kcal: next.kcal ?? null,
      protein_g: next.protein_g ?? null,
      carbs_g: next.carbs_g ?? null,
      fat_g: next.fat_g ?? null,
      fiber_g: next.fiber_g ?? null,
      created_by: 'ai',
      notes: optString(args, 'notes') ?? null,
    });
    return json({ set: true, id, effectiveFrom: today, targets: next });
  },
};

// --- log_screening_done (0007) ----------------------------------------------
//
// The write half of get_screenings, and deliberately the ONLY one. Recording
// that a screening HAPPENED is a fact the user reports in conversation ("had my
// DEXA last Thursday"), and leaving it unwritable is what makes the ledger drift
// out of date. Choosing a screening's cadence is a different act — "colonoscopy
// every five years or ten" is a clinical decision, and CLAUDE.md §6 puts those
// with a physician, not with this tool. So the Coach can close a cycle it is
// told about; it cannot invent one. Adding or re-scheduling a screening stays on
// app/screening-form.tsx.

/** Resolve a screening id → its row, with a message pointing at the fix. */
function requireScreening(db: Database, id: string) {
  const row = getScreening(db, id);
  if (!row) throw new Error(`No screening with id ${id}. Call get_screenings first.`);
  return row;
}

const logScreeningDoneTool: CoachTool = {
  name: 'log_screening_done',
  description:
    'Record that a tracked screening was completed, which rolls its cadence forward (next due ' +
    '= that date + its interval). Get the id from get_screenings. Pass "date" when it happened ' +
    'on an earlier day — the cadence is computed from the date you give, so a wrong one skews ' +
    'every future due date. Use when the user says they had a scan, exam or panel done.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'From get_screenings.' },
      ...DATE_PROPERTY,
    },
    required: ['id'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input, db, context) => {
    const args = asRecord(input);
    const screening = requireScreening(db, reqString(args, 'id'));
    const on = logDate(args, context.now);
    // Show the CONSEQUENCE, not just the act: rolling a decennial screening a
    // month early moves the next one by a month, and the user has to see the
    // date they are agreeing to. Derived through the repository's own
    // addMonthsClamped so the card cannot disagree with the row.
    const nextDue = screening.interval_months
      ? addMonthsClamped(on, screening.interval_months)
      : null;
    return (
      `Mark "${screening.name}" done ${on}` +
      (nextDue ? ` — next due ${nextDue}` : ' — one-off, nothing scheduled after it')
    );
  },
  execute: (db, input, context) => {
    const args = asRecord(input);
    const screening = requireScreening(db, reqString(args, 'id'));
    const on = logDate(args, context.now);
    markScreeningDone(db, screening.id, on);
    const updated = requireScreening(db, screening.id);
    return json({
      logged: true,
      id: screening.id,
      name: screening.name,
      lastCompleted: updated.last_completed,
      nextDue: updated.next_due,
    });
  },
};

// --- save_knowledge_entry (the knowledge base, 0035) -------------------------

/**
 * The Coach's one write path into the knowledge base
 * (docs/knowledge-subapp.md §6).
 *
 * ## Why the card can be this compact
 *
 * `Save knowledge entry "<title>" · <topic> · <N> words` names WHAT and HOW
 * MUCH, and nothing else — which would be a poor confirmation for a multi-
 * paragraph document if the card were the only thing on screen. It isn't: the
 * doctrine (system-prompt.ts TOOL_DOCTRINE) requires the model to present the
 * drafted entry VERBATIM in its message before calling, so the body the user
 * approves sits directly above the card. The card names the commitment; the
 * message is the content. Putting the whole body in `confirmSummary` instead
 * would be a wall of text in a one-line slot, and the user would stop reading
 * it — which is the failure mode a confirmation gate exists to prevent.
 *
 * ## What it deliberately cannot do
 *
 * There is no `get_knowledge_entry` and no Coach edit/archive path. Reading is
 * covered by `search_history`, which already returns knowledge excerpts with
 * citations; editing is the user's act in the UI, consistent with "editing or
 * deleting anything already logged" living in UNCOVERED_DOMAINS. Both are
 * recorded as deliberately-out in the spec, with the revisit trigger: if real
 * transcripts show truncated-doctrine answers, add the read tool BATCHED with
 * the next registry change.
 */
const saveKnowledgeEntryTool: CoachTool = {
  name: 'save_knowledge_entry',
  // TRIMMED BEFORE IT SHIPPED (db/coach-eval.test.mjs §6: "the next addition
  // trims"). The first draft restated three rails the system prompt's cached
  // Memory-and-knowledge bullet now carries — invitation-only, present the body
  // before calling, and the memory/knowledge line — which is the exact
  // eight-descriptions-say-it-eight-times duplication that comment was written
  // about. What stays is only what the doctrine does NOT say: what the tool
  // writes, and the topic vocabulary, which is data the prompt has no business
  // carrying.
  description:
    'Save ONE entry to the user’s knowledge base. `personal` = a durable fact about THEM, too ' +
    'long for a one-line memory; `scientific` = how something works, or a stance they commit ' +
    'to. Only on their request or invitation, and present the entry in your message first.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'One line: what the entry commits to.' },
      // REQUIRED, with no per-property description of its own (0044). Required
      // rather than defaulted because the default would be wrong in exactly the
      // case that matters: a model omitting the field is usually one that has
      // just been told something about the USER, and silently filing that under
      // `scientific` puts a fact about his knee in with the articles. The two
      // enum values are defined once, in the description above — repeating them
      // here is the eight-descriptions-say-it-eight-times duplication that
      // db/coach-eval.test.mjs §6 exists to punish.
      section: { type: 'string', enum: ['personal', 'scientific'] },
      topic: {
        type: 'string',
        description:
          'cardiovascular, recovery, training, sleep, metabolic, method, supplements, ' +
          'lifestyle, or a new lowercase word.',
      },
      body: {
        type: 'string',
        description:
          'The entry in paragraphs, citable. Blank lines separate paragraphs and are kept.',
      },
    },
    required: ['title', 'section', 'topic', 'body'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: (input) => {
    const args = asRecord(input);
    const title = reqString(args, 'title');
    const topic = reqString(args, 'topic');
    const body = reqString(args, 'body');
    const words = body.trim().split(/\s+/).length;
    // The section is on the CARD because it is a consequence the user is
    // approving: it decides which half of the base the entry can be found in
    // afterwards, and "personal" is the one he would want to catch being wrong.
    const section = reqEnum(args, 'section', KNOWLEDGE_SECTIONS);
    return `Save ${section} entry "${title}" · ${topic} · ${words} words`;
  },
  execute: (db, input) => {
    const args = asRecord(input);
    // The SAME repository path the editor and the import review screen use —
    // chunking included — so a Coach-saved entry is indistinguishable from a
    // hand-written one downstream, and is retrievable the moment it lands.
    const id = saveKnowledgeEntry(db, {
      title: reqString(args, 'title'),
      topic: reqString(args, 'topic'),
      body: reqString(args, 'body'),
      section: reqEnum(args, 'section', KNOWLEDGE_SECTIONS),
      source: 'coach',
    });
    return json({ saved: true, id });
  },
};

export const WRITE_TOOLS: CoachTool[] = [
  logMetricTool,
  logMealTool,
  logWorkoutTool,
  logSymptomTool,
  logCaptureTool,
  logNoteTool,
  setNutritionTargetsTool,
  logScreeningDoneTool,
  rememberTool,
  forgetTool,
  adjustTodayTool,
  updateProtocolTool,
  setModeTool,
  createExperimentTool,
  completeExperimentTool,
  abandonExperimentTool,
  setReminderTool,
  completeReminderTool,
  dismissReminderTool,
  addGroceryItemsTool,
  completeGroceryItemsTool,
  addRecipeToGroceryListTool,
  logRecipeTool,
  saveRecipeTool,
  saveKnowledgeEntryTool,
];
