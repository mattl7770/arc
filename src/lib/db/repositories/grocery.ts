/**
 * The grocery list's data layer (0032_grocery.sql): one standing list, its
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

/**
 * How long a checked item stays in the CURRENT cart before it ages into "Old
 * carts" (owner call, 2026-08-12: *"move anything checked off in a cart that is
 * over 1 day old into the old carts tab"*).
 *
 * A day, exactly as asked, and measured from the check-off — not from midnight.
 * Midnight would age a 23:50 shop out of the cart ten minutes later, which is
 * the one moment it is most likely to still be being unpacked.
 */
export const CART_AGE_HOURS = 24;

/** The current cart, and the carts before it. */
export type CartSplit = {
  /** Checked within the last {@link CART_AGE_HOURS} — this shop. */
  cart: GroceryItemRow[];
  /** Checked before that — previous shops, kept for the re-add history. */
  old: GroceryItemRow[];
};

/**
 * The instant a checked item stops belonging to the current cart. Exported so
 * the screen and the repository agree on one boundary instead of computing two.
 */
export function cartCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - CART_AGE_HOURS * 3_600_000).toISOString();
}

/**
 * Split checked items into the current cart and the older ones.
 *
 * Pure over the rows, so the partition is testable without a clock: `checked_at`
 * is an ISO-8601 UTC string and the cutoff is one too, and that shape compares
 * lexicographically in chronological order (the same property the reminder
 * floor leans on). A row with a NULL `checked_at` cannot occur here — the
 * callers select on `checked_at IS NOT NULL` — but it would sort into `old`
 * rather than silently vanish.
 */
export function splitCart(items: GroceryItemRow[], cutoff: string): CartSplit {
  const cart: GroceryItemRow[] = [];
  const old: GroceryItemRow[] = [];
  for (const item of items) {
    if (item.checked_at !== null && item.checked_at >= cutoff) cart.push(item);
    else old.push(item);
  }
  return { cart, old };
}

/** The two cart sections the grocery screen draws, newest check-off first in
 *  each. One query, one boundary — see {@link splitCart}. */
export function cartSections(db: Database, now: Date = new Date(), limit: number = 500): CartSplit {
  return splitCart(listCheckedGroceryItems(db, limit), cartCutoff(now));
}

/**
 * Empty ONE of the two cart sections. `scope: 'cart'` deletes what was checked
 * since the cutoff, `'old'` deletes what was checked before it — never both, so
 * clearing the current cart can't take last week's history with it and vice
 * versa. Returns how many rows went.
 *
 * This replaced a single `clearCheckedItems` that took every checked row at
 * once. With two sections on screen that function had no honest button to sit
 * behind: a Clear under "In cart" that also emptied "Old carts" would be a
 * control whose scope contradicts the heading directly above it.
 *
 * The prefs memory is untouched either way: purchase history powers
 * autocomplete and staples, and emptying a cart is not forgetting that you buy
 * milk (the column-ownership rules at the top of this file).
 */
export function clearCartSection(
  db: Database,
  scope: 'cart' | 'old',
  now: Date = new Date()
): number {
  const cutoff = cartCutoff(now);
  const op = scope === 'cart' ? '>=' : '<';
  const row = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM grocery_items WHERE checked_at IS NOT NULL AND checked_at ${op} ?`,
    [cutoff]
  );
  db.run(`DELETE FROM grocery_items WHERE checked_at IS NOT NULL AND checked_at ${op} ?`, [cutoff]);
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

/** Open-item count — raw ROWS, not the lines the list screen draws. */
export function openGroceryCount(db: Database): number {
  const row = db.get<{ n: number }>(
    'SELECT count(*) AS n FROM grocery_items WHERE checked_at IS NULL'
  );
  return row?.n ?? 0;
}

/** Items already in the cart — a soft state, cleared by hand, never at midnight. */
export function checkedGroceryCount(db: Database): number {
  const row = db.get<{ n: number }>(
    'SELECT count(*) AS n FROM grocery_items WHERE checked_at IS NOT NULL'
  );
  return row?.n ?? 0;
}

/**
 * What the Eat tab's Grocery row counts: **lines you will actually see**, i.e.
 * `consolidatedOpenList().length`, not `openGroceryCount()`'s raw rows.
 *
 * The two disagree the moment a name repeats — `addRecipeToGroceryList` inserts
 * one row per ingredient line with no dedupe, so "milk" from two recipes is two
 * rows and one line. A hub that promises 12 and opens onto 8 is the ledger rule
 * broken across two screens (00-design-spec.md §5), and it is exactly what the
 * first cut of this row did.
 */
export function openGroceryLineCount(db: Database): number {
  return consolidatedOpenList(db).length;
}
