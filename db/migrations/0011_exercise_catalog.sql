-- ============================================================================
-- ARC 0011 — exercise catalog: exercises + exercise_muscles (+ seeded core)
--
-- The training sub-app's reference layer (docs/exercise-subapp.md §3). Every
-- logged set can now be attributed to muscles: `exercises` is the movement
-- catalog (name, equipment, movement pattern, how it's logged); its
-- `exercise_muscles` children map each movement to the muscles it works, with
-- a primary/secondary role so per-muscle volume and recovery count fractionally
-- (primary 1.0, secondary 0.5 — the counting method the 2025 Pelland
-- meta-regression found decisively best). Custom exercises the user creates get
-- newId() UUIDs and is_custom = 1; the ~69 seeded core rows use STABLE SLUG ids
-- ('barbell-back-squat') so future catalog-expansion migrations can
-- INSERT OR IGNORE by id and routines/sets that reference them survive re-seeds.
--
-- Numbered 0011: this is the Exercise sub-app window's reserved block (0011-0013,
-- docs/project-status.md). 0005/0006 (Coach), 0007 (Screenings), 0008-0010
-- (Nutrition food-logging) are claimed by other parallel windows; the runner
-- tolerates the numbering gaps until the branches merge — versions must only
-- increase, and migrate.test.mjs asserts user_version = max(version).
--
-- Conventions per CLAUDE.md §9 / 0001_init.sql: text ids PRIMARY KEY NOT NULL
-- (SQLite's PRIMARY KEY alone would accept NULL text ids — the NOT NULL is
-- load-bearing); enum vocabulary as text + CHECK (col IN (...)); JSON as text +
-- CHECK (json_valid); ISO-8601 UTC text timestamps; created_at/updated_at with
-- an AFTER UPDATE trigger on the mutable table (recursive_triggers stays OFF).
-- The exercise_muscles FK relies on PRAGMA foreign_keys = ON, which the client
-- sets on every connection. The runner stamps PRAGMA user_version = 11.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- exercises — one row per distinct movement. `equipment`, `movement_pattern`,
-- `mechanic`, and `logging_type` are the fixed ARC-owned vocabularies (unlike a
-- vendor metric_type, we author the whole catalog, so CHECK enums are right).
-- `logging_type` drives which fields a set row shows (weight×reps vs a timed
-- carry vs a distance/duration cardio row). `movement_pattern` is nullable —
-- pattern is meaningful for compounds (push/pull/hinge/squat…), less so for pure
-- isolation, and NULL is honest there. `aliases` is a JSON array of search
-- synonyms. archived hides a row from pickers without deleting history that
-- points at it.
-- ----------------------------------------------------------------------------
CREATE TABLE exercises (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  aliases text CHECK (aliases IS NULL OR json_valid(aliases)),
  equipment text NOT NULL CHECK (
    equipment IN (
      'barbell', 'dumbbell', 'kettlebell', 'cable', 'machine', 'smith',
      'bodyweight', 'band', 'ez_bar', 'trap_bar', 'plate', 'medicine_ball',
      'suspension', 'bench', 'pullup_bar', 'other'
    )
  ),
  movement_pattern text CHECK (
    movement_pattern IS NULL OR movement_pattern IN (
      'squat', 'hinge', 'lunge', 'push_h', 'push_v', 'pull_h', 'pull_v',
      'carry', 'rotation', 'core', 'locomotion'
    )
  ),
  mechanic text CHECK (mechanic IS NULL OR mechanic IN ('compound', 'isolation')),
  logging_type text NOT NULL CHECK (
    logging_type IN (
      'weight_reps', 'bodyweight_reps', 'weighted_bodyweight',
      'assisted_bodyweight', 'duration', 'weight_duration', 'distance_duration'
    )
  ),
  unilateral integer NOT NULL DEFAULT 0 CHECK (unilateral IN (0, 1)),
  instructions text CHECK (instructions IS NULL OR json_valid(instructions)),
  is_custom integer NOT NULL DEFAULT 0 CHECK (is_custom IN (0, 1)),
  archived integer NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Pickers list live rows by name; custom-vs-seed and pattern filters are common.
CREATE INDEX exercises_active_idx ON exercises (archived, name);
CREATE INDEX exercises_pattern_idx ON exercises (movement_pattern) WHERE movement_pattern IS NOT NULL;

-- ----------------------------------------------------------------------------
-- exercise_muscles — the movement→muscle mapping, one row per (exercise, muscle).
-- role 'primary' (the mover, weight 1.0) or 'secondary' (a synergist, weight
-- 0.5). Append-only reference data: no updated_at (edits replace rows), CASCADE
-- with the exercise (a mapping has no meaning without its movement). The 16
-- muscle vocabulary splits the deltoid heads — front delts saturate from
-- pressing (MEV ~0) while side/rear need direct work (MEV 6-8), so a unified
-- 'shoulders' bucket would make per-muscle volume uncomputable.
-- ----------------------------------------------------------------------------
CREATE TABLE exercise_muscles (
  id text PRIMARY KEY NOT NULL,
  exercise_id text NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  muscle text NOT NULL CHECK (
    muscle IN (
      'chest', 'front_delts', 'side_delts', 'rear_delts', 'lats', 'upper_back',
      'lower_back', 'traps', 'biceps', 'triceps', 'forearms', 'quads',
      'hamstrings', 'glutes', 'calves', 'abs'
    )
  ),
  role text NOT NULL CHECK (role IN ('primary', 'secondary')),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (exercise_id, muscle)
);

CREATE INDEX exercise_muscles_muscle_idx ON exercise_muscles (muscle, role);
CREATE INDEX exercise_muscles_exercise_idx ON exercise_muscles (exercise_id);

-- ----------------------------------------------------------------------------
-- updated_at trigger (exercises only — exercise_muscles is append-only). See
-- 0001_init.sql for why there is no WHEN self-guard.
-- ----------------------------------------------------------------------------
CREATE TRIGGER exercises_set_updated_at AFTER UPDATE ON exercises FOR EACH ROW BEGIN
  UPDATE exercises SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- ============================================================================
-- Seeded core catalog — ~69 curated movements covering all 16 muscle groups,
-- every movement pattern, and the major equipment. Quarried from
-- free-exercise-db (Unlicense / public domain, embeddable with no attribution)
-- and enriched here with movement_pattern / logging_type / unilateral / aliases
-- (fields no open dataset ships). Plain INSERT (not OR IGNORE): a migration runs
-- exactly once under its user_version guard, so these can't double-insert. The
-- custom-exercise escape hatch means this core needs coverage, not exhaustion.
-- ============================================================================
-- Seeded exercise catalog. ids are stable slugs (custom rows use newId UUIDs).
INSERT INTO exercises (id, name, aliases, equipment, movement_pattern, mechanic, logging_type, unilateral) VALUES
('barbell-bench-press','Barbell Bench Press','["Bench Press","Flat Bench"]','barbell','push_h','compound','weight_reps',0),
('incline-barbell-bench-press','Incline Barbell Bench Press','["Incline Bench"]','barbell','push_h','compound','weight_reps',0),
('dumbbell-bench-press','Dumbbell Bench Press','["DB Bench"]','dumbbell','push_h','compound','weight_reps',0),
('incline-dumbbell-press','Incline Dumbbell Press','["Incline DB Press"]','dumbbell','push_h','compound','weight_reps',0),
('machine-chest-press','Machine Chest Press',NULL,'machine','push_h','compound','weight_reps',0),
('cable-fly','Cable Fly','["Cable Crossover"]','cable','push_h','isolation','weight_reps',0),
('dumbbell-fly','Dumbbell Fly','["DB Fly"]','dumbbell','push_h','isolation','weight_reps',0),
('push-up','Push-Up','["Pushup"]','bodyweight','push_h','compound','bodyweight_reps',0),
('chest-dip','Chest Dip','["Dip"]','bodyweight','push_h','compound','weighted_bodyweight',0),
('pull-up','Pull-Up','["Pullup"]','pullup_bar','pull_v','compound','weighted_bodyweight',0),
('chin-up','Chin-Up','["Chinup"]','pullup_bar','pull_v','compound','weighted_bodyweight',0),
('lat-pulldown','Lat Pulldown','["Pulldown"]','cable','pull_v','compound','weight_reps',0),
('barbell-row','Barbell Row','["Bent-Over Row","Pendlay Row"]','barbell','pull_h','compound','weight_reps',0),
('dumbbell-row','Dumbbell Row','["One-Arm Row","DB Row"]','dumbbell','pull_h','compound','weight_reps',1),
('seated-cable-row','Seated Cable Row','["Cable Row"]','cable','pull_h','compound','weight_reps',0),
('machine-row','Machine Row','["Chest-Supported Row"]','machine','pull_h','compound','weight_reps',0),
('face-pull','Face Pull',NULL,'cable','pull_h','isolation','weight_reps',0),
('straight-arm-pulldown','Straight-Arm Pulldown',NULL,'cable','pull_v','isolation','weight_reps',0),
('back-extension','Back Extension','["Hyperextension"]','bodyweight','hinge','isolation','weighted_bodyweight',0),
('barbell-shrug','Barbell Shrug','["Shrug"]','barbell','pull_v','isolation','weight_reps',0),
('dumbbell-shrug','Dumbbell Shrug','["DB Shrug"]','dumbbell','pull_v','isolation','weight_reps',0),
('overhead-press','Overhead Press','["OHP","Military Press","Standing Press"]','barbell','push_v','compound','weight_reps',0),
('dumbbell-shoulder-press','Dumbbell Shoulder Press','["DB Shoulder Press","Seated DB Press"]','dumbbell','push_v','compound','weight_reps',0),
('machine-shoulder-press','Machine Shoulder Press',NULL,'machine','push_v','compound','weight_reps',0),
('lateral-raise','Lateral Raise','["Side Raise","DB Lateral Raise"]','dumbbell','push_v','isolation','weight_reps',0),
('cable-lateral-raise','Cable Lateral Raise',NULL,'cable','push_v','isolation','weight_reps',1),
('reverse-fly','Reverse Fly','["Rear Delt Fly"]','dumbbell','pull_h','isolation','weight_reps',0),
('front-raise','Front Raise',NULL,'dumbbell','push_v','isolation','weight_reps',0),
('barbell-curl','Barbell Curl','["BB Curl"]','barbell','pull_v','isolation','weight_reps',0),
('dumbbell-curl','Dumbbell Curl','["DB Curl"]','dumbbell','pull_v','isolation','weight_reps',0),
('hammer-curl','Hammer Curl',NULL,'dumbbell','pull_v','isolation','weight_reps',0),
('preacher-curl','Preacher Curl',NULL,'ez_bar','pull_v','isolation','weight_reps',0),
('cable-curl','Cable Curl',NULL,'cable','pull_v','isolation','weight_reps',0),
('incline-dumbbell-curl','Incline Dumbbell Curl',NULL,'dumbbell','pull_v','isolation','weight_reps',0),
('close-grip-bench-press','Close-Grip Bench Press','["CGBP"]','barbell','push_h','compound','weight_reps',0),
('triceps-pushdown','Triceps Pushdown','["Cable Pushdown","Rope Pushdown"]','cable','push_v','isolation','weight_reps',0),
('overhead-triceps-extension','Overhead Triceps Extension','["French Press"]','dumbbell','push_v','isolation','weight_reps',0),
('skull-crusher','Skull Crusher','["Lying Triceps Extension"]','ez_bar','push_h','isolation','weight_reps',0),
('triceps-dip','Triceps Dip','["Bench Dip"]','bodyweight','push_v','compound','weighted_bodyweight',0),
('wrist-curl','Wrist Curl',NULL,'dumbbell','pull_v','isolation','weight_reps',0),
('farmers-carry','Farmer’s Carry','["Farmer Walk","Loaded Carry"]','dumbbell','carry','compound','weight_duration',0),
('barbell-back-squat','Barbell Back Squat','["Back Squat","Squat"]','barbell','squat','compound','weight_reps',0),
('front-squat','Front Squat',NULL,'barbell','squat','compound','weight_reps',0),
('leg-press','Leg Press',NULL,'machine','squat','compound','weight_reps',0),
('goblet-squat','Goblet Squat',NULL,'dumbbell','squat','compound','weight_reps',0),
('leg-extension','Leg Extension',NULL,'machine','squat','isolation','weight_reps',0),
('bulgarian-split-squat','Bulgarian Split Squat','["Rear-Foot-Elevated Split Squat"]','dumbbell','lunge','compound','weight_reps',1),
('walking-lunge','Walking Lunge','["Lunge"]','dumbbell','lunge','compound','weight_reps',1),
('hack-squat','Hack Squat',NULL,'machine','squat','compound','weight_reps',0),
('romanian-deadlift','Romanian Deadlift','["RDL"]','barbell','hinge','compound','weight_reps',0),
('lying-leg-curl','Lying Leg Curl','["Leg Curl"]','machine','hinge','isolation','weight_reps',0),
('seated-leg-curl','Seated Leg Curl',NULL,'machine','hinge','isolation','weight_reps',0),
('stiff-leg-deadlift','Stiff-Leg Deadlift','["SLDL"]','barbell','hinge','compound','weight_reps',0),
('conventional-deadlift','Deadlift','["Conventional Deadlift"]','barbell','hinge','compound','weight_reps',0),
('hip-thrust','Hip Thrust','["Barbell Hip Thrust"]','barbell','hinge','compound','weight_reps',0),
('trap-bar-deadlift','Trap Bar Deadlift','["Hex Bar Deadlift"]','trap_bar','hinge','compound','weight_reps',0),
('cable-pull-through','Cable Pull-Through',NULL,'cable','hinge','isolation','weight_reps',0),
('kettlebell-swing','Kettlebell Swing','["KB Swing"]','kettlebell','hinge','compound','weight_reps',0),
('standing-calf-raise','Standing Calf Raise','["Calf Raise"]','machine','squat','isolation','weight_reps',0),
('seated-calf-raise','Seated Calf Raise',NULL,'machine','squat','isolation','weight_reps',0),
('plank','Plank',NULL,'bodyweight','core','isolation','duration',0),
('hanging-leg-raise','Hanging Leg Raise',NULL,'pullup_bar','core','isolation','bodyweight_reps',0),
('cable-crunch','Cable Crunch',NULL,'cable','core','isolation','weight_reps',0),
('ab-wheel-rollout','Ab Wheel Rollout','["Ab Rollout"]','bodyweight','core','isolation','bodyweight_reps',0),
('russian-twist','Russian Twist',NULL,'medicine_ball','rotation','isolation','weight_reps',0),
('treadmill-run','Treadmill Run','["Run","Jog"]','machine','locomotion','compound','distance_duration',0),
('rowing-erg','Rowing Machine','["Erg","Row Erg"]','machine','pull_h','compound','distance_duration',0),
('stationary-bike','Stationary Bike','["Cycling","Bike"]','machine','locomotion','compound','distance_duration',0),
('incline-walk','Incline Walk','["Ruck","Walk"]','machine','locomotion','compound','distance_duration',0);

INSERT INTO exercise_muscles (id, exercise_id, muscle, role) VALUES
('barbell-bench-press__chest','barbell-bench-press','chest','primary'),
('barbell-bench-press__front_delts','barbell-bench-press','front_delts','secondary'),
('barbell-bench-press__triceps','barbell-bench-press','triceps','secondary'),
('incline-barbell-bench-press__chest','incline-barbell-bench-press','chest','primary'),
('incline-barbell-bench-press__front_delts','incline-barbell-bench-press','front_delts','secondary'),
('incline-barbell-bench-press__triceps','incline-barbell-bench-press','triceps','secondary'),
('dumbbell-bench-press__chest','dumbbell-bench-press','chest','primary'),
('dumbbell-bench-press__front_delts','dumbbell-bench-press','front_delts','secondary'),
('dumbbell-bench-press__triceps','dumbbell-bench-press','triceps','secondary'),
('incline-dumbbell-press__chest','incline-dumbbell-press','chest','primary'),
('incline-dumbbell-press__front_delts','incline-dumbbell-press','front_delts','secondary'),
('incline-dumbbell-press__triceps','incline-dumbbell-press','triceps','secondary'),
('machine-chest-press__chest','machine-chest-press','chest','primary'),
('machine-chest-press__front_delts','machine-chest-press','front_delts','secondary'),
('machine-chest-press__triceps','machine-chest-press','triceps','secondary'),
('cable-fly__chest','cable-fly','chest','primary'),
('cable-fly__front_delts','cable-fly','front_delts','secondary'),
('dumbbell-fly__chest','dumbbell-fly','chest','primary'),
('dumbbell-fly__front_delts','dumbbell-fly','front_delts','secondary'),
('push-up__chest','push-up','chest','primary'),
('push-up__front_delts','push-up','front_delts','secondary'),
('push-up__triceps','push-up','triceps','secondary'),
('chest-dip__chest','chest-dip','chest','primary'),
('chest-dip__triceps','chest-dip','triceps','secondary'),
('chest-dip__front_delts','chest-dip','front_delts','secondary'),
('pull-up__lats','pull-up','lats','primary'),
('pull-up__biceps','pull-up','biceps','secondary'),
('pull-up__upper_back','pull-up','upper_back','secondary'),
('chin-up__lats','chin-up','lats','primary'),
('chin-up__biceps','chin-up','biceps','secondary'),
('chin-up__upper_back','chin-up','upper_back','secondary'),
('lat-pulldown__lats','lat-pulldown','lats','primary'),
('lat-pulldown__biceps','lat-pulldown','biceps','secondary'),
('lat-pulldown__upper_back','lat-pulldown','upper_back','secondary'),
('barbell-row__upper_back','barbell-row','upper_back','primary'),
('barbell-row__lats','barbell-row','lats','secondary'),
('barbell-row__biceps','barbell-row','biceps','secondary'),
('barbell-row__rear_delts','barbell-row','rear_delts','secondary'),
('dumbbell-row__upper_back','dumbbell-row','upper_back','primary'),
('dumbbell-row__lats','dumbbell-row','lats','secondary'),
('dumbbell-row__biceps','dumbbell-row','biceps','secondary'),
('seated-cable-row__upper_back','seated-cable-row','upper_back','primary'),
('seated-cable-row__lats','seated-cable-row','lats','secondary'),
('seated-cable-row__biceps','seated-cable-row','biceps','secondary'),
('seated-cable-row__rear_delts','seated-cable-row','rear_delts','secondary'),
('machine-row__upper_back','machine-row','upper_back','primary'),
('machine-row__lats','machine-row','lats','secondary'),
('machine-row__biceps','machine-row','biceps','secondary'),
('face-pull__rear_delts','face-pull','rear_delts','primary'),
('face-pull__upper_back','face-pull','upper_back','secondary'),
('face-pull__traps','face-pull','traps','secondary'),
('straight-arm-pulldown__lats','straight-arm-pulldown','lats','primary'),
('back-extension__lower_back','back-extension','lower_back','primary'),
('back-extension__glutes','back-extension','glutes','secondary'),
('back-extension__hamstrings','back-extension','hamstrings','secondary'),
('barbell-shrug__traps','barbell-shrug','traps','primary'),
('dumbbell-shrug__traps','dumbbell-shrug','traps','primary'),
('overhead-press__front_delts','overhead-press','front_delts','primary'),
('overhead-press__side_delts','overhead-press','side_delts','secondary'),
('overhead-press__triceps','overhead-press','triceps','secondary'),
('dumbbell-shoulder-press__front_delts','dumbbell-shoulder-press','front_delts','primary'),
('dumbbell-shoulder-press__side_delts','dumbbell-shoulder-press','side_delts','secondary'),
('dumbbell-shoulder-press__triceps','dumbbell-shoulder-press','triceps','secondary'),
('machine-shoulder-press__front_delts','machine-shoulder-press','front_delts','primary'),
('machine-shoulder-press__side_delts','machine-shoulder-press','side_delts','secondary'),
('machine-shoulder-press__triceps','machine-shoulder-press','triceps','secondary'),
('lateral-raise__side_delts','lateral-raise','side_delts','primary'),
('cable-lateral-raise__side_delts','cable-lateral-raise','side_delts','primary'),
('reverse-fly__rear_delts','reverse-fly','rear_delts','primary'),
('reverse-fly__upper_back','reverse-fly','upper_back','secondary'),
('front-raise__front_delts','front-raise','front_delts','primary'),
('barbell-curl__biceps','barbell-curl','biceps','primary'),
('barbell-curl__forearms','barbell-curl','forearms','secondary'),
('dumbbell-curl__biceps','dumbbell-curl','biceps','primary'),
('dumbbell-curl__forearms','dumbbell-curl','forearms','secondary'),
('hammer-curl__biceps','hammer-curl','biceps','primary'),
('hammer-curl__forearms','hammer-curl','forearms','secondary'),
('preacher-curl__biceps','preacher-curl','biceps','primary'),
('cable-curl__biceps','cable-curl','biceps','primary'),
('cable-curl__forearms','cable-curl','forearms','secondary'),
('incline-dumbbell-curl__biceps','incline-dumbbell-curl','biceps','primary'),
('close-grip-bench-press__triceps','close-grip-bench-press','triceps','primary'),
('close-grip-bench-press__chest','close-grip-bench-press','chest','secondary'),
('close-grip-bench-press__front_delts','close-grip-bench-press','front_delts','secondary'),
('triceps-pushdown__triceps','triceps-pushdown','triceps','primary'),
('overhead-triceps-extension__triceps','overhead-triceps-extension','triceps','primary'),
('skull-crusher__triceps','skull-crusher','triceps','primary'),
('triceps-dip__triceps','triceps-dip','triceps','primary'),
('triceps-dip__chest','triceps-dip','chest','secondary'),
('triceps-dip__front_delts','triceps-dip','front_delts','secondary'),
('wrist-curl__forearms','wrist-curl','forearms','primary'),
('farmers-carry__forearms','farmers-carry','forearms','primary'),
('farmers-carry__traps','farmers-carry','traps','secondary'),
('farmers-carry__abs','farmers-carry','abs','secondary'),
('farmers-carry__quads','farmers-carry','quads','secondary'),
('barbell-back-squat__quads','barbell-back-squat','quads','primary'),
('barbell-back-squat__glutes','barbell-back-squat','glutes','secondary'),
('barbell-back-squat__hamstrings','barbell-back-squat','hamstrings','secondary'),
('barbell-back-squat__lower_back','barbell-back-squat','lower_back','secondary'),
('front-squat__quads','front-squat','quads','primary'),
('front-squat__glutes','front-squat','glutes','secondary'),
('front-squat__abs','front-squat','abs','secondary'),
('leg-press__quads','leg-press','quads','primary'),
('leg-press__glutes','leg-press','glutes','secondary'),
('leg-press__hamstrings','leg-press','hamstrings','secondary'),
('goblet-squat__quads','goblet-squat','quads','primary'),
('goblet-squat__glutes','goblet-squat','glutes','secondary'),
('leg-extension__quads','leg-extension','quads','primary'),
('bulgarian-split-squat__quads','bulgarian-split-squat','quads','primary'),
('bulgarian-split-squat__glutes','bulgarian-split-squat','glutes','secondary'),
('bulgarian-split-squat__hamstrings','bulgarian-split-squat','hamstrings','secondary'),
('walking-lunge__quads','walking-lunge','quads','primary'),
('walking-lunge__glutes','walking-lunge','glutes','secondary'),
('walking-lunge__hamstrings','walking-lunge','hamstrings','secondary'),
('hack-squat__quads','hack-squat','quads','primary'),
('hack-squat__glutes','hack-squat','glutes','secondary'),
('romanian-deadlift__hamstrings','romanian-deadlift','hamstrings','primary'),
('romanian-deadlift__glutes','romanian-deadlift','glutes','secondary'),
('romanian-deadlift__lower_back','romanian-deadlift','lower_back','secondary'),
('lying-leg-curl__hamstrings','lying-leg-curl','hamstrings','primary'),
('lying-leg-curl__calves','lying-leg-curl','calves','secondary'),
('seated-leg-curl__hamstrings','seated-leg-curl','hamstrings','primary'),
('stiff-leg-deadlift__hamstrings','stiff-leg-deadlift','hamstrings','primary'),
('stiff-leg-deadlift__glutes','stiff-leg-deadlift','glutes','secondary'),
('stiff-leg-deadlift__lower_back','stiff-leg-deadlift','lower_back','secondary'),
('conventional-deadlift__glutes','conventional-deadlift','glutes','primary'),
('conventional-deadlift__hamstrings','conventional-deadlift','hamstrings','secondary'),
('conventional-deadlift__lower_back','conventional-deadlift','lower_back','secondary'),
('conventional-deadlift__upper_back','conventional-deadlift','upper_back','secondary'),
('conventional-deadlift__quads','conventional-deadlift','quads','secondary'),
('hip-thrust__glutes','hip-thrust','glutes','primary'),
('hip-thrust__hamstrings','hip-thrust','hamstrings','secondary'),
('trap-bar-deadlift__glutes','trap-bar-deadlift','glutes','primary'),
('trap-bar-deadlift__quads','trap-bar-deadlift','quads','secondary'),
('trap-bar-deadlift__hamstrings','trap-bar-deadlift','hamstrings','secondary'),
('trap-bar-deadlift__lower_back','trap-bar-deadlift','lower_back','secondary'),
('cable-pull-through__glutes','cable-pull-through','glutes','primary'),
('cable-pull-through__hamstrings','cable-pull-through','hamstrings','secondary'),
('kettlebell-swing__glutes','kettlebell-swing','glutes','primary'),
('kettlebell-swing__hamstrings','kettlebell-swing','hamstrings','secondary'),
('kettlebell-swing__lower_back','kettlebell-swing','lower_back','secondary'),
('standing-calf-raise__calves','standing-calf-raise','calves','primary'),
('seated-calf-raise__calves','seated-calf-raise','calves','primary'),
('plank__abs','plank','abs','primary'),
('hanging-leg-raise__abs','hanging-leg-raise','abs','primary'),
('hanging-leg-raise__forearms','hanging-leg-raise','forearms','secondary'),
('cable-crunch__abs','cable-crunch','abs','primary'),
('ab-wheel-rollout__abs','ab-wheel-rollout','abs','primary'),
('russian-twist__abs','russian-twist','abs','primary'),
('treadmill-run__quads','treadmill-run','quads','primary'),
('treadmill-run__hamstrings','treadmill-run','hamstrings','secondary'),
('treadmill-run__calves','treadmill-run','calves','secondary'),
('treadmill-run__glutes','treadmill-run','glutes','secondary'),
('rowing-erg__upper_back','rowing-erg','upper_back','primary'),
('rowing-erg__lats','rowing-erg','lats','secondary'),
('rowing-erg__quads','rowing-erg','quads','secondary'),
('rowing-erg__hamstrings','rowing-erg','hamstrings','secondary'),
('stationary-bike__quads','stationary-bike','quads','primary'),
('stationary-bike__hamstrings','stationary-bike','hamstrings','secondary'),
('stationary-bike__calves','stationary-bike','calves','secondary'),
('incline-walk__calves','incline-walk','calves','primary'),
('incline-walk__quads','incline-walk','quads','secondary'),
('incline-walk__glutes','incline-walk','glutes','secondary'),
('incline-walk__hamstrings','incline-walk','hamstrings','secondary');
