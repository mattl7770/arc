-- ============================================================================
-- ARC 0054 — pairing an ingested (HealthKit) session with the one ARC logged
--
-- Owner, backlog D3: *"auto-pair an ingested session with a manually logged one
-- by time, pulling calories and other data into the manual session."* The spike
-- is docs/spikes/ingested-workouts.md; this is its first slice.
--
-- Today nothing joins `wearable_data` (metric_type = 'workout', one row per
-- HealthKit workout object) to `workouts` (what the owner logged). That absence
-- is not merely a missing feature — it is a live DEFECT. The Coach reads
-- ingested minutes through the `workout` metric AND reads `workouts` through
-- get_training_summary, so **a session logged in ARC and also recorded by the
-- watch is counted twice**, in two tools, with nothing able to tell. A link is
-- what finally makes that reconcilable.
--
-- ── WHY A LINK TABLE AND NOT A COLUMN ON EITHER SIDE ──
--
-- A `wearable_data.workout_id` would put an ARC-side foreign key on the MIRROR:
-- `wearable_data` is re-aggregated from HealthKit on a trailing window and
-- corrects itself in place (docs/wearables-subapp.md §4), so every re-sync would
-- have to remember to preserve a column that has nothing to do with HealthKit.
-- A `workouts.wearable_id` is better but still one-sided: it can express "this
-- session came from the watch" and cannot express the uniqueness of the other
-- direction, so two manual sessions could both claim one watch record and only
-- code would notice.
--
-- The link table states both directions at once, and **its two unique indexes
-- ARE the one-to-one guarantee** — not the pairing code, because code is where a
-- one-to-one guarantee goes to die. One ingested session links to at most one
-- manual session, and one manual session to at most one ingested session,
-- because the database refuses anything else.
--
-- ── WHAT IS DELIBERATELY *NOT* HERE: the pulled numbers ──
--
-- kcal, distance, duration and activity are NOT copied onto `workouts`. They are
-- JOINED through this link at read time. `wearable_data` is a mirror that
-- re-syncs and corrects a figure; a copy taken today goes stale the moment the
-- source revises it and nothing would ever repair it — and a copy is a second
-- source of truth for a number the app already holds. The link CASCADEs from
-- both sides, so the join is always either live or absent, never wrong.
--
-- ── NO `dismissed_at` ──
--
-- The spike proposed a tombstone row for "not training", so a dismissed session
-- would not come back on the next 14-day re-sync. Nothing in this slice writes
-- one: the blank inbox is bounded by a 14-day horizon instead, and an unfilled
-- session simply ages out. A column with no writer is schema that lies about
-- what the app does, so it waits for the feature that needs it.
--
-- ── IMMUTABLE, SO NO `updated_at` ──
--
-- A link is created or destroyed; it is never edited (a hand-made link replaces
-- an automatic one by DELETE + INSERT). That puts it with `protocol_versions` in
-- CLAUDE.md §9's stated exception: `created_at` only, and no AFTER UPDATE
-- trigger to stamp a column nothing writes.
--
-- ── NUMBERED 0054, NOT THE RESERVED 0052 ──
--
-- docs/backlog-2026-09.md reserved `0052` for this work when main's head was
-- 0047. **D4 landed 0053 while this branch was being written**, and 0052 is
-- still absent from main — which is precisely the trap, not an escape from it.
-- The runner applies only `version > user_version` (src/lib/db/migrate.ts), so a
-- device that has already stamped 53 would SILENTLY SKIP a 0052 forever: no
-- error, no retry, just a `workouts.started_at` that never exists and a pairing
-- pass that throws on a missing table. A reservation does not hold a number; the
-- head does.
--
-- So this takes the next number ABOVE main's head. 0048–0051 are held by C-wave
-- branches that face the same problem and will have to resolve it the same way.
-- Re-check `git ls-tree main -- db/migrations/` at merge and renumber UP again
-- if 0054 has been taken since. Conventions per CLAUDE.md §9 / 0001_init.sql.
-- Run `npm run db:bundle` after this file changes.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- workouts.started_at — the instant the session began.
--
-- Pairing is span overlap, and until now a `workouts` row had no span to overlap
-- with. It has `date` (a LOGICAL day), `created_at` (when the row was written)
-- and `duration_min`. For a live session those imply a span, because the logger
-- writes at Finish; for a BACKDATED one — a past session typed in, a photo
-- import — `created_at` is a different day entirely and the implied span is
-- meaningless. That is the same fact `attributedInstant` already encodes
-- (src/lib/db/repositories/training-stats.ts).
--
-- So the column is NULLABLE and null means exactly "no span": the live logger
-- writes the instant it really started, every other writer leaves it alone, and
-- a session with no span never auto-pairs. That is the honest reading rather
-- than a heuristic — a wrong auto-pair pulls a run's 600 kcal into a lifting
-- session and no screen would show that as wrong.
--
-- The GLOB checks the SHAPE only (ISO-8601 date then a 'T'), matching how every
-- other instant column in the schema is guarded. In GLOB `_` is literal, so the
-- character classes are `[0-9]`, never LIKE's `_`.
-- ----------------------------------------------------------------------------
ALTER TABLE workouts ADD COLUMN started_at text CHECK (
  started_at IS NULL OR started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'
);

