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
  /**
   * Figures the basis chip converted from what was TYPED, by field (a macro's
   * field name, or a micro's key). Absent when there are none — a form opened
   * from a row has none. See {@link TypedFigure}.
   */
  typed?: Partial<Record<string, TypedFigure>>;
};

/**
 * A typed figure the basis chip converted (2026-10-21 fix round): the text as
 * typed, the basis it was typed on, the serving it was converted by, and the
 * 2 dp text the chip printed (`shown`). While the field still shows `shown` and
 * the serving is unchanged, the chip converts back to the typed text itself and
 * Save writes the typed value — not the print's: protein 0.3 per 100 g is 0.02
 * in a 5 g serving, and 0.02 is 0.4 per 100 g.
 */
export type TypedFigure = { text: string; basis: EntryBasis; serving: number; shown: string };

/** The carried figure for `key`, if the field still shows what the chip printed
 *  from it and the serving it was converted by still stands. */
function liveTyped(
  form: FoodForm,
  key: string,
  text: string,
  serving: number | null
): TypedFigure | undefined {
  const carried = form.typed?.[key];
  return carried && carried.shown === text && carried.serving === serving ? carried : undefined;
}

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

/**
 * The text a stored per-100 figure prints as on `basis`, with a serving of
 * `serving` — what the field shows for a figure nobody has typed over.
 */
function storedText(stored: number | null | undefined, basis: EntryBasis, serving: number): string {
  if (stored == null) return '';
  return numText(basis === 'serving' ? (stored * serving) / 100 : stored);
}

/** The figure fields one basis chip governs: the macros, then each micro. */
const MACRO_FIELDS = [
  ['kcal', 'kcal_100g'],
  ['protein', 'protein_g_100g'],
  ['carbs', 'carbs_g_100g'],
  ['fat', 'fat_g_100g'],
  ['fiber', 'fiber_g_100g'],
] as const;

/**
 * Tap the other entry-basis chip (2026-10-21 review). The fields hold figures
 * on the CURRENT basis, and switching it without converting them would
 * reinterpret every one — an edit opened per 100 ml, switched to per serving,
 * would save 132.89 kcal as per 250 ml. So every figure is converted by the
 * serving (per-100 × serving / 100, and back), micros included, and the
 * numbers on screen keep meaning the same food.
 *
 * A field nobody has typed over (its text is still what the stored figure
 * prints as on this basis) is converted from the STORED number, not its 2 dp
 * text, so per 100 → per serving → per 100 lands on exactly the text it
 * opened with, and Save writes the stored value back unchanged. A field that
 * WAS typed is carried the same way (`typed`, {@link TypedFigure}): converted
 * from the typed number, and back to its typed text exactly.
 *
 * Null when it cannot convert: figures are filled and there is no serving
 * size above zero to convert them by. The screen says why and stays put.
 */
export function switchEntryBasis(
  form: FoodForm,
  next: EntryBasis,
  original?: { food: FoodRow }
): FoodForm | null {
  if (next === form.entryBasis) return form;
  const figureTexts = [
    ...MACRO_FIELDS.map(([field]) => form[field]),
    ...MICROS.map((m) => form.micros[m.key] ?? ''),
  ];
  const serving = toNumber(form.servingAmount);
  if (serving === null || !Number.isFinite(serving) || serving <= 0) {
    return figureTexts.every((t) => t.trim() === '') ? { ...form, entryBasis: next } : null;
  }
  const food = original && original.food.basis === form.unit ? original.food : undefined;
  const storedMicros = parseMicros(food?.micros);
  const typed: Partial<Record<string, TypedFigure>> = {};
  const convert = (key: string, text: string, stored: number | null | undefined): string => {
    // Converted from a typed figure and untouched since: back to it as typed
    // (with two bases, the way back is always to the basis it was typed on).
    const carried = liveTyped(form, key, text, serving);
    if (carried) return carried.text;
    if (food && stored != null && text === storedText(stored, form.entryBasis, serving)) {
      return storedText(stored, next, serving);
    }
    const t = text.trim();
    if (t === '' || !validNumber(t)) return text;
    const n = Number(t);
    const shown = numText(next === 'serving' ? (n * serving) / 100 : (n * 100) / serving);
    typed[key] = { text, basis: form.entryBasis, serving, shown };
    return shown;
  };
  const { typed: carriedBefore, ...rest } = form;
  void carriedBefore;
  const out: FoodForm = { ...rest, entryBasis: next, micros: { ...form.micros } };
  for (const [field, column] of MACRO_FIELDS) {
    out[field] = convert(field, form[field], food?.[column]);
  }
  for (const m of MICROS) {
    const text = form.micros[m.key];
    if (text !== undefined) out.micros[m.key] = convert(m.key, text, storedMicros[m.key]);
  }
  if (Object.keys(typed).length > 0) out.typed = typed;
  return out;
}

