/**
 * Sodium, caffeine and fiber — the owner's three (backlog A8) — where he reads
 * them without opening the micronutrients screen (2026-09-23). Pure and
 * DB-free, so the Eat tab, the meal screen, the estimator's review table, the
 * Coach's day payload and db/nutrition-v2.test.mjs all read the same rule.
 *
 * The owner, from the device:
 *
 *   - "Sodium and caffeine more accessible"
 *   - "Fiber should be more visible too"
 *   - "Important micro should show on key items; i.e., displaying caffeine on
 *     a latte"
 *
 * Two readings answer them: {@link keyMicro}, the one figure an ITEM row is
 * worth showing, and {@link dayKeyMicros}, the three DAY totals the Today grid
 * carries under its macro bars.
 *
 * **No signal colour, anywhere here.** A daily micro total is not a biological
 * state, so the firewall holds (00-design-spec.md §2). The macro bars' colours
 * are an owner override for MACROS only (docs/project-status.md §3) and it does
 * not reach these: they are mono figures against a reference, never a verdict.
 */
import { fmtInt, fmtQty } from './format';
import { MICROS, type Micros, parseMicros } from './micros';

// --- One notable figure on an item row ---------------------------------------

/**
 * Sodium earns an item row at a FIFTH of its 2,300 mg limit — 460 mg — which is
 * the FDA's own "high in" line (21 CFR 101.54(b): 20% or more of the Daily
 * Value). Below it, sodium is on every savoury item and saying so on each would
 * be noise; above it, one item is a real part of the day's limit.
 */
export const KEY_SODIUM_SHARE = 0.2;

/**
 * Fiber earns an item row at 5 g — roughly a fifth of a day's worth at the
 * FDA's 28 g Daily Value, the same share sodium uses, and a round figure a
 * person can hold. A bowl of lentils clears it; a slice of toast does not.
 */
export const KEY_FIBER_G = 5;

/** The one figure an item row shows, and the words it is shown in. */
export type KeyMicro = {
  key: 'caffeine_mg' | 'sodium_mg' | 'fiber_g';
  /** The amount, in the unit the label names. */
  value: number;
  /** "145 mg caffeine" · "620 mg sodium" · "8 g fiber" — mono, as printed. */
  label: string;
};

const SODIUM_LIMIT = MICROS.find((m) => m.key === 'sodium_mg')?.reference ?? 2300;

/**
 * The one micro worth printing on an item row, or null — **one figure per row
 * at most**, in this order:
 *
 * 1. **Caffeine, whenever the item records it** (and it rounds to at least
 *    1 mg). It is the one the owner named by example — a latte — and the one
 *    that matters at any size: it is a question about the next few hours, not
 *    only about the day's sum.
 * 2. **Sodium, only at {@link KEY_SODIUM_SHARE} of its limit or more.**
 * 3. **Fiber, only at {@link KEY_FIBER_G} or more.**
 *
 * A figure the item does not record never prints — "not recorded" is not 0 —
 * and nothing from the rest of the shortlist competes for the slot: the three
 * are the owner's, and the micronutrients screen holds the rest.
 *
 * Accepts the stored JSON (`meal_items.micros`) or an already-parsed object, so
 * a logged row, a review row and a composite's summed parts all go through it.
 */
export function keyMicro(item: {
  micros?: string | null | Micros;
  fiber_g?: number | null;
}): KeyMicro | null {
  const micros: Micros =
    typeof item.micros === 'object' && item.micros !== null
      ? item.micros
      : parseMicros(item.micros ?? null);
  const caffeine = micros.caffeine_mg;
  if (caffeine != null && Math.round(caffeine) >= 1) {
    return { key: 'caffeine_mg', value: caffeine, label: `${fmtInt(caffeine)} mg caffeine` };
  }
  const sodium = micros.sodium_mg;
  if (sodium != null && sodium >= SODIUM_LIMIT * KEY_SODIUM_SHARE) {
    return { key: 'sodium_mg', value: sodium, label: `${fmtInt(sodium)} mg sodium` };
  }
  const fiber = item.fiber_g;
  if (fiber != null && fiber >= KEY_FIBER_G) {
    return { key: 'fiber_g', value: fiber, label: `${fmtQty(fiber)} g fiber` };
  }
  return null;
}

/** {@link keyMicro}'s label, or null — what a row's sub-line appends. */
export function keyMicroLabel(item: {
  micros?: string | null | Micros;
  fiber_g?: number | null;
}): string | null {
  return keyMicro(item)?.label ?? null;
}

/**
 * A composite's parts as one item, for {@link keyMicro}: the dish's sodium is
 * the sum of its parts' sodium, and so on. The same NULL discipline as every
 * roll-up here — a key sums over the parts that record it, and is absent when
 * none does; fiber likewise.
 */
export function partsAsItem(parts: { micros?: string | null; fiber_g?: number | null }[]): {
  micros: Micros;
  fiber_g: number | null;
} {
  const micros: Micros = {};
  let fiber: number | null = null;
  for (const part of parts) {
    const own = parseMicros(part.micros);
    for (const m of MICROS) {
      const v = own[m.key];
      if (v != null) micros[m.key] = (micros[m.key] ?? 0) + v;
    }
    if (part.fiber_g != null) fiber = (fiber ?? 0) + part.fiber_g;
  }
  return { micros, fiber_g: fiber };
}

