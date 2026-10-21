/**
 * Open Food Facts barcode lookup — the one online-except-AI path in nutrition
 * (docs/nutrition-subapp.md §5). A scanned barcode resolves locally first
 * (findFoodByBarcode over the grown catalog); only a miss reaches the network,
 * and every hit is cached back into `foods` (source='openfoodfacts') so the
 * pantry converges to fully-offline scanning. A local hit that is still OFF's
 * own, unedited, is re-read in the background when online and healed if OFF
 * now says something different (`refreshOffFood`, 2026-10-21).
 *
 * Pure + fetch-injected, so the mapping is headless-testable (db/barcode.test.mjs)
 * and never imports op-sqlite or expo. OFF's ODbL private-use carve-out covers a
 * single-user, never-redistributed cache; the required custom User-Agent
 * identifies the app per OFF etiquette (well under 15 req/min by construction).
 *
 * Unit handling is conservative on purpose (research §1: branded/label data is
 * unreliable for magnesium, omega-3, and most vitamins): only the values OFF
 * reliably normalizes are mapped — macros/fiber in grams, and sodium /
 * potassium / calcium / iron / caffeine converted from OFF's grams to
 * milligrams (caffeine since 2026-09-23, under a tighter ceiling of its own). Every
 * value is range-checked — macros/kcal to the schema's bounds, micros to a
 * physical ceiling (a contributor who types 500 into the grams field of a
 * per-100 g sodium would otherwise cache 500,000 mg and blow up the day's
 * rollup) — so a garbage entry is dropped rather than stored or thrown on.
 *
 * ## Per 100, per serving, and what each is measured in (owner, 2026-10-21)
 *
 * *"I think barcode scanner for food logging misinterprets per serving and per
 * 100g / other sometimes."* The case that came with it: Lewis Road Creamery
 * chocolate milk, 750 ml, logged two 250 ml servings as **1,660 kcal**. The
 * cached row's "per 100" figures (332 kcal, P 10.8, C 31, F 18.4) were the
 * label's PER-SERVING figures — the OFF entry was wrong when it was first
 * scanned, and the cache then kept it forever. Five things change here:
 *
 * 1. **The two sets are cross-checked.** Where OFF holds a `_100g` and a
 *    `_serving` figure and the serving is known, `_serving` must be
 *    `_100g × serving / 100` (±10 %). If instead `_100g` ≈ `_serving` — the
 *    per-serving column typed into the per-100 one, exactly the case above —
 *    and the serving is not ~100, the per-100 figures are rebuilt from the
 *    per-serving ones. If neither fits, `_100g` is kept and the food is marked
 *    DOUBTFUL, which the portion screen says out loud.
 * 2. **Energy is checked against the macros.** 4P + 4C + 9F more than 35 % from
 *    the stated kcal (on anything over 20 kcal) marks the food doubtful
 *    ({@link energyLooksWrong}, pure, so a cached row is checked the same way).
 *    Energy given only in kJ is read as kJ ÷ 4.184.
 * 3. **A figure missing per 100 is read per serving**, divided by the serving's
 *    size — only when that size is known in the food's own unit. A product
 *    with per-serving figures and no such serving is refused (manual entry,
 *    name and brand filled), never cached as a food with no numbers.
 * 4. **The serving's unit is read, not assumed.** OFF's `serving_quantity_unit`,
 *    or — on an older entry without one — the unit `serving_size` prints,
 *    accepted only when its number agrees with `serving_quantity` (`33 cl` and
 *    330 agree; `33 cl` and 33 do not). `"250ml"` now reads as millilitres —
 *    the old `\bml\b` never matched it, there being no word boundary between a
 *    digit and a letter. A serving in a different unit from the figures, or an
 *    unknown one, is left off and the review says why.
 * 5. **The cache heals** — see the first paragraph.
 *
 * What is never done: converting grams to millilitres, or a volume to a mass.
 * Recognising that `33 cl` is a volume is not a conversion; dividing a
 * per-serving figure by a serving measured in a different unit would be.
 */
import { serializeMicros } from './micros';
import type { AmountUnit, NewFood } from './types';

const OFF_BASE = 'https://world.openfoodfacts.org/api/v2/product';
// `nutrition_data_per` is what makes a scanned drink a DRINK (0047): OFF states
// "100g" or "100ml" for the per-100 figures it publishes, so the basis is read
// off the product rather than guessed from its name. `serving_quantity_unit`
// is the unit OFF normalised `serving_quantity` into (2026-10-21).
const OFF_FIELDS =
  'product_name,product_name_en,brands,nutriments,serving_size,serving_quantity,serving_quantity_unit,nutrition_data_per';

