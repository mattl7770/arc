/**
 * Types for the grocery list, mirroring db/migrations/0032_grocery.sql — see
 * docs/recipes-grocery.md §2b. Kept beside the feature (the nutrition-types
 * pattern): hand-authored, lockstep with the schema.
 */
import type { SqliteBool, Timestamp } from '@/lib/db/types';

/** Who put the item on the list. */
export type GroceryItemSource = 'user' | 'coach' | 'recipe';

/** A `grocery_items` row as SELECT returns it. checked_at NULL = open. */
export type GroceryItemRow = {
  id: string;
  name: string;
  name_norm: string;
  qty_text: string | null;
  category: string;
  source: GroceryItemSource;
  recipe_id: string | null;
  food_id: string | null;
  checked_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** What the app (or a Coach tool) supplies when adding items. `category` is
 * normally derived (static table + learned prefs); passing one overrides. */
export type NewGroceryItem = {
  name: string;
  qty_text?: string | null;
  category?: string | null;
  source?: GroceryItemSource;
  recipe_id?: string | null;
  food_id?: string | null;
};

/** A `grocery_name_prefs` row — the per-item-name memory (autocomplete,
 * staples, learned category). One row per distinct name_norm. */
export type GroceryNamePrefRow = {
  id: string;
  name_norm: string;
  display_name: string;
  category: string | null;
  is_staple: SqliteBool;
  last_qty_text: string | null;
  times_added: number;
  last_added_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** An open item as the list screen renders it, grouped under its category. */
export type GroceryListSection = {
  category: string;
  label: string;
  items: GroceryItemRow[];
};

/**
 * One line of the consolidated view: open items sharing a name_norm, merged
 * for display — same-unit sums only, differing quantities listed side by side,
 * source items preserved (consolidation is a view, never a destructive merge).
 */
export type ConsolidatedGroceryLine = {
  name: string;
  name_norm: string;
  category: string;
  /** "2 + 1 bag" style display of the member quantities (nulls skipped). */
  qtyDisplay: string | null;
  items: GroceryItemRow[];
};
