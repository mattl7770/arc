/**
 * What his food history says he usually has — device round 3, items 64, 73 and
 * 74 (docs/nutrition-subapp.md §21). Reads only, plus three writes that are
 * each another repository's: a saved repeat is `createFood` (the Create a food
 * screen's writer), an add-on is `addMealItem` (Add food's), and the offer
 * cursor is the preferences blob (`recordRepeatOffer`). No table, no migration:
 * every answer here is a join the schema already implies.
 *
 * The rules — what "the same food" and "identical" mean, what counts as usual,
 * what an add-on is — live in src/lib/nutrition/repeats.ts, pure, so they are
 * tested without a database.
 */
import type { Database } from '../database';
import { shiftISODate, todayISODate } from '../date';
import { createFood, escapeLike, normalizeFoodName } from './foods';
import { templateItemsToLog } from './meal-templates';
import { addMealItem, copyMealItems } from './nutrition';
import { recordRepeatOffer, repeatOffersMade } from './user';
import {
  ADD_ON_MINUTES,
  addOnItem,
  foodFromRepeat,
  foodKey,
  type LoggedFood,
  pickRepeatFood,
  rankAddOns,
  rankUsualFoods,
  type RepeatFood,
  type UsualAddOn,
  type UsualFood,
  usualFoodsContext,
  USUAL_FOODS_DAYS,
} from '@/lib/nutrition/repeats';
import { activeUsagePolicy } from '@/lib/ai/usage-policy';
import type { MealItemWithServing, NewMealItem } from '@/lib/nutrition/types';

/**
 * Top-level logged items, NEWEST LOGGED FIRST. A composite (0058) reads as the
 * dish: its figures are its parts' sums, its amount and unit only when every
 * part shares one (invariant 5) — otherwise no amount, and grams, the schema's
 * own default.
 */
function loggedFoods(db: Database, where: string, params: (string | number)[]): LoggedFood[] {
  const part = (column: string) =>
    `CASE WHEN mi.is_composite = 0 THEN mi.${column}
          ELSE (SELECT sum(p.${column}) FROM meal_items p WHERE p.parent_item_id = mi.id) END`;
  return db.all<LoggedFood>(
    `SELECT mi.id, mi.meal_id, m.date, mi.food_id, mi.name, mi.serving_qty, mi.piece_name,
            mi.confidence, mi.micros, mi.is_composite, mi.created_at,
            CASE WHEN mi.is_composite = 0 THEN mi.amount
                 ELSE (SELECT CASE WHEN count(DISTINCT p.unit) = 1 AND count(p.amount) = count(*)
                                   THEN sum(p.amount) END
                       FROM meal_items p WHERE p.parent_item_id = mi.id) END AS amount,
            CASE WHEN mi.is_composite = 0 THEN mi.unit
                 ELSE coalesce((SELECT CASE WHEN count(DISTINCT p.unit) = 1 THEN min(p.unit) END
                                FROM meal_items p WHERE p.parent_item_id = mi.id), 'g') END AS unit,
            ${part('kcal')} AS kcal, ${part('protein_g')} AS protein_g,
            ${part('carbs_g')} AS carbs_g, ${part('fat_g')} AS fat_g,
            ${part('fiber_g')} AS fiber_g
     FROM meal_items mi JOIN meals m ON m.id = mi.meal_id
     WHERE mi.parent_item_id IS NULL AND ${where}
     ORDER BY mi.created_at DESC, mi.rowid DESC`,
    params
  );
}

/** The first day of the "usual" window that ends on `today`. */
function windowStart(today: string): string {
  return shiftISODate(today, -(USUAL_FOODS_DAYS - 1));
}

// --- 73 — the estimators' per-call context -----------------------------------

/** His most-logged foods over the last {@link USUAL_FOODS_DAYS} days. */
export function listUsualFoods(
  db: Database,
  today: string = todayISODate(),
  limit: number = activeUsagePolicy().usualFoods
): UsualFood[] {
  return rankUsualFoods(
    loggedFoods(db, 'm.date >= ? AND m.date <= ?', [windowStart(today), today]),
    limit
  );
}

/**
 * The block the photo and describe estimators append to the user turn, or null
 * on a cold start. Never throws: an estimate must not fail because a read of
 * the history did.
 */
export function usualFoodsContextFor(db: Database, today: string = todayISODate()): string | null {
  try {
    return usualFoodsContext(listUsualFoods(db, today));
  } catch (error) {
    console.warn('[food-history] usual foods unavailable', error);
    return null;
  }
}

// --- 73/74 — Save as a food, offered once ------------------------------------

