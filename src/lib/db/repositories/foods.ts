/**
 * The foods catalog's data layer (0014_food_catalog.sql + the 0016 seed):
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
import { restoreRow, snapshotRows, type SnapshotRow } from '../row-snapshot';
import type { FoodRow, NewFood, RecentFood } from '@/lib/nutrition/types';

/** The search key: lowercased, whitespace-collapsed. Exported for tests. */
export function normalizeFoodName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** LIKE-escape a token so a typed '%' or '_' matches literally (ESCAPE '\').
 * Exported for the other tokenized-search repositories (recipes). */
export function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Persist one catalog food; returns its id. Defaults to a user custom. */
export function createFood(db: Database, food: NewFood): string {
  const id = newId(db);
  db.run(
    `INSERT INTO foods (id, name, name_norm, brand, barcode, serving_name, serving_amount,
       kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, fiber_g_100g, micros, source, basis)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      food.name,
      normalizeFoodName(food.name),
      food.brand ?? null,
      food.barcode ?? null,
      food.serving_name ?? null,
      food.serving_amount ?? null,
      food.kcal_100g ?? null,
      food.protein_g_100g ?? null,
      food.carbs_g_100g ?? null,
      food.fat_g_100g ?? null,
      food.fiber_g_100g ?? null,
      food.micros ?? null,
      food.source ?? 'user',
      // Absent basis is grams — a food nobody called a drink is a solid, which
      // is what every row written before 0047 was.
      food.basis ?? 'g',
    ]
  );
  return id;
}

/**
 * Full rewrite of a food's editable columns (the edit screen loads, merges,
 * saves). `source` is provenance and never changes; existing meal_items keep
 * their logged snapshots regardless — catalog edits only affect future adds.
 *
 * That includes `basis` (0047): correcting a food from grams to millilitres
 * governs the next portion added, and leaves every already-logged item saying
 * the unit it was actually logged in.
 */
export function updateFood(db: Database, id: string, food: NewFood): void {
  db.run(
    `UPDATE foods SET name = ?, name_norm = ?, brand = ?, barcode = ?, serving_name = ?,
       serving_amount = ?, kcal_100g = ?, protein_g_100g = ?, carbs_g_100g = ?,
       fat_g_100g = ?, fiber_g_100g = ?, micros = ?, basis = ?
     WHERE id = ?`,
    [
      food.name,
      normalizeFoodName(food.name),
      food.brand ?? null,
      food.barcode ?? null,
      food.serving_name ?? null,
      food.serving_amount ?? null,
      food.kcal_100g ?? null,
      food.protein_g_100g ?? null,
      food.carbs_g_100g ?? null,
      food.fat_g_100g ?? null,
      food.fiber_g_100g ?? null,
      food.micros ?? null,
      food.basis ?? 'g',
      id,
    ]
  );
}

/** Remove a catalog entry. Logged meal_items keep their snapshots (their
 * food_id goes NULL via ON DELETE SET NULL) — history survives catalog churn. */
export function deleteFood(db: Database, id: string): void {
  db.run('DELETE FROM foods WHERE id = ?', [id]);
}

/**
 * What still points at a catalog food: the meals that logged it, the templates
 * and the recipes that name it. Each of these carries its OWN snapshot of the
 * figures (a meal item and a template item since 0014/0018, a recipe line its
 * per-batch numbers since 0031), so a deletion changes none of their numbers —
 * their `food_id` goes NULL (every reference is `ON DELETE SET NULL`) and they
 * stop linking to it. Counted for the consequence line the food's delete shows
 * on Add food, and on the Coach's card for the same act.
 *
 * `counted` is the one thing that DOES change on screen. A meal item logged as
 * a count of the food's serving ("2 × 1 egg (100 g)") draws its noun from a
 * LIVE join to `foods.serving_name` (`listMealItems`; `portionLabel`), because
 * the serving name was never snapshotted onto the item (0059's header names
 * that gap). Once the food is gone the join is NULL and the row reads as its
 * amount alone ("100 g"); the numbers are untouched. Counted per item, since it
 * is items whose label changes.
 */
export type FoodUsage = { meals: number; templates: number; recipes: number; counted: number };

export function foodUsage(db: Database, id: string): FoodUsage {
  const count = (sql: string): number => db.get<{ n: number }>(sql, [id])?.n ?? 0;
  return {
    meals: count('SELECT count(DISTINCT meal_id) AS n FROM meal_items WHERE food_id = ?'),
    templates: count(
      'SELECT count(DISTINCT template_id) AS n FROM meal_template_items WHERE food_id = ?'
    ),
    recipes: count(
      'SELECT count(DISTINCT recipe_id) AS n FROM recipe_ingredients WHERE food_id = ?'
    ),
    // Exactly the rows `portionLabel` draws a serving count on through the
    // join: a count, no piece noun of its own, and a food that names a serving.
    counted: count(
      `SELECT count(*) AS n FROM meal_items mi JOIN foods f ON f.id = mi.food_id
       WHERE mi.food_id = ? AND mi.serving_qty IS NOT NULL AND mi.piece_name IS NULL
         AND f.serving_name IS NOT NULL`
    ),
  };
}

/** The four tables that reference `foods (id)`, each `ON DELETE SET NULL`. */
const FOOD_LINKS = [
  'meal_items',
  'meal_template_items',
  'recipe_ingredients',
  'grocery_items',
] as const;

/**
 * What a catalog food's deletion took (2026-09-25): the row itself, every
 * column, and the ids of every row that linked to it — the links the
 * `ON DELETE SET NULL` clears. {@link restoreFood} needs both to put the
 * catalog back as it was.
 */
export type TakenFood = {
  food: SnapshotRow;
  /** Per referencing table, the ids whose `food_id` named this food. */
  links: Record<(typeof FOOD_LINKS)[number], string[]>;
};

/**
 * Delete a catalog food the way the Coach always has — {@link deleteFood} —
 * having first read the row and every link to it. Null when there is no such
 * food, and then nothing is deleted.
 */
export function takeFood(db: Database, id: string): TakenFood | null {
  const food = snapshotRows(db, 'foods', 'id = ?', [id])[0];
  if (!food) return null;
  const links = {} as TakenFood['links'];
  for (const table of FOOD_LINKS) {
    links[table] = db
      .all<{ id: string }>(`SELECT id FROM ${table} WHERE food_id = ? ORDER BY rowid`, [id])
      .map((row) => row.id);
  }
  deleteFood(db, id);
  return { food, links };
}

/**
 * Put back what {@link takeFood} took, in one transaction: the food row
 * verbatim (its id, its figures, its favourite star, its `created_at`), then
 * every link the deletion cleared — only where the row is still there and its
 * `food_id` is still empty, so a line re-pointed at another food since keeps
 * its new food.
 *
 * Exact in everything the catalog shows. One cost, stated: a re-linked row's
 * `updated_at` records the re-link, because the per-table trigger stamps every
 * UPDATE — the same write stamp `uncombineMeals` documents.
 *
 * Throws, writing nothing, when the food cannot come back — a food with the
 * same barcode cached since (the barcode index is UNIQUE), or the id taken.
 */
export function restoreFood(db: Database, taken: TakenFood): void {
  const id = String(taken.food.id);
  db.transaction(() => {
    restoreRow(db, 'foods', taken.food);
    for (const table of FOOD_LINKS) {
      const ids = taken.links[table];
      if (ids.length === 0) continue;
      db.run(
        `UPDATE ${table} SET food_id = ?
          WHERE food_id IS NULL AND id IN (${ids.map(() => '?').join(', ')})`,
        [id, ...ids]
      );
    }
  });
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
  last_amount: number | null;
  last_serving_qty: number | null;
  last_logged_at: string;
};

/**
 * Foods most recently logged, newest first, each with the portion it was last
 * logged at — so the recents rail re-adds "what you had last time" in one tap.
 * "Last" is the row written last ({@link readRecentFoods}).
 *
 * `last_serving_qty` is a count of the FOOD's serving, so it is read only where
 * the item has no `piece_name` (2026-09-25): a grounded `2 eggs` counts pieces,
 * and re-adding it as two servings of a food whose serving is `3 slices` would
 * log six. Such a row re-adds by its amount instead, which is the same portion.
 */
export function listRecentFoods(db: Database, limit: number = 12): RecentFood[] {
  return readRecentFoods(db, false, limit);
}

/**
 * The scanner's running list: barcoded foods this user has actually **logged**,
 * newest first, each with the portion it was last logged at.
 *
 * *"Under scan a barcode, lets show a running list of the most recently logged
 * barcodes for quick tapping."* (owner, 2026-08-14.)
 *
 * It is {@link listRecentFoods} narrowed to `f.barcode IS NOT NULL`, and that
 * narrowing is the whole design decision — no table, no migration, no second
 * store of scan history to fall out of step with the catalog. A scanned code
 * already lands in `foods` (`cacheBarcodeFood`, source `openfoodfacts`) and
 * logging it already lands in `meal_items`; the list is the join those two
 * facts already imply.
 *
 * **LOGGED, not scanned** — the join is through `meal_items`, so a code that was
 * scanned and then abandoned at the portion sheet never appears. That is the
 * point: the list exists to re-log a repeat item, and a food nobody ate is not
 * one. A code that resolved to nothing at all never even became a `foods` row,
 * so it cannot appear by construction; it reaches this list only if the user
 * takes the manual fallback, saves the food, and eats it.
 */
export function listRecentBarcodeFoods(db: Database, limit: number = 6): RecentFood[] {
  return readRecentFoods(db, true, limit);
}

/**
 * The two recents rails' one query: each food's LAST logged row, newest first.
 *
 * **Which row is "last" is decided here, never left to SQLite** (2026-09-25).
 * This was a bare column beside `max(created_at)`, whose value comes from
 * whichever row the scan met first at the max — and `created_at` is
 * millisecond text, so one `logMealWithItems` stamps every item it writes with
 * the same value. Two rows of one food in one meal (`2 eggs` beside `1 × egg`)
 * tied, and the portion the rail re-added was an accident of scan order. The
 * tie now breaks on `rowid`, SQLite's own insertion order and the tie-break
 * `ai_messages` and `body_metrics` already use, so "last" is the row written
 * last. `row_number()` is the window function 0042 already runs on the device.
 */
function readRecentFoods(db: Database, barcodeOnly: boolean, limit: number): RecentFood[] {
  const rows = db.all<RecentRow>(
    `WITH latest AS (
       SELECT food_id, amount, serving_qty, piece_name, created_at,
              row_number() OVER (
                PARTITION BY food_id ORDER BY created_at DESC, rowid DESC
              ) AS rn
       FROM meal_items
       WHERE food_id IS NOT NULL
     )
     SELECT f.*, l.amount AS last_amount,
            -- A piece count is not a serving count (listRecentFoods).
            CASE WHEN l.piece_name IS NULL THEN l.serving_qty END AS last_serving_qty,
            l.created_at AS last_logged_at
     FROM latest l
     JOIN foods f ON f.id = l.food_id
     WHERE l.rn = 1${barcodeOnly ? ' AND f.barcode IS NOT NULL' : ''}
     ORDER BY last_logged_at DESC, f.id
     LIMIT ?`,
    [limit]
  );
  return rows.map(({ last_amount, last_serving_qty, last_logged_at, ...food }) => ({
    food,
    lastAmount: last_amount,
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

/**
 * Cache a resolved barcode food (from Open Food Facts) into the catalog and
 * return the stored row. Idempotent: if that barcode is already cached — a
 * re-scan, or a race between two scans — the existing row is returned rather
 * than tripping the partial-unique barcode index. `food.barcode` is normalized
 * to digits so the stored value matches what findFoodByBarcode looks up.
 */
export function cacheBarcodeFood(db: Database, food: NewFood): FoodRow {
  const raw = food.barcode ? food.barcode.replace(/\D/g, '') : '';
  // The schema requires ≥6 digits; a shorter code is stored as no barcode
  // (the food is still cached, just not barcode-addressable) so the CHECK holds.
  const digits = raw.length >= 6 ? raw : '';
  if (digits !== '') {
    const existing = findFoodByBarcode(db, digits);
    if (existing) return existing;
  }
  const id = createFood(db, { ...food, barcode: digits === '' ? null : digits });
  return getFood(db, id)!;
}
