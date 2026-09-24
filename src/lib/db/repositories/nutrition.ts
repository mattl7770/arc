/**
 * The Nutrition sub-app's data layer: meals in, the day's intake out.
 *
 * Meals live in their own `meals` table (0002_nutrition.sql) — a record of what
 * was actually eaten — not in `log_entries` (whose type='meal' rows are
 * *planned* mission items on Home). Manual entry writes here today; the
 * photo / natural-language path (Phase 3, Coach) and meal templates will write
 * the same rows with their own `source`, so nothing here is manual-entry-shaped.
 *
 * Like every repository, this depends only on the {@link Database} interface —
 * never op-sqlite — so the same code runs on device and against node:sqlite in
 * db/nutrition.test.mjs.
 */
import type { Database, Scalar } from '../database';
import { localDaysList, todayISODate } from '../date';
import { newId } from '../id';
import type { DateString, TimeString } from '../types';
import { CombineRefused, combinedName, planCombine } from '@/lib/nutrition/combine';
import { assembleMealItems } from '@/lib/nutrition/composite';
import { isValidClock } from '@/lib/nutrition/meal-time';
import {
  type Micros,
  parseMicros,
  scaleMicros,
  serializeMicros,
  sumMicros,
} from '@/lib/nutrition/micros';
import type {
  DayTotals,
  MealItemRow,
  MealItemWithServing,
  MealPhotoRow,
  MealRow,
  NewMeal,
  NewMealItem,
  NewMealItemComponent,
  NewMealPhoto,
  NewMealWithItems,
  NewNutritionTargets,
  NutritionHistoryDay,
  NutritionTargetsRow,
} from '@/lib/nutrition/types';

/** Persist one eaten meal; returns its id. Absent macros store as NULL. */
export function logMeal(db: Database, meal: NewMeal): string {
  const id = newId(db);
  db.run(
    `INSERT INTO meals (id, date, time, name, kcal, protein_g, carbs_g, fat_g, source, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
    [
      id,
      meal.date,
      meal.time,
      meal.name,
      meal.kcal ?? null,
      meal.protein_g ?? null,
      meal.carbs_g ?? null,
      meal.fat_g ?? null,
      meal.notes ?? null,
    ]
  );
  return id;
}

/**
 * The day's meals in eating order — by wall-clock time, untimed meals last,
 * ties by insertion. `date` is the local calendar day (todayISODate), passed in
 * so the headless tests are deterministic.
 */
export function listTodayMeals(db: Database, date: string): MealRow[] {
  return db.all<MealRow>(
    `SELECT * FROM meals WHERE date = ? ORDER BY (time IS NULL), time, created_at, id`,
    [date]
  );
}

/**
 * Summed intake for the day's "Today" card. sum() skips NULL macros (a meal
 * with no recorded protein doesn't zero the day) and the coalesce makes an
 * empty day read as zeros rather than NULLs.
 */
export function todayTotals(db: Database, date: string): DayTotals {
  const row = db.get<DayTotals>(
    `SELECT
       coalesce(sum(kcal), 0)      AS kcal,
       coalesce(sum(protein_g), 0) AS protein_g,
       coalesce(sum(carbs_g), 0)   AS carbs_g,
       coalesce(sum(fat_g), 0)     AS fat_g,
       count(*)                    AS mealCount
     FROM meals WHERE date = ?`,
    [date]
  );
  return row ?? { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, mealCount: 0 };
}

/**
 * The first day a meal was ever logged, or null on a database that holds none —
 * the back bound of the history screen's day picker (C1).
 *
 * The picker needs a floor for the same reason app/water.tsx clips its by-day
 * list to `waterRecordStart`: without one the back arrow steps for ever through
 * days that never existed, and "Nothing logged on Tuesday" stops being a fact
 * about the record and becomes a fact about the calendar. `date` sorts
 * chronologically as text, which is the whole reason the schema stores it that
 * way, so this is `min()` and an index hit rather than a scan through rows.
 */
export function firstMealDate(db: Database): string | null {
  const row = db.get<{ date: string | null }>(`SELECT min(date) AS date FROM meals`);
  return row?.date ?? null;
}

export interface DayIntakePoint {
  date: string;
  kcal: number;
  protein_g: number;
  /**
   * How many meals were logged that day — the "has data" signal. Kept separate
   * from `kcal` because a meal can be saved with only a name (kcal NULL, summing
   * to 0), so a zero kcal total does NOT mean the day is empty.
   */
  mealCount: number;
}

/**
 * Daily kcal + protein + meal count for the last `days` calendar days, oldest ->
 * `today` inclusive, zero-filled for days with no meals — the Nutrition trend
 * chart's data source. `today` is injectable so the headless tests are
 * deterministic.
 */
export function dailyIntakeSeries(
  db: Database,
  days: number = 7,
  today: string = todayISODate()
): DayIntakePoint[] {
  const dates = localDaysList(today, days);
  const rows = db.all<{ date: string; kcal: number; protein_g: number; mealCount: number }>(
    `SELECT date,
            coalesce(sum(kcal), 0)      AS kcal,
            coalesce(sum(protein_g), 0) AS protein_g,
            count(*)                    AS mealCount
     FROM meals
     WHERE date >= ? AND date <= ?
     GROUP BY date`,
    [dates[0] ?? today, today]
  );
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return dates.map((date) => {
    const row = byDate.get(date);
    return {
      date,
      kcal: row?.kcal ?? 0,
      protein_g: row?.protein_g ?? 0,
      mealCount: row?.mealCount ?? 0,
    };
  });
}

// === Itemized meals (0008: foods + meal_items) ===============================
//
// A meal MAY be itemized: child meal_items rows, each a food+portion snapshot.
// When a meal has items, its own kcal/macro columns are maintained as the item
// sums — recomputed inside the same transaction as every item change — which
// is exactly what keeps todayTotals / dailyIntakeSeries (above) and the
// Data-tab trend correct without touching them. These functions are the only
// writers of an itemized meal's totals; the manual-entry path (logMeal) never
// creates items, so the two kinds coexist. See docs/nutrition-subapp.md §3.

/** JS-side NULL-skipping sum: absent everywhere → NULL, else sum of knowns. */
function sumOrNull(values: (number | null | undefined)[]): number | null {
  let sum: number | null = null;
  for (const v of values) {
    if (v != null) sum = (sum ?? 0) + v;
  }
  return sum;
}

/** A composite header (0058) — an item supplied with parts beneath it. */
function isCompositeInput(item: NewMealItem): boolean {
  return Array.isArray(item.components) && item.components.length > 0;
}

/**
 * The rows that carry NUMBERS, flattened out of a supplied tree (0058).
 *
 * A composite HEADER contributes nothing — its macros are NULL by invariant 2
 * — so every place that sums a supplied list sums this instead. One helper, so
 * the two places that pre-compute a meal's totals cannot disagree with the
 * `is_composite = 0` filter the recompute uses.
 */
function leafItems(items: NewMealItem[]): NewMealItemComponent[] {
  return items.flatMap((item) => (isCompositeInput(item) ? (item.components ?? []) : [item]));
}

function insertMealItem(
  db: Database,
  mealId: string,
  item: NewMealItem,
  /** The composite this row is a part of, or null for a top-level row. */
  parentItemId: string | null = null
): string {
  const id = newId(db);
  // A HEADER carries no numbers of its own (0058, invariant 2). Not "we ignore
  // them at read time" — they are never written, so a query that forgets the
  // is_composite filter under-counts by zero instead of doubling the pizza.
  const header = parentItemId === null && isCompositeInput(item);
  // A header MAY carry a COUNT of what it is (0059): `serving_qty` and the noun
  // it counts. That is a fact about the whole dish, not a number that sums, so
  // invariant 2 does not reach it — no sum anywhere reads `serving_qty`, and the
  // only two non-display readers inner-join on `food_id`, which a header lacks.
  //
  // The pair is written only WHOLE. A noun with no count names nothing, so
  // `piece_name` rides on a non-null `serving_qty`; on a part or a plain item it
  // is always NULL, whose count names the catalog food's serving through the
  // live join instead. The two vocabularies never share a column.
  const count = item.serving_qty ?? null;
  const pieceName = header && count != null ? (item.piece_name ?? null) : null;
  db.run(
    `INSERT INTO meal_items (id, meal_id, food_id, name, amount, unit, serving_qty,
       kcal, protein_g, carbs_g, fat_g, fiber_g, confidence, micros,
       parent_item_id, is_composite, piece_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      mealId,
      // A header is a dish, not a catalog food: grounding never prices one
      // (groundMealEstimate skips an item that has components), so it carries
      // no food_id to mislead a later re-price.
      header ? null : (item.food_id ?? null),
      item.name,
      // Invariant 5: the amount IS summable, so a header keeps its own null and
      // the reader derives the total from the parts.
      header ? null : (item.amount ?? null),
      // Absent unit is grams (0047) — every item logged before that column
      // existed was grams, and so is every caller that never states one.
      item.unit ?? 'g',
      count,
      header ? null : (item.kcal ?? null),
      header ? null : (item.protein_g ?? null),
      header ? null : (item.carbs_g ?? null),
      header ? null : (item.fat_g ?? null),
      header ? null : (item.fiber_g ?? null),
      header ? null : (item.confidence ?? null),
      header ? null : (item.micros ?? null),
      parentItemId,
      header ? 1 : 0,
      pieceName,
    ]
  );
  if (header) {
    for (const component of item.components ?? []) {
      insertMealItem(db, mealId, component, id);
    }
  }
  return id;
}

