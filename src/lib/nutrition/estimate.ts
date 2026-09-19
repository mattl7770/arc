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
import type { JsonText } from '@/lib/db/types';
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { type FetchLike, runCoachTurn, type WireMessage } from '@/lib/ai/model-client';

import { countLabel } from './format';
import { coerceMicros, parseMicros, serializeMicros } from './micros';
import { itemForPortion } from './servings';
import type { AmountUnit, EstimateConfidence, FoodRow } from './types';

export type EstimateInput =
  | { kind: 'text'; description: string }
  | { kind: 'photo'; base64Jpeg: string; mediaType: 'image/jpeg'; description?: string };

/** One part of a composite dish (0058, backlog C4) — a plain priced row that
 *  happens to live under a header. One level only: a part has no parts. */
export type MealEstimateComponent = {
  name: string;
  amount: number | null;
  unit: AmountUnit;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
  /** Inherited from the dish the model priced — it stated one confidence for
   *  the pizza, and that is as true of the cheese as of the crust. */
  confidence: EstimateConfidence;
  foodId: string | null;
  micros: JsonText | null;
};

export type MealEstimateItem = {
  name: string;
  /** Estimated portion in {@link MealEstimateItem.unit}; null when the model can
   * only price energy — and always null on a composite HEADER, whose amount is
   * derived from its parts. */
  amount: number | null;
  /** What the model judged this item to be measured in — `'ml'` when it decided
   * the item is a DRINK, `'g'` otherwise and whenever it said nothing usable
   * (0047, backlog B2). Nothing downstream converts between the two. */
  unit: AmountUnit;
  /**
   * The item's own energy — and **null on a composite header** (0058). A header
   * is a name over its parts, not a row of numbers: one fact gets one number,
   * and a headline that cannot disagree with its parts is one that is derived
   * from them. Every reader must branch on {@link MealEstimateItem.components}
   * rather than treating a null as a zero.
   */
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  confidence: EstimateConfidence;
  /** Set when the item was grounded to a catalog food (macros re-priced from
   * its per-100 g values); null means raw model numbers. Never set on a
   * composite header — a dish is not a catalog food. */
  foodId: string | null;
  /**
   * Per-portion micronutrient snapshot (JSON), or null when nothing was
   * recorded. Two sources, in this order: a catalog food's own values when the
   * item grounds to one (as complete as the manual-add path, servings.ts), else
   * whatever SODIUM and CAFFEINE the model returned for the portion it
   * estimated (backlog A8). Null is "not recorded" and never a zero.
   */
  micros: JsonText | null;
  /**
   * The parts of a composite dish — at most 4, capped by the parser rather than
   * by hoping (0058, backlog C4). Null for a plain item, which is almost every
   * item. Non-empty means this row is a HEADER and carries no macros.
   */
  components: MealEstimateComponent[] | null;
  /**
   * How many countable pieces the model PRICED, and what one is called — a
   * whole pizza comes back `{slice, 8}`, three slices on a plate `{slice, 3}`
   * (0059).
   *
   * Read only on a composite header and ignored anywhere else: on a plain item
   * the count would land in three places built for a catalog SERVING count (the
   * recents rail's re-add, a template round-trip, meal-detail's serving-mode
   * predicate), where `3 × slice` and `3 × '1 slice'` are not the same claim.
   *
   * It is the model performing §4.1's DECLARATION — "what is priced here is N
   * pieces" — so a wrong answer costs one keypad entry and nothing else.
   */
  pieces: { name: string; count: number } | null;
};

/** Does this estimate item stand over parts? The one predicate every reader
 *  branches on, so "null kcal" is never mistaken for "zero kcal". */
export function isCompositeEstimateItem(item: MealEstimateItem): boolean {
  // `Array.isArray` rather than `!== null`: an estimate built by hand — a test
  // fixture, a future caller — omits the key entirely, and an undefined must
  // read as "a plain item", never crash a grounding pass.
  return Array.isArray(item.components) && item.components.length > 0;
}

/**
 * What choosing one button answer DOES to the estimate — a tiny closed
 * vocabulary the parser can validate (0058-adjacent, backlog C5).
 *
 * This is a **wire format for what the model decided**, not a decision table.
 * The model still decides whether to ask, what to ask, which answers are
 * plausible and what each implies; these four shapes are only how it says so.
 * That is the same relationship `MealEstimate`'s JSON already has to the
 * estimate itself, and it is what keeps ARC's standing rule intact — judgment
 * lives in the model, never in a rule table.
 *
 * Because the effect travels WITH the estimate, answering is pure on-device
 * arithmetic over the review rows: no second round trip, instant, and it works
 * with the network gone once the first reply has landed.
 */
export type QuestionEffect =
  /** Multiply that item's portion and macros — "how many shots?" */
  | { kind: 'scale_item'; name: string; factor: number }
  /**
   * Set that item's portion outright, in the item's OWN unit — "small, medium
   * or large?" on a latte's milk is millilitres, not grams. The spike called
   * this `set_grams`; `ml` landed (0047) between the design and the build, and
   * a key named for one unit describing a number in another is exactly the lie
   * that migration renamed three columns to avoid.
   */
  | { kind: 'set_amount'; name: string; amount: number }
  /** Add a whole item — "was there dressing?" → yes, ~30 g vinaigrette. */
  | {
      kind: 'add_item';
      name: string;
      amount: number | null;
      unit: AmountUnit;
      kcal: number;
      protein_g: number;
      carbs_g: number;
      fat_g: number;
    }
  /** Drop an item — "did you eat the bun?" → no. */
  | { kind: 'remove_item'; name: string };

