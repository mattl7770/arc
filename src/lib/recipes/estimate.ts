/**
 * Pricing a recipe's ingredient lines **without asking the user to** (0034).
 *
 * Owner call, 2026-08-12, off a Coach-written stir-fry showing five "Not counted
 * yet" rows and five LINK buttons: *"…removing this whole 'linking' behavior in
 * exchange for it being done automatically behind the scenes."*
 *
 * ## What the old rule was really protecting
 *
 * 0031 made resolution explicit — a line carried macros only once the user had
 * picked a catalog food for it. That was never about the tapping. It was about
 * **provenance**: the danger is a number of unknown origin entering the rollup,
 * the logged meal and the day's totals wearing the same face as a number the
 * user asserted. So the tapping goes and the provenance stays, as
 * `recipe_ingredients.resolved_by`.
 *
 * ## Two passes, cheapest and most certain first
 *
 * 1. {@link catalogResolveRecipe} — **deterministic, offline, free.** For each
 *    unresolved line it reads a MASS quantity off the parsed overlay (g / kg /
 *    oz / lb — mass→mass is arithmetic, not a density guess) and looks for a
 *    CONFIDENT catalog match on the name. Confident means exact, or the line's
 *    name is the food's leading phrase — the same rule the meal estimator
 *    grounds with, and the same refusal the labs pipeline makes: `Testosterone`
 *    is a substring of `Testosterone, Free`, so a single generic token never
 *    matches. Lands as `resolved_by = 'catalog'`, which is the same data a hand
 *    pick would have produced.
 * 2. {@link resolveRecipeWithModel} — **one model turn, for what is left.**
 *    "2 tbsp butter" and "2 cloves garlic" have no mass on the line and no
 *    catalog food at that unit; a model can price both. Lands as
 *    `resolved_by = 'ai'` with `food_id` NULL and `micros` NULL, because there
 *    is no catalog food behind those numbers and a micronutrient nobody was
 *    asked for must not appear as a zero.
 *
 * Pass 1 runs on every save (including the Coach's `save_recipe`); pass 2 runs
 * from the recipe screen, once, when there is still something unpriced and a
 * model key exists. Neither ever overwrites a line the user resolved by hand.
 *
 * ## What this module refuses to do
 *
 * It never invents a quantity for a line that states none and that the model
 * declines to price — such a line stays unresolved and the screen says so.
 * "No data, no number" survives automation; what changed is who does the work,
 * not whether a number may be made up.
 */
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { type FetchLike, runCoachTurn, type WireMessage } from '@/lib/ai/model-client';
import type { Database } from '@/lib/db/database';
import { normalizeFoodName, searchFoods } from '@/lib/db/repositories/foods';
import {
  listIngredients,
  resolveIngredient,
  resolveIngredientByModel,
} from '@/lib/db/repositories/recipes';

import type { RecipeIngredientRow } from '@/lib/recipes/types';

/** Thrown when no model key is configured (the UI points the user at Settings). */
export class RecipePricingUnavailableError extends Error {
  constructor() {
    super('Pricing the remaining lines needs a model key — set one in Settings › Coach.');
    this.name = 'RecipePricingUnavailableError';
  }
}

/** Whether the model pass can run — the same key the Coach uses. */
export function isRecipePricingAvailable(): boolean {
  return apiKeyStore.has();
}

// --- Pass 1: the catalog, deterministically -----------------------------------

/** Mass units → grams. ONLY mass: a cup of flour and a cup of oil differ by
 *  density, and this module has no density data and will not pretend to. */