/**
 * Re-derive a meal's macro columns from its items. SQLite's sum() already
 * NULL-skips (and yields NULL over zero rows), so a meal emptied of items
 * returns to free-form NULLs — "not recorded", never a fake 0. Callers wrap
 * this in the same transaction as the item change.
 */
function recomputeMealTotals(db: Database, mealId: string): void {
  // `AND is_composite = 0` — CHILDREN ONLY (0058). A composite header's macros
  // are already NULL, so this filter is the second belt rather than the first;
  // it is here so the intent is legible at the call site and so the query stays
  // right if a header ever acquires a number.
  db.run(
    `UPDATE meals SET
       kcal      = (SELECT sum(kcal)      FROM meal_items WHERE meal_id = ? AND is_composite = 0),
       protein_g = (SELECT sum(protein_g) FROM meal_items WHERE meal_id = ? AND is_composite = 0),
       carbs_g   = (SELECT sum(carbs_g)   FROM meal_items WHERE meal_id = ? AND is_composite = 0),
       fat_g     = (SELECT sum(fat_g)     FROM meal_items WHERE meal_id = ? AND is_composite = 0)
     WHERE id = ?`,
    [mealId, mealId, mealId, mealId, mealId]
  );
}

/**
 * Persist a meal and its items in one transaction — a CHECK violation on any
 * item rolls the whole meal back (the workout+sets pattern). The meal's macro
 * columns are written as the item sums up front, so a reader that lands
 * between commits still never sees a half-summed meal.
 */
