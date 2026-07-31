-- ============================================================================
-- ARC 0026 — day modes: how a not-normal day adapts
--
-- A "mode" (Normal/Travel/Sick/Deload/Social/Custom) is a fact about a day that
-- reshapes the mission plan, the hero's priorities, the Coach's tone, and
-- adherence accounting (docs/information-architecture.md §Modes, locked
-- 2026-07-25). A mode is declared once and the day adapts, instead of showing
-- the standard plan and marking half of it missed.
--
-- Its own table (not a `daily_logs` column) because a mode spans a RANGE — a
-- whole trip (Travel), an illness (Sick), a deload week — or runs open-ended
-- until turned off. The ACTIVE mode for a date is the most-recently-set row
-- whose range covers it (see src/lib/db/repositories/day-modes.ts); no covering
-- row means Normal (the implicit default). A `normal` row MAY be stored as an
-- explicit reset — the most-recent covering row wins, so a `normal` set today
-- ends an earlier open-ended Sick/Travel without editing the old row.
--
-- Numbered 0026: next free above the current max (0025 RAG). Conventions per
-- CLAUDE.md §9 / 0001_init.sql: text PK NOT NULL app-generated id, YYYY-MM-DD
-- date text (GLOB-checked), enum as text + CHECK, ISO-8601 created_at/updated_at
-- with an AFTER UPDATE trigger.
-- ============================================================================
CREATE TABLE day_modes (
  id text PRIMARY KEY NOT NULL,
  mode text NOT NULL CHECK (mode IN ('normal', 'travel', 'sick', 'deload', 'social', 'custom')),
  -- Inclusive local-calendar range. `start_date` = the first day it applies;
  -- `end_date` NULL = open-ended ("on until turned off"); start == end = just
  -- today; start < end = a range (a trip). Clearing a mode sets `end_date` to
  -- the day before it should stop applying (or deletes an all-future row).
  start_date text NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date text CHECK (
    end_date IS NULL OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  -- Optional user label (esp. for Custom) and a free note ("red-eye to Tokyo").
  label text,
  note text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Active-mode resolution scans by start_date and recency; index both.
CREATE INDEX day_modes_start_idx ON day_modes (start_date DESC);

CREATE TRIGGER day_modes_set_updated_at AFTER UPDATE ON day_modes FOR EACH ROW BEGIN
  UPDATE day_modes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
