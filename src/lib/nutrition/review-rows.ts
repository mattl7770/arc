import type { Database } from '@/lib/db/database';
import { getFood } from '@/lib/db/repositories/foods';
import type {
  MealEstimate,
  MealRevisionItem,
  MealRevisionSubject,
  QuestionEffect,
} from './estimate';
import { mergeMicros, parseMicros, scaleMicros, serializeMicros } from './micros';
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
 * ## "Ate 3 of 8 slices" (0059, re-cut 2026-09-23)
 *
 * A third handle on the same dish: a COUNT of pieces and the noun for one of
 * them, drawn as one sentence with two numbers — `ATE [3] OF [8] SLICES`.
 *
 * - **OF** is how many pieces the dish AS PRICED is ({@link ReviewItem.wholeCount}).
 *   While all of it is eaten, typing it declares (or re-declares) and nothing
 *   scales; once part of it is eaten, the parts follow so the sentence stays
 *   true — `ate 3 of 8` retyped as `of 6` is every part × 8/6.
 * - **ATE** is how many of them were eaten ({@link ReviewPieces.count}, the
 *   number that is saved). Typing it scales every part by `ate / of`.
 *
 * It replaced a single field whose label switched from `THIS IS` (declare) to
 * `I ATE` (scale) and which moved up a row on its first keystroke — the owner
 * found it "funky" on the device, and the field that moved was the one being
 * typed into. Now each number has its own field, neither ever moves, and which
 * one you type into says which question you are answering. The spike's
 * principle is unchanged: the count says how many pieces the parts, AS THEY
 * STAND, add up to; the first count declares, every later one preserves.
 *
 * **A RECORD's count has no OF.** Rows built from a logged meal (the Adjust
 * screen) come with a count of what was EATEN and no whole — the whole was
 * history of the estimate the record never stored — so they read
 * `ATE [3] SLICES`, as the meal screen does ({@link rowsFromEstimate}'s
 * `countIsEaten`). Offering `of [3]` there would invite typing the pizza's
 * eight, which re-declares three logged slices as eight.
 *
 * Both fields are the grams field's siblings in every mechanical respect — same
 * focus snapshot, same non-compounding scale, same "the current state is the
 * record" — so the arithmetic lives in {@link setCompositeCount} and
 * {@link setCompositeWhole}.
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

/** How many pieces the parts, as they stand, add up to — the count that is
 *  SAVED as `serving_qty` — and what one piece is called (0059). */
export type ReviewPieces = { name: string; count: number };

/** The count state a count or whole-dish field was focused on — see
 *  {@link ReviewItem.countFrom}. */
export type ReviewCountFrom = { count: number | null; whole: number | null };

/** A top-level review row. `components` is empty for a plain item and holds the
 *  parts for a composite (0058); one level only. */
