/**
 * The grocery list's data layer (0031_grocery.sql): one standing list, its
 * check-off history, and the per-item-name memory (grocery_name_prefs) that
 * powers autocomplete, staples, and learned categories. Spec:
 * docs/recipes-grocery.md §2b.
 *
 * Column-ownership rules (what keeps times_added from double-counting):
 *  - addGroceryItems owns times_added / last_added_at / last_qty_text /
 *    display_name — one upsert per add, in the same transaction as the insert.
 *  - The user re-filing an item (updateGroceryItem with a category) owns
 *    prefs.category, which then beats the static keyword table forever.
 *  - setStaple owns is_staple.
 *  - CHECK-OFF WRITES NOTHING to prefs — purchase recency is read straight
 *    from grocery_items.checked_at (the Recent chips), and clearing the cart
 *    section deletes those rows without touching the memory.
 *
 * Like every repository, this depends only on the {@link Database} interface —
 * never op-sqlite — so the same code runs on device and against node:sqlite in
 * db/grocery.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import { normalizeFoodName } from './foods';
import { listIngredients } from './recipes';
import { categorizeGroceryItem, GROCERY_CATEGORIES } from '@/lib/grocery/categories';
import { mergeQtyTexts } from '@/lib/grocery/quantities';
import { formatQty } from '@/lib/recipes/ingredients';
import type {
  ConsolidatedGroceryLine,
  GroceryItemRow,
  GroceryNamePrefRow,
  NewGroceryItem,
} from '@/lib/grocery/types';

const NOW_ISO = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/** Category → display rank (unknown categories sort after the known ones). */
const CATEGORY_RANK: Record<string, number> = Object.fromEntries(
  GROCERY_CATEGORIES.map((c, i) => [c.key, i])
);

function categoryRank(category: string): number {
  return CATEGORY_RANK[category] ?? GROCERY_CATEGORIES.length;
}

export function getNamePref(db: Database, nameNorm: string): GroceryNamePrefRow | undefined {
  return db.get<GroceryNamePrefRow>('SELECT * FROM grocery_name_prefs WHERE name_norm = ?', [
    nameNorm,
  ]);
}

/** The add-time prefs upsert (owns times_added/last_added_at/last_qty_text/
 * display_name; leaves category and is_staple alone). Callers hold the txn. */
function recordAdd(db: Database, nameNorm: string, displayName: string, qtyText: string | null) {
  const existing = getNamePref(db, nameNorm);
  if (existing) {
    db.run(
      `UPDATE grocery_name_prefs
       SET display_name = ?, last_qty_text = coalesce(?, last_qty_text),
           times_added = times_added + 1, last_added_at = ${NOW_ISO}
       WHERE name_norm = ?`,
      [displayName, qtyText, nameNorm]
    );
  } else {
    db.run(
      `INSERT INTO grocery_name_prefs (id, name_norm, display_name, last_qty_text,
         times_added, last_added_at)
       VALUES (?, ?, ?, ?, 1, ${NOW_ISO})`,
      [newId(db), nameNorm, displayName, qtyText]
    );
  }
}

/**
 * Add items (batch — one transaction). Category: explicit value > the user's
 * learned pref > the static keyword table > 'other'. Every add feeds the
 * prefs memory per the ownership rules above. Returns the new item ids.
 */
