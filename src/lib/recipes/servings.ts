/**
 * **How many servings is this?** — a deterministic, offline guess from the
 * weights the ingredient lines already state (backlog C8: *"estimate number of
 * servings for recipe imports based on quantities."*).
 *
 * Every import has to land a `servings`, because `recipes.servings` is
 * `NOT NULL CHECK (servings > 0)` and every per-serving number in the sub-app
 * divides by it. Until now the review screen simply asked, and a source that
 * never said left the user to guess from a wall of ingredient lines — which is
 * the arithmetic a computer should be doing.
 *
 * ## The rule, in one line
 *
 * **The source's own yield always wins.** A caption that says "serves 4" has
 * told you the answer; nothing here may overrule it. This module only runs when
 * the source said nothing, and what it produces is a SUGGESTION — see the
 * provenance section below, which is the whole reason it does not just write the
 * number.
 *
 * ## The mass: only what the lines actually weigh
 *
 * `lineGrams` (src/lib/recipes/estimate.ts) is reused rather than re-derived,
 * and it converts MASS ONLY — g, kg, oz, lb. A cup of flour and a cup of oil
 * differ by density and this codebase has no density data and will not pretend
 * to (src/lib/recipes/ingredients.ts states that rule; the catalog pricing pass
 * obeys the same one). So "2 tbsp butter" and "2 cloves garlic" contribute
 * nothing to the total, which is the honest outcome and also nearly harmless:
 * the lines that carry a recipe's mass are the ones written with a mass.
 *
 * **The consequence must be stated, because it biases one way.** Unweighed lines
 * make the total too SMALL, so the estimate reads LOW — a curry whose only
 * weighed lines are the chickpeas and the tomatoes will suggest 2 servings where
 * the cook makes 4. That is why {@link estimateServings} refuses unless most of
 * the lines are weighed, why the coverage is printed beside the number on the
 * review, and why the number is a suggestion rather than a default.
 *
 * Two further honest limits, neither modelled:
 *   - **Raw, not finished.** These are ingredient weights. A stew loses water,
 *     a grain gains it. The review says "from the ingredient weights" for this
 *     reason, and never "from the finished dish".
 *   - **Inedible mass counts.** A whole chicken and a bag of unpeeled squash go
 *     in at their full weight. Both push the estimate high, partly offsetting
 *     the unweighed-line bias, and neither is worth a second table to correct.
 *
 * ## The table
 *
 * {@link SERVING_GRAMS} is **ARC's own portion convention**, not a citation, and
 * it is written that way on purpose: a convention is arguable and a measurement
 * is not, and this is a convention. Its anchor is the band the backlog names —
 * ~400–600 g per main-course serving — and the other rows are scaled off that by
 * what the dish physically IS, each stating the everyday object it is calibrated
 * to, so a row that is wrong for this cook is wrong *legibly*.
 *
 * | kind | g / serving | calibrated to |
 * | --- | --- | --- |
 * | `main` | 500 | a plated main: protein + starch + vegetable. The midpoint of C8's 400–600 g band, and the default for anything unrecognised. |
 * | `soup` | 400 | a bowl — ~400 ml of mostly water, and water is 1 g/ml. Covers stews and chilis. |
 * | `side` | 200 | one component of a plate rather than the plate. |
 * | `baked` | 90 | a slice of loaf, a muffin, two cookies. |
 * | `sauce` | 60 | a condiment portion — dressing, pesto, dip. |
 * | `drink` | 350 | a glass: a smoothie or a shake. |
 *
 * The kind is read off the TITLE ({@link classifyRecipe}) by a small keyword
 * table, most specific first, defaulting to `main`. A title is what the author
 * chose to call the dish, which makes it the best single signal available
 * offline — and being wrong costs a suggestion the user is about to confirm or
 * overrule, never a stored number.
 *
 * Pure and DB-free, so db/recipe-import.test.mjs exercises the table, the
 * coverage floor and the caption-wins rule directly.
 */
import { fmtInt } from '@/lib/nutrition/format';

import { lineGrams } from './estimate';
import { parseIngredientLine } from './ingredients';

/** The dish shapes the portion table distinguishes. `main` is the default. */
export type RecipeKind = 'main' | 'soup' | 'side' | 'baked' | 'sauce' | 'drink';

/** Grams of ingredient per serving, by dish shape. See the table in the header
 *  for what each row is calibrated to. */
export const SERVING_GRAMS: Record<RecipeKind, number> = {
  main: 500,
  soup: 400,
  side: 200,
  baked: 90,
  sauce: 60,
  drink: 350,
};

