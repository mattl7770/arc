/**
 * The recipe sub-app's **one model seam**: pricing a recipe's ingredient lines
 * without asking the user to (0034), and revising a recipe from a plain-English
 * instruction (2026-08-12 — see the section at the foot of this file). One
 * module owns the key check, the guarded streaming fetch and the JSON
 * contracts, exactly as src/lib/nutrition/estimate.ts owns them for meals.
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

// --- Revising a recipe in plain English (owner, 2026-08-12) -------------------
//
// *"Add a button to edit a recipe with plain-text input to the coach. (i.e.
//  'change the milk for almond milk and add something to keep the sweetness the
//  same' or 'make it higher protein and lower calorie')"*
//
// Those two examples are the spec, and they are two different jobs:
//   1. A SUBSTITUTION that requires a compensating change the user did not
//      name. Swapping the milk is the easy half; noticing that the sweetness
//      went with it is the request.
//   2. A GOAL, not an edit. "Higher protein, lower calorie" says nothing about
//      which line to touch — deciding that IS the work, and it is exactly the
//      kind of judgment that belongs in the model rather than in a rule table
//      (the coach-judgment-not-rules memory).
//
// It lives beside the pricing passes for the same reason `reviseMeal` lives
// beside `estimateMeal`: one module per sub-app owns the model seam, the
// guarded streaming fetch, and the availability check. A second HTTP stack for
// a second kind of turn is how two paths drift.
//
// ## Cost discipline (owner flagged a ~10¢ Coach turn, 2026-08-12)
//
//   - **No tools.** `tools: []`, so the Coach's ~8k-token tool catalog — the
//     expensive, invariant bulk of a real Coach turn — is never uploaded. A
//     rewrite has nothing to call.
//   - **The system prompt is a module constant**, so it is byte-identical on
//     every revision and rides the cache breakpoint `buildMessagesRequest`
//     already puts on the static system block (src/lib/ai/model-client.ts).
//     Building it per call from the recipe would have made it uncacheable.
//   - **The recipe goes up once, as words.** No macros, no snapshots, no
//     micros, no ids: the model is rewriting a document, and the numbers are
//     the pricing passes' job, which already ran.
//   - **The reply is raw lines and steps**, not a per-line object carrying
//     qty/unit/name. `parseIngredientLine` derives that overlay deterministically
//     and for free — asking the model for it would cost output tokens on every
//     line to get a worse answer.
//
// ## It is a PROPOSAL
//
// Nothing here writes. `reviseRecipe` returns a draft, the screen shows it
// against what the recipe says now ({@link diffRecipeLines}), and
// `applyRecipeRevision` runs only if the user accepts — which matters more here
// than for a new recipe, because this REPLACES a document that already exists
// and may already have hand-resolved lines in it.

/** Thrown when no model key is configured (the UI points the user at Settings). */
export class RecipeRevisionUnavailableError extends Error {
  constructor() {
    super('Editing a recipe in words needs a model key — set one in Settings › Coach.');
    this.name = 'RecipeRevisionUnavailableError';
  }
}

/** Whether the revision path can run — the same key the Coach uses. */
export function isRecipeRevisionAvailable(): boolean {
  return apiKeyStore.has();
}

/** The recipe as it stands, the way the model is shown it. */
export type RecipeRevisionSubject = {
  title: string;
  servings: number;
  /** Raw ingredient lines, in order — the source of truth, never the overlay. */
  ingredients: string[];
  steps: string[];
};

/** The revised recipe as the model proposes it. Nothing is written until the
 *  user accepts it. */
export type RecipeRevision = {
  title: string;
  servings: number;
  ingredients: string[];
  steps: string[];
  /** The model's own one-or-two-sentence account of what it changed and why.
   *  Shown on the review; never written to `recipes.notes`, which is the
   *  user's own column. */
  notes: string | null;
};

/**
 * The revision system prompt.
 *
 * Its job is restraint plus one licence. The restraint is the same one
 * `MEAL_REVISION_SYSTEM_PROMPT` needs — a model asked about the milk will
 * happily rewrite the whole recipe — so "leave everything else byte-identical"
 * is stated first and is the reason the reply is a FULL list rather than a
 * patch: a full list that must round-trip unchanged is checkable on screen
 * next to the original, and a patch is not.
 *
 * The licence is the second example's whole point. "Make it higher protein and
 * lower calorie" names no line, so the model must choose; being told to choose
 * the SMALLEST set of changes that achieves the goal, and to say what it chose
 * and why, is what keeps that from becoming a rewrite wearing the same title.
 */
