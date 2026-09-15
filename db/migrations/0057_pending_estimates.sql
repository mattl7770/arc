-- ============================================================================
-- ARC 0057 — pending_estimates: an AI estimate taken offline is queued, not lost
--
-- Owner, backlog C3: *"Offline food logging — catalog/manual path fully works
-- with no network; AI-dependent estimates queue until back online."*
--
-- The catalog, template and manual paths were already offline by construction
-- (no `fetch` anywhere on them — db/nutrition-v2.test.mjs §23 pins that as a
-- source fact rather than a belief). The gap is the one path that genuinely
-- needs the network: photograph / describe / revise. Until now that path
-- printed "Couldn't estimate that meal. Check your connection" and threw the
-- meal away — including, on the photo path, a downscaled JPEG of a plate that
-- no longer exists. ARC data has exactly ONE copy; a meal lost on a plane is a
-- meal that never happened.
--
-- ── WHAT IS QUEUED, AND WHY IT IS A ROW RATHER THAN A KV ──
--
-- `workout_drafts` (0045) and `health_sync_state` (0021) are this app's two KV
-- tables, and both were considered first. Both are SINGLE-SLOT by construction
-- — one live workout, one sync cursor — and a queue is not: a weekend away is
-- three meals waiting, each pointing at its own meal row and (on the photo
-- path) its own file on disk. A KV would have to hold an array and rewrite the
-- whole array to delete one entry, which is precisely the read-modify-write a
-- table exists to avoid. `users.preferences` is worse still: this is machine
-- state, not a user choice (0045's own argument, and it applies unchanged).
--
-- ── THE IMAGE IS A FILE, AND NOT IN THE `meal-photos` DIRECTORY ──
--
-- 0033's rule holds: the bytes live on disk, the database stores a BASE NAME
-- and never a path, because iOS re-issues the app container's UUID on every
-- install. The CHECK enforces it literally, in the same three clauses.
--
-- What is new is the DIRECTORY, and it is load-bearing: a queued photo lives in
-- `pending-estimates/`, NOT in `meal-photos/`. The meal-photo sweep
-- (src/lib/media/meal-photo-store.ts) reconciles that directory against
-- `meal_photos` rows in BOTH directions and deletes any file with no row — so a
-- queued photo parked there would be deleted as an orphan on the very next app
-- open, which is the one moment the queue most needs it. Two directories, two
-- lifecycles, no shared sweep.
--
-- On a successful drain the bytes are copied into `meal-photos/` through the
-- ordinary `attachMealPhoto` (one writer, 0033's invariant intact) and the
-- pending file is removed, so a queued photo ends up exactly where an
-- interactive one does and inherits the same retention window.
--
-- ── ONE ROW PER MEAL (`meal_id` IS UNIQUE), AND WHAT IT BUYS ──
--
-- A meal has at most one estimate in flight. UNIQUE makes that a schema fact,
-- so the drainer cannot double-apply and a re-queue is an UPSERT rather than a
-- second row racing the first. `ON DELETE CASCADE` is then the whole of "the
-- user gave up on it": deleting the placeholder meal deletes the queue entry,
-- and the file is reclaimed by the pending directory's own orphan pass.
--
-- CASCADE does not violate the never-destroy-log-history rule (CLAUDE.md §9).
-- That rule bites on REFERENCES to a log — foods, recipes, protocols — which
-- stay ON DELETE SET NULL. A queued request is not history; it is an unsent
-- intention that belongs to exactly one meal, the same relation `meal_items`
-- and `meal_photos` already have.
--
-- ── `kind`, AND WHY `revise` IS IN THE VOCABULARY ──
--
--   'photo'  — a downscaled JPEG (+ an optional typed description as context)
--   'text'   — describe-in-words; `description` is the whole request
--   'revise' — a plain-English correction to a meal that ALREADY has items
--
-- The first two create a PLACEHOLDER meal the user can see immediately, with
-- NULL macros — never a 0, which would be a fabricated measurement and would
-- also sum into the day's totals as a fact. NULL is what the Eat tab already
-- draws honestly, and what already (correctly) drops the day out of countdown
-- mode: energy that is genuinely unknown cannot be subtracted from a target.
--
-- 'revise' points at a meal that already exists and needs no placeholder. Its
-- `description` is the correction; the drainer re-reads the meal's items AT
-- DRAIN TIME rather than snapshotting them here, so a hand-edit made while
-- offline is the "before" the correction applies to instead of something the
-- correction silently overwrites.
--
-- ARC-owned vocabulary, so text + CHECK (CLAUDE.md §9).
--
-- ── `attempts` / `last_error`: A QUEUE ENTRY IS NEVER SILENTLY DROPPED ──
--
-- A drain that fails again bumps `attempts` and records why. Nothing here
-- expires a row: an entry that fails for a reason waiting cannot fix (no API
-- key yet, a refusal) is still retried on the next foreground, because "no key
-- yet" is fixable in Settings and the alternative is deleting the user's meal
-- on his behalf. The escape hatch is the one he already has — delete the
-- placeholder meal, and CASCADE takes the entry with it.
--
-- ── NUMBERED 0057, AND IT WAS 0048 UNTIL THE MOMENT OF COMMIT ──
--
-- This file was written as `0048_pending_estimates.sql`: at branch time `main`
-- held up to 0047, so 0048 was the next free number and the backlog had even
-- reserved it. By the time the work was committed `main` had taken 0046, 0050,
-- 0053 and 0054, and `claude/c12-c13-exercise` held 0055 and 0056 in flight.
--
-- **0048 is STILL unused on main, and shipping it anyway would have stranded it
-- forever.** The runner is forward-only and SILENTLY SKIPS any file at or below
-- a device's `PRAGMA user_version`: a phone that has applied 0054 never looks at
-- 0048 again, so this table would simply not exist and every read of it would
-- throw on a screen with nothing above to catch it. Nothing fails at build time,
-- in CI, or in any test that starts from an empty database — which is exactly
-- why the backlog has recorded seven of these in a week.
--
-- So the rule is not "take the next free number". It is **take the next number
-- ABOVE main's head, re-checked at the moment of commit, and above anything an
-- unmerged branch already holds.** 0057 is that number. The runner stamps
-- PRAGMA user_version = 57.
--
-- Conventions per CLAUDE.md §9 / 0001_init.sql: app-generated UUID text ids
-- (PRIMARY KEY NOT NULL, no default — src/lib/db/id.ts, SQLite randomblob,
-- because Hermes has no `crypto`), ISO-8601 UTC text timestamps, enum
-- vocabulary as text + CHECK, created_at/updated_at with an AFTER UPDATE
-- trigger (recursive_triggers stays OFF). Run `npm run db:bundle` after this
-- file changes.
-- ============================================================================

CREATE TABLE pending_estimates (
  id text PRIMARY KEY NOT NULL,
  -- The meal this request will fill in: a placeholder for 'photo'/'text', the
  -- existing meal for 'revise'. UNIQUE — one estimate in flight per meal.
  meal_id text NOT NULL UNIQUE REFERENCES meals (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('photo', 'text', 'revise')),
  -- The words half of the request: the description for 'text', the correction
  -- for 'revise', optional extra context for 'photo'. NULL only on a bare
  -- photo — see the note on the absent cross-column CHECK at the foot.
  description text,
  -- The BASE NAME of the queued JPEG inside the pending-estimates directory —
  -- never a path (0033's rule, and its three clauses verbatim). NULL for the
  -- two text-only kinds.
  file_name text UNIQUE CHECK (
    file_name IS NULL OR (
      file_name GLOB '*.jpg' AND file_name NOT GLOB '*/*' AND file_name NOT GLOB '*\*'
    )
  ),
  -- The queued image's true pixel dimensions, carried so the photo lands on the
  -- meal at its own aspect when the drain succeeds (0033 meal_photos.width /
  -- height). Nullable for the same reason they are there: a source that cannot
  -- report them yields no number rather than a plausible one.
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Why the last drain failed, for the next one's diagnosis. Never shown to the
  -- user as the model's words: the screen states the fact ("waiting for a
  -- connection"), not an exception message.
  last_error text,
  -- When the request was MADE. The queue drains oldest-first, so a meal logged
  -- on the plane lands before the one logged in the taxi.
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The drainer's index: oldest-first over a table that is empty almost always.
CREATE INDEX pending_estimates_created_idx ON pending_estimates (created_at);

CREATE TRIGGER pending_estimates_set_updated_at
AFTER UPDATE ON pending_estimates FOR EACH ROW BEGIN
  UPDATE pending_estimates
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.id;
END;

-- NOTE on the constraint that is deliberately ABSENT. The obvious one is
-- `CHECK ((kind = 'photo') = (file_name IS NOT NULL))`. It is a CROSS-column
-- CHECK, and 0034 records what SQLite does with those on an ALTER — but the
-- rule it would encode is wrong here anyway, which is the better reason. A
-- photo whose FILE failed to write must still be queueable as its typed
-- description rather than refused outright, and a 'photo' row whose file is
-- later lost must degrade to that rather than becoming unupdatable. The pairing
-- is maintained by the repository, which is the only writer, and asserted in
-- db/nutrition-v2.test.mjs §23.