/** OFF etiquette: identify the app — no personal data. Nothing that leaves the
 * device may carry PII except the AI call (local-first stance), so the contact
 * names the app, not the owner. */
export const OFF_USER_AGENT = 'ARC/0.1 (personal longevity app)';

/** The minimal fetch surface — global fetch and expo/fetch both satisfy it. */
export type OffFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Strip a scanned barcode to digits; '' when it isn't a usable code. */
export function normalizeBarcode(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** The product-lookup URL for a (digits-only) barcode. */
export function offProductUrl(barcode: string): string {
  return `${OFF_BASE}/${barcode}?fields=${OFF_FIELDS}`;
}

type OffNutriments = Record<string, unknown>;

function offNum(nutriments: OffNutriments, key: string): number | null {
  const v = nutriments[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** kJ per kcal — a physical constant, not a unit guess. */
const KJ_PER_KCAL = 4.184;

/** Energy in kcal on one basis (`100g` | `serving`): the kcal field, else the
 *  kJ field ÷ 4.184. */
function offKcal(nutriments: OffNutriments, on: '100g' | 'serving'): number | null {
  const kcal = offNum(nutriments, `energy-kcal_${on}`);
  if (kcal != null) return kcal;
  const kj = offNum(nutriments, `energy-kj_${on}`);
  return kj != null ? kj / KJ_PER_KCAL : null;
}

/** One nutrient on one basis; energy reads through {@link offKcal}. */
function onBasis(nutriments: OffNutriments, key: string, on: '100g' | 'serving'): number | null {
  return key === 'energy-kcal' ? offKcal(nutriments, on) : offNum(nutriments, `${key}_${on}`);
}

/**
 * Nothing physical exceeds its own mass: even pure salt is ~39,000 mg sodium
 * per 100 g. A value past this is a contributor unit-entry error — drop it
 * rather than cache an absurd milligram figure that would swamp the day's total.
 */
const MG_CEILING_PER_100G = 50000;

/**
 * Caffeine's own ceiling, per 100 of the product's basis: a tenth of it.
 *
 * OFF's label field for caffeine is entered in milligrams and normalised into
 * `caffeine_100g` in GRAMS, like every other mass nutrient — so an energy
 * drink's 32 mg per 100 ml arrives as `0.032`. The error this guards against is
 * a contributor typing the milligram figure into the grams field: that same
 * drink then reads 32,000 mg, which the generic 50,000 ceiling above would let
 * through, and one can would put 80,000 mg on the day's Caffeine cell.
 *
 * Nothing sold as food is a tenth caffeine. The densest foods in USDA FoodData
 * Central are the instant coffee and tea powders, a few per cent (instant
 * coffee, NDB 14214: 3,142 mg per 100 g); a caffeinated drink concentrate runs
 * to about 3,000 mg per 100 ml. Above 10,000 is a unit error or a supplement,
 * and either way it is dropped rather than cached.
 */
const CAFFEINE_MG_CEILING_PER_100 = 10000;

/** The schema's own bounds on a per-100 figure. */
const KCAL_CEILING_PER_100 = 950;
const MACRO_CEILING_PER_100 = 100;

/**
 * A unit a label prints, and how many grams or millilitres one of it is. Used
 * ONLY to check that `serving_size`'s own number agrees with OFF's normalised
 * `serving_quantity` — never to convert a stored figure.
 */
const SERVING_UNITS: Record<string, { unit: AmountUnit; per: number }> = {
  g: { unit: 'g', per: 1 },
  gr: { unit: 'g', per: 1 },
  gram: { unit: 'g', per: 1 },
  grams: { unit: 'g', per: 1 },
  kg: { unit: 'g', per: 1000 },
  mg: { unit: 'g', per: 0.001 },
  oz: { unit: 'g', per: 28.3495 },
  ml: { unit: 'ml', per: 1 },
  cl: { unit: 'ml', per: 10 },
  dl: { unit: 'ml', per: 100 },
  l: { unit: 'ml', per: 1000 },
  floz: { unit: 'ml', per: 29.5735 },
};

/**
 * The first `<number> <unit>` a serving text states — `"1 can (330 ml)"` and
 * `"250ml"` → that many ml, `"33 cl"` → 330 ml, `"30g"` → 30 g — or null when
 * it states none (`"1 bar"`, `"a handful"`). The unit must END at a word
 * boundary, so `"250mlg"` is junk, not millilitres; it need not START at one,
 * which is what `"250ml"` needs. Alternation order matters: `fl oz` before
 * `oz`, the longer units before `l` and `g`.
 */
export function servingSizeMeasure(
  text: string | null | undefined
): { unit: AmountUnit; amount: number } | null {
  if (typeof text !== 'string') return null;
  const m = /(\d+(?:[.,]\d+)?)\s*(fl\.?\s*oz|grams|gram|gr|kg|mg|ml|cl|dl|oz|g|l)\b/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]!.replace(',', '.'));
  const key = m[2]!.toLowerCase().replace(/[.\s]/g, '');
  const unit = SERVING_UNITS[key];
  if (!unit || !Number.isFinite(n) || n <= 0) return null;
  return { unit: unit.unit, amount: n * unit.per };
}

/** Two readings of one serving agree: within 2 % (an ounce printed as 28 g). */
function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.02 * Math.max(a, b) + 0.05;
}