/**
 * Title keywords → kind, **in order**: the first row whose keyword appears wins,
 * so the specific shapes are listed before the general ones. "Chicken noodle
 * soup" is a soup before it is anything else; "banana bread" is baked before it
 * is a banana.
 *
 * Deliberately short. A keyword table that tries to cover every dish becomes a
 * thing nobody can reason about, and every miss lands on `main` — which is both
 * the commonest case and the one whose error the user is most likely to spot.
 */
const KIND_KEYWORDS: [RecipeKind, string[]][] = [
  ['drink', ['smoothie', 'shake', 'juice', 'latte', 'cocktail', 'lemonade', 'iced tea']],
  [
    'sauce',
    ['sauce', 'dressing', 'marinade', 'dip', 'pesto', 'salsa', 'chutney', 'hummus', 'glaze'],
  ],
  ['soup', ['soup', 'stew', 'chili', 'chilli', 'broth', 'bisque', 'chowder', 'ramen', 'pho']],
  [
    'baked',
    [
      'bread',
      'loaf',
      'cake',
      'muffin',
      'cookie',
      'biscuit',
      'brownie',
      'scone',
      'tart',
      'pie',
      'flapjack',
      'granola bar',
    ],
  ],
  ['side', ['side', 'slaw', 'pickle', 'relish', 'garnish']],
];

/**
 * The dish shape a title names, defaulting to `main`.
 *
 * Matched on a lowercased title with word boundaries loosened to plain substring
 * containment, which is right for this job: "Soups" and "Chicken Soup" both mean
 * soup, and a false hit costs a suggestion the user overrules rather than a
 * stored number. The one hazard substring matching has here is a keyword inside
 * an unrelated word ("piecrust" containing "pie"), and every such hit lands on
 * a kind that is still closer than the default.
 */
export function classifyRecipe(title: string): RecipeKind {
  const t = title.toLowerCase();
  for (const [kind, words] of KIND_KEYWORDS) {
    if (words.some((word) => t.includes(word))) return kind;
  }
  return 'main';
}

/** What a servings estimate knows about itself — enough for the review to state
 *  its whole basis in one sentence, which is what makes it confirmable. */
export type ServingsEstimate = {
  /** The suggestion: a whole number of servings, at least 1. */
  servings: number;
  /** Total grams the estimate was built from (mass-bearing lines only). */
  totalGrams: number;
  /** Lines that stated a mass. */
  linesCounted: number;
  /** Lines considered — the coverage denominator. */
  linesTotal: number;
  /** The dish shape read off the title. */
  kind: RecipeKind;
  /** The table value used, g per serving. */
  perServingG: number;
};

/** The floors, stated once so the refusal is readable at the call site. */
const MIN_LINES_COUNTED = 2;
const MIN_TOTAL_GRAMS = 100;
/** At most this many servings. A mis-parsed "2000 g" must not suggest 40. */
const MAX_SERVINGS = 24;

/** A line as the estimator reads it: the raw text is always there, the overlay
 *  may not be (a JSON-LD import carries raw lines only). */
export type EstimatableLine = {
  raw_text: string;
  qty?: number | null;
  unit?: string | null;
};

/**
 * The estimate, or **null when there is not enough weighed to guess from**.
 *
 * Three floors, each of which turns a confident wrong number into an honest
 * absence:
 *
 * 1. **At least 2 lines state a mass.** One weighed line in a nine-line recipe
 *    is not the recipe's mass, it is one ingredient of it, and dividing it by a
 *    serving size produces a number with no relationship to the yield.
 * 2. **At least half the lines state a mass** (`counted * 2 >= total`). This is
 *    the floor that handles the bias named in the header: an estimate built on a
 *    minority of the lines reads low by an unknown amount, so it is not offered.
 * 3. **At least 100 g in total.** Below that the recipe is a spice blend or the
 *    parse went wrong, and either way a serving count means nothing.
 *
 * A line with no overlay is parsed from its raw text (`parseIngredientLine`), so
 * this works identically on a model-extracted draft and on a deterministic
 * JSON-LD one that carries raw lines only.
 */
