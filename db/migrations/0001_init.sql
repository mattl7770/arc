-- ============================================================================
-- ARC v1 core schema — SQLite (local-first)
--
-- Ported from the original Postgres/Supabase migration when ARC moved to a
-- local-first, single-user, no-server architecture. See the 2026-07-24 ADR in
-- docs/decisions.md and the plan in docs/architecture-migration.md (Phase 0).
--
-- THIS FILE IS THE SOURCE OF TRUTH for the schema. The Postgres/Supabase origin
-- has been deleted (2026-07-25); it survives in git history only.
--
-- Dialect / design changes from the Postgres original:
--   * enums          -> text + CHECK (col IN (...))
--   * uuid           -> text. Ids are app-generated v4 UUIDs (src/lib/db/id.ts,
--                       sourced from SQLite randomblob — Hermes has no crypto
--                       global), with NO default. Declared PRIMARY KEY NOT NULL
--                       so a missing id fails loud — SQLite's PRIMARY KEY alone
--                       does NOT imply NOT NULL for a text key (a rowid-table
--                       quirk) and would silently accept unlimited NULL-id rows,
--                       so the explicit NOT NULL is load-bearing, not decorative.
--   * timestamptz    -> text, ISO-8601 UTC, default strftime(...Z). ISO strings
--                       sort chronologically as text, so range/order queries and
--                       indexes still work.
--   * date           -> text 'YYYY-MM-DD' (GLOB-checked)
--   * time           -> text 'HH:MM'      (GLOB-checked)
--   * numeric        -> real ;  boolean -> integer 0|1 (CHECK)
--   * jsonb          -> text, guarded by json_valid()
--   * RLS / GRANT / auth triggers / user_id tenancy  -> REMOVED. One user, one
--     device: the OS + app lock are the security boundary, not row policies.
--     Child tables no longer carry user_id, so the composite (id, user_id)
--     foreign keys collapse to simple ones and the (user_id, x) uniques/indexes
--     lose their user_id prefix.
--   * slug / metric_type regex CHECKs (`~`) -> dropped (SQLite has no regex in
--     portable DDL). The repository layer owns that validation now.
--
-- Runtime requirements the DB layer MUST set on every connection:
--   PRAGMA foreign_keys = ON;    -- SQLite defaults this OFF
--   recursive_triggers stays OFF (the SQLite default) so the updated_at
--   triggers below don't re-fire themselves.
-- The migration runner stamps PRAGMA user_version = 1 after applying this file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- users — a single-row profile now, not an auth mirror. No email/uid identity;
-- just the settings the app and Coach need (timezone drives "today").
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id text PRIMARY KEY NOT NULL,
  email text,
  full_name text,
  date_of_birth text,
  biological_sex text CHECK (
    biological_sex IN ('male', 'female', 'intersex', 'prefer_not_to_say')
  ),
  timezone text NOT NULL DEFAULT 'UTC',
  preferences text NOT NULL DEFAULT '{}' CHECK (json_valid(preferences)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    date_of_birth IS NULL
    OR (date_of_birth GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date_of_birth > '1900-01-01')
  )
);

-- ----------------------------------------------------------------------------
-- biomarkers — global reference data (the definition of ApoB is the same for
-- everyone). Seeded locally; never user-scoped.
-- ----------------------------------------------------------------------------
CREATE TABLE biomarkers (
  id text PRIMARY KEY NOT NULL,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'other' CHECK (
    category IN (
      'cardiovascular', 'metabolic', 'hormone', 'inflammation', 'nutrient',
      'organ', 'immune', 'hematology', 'cancer', 'toxin', 'other'
    )
  ),
  unit text,
  description text,
  optimal_range_low real,
  optimal_range_high real,
  standard_range_low real,
  standard_range_high real,
  higher_is_better integer CHECK (higher_is_better IN (0, 1)),
  notes text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    optimal_range_low IS NULL OR optimal_range_high IS NULL
    OR optimal_range_low <= optimal_range_high
  ),
  CHECK (
    standard_range_low IS NULL OR standard_range_high IS NULL
    OR standard_range_low <= standard_range_high
  )
);

CREATE INDEX biomarkers_category_idx ON biomarkers (category);

