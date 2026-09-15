/**
 * **AI add-exercise** — the model writes a catalog ENTRY, never a search result.
 *
 * Owner, 2026-09-14 (backlog C12): *"ai add exercise replaces ai search (search
 * catalog first)."* This module is what replaced `ai-search.ts`, and the
 * difference is the whole item.
 *
 * ## What the old door did, and why it is gone
 *
 * AI search sent the model the CATALOG INDEX — every live movement's id and
 * name — and asked it to pick. That is a retrieval problem ARC already solves
 * better than a model can, offline, deterministically, in about a millisecond:
 * A7's ranked matcher (./match.ts) folds plurals and punctuation, reads aliases,
 * tolerates transposition, and answers "lat pulldowns", "pull-downs",
 * "skullcrusher" and "bnech press" without a network. Paying a model round-trip
 * to re-derive that was the expensive way to be less reliable — and it could
 * return an id for a movement that had since been archived, or invent one.
 *
 * So the search is the catalog's, and the model is asked only the question the
 * catalog cannot answer: **define a movement ARC does not have.** The picker
 * offers the door only when `hasConfidentMatch` says nothing above the weakest
 * tier matched (./match.ts), which is what "catalog first" means in code.
 *
 * ## What comes back
 *
 * One whole `exercises` row's worth of facts — name, aliases, equipment,
 * primary/secondary muscles, `measures` (0046), `logging_type`, pattern,
 * mechanic, unilateral, instructions — rendered for review and written only
 * when the owner taps Save, marked `source: 'ai'` (0056). Never silently: those
 * muscles go on to feed `exercise_muscles`, and through it muscle freshness,
 * weekly volume and the body figure, so a wrong secondary muscle is not a
 * cosmetic error — it is a number in a rollup with no visible origin.
 *
 * **The model proposes, this file disposes.** Every enum is checked against
 * ARC's own vocabulary and an entry missing an essential (a name, a legal
 * equipment, a legal logging type, at least one muscle from the SIXTEEN) is
 * rejected whole rather than half-kept. Half a definition is worse than none:
 * it looks like a catalog entry and is not one.
 *
 * Mirrors src/lib/nutrition/estimate.ts / import-workout.ts: pure builder +
 * pure parser (headless-tested in db/exercise-ai.test.mjs), the one impure model
 * call through the Coach's client, guarded expo/fetch.
 */
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { type FetchLike, runCoachTurn, type WireMessage } from '@/lib/ai/model-client';
import { ALL_MEASURES, MEASURES_FOR_LOGGING_TYPE, type Measures } from './measures';
import type {
  Equipment,
  LoggingType,
  Mechanic,
  MovementPattern,
  Muscle,
  NewExercise,
} from './types';

/** Thrown when no model key is configured (the UI points the user to Settings). */
export class AiExerciseUnavailableError extends Error {
  constructor() {
    super('Adding with AI needs a model key — set one in the Coach settings.');
    this.name = 'AiExerciseUnavailableError';
  }
}