/** OFF's stated unit for `serving_quantity`, when it states one. */
function declaredServingUnit(product: Record<string, unknown>): AmountUnit | null {
  const u = typeof product.serving_quantity_unit === 'string' ? product.serving_quantity_unit : '';
  if (/^\s*ml\s*$/i.test(u)) return 'ml';
  if (/^\s*g\s*$/i.test(u)) return 'g';
  return null;
}

/**
 * What a scanned product is measured in (0047).
 *
 * OFF publishes its own answer in `nutrition_data_per` — `"100g"` or `"100ml"` —
 * and that field is authoritative for the very numbers being cached, so it is
 * read first. Where it is absent (older or sparser entries), the serving says:
 * OFF's stated `serving_quantity_unit`, then the unit the `serving_size` text
 * prints — `"330 ml"`, `"250ml"` and `"33 cl"` are volumes, `"30 g"` a mass.
 * Grams when nothing says.
 *
 * `nutrition_data_per` is only believed when it actually says `100g` / `100ml`.
 * OFF also writes `"serving"` there, which says nothing about the unit — and a
 * loose match would read the `g` in "serving" as an answer.
 */
function offBasis(product: Record<string, unknown>): AmountUnit {
  const per = typeof product.nutrition_data_per === 'string' ? product.nutrition_data_per : '';
  if (/^\s*100\s*ml/i.test(per)) return 'ml';
  if (/^\s*100\s*g/i.test(per)) return 'g';
  return (
    declaredServingUnit(product) ??
    servingSizeMeasure(product.serving_size as string | undefined)?.unit ??
    'g'
  );
}

/**
 * The serving's size IN THE FOOD'S OWN UNIT, or null with the reason it was not
 * kept (a clause, lower case). Pair-or-none, like the schema: a serving the
 * figures cannot be read against is no serving at all.
 */
function offServing(
  product: Record<string, unknown>,
  basis: AmountUnit
): { amount: number | null; why: string | null } {
  const qty =
    typeof product.serving_quantity === 'number'
      ? product.serving_quantity
      : Number(product.serving_quantity);
  if (!Number.isFinite(qty) || qty <= 0) return { amount: null, why: null };
  const size = typeof product.serving_size === 'string' ? product.serving_size.trim() : '';
  let unit = declaredServingUnit(product);
  if (unit === null) {
    const stated = servingSizeMeasure(size);
    if (stated && sameAmount(stated.amount, qty)) unit = stated.unit;
  }
  if (unit === null) {
    return {
      amount: null,
      why: `its serving${size ? ` (“${size}”)` : ''} doesn’t say what ${round1(qty)} is measured in`,
    };
  }
  if (unit !== basis) {
    return {
      amount: null,
      why: `its serving is ${round1(qty)} ${unit} but its figures are per 100 ${basis}`,
    };
  }
  return { amount: qty, why: null };
}

