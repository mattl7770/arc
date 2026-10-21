/**
 * The catalog food form — what app/food-new.tsx's fields hold, and the food a
 * Save writes from them. Pure and DB-free, so the create path, the EDIT path
 * (owner, 2026-10-21: *"edit saved foods"*) and db/foods.test.mjs read one set
 * of rules.
 *
 * ## Storage is per 100; entry may be per serving
 *
 * Macros and micros are typed per 100 of the food's unit (the database way) or
 * per serving (the label way); a per-serving entry is divided by the serving's
 * size on Save, rounded to 2 dp — IEEE-754 overshoots that division (14 g of
 * fat in a 14 g serving is 100.00000000000001) and would trip the schema's
 * 100 g ceiling on a 100 %-macro staple.
 *
 * ## An edit writes back what nobody touched, exactly
 *
 * An edit opens with the stored figures printed to 2 dp, and a Save that wrote
 * those printed numbers back would round every untouched figure — a silent
 * change to a row the user did not change. So when a field's text is still
 * what it opened with (and the entry is still per 100 of the same unit), the
 * STORED number is written, not the text's. The same for each micro.
 *
 * ## Micros are fields now
 *
 * Until this round no screen typed a micro: a described food's arrived from the
 * model and were read out under the macros. The owner asked to edit them
 * (2026-10-21), so the whole shortlist (`MICROS`) is a field each, in its own
 * unit, stored per 100 like everything else. A blank field is "not recorded"
 * and removes the key — never a 0.
 */
import type { FoodUsage } from '@/lib/db/repositories/foods';

import { foodKeptPhrase } from './food-delete';
import { MICROS, type MicroKey, type Micros, parseMicros, serializeMicros } from './micros';
import type { AmountUnit, FoodRow, FoodSource, NewFood } from './types';

export type EntryBasis = 'per100' | 'serving';

/** Every field as the keyboard holds it. */
export type FoodForm = {
  name: string;
  brand: string;
  servingName: string;
  /** The serving's size, in `unit`. */
  servingAmount: string;
  unit: AmountUnit;
  entryBasis: EntryBasis;
  kcal: string;
  protein: string;
  carbs: string;
  fat: string;
  fiber: string;
  micros: Partial<Record<MicroKey, string>>;
};

export function emptyFoodForm(name: string = ''): FoodForm {
  return {
    name,
    brand: '',
    servingName: '',
    servingAmount: '',
    unit: 'g',
    entryBasis: 'per100',
    kcal: '',
    protein: '',
    carbs: '',
    fat: '',
    fiber: '',
    micros: {},
  };
}

/** A stored figure as the form's own text: 2 dp, blank for not recorded. */
export function numText(value: number | null | undefined): string {
  return value == null ? '' : String(Math.round(value * 100) / 100);
}

/** A per-100 micros payload as fields. */
export function microsText(json: string | null | undefined): Partial<Record<MicroKey, string>> {
  const micros = parseMicros(json);
  const out: Partial<Record<MicroKey, string>> = {};
  for (const m of MICROS) {
    const v = micros[m.key];
    if (v != null) out[m.key] = numText(v);
  }
  return out;
}

/** A catalog row as the form opens it for editing — per 100, its own unit. */
export function foodFormFromRow(food: FoodRow): FoodForm {
  return {
    name: food.name,
    brand: food.brand ?? '',
    servingName: food.serving_name ?? '',
    servingAmount: numText(food.serving_amount),
    unit: food.basis,
    entryBasis: 'per100',
    kcal: numText(food.kcal_100g),
    protein: numText(food.protein_g_100g),
    carbs: numText(food.carbs_g_100g),
    fat: numText(food.fat_g_100g),
    fiber: numText(food.fiber_g_100g),
    micros: microsText(food.micros),
  };
}

function validNumber(text: string): boolean {
  const t = text.trim();
  if (t === '') return true;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0;
}

