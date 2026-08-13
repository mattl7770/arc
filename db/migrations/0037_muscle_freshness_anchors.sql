-- ============================================================================
-- ARC 0037 — muscle freshness the user can correct BY HAND, without the
-- correction rotting
--
-- Owner request, 2026-08-12, off the muscle-freshness screen: *"Add
-- functionality to manually adjust muscle freshness after tapping into the
-- sub-screen"*.
--
-- The model in src/lib/exercise/freshness.ts only knows what was logged: it
-- sums recent sets and decays them. It cannot know about the session done on a
-- borrowed rack and never written down, the mountain hike that wrecked the
-- calves, the day the shoulder simply feels done. The user can. This table is
-- where he says so.
--
-- ── WHY AN ANCHOR AND NOT A FLAG ──
--
-- The naive column is `manual_freshness integer` on a muscle: "quads are 40".
-- It ships in ten minutes and it is wrong within a day, because it never
-- expires. A number asserted on Tuesday is still being displayed on Friday
-- after two leg sessions and three nights of sleep, and the figure is then
-- lying with total confidence. The same failure in a different coat is a
-- boolean "I'm fresh" override, which pins a muscle at 100 forever.
--
-- So a row here is an ANCHOR, not a value: **as of `anchored_at`, this muscle
-- was `freshness` percent recovered.** That is a statement about a MOMENT, and
-- the existing recovery model carries it forward from there exactly as it
-- carries a set forward:
--
--   * the anchor enters the fatigue sum as `FRESH_FULL × (1 − freshness/100)`,
--     decayed by the muscle's own τ over the hours since `anchored_at` — so it
--     recovers on the same clock everything else does;
--   * sets logged BEFORE the anchor are dropped, because the assertion already
--     accounts for them — "the quads are at 40 right now" is a complete
--     statement about the quads right now;
--   * sets logged AFTER it deplete from it normally, so the next real session
--     supersedes the correction without anyone having to clear it;
--   * once `anchored_at` falls out of the freshness lookback window the anchor
--     is ignored outright, which is belt-and-braces: three time constants have
--     passed by then and it contributes ~0 anyway.
--
-- The end state of every anchor, left alone, is therefore the same as the end
-- state of every set: nothing. It cannot accumulate into a permanent lie. It
-- can also be cleared outright, which is the other half of the contract — the
-- screen offers CLEAR whenever a muscle is anchored.
--
-- ── AN ASSERTED NUMBER AND A DERIVED ONE MUST NOT WEAR THE SAME FACE ──
--
-- The standing rule this schema already applies to recipe lines (`resolved_by`,
-- 0034). A freshness reading computed from logged sets and a freshness reading
-- the user typed are different KINDS of claim, and a screen that prints them
-- identically has destroyed the difference. So the row is readable — the ledger
-- prints "set by hand" beside any muscle currently carrying an anchor, and the
-- reading itself says how long ago the assertion was made.
--
-- ── SHAPE ──
--
-- One anchor per muscle: `UNIQUE`, and setting a new one is an UPSERT that
-- re-stamps `anchored_at`. History is deliberately NOT kept. An anchor is a
-- correction to a derived reading, not a log of what happened — the workout log
-- is the log — and a table of superseded corrections would be a data dump
-- nothing reads. (If the Coach ever wants "how often does he override the
-- model", that is a different table with a different reason to exist.)
--
-- No foreign key: `muscle` is ARC's own closed vocabulary, enforced by CHECK
-- the way every other muscle column in the schema is (0011 exercise_muscles).
-- The sixteen values are MUSCLE_ORDER in src/lib/exercise/constants.ts.
--
-- Conventions per CLAUDE.md §9: app-generated v4 UUID text PK declared PRIMARY
-- KEY NOT NULL (src/lib/db/id.ts, SQLite randomblob — Hermes has no crypto);
-- ISO-8601 text timestamps; created_at + updated_at with the AFTER UPDATE
-- trigger (recursive_triggers stays OFF); enum vocabulary as text + CHECK.
--
-- Numbered 0037. The runner is forward-only and silently SKIPS any file at or
-- below a device's user_version, so a number below main's head would never run
-- on the owner's phone. The runner stamps PRAGMA user_version = 37 after
-- applying this file.
--
-- This file was authored as 0036 against a main whose head was 0034, holding
-- 0035 back for work then in flight. Both 0035 (recipe folders) and 0036
-- (progress photos) landed on main while this branch was being written, so it
-- was renumbered on the way in. That is the expected outcome of parallel
-- branches rather than a mistake, and it carries the rule: RESERVING A NUMBER
-- DOES NOT HOLD IT — re-check main's head at MERGE time, not at authoring time.
-- Renumbering is cheap; colliding is not. Two files sharing a number apply in
-- an order nothing defines, and only one of them stamps user_version, so the
-- other is silently skipped forever on any device that has already migrated.
-- ============================================================================

CREATE TABLE muscle_freshness_anchors (
  id text PRIMARY KEY NOT NULL,
  -- One anchor per muscle. A new assertion replaces the old one (UPSERT).
  muscle text NOT NULL UNIQUE CHECK (
    muscle IN (
      'chest', 'front_delts', 'side_delts', 'rear_delts', 'lats', 'upper_back',
      'lower_back', 'traps', 'biceps', 'triceps', 'forearms', 'quads',
      'hamstrings', 'glutes', 'calves', 'abs'
    )
  ),
  -- What the user says the muscle was AT `anchored_at`. 0 = fully spent,
  -- 100 = fully recovered — the same scale the computed ledger prints.
  freshness integer NOT NULL CHECK (freshness >= 0 AND freshness <= 100),
  -- The instant the assertion is about. This is the whole design: the model
  -- decays from here, and sets before it are superseded by it.
  anchored_at text NOT NULL CHECK (
    anchored_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]*'
  ),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER muscle_freshness_anchors_set_updated_at
AFTER UPDATE ON muscle_freshness_anchors FOR EACH ROW BEGIN
  UPDATE muscle_freshness_anchors
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE id = NEW.id;
END;
