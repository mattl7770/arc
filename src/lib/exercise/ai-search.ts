/**
 * AI exercise search — "name it, describe it, or say what you want to do" →
 * exercises. The third catalog door beside browse and the manual custom form
 * (docs/exercise-subapp.md): the model sees the user's words plus the CATALOG
 * INDEX (id + name of every live exercise — small, ~70 rows) and answers with
 * ids to MATCH and, only when nothing fits, full definitions to CREATE.
 * Everything is validated against ARC's own enums — the model proposes, the
 * parser disposes — and creations land in the picker as review cards, never
 * silently.
 *
 * Mirrors src/lib/nutrition/estimate.ts / import-workout.ts: pure builder +
 * parser (headless-tested), the one impure model call through the Coach's
 * client, guarded expo/fetch.
 */
import type { Database } from '@/lib/db/database';
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { type FetchLike, runCoachTurn, type WireMessage } from '@/lib/ai/model-client';
import { getExercise, listExercises } from '@/lib/db/repositories/exercise-catalog';
import type {
  CatalogExercise,
  Equipment,
  LoggingType,
  Mechanic,
  MovementPattern,
  Muscle,
  NewExercise,
} from './types';

// --- Types -------------------------------------------------------------------

export type ExerciseSearchResult = {
  /** Existing catalog exercises the model matched, resolved and in its order. */
  matches: CatalogExercise[];
  /** Vetted definitions for movements the catalog lacks — shown as review cards. */
  creations: NewExercise[];
  /** One short model note ("closest existing is X; created Y for the cable version"). */
  note: string | null;
};

/** Thrown when no model key is configured (the UI points the user to Settings). */
export class ExerciseSearchUnavailableError extends Error {
  constructor() {
    super('AI search needs a model key — set one in the Coach settings.');
    this.name = 'ExerciseSearchUnavailableError';
  }
}

/** Whether AI search can run — a model key is configured. */
export function isExerciseSearchAvailable(): boolean {
  return apiKeyStore.has();
}

function loadStreamingFetch(): FetchLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo/fetch') as { fetch?: unknown };
    return (mod.fetch ?? null) as FetchLike | null;
  } catch {
    return null;
  }
}

// --- Enum guards (the model proposes, these dispose) -------------------------

const MUSCLES: Muscle[] = [
  'chest',
  'front_delts',
  'side_delts',
  'rear_delts',
  'lats',
  'upper_back',
  'lower_back',
  'traps',
  'biceps',
  'triceps',
  'forearms',
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'abs',
];
const EQUIPMENT: Equipment[] = [
  'barbell',
  'dumbbell',
  'kettlebell',
  'cable',
  'machine',
  'smith',
  'bodyweight',
  'band',
  'ez_bar',
  'trap_bar',
  'plate',
  'medicine_ball',
  'suspension',
  'bench',
  'pullup_bar',
  'other',
];
const PATTERNS: MovementPattern[] = [
  'squat',
  'hinge',
  'lunge',
  'push_h',
  'push_v',
  'pull_h',
  'pull_v',
  'carry',
  'rotation',
  'core',
  'locomotion',
];
const LOGGING_TYPES: LoggingType[] = [
  'weight_reps',
  'bodyweight_reps',
  'weighted_bodyweight',
  'assisted_bodyweight',
  'duration',
  'weight_duration',
  'distance_duration',
];
const MECHANICS: Mechanic[] = ['compound', 'isolation'];

const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | null =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;

const listOf = <T extends string>(allowed: readonly T[], value: unknown): T[] => {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const v of value) {
    const ok = oneOf(allowed, v);
    if (ok && !out.includes(ok)) out.push(ok);
  }
  return out;
};

// --- The request -------------------------------------------------------------

export const EXERCISE_SEARCH_SYSTEM_PROMPT = [
  'You resolve a lifter’s request — an exercise name, a description of a movement, or a',
  'goal like "something for rear delts with just dumbbells" — against a fitness app’s',
  'exercise catalog. The catalog index (id + name) is supplied with each request.',
  '',
  'Rules:',
  '- STRONGLY prefer matching existing catalog entries: return their ids in "matches",',
  '  best first, up to 5. A different grip/stance of an existing movement is a match.',
  '- Only when the catalog genuinely lacks the movement, define it in "created" (at most',
  '  2): give its common English name, equipment, primary/secondary muscles, movement',
  '  pattern, mechanic, how it is logged, whether it is unilateral, and 2–4 short',
  '  instruction steps.',
  '- Never invent exotic exercises for a vague ask — vague asks get matches.',
  '- One short sentence of guidance may go in "note"; null otherwise.',
  '',
  'Vocabulary (use EXACTLY these tokens):',
  `- muscles: ${MUSCLES.join(', ')}`,
  `- equipment: ${EQUIPMENT.join(', ')}`,
  `- movementPattern: ${PATTERNS.join(', ')} (or null for isolation work)`,
  `- mechanic: ${MECHANICS.join(', ')}`,
  `- loggingType: ${LOGGING_TYPES.join(', ')}`,
  '',
  'Respond with ONLY a JSON object, no prose, matching:',
  '{"matches": [{"id": string}], "created": [{"name": string, "equipment": string,',
  ' "primaryMuscles": [string], "secondaryMuscles": [string], "movementPattern": string|null,',
  ' "mechanic": string, "loggingType": string, "unilateral": boolean,',
  ' "instructions": [string]}], "note": string|null}',
].join('\n');