export const RECIPE_REVISION_SYSTEM_PROMPT = [
  'You revise a saved recipe for a longevity-focused cook, following one plain-English',
  'instruction from the user. Be precise and conservative.',
  '',
  'Rules:',
  '- Return the COMPLETE revised recipe, not a patch.',
  '- Change ONLY what the instruction implies. Every ingredient line and step it does not',
  '  touch must come back with exactly the same wording it went in with — do not tidy,',
  '  reword, reorder or re-unit anything you were not asked about.',
  '- A substitution often needs a compensating change the user did not name (swapping',
  '  sweetened milk for an unsweetened one loses sweetness). Make it, keep it minimal, and',
  '  say so in "notes".',
  '- An instruction can be a GOAL rather than an edit ("higher protein, lower calorie"). Then',
  '  you choose what to change: make the SMALLEST set of changes that genuinely achieves it,',
  '  and say in "notes" what you changed and why.',
  '- Every ingredient line keeps the "quantity unit name" shape it had ("200 g chicken',
  '  thighs"). Give an amount for anything you add; never leave a new line amountless.',
  '- Update any step that names an ingredient you changed. Leave the others alone.',
  '- Keep "servings" as it was unless the instruction is about yield.',
  '- Never invent nutrition numbers — you are rewriting the recipe, not pricing it.',
  '',
  'Respond with ONLY a JSON object, no prose, matching:',
  '{"title": string, "servings": number, "ingredients": [string], "steps": [string],',
  ' "notes": string|null}',
].join('\n');

/** Build the revision request: the recipe as it stands, then the instruction. */
export function buildRecipeRevisionRequest(
  recipe: RecipeRevisionSubject,
  instruction: string
): { system: string; messages: { role: 'user'; content: string }[] } {
  const body = [
    `Recipe: ${recipe.title}`,
    `Servings: ${recipe.servings}`,
    'Ingredients:',
    ...recipe.ingredients.map((line) => `- ${line}`),
    ...(recipe.steps.length > 0
      ? ['Steps:', ...recipe.steps.map((step, i) => `${i + 1}. ${step}`)]
      : ['Steps: none recorded.']),
    '',
    `Instruction from the user: ${instruction}`,
  ].join('\n');
  return {
    system: RECIPE_REVISION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: body }],
  };
}

/** Non-empty trimmed strings out of an unknown array — the model's shape is
 *  never trusted, and a blank line is not an ingredient. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}

/**
 * Parse and validate the model's reply. Defensive throughout: a reply with no
 * usable ingredient lines throws, because a recipe with no ingredients is not
 * a revision of anything — better to say the pass failed than to offer the user
 * an empty document to accept.
 *
 * **Two fields fall back to what the recipe already says rather than to a
 * default, and both for the same reason: a field the model omitted is an
 * omission, not an instruction to delete something.**
 *
 * - `servings` → the current yield, never a made-up 1. A silent reset to one
 *   serving would rescale every future log of the recipe.
 * - `steps` → the current method whenever the reply carries none. The prompt
 *   asks for the COMPLETE recipe, so a missing `steps` key is a model that
 *   dropped a field; writing `'[]'` over it would erase the method as a side
 *   effect of "swap the milk". Deleting the steps deliberately is not a thing
 *   anyone asks a rewriter for, and the manual editor does it in two taps.
 */