export function logMealWithItems(
  db: Database,
  meal: NewMealWithItems
): { mealId: string; itemIds: string[] } {
  const mealId = newId(db);
  const itemIds: string[] = [];
  db.transaction(() => {
    db.run(
      `INSERT INTO meals (id, date, time, name, kcal, protein_g, carbs_g, fat_g, source, notes, recipe_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mealId,
        meal.date,
        meal.time,
        meal.name,
        // Leaves only — a composite header contributes nothing (0058).
        sumOrNull(leafItems(meal.items).map((i) => i.kcal)),
        sumOrNull(leafItems(meal.items).map((i) => i.protein_g)),
        sumOrNull(leafItems(meal.items).map((i) => i.carbs_g)),
        sumOrNull(leafItems(meal.items).map((i) => i.fat_g)),
        meal.source ?? 'manual',
        meal.notes ?? null,
        meal.recipe_id ?? null,
      ]
    );
    for (const item of meal.items) itemIds.push(insertMealItem(db, mealId, item));
  });
  return { mealId, itemIds };
}

/**
 * Append one item to a meal and fold it into the meal's totals.
 *
 * If the meal was FREE-FORM with typed totals (manual entry), the first added
 * item would otherwise hand ownership of the totals to the items and silently
 * destroy what the user typed — so those totals are first preserved as their
 * own "(as logged)" item. The egg you forgot adds to the 800-kcal dinner; it
 * doesn't replace it.
 */
export function addMealItem(db: Database, mealId: string, item: NewMealItem): string {
  let id = '';
  db.transaction(() => {
    const existing = db.get<{ n: number }>(
      'SELECT count(*) AS n FROM meal_items WHERE meal_id = ?',
      [mealId]
    );
    if ((existing?.n ?? 0) === 0) {
      const meal = getMeal(db, mealId);
      if (
        meal &&
        (meal.kcal !== null ||
          meal.protein_g !== null ||
          meal.carbs_g !== null ||
          meal.fat_g !== null)
      ) {
        insertMealItem(db, mealId, {
          name: `${meal.name} (as logged)`,
          kcal: meal.kcal,
          protein_g: meal.protein_g,
          carbs_g: meal.carbs_g,
          fat_g: meal.fat_g,
        });
      }
    }
    id = insertMealItem(db, mealId, item);
    recomputeMealTotals(db, mealId);
  });
  return id;
}

/** Rewrite an item's portion + macro snapshot (the caller re-scales via
 * src/lib/nutrition/servings.ts) and re-derive the meal's totals. */
export function updateMealItemPortion(
  db: Database,
  itemId: string,
  portion: Pick<
    NewMealItem,
    'amount' | 'serving_qty' | 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g' | 'fiber_g' | 'micros'
  >
): void {
  const row = db.get<{ meal_id: string }>('SELECT meal_id FROM meal_items WHERE id = ?', [itemId]);
  if (!row) return;
  db.transaction(() => {
    // `unit` is deliberately absent: re-portioning answers "how much", and a
    // portion does not change what it is measured in (see rescaleLoggedItem).
    db.run(
      `UPDATE meal_items SET amount = ?, serving_qty = ?, kcal = ?, protein_g = ?,
         carbs_g = ?, fat_g = ?, fiber_g = ?, micros = ?
       WHERE id = ?`,
      [
        portion.amount ?? null,
        portion.serving_qty ?? null,
        portion.kcal ?? null,
        portion.protein_g ?? null,
        portion.carbs_g ?? null,
        portion.fat_g ?? null,
        portion.fiber_g ?? null,
        portion.micros ?? null,
        itemId,
      ]
    );
    recomputeMealTotals(db, row.meal_id);
  });
}

/**
 * Replace a meal's ENTIRE item list in one transaction, then re-derive its
 * totals. Returns the new item ids.
 *
 * Written for the plain-text AI revision (`app/meal-revise.tsx`, owner request
 * 2026-08-12: *"Actually, that was cooked in olive oil not butter"*), where the
 * model returns the whole corrected list rather than a patch. Wholesale
 * replacement is the honest shape for that: an instruction like "that was olive
 * oil, not butter" can remove one item, add another and re-price a third, and a
 * diff applied item-by-item would have to guess which of those it was doing.
 *
 * **Nothing outside `meal_items` moves.** The meal's identity, date, time,
 * name, notes, `source` and `recipe_id` are the user's, and a revision to what
 * was in the bowl is not permission to restamp any of them. The totals follow
 * because they are DERIVED from the items — `recomputeMealTotals` in the same
 * transaction, so no reader can land on a half-summed meal.
 *
 * **An empty list is refused, not honoured.** Deleting every item silently
 * returns the meal to free-form NULL totals, which looks identical to a meal
 * nobody priced — so a revision that resolves to nothing throws and the caller
 * keeps what it had. Emptying a meal is what `removeMealItem` and Delete are
 * for, and both are deliberate acts on this screen.
 */
export function replaceMealItems(db: Database, mealId: string, items: NewMealItem[]): string[] {
  if (items.length === 0) {
    throw new Error('a revision must leave at least one item — delete the meal instead');
  }
  const itemIds: string[] = [];
  db.transaction(() => {
    db.run('DELETE FROM meal_items WHERE meal_id = ?', [mealId]);
    for (const item of items) itemIds.push(insertMealItem(db, mealId, item));
    recomputeMealTotals(db, mealId);
  });
  return itemIds;
}

/**
 * Remove one item; the meal's totals follow (all-NULL once emptied).
 *
 * Removing a composite HEADER takes its parts with it, by the 0058 FK cascade
 * (`PRAGMA foreign_keys = ON`, CLAUDE.md §9). Removing the LAST part of a
 * composite removes the composite too — invariant 4: a header over nothing is a
 * row named "Pepperoni pizza" with no numbers, which is indistinguishable from
 * an unpriced item and would silently drop the meal out of countdown mode.
 */
export function removeMealItem(db: Database, itemId: string): void {
  const row = db.get<{ meal_id: string; parent_item_id: string | null }>(
    'SELECT meal_id, parent_item_id FROM meal_items WHERE id = ?',
    [itemId]
  );
  if (!row) return;
  db.transaction(() => {
    db.run('DELETE FROM meal_items WHERE id = ?', [itemId]);
    if (row.parent_item_id !== null) {
      const left = db.get<{ n: number }>(
        'SELECT count(*) AS n FROM meal_items WHERE parent_item_id = ?',
        [row.parent_item_id]
      );
      if ((left?.n ?? 0) === 0) db.run('DELETE FROM meal_items WHERE id = ?', [row.parent_item_id]);
    }
    recomputeMealTotals(db, row.meal_id);
  });
}

/**
 * "I ate half the pizza": multiply every component of one composite by
 * `factor` — amount, macros and micros — in one transaction (0058).
 *
 * **Proportional is the only honest reading.** Halving the crust and not the
 * cheese would be a claim about *which* half, which nothing knows.
 *
 * **Nothing is rounded on write.** The macro columns are `real` and rendering
 * rounds, so ×0.5 then ×2 returns exactly where it started. Round here and the
 * pizza loses a gram every time the owner changes his mind.
 *
 * **It scales the components' CURRENT values, not a hidden original.** There is
 * no base column and there should not be one: the current state is the only
 * state the record has, and a hidden original would make the visible numbers
 * stop being the record. So a part corrected by hand first (the pepperoni taken
 * off half) is halved from the corrected number, which is the owner's own
 * answer to this question.
 *
 * **The COUNT moves with the parts (0059).** A count is a fact about the whole
 * dish, so whatever scales the whole scales it: half of six slices is three, and
 * a third of eight is the honest 2.7. The correspondence the count declares —
 * "the parts, as they stand, are N pieces" — is preserved by scaling both, which
 * is exactly what keeps `kcal ÷ serving_qty` constant across any run of chips.
 */
export function scaleCompositeItem(db: Database, parentItemId: string, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`scaleCompositeItem: ${factor} is not a portion of anything.`);
  }
  const parent = db.get<{ meal_id: string; is_composite: number }>(
    'SELECT meal_id, is_composite FROM meal_items WHERE id = ?',
    [parentItemId]
  );
  if (!parent || parent.is_composite !== 1) return;
  const components = db.all<MealItemRow>(
    'SELECT * FROM meal_items WHERE parent_item_id = ? ORDER BY created_at, rowid',
    [parentItemId]
  );
  db.transaction(() => {
    for (const c of components) {
      const s = (v: number | null): number | null => (v == null ? null : v * factor);
      db.run(
        // `piece_name = NULL` beside `serving_qty = NULL`: a part never carries
        // the pair — a slice is not a fraction of the cheese (0059).
        `UPDATE meal_items SET amount = ?, serving_qty = NULL, piece_name = NULL, kcal = ?,
           protein_g = ?, carbs_g = ?, fat_g = ?, fiber_g = ?, micros = ?
         WHERE id = ?`,
        [
          // A component with no amount still scales its macros — an "≈300 kcal"
          // part has no portion to move, but it is still half as much food.
          s(c.amount),
          s(c.kcal),
          s(c.protein_g),
          s(c.carbs_g),
          s(c.fat_g),
          s(c.fiber_g),
          serializeMicros(scaleMicros(parseMicros(c.micros), factor)),
          c.id,
        ]
      );
    }
    // The header's count, where it has one. Nothing is rounded here either, for
    // the same reason: ×0.5 then ×2 must return to exactly 8.
    db.run(
      'UPDATE meal_items SET serving_qty = serving_qty * ? WHERE id = ? AND serving_qty IS NOT NULL',
      [factor, parentItemId]
    );
    recomputeMealTotals(db, parent.meal_id);
  });
}

/**
 * The count on a composite header — "this pizza is 8 slices", then "I ate 3"
 * (0059, backlog "Slices as a food unit").
 *
 * **The first count DECLARES; every later one PRESERVES.** A composite's parts
 * are the whole dish as the model priced it, so a count typed onto an UNCOUNTED
 * composite can only mean *"what is priced here is N pieces"* — never *"I ate
 * N"*. Taking it the second way on a photographed whole pizza would write
 * `3 × slice` over eight slices of macros and count the whole pizza into the
 * day: the headline disagreeing with the parts, which 0058 built two belts to
 * make impossible. So:
 *
 * - **no count yet** → write the pair, scale NOTHING. Every part and the meal's
 *   own kcal come out byte-identical.
 * - **already counted** → scale every part by `count / current` and then write
 *   the count outright, so 3 → 4 → 3 lands on exactly 3 rather than on a product
 *   of two floats.
 *
 * The grams-per-piece is never stored — it is `amount ÷ serving_qty`, derived
 * every render. A stored copy would disagree with the first the moment a part
 * was hand-edited, which is the one edit allowed to move it (a part correction
 * never moves its siblings and never pushes back onto the parent: you still ate
 * three slices, they were lighter).
 */
export function setCompositeCount(
  db: Database,
  parentItemId: string,
  count: number,
  pieceName?: string
): void {
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(`setCompositeCount: ${count} is not a count of anything.`);
  }
  const parent = db.get<{
    serving_qty: number | null;
    piece_name: string | null;
    is_composite: number;
  }>('SELECT serving_qty, piece_name, is_composite FROM meal_items WHERE id = ?', [parentItemId]);
  if (!parent || parent.is_composite !== 1) return;
  // A count needs a noun to read as a count at all, so a declaration that names
  // none gets the neutral `piece` and the noun control renames it. A re-count
  // that names none keeps the noun the dish already has.
  const given = pieceName?.trim();
  const noun = given !== undefined && given !== '' ? given : (parent.piece_name ?? 'piece');
  const current = parent.serving_qty;
  if (current != null && current > 0) {
    // Counted already: the parts follow the count, so the two keep describing
    // the same food. `scaleCompositeItem` moves the count too, which is why the
    // explicit write below is what settles the final value.
    scaleCompositeItem(db, parentItemId, count / current);
  }
  db.run('UPDATE meal_items SET serving_qty = ?, piece_name = ? WHERE id = ?', [
    count,
    noun,
    parentItemId,
  ]);
}

/**
 * Clear a composite's count, scaling nothing (0059).
 *
 * The route back from a count that was wrong — the model said 8, the pizza was
 * 6. Empty means "no count", so the NEXT number declares afresh and moves
 * nothing; re-declaring by typing over the 8 would scale the parts by 6/8 on a
 * dish that was never eight slices. The parts are untouched here because
 * forgetting how many pieces a dish was is not eating any of it.
 */
export function clearCompositeCount(db: Database, parentItemId: string): void {
  db.run(
    'UPDATE meal_items SET serving_qty = NULL, piece_name = NULL WHERE id = ? AND is_composite = 1',
    [parentItemId]
  );
}

/** A meal's items in logged order, each joined with its catalog food's
 * serving name (NULL for free-form items or a since-deleted food). */
export function listMealItems(db: Database, mealId: string): MealItemWithServing[] {
  return db.all<MealItemWithServing>(
    `SELECT mi.*, f.serving_name AS food_serving_name
     FROM meal_items mi
     LEFT JOIN foods f ON f.id = mi.food_id
     WHERE mi.meal_id = ?
     ORDER BY mi.created_at, mi.rowid`,
    [mealId]
  );
}

/**
 * meal_id → item count for one day — the "Eaten today" list's "· N items".
 *
 * `AND mi.parent_item_id IS NULL` — **a different filter from the sums, for a
 * different question** (0058). The sums want LEAVES, because leaves carry the
 * numbers; this tally wants what the collapsed ledger DRAWS, which is one row
 * per pizza. A meal holding one three-part composite reads "1 item", not "4",
 * because four is not a number anything on that screen shows. Both filters
 * carry this note, because they will otherwise be "corrected" to match.
 */
export function mealItemCounts(db: Database, date: string): Record<string, number> {
  const rows = db.all<{ meal_id: string; n: number }>(
    `SELECT mi.meal_id, count(*) AS n
     FROM meal_items mi
     JOIN meals m ON m.id = mi.meal_id
     WHERE m.date = ? AND mi.parent_item_id IS NULL
     GROUP BY mi.meal_id`,
    [date]
  );
  return Object.fromEntries(rows.map((r) => [r.meal_id, r.n]));
}

/**
 * meal_id → the metrics whose total is **knowingly short**, for one day.
 *
 * An itemized meal's macro columns are sums over its items, and those sums SKIP
 * NULL. So a meal can carry a perfectly non-null kcal that is short by every
 * ingredient nobody priced — which is exactly what `logRecipe` writes when a
 * recipe is partially resolved: the counted lines land with snapshots, the rest
 * land as name-only items with NULL macros, and the meal's own kcal is the sum
 * of the counted half.
 *
 * That is honest as a LEDGER (the row shows what is known, and the recipe screen
 * discloses the undercount), but it is not honest as a MINUEND: subtracting it
 * from a target over-states what is left, silently, on the days the user did the
 * most work. `src/lib/nutrition/remaining.ts` takes this map so the countdown
 * can refuse those meals the same way it refuses a meal with no numbers at all.
 *
 * A meal with no items at all (the manual-entry path) simply does not appear —
 * its columns are what the user typed, and NULL there is already handled.
 *
 * **`AND mi.is_composite = 0` (0058).** A composite HEADER's macros are NULL by
 * design — it is a name over its parts, not a row of numbers — so without this
 * filter every meal holding a pizza would be marked knowingly short on every
 * metric, and the Eat tab's hero would quietly stop counting down for a meal
 * that is fully priced. Same filter as `recomputeMealTotals`, same reason, and
 * deliberately NOT the same filter as `mealItemCounts` (see its note).
 */
export function partialMealMetrics(
  db: Database,
  date: string
): Record<string, Partial<Record<'kcal' | 'protein_g' | 'carbs_g' | 'fat_g', boolean>>> {
  const rows = db.all<{
    meal_id: string;
    kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
  }>(
    `SELECT mi.meal_id                            AS meal_id,
            max(mi.kcal IS NULL)                  AS kcal,
            max(mi.protein_g IS NULL)             AS protein_g,
            max(mi.carbs_g IS NULL)               AS carbs_g,
            max(mi.fat_g IS NULL)                 AS fat_g
     FROM meal_items mi
     JOIN meals m ON m.id = mi.meal_id
     WHERE m.date = ? AND mi.is_composite = 0
     GROUP BY mi.meal_id`,
    [date]
  );
  const out: Record<
    string,
    Partial<Record<'kcal' | 'protein_g' | 'carbs_g' | 'fat_g', boolean>>
  > = {};
  for (const row of rows) {
    const partial: Partial<Record<'kcal' | 'protein_g' | 'carbs_g' | 'fat_g', boolean>> = {};
    if (row.kcal) partial.kcal = true;
    if (row.protein_g) partial.protein_g = true;
    if (row.carbs_g) partial.carbs_g = true;
    if (row.fat_g) partial.fat_g = true;
    if (Object.keys(partial).length > 0) out[row.meal_id] = partial;
  }
  return out;
}

export function getMeal(db: Database, id: string): MealRow | undefined {
  return db.get<MealRow>('SELECT * FROM meals WHERE id = ?', [id]);
}

/**
 * Move a logged meal to a different day and/or wall-clock time — the owner's
 * "change the time of a meal" (2026-08-12).
 *
 * **Why the date moves with the time.** The case that motivated it is a meal
 * eaten at 00:40 that belongs to the evening before, and re-timing it to 23:40
 * without also moving the day writes a *worse* lie than the one being fixed. So
 * this takes both, and the day boundary is a supported crossing.
 *
 * **Why one UPDATE is the whole implementation, and how that was established.**
 * Nothing in this schema denormalises a day's nutrition: `todayTotals`,
 * `dailyIntakeSeries` and `nutritionHistory` all group `meals` by the `date`
 * column at read time, `meal_items` carry no date of their own (they hang off
 * the meal), and a meal touches neither `daily_logs` nor `log_entries` — which
 * db/nutrition.test.mjs §8 asserts directly. So re-dating a meal moves its
 * energy off one day's totals and onto another's by construction, on both days
 * at once, with nothing to recompute. That is verified rather than assumed:
 * db/nutrition.test.mjs walks the totals of both days across a move.
 *
 * **Separate from {@link updateMealMeta}** rather than folded into it: that one
 * rewrites name and notes too, so a time editor calling it would have to
 * re-send the name it never asked about — the exact shape that turns a typo fix
 * into silent destruction elsewhere in this codebase (see the note in
 * repositories/recipes.ts).
 *
 * Throws on an impossible clock. The schema's GLOB CHECK only tests the SHAPE
 * `[0-9][0-9]:[0-9][0-9]`, which `99:99` passes, so this is the layer where
 * hours are hours. The editor gates its Save on the same predicate; this is the
 * backstop that makes the guarantee true for every future caller.
 */
export function updateMealTime(
  db: Database,
  id: string,
  when: { date: DateString; time: TimeString | null }
): void {
  if (!isValidClock(when.time)) {
    throw new Error(`updateMealTime: "${when.time}" is not a valid HH:MM clock time.`);
  }
  db.run('UPDATE meals SET date = ?, time = ? WHERE id = ?', [when.date, when.time, id]);
}

/**
 * Rename a logged meal — the owner's *"add functionality to be able to change
 * the name of a meal"* (2026-08-15).
 *
 * **What a meal's name already was, before this existed.** `meals.name` is free
 * text and `NOT NULL` (0002_nutrition.sql) — a real column, not a slot enum and
 * not a title derived from the items. It is written once, by whichever path
 * created the row: the manual form's `Meal` field, the template's name, the
 * recipe's title through `logRecipe`, the name the estimator's model gave the
 * plate, or the source meal's name through `relogMeal`. So a rename is one
 * UPDATE of one column and needed **no migration**.
 *
 * **There is no derived title to fall back to, so an empty name is REFUSED
 * rather than cleared.** Nothing in this schema can reconstruct a name: an
 * itemized meal could be described by its items, but inventing "Chicken + rice"
 * on the user's behalf is a fabricated record, and a free-form meal has nothing
 * at all to derive from. The column is `NOT NULL` precisely because a nameless
 * meal is not a state this app has — it is the row's identity in the
 * Eaten-today list, in this screen's header, in VoiceOver and in the default
 * name offered when the meal is saved as a template or a recipe. So a blank
 * name writes nothing and the meal keeps the name it has. The editor gates its
 * Save on the same predicate; this is the backstop that makes the guarantee
 * true for every future caller (the shape {@link updateMealTime} uses for an
 * impossible clock).
 *
 * **Nothing else moves.** One column in one statement: the date, time, notes,
 * `source`, `recipe_id`, totals, items and photos are all untouched by
 * construction, and db/nutrition.test.mjs §13 walks each of them across a
 * rename. **Separate from {@link updateMealMeta}** for the reason
 * {@link updateMealTime} is separate from it — that one rewrites the time and
 * notes as well, so a rename calling it would have to re-send a clock it never
 * asked about, which is how a typo fix becomes silent destruction elsewhere.
 */
export function updateMealName(db: Database, id: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new Error('updateMealName: a meal keeps its name — "" is not one.');
  }
  db.run('UPDATE meals SET name = ? WHERE id = ?', [trimmed, id]);
}

/** Edit a meal's descriptive fields; totals belong to items/logMeal, not here. */
export function updateMealMeta(
  db: Database,
  id: string,
  meta: { name: string; time: string | null; notes?: string | null }
): void {
  db.run('UPDATE meals SET name = ?, time = ?, notes = ? WHERE id = ?', [
    meta.name,
    meta.time,
    meta.notes ?? null,
    id,
  ]);
}

/** Delete a meal; its items follow via ON DELETE CASCADE. */
export function deleteMeal(db: Database, id: string): void {
  db.run('DELETE FROM meals WHERE id = ?', [id]);
}

/**
 * "Log again": duplicate a past meal (items and all) onto `date` at `time` —
 * the copy-from-yesterday loop. Snapshots are copied, not re-priced: you get
 * the meal as it was logged — including AI provenance, so a duplicated
 * estimate still reads as an estimate ('ai_suggested' survives; every other
 * source becomes 'manual', because re-logging a synced/imported meal by hand
 * IS a manual act). Returns the new meal id, or null if the source is gone.
 */
export function relogMeal(
  db: Database,
  mealId: string,
  date: string,
  time: string | null
): string | null {
  const meal = getMeal(db, mealId);
  if (!meal) return null;
  const source = meal.source === 'ai_suggested' ? 'ai_suggested' : 'manual';
  const items = db.all<MealItemWithServing>(
    // Insertion order — a whole batch shares one millisecond created_at, and a
    // UUID tie-break would scramble it (rowid is monotonic per insert).
    'SELECT * FROM meal_items WHERE meal_id = ? ORDER BY created_at, rowid',
    [mealId]
  );
  if (items.length === 0) {
    // Direct insert rather than logMeal, which stamps source='manual'.
    const id = newId(db);
    db.run(
      `INSERT INTO meals (id, date, time, name, kcal, protein_g, carbs_g, fat_g, source, notes, recipe_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        date,
        time,
        meal.name,
        meal.kcal,
        meal.protein_g,
        meal.carbs_g,
        meal.fat_g,
        source,
        meal.notes,
        meal.recipe_id,
      ]
    );
    return id;
  }
  // "Log again" of a cooked recipe is cooking it again — provenance carries.
  // The TREE carries too (0058): re-logging a pizza re-logs a pizza, not four
  // loose rows. `assembleMealItems` is the single reader that knows the shape.
  const copy = (i: MealItemWithServing) => ({
    food_id: i.food_id,
    name: i.name,
    amount: i.amount,
    unit: i.unit,
    serving_qty: i.serving_qty,
    kcal: i.kcal,
    protein_g: i.protein_g,
    carbs_g: i.carbs_g,
    fat_g: i.fat_g,
    fiber_g: i.fiber_g,
    confidence: i.confidence,
    micros: i.micros,
    // A re-logged pizza is a counted pizza (0059). The noun rides with the count
    // it names; on a part or a plain item both are already what they were.
    piece_name: i.piece_name,
  });
  return logMealWithItems(db, {
    date,
    time,
    name: meal.name,
    notes: meal.notes,
    source,
    recipe_id: meal.recipe_id,
    items: assembleMealItems(items).map((node) =>
      node.kind === 'composite'
        ? { ...copy(node.item), components: node.components.map(copy) }
        : copy(node.item)
    ),
  }).mealId;
}

// === Taking back, putting back, combining (owner, device, 2026-09-23) ========
//
// *"undo for removing a food"* and *"some way to easily combine multiple food
// logs that are the same meal"*. docs/nutrition-subapp.md §14 is the account.
//
// **An Undo puts back the ROWS, not a copy of them.** Re-logging what was
// removed through `insertMealItem` would mint new ids, new `created_at` stamps
// and a new place in the meal — a different record that happens to carry the
// same numbers. So a removal first reads every row it is about to delete,
// every column of it plus its `rowid`, and the Undo re-inserts those rows
// verbatim: the same ids, the same snapshot figures (macros, micros, amount,
// unit, count, piece name), the same `created_at`, and — where the `rowid` is
// still free — the same `rowid`, which is the tie-break every item read orders
// by (`ORDER BY created_at, rowid`: a batch logged in one millisecond is put
// back in its own order, not at the end of it).
//
// **The removal itself is the screen's own function.** `takeMealItem` reads,
// then calls `removeMealItem`; `takeMeal` reads, then calls `deleteMeal`. So the
// write is the one the meal screen always made and the Coach's registry still
// makes (docs/coach-domains.md, the parity rule) — the reading beforehand is
// the only thing added.

/** A row exactly as it stood: every column, and its `rowid`. */
export type TakenRow = { __rowid: number } & Record<string, Scalar>;

/** The four tables a meal's record spans (0002, 0014, 0033, 0057). */
type MealTable = 'meals' | 'meal_items' | 'meal_photos' | 'pending_estimates';

function takeRows(db: Database, table: MealTable, where: string, params: Scalar[]): TakenRow[] {
  return db.all<TakenRow>(
    `SELECT rowid AS __rowid, * FROM ${table} WHERE ${where} ORDER BY rowid`,
    params
  );
}

/**
 * {@link takeRows} over a table a database may predate — `meal_photos` (0033)
 * and `pending_estimates` (0057). The same tolerance `deleteMealWithPhotos`
 * always had: the meal must still go, and parts it cannot have are none.
 */
function takeRowsIfPresent(
  db: Database,
  table: 'meal_photos' | 'pending_estimates',
  where: string,
  params: Scalar[]
): TakenRow[] {
  try {
    return takeRows(db, table, where, params);
  } catch {
    return [];
  }
}

/**
 * Re-insert one taken row verbatim — every column it had, and its `rowid` when
 * nothing has taken it since (a row inserted during the window may have: SQLite
 * without AUTOINCREMENT hands out max(rowid)+1). Without the `rowid` the row
 * still lands with its own `created_at`, which is the primary order key.
 *
 * Column names come from the row the database itself returned, never from
 * input, and are quoted.
 */
function putRow(db: Database, table: MealTable, row: TakenRow): void {
  const { __rowid, ...columns } = row;
  const names = Object.keys(columns);
  const values: Scalar[] = names.map((name) => columns[name] ?? null);
  const free =
    db.get<{ one: number }>(`SELECT 1 AS one FROM ${table} WHERE rowid = ?`, [__rowid]) ===
    undefined;
  const list = names.map((name) => `"${name.replace(/"/g, '""')}"`);
  const all = free ? ['rowid', ...list] : list;
  const params = free ? [__rowid, ...values] : values;
  db.run(
    `INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`,
    params
  );
}

/**
 * A reference the `ON DELETE SET NULL` rule would have cleared had the row been
 * there when its target went — a recipe (`meals.recipe_id`, 0031) or a catalog
 * food (`meal_items.food_id`, 0014) deleted while the Undo was open. Putting the
 * row back with the reference cleared is exactly the state it would be in had
 * it never been removed; putting it back with the reference would fail the FK.
 */
function clearedIfGone(
  db: Database,
  row: TakenRow,
  column: 'recipe_id' | 'food_id',
  table: 'recipes' | 'foods'
): TakenRow {
  const id = row[column];
  if (id == null) return row;
  const there = db.get<{ one: number }>(`SELECT 1 AS one FROM ${table} WHERE id = ?`, [id]);
  return there ? row : { ...row, [column]: null };
}

/** Headers and plain items before parts: a part's parent must exist first. */
function parentsFirst(rows: TakenRow[]): TakenRow[] {
  return [
    ...rows.filter((row) => row.parent_item_id == null),
    ...rows.filter((row) => row.parent_item_id != null),
  ];
}

function marks(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

/**
 * Whether two readings of the same rows say the same thing: every column but
 * `updated_at`, and the `rowid`, row by row in `rowid` order. It is how an Undo
 * knows the record is still the one it was offered against. The write stamp is
 * left out because it is not the record — a no-op UPDATE moves it and changes
 * nothing anyone logged.
 */
function sameRecord(a: readonly TakenRow[], b: readonly TakenRow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, index) => {
    const other = b[index]!;
    const keys = new Set([...Object.keys(row), ...Object.keys(other)]);
    keys.delete('updated_at');
    for (const key of keys) {
      if ((row[key] ?? null) !== (other[key] ?? null)) return false;
    }
    return true;
  });
}

