/**
 * The foods catalog's data layer (0008_food_catalog.sql + the 0010 seed):
 * search, favorites, recents, customs, and the offline barcode lookup.
 *
 * Search is tokenized LIKE over `name_norm` — a lowercased key this repository
 * writes on every insert/update (SQLite's lower() is ASCII-only, so
 * normalization lives here in JS). At catalog scale (a few hundred rows,
 * growing by the user's own foods) that needs no FTS; revisit if it ever
 * passes ~5k rows. Ranking: whole-query prefix matches first, favorites next,
 * then name — deterministic, no scoring magic.
 *
 * Like every repository, this depends only on the {@link Database} interface —
 * never op-sqlite — so the same code runs on device and against node:sqlite in
 * db/foods.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { FoodRow, NewFood, RecentFood } from '@/lib/nutrition/types';

/** The search key: lowercased, whitespace-collapsed. Exported for tests. */
export function normalizeFoodName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** LIKE-escape a token so a typed '%' or '_' matches literally (ESCAPE '\'). */
function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Persist one catalog food; returns its id. Defaults to a user custom. */
export function createFood(db: Database, food: NewFood): string {
  const id = newId(db);
  db.run(
    `INSERT INTO foods (id, name, name_norm, brand, barcode, serving_name, serving_grams,
       kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, fiber_g_100g, micros, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      food.name,
      normalizeFoodName(food.name),
      food.brand ?? null,
      food.barcode ?? null,
      food.serving_name ?? null,
      food.serving_grams ?? null,
      food.kcal_100g ?? null,
      food.protein_g_100g ?? null,
      food.carbs_g_100g ?? null,
      food.fat_g_100g ?? null,
      food.fiber_g_100g ?? null,
      food.micros ?? null,
      food.source ?? 'user',
    ]
  );
  return id;
}

/**
 * Full rewrite of a food's editable columns (the edit screen loads, merges,
 * saves). `source` is provenance and never changes; existing meal_items keep
 * their logged snapshots regardless — catalog edits only affect future adds.
 */
export function updateFood(db: Database, id: string, food: NewFood): void {
  db.run(
    `UPDATE foods SET name = ?, name_norm = ?, brand = ?, barcode = ?, serving_name = ?,
       serving_grams = ?, kcal_100g = ?, protein_g_100g = ?, carbs_g_100g = ?,
       fat_g_100g = ?, fiber_g_100g = ?, micros = ?
     WHERE id = ?`,
    [
      food.name,
      normalizeFoodName(food.name),
      food.brand ?? null,
      food.barcode ?? null,
      food.serving_name ?? null,
      food.serving_grams ?? null,
      food.kcal_100g ?? null,
      food.protein_g_100g ?? null,
      food.carbs_g_100g ?? null,
      food.fat_g_100g ?? null,
      food.fiber_g_100g ?? null,
      food.micros ?? null,
      id,
    ]
  );
}

/** Remove a catalog entry. Logged meal_items keep their snapshots (their
 * food_id goes NULL via ON DELETE SET NULL) — history survives catalog churn. */
export function deleteFood(db: Database, id: string): void {
  db.run('DELETE FROM foods WHERE id = ?', [id]);
}

export function getFood(db: Database, id: string): FoodRow | undefined {
  return db.get<FoodRow>('SELECT * FROM foods WHERE id = ?', [id]);
}

export function setFoodFavorite(db: Database, id: string, favorite: boolean): void {
  db.run('UPDATE foods SET is_favorite = ? WHERE id = ?', [favorite ? 1 : 0, id]);
}

/**
 * Catalog search: every whitespace token must appear in `name_norm`; rows
 * whose name starts with the whole query rank first, favorites break ties.
 * An empty/blank query returns nothing — the screen shows recents instead.
 */
export function searchFoods(db: Database, query: string, limit: number = 25): FoodRow[] {
  const q = normalizeFoodName(query);
  if (q === '') return [];
  const tokens = q.split(' ');
  const where = tokens.map(() => `name_norm LIKE ? ESCAPE '\\'`).join(' AND ');
  const params = tokens.map((t) => `%${escapeLike(t)}%`);
  return db.all<FoodRow>(
    `SELECT * FROM foods WHERE ${where}
     ORDER BY (name_norm LIKE ? ESCAPE '\\') DESC, is_favorite DESC, name, id
     LIMIT ?`,
    [...params, `${escapeLike(q)}%`, limit]
  );
}

export function listFavoriteFoods(db: Database): FoodRow[] {
  return db.all<FoodRow>('SELECT * FROM foods WHERE is_favorite = 1 ORDER BY name, id');
}

/** One recents row before the {@link RecentFood} shape is assembled. */
type RecentRow = FoodRow & {
  last_grams: number | null;
  last_serving_qty: number | null;
  last_logged_at: string;
};

/**
 * Foods most recently logged, newest first, each with the portion it was last
 * logged at — so the recents rail re-adds "what you had last time" in one tap.
 * Relies on SQLite's documented bare-column-with-max() behavior: the
 * last_grams / last_serving_qty values come from the same row that supplied
 * max(created_at).
 */
export function listRecentFoods(db: Database, limit: number = 12): RecentFood[] {
  const rows = db.all<RecentRow>(
    `SELECT f.*, mi.grams AS last_grams, mi.serving_qty AS last_serving_qty,
            max(mi.created_at) AS last_logged_at
     FROM meal_items mi
     JOIN foods f ON f.id = mi.food_id
     GROUP BY f.id
     ORDER BY last_logged_at DESC, f.id
     LIMIT ?`,
    [limit]
  );
  return rows.map(({ last_grams, last_serving_qty, last_logged_at, ...food }) => ({
    food,
    lastGrams: last_grams,
    lastServingQty: last_serving_qty,
    lastLoggedAt: last_logged_at,
  }));
}

/**
 * Offline barcode lookup against the grown local cache (seeded foods carry no
 * barcodes; scanned Open Food Facts hits are written back as catalog rows).
 * Accepts raw scanner output — anything non-digit is stripped before lookup.
 */
export function findFoodByBarcode(db: Database, barcode: string): FoodRow | undefined {
  const digits = barcode.replace(/\D/g, '');
  if (digits === '') return undefined;
  return db.get<FoodRow>('SELECT * FROM foods WHERE barcode = ?', [digits]);
}