/** One button answer, carrying the effect of choosing it. */
export type QuestionOption = { label: string; effect: QuestionEffect };

/**
 * One clarifying question (backlog C5). **Usually absent** — most meals need
 * none, and the prompt says so twice.
 */
export type EstimateQuestion = {
  id: string;
  /** The question, as a sentence: "How many shots?" */
  ask: string;
  /** 2–4 button answers. A question left with fewer than two is dropped — one
   *  button is not a question. */
  options: QuestionOption[];
  /** Whether a typed answer is offered behind a click. It is the ONE path that
   *  costs a second model call, and the photo is never resent. */
  allowOther: boolean;
};

export type MealEstimate = {
  /** A short meal title, e.g. "Salmon, rice and greens". */
  title: string;
  items: MealEstimateItem[];
  /** Model-stated caveats worth showing in review ("dressing not visible"). */
  notes: string | null;
  /**
   * Up to three things the model would like to know, each answerable with a
   * button (backlog C5). Empty is the norm. **An unanswered question never
   * blocks Save** — the items already assume the most likely answer, so
   * skipping costs accuracy, not coherence.
   */
  questions: EstimateQuestion[];
};

/** Thrown when no model key is configured (the UI points the user to Settings). */
export class MealEstimationUnavailableError extends Error {
  constructor() {
    super('Meal estimation needs a model key — set one in the Coach settings.');
    this.name = 'MealEstimationUnavailableError';
  }
}

/**
 * Thrown by {@link parseMealEstimate} when the model answered and the answer
 * was unusable — no JSON, bad JSON, or no item with a name.
 *
 * A named class rather than a bare `Error` because the offline queue (0057) has
 * to tell a reply it could not read from a request that never left the phone:
 * the first will fail identically tomorrow, the second is exactly what waiting
 * fixes. See `isQueueableFailure`.
 */
export class MealEstimateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MealEstimateParseError';
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

// --- The vision request the Coach client consumes -----------------------------
//
// The model client (src/lib/ai/model-client.ts) is imported directly above;
// these local block types just give the image/text content a precise shape. The
// client's WireContentBlock carries an image as an opaque block, so
// buildMealEstimationRequest's output is cast to WireMessage[] at the call site
// in estimateMeal — the shapes match the Anthropic vision wire format 1:1.

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
  '- A named prepared dish whose parts a person would change separately (a pizza, a burger,',
  '  a salad with dressing) comes back as ONE item carrying a "components" array of at most',
  '  4 parts, and NO macros of its own. Everything else is a plain item with no',
  '  "components". Never decompose a single ingredient or a packaged product.',
  '- If what you priced is a countable number of pieces (slices, wings, rolls), give',
  '  "pieces": the singular noun and the count; else null.',
  '- Estimate each portion from visual cues (glass and plate size, utensils) and any text,',
  '  as "amount" plus the "unit" it is measured in: "ml" for anything DRUNK (coffee, beer,',
  '  a smoothie), "g" for everything eaten. Estimate a drink in millilitres directly;',
  '  never convert it to grams.',
  '- Give kcal and protein/carbs/fat grams per item; fiber grams when inferable, else null.',
  '  Those are always grams of macronutrient, whatever the portion unit is.',
  '- Set per-item confidence: "high" for clearly identified packaged/simple foods, "medium"',
  '  for typical mixed dishes, "low" when the food or portion is genuinely uncertain.',
  '- Account for likely hidden fats (cooking oil, butter, dressing), say so in notes when they',
  '  matter, and prefer underestimating an unknown over inventing precision.',
  '- Give sodium and caffeine in milligrams, under "micros", for any item that plausibly',
  '  carries them (salted, cured or restaurant-made; coffee, tea, cola, dark chocolate).',
  '  OMIT the key when you would be guessing — an absent key means "not recorded" and a 0',
  '  means "measured none", and they are not the same claim.',
  '',
  'Questions (optional, and USUALLY ABSENT):',
  '- Ask nothing unless an answer would move the estimate by more than ~15% of its energy or',
  '  ~10 g of protein. Most meals need no question at all; an empty list is the norm.',
  '- Ask only what the person was there for — how many shots, how big the glass, how much was',
  "  left. Never what happened in a kitchen they did not stand in (a restaurant's oil, the",
  '  butter under a steak). Never what the photo already answers.',
  '- At most 3, and one good question beats three weak ones. Each carries 2-4 button answers,',
  '  and each answer carries the EFFECT of choosing it, as one of:',
  '  {"scale_item": name, "factor": n} · {"set_amount": name, "amount": n} ·',
  '  {"remove_item": name} · {"add_item": {name, amount, unit, kcal, protein_g, carbs_g, fat_g}}',
  '- Name the most likely answer first; the items you return must already assume it.',
  '',
  'Respond with ONLY a JSON object, no prose, matching:',
  '{"title": string, "items": [{"name": string, "amount": number|null, "unit": "g"|"ml",',
  ' "kcal": number, "protein_g": number, "carbs_g": number, "fat_g": number,',
  ' "fiber_g": number|null,',
  ' "micros": {"sodium_mg": number, "caffeine_mg": number}|null,',
  ' "confidence": "high"|"medium"|"low",',
  ' "pieces": {"name": string, "count": number}|null,',
  ' "components": [{"name": string, "amount": number|null, "unit": "g"|"ml", "kcal": number,',
  '   "protein_g": number, "carbs_g": number, "fat_g": number, "fiber_g": number|null}]|null}],',
  ' "notes": string|null,',
  ' "questions": [{"id": string, "ask": string, "allow_other": boolean,',
  '   "options": [{"label": string, "effect": <one of the four above>}]}]}',
  'Micro amounts are for the portion you estimated, not per 100.',
].join('\n');

