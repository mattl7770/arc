import type { Database } from '@/lib/db/database';
import { getFood } from '@/lib/db/repositories/foods';
import type {
  MealEstimate,
  MealRevisionItem,
  MealRevisionSubject,
  QuestionEffect,
} from './estimate';
import { parseMicros, scaleMicros, serializeMicros } from './micros';
import { itemForPortion, rescaleLoggedItem } from './servings';
import type {
  AmountUnit,
  EstimateConfidence,
  FoodRow,
  NewMealItem,
  NewMealItemComponent,
} from './types';

/**
 * The estimator review's ROWS — the pure half of the one review table both
 * `app/meal-estimate.tsx` and `app/meal-revise.tsx` draw. The JSX lives in
 * src/components/nutrition/estimate-review.tsx and re-exports everything here;
 * this file holds no React, so db/nutrition-v2.test.mjs drives the whole tree
 * — scaling, the last-part rule, answering a question — headlessly.
 *
 * ## Why this is shared and not duplicated
 *
 * The two screens have always drawn the same table, and until C4 they did it
 * with two copies of the same forty lines. Composite foods (0049) turn that
 * table into a **tree** with a disclosure, proportional scaling and a
 * last-component rule — which is exactly the kind of logic that must not drift
 * between two screens that are supposed to guarantee the same thing. The
 * estimator already states the principle for the pipeline (*"one schema, one
 * parser, one review"*); this is the review half of it.
 *
 * ## The ledger rule, mechanically
 *
 * The Items label carries the total of the rows visible beneath it, recomputed
 * from each row's live amount. A **composite header carries no numbers of its
 * own** — its amount and kcal are derived from its parts every render — so the
 * headline cannot come to disagree with the parts, by construction rather than
 * by maintenance.
 *
 * ## One surface device (00-design-spec.md §1)
 *
 * The Items block stays the single `Block device="plate"` it has always been. A
 * composite is **not** a nested plate: a block gets exactly one device, and the
 * drawing set's answer to subordination inside a ruled table is INDENTATION.
 * So the parts are ruled rows inside the same plate at `pl-6`, with no fill, no
 * left rule and no new mark.
 *
 * ## "I ate half" (owner decision, C4)
 *
 * Fraction chips `½ · ⅓ · ¼` plus the whole-dish amount field. Both scale every
 * part proportionally — halving the crust and not the cheese would be a claim
 * about *which* half, which nothing knows — and both act on the parts' CURRENT
 * values, so a hand-correction made first is what gets halved. Nothing is
 * written until the screen's own Save; what the chips move is the proposal.
 *
 * The amount field is live and non-compounding because it scales from a
 * SNAPSHOT taken when the field is focused, not from whatever it last produced.
 * Typing `3`, `36`, `360` into a 720 g pizza therefore lands on ×0.5, not on
 * ×0.5 ×0.5 ×0.5.
 */

/** The portion snapshot an amount edit re-scales from. */
export type ReviewBase = {
  amount: number | null;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  micros: string | null;
};

/** One priced row: a plain item, or one part of a composite. */
export type ReviewRow = {
  key: string;
  name: string;
  foodId: string | null;
  food: FoodRow | undefined;
  confidence: EstimateConfidence;
  base: ReviewBase;
  amountText: string;
  /** What the amount counts — the model's own call (0047). Shown beside the
   *  field and written onto the item; never converted for the oz preference. */
  unit: AmountUnit;
};

/** A top-level review row. `components` is empty for a plain item and holds the
 *  parts for a composite (0049); one level only. */
export type ReviewItem = ReviewRow & {
  components: ReviewRow[];
  expanded: boolean;
  /** The parts as they stood when the whole-dish field was focused — the
   *  baseline that keeps live scaling from compounding. Null when not editing. */
  scaleFrom: ReviewRow[] | null;
};

export function isComposite(row: ReviewItem): boolean {
  return row.components.length > 0;
}

export function parseAmount(text: string): number | null {
  const n = Number(text.trim());
  return Number.isFinite(n) && n > 0 && n <= 5000 ? n : null;
}

/**
 * Current macros/micros for a row at its edited amount — via the same tested
 * rescale used everywhere; falls back to the base when it cannot scale.
 */
export function currentPortion(row: ReviewRow) {
  const amount = parseAmount(row.amountText);
  if (amount != null) {
    const scaled = rescaleLoggedItem(row.base, row.food, { amount });
    if (scaled) return scaled;
  }
  return {
    // A validly-typed portion is kept even when macros can't be re-scaled (an
    // ungrounded, amountless item): the number the user entered is recorded
    // rather than silently dropped, and — since parseAmount only yields > 0 —
    // this is always null or positive, so it can never violate the schema's
    // CHECK(amount > 0).
    amount: amount ?? row.base.amount,
    serving_qty: null,
    kcal: row.base.kcal,
    protein_g: row.base.protein_g,
    carbs_g: row.base.carbs_g,
    fat_g: row.base.fat_g,
    fiber_g: row.base.fiber_g,
    micros: row.base.micros,
  };
}

