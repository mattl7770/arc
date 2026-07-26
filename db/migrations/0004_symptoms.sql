-- ============================================================================
-- ARC 0004 — symptoms: capture what's off, when
--
-- Symptoms (headaches, pains, GI, brain fog, low energy…) logged as they happen,
-- so the Coach can correlate them against protocols, labs, and wearables (owner
-- priority, 2026-07-25). Their own table rather than a `log_entries` variant:
-- symptoms carry structured fields (severity, body area) a generic log row
-- doesn't, and log_entries.type is a fixed CHECK vocabulary (adding 'symptom'
-- would mean recreating that table). An additive CREATE is cleaner.
--
-- Numbered 0004 (after nutrition 0002 + exercise 0003). Conventions per
-- CLAUDE.md §9 / 0001_init.sql: app-generated v4 UUID text ids (PRIMARY KEY
-- NOT NULL, no default — src/lib/db/id.ts), local-calendar `date` text
-- YYYY-MM-DD (GLOB-checked), wall-clock `time` text HH:MM, ISO-8601 UTC
-- created_at/updated_at with an AFTER UPDATE trigger (recursive_triggers stays
-- OFF), enum vocabulary as text + CHECK.
-- ============================================================================
CREATE TABLE symptoms (
  id text PRIMARY KEY NOT NULL,
  date text NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Wall-clock time it occurred on the local day above; nullable when logged
  -- after the fact. Untimed entries sort last in the day list.
  time text CHECK (time IS NULL OR time GLOB '[0-9][0-9]:[0-9][0-9]'),
  name text NOT NULL,
  -- Subjective 1–10 intensity, nullable (a quick note may not rate it).
  severity integer CHECK (severity IS NULL OR (severity >= 1 AND severity <= 10)),
  body_area text,
  notes text,
  source text NOT NULL DEFAULT 'manual' CHECK (
    source IN (
      'function_pdf', 'manual', 'api', 'device_sync', 'apple_health',
      'health_connect', 'terra', 'ai_suggested', 'import'
    )
  ),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX symptoms_date_idx ON symptoms (date DESC);

CREATE TRIGGER symptoms_set_updated_at AFTER UPDATE ON symptoms FOR EACH ROW BEGIN
  UPDATE symptoms SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
