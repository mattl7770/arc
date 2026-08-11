-- ============================================================================
-- ARC 0030 — recipe book: recipes + recipe_ingredients (+ meals.recipe_id)
--
-- A recipe is HOW TO COOK ONE BATCH — title, servings (the batch yield),
-- instructions, and ingredient lines — distinct from a meal template ("what I
-- ate", 0018) and from protocols (which own the day's plan). Spec:
-- docs/recipes-grocery.md.
--
-- Ingredient lines are honest about three layers (§2a of the spec):
--   1. raw_text — the imported/typed line, source of truth, never destroyed.
--   2. qty/unit/name — a parsed best-effort overlay; nullable, editable.
--   3. food_id + grams + macro/micro SNAPSHOTS — an EXPLICIT resolution to the
--      catalog, set only by the user. Snapshots are per-BATCH, taken at
--      resolution time, so recipe nutrition survives catalog churn and food
--      deletion (food_id is ON DELETE SET NULL; the 0018 stamp discipline).
--
-- "Resolved" is a structural predicate: grams NOT NULL AND kcal NOT NULL. The
-- coupling CHECK below makes grams-without-energy-snapshot (and the reverse)
-- unrepresentable; the other macros stay individually nullable because a
-- resolving food may genuinely lack fiber/protein data — per-macro honesty is
-- a display rule, not a CHECK. `negligible` marks lines that count as zero on
-- purpose (water, "salt to taste"), which is what keeps the all-or-nothing
-- nutrition gate usable.
--
-- meals.recipe_id (ALTER below) is provenance only — "times cooked" is derived
-- from meals, never counted here. FK ADD COLUMN follows the 0013 precedent
-- (workouts.routine_id): legal because the added column defaults to NULL.
-- Meals logged from a recipe keep source='manual' (a cooked-and-confirmed meal
-- is a manual assertion, exactly like template logging).
--
-- Conventions per CLAUDE.md §9: app-generated v4 UUID text PKs declared
-- PRIMARY KEY NOT NULL; ISO-8601 created_at/updated_at + AFTER UPDATE trigger
-- (both tables are mutable — a recipe is a living document, unlike a logged
-- meal); enum-as-text + CHECK for ARC-owned vocabularies; json_valid CHECKs;
-- FK actions rely on PRAGMA foreign_keys = ON (set per connection).
--
-- Numbered 0030: next free above the current max (0029_purge_seed_mission —
-- re-measured against main at branch time; the runner skips lower numbers
-- silently and throws on duplicates). The runner stamps
-- PRAGMA user_version = 30 after applying this file.
-- ============================================================================
CREATE TABLE recipes (
  id text PRIMARY KEY NOT NULL,
  title text NOT NULL,
  title_norm text NOT NULL,
  source text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'import', 'ai')),
  source_url text,
  source_platform text CHECK (
    source_platform IS NULL OR source_platform IN ('instagram', 'tiktok', 'youtube', 'website')
  ),
  source_author text,
  -- og:image / oEmbed thumbnail URL. Stored at import; NOT rendered until the
  -- Phase 4 media decision sanctions the fetch (docs/recipes-grocery.md §5).
  source_image_url text,
  servings real NOT NULL CHECK (servings > 0),
  total_weight_g real CHECK (total_weight_g IS NULL OR total_weight_g > 0),
  prep_min integer CHECK (prep_min IS NULL OR prep_min >= 0),
  cook_min integer CHECK (cook_min IS NULL OR cook_min >= 0),
  -- Ordered instruction steps as a JSON array of strings.
  steps text NOT NULL DEFAULT '[]' CHECK (json_valid(steps)),
  tags text CHECK (tags IS NULL OR json_valid(tags)),
  notes text,
  is_favorite integer NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX recipes_title_norm_idx ON recipes (title_norm);

CREATE TABLE recipe_ingredients (
  id text PRIMARY KEY NOT NULL,
  recipe_id text NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  raw_text text NOT NULL,
  qty real CHECK (qty IS NULL OR qty > 0),
  unit text,
  name text,
  food_id text REFERENCES foods (id) ON DELETE SET NULL,
  grams real CHECK (grams IS NULL OR grams > 0),
  kcal real CHECK (kcal IS NULL OR kcal >= 0),
  protein_g real CHECK (protein_g IS NULL OR protein_g >= 0),
  carbs_g real CHECK (carbs_g IS NULL OR carbs_g >= 0),
  fat_g real CHECK (fat_g IS NULL OR fat_g >= 0),
  fiber_g real CHECK (fiber_g IS NULL OR fiber_g >= 0),
  micros text CHECK (micros IS NULL OR json_valid(micros)),
  negligible integer NOT NULL DEFAULT 0 CHECK (negligible IN (0, 1)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- The resolved predicate, structurally: a line has per-batch grams iff it
  -- has a per-batch kcal snapshot (0014's pair-or-none spirit).
  CHECK ((grams IS NULL) = (kcal IS NULL))
);

CREATE INDEX recipe_ingredients_recipe_idx ON recipe_ingredients (recipe_id);
CREATE INDEX recipe_ingredients_food_idx ON recipe_ingredients (food_id);

-- Provenance from a cooked meal back to its recipe (derived "times cooked").
ALTER TABLE meals ADD COLUMN recipe_id text REFERENCES recipes (id) ON DELETE SET NULL;
CREATE INDEX meals_recipe_idx ON meals (recipe_id);

CREATE TRIGGER recipes_set_updated_at AFTER UPDATE ON recipes FOR EACH ROW BEGIN
  UPDATE recipes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER recipe_ingredients_set_updated_at AFTER UPDATE ON recipe_ingredients FOR EACH ROW BEGIN
  UPDATE recipe_ingredients SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