/** NULL-skipping sum — "not recorded" never becomes 0. */
function sumOrNull(values: (number | null | undefined)[]): number | null {
  let sum: number | null = null;
  for (const v of values) {
    if (v != null) sum = (sum ?? 0) + v;
  }
  return sum;
}

/**
 * What a composite reads as, derived from its parts every render.
 *
 * An amount sums only when EVERY part has one and they share a unit — nothing
 * converts (B2/0047), and a partial sum would be a fabricated total.
 */
export function rolled(row: ReviewItem) {
  const portions = row.components.map(currentPortion);
  const units = new Set(row.components.map((c) => c.unit));
  const allPriced = portions.length > 0 && portions.every((p) => p.amount != null);
  return {
    amount:
      allPriced && units.size === 1 ? portions.reduce((s, p) => s + (p.amount ?? 0), 0) : null,
    unit: units.size === 1 ? (row.components[0]?.unit ?? row.unit) : row.unit,
    kcal: sumOrNull(portions.map((p) => p.kcal)),
    protein_g: sumOrNull(portions.map((p) => p.protein_g)),
    carbs_g: sumOrNull(portions.map((p) => p.carbs_g)),
    fat_g: sumOrNull(portions.map((p) => p.fat_g)),
    fiber_g: sumOrNull(portions.map((p) => p.fiber_g)),
  };
}

/** The visible total: a plain row's own kcal, a composite's parts' sum. */
export function reviewKcal(rows: ReviewItem[]): number | null {
  return rows.reduce<number | null>((sum, row) => {
    const kcal = isComposite(row) ? rolled(row).kcal : currentPortion(row).kcal;
    return kcal == null ? sum : (sum ?? 0) + kcal;
  }, null);
}

/** @internal Exported for the drawing half only.
 * An amount as a field shows it: whole where it is whole, one decimal where a
 *  fraction chip produced one. Rounding to an integer here is what would make
 *  ×½ then ×2 lose a gram. */
export function amountLabel(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : String(Math.round(amount * 10) / 10);
}

/** Build one review row from an estimate item or component. */
function toRow(
  db: Database,
  item: {
    name: string;
    amount: number | null;
    unit: AmountUnit;
    kcal: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
    confidence: EstimateConfidence;
    foodId: string | null;
    micros: string | null;
  },
  key: string
): ReviewRow {
  const food = item.foodId ? getFood(db, item.foodId) : undefined;
  // A grounded item's base is derived from the food so macros AND micros are
  // consistent — including when the user clears the amount field. An ungrounded
  // item keeps the model's numbers, including the sodium/caffeine it returns
  // (A8); those scale with an amount edit like every other figure on the row.
  // groundMealEstimate only sets foodId when the food's basis MATCHES the
  // item's unit, so re-pricing here can never cross the two.
  const grounded =
    food && item.amount != null && item.amount > 0
      ? itemForPortion(food, { amount: item.amount })
      : null;
  return {
    key,
    name: item.name,
    foodId: item.foodId,
    food,
    confidence: item.confidence,
    unit: item.unit,
    base: {
      // A non-positive amount from the model would violate meal_items
      // CHECK(amount > 0) and roll back the whole save; store it as "not
      // recorded" (null) instead.
      amount: item.amount != null && item.amount > 0 ? item.amount : null,
      kcal: grounded?.kcal ?? item.kcal,
      protein_g: grounded?.protein_g ?? item.protein_g,
      carbs_g: grounded?.carbs_g ?? item.carbs_g,
      fat_g: grounded?.fat_g ?? item.fat_g,
      fiber_g: grounded?.fiber_g ?? item.fiber_g,
      micros: grounded?.micros ?? item.micros,
    },
    amountText: item.amount != null && item.amount > 0 ? amountLabel(item.amount) : '',
  };
}

/** A grounded estimate as editable review rows — the tree included. */
export function rowsFromEstimate(db: Database, estimate: MealEstimate): ReviewItem[] {
  return estimate.items.map((item, i) => ({
    ...toRow(db, { ...item, micros: item.micros ?? null }, `${i}-${item.name}`),
    components: (item.components ?? []).map((part, j) =>
      toRow(db, { ...part, micros: part.micros ?? null }, `${i}-${j}-${part.name}`)
    ),
    expanded: false,
    scaleFrom: null,
  }));
}