/**
 * The micros a Save writes: the stored payload with ONLY the shortlist's keys
 * replaced by the form's. A key the form has no field for (`alcohol_g`, which
 * Night out writes, and anything outside the vocabulary) passes through
 * untouched, in its stored order — the Coach's edit already writes `micros`
 * back as it read it, and the screen now agrees. Unchanged, the stored text
 * itself is returned, so an untouched edit is no content change.
 */
function mergedMicros(storedJson: string | null | undefined, fromForm: Micros): string | null {
  let stored: Record<string, unknown> = {};
  if (storedJson) {
    try {
      const parsed: unknown = JSON.parse(storedJson);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        stored = parsed as Record<string, unknown>;
      }
    } catch {
      stored = {};
    }
  }
  const shortlist = new Set<string>(MICROS.map((m) => m.key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored)) {
    if (!shortlist.has(k)) out[k] = v;
    else if (fromForm[k as MicroKey] !== undefined) out[k] = fromForm[k as MicroKey];
  }
  for (const m of MICROS) {
    const v = fromForm[m.key];
    if (v !== undefined && !(m.key in out)) out[m.key] = v;
  }
  if (Object.keys(out).length === 0) return null;
  const json = JSON.stringify(out);
  return storedJson && json === JSON.stringify(stored) ? storedJson : json;
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
  // Still in the unit it opened in: an untouched field is its stored value. Per
  // 100, untouched is the text it opened with; per serving, it is the text the
  // chip printed from the stored figure (`switchEntryBasis`) for this serving.
  const verbatim = original !== undefined && unit === original.food.basis;
  const factor = entryBasis === 'serving' && servingUsable ? 100 / serving : 1;
  const per100 = (
    key: string,
    text: string,
    opened: string | undefined,
    stored: number | null
  ): number | null => {
    // Shown by the basis chip from a typed figure, untouched since: the TYPED
    // value is written, not its 2 dp print converted back (`TypedFigure`).
    const carried = servingUsable ? liveTyped(form, key, text, serving) : undefined;
    if (carried && carried.basis !== entryBasis && validNumber(carried.text)) {
      const n = Number(carried.text.trim());
      return carried.basis === 'per100' ? n : round2((n * 100) / carried.serving);
    }
    if (verbatim && entryBasis === 'per100' && opened !== undefined && text === opened) {
      return stored;
    }
    if (
      verbatim &&
      entryBasis === 'serving' &&
      servingUsable &&
      stored !== null &&
      text === storedText(stored, 'serving', serving)
    ) {
      return stored;
    }
    const n = toNumber(text);
    if (n === null) return null;
    return entryBasis === 'serving' ? round2(n * factor) : n;
  };

  const o = original?.food;
  const of = original?.form;
  const kcal = per100('kcal', form.kcal, of?.kcal, o?.kcal_100g ?? null);
  const protein = per100('protein', form.protein, of?.protein, o?.protein_g_100g ?? null);
  const carbs = per100('carbs', form.carbs, of?.carbs, o?.carbs_g_100g ?? null);
  const fat = per100('fat', form.fat, of?.fat, o?.fat_g_100g ?? null);
  const fiber = per100('fiber', form.fiber, of?.fiber, o?.fiber_g_100g ?? null);

  if (kcal !== null && kcal > 950) {
    return { ok: false, problem: `kcal per 100 ${unit} can’t exceed 950 (pure fat is ~884).` };
  }
  if ([protein, carbs, fat, fiber].some((m) => m !== null && m > 100)) {
    return { ok: false, problem: `A macro can’t exceed 100 g per 100 ${unit} of food.` };
  }

  const storedMicros = parseMicros(o?.micros);
  const micros: Micros = {};
  for (const m of MICROS) {
    const v = per100(
      m.key,
      form.micros[m.key] ?? '',
      of?.micros[m.key] ?? '',
      storedMicros[m.key] ?? null
    );
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
      // An edit keeps every key the form has no field for (`mergedMicros`).
      micros: o ? mergedMicros(o.micros, micros) : serializeMicros(micros),
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