/** Every item a meal holds, every column, as {@link sameRecord} compares them. */
function itemRecord(db: Database, mealId: string): TakenRow[] {
  return takeRows(db, 'meal_items', 'meal_id = ?', [mealId]);
}

/**
 * Items read earlier, as they should read NOW if nothing touched them: a
 * catalog food deleted in between was cleared by `ON DELETE SET NULL`, which
 * is the database keeping its own rule, not anyone changing the meal.
 */
function itemsAsExpected(db: Database, rows: readonly TakenRow[]): TakenRow[] {
  return rows.map((row) => clearedIfGone(db, row, 'food_id', 'foods'));
}

/** What one item's removal took — everything {@link removeMealItem} deleted. */
export type TakenMealItems = {
  mealId: string;
  /** The item the user removed, as the Undo row names it. */
  name: string;
  /** Its energy over the rows that carry numbers; null when none was priced. */
  kcal: number | null;
  rows: TakenRow[];
  /** The items the removal LEFT, every column — the meal the Undo expects to
   *  find. Anything else there refuses it (see {@link restoreMealItems}). */
  left: TakenRow[];
  /** The meal's four totals before the removal, and after it. */
  totalsBefore: MealTotals;
  totalsAfter: MealTotals;
};

type MealTotals = Pick<MealRow, 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g'>;

