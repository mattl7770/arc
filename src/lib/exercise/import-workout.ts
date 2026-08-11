/**
 * The AI workout-import seam: a photo of a workout logged in ANOTHER app (a
 * screenshot of Hevy/Strong/Fitbod, a whiteboard, a paper card) → a structured,
 * reviewable session. Mirrors src/lib/nutrition/estimate.ts, the blessed
 * pattern — and REUSES the Coach's on-device model client (`runCoachTurn`),
 * never a second HTTP/model stack:
 *
 *   1. {@link buildWorkoutParseRequest} builds the vision request (base64 image
 *      + an optional user note).
 *   2. {@link parseWorkoutImport} validates the model's JSON reply — never
 *      trusts its shape, clamps every number to the schema's own bounds.
 *   3. {@link groundWorkoutImport} matches exercise names against the local
 *      catalog (exact or leading-phrase on names and aliases), so a matched
 *      movement lands with its `exercise_id` and feeds freshness/e1RM history.
 *   4. The result ALWAYS lands in an editable review screen
 *      (app/workout-import.tsx) — model output is never auto-committed.
 *
 * Pure builder/parser/grounder so the headless tests can exercise all of it;
 * the only impure part (the model call) is isolated in
 * {@link importWorkoutFromPhoto} with the guarded expo/fetch require.
 */
import type { Database } from '@/lib/db/database';
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { type FetchLike, runCoachTurn, type WireMessage } from '@/lib/ai/model-client';
import { listExercises } from '@/lib/db/repositories/exercise-catalog';
import type { WorkoutKind } from './types';

// --- Types -------------------------------------------------------------------

export type ImportedSet = {
  reps: number | null;
  /** As read off the screenshot, in the unit it displayed. */
  weight: number | null;
  weightUnit: 'lb' | 'kg' | null;
  rpe: number | null;
};

export type ImportedExercise = {
  name: string;
  /** Catalog id when grounding found a confident match; null keeps free text. */
  exerciseId: string | null;
  sets: ImportedSet[];
};

export type ImportedWorkout = {
  /** The session's date when the screenshot shows one; null = unknown. */
  date: string | null;
  name: string;
  kind: WorkoutKind;
  durationMin: number | null;
  exercises: ImportedExercise[];
  /** Model-stated caveats worth showing in review ("date partially cropped"). */
  notes: string | null;
};

/** Thrown when no model key is configured (the UI points the user to Settings). */
export class WorkoutImportUnavailableError extends Error {
  constructor() {
    super('Workout import needs a model key — set one in the Coach settings.');
    this.name = 'WorkoutImportUnavailableError';
  }
}

/** Whether the import path can run — a model key is configured. */
export function isWorkoutImportAvailable(): boolean {
  return apiKeyStore.has();
}

/** Guarded expo/fetch (streams in RN; absent under node — see estimate.ts). */
function loadStreamingFetch(): FetchLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo/fetch') as { fetch?: unknown };
    return (mod.fetch ?? null) as FetchLike | null;
  } catch {
    return null;
  }
}

// --- The vision request ------------------------------------------------------

export type VisionTextBlock = { type: 'text'; text: string };
export type VisionImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/jpeg'; data: string };
};
export type VisionContentBlock = VisionTextBlock | VisionImageBlock;

export type WorkoutParseRequest = {
  system: string;
  messages: { role: 'user'; content: VisionContentBlock[] }[];
};

/**
 * The extraction system prompt. Transcribe-don't-invent is the whole game: an
 * imported log must contain exactly what the other app recorded — a hallucinated
 * set is worse than a missing one, and the review screen catches gaps.
 */
export const WORKOUT_PARSE_SYSTEM_PROMPT = [
  'You transcribe a workout logged in another fitness app (or on paper) from a photo, for',
  'import into a local training log. TRANSCRIBE, never invent: only record what is legible.',
  '',
  'Rules:',
  '- One entry per exercise, in the order shown; one entry per set with reps and weight.',
  '- Read the weight unit from the image (lb or kg). If it is genuinely not shown, use null.',
  '- Warmup sets marked as such in the source may be skipped; working sets must all land.',
  '- Bodyweight movements: weight null. Reps-only rows: weight null. Time-only rows: skip.',
  "- The session DATE: only if visible in the image (a header like 'Yesterday' is NOT a",
  '  date — use null unless an absolute date is shown). Format YYYY-MM-DD.',
  '- kind: "strength" for lifting, "cardio" for a run/ride/row log, "mobility" for',
  '  stretching/yoga, else "other".',
  '- durationMin: the total session duration if shown, else null.',
  '- RPE per set only when the source shows it.',
  '- Anything uncertain or cropped goes in notes, briefly.',
  '',
  'Respond with ONLY a JSON object, no prose, matching:',
  '{"date": "YYYY-MM-DD"|null, "name": string, "kind": "strength"|"cardio"|"mobility"|"other",',
  ' "durationMin": number|null, "exercises": [{"name": string, "sets": [{"reps": number|null,',
  ' "weight": number|null, "weightUnit": "lb"|"kg"|null, "rpe": number|null}]}],',
  ' "notes": string|null}',
].join('\n');

/** Build the model request — image first, then the ask (vision docs order). */
export function buildWorkoutParseRequest(
  base64Jpeg: string,
  userNote?: string
): WorkoutParseRequest {
  const content: VisionContentBlock[] = [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Jpeg } },
    {
      type: 'text',
      text: userNote?.trim()
        ? `Transcribe this workout for import. Extra context: ${userNote.trim()}`
        : 'Transcribe this workout for import.',
    },
  ];
  return { system: WORKOUT_PARSE_SYSTEM_PROMPT, messages: [{ role: 'user', content }] };
}