/** IEEE-754 noise off a divided figure (14 × 100 / 14 = 100.00000000000001). */
function clean(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function round1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Within label rounding: 10 %, or an absolute slack for small figures. */
function agrees(a: number, b: number, slack: number): boolean {
  return Math.abs(a - b) <= Math.max(0.1 * Math.max(a, b), slack);
}

/** The four figures the two sets are compared on, and the absolute slack a
 *  label's rounding is allowed on each (5 kcal, 1 g). */
const COMPARED: { key: string; slack: number }[] = [
  { key: 'energy-kcal', slack: 5 },
  { key: 'proteins', slack: 1 },
  { key: 'carbohydrates', slack: 1 },
  { key: 'fat', slack: 1 },
];

/**
 * What OFF's two sets of figures say about each other, given a known serving:
 *
 * - `consistent` — every compared figure has `_serving ≈ _100g × q / 100` (or
 *   there was nothing to compare);
 * - `swapped` — none disagrees outright, and at least one has `_100g ≈ _serving`
 *   where the serving is not ~100: the per-serving figures were typed into
 *   the per-100 column;
 * - `conflict` — anything else. Nothing here can say which number is wrong.
 */
function crossCheck(
  nutriments: OffNutriments,
  serving: number
): 'consistent' | 'swapped' | 'conflict' {
  const near100 = Math.abs(serving - 100) <= 10;
  let swapped = false;
  for (const c of COMPARED) {
    const per100 = onBasis(nutriments, c.key, '100g');
    const perServing = onBasis(nutriments, c.key, 'serving');
    if (per100 == null || perServing == null) continue;
    if (agrees((per100 * serving) / 100, perServing, c.slack)) continue;
    if (!near100 && agrees(per100, perServing, c.slack)) {
      swapped = true;
      continue;
    }
    return 'conflict';
  }
  return swapped ? 'swapped' : 'consistent';
}

/**
 * Whether a food's energy disagrees with its own macros: 4P + 4C + 9F more
 * than 35 % from the stated kcal, on anything over 20 kcal per 100, with all
 * three macros recorded. Pure, on the stored per-100 columns, so a cached row
 * is judged exactly as a fresh read is (the portion screen asks it of both).
 *
 * Alcohol (7 kcal/g) and sugar alcohols are not in the formula, so a beer or a
 * sugar-free sweet can trip it. It only ever adds a line asking the user to
 * check the label; it changes no number.
 */
export function energyLooksWrong(food: {
  kcal_100g: number | null;
  protein_g_100g: number | null;
  carbs_g_100g: number | null;
  fat_g_100g: number | null;
}): boolean {
  const { kcal_100g: kcal, protein_g_100g: p, carbs_g_100g: c, fat_g_100g: f } = food;
  if (kcal == null || p == null || c == null || f == null || kcal <= 20) return false;
  const fromMacros = 4 * p + 4 * c + 9 * f;
  return Math.abs(fromMacros - kcal) / kcal > 0.35;
}

/** How the figures were read, for the scanner's review to say (2026-10-21). */
export type OffLabel = {
  /**
   * `per100` — OFF's per-100 figures, as given; `serving` — at least one core
   * figure was read per serving and divided by the serving's size here;
   * `rescaled` — the per-100 column held the per-serving figures, and the
   * per-100 figures were rebuilt from them.
   */
  read: 'per100' | 'serving' | 'rescaled';
  /** Why a serving the product names was NOT kept, as a sentence; null when it
   *  was kept, or there was none to keep. */
  servingDropped: string | null;
  /** The figures were kept but cannot all be true — the two sets disagree, or
   *  the energy disagrees with the macros. The review says so. */
  doubtful: boolean;
};

/** The whole reading of one OFF response. */
export type OffRead =
  | { kind: 'food'; food: NewFood; label: OffLabel }
  /** Usable as a name, not as numbers: the scanner offers manual entry with
   *  the name and brand filled, and says why. */
  | { kind: 'refused'; name: string; brand: string | null; reason: string };

/**
 * Read an OFF v2 product response, or null when it is unusable (product not
 * found, or no name). Validates every numeric against the schema's bounds so a
 * returned food is always safe to createFood — and REFUSES, rather than
 * guesses, when a per-serving figure has nothing to be read against (see the
 * header).
 */
export function readOffProduct(response: unknown, barcode: string): OffRead | null {
  if (typeof response !== 'object' || response === null) return null;
  const root = response as Record<string, unknown>;
  if (root.status !== 1 || typeof root.product !== 'object' || root.product === null) return null;
  const product = root.product as Record<string, unknown>;

  const name =
    (typeof product.product_name === 'string' && product.product_name.trim()) ||
    (typeof product.product_name_en === 'string' && product.product_name_en.trim()) ||
    '';
  if (name === '') return null; // a nameless product is useless to log

  // A leading comma/blank makes split(',')[0] an empty segment even though the
  // whole string trims non-empty — coalesce that back to null (not recorded is
  // NULL, never a placeholder).
  const firstBrand =
    typeof product.brands === 'string' ? product.brands.split(',')[0]?.trim() : undefined;
  const brand = firstBrand ? firstBrand : null;
  const refuse = (reason: string): OffRead => ({ kind: 'refused', name, brand, reason });

  const nutriments: OffNutriments =
    typeof product.nutriments === 'object' && product.nutriments !== null
      ? (product.nutriments as OffNutriments)
      : {};

  const basis = offBasis(product);
  const serving = offServing(product, basis);
  const q = serving.amount;
  const servingName =
    typeof product.serving_size === 'string' && product.serving_size.trim() !== ''
      ? product.serving_size.trim()
      : '1 serving';

  // THE CROSS-CHECK — only possible with a serving in the food's own unit.
  const check = q != null ? crossCheck(nutriments, q) : 'consistent';

  /**
   * One nutrient per 100 of the basis.
   * - normally OFF's `_100g`, else its `_serving` ÷ the serving (`derived`);
   * - when `rescale` (the columns were swapped): the `_serving` figure ÷ the
   *   serving, else the `_100g` figure — which IS a per-serving figure — ÷ the
   *   serving, by the same diagnosis.
   * `unplaced` marks a per-serving figure with no serving to divide it by.
   */
  const read = (
    key: string,
    rescale: boolean
  ): { value: number | null; derived: boolean; unplaced: boolean } => {
    const per100 = onBasis(nutriments, key, '100g');
    const perServing = onBasis(nutriments, key, 'serving');
    if (rescale && q != null) {
      const v = perServing ?? per100;
      return { value: v == null ? null : clean((v * 100) / q), derived: false, unplaced: false };
    }
    if (per100 != null) return { value: per100, derived: false, unplaced: false };
    if (perServing == null) return { value: null, derived: false, unplaced: false };
    if (q == null) return { value: null, derived: false, unplaced: true };
    return { value: clean((perServing * 100) / q), derived: true, unplaced: false };
  };
  const readAll = (rescale: boolean) => ({
    kcal: read('energy-kcal', rescale),
    protein: read('proteins', rescale),
    carbs: read('carbohydrates', rescale),
    fat: read('fat', rescale),
    fiber: read('fiber', rescale),
  });
  const overCeiling = (f: ReturnType<typeof readAll>): boolean =>
    (f.kcal.value != null && f.kcal.value > KCAL_CEILING_PER_100) ||
    [f.protein, f.carbs, f.fat, f.fiber].some(
      (x) => x.value != null && x.value > MACRO_CEILING_PER_100
    );

  let rescaled = check === 'swapped';
  let doubtful = check === 'conflict';
  let figures = readAll(rescaled);
  // A rebuild that lands past the schema's bounds was the wrong diagnosis: keep
  // OFF's per-100 figures, and say they are doubtful.
  if (rescaled && overCeiling(figures)) {
    rescaled = false;
    doubtful = true;
    figures = readAll(false);
  }
  const core = [figures.kcal, figures.protein, figures.carbs, figures.fat];

  if (core.some((f) => f.unplaced)) {
    return refuse(
      `Open Food Facts has this product’s figures per serving only, and ` +
        `${serving.why ?? 'gives no serving size to read them against'}. Add it from the package.`
    );
  }
  // A per-serving figure that divides to more than the schema allows says the
  // serving's size is wrong — every other derived figure came through the same
  // division, so none of them is kept either.
  const derivedOver =
    (figures.kcal.derived &&
      figures.kcal.value != null &&
      figures.kcal.value > KCAL_CEILING_PER_100) ||
    [figures.protein, figures.carbs, figures.fat, figures.fiber].some(
      (f) => f.derived && f.value != null && f.value > MACRO_CEILING_PER_100
    );
  if (derivedOver) {
    return refuse(
      `Open Food Facts’ per-serving figures don’t fit its ${round1(q ?? 0)} ${basis} ` +
        'serving — they come to more than the food itself. Add it from the package.'
    );
  }

  // OFF's own per-100 figures past the schema's bounds are dropped (a unit typo
  // on one figure), as they always were.
  const bounded = (f: { value: number | null }, ceiling: number): number | null =>
    f.value != null && f.value <= ceiling ? f.value : null;

  // Micros, per 100 of the basis, read the same way as the macros. OFF stores
  // them in GRAMS → milligrams, dropping anything past `ceiling`.
  const mg = (key: string, ceiling: number = MG_CEILING_PER_100G): number | undefined => {
    const g = read(key, rescaled).value;
    if (g == null) return undefined;
    const v = g * 1000;
    return v <= ceiling ? v : undefined;
  };
  // Sodium: prefer the direct sodium field, else derive from salt (÷2.5),
  // subject to the same physical ceiling.
  const saltG = read('salt', rescaled).value;
  const fromSalt = saltG != null ? (saltG / 2.5) * 1000 : undefined;
  const sodiumRaw = mg('sodium') ?? fromSalt;
  const sodium_mg = sodiumRaw != null && sodiumRaw <= MG_CEILING_PER_100G ? sodiumRaw : undefined;
  const potassium_mg = mg('potassium');
  const calcium_mg = mg('calcium');
  const iron_mg = mg('iron');
  // The owner's example was a latte, and a scanned energy drink or cold brew is
  // the same fact (2026-09-23). Per 100 of the product's basis, like every
  // figure here — OFF's `_100g` is per 100 ml on a `100ml` product.
  const caffeine_mg = mg('caffeine', CAFFEINE_MG_CEILING_PER_100);

  const micros = serializeMicros({
    ...(sodium_mg != null ? { sodium_mg } : {}),
    ...(potassium_mg != null ? { potassium_mg } : {}),
    ...(calcium_mg != null ? { calcium_mg } : {}),
    ...(iron_mg != null ? { iron_mg } : {}),
    ...(caffeine_mg != null ? { caffeine_mg } : {}),
  });

  const food: NewFood = {
    name,
    brand,
    barcode,
    serving_name: q != null ? servingName : null,
    serving_amount: q,
    basis,
    kcal_100g: bounded(figures.kcal, KCAL_CEILING_PER_100),
    protein_g_100g: bounded(figures.protein, MACRO_CEILING_PER_100),
    carbs_g_100g: bounded(figures.carbs, MACRO_CEILING_PER_100),
    fat_g_100g: bounded(figures.fat, MACRO_CEILING_PER_100),
    fiber_g_100g: bounded(figures.fiber, MACRO_CEILING_PER_100),
    micros,
    source: 'openfoodfacts',
  };
  return {
    kind: 'food',
    food,
    label: {
      read: rescaled ? 'rescaled' : core.some((f) => f.derived) ? 'serving' : 'per100',
      servingDropped:
        serving.why === null
          ? null
          : `Serving left off: ${serving.why}. Log it by ${basis === 'ml' ? 'millilitres' : 'grams'}.`,
      doubtful:
        doubtful ||
        energyLooksWrong({
          kcal_100g: food.kcal_100g ?? null,
          protein_g_100g: food.protein_g_100g ?? null,
          carbs_g_100g: food.carbs_g_100g ?? null,
          fat_g_100g: food.fat_g_100g ?? null,
        }),
    },
  };
}

/**
 * The food alone, or null — for a caller with no use for the reading's notes
 * (and the mapping tests that predate them). A refused product is null here.
 */
export function parseOffProduct(response: unknown, barcode: string): NewFood | null {
  const read = readOffProduct(response, barcode);
  return read?.kind === 'food' ? read.food : null;
}

/** Distinguishes a "not found" from a network/parse failure for the UI. */
export class OffLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffLookupError';
  }
}

/**
 * Look a barcode up on Open Food Facts. Returns the reading ({@link OffRead}),
 * or null when the product isn't in OFF. Throws {@link OffLookupError} on a
 * network or non-2xx failure so the caller can tell "not found" (fall back to
 * manual) from "you're offline" (fall back to manual, differently worded). The
 * fetch is injected so this is testable and provider-agnostic.
 */
export async function lookupOffProduct(
  barcode: string,
  fetchImpl: OffFetch,
  signal?: AbortSignal
): Promise<OffRead | null> {
  const code = normalizeBarcode(barcode);
  if (code === '') return null;
  let response: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    response = await fetchImpl(offProductUrl(code), {
      method: 'GET',
      headers: { 'User-Agent': OFF_USER_AGENT, Accept: 'application/json' },
      signal,
    });
  } catch (error) {
    throw new OffLookupError(error instanceof Error ? error.message : 'Network request failed.');
  }
  if (!response.ok) {
    // A 404 from OFF means "no such product" — a clean miss, not an error.
    if (response.status === 404) return null;
    throw new OffLookupError(`Open Food Facts returned HTTP ${response.status}.`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OffLookupError('Open Food Facts sent an unreadable response.');
  }
  return readOffProduct(body, code);
}