/** The repeat to offer on `date`, if any — without recording the offer. */
export function repeatFoodCandidate(db: Database, date: string): RepeatFood | null {
  const items = loggedFoods(
    db,
    'mi.food_id IS NULL AND mi.is_composite = 0 AND m.date >= ? AND m.date <= ?',
    [windowStart(date), date]
  );
  if (items.length === 0) return null;
  const catalog = new Set(
    db.all<{ name_norm: string }>('SELECT name_norm FROM foods').map((row) => row.name_norm)
  );
  return pickRepeatFood(items, date, repeatOffersMade(db), catalog);
}

/**
 * The repeat to offer now, recorded as offered in the same breath — the offer
 * is made ONCE, so making it and remembering it are one act. Null when there is
 * none.
 */
export function takeRepeatFoodOffer(db: Database, date: string): RepeatFood | null {
  const repeat = repeatFoodCandidate(db, date);
  if (repeat) recordRepeatOffer(db, repeat.key);
  return repeat;
}

/** Save the repeat as a catalog food, through `createFood`; returns its id. */
export function saveRepeatAsFood(db: Database, repeat: RepeatFood): string {
  return createFood(db, foodFromRepeat(repeat.latest));
}

// --- 74 — saved meals and past meals in Add food's search --------------------

/** A saved meal or a past meal that a search found. */
export type MealHit = {
  kind: 'template' | 'meal';
  id: string;
  name: string;
  kcal: number | null;
  /** Top-level items — a pizza is one. */
  itemCount: number;
  /** A past meal's day; null for a template. */
  date: string | null;
};

/** Every token of the query in the name, as the catalog search matches. */
function tokensOf(query: string): string[] {
  const q = normalizeFoodName(query);
  return q === '' ? [] : q.split(' ');
}

/**
 * Saved meals (templates) and past meals whose name holds every word typed —
 * the catalog search's rule (`searchFoods`). Past meals: only ones with items
 * (a free-form total has nothing to add as items), one per name — the latest —
 * and never `excludeMealId`, the meal being added to.
 */
export function searchMealHits(
  db: Database,
  query: string,
  options: { excludeMealId?: string | null; limit?: number } = {}
): { templates: MealHit[]; meals: MealHit[] } {
  const tokens = tokensOf(query);
  if (tokens.length === 0) return { templates: [], meals: [] };
  const limit = options.limit ?? 5;
  const like = tokens.map((t) => `%${escapeLike(t)}%`);

  const templates = db
    .all<{ id: string; name: string; kcal: number | null; n: number }>(
      `SELECT t.id, t.name, sum(ti.kcal) AS kcal, count(ti.id) AS n
       FROM meal_templates t JOIN meal_template_items ti ON ti.template_id = t.id
       WHERE ${tokens.map(() => `t.name_norm LIKE ? ESCAPE '\\'`).join(' AND ')}
       GROUP BY t.id ORDER BY t.name, t.id LIMIT ?`,
      [...like, limit]
    )
    .map((row) => ({
      kind: 'template' as const,
      id: row.id,
      name: row.name,
      kcal: row.kcal,
      itemCount: row.n,
      date: null,
    }));

  // LIKE is case-blind for ASCII only, so it narrows and the normalized name
  // decides — the same split the catalog's own name_norm makes.
  const rows = db.all<{ id: string; name: string; kcal: number | null; date: string; n: number }>(
    `SELECT m.id, m.name, m.kcal, m.date,
            (SELECT count(*) FROM meal_items mi
             WHERE mi.meal_id = m.id AND mi.parent_item_id IS NULL) AS n
     FROM meals m
     WHERE m.id <> ? AND ${tokens.map(() => `m.name LIKE ? ESCAPE '\\'`).join(' AND ')}
       AND EXISTS (SELECT 1 FROM meal_items mi WHERE mi.meal_id = m.id)
     ORDER BY m.date DESC, (m.time IS NULL), m.time DESC, m.created_at DESC, m.id
     LIMIT 200`,
    [options.excludeMealId ?? '', ...like]
  );
  const seen = new Set<string>();
  const meals: MealHit[] = [];
  for (const row of rows) {
    const norm = normalizeFoodName(row.name);
    if (!tokens.every((t) => norm.includes(t)) || seen.has(norm)) continue;
    seen.add(norm);
    meals.push({
      kind: 'meal',
      id: row.id,
      name: row.name,
      kcal: row.kcal,
      itemCount: row.n,
      date: row.date,
    });
    if (meals.length >= limit) break;
  }
  return { templates, meals };
}

/** The items a hit adds — a template's, or a past meal's copied as logged. */
export function mealHitItems(db: Database, hit: Pick<MealHit, 'kind' | 'id'>): NewMealItem[] {
  if (hit.kind === 'template') return templateItemsToLog(db, hit.id);
  return copyMealItems(
    db,
    db.all<MealItemWithServing>(
      'SELECT * FROM meal_items WHERE meal_id = ? ORDER BY created_at, rowid',
      [hit.id]
    )
  );
}