function mealTotals(db: Database, mealId: string): MealTotals | undefined {
  return db.get<MealTotals>('SELECT kcal, protein_g, carbs_g, fat_g FROM meals WHERE id = ?', [
    mealId,
  ]);
}

const sameTotals = (a: MealTotals | undefined, b: MealTotals): boolean =>
  a !== undefined &&
  a.kcal === b.kcal &&
  a.protein_g === b.protein_g &&
  a.carbs_g === b.carbs_g &&
  a.fat_g === b.fat_g;

/**
 * Remove one item the way the meal screen always has — {@link removeMealItem},
 * so a header takes its parts and a last part takes its header — having first
 * read every row that call is about to delete. Returns what {@link
 * restoreMealItems} needs to put them back, or null when there was no such item.
 */
export function takeMealItem(db: Database, itemId: string): TakenMealItems | null {
  const item = db.get<{ meal_id: string; parent_item_id: string | null; name: string }>(
    'SELECT meal_id, parent_item_id, name FROM meal_items WHERE id = ?',
    [itemId]
  );
  if (!item) return null;
  const ids = [itemId];
  if (item.parent_item_id !== null) {
    const left = db.get<{ n: number }>(
      'SELECT count(*) AS n FROM meal_items WHERE parent_item_id = ?',
      [item.parent_item_id]
    );
    // Invariant 4: the last part takes its header with it, so the header is
    // part of what was taken.
    if ((left?.n ?? 0) <= 1) ids.push(item.parent_item_id);
  }
  const rows = takeRows(
    db,
    'meal_items',
    `id IN (${marks(ids)}) OR parent_item_id IN (${marks(ids)})`,
    [...ids, ...ids]
  );
  const totalsBefore = mealTotals(db, item.meal_id)!;
  removeMealItem(db, itemId);
  return {
    mealId: item.meal_id,
    name: item.name,
    kcal: sumOrNull(
      rows.filter((row) => row.is_composite === 0).map((row) => row.kcal as number | null)
    ),
    rows,
    left: itemRecord(db, item.meal_id),
    totalsBefore,
    totalsAfter: mealTotals(db, item.meal_id)!,
  };
}

