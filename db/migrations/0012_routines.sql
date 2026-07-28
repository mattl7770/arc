-- ============================================================================
-- ARC 0012 — routines: routines + routine_exercises
--
-- Repeatable training templates (docs/exercise-subapp.md §3). A `routine` is a
-- named, ordered list of exercises with per-exercise targets (sets, a rep
-- range, rest); starting one opens the logger pre-filled, and last session's
-- numbers become the placeholders — so a repeat is one confirm per set. This is
-- the "Templates" the Exercise hub stubbed for the workout builder.
--
-- Distinct from `protocols` (0001): a protocol is a versioned stack that drives
-- Home's mission (supplements, habits, whole-day routines); a training routine
-- is a concrete exercise list the logger consumes. They may converge later
-- (a protocol of type 'training_block' referencing a routine), but keeping them
-- separate now avoids overloading protocol_versions' JSON with set/rep grids.
--
-- Numbered 0012: the Exercise window's reserved block (0011-0013). Runner
-- stamps PRAGMA user_version = 12. Conventions per CLAUDE.md §9 / 0001_init.sql.
-- The routine_exercises FK relies on PRAGMA foreign_keys = ON (client sets it).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- routines — one row per template. last_started_at (nullable) records the most
-- recent time this routine was used to start a workout, powering "last done N
-- days ago" without a join; archived hides it from the list without deleting
-- the row (and any workouts that referenced it keep their link — see 0013's
-- SET NULL). No slug/versioning: a routine is mutable working data, not a
-- versioned artifact like a protocol.
-- ----------------------------------------------------------------------------
CREATE TABLE routines (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  notes text,
  archived integer NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  last_started_at text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX routines_active_idx ON routines (archived, name);

-- ----------------------------------------------------------------------------
-- routine_exercises — the ordered lines of a routine. position is 1-based and
-- orders the list. target_sets / rep_low / rep_high / rest_sec are the
-- prescription the recommender and logger read; rep_low/high are nullable (a
-- carry or a timed hold has no rep range) but when both are set the CHECK keeps
-- low <= high. CASCADE with the routine (a line has no meaning outside it);
-- CASCADE with the exercise too — deleting a catalog movement removes it from
-- templates (workout HISTORY keeps its own SET NULL link in 0013; a routine is
-- a forward-looking plan, not history, so cascade is right here).
-- ----------------------------------------------------------------------------
CREATE TABLE routine_exercises (
  id text PRIMARY KEY NOT NULL,
  routine_id text NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
  exercise_id text NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 1),
  target_sets integer NOT NULL DEFAULT 3 CHECK (target_sets >= 1 AND target_sets <= 20),
  rep_low integer CHECK (rep_low IS NULL OR (rep_low >= 1 AND rep_low < 100)),
  rep_high integer CHECK (rep_high IS NULL OR (rep_high >= 1 AND rep_high < 100)),
  rest_sec integer CHECK (rest_sec IS NULL OR (rest_sec >= 0 AND rest_sec < 3600)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (rep_low IS NULL OR rep_high IS NULL OR rep_low <= rep_high)
);

CREATE INDEX routine_exercises_routine_idx ON routine_exercises (routine_id, position);
CREATE INDEX routine_exercises_exercise_idx ON routine_exercises (exercise_id);

-- ----------------------------------------------------------------------------
-- updated_at triggers (see 0001_init.sql for why there is no WHEN self-guard).
-- ----------------------------------------------------------------------------
CREATE TRIGGER routines_set_updated_at AFTER UPDATE ON routines FOR EACH ROW BEGIN
  UPDATE routines SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER routine_exercises_set_updated_at AFTER UPDATE ON routine_exercises FOR EACH ROW BEGIN
  UPDATE routine_exercises SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
