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
 * with two copies of the same forty lines. Composite foods (0058) turn that
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
 *
 * ## "Three slices of the eight" (0059)
 *
 * A third handle on the same dish: a COUNT of pieces and the noun for one of
 * them. It is the grams field's sibling in every mechanical respect — same
 * focus snapshot, same non-compounding scale, same "the current state is the
 * record" — with one rule of its own, stated in full above
 * {@link setCompositeCount}: the FIRST count declares what the parts already
 * are and moves nothing; every later one scales them.
 *
 * **The invariant that keeps that honest:** `countFrom` is never consumed
 * against parts it did not describe. Every writer that drops `scaleFrom` drops
 * `countFrom` with it, and the two are always taken in the same breath.
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

/** How many pieces a composite is, and what one piece is called (0059). */
export type ReviewPieces = { name: string; count: number };

/** A top-level review row. `components` is empty for a plain item and holds the
 *  parts for a composite (0058); one level only. */
export type ReviewItem = ReviewRow & {
  components: ReviewRow[];
  expanded: boolean;
  /** The parts as they stood when a whole-dish field was focused — the
   *  baseline that keeps live scaling from compounding. Null when not editing. */
  scaleFrom: ReviewRow[] | null;
  /** The count of pieces this composite is, and the noun for one of them
   *  (0059). Null on a plain item and on an uncounted composite. */
  pieces: ReviewPieces | null;
  /** The count field's text, the sibling of {@link ReviewRow.amountText}. Empty
   *  means "show what {@link ReviewItem.pieces} says". */
  countText: string;
  /**
   * The count as it stood when {@link ReviewItem.scaleFrom} was taken — the
   * other half of the same snapshot, so neither live field can compound.
   *
   * An INNER null is the load-bearing case: the row had no count when the field
   * was focused, so whatever number arrives DECLARES one ("this dish is 8
   * pieces") and moves nothing. An outer null means no baseline has been taken;
   * the writers then read the count off the row as it stands.
   */
  countFrom: { count: number | null } | null;
};

export function isComposite(row: ReviewItem): boolean {
  return row.components.length > 0;
}

export function parseAmount(text: string): number | null {
  const n = Number(text.trim());
  return Number.isFinite(n) && n > 0 && n <= 5000 ? n : null;
}

/** A piece count: the amount ceiling's cousin, two orders smaller. Nothing a
 *  person eats is 101 slices, and a typo that says so should not scale a meal
 *  by a hundred. */
export function parseCount(text: string): number | null {
  const n = Number(text.trim());
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
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
    // The model's own count of what it priced (0059), read only on a composite:
    // a count of pieces is a fact about a dish with parts, and on a plain item
    // it would land in three places built for a catalog SERVING count.
    pieces: item.components && item.components.length > 0 ? (item.pieces ?? null) : null,
    countText: '',
    countFrom: null,
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
      // A part never carries the pair — a slice is not a fraction of the cheese
      // (0059). Stated rather than defaulted, so the rule is legible here.
      piece_name: null,
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
        // something. Its COUNT is not one of them (0059): a count is a fact
        // about the whole dish, and nothing sums it.
        {
          name: row.name,
          unit: row.unit,
          serving_qty: row.pieces?.count ?? null,
          piece_name: row.pieces?.name ?? null,
          components: row.components.map(priced),
        }
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
      // …and so is the count that snapshot was taken beside. The count itself
      // STAYS: you still ate three slices, they were lighter (0059).
      countFrom: null,
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
    // Invariant 4: the header goes with its last part — and its count with it.
    if (components.length === 0) continue;
    // The count survives a part being removed (a slice without its pepperoni is
    // still a slice); only the stale baseline goes.
    out.push({ ...row, components, scaleFrom: null, countFrom: null });
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

/** A count scaled with the parts it describes — the correspondence §4.1 of the
 *  spike states, kept by arithmetic rather than by maintenance. */
function scalePieces(pieces: ReviewPieces | null, from: number | null, factor: number) {
  if (!pieces || from == null) return pieces;
  return { ...pieces, count: from * factor };
}

/** A fraction chip: every part of one composite, scaled proportionally from
 *  what it reads NOW — and the count with them (0059). */
export function scaleComposite(rows: ReviewItem[], key: string, factor: number): ReviewItem[] {
  if (!(factor > 0)) return rows;
  return rows.map((row) =>
    row.key === key && isComposite(row)
      ? {
          ...row,
          components: row.components.map((c) => scaleRow(c, factor)),
          // A chip moves the WHOLE dish, so it moves the count: a third of
          // eight slices is the honest 2.7, never a rounded 3 the parts do not
          // add up to.
          pieces: scalePieces(row.pieces, row.pieces?.count ?? null, factor),
          // The whole-dish field and the count field re-derive from the parts
          // again, and the next edit starts from what is now on screen.
          amountText: '',
          countText: '',
          scaleFrom: null,
          countFrom: null,
        }
      : row
  );
}

/** Focus of the whole-dish field: freeze the parts AND the count as the
 *  scaling baseline — one snapshot, so neither can compound against the other. */
export function beginCompositeScale(rows: ReviewItem[], key: string): ReviewItem[] {
  return rows.map((row) =>
    row.key === key
      ? { ...row, scaleFrom: row.components, countFrom: { count: row.pieces?.count ?? null } }
      : row
  );
}

/** Blur: drop the baseline, so the next edit takes a fresh one. */
export function endCompositeScale(rows: ReviewItem[], key: string): ReviewItem[] {
  return rows.map((row) => (row.key === key ? { ...row, scaleFrom: null, countFrom: null } : row));
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
    // The count half of the same snapshot. Taken here when the focus handler
    // never ran (a headless caller, or react-native's own focus ordering), so
    // the count cannot compound either.
    const fromCount = row.countFrom ?? { count: row.pieces?.count ?? null };
    const target = parseAmount(text);
    const total = from.reduce<number | null>((sum, c) => {
      const amount = currentPortion(c).amount;
      return sum == null || amount == null ? null : sum + amount;
    }, 0);
    if (target == null || total == null || total <= 0) {
      // Mid-typing ("3", "", "abc") the parts must not jump. The field holds
      // what was typed; the parts follow only once it is a number.
      return { ...row, scaleFrom: from, countFrom: fromCount, amountText: text };
    }
    const factor = target / total;
    return {
      ...row,
      scaleFrom: from,
      countFrom: fromCount,
      amountText: text,
      components: from.map((c) => scaleRow(c, factor)),
      pieces: scalePieces(row.pieces, fromCount.count, factor),
    };
  });
}