/**
 * Put back what {@link takeMealItem} took.
 *
 * **Refuses, writing nothing, unless the meal is exactly as the removal left
 * it** — the same items, every column (bar the write stamp) the same. The meal
 * screen closes the Undo on its own next write, but not every write is the
 * screen's: a queued revision drained on return to the foreground runs
 * `replaceMealItems` under a screen that is still showing the offer. Putting a
 * row back beside what replaced it would build a meal nobody logged and count
 * the removed item twice; putting a part back under a header that was replaced
 * would fail its foreign key. So it throws, as {@link uncombineMeals} does, and
 * the Undo row says it could not.
 *
 * **The totals go back to the exact figures they had.** Re-deriving them
 * instead would be right in arithmetic and wrong in the last bit: a meal
 * written by `logMealWithItems` carries totals summed in JS, while
 * `recomputeMealTotals` sums in SQLite, and the two can differ by one ulp — a
 * "189.4" that is not the 189.4 it was. Only when the totals themselves were
 * written since (the items being unchanged) are they re-derived from the items.
 */
export function restoreMealItems(db: Database, taken: TakenMealItems): void {
  if (!getMeal(db, taken.mealId)) {
    throw new Error('restoreMealItems: the meal these belonged to is gone.');
  }
  if (!sameRecord(itemRecord(db, taken.mealId), itemsAsExpected(db, taken.left))) {
    throw new Error('restoreMealItems: the meal has changed since, so it stays as it is.');
  }
  db.transaction(() => {
    const untouched = sameTotals(mealTotals(db, taken.mealId), taken.totalsAfter);
    for (const row of parentsFirst(taken.rows)) {
      putRow(db, 'meal_items', clearedIfGone(db, row, 'food_id', 'foods'));
    }
    if (untouched) {
      const t = taken.totalsBefore;
      db.run('UPDATE meals SET kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ?', [
        t.kcal,
        t.protein_g,
        t.carbs_g,
        t.fat_g,
        taken.mealId,
      ]);
    } else {
      recomputeMealTotals(db, taken.mealId);
    }
  });
}

/** What a whole meal's removal took: the meal and every part of it. */
export type TakenMeal = {
  meal: TakenRow;
  items: TakenRow[];
  photos: TakenRow[];
  /** A queued estimate (0057) — at most one, by its UNIQUE meal_id. */
  pending: TakenRow[];
};

/**
 * Delete a meal the way the meal screen always has — {@link deleteMeal}, whose
 * CASCADE takes its items, its photo rows and a queued estimate — having first
 * read every one of those rows. The FILES are not touched here: the database
 * layer knows no directory, and a file removed now is the one thing an Undo
 * could not bring back (src/lib/media/meal-photo-store.ts holds them).
 */
export function takeMeal(db: Database, mealId: string): TakenMeal | null {
  const meal = takeRows(db, 'meals', 'id = ?', [mealId])[0];
  if (!meal) return null;
  const taken: TakenMeal = {
    meal,
    items: takeRows(db, 'meal_items', 'meal_id = ?', [mealId]),
    photos: takeRowsIfPresent(db, 'meal_photos', 'meal_id = ?', [mealId]),
    pending: takeRowsIfPresent(db, 'pending_estimates', 'meal_id = ?', [mealId]),
  };
  deleteMeal(db, mealId);
  return taken;
}

/** The photo files a taken meal's rows named — what its removal will clear. */
export function takenPhotoFileNames(taken: TakenMeal): string[] {
  return taken.photos.map((row) => String(row.file_name));
}

/** The queued photo a taken meal's estimate named, if it had one. */
export function takenPendingFileNames(taken: TakenMeal): string[] {
  return taken.pending
    .map((row) => row.file_name)
    .filter((name): name is string => typeof name === 'string');
}

/**
 * Put back what {@link takeMeal} took, in one transaction: the meal row with
 * its own totals (verbatim — a free-form meal's typed numbers have no items to
 * re-derive them from), then its items parents-first, its photo rows and its
 * queued estimate. The day's totals are sums over `meals` rows, so they return
 * to exactly the figure they had.
 */
export function restoreMeal(db: Database, taken: TakenMeal): void {
  db.transaction(() => {
    putRow(db, 'meals', clearedIfGone(db, taken.meal, 'recipe_id', 'recipes'));
    for (const row of parentsFirst(taken.items)) {
      putRow(db, 'meal_items', clearedIfGone(db, row, 'food_id', 'foods'));
    }
    for (const row of taken.photos) putRow(db, 'meal_photos', row);
    for (const row of taken.pending) putRow(db, 'pending_estimates', row);
  });
}

/** What {@link combineMeals} did, held so {@link uncombineMeals} can undo it. */
export type CombinedMeals = {
  /** The meal that survived — the earliest (src/lib/nutrition/combine.ts). */
  keptId: string;
  /** Its row as it stood before, restored verbatim by the Undo. */
  kept: TakenRow;
  /** The items it held before — they stay with it when the combine is undone. */
  keptItemIds: string[];
  absorbed: { meal: TakenRow; itemIds: string[]; photoIds: string[] }[];
  /** The "(as logged)" items written for free-form meals — deleted by the Undo. */
  standInIds: string[];
  /** The combined meal as the combine LEFT it — its row and every item, every
   *  column. The Undo runs only while the meal still reads exactly this. */
  result: { meal: TakenRow; items: TakenRow[] };
  /** The name the result took. */
  name: string;
  count: number;
};

/**
 * Several of one day's meals become one — owner, device, 2026-09-23: *"some way
 * to easily combine multiple food logs that are the same meal"*. ONE
 * transaction; the plan is `planCombine`'s, the same one the Eat tab drew its
 * sentence from.
 *
 * **What survives.** The earliest meal's ROW: its id, date and time. The name
 * is `options.name` when one was typed, else that meal's own. Notes are kept,
 * every one, in list order. `source` is `'ai_suggested'` when any of them was —
 * a meal holding an estimate reads as one, as `relogMeal` keeps it. The one
 * `recipe_id` (the plan refuses two different ones) is kept.
 *
 * **What moves.** Every `meal_items` row — headers and parts together, so a
 * composite stays in one meal (0058 invariant 3) — and every `meal_photos` row,
 * by `UPDATE … SET meal_id`: the same ids, the same `rowid`s, the same
 * `created_at`, so the combined meal lists its items in the order they were
 * logged and a photo's retention clock (its own `created_at`, 0033) does not
 * move. Then the absorbed rows are deleted, holding nothing.
 *
 * **What a free-form meal becomes.** A meal with no items keeps its typed totals
 * on its own row, which `recomputeMealTotals` does not read — so each becomes
 * one item, `<name> (as logged)`, carrying those totals: `addMealItem`'s rule
 * for the same problem. A meal whose totals were never recorded still becomes
 * that item, name only, because what was eaten is a record even unpriced; the
 * day's countdown already refused that meal, and refuses the item the same way
 * (`partialMealMetrics`).
 *
 * **What else pointed at the absorbed meals** — checked against every foreign
 * key (docs/nutrition-subapp.md §14): items and photos move; a queued estimate
 * is refused by the plan before anything is written; templates, recipes and
 * reports copy numbers and hold no meal id; the Coach's conversation keeps the
 * ids it was handed as history (`ai_messages` is append-only), and a later read
 * by an absorbed id says the meal is gone.
 *
 * Throws {@link CombineRefused}, writing nothing, when the plan refuses or a
 * meal is no longer there; its message is the sentence the Eat tab shows.
 */
