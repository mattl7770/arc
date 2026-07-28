-- ============================================================================
-- ARC 0014 — nutrition sub-app: the foods catalog + meal_items
--
-- The Nutrition screen grows from single-row meal entry into a real food
-- logger (docs/nutrition-subapp.md). Two tables:
--
--   * `foods` — the on-device catalog: seeded staples (0016), user customs,
--     AI-synthesized entries, and barcode hits cached from Open Food Facts.
--     Macros are stored CANONICAL per-100 g (the FDC / Open Food Facts
--     convention); an optional named household serving (`serving_name` +
--     `serving_grams`) makes "2 eggs" a portion, not a calculation.
--   * `meal_items` — a food+portion inside a `meals` row. Items SNAPSHOT their
--     name and macros at log time, so editing or deleting a catalog food never
--     rewrites eating history. When a meal has items, the repository maintains
--     the meal's own kcal/macro columns as the item sums (in the same
--     transaction as every item change), which is what keeps the existing
--     todayTotals / dailyIntakeSeries reads correct without touching them.
--
-- Numbered 0014: the nutrition block sits above the Coach's ai_chat/reminders
-- (0008/0009) and Exercise's reserved 0011–0013 — renumbered from the original
-- 0008 at merge, since the Coach took 0008/0009. The runner tolerates the gap;
-- versions must only increase.
--
-- Conventions per CLAUDE.md §9 / 0001_init.sql:
--   * app-generated v4 UUID ids, declared PRIMARY KEY NOT NULL (load-bearing:
--     SQLite's PRIMARY KEY alone would accept NULL text ids);
--   * enum vocabulary -> text + CHECK. `foods.source` is its own ARC-owned
--     vocabulary ('seed'/'user'/'ai'/'openfoodfacts') — catalog provenance is a
--     different axis than the shared data_source of *logged* rows;
--   * JSON (`micros`) is text guarded by json_valid — per-100 g longevity
--     shortlist keys (sodium_mg, potassium_mg, magnesium_mg, …), only values
--     the source actually knows;
--   * per-100 g macro columns are bounded 0–100 by definition (grams per
--     100 g); kcal_100g <= 950 (pure fat is ~884, the densest food there is);
--   * meal_items -> meals is ON DELETE CASCADE (an item has no meaning outside
--     its meal, like workout_sets); meal_items -> foods is ON DELETE SET NULL
--     (history survives catalog churn, per the delete-semantics ADR);
--   * created_at/updated_at + AFTER UPDATE trigger per table (both tables are
--     mutable: favorite toggles, portion edits). recursive_triggers stays OFF;
--   * the FK actions rely on PRAGMA foreign_keys = ON, set on every connection.
-- The migration runner stamps PRAGMA user_version = 14 after applying this file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- foods — one catalog entry. `name_norm` is the lowercased search key, written
-- by the repository (SQLite's lower() is ASCII-only, so normalization lives in
-- JS). `barcode` is digits-only EAN/UPC, unique where present so a re-scan
-- upserts instead of duplicating. A named serving is pair-or-none: a name
-- without grams is unusable, grams without a name is meaningless.
-- ----------------------------------------------------------------------------
CREATE TABLE foods (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  name_norm text NOT NULL,
  brand text,
  barcode text CHECK (barcode IS NULL OR (length(barcode) >= 6 AND barcode NOT GLOB '*[^0-9]*')),
  serving_name text,
  serving_grams real CHECK (serving_grams IS NULL OR serving_grams > 0),
  kcal_100g real CHECK (kcal_100g IS NULL OR (kcal_100g >= 0 AND kcal_100g <= 950)),
  protein_g_100g real CHECK (protein_g_100g IS NULL OR (protein_g_100g >= 0 AND protein_g_100g <= 100)),
  carbs_g_100g real CHECK (carbs_g_100g IS NULL OR (carbs_g_100g >= 0 AND carbs_g_100g <= 100)),
  fat_g_100g real CHECK (fat_g_100g IS NULL OR (fat_g_100g >= 0 AND fat_g_100g <= 100)),
  fiber_g_100g real CHECK (fiber_g_100g IS NULL OR (fiber_g_100g >= 0 AND fiber_g_100g <= 100)),
  micros text CHECK (micros IS NULL OR json_valid(micros)),
  source text NOT NULL DEFAULT 'user' CHECK (source IN ('seed', 'user', 'ai', 'openfoodfacts')),
  is_favorite integer NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((serving_name IS NULL) = (serving_grams IS NULL))
);

CREATE INDEX foods_name_norm_idx ON foods (name_norm);
CREATE UNIQUE INDEX foods_barcode_idx ON foods (barcode) WHERE barcode IS NOT NULL;

-- ----------------------------------------------------------------------------
-- meal_items — one food+portion in a meal. `name` and the macro columns are a
-- snapshot at log time (the catalog can drift; the record of what was eaten
-- cannot). `grams`/`serving_qty` are both nullable: an AI estimate may know
-- only "≈300 kcal of lasagna", a serving-based add may know only "2 servings".
-- `confidence` is stamped on AI-estimated items ('high'/'medium'/'low') so the
-- review UI and the Coach can weigh them; manual items leave it NULL.
-- ----------------------------------------------------------------------------
CREATE TABLE meal_items (
  id text PRIMARY KEY NOT NULL,
  meal_id text NOT NULL REFERENCES meals (id) ON DELETE CASCADE,
  food_id text REFERENCES foods (id) ON DELETE SET NULL,
  name text NOT NULL,
  grams real CHECK (grams IS NULL OR grams > 0),
  serving_qty real CHECK (serving_qty IS NULL OR serving_qty > 0),
  kcal real CHECK (kcal IS NULL OR kcal >= 0),
  protein_g real CHECK (protein_g IS NULL OR protein_g >= 0),
  carbs_g real CHECK (carbs_g IS NULL OR carbs_g >= 0),
  fat_g real CHECK (fat_g IS NULL OR fat_g >= 0),
  fiber_g real CHECK (fiber_g IS NULL OR fiber_g >= 0),
  confidence text CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX meal_items_meal_idx ON meal_items (meal_id);
CREATE INDEX meal_items_food_idx ON meal_items (food_id);

-- ----------------------------------------------------------------------------
-- updated_at triggers (see 0001_init.sql for why there is no WHEN self-guard).
-- ----------------------------------------------------------------------------
CREATE TRIGGER foods_set_updated_at AFTER UPDATE ON foods FOR EACH ROW BEGIN
  UPDATE foods SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER meal_items_set_updated_at AFTER UPDATE ON meal_items FOR EACH ROW BEGIN
  UPDATE meal_items SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