function toNumber(text: string): number | null {
  const t = text.trim();
  return t === '' ? null : Number(t);
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** What the form makes, or why it makes nothing yet. `problem` is null when
 *  the only thing missing is a name — the disabled Save says that by itself. */
export type FoodFormResult = { ok: true; food: NewFood } | { ok: false; problem: string | null };

/**
 * The food a Save writes, or the one sentence that says why not.
 *
 * `original` is the row being edited and the form it opened as; with it, every
 * untouched figure writes back its stored value (see the header), and the
 * barcode and provenance are the row's own — an edit changes what was typed,
 * never where the food came from.
 */
export function readFoodForm(
  form: FoodForm,
  opts: {
    barcode: string | null;
    source: FoodSource;
    original?: { food: FoodRow; form: FoodForm };
  }
): FoodFormResult {
  const { unit, entryBasis } = form;
  const numbers = [form.servingAmount, form.kcal, form.protein, form.carbs, form.fat, form.fiber];
  const microTexts = MICROS.map((m) => form.micros[m.key] ?? '');
  if (![...numbers, ...microTexts].every(validNumber)) {
    return { ok: false, problem: 'Numbers only — leave a field blank if you don’t know it.' };
  }
  const serving = toNumber(form.servingAmount);
  const servingUsable = serving !== null && serving > 0;
  // The schema's pair-or-none rule, tightened to USABLE: a named serving needs
  // an amount ABOVE ZERO and vice versa — "1 cup" of 0 g would pass a
  // null-based pairing check and then trip the DB CHECK into a silent dead end.
  if ((form.servingName.trim() === '') !== !servingUsable) {
    return {
      ok: false,
      problem: `A serving needs both a name and its ${unit} above zero (or leave both blank).`,
    };
  }
  if (entryBasis === 'serving' && !servingUsable) {
    return { ok: false, problem: `Per-serving entry needs the serving ${unit} filled in first.` };
  }

  const original = opts.original;
  // Still per 100 of the unit it opened in: an untouched field is its stored value.
  const verbatim =
    original !== undefined && entryBasis === 'per100' && unit === original.food.basis;
  const factor = entryBasis === 'serving' && servingUsable ? 100 / serving : 1;
  const per100 = (text: string, opened: string | undefined, stored: number | null): number | null => {
    if (verbatim && opened !== undefined && text === opened) return stored;
    const n = toNumber(text);
    if (n === null) return null;
    return entryBasis === 'serving' ? round2(n * factor) : n;
  };

  const o = original?.food;
  const of = original?.form;
  const kcal = per100(form.kcal, of?.kcal, o?.kcal_100g ?? null);
  const protein = per100(form.protein, of?.protein, o?.protein_g_100g ?? null);
  const carbs = per100(form.carbs, of?.carbs, o?.carbs_g_100g ?? null);
  const fat = per100(form.fat, of?.fat, o?.fat_g_100g ?? null);
  const fiber = per100(form.fiber, of?.fiber, o?.fiber_g_100g ?? null);

  if (kcal !== null && kcal > 950) {
    return { ok: false, problem: `kcal per 100 ${unit} can’t exceed 950 (pure fat is ~884).` };
  }
  if ([protein, carbs, fat, fiber].some((m) => m !== null && m > 100)) {
    return { ok: false, problem: `A macro can’t exceed 100 g per 100 ${unit} of food.` };
  }

  const storedMicros = parseMicros(o?.micros);
  const micros: Micros = {};
  for (const m of MICROS) {
    const v = per100(form.micros[m.key] ?? '', of?.micros[m.key] ?? '', storedMicros[m.key] ?? null);
    if (v !== null) micros[m.key] = v;
  }

  // The serving's size: the stored one when untouched, as the figures are.
  const servingAmount =
    !servingUsable
      ? null
      : o && of && form.servingAmount === of.servingAmount && unit === o.basis
        ? o.serving_amount
        : serving;

  const name = form.name.trim();
  if (name === '') return { ok: false, problem: null };
  return {
    ok: true,
    food: {
      name,
      brand: form.brand.trim() === '' ? null : form.brand.trim(),
      barcode: opts.barcode,
      serving_name: form.servingName.trim() === '' ? null : form.servingName.trim(),
      serving_amount: servingAmount,
      basis: unit,
      kcal_100g: kcal,
      protein_g_100g: protein,
      carbs_g_100g: carbs,
      fat_g_100g: fat,
      fiber_g_100g: fiber,
      micros: serializeMicros(micros),
      source: opts.source,
    },
  };
}

/**
 * What saving an edit does, stated before it does it (00-design-spec.md §5):
 * the catalog entry changes, and nothing already logged does — every meal,
 * template and recipe line carries its own snapshot. The one live join is the
 * serving's NAME on an item counted in it ("2 × 1 egg"), so a renamed serving
 * says so.
 */
export function foodEditConsequence(usage: FoodUsage, servingRenamed: boolean): string {
  const kept = foodKeptPhrase({ ...usage, counted: 0 });
  const head =
    kept === null
      ? 'Changes the catalog entry. Nothing logged uses it yet.'
      : `Changes the catalog entry only — it is ${kept}. What you add from now on uses the new figures.`;
  if (!servingRenamed || !(usage.counted > 0)) return head;
  const n = usage.counted;
  return `${head} ${n} item${n === 1 ? '' : 's'} counted in its serving will read the new serving name.`;
}
