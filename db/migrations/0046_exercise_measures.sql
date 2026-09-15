-- ============================================================================
-- ARC 0046 — an exercise declares what it MEASURES (reps · load · time · distance)
--
-- Owner, 2026-09-14 (backlog B1): *"Distance instead of reps for running
-- workouts, etc."* and *"time for some exercises i.e. planks and running
-- instead of reps."* Every set in ARC has been reps × load since 0003. A run is
-- time AND distance; a plank is time; a farmer's carry is load + distance. The
-- logger asked for reps on a plank and had nowhere to put five kilometres.
--
-- ── WHY A NEW COLUMN AND NOT `logging_type` ──
--
-- `exercises.logging_type` (0011) already sorts movements into seven buckets
-- and three of them are exactly this question ('duration', 'weight_duration',
-- 'distance_duration'). It is NOT enough, for three reasons:
--
--   1. It cannot say load + time + distance, or distance alone. Its vocabulary
--      is a CHECK'd enum, and adding a value to a CHECK in SQLite is the
--      twelve-step table rebuild — on `exercises`, the parent of two live
--      foreign keys (`exercise_muscles`, `workout_sets.exercise_id`) and of the
--      owner's whole training history. That rebuild is exactly the manoeuvre
--      src/lib/db/repositories/exercise.ts refuses for `workouts.name`.
--   2. `logging_type` is a GUESS on every row the app writes itself: the
--      picker's New-exercise form derives it from equipment alone
--      (bodyweight → 'bodyweight_reps', else 'weight_reps'), so a custom
--      "Running" or "Side Plank" is stored as a reps×load lift. The backfill
--      below CORRECTS those by name, and a correction has to persist — it
--      cannot be re-derived at read time from the value that was wrong.
--   3. D3 (HealthKit-ingested workouts) needs to declare measures for movements
--      that have no logging_type opinion at all.
--
-- So `measures` supersedes `logging_type` as the authority for WHAT A SET
-- CARRIES. `logging_type` is kept — it still distinguishes bodyweight from
-- weighted from assisted, which `measures` deliberately does not — and remains
-- what the AI-search and picker forms author; `measures` is derived from it on
-- write (src/lib/exercise/measures.ts) so the two can never drift.
--
-- ── WHY A CHECK'd TEXT AND NOT JSON ──
--
-- CLAUDE.md §9: enum vocabulary → text + CHECK; vendor vocabulary → free text.
-- This vocabulary is entirely ARC's, so it takes the CHECK. A JSON array would
-- need `json_valid` and would still admit `["reps","reps"]`, `["foo"]`, and
-- `["load","reps"]` — three spellings of two facts, which is how a JSON column
-- becomes an un-queryable free-text column.
--
-- The value is the canonical, comma-joined subset in the fixed order
-- reps,load,time,distance. The CHECK enumerates ALL FIFTEEN non-empty subsets,
-- and that totality is the point: the domain is closed at four measures, so no
-- future migration can ever need a sixteenth value and this CHECK can never
-- become the rebuild that (1) above rejects.
--
-- ── WHAT IS *NOT* HERE: the cross-table rule ──
--
-- "A set carries the fields its exercise implies" (no reps on a plank) is a
-- REPOSITORY responsibility — `insertSet` nulls what the exercise does not
-- measure. It is deliberately not a CHECK, and 0034 is why: a cross-column
-- CHECK passes on an empty test fixture and then rejects the ALTER on a
-- populated device, where the rows that violate it are the user's own history
-- and there is no second copy to restore from.
--
-- ── BACKFILL ──
--
-- Pass 1 derives `measures` from `logging_type` for every existing row (the
-- shipped catalog's plank, treadmill run, rowing erg, stationary bike and
-- incline walk all land correctly). Passes 2–4 then correct rows BY NAME, which
-- is what reaches the custom exercises the picker mis-typed. An append-only
-- UPDATE inside a migration is legal — it runs exactly once under the runner's
-- user_version guard.
--
-- Numbered 0046: main's head is 0045 (workout_drafts); 0047 is reserved by B2
-- (the `ml` unit) running in parallel. The runner SILENTLY SKIPS any number at
-- or below a device's `PRAGMA user_version`, so a collision strands a migration
-- forever — re-check `git ls-tree main -- db/migrations/` before merging.
-- Conventions per CLAUDE.md §9 / 0001_init.sql. Run `npm run db:bundle` after
-- this file changes.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- exercises.measures — what a set of this movement records.
--
-- NOT NULL with a default, because an ALTER-added NOT NULL column must carry a
-- non-NULL default in SQLite; 'reps,load' is the right one because it is what
-- every row in the table meant before this migration existed, and it is what a
-- row inserted by a build that predates the write-side change would have meant.
-- ----------------------------------------------------------------------------
ALTER TABLE exercises ADD COLUMN measures text NOT NULL DEFAULT 'reps,load' CHECK (
  measures IN (
    'reps',
    'load',
    'time',
    'distance',
    'reps,load',
    'reps,time',
    'reps,distance',
    'load,time',
    'load,distance',
    'time,distance',
    'reps,load,time',
    'reps,load,distance',
    'reps,time,distance',
    'load,time,distance',
    'reps,load,time,distance'
  )
);