/** Whether the AI door can be drawn at all — a model key is configured. */
export function isAiExerciseAvailable(): boolean {
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

/**
 * ARC's sixteen muscles, and the boundary the brief calls out by name: anything
 * outside this list is rejected here rather than reaching `exercise_muscles`,
 * whose CHECK would otherwise fail the INSERT mid-transaction and roll the whole
 * movement back with an opaque error. Same sixteen as MUSCLE_ORDER
 * (./constants.ts) and as 0011's CHECK — three copies that must agree, which
 * db/exercise-ai.test.mjs asserts rather than trusts.
 */
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

/**
 * The one-shot prompt. No catalog index rides with it — that is the whole point
 * of catalog-first, and it is also why this prompt is a fraction of the retired
 * search prompt's size: the ~70-row index was the bulk of every request.
 *
 * Measured at ~430 tokens of system prompt (db/exercise-ai.test.mjs §6 asserts
 * the ceiling). ARC has no `ESTIMATOR_PROMPT_CEILING` pattern for one-off
 * prompts — only the Coach's registry-wide budget in db/coach-eval.test.mjs §6,
 * which this is not part of (it is a separate turn with no tools) — so the test
 * pins a number rather than inheriting one.
 */
export const AI_EXERCISE_SYSTEM_PROMPT = [
  'Write ONE catalog entry for a training movement. The user already searched the app’s',
  'exercise catalog and it has nothing like this; define the movement, do not find it.',
  '',
  'Rules:',
  '- "name": the common English name, title case ("Landmine Press").',
  '- "aliases": 0-4 other names the SAME movement is written under — abbreviations and',
  '  word-order variants, not descriptions. The app’s search matches on these.',
  '- Muscles: at least one primary. Only the tokens below, never any others.',
  '- "measures" is what one SET records: "reps,load" for an ordinary lift, "reps" for',
  '  bodyweight, "time" for a plank, "time,distance" for a run, "load,distance" for a',
  '  carry. Exact comma-joined string, in the order reps,load,time,distance.',
  '- 2-4 short instruction steps.',
  '- If this is not a real, specific movement, return {"entry": null}.',
  '',
  'Vocabulary (use EXACTLY these tokens):',
  `- muscles: ${MUSCLES.join(', ')}`,
  `- equipment: ${EQUIPMENT.join(', ')}`,
  `- movementPattern: ${PATTERNS.join(', ')} (or null for isolation work)`,
  `- mechanic: ${MECHANICS.join(', ')}`,
  `- loggingType: ${LOGGING_TYPES.join(', ')}`,
  `- measures: ${ALL_MEASURES.join(' | ')}`,
  '',
  'Respond with ONLY a JSON object, no prose, matching:',
  '{"entry": {"name": string, "aliases": [string], "equipment": string,',
  ' "primaryMuscles": [string], "secondaryMuscles": [string], "movementPattern": string|null,',
  ' "mechanic": string, "loggingType": string, "measures": string, "unilateral": boolean,',
  ' "instructions": [string]}, "note": string|null}',
].join('\n');

export type AiExerciseRequest = {
  system: string;
  messages: { role: 'user'; content: string }[];
};

/**
 * Build the model request: the user's words, and nothing else. The catalog is
 * deliberately absent — it was already searched, and sending it would invite the
 * model to answer with a movement the matcher has already ruled out.
 */
export function buildAiExerciseRequest(query: string): AiExerciseRequest {
  return {
    system: AI_EXERCISE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Movement: ${query.trim()}` }],
  };
}

// --- Parsing (pure, headless-tested) -----------------------------------------

/** A vetted entry plus the model's one optional sentence about it. */
export type ParsedAiExercise = { entry: NewExercise; note: string | null };

/**
 * Parse and validate the model's JSON reply into a savable catalog entry.
 *
 * REJECTS WHOLE, never half-keeps. An entry without a name, a legal equipment,
 * a legal `loggingType` or at least one muscle from ARC's sixteen throws, and
 * the caller reports it. The alternative — writing a row with, say, no primary
 * muscle — produces a catalog entry that is invisible to muscle freshness,
 * weekly volume and the body figure, which is the 2026-08-14 null-`exercise_id`
 * bug wearing a different hat.
 *
 * `measures` is taken from the model when it is one of the fifteen legal
 * canonical strings, and DERIVED from `loggingType` otherwise. Both directions
 * are needed: the derivation (MEASURES_FOR_LOGGING_TYPE, the one mapping) is
 * what every form in the app uses and cannot be wrong, but it also cannot
 * express a carry's load + distance — `loggingType` has no value for that — so
 * an explicit, legal `measures` wins where it disagrees. That is exactly the
 * escape hatch `NewExercise.measures` was added for in 0046.
 *
 * Tolerant of ```json fences.
 */
export function parseAiExercise(replyText: string): ParsedAiExercise {
  const start = replyText.indexOf('{');
  const end = replyText.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('The reply contained no JSON object.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(replyText.slice(start, end + 1));
  } catch {
    throw new Error('The reply was not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('The reply was not a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  const candidate = obj.entry;
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('That doesn’t look like a movement. Try naming it differently.');
  }
  const e = candidate as Record<string, unknown>;

  const name = typeof e.name === 'string' ? e.name.trim() : '';
  const equipment = oneOf(EQUIPMENT, e.equipment);
  const loggingType = oneOf(LOGGING_TYPES, e.loggingType);
  const primaryMuscles = listOf(MUSCLES, e.primaryMuscles);
  if (name === '' || !equipment || !loggingType || primaryMuscles.length === 0) {
    throw new Error('The entry came back incomplete. Try again, or add it by hand.');
  }
  // A muscle listed twice, or listed secondary AND primary, trips 0011's
  // UNIQUE(exercise_id, muscle) on the second INSERT and rolls the whole
  // exercise back. `createCustomExercise` dedupes too; doing it here as well
  // means the REVIEW CARD shows exactly what will be stored.
  const secondaryMuscles = listOf(MUSCLES, e.secondaryMuscles).filter(
    (m) => !primaryMuscles.includes(m)
  );
  const aliases = Array.isArray(e.aliases)
    ? [
        ...new Set(
          e.aliases
            .filter((a): a is string => typeof a === 'string')
            .map((a) => a.trim())
            .filter((a) => a !== '' && a.toLowerCase() !== name.toLowerCase())
        ),
      ].slice(0, 4)
    : [];
  const instructions = Array.isArray(e.instructions)
    ? e.instructions
        .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
        .map((s) => s.trim())
        .slice(0, 6)
    : [];
  const measures: Measures =
    (oneOf(ALL_MEASURES, e.measures) as Measures | null) ?? MEASURES_FOR_LOGGING_TYPE[loggingType];

  const entry: NewExercise = {
    name,
    equipment,
    loggingType,
    measures,
    movementPattern: oneOf(PATTERNS, e.movementPattern),
    mechanic: oneOf(MECHANICS, e.mechanic),
    unilateral: e.unilateral === true,
    primaryMuscles,
    secondaryMuscles,
    source: 'ai',
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(instructions.length > 0 ? { instructions } : {}),
  };
  const note = typeof obj.note === 'string' && obj.note.trim() !== '' ? obj.note.trim() : null;
  return { entry, note };
}

// --- The model call ----------------------------------------------------------

/**
 * One turn through the Coach's model client (no tools), returning a vetted
 * entry. Throws {@link AiExerciseUnavailableError} when there is no key or no
 * streaming fetch.
 *
 * **Nothing is written here.** The picker renders the entry as a review card
 * and calls `createCustomExercise` only when the owner taps Save — the rule
 * every AI write path in ARC follows, and the reason `source: 'ai'` is worth
 * recording at all.
 */
export async function addExerciseWithAI(
  query: string,
  signal?: AbortSignal
): Promise<ParsedAiExercise> {
  const apiKey = apiKeyStore.get();
  const fetchImpl = loadStreamingFetch();
  if (!apiKey || !fetchImpl) throw new AiExerciseUnavailableError();

  const req = buildAiExerciseRequest(query);
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
    throw new Error('The model declined this request.');
  }
  return parseAiExercise(text.length > 0 ? text : result.text);
}