export function estimateServings(title: string, lines: EstimatableLine[]): ServingsEstimate | null {
  const linesTotal = lines.filter((l) => l.raw_text.trim() !== '').length;
  if (linesTotal === 0) return null;

  let totalGrams = 0;
  let linesCounted = 0;
  for (const line of lines) {
    if (line.raw_text.trim() === '') continue;
    // Prefer the overlay the extraction produced; fall back to parsing the raw
    // line, which is what a JSON-LD draft always needs.
    const overlay =
      line.qty != null && line.qty > 0
        ? { qty: line.qty, unit: line.unit ?? null }
        : parseIngredientLine(line.raw_text);
    const grams = lineGrams({ qty: overlay.qty ?? null, unit: overlay.unit ?? null });
    if (grams === null || grams <= 0) continue;
    totalGrams += grams;
    linesCounted += 1;
  }

  if (linesCounted < MIN_LINES_COUNTED) return null;
  if (linesCounted * 2 < linesTotal) return null;
  if (totalGrams < MIN_TOTAL_GRAMS) return null;

  const kind = classifyRecipe(title);
  const perServingG = SERVING_GRAMS[kind];
  const servings = Math.min(MAX_SERVINGS, Math.max(1, Math.round(totalGrams / perServingG)));
  return { servings, totalGrams, linesCounted, linesTotal, kind, perServingG };
}

/** What the review screen starts the Servings field from, and whether that
 *  number is the source's or ARC's. */
export type ServingsForReview = {
  /** The field's initial value — `null` means EMPTY, which is what an
   *  unconfirmed estimate leaves it as. */
  value: number | null;
  /** The estimate to offer, or null when there is nothing to offer (the source
   *  stated a yield, or nothing could be estimated). */
  estimate: ServingsEstimate | null;
};

/**
 * **The caption wins, and an estimate is never pre-filled.**
 *
 * This is the 0034 provenance rule applied to a number that has no column to
 * carry its provenance in: *an inferred number must not wear the face of one the
 * user asserted.* `recipes.servings` is a bare `real NOT NULL` — there is no
 * `resolved_by` beside it and (backlog C8) no migration to add one — so the only
 * place the distinction can be kept is BEFORE the write.
 *
 * So it is kept absolutely:
 *
 *  - **Source stated a yield** → that is the value, and no estimate is offered.
 *    "Serves 4" is the author's assertion and outranks any arithmetic over the
 *    ingredient list.
 *  - **Source said nothing, and an estimate exists** → the field starts EMPTY
 *    and the estimate is drawn beside it, marked as an estimate, with one
 *    control that puts it in. The existing Save gate already refuses an empty
 *    servings field, so an unconfirmed estimate is not merely un-saved, it is
 *    **unsaveable** — there is no path by which it reaches the database without
 *    a tap that means "yes, four".
 *  - **Neither** → the field starts empty and the screen asks, exactly as it did
 *    before C8.
 *
 * The weaker design — pre-fill the field and mark it — was rejected for one
 * reason: a marked pre-fill is still a number sitting in the field when the
 * user taps Save, and the mark is then decoration over a default. Leaving the
 * field empty is what makes the confirmation load-bearing rather than
 * decorative, and it is why nothing needed to be stored on the saved recipe:
 * an estimate that cannot be saved unconfirmed leaves no unconfirmed estimate on
 * a recipe to mark.
 */
export function servingsForReview(
  stated: number | null,
  estimate: ServingsEstimate | null
): ServingsForReview {
  if (stated !== null && stated > 0) return { value: stated, estimate: null };
  return { value: null, estimate };
}

/**
 * The estimate's whole basis, as the sentence the review prints under the field.
 *
 * It states every input — the mass, the coverage, the portion size and the dish
 * shape it came from — because a suggestion the user cannot check is a number
 * they can only obey. The coverage clause is the one that matters most: it is
 * the direction of the error (see the header), so it is said out loud rather
 * than buried in a docblock nobody on a phone can read.
 */
export function servingsEstimateBasis(estimate: ServingsEstimate): string {
  // Hermes has no Intl, so the thousands comma is hand-rolled (fmtInt), never
  // `toLocaleString` — the same call every other figure in the sub-app makes.
  const grams = fmtInt(estimate.totalGrams);
  const coverage =
    estimate.linesCounted === estimate.linesTotal
      ? `all ${estimate.linesTotal} lines`
      : `${estimate.linesCounted} of ${estimate.linesTotal} lines`;
  return `${grams} g across ${coverage} that give a weight, at about ${estimate.perServingG} g a ${KIND_NOUNS[estimate.kind]} serving. Ingredient weights, so a dish that cooks down yields less.`;
}

/** How each kind names itself inside the basis sentence. */
const KIND_NOUNS: Record<RecipeKind, string> = {
  main: 'main-course',
  soup: 'bowl',
  side: 'side',
  baked: 'baked',
  sauce: 'condiment',
  drink: 'glass',
};