export function parseRecipeRevision(
  replyText: string,
  current: { servings: number; steps: string[] }
): RecipeRevision {
  const start = replyText.indexOf('{');
  const end = replyText.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Revision reply contained no JSON object.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(replyText.slice(start, end + 1));
  } catch {
    throw new Error('Revision reply was not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Revision reply was not a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  const ingredients = stringList(obj.ingredients);
  if (ingredients.length === 0) {
    throw new Error('Revision reply had no usable ingredient lines.');
  }
  const servings =
    typeof obj.servings === 'number' && Number.isFinite(obj.servings) && obj.servings > 0
      ? obj.servings
      : current.servings;
  const steps = stringList(obj.steps);
  return {
    title: typeof obj.title === 'string' && obj.title.trim() !== '' ? obj.title.trim() : '',
    servings,
    ingredients,
    steps: steps.length === 0 ? current.steps : steps,
    notes: typeof obj.notes === 'string' && obj.notes.trim() !== '' ? obj.notes.trim() : null,
  };
}

/**
 * Apply a plain-English instruction to a recipe — one turn through the Coach's
 * model client, no tools. Throws {@link RecipeRevisionUnavailableError} when no
 * key is set or the streaming fetch is absent.
 *
 * The result is NOT written: the caller shows it as a proposal and only
 * `applyRecipeRevision` (src/lib/db/repositories/recipes.ts) lands it.
 */
export async function reviseRecipe(
  recipe: RecipeRevisionSubject,
  instruction: string,
  signal?: AbortSignal
): Promise<RecipeRevision> {
  const apiKey = apiKeyStore.get();
  const fetchImpl = loadStreamingFetch();
  if (!apiKey || !fetchImpl) throw new RecipeRevisionUnavailableError();

  const req = buildRecipeRevisionRequest(recipe, instruction);
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
    throw new Error('The model declined to revise this recipe.');
  }
  return parseRecipeRevision(text.length > 0 ? text : result.text, {
    servings: recipe.servings,
    steps: recipe.steps,
  });
}

/** One row of the review: a line of the revised recipe, or one the revision
 *  dropped, with what happened to it. */
export type RevisionDiffRow = {
  text: string;
  /** `same` survived verbatim (and so keeps its price and provenance),
   *  `added` is new or reworded, `removed` is gone. */
  state: 'same' | 'added' | 'removed';
};

/**
 * **The one matching rule**, and the reason there is only one.
 *
 * A line SURVIVES a revision iff the other list still contains its exact
 * wording, matched first-come so two identical lines pair off one for one
 * rather than collapsing. `applyRecipeRevision` decides what to keep by this
 * rule, {@link diffRecipeLines} marks the review by it, and
 * {@link droppedRecipeLines} tells the screen which priced rows are about to
 * go. If those three ever disagreed the review would be describing a different
 * write than the one that lands, so they read one function.
 *
 * Returns a flag per entry of `list`, positionally.
 */
function survivorFlags(list: string[], other: string[]): boolean[] {
  // Compared TRIMMED, which is the same key `applyRecipeRevision` matches on.
  // The stored line goes up to the model untrimmed and every line comes back
  // trimmed, so an untrimmed comparison would mark a line nobody touched as
  // dropped-and-re-added — and the write would then really destroy its price
  // and its provenance, for a leading space.
  const pool = new Map<string, number>();
  for (const line of other) {
    const key = line.trim();
    pool.set(key, (pool.get(key) ?? 0) + 1);
  }
  return list.map((text) => {
    const key = text.trim();
    const left = pool.get(key) ?? 0;
    if (left === 0) return false;
    pool.set(key, left - 1);
    return true;
  });
}

/**
 * What changed, as rows the review can draw — the thing that turns a rewritten
 * recipe into a decision the user can actually make.
 *
 * The revised list comes back in order, each row marked `same` or `added`, and
 * the dropped lines follow as `removed` in their original order. That ordering
 * is the point: the user reads the recipe they would END UP WITH, top to
 * bottom, with the new words marked in place, and then sees what left. A
 * two-column before/after would hand them the alignment work.
 */
export function diffRecipeLines(before: string[], after: string[]): RevisionDiffRow[] {
  const keptAfter = survivorFlags(after, before);
  const rows: RevisionDiffRow[] = after.map((text, i) => ({
    text,
    state: keptAfter[i] ? ('same' as const) : ('added' as const),
  }));
  const keptBefore = survivorFlags(before, after);
  before.forEach((text, i) => {
    if (!keptBefore[i]) rows.push({ text, state: 'removed' });
  });
  return rows;
}

/**
 * The CURRENT rows a revision would not keep — precisely the rows
 * `applyRecipeRevision` deletes, by the same rule.
 *
 * The screen needs these as rows and not as strings because the honest
 * disclosure is about what they CARRY: a line the user priced by hand is the
 * strongest provenance in the book, and rewording it hands it back to the
 * automatic passes. Saying so before the user accepts is the difference
 * between a proposal and a surprise.
 */
export function droppedRecipeLines<T extends { raw_text: string }>(
  before: T[],
  after: string[]
): T[] {
  const kept = survivorFlags(
    before.map((row) => row.raw_text),
    after
  );
  return before.filter((_, i) => !kept[i]);
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