-- ----------------------------------------------------------------------------
-- Backfill — `created_at − duration_min`, and ONLY where that is defensible.
--
-- Three guards, and each one is the difference between a span and a guess:
--
--   1. `duration_min` present and positive — no duration, no span.
--   2. `duration_min <= 360` — the live logger's own MAX_SESSION_MIN. A stored
--      duration above six hours is already known-suspect (the logger discards
--      one), and subtracting it would invent a start in the middle of the night.
--   3. `substr(created_at, 1, 10) = date` — the row was written on the day it
--      is about, i.e. it is not backdated. `created_at` is a UTC instant and
--      `date` is a LOCAL logical day, so this comparison is deliberately
--      STRICTER than the JS one (`logicalDate`): near midnight, and for any
--      offset far from UTC, a same-day session can fail it and stay NULL. That
--      is the safe direction — a missed pair costs nothing, a wrong span costs
--      a wrong pair — and the next live session writes its own start anyway.
--
-- An append-only UPDATE inside a migration is legal: it runs exactly once under
-- the runner's user_version guard.
-- ----------------------------------------------------------------------------
UPDATE workouts
SET started_at = strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      created_at,
      '-' || CAST(duration_min AS integer) || ' minutes'
    )
WHERE duration_min IS NOT NULL
  AND duration_min > 0
  AND duration_min <= 360
  AND substr(created_at, 1, 10) = date;

-- ----------------------------------------------------------------------------
-- workout_ingest_links — one ingested session ↔ one manual session.
--
-- `linked_by` is the 0034 provenance rule again, third application: who made
-- this link. An automatic link is an inference from overlapping clocks; a hand
-- link is an assertion. They must not wear the same face, and `overlap` records
-- the number that justified an automatic one (NULL for a hand link, which needs
-- no justification beyond having been made).
--
-- **CASCADE on both sides, and each direction is a deliberate answer:**
--   · Deleting the manual session drops the link and leaves the ingested mirror
--     standing, free to re-pair or re-enter the blank inbox.
--   · Deleting the ingested row — which a re-sync may legitimately do — drops
--     the link and leaves the manual session whole. Nothing of the owner's is
--     ever carried by the link, precisely because nothing was copied.
-- ----------------------------------------------------------------------------
CREATE TABLE workout_ingest_links (
  id text PRIMARY KEY NOT NULL,
  workout_id text NOT NULL REFERENCES workouts (id) ON DELETE CASCADE,
  wearable_id text NOT NULL REFERENCES wearable_data (id) ON DELETE CASCADE,
  linked_by text NOT NULL DEFAULT 'auto' CHECK (linked_by IN ('auto', 'user')),
  overlap real CHECK (overlap IS NULL OR (overlap >= 0 AND overlap <= 1)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The one-to-one guarantee, stated twice because it has two directions. Both
-- columns are NOT NULL, so a plain UNIQUE is total here — SQLite's UNIQUE admits
-- unlimited NULLs, and there are none to admit.
CREATE UNIQUE INDEX workout_ingest_links_workout_key ON workout_ingest_links (workout_id);
CREATE UNIQUE INDEX workout_ingest_links_wearable_key ON workout_ingest_links (wearable_id);
