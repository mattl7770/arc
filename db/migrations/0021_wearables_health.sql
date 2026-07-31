-- ============================================================================
-- ARC 0021 — Apple Health ingestion: source_device 'apple_health' + sync state
--
-- The wearables pipeline (docs/wearables-subapp.md) lands HealthKit data in the
-- 0001 `wearable_data` table. Two schema needs:
--
--   1. REBUILD `wearable_data` to add 'apple_health' to the source_device CHECK.
--      Cumulative metrics (steps, active/resting energy) are ingested as
--      HealthKit's own MERGED daily statistics — Apple's cross-device dedup is
--      private and cannot be reproduced, so those rows have no single device by
--      design; 'apple_health' is the honest label for the merged transport.
--      (The sibling `source` enums in 0001 already carry 'apple_health'; only
--      this device vocabulary lacked it.) SQLite cannot ALTER a CHECK, hence
--      the copy-swap rebuild: no table references wearable_data by FK, and the
--      runner wraps the whole file in one transaction, so a straight
--      create-copy-drop-rename is safe; indexes and the updated_at trigger are
--      recreated under their 0001 names. Existing rows (manual water/HRV/RHR
--      from the Log tab) are preserved byte-for-byte.
--
--   2. `health_sync_state` — a tiny KV table for the sync cursor: key
--      'apple_health' holds {lastSyncedAt, firstSyncedAt} JSON, letting each
--      sync window from the last one (trailing 14-day re-aggregation; 90 days
--      on first sync). Future HKAnchoredObjectQuery anchors land here too —
--      value is free JSON precisely so that is not a migration. A table rather
--      than users.preferences because it is machine cursor state, not a user
--      choice (the enable toggle IS a preference and lives there).
--
-- Numbered 0021: 0019 (RAG) and 0024–0026 (labs) are reserved by parallel
-- windows; the runner tolerates gaps — versions must only increase.
--
-- ⚠️ But a gap is only safe for a branch that merges BEFORE a higher number
-- ships. `pendingMigrations` filters `version > user_version`, so on a device
-- that has already run this file (user_version = 21) a migration later merged as
-- 0019 would be skipped SILENTLY — no error, just missing tables at first use.
-- Whoever lands the RAG migration must renumber it to 0022+ (0022–0023 free).
--
-- Conventions per CLAUDE.md §9 / 0001_init.sql: app-generated v4 UUID text ids
-- (PRIMARY KEY NOT NULL, no default — src/lib/db/id.ts), ISO-8601 UTC text
-- timestamps, enum vocabulary as text + CHECK, JSON as text + json_valid,
-- created_at/updated_at with an AFTER UPDATE trigger (recursive_triggers OFF).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. wearable_data rebuild — identical shape, one new CHECK value.
-- ----------------------------------------------------------------------------
CREATE TABLE wearable_data_new (
  id text PRIMARY KEY NOT NULL,
  date text NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- e.g. sleep_score, hrv, rhr, strain, recovery, steps, spo2, temperature.
  -- Free text (vendors add metrics on their schedule); the repository layer
  -- enforces the ^[a-z0-9_]+$ shape the Postgres CHECK used to.
  metric_type text NOT NULL,
  value real NOT NULL,
  unit text,
  -- 'apple_health' = HealthKit's merged cross-device daily statistic, used only
  -- where per-device attribution is impossible by design (cumulative metrics).
  source_device text NOT NULL CHECK (
    source_device IN (
      'oura', 'whoop', 'ultrahuman', 'apple_watch', 'garmin', 'eight_sleep',
      'withings', 'apple_health', 'manual', 'other'
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

INSERT INTO wearable_data_new (
  id, date, metric_type, value, unit, source_device, source_raw_id,
  start_time, end_time, metadata, created_at, updated_at
)
SELECT
  id, date, metric_type, value, unit, source_device, source_raw_id,
  start_time, end_time, metadata, created_at, updated_at
FROM wearable_data;

-- Dropping the old table also drops its indexes and trigger.
DROP TABLE wearable_data;
ALTER TABLE wearable_data_new RENAME TO wearable_data;

CREATE INDEX wearable_data_date_idx ON wearable_data (date DESC);
CREATE INDEX wearable_data_metric_date_idx
  ON wearable_data (metric_type, date DESC);
-- Re-syncing a device updates rows rather than duplicating them.
CREATE UNIQUE INDEX wearable_data_device_raw_id_key
  ON wearable_data (source_device, source_raw_id)
  WHERE source_raw_id IS NOT NULL;

CREATE TRIGGER wearable_data_set_updated_at AFTER UPDATE ON wearable_data FOR EACH ROW BEGIN
  UPDATE wearable_data SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- 2. health_sync_state — sync cursor KV. One row per integration key.
-- ----------------------------------------------------------------------------
CREATE TABLE health_sync_state (
  id text PRIMARY KEY NOT NULL,
  key text NOT NULL UNIQUE,
  value text NOT NULL DEFAULT '{}' CHECK (json_valid(value)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER health_sync_state_set_updated_at
AFTER UPDATE ON health_sync_state FOR EACH ROW BEGIN
  UPDATE health_sync_state
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.id;
END;