/** The rows as `meal_items` input — a composite becomes a header with parts. */
export function rowsToMealItems(rows: ReviewItem[]): NewMealItem[] {
  const priced = (row: ReviewRow): NewMealItemComponent => {
    const p = currentPortion(row);
    return {
      food_id: row.foodId,
      name: row.name,
      amount: p.amount,
      unit: row.unit,
      serving_qty: null,
      kcal: p.kcal,
      protein_g: p.protein_g,
      carbs_g: p.carbs_g,
      fat_g: p.fat_g,
      fiber_g: p.fiber_g,
      confidence: row.confidence,
      micros: p.micros,
    };
  };
  return rows.map((row) =>
    isComposite(row)
      ? // The header's own numbers are never sent — the repository would drop
        // them anyway (invariant 2), and sending them would suggest they mean
        // something.
        { name: row.name, unit: row.unit, components: row.components.map(priced) }
      : priced(row)
  );
}

// --- Edits ------------------------------------------------------------------

/** Set one row's amount text. `key` may name a top-level row or a part. */
export function setRowAmount(rows: ReviewItem[], key: string, text: string): ReviewItem[] {
  return rows.map((row) => {
    if (row.key === key) return { ...row, amountText: text };
    if (!row.components.some((c) => c.key === key)) return row;
    return {
      ...row,
      components: row.components.map((c) => (c.key === key ? { ...c, amountText: text } : c)),
      // A hand-correction rebases what the chips will halve (owner decision):
      // the whole-dish snapshot is stale the moment a part moves.
      scaleFrom: null,
    };
  });
}

/**
 * Remove one row. **Removing the last part removes the composite** (invariant
 * 4): a header over nothing is a name with no numbers, which is
 * indistinguishable from an unpriced item.
 */
export function removeRow(rows: ReviewItem[], key: string): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const row of rows) {
    // A top-level row, or a whole composite with its parts.
    if (row.key === key) continue;
    if (!row.components.some((c) => c.key === key)) {
      out.push(row);
      continue;
    }
    const components = row.components.filter((c) => c.key !== key);
    // Invariant 4: the header goes with its last part.
    if (components.length === 0) continue;
    out.push({ ...row, components, scaleFrom: null });
  }
  return out;
}

export function toggleExpanded(rows: ReviewItem[], key: string): ReviewItem[] {
  return rows.map((row) => (row.key === key ? { ...row, expanded: !row.expanded } : row));
}

/** One part, scaled by `factor` from its CURRENT values. */
function scaleRow(row: ReviewRow, factor: number): ReviewRow {
  const cur = currentPortion(row);
  const mul = (v: number | null | undefined): number | null => (v == null ? null : v * factor);
  const amount = cur.amount == null ? null : cur.amount * factor;
  return {
    ...row,
    base: {
      amount,
      kcal: mul(cur.kcal),
      protein_g: mul(cur.protein_g),
      carbs_g: mul(cur.carbs_g),
      fat_g: mul(cur.fat_g),
      fiber_g: mul(cur.fiber_g),
      micros: serializeMicros(scaleMicros(parseMicros(cur.micros), factor)),
    },
    amountText: amount == null ? '' : amountLabel(amount),
  };
}

/** A fraction chip: every part of one composite, scaled proportionally from
 *  what it reads NOW. */
export function scaleComposite(rows: ReviewItem[], key: string, factor: number): ReviewItem[] {
  if (!(factor > 0)) return rows;
  return rows.map((row) =>
    row.key === key && isComposite(row)
      ? {
          ...row,
          components: row.components.map((c) => scaleRow(c, factor)),
          // The whole-dish field re-derives from the parts again, and the next
          // chip starts from what is now on screen.
          amountText: '',
          scaleFrom: null,
        }
      : row
  );
}

/** Focus of the whole-dish field: freeze the parts as the scaling baseline. */
export function beginCompositeScale(rows: ReviewItem[], key: string): ReviewItem[] {
  return rows.map((row) => (row.key === key ? { ...row, scaleFrom: row.components } : row));
}

/** Blur: drop the baseline, so the next edit takes a fresh one. */
export function endCompositeScale(rows: ReviewItem[], key: string): ReviewItem[] {
  return rows.map((row) => (row.key === key ? { ...row, scaleFrom: null } : row));
}

/**
 * The whole-dish field changed: scale the parts to that total, from the
 * snapshot taken on focus. Non-compounding, so typing `3` `6` `0` into a 720 g
 * pizza lands on ×0.5 rather than on ×0.5 three times.
 */
export function scaleCompositeTo(rows: ReviewItem[], key: string, text: string): ReviewItem[] {
  return rows.map((row) => {
    if (row.key !== key || !isComposite(row)) return row;
    const from = row.scaleFrom ?? row.components;
    const target = parseAmount(text);
    const total = from.reduce<number | null>((sum, c) => {
      const amount = currentPortion(c).amount;
      return sum == null || amount == null ? null : sum + amount;
    }, 0);
    if (target == null || total == null || total <= 0) {
      // Mid-typing ("3", "", "abc") the parts must not jump. The field holds
      // what was typed; the parts follow only once it is a number.
      return { ...row, scaleFrom: from, amountText: text };
    }
    const factor = target / total;
    return {
      ...row,
      scaleFrom: from,
      amountText: text,
      components: from.map((c) => scaleRow(c, factor)),
    };
  });
}

