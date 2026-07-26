-- ============================================================================
-- ARC migration 0002 — nutrition: the meals table
--
-- One row per eaten meal. This is the Nutrition sub-app's own store, distinct
-- from `log_entries.type = 'meal'` (a *planned* mission item, e.g. "Lunch ·
-- Template B at 12:30"): a meal here is a record of what was actually eaten,
-- with its energy and macros, summed into the day's intake. Photo / natural-
-- language logging (Phase 3, Coach) and meal templates will write the same
-- rows — `source` already carries the vocabulary ('manual' today,
-- 'ai_suggested' for a parsed photo/description later), so they arrive without
-- a migration.
--
-- Conventions per CLAUDE.md §9 / 0001_init.sql: app-generated v4 UUID text ids
-- (PRIMARY KEY NOT NULL, no default — src/lib/db/id.ts), local-calendar `date`
-- text YYYY-MM-DD (GLOB-checked), wall-clock `time` text HH:MM, ISO-8601 UTC
-- created_at/updated_at with an AFTER UPDATE trigger (recursive_triggers stays
-- OFF), enum vocabulary as text + CHECK. Macros are nullable — a quick manual
-- entry may carry only a name and kcal; sum() ignores the NULLs.
-- ============================================================================
CREATE TABLE meals (
  id text PRIMARY KEY NOT NULL,
  date text NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Wall-clock time eaten, on the local calendar day above (same split as
  -- log_entries.scheduled_time). Nullable: a meal logged after the fact may
  -- have no meaningful clock time; the day list sorts untimed meals last.
  time text CHECK (time IS NULL OR time GLOB '[0-9][0-9]:[0-9][0-9]'),
  name text NOT NULL,
  kcal real CHECK (kcal IS NULL OR kcal >= 0),
  protein_g real CHECK (protein_g IS NULL OR protein_g >= 0),
  carbs_g real CHECK (carbs_g IS NULL OR carbs_g >= 0),
  fat_g real CHECK (fat_g IS NULL OR fat_g >= 0),
  source text NOT NULL DEFAULT 'manual' CHECK (
    source IN (
      'function_pdf', 'manual', 'api', 'device_sync', 'apple_health',
      'health_connect', 'terra', 'ai_suggested', 'import'
    )
  ),
  notes text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX meals_date_idx ON meals (date DESC);

CREATE TRIGGER meals_set_updated_at AFTER UPDATE ON meals FOR EACH ROW BEGIN
  UPDATE meals SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
