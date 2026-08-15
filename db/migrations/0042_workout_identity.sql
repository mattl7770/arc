-- ============================================================================
-- ARC 0042 — the ingested workout gets a GLOBAL identity, and its duplicates go
--
-- The owner's report: "In the data tab under wearables, there is a workout log
-- that does not work well. It has lots of duplicates."
--
-- 0001 gave every ingested row ONE idempotency key:
--
--     UNIQUE (source_device, source_raw_id) WHERE source_raw_id IS NOT NULL
--
-- That composite is exactly right for the day-bucket rows it was designed for.
-- Their raw id is `hk:<metric>:<date>`, which is the same string for every
-- device reporting that metric that day, so the `source_device` prefix is what
-- keeps a ring's HRV and a watch's HRV as two separate readings for the read
-- side to arbitrate between (`pickDailyMetric`).
--
-- It is the WRONG key for a workout. A workout's `source_raw_id` is the
-- HealthKit sample UUID, which names one object in the HealthKit store — it is
-- already globally unique, and qualifying it by device does not tighten the key,
-- it LOOSENS it: the same UUID under two different `source_device` values
-- becomes two rows describing one session.
--
-- That is not hypothetical. `sourceDeviceFor` (src/lib/health/mapping.ts) buckets
-- on `provenance.bundleId`, and `provenanceOf` (healthkit.ts) yields a NULL
-- bundle id whenever a sample's `sourceRevision` arrives in a shape the seam
-- cannot parse — deliberately, so shape drift degrades instead of throwing. A
-- null bundle falls through to 'other'. Parse the same sample successfully on a
-- later pass and it buckets to 'garmin'. Under the composite key those are two
-- rows, and every flip of the bucket adds another. Keyed on the UUID alone, the
-- second pass is an UPDATE that corrects the label in place.
--
-- ⚠️ The 0001 index is KEPT, not replaced. It still owns every day-bucket row,
-- where per-device separation is the intended behaviour. This migration adds a
-- second, narrower unique index that applies to workouts only. The two never
-- disagree: any (device, uuid) collision is also a (uuid) collision, and the
-- repository's workout upsert names the new index as its conflict target and
-- rewrites `source_device` in the DO UPDATE, so resolving through it always
-- leaves the composite index satisfied too.
--
-- ## The cleanup must be safe on a populated device
--
-- CREATE UNIQUE INDEX fails outright if the table already violates it, and this
-- file is wrapped in the runner's transaction — so a failure here rolls back and
-- the device is stuck at 41 forever. The DELETE below therefore runs FIRST and
-- must be exhaustive.
--
-- Which duplicate survives is decided by the same SOURCE_PRIORITY order the read
-- side arbitrates with (src/lib/db/repositories/wearables.ts), so the row that
-- is kept is the row the UI would have chosen anyway; `created_at, id` breaks
-- ties deterministically, so re-running on identical data is a no-op. Losing a
-- duplicate destroys nothing: these rows are an ingested mirror of the HealthKit
-- store, and the next sync re-derives anything wrongly dropped from the source
-- of truth on the phone. (This is the exception the "never destroy execution
-- history" rule allows for, and it is worth stating why: sessions logged IN ARC
-- live in `workouts`/`workout_sets`, which this file does not touch.)
--
-- In practice the DELETE is expected to affect ZERO rows on the owner's device:
-- the HealthKit native module is not in the current binary, so no workout has
-- ever been ingested. It is written for correctness after the pending EAS build,
-- not for a cleanup anyone can observe today.
--
-- ## Numbering — 0042, and why not 0039
--
-- Forward-only: `pendingMigrations` filters `version > user_version`, so a file
-- numbered at or below a device's stamp is skipped SILENTLY, with no error and
-- no tables. This branch was briefed to take 0039, but 0039 was already taken by
-- the reports migration and merged to `main` before this work started (0038 is
-- knowledge entries), and 0040/0041 are reserved by branches running in
-- parallel. 0042 is the first number that collides with nothing.
--
-- Conventions per CLAUDE.md §9. No new table, no new column — an index and a
-- delete — so there is no id/timestamp/trigger surface here.
-- The migration runner stamps PRAGMA user_version = 42 after applying this file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Collapse existing duplicates, keeping the best-sourced row per UUID.
-- ----------------------------------------------------------------------------
DELETE FROM wearable_data
WHERE metric_type = 'workout'
  AND source_raw_id IS NOT NULL
  AND id NOT IN (
    SELECT keeper.id FROM (
      SELECT
        id,
        row_number() OVER (
          PARTITION BY source_raw_id
          ORDER BY
            -- SOURCE_PRIORITY, verbatim. 'other' stays ABOVE 'apple_health' and
            -- 'manual': no wearable is chosen yet (CLAUDE.md §8), so an
            -- unrecognised device legitimately lands there and must not lose to
            -- a merged total or a keypad entry.
            CASE source_device
              WHEN 'apple_watch'  THEN 0
              WHEN 'oura'         THEN 1
              WHEN 'whoop'        THEN 2
              WHEN 'ultrahuman'   THEN 3
              WHEN 'garmin'       THEN 4
              WHEN 'eight_sleep'  THEN 5
              WHEN 'withings'     THEN 6
              WHEN 'other'        THEN 7
              WHEN 'apple_health' THEN 8
              WHEN 'manual'       THEN 9
              ELSE 10
            END,
            created_at,
            id
        ) AS rn
      FROM wearable_data
      WHERE metric_type = 'workout' AND source_raw_id IS NOT NULL
    ) AS keeper
    WHERE keeper.rn = 1
  );

-- ----------------------------------------------------------------------------
-- 2. The UUID is the key. Partial, so day-bucket rows are untouched by it.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX wearable_data_workout_uuid_key
  ON wearable_data (source_raw_id)
  WHERE metric_type = 'workout' AND source_raw_id IS NOT NULL;
