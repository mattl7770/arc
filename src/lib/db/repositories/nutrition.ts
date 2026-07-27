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
import { todayISODate } from '../date';
import { newId } from '../id';
import { type Micros, parseMicros, sumMicros } from '@/lib/nutrition/micros';
import type {
  DayTotals,
  MealItemWithServing,
  MealRow,
  NewMeal,
  NewMealItem,
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
 * `count` local-calendar dates ending at (and including) `end`, oldest first —
 * the zero-fill scaffold for {@link dailyIntakeSeries}. Built from Date math
 * (not a SQL date range) so callers always get exactly `count` points
 * regardless of how sparse the data is; `end` is parsed as local Y/M/D
 * components, not `new Date(string)`, which some runtimes treat as UTC
 * midnight and would shift the day near timezone boundaries.
 */
function dateListEndingAt(end: string, count: number): string[] {
  const [y, m, d] = end.split('-').map(Number);
  const dates: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    dates.push(todayISODate(new Date(y!, m! - 1, d! - i)));
  }
  return dates;
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
  const dates = dateListEndingAt(today, days);
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
      `INSERT INTO meals (id, date, time, name, kcal, protein_g, carbs_g, fat_g, source, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
     ORDER BY mi.created_at, mi.id`,
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

export function getMeal(db: Database, id: string): MealRow | undefined {
  return db.get<MealRow>('SELECT * FROM meals WHERE id = ?', [id]);
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
  const items = db.all<MealItemWithServing>('SELECT * FROM meal_items WHERE meal_id = ?', [mealId]);
  if (items.length === 0) {
    // Direct insert rather than logMeal, which stamps source='manual'.
    const id = newId(db);
    db.run(
      `INSERT INTO meals (id, date, time, name, kcal, protein_g, carbs_g, fat_g, source, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ]
    );
    return id;
  }
  return logMealWithItems(db, {
    date,
    time,
    name: meal.name,
    notes: meal.notes,
    source,
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
  const dates = dateListEndingAt(today, days);
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
