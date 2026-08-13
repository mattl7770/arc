-- ============================================================================
-- ARC 0035 — the recipe book gets FOLDERS
--
-- Owner request, 2026-08-12: *"Make functionality for creating folders in the
-- recipe book."*
--
-- ── A FILING SYSTEM, NOT A TAG CLOUD ──
--
-- The shape was a real choice and it is the whole design, so it is written
-- down here rather than inferred from the DDL.
--
-- **One folder per recipe** — `recipes.folder_id`, a nullable FK — and NOT a
-- `recipe_folder_members` join table. A join table is what produces a tag
-- cloud: a recipe in "Dinners" and "High protein" and "Quick" is not filed
-- anywhere, it is described three times, and the question a filing system
-- exists to answer ("where does this live?") stops having an answer. The owner
-- asked for folders. A folder is a place, and a document is in one place.
--
-- The cost of that call is real and worth stating: a recipe that is genuinely
-- both a weeknight dinner and a high-protein meal has to pick. That is what
-- `tags` (already on `recipes`, 0031) is for, and the two coexist without
-- competing — tags describe, folders file.
--
-- **Flat, not nested.** Also deliberate. Nesting buys a path model, breadcrumbs
-- on every screen that names a folder, a cycle check on every move (a folder
-- may not be moved into its own descendant), and a rule for what happens to a
-- subtree when its parent is deleted — four mechanisms, each with its own way
-- to be wrong, to organise a personal cookbook that will hold tens of
-- documents and perhaps a dozen drawers. At that size a flat list is not a
-- compromise, it is the correct answer: every folder is one tap from the book
-- and the whole cabinet is legible in one screen.
--
-- If that ever stops being true, nesting is an additive migration — a nullable
-- `parent_id text REFERENCES recipe_folders (id) ON DELETE SET NULL` — and
-- nothing on the recipe side changes. Choosing flat now does not close the
-- door; choosing a join table now would have.
--
-- ── DELETING A FOLDER MUST NEVER DELETE THE RECIPES IN IT ──
--
-- `ON DELETE SET NULL`, per CLAUDE.md §9's standing preference and for the
-- 0031 reason: a folder is a label on a drawer, and burning the drawer is not
-- how you get rid of the label. Deleting a folder UNFILES its recipes — they
-- return to Unfiled, whole, with every ingredient, snapshot and cooked-meal
-- backlink intact. CASCADE here would let one tap on an organisational control
-- destroy the documents it organises, which is the single worst thing a filing
-- system can do.
--
-- ── UNFILED IS A REAL PLACE, NOT AN ERROR ──
--
-- `folder_id IS NULL` is the default for every recipe that exists today and
-- every recipe created from now on: import, the manual editor and the Coach's
-- `save_recipe` all land unfiled, because a recipe arrives before anyone has
-- decided where it goes. So the book's default view is EVERY recipe, and
-- "Unfiled" is a filter beside the folders rather than a quarantine — a recipe
-- in no folder is never harder to reach than one in a folder.
--
-- ── THE UNIQUE NAME, AND WHY THE 0034 TRAP DOES NOT APPLY HERE ──
--
-- `name_norm` is UNIQUE: two drawers labelled "Dinners" is a filing error, not
-- a preference, and the repository turns the constraint violation into a
-- sentence the user reads. This is safe where 0034's cross-column CHECK was
-- not — that one was an ALTER validated against existing rows, which passes on
-- an empty fixture and fails on a populated device. Here the UNIQUE index is
-- created on a table that is empty by construction (it is created in this same
-- file), and the only ALTER is a plain nullable ADD COLUMN carrying no CHECK
-- at all, which SQLite never validates against existing rows.
--
-- Conventions per CLAUDE.md §9: app-generated v4 UUID text PK declared
-- PRIMARY KEY NOT NULL; ISO-8601 created_at/updated_at + an AFTER UPDATE
-- trigger (a folder is renameable, so it is mutable); the FK relies on
-- PRAGMA foreign_keys = ON, set per connection. No CHECK vocabulary here —
-- a folder name is the user's own words, not an ARC-owned enum.
--
-- Numbered 0035: the next free number above 0034_recipe_photo_autoresolve,
-- the current max. The runner is forward-only and silently SKIPS any file at
-- or below a device's user_version, so a lower number would never run on the
-- owner's phone. The runner stamps PRAGMA user_version = 35 after this file.
-- ============================================================================

CREATE TABLE recipe_folders (
  id text PRIMARY KEY NOT NULL,
  -- The user's own words, in their own casing.
  name text NOT NULL,
  -- The uniqueness + lookup key (the foods.name_norm pattern): lowercased and
  -- whitespace-collapsed by the repository, never by SQL.
  name_norm text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One drawer per label. See the header for why this is safe as a new-table
-- index where 0034's coupling CHECK was not safe as an ALTER.
CREATE UNIQUE INDEX recipe_folders_name_norm_idx ON recipe_folders (name_norm);

-- Where a recipe is filed. NULL = Unfiled, which is a place, not a failure.
-- SET NULL is the load-bearing word: deleting a folder unfiles its recipes and
-- never destroys one.
ALTER TABLE recipes ADD COLUMN folder_id text REFERENCES recipe_folders (id) ON DELETE SET NULL;

CREATE INDEX recipes_folder_idx ON recipes (folder_id);

CREATE TRIGGER recipe_folders_set_updated_at AFTER UPDATE ON recipe_folders FOR EACH ROW BEGIN
  UPDATE recipe_folders SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