// --- The count of pieces (0059) ---------------------------------------------
//
// THE PRINCIPLE, in one sentence: the unit says what the number is measured in;
// the count says how many of a named piece the parts, AS THEY STAND, add up to.
// The first count DECLARES that correspondence; every later change PRESERVES it
// by scaling the parts.
//
// That is why the empty field asks one question and its label says which. A
// composite's parts are the whole dish as it was priced, so a number typed onto
// an UNCOUNTED composite can only mean "what is priced here is N pieces" — take
// it as "I ate N" and a photographed whole pizza reads `3 × slice` over eight
// slices of macros, the headline disagreeing with the parts.

/** Focus of the count field: freeze the parts and the count together. An inner
 *  null count is what makes this focus a DECLARATION. */
export function beginCountEdit(rows: ReviewItem[], key: string): ReviewItem[] {
  return beginCompositeScale(rows, key);
}

/** Blur: drop both baselines, and let the field re-derive from the count it
 *  actually produced (so half-typed text never outlives the edit). */
export function endCountEdit(rows: ReviewItem[], key: string): ReviewItem[] {
  return rows.map((row) =>
    row.key === key ? { ...row, scaleFrom: null, countFrom: null, countText: '' } : row
  );
}

/**
 * The count field changed.
 *
 * - **Empty on a counted row CLEARS the count** — `pieces` null, parts
 *   untouched. That is the route back from a count the model got wrong: empty
 *   means "no count", so the next number declares afresh and moves nothing.
 * - **Not yet a number** ("abc", "") holds the text and moves nothing.
 * - **With no count at focus** the number DECLARES: the parts stand exactly as
 *   they are and are now said to be N pieces.
 * - **With one** the parts scale by `count / baseline` from the frozen
 *   snapshot, non-compounding exactly as {@link scaleCompositeTo} is.
 */
export function setCompositeCount(rows: ReviewItem[], key: string, text: string): ReviewItem[] {
  return rows.map((row) => {
    if (row.key !== key || !isComposite(row)) return row;
    if (text.trim() === '') {
      // Clearing is a declaration of ignorance, not of eating: nothing scales.
      return { ...row, countText: text, pieces: null, countFrom: { count: null } };
    }
    const from = row.countFrom ?? { count: row.pieces?.count ?? null };
    const count = parseCount(text);
    if (count == null) return { ...row, countText: text, countFrom: from };
    const noun = row.pieces?.name ?? 'piece';
    // Read out of the snapshot before the closure below, so the narrowing holds.
    const baseline = from.count;
    if (baseline == null || baseline <= 0) {
      // THE DECLARATION. Every part and the meal's energy come out
      // byte-identical; all that changes is what the dish is now said to be.
      return { ...row, countText: text, countFrom: from, pieces: { name: noun, count } };
    }
    const base = row.scaleFrom ?? row.components;
    return {
      ...row,
      countText: text,
      countFrom: from,
      scaleFrom: base,
      components: base.map((c) => scaleRow(c, count / baseline)),
      pieces: { name: noun, count },
    };
  });
}

/**
 * Rename the piece — `piece` → `slice`. Trimmed; an empty noun is refused
 * rather than stored, because a count with no name for what it counts does not
 * read as a count at all.
 *
 * A row with no count cannot be named: a noun with no count names nothing, and
 * that is the same pairing the repository writes.
 */
export function setPiecesName(rows: ReviewItem[], key: string, name: string): ReviewItem[] {
  const trimmed = name.trim();
  if (trimmed === '') return rows;
  return rows.map((row) =>
    row.key === key && row.pieces ? { ...row, pieces: { ...row.pieces, name: trimmed } } : row
  );
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
        // An answer adds a PLAIN item, and a plain item is never counted in
        // pieces (0059) — the count lives on a dish with parts.
        pieces: null,
        countText: '',
        countFrom: null,
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
  // no numbers of its own, so there is nothing else it could mean — and its
  // count with them, so a C5 answer of "3 of the 8" leaves `3 × slice` (0059).
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
        countFrom: null,
        // A plain row has no count of pieces; carried rather than re-derived so
        // this stays exhaustive over ReviewItem.
        pieces: row.pieces,
        countText: row.countText,
      };
    if (!row.components.some((c) => c.key === targetKey)) return row;
    return {
      ...row,
      components: row.components.map((c) => (c.key === targetKey ? scaleRow(c, effect.factor) : c)),
      amountText: '',
      scaleFrom: null,
      // A PART moved, so the baseline is stale — but the count is not: you still
      // ate three slices, they were lighter.
      countFrom: null,
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
      isComposite(row)
        ? // The count rides with the dish (0059): the model is shown `8 × slice,
          // 3 parts` and told to keep it unless the correction moves it.
          { ...line(row), pieces: row.pieces, components: row.components.map(line) }
        : line(row)
    ),
  };
}
