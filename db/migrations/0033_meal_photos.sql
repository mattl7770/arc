-- ============================================================================
-- ARC 0033 — meal photos: the picture the estimate was made from, kept briefly
--
-- Owner request, 2026-08-12: *"when capturing a meal with a photo, that photo
-- should be attached to the meal to see. We can clear these after a few days to
-- save space."* Until now app/meal-estimate.tsx downscaled the shot, sent it to
-- the model, and dropped it on the floor — the one artefact that could settle
-- "is that estimate right?" was destroyed the moment it stopped being a model
-- payload.
--
-- WHAT LIVES WHERE. The IMAGE lives on disk, under the app's Documents
-- directory (src/lib/media/meal-photo-store.ts); this table stores a NAME and
-- nothing else. A photo is the user's own data (CLAUDE.md §2, local-first) and
-- base64 in SQLite would put megabytes into every read of the row, every
-- backup, and every export serializer that walks the table.
--
-- A NAME, NOT A PATH — and this is the load-bearing decision. iOS re-issues the
-- app container's UUID on every install and every update, so an absolute
-- `file:///var/mobile/Containers/Data/Application/<UUID>/Documents/…` written
-- today is a dangling pointer after the next TestFlight build. The directory is
-- resolved at read time from `Paths.document`; the database only ever holds
-- "<uuid>.jpg". The CHECK enforces that literally: it must end in .jpg and must
-- not contain a separator, so no caller can quietly start storing a path again.
-- (`lab_reports.file_path` stores a URI and documents its own fragility — this
-- is the version that does not have that problem.)
--
-- A TABLE, NOT A COLUMN ON `meals`. Two reasons, one of them a direct
-- interaction with the other half of this round's work:
--
--   1. Retention is keyed on the PHOTO's own created_at, never on `meals.date`.
--      The same device pass added editing of a meal's date and time, so a meal
--      can be re-dated to yesterday — or to last month — long after its photo
--      was taken. Hanging the sweep off the meal's date would mean correcting a
--      mis-timed meal silently expires (or resurrects) its photo. The photo
--      expires a fixed number of days after it was TAKEN, which is the only
--      reading of "clear these after a few days" that survives a re-date.
--   2. A meal may reasonably carry more than one image (the plate, then the
--      label on the packet). A column would force a second migration for that;
--      a child table is already the shape.
--
-- DELETE SEMANTICS. `ON DELETE CASCADE` from `meals`, which is the same call
-- `meal_items` makes (0014) and does not violate the never-destroy-log-history
-- rule: a photo is not history that outlives its meal, it is *part of* the
-- meal's record. The rule bites on REFERENCES to a log (foods, recipes,
-- protocols), which stay ON DELETE SET NULL. What CASCADE does not do is delete
-- the file, so deletion is routed through
-- src/lib/media/meal-photo-store.ts::deleteMealWithPhotos, and the retention
-- sweep reconciles both directions anyway — a file with no row is removed, and
-- a row whose file has gone is removed, so the two can never disagree for
-- longer than one app open.
--
-- Conventions per CLAUDE.md §9: app-generated v4 UUID text PK declared PRIMARY
-- KEY NOT NULL (src/lib/db/id.ts, SQLite randomblob — Hermes has no crypto);
-- ISO-8601 text created_at/updated_at with the AFTER UPDATE trigger
-- (recursive_triggers stays OFF); enum vocabulary as text + CHECK; FK actions
-- rely on PRAGMA foreign_keys = ON, set per connection.
--
-- Numbered 0033: the next free number above 0032_grocery, main's current max.
-- The runner is forward-only and silently SKIPS any file at or below a device's
-- user_version, so a lower number would never run on the owner's phone. The
-- runner stamps PRAGMA user_version = 33 after applying this file.
-- ============================================================================
CREATE TABLE meal_photos (
  id text PRIMARY KEY NOT NULL,
  meal_id text NOT NULL REFERENCES meals (id) ON DELETE CASCADE,
  -- The file's BASE NAME inside the photo directory, never a path. UNIQUE makes
  -- the file<->row correspondence a schema fact rather than a convention, so two
  -- rows can never claim one file and a sweep can never delete a file that is
  -- still spoken for.
  file_name text NOT NULL UNIQUE CHECK (
    file_name GLOB '*.jpg' AND file_name NOT GLOB '*/*' AND file_name NOT GLOB '*\*'
  ),
  -- Pixel dimensions of the stored JPEG, so the meal screen can draw the frame
  -- at the photo's true aspect instead of cropping it to a guessed square.
  -- Nullable: a source that cannot report them yields no number rather than a
  -- plausible one, and the reader falls back to a fixed frame.
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  -- Which of the two capture paths produced it. Provenance only — nothing reads
  -- it for behaviour — kept because every other logged row in this schema
  -- records where it came from (meals.source, foods.source, recipes.source).
  source text NOT NULL DEFAULT 'camera' CHECK (source IN ('camera', 'library')),
  -- When the photo was TAKEN. This column is the retention clock; see the note
  -- on re-dating above.
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX meal_photos_meal_idx ON meal_photos (meal_id);
-- The sweep's index: it selects by created_at < cutoff on every app open.
CREATE INDEX meal_photos_created_idx ON meal_photos (created_at);

CREATE TRIGGER meal_photos_set_updated_at AFTER UPDATE ON meal_photos FOR EACH ROW BEGIN
  UPDATE meal_photos SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