// --- The day's three, under the macro bars ------------------------------------

/** One of the Today grid's three readings. */
export type DayMicroReading = {
  key: 'sodium_mg' | 'caffeine_mg' | 'fiber_g';
  label: 'Sodium' | 'Caffeine' | 'Fiber';
  /** The day's total, formatted — or null when nothing today recorded it. */
  figure: string | null;
  unit: 'mg' | 'g';
  /**
   * What the figure is read against, in words: `of ~2,300 limit` for the two
   * ceilings, `of 30 g` against the owner's fiber target, `no target set` with
   * none, and `not recorded` under an absent figure.
   */
  against: string;
  /** The same sentence for VoiceOver, since the cell is three short lines. */
  spoken: string;
};

/**
 * The three readings the Today grid draws, in the owner's order of mention —
 * sodium, caffeine, fiber.
 *
 * - **Sodium and caffeine against their ceilings** — `of ~2,300 limit`,
 *   `of ~400 limit`, the references `src/lib/nutrition/micros.ts` sources
 *   (FDA). The tilde is the honesty: a general figure for healthy adults, not
 *   a target he set and not a line a gram past which anything happens.
 * - **Fiber against HIS target** (`nutrition_targets.fiber_g`), the same value
 *   the micros screen and the Coach read. With no target the figure stands
 *   alone and says so — no denominators until targets exist
 *   (00-design-spec.md §5).
 * - **Nothing recorded is an em-dash, never a 0.** `fiberEaten` is null when no
 *   item today recorded fiber (`dayFiberRecorded`), which is not the same
 *   claim as a day of zero-fiber foods.
 */
export function dayKeyMicros(input: {
  micros: Micros;
  fiberEaten: number | null;
  fiberTarget: number | null;
}): DayMicroReading[] {
  const ceiling = (key: 'sodium_mg' | 'caffeine_mg', label: 'Sodium' | 'Caffeine') => {
    const reference = MICROS.find((m) => m.key === key)?.reference ?? 0;
    const value = input.micros[key];
    const limit = `of ~${fmtInt(reference)} limit`;
    return value == null
      ? {
          key,
          label,
          figure: null,
          unit: 'mg' as const,
          against: 'not recorded',
          spoken: `${label}, not recorded today`,
        }
      : {
          key,
          label,
          figure: fmtInt(value),
          unit: 'mg' as const,
          against: limit,
          spoken: `${label}, ${fmtInt(value)} milligrams of about ${fmtInt(reference)} limit`,
        };
  };
  const target = input.fiberTarget !== null && input.fiberTarget > 0 ? input.fiberTarget : null;
  const fiber: DayMicroReading =
    input.fiberEaten == null
      ? {
          key: 'fiber_g',
          label: 'Fiber',
          figure: null,
          unit: 'g',
          against: 'not recorded',
          spoken: 'Fiber, not recorded today',
        }
      : {
          key: 'fiber_g',
          label: 'Fiber',
          figure: fmtInt(input.fiberEaten),
          unit: 'g',
          against: target !== null ? `of ${fmtInt(target)} g` : 'no target set',
          spoken:
            target !== null
              ? `Fiber, ${fmtInt(input.fiberEaten)} of ${fmtInt(target)} grams`
              : `Fiber, ${fmtInt(input.fiberEaten)} grams, no target set`,
        };
  return [ceiling('sodium_mg', 'Sodium'), ceiling('caffeine_mg', 'Caffeine'), fiber];
}

/**
 * How many of the day's meals carry numbers but no items — typed totals, which
 * record no sodium, caffeine or fiber by construction. `itemCounts` is
 * `mealItemCounts`' map (a meal with items has an entry). A meal with no
 * numbers at all is not counted: it adds nothing to anything, and the grid's
 * own note already says so.
 */
export function countTotalsOnlyMeals(
  meals: {
    id: string;
    kcal: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
  }[],
  itemCounts: Record<string, number>
): number {
  return meals.filter(
    (meal) =>
      (itemCounts[meal.id] ?? 0) === 0 &&
      (meal.kcal != null || meal.protein_g != null || meal.carbs_g != null || meal.fat_g != null)
  ).length;
}

/**
 * The one caveat the three need on the Today grid, or null.
 *
 * A meal logged as TOTALS only (typed kcal and macros, no items) records no
 * sodium, caffeine or fiber by construction — those live on items — so a day
 * holding one undercounts all three, silently, unless it is said. Said in one
 * line, and only on a day it is true.
 *
 * (Items without a micros record — most seed foods — are the everyday case and
 * the micronutrients screen's own caveat covers them; flagging those here would
 * put the sentence on every day there is.)
 */
export function totalsOnlyNote(totalsOnlyMeals: number): string | null {
  if (totalsOnlyMeals <= 0) return null;
  return totalsOnlyMeals === 1
    ? 'A meal logged as totals only adds no sodium, caffeine or fiber here.'
    : `${totalsOnlyMeals} meals logged as totals only add no sodium, caffeine or fiber here.`;
}