-- ----------------------------------------------------------------------------
-- lab_reports — one row per ingested report (typically a Function Health PDF).
-- The raw extraction is kept beside the parsed rows so a parser improvement can
-- be replayed without re-uploading.
-- ----------------------------------------------------------------------------
CREATE TABLE lab_reports (
  id text PRIMARY KEY NOT NULL,
  source text NOT NULL DEFAULT 'function_pdf' CHECK (
    source IN (
      'function_pdf', 'manual', 'api', 'device_sync', 'apple_health',
      'health_connect', 'terra', 'ai_suggested', 'import'
    )
  ),
  collected_at text NOT NULL CHECK (collected_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Local file / PhotoKit / iCloud reference to the original PDF, not a cloud
  -- storage path any more. The file is the source of truth, not the parse.
  file_path text,
  raw_extracted_json text CHECK (
    raw_extracted_json IS NULL OR json_valid(raw_extracted_json)
  ),
  parsed_at text,
  notes text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX lab_reports_collected_idx ON lab_reports (collected_at DESC);

-- ----------------------------------------------------------------------------
-- lab_results — one biomarker value at one point in time. report_id is NULL for
-- manual entries (and NULLs never collide in the idempotency unique below).
-- ----------------------------------------------------------------------------
CREATE TABLE lab_results (
  id text PRIMARY KEY NOT NULL,
  biomarker_id text NOT NULL REFERENCES biomarkers (id) ON DELETE RESTRICT,
  -- Deleting a report discards the values parsed out of it; manual entries
  -- (report_id NULL) are untouched.
  report_id text REFERENCES lab_reports (id) ON DELETE CASCADE,
  value real NOT NULL,
  collected_at text NOT NULL CHECK (collected_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  lab_name text,
  source text NOT NULL DEFAULT 'function_pdf' CHECK (
    source IN (
      'function_pdf', 'manual', 'api', 'device_sync', 'apple_health',
      'health_connect', 'terra', 'ai_suggested', 'import'
    )
  ),
  notes text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Idempotency guard: one value per biomarker per report.
  UNIQUE (report_id, biomarker_id)
);

CREATE INDEX lab_results_biomarker_collected_idx
  ON lab_results (biomarker_id, collected_at DESC);
CREATE INDEX lab_results_collected_idx ON lab_results (collected_at DESC);
CREATE INDEX lab_results_report_idx
  ON lab_results (report_id) WHERE report_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- protocols / protocol_versions — protocols are treated like code: the protocol
-- row is the stable identity, every change is a new immutable version, and
-- current_version_id points at what is live.
--
-- protocols.current_version_id references protocol_versions, which is created
-- just below — SQLite permits this forward reference (FKs are resolved at
-- runtime, not at CREATE time).
-- ----------------------------------------------------------------------------
CREATE TABLE protocols (
  id text PRIMARY KEY NOT NULL,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  type text NOT NULL CHECK (
    type IN (
      'daily_routine', 'supplement_stack', 'meal_template', 'training_block',
      'therapy_protocol', 'sleep_protocol', 'other'
    )
  ),
  is_active integer NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  current_version_id text REFERENCES protocol_versions (id) ON DELETE SET NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE protocol_versions (
  id text PRIMARY KEY NOT NULL,
  protocol_id text NOT NULL REFERENCES protocols (id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number > 0),
  -- Shape depends on protocols.type; a supplement stack and a training block
  -- do not share columns, hence json.
  content text NOT NULL DEFAULT '{}' CHECK (json_valid(content)),
  change_notes text,
  created_by text NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'ai')),
  -- Immutable snapshot: no updated_at, no update path. That is the point of
  -- versioning.
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (protocol_id, version_number)
);

CREATE INDEX protocols_active_idx ON protocols (is_active) WHERE is_active = 1;
CREATE INDEX protocol_versions_protocol_idx
  ON protocol_versions (protocol_id, version_number DESC);

-- ----------------------------------------------------------------------------
-- daily_logs / log_entries — the execution layer. One daily_log per calendar
-- day; log_entries are the rows behind Today's Mission.
-- ----------------------------------------------------------------------------
CREATE TABLE daily_logs (
  id text PRIMARY KEY NOT NULL,
  date text NOT NULL UNIQUE CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  summary text,
  overall_adherence_score real CHECK (
    overall_adherence_score IS NULL
    OR (overall_adherence_score >= 0 AND overall_adherence_score <= 100)
  ),
  notes text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE log_entries (
  id text PRIMARY KEY NOT NULL,
  daily_log_id text NOT NULL REFERENCES daily_logs (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (
    type IN (
      'habit', 'meal', 'workout', 'supplement', 'medication', 'therapy',
      'metric', 'note'
    )
  ),
  -- ON DELETE SET NULL so deleting a protocol never destroys execution history.
  protocol_id text REFERENCES protocols (id) ON DELETE SET NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'completed', 'skipped', 'partial')
  ),
  -- Wall-clock 'HH:MM'; the calendar date comes from the parent daily_log, so a
  -- 07:00 habit stays 07:00 across timezones. Also the mission sort key.
  scheduled_time text CHECK (scheduled_time IS NULL OR scheduled_time GLOB '[0-9][0-9]:[0-9][0-9]'),
  completed_at text,
  value text CHECK (value IS NULL OR json_valid(value)),
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

CREATE INDEX log_entries_daily_log_idx ON log_entries (daily_log_id);
CREATE INDEX log_entries_status_idx ON log_entries (status);
CREATE INDEX log_entries_protocol_idx
  ON log_entries (protocol_id) WHERE protocol_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- wearable_data — everything normalised into ARC's own shape, tall/narrow so a
-- new metric is a new row, not a migration. Always labelled with its device so
-- dual-ring / ring-plus-strap setups stay disambiguated.
-- ----------------------------------------------------------------------------
CREATE TABLE wearable_data (
  id text PRIMARY KEY NOT NULL,
  date text NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- e.g. sleep_score, hrv, rhr, strain, recovery, steps, spo2, temperature.
  -- Free text (vendors add metrics on their schedule); the repository layer
  -- enforces the ^[a-z0-9_]+$ shape the Postgres CHECK used to.
  metric_type text NOT NULL,
  value real NOT NULL,
  unit text,
  source_device text NOT NULL CHECK (
    source_device IN (
      'oura', 'whoop', 'ultrahuman', 'apple_watch', 'garmin', 'eight_sleep',
      'withings', 'manual', 'other'
    )
  ),
  source_raw_id text,
  start_time text,
  end_time text,
  metadata text NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (start_time IS NULL OR end_time IS NULL OR start_time <= end_time)
);

CREATE INDEX wearable_data_date_idx ON wearable_data (date DESC);
CREATE INDEX wearable_data_metric_date_idx
  ON wearable_data (metric_type, date DESC);
-- Re-syncing a device updates rows rather than duplicating them.
CREATE UNIQUE INDEX wearable_data_device_raw_id_key
  ON wearable_data (source_device, source_raw_id)
  WHERE source_raw_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- body_metrics — body composition over time. Every column nullable because a
-- scale, a DEXA scan, and a tape measure each fill a different subset.
-- ----------------------------------------------------------------------------
CREATE TABLE body_metrics (
  id text PRIMARY KEY NOT NULL,
  measured_at text NOT NULL,
  -- Upper bounds restore the implicit domain the Postgres numeric(p,s) types
  -- carried before the numeric->real collapse (weight/muscle/bone were
  -- numeric(6,3) so < 1000; waist/hip numeric(6,2) so < 10000; visceral
  -- numeric(5,2) so < 1000), catching fat-finger inserts at the DB layer for
  -- data that has no source of truth to re-derive from. Loose on purpose.
  weight_kg real CHECK (weight_kg IS NULL OR (weight_kg > 0 AND weight_kg < 1000)),
  body_fat_pct real CHECK (
    body_fat_pct IS NULL OR (body_fat_pct >= 0 AND body_fat_pct <= 100)
  ),
  muscle_mass_kg real CHECK (
    muscle_mass_kg IS NULL OR (muscle_mass_kg > 0 AND muscle_mass_kg < 1000)
  ),
  bone_mass_kg real CHECK (
    bone_mass_kg IS NULL OR (bone_mass_kg > 0 AND bone_mass_kg < 1000)
  ),
  -- Had no CHECK at all before; a rating is non-negative.
  visceral_fat_rating real CHECK (
    visceral_fat_rating IS NULL OR (visceral_fat_rating >= 0 AND visceral_fat_rating < 1000)
  ),
  waist_cm real CHECK (waist_cm IS NULL OR (waist_cm > 0 AND waist_cm < 10000)),
  hip_cm real CHECK (hip_cm IS NULL OR (hip_cm > 0 AND hip_cm < 10000)),
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

CREATE INDEX body_metrics_measured_idx ON body_metrics (measured_at DESC);

-- ----------------------------------------------------------------------------
-- updated_at triggers
--
-- One AFTER UPDATE trigger per mutable table (protocol_versions is immutable, so
-- it has none). Correctness depends on recursive_triggers being OFF — the SQLite
-- default, which the DB client must never override: otherwise the inner UPDATE
-- that stamps updated_at would re-fire the trigger.
--
-- A `WHEN NEW.updated_at = OLD.updated_at` self-guard was tried and REJECTED: in
-- a trigger cascade strftime('now') returns the same value on each call, so the
-- fresh stamp can equal OLD within one millisecond, the WHEN stays true, and it
-- recurses to the depth limit anyway (reproduced under recursive_triggers=ON in
-- db/validate-schema.mjs). Relying on the default OFF is the idiomatic, actually
-- -correct choice; `AFTER UPDATE OF <cols>` was also rejected — listing every
-- column but updated_at is a footgun that silently stops stamping a new column.
-- ----------------------------------------------------------------------------
CREATE TRIGGER users_set_updated_at AFTER UPDATE ON users FOR EACH ROW BEGIN
  UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER biomarkers_set_updated_at AFTER UPDATE ON biomarkers FOR EACH ROW BEGIN
  UPDATE biomarkers SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER lab_reports_set_updated_at AFTER UPDATE ON lab_reports FOR EACH ROW BEGIN
  UPDATE lab_reports SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER lab_results_set_updated_at AFTER UPDATE ON lab_results FOR EACH ROW BEGIN
  UPDATE lab_results SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER protocols_set_updated_at AFTER UPDATE ON protocols FOR EACH ROW BEGIN
  UPDATE protocols SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER daily_logs_set_updated_at AFTER UPDATE ON daily_logs FOR EACH ROW BEGIN
  UPDATE daily_logs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER log_entries_set_updated_at AFTER UPDATE ON log_entries FOR EACH ROW BEGIN
  UPDATE log_entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER wearable_data_set_updated_at AFTER UPDATE ON wearable_data FOR EACH ROW BEGIN
  UPDATE wearable_data SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER body_metrics_set_updated_at AFTER UPDATE ON body_metrics FOR EACH ROW BEGIN
  UPDATE body_metrics SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