/**
 * The ceiling on {@link MEAL_ESTIMATION_SYSTEM_PROMPT}, in the estimator
 * db/coach-eval.test.mjs §6 uses (~3.6 chars per prose token).
 *
 * **This prompt had no guard at all until C4/C5, and it drifted 296 → 449
 * tokens in a single day** — backlog A8 (caffeine / fiber / sodium) merged five
 * lines and a schema key, a 52% growth nobody noticed, because the two Coach
 * ceilings measure `buildCoachSystemPrompt` and `toWireTools(COACH_TOOLS)` and
 * the estimator is neither: it is a different system prompt on a tool-less turn
 * (`tools: []`).
 *
 * So the number is here, it is asserted in db/nutrition-v2.test.mjs against
 * BOTH estimator prompts, and the rule the Coach's own budget note states
 * applies to it verbatim: **the next addition trims rather than raises it.**
 *
 * THE ACCOUNTING for the round that set it (C4 + C5, 2026-09-14):
 *
 *   542  `main` at branch point (449 + `ml`)
 *   +149 C4: the composite rule, and "components" on the schema line
 *   +279 C5: the question rules, and "questions" on the schema line
 *   −48  TRIMMED IN THE SAME ROUND, because the rule above binds this round
 *        too. Three enumerations became three examples each, with no rule
 *        lost: the drinks list (coffee/tea/juice/soda/beer/wine/milk/smoothie
 *        → coffee, beer, a smoothie), the sodium and caffeine lists, and the
 *        composite rule's five dishes → three. Examples teach; a catalogue of
 *        examples only teaches once.
 *   ---
 *   922, against 1,000. **78 tokens of headroom.**
 *
 * THE ROUND AFTER IT (0059, "slices", 2026-09-19) — and it paid the rule:
 *
 *   922  where C4 + C5 left it
 *   +38  the pieces rule, one bullet after the composite bullet
 *   +14  "pieces" on the schema line, after "confidence"
 *   −7   TRIMMED IN THE SAME ROUND, from the pair this note itself named as
 *        the cheapest cut: the hidden-fats bullet and "prefer underestimating
 *        an unknown over inventing precision" are one bullet now. They always
 *        overlapped — both say "do not invent what you cannot see" — and
 *        neither rule is lost.
 *   ---
 *   967, against 1,000. **33 tokens of headroom.**
 *
 * The REVISION prompt is measured too, and was not before: 798 → **834**
 * (the schema clause, and one rail telling the model to keep a count it was
 * not asked to change). It is the looser of the two and always has been.
 *
 * What is left to cut, when that runs out and it is genuinely needed: the
 * confidence bullet's three definitions could become two. That is a real rule,
 * so it is not free — which is the point of a ceiling.
 */
export const ESTIMATOR_PROMPT_CEILING = 1000;

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

/**
 * The model's `unit`, or `'g'` for anything else it said.
 *
 * Grams is the safe default rather than a refusal: it is what every item was
 * before 0047, it is what the overwhelming majority of items are, and a
 * mis-defaulted unit is visible and fixable on the review screen — which is
 * where every estimate lands anyway.
 */
