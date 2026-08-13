-- ============================================================================
-- ARC 0034 — a recipe gets a picture, and its lines get PRICED WITHOUT ASKING
--
-- Two owner calls, 2026-08-12, both off the Ribeye Steak & Broccoli Butter
-- Stir-fry screen — five lines reading "Not counted yet", five buttons reading
-- LINK, and no nutrition:
--
--   *"I should be able to see estimated nutrition facts there, as well as have
--    the option to add a photo to the recipe."*
--   *"...removing this whole 'linking' behavior in exchange for it being done
--    automatically behind the scenes."*
--
-- ── WHAT CHANGES, AND WHAT THE OLD RULE ACTUALLY PROTECTED ──
--
-- 0031 made resolution EXPLICIT: a line carried macros only once the user had
-- picked a catalog food for it. That rule was never really about the tapping —
-- it was about **provenance**. The danger it guarded was a number of unknown
-- origin entering the rollup, the logged meal and the day's totals wearing the
-- same face as a number the user asserted.
--
-- So the tapping goes and the provenance stays, as a column. `resolved_by`
-- records WHO priced each line:
--
--   'user'     the user picked the food by hand (0031's original act, still
--              available as the correction path)
--   'catalog'  an EXACT catalog name match at a mass quantity read off the
--              line itself. Same data as 'user', reached without asking —
--              deterministic, offline, and never fuzzy (the labs rule holds:
--              exact name or leading phrase, or it is not a match at all)
--   'ai'       a model priced the line. A real estimate, and every surface
--              that draws it says so
--
--   NULL       unresolved — nothing has priced this line
--
-- The all-or-nothing honesty gate in `recipeNutrition` is unchanged; what
-- changes is that the gate now usually PASSES, because something priced every
-- line without the user doing the work. `estimatedCount` rides alongside it so
-- a screen can say "of these five, two are estimated" instead of implying all
-- five were measured.
--
-- ── THE COUPLING IS NOT A CHECK, AND THAT IS A FINDING, NOT A SHORTCUT ──
--
-- The obvious constraint is `CHECK ((resolved_by IS NULL) = (grams IS NULL))`,
-- mirroring 0031's grams⇔kcal coupling. **SQLite accepts that on an empty
-- table and REJECTS the whole ALTER on a populated one** — verified against
-- node:sqlite: ADD COLUMN validates a cross-column CHECK against existing rows,
-- and every already-resolved line on the owner's device has grams and a NULL
-- new column, so the migration would fail at `CHECK constraint failed` on the
-- one database that matters. It passes in a fresh test fixture, which is
-- exactly how that would have shipped.
--
-- So the CHECK covers the VOCABULARY only, the backfill below establishes the
-- invariant for existing rows, and the repository is what maintains it
-- (`resolveIngredient` / `resolveIngredientByModel` / `unresolveIngredient` all
-- write the pair together). Recorded here because the next person will reach
-- for the same CHECK and see it pass in a test.
--
-- ── THE BACKFILL IS THE HONEST READING OF HISTORY ──
--
-- Every line resolved before this migration was resolved the only way that
-- existed: the user opened a food search and picked. `'user'` is not a guess
-- about those rows, it is what happened. Unresolved lines stay NULL.
--
-- ── THE PHOTO: A NAME, NOT A PATH ──
--
-- Same decision as 0033, for the same reason: iOS re-issues the app container's
-- UUID on every install, so an absolute file:// URI written today dangles after
-- the next build. The column holds "<name>.jpg" and the directory is resolved
-- at read time (src/lib/media/recipe-photo-store.ts). The CHECK enforces it
-- literally — must end .jpg, must contain no separator — so no caller can
-- quietly start storing a path again.
--
-- UNLIKE a meal photo, a recipe photo has NO RETENTION SWEEP. A meal photo is
-- evidence for an estimate made that day and is cleared after a week; a recipe
-- is a living document the user will open for years, and a cookbook that
-- deletes its own pictures is broken. The file/row invariant still holds — the
-- store reconciles orphans and dangling names on every app open — only the
-- expiry pass is absent. One photo per recipe: a column, not a table, and
-- replacing it removes the old file in the same call (setRecipePhoto).
--
-- Conventions per CLAUDE.md §9: nullable ADD COLUMNs (the 0031 precedent —
-- meals.recipe_id), CHECKs for ARC-owned vocabularies. No new trigger: the
-- triggers from 0031 already cover every column on both tables.
--
-- Numbered 0034: the next free number above 0033_meal_photos, the current max.
-- The runner is forward-only and silently SKIPS any file at or below a device's
-- user_version, so a lower number would never run on the owner's phone. The
-- runner stamps PRAGMA user_version = 34 after applying this file.
-- ============================================================================

-- The picture. Base NAME only; see the note above.
ALTER TABLE recipes ADD COLUMN photo_file_name text CHECK (
  photo_file_name IS NULL
  OR (photo_file_name GLOB '*.jpg' AND photo_file_name NOT GLOB '*/*' AND photo_file_name NOT GLOB '*\*')
);

-- Who priced this line. NULL ⇔ unresolved; the repository maintains that pair
-- (it cannot be a CHECK here — see the note above).
ALTER TABLE recipe_ingredients ADD COLUMN resolved_by text CHECK (
  resolved_by IS NULL OR resolved_by IN ('user', 'catalog', 'ai')
);

-- Every pre-existing resolution was the user's own explicit pick, because that
-- was the only path that existed. Not a guess — a record of what happened.
UPDATE recipe_ingredients SET resolved_by = 'user' WHERE grams IS NOT NULL;
