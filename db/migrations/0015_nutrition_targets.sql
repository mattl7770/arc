-- ============================================================================
-- ARC 0015 — nutrition sub-app: versioned daily targets
--
-- Daily energy + macro targets as APPEND-ONLY, IMMUTABLE rows — the
-- protocol_versions pattern (a target you can edit in place is not a version).
-- The active target set for a day is the newest row whose effective_date is on
-- or before that day, so "was I under target in March?" is answered against
-- March's targets, not today's. Changing targets inserts a new row; nothing is
-- ever updated or deleted, hence created_at only and NO updated_at trigger.
--
-- `created_by` reuses the Authorship vocabulary ('user' | 'ai'): today the
-- owner sets targets in the targets screen; later the Coach proposes new
-- versions from weight trend + intake (MacroFactor-style adaptive math, but
-- proposed and approved, never silently applied), with its reasoning in
-- `notes`. There is deliberately NO seeded default row — the screen shows real
-- denominators or none (docs/nutrition-subapp.md §3).
--
-- Every column of the target set is nullable — a protein-only target is valid —
-- but at least one of the five must be present or the row means nothing.
--
-- Numbered 0015 in the nutrition 0014+ block. Conventions per CLAUDE.md §9:
-- app-generated v4 UUID text PK declared PRIMARY KEY NOT NULL; dates are text
-- 'YYYY-MM-DD' (GLOB-checked); enum vocabulary -> text + CHECK.
-- The migration runner stamps PRAGMA user_version = 15 after applying this file.
-- ============================================================================
CREATE TABLE nutrition_targets (
  id text PRIMARY KEY NOT NULL,
  effective_date text NOT NULL CHECK (effective_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kcal real CHECK (kcal IS NULL OR kcal > 0),
  protein_g real CHECK (protein_g IS NULL OR protein_g >= 0),
  carbs_g real CHECK (carbs_g IS NULL OR carbs_g >= 0),
  fat_g real CHECK (fat_g IS NULL OR fat_g >= 0),
  fiber_g real CHECK (fiber_g IS NULL OR fiber_g >= 0),
  created_by text NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'ai')),
  notes text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- No updated_at — versions are immutable by design (see protocol_versions).
  CHECK (
    kcal IS NOT NULL OR protein_g IS NOT NULL OR carbs_g IS NOT NULL
    OR fat_g IS NOT NULL OR fiber_g IS NOT NULL
  )
);

CREATE INDEX nutrition_targets_date_idx ON nutrition_targets (effective_date DESC, created_at DESC);