export function combineMeals(
  db: Database,
  mealIds: readonly string[],
  options: { name?: string | null } = {}
): CombinedMeals {
  const found = [...new Set(mealIds)].map((id) => getMeal(db, id));
  if (found.some((meal) => meal === undefined)) {
    throw new CombineRefused('One of those meals is no longer logged, so nothing was combined.');
  }
  const meals = found as MealRow[];
  const plan = planCombine(meals, pendingAmong(db, meals));
  if (plan.kind === 'too-few') throw new CombineRefused('It takes two meals to combine.');
  if (plan.kind === 'refused') throw new CombineRefused(plan.reason);

  const { keep, absorb } = plan;
  const all = [keep, ...absorb];
  const name = combinedName(options.name ?? null, keep);
  const itemIdsOf = (mealId: string): string[] =>
    db
      .all<{ id: string }>('SELECT id FROM meal_items WHERE meal_id = ? ORDER BY rowid', [mealId])
      .map((row) => row.id);
  const photoIdsOf = (mealId: string): string[] =>
    takeRowsIfPresent(db, 'meal_photos', 'meal_id = ?', [mealId]).map((row) => String(row.id));

  const kept = takeRows(db, 'meals', 'id = ?', [keep.id])[0]!;
  const keptItemIds = itemIdsOf(keep.id);
  const absorbed = absorb.map((meal) => ({
    meal: takeRows(db, 'meals', 'id = ?', [meal.id])[0]!,
    itemIds: itemIdsOf(meal.id),
    photoIds: photoIdsOf(meal.id),
  }));
  const freeForm = all.filter(
    (meal, index) => (index === 0 ? keptItemIds : absorbed[index - 1]!.itemIds).length === 0
  );
  const notes = all
    .map((meal) => meal.notes?.trim() ?? '')
    .filter((note, index, list) => note !== '' && list.indexOf(note) === index);
  const source = all.some((meal) => meal.source === 'ai_suggested') ? 'ai_suggested' : keep.source;
  const recipeId = all.find((meal) => meal.recipe_id !== null)?.recipe_id ?? null;

  const standInIds: string[] = [];
  db.transaction(() => {
    for (const meal of freeForm) {
      const id = insertMealItem(db, keep.id, {
        name: `${meal.name} (as logged)`,
        kcal: meal.kcal,
        protein_g: meal.protein_g,
        carbs_g: meal.carbs_g,
        fat_g: meal.fat_g,
      });
      // Stamped with its meal's own `created_at`, so the result lists what was
      // eaten in the order it was logged rather than the typed totals last.
      db.run('UPDATE meal_items SET created_at = ? WHERE id = ?', [meal.created_at, id]);
      standInIds.push(id);
    }
    for (const meal of absorb) {
      db.run('UPDATE meal_items SET meal_id = ? WHERE meal_id = ?', [keep.id, meal.id]);
      db.run('UPDATE meal_photos SET meal_id = ? WHERE meal_id = ?', [keep.id, meal.id]);
      db.run('DELETE FROM meals WHERE id = ?', [meal.id]);
    }
    db.run('UPDATE meals SET name = ?, notes = ?, source = ?, recipe_id = ? WHERE id = ?', [
      name,
      notes.length > 0 ? notes.join('\n\n') : null,
      source,
      recipeId,
      keep.id,
    ]);
    recomputeMealTotals(db, keep.id);
  });

  return {
    keptId: keep.id,
    kept,
    keptItemIds,
    absorbed,
    standInIds,
    result: {
      meal: takeRows(db, 'meals', 'id = ?', [keep.id])[0]!,
      items: itemRecord(db, keep.id),
    },
    name,
    count: all.length,
  };
}

/** Which of these meals are waiting on a queued estimate (0057) — tolerant of a
 *  database that predates the queue, where the answer is none. */
function pendingAmong(db: Database, meals: readonly Pick<MealRow, 'id'>[]): Set<string> {
  try {
    return new Set(
      db
        .all<{ meal_id: string }>(
          `SELECT meal_id FROM pending_estimates WHERE meal_id IN (${marks(meals)})`,
          meals.map((meal) => meal.id)
        )
        .map((row) => row.meal_id)
    );
  } catch {
    return new Set();
  }
}

/**
 * Undo a combine exactly: the stand-in items go, each absorbed meal's row comes
 * back verbatim and its items and photos move back to it by id — so each keeps
 * its `rowid` and `created_at`, and its old place in its old meal — and the kept
 * meal's own columns are restored as they stood. Every meal row is then what it
 * was, so every day total is what it was.
 *
 * **Refuses when the combined meal has moved on** — unless its row and every
 * item read exactly what the combine left (`combined.result`: every column bar
 * the write stamp). An item added, removed, re-portioned, halved or re-counted;
 * a rename, a new time, a changed note; a revision queued against it: any of
 * these, and the old rows and old totals this function restores would be
 * written over the change — a meal nobody logged, and a day total that no
 * longer adds up. So it throws and writes nothing, the way the Coach's
 * staleness guard refuses a card whose row moved (docs/coach-domains.md). The
 * one change it forgives is the database's own: a catalog food or recipe
 * deleted meanwhile, whose reference `ON DELETE SET NULL` cleared.
 *
 * One cost, stated: the moved rows' `updated_at` records the two moves, because
 * the 0014 trigger stamps every UPDATE. It is a write stamp, not the record.
 */