// --- Parsing (pure, headless-tested) -----------------------------------------

const KINDS: WorkoutKind[] = ['strength', 'cardio', 'mobility', 'other'];

function cleanNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < min || value >= max) return null;
  return value;
}

/**
 * Parse and validate the model's JSON reply. Never trusts the shape: every
 * number is clamped to the schema's own bounds (reps ≥ 0 int, weight under the
 * 1000 kg / ~2000 lb fat-finger CHECK, RPE 1–10), a malformed date becomes
 * null (the review screen asks), unknown kinds fall back to 'strength', and a
 * reply with no usable sets throws so the caller reports a failed parse rather
 * than logging an empty session. Tolerant of ```json fences / stray prose.
 */
export function parseWorkoutImport(replyText: string): ImportedWorkout {
  const start = replyText.indexOf('{');
  const end = replyText.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Workout import reply contained no JSON object.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(replyText.slice(start, end + 1));
  } catch {
    throw new Error('Workout import reply was not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Workout import reply was not a JSON object.');
  }
  const obj = raw as Record<string, unknown>;

  const date =
    typeof obj.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.date) ? obj.date : null;
  const kind = KINDS.includes(obj.kind as WorkoutKind) ? (obj.kind as WorkoutKind) : 'strength';
  const durationMin = cleanNumber(obj.durationMin, 1, 1000);

  const exercises: ImportedExercise[] = [];
  for (const entry of Array.isArray(obj.exercises) ? obj.exercises : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (name === '') continue;
    const sets: ImportedSet[] = [];
    for (const s of Array.isArray(e.sets) ? e.sets : []) {
      if (typeof s !== 'object' || s === null) continue;
      const set = s as Record<string, unknown>;
      const repsRaw = cleanNumber(set.reps, 0, 10000);
      const reps = repsRaw == null ? null : Math.round(repsRaw);
      const weightUnit = set.weightUnit === 'kg' || set.weightUnit === 'lb' ? set.weightUnit : null;
      // Bound in the unit's own terms, both strictly inside the canonical
      // <1000 kg CHECK once converted.
      const weight =
        weightUnit === 'kg' ? cleanNumber(set.weight, 0.5, 999) : cleanNumber(set.weight, 1, 1999);
      const rpe = cleanNumber(set.rpe, 1, 10.5);
      if (reps == null && weight == null) continue;
      sets.push({ reps, weight, weightUnit, rpe });
    }
    if (sets.length === 0) continue;
    exercises.push({ name, exerciseId: null, sets });
  }
  if (exercises.length === 0) {
    throw new Error('Workout import reply had no usable sets.');
  }

  const name =
    typeof obj.name === 'string' && obj.name.trim() !== '' ? obj.name.trim() : 'Imported workout';
  const notes = typeof obj.notes === 'string' && obj.notes.trim() !== '' ? obj.notes.trim() : null;
  return { date, name, kind, durationMin, exercises, notes };
}

// --- Grounding (pure over the Database interface) ----------------------------

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * A match confident enough to attach a catalog id: exact normalized name/alias,
 * or the imported name is the catalog name's leading phrase (multi-token only —
 * "bench" alone must not claim "Bench Press"; nutrition's grounding learned the
 * same lesson). Unmatched names stay free text, which the schema supports.
 */
function confidentMatchId(
  imported: string,
  catalog: { id: string; name: string; aliases: string[] }[]
): string | null {
  const n = normalize(imported);
  if (n === '') return null;
  for (const ex of catalog) {
    if (normalize(ex.name) === n) return ex.id;
    if (ex.aliases.some((a) => normalize(a) === n)) return ex.id;
  }
  if (n.split(' ').length < 2) return null;
  for (const ex of catalog) {
    const cn = normalize(ex.name);
    if (cn.startsWith(`${n} `) || n.startsWith(`${cn} `)) return ex.id;
  }
  return null;
}

/** Attach catalog ids where the name match is confident. */
export function groundWorkoutImport(db: Database, imported: ImportedWorkout): ImportedWorkout {
  const catalog = listExercises(db).map((e) => ({ id: e.id, name: e.name, aliases: e.aliases }));
  return {
    ...imported,
    exercises: imported.exercises.map((e) => ({
      ...e,
      exerciseId: confidentMatchId(e.name, catalog),
    })),
  };
}

// --- The model call ----------------------------------------------------------

/**
 * Parse a workout photo — one turn through the Coach's model client (no tools).
 * Throws {@link WorkoutImportUnavailableError} when no key is set or the
 * streaming fetch is absent. The result is NOT logged — the caller grounds it
 * and lands it in an editable review the user must confirm.
 */
export async function importWorkoutFromPhoto(
  base64Jpeg: string,
  userNote?: string,
  signal?: AbortSignal
): Promise<ImportedWorkout> {
  const apiKey = apiKeyStore.get();
  const fetchImpl = loadStreamingFetch();
  if (!apiKey || !fetchImpl) throw new WorkoutImportUnavailableError();

  const req = buildWorkoutParseRequest(base64Jpeg, userNote);
  let text = '';
  const result = await runCoachTurn(
    { apiKey, model: apiKeyStore.getModel(), fetchImpl },
    { system: req.system, messages: req.messages as unknown as WireMessage[], tools: [] },
    {
      onToken: (chunk) => {
        text += chunk;
      },
      signal,
      executeTool: async () => ({ content: '' }),
    }
  );
  if (result.stopReason === 'refusal') {
    throw new Error('The model declined to read this photo.');
  }
  return parseWorkoutImport(text.length > 0 ? text : result.text);
}
