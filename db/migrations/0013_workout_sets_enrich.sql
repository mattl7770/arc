-- ============================================================================
-- ARC 0013 — enrich workouts + workout_sets for the structured logger
--
-- Additive columns that upgrade the 0003 tables from free-text session logging
-- to catalog-linked, structured strength logging (docs/exercise-subapp.md §3),
-- WITHOUT touching a shipped migration and WITHOUT breaking any existing row or
-- the exercise.ts exports the Data-tab trend and the Coach's read-tool depend
-- on. Every column is nullable (or has a safe default), so every pre-existing
-- workout/workout_set stays valid and the old free-text `exercise` column keeps
-- working as the display name.
--
-- Numbered 0013: last of the Exercise window's reserved block (0011-0013);
-- must run AFTER 0011 (exercises) and 0012 (routines) since its FKs reference
-- them. Runner stamps PRAGMA user_version = 13.
--
-- SQLite ALTER TABLE ADD COLUMN notes:
--   * a REFERENCES column added by ALTER must default to NULL (it does here);
--   * a NOT NULL column added by ALTER must carry a non-NULL default
--     (set_type does: 'normal'). Both rules are satisfied below.
-- FKs enforce only with PRAGMA foreign_keys = ON (the client sets it per
-- connection); the SET NULL keeps execution history when a routine or catalog
-- exercise is deleted (CLAUDE.md: deleting a plan must never destroy history).
-- ============================================================================

-- workouts.routine_id — which routine (if any) this session was started from.
-- SET NULL: deleting a routine must not delete or orphan the workouts run under
-- it; they keep their name and sets, just unlinked from the (now gone) template.
ALTER TABLE workouts ADD COLUMN routine_id text REFERENCES routines (id) ON DELETE SET NULL;

-- workout_sets.exercise_id — the catalog movement this set belongs to. Nullable
-- + SET NULL: pre-0013 rows (and any quick free-text log) have only the
-- `exercise` text name; history outlives catalog edits. New structured logging
-- writes BOTH exercise_id and the exercise text (the display name), so a set is
-- readable even if the catalog row is later archived or deleted.
ALTER TABLE workout_sets ADD COLUMN exercise_id text REFERENCES exercises (id) ON DELETE SET NULL;

-- set_type — warmup / normal / failure / drop. Warmups are excluded from e1RM,
-- PRs, and volume/freshness (the Hevy/Strong rule); the others feed the engine.
-- NOT NULL DEFAULT 'normal' so every existing set reads as a normal working set.
ALTER TABLE workout_sets ADD COLUMN set_type text NOT NULL DEFAULT 'normal'
  CHECK (set_type IN ('normal', 'warmup', 'failure', 'drop'));

-- rpe — Rate of Perceived Exertion 1-10 (RIR = 10 - RPE). Nullable: optional per
-- set; when present it sharpens e1RM (n = reps + RIR) and fatigue weighting.
ALTER TABLE workout_sets ADD COLUMN rpe real CHECK (rpe IS NULL OR (rpe >= 1 AND rpe <= 10));

-- duration_sec — seconds for a timed set (plank, a carry). Nullable; only
-- logging_types 'duration' / 'weight_duration' use it. Loose fat-finger bound
-- (< 36000s = 10h) mirrors the schema's other manual-magnitude guards.
ALTER TABLE workout_sets ADD COLUMN duration_sec integer
  CHECK (duration_sec IS NULL OR (duration_sec >= 0 AND duration_sec < 36000));

-- superset_group — reserved for supersets: sets sharing a group id within a
-- workout are performed back-to-back. UI ships later; the column lands now so
-- adding supersets is not another migration. NULL = a straight set.
ALTER TABLE workout_sets ADD COLUMN superset_group integer
  CHECK (superset_group IS NULL OR superset_group >= 1);

-- Per-exercise history reads (e1RM trend, PRs, last-session prefill) filter on
-- exercise_id; index it. (workout_sets_workout_idx from 0003 covers the join.)
CREATE INDEX workout_sets_exercise_idx ON workout_sets (exercise_id) WHERE exercise_id IS NOT NULL;