-- ----------------------------------------------------------------------------
-- workout_sets.distance_m — metres, the canonical distance unit, matching how
-- weight is canonical kg (0003) so the km/mi display toggle is never a
-- migration. Nullable: only a distance-measuring movement fills it.
--
-- The upper bound is the schema's usual manual-magnitude guard: under a million
-- metres. Nothing a human logs as ONE SET is 1,000 km, and a fat-fingered
-- "50000" for a 5 km run should land as an obviously-wrong number the user can
-- see and fix, not be rejected — the bound exists to stop a stray keypress from
-- poisoning a pace average, not to police the value.
--
-- `duration_sec` already exists (0013) with its own < 36000 s bound; timed sets
-- had a column and no UI. They have both now.
-- ----------------------------------------------------------------------------
ALTER TABLE workout_sets ADD COLUMN distance_m real
  CHECK (distance_m IS NULL OR (distance_m >= 0 AND distance_m < 1000000));

-- ----------------------------------------------------------------------------
-- Pass 1 — derive from logging_type. Total over the enum, so every row is
-- touched and nothing is left on the ALTER default by accident.
--
--   weight_reps / weighted_bodyweight / assisted_bodyweight → reps,load
--   bodyweight_reps                                          → reps
--   duration                                                 → time
--   weight_duration                                          → load,time
--   distance_duration                                        → time,distance
--
-- weighted/assisted bodyweight collapse to reps,load on purpose: the DIFFERENCE
-- between them (is the load added or subtracted) is what `logging_type` is
-- still for, and duplicating it here would be two columns to disagree later.
-- ----------------------------------------------------------------------------
UPDATE exercises SET measures = CASE logging_type
  WHEN 'weight_reps' THEN 'reps,load'
  WHEN 'weighted_bodyweight' THEN 'reps,load'
  WHEN 'assisted_bodyweight' THEN 'reps,load'
  WHEN 'bodyweight_reps' THEN 'reps'
  WHEN 'duration' THEN 'time'
  WHEN 'weight_duration' THEN 'load,time'
  WHEN 'distance_duration' THEN 'time,distance'
  ELSE 'reps,load'
END;

-- ----------------------------------------------------------------------------
-- Pass 2 — HOLDS: time only. Reaches a custom "Side Plank" the picker stored as
-- a reps×load lift. Guarded to rows still reading reps-ish, so a movement the
-- catalog already types correctly is never re-decided by a name.
-- ----------------------------------------------------------------------------
UPDATE exercises SET measures = 'time'
WHERE measures IN ('reps', 'reps,load')
  AND (
    lower(name) GLOB '*plank*'
    OR lower(name) GLOB '*wall sit*'
    OR lower(name) GLOB '*dead hang*'
    OR lower(name) GLOB '*hollow hold*'
  );

-- ----------------------------------------------------------------------------
-- Pass 3 — ENDURANCE: time + distance. Running, cycling, rowing, swimming,
-- walking, hiking, rucking, the elliptical.
--
-- Three traps, all real:
--   * '*run*' matches "t-RUN-k rotation", so 'run' is anchored to a word
--     boundary ('run*' at the start, '* run*' after a space) instead.
--   * '*row*' would swallow Barbell Row, Dumbbell Row, Seated Cable Row and
--     Machine Row — four of the seeded catalog's most-used lifts. Only the
--     unambiguous 'rowing' / 'erg' spellings are matched.
--   * '*walk*' catches Walking Lunge, which is a reps×load lift; excluded.
-- ----------------------------------------------------------------------------
UPDATE exercises SET measures = 'time,distance'
WHERE measures IN ('reps', 'reps,load')
  AND (
    lower(name) GLOB 'run*'
    OR lower(name) GLOB '* run*'
    OR lower(name) GLOB '*jog*'
    OR lower(name) GLOB '*sprint*'
    OR lower(name) GLOB '*treadmill*'
    OR lower(name) GLOB '*cycl*'
    OR lower(name) GLOB '*bike*'
    OR lower(name) GLOB '*rowing*'
    OR lower(name) GLOB '*erg*'
    OR lower(name) GLOB '*swim*'
    OR lower(name) GLOB '*elliptical*'
    OR lower(name) GLOB '*hike*'
    OR lower(name) GLOB '*hiking*'
    OR lower(name) GLOB '*ruck*'
    OR (lower(name) GLOB '*walk*' AND lower(name) NOT GLOB '*lunge*')
  );

-- ----------------------------------------------------------------------------
-- Pass 4 — LOADED TRAVEL: load + distance. The owner's own framing: *"a
-- farmer's carry is load + distance"*.
--
-- The guard includes 'load,time' — which is where pass 1 puts the seeded
-- `farmers-carry` (logging_type 'weight_duration') — so the shipped carry is
-- corrected here rather than by an id special case. Nothing is lost by dropping
-- `time` from a carry: `duration_sec` has existed since 0013 and NO screen has
-- ever written it (the live logger's WEIGHT_LOGGING set showed weight and reps
-- for a weight_duration movement and never a clock), so there is not one timed
-- carry in any device's history to orphan.
--
-- A weighted plank — 'load,time' from pass 1, matching no name here — keeps its
-- clock, which is the case this guard is careful for.
-- ----------------------------------------------------------------------------
UPDATE exercises SET measures = 'load,distance'
WHERE measures IN ('reps', 'reps,load', 'load,time')
  AND (
    lower(name) GLOB '*farmer*'
    OR lower(name) GLOB '*carry*'
    OR lower(name) GLOB '*sled*'
    OR lower(name) GLOB '*yoke*'
  );