export type ExerciseSearchRequest = {
  system: string;
  messages: { role: 'user'; content: string }[];
};

/** Build the model request: the ask + the catalog index it resolves against. */
export function buildExerciseSearchRequest(
  query: string,
  catalogIndex: { id: string; name: string }[]
): ExerciseSearchRequest {
  const index = catalogIndex.map((e) => `${e.id} :: ${e.name}`).join('\n');
  return {
    system: EXERCISE_SEARCH_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Catalog index:\n${index}\n\nRequest: ${query.trim()}`,
      },
    ],
  };
}

// --- Parsing (pure, headless-tested) -----------------------------------------

export type ParsedExerciseSearch = {
  matchIds: string[];
  creations: NewExercise[];
  note: string | null;
};

/**
 * Parse and validate the model's JSON reply. Ids are kept as strings (the
 * caller resolves them against the DB and drops unknowns); every enum value is
 * checked against ARC's own vocabularies and a creation missing its essentials
 * (name, valid equipment/loggingType, ≥1 valid primary muscle) is dropped
 * whole — half a definition is worse than none. Tolerant of ```json fences.
 */
export function parseExerciseSearch(replyText: string): ParsedExerciseSearch {
  const start = replyText.indexOf('{');
  const end = replyText.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Exercise search reply contained no JSON object.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(replyText.slice(start, end + 1));
  } catch {
    throw new Error('Exercise search reply was not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Exercise search reply was not a JSON object.');
  }
  const obj = raw as Record<string, unknown>;

  const matchIds: string[] = [];
  for (const m of Array.isArray(obj.matches) ? obj.matches.slice(0, 5) : []) {
    if (typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string') {
      const id = (m as { id: string }).id.trim();
      if (id !== '' && !matchIds.includes(id)) matchIds.push(id);
    }
  }

  const creations: NewExercise[] = [];
  for (const entry of Array.isArray(obj.created) ? obj.created.slice(0, 2) : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    const equipment = oneOf(EQUIPMENT, e.equipment);
    const loggingType = oneOf(LOGGING_TYPES, e.loggingType);
    const primaryMuscles = listOf(MUSCLES, e.primaryMuscles);
    if (name === '' || !equipment || !loggingType || primaryMuscles.length === 0) continue;
    const secondary = listOf(MUSCLES, e.secondaryMuscles).filter(
      (m) => !primaryMuscles.includes(m)
    );
    const instructions = Array.isArray(e.instructions)
      ? e.instructions
          .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
          .map((s) => s.trim())
          .slice(0, 6)
      : [];
    creations.push({
      name,
      equipment,
      loggingType,
      movementPattern: oneOf(PATTERNS, e.movementPattern),
      mechanic: oneOf(MECHANICS, e.mechanic),
      unilateral: e.unilateral === true,
      primaryMuscles,
      secondaryMuscles: secondary,
      ...(instructions.length > 0 ? { instructions } : {}),
    });
  }

  const note = typeof obj.note === 'string' && obj.note.trim() !== '' ? obj.note.trim() : null;
  if (matchIds.length === 0 && creations.length === 0) {
    throw new Error('Exercise search reply had no usable results.');
  }
  return { matchIds, creations, note };
}

/** Resolve parsed match ids against the DB, dropping unknowns/archived-deleted. */
export function resolveSearchMatches(
  db: Database,
  parsed: ParsedExerciseSearch
): ExerciseSearchResult {
  const matches: CatalogExercise[] = [];
  for (const id of parsed.matchIds) {
    const ex = getExercise(db, id);
    if (ex) matches.push(ex);
  }
  return { matches, creations: parsed.creations, note: parsed.note };
}

// --- The model call ----------------------------------------------------------

/**
 * One search turn through the Coach's model client (no tools). Throws
 * {@link ExerciseSearchUnavailableError} when no key/fetch. Creations are NOT
 * written — the picker shows them as review cards the user confirms.
 */
export async function searchExercisesWithAI(
  db: Database,
  query: string,
  signal?: AbortSignal
): Promise<ExerciseSearchResult> {
  const apiKey = apiKeyStore.get();
  const fetchImpl = loadStreamingFetch();
  if (!apiKey || !fetchImpl) throw new ExerciseSearchUnavailableError();

  const index = listExercises(db).map((e) => ({ id: e.id, name: e.name }));
  const req = buildExerciseSearchRequest(query, index);
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
    throw new Error('The model declined this search.');
  }
  return resolveSearchMatches(db, parseExerciseSearch(text.length > 0 ? text : result.text));
}
