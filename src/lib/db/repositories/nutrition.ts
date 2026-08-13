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
import type { Database } from '../database';
import { localDaysList, todayISODate } from '../date';
import { newId } from '../id';
import type { DateString, TimeString } from '../types';
import { isValidClock } from '@/lib/nutrition/meal-time';
import { type Micros, parseMicros, sumMicros } from '@/lib/nutrition/micros';
import type {
  DayTotals,
  MealItemWithServing,
  MealPhotoRow,
  MealRow,
  NewMeal,
  NewMealItem,
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

function insertMealItem(db: Database, mealId: string, item: NewMealItem): string {
  const id = newId(db);
  db.run(
    `INSERT INTO meal_items (id, meal_id, food_id, name, grams, serving_qty,
       kcal, protein_g, carbs_g, fat_g, fiber_g, confidence, micros)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      mealId,
      item.food_id ?? null,
      item.name,
      item.grams ?? null,
      item.serving_qty ?? null,
      item.kcal ?? null,
      item.protein_g ?? null,
      item.carbs_g ?? null,
      item.fat_g ?? null,
      item.fiber_g ?? null,
      item.confidence ?? null,
      item.micros ?? null,
    ]
  );
  return id;
}

/**
 * Re-derive a meal's macro columns from its items. SQLite's sum() already
 * NULL-skips (and yields NULL over zero rows), so a meal emptied of items
 * returns to free-form NULLs — "not recorded", never a fake 0. Callers wrap
 * this in the same transaction as the item change.
 */
function recomputeMealTotals(db: Database, mealId: string): void {
  db.run(
    `UPDATE meals SET
       kcal      = (SELECT sum(kcal)      FROM meal_items WHERE meal_id = ?),
       protein_g = (SELECT sum(protein_g) FROM meal_items WHERE meal_id = ?),
       carbs_g   = (SELECT sum(carbs_g)   FROM meal_items WHERE meal_id = ?),
       fat_g     = (SELECT sum(fat_g)     FROM meal_items WHERE meal_id = ?)
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
        sumOrNull(meal.items.map((i) => i.kcal)),
        sumOrNull(meal.items.map((i) => i.protein_g)),
        sumOrNull(meal.items.map((i) => i.carbs_g)),
        sumOrNull(meal.items.map((i) => i.fat_g)),
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
    'grams' | 'serving_qty' | 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g' | 'fiber_g' | 'micros'
  >
): void {
  const row = db.get<{ meal_id: string }>('SELECT meal_id FROM meal_items WHERE id = ?', [itemId]);
  if (!row) return;
  db.transaction(() => {
    db.run(
      `UPDATE meal_items SET grams = ?, serving_qty = ?, kcal = ?, protein_g = ?,
         carbs_g = ?, fat_g = ?, fiber_g = ?, micros = ?
       WHERE id = ?`,
      [
        portion.grams ?? null,
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

/** Remove one item; the meal's totals follow (all-NULL once emptied). */
export function removeMealItem(db: Database, itemId: string): void {
  const row = db.get<{ meal_id: string }>('SELECT meal_id FROM meal_items WHERE id = ?', [itemId]);
  if (!row) return;
  db.transaction(() => {
    db.run('DELETE FROM meal_items WHERE id = ?', [itemId]);
    recomputeMealTotals(db, row.meal_id);
  });
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

/** meal_id → item count for one day — the "Eaten today" list's "· N items". */
export function mealItemCounts(db: Database, date: string): Record<string, number> {
  const rows = db.all<{ meal_id: string; n: number }>(
    `SELECT mi.meal_id, count(*) AS n
     FROM meal_items mi
     JOIN meals m ON m.id = mi.meal_id
     WHERE m.date = ?
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
     WHERE m.date = ?
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
  return logMealWithItems(db, {
    date,
    time,
    name: meal.name,
    notes: meal.notes,
    source,
    recipe_id: meal.recipe_id,
    items: items.map((i) => ({
      food_id: i.food_id,
      name: i.name,
      grams: i.grams,
      serving_qty: i.serving_qty,
      kcal: i.kcal,
      protein_g: i.protein_g,
      carbs_g: i.carbs_g,
      fat_g: i.fat_g,
      fiber_g: i.fiber_g,
      confidence: i.confidence,
      micros: i.micros,
    })),
  }).mealId;
}

/**
 * The day's fiber, summed from meal items (meals carry no fiber column — only
 * itemized/AI meals know it). Zero on a day with none recorded; the Today card
 * only surfaces fiber when a fiber target exists, so a manual-entry day isn't
 * scolded over data it never captured.
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
