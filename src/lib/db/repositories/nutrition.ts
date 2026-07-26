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
import { newId } from '../id';
import type { DayTotals, MealRow, NewMeal } from '@/lib/nutrition/types';

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