// --- Answering a clarifying question (backlog C5) ---------------------------

/** Case-insensitive name match — the model writes "Espresso", the row holds
 *  whatever it returned, and the two are the same item. */
function namedRow(rows: ReviewItem[], name: string): { top: ReviewItem; part?: ReviewRow } | null {
  const wanted = name.trim().toLowerCase();
  for (const row of rows) {
    if (row.name.toLowerCase() === wanted) return { top: row };
    const part = row.components.find((c) => c.name.toLowerCase() === wanted);
    if (part) return { top: row, part };
  }
  return null;
}

/**
 * Apply one button answer's effect to the review rows — **pure on-device
 * arithmetic**, no second model call (backlog C5).
 *
 * The caller applies it to the rows AS THEY STOOD BEFORE that question was
 * first answered, so changing an answer produces the same state as having
 * chosen the second option first. Nothing accumulates.
 *
 * An effect that names a row which is no longer there (the user removed it
 * first) is a no-op rather than an error: the record on screen is what gets
 * saved, and an answer cannot conjure back a row the user deleted.
 */
export function applyAnswer(rows: ReviewItem[], effect: QuestionEffect): ReviewItem[] {
  if (effect.kind === 'add_item') {
    // A stable key, so applying the same answer twice cannot produce two rows.
    const key = `answer-${effect.name.toLowerCase()}`;
    if (rows.some((row) => row.key === key)) return rows;
    return [
      ...rows,
      {
        key,
        name: effect.name,
        foodId: null,
        food: undefined,
        // An answered question is the USER asserting a fact, so the row it adds
        // is not a low-confidence guess — but it is still the model's numbers
        // for a thing the user only confirmed the presence of. 'medium' is the
        // honest middle, and the review row is editable either way.
        confidence: 'medium',
        unit: effect.unit,
        base: {
          amount: effect.amount,
          kcal: effect.kcal,
          protein_g: effect.protein_g,
          carbs_g: effect.carbs_g,
          fat_g: effect.fat_g,
          fiber_g: null,
          micros: null,
        },
        amountText: effect.amount == null ? '' : amountLabel(effect.amount),
        components: [],
        expanded: false,
        scaleFrom: null,
      },
    ];
  }

  const found = namedRow(rows, effect.name);
  if (!found) return rows;
  const targetKey = found.part ? found.part.key : found.top.key;

  if (effect.kind === 'remove_item') return removeRow(rows, targetKey);
  if (effect.kind === 'set_amount')
    return setRowAmount(rows, targetKey, amountLabel(effect.amount));

  // scale_item. Scaling a COMPOSITE header scales every part — the header has
  // no numbers of its own, so there is nothing else it could mean.
  if (!found.part && isComposite(found.top)) {
    return scaleComposite(rows, found.top.key, effect.factor);
  }
  return rows.map((row) => {
    if (row.key === targetKey)
      return {
        ...scaleRow(row, effect.factor),
        components: row.components,
        expanded: row.expanded,
        scaleFrom: null,
      };
    if (!row.components.some((c) => c.key === targetKey)) return row;
    return {
      ...row,
      components: row.components.map((c) => (c.key === targetKey ? scaleRow(c, effect.factor) : c)),
      amountText: '',
      scaleFrom: null,
    };
  });
}

/**
 * The review rows as the model's view of the meal — what the ONE second call
 * this feature allows is given (backlog C5, the "Other" path).
 *
 * Text only, and deliberately: `messages` carries no prompt-cache breakpoint,
 * so a resent photo is billed in full every time. The rows as they now stand
 * plus the typed sentence are enough for `reviseMeal`, which already exists and
 * already does exactly this job for the Adjust screen.
 */
export function rowsToRevisionSubject(name: string, rows: ReviewItem[]): MealRevisionSubject {
  const line = (row: ReviewRow): MealRevisionItem => {
    const p = currentPortion(row);
    return {
      name: row.name,
      amount: p.amount ?? null,
      unit: row.unit,
      kcal: p.kcal ?? null,
      protein_g: p.protein_g ?? null,
      carbs_g: p.carbs_g ?? null,
      fat_g: p.fat_g ?? null,
      micros: p.micros ?? null,
    };
  };
  return {
    name,
    items: rows.map((row) =>
      isComposite(row) ? { ...line(row), components: row.components.map(line) } : line(row)
    ),
  };
}
