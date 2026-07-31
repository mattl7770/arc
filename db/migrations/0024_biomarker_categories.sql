-- ============================================================================
-- ARC 0024 — widen biomarkers.category for the labs pipeline
--
-- Adds 'microbiome' and 'biological_age' to the category vocabulary. Today's
-- 11-value enum (0001) can store neither, which is the tracked "Lab breadth"
-- gap in docs/project-status.md: a Function Health report prints a biological
-- age, and the microbiome add-on panel has nowhere to land. Everything else on
-- a comprehensive US panel maps onto the existing values (liver/kidney/urine →
-- organ, thyroid/sex hormones → hormone, heavy metals → toxin), so the enum
-- grows by exactly two — see docs/labs-subapp.md §2.
--
-- Numbered 0024: 0019 is reserved for RAG and 0021–0023 for wearables.
-- The runner stamps PRAGMA user_version = 24.
--
-- ----------------------------------------------------------------------------
-- WHY THIS IS A TABLE REBUILD, AND WHY IT SHUTTLES lab_results
-- ----------------------------------------------------------------------------
-- SQLite cannot ALTER a CHECK constraint, so the table must be rebuilt. The
-- usual recipe ("PRAGMA foreign_keys = OFF, rebuild, turn it back on") is NOT
-- available here: the migration runner wraps every migration in a transaction
-- (src/lib/db/migrate.ts), and `PRAGMA foreign_keys` is a documented no-op
-- inside one. `biomarkers` is a parent table — lab_results.biomarker_id
-- references it ON DELETE RESTRICT — and with FK enforcement stuck ON, a
-- DROP TABLE fires an implicit DELETE of every parent row, which RESTRICT
-- rejects the moment a single lab_results row exists.
--
-- Three approaches were tried against real SQLite (3.51) before this one:
--
--   * `PRAGMA legacy_alter_table = ON` then RENAME the old table aside.
--     REJECTED: the pragma takes effect, but SQLite rewrites a child's
--     REFERENCES clause on RENAME whenever foreign_keys is ON regardless of
--     legacy_alter_table — lab_results ends up pointing at `biomarkers_old`,
--     and dropping that table then fails exactly as before.
--
--   * `PRAGMA defer_foreign_keys = ON` (which, unlike foreign_keys, IS honored
--     inside a transaction). REJECTED, and it is a TRAP: every statement
--     succeeds, including the DROP — and then COMMIT fails with "FOREIGN KEY
--     constraint failed", because the deferred-violation counter incremented by
--     the implicit DELETE is never decremented by re-inserting the same ids into
--     a different table. A later `PRAGMA foreign_key_check` reports clean, so
--     the failure looks unexplainable. The transaction stays open and the
--     runner's ROLLBACK is what saves the database.
--
--   * Shuttling the child rows out and back — what this migration does, and the
--     only one of the three that commits. With lab_results momentarily empty,
--     `biomarkers` has no children, so the implicit DELETE behind DROP TABLE
--     violates nothing.
--
-- Verified end to end in db/labs.test.mjs: rows, ids, timestamps, the FK, the
-- RESTRICT semantics, the updated_at trigger, and `PRAGMA foreign_key_check`
-- all survive, with lab_results non-empty across the rebuild.
--
-- As of 0023, `lab_results` is the ONLY table referencing `biomarkers` — if that
-- ever stops being true, a future rebuild must shuttle the new child too.
-- ============================================================================

-- 1. Park the children. A plain table (not TEMP): the runner's transaction
--    rolls it away on any failure, and TEMP tables live in a separate database
--    whose interaction with that rollback is one more thing to reason about.
CREATE TABLE _rebuild_lab_results AS
  SELECT id, biomarker_id, report_id, value, collected_at, lab_name, source,
         notes, created_at, updated_at
  FROM lab_results;

DELETE FROM lab_results;

-- 2. The new parent — identical to 0001's `biomarkers` except for the two added
--    category values. Kept column-for-column so the copy below is total.
CREATE TABLE biomarkers_new (
  id text PRIMARY KEY NOT NULL,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'other' CHECK (
    category IN (
      'cardiovascular', 'metabolic', 'hormone', 'inflammation', 'nutrient',
      'organ', 'immune', 'hematology', 'cancer', 'toxin', 'microbiome',
      'biological_age', 'other'
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

-- 3. Carry every row over verbatim, timestamps included — ids must not change
--    (lab_results.biomarker_id points at them and is about to be restored).
INSERT INTO biomarkers_new (
  id, slug, name, category, unit, description, optimal_range_low,
  optimal_range_high, standard_range_low, standard_range_high,
  higher_is_better, notes, created_at, updated_at
)
SELECT id, slug, name, category, unit, description, optimal_range_low,
       optimal_range_high, standard_range_low, standard_range_high,
       higher_is_better, notes, created_at, updated_at
FROM biomarkers;

-- 4. Swap. The DROP also takes 0001's biomarkers_category_idx and the
--    biomarkers_set_updated_at trigger with it, so both are recreated below.
--    The RENAME touches no REFERENCES clause: nothing references the
--    `biomarkers_new` name.
DROP TABLE biomarkers;
ALTER TABLE biomarkers_new RENAME TO biomarkers;

-- 5. Put the children back and clear the shuttle. This re-validates every FK
--    against the rebuilt parent, so a lost id would fail loudly right here.
INSERT INTO lab_results (
  id, biomarker_id, report_id, value, collected_at, lab_name, source, notes,
  created_at, updated_at
)
SELECT id, biomarker_id, report_id, value, collected_at, lab_name, source,
       notes, created_at, updated_at
FROM _rebuild_lab_results;

DROP TABLE _rebuild_lab_results;

-- 6. Restore what the DROP removed (see 0001 for why the trigger has no WHEN
--    self-guard — it relies on recursive_triggers staying OFF).
CREATE INDEX biomarkers_category_idx ON biomarkers (category);

CREATE TRIGGER biomarkers_set_updated_at AFTER UPDATE ON biomarkers FOR EACH ROW BEGIN
  UPDATE biomarkers SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
