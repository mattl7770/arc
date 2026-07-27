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
