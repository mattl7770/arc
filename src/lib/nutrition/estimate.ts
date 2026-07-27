/**
 * The AI meal-estimation seam: photo → itemized macros, description → itemized
 * macros. This is the nutrition sub-app's ONE model touchpoint, and it is a
 * SEAM today, not a call — exactly like coach-service.ts before its model call
 * landed.
 *
 * REUSE, DON'T REBUILD (docs/nutrition-subapp.md §6): the Coach's on-device
 * model client (`src/lib/ai/model-client.ts` — `runCoachTurn`, the streaming
 * Messages-API loop, key in the iOS Keychain) is the ONE model path in the app.
 * That client lives on the Coach branch and is not on `main` yet, so this
 * module must NOT import it (it would break the build) and must NOT grow a
 * second HTTP/model stack. Instead it ships the *pure* pieces that plug into
 * that client with no second path:
 *   - {@link buildMealEstimationRequest} produces the exact request shape the
 *     client's `AgenticRequest` consumes (a system prompt + one user message,
 *     with a base64 image block for the photo case);
 *   - {@link parseMealEstimate} validates the model's JSON reply into a
 *     {@link MealEstimate}.
 * When the client merges, the integrator wires ~5 lines (see estimateMeal's
 * doc) — building the request here, running it through `runCoachTurn` with no
 * tools, and parsing the text. Nothing else in this module changes.
 *
 * The planned call (research: docs/nutrition-subapp.md §1 "Camera + vision"):
 *   1. photo → ~1024 px JPEG at ~0.65 quality (expo-image-manipulator) →
 *      base64 image block before the visual-estimation prompt. ≈1,369 vision
 *      tokens ≈ $0.001–0.004 per photo; only the compressed copy leaves device.
 *   2. Ground, don't trust: returned item names are matched against the local
 *      catalog + the user's recents (searchFoods / listRecentFoods); a hit
 *      swaps in known per-100 g macros scaled to the estimated grams. Raw LLM
 *      photo MAPE is ~36%, portion-dominated — so results ALWAYS land in an
 *      editable review screen, saved source='ai_suggested' with per-item
 *      confidence, never auto-committed.
 *   3. Describe-in-words is the same pipeline minus the image block.
 */
import type { EstimateConfidence } from './types';

export type EstimateInput =
  | { kind: 'text'; description: string }
  | { kind: 'photo'; base64Jpeg: string; mediaType: 'image/jpeg'; description?: string };

export type MealEstimateItem = {
  name: string;
  /** Estimated portion in grams; null when the model can only price energy. */
  grams: number | null;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
  confidence: EstimateConfidence;
  /** Set when the item was grounded to a catalog food (macros re-priced from
   * its per-100 g values); null means raw model numbers. */
  foodId: string | null;
};

export type MealEstimate = {
  /** A short meal title, e.g. "Salmon, rice and greens". */
  title: string;
  items: MealEstimateItem[];
  /** Model-stated caveats worth showing in review ("dressing not visible"). */
  notes: string | null;
};

/** Thrown while the Coach model client hasn't landed (or has no key). */
export class MealEstimationUnavailableError extends Error {
  constructor() {
    super('Meal estimation needs the on-device model (the Coach client) — not wired yet.');
    this.name = 'MealEstimationUnavailableError';
  }
}

/**
 * Whether the estimation path can run. Mirrors isCoachKeyConfigured — the UI
 * reads this to keep the "Describe or snap" affordance honest. Flips when the
 * Coach model client merges and a provider key is configured.
 */
export function isMealEstimationAvailable(): boolean {
  return false;
}

// --- The request the Coach client consumes (structurally == AgenticRequest) --
//
// These mirror the model client's wire types (`WireMessage` / content blocks in
// src/lib/ai/model-client.ts). Redeclared locally because that module is not on
// `main` yet and this file must not import it; at integration they are the same
// shapes, so the builder's output drops straight into `runCoachTurn`.

export type VisionTextBlock = { type: 'text'; text: string };
export type VisionImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/jpeg'; data: string };
};
export type VisionContentBlock = VisionTextBlock | VisionImageBlock;

export type MealEstimationRequest = {
  system: string;
  messages: { role: 'user'; content: VisionContentBlock[] }[];
};

/**
 * The visual-estimation system prompt. Peer-reviewed work (docs/nutrition-subapp.md
 * §1) shows prompt design materially moves accuracy: estimate portions from
 * visual cues, itemize, own the hidden-fat uncertainty, and return JSON only so
 * {@link parseMealEstimate} can consume it deterministically.
 */
