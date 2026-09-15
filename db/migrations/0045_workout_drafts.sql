-- ============================================================================
-- ARC 0045 — workout_drafts: the live session survives the app being killed
--
-- Owner report, 2026-09-14: *"losing workout information when closing app mid
-- workout, necessary for fixing when app bugs."* The live logger
-- (app/workout-live.tsx) held the whole session in React state, so anything iOS
-- did to the process — a memory kill in the background, a crash, a bad build —
-- took the session with it. ARC data has exactly ONE copy (the phone), so a
-- lost session is not re-downloadable from anywhere; it simply never happened.
--
-- ── WHY A SEPARATE STORE AND NOT AN IN-PROGRESS FLAG ON `workouts` ──
--
-- The obvious alternative is to write the session as a real `workouts` row the
-- moment it starts and mark it `in_progress = 1`. It is the wrong shape here,
-- and the constraint that decides it is not tidiness, it is CONTAMINATION.
--
-- Everything the training engine knows it computes by querying `workout_sets`
-- at read time — muscle freshness (`recentMuscleLoads`), weekly volume
-- (`weeklyMuscleSets`), personal records and e1RM (`personalRecords`,
-- `workingSets`), the previous-session placeholders the logger itself shows
-- (`lastSessionSets`), the week totals on the hub, the Coach's training reads
-- (src/lib/ai/tools/read-tools.ts), the self-review report assembler, the
-- export. With a flag, EVERY ONE of those has to remember to exclude drafts,
-- forever, including the ones written next month. One forgotten predicate and a
-- half-typed set that never happened is a personal record, or a warm-up typed
-- and then abandoned counts against the week's volume. The failure is silent,
-- and it corrupts the very history this feature exists to protect.
--
-- A separate table makes the exclusion STRUCTURAL: there is no flag to forget,
-- because no query that reads training can even see this data. The draft is not
-- a workout — it is what the user has typed so far — and it becomes a workout
-- at exactly one moment, when Finish runs `logWorkout` in its one transaction.
-- Abandoning is then a DELETE of one row with nothing left behind, where the
-- flag design has to delete a parent workout and cascade its sets.
--
-- ── WHY A TABLE AND NOT AN EXISTING KV ──
--
-- `health_sync_state` (0021) is the app's other KV table and it was considered
-- first. It is documented as, and named for, the HealthKit sync cursor; parking
-- a live workout in it would make that name a lie for every future reader, and
-- it is read by the wearables repository on a schedule this write has nothing
-- to do with. `users.preferences` is worse: a draft is machine state, not a
-- user choice, and this row is rewritten on every keystroke — the profile row
-- is not a scratchpad. So: its own table, named for exactly what it holds.
--
-- ── SHAPE ──
--
-- A KV, following `health_sync_state`'s pattern: one row per draft slot, value
-- free JSON guarded by `json_valid`. Free JSON on purpose — the payload is the
-- logger's own state (blocks, sets, what is typed in each field, the rest
-- timer's target instant) and it will change when B1 adds time/distance metric
-- types. A shape change must never be a migration for something this transient;
-- the payload carries its own `version`, and a draft written by an older build
-- is discarded on read (src/lib/exercise/draft.ts). There is no history to
-- lose: a draft is at most one unfinished session old.
--
-- `key` is a CHECK'd enum because ARC owns the whole vocabulary (CLAUDE.md §9 —
-- enum vocabulary as text + CHECK, vendor vocabulary as free text). Two slots:
--   'live'   — app/workout-live.tsx, the structured set grid
--   'manual' — app/workout-log.tsx, the free-form cardio/mobility/past logger
-- They are separate rows, so resuming one never disturbs the other.
--
-- UNIQUE on `key` is what makes the write an UPSERT rather than an append: a
-- draft has no history, only a latest. `updated_at` is therefore also the
-- "in progress since" that the hub's Resume card reads.
--
-- Numbered 0045: main's head is 0044 (knowledge sections). The runner SILENTLY
-- SKIPS any number at or below a device's `PRAGMA user_version`, so a collision
-- strands a migration forever — re-check `git ls-tree main -- db/migrations/`
-- before merging (seven collisions in a week). Conventions per CLAUDE.md §9 /
-- 0001_init.sql: app-generated UUID text ids (PRIMARY KEY NOT NULL, no default
-- — src/lib/db/id.ts), ISO-8601 UTC text timestamps, JSON as text + json_valid,
-- created_at/updated_at with an AFTER UPDATE trigger (recursive_triggers OFF).
-- Run `npm run db:bundle` after this file changes.
-- ============================================================================

CREATE TABLE workout_drafts (
  id text PRIMARY KEY NOT NULL,
  key text NOT NULL UNIQUE CHECK (key IN ('live', 'manual')),
  value text NOT NULL DEFAULT '{}' CHECK (json_valid(value)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER workout_drafts_set_updated_at
AFTER UPDATE ON workout_drafts FOR EACH ROW BEGIN
  UPDATE workout_drafts
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.id;
END;
