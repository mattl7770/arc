-- ============================================================================
-- ARC 0035 — progress photos: the body-progress gallery and its AI readings
--
-- Spec: docs/progress-photos-subapp.md (§2 is this table; the six owner calls
-- were answered 2026-08-12 and are recorded in that file's "Decided" block).
--
-- THE THIRD CONSUMER OF THE 0033/0034 PHOTO SUBSTRATE, not a new invention.
-- The IMAGE lives on disk under the app's Documents directory
-- (src/lib/media/progress-photo-store.ts over photo-file-store.ts's
-- `nativeStoreIn('progress-photos')`); this table stores a bare NAME and
-- nothing else. Every reason 0033's header gives holds here verbatim — chiefly
-- that iOS re-issues the app container's UUID on every install, so an absolute
-- path written today dangles after the next build. The CHECKs below are 0033's,
-- character for character, so the three tables are grep-twins: must end .jpg,
-- must contain neither separator. GLOB, not LIKE — in GLOB the pattern is
-- literal (no backslash escape), which is what lets `'*\*'` mean "contains a
-- backslash" rather than "contains anything".
--
-- WHAT CHANGED FROM THE 2026-07-24 MEDIA POLICY. That policy said "PhotoKit
-- reference + thumbnail". Two facts killed it and the owner accepted the
-- amendment on 2026-08-12: (1) re-fetching an original by its PhotoKit id needs
-- expo-media-library, which is not installed and not in any planned build, so a
-- stored reference would be a reference nothing can follow; (2) even with it,
-- `localIdentifier`s are device-local and every one of them dangles at once
-- after a restore to a new phone — the stable id is PHCloudIdentifier and no
-- Expo module exposes it. So the always-stored artefact is a WORKING COPY
-- (longest edge 1600px, JPEG q0.7, ~180-350 KB), which serves the gallery cell,
-- the full-screen view, the dangling-reference fallback and the AI payload
-- source. ~0.5 GB/decade at three poses a week, against the ~3 GB/decade
-- food-photo budget the same ADR already accepted. iCloud Photos still owns the
-- original at full quality; ARC's copy is a working record, not a keepsake.
--
-- NO RETENTION SWEEP. This is the recipe-photo precedent (0034), stated at its
-- strongest: a meal photo is evidence for one day's estimate and expires after
-- seven days; a progress photo is the whole point of a decade-long record. The
-- meal store's sweep is keyed to its OWN directory constant and can never reach
-- this one — db/progress-photos.test.mjs asserts exactly that, because "a
-- different directory" is a fact worth a test rather than a comment.
--
-- `taken_on`, NOT `date`. meals.date and wearable_data.date set a precedent for
-- the short name, but here the name has to carry the semantics: the row's day is
-- the SHUTTER's day, never the import's, and an import may be years after the
-- shutter. Import-day-vs-shutter-day is this feature's central hazard, so the
-- column says which one it is. `taken_at` is the optional instant, nullable
-- because EXIF may not supply one and no data means no number. (This is the
-- inverse of body_metrics' UTC-instant-only design, whose local-day gymnastics
-- every consumer pays for — see src/lib/db/repositories/body.ts.)
--
-- POSE IS A CLOSED 4-VALUE CHECK, and the rebuild cost is accepted.
-- `side_left`/`side_right` was considered and rejected as over-taxonomy for v1
-- ('other' + notes covers it). Widening a CHECK later is a parent-table rebuild
-- with a child to shuttle (the labs 0024 rebuild is the worked example), but the
-- alternative — free text validated in the repository, the `metric_type`
-- philosophy — gives up the CHECK convention for a set that is genuinely closed.
--
-- NO body_metric_id FK. Weight context is correlated BY DATE at read time
-- (nearest weigh-in within ±3 days, distance always stated). A hard link goes
-- stale the moment a weigh-in is edited, adds delete-ordering complexity, and
-- buys no query power over a date join.
--
-- Conventions per CLAUDE.md §9: app-generated v4 UUID text PK declared PRIMARY
-- KEY NOT NULL (src/lib/db/id.ts, SQLite randomblob — Hermes has no crypto);
-- ISO-8601 text created_at/updated_at with the AFTER UPDATE trigger
-- (recursive_triggers stays OFF); enum vocabulary as text + CHECK; JSON as text
-- guarded by json_valid; FK actions rely on PRAGMA foreign_keys = ON, set per
-- connection.
--
-- Numbered 0035: the next free number above 0034_recipe_photo_autoresolve,
-- main's max when this branched. The runner is forward-only and silently SKIPS
-- any file at or below a device's user_version, so a lower number (or a fill of
-- a dead gap — 0005/6/10/19/22/23) would never run on the owner's phone. The
-- runner stamps PRAGMA user_version = 35 after applying this file.
-- ============================================================================
CREATE TABLE progress_photos (
  id text PRIMARY KEY NOT NULL,
  -- The LOCAL day the photo was taken (EXIF/asset date, user-editable at
  -- import). Never silently stamped with today — the import flow leaves the
  -- field empty and makes the user fill it when EXIF gives nothing.
  taken_on text NOT NULL CHECK (taken_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- The instant, when EXIF supplied one. Nullable: no data, no number. The
  -- shape CHECK is deliberately loose past the date — it exists to reject
  -- garbage, not to re-implement an ISO parser in SQL.
  taken_at text CHECK (
    taken_at IS NULL OR taken_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'
  ),
  pose text NOT NULL DEFAULT 'front' CHECK (pose IN ('front', 'side', 'back', 'other')),
  -- 'camera' is unreachable in v1 (library-pick only, owner call 2026-08-12) and
  -- is in the CHECK anyway, so the v2 guided-capture screen needs no rebuild.
  source text NOT NULL DEFAULT 'library' CHECK (source IN ('library', 'camera')),
  -- The picker's PhotoKit localIdentifier. DORMANT PROVENANCE: nothing in v1
  -- reads it for behaviour (no installed module can re-fetch by it), it powers
  -- duplicate detection through the partial unique below, and it is the hook a
  -- future MediaLibrary / PHCloudIdentifier upgrade would re-link through.
  asset_id text,
  -- The working copy's BASE NAME inside the progress-photos directory, never a
  -- path. UNIQUE makes the file<->row correspondence a schema fact rather than a
  -- convention, so two rows can never claim one file and the sweep can never
  -- delete a file that is still spoken for.
  working_file_name text NOT NULL UNIQUE CHECK (
    working_file_name GLOB '*.jpg'
    AND working_file_name NOT GLOB '*/*'
    AND working_file_name NOT GLOB '*\*'
  ),
  -- The full-resolution in-app copy, written only when is_important was set AT
  -- PICK TIME. Deliberately NOT coupled to is_important by a CHECK: v1 cannot
  -- retro-fetch an original, so flipping the flag later legitimately leaves this
  -- NULL, and the detail screen says so in words.
  original_file_name text UNIQUE CHECK (
    original_file_name IS NULL
    OR (
      original_file_name GLOB '*.jpg'
      AND original_file_name NOT GLOB '*/*'
      AND original_file_name NOT GLOB '*\*'
    )
  ),
  is_important integer NOT NULL DEFAULT 0 CHECK (is_important IN (0, 1)),
  notes text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The gallery's own order: every read is newest-first by shutter day.
CREATE INDEX progress_photos_taken_idx ON progress_photos (taken_on DESC);
-- The compare screen's query: same pose, newest first.
CREATE INDEX progress_photos_pose_taken_idx ON progress_photos (pose, taken_on DESC);
-- Dedupe. PARTIAL so the many rows that arrive without an assetId (a picker that
-- does not expose one; a re-picked asset) are not forced into a single NULL.
CREATE UNIQUE INDEX progress_photos_asset_key ON progress_photos (asset_id)
  WHERE asset_id IS NOT NULL;

CREATE TRIGGER progress_photos_set_updated_at AFTER UPDATE ON progress_photos FOR EACH ROW BEGIN
  UPDATE progress_photos SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- progress_photo_analyses — saved AI readings.
--
-- A TABLE, NOT A COLUMN, for two reasons that a column cannot serve: a PAIR
-- reading references two photos, and one photo may be read many times (a year
-- apart, by different models).
--
-- Readings persist ON SAVE only. Unlike a meal estimate — which lands in `meals`
-- either way — a reading has no other landing table, and discarding one means
-- paying tokens to re-read it. The review gate stays regardless: nothing
-- auto-commits (docs/progress-photos-subapp.md §5).
--
-- WHY `caveats` IS NOT NULL, which is this table's one departure from the spec
-- sketch. Lighting, pose and angle differences are THE failure mode of photo
-- comparison; the prompt makes caveats mandatory and refuses a reading without
-- them. A mandatory field buried inside a JSON blob is a mandatory field that
-- quietly goes missing, so the schema enforces what the prompt demands. For the
-- same reason `observations` and `changes` are separate JSON arrays rather than
-- one bag: each column holds exactly one thing.
--
-- NO numeric body-composition estimates are stored because none are produced —
-- owner call, 2026-08-12: visual body-fat estimation is ±5 points on a good day,
-- and a plausible wrong number filed next to a trend surface is the exact hazard
-- the labs mapper exists to prevent. The asymmetry with meal-estimate's
-- ≈-labelled numbers is deliberate and confirmed.
-- ----------------------------------------------------------------------------
CREATE TABLE progress_photo_analyses (
  id text PRIMARY KEY NOT NULL,
  photo_id text NOT NULL REFERENCES progress_photos (id) ON DELETE CASCADE,
  -- NULL for a single-photo reading; set for an A/B comparison, where photo_id
  -- is the EARLIER photo and this the later — the prompt states that order, and
  -- the screens render it that way. CASCADE on both paths: a reading of a photo
  -- that no longer exists is not history worth keeping, it is a caption with no
  -- picture. A photo compared with itself is a bug, not a use case.
  compare_photo_id text REFERENCES progress_photos (id) ON DELETE CASCADE CHECK (
    compare_photo_id IS NULL OR compare_photo_id <> photo_id
  ),
  -- Which model said it. Provenance is not optional on a reading: the same
  -- photos read by two models a year apart must be distinguishable on screen.
  model text NOT NULL,
  summary text NOT NULL,
  -- [{ "area": string, "note": string }]
  observations text CHECK (observations IS NULL OR json_valid(observations)),
  -- [{ "area": string, "direction": "leaner"|"fuller"|"unchanged"|"unclear",
  --    "note": string }] — pair readings only.
  changes text CHECK (changes IS NULL OR json_valid(changes)),
  caveats text NOT NULL,
  confidence text CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX progress_photo_analyses_photo_idx ON progress_photo_analyses (photo_id);
-- The second FK needs its own index or every delete of a photo that is the LATER
-- half of a comparison scans the table to find the rows to cascade. Cheap now,
-- invisible later.
CREATE INDEX progress_photo_analyses_compare_idx ON progress_photo_analyses (compare_photo_id);

CREATE TRIGGER progress_photo_analyses_set_updated_at
AFTER UPDATE ON progress_photo_analyses FOR EACH ROW BEGIN
  UPDATE progress_photo_analyses SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.id;
END;