export const MEAL_ESTIMATION_SYSTEM_PROMPT = [
  'You estimate the nutrition of a meal from a photo and/or a text description for a',
  'longevity-focused food logger. Be precise and calibrated, never confident beyond the',
  'evidence.',
  '',
  'Rules:',
  '- Itemize the meal: one entry per distinct food, not one blob.',
  '- Estimate each portion in grams from visual cues (plate size, utensils) and any text.',
  '- Give kcal and protein/carbs/fat grams per item; fiber grams when inferable, else null.',
  '- Set per-item confidence: "high" for clearly identified packaged/simple foods, "medium"',
  '  for typical mixed dishes, "low" when the food or portion is genuinely uncertain.',
  '- Account for likely hidden fats (cooking oil, butter, dressing) and say so in notes when',
  '  they materially affect the estimate.',
  '- Prefer underestimating an unknown over inventing precision.',
  '',
  'Respond with ONLY a JSON object, no prose, matching:',
  '{"title": string, "items": [{"name": string, "grams": number|null, "kcal": number,',
  ' "protein_g": number, "carbs_g": number, "fat_g": number, "fiber_g": number|null,',
  ' "confidence": "high"|"medium"|"low"}], "notes": string|null}',
].join('\n');

/**
 * Build the model request for a meal estimate — the exact shape the Coach
 * client's `runCoachTurn` takes (system + messages, no tools). The photo case
 * puts the image block before the text, as the vision docs recommend.
 */
export function buildMealEstimationRequest(input: EstimateInput): MealEstimationRequest {
  const content: VisionContentBlock[] = [];
  if (input.kind === 'photo') {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: input.mediaType, data: input.base64Jpeg },
    });
    content.push({
      type: 'text',
      text: input.description
        ? `Estimate this meal. Extra context: ${input.description}`
        : 'Estimate this meal from the photo.',
    });
  } else {
    content.push({ type: 'text', text: `Estimate this meal: ${input.description}` });
  }
  return {
    system: MEAL_ESTIMATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  };
}

const CONFIDENCES: EstimateConfidence[] = ['high', 'medium', 'low'];

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Parse and validate the model's JSON reply into a {@link MealEstimate}. Never
 * trusts the model's shape: unknown fields are dropped, missing macros default
 * to 0 (the review screen shows and lets the user fix them), an unknown
 * confidence falls back to 'low' (surface uncertainty, don't hide it), and a
 * reply with no usable items throws so the caller can tell the user the
 * estimate failed rather than logging an empty meal.
 *
 * Tolerant of a reply wrapped in ```json fences or surrounded by stray prose —
 * it extracts the outermost JSON object first.
 */
export function parseMealEstimate(replyText: string): MealEstimate {
  const start = replyText.indexOf('{');
  const end = replyText.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Meal estimate reply contained no JSON object.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(replyText.slice(start, end + 1));
  } catch {
    throw new Error('Meal estimate reply was not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Meal estimate reply was not a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items: MealEstimateItem[] = [];
  for (const entry of rawItems) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (name === '') continue;
    const confidence: EstimateConfidence = CONFIDENCES.includes(e.confidence as EstimateConfidence)
      ? (e.confidence as EstimateConfidence)
      : 'low';
    items.push({
      name,
      grams: num(e.grams),
      kcal: num(e.kcal) ?? 0,
      protein_g: num(e.protein_g) ?? 0,
      carbs_g: num(e.carbs_g) ?? 0,
      fat_g: num(e.fat_g) ?? 0,
      fiber_g: num(e.fiber_g),
      confidence,
      foodId: null,
    });
  }
  if (items.length === 0) {
    throw new Error('Meal estimate reply had no usable items.');
  }
  const title =
    typeof obj.title === 'string' && obj.title.trim() !== '' ? obj.title.trim() : 'Meal';
  const notes = typeof obj.notes === 'string' && obj.notes.trim() !== '' ? obj.notes.trim() : null;
  return { title, items, notes };
}

/**
 * Estimate a meal from a photo or a description. Today: always throws
 * {@link MealEstimationUnavailableError}; the contract is what ships. The UI
 * treats the error as "arrives with the Coach", identical to the mock Coach's
 * honesty rule — a nutrition number ARC invented would be worse than none.
 *
 * Integration when the Coach client is on `main` (do NOT add a second path):
 *
 *   import { runCoachTurn } from '@/lib/ai/model-client';
 *   const req = buildMealEstimationRequest(input);
 *   let text = '';
 *   await runCoachTurn(config, { ...req, tools: [] }, {
 *     onToken: (t) => { text += t; },
 *     executeTool: async () => ({ content: '' }), // no tools in this turn
 *   });
 *   return parseMealEstimate(text);
 *
 * `config` is the Coach's ModelClientConfig (its key + fetchImpl + model). The
 * grounding step (match items to the catalog, swap in known macros, set foodId)
 * runs on the returned MealEstimate before the review screen.
 */
export async function estimateMeal(_input: EstimateInput): Promise<MealEstimate> {
  throw new MealEstimationUnavailableError();
}