export function uncombineMeals(db: Database, combined: CombinedMeals): void {
  const meal = takeRows(db, 'meals', 'id = ?', [combined.keptId]);
  const unchanged =
    sameRecord(meal, [clearedIfGone(db, combined.result.meal, 'recipe_id', 'recipes')]) &&
    sameRecord(itemRecord(db, combined.keptId), itemsAsExpected(db, combined.result.items)) &&
    pendingAmong(db, [{ id: combined.keptId }]).size === 0;
  if (!unchanged) {
    throw new Error('uncombineMeals: the combined meal has changed since, so it stays as it is.');
  }
  db.transaction(() => {
    if (combined.standInIds.length > 0) {
      db.run(
        `DELETE FROM meal_items WHERE id IN (${marks(combined.standInIds)})`,
        combined.standInIds
      );
    }
    for (const a of combined.absorbed) {
      putRow(db, 'meals', clearedIfGone(db, a.meal, 'recipe_id', 'recipes'));
      const id = String(a.meal.id);
      if (a.itemIds.length > 0) {
        db.run(`UPDATE meal_items SET meal_id = ? WHERE id IN (${marks(a.itemIds)})`, [
          id,
          ...a.itemIds,
        ]);
      }
      if (a.photoIds.length > 0) {
        db.run(`UPDATE meal_photos SET meal_id = ? WHERE id IN (${marks(a.photoIds)})`, [
          id,
          ...a.photoIds,
        ]);
      }
    }
    const kept = clearedIfGone(db, combined.kept, 'recipe_id', 'recipes');
    const RESTORED = [
      'date',
      'time',
      'name',
      'kcal',
      'protein_g',
      'carbs_g',
      'fat_g',
      'source',
      'notes',
      'recipe_id',
    ] as const;
    db.run(`UPDATE meals SET ${RESTORED.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
      ...RESTORED.map((column) => kept[column] ?? null),
      combined.keptId,
    ]);
  });
}

/**
 * The day's fiber, summed from meal items (meals carry no fiber column — only
 * itemized/AI meals know it). Zero on a day with none recorded — which is why
 * nothing that prints or reports the day's fiber reads it any more: see
 * {@link dayFiberRecorded}, which says NULL there instead.
 */
export function dayFiberTotal(db: Database, date: string): number {
  const row = db.get<{ fiber: number | null }>(
    `SELECT sum(mi.fiber_g) AS fiber
     FROM meal_items mi
     JOIN meals m ON m.id = mi.meal_id
     WHERE m.date = ?`,
    [date]
  );
  return row?.fiber ?? 0;
}

/**
 * The day's fiber as {@link dayFiberTotal} sums it — but NULL, not 0, when no
 * item today recorded any (2026-09-23). The Eat tab now prints fiber under its
 * macro bars on every day, and a 0 there would claim a day of zero-fiber foods
 * when the truth is that nothing logged carried a fiber figure at all.
 *
 * Every reader that prints or reports the day's fiber takes this one — the Eat
 * tab, the micronutrients screen, the Coach's `nutritionTargets.fiber` and
 * `keyMicros`, and the `micronutrients` domain — so no two of them can say
 * "not recorded" and "0 g" about the same day (review finding, 2026-09-23).
 */
export function dayFiberRecorded(db: Database, date: string): number | null {
  const row = db.get<{ fiber: number | null }>(
    `SELECT sum(mi.fiber_g) AS fiber
     FROM meal_items mi
     JOIN meals m ON m.id = mi.meal_id
     WHERE m.date = ?`,
    [date]
  );
  return row?.fiber ?? null;
}

/**
 * Every item of the day that records micros or fiber, with its meal — what
 * `mealKeyMicroLabels` (src/lib/nutrition/key-micro.ts) folds into the one
 * notable figure each Eat-tab meal row prints (2026-09-23). A composite header
 * stores neither, so it drops out here and its parts carry the dish, the way
 * they do in every roll-up. A meal typed as totals has no items and no rows.
 */
export function dayMealItemMicros(
  db: Database,
  date: string
): { meal_id: string; micros: string | null; fiber_g: number | null }[] {
  return db.all<{ meal_id: string; micros: string | null; fiber_g: number | null }>(
    `SELECT mi.meal_id, mi.micros, mi.fiber_g
     FROM meal_items mi
     JOIN meals m ON m.id = mi.meal_id
     WHERE m.date = ? AND (mi.micros IS NOT NULL OR mi.fiber_g IS NOT NULL)`,
    [date]
  );
}

/**
 * The day's micronutrient totals, summed from item snapshots (0014). Micros
 * are per-portion JSON, so this reads the day's item payloads and folds them in
 * JS (sumMicros skips absent keys). Only itemized/catalog-linked or AI meals
 * carry micros — a purely free-form manual day yields {}, which the UI reads as
 * "no micro data today", never a fake zero panel.
 */
export function dayMicroTotals(db: Database, date: string): Micros {
  const rows = db.all<{ micros: string | null }>(
    `SELECT mi.micros
     FROM meal_items mi
     JOIN meals m ON m.id = mi.meal_id
     WHERE m.date = ? AND mi.micros IS NOT NULL`,
    [date]
  );
  return sumMicros(rows.map((r) => parseMicros(r.micros)));
}

/**
 * Per-day nutrition totals for the last `days` calendar days (oldest → `today`
 * inclusive, zero-filled), each paired with the daily targets that governed
 * that day — the cross-day trends screen's data source. Macros come from the
 * `meals` columns (correct for free-form and itemized alike); fiber from the
 * item snapshots. Targets are resolved per day so a history row is judged
 * against its own era's targets, not today's. `today` is injectable so the
 * headless tests are deterministic.
 */
export function nutritionHistory(
  db: Database,
  days: number = 14,
  today: string = todayISODate()
): NutritionHistoryDay[] {
  const dates = localDaysList(today, days);
  const start = dates[0] ?? today;

  const mealRows = db.all<{
    date: string;
    kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    mealCount: number;
  }>(
    `SELECT date,
            coalesce(sum(kcal), 0)      AS kcal,
            coalesce(sum(protein_g), 0) AS protein_g,
            coalesce(sum(carbs_g), 0)   AS carbs_g,
            coalesce(sum(fat_g), 0)     AS fat_g,
            count(*)                    AS mealCount
     FROM meals WHERE date >= ? AND date <= ?
     GROUP BY date`,
    [start, today]
  );
  const byDate = new Map(mealRows.map((r) => [r.date, r]));

  const fiberRows = db.all<{ date: string; fiber: number }>(
    `SELECT m.date AS date, coalesce(sum(mi.fiber_g), 0) AS fiber
     FROM meal_items mi
     JOIN meals m ON m.id = mi.meal_id
     WHERE m.date >= ? AND m.date <= ?
     GROUP BY m.date`,
    [start, today]
  );
  const fiberByDate = new Map(fiberRows.map((r) => [r.date, r.fiber]));

  return dates.map((date) => {
    const row = byDate.get(date);
    const t = activeNutritionTargets(db, date);
    return {
      date,
      kcal: row?.kcal ?? 0,
      protein_g: row?.protein_g ?? 0,
      carbs_g: row?.carbs_g ?? 0,
      fat_g: row?.fat_g ?? 0,
      fiber_g: fiberByDate.get(date) ?? 0,
      mealCount: row?.mealCount ?? 0,
      target: t
        ? {
            kcal: t.kcal,
            protein_g: t.protein_g,
            carbs_g: t.carbs_g,
            fat_g: t.fat_g,
            fiber_g: t.fiber_g,
          }
        : null,
    };
  });
}

// === Meal photos (0033: meal_photos) =========================================
//
// The ROW half of meal photos; the file half and the retention sweep that pairs
// them live in src/lib/media/meal-photo-store.ts, which is the only module that
// touches both. Nothing here knows what a directory is — these functions run
// unchanged against node:sqlite in db/nutrition-v2.test.mjs, which is what lets
// the sweep be tested for real without a device.
//
// `file_name` is a base name, never a path (0033 CHECKs it), because iOS
// re-issues the app container's UUID on every install.

/** Record a photo already written to disk; returns its id. The caller writes
 *  the file FIRST and removes it if this throws — see attachMealPhoto. */
export function insertMealPhoto(db: Database, photo: NewMealPhoto): string {
  const id = newId(db);
  db.run(
    `INSERT INTO meal_photos (id, meal_id, file_name, width, height, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, photo.meal_id, photo.file_name, photo.width ?? null, photo.height ?? null, photo.source]
  );
  return id;
}

/**
 * The photo to show on a meal: the most recent one it carries, or undefined.
 *
 * Newest-first rather than oldest so that a second shot of the same meal reads
 * as a correction of the first, which is the only reason anyone takes one.
 */
export function latestMealPhoto(db: Database, mealId: string): MealPhotoRow | undefined {
  return db.get<MealPhotoRow>(
    'SELECT * FROM meal_photos WHERE meal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    [mealId]
  );
}

/**
 * Every photo a meal carries, newest first — what the meal screen draws
 * (2026-09-23). A meal is photographed once, when it is estimated; a meal that
 * holds two is one COMBINED from two photographed meals, and each photo is the
 * evidence for its own part of it, so none is hidden behind the newest.
 */
export function listMealPhotos(db: Database, mealId: string): MealPhotoRow[] {
  return db.all<MealPhotoRow>(
    'SELECT * FROM meal_photos WHERE meal_id = ? ORDER BY created_at DESC, rowid DESC',
    [mealId]
  );
}

/** Every file name one meal holds — read BEFORE deleting the meal, because the
 *  0033 CASCADE takes the rows and leaves the files. */
export function mealPhotoFileNames(db: Database, mealId: string): string[] {
  return db
    .all<{ file_name: string }>('SELECT file_name FROM meal_photos WHERE meal_id = ?', [mealId])
    .map((r) => r.file_name);
}

/** Every photo the database still claims — the sweep's reconcile set. Small by
 *  construction: retention keeps it to roughly a week of meals. */
export function allMealPhotos(db: Database): MealPhotoRow[] {
  return db.all<MealPhotoRow>('SELECT * FROM meal_photos ORDER BY created_at');
}

/**
 * Photos taken before `cutoff` (an ISO-8601 instant) — what the retention sweep
 * clears. Compared against the PHOTO's own created_at, never the meal's date:
 * the meal's date is user-editable now, and a corrected meal time must not
 * expire or resurrect an image.
 */
export function expiredMealPhotos(db: Database, cutoff: string): MealPhotoRow[] {
  return db.all<MealPhotoRow>(
    'SELECT * FROM meal_photos WHERE created_at < ? ORDER BY created_at',
    [cutoff]
  );
}

/** Drop one photo row. The file is the caller's to remove — and if it fails to,
 *  the sweep's orphan pass gets it on the next app open. */
export function deleteMealPhoto(db: Database, id: string): void {
  db.run('DELETE FROM meal_photos WHERE id = ?', [id]);
}

// === Daily targets (0009: nutrition_targets) =================================

/** Append a target version (immutable — changes insert, never update). */
export function setNutritionTargets(db: Database, targets: NewNutritionTargets): string {
  const id = newId(db);
  db.run(
    `INSERT INTO nutrition_targets (id, effective_date, kcal, protein_g, carbs_g, fat_g,
       fiber_g, created_by, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      targets.effective_date,
      targets.kcal ?? null,
      targets.protein_g ?? null,
      targets.carbs_g ?? null,
      targets.fat_g ?? null,
      targets.fiber_g ?? null,
      targets.created_by ?? 'user',
      targets.notes ?? null,
    ]
  );
  return id;
}

/**
 * The target set governing `date`: the newest version effective on or before
 * it (created_at breaks same-day ties). undefined until targets are first set
 * — the UI shows real denominators or none, never a seeded placeholder.
 */
export function activeNutritionTargets(
  db: Database,
  date: string
): NutritionTargetsRow | undefined {
  return db.get<NutritionTargetsRow>(
    `SELECT * FROM nutrition_targets
     WHERE effective_date <= ?
     ORDER BY effective_date DESC, created_at DESC, id DESC
     LIMIT 1`,
    [date]
  );
}
