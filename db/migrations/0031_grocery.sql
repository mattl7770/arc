-- ============================================================================
-- ARC 0031 — grocery list: grocery_items + grocery_name_prefs
--
-- ONE standing list (single user, one household — a second list would be a
-- later migration; deliberately simpler than data-model.md's old grocery_lists
-- sketch). Spec: docs/recipes-grocery.md §2b.
--
-- grocery_items is the list INCLUDING its history: check-off stamps
-- checked_at (NULL = open) — a soft state, never a delete — so purchase
-- history keeps powering the Recent re-add chips. `category` is free text on
-- purpose (the wearable metric_type precedent): the static keyword table
-- (src/lib/grocery/categories.ts) + learned prefs own the vocabulary, so a new
-- category is not a migration. recipe_id / food_id are provenance backlinks
-- (ON DELETE SET NULL — a deleted recipe never destroys the list).
--
-- grocery_name_prefs is the on-device memory that makes the list fast: one row
-- per distinct item name (UNIQUE name_norm, upsert key). COLUMN OWNERSHIP IS
-- EXPLICIT so times_added can't double-count: the add-time upsert owns
-- times_added / last_added_at / last_qty_text / display_name; the user
-- re-filing an item owns category (which then beats the static table forever);
-- the user owns is_staple; CHECK-OFF WRITES NOTHING HERE (purchase recency is
-- read from grocery_items.checked_at directly).
--
-- Conventions per CLAUDE.md §9: app-generated v4 UUID text PKs declared
-- PRIMARY KEY NOT NULL; ISO-8601 created_at/updated_at + AFTER UPDATE trigger
-- (both tables mutable); enum-as-text + CHECK for ARC-owned vocabularies;
-- FK actions rely on PRAGMA foreign_keys = ON (set per connection).
--
-- Numbered 0031: next free above 0030_recipes (same branch). The runner stamps
-- PRAGMA user_version = 31 after applying this file.
-- ============================================================================
CREATE TABLE grocery_items (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  name_norm text NOT NULL,
  -- Free display text ("2", "1 bag", "500 g") — the surveyed apps' verdict:
  -- light parse for merging, never forced structure.
  qty_text text,
  category text NOT NULL DEFAULT 'other',
  source text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'coach', 'recipe')),
  recipe_id text REFERENCES recipes (id) ON DELETE SET NULL,
  food_id text REFERENCES foods (id) ON DELETE SET NULL,
  -- NULL = open; ISO timestamp = in cart. Soft state, not deletion.
  checked_at text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX grocery_items_name_norm_idx ON grocery_items (name_norm);
CREATE INDEX grocery_items_checked_idx ON grocery_items (checked_at);

CREATE TABLE grocery_name_prefs (
  id text PRIMARY KEY NOT NULL,
  name_norm text NOT NULL UNIQUE,
  display_name text NOT NULL,
  -- NULL = defer to the static keyword table; set = the user's re-filing.
  category text,
  is_staple integer NOT NULL DEFAULT 0 CHECK (is_staple IN (0, 1)),
  last_qty_text text,
  times_added integer NOT NULL DEFAULT 0 CHECK (times_added >= 0),
  last_added_at text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER grocery_items_set_updated_at AFTER UPDATE ON grocery_items FOR EACH ROW BEGIN
  UPDATE grocery_items SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER grocery_name_prefs_set_updated_at AFTER UPDATE ON grocery_name_prefs FOR EACH ROW BEGIN
  UPDATE grocery_name_prefs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
