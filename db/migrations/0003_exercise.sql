-- ============================================================================
-- ARC 0003 — exercise: workouts + workout_sets
--
-- Training as first-class data (docs/project-status.md "Exercise as measured
-- data"). A `workout` is one session (a lift day, a Zone 2 ride, a mobility
-- block); `workout_sets` are its strength rows. Cardio/mobility sessions carry
-- duration on the workout itself and typically have no sets.
--
-- Numbered 0003: 0002 is reserved by the parallel Nutrition slice (the runner
-- tolerates the gap until both branches merge — versions must only increase).
--
-- Conventions per CLAUDE.md §9 / 0001_init.sql:
--   * app-generated v4 UUID ids, declared PRIMARY KEY NOT NULL (load-bearing:
--     SQLite's PRIMARY KEY alone would accept NULL text ids);
--   * date is text 'YYYY-MM-DD' (GLOB-checked), timestamps ISO-8601 UTC text;
--   * enum vocabulary -> text + CHECK (kind IN (...));
--   * weight is stored CANONICAL kg (matching body_metrics) — lb/kg display
--     conversion is the UI's job, so a unit toggle is never a migration;
--   * created_at/updated_at + AFTER UPDATE trigger per table. Correctness of
--     the triggers depends on recursive_triggers staying OFF (the default);
--   * the ON DELETE CASCADE relies on PRAGMA foreign_keys = ON, which the
--     client sets on every connection (SQLite defaults it OFF).
-- The migration runner stamps PRAGMA user_version = 3 after applying this file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- workouts — one row per session. duration_min is nullable: a live session gets
-- it stamped at finish, a quick manual log may not know it.
-- ----------------------------------------------------------------------------
CREATE TABLE workouts (
  id text PRIMARY KEY NOT NULL,
  date text NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('strength', 'cardio', 'mobility', 'other')),
  duration_min real CHECK (duration_min IS NULL OR duration_min >= 0),
  notes text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX workouts_date_idx ON workouts (date DESC);

-- ----------------------------------------------------------------------------
-- workout_sets — one strength set. Deleting a workout deletes its sets: a set
-- has no meaning outside its session (unlike log history, which survives its
-- protocol via SET NULL). reps/weight_kg are nullable — a bodyweight movement
-- has no load, a timed carry has no reps. The weight upper bound follows
-- body_metrics' fat-finger rationale (0001): manually typed, nothing to
-- re-derive from, and no barbell holds 1000 kg. Loose on purpose.
-- ----------------------------------------------------------------------------
CREATE TABLE workout_sets (
  id text PRIMARY KEY NOT NULL,
  workout_id text NOT NULL REFERENCES workouts (id) ON DELETE CASCADE,
  exercise text NOT NULL,
  set_index integer CHECK (set_index IS NULL OR set_index >= 0),
  reps integer CHECK (reps IS NULL OR reps >= 0),
  weight_kg real CHECK (weight_kg IS NULL OR (weight_kg >= 0 AND weight_kg < 1000)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX workout_sets_workout_idx ON workout_sets (workout_id);

-- ----------------------------------------------------------------------------
-- updated_at triggers (see 0001_init.sql for why there is no WHEN self-guard).
-- ----------------------------------------------------------------------------
CREATE TRIGGER workouts_set_updated_at AFTER UPDATE ON workouts FOR EACH ROW BEGIN
  UPDATE workouts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER workout_sets_set_updated_at AFTER UPDATE ON workout_sets FOR EACH ROW BEGIN
  UPDATE workout_sets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