// --- 64 — a drink's usual add-ons --------------------------------------------

/** How many earlier logs of a drink are read for its add-ons. */
const ADD_ON_OCCURRENCES = 50;

/**
 * The usual add-ons for the logged item `itemId`: empty unless it is a DRINK — a
 * top-level row measured in millilitres (0047), or a dish whose parts all are —
 * and empty on a cold start. Learned from the drink's earlier logs: what else
 * was logged in the same meal within {@link ADD_ON_MINUTES} minutes of it.
 */
export function usualAddOnsFor(db: Database, itemId: string): UsualAddOn[] {
  const drink = loggedFoods(db, 'mi.id = ?', [itemId])[0];
  if (!drink || drink.unit !== 'ml') return [];
  const key = foodKey(drink);
  const earlier = (
    drink.food_id !== null
      ? loggedFoods(db, 'mi.food_id = ? AND mi.id <> ?', [drink.food_id, drink.id])
      : loggedFoods(db, `mi.food_id IS NULL AND mi.name LIKE ? ESCAPE '\\' AND mi.id <> ?`, [
          escapeLike(drink.name.trim()),
          drink.id,
        ])
  )
    .filter((item) => foodKey(item) === key)
    .slice(0, ADD_ON_OCCURRENCES);
  if (earlier.length === 0) return [];

  const ids = earlier.map((item) => item.id);
  const companions = db.all<{ occurrence: string; companion: string }>(
    `SELECT o.id AS occurrence, a.id AS companion
       FROM meal_items o
       JOIN meal_items a ON a.meal_id = o.meal_id AND a.id <> o.id
        AND a.parent_item_id IS NULL AND a.is_composite = 0
        AND abs(julianday(a.created_at) - julianday(o.created_at)) * 1440 <= ?
       WHERE o.id IN (${ids.map(() => '?').join(', ')})`,
    [ADD_ON_MINUTES, ...ids]
  );
  if (companions.length === 0) return [];
  const companionIds = [...new Set(companions.map((row) => row.companion))];
  const byId = new Map(
    loggedFoods(db, `mi.id IN (${companionIds.map(() => '?').join(', ')})`, companionIds).map(
      (item) => [item.id, item]
    )
  );
  const present = new Set(
    db
      .all<{ food_id: string | null; name: string }>(
        'SELECT food_id, name FROM meal_items WHERE meal_id = ? AND parent_item_id IS NULL',
        [drink.meal_id]
      )
      .map(foodKey)
  );
  return rankAddOns(
    key,
    companions.flatMap((row) => {
      const item = byId.get(row.companion);
      return item ? [{ occurrence: row.occurrence, item }] : [];
    }),
    present
  );
}

/**
 * Every drink's add-ons in one meal, keyed by item id — what meal-detail draws.
 * Only drinks with at least one add-on appear.
 *
 * **The drink is the bigger pour.** Milk and syrup are measured in ml too, and
 * co-occurrence is symmetric — the flat white went with the milk as often as
 * the milk with the flat white — so history alone cannot say which is the
 * drink. Volume can: an ml row with a LARGER ml row logged within
 * {@link ADD_ON_MINUTES} minutes of it in the same meal is an add-on here, and
 * draws no chips of its own. And a chip is drawn once per meal, under the first
 * drink that offers it.
 */
export function mealAddOns(db: Database, mealId: string): Record<string, UsualAddOn[]> {
  const out: Record<string, UsualAddOn[]> = {};
  try {
    const pours = loggedFoods(db, 'mi.meal_id = ?', [mealId])
      .filter((i) => i.unit === 'ml')
      .reverse(); // logged order
    const minutes = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 60000;
    const drinks = pours.filter(
      (pour) =>
        !pours.some(
          (other) =>
            other.id !== pour.id &&
            (other.amount ?? 0) > (pour.amount ?? 0) &&
            minutes(other.created_at, pour.created_at) <= ADD_ON_MINUTES
        )
    );
    const shown = new Set<string>();
    for (const drink of drinks) {
      const addOns = usualAddOnsFor(db, drink.id).filter((addOn) => !shown.has(addOn.key));
      for (const addOn of addOns) shown.add(addOn.key);
      if (addOns.length > 0) out[drink.id] = addOns;
    }
  } catch (error) {
    // A suggestion is never worth a broken meal screen.
    console.warn('[food-history] add-ons unavailable', error);
  }
  return out;
}

/** One tap: the add-on, as last logged, into `mealId` — through `addMealItem`. */
export function addUsualAddOn(db: Database, mealId: string, addOn: UsualAddOn): string {
  return addMealItem(db, mealId, addOnItem(addOn));
}
