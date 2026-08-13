-- ============================================================================
-- ARC 0039 — reports: the self-review and the doctor-visit pack, as records
--
-- docs/reports-subapp.md §5. A report is a DOCUMENT ASSEMBLED FOR A READER,
-- which is what separates it from the whole-database export (Settings ›
-- Security & data) and from the encrypted backup. This table is what makes it a
-- record rather than a transient render.
--
-- WHY PERSIST AT ALL, when every number is deterministically re-derivable?
-- Because it is not, and the reason is the whole point:
--
--   1. **"What did the doctor actually see?" must be answerable forever.** You
--      hand a pack over on 12 August; on 3 September you re-import a lab PDF
--      with a corrected value, or fix a mis-dated meal. Re-assembling "the
--      August pack" then produces a document that has never existed, and the
--      conversation you had with your physician becomes unreconstructable.
--   2. Deterministic regeneration drifts the moment ANY correction lands —
--      an edited workout, a deleted protocol, a re-synced night of sleep.
--
-- So: file + row, the `lab_reports` precedent. `data_json` is the full
-- serialized `ReportData` — the reproducible snapshot, playing exactly the role
-- `lab_reports.raw_extracted_json` plays for a parse. **History re-renders FROM
-- data_json; it never re-assembles.** "Share again" re-runs the renderer over
-- the snapshot and re-creates the file, so a report survives its own file being
-- deleted from Documents.
--
-- `narrative_text` IS DELIBERATELY A SEPARATE COLUMN, not a key inside
-- data_json. The Coach's read (spec §6a) is the one place a language model may
-- write into a report, and the deterministic snapshot must never carry model
-- text: if it lived in the JSON, then every re-render, every export, and every
-- future consumer of that blob would treat generated prose as part of the
-- computed record. The column boundary is the guarantee, and db/reports.test.mjs
-- asserts data_json never contains it. NULL is the ordinary case — the read is
-- opt-in per report (⚑ MATT #5, decided 2026-08-12), and the doctor pack can
-- never have one at all (`renderDoctorPack` takes no narrative parameter).
--
-- FILE PATH, not a bare name: this follows `lab_reports.file_path` (a
-- Documents-relative reference) rather than 0033's name-only column, because a
-- report file is regenerable from `data_json` — a dangling reference after an
-- iOS container-UUID change costs a re-render, not data. `file_name` is stored
-- alongside so history can show what was shared without parsing the path.
--
-- ALL COLUMNS ARE SCALARS, so this table rides the existing whole-database
-- export automatically (src/lib/export/serializer.ts enumerates sqlite_master
-- and asserts every value JSON-safe). Reports are themselves owned data; that
-- they export without a line of new code is a property of the generic
-- serializer, and db/reports.test.mjs pins it.
--
-- Numbered 0039 — the file's THIRD number. It was 0035 for most of the build
-- (main's head was 0034 at branch time), re-measured mid-build to 0036 when the
-- folders round took 0035, and main then took 0036 (progress photos) and 0037
-- (freshness anchors) too, with 0038 (knowledge) merging just ahead of this —
-- so it landed as 0039 at merge. The original note said main's head was 0034
-- when this branch was cut; `0035_recipe_folders.sql` landed on main while
-- Reports was being written, so this file was RE-MEASURED at merge time and
-- moved up — which is the whole discipline, not an accident.
--
-- ⚠️ A migration numbered at or below a device's `PRAGMA user_version` is
-- SKIPPED SILENTLY: it would never run, on a device that already passed that
-- number, with no error anywhere. So never fill a gap and never renumber
-- downward (docs/project-status.md, Known caveats). Run `npm run db:bundle`
-- after touching this file.
--
-- Conventions per CLAUDE.md §9 / 0001_init.sql: app-generated v4 UUID text PK
-- declared PRIMARY KEY NOT NULL (SQLite's PRIMARY KEY alone permits NULLs on a
-- text key); dates as text 'YYYY-MM-DD' (GLOB-checked); enum vocabulary as text
-- + CHECK; JSON as text + json_valid CHECK; ISO-8601 created_at/updated_at with
-- an AFTER UPDATE trigger (recursive_triggers stays OFF).
-- ============================================================================
CREATE TABLE reports (
  id text PRIMARY KEY NOT NULL,
  report_type text NOT NULL CHECK (report_type IN ('self_review', 'doctor_pack')),
  -- Both NULL for a doctor pack, which is point-in-time rather than periodic.
  -- Paired: a report either has a period or has none, never half of one.
  period_start text CHECK (
    period_start IS NULL
    OR period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  period_end text CHECK (
    period_end IS NULL
    OR period_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  generated_at text NOT NULL,
  file_name text NOT NULL,
  -- Relative to the app's Documents directory (the export precedent).
  file_path text NOT NULL,
  -- The full serialized ReportData — the reproducible snapshot. See the header.
  data_json text NOT NULL CHECK (json_valid(data_json)),
  -- The attributed model prose, when the user added it. Stored APART from
  -- data_json on purpose — see the header.
  narrative_text text,
  app_version text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- A period is both bounds or neither. Half a period would render a heading
  -- with a missing end date and would make the history list's ordering by
  -- period ambiguous.
  CHECK (
    (period_start IS NULL AND period_end IS NULL)
    OR (period_start IS NOT NULL AND period_end IS NOT NULL AND period_start <= period_end)
  ),
  -- A doctor pack is point-in-time BY DEFINITION (spec §3b). Enforcing it here
  -- rather than trusting the writer means the invariant survives a future
  -- caller that has not read the spec.
  CHECK (report_type != 'doctor_pack' OR period_start IS NULL)
);

CREATE INDEX reports_generated_idx ON reports (generated_at DESC);

CREATE TRIGGER reports_set_updated_at AFTER UPDATE ON reports FOR EACH ROW BEGIN
  UPDATE reports SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
