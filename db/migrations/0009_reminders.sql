-- ============================================================================
-- ARC 0009 — reminders: the nudge store
--
-- One row per reminder — user-asked ("remind me to take magnesium at 9pm") or
-- Coach-initiated ("you haven't logged weight in 8 days — want a daily
-- nudge?"). This is the DATA + in-app surfacing layer only: rows are read by
-- the Coach screen (and, later, Home) and by the Coach's list_reminders tool.
-- OS notification *delivery* (expo-notifications) is a native dependency and a
-- deliberate non-goal of this migration — when it lands, it schedules from
-- these same rows; nothing here changes.
--
-- Numbered 0009 (renumbered from 0006 at integration to sit above Screenings 0007;
-- 0007+). Conventions per CLAUDE.md §9 / 0001_init.sql: app-generated v4 UUID
-- text ids (PRIMARY KEY NOT NULL, no default — src/lib/db/id.ts),
-- local-calendar `date` text YYYY-MM-DD (GLOB-checked), wall-clock `time` text
-- HH:MM, ISO-8601 UTC created_at/updated_at with an AFTER UPDATE trigger
-- (recursive_triggers stays OFF), enum vocabulary as text + CHECK.
-- ============================================================================
CREATE TABLE reminders (
  id text PRIMARY KEY NOT NULL,
  -- What to surface: "Take magnesium", "Log weight".
  title text NOT NULL,
  -- Wall-clock HH:MM to nudge at; NULL means "sometime that day".
  time text CHECK (time IS NULL OR time GLOB '[0-9][0-9]:[0-9][0-9]'),
  -- For a one-off: the local calendar day it applies to (NULL = today/undated).
  -- For 'weekly': the anchor date whose weekday repeats. Unused for 'daily'.
  date text CHECK (date IS NULL OR date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  repeat text NOT NULL DEFAULT 'once' CHECK (repeat IN ('once', 'daily', 'weekly')),
  -- 'active' surfaces; 'done' was acted on (one-offs); 'dismissed' was turned
  -- off. Recurring reminders stay 'active' until dismissed — per-day completion
  -- is execution state and belongs to the log layer, not the reminder row.
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'dismissed')),
  -- Who created it — same authorship vocabulary as protocol_versions.
  created_by text NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'ai')),
  notes text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- A weekly reminder needs its anchor weekday.
  CHECK (repeat != 'weekly' OR date IS NOT NULL)
);

-- The surfacing read: active reminders, timed ones in clock order.
CREATE INDEX reminders_status_idx ON reminders (status) WHERE status = 'active';

CREATE TRIGGER reminders_set_updated_at AFTER UPDATE ON reminders FOR EACH ROW BEGIN
  UPDATE reminders SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