export type ReviewItem = ReviewRow & {
  components: ReviewRow[];
  expanded: boolean;
  /** The parts as they stood when a whole-dish field was focused — the
   *  baseline that keeps live scaling from compounding. Null when not editing. */
  scaleFrom: ReviewRow[] | null;
  /** How many pieces were EATEN — the count the parts, as they stand, add up
   *  to — and the noun for one of them (0059). The `ATE` number. Null on a
   *  plain item and on an uncounted composite. */
  pieces: ReviewPieces | null;
  /**
   * How many pieces the dish AS PRICED is — the `OF` number in `ate 3 of 8`
   * (2026-09-23). Never non-null without {@link ReviewItem.pieces}; equal to
   * its count until an `ATE` edit says less (or more) of the dish was eaten.
   *
   * **Null beside a count is a RECORD's count** — a count of what was eaten,
   * with no whole known (rows built from a logged meal: `countIsEaten`). Such a
   * row reads `ATE [3] SLICES`, with no OF to mistake for the pizza's size.
   *
   * **View state only, never saved.** It is the spike's rejected denominator:
   * once the parts are scaled to three slices, "8" is history of the estimate,
   * so it lives exactly as long as the review and `rowsToMealItems` drops it.
   */
  wholeCount: number | null;
  /** The ATE field's text while it is being typed into; null shows
   *  {@link ReviewItem.pieces}' count. Null rather than `''` as the sentinel, so
   *  a field emptied mid-edit shows empty instead of refilling under the thumb. */
  countText: string | null;
  /** The OF field's text while it is being typed into; null shows
   *  {@link ReviewItem.wholeCount}. */
  wholeText: string | null;
  /**
   * The count and the whole as they stood when {@link ReviewItem.scaleFrom} was
   * taken — the other half of the same snapshot, so no live field can compound.
   *
   * A null `whole` is the load-bearing case: the row had no count when the field
   * was focused, so the number typed into OF DECLARES one ("this dish is 8
   * pieces") and moves nothing. An outer null means no baseline has been taken;
   * the writers then read both off the row as it stands.
   */
  countFrom: ReviewCountFrom | null;
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
      // Key by key, as grounding merges them (`mergeMicros`): the food's
      // recorded keys, the item's own for the rest.
      micros: grounded
        ? serializeMicros(mergeMicros(parseMicros(grounded.micros), parseMicros(item.micros)))
        : item.micros,
    },
    amountText: item.amount != null && item.amount > 0 ? amountLabel(item.amount) : '',
  };
}

/**
 * A grounded estimate as editable review rows — the tree included.
 *
 * `countIsEaten` is for rows built from a LOGGED meal (app/meal-revise.tsx):
 * the model is handed the record's count — what was eaten — and told to keep
 * it, so what comes back is a count of the portion, not of a dish priced whole.
 * Those rows carry no whole (`wholeCount` null) and read `ATE [3] SLICES`.
 */
export function rowsFromEstimate(
  db: Database,
  estimate: MealEstimate,
  { countIsEaten = false }: { countIsEaten?: boolean } = {}
): ReviewItem[] {
  return estimate.items.map((item, i) => {
    // The model's own count of what it priced (0059), read only on a composite:
    // a count of pieces is a fact about a dish with parts, and on a plain item
    // it would land in three places built for a catalog SERVING count.
    const pieces = item.components && item.components.length > 0 ? (item.pieces ?? null) : null;
    return {
      ...toRow(db, { ...item, micros: item.micros ?? null }, `${i}-${item.name}`),
      components: (item.components ?? []).map((part, j) =>
        toRow(db, { ...part, micros: part.micros ?? null }, `${i}-${j}-${part.name}`)
      ),
      expanded: false,
      scaleFrom: null,
      pieces,
      // The count is of what was PRICED, so the dish as priced is that many
      // pieces and all of them are on the plate: `ate [8] of [8] slices`. A
      // record's count is of what was eaten, and has no whole to offer.
      wholeCount: countIsEaten ? null : (pieces?.count ?? null),
      countText: null,
      wholeText: null,
      countFrom: null,
    };
  });
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
  return rows.map((row) => {
    if (!isComposite(row)) return priced(row);
    // The header's own numbers are never sent — the repository would drop them
    // anyway (invariant 2), and sending them would suggest they mean something.
    // Its COUNT is not one of them (0059): a count is a fact about the whole
    // dish, and nothing sums it. The count saved is the one EATEN — what the
    // parts, as saved, add up to; the dish as priced (`wholeCount`, the "of 8")
    // is history of the estimate and is dropped.
    //
    // A count field emptied but not yet left — Save tapped with it still
    // focused, which the keyboard's "handled" taps allow — is resolved here
    // exactly as its blur would resolve it ({@link settleCount}).
    const settled = settleCount(row);
    return {
      name: row.name,
      unit: row.unit,
      serving_qty: settled.pieces?.count ?? null,
      piece_name: settled.pieces?.name ?? null,
      components: row.components.map(priced),
    };
  });
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

/** Open or close one composite. Closing it ENDS any count edit inside it
 *  ({@link settleCount}): the fields unmount with the disclosure, and a focused
 *  field that unmounts is not promised a blur — so the header would otherwise go
 *  on showing a count that an emptied field had already given up. */
export function toggleExpanded(rows: ReviewItem[], key: string): ReviewItem[] {
  return rows.map((row) =>
    row.key === key ? { ...(row.expanded ? settleCount(row) : row), expanded: !row.expanded } : row
  );
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
          // A chip moves the WHOLE dish, so it moves the count eaten: a third
          // of eight slices is the honest 2.7, never a rounded 3 the parts do
          // not add up to. The dish as priced (`wholeCount`) does not move — a
          // C5 answer of "three of the eight" reads `ate 3 of 8`.
          pieces: scalePieces(row.pieces, row.pieces?.count ?? null, factor),
          // The whole-dish field and the count fields re-derive from the parts
          // again, and the next edit starts from what is now on screen.
          amountText: '',
          countText: null,
          wholeText: null,
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
    row.key === key ? { ...row, scaleFrom: row.components, countFrom: countNow(row) } : row
  );
}