const GRAMS_PER_UNIT: Record<string, number> = {
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

/**
 * Grams stated by the line itself, or null. A line whose unit is volumetric or
 * countable ("2 tbsp", "2 cloves") yields null and goes to the model — which is
 * the honest outcome, not a failure.
 */
export function lineGrams(line: Pick<RecipeIngredientRow, 'qty' | 'unit'>): number | null {
  if (line.qty === null || line.qty <= 0 || line.unit === null) return null;
  const factor = GRAMS_PER_UNIT[line.unit];
  return factor === undefined ? null : line.qty * factor;
}

/**
 * A catalog match confident enough to price from — the meal estimator's rule,
 * kept identical on purpose.
 *
 * A generic single-token name ("rice", "chicken") is deliberately NOT
 * confident: the top substring hit for it is alphabetical noise ("rice" → "Rice
 * cakes"), and silently pricing a chicken breast as rice cakes would be worse
 * than leaving the line for the model. So: an exact name, or a multi-token name
 * that is the food's leading phrase ("chicken breast" → "Chicken breast,
 * cooked").
 */
export function isConfidentFoodMatch(itemNorm: string, foodNorm: string): boolean {
  if (foodNorm === itemNorm) return true;
  const tokens = itemNorm.split(' ').filter(Boolean);
  if (tokens.length < 2) return false;
  return foodNorm.startsWith(`${itemNorm} `) || foodNorm.startsWith(`${itemNorm},`);
}

/** What one automatic pass managed. */
export type ResolvePassResult = {
  /** Lines this pass priced. */
  resolved: number;
  /** Lines still unpriced afterwards (non-negligible). */
  remaining: number;
};

/**
 * Pass 1. Price every unresolved line that states a mass AND matches a catalog
 * food confidently. Offline, deterministic, and safe to re-run: a resolved line
 * (however it was resolved) is never touched.
 */
export function catalogResolveRecipe(db: Database, recipeId: string): ResolvePassResult {
  let resolved = 0;
  for (const line of listIngredients(db, recipeId)) {
    if (line.negligible === 1 || line.resolved_by !== null) continue;
    const grams = lineGrams(line);
    if (grams === null) continue;
    const name = line.name ?? line.raw_text;
    const match = searchFoods(db, name, 1)[0];
    if (!match || !isConfidentFoodMatch(normalizeFoodName(name), match.name_norm)) continue;
    if (match.kcal_100g === null) continue;
    try {
      resolveIngredient(db, line.id, match.id, grams, 'catalog');
      resolved += 1;
    } catch {
      // A food that cannot price energy is not a match — skip it and let the
      // model pass take the line. One bad row never fails the pass.
    }
  }
  return { resolved, remaining: unpricedLines(db, recipeId).length };
}

/** Non-negligible lines still carrying no numbers. */
export function unpricedLines(db: Database, recipeId: string): RecipeIngredientRow[] {
  return listIngredients(db, recipeId).filter((l) => l.negligible === 0 && l.resolved_by === null);
}

// --- Pass 2: the model, for what the catalog could not reach -------------------

/**
 * The pricing prompt.
 *
 * Three things it is strict about, each a way this could quietly mislead:
 *   - **Per BATCH, not per serving.** The line is a batch quantity; the recipe
 *     divides by servings later. Asking per serving would double-divide.
 *   - **Cooking fat is a line, not an invention.** It prices what is written.
 *     It is explicitly told not to add ingredients nobody listed.
 *   - **Absent, not zero.** A macro it cannot reach is null, and a LINE it
 *     cannot price at all is returned with `grams: null` and dropped — leaving
 *     it honestly unresolved beats a confident guess at "a handful".
 */
export const RECIPE_PRICING_SYSTEM_PROMPT = [
  'You price individual recipe ingredient lines for a longevity-focused food logger.',
  'Be precise and calibrated, never confident beyond the evidence.',
  '',
  'Rules:',
  '- Each line is a quantity for the WHOLE BATCH. Do not divide by servings.',
  '- For each line give: grams for that quantity, and kcal / protein / carbs / fat / fiber',
  '  for those grams. Use standard food-composition values.',
  '- Convert volumetric and countable amounts sensibly ("2 tbsp butter" ≈ 28 g, "2 cloves',
  '  garlic" ≈ 6 g), and say the assumption in "note" when it materially moves the number.',
  '- Price ONLY the lines given. Never add an ingredient nobody listed.',
  '- Any macro you genuinely cannot estimate is null. Never return 0 for "unknown".',
  '- A line you cannot price at all ("a handful of something", "to taste"): return it with',
  '  "grams": null. It stays uncounted, which is the honest outcome.',
  '- Return one entry per line given, each carrying the "index" it arrived with.',
  '',
  'Respond with ONLY a JSON object, no prose, matching:',
  '{"lines": [{"index": number, "grams": number|null, "kcal": number|null,',
  ' "protein_g": number|null, "carbs_g": number|null, "fat_g": number|null,',
  ' "fiber_g": number|null, "note": string|null}]}',
].join('\n');

/** One priced line as the model returns it, validated. */
export type PricedLine = {
  index: number;
  grams: number | null;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  note: string | null;
};

/** The request: the recipe for context, then the lines that need pricing. */
export function buildRecipePricingRequest(
  title: string,
  lines: { index: number; raw: string }[]
): { system: string; messages: { role: 'user'; content: string }[] } {
  const body = [
    `Recipe: ${title}`,
    'Price these ingredient lines (each is a whole-batch quantity):',
    ...lines.map((l) => `${l.index}. ${l.raw}`),
  ].join('\n');
  return {
    system: RECIPE_PRICING_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: body }],
  };
}

