-- ============================================================================
-- ARC 0020 — training programs: multi-week periodization over routines
--
-- The next layer above routines (docs/exercise-subapp.md): a `program` is a
-- multi-week mesocycle — a repeating weekly split (which routine runs on which
-- weekday) plus a length in weeks and planned deload/test weeks. Routines stay
-- the flat exercise lists; a program schedules them across a calendar and marks
-- when to back off. Progressive overload within a week is still the per-exercise
-- engine (freshness + double progression); the program adds the week-scale
-- structure (accumulate 4 weeks, deload 1) that per-exercise logic can't see.
--
-- Model — a REPEATING weekly template, not a full week×day grid:
--   * program_days maps weekday -> routine (the split that repeats every week);
--     a weekday with no row is a rest day.
--   * program_weeks marks the weeks that differ from plain accumulation (a
--     deload or a test week); an unlisted week is 'accumulation'. On a deload
--     week the SAME routines run, and the engine/logger cut volume (the RP
--     model: same movements, ~half the sets) — so deload is week metadata, not
--     a different day map.
--   * programs.active_start is the local Monday the running instance began
--     (NULL = not scheduled). "Today's session" is derived: week index from
--     (today - active_start)/7, weekday from today, then a program_days lookup.
--     At most one program is active at a time (repo-enforced: activating one
--     clears the others).
--
-- Numbered 0020: the Exercise window's second reserved block. main holds
-- 0001-0009 + this window's 0011-0013; 0014-0018 are reserved for Nutrition and
-- 0019 for the Coach's RAG (all land on merge). The runner tolerates the gaps —
-- versions only increase, migrate.test asserts user_version = max(version).
-- Conventions per CLAUDE.md §9 / 0001_init.sql. FKs need PRAGMA foreign_keys =
-- ON (client sets it). Runner stamps PRAGMA user_version = 20.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- programs — one row per mesocycle template. `weeks` is the length; a program
-- runs weeks 1..weeks then ends. `active_start` (a local Monday YYYY-MM-DD) is
-- set when the user starts the program and cleared when they stop it or it
-- finishes; only one program carries a non-null active_start at a time.
-- ----------------------------------------------------------------------------
CREATE TABLE programs (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  notes text,
  weeks integer NOT NULL CHECK (weeks >= 1 AND weeks <= 52),
  active_start text CHECK (
    active_start IS NULL OR active_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  archived integer NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One partial index so "the active program" is a fast, single-row lookup.
CREATE INDEX programs_active_idx ON programs (active_start) WHERE active_start IS NOT NULL;

-- ----------------------------------------------------------------------------
-- program_days — the repeating weekly split: at most one routine per weekday.
-- dow is 1=Mon … 7=Sun (ISO). routine_id NOT NULL + ON DELETE CASCADE: a day
-- exists to run a routine, so if that routine is deleted the day reverts to
-- rest (its row is removed) rather than lingering as a dangling plan. A rest
-- day is simply the ABSENCE of a row for that weekday.
-- ----------------------------------------------------------------------------
CREATE TABLE program_days (
  id text PRIMARY KEY NOT NULL,
  program_id text NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  dow integer NOT NULL CHECK (dow >= 1 AND dow <= 7),
  routine_id text NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (program_id, dow)
);

CREATE INDEX program_days_program_idx ON program_days (program_id, dow);
CREATE INDEX program_days_routine_idx ON program_days (routine_id);

-- ----------------------------------------------------------------------------
-- program_weeks — only the weeks that DIFFER from plain accumulation. A week
-- with no row is 'accumulation'; a row marks it 'deload' or 'test'. Sparse on
-- purpose (a typical program stores one deload row). week is 1-based and must
-- be within the program's length (repo-enforced; not a cross-row SQL CHECK).
-- ----------------------------------------------------------------------------
CREATE TABLE program_weeks (
  id text PRIMARY KEY NOT NULL,
  program_id text NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  week integer NOT NULL CHECK (week >= 1),
  kind text NOT NULL CHECK (kind IN ('accumulation', 'deload', 'test')),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (program_id, week)
);

CREATE INDEX program_weeks_program_idx ON program_weeks (program_id, week);

-- ----------------------------------------------------------------------------
-- updated_at triggers (see 0001_init.sql for why there is no WHEN self-guard).
-- ----------------------------------------------------------------------------
CREATE TRIGGER programs_set_updated_at AFTER UPDATE ON programs FOR EACH ROW BEGIN
  UPDATE programs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER program_days_set_updated_at AFTER UPDATE ON program_days FOR EACH ROW BEGIN
  UPDATE program_days SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER program_weeks_set_updated_at AFTER UPDATE ON program_weeks FOR EACH ROW BEGIN
  UPDATE program_weeks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