/** The count state as the row holds it now — what a snapshot freezes. A null
 *  whole beside a count is a record's count, and stays null. */
function countNow(row: ReviewItem): ReviewCountFrom {
  return { count: row.pieces?.count ?? null, whole: row.wholeCount };
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
    const fromCount = row.countFrom ?? countNow(row);
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

// --- The count of pieces (0059, re-cut 2026-09-23) --------------------------
//
// THE PRINCIPLE, in one sentence: the unit says what the number is measured in;
// the count says how many of a named piece the parts, AS THEY STAND, add up to.
// The first count DECLARES that correspondence; every later change PRESERVES it
// by scaling the parts.
//
// Two numbers say it now, each in its own field, so no field ever has to change
// what it means: OF says what the dish is, ATE how much of it was eaten. A
// composite's parts are the whole dish as it was priced, so until the dish has
// an OF a number can only mean "this dish is N pieces" — which is why the screen
// draws ATE only once there is an OF, and why this file will not let a number
// typed into ATE conjure one.
//
// ONE RULE FOR TEXT THAT IS NOT A COUNT, in either field (`""`, `0`, `101`,
// `1.2.`): the parts show exactly as they stood when the field was focused, and
// a count the dish already had returns to its value then. Only a valid number
// moves anything. That is what makes leaving a field EMPTY safe to act on at
// blur — it un-counts the dish as it stood, never at a scale that some number
// typed a moment earlier produced (a `1` on the way to `12` is × 8). The one
// exception is shape, not grams: a declaration still being typed keeps the
// counted shape its last number gave it, since a declaration never moved a gram.

/** Two counts that are the same count — `===` would let the float noise of a
 *  C5 multiplication decide whether an OF edit re-declares or re-scales. */
function sameCount(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
}

/**
 * The edit now open will UN-COUNT the dish when it ends: the field that says
 * what the dish IS was emptied. That is OF — or, on a record's count, which has
 * no OF (`wholeCount` null beside a count), ATE. Resolved on blur
 * ({@link endCountEdit}), on collapse ({@link toggleExpanded}) and at Save
 * ({@link rowsToMealItems}), and never on the keystroke, so backspacing an 8 to
 * type a 6 is one edit.
 */
function pendingUncount(row: ReviewItem): boolean {
  const emptied = (text: string | null) => text !== null && text.trim() === '';
  return (
    emptied(row.wholeText) ||
    (row.pieces !== null && row.wholeCount === null && emptied(row.countText))
  );
}

/** A count edit, ended: baselines dropped, both fields re-derived from what they
 *  produced, and the dish un-counted if {@link pendingUncount} says so — the
 *  parts left exactly where they stand ("forgetting how many pieces a dish was
 *  is not eating any of it"). */
function settleCount(row: ReviewItem): ReviewItem {
  return {
    ...row,
    scaleFrom: null,
    countFrom: null,
    countText: null,
    wholeText: null,
    ...(pendingUncount(row) ? { pieces: null, wholeCount: null } : {}),
  };
}

/** Focus of either count field: freeze the parts, the count and the whole
 *  together. A null count is what makes an OF focus a DECLARATION. */
export function beginCountEdit(rows: ReviewItem[], key: string): ReviewItem[] {
  return beginCompositeScale(rows, key);
}

/**
 * Blur of either count field — {@link settleCount}.
 *
 * **Emptied and left, the field that says what the dish is un-counts it**: OF,
 * or ATE on a record's count. The single field this replaced cleared the count
 * on the empty KEYSTROKE, so the 6 typed after backspacing an 8 re-declared over
 * parts already scaled — two gestures for "change 8 to 6" with opposite effects.
 * An ATE emptied beside an OF simply shows the count again: emptying what you
 * ate is not a statement about the dish.
 */
export function endCountEdit(rows: ReviewItem[], key: string): ReviewItem[] {
  return rows.map((row) => (row.key === key ? settleCount(row) : row));
}

/**
 * The ATE field changed — how many of the dish's pieces were eaten.
 *
 * - **No count at focus** holds, moving nothing: there is nothing to take a
 *   share of, and a number on an uncounted dish can only mean "this dish is N
 *   pieces", which is OF's question. The screen does not draw this field there.
 * - **Not a count** shows the dish as it stood at focus (the rule above).
 * - **Otherwise** every part scales by `count / baseline` from the frozen
 *   snapshot, non-compounding exactly as {@link scaleCompositeTo} is, and the
 *   count eaten becomes the number typed. The dish as priced does not move.
 */
export function setCompositeCount(rows: ReviewItem[], key: string, text: string): ReviewItem[] {
  return rows.map((row) => {
    if (row.key !== key || !isComposite(row)) return row;
    const from = row.countFrom ?? countNow(row);
    const base = row.scaleFrom ?? row.components;
    // Read out of the snapshot before the closure below, so the narrowing holds.
    const baseline = from.count;
    if (baseline == null || baseline <= 0) {
      return { ...row, countText: text, countFrom: from, scaleFrom: base };
    }
    const name = row.pieces?.name ?? 'piece';
    const count = parseCount(text);
    return {
      ...row,
      countText: text,
      countFrom: from,
      scaleFrom: base,
      components: count == null ? base : base.map((c) => scaleRow(c, count / baseline)),
      pieces: { name, count: count ?? baseline },
      // The whole-dish grams field re-derives from the parts it now reads.
      amountText: '',
    };
  });
}

/**
 * The OF field changed — how many pieces the dish AS PRICED is.
 *
 * - **Not a count** — EMPTY included — shows the dish as it stood at focus (the
 *   rule above, and its one exception); an empty OF then un-counts it on blur.
 * - **No count at focus → THE DECLARATION.** The parts stand exactly as they
 *   are and are now said to be N pieces, every one of them eaten:
 *   `ate [8] of [8]`. Every part and the meal's energy come out byte-identical.
 * - **All of it eaten at focus (ate = of) → a RE-DECLARATION.** The model said
 *   eight and the pizza was six: the count eaten follows the whole and nothing
 *   scales. No clearing first — the gesture the old single field needed, and the
 *   one the spike warned was a trap in the hand.
 * - **Part of it eaten (ate ≠ of) → what the sentence now says.** The count
 *   eaten stands and the parts become `ate / of` of the dish as priced: after
 *   `ate 3 of 8`, typing 6 reads `ate 3 of 6`, and every part scales by 8/6.
 *
 * So OF moves grams only in the last case — and, like any re-declaration, it
 * re-fixes what one piece weighs, which ATE never does.
 */
export function setCompositeWhole(rows: ReviewItem[], key: string, text: string): ReviewItem[] {
  return rows.map((row) => {
    if (row.key !== key || !isComposite(row)) return row;
    const from = row.countFrom ?? countNow(row);
    const base = row.scaleFrom ?? row.components;
    const name = row.pieces?.name ?? 'piece';
    const eaten = from.count;
    const was = from.whole;
    const whole = parseCount(text);
    if (whole == null) {
      // A DECLARATION in progress (no count at focus) keeps the shape its last
      // number gave it: its parts never moved, so there is nothing to restore,
      // and flipping back to uncounted on the empty keystroke would mount and
      // unmount ATE, the header's grams field and the chips around the field
      // being typed into — "8", backspace, "6" is one edit. Left empty, it
      // un-counts on blur like any other.
      if (eaten == null) {
        return { ...row, wholeText: text, countFrom: from, scaleFrom: base, components: base };
      }
      return {
        ...row,
        wholeText: text,
        countFrom: from,
        scaleFrom: base,
        components: base,
        pieces: { name, count: eaten },
        wholeCount: was,
        amountText: '',
      };
    }
    if (was == null || eaten == null || sameCount(eaten, was)) {
      // Declared or re-declared: the parts at focus are the whole dish, now
      // said to be `whole` pieces — all of them eaten. Nothing scales.
      return {
        ...row,
        wholeText: text,
        countFrom: from,
        scaleFrom: base,
        components: base,
        pieces: { name, count: whole },
        wholeCount: whole,
        amountText: '',
      };
    }
    return {
      ...row,
      wholeText: text,
      countFrom: from,
      scaleFrom: base,
      components: base.map((c) => scaleRow(c, was / whole)),
      pieces: { name, count: eaten },
      wholeCount: whole,
      amountText: '',
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

// --- A LOGGED composite's count (app/meal-detail.tsx) -----------------------
//
// The review sheet counts a dish AS PRICED, so it has two numbers — ate [3] of
// [8]. A logged record has one: the parts are what was eaten, and the "of 8"
// was history of the estimate that the record never stored (the spike's
// rejected denominator; no migration). So on the record:
//
// - a COUNTED composite reads `ate [3] slices` — the count is what you ate, and
//   typing a new one scales every part by new / current;
// - an UNCOUNTED one reads the review's own sentence — its parts, as logged, are
//   the whole dish, so OF declares what they are and ATE then takes a share.
//
// meal-detail stages a draft and writes on Save (its rule for anything already
// in the day's totals), so what Save will do is decided HERE, purely, and the
// sentence stated above the Save button reads the same plan it executes.

/** A count draft on a logged composite. A null text is an untouched field. */
export type LoggedCountDraft = {
  eatenText: string | null;
  wholeText: string | null;
  nounText: string;
};

/**
 * What Save does to a logged composite's count — through the repository's own
 * `setCompositeCount` / `clearCompositeCount`, nothing else.
 *
 * - `clear` — the count goes and the parts stand (a counted record's ATE saved
 *   EMPTY: forgetting how many pieces a dish was is not eating any of it).
 * - `set` — `declare` (uncounted only) says what the parts ARE and scales
 *   nothing; then `eaten`, when it differs, scales every part by
 *   eaten / (the count just declared, or the one the record holds).
 * - `none` — nothing typed that would change the record.
 * - `invalid` — a field holds text that is not a count.
 */
export type LoggedCountPlan =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'clear' }
  | { kind: 'set'; declare: number | null; eaten: number | null; noun: string | undefined };

export function planLoggedCount(
  draft: LoggedCountDraft,
  stored: { serving_qty: number | null; piece_name: string | null }
): LoggedCountPlan {
  const typedNoun = draft.nounText.trim();
  const noun = typedNoun === '' ? undefined : typedNoun;
  const renamed = noun !== undefined && noun !== stored.piece_name;
  const current = stored.serving_qty;

  if (current != null) {
    // COUNTED: one number, what was eaten.
    if (draft.eatenText === null) {
      // Untouched — a rename alone is a count of the same size, which scales by
      // exactly 1 and writes the new noun.
      return renamed ? { kind: 'set', declare: null, eaten: current, noun } : { kind: 'none' };
    }
    if (draft.eatenText.trim() === '') return { kind: 'clear' };
    const eaten = parseCount(draft.eatenText);
    if (eaten == null) return { kind: 'invalid' };
    return eaten === current && !renamed
      ? { kind: 'none' }
      : { kind: 'set', declare: null, eaten, noun };
  }

  // UNCOUNTED: OF declares; there is nothing to take a share of until it does.
  if (draft.wholeText === null || draft.wholeText.trim() === '') return { kind: 'none' };
  const whole = parseCount(draft.wholeText);
  if (whole == null) return { kind: 'invalid' };
  // An untouched or emptied ATE is all of it — the state every count starts in.
  if (draft.eatenText === null || draft.eatenText.trim() === '') {
    return { kind: 'set', declare: whole, eaten: null, noun };
  }
  const eaten = parseCount(draft.eatenText);
  if (eaten == null) return { kind: 'invalid' };
  return { kind: 'set', declare: whole, eaten: eaten === whole ? null : eaten, noun };
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
        wholeCount: null,
        countText: null,
        wholeText: null,
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
  // count with them, so a C5 answer of "3 of the 8" reads `ate 3 of 8` (0059).
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
        wholeCount: row.wholeCount,
        countText: row.countText,
        wholeText: row.wholeText,
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

// --- Answering SEVERAL questions (2026-09-23) --------------------------------
//
// The defect this replaces: the screen froze a base PER QUESTION, the first
// time each was answered, and re-applied a changed answer to that base alone.
// Answer the milk, then the shots, then change the milk, and the change was
// applied to rows from before the shots — the espresso went back to two shots
// while its "3" chip stayed lit. A lit chip whose effect is not on the rows is
// a claim the screen cannot back.
//
// So the answers are a TRAIL, in the order each question was first answered,
// and every entry keeps the rows as they stood just before it. Changing one
// answer rebuilds from that entry's base and re-applies every later answer on
// top. The invariant, pinned by db/nutrition-v2.test.mjs §57: **every answered
// question's effect is on the rows, and no other answer's is.**

/** What the screen shows for a question answered by TYPING — no chip is lit,
 *  but the tally counts it and Undo restores the rows before it. */
export const ANSWERED_BY_TYPING = -1;

/** One answer: a chip (its index, and the effect it carries), or the rows a
 *  typed answer's text-only model call came back as. */
export type GivenAnswer =
  { kind: 'option'; index: number; effect: QuestionEffect } | { kind: 'typed'; rows: ReviewItem[] };

/** One answered question, and the rows as they stood just before its answer. */
export type AnsweredQuestion = { id: string; base: ReviewItem[]; answer: GivenAnswer };

function applyGiven(rows: ReviewItem[], answer: GivenAnswer): ReviewItem[] {
  return answer.kind === 'option' ? applyAnswer(rows, answer.effect) : answer.rows;
}

/**
 * Answer (or re-answer, or — with `null` — un-answer) one question, and replay
 * every answer given after it. Pure; the hook holds the trail and the screen's
 * rows and does nothing else.
 *
 * - **A question not yet answered** is appended: its base is the rows as they
 *   stand now, hand edits included.
 * - **A question already answered** rebuilds from its own base, so changing an
 *   answer never compounds on the old one ("3" then "1" is one shot, never
 *   3 × ½), and every LATER chip answer is re-applied on top — by name, as it
 *   was the first time — with its base re-taken as it goes.
 * - **A later TYPED answer is withdrawn**, and the tally shows it: it was a
 *   model reply over rows that no longer stand, and replaying it would restore
 *   the old answer it was computed against. Asking the model again is the
 *   user's call, one tap away.
 *
 * The cost, stated because it is real: a hand edit made AFTER a question was
 * first answered is lost when that question's answer changes — it is not in
 * any base. The same trade C5 made for one question, now true for several:
 * a silently doubled portion is a wrong record, a re-typed figure is an
 * annoyance. A hand edit made BEFORE the question was first answered is in its
 * base and survives.
 */
export function answerQuestion(
  trail: AnsweredQuestion[],
  current: ReviewItem[],
  id: string,
  answer: GivenAnswer | null
): { trail: AnsweredQuestion[]; rows: ReviewItem[] } {
  const at = trail.findIndex((entry) => entry.id === id);
  const answered = trail[at];
  if (answered === undefined) {
    if (answer === null) return { trail, rows: current };
    return {
      trail: [...trail, { id, base: current, answer }],
      rows: applyGiven(current, answer),
    };
  }
  let rows = answered.base;
  const next = trail.slice(0, at);
  if (answer !== null) {
    next.push({ id, base: rows, answer });
    rows = applyGiven(rows, answer);
  }
  for (const later of trail.slice(at + 1)) {
    if (later.answer.kind === 'typed') continue;
    next.push({ id: later.id, base: rows, answer: later.answer });
    rows = applyGiven(rows, later.answer);
  }
  return { trail: next, rows };
}

/** The chips a trail lights: question id → the option index, or
 *  {@link ANSWERED_BY_TYPING}. An unanswered question is absent. */
export function answersOf(trail: AnsweredQuestion[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of trail) {
    out[entry.id] = entry.answer.kind === 'option' ? entry.answer.index : ANSWERED_BY_TYPING;
  }
  return out;
}

/** The rows a typed answer to `id` is asked over: before that question's own
 *  answer if it has one (so the reply replaces it rather than stacking on it),
 *  else as they stand. */
export function rowsBeforeAnswer(
  trail: AnsweredQuestion[],
  current: ReviewItem[],
  id: string
): ReviewItem[] {
  return trail.find((entry) => entry.id === id)?.base ?? current;
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
      // Shown so it rides back unchanged on a row the typed answer is not
      // about (2026-09-23) — see MealRevisionItem.fiber_g.
      fiber_g: p.fiber_g ?? null,
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

/**
 * The rows a typed answer came back as, given back the dish counts they were
 * sent without.
 *
 * The typed-answer call sends each dish's count EATEN (`pieces`) and tells the
 * model to keep it; what returns is rebuilt by {@link rowsFromEstimate}, which
 * reads any count as the dish priced whole. Before a dish is eaten from those
 * are the same number; after `ate 3 of 8` they are not, and the rebuilt row
 * would read `ate [3] of [3]` — the 8 gone, and an OF inviting the pizza's
 * eight over three slices of parts. So, matching by name:
 *
 * - the count came back **unchanged** → the dish's own whole comes back with it
 *   (`ate 3 of 8` stays `ate 3 of 8`; a record's count stays wholeless);
 * - it came back **changed** → it is still a count of what was eaten, and
 *   nothing says what the dish was: no whole, `ate [n] slices`;
 * - the dish was **not counted** before → the model counted what it priced,
 *   which is the whole, as on a fresh estimate.
 */
export function carryWholes(sent: ReviewItem[], back: ReviewItem[]): ReviewItem[] {
  return back.map((row) => {
    if (!row.pieces) return row;
    const name = row.name.trim().toLowerCase();
    const before = sent.find((s) => isComposite(s) && s.name.trim().toLowerCase() === name);
    if (!before?.pieces) return row;
    return {
      ...row,
      wholeCount: sameCount(row.pieces.count, before.pieces.count) ? before.wholeCount : null,
    };
  });
}