/** A finite, non-negative number, or null. Anything else the model sends — a
 *  string, NaN, a negative — is absent rather than coerced. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Parse and validate the model's reply. Never trusts its shape: an entry with
 * no usable `index` is dropped, an unparseable macro is null, and an entry
 * whose `grams` or `kcal` is absent is dropped entirely — the schema couples
 * those two, and half a resolution is not one.
 *
 * A reply with NO usable line throws, so the caller can say the pass failed
 * rather than reporting a silent success that changed nothing.
 */
export function parseRecipePricing(replyText: string): PricedLine[] {
  const start = replyText.indexOf('{');
  const end = replyText.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Pricing reply contained no JSON object.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(replyText.slice(start, end + 1));
  } catch {
    throw new Error('Pricing reply was not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Pricing reply was not a JSON object.');
  }
  const entries = Array.isArray((raw as Record<string, unknown>).lines)
    ? ((raw as Record<string, unknown>).lines as unknown[])
    : [];
  const out: PricedLine[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const index = num(e.index);
    if (index === null || !Number.isInteger(index)) continue;
    const grams = num(e.grams);
    const kcal = num(e.kcal);
    // The schema couples grams and kcal. A line the model could not price is
    // legitimate and simply carries nulls; it is kept in the result so the
    // caller can count it, and skipped by the writer.
    out.push({
      index,
      grams: grams !== null && grams > 0 ? grams : null,
      kcal,
      protein_g: num(e.protein_g),
      carbs_g: num(e.carbs_g),
      fat_g: num(e.fat_g),
      fiber_g: num(e.fiber_g),
      note: typeof e.note === 'string' && e.note.trim() !== '' ? e.note.trim() : null,
    });
  }
  if (out.length === 0) throw new Error('Pricing reply had no usable lines.');
  return out;
}

/**
 * Pass 2. Price whatever the catalog could not, in one model turn, and write
 * the results.
 *
 * Returns the pass result plus any notes the model attached, so the screen can
 * show its assumptions ("2 tbsp butter assumed at 28 g"). Throws
 * {@link RecipePricingUnavailableError} when no key is set or the streaming
 * fetch is absent; the caller says so in words and leaves the lines unresolved.
 *
 * **The index is the contract.** The model is given numbered lines and must
 * return the same numbers; anything pointing outside the set it was sent is
 * ignored rather than applied to whichever line happens to sit there.
 */
export async function resolveRecipeWithModel(
  db: Database,
  recipeId: string,
  title: string,
  signal?: AbortSignal
): Promise<ResolvePassResult & { notes: string[] }> {
  const pending = unpricedLines(db, recipeId);
  if (pending.length === 0) return { resolved: 0, remaining: 0, notes: [] };

  const apiKey = apiKeyStore.get();
  const fetchImpl = loadStreamingFetch();
  if (!apiKey || !fetchImpl) throw new RecipePricingUnavailableError();

  const req = buildRecipePricingRequest(
    title,
    pending.map((line, i) => ({ index: i, raw: line.raw_text }))
  );
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
    throw new Error('The model declined to price this recipe.');
  }

  const priced = parseRecipePricing(text.length > 0 ? text : result.text);
  const notes: string[] = [];
  let resolved = 0;
  for (const entry of priced) {
    const line = pending[entry.index];
    if (!line) continue; // an index outside the set it was sent
    if (entry.grams === null || entry.kcal === null) continue; // honestly unpriced
    try {
      resolveIngredientByModel(db, line.id, {
        grams: entry.grams,
        kcal: entry.kcal,
        protein_g: entry.protein_g,
        carbs_g: entry.carbs_g,
        fat_g: entry.fat_g,
        fiber_g: entry.fiber_g,
      });
      resolved += 1;
      if (entry.note) notes.push(entry.note);
    } catch {
      // One rejected row never fails the pass; the line stays unresolved.
    }
  }
  return { resolved, remaining: unpricedLines(db, recipeId).length, notes };
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