export function addGroceryItems(db: Database, items: NewGroceryItem[]): string[] {
  const ids: string[] = [];
  db.transaction(() => {
    for (const item of items) {
      const name = item.name.trim();
      if (name === '') continue;
      const nameNorm = normalizeFoodName(name);
      const pref = getNamePref(db, nameNorm);
      const category = item.category ?? categorizeGroceryItem(nameNorm, pref?.category);
      const id = newId(db);
      db.run(
        `INSERT INTO grocery_items (id, name, name_norm, qty_text, category, source,
           recipe_id, food_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          name,
          nameNorm,
          item.qty_text ?? null,
          category,
          item.source ?? 'user',
          item.recipe_id ?? null,
          item.food_id ?? null,
        ]
      );
      recordAdd(db, nameNorm, name, item.qty_text ?? null);
      ids.push(id);
    }
  });
  return ids;
}

/** Open items, category walking order then oldest-first within a category. */
export function listOpenGroceryItems(db: Database): GroceryItemRow[] {
  const rows = db.all<GroceryItemRow>(
    'SELECT * FROM grocery_items WHERE checked_at IS NULL ORDER BY created_at, id'
  );
  return rows.sort(
    (a, b) =>
      categoryRank(a.category) - categoryRank(b.category) ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id)
  );
}

/** Checked ("in cart") items, newest check-off first. */
export function listCheckedGroceryItems(db: Database, limit: number = 50): GroceryItemRow[] {
  return db.all<GroceryItemRow>(
    'SELECT * FROM grocery_items WHERE checked_at IS NOT NULL ORDER BY checked_at DESC, id LIMIT ?',
    [limit]
  );
}

export function getGroceryItem(db: Database, id: string): GroceryItemRow | undefined {
  return db.get<GroceryItemRow>('SELECT * FROM grocery_items WHERE id = ?', [id]);
}

/** Check off an item — a soft state (checked_at stamps), never a delete. */
export function checkGroceryItem(db: Database, id: string): void {
  db.run(`UPDATE grocery_items SET checked_at = ${NOW_ISO} WHERE id = ?`, [id]);
}

export function uncheckGroceryItem(db: Database, id: string): void {
  db.run('UPDATE grocery_items SET checked_at = NULL WHERE id = ?', [id]);
}

/** Empty the "in cart" section. Deletes only CHECKED rows; the prefs memory
 * (autocomplete/staples/learned categories) is untouched by design. */
export function clearCheckedItems(db: Database): number {
  const row = db.get<{ n: number }>(
    'SELECT count(*) AS n FROM grocery_items WHERE checked_at IS NOT NULL'
  );
  db.run('DELETE FROM grocery_items WHERE checked_at IS NOT NULL');
  return row?.n ?? 0;
}

/**
 * Edit an item. A name change re-derives name_norm; a CATEGORY change is the
 * user re-filing — it writes the learned pref (upserting the row if the item
 * predates the memory), which beats the static table on every future add.
 */
export function updateGroceryItem(
  db: Database,
  id: string,
  changes: { name?: string; qty_text?: string | null; category?: string }
): void {
  const item = getGroceryItem(db, id);
  if (!item) return;
  const name = changes.name?.trim() || item.name;
  const nameNorm = normalizeFoodName(name);
  db.transaction(() => {
    db.run(
      'UPDATE grocery_items SET name = ?, name_norm = ?, qty_text = ?, category = ? WHERE id = ?',
      [
        name,
        nameNorm,
        changes.qty_text !== undefined ? changes.qty_text : item.qty_text,
        changes.category ?? item.category,
        id,
      ]
    );
    if (changes.category && changes.category !== item.category) {
      const pref = getNamePref(db, nameNorm);
      if (pref) {
        db.run('UPDATE grocery_name_prefs SET category = ? WHERE name_norm = ?', [
          changes.category,
          nameNorm,
        ]);
      } else {
        db.run(
          `INSERT INTO grocery_name_prefs (id, name_norm, display_name, category)
           VALUES (?, ?, ?, ?)`,
          [newId(db), nameNorm, name, changes.category]
        );
      }
    }
  });
}

export function removeGroceryItem(db: Database, id: string): void {
  db.run('DELETE FROM grocery_items WHERE id = ?', [id]);
}

/**
 * Add a recipe's ingredient lines to the list (the pre-checked-picker flow:
 * the caller passes exactly the ingredient ids the user left checked). Items
 * carry recipe/food backlinks and a qty display built from the parsed overlay.
 * Returns the new item ids.
 */
export function addRecipeToGroceryList(
  db: Database,
  recipeId: string,
  includeIngredientIds: string[]
): string[] {
  const include = new Set(includeIngredientIds);
  const lines = listIngredients(db, recipeId).filter((l) => include.has(l.id));
  const items: NewGroceryItem[] = lines.map((line) => ({
    name: line.name ?? line.raw_text,
    qty_text:
      line.qty !== null ? `${formatQty(line.qty)}${line.unit ? ` ${line.unit}` : ''}` : null,
    source: 'recipe',
    recipe_id: recipeId,
    food_id: line.food_id,
  }));
  return addGroceryItems(db, items);
}

/** Autocomplete over the user's own history: prefix match on name_norm,
 * most-added first. Empty prefix → nothing (the screen shows staples instead). */
export function searchGroceryHistory(
  db: Database,
  prefix: string,
  limit: number = 8
): GroceryNamePrefRow[] {
  const q = normalizeFoodName(prefix);
  if (q === '') return [];
  const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return db.all<GroceryNamePrefRow>(
    `SELECT * FROM grocery_name_prefs WHERE name_norm LIKE ? ESCAPE '\\'
     ORDER BY times_added DESC, last_added_at DESC, name_norm LIMIT ?`,
    [`${escaped}%`, limit]
  );
}

export function listStaples(db: Database): GroceryNamePrefRow[] {
  return db.all<GroceryNamePrefRow>(
    'SELECT * FROM grocery_name_prefs WHERE is_staple = 1 ORDER BY display_name, id'
  );
}

/** Star/unstar a name as a staple (upserts the memory row if it's new). */
export function setStaple(db: Database, name: string, staple: boolean): void {
  const nameNorm = normalizeFoodName(name);
  const pref = getNamePref(db, nameNorm);
  if (pref) {
    db.run('UPDATE grocery_name_prefs SET is_staple = ? WHERE name_norm = ?', [
      staple ? 1 : 0,
      nameNorm,
    ]);
  } else if (staple) {
    db.run(
      `INSERT INTO grocery_name_prefs (id, name_norm, display_name, is_staple)
       VALUES (?, ?, ?, 1)`,
      [newId(db), nameNorm, name.trim()]
    );
  }
}

/**
 * The consolidated open list: one line per name_norm, quantities merged for
 * display (same-unit sums only; mixed units join with " + "), member items
 * preserved — a VIEW, never a destructive merge. Ordered by category walking
 * order, then first-added.
 */
export function consolidatedOpenList(db: Database): ConsolidatedGroceryLine[] {
  const open = listOpenGroceryItems(db);
  const byName = new Map<string, GroceryItemRow[]>();
  for (const item of open) {
    const group = byName.get(item.name_norm);
    if (group) group.push(item);
    else byName.set(item.name_norm, [item]);
  }
  return [...byName.values()].map((items) => ({
    name: items[0]!.name,
    name_norm: items[0]!.name_norm,
    category: items[0]!.category,
    qtyDisplay: mergeQtyTexts(items.map((i) => i.qty_text)),
    items,
  }));
}

/** Open-item count — the Nutrition hub's "Grocery list · N" line. */
export function openGroceryCount(db: Database): number {
  const row = db.get<{ n: number }>(
    'SELECT count(*) AS n FROM grocery_items WHERE checked_at IS NULL'
  );
  return row?.n ?? 0;
}