function amountUnit(value: unknown): AmountUnit {
  return value === 'ml' ? 'ml' : 'g';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** At most this many parts hang off one composite (0058). A hard number, and
 *  the PARSER enforces it rather than the prompt hoping: a nine-row pizza is a
 *  data dump, not a record you can read at a glance. */
export const MAX_COMPOSITE_COMPONENTS = 4;

/**
 * The model's `components` array, validated into parts — or null when there is
 * nothing usable, which is the overwhelmingly common case.
 *
 * Every part inherits the dish's `confidence`: the model stated one confidence
 * for the pizza, and that is as true of the cheese as of the crust. Asking for
 * a per-part confidence would cost tokens for a number that would only ever
 * repeat the parent's.
 */
function parseComponents(
  raw: unknown,
  confidence: EstimateConfidence
): MealEstimateComponent[] | null {
  if (!Array.isArray(raw)) return null;
  const parts: MealEstimateComponent[] = [];
  for (const entry of raw) {
    if (parts.length >= MAX_COMPOSITE_COMPONENTS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (name === '') continue;
    parts.push({
      name,
      amount: num(e.amount) ?? num(e.grams),
      unit: amountUnit(e.unit),
      kcal: num(e.kcal) ?? 0,
      protein_g: num(e.protein_g) ?? 0,
      carbs_g: num(e.carbs_g) ?? 0,
      fat_g: num(e.fat_g) ?? 0,
      fiber_g: num(e.fiber_g),
      confidence,
      foodId: null,
      micros: serializeMicros(coerceMicros(e.micros)),
    });
  }
  // A single part is not a composite — it is the item itself, wearing a header.
  // Collapsing it here keeps invariant 4 ("a composite always has ≥ 1
  // component") from becoming "a composite that is only ever one component",
  // which is a disclosure chevron over nothing worth disclosing.
  return parts.length >= 2 ? parts : null;
}

/**
 * The model's `pieces`, validated — or null, which is the common case (0059).
 *
 * Shape only. The RULE in the prompt is a criterion with three examples ("a
 * countable number of pieces — slices, wings, rolls"), not a dish list, because
 * judgment lives in the model and this is only how it says so — the same
 * relationship {@link QuestionEffect} has to a decision.
 *
 * The count's bounds are the review field's own (`parseCount`): finite, > 0 and
 * ≤ 100. Nothing a person eats is 101 slices, and a model typo that says so
 * would otherwise scale a dish by a hundred on the first later edit.
 */
function parsePieces(raw: unknown): { name: string; count: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  const count = typeof p.count === 'number' ? p.count : NaN;
  if (name === '' || !Number.isFinite(count) || count <= 0 || count > 100) return null;
  return { name, count };
}

/** The owner said three. The model is not the enforcer of that (backlog C5). */
export const MAX_ESTIMATE_QUESTIONS = 3;

/**
 * One option's effect, or null when it is not usable.
 *
 * `known` is the set of item names the estimate actually returned. **The
 * commonest model error is an effect naming an item it renamed**, so an effect
 * pointing at nothing is dropped rather than applied to nothing. `add_item` is
 * the exception: it names an item that does not exist yet, which is the point.
 *
 * Bounds are the schema's own: `CHECK (amount > 0)`, and the same ≤ 5,000
 * ceiling the review screen's `parseAmount` applies.
 */
function parseEffect(raw: unknown, known: Set<string>): QuestionEffect | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const named = (value: unknown): string | null => {
    const name = typeof value === 'string' ? value.trim() : '';
    return name !== '' && known.has(name.toLowerCase()) ? name : null;
  };
  const positive = (value: unknown): number | null => {
    const n = num(value);
    return n != null && n > 0 && n <= 5000 ? n : null;
  };

  if (e.scale_item !== undefined) {
    const name = named(e.scale_item);
    const factor = num(e.factor);
    // A factor of 0 is "remove_item" said badly, and a negative one is
    // meaningless; neither is silently reinterpreted.
    if (name === null || factor == null || factor <= 0 || factor > 50) return null;
    return { kind: 'scale_item', name, factor };
  }
  if (e.set_amount !== undefined || e.set_grams !== undefined) {
    // `set_grams` is read as a fallback for the same reason `grams` is read as
    // a fallback for `amount`: a model reaching for the older word still lands
    // on the row rather than being dropped.
    const name = named(e.set_amount ?? e.set_grams);
    const amount = positive(e.amount ?? e.grams);
    if (name === null || amount == null) return null;
    return { kind: 'set_amount', name, amount };
  }
  if (e.remove_item !== undefined) {
    const name = named(e.remove_item);
    return name === null ? null : { kind: 'remove_item', name };
  }
  if (typeof e.add_item === 'object' && e.add_item !== null) {
    const a = e.add_item as Record<string, unknown>;
    const name = typeof a.name === 'string' ? a.name.trim() : '';
    if (name === '') return null;
    const amount = num(a.amount) ?? num(a.grams);
    return {
      kind: 'add_item',
      name,
      amount: amount != null && amount > 0 && amount <= 5000 ? amount : null,
      unit: amountUnit(a.unit),
      kcal: num(a.kcal) ?? 0,
      protein_g: num(a.protein_g) ?? 0,
      carbs_g: num(a.carbs_g) ?? 0,
      fat_g: num(a.fat_g) ?? 0,
    };
  }
  // An unknown effect key is dropped — the vocabulary is closed on purpose.
  return null;
}

/**
 * The model's `questions`, put through the three gates (backlog C5 §3.5).
 *
 * 1. **The prompt** is the judgment gate, and the only one that can be smart.
 * 2. **A deterministic confidence gate, here:** if EVERY item came back
 *    `confidence: 'high'`, drop all questions. A model certain about every item
 *    and still wanting to ask has contradicted itself, and a certain estimate
 *    is the one case where an extra tap is pure friction.
 * 3. **A hard cap**, after the drops — so three good questions survive a fourth
 *    malformed one rather than being crowded out by it.
 */
function parseQuestions(raw: unknown, items: MealEstimateItem[]): EstimateQuestion[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (items.every((item) => item.confidence === 'high')) return [];

  // Components are addressable too: "was there dressing on the salad" may want
  // to scale a part rather than the dish.
  const known = new Set<string>();
  for (const item of items) {
    known.add(item.name.toLowerCase());
    for (const part of item.components ?? []) known.add(part.name.toLowerCase());
  }

  const questions: EstimateQuestion[] = [];
  for (const entry of raw) {
    if (questions.length >= MAX_ESTIMATE_QUESTIONS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const q = entry as Record<string, unknown>;
    const ask = typeof q.ask === 'string' ? q.ask.trim() : '';
    if (ask === '') continue;
    const options: QuestionOption[] = [];
    for (const rawOption of Array.isArray(q.options) ? q.options : []) {
      if (options.length >= 4) break;
      if (typeof rawOption !== 'object' || rawOption === null) continue;
      const o = rawOption as Record<string, unknown>;
      const label = typeof o.label === 'string' ? o.label.trim() : '';
      if (label === '') continue;
      const effect = parseEffect(o.effect, known);
      if (effect === null) continue;
      options.push({ label, effect });
    }
    // One button is not a question.
    if (options.length < 2) continue;
    questions.push({
      id: typeof q.id === 'string' && q.id.trim() !== '' ? q.id.trim() : `q${questions.length}`,
      ask,
      options,
      allowOther: q.allow_other === true,
    });
  }
  return questions;
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
    throw new MealEstimateParseError('Meal estimate reply contained no JSON object.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(replyText.slice(start, end + 1));
  } catch {
    throw new MealEstimateParseError('Meal estimate reply was not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new MealEstimateParseError('Meal estimate reply was not a JSON object.');
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
    const components = parseComponents(e.components, confidence);
    // A COMPOSITE HEADER keeps no numbers of its own — they are DROPPED, not
    // reconciled (0058). One fact gets one number, and the headline is derived
    // from the parts, so it cannot come to disagree with them.
    items.push({
      name,
      // `grams` is read as a fallback for `amount`: an older prompt's shape (and
      // a model that reaches for the word anyway) still lands on the row, as
      // grams, rather than silently becoming an unportioned item.
      amount: components ? null : (num(e.amount) ?? num(e.grams)),
      unit: amountUnit(e.unit),
      kcal: components ? null : (num(e.kcal) ?? 0),
      protein_g: components ? null : (num(e.protein_g) ?? 0),
      carbs_g: components ? null : (num(e.carbs_g) ?? 0),
      fat_g: components ? null : (num(e.fat_g) ?? 0),
      fiber_g: components ? null : num(e.fiber_g),
      confidence,
      foodId: null,
      // The model's own sodium/caffeine, put through the same vocabulary filter
      // as stored micros: unknown keys and non-numbers are dropped, and an item
      // that returned nothing usable serialises back to NULL rather than {}.
      micros: components ? null : serializeMicros(coerceMicros(e.micros)),
      components,
      // A count of pieces is a fact about a DISH WITH PARTS (0059). On a plain
      // item it is dropped rather than carried: `serving_qty` there counts the
      // catalog food's own serving through a live join, and `3 × slice` beside
      // `3 × '1 slice'` is two vocabularies in one column.
      pieces: components ? parsePieces(e.pieces) : null,
    });
  }
  if (items.length === 0) {
    throw new MealEstimateParseError('Meal estimate reply had no usable items.');
  }
  const title =
    typeof obj.title === 'string' && obj.title.trim() !== '' ? obj.title.trim() : 'Meal';
  const notes = typeof obj.notes === 'string' && obj.notes.trim() !== '' ? obj.notes.trim() : null;
  return { title, items, notes, questions: parseQuestions(obj.questions, items) };
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

// --- Revising a logged meal in plain English ---------------------------------
//
// Owner request, 2026-08-12: *"I should be able to use plain-text input to have
// AI edit a meal. I.e. 'Actually, that was cooked in olive oil not butter' and
// it then makes those changes."*
//
// The correction path was manual and item-shaped: open the meal, find the
// butter row, remove it, search the catalog for olive oil, add it, set its
// grams. Six interactions to state one fact. That is also the moment a
// correction is least likely to be made — you are remembering something about a
// meal you have already logged and moved on from.
//
// It reuses the estimator wholesale rather than growing a second pipeline: the
// model returns THE WHOLE REVISED ITEM LIST in the same JSON shape, so
// {@link parseMealEstimate} validates it, {@link groundMealEstimate} re-prices
// it against the catalog, and the review screen is the same editable table with
// the same guarantees. One schema, one parser, one review.
//
// **A revision is a proposal, exactly like an estimate.** Nothing is written
// until the user confirms it on the review screen — which matters more here
// than for a new meal, because this one REPLACES a record that already exists.

/** One row of the meal as the model is shown it. */
export type MealRevisionItem = {
  name: string;
  amount: number | null;
  unit: AmountUnit;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  /** The item's stored micro snapshot, so sodium and caffeine can be shown to
   * the model and carried back on an item it was not asked to change. */
  micros?: JsonText | null;
  /** The parts of a composite dish (0058) — printed indented beneath it, so a
   *  correction to the pepperoni is a correction to a part the model can see. */
  components?: MealRevisionItem[];
  /** A composite's count of pieces and their noun (0059) — printed in the
   *  header's tail as `8 × slice`, so a correction can move it and a correction
   *  about something else leaves it where it is. */
  pieces?: { name: string; count: number } | null;
};

/** The meal as it stands, the way the model is shown it. */
export type MealRevisionSubject = {
  name: string;
  items: MealRevisionItem[];
};

/**
 * The revision system prompt.
 *
 * Its whole job is restraint. The failure mode is not a bad number, it is a
 * model that re-estimates the entire meal because it was asked about one
 * ingredient — so the instruction to leave untouched items byte-identical is
 * stated first, stated twice, and is the reason the reply carries the full list
 * rather than a patch (a full list that must round-trip unchanged is checkable
 * on screen; a patch is not).
 */
export const MEAL_REVISION_SYSTEM_PROMPT = [
  'You revise an already-logged meal for a longevity-focused food logger, following one',
  'plain-English correction from the user.',
  '',
  'Rules:',
  '- Return the COMPLETE revised item list, not a patch.',
  '- Change ONLY what the correction implies. Every other item must come back with the same',
  '  name, amount, unit, macros and micros it went in with — do not re-estimate the meal.',
  '- An item\'s "unit" is "ml" for anything drunk and "g" for anything eaten. Keep the unit',
  '  each item arrived with unless the correction itself changes what the item is; never',
  '  restate a millilitre amount as grams.',
  '- A correction may remove an item, add one, rename one, or change its portion. Apply what',
  '  was actually said and nothing more.',
  '- An item shown with parts indented under it is ONE composite dish. Return it as one item',
  '  with those parts in "components" and NO macros of its own, unless the correction is that',
  '  it was never a composite. A correction to one part changes that part only.',
  '- Keep "pieces" as it arrived unless the correction itself changes the count.',
  '- When a swap changes the cooking fat, carry the portion across sensibly (the same amount',
  '  of oil as there was butter) unless the user gave an amount.',
  '- Keep per-item confidence honest: an item the user has just corrected is usually more',
  '  certain, not less; one you had to infer is "low".',
  '- Give sodium and caffeine in milligrams, under "micros", on the same terms as an',
  '  estimate: only where the item plausibly carries them, omitted where you would be',
  '  guessing, and for the portion stated rather than per 100 g.',
  '- Use the notes field to say what you changed, in one short sentence.',
  '',
  'Questions (optional, and USUALLY ABSENT):',
  '- Only when the correction itself left something ambiguous that would move the estimate by',
  '  more than ~15% of its energy, and only what the person was there for — never what',
  '  happened in a kitchen they did not stand in. An empty list is the norm.',
  '- At most 3, each with 2-4 button answers, and each answer carrying the EFFECT of choosing',
  '  it: {"scale_item": name, "factor": n} · {"set_amount": name, "amount": n} ·',
  '  {"remove_item": name} · {"add_item": {name, amount, unit, kcal, protein_g, carbs_g, fat_g}}',
  '- Name the most likely answer first; the items you return must already assume it.',
  '',
  'Respond with ONLY a JSON object, no prose, matching:',
  '{"title": string, "items": [{"name": string, "amount": number|null, "unit": "g"|"ml",',
  ' "kcal": number, "protein_g": number, "carbs_g": number, "fat_g": number,',
  ' "fiber_g": number|null,',
  ' "micros": {"sodium_mg": number, "caffeine_mg": number}|null,',
  ' "confidence": "high"|"medium"|"low",',
  ' "pieces": {"name": string, "count": number}|null,',
  ' "components": [{"name": string, "amount": number|null, "unit": "g"|"ml", "kcal": number,',
  '   "protein_g": number, "carbs_g": number, "fat_g": number, "fiber_g": number|null}]|null}],',
  ' "notes": string|null,',
  ' "questions": [{"id": string, "ask": string, "allow_other": boolean,',
  '   "options": [{"label": string, "effect": <one of the four above>}]}]}',
].join('\n');

/** Build the revision request: the meal as it stands, then the correction. */
export function buildMealRevisionRequest(
  meal: MealRevisionSubject,
  instruction: string
): MealEstimationRequest {
  const line = (item: MealRevisionItem, indent: string): string[] => {
    // Only the two micros the model is asked for. The rest of the vocabulary
    // comes off the catalog food at grounding time, so showing it here would
    // invite the model to restate numbers it never estimated.
    const micros = parseMicros(item.micros);
    const parts = [
      // The stored unit, printed as it stands. The model is shown the meal in
      // the units it was logged in, which is the only way "leave it byte-
      // identical" can mean anything for a drink.
      item.amount === null ? null : `${Math.round(item.amount)} ${item.unit}`,
      item.kcal === null ? null : `${Math.round(item.kcal)} kcal`,
      item.protein_g === null ? null : `P ${Math.round(item.protein_g)}`,
      item.carbs_g === null ? null : `C ${Math.round(item.carbs_g)}`,
      item.fat_g === null ? null : `F ${Math.round(item.fat_g)}`,
      micros.sodium_mg == null ? null : `sodium ${Math.round(micros.sodium_mg)} mg`,
      micros.caffeine_mg == null ? null : `caffeine ${Math.round(micros.caffeine_mg)} mg`,
    ].filter(Boolean);
    // A composite header carries no numbers of its own (0058): it says how many
    // parts it has, and the parts are printed beneath it. "no numbers recorded"
    // would be a lie about a dish that is fully priced by its components.
    //
    // The one COUNT the model is ever shown is a header's piece count (0059),
    // printed through the same `countLabel` the screens use so the two cannot
    // drift. A catalog item's serving count is deliberately NOT printed — the
    // row shows `57 g, 104 kcal, …` as it always has — so `2 × 3 slices` never
    // sits beside `8 × slice` and there is no vocabulary to confuse.
    const components = item.components ?? [];
    const count = item.pieces ? `${countLabel(item.pieces.count, item.pieces.name)}, ` : '';
    const tail =
      components.length > 0
        ? ` — ${count}${components.length} parts`
        : parts.length > 0
          ? ` — ${parts.join(', ')}`
          : // An unpriced item says so in words. A blank tail would read as
            // zero, and the model would return zeros for it.
            ' — no numbers recorded';
    return [
      `${indent}- ${item.name}${tail}`,
      ...components.flatMap((part) => line(part, `${indent}  `)),
    ];
  };
  const rows = meal.items.flatMap((item) => line(item, ''));
  const text = [
    `Logged meal: ${meal.name}`,
    'Items as they stand:',
    ...rows,
    '',
    `Correction from the user: ${instruction}`,
  ].join('\n');
  return {
    system: MEAL_REVISION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  };
}

/**
 * Apply a plain-English correction to a logged meal — one turn through the
 * Coach's model client, no tools. Throws
 * {@link MealEstimationUnavailableError} when no key is set or the streaming
 * fetch is absent. The result is NOT written: the caller grounds it and lands
 * it in an editable review the user must confirm.
 */
export async function reviseMeal(
  meal: MealRevisionSubject,
  instruction: string,
  signal?: AbortSignal
): Promise<MealEstimate> {
  const apiKey = apiKeyStore.get();
  const fetchImpl = loadStreamingFetch();
  if (!apiKey || !fetchImpl) throw new MealEstimationUnavailableError();

  const req = buildMealRevisionRequest(meal, instruction);
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
    throw new Error('The model declined to revise this meal.');
  }
  return parseMealEstimate(text.length > 0 ? text : result.text);
}

// --- Describing a CATALOG ENTRY in plain English (C2) -------------------------
//
// Owner, backlog C2: *"Describe a food in words and AI fills the catalog
// entry's macros — yes."*
//
// This is a different job from estimating a meal, and it gets its own small
// prompt rather than a branch inside the estimator's:
//
//   * a MEAL is a list of portions eaten now; a catalog ENTRY is one food,
//     priced PER 100 of its basis, kept for life and re-used at any portion;
//   * the estimator's reply shape is a list of items with per-portion macros and
//     per-item confidence — none of which a `foods` row has a column for;
//   * every word the two prompts do not share is a word the other one pays for
//     on every call. The meal prompt is the expensive one (it rides a photo);
//     this one is a few hundred tokens of text.
//
// **Nothing here writes.** The reply is rendered into app/food-new.tsx's own
// fields for review and is saved only when the owner taps Save — at which point
// the row is stamped `source: 'ai'`, so an inferred number never wears the face
// of one he typed (the 0034 rule, one screen over).

/** One catalog entry as the model proposes it — the `foods` column names, so the
 *  screen's mapping is a rename-free assignment. Every figure may be null:
 *  "not recorded" is a state this catalog already draws, and a blank field is
 *  what it looks like. */
export type FoodEntryEstimate = {
  name: string;
  brand: string | null;
  /** What the food is measured in (0047). `'g'` unless the model said `ml`. */
  basis: AmountUnit;
  serving_name: string | null;
  /** The named serving's size, in `basis`. Pair-or-none with `serving_name`. */
  serving_amount: number | null;
  kcal_100g: number | null;
  protein_g_100g: number | null;
  carbs_g_100g: number | null;
  fat_g_100g: number | null;
  fiber_g_100g: number | null;
  /** Per-100-of-basis sodium/caffeine, or null when the model recorded neither. */
  micros: JsonText | null;
};

/**
 * The food-entry system prompt. Short on purpose — the model is filling one
 * row, and the three things it has to get right are stated as rules rather than
 * implied by the schema: **per 100 of the basis** (not per serving), **ml only
 * for a drink**, and **null rather than a guess**.
 *
 * The bounds are in the prompt as well as in the parser because a reply that
 * trips a CHECK is a field the user has to notice is missing; the schema limits
 * (a macro ≤ 100 g per 100, kcal ≤ 950) are cheap to state and they are the two
 * the model would otherwise break by pricing a serving instead of a hundred.
 */
export const FOOD_ENTRY_SYSTEM_PROMPT = [
  'You fill in ONE catalog entry for a longevity-focused food logger, from a plain-English',
  'description of a single food. Be calibrated, never confident beyond the evidence.',
  '',
  'Rules:',
  '- One food, never a meal. Name it the way a label would ("Rotisserie chicken thigh, skin',
  '  on"); "brand" only for a branded product, else null.',
  '- "basis" is what the food is MEASURED IN: "ml" for anything DRUNK — coffee, tea, juice,',
  '  soda, beer, wine, milk, a smoothie or shake — and "g" for everything eaten.',
  '- Give a household serving when one is natural ("1 thigh", "1 can"): "serving_name" plus',
  '  "serving_amount" in the basis. Both null when nothing natural exists.',
  '- Every macro figure is PER 100 of the basis, never per serving. A macro cannot exceed 100',
  '  and kcal cannot exceed 950 — if yours do, you have priced a serving by mistake.',
  '- Give sodium and caffeine in milligrams PER 100, under "micros", where the food plausibly',
  '  carries them: sodium for anything salted, cured, canned, processed or restaurant-made;',
  '  caffeine for coffee, tea, matcha, cola, energy drinks, dark chocolate, pre-workout. OMIT',
  '  the key when you would be guessing — absent means "not recorded", 0 means "measured',
  '  none", and they are not the same claim.',
  '- Use null for any figure you cannot estimate: a blank is honest, an invented number is not.',
  '',
  'Respond with ONLY a JSON object, no prose, matching:',
  '{"name": string, "brand": string|null, "basis": "g"|"ml",',
  ' "serving_name": string|null, "serving_amount": number|null,',
  ' "kcal_100": number|null, "protein_g_100": number|null, "carbs_g_100": number|null,',
  ' "fat_g_100": number|null, "fiber_g_100": number|null,',
  ' "micros": {"sodium_mg": number, "caffeine_mg": number}|null}',
].join('\n');

/** Build the food-entry request: the system prompt above, and the description. */
export function buildFoodEntryRequest(description: string): MealEstimationRequest {
  return {
    system: FOOD_ENTRY_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: [{ type: 'text', text: `Describe this food: ${description}` }] },
    ],
  };
}

/** A per-100 figure the schema will accept, or null. **Out of range is dropped,
 *  not clamped**: a clamp invents a number the model never gave and hides that
 *  it was wrong, while a blank is this form's own word for "not recorded" and is
 *  one tap from corrected. */
function per100(value: unknown, max: number): number | null {
  const n = num(value);
  return n !== null && n <= max ? n : null;
}

/**
 * Parse and validate the model's reply into a {@link FoodEntryEstimate}. Never
 * trusts the model's shape: unknown fields are dropped, out-of-range figures
 * become null (see {@link per100}), an unknown basis falls back to `'g'` — the
 * same permissive default `parseMealEstimate` takes, for the same reason: a food
 * nobody called a drink is a solid, and a mis-defaulted unit is visible and
 * fixable on the form the reply lands in.
 *
 * A reply with no usable NAME throws, because a nameless catalog row is not a
 * thing the user can be asked to review — it is a blank form with the typing
 * already done wrong.
 *
 * Tolerant of ```json fences and stray prose, like the meal parser.
 */
export function parseFoodEntry(replyText: string): FoodEntryEstimate {
  const start = replyText.indexOf('{');
  const end = replyText.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Food entry reply contained no JSON object.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(replyText.slice(start, end + 1));
  } catch {
    throw new Error('Food entry reply was not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Food entry reply was not a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (name === '') throw new Error('Food entry reply had no usable name.');

  const brand = typeof obj.brand === 'string' && obj.brand.trim() !== '' ? obj.brand.trim() : null;
  const servingName =
    typeof obj.serving_name === 'string' && obj.serving_name.trim() !== ''
      ? obj.serving_name.trim()
      : null;
  // A serving is pair-or-none in the schema, so it is pair-or-none here: a name
  // with no size is unusable and a size with no name is meaningless, and either
  // half alone would trip the table CHECK on save. The ceiling matches the one
  // the portion editors already enforce — 5,000 of anything is not a serving.
  const rawAmount = num(obj.serving_amount);
  const servingAmount = rawAmount !== null && rawAmount > 0 && rawAmount <= 5000 ? rawAmount : null;
  const paired = servingName !== null && servingAmount !== null;

  return {
    name,
    brand,
    basis: amountUnit(obj.basis),
    serving_name: paired ? servingName : null,
    serving_amount: paired ? servingAmount : null,
    kcal_100g: per100(obj.kcal_100, 950),
    protein_g_100g: per100(obj.protein_g_100, 100),
    carbs_g_100g: per100(obj.carbs_g_100, 100),
    fat_g_100g: per100(obj.fat_g_100, 100),
    fiber_g_100g: per100(obj.fiber_g_100, 100),
    // The same vocabulary filter the meal path uses: an invented key or a
    // non-number is dropped, and a food that returned nothing usable stores NULL
    // rather than an empty object.
    micros: serializeMicros(coerceMicros(obj.micros)),
  };
}

/**
 * Describe a food in words and get one catalog entry back — one turn through
 * the Coach's model client, no tools, no image. Throws
 * {@link MealEstimationUnavailableError} when no key is set or the streaming
 * fetch is absent (pre-rebuild), which the caller renders as the honest
 * needs-a-connection state rather than a broken form.
 *
 * **Writes nothing.** The caller renders the result into its own fields and the
 * row is created only when the user saves it.
 */
export async function estimateFoodEntry(
  description: string,
  signal?: AbortSignal
): Promise<FoodEntryEstimate> {
  const apiKey = apiKeyStore.get();
  const fetchImpl = loadStreamingFetch();
  if (!apiKey || !fetchImpl) throw new MealEstimationUnavailableError();

  const req = buildFoodEntryRequest(description);
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
    throw new Error('The model declined to describe this food.');
  }
  return parseFoodEntry(text.length > 0 ? text : result.text);
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
 * to a food with complete macros AND THE SAME UNIT, RE-PRICE the whole item from
 * that food's per-100 values at the estimated amount (setting foodId), so a
 * "Chicken breast" estimate inherits the seeded food's real macros. Everything
 * else — an ambiguous name, no match, a unit mismatch, or a match with
 * incomplete macros — keeps the model's own numbers verbatim, so grounding never
 * produces a half-catalog, half-model item. Confidence is untouched (portion uncertainty remains); the
 * review screen is the safety net for a wrong portion. Pure over the Database
 * interface, so it's headless-testable.
 */
export function groundMealEstimate(db: Database, estimate: MealEstimate): MealEstimate {
  const priceOne = <T extends MealEstimateItem | MealEstimateComponent>(item: T): T => {
    if (item.amount == null || item.amount <= 0) return item;
    const match: FoodRow | undefined = searchFoods(db, item.name, 1)[0];
    if (!match || !isConfidentMatch(normalizeFoodName(item.name), match.name_norm)) return item;
    // The UNITS have to agree, not just the name. Re-pricing a 250 ml coffee
    // from a per-100-g food would multiply a volume by a mass's macros and show
    // the result under the same name and confidence — the exact silent-worsening
    // this function's name rule exists to prevent, one axis over. A mismatch
    // keeps the model's own numbers, which are at least self-consistent.
    if (match.basis !== item.unit) return item;
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
    const priced = itemForPortion(match, { amount: item.amount });
    return {
      ...item,
      kcal: priced.kcal ?? item.kcal,
      protein_g: priced.protein_g ?? item.protein_g,
      carbs_g: priced.carbs_g ?? item.carbs_g,
      fat_g: priced.fat_g ?? item.fat_g,
      // Fiber may be genuinely absent on the food; keep the model's when so.
      fiber_g: priced.fiber_g ?? item.fiber_g,
      // Carry the food's per-portion micros snapshot too, so a grounded item is
      // as complete as one added by hand (servings.ts). A food that records
      // none leaves the model's own sodium/caffeine standing rather than
      // erasing them — which is how a catalog coffee with no micros row still
      // logs its caffeine. Not merged key by key: a food that records micros at
      // all is the better source for all of them, and half-catalog/half-model
      // is the one shape this function exists to avoid.
      micros: priced.micros ?? item.micros,
      foodId: match.id,
    };
  };
  const items = estimate.items.map((item) => {
    // A COMPOSITE HEADER IS NEVER PRICED (0058). The seed catalog holds
    // whole-dish archetypes — 'Pizza, cheese slice', 'Cheeseburger, fast food',
    // 'Chicken burrito' — each one leading phrase away from what a model
    // actually writes, so grounding a header would re-price the dish into
    // numbers that contradict the parts drawn beneath it. The parts ARE
    // grounded: a single-token name ("cheese", "crust") fails isConfidentMatch
    // by design and keeps the model's numbers, which is the correct outcome.
    if (isCompositeEstimateItem(item)) {
      return { ...item, components: (item.components ?? []).map(priceOne) };
    }
    return priceOne(item);
  });
  return { ...estimate, items };
}
