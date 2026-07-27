-- ============================================================================
-- ARC 0018 — nutrition sub-app: meal templates
--
-- A reusable named meal (MyFitnessPal's "saved meals" / MacroFactor's food
-- combos): "Protein oats", "Post-workout shake". Logging from a template
-- creates a real `meals` row + `meal_items` — the template is a stamp, not a
-- link, so editing a template never rewrites meals already logged from it, and
-- deleting a template never touches eating history.
--
-- `meal_template_items` mirrors `meal_items`' snapshot shape (food_id SET NULL
-- for provenance, name + portion + per-portion macros/micros captured at
-- template-build time) MINUS `confidence`: a template is a deliberate,
-- user-curated recipe, so logging from it is a manual assertion, not an AI
-- estimate — its items land with confidence NULL. Templates can be built from
-- scratch or captured retroactively from a logged meal (saveMealAsTemplate).
--
-- Conventions per CLAUDE.md §9 / 0008: app-generated v4 UUID text PKs declared
-- PRIMARY KEY NOT NULL; ISO-8601 created_at/updated_at + AFTER UPDATE trigger
-- (both tables are mutable — rename, re-portion); template_items -> templates
-- is ON DELETE CASCADE (an item has no meaning outside its template);
-- template_items -> foods is ON DELETE SET NULL (a template survives a food's
-- deletion via its name/macro snapshot). Portion columns carry the same CHECKs
-- as meal_items. FK actions rely on PRAGMA foreign_keys = ON (set per connection).
--
-- Numbered 0018 in the nutrition 0014+ block. The runner stamps
-- PRAGMA user_version = 18 after applying this file.
-- ============================================================================
CREATE TABLE meal_templates (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  name_norm text NOT NULL,
  notes text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX meal_templates_name_norm_idx ON meal_templates (name_norm);

CREATE TABLE meal_template_items (
  id text PRIMARY KEY NOT NULL,
  template_id text NOT NULL REFERENCES meal_templates (id) ON DELETE CASCADE,
  food_id text REFERENCES foods (id) ON DELETE SET NULL,
  name text NOT NULL,
  grams real CHECK (grams IS NULL OR grams > 0),
  serving_qty real CHECK (serving_qty IS NULL OR serving_qty > 0),
  kcal real CHECK (kcal IS NULL OR kcal >= 0),
  protein_g real CHECK (protein_g IS NULL OR protein_g >= 0),
  carbs_g real CHECK (carbs_g IS NULL OR carbs_g >= 0),
  fat_g real CHECK (fat_g IS NULL OR fat_g >= 0),
  fiber_g real CHECK (fiber_g IS NULL OR fiber_g >= 0),
  micros text CHECK (micros IS NULL OR json_valid(micros)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX meal_template_items_template_idx ON meal_template_items (template_id);
CREATE INDEX meal_template_items_food_idx ON meal_template_items (food_id);

CREATE TRIGGER meal_templates_set_updated_at AFTER UPDATE ON meal_templates FOR EACH ROW BEGIN
  UPDATE meal_templates SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER meal_template_items_set_updated_at AFTER UPDATE ON meal_template_items FOR EACH ROW BEGIN
  UPDATE meal_template_items SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
