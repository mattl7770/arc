/**
 * The AI meal-estimation seam: photo → itemized macros, description → itemized
 * macros. This is the nutrition sub-app's ONE model touchpoint — and it now
 * REUSES the Coach's on-device model client (`src/lib/ai/model-client.ts`'s
 * `runCoachTurn`), never a second HTTP/model stack:
 *   1. {@link buildMealEstimationRequest} builds the `AgenticRequest` the client
 *      consumes (system + one user message, with a base64 image block for photos).
 *   2. {@link estimateMeal} runs that request through `runCoachTurn` (no tools),
 *      using the same key (iOS Keychain, `api-key-store`) and streaming fetch
 *      (`expo/fetch`) as Coach chat, then {@link parseMealEstimate} validates
 *      the model's JSON reply.
 *   3. {@link groundMealEstimate} matches each item against the local catalog
 *      and re-prices it from known per-100 g values (Lose-It's own-history lever
 *      / MacroFactor's retrieve-then-generate). Raw LLM photo MAPE is ~36%,
 *      portion-dominated (research §1) — so results ALWAYS land in an editable
 *      review screen, saved source='ai_suggested' with per-item confidence,
 *      NEVER auto-committed.
 * Describe-in-words is the same pipeline minus the image block.
 *
 * `expo/fetch` is loaded through a guarded require (like api-key-store's) so
 * this module — whose pure builder/parser the headless tests import — never
 * fails to load in node, where the native/Expo fetch is absent.
 */
import type { Database } from '@/lib/db/database';
import { normalizeFoodName, searchFoods } from '@/lib/db/repositories/foods';
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { type FetchLike, runCoachTurn, type WireMessage } from '@/lib/ai/model-client';

import { itemForPortion } from './servings';
import type { EstimateConfidence, FoodRow } from './types';

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

/** Thrown when no model key is configured (the UI points the user to Settings). */
export class MealEstimationUnavailableError extends Error {
  constructor() {
    super('Meal estimation needs a model key — set one in the Coach settings.');
    this.name = 'MealEstimationUnavailableError';
  }
}

/**
 * Whether the estimation path can run — a model key is configured (same key the
 * Coach uses). The UI reads this to keep the "Describe or snap" affordance
 * honest; re-render via the Coach's useSessionKeySet() so it stays current.
 */
export function isMealEstimationAvailable(): boolean {
  return apiKeyStore.has();
}

/**
 * `expo/fetch` streams response bodies in React Native (the global fetch there
 * does not). Loaded through a guarded require so the node test loader — which
 * imports this module's pure functions — never fails on the missing module.
 */
function loadStreamingFetch(): FetchLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo/fetch') as { fetch?: unknown };
    return (mod.fetch ?? null) as FetchLike | null;
  } catch {
    return null;
  }
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
 * Estimate a meal from a photo or a description — one turn through the Coach's
 * model client (no tools). Throws {@link MealEstimationUnavailableError} when no
 * key is set or the streaming fetch is absent (pre-rebuild); the caller shows
 * an honest "connect a key" message. The returned estimate is NOT logged — the
 * caller grounds it ({@link groundMealEstimate}) and lands it in an editable
 * review the user must confirm.
 */
export async function estimateMeal(
  input: EstimateInput,
  signal?: AbortSignal
): Promise<MealEstimate> {
  const apiKey = apiKeyStore.get();
  const fetchImpl = loadStreamingFetch();
  if (!apiKey || !fetchImpl) throw new MealEstimationUnavailableError();

  const req = buildMealEstimationRequest(input);
  let text = '';
  const result = await runCoachTurn(
    { apiKey, model: apiKeyStore.getModel(), fetchImpl },
    { system: req.system, messages: req.messages as unknown as WireMessage[], tools: [] },
    {
      onToken: (chunk) => {
        text += chunk;
      },
      signal,
      // No tools in an estimation turn; the model answers in text.
      executeTool: async () => ({ content: '' }),
    }
  );
  if (result.stopReason === 'refusal') {
    throw new Error('The model declined to estimate this meal.');
  }
  return parseMealEstimate(text.length > 0 ? text : result.text);
}

/**
 * A catalog match confident enough to re-price from. A generic single-token
 * name ("rice", "chicken", "egg") is deliberately NOT confident — the top
 * substring hit for it is alphabetical noise ("rice" → "Rice cakes"), and
 * silently swapping the model's chicken-breast macros for rice-cake macros
 * would make the estimate worse while the review screen shows the same name and
 * confidence. So we ground only on an exact name match, or a multi-token name
 * that is the food's leading phrase ("chicken breast" → "Chicken breast,
 * cooked"). Everything else keeps the model's own numbers.
 */
function isConfidentMatch(itemNorm: string, foodNorm: string): boolean {
  if (foodNorm === itemNorm) return true;
  const tokens = itemNorm.split(' ').filter(Boolean);
  if (tokens.length < 2) return false;
  return foodNorm.startsWith(`${itemNorm} `) || foodNorm.startsWith(`${itemNorm},`);
}

/**
 * Ground an estimate against the on-device catalog: for a CONFIDENT name match
 * to a food with complete macros, RE-PRICE the whole item from that food's
 * per-100 g values at the estimated grams (setting foodId), so a "Chicken
 * breast" estimate inherits the seeded food's real macros. Everything else —
 * an ambiguous name, no match, or a match with incomplete macros — keeps the
 * model's own numbers verbatim, so grounding never produces a half-catalog,
 * half-model item. Confidence is untouched (portion uncertainty remains); the
 * review screen is the safety net for a wrong portion. Pure over the Database
 * interface, so it's headless-testable.
 */
export function groundMealEstimate(db: Database, estimate: MealEstimate): MealEstimate {
  const items = estimate.items.map((item) => {
    if (item.grams == null || item.grams <= 0) return item;
    const match: FoodRow | undefined = searchFoods(db, item.name, 1)[0];
    if (!match || !isConfidentMatch(normalizeFoodName(item.name), match.name_norm)) return item;
    // Only ground when the food carries every macro — a partial food would
    // leave the item's kcal contradicting its (kept-from-model) macros.
    if (
      match.kcal_100g == null ||
      match.protein_g_100g == null ||
      match.carbs_g_100g == null ||
      match.fat_g_100g == null
    ) {
      return item;
    }
    const priced = itemForPortion(match, { grams: item.grams });
    return {
      ...item,
      kcal: priced.kcal ?? item.kcal,
      protein_g: priced.protein_g ?? item.protein_g,
      carbs_g: priced.carbs_g ?? item.carbs_g,
      fat_g: priced.fat_g ?? item.fat_g,
      // Fiber may be genuinely absent on the food; keep the model's when so.
      fiber_g: priced.fiber_g ?? item.fiber_g,
      foodId: match.id,
    };
  });
  return { ...estimate, items };
}
