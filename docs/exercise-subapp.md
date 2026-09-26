# Exercise Sub-App — Design Spec

**Status:** Phase 11 (2026-09-23) — **what a weight counts, and how a lift is trending** (§15, migration **0062**): every loaded movement says whether its figure is total, per hand, per side, the stack, or load added to bodyweight, and the owner can correct it; records, best at each rep count, a switchable per-session trend, a direction of travel, PR stamps for every record kind, and a Train-hub list of every exercise trained. Phase 10 the same day — **leaving keeps a session; its minutes and exercise order are editable** (§14, no migration). Earlier: Phase 6 — **an exercise declares what it measures** (backlog B1, migration **0046**): reps · load · time · distance per movement, so a plank is logged as a hold and a run as a time and a distance. Phase 5 before it: the live session survives the app being killed (**0045**) and exercise search tolerates how people actually type. Phase 4: body-figure freshness diagram, photo workout import (AI), saved workouts (programs retired), in-session exercise detail with bundled photos, the superset "bind" animation, and AI exercise search. AI features run through the Coach's model client and always land in an editable review; everything else stays offline.
**Last updated:** 2026-09-23
**Window:** parallel build, migrations **0011–0013** + **0020** + **0045** + **0046** + **0054–0056** + **0062**
**Reads:** CLAUDE.md §4/§9 · `docs/information-architecture.md` · `docs/project-status.md` ("exercise as measured data") · `db/migrations/0003_exercise.sql` · `docs/backlog-2026-09.md` (A1, A7, B1)

> **Phase 11 shipped (2026-09-23) — two owner notes from the device.**
>
> *"indicate whether weight is per arm, total, etc. for different exercises"* — every loaded movement now says what its figure counts (total · per hand · per side · stack · added to bodyweight · assisted), derived from the catalog by one pure function and correctable per exercise; only the owner's correction is stored (`exercises.load_basis`, **0062**). Records, trends and the PR stamp stay in the logged basis — nothing is doubled — and the Coach reads the basis in its payloads. *"trends, prs, etc for exercises (i.e. fitbod)"* — best at each rep count, session volume and rep records, a switchable per-session trend with a direction of travel, a PR stamp for every record kind that names what it beat, PR marks in history, and an **Exercises** list on the Train hub. **§15** is the whole decision, including the Fitbod audit.

> **Phase 10 (2026-09-23) — three owner notes from the device, no migration.** Leaving either logger no longer discards the session: it is kept exactly as an iOS kill keeps it, from its first exercise, with a Discard control of its own and one row on Home as the way back. A logged session's **duration is a field**; a live session's **start** moves in five-minute steps. Exercises **reorder** in an Order mode, where a superset moves as one. **§14** is the whole record, including the table of every way out of an open session.

> **Phase 6 shipped (2026-09-14) — backlog B1, the last Phase B foundation.**
>
> **An exercise declares what a set of it records.** Owner: *"Distance instead of reps for running workouts, etc."* and *"time for some exercises i.e. planks and running instead of reps."* `exercises.measures` (**0046**) is a CHECK'd subset of `reps · load · time · distance`; `workout_sets` gains `distance_m` beside the `duration_sec` 0013 already had. The loggers draw the columns the movement asks for, the freshness model doses endurance work by the clock (a 45-minute run reads quads 57, not 88), e1RM and progression stay confined to load × reps, and time and distance get records of their own. The draft version went 1 → 2, so any in-flight draft evaporates. **§10** is the whole decision.

> **Phase 5 shipped (2026-09-14) — two backlog items, A1 and A7.**
>
> **A1 — an unfinished workout can no longer be lost.** Owner: *"losing workout information when closing app mid workout, necessary for fixing when app bugs."* The live logger held the session in React state, so a memory kill, a crash or a bad build took it with it — and ARC data has exactly one copy. Every change now writes through to **`workout_drafts`** (0045) as it happens, and the hub offers **Session in progress → Resume**. See §3 (0045) and §9 for the decision, what survives, and what deliberately does not.
>
> **A7 — search tolerates how people actually type.** Owner: *"more intelligent search for exercises, i.e. common misspellings, alternative names."* One matcher (`src/lib/exercise/match.ts`) now serves both the picker's search field and `resolveExerciseByName`: exact → alias → prefix → contains → fuzzy, with bounded Damerau-Levenshtein (transposition = one edit) and a "squashed" folding that joins split or run-together words. "bnech press", "sqaut", "skullcrusher", "pull-downs" and "lying tricep extension" all land. The resolver keeps its confidence discipline unchanged — a bare "Press" still resolves to nothing, pinned in `db/coach-tools.test.mjs` §27 and `db/exercise-catalog.test.mjs` §8. No new dependency; the alias source is the existing `exercises.aliases` JSON column, so **no migration for A7**.

> **Phase 4 shipped (2026-08-11) — six owner asks.**
>
> 1. **Muscle freshness is a body figure** — front + back print-schematic (pure Views on a 100×220 region grid, `src/lib/exercise/figure.ts` + `muscle-figure.tsx`; no SVG dep). Cells stay quiet paper while fresh and take a signal-ink fill only as they deplete. Tapping the figure pushes **`app/muscle-freshness.tsx`** — the full per-muscle bar ledger the hub used to show inline.
> 2. **Photo workout import** — hub "Manual log" (renamed from Quick log) gains "Import from a photo of another app": `app/workout-import.tsx` picks a screenshot (**expo-image-picker — a native dep then; in the owner’s binary since the 2026-08-25 rebuild**), `src/lib/exercise/import-workout.ts` transcribes it through the Coach's `runCoachTurn` (vision), grounds names to the catalog, and lands an **editable review** (date backdatable, every set editable, unit cycling) → `logWorkout`. Backdated fatigue is attributed to the workout's own date at local noon (`attributedInstant` in training-stats), so an imported last-week session reads recovered, not just-trained.
> 3. **Saved workouts replace routines + programs** (owner call): one flat list of reusable sessions, loaded pre-filled. The `routines` tables carry them (UI renamed); **programs are retired** — `app/program-edit.tsx`, the programs repo/tests and the recommender's schedule branch are deleted, the 0020 tables stay in the schema dormant, and `ProgramContext`/the `rest` arm stay in the Recommendation type for the Coach's read tool (dormant). `buildRecommendation`'s signature and result shape are unchanged. The Train-today stamp now carries **two doors: Start recommended + Start empty**.
> 4. **In-session exercise detail** — the exercise title on every live-logger block pushes `app/exercise-detail.tsx`, which now opens with **how the movement looks** (bundled public-domain demo photo, `assets/exercises/` + `images.generated.ts` — 69 frames, ~4.4 MB, matched from free-exercise-db) beside the **muscles-worked schematic** (figure in highlight mode), above records/trend/history.
> 5. **The superset "bind"** — linking two exercises makes them one object: the lower plate springs up until the facing borders fuse into a single shared rule, and a SUPERSET seam chip stamps into the joint (Reanimated layout spring + ZoomIn; tap the seam to split). Replaces the static label; awaiting owner review on device.
> 6. ~~**AI exercise search**~~ — the picker's third door ("Find with AI"), one model turn resolving the user's words against the catalog index. **Retired 2026-09-14 by C12** (§13): searching the catalog is the matcher's job, and the model now writes the ENTRY for a movement the catalog lacks. `src/lib/exercise/ai-search.ts` is deleted; its review-card discipline and `NewExercise.instructions` survive in `ai-add.ts`.
>
> 31 new headless tests (`db/exercise-ai.test.mjs`: figure completeness, import parse/ground, backdated attribution, search parse/vetting, instructions); `db/training-volume.test.mjs` rewritten without programs (volumeScale coverage added); `db/programs.test.mjs` deleted.

> **Phase 3 (2026-07-27, largely superseded by Phase 4's owner round).** Programs / periodization (migration **0020**, tables now dormant), weekly volume vs MEV/MAV/MRV landmarks (`volume.ts`, still live), supersets writing `superset_group` (still live, now animated), rest-timer background alerts (`rest-timer.ts`, still live, still awaiting the EAS rebuild).

> **Phase 3 shipped (2026-07-27).** **Programs / periodization** (migration **0020** `programs`+`program_days`+`program_weeks`): a multi-week mesocycle is a repeating weekly split (weekday→routine) with a length and marked deload/test weeks; one program is active at a time, and "Train today" derives the scheduled session from `active_start` + the calendar weekday, taking precedence over the freshness pick. Repo `programs.ts`, builder `app/program-edit.tsx`, a routine picker, hub Programs section + program-aware Train-today card. **Weekly volume vs MEV/MAV/MRV landmarks** (`src/lib/exercise/volume.ts` + `VOLUME_LANDMARKS`): `weeklyMuscleSets` → per-muscle add/hold/cut verdict, surfaced as the hub's "Weekly volume" section. **Supersets**: the reserved `workout_sets.superset_group` is now written — adjacent blocks link into a superset in `workout-live.tsx`. **Rest-timer background alerts**: `src/lib/notifications/rest-timer.ts` (mirrors `reminders.ts`; one-shot, guarded-native, a no-op on any binary without `expo-notifications`; that module reached the owner’s in the 2026-08-25 rebuild, and no alert has been observed — still FLAGGED). Deload weeks pre-fill fewer sets in the logger. 46 new headless tests (programs 28 + volume/recommend/rest 18). `exercise.ts` exports still byte-stable.

> **Phase 2 (2026-07-27).** Migrations 0011 `exercises`+`exercise_muscles` (69-exercise seeded core), 0012 `routines`+`routine_exercises`, 0013 additive enrichment of `workout_sets`/`workouts`. Pure offline engine (e1RM, freshness decay, dynamic double progression, warmup/rest, recommender). Screens: grown hub, structured logger, routine builder, exercise detail, shared picker. Unit rendering honours the lb/kg preference. 83 headless tests.

---

## 1. What this is

Turn ARC's Exercise screen into a complete training sub-app on the level of FitBod — it tells you exactly what to train today based on recovery and goals, and logs it beautifully — adapted to ARC's local-first, Porcelain-Ledger world.

**The core loop:**

1. A curated **exercise catalog** (muscles, equipment, movement patterns) makes every set attributable to muscles.
2. **Routines** make sessions repeatable; starting one pre-fills last session's numbers so a repeat is one tap per set.
3. A **structured set logger** captures reps × weight × RPE with set types, a rest timer, and live PR detection.
4. A **rule-based engine** — per-muscle freshness decay + progressive overload from set history + e1RM — recommends *what to train today* and *what to lift on every set*. Fully offline.
5. The **Coach** later narrates and negotiates on top of the engine's numbers; it never computes them.

### The research verdict (Phase 0)

FitBod, Hevy, Strong, RP Hypertrophy, and JuggernautAI were studied in depth (FitBod down to its granted patents). The finding that shapes this whole spec: **essentially none of the intelligence in these apps needs a model at runtime.**

- **FitBod's** "AI" is two engines its patents describe as heuristic pipelines: an *Exercise Selector* (per-muscle recovery % + hand-rated exercise metadata + equipment hard-filter + goal ×1.5 boost + recency penalties + a rank-shuffle "variance" dial) and a *Capability Recommender* (Epley-style e1RM as a recency-weighted 180-day moving average, conservative cold starts, RIR-driven load nudges). Its recovery model is a per-muscle 0–100% score depleted by sets×reps×load and saturating back at ~7 days.
- **Hevy/Strong** are 100% deterministic: previous-values-as-placeholders set grids, per-exercise rest timers, warmup ramp generators, plate math, and PR detection by simple MAX comparisons (heaviest weight, best e1RM, rep-records).
- **RP** is a lookup table (per-muscle MEV→MRV weekly-set landmarks, +1–2 sets/week, RIR 4→3→2→1) plus a tiny ordinal survey (soreness/pump/workload) mapped to ±sets by published if/then rules. **Juggernaut** is percentage waves off a training max plus a readiness survey that scales volume.
- The genuinely-AI parts are exactly the ones ARC already routes to the Coach: free-text parsing ("5×5 squat at 225"), narrative explanation, substitutions/negotiation, and fusing training state with sleep/HRV/labs.

So: **the engine ships as deterministic TypeScript + SQL, offline, testable headlessly.** The Coach seam is designed in but stubbed. This is FitBod's actual architecture with the marketing removed — and it matches ARC's offline-except-AI principle exactly.

---

## 2. Feature set & screen map

### Features by slice

| Slice | Features | Offline? |
| --- | --- | --- |
| **A — Catalog & richer sets** | Seeded exercise catalog (~300, curated) · exercise picker with search/filters · custom exercises · set logging upgraded with catalog link, set types (warmup/normal/failure/drop), RPE · e1RM + PR detection · per-exercise detail (history, e1RM trend, rep-records) | ✅ |
| **B — Routines** | Routine builder (ordered exercises, target sets × rep ranges, rest) · start-from-routine with previous-values prefill · finish-diverged → "update routine?" prompt | ✅ |
| **C — The engine** | Per-muscle freshness ledger · "Train today" recommendation on the hub (which routine / which muscles + per-set load targets) · in-app rest timer · warmup ramp suggestion · stall detection + deload suggestion | ✅ |
| **D — Coach assist** (after Coach window merges) | NL set logging · "why this recommendation" narrative · conversational substitutions · readiness modifier from Apple Health (HRV/sleep) once wearables land | needs model / HealthKit |

Deferred (flagged, not designed here): supersets (column reserved), plate calculator, background rest-timer notifications (native), VO₂max (needs wearables — stays an honest `—`), body-diagram heatmap (the ledger table below replaces it; a silhouette is a later nice-to-have).

### Screen map

| Screen | Route | Status |
| --- | --- | --- |
| **Exercise hub** | `app/exercise.tsx` | exists — grows: "Train today" card (the pine action), routines list (replaces the Templates stub), muscle-freshness ledger, existing week strip + recent sessions |
| **Live workout** (structured) | `app/workout-live.tsx` | **new** — the set-grid logger: exercise blocks, previous-values prefill, set-type/RPE entry, rest timer, PR stamps. Entered from "Train today" or a routine |
| **Quick log** | `app/workout-log.tsx` | exists — **kept as-is** for free-form/cardio/mobility/past sessions (a grid is wrong for a Zone 2 ride) |
| **Routine builder** | `app/routine-edit.tsx` | **new** — name, ordered exercises, targets. Exercise picker is an in-screen modal, not a route. Lines reorder in the session's Order mode (§14.9) |
| **Exercise detail** | `app/exercise-detail.tsx` | **new** — history list, e1RM sparkline, rep-record table, last-performed |

All pushed screens: `<Screen>` + `<StackHeader>`, registered in `app/_layout.tsx` (**integrator-merge**).

---

## 3. Data model (migrations 0011–0013)

Extends `workouts` + `workout_sets` (0003) **without breaking them**. All existing exports stay stable: `logWorkout`, `addSet`, `weekSummary`, `weeklyTrainingSeries`, `localWeekRange`, `listRecentSessions`, and the `WeekPoint` shape — the Data tab's Training trend and the Coach's read-tools keep working untouched.

### 0011 — `exercises` + `exercise_muscles` + seed

```sql
CREATE TABLE exercises (
  id text PRIMARY KEY NOT NULL,           -- seeded rows: stable slug ('barbell-back-squat');
                                          -- custom rows: newId() UUID
  name text NOT NULL,
  aliases text CHECK (aliases IS NULL OR json_valid(aliases)),   -- JSON array, search aid
  equipment text NOT NULL CHECK (equipment IN (
    'barbell','dumbbell','kettlebell','cable','machine','smith','bodyweight','band',
    'ez_bar','trap_bar','plate','medicine_ball','suspension','bench','pullup_bar','other')),
  movement_pattern text CHECK (movement_pattern IS NULL OR movement_pattern IN (
    'squat','hinge','lunge','push_h','push_v','pull_h','pull_v','carry','rotation','core')),
  mechanic text CHECK (mechanic IS NULL OR mechanic IN ('compound','isolation')),
  logging_type text NOT NULL CHECK (logging_type IN (
    'weight_reps','bodyweight_reps','weighted_bodyweight','assisted_bodyweight',
    'duration','weight_duration','distance_duration')),
  unilateral integer NOT NULL DEFAULT 0 CHECK (unilateral IN (0, 1)),
  instructions text CHECK (instructions IS NULL OR json_valid(instructions)),
  is_custom integer NOT NULL DEFAULT 0 CHECK (is_custom IN (0, 1)),
  archived integer NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at / updated_at + trigger                      -- per convention
);

CREATE TABLE exercise_muscles (
  id text PRIMARY KEY NOT NULL,
  exercise_id text NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  muscle text NOT NULL CHECK (muscle IN (
    'chest','front_delts','side_delts','rear_delts','lats','upper_back','lower_back',
    'traps','biceps','triceps','forearms','quads','hamstrings','glutes','calves','abs')),
  role text NOT NULL CHECK (role IN ('primary', 'secondary')),
  UNIQUE (exercise_id, muscle),
  created_at                                              -- append-only: no updated_at
);
```

**Why a junction table, not a JSON array:** per-muscle weekly volume and freshness are the core queries of the whole engine (`GROUP BY muscle`), and CLAUDE.md's own principle is explicit tables over JSON blobs. The `role` column is what makes **fractional set counting** (primary = 1.0, secondary = 0.5 — the counting method the 2025 Pelland meta-regression found decisively best) a one-line SQL weight.

**Why 16 muscles, delts split:** RP's landmarks make a unified "shoulders" bucket uncomputable — front delts are saturated by pressing (MEV 0), side/rear delts need direct work (MEV 6–8, MRV 25+). Hevy's 15-group list, plus the split.

**Why `logging_type`:** it drives which fields the set row shows (weight×reps vs duration vs +weight/−assist) — the cleanest published model is Hevy's taxonomy. `workout_sets` needs no new columns for this; reps/weight_kg stay nullable as today, duration-type sets store seconds in `reps`? — **no**: duration sets store nothing new in v1; the three duration types are catalog-complete but their grid rows show a duration field persisted in `duration_sec` (see 0013). `weight_distance` is dropped from v1 (sled/farmer-distance is rare; `weight_duration` covers carries).

**Seeding:** curated **~300 exercises inside the 0011 migration SQL** (INSERTs with stable slug ids), quarried from **free-exercise-db** (~873 exercises, **Unlicense/public domain** — embeddable with zero legal friction; wger is CC-BY-SA, ExRx is proprietary/excluded) and enriched at authoring time with `movement_pattern`, `unilateral`, `logging_type`, and aliases — fields **no open dataset ships** and which are exactly the programming-useful ones. Curation drops stretching/foam-roll noise and duplicate grip variants; custom creation is the escape hatch, so coverage pressure is zero (Hevy ships "400+", Strong ~300; ~150 covers >95% of really-logged volume). Seed lives in the migration (versioned like code, self-contained, no shared `seed.ts` edit — one fewer integrator-merge point). No images in v1.

### 0012 — `routines` + `routine_exercises`

```sql
CREATE TABLE routines (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,                     -- 'Upper A'
  notes text,
  archived integer NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  last_started_at text,                   -- ISO timestamp, for 'last performed N days ago'
  created_at / updated_at + trigger
);

CREATE TABLE routine_exercises (
  id text PRIMARY KEY NOT NULL,
  routine_id text NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
  exercise_id text NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 1),
  target_sets integer NOT NULL DEFAULT 3 CHECK (target_sets >= 1 AND target_sets <= 20),
  rep_low integer CHECK (rep_low IS NULL OR rep_low >= 1),
  rep_high integer CHECK (rep_high IS NULL OR (rep_high >= 1 AND rep_high < 100)),
  rest_sec integer CHECK (rest_sec IS NULL OR (rest_sec >= 0 AND rest_sec < 3600)),
  created_at / updated_at + trigger
);
```

Deleting a routine cascades its rows — a routine line has no meaning outside its routine — but **never touches workouts**: execution history lives in `workouts`/`workout_sets`, which reference routines only via the nullable `workouts.routine_id` below (SET NULL — the CLAUDE.md delete-semantics rule).

### 0013 — enrich `workout_sets` + `workouts` (additive ALTERs)

```sql
ALTER TABLE workouts ADD COLUMN routine_id text REFERENCES routines (id) ON DELETE SET NULL;

ALTER TABLE workout_sets ADD COLUMN exercise_id text REFERENCES exercises (id) ON DELETE SET NULL;
ALTER TABLE workout_sets ADD COLUMN set_type text NOT NULL DEFAULT 'normal'
  CHECK (set_type IN ('normal', 'warmup', 'failure', 'drop'));
ALTER TABLE workout_sets ADD COLUMN rpe real CHECK (rpe IS NULL OR (rpe >= 1 AND rpe <= 10));
ALTER TABLE workout_sets ADD COLUMN duration_sec integer
  CHECK (duration_sec IS NULL OR (duration_sec >= 0 AND duration_sec < 36000));
ALTER TABLE workout_sets ADD COLUMN superset_group integer
  CHECK (superset_group IS NULL OR superset_group >= 1);   -- reserved; UI later
CREATE INDEX workout_sets_exercise_idx ON workout_sets (exercise_id);
```

- `exercise_id` is **nullable and SET NULL**: history must outlive catalog edits, and every pre-existing row (free-text `exercise` only) stays valid. The `exercise` text column remains the display name — written alongside `exercise_id` by new code, still the only field for quick-log free text. Old rows can be back-linked later by an alias-match pass (a Coach-assist job, not a migration).
- Warmup sets (`set_type='warmup'`) are **excluded from e1RM, PRs, volume, and freshness** — the Hevy/Strong rule.
- **PRs and freshness are derived, not stored.** No `personal_records` or `muscle_state` tables: both are cheap indexed reads over history for a single user, always consistent, nothing to invalidate. If set-completion PR checks ever feel slow on device, a cache table is a later additive migration. (This is the one deliberate deviation from the mission's "likely new tables" list — derivation beats denormalization at n=1.)

### 0045 — `workout_drafts` (the unfinished session)

```sql
CREATE TABLE workout_drafts (
  id text PRIMARY KEY NOT NULL,
  key text NOT NULL UNIQUE CHECK (key IN ('live', 'manual')),
  value text NOT NULL DEFAULT '{}' CHECK (json_valid(value)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

A two-slot KV following `health_sync_state`'s pattern — one row per logging screen, the payload free JSON carrying its own `version`. The full argument is in the migration's header; the short form is §9 below.

### 0046 — `exercises.measures` + `workout_sets.distance_m` (B1)

```sql
ALTER TABLE exercises ADD COLUMN measures text NOT NULL DEFAULT 'reps,load'
  CHECK (measures IN ( … all 15 non-empty subsets, canonical order … ));
ALTER TABLE workout_sets ADD COLUMN distance_m real
  CHECK (distance_m IS NULL OR (distance_m >= 0 AND distance_m < 1000000));
```

**An exercise declares what a set of it records** — a subset of `reps · load · time · distance`, stored as the comma-joined subset in that fixed order (`'reps,load'`, `'time'`, `'time,distance'`, `'load,distance'`). See §10.

### Repository & type layout (exports stay stable)

- `src/lib/db/repositories/exercise.ts` — **untouched exports.** One compatible extension: `SetInput` gains optional `exerciseId?`, `setType?`, `rpe?`, `durationSec?` fields and `LogWorkoutInput` gains `routineId?`; `logWorkout`/`addSet` write them when present. Call-compatible — every existing caller and test passes unchanged. Flagged for integrator eyes anyway.
- New repos (new files — zero collision surface): `exercise-catalog.ts` (search, get, muscles, custom CRUD), `routines.ts` (CRUD, start-prefill reads), `training-stats.ts` (per-exercise history, e1RM series, rep-records, per-muscle weekly volume, freshness inputs).
- Pure engine, DB-free, in `src/lib/exercise/`: `e1rm.ts`, `freshness.ts`, `progression.ts`, `recommend.ts` — import nothing but types, so they test trivially and the same code could someday move to SwiftUI by translation.
- View types in `src/lib/exercise/types.ts` (existing file, additive).

---

## 4. The engine (rule-based, offline)

Every constant below is a named export in one place (`src/lib/exercise/constants.ts`), commented as tunable.

### 4.1 e1RM

- Base: **Epley**, `e1rm = w × (1 + n/30)`, with `n = reps + RIR` when RPE is logged (`RIR = 10 − RPE`) — the RTS chart is a pure diagonal in `reps + RIR`, so one formula covers the RPE-aware case within ~1%.
- Only sets with `reps ≤ 10` (hard cap 12), `set_type` normal/failure, and `RIR ≤ 4` count. No-RPE sets use raw reps (conservative).
- Per-exercise **capability** = max e1RM in the last 42 days, decayed 1%/week thereafter (FitBod's recency-weighted idea, simplified honestly for n=1).

### 4.2 Muscle freshness (the recovery model)

Per muscle *m*: `fatigue_m(now) = Σ over last 14 days of sets: role_weight × effort_weight × e^(−Δh/τ_m)`

- `role_weight`: primary 1.0, secondary 0.5 (fractional counting).
- `effort_weight`: 1.0 default; 0.5 if RIR > 4 (easy set); 1.25 if RIR 0 (failure costs 24–48 h extra recovery — Morán-Navarro 2017).
- `τ_m` from published recovery windows, τ = window/3 (residual ≈ 5% at the window): **72 h** muscles (quads, hamstrings, glutes, lats, upper_back, lower_back) τ = 24 h · **48 h** (chest, side_delts, rear_delts, front_delts, traps, triceps) τ = 16 h · **36 h** (biceps, calves, forearms, abs) τ = 12 h.
- `freshness_m = 100 × e^(−fatigue_m / FRESH_SCALE)`, `FRESH_SCALE = 8`. *(Restated 2026-08-14: it was `100 × (1 − min(1, F/8))`, and the `min` clipped — eight fractional sets and twenty-four both printed 0. The calibration table lives on `freshnessFromFatigue`, and `db/training-engine.test.mjs` §5b is the specification.)* Display buckets: ≥ 80 fresh · 50–79 recovering · < 50 fatigued.
- **`effort_weight` for ENDURANCE work is the duration, not the set** (B1, 0046). A set whose exercise measures time **and** distance and carries no load — a run, a ride, a row, a swim, a walk — costs `duration / ENDURANCE_MINUTES_PER_SET` working sets, RPE-scaled through the same knob, capped at `ENDURANCE_EFFORT_CAP = 18`. Ten minutes ≈ one hard set. See §10.

Cardio logged with kind `cardio` but no catalog movement still contributes nothing to any muscle — attribution runs through `exercise_muscles`, so a free-text cardio session is invisible to the ledger by the same rule every other free-text set is.

### 4.3 Progression (per exercise)

- **Dynamic double progression** within the routine's rep range (defaults: compound 6–10, isolation 8–15): any set that hit the top of range at RIR ≥ 1 gets +1 increment next time; others repeat.
- Increments: barbell lower-body +5 lb, barbell upper-body +2.5 lb (displayed; stored kg), dumbbell → next catalog increment (5 lb steps), machine +5 lb. (ACSM 2-for-2 spirit, Hevy/StrongLifts numbers.)
- **Stall = 3 consecutive sessions** on an exercise with no set progressing → suggest **−10%** and reset to bottom of range (StrongLifts' shipped rule).
- Never-performed exercise: no target, placeholder "—, find your weight" (honest; converges in 2 sessions like FitBod's cold start anyway).

### 4.4 "Train today" recommendation

1. Compute freshness ledger.
2. **With routines:** score each non-archived routine = set-weighted mean freshness of its primary muscles; recommend the top one, with the two-line why: `Upper A — chest 96 · delts 88 · triceps 84` / `last done Tue · squat day is 62% recovered`. A routine below 60 average is shown with a caution note instead of hidden (recovery *prioritizes*, never gates — the FitBod rule).
3. **Without routines:** recommend the 2–3 freshest muscle groups clustered by pattern affinity (push/pull/legs) plus the user's most-logged exercises for them (falling back to one compound per pattern from the catalog).
4. Per exercise, attach the progression target (§4.3) and a warmup ramp for the first exercise per muscle group: bar×5 → 50%×5 → 70%×3 → 85%×2 of working weight, rounded to plate math, skipped when working weight < 1.5× bar (Starting Strength scheme).
5. Rest defaults per set, auto-started on completion: compound ≤ 6 reps → 180 s · compound 7–12 → 150 s · isolation → 90 s (2024 Bayesian meta-analysis: ≥ 60 s matters, > 90 s marginal).

⚠️ **The traffic runs the other way too, since 2026-08-25.** Home's **Strain** pillar reads this sub-app's data: `dailyMuscleSetLoad` (`repositories/training-stats.ts`) shares its FROM/WHERE with `muscleSetsInRange` and totals role-weighted working sets per day, and `src/lib/home/readiness.ts` grades yesterday against the mean over prior *training* days. Two consequences for anyone editing here. **Changing what counts as a working set now moves a Home pillar**, not just the volume section. And the sum across muscles is *tissue loaded*, not sets performed — a compound set is 2.0 units — so it must never be printed to the user as a set count. Sharing the substrate is the point: Strain and the freshness figure can no longer contradict each other, which is exactly what the owner reported them doing.

Readiness (sleep/HRV) does **not** modify volume, and — corrected 2026-08-08 — `recommend.ts` has **no** readiness parameter (an earlier version of this line claimed the seam was in the signature; it never was). This is now deliberate, not deferred: readiness must never scale volume *automatically* — whether a low-recovery morning means backing off is a judgment call that depends on program phase, cause, and context, so it belongs to the Coach model (which reads readiness via `get_today_snapshot` and the engine's state via `get_training_recommendation`). The planned seam is a **caller-supplied adjustment dial** (e.g. `volumeScale`) the Coach passes when *it* decides — see `docs/coach-intelligence-review.md` §4 Phase 2.

---

## 5. Porcelain Ledger translation

FitBod's neon heatmap and Hevy's green grids, restated in ARC's language — no new tokens, no exceptions to the system:

| Genre convention | Porcelain Ledger form |
| --- | --- |
| Muscle-recovery body heatmap | **The freshness ledger:** typeset rows — muscle name, mono `96%`, a thin hairline track with a signal-colour fill. Freshness is a biological state, so signal colours are *sanctioned here*: optimal ≥ 80, caution 50–79, poor < 50. No silhouette, no gradients. |
| Set grid with green checks | Porcelain card per exercise block; `hairline-soft` row per set; columns SET · PREV (ink-muted mono `135×8`) · LB (mono input) · REPS (mono input) · RPE (mono, optional) · check. Completing a set stamps a **pine check** — completion is what pine means. Row text drops to ink-muted when done. |
| Rest timer takeover | A quiet line under the active block: mono `2:14` counting down, `+15 / −15` ghost chips, no modal, no glow. |
| PR confetti / trophies | A small mono **`PR`** tag in ink on the set row + one line in the finish summary (`Bench 8×140 — best e1RM to date`). No pine (it's not a completion), no signal colour (it's not a verdict). If it under-lands on device, the candidate upgrade is serif italic, not colour. |
| "Start workout" CTA | The **one pine action** on the hub is the "Train today" card's start button. Routines list and quick-log drop to ghost/porcelain rows. |
| Numbers everywhere | Every measured value mono: freshness %, e1RM, targets, elapsed, countdown. Serif only for screen titles and the finish summary's verdict line. |

The live-workout screen's one pine action is **Finish workout**; set checks are completion stamps (sanctioned pine, same as Home's mission circles).

---

## 6. Native / dependency flags

| Thing | Status |
| --- | --- |
| **In-app rest timer** (foreground) | pure JS — ships in slice C |
| **Background rest-timer notification** | needs `expo-notifications` → **native, new dev build** — deferred; batch with `expo-secure-store` / `expo-local-authentication` per project-status. Until then the timer is honest: it keeps counting on return to foreground (timestamps, not ticks). |
| **HR / VO₂max / readiness inputs** | HealthKit → **native** — deferred to wearables phase. VO₂max stays `—`. |
| **Coach model client** (`src/lib/ai/coach-service.ts`) | merged and live. The old `coach-assist.ts` wrapper seam was **deleted 2026-08-08** (never called; its premise went stale) — the Coach now reads the engine directly through its `get_training_recommendation` tool, and slice D's "AI refinement" happens as model judgment over that state, not a wrapper (see `docs/coach-intelligence-review.md` §4). |
| New JS deps | **none** — no react-native-svg (existing Sparkline covers charts), no timer libs. (`react-native-svg` was added to `package.json` on 2026-08-25 for work on another branch; nothing here imports it, and it is not in the owner’s binary.) |

---

## 7. Build sequence & verification

Order: **A → B → C** (each an independently shippable vertical slice, offline), **D** after the Coach window merges.

Per-slice gates (all green before handoff): `npm run typecheck` · `lint` · `format:check` · `db:validate` · `db:test` (new suites: `db/exercise-catalog.test.mjs`, `db/routines.test.mjs`, `db/training-engine.test.mjs` mirroring `db/nutrition.test.mjs`) · `npx expo export --platform ios`. Pure-engine math (e1RM, freshness decay, progression triggers) gets exhaustive headless tests — it's all DB-free functions on purpose.

**Integrator-merge points (Matt's main window folds these):**

1. `src/lib/db/migrations.generated.ts` — regenerate via `npm run db:bundle` after 0011–0013.
2. `package.json` — three new test files appended to the `db:test` chain.
3. `app/_layout.tsx` — three new `<Stack.Screen>` lines (`workout-live`, `routine-edit`, `exercise-detail`).
4. `app/(tabs)/data.tsx` / Training trend — **no change planned**; flag only if a richer trend is wanted later.
5. Docs: `project-status.md` §1/§2 rows, `data-model.md` new-tables section, a `decisions.md` ADR — written at merge per the docs-follow-reality rule.
6. **Migration numbers:** this window was reserved 0011–0013 (the 0007-next-feature note in project-status predates this dispatch); integrator finalizes exact numbers at merge — all three files are gap-tolerant until then.

---

## 8. Open questions for Matt (answer before or during slice A)

1. **Two loggers or one?** This spec keeps `workout-log.tsx` (quick, free-form) alongside the new structured `workout-live.tsx`. The alternative — one logger that grows modes — is cleaner in the tab bar of the mind but heavier to build and easy to regress. Preference?
2. **Goal setting:** the engine defaults to a longevity blend (compound 6–10 @ RIR 1–3, isolation 8–15, 10–20 sets/muscle/week). Worth a Settings choice (strength-biased vs hypertrophy-biased), or is the blend the point?
3. **Catalog size/curation:** ~300 seeded exercises curated by me from free-exercise-db, enriched with patterns/aliases. Want to review the seed list itself, or trust the curation and edit-by-archiving later?
4. **PR stamp styling** (§5): mono ink tag proposed; bless or redirect on device.
5. **RPE entry:** optional per set, hidden behind a tap (default) or always a visible column? (Strong shows it always; it adds a fourth number to every row.)

---

## 9. Phase 5 — the draft store and the matcher (2026-09-14)

### 9.1 A1 — why a draft store and not an in-progress workout

Two designs were on the table for "the live session must survive the app being killed":

| | a flagged `workouts` row | **a separate draft store (chosen)** |
| --- | --- | --- |
| Where the session lives while unfinished | `workouts` + `workout_sets`, `in_progress = 1` | `workout_drafts`, one JSON row |
| How stats exclude it | a predicate every reader must remember, forever | **structurally — no training query reads this table** |
| Abandoning it | delete the parent workout, cascade its sets | delete one row |
| Cost of getting it wrong | a half-typed set becomes a PR; an abandoned warm-up counts against weekly volume; both silent | nothing to get wrong |

The deciding constraint is the second row. Everything the training engine knows it computes from `workout_sets` at read time — `recentMuscleLoads` (freshness), `weeklyMuscleSets` (volume), `personalRecords` / `workingSets` (PRs, e1RM), `lastSessionSets` (the logger's own placeholders), `weekSummary`, `listRecentSessions`, the Coach's `read-tools.ts`, `assemble-self-review.ts`, the export. A flag puts an exclusion predicate in every one of them and in every query written after today. This is the owner's execution history with no server copy, so the failure mode — silent contamination — is the expensive one.

`health_sync_state` (0021) was considered as a host and rejected: it is named and documented as the HealthKit sync cursor, and a live workout parked in it makes that name a lie. `users.preferences` was rejected too — a draft is machine state, not a user choice, and it is rewritten on every keystroke.

**What survives a kill:** every exercise block and its order, every set with its weight / reps / RPE *exactly as typed* (strings, so a half-typed "1 " is still half-typed), set type, the completion stamps, the PR stamps, superset binds, the previous-session placeholders, the best-e1RM bar, the saved workout the session started from, the instant the session started (so the elapsed clock is honest, not restarted), and the rest timer's target instant if it has not already passed. The free-form logger (`workout-log.tsx`) keeps its drafted sets *and* its entry row, because that screen deliberately saves a typed-but-never-Added row.

**What deliberately does not survive:** an EDIT of an already-saved session (it has a stored copy — nothing unrecorded is at risk, and a resumable edit could only re-apply half a correction); the scheduled OS rest ALERT (it was queued with expo-notifications before the kill and is still queued, so re-arming would fire it twice — only the countdown is restored; since 2026-09-23 its id rides the draft so the resumed screen can cancel it, §14.8); scroll position, keyboard focus and the picker sheet.

**Guarantees, each pinned in `db/exercise.test.mjs` §10:** the draft round-trips byte-identical across a close-and-reopen of the database file; a full draft session writes zero `workouts` and zero `workout_sets` rows and moves none of freshness / volume / PRs / placeholders / the week; discarding leaves the draft store empty and the training history untouched; finishing clears the draft only after the write succeeds; a payload from another `version`, or junk, reads as "nothing to resume" rather than throwing on the mount path.

**Overwrite safety.** The logger keeps one live slot, so starting a new session while a draft exists would clobber it. Every door into the live logger on the hub therefore passes through one confirm — *Resume it* / *Start new* (destructive) / Cancel. Discarding, from the hub or from the logger's own **Discard workout** control, names what it is about to delete. *(Until 2026-09-23 the back-out confirm was the logger's discard; leaving no longer discards at all — §14.)*

### 9.2 A7 — the ranking, and what the resolver refuses

`src/lib/exercise/match.ts` is the single matcher; `resolveExerciseByName` and the picker's search field are two policies over it, not two implementations.

| Tier | Matches | Resolver uses it? |
| --- | --- | --- |
| 0 exact | folded name equals the query | yes |
| 1 alias | folded alias equals the query | yes |
| 2 prefix | name/alias begins with the query, at a word boundary | multi-word queries only |
| 3 contains | name/alias contains the query anywhere | **never** |
| 4 fuzzy | within tolerance of a whole name/alias | only if exactly one movement is closest |
| 5 fuzzy word | every typed word is within tolerance of a word of the name | **never** |

Ties break on: tier, edit distance, own-name before alias, shorter name, alphabetical — deterministic, because a list that reshuffles between keystrokes is unusable.

Two foldings do most of the work before any fuzziness is needed. The **normalise** lowercases, turns punctuation into spaces and de-pluralises each token ("Lat Pulldowns" → "lat pulldown", "Triceps" → "tricep"). The **squash** then removes the spaces, which catches every compound people write as one word — "pull-downs" / "Pulldown", "skullcrusher" / "Skull Crusher", "chinup" / "Chin-Up". Equality under the squash counts as *exact*, not fuzzy: the letters are identical, nothing is being guessed.

Only what is left goes to **bounded Damerau-Levenshtein** — transposition costs one edit, which is what makes "bnech" and "sqaut" work — with a tolerance that scales with length: 0 at three characters or fewer, 1 to five, 2 to eight, 3 above. The short-word zero is the guard that keeps "row" away from "raise" and "leg" away from "lat". Hand-rolled: no dependency was added.

**The alias source is the existing `exercises.aliases` JSON column** (0011), which already carries ~60 alternative names. No alias table and no migration were needed for A7 — and generic tolerance beats hand-listing misspellings, which is a list that is never finished.

The resolver's contract is unchanged where it matters: a unique match or null, never a guess. `Press`, `Bench`, `raise`, `pull`, `fly`, `extension` and `machine` all still resolve to nothing, because a wrong `exercise_id` attributes a set to the wrong muscles for the life of the database. Pinned in `db/coach-tools.test.mjs` §27 and `db/exercise-catalog.test.mjs` §8–§9.

### 9.3 What only a device can settle

- **The write-through's feel.** Each keystroke in the set grid now performs one small `INSERT … ON CONFLICT` (skipped when the serialised payload is unchanged). op-sqlite is synchronous, so if anything is going to stutter it is typing into a long session on a real phone. If it does, the fix is a short debounce on the payload — not a retreat from write-through.
- **The Resume card's place** at the top of the hub, above Train today, and whether a neutral plate is enough presence for it.
- **Whether a resumed rest timer should re-arm its OS alert.** It deliberately does not (the pre-kill notification is still queued); that assumption is only observable on a device where the rest alert has actually been seen to fire — which, per §6, has still never been confirmed.

---

## 10. Phase 6 — an exercise declares what it measures (B1, 2026-09-14)

Owner: *"Distance instead of reps for running workouts, etc."* and *"time for some exercises i.e. planks and running instead of reps."* Every set in ARC had been reps × load since 0003: the logger asked a plank for reps and had nowhere to put five kilometres.

### 10.1 The model

`exercises.measures` (migration **0046**) is the comma-joined subset of `reps · load · time · distance`, in that fixed order. A set carries the corresponding nullable columns — the existing `reps` / `weight_kg` / `duration_sec` (0013) plus the new `distance_m` (metres, canonical, so the km/mi toggle is display-only exactly as kg is).

**Why a CHECK'd text and not JSON.** CLAUDE.md §9: ARC owns this whole vocabulary, so it takes the CHECK. A JSON array would need `json_valid` and would still admit `["reps","reps"]` and `["load","reps"]` — three spellings of two facts. The CHECK enumerates **all fifteen** non-empty subsets, and that totality is the point: the domain is closed at four measures, so the CHECK can never need a sixteenth value and can never become the twelve-step table rebuild it would otherwise be on a table that parents two live foreign keys.

**Why not `logging_type`.** 0011's `logging_type` already sorts movements into seven buckets and three of them are this question. It is not enough: it cannot say load + time + distance or distance alone, adding a value to *its* CHECK is that same rebuild, and it is a **guess** on every row the app writes itself — the picker's New-exercise form derives it from equipment alone, so a custom "Running" is stored as a reps × load lift. `measures` supersedes it as the authority for what a set carries; `logging_type` stays (it still separates bodyweight from weighted from assisted) and remains what the forms author, with `measures` derived from it on write through one map (`MEASURES_FOR_LOGGING_TYPE`), so the two cannot drift.

**The cross-table rule lives in the repository.** "A set carries the fields its exercise implies" is enforced by `insertSet` (via `maskByMeasures`), not by a CHECK — the 0034 lesson: a cross-column CHECK passes on an empty fixture and then rejects the ALTER on a populated device, where the offending rows are the owner's own history. Surplus fields are NULLed rather than throwing, because every caller writes inside one transaction and a throw would roll back a whole session over one surplus field. The Coach's `log_workout` **card** masks with the same function, so the confirmation promises the row that will actually exist.

### 10.2 The backfill

Pass 1 derives from `logging_type` for every row. Passes 2–4 then correct **by name**, which is what reaches the custom exercises the picker mis-typed:

| Pass | Result | From |
| --- | --- | --- |
| 1 | `reps,load` | `weight_reps`, `weighted_bodyweight`, `assisted_bodyweight` |
| 1 | `reps` | `bodyweight_reps` |
| 1 | `time` | `duration` |
| 1 | `load,time` | `weight_duration` |
| 1 | `time,distance` | `distance_duration` |
| 2 | `time` | plank · wall sit · dead hang · hollow hold |
| 3 | `time,distance` | run (word-anchored) · jog · sprint · treadmill · cycl · bike · rowing · erg · swim · elliptical · hike · ruck · walk (not lunge) |
| 4 | `load,distance` | farmer · carry · sled · yoke |

Shipped catalog after the backfill: **plank** `time` · **treadmill run / rowing erg / stationary bike / incline walk** `time,distance` · **farmer's carry** `load,distance` (the owner's own framing; nothing is orphaned, because no screen has ever written `duration_sec`) · **push-up and the other bodyweight movements** `reps` · everything else `reps,load`.

Three traps the name passes are written around, all real: `*run*` matches "t**run**k rotation" (so `run` is word-anchored); `*row*` would have swallowed Barbell / Dumbbell / Seated Cable / Machine Row (so only `rowing` and `erg` match); `*walk*` catches the Walking Lunge (excluded).

### 10.3 Stats: what each measure can and cannot claim

- **e1RM, PRs by load, and progression apply only to `reps` + `load`.** A plank can never set an estimated 1RM — already true arithmetically (`countsForE1rm` rejects a null load or null reps) and now stated as a property of the movement, which is what lets the detail screen *omit* an e1RM panel rather than draw one that would only ever read "—".
- **Three new records, and the honesty is in what is not answered.** *Longest* (the plank record) and *Farthest* are unambiguous. *Best pace* is seconds per kilometre over pieces of at least `PACE_PR_MIN_M` = 400 m — below that a sprint's pace would own the record for every distance forever. It is still one number across all distances, which is a real simplification: a 5 km PR pace and a half-marathon PR pace are different achievements. Per-distance bests are a table, not a record, and wait until there is history worth tabling.
- **Freshness is duration-aware for endurance work; weekly VOLUME is not.** The asymmetry is deliberate. Freshness models systemic fatigue, where an hour of running plainly costs more than a minute. Weekly volume is measured against MEV/MAV/MRV, landmarks derived entirely from resistance-training sets — scaling a run to 4.5 "sets" of quads would compare it to a scale it was never on and report that an easy hour had pushed the owner past his maximum recoverable volume. One row, one set, there.

**The calibration** (pinned in `db/training-engine.test.mjs` §5c, which is the specification): a **45-minute run with no RPE reads quads 57 and calves / hamstrings / glutes 75** — recovering, roughly a third of a twelve-set leg day. An easy 45 minutes (RPE 5) reads 75; a hard one 57. A run logged with no duration falls back to one working set (quads 88), because a distance-only import still happened. Ten hours — the `duration_sec` ceiling — caps at 11, above the model's floor and well below the ~44 units a hand-asserted "Spent" implies, so nothing inferred can out-assert the user. A **60-second plank is one set of abs (88)**, not a tenth of one: `time` without `distance` is a hold, and a hold is one set however long it lasts.

### 10.4 What changed above the data layer

- **Loggers.** `workout-live` draws its columns from the block's `measures` (canonical order; the `Prev` column is the one that yields when a movement measures three things). The clock is an `mm:ss` field on the full punctuation keyboard — no iOS number pad has a colon — with a tolerant parser where a bare `60` is a minute. *(Superseded on device, 2026-09-23: the clock is now a number pad whose digits fill from the right — §10.5.)* Distance is typed in the user's own unit and stored in metres. `workout-log`, whose exercise is free text, resolves the typed name through the **same** `resolveExerciseByName` the repository will use, so the fields on screen are the fields that will be stored.
- **`DRAFT_VERSION` 1 → 2.** `DraftSet` gained `time` and `distance`, `DraftBlock` gained `measures`. A v1 payload is discarded, not migrated — the first real use of the mechanism 0045 shipped for. The one abandoned draft on the device evaporates on first launch.
- **Import.** The extraction prompt said *"Time-only rows: skip"*, so a screenshot of a run imported as nothing. It now asks for `durationS` (seconds) and `distanceM` (metres, converted from whatever the source showed), and a row with only those is a complete set. The review screen shows them; it does not yet let you edit them — a duration and a distance are printed as single unambiguous tokens, and when one is misread the honest repair is to remove the set rather than retype a number the photo does not support.
- **Coach.** `log_workout`'s set item gained `duration_s` / `distance_m` (+31 tok), paid for by deleting its `name` property (−30 tok) — a required field asking the model to invent a string for a column the owner retired on 2026-08-14 and nothing has rendered since. Net **+1 token**; neither §6 ceiling moved. The training reads report per-session `setSeconds` / `setMetres`, which costs nothing against that budget because it is payload, not schema.
- **D3's seam.** A set with `duration_sec` + `distance_m` and no reps is a first-class row, pinned as such — which is what ingested HealthKit workouts will map onto.

### 10.5 What only a device can settle

- **The `mm:ss` field — answered on device, 2026-09-23.** It was the only input in the app on `numbers-and-punctuation`, and this section asked whether reaching for a colon mid-set was acceptable, or whether it should become two number fields, or stopwatch-style digit entry. Owner: *"plank time should not require me to put in a colon, should automatically fill right to left"* — not acceptable, and the third option. What shipped:
  - **One field, every set grid.** `DurationField` (`src/components/exercise/duration-field.tsx`) is the time input in the live logger's set grid — which is also the session editor and the watch-session fill — and in the free-form logger's entry row. No set duration is typed on `numbers-and-punctuation` any more.
  - **A plain number pad with the Done bar, filled from the right.** `1` → `0:01`, `13` → `0:13`, `130` → `1:30`, `1305` → `13:05`, `13050` → `1:30:50`; Backspace shifts the last digit back out. The colons are drawn, never typed, and a leading zero is not a digit — it moves nothing on the clock. The field is driven by the key pressed, not by the native text, so a caret UIKit left mid-clock cannot put a digit anywhere but the right-hand end.
  - **The stored value is unchanged.** Still `workout_sets.duration_sec`, whole seconds, read by the same `parseClock` from the same `m:ss` text the draft always held — no migration, no `DRAFT_VERSION` bump. A draft typed on the old keyboard reads the way it was typed: a bare `90` was ninety seconds, so it opens as `1:30`, not `0:90`. A stored `0` opens as `0:00` rather than blank, so the editor's delete-and-reinsert cannot turn it into NULL.
  - **Seconds past 59 are normalised on commit, not rejected.** `190` reads `1:90` while it is typed and `2:30` when editing ends (blur, or the Done bar); minutes past 59 carry the same way (`60:00` → `1:00:00`). Rejecting the `0` would strand the user mid-number, and normalising as they type would move digits under their thumb (`1 9 0` → `2:30`, and the next `5` lands on `23:05` instead of `19:05`). Commit only re-spells — 1:90 and 2:30 are the same 150 s — so a Finish tapped with the field still focused saves the same seconds a blur would have, and the free-form logger does not count a re-spelling as a new entry (it would otherwise save the set just Added twice).
  - **The maximum is five digits,** `9:59:59` — the last value `duration_sec < 36000` stores. A sixth digit is refused. What five digits can still spell past the limit (`9:99:99`, 38,439 s) is kept exactly as typed and flagged by the loggers' existing over-limit guards, the same as an over-limit weight; nothing is clamped to a number nobody typed.
  - **A3 and the microwave meet on the first key only, and split by key.** Focusing a filled field selects it (A3), so the first *digit* starts a new number — the free-form logger keeps the last set's time after Add, which is exactly A3's case. The first *Backspace* does not clear it: an existing value opens as its digits, and Backspace edits the last one (`1:30` → `0:13`). The replacement is decided in JavaScript, so it holds even where the native highlight does not survive the tap.
  - **44 pt without moving the grid.** The field is 44 pt tall and gives back 5 pt of margin each side: it fills the free-form logger's 44 pt well exactly, and overhangs the set grid's 36 pt well by 4 pt above and below — inside the row's padding — so the row keeps its height and the wells stay level with the weight, reps and distance wells beside it.
  - **Not changed:** the `Prev` column and the set lines elsewhere still print a duration through `formatClock`, which runs minutes past 59 (`90:50`), where the field draws `1:30:50`. The two agree under an hour, which every plank does; aligning `formatClock` would also change the live elapsed clock, so it is left as a follow-up rather than done under this change.
  - Pinned headlessly in `db/exercise.test.mjs` §12 (every example above, backspace, normalisation, empty, the hour boundary and the maximum, plus every buffer up to five digits and every storable second) and `db/screens-render.test.mjs` §22 (the set grid and the entry row render a number pad, and a stored 90 s set draws `1:30`).
- **What the stopwatch field still needs a phone for.** That `onKeyPress` reaches JavaScript for every number-pad key (RN 0.86 emits it from `textInputShouldChangeText`; if it did not, the field would refuse every digit — total and obvious, not subtle). Whether the raw digit flashes for a frame before the drawn clock replaces it (`0:013` → `0:13`). Whether A3's highlight survives the tap here, and whether a highlighted value that backspaces by one digit rather than clearing reads as right. Whether the 4 pt overhang actually takes a thumb above and below a set-grid well. Whether VoiceOver's reading of `1:30` and the field's hint are enough to type blind.
- **Three value columns at 375 pt.** Nothing in the shipped catalog measures three things, so the `Prev`-column fallback is untested by the owner's own use.
- **Whether a session of only endurance movements should log as `kind: 'cardio'`.** The live logger still writes `'strength'` for everything; changing it would move the hub's Zone-2 minutes, so it is left for the owner to call.
- **The ten-minutes-per-set calibration itself.** It is anchored to one reading (45 min → quads 57), and the only test that matters is whether, the morning after a long run, the figure matches how his legs feel.

---

## 11. Phase 7 — ingested workouts reach the training data (D3, 2026-09-14, migration 0054)

Backlog **D3**, first slice of `docs/spikes/ingested-workouts.md`. The pairing half — the link
table, the overlap rule, the de-duplication of the Coach's two training reads — is documented
in `docs/wearables-subapp.md` §17. This is what it means on the Train side.

### 11.1 Three outcomes, and they stay distinguishable

`src/lib/exercise/activity-load.ts` maps a raw `HKWorkoutActivityType` int — never the label,
because `mapping.ts` says the names churn across SDK versions — to one of three answers:

| outcome | types | behaviour |
| --- | --- | --- |
| **inferred** | 52 Walking · 24 Hiking · 37 Running · 13 Cycling · 35 Rowing · 46 Swimming · 16 Elliptical · 44/68 Stairs · 60 XC skiing · 64 Jump rope · 9 Climbing · 61 Downhill skiing | contributes fractional load, **marked inferred** |
| **blank** | 50 Strength training · 20 Functional strength · 59 Core training | contributes nothing and **asks** (§11.3) |
| **refused** | 62 Flexibility · 33 Prep & recovery · 80 Cooldown · 29 Mind & body · 57 Yoga · 66 Pilates · 63 HIIT · 28 Martial arts · 73 Mixed cardio · 11 Cross training · 69 Step training · 3000 Other · anything unmapped | contributes nothing and **never asks** |

Separating *refused* from *blank* is the honesty rule in operational form. A HIIT session left
"blank" would sit in an inbox forever asking a question ARC cannot frame — burpees or an
assault bike are not the same body — and a stretch is not fatigue, so yoga contributes a real,
deliberate zero rather than an absence.

### 11.2 The numbers are role weights, and the dose is 0046's

Each entry is a **role weight** on exactly the scale `exercise_muscles` already uses: 1.0 is a
primary mover, 0.5 an assist. Duration is applied afterwards by the endurance rule from §10 —
ten minutes per working set, capped at `ENDURANCE_EFFORT_CAP` — which is the same arithmetic a
run *logged in ARC* already gets.

That shared scale is the point. **A 45-minute run ingested from the watch reads exactly as a
45-minute run typed into the logger does** (quads 57), because it is the same calculation on
the same units. A per-hour table of "fractional sets" would have been a second dose model for
the same hour. The cap comes free with the rule: a six-hour walk reaches 18 effort units ×
0.25 = 4.5 → quads 57, a long day on the feet rather than a leg day. A session under ten
minutes contributes nothing — HealthKit emits a workout object every time the Watch decides
you walked to the car.

Walking is the owner's own calibration (*"minorly effect the legs and not much else"*): quads
0.25 · calves 0.25 · glutes 0.2 · hamstrings 0.15, i.e. a 45-minute walk puts quads at **87**.
Everything else is scaled against running, whose primaries sit at a full 1.0.

### 11.3 Provenance, and the two firewalls

**`MuscleLoad.origin`** (`'set'` | `'ingested'`, defaulting to `'set'`) and
**`MuscleFreshness.inferredShare`** are 0034's rule in its third application: *"a number of
unknown origin entering the rollup … wearing the same face as a number the user asserted"*. A
part-inferred muscle says **Part inferred** under its name in the ledger, the body figure's key
names every such muscle, and `freshnessSummary` says it aloud for VoiceOver. A hand-set anchor
still wins the one provenance slot on the row — an assertion outranks a derivation, and two
stacked qualifiers on a 9 pt line is noise rather than honesty.

Two firewalls, both structural rather than remembered:

1. **A paired session infers nothing.** The sets are the session; the owner typed them.
   Without this, a workout logged in ARC and recorded by the watch would deplete its muscles
   twice — the fatigue-model version of the Coach's double-count.
2. **Weekly VOLUME takes no inferred load at all.** `muscleSetsInRange` counts *sets worked*
   and is printed to the owner as a set count; a walk contributes no sets, and the MEV/MAV/MRV
   landmarks it is measured against are derived from resistance training alone. The firewall
   needs no predicate: volume reads `workout_sets`, and an ingested session has none.

Both halves of the ledger are assembled by one function, `muscleLoadsForFreshness` — the hub's
body figure and the per-muscle screen must never be able to concatenate different halves.

### 11.4 The blank

An unpaired, strength-coded ingested session is an open question, so it appears on the **Train
hub** — a training task, not a Data-tab reference row — as a ruled plate headed *From your
watch*, one row per session: *"Strength session from Apple Health · 47 min · Garmin · muscles
unknown"*, with **Log sets** opening `workout-live` seeded with the ingested row's id.

**It is the LAST section on the hub** (owner, on the device, 2026-09-21: *"should be at the
bottom not the top of the page"*). It shipped under Train today, where it argued with the one
thing the screen exists to answer, and the same round of feedback largely emptied it: pairing
now reaches a session logged without a start time (§11.7), so most of what used to queue here
never queues at all. What is left is a genuine remainder, and a remainder belongs after the
record it did not join. Its empty behaviour is unchanged — it renders nothing rather than
standing empty, for the reason below.

That seeded session takes its **day, duration and start instant from the watch**, not from the
elapsed clock: the session happened this morning and is being typed up now, so timing the
typing would be the wrong number. On Finish it writes the `workouts` row and the link together,
`linked_by = 'user'`. The id rides in the live draft (`LiveDraft.ingestId`) for the same reason
`routineId` does — an app kill mid-fill must not forget which session the sets belong to.

Two bounds keep it from becoming an inbox nobody opens: a **14-day horizon** (switching this on
against the 90-day backfill would otherwise produce forty questions on day one), and the plate
renders **only when there is something to ask** — unlike Saved workouts and Recent sessions, an
inbox with nothing in it is not a record standing empty, it is a permanent "nothing to do"
panel on the hub of a phone with no watch.

A paired session shows **once**: the Train hub's Recent-sessions row prints what the watch
measured (`Garmin · 612 kcal · 8.4 km · avg 142 · max 171 bpm`) on its own line under what the
owner typed, and the Data tab marks its copy *logged in ARC* rather than presenting a second
workout.

**Heart rate joined that line on 2026-09-19** (D3b — the spec is
`docs/wearables-subapp.md` §18). Three things about it belong here, because they are facts
about these screens rather than about the HealthKit seam:

- **The session editor finally renders its pair.** `workout-live` has loaded
  `WorkoutDetail.ingested` since `0054` and never drawn it. It now prints the same string as
  one mono line under the header while `editing` — this is the screen where the owner asks
  *"how hard was that actually"*, and the answer was one join away. The seeded *filling-in*
  line is untouched: it identifies the session, which is a different job.
- **`ingestDetail` returns two strings now.** It takes `{ spoken: true }` and yields *"average
  heart rate 142, peak 171 beats per minute"*. The hub's row interpolates the watch line into
  its `accessibilityLabel`, and whatever that label says VoiceOver speaks — `avg 142 · max 171
  bpm` read aloud is a string of tokens rather than a measurement. Both the hub and the editor
  compute the display form and the spoken form separately; one variable feeding both was the
  bug waiting to happen.
- **No signal colour, and no verdict.** The clause is mono and muted like the rest of the
  line. The design firewall marks biological *state*, and a bare 142 has none: what it means
  depends on the load in that session, which ARC does not hold. Nothing on the training side
  interprets it — no zones, no freshness input, no volume input (§11.3's second firewall still
  holds: an ingested session has no sets, and an intensity multiplier would be a second model
  of the same hour).

### 11.5 Tests

`db/training-engine.test.mjs` §9: the walk's four muscles and nothing else, at the stated
weights, labelled inferred; the ingested/logged run parity at 57; the floor and the cap; HIIT,
yoga and an unmapped type contributing zero and never asking; a strength session contributing
zero and entering the inbox with its span; the blank answered by a fill; a paired session
inferring nothing and the ledger staying byte-identical; **a DAY-paired session inferring
nothing either, and the ledger byte-identical for it too**; weekly volume byte-identical while
freshness moves.

### 11.6 What only a device can settle

- **The twelve role weights.** They are judgement, like the recovery windows beside them, and
  the only test that matters is whether the figure the morning after a long walk matches how
  the owner's legs feel.
- **Whether `Core training` belongs in *blank* rather than *inferred*.** "Abs, primary" is
  tempting; a session coded Core training on a Garmin is frequently a whole circuit.
- **The 14-day blank horizon**, against a real backfill on a real device.
- **Whether the day rule pairs the right things** (§11.7), which is the whole of it: on a day
  when the owner logs a lift without a start time and the watch also recorded a walk, and
  nothing else, the two pair if their durations are within the tolerance — a 45-minute walk
  and a 30-minute lift would. Nothing on screen can prove that wrong; only he can, and the
  unpair tap is the whole remedy. If it happens often, the next lever is the activity coding
  (a walk is `inferred`, a lift is `blank`), not a tighter tolerance.
- **Avg/max HR** — no longer deferred; built 2026-09-19 as D3b
  (`docs/wearables-subapp.md` §18). What a device still settles on *these* screens: whether
  `avg 142 · max 171 bpm` reads as one line under a session title at 10 pt mono on the hub,
  how the spoken form sounds in VoiceOver, and — the question under all of it — whether Garmin
  Connect writes in-workout heart rate to Apple Health at all.

### 11.7 The day rule reaches the sessions the owner actually logs (2026-09-21)

The pairing rule itself is `docs/wearables-subapp.md` §17.7 — this is what it means on the
Train side. Until this round, only sessions from the **live logger** could pair, because only
the live logger writes `workouts.started_at` and pairing was span overlap. Everything else —
the free-form logger, a backdated entry, a photo import, anything the Coach writes — sat
unpaired forever, its watch copy queuing in the blank inbox beside the sets the owner had
already typed. The owner overruled that from the device. A logged session with no start time
now pairs with an unpaired ingested session on the **same logical day**: outright when it is
the only one, otherwise on the closest duration and only inside a stated tolerance (the shorter
must be at least half the longer), and never by guessing when there is nothing to choose on.

Three consequences that are facts about these screens:

- **The blank inbox mostly empties**, which is what moved it to the bottom (§11.4). A
  strength-coded session the owner logged the sets for is now *paired*, so it stops asking.
- **The pair says how it was made.** A day pair ends its watch line `· same day` (spoken:
  *"matched by day, not by clock"*) — on the hub's Recent-sessions row and in the session
  editor. A span pair says nothing extra: it shares a clock and needs no caveat.
- **Unpairing is one tap, on the watch line in the session editor.** No confirmation, because
  nothing of the owner's goes — the sets stay, the watch's record stays, and what is discarded
  is an inference ARC made. The pair is then **refused**, so the next sync does not remake it;
  a hand link from the blank inbox clears the refusal again.

The two freshness firewalls in §11.3 hold unchanged and by construction: "a paired session
infers nothing" is one predicate on the *existence* of a link and never on how it was made, so
a day pair is de-duplicated exactly like a span pair. Unpairing hands the watch's record its
inferred load back, which is the correct reading once ARC has been told it was a session of its
own.

## 12. Phase 8 — the away-gym bit (C13, 2026-09-14)

Owner: *"for when I am not at my home gym, I can make note of that and ARC can adjust intelligently"* — a stiffer machine must not read as a regression. The full argument is `docs/spikes/gym-away-note.md` (approved, all three questions as recommended); this section is what was built.

### 12.1 The governing sentence

> **An away session is real training and unreal measurement.**

It happened, it fatigued you, it counts as volume. Its *numbers* are not comparable to the home baseline — **in either direction**. Everything that counts **work** includes it; everything that compares **load** excludes it from the baseline while still showing it.

### 12.2 The flag

```sql
ALTER TABLE workouts ADD COLUMN away integer NOT NULL DEFAULT 0 CHECK (away IN (0, 1));
```

Migration **0055**. A column and not `workouts.notes`, because every consumer that changes behaviour is SQL or a reducer over SQL rows, and 0034's header already states the rule: provenance is a column. A **bit** and not a four-value enum, because the *behaviour* is binary and widening a CHECK on `workouts` — the parent of `workout_sets.workout_id`, i.e. the whole execution history — is the twelve-step rebuild. A nullable `gym_id` **beside** the bit later is one additive ALTER, and `away = 1 AND gym_id IS NULL` reads perfectly well as "somewhere else"; named gyms are deliberately not v1.

`NOT NULL DEFAULT 0` because every workout already on the device *was* at home — there was no other option when it was logged.

### 12.3 Six consumers, three answers

| Read | Away sessions | Why |
| --- | --- | --- |
| `personalRecordsFrom` | **excluded** | `bestE1rmKg` is a bar every future session must clear. A false PR raises it permanently and the next four home sessions then read as a stall — the exact complaint, arriving a month later and much harder to diagnose. A *missed* real PR is recoverable next session. So: no record **even when the numbers are the best on record**, and the control's own copy says so. |
| `toggleDone` (the live PR stamp) | **excluded** | Same rule, live. Turning the flag on mid-session also clears the stamps already earned — a "PR" tag left standing would contradict the line of copy directly beneath the control. |
| `suggestProgression` | **excluded** | The stall branch *is* the false-deload path: `STALL_SESSIONS` sessions with no gain and reps below the top of the range is exactly what three weeks on stiffer machines produces. |
| `lastSessionSets` (prefill) | **deprioritised** | The most recent **non-away** session, falling back to any when there is none. A confirmed placeholder becomes a real logged set, so away numbers leak into history by the quietest route available. One `ORDER BY w.away, …` does the whole of it. |
| `e1rmSeriesFrom` (the chart) | **kept and marked** | Deleting them would be a different lie: the session happened and the owner will look for it. The point draws **hollow** (`Sparkline`'s new `marked` prop) — a *form* difference, never a colour, because this is behaviour and signal ink marks biology. |
| freshness · weekly volume · `weekSummary` · the strain pillar · the self-review | **untouched** | **None of them reads a weight.** `muscleFreshness` multiplies role weight × effort(rpe, failure) × decay; the rest count role-weighted sets and minutes. A set to RPE 8 on a stiff machine fatigues the muscle exactly as much as one at home. `db/training-engine.test.mjs` §9(e) asserts these readings are *identical* with the flag on and off — the test exists so a later pass does not "complete" the feature by adding a branch. |

**One deviation from the spike (§3.3b).** It proposed excluding away sessions inside `exerciseSessionTops`. That reducer also feeds `app/exercise-detail.tsx`'s History list, so dropping them there would erase the session from the one screen built to show it. The flag rides on `SessionTopSet` instead and **`suggestProgression` refuses it** — the false-deload path closes at the branch itself, the history stays honest, and a future caller cannot feed the engine away numbers by accident.

### 12.4 The control

One quiet pressable in the live logger's clock row, in the **label voice** — `AWAY GYM`, hairline outline off, `border-ink bg-paper-dim` on, the protocol editor's chip vocabulary. **No accent**: that screen's budget is one primary action (Finish workout) plus the completion stamps. On, one serif muted line sits beneath it:

> *Loads from this session won't set records or steer progression, even if they're the best on record. It still counts as training.*

That sentence is the entire feature, said where the decision is made — including the corner case the owner will hit first, where the away gym's machine is *easier*.

**Off by default on every session and never remembered.** The failure modes are asymmetric: forgetting to turn it *on* costs one session's PR fidelity and is fixable afterwards on this same screen; forgetting to turn it *off* would silently kill PR detection at home, indefinitely, with no symptom.

**`DRAFT_VERSION` 2 → 3.** `LiveDraft` gained `away`; a v2 payload is discarded rather than read as "home", which would be right almost always — the wrong standard for the one flag whose job is keeping an incomparable load out of the baseline.

**Editable afterwards, with nothing to re-derive.** PRs are awarded live and never stored and every other affected read is computed on demand, so flipping the flag on a two-week-old session simply changes what the next read returns. `replaceWorkout` **preserves** an omitted flag rather than defaulting it — silence from a caller is not an assertion of "home".

### 12.5 The Coach

`get_training_summary.recentSessions` rows gain `away: true` (omitted on home sessions — payload, not schema, so it costs the prompt budget nothing), and the tool description gains one sentence:

> *`away: true` means a different gym — those loads are not comparable, so never call them a regression.*

That sentence is the Coach's entire share of the feature; it needs no arithmetic at all. **+36 tok**, paid for with **−21** in the same two training tools: `get_training_recommendation` no longer claims "program week (and whether it is a deload)" — a `recommendation.program` field that *cannot* appear, since programs were retired on 2026-08-11 and the recommender's schedule branch was deleted — and `get_training_summary`'s own "(default 28)", which its `days` property restates verbatim. Net **+17 tok**, 9,224 → 9,241 against the 9,250 ceiling. **Neither ceiling moved.**

### 12.6 What only a device can settle

- **Whether the chip is findable.** It is deliberately quiet and sits beside the clock; the question is whether it is quiet enough to ignore for months and still obvious in a hotel gym on the first try.
- **Whether "off every time" is the right default in practice**, on a two-week trip where the answer is "away" fourteen days running. The asymmetry argues it is; only a trip will say.
- **The hollow bar.** At 120 pt the e1RM spark draws twelve ~9 pt bars, and an outlined bar at that width has never been looked at on a phone.

---

## 13. Phase 9 — catalog first, and the AI writes the entry (C12, 2026-09-14)

Owner: *"ai add exercise replaces ai search (search catalog first)."*

### 13.1 What the old door did, and why it is retired

**AI exercise search** (Phase 4, bullet 6 above — `src/lib/exercise/ai-search.ts`, now **deleted**) was a standing third entrance beside browsing and the manual form. It sent the model the **catalog index** — every live movement's id and name — and asked it to pick.

That is a retrieval problem ARC already solves better than a model can: A7's ranked matcher (`src/lib/exercise/match.ts`) folds plurals and punctuation, reads aliases, tolerates transposition, and answers *"lat pulldowns"*, *"pull-downs"*, *"skullcrusher"* and *"bnech press"* offline, deterministically, in about a millisecond. Paying a round-trip to re-derive that was the expensive way to be less reliable — and the model could return an id for an archived movement, or invent one outright.

So the search is the catalog's, and the model is asked only the question the catalog cannot answer.

**Removed:** `src/lib/exercise/ai-search.ts` (the module), `AiSearchView` (the picker's mode), the standing "Find with AI" button, and every export of that module — `searchExercisesWithAI`, `isExerciseSearchAvailable`, `ExerciseSearchUnavailableError`, `parseExerciseSearch`, `resolveSearchMatches`, `buildExerciseSearchRequest`, `EXERCISE_SEARCH_SYSTEM_PROMPT`. `db/exercise-ai.test.mjs` §6d asserts the file is gone **and** that nothing in `src/` or `app/` still imports it or calls anything it exported — a dead module nobody imports is the failure this guards against, not just a missing file. **No route was added or removed:** the picker is a `Modal` component, never a screen, so `app/_layout.tsx` is untouched.

### 13.2 The gate: `offersAiEntry`

```ts
offersAiEntry(entries, query) // src/lib/exercise/match.ts
```

True when something was typed **and** nothing matched above the matcher's weakest tier. The line sits under `TIER.fuzzy` and above `TIER.fuzzyToken`, exactly where `match.ts`'s own docblock already puts it: tiers 0-4 are statements about the **letters typed** — an exact fold, an alias, a leading phrase, a containment, a whole name a few edits away — while FUZZY WORD is the one tier that is a *reach*, and the tier `resolveUniqueMatch` refuses outright for the same reason.

| Typed | Tier reached | Door |
| --- | --- | --- |
| `bench press`, `RDL`, `lat pulldowns`, `skullcrusher` | exact / alias | shut |
| `curl`, `press` | contains — lists every one | shut |
| `bnech press`, `sqaut` | fuzzy | shut |
| `jefferson curl` | fuzzy word only | **open** |
| `landmine press`, `zercher squat` | nothing | **open** |
| *(empty)* | — | shut |

The empty-query case lives inside the gate rather than at the call site, so there is one answer to "is the door drawn": nothing typed is not a question.

**A known limit, pinned rather than papered over.** `hack squat` keeps the door **shut**: "hack" is one substitution from the *Back Squat* alias, which is a whole-name FUZZY match and confident by every definition this module has. The owner gets Back Squat at the top of the list and the manual **New exercise** door. Widening the gate to catch it would mean distrusting tier 4 everywhere — the tier that makes `bnech press` work, a far commoner case than a one-letter collision with a real movement.

### 13.3 What the model is asked for

`src/lib/exercise/ai-add.ts` — a whole `exercises` row's worth of facts: name, **aliases**, equipment, primary/secondary muscles, `measures` (0046), `logging_type`, pattern, mechanic, unilateral, instructions.

- **No catalog index rides with the request.** That is the whole of catalog-first, and it is also why the prompt is a fraction of the retired one: the ~70 id/name pairs were the bulk of every search request. ~571 tokens of system prompt, one-off and uncached, pinned at a ceiling of 600 in `db/exercise-ai.test.mjs` §6b. ARC has no `ESTIMATOR_PROMPT_CEILING` pattern for one-off prompts — the only prompt budget in the repo is the Coach's registry-wide one (`db/coach-eval.test.mjs` §6), and this is a separate turn with no tools, so it is not part of it. The test pins a measured number rather than inheriting an allowance.
- **The model proposes, the parser disposes.** Every enum is checked against ARC's own vocabulary, and the **sixteen-muscle vocabulary is enforced at the boundary** — a muscle outside it is dropped here rather than at 0011's CHECK inside `createCustomExercise`'s transaction, which would roll the whole movement back with an opaque failure.
- **Rejected whole, never half-kept.** No name, no legal equipment, no legal `loggingType`, or no surviving primary muscle: throw. Half a definition looks like a catalog entry and is not one — a movement with no primary muscle contributes nothing to freshness, weekly volume or the body figure, for ever, silently. That is the 2026-08-14 null-`exercise_id` bug wearing a different hat.
- **`measures` both ways.** A legal canonical string from the model wins; anything else derives from `logging_type` through the one `MEASURES_FOR_LOGGING_TYPE` map. Both directions are needed — the derivation cannot express a carry's load + distance, and the model cannot be trusted with a sixteenth value.
- **Aliases are finally written.** `exercises.aliases` has existed since 0011 and only the seed ever filled it, so a custom movement answered to exactly one spelling. `createCustomExercise` now persists them (trimmed, de-duplicated, never an echo of the name, `NULL` rather than `[]` when empty), which is most of what makes an AI-authored movement findable again next month — and it is what closes the gate for that movement afterwards.

### 13.4 Provenance: migration `0056`

```sql
ALTER TABLE exercises ADD COLUMN source text CHECK (
  source IS NULL OR source IN ('seed', 'user', 'ai')
);
UPDATE exercises SET source = 'seed' WHERE is_custom = 0;
```

**Not `is_custom`.** That column answers "did this ship with the app"; `source` answers "who authored the facts in it". A movement the owner typed into the three-field New-exercise form and one a model authored — aliases, secondary muscles, pattern, mechanic, `measures` — are both `is_custom = 1` and are not equally trustworthy. Those muscles feed `exercise_muscles`, and through it freshness, weekly volume and the body figure; when a definition looks wrong in two months, the first question is who put it there. 0034's rule again, and `recipe_ingredients.resolved_by` is the direct precedent down to its vocabulary.

**Custom rows are left NULL by the backfill, deliberately.** The retired AI-search path created movements through the same `createCustomExercise` and left no mark, so an existing custom row could be either. Writing `user` over that would assert something nobody knows — exactly the failure the column exists to prevent. `NULL` means "authored before provenance was recorded", which is true.

The mark is **visible**: the review card carries it before the row exists, and the catalog row afterwards reads `AI` where it would otherwise read `Custom`. A mark nobody can see is not provenance.

### 13.5 The flow

Search, nothing confident, **Add with AI** (in the results plate, under whatever weak guesses the search did turn up, outlined, no accent), the view opens **already running** on the words already typed with no second field, a **review card** listing every fact that will land — including the aliases and secondary muscles nothing else would ever show — and **Save & add** writes the row and picks it into the session like any other exercise. Nothing is written before Save.

**Offline** is an honest state and a specific one: *"Couldn't reach the model. Browsing and 'New exercise' still work offline."* — which is true, and names which half is down. No key at all means the door is never drawn.

### 13.6 What only a device can settle

- **Whether the door is findable where it now sits.** It moved from a standing button at the top of the picker into the results plate; the gain is that it only appears when it is the right answer, and the risk is that it appears below the fold on a long list of weak guesses.
- **How often the gate is right.** `hack squat` is the known false negative; the real question is how many of the movements the owner actually reaches for land on the wrong side of tier 4.
- **Whether a one-shot entry is good enough**, or whether the review card needs to be editable before Save. It is deliberately read-only for now: the manual form is one tap away and re-running the model is cheaper than building a second editor.

---

## 14. Phase 10 — leaving, re-timing and reordering a session (2026-09-23)

Three owner notes from the device, verbatim: *"confirm in progress workouts not getting cleared, should be same for going to rest of the app"* · *"workout duration should be editable"* · *"be able to reorder exercises in a workout"*. No migration: head stays `0061`. The live logger and the logged-session editor are one screen (`app/workout-live.tsx`, editing when opened with `workoutId`); `app/workout-log.tsx` is the free-form logger, and after the review round (§14.8) it follows the same leaving rule.

### 14.1 Every way out of an open session, from the code

| Way out | Before | Now |
| --- | --- | --- |
| Header back / iOS swipe back | `beforeRemove` asked *Discard this workout?* — **Keep logging** (stay) or **Discard** (draft deleted). There was no way to leave and keep the session. The swipe was worse: the listener was added with `addListener`, which native-stack does not honour for the gesture (`NativeStackView` sets `preventNativeDismiss` only from `usePreventRemove`), so the swipe could leave while the alert was still asking. And a session with exercises but nothing typed was never written at all, so leaving it lost it silently, start instant included. | Leaves. Nothing is asked and nothing is cleared — every change is already in the slot, exactly as after an iOS kill, and a session is in the slot from its **first exercise**, typed into or not (§14.8). The one exception: if the last draft write threw, leaving asks *Leave without a saved copy?* |
| Switching tabs | Not reachable: the logger is a root-stack screen that covers the tab bar. | Same. |
| Pushing another screen from the logger (a block's title → exercise detail) | The logger stays mounted underneath with its state; back returns to it. Nothing lost. | Same. |
| A notification tap (reminder, protocol item, check-in) | `router.push('/')` / `('/(tabs)/coach')` dispatches a stack PUSH, so a second `(tabs)` lands on top with the logger still mounted beneath (read from the code; a device should confirm). From there the Train hub can **resume** the same draft into a second logger, **finish** it, **discard** it or **start new** — and the logger underneath, once returned to, still held its session in memory: its next keystroke would overwrite whatever was in the slot, and its Finish would save the workout a second time. | The logger re-reads the slot whenever it regains focus (§14.2). Same session, written by the other copy → it adopts that copy. Slot emptied, or holding another session → it closes to one line and never writes, finishes or clears again. Finish checks the same thing first. |
| App to background | Stays mounted; the draft is already written; both clocks count from instants. | Same. |
| iOS kills the app | The draft survives in `workout_drafts` (0045). The app relaunches on Home, which said nothing; the way back was Train → Session in progress → Resume. | Same survival, plus **one row on Home** that resumes it directly (§14.3). |
| Opening the logger again from another entry point while a draft exists | Every hub door into the live logger goes through `guardedStart` (Resume it / Start new / Cancel). Opening a logged session (`workoutId`) writes no draft, so it cannot clobber one. | Same, plus Home's row (a resume). A logger pushed without a guard over a foreign session goes stale rather than writing over it: a new screen reads the slot on mount, before its first write can land. |
| Finish, when something after the save throws | `touchRoutineStarted`, the watch link and pair-on-save shared the save's `try`: a throw there showed *Save failed — Nothing was changed* about a workout that HAD been saved, and left its draft on screen one tap from saving it twice. | The save has its own `try`; everything after it is bookkeeping in a second one — the split `workout-log.tsx` already made. |

Discarding is now its own control, **Discard workout**, under Finish (the old confirm's words and two taps), beside the hub's trash. A live session left open keeps its OS rest alert queued, as a kill already did; the resumed screen restores the countdown, does not re-arm it, and **adopts** it through the id the draft carries (§14.8), so dismissing, bumping or replacing the rest there — or Finish, or Discard, or the hub's trash — cancels it.

### 14.2 The session id, and why a screen can go stale

The live slot is one row, and a logger can now outlive its claim on it. So `LiveDraft` carries an optional **`sessionId`**, minted when a session starts and carried through every write, resume and start adjustment. It is **not a version bump**: a draft written before it existed is identified by its `startedAt` (`liveDraftSessionId`), which is unique per session in practice, and the next write replaces it with a real id — the reasoning that let `ingestId` land without one.

`liveSlotState(stored, sessionId)` answers `free` / `mine` / `other`; only a missing row or one from another build is `free` — any draft that parses is a session, typed into or not (§14.8). The logger reads it when a new screen mounts, when it regains focus, and before Finish: nothing writes a draft except the focused logger, so those are the only moments another screen can have touched the slot, and the per-keystroke write path is unchanged. `free` means "ended elsewhere" only to a screen that had written (or resumed) the session; a fresh screen that has written nothing is simply fresh. `clearOwnDraft` refuses to delete another session.

Each of those decisions is a pure function in `src/lib/exercise/draft.ts`, pinned branch by branch in `db/exercise.test.mjs` §14: `liveSlotLoss` (ended / other / still mine, and the fresh-screen case that must not read as ended), `mayClearLiveSlot`, `liveFocusDecision` (keep / adopt the other copy's write / stale) and `leaveGuard` (leave / ask about a failed write / ask about an edit's changes — it has no outcome that clears anything).

### 14.3 The way back in: Train hub and Home

The **Train hub's** Session in progress card is unchanged and stays the full surface (both loggers, resume or discard). **Home** gains one row under the status line: `Workout in progress · 3 sets done · started 14:02` with `RESUME ›` — see `docs/home-screen.md`. Home, because it is where the app lands after a kill, and the question it answers ("what should I do right now") sometimes has the plain answer *finish what you started*; one mono row and no device, because an open session is a fact about now and CLAUDE.md §5 allows Home one hero. It states a clock time, not an elapsed count, because Home does not tick; a session with nothing stamped yet reads `Workout in progress · started 14:02`, with no count. The free-form logger's draft is not on Home.

### 14.4 Duration

`workouts` stores `duration_min` (a figure) and, for a timed session, `started_at` (an instant); there is no end column. So nothing new is stored:

- **A logged session edits the figure.** The editor's clock line is now `Today [ 47 ] MIN` — a number pad in the recessed stock every entry field here uses. Blank stores NULL ("no duration"); a figure the owner types must be whole minutes 1–999 (`parseDurationField`), with Save held and the margin saying why. **An untouched field never holds Save** and writes back the stored figure exactly, whatever it is — the Coach and imports can store 0, 0.3 or 1,200 minutes, and none of those round-trips through a whole-minutes field (`editedDuration`; until the review round a stored 0 held Save over a field nobody had touched). `started_at` is left alone: correcting "60, not 20" moves the end, the fact that was wrong. A changed figure (`editedDuration(…).changed`) runs a pairing pass after the save.
- **A live session edits the START**, never the elapsed number: `started 14:02  [−5 min] [+5 min]` under the clock (`shiftSessionStart`) — the smallest honest version of "I forgot to press start", in the step people misremember by. Bounded to `[now − 6 h, now]`, the same six hours Finish's clamp records at all; a stepper that cannot move is drawn off. Finish derives both the duration and `started_at` from the start, so the correction reaches both.

Every reader of a duration reads the column at query time, so the edit reaches each with nothing to invalidate — checked one by one:

| Reader | Sees the edit? |
| --- | --- |
| Hub session line (`listRecentSessions` → `sessionDetail`) | yes — pinned, `db/exercise.test.mjs` §13 |
| The week's cardio minutes (`weekSummary`) | yes — pinned, §13 |
| Coach daily series (`trainingDailyTotals`) | yes — pinned, §13 |
| Coach payload (`get_training_summary`, `get_today_snapshot`) | yes — `get_training_summary` pinned, `db/coach-tools.test.mjs` §46; the snapshot selects the same column |
| Watch pairing — the span rule (`started_at + duration_min`) and the day rule's closest-duration / `DAY_PAIR_MIN_RATIO` test | yes, on the next pass, and the editor runs one when the figure changed — pinned, `db/wearables.test.mjs` §26. An **existing** link is not re-judged: the Unpair line on the same screen is the door out of one. |
| Readiness strain | does not read a duration at all — it grades logged SETS (and active energy); unchanged by design |
| Calories | ARC computes none from a duration; kcal only comes from a paired watch record, joined, never copied |

### 14.5 Reorder

A **Reorder** control (label voice, off the accent budget) sits above the exercise list whenever there are two things to put in order. It folds the set tables into one ruled plate — **Order** — a row per movable unit with an up and a down control; no drag library. The order is the blocks array: the draft serialises it, and Finish / Save writes the sets in block order, so `workout_sets.set_index` 1..n is the persisted order (`replaceWorkout` re-inserts in the order given). No new field.

**A superset moves as one** (`src/lib/exercise/block-order.ts`). A superset is `linkedToNext` on the upper block — "bound to whatever sits below me" — so moving one member past its partner would silently re-bind it to a stranger or split the pair. The unit of movement is the segment (a maximal bound run, or one block); a segment steps past the whole neighbouring segment, never into it. The Order plate says so, and says how to move one exercise alone: split it at the seam first. A bind dangling off the last block is cleared by any move, and **removing** the lower half of a superset no longer leaves the upper half bound to whatever came next (`removeBlockKeepingBinds` — a latent bug the reorder would have exposed).

The **watch pairing (0054)** is a link from the SESSION to a HealthKit record; a reorder rewrites sets under the same workout id, so the link row is untouched — pinned, `db/wearables.test.mjs` §26.

**Reopening a reordered session** (`storedBlockRuns`, the same module). The editor cuts the stored flat set list back into blocks. It used to continue a block on the same movement alone and read every bind from the first group it saw per movement — so a lone Bench moved directly above a Bench + Row superset (stored `bench(–) bench(1) row(1)`) reopened as ONE Bench block with no superset, and the next Save wrote every group back as NULL. Now a run continues only on the same movement **and** the same group, and each block's bind is read from its own group against its neighbour's. Two neighbouring blocks of one movement still reopen as one block only when they share a group (or both have none) — then nothing is lost, because the merged block writes every set back with that same group. A side effect worth having: a free-text block's bind, which Save has always written, is read back too.

### 14.6 Tests

`db/exercise.test.mjs` §13 (segments, moves, dangling binds, removal, persisted order and groups, the start bounds, the minutes field, every reader, slot ownership, the legacy identity, Home's line) and §14 (the review round: a session from its first exercise, `liveSlotLoss` / `mayClearLiveSlot` / `liveFocusDecision` / `leaveGuard` branch by branch, the rest-alert id through the store, `editedDuration` on untouched 0 / 0.3 / 1000 / 1200.5 and on typed figures, `storedBlockRuns` on the reordered-superset probe and its neighbours, and the stored-groups round trip through the repository) · `db/wearables.test.mjs` §26 (both pairing rules read a corrected figure; a reorder keeps the link) · `db/coach-tools.test.mjs` §46 · `db/screens-render.test.mjs` §23 — the live logger is on the render walk for the first time, through a `react-native-reanimated` stub (`db/render-stubs/react-native-reanimated.mjs`; the package cannot load under node); since the review round it also renders an untouched session on Home, the hub and the logger, a stored 0-minute session with Save enabled, the reordered superset reopening with its seam, and the free-form logger's Discard control.

The §13 / §46 / §26 "every reader" rows call `replaceWorkout` directly: they prove the readers read the column, not that the editor writes the right figure. The editor's half is `editedDuration`, pinned in §14.

### 14.7 What only a device can settle

- **Leaving by swipe.** The gesture was never blocked natively; what is new is that nothing is asked. Confirm no alert appears over a screen that has already gone.
- **A notification tap mid-session** — that it pushes the tabs over the logger (as read from `router.push`), and that coming back to the logger after finishing or discarding from the hub shows the one-line notice rather than the old session.
- **The rest alert after leaving mid-rest** — it is now left queued on purpose; whether it fires while elsewhere in the app is the same unconfirmed question §6 already carries. And that the resumed screen's dismiss / next set / Finish really cancels the adopted one.
- **An untouched session kept.** Tapping Start and backing straight out now leaves a Session in progress card and a Home row until it is discarded. Whether that reads as honest or as noise is the owner's call on the device.
- **Home's row** — whether one mono line is enough presence after a kill, and whether `RESUME ›` reads as a door.
- **The start steppers** — whether five minutes is the right step, and whether the row crowds the clock line on a 375pt screen.
- **Reorder** — whether folding the set tables away is the right shape for a long session, and whether 44pt arrows in a plate are easy to hit mid-set.
- **The free-form logger's way out** — that backing out of *Log a session* now leaves quietly and the hub's card brings the draft back, and whether *Discard session* under Save is findable.

### 14.8 The review round (2026-09-23)

An independent review of the first cut found five things the code did not do as this section claimed. Each is fixed, and each fix is pinned in `db/exercise.test.mjs` §14 or `db/screens-render.test.mjs` §23.

- **A session is kept from its first exercise, typed into or not** (`liveSessionOpen`). The first cut still wrote a draft only once a value was typed, so a saved workout started, warmed up for and left to check Home came back as nothing: no Home row, no hub card, and starting it again restarted the clock. That was the owner's complaint itself. Now the write-through runs whenever the session has a block — on mount, for a session started from a saved workout — and the hub's card, Home's row, the logger's Resume and the slot protection all accept any draft `parseLiveDraft` accepts. `draftBlocksHaveData` is narrowed to what it always really decided: whether Finish can run, and what Discard says it deletes. The cost is one Discard for a session started by mistake; §14.7 asks the owner whether that is noise. Because a new session's first write now happens on mount, before the focus check runs, a **new screen reads the slot in its initial state**: a session already there (reachable only past the hub's Resume it / Start new question) sends the screen stale instead of being overwritten. After mount only the focus check can find the slot changed, since nothing writes a draft except the focused logger.
- **The rest alert rides the draft** (`LiveDraft.restAlertId`, optional, no version bump). The first cut left the alert queued on leaving but gave the resumed screen no way to reach it, so a dismissed rest, a ±15, the next set's rest, a Finish or a Discard all left the old alert to buzz at its original time. Now the resumed screen adopts the id (and so does a screen adopting another copy's write on focus), and the hub's trash and *Start new* cancel it before clearing the slot. One window stays open: an id that arrives from iOS after the screen has already gone (the schedule is async — milliseconds) never reaches the draft; that alert still fires on time, it just cannot be cancelled early.
- **A reordered superset survives a reopen** (`storedBlockRuns`, §14.5).
- **An untouched duration never holds Save** (`editedDuration`, §14.4).
- **The free-form logger leaves the same way.** `app/workout-log.tsx` asked *Discard this workout?* on back, so the two loggers did opposite things on one gesture. It now goes through the same `leaveGuard`: backing out keeps the draft (the hub's Session in progress card resumes it), a failed draft write is the only question, and *Discard session* (*Discard workout* in its live mode) is a muted control under Save, the old confirm's words and two taps. Its write-through also records a write only once it lands, as the live logger's does. Its draft is still not on Home: a past session being typed up is not a fact about now.

What the review round did not add: the free-form logger has no session id, so the notification-tap double stack §14.1 fixes for the live logger is still possible there. That predates this change — a push over the logger never went through `beforeRemove` — and is left as an open question rather than a second copy of §14.2.

### 14.9 Saved workouts reorder too (2026-09-23)

An independent verifier found the gap the owner was most likely to hit: the saved-workout editor (Train › Saved workouts › Edit, `app/routine-edit.tsx`) could only append and remove lines. Moving an exercise meant removing it and adding it again, which threw away the sets, rep range and rest typed on that line. No migration.

**The same interaction, the same helper.** The editor gets the session's Order mode: a **Reorder** toggle above the list (label voice, off the accent budget, drawn only when there are two lines), and in reorder mode the **Order** plate takes the Exercises plate's place, one row per line with an up and a down control. The plate is `src/components/exercise/exercise-order.tsx`, lifted from the logger's local `ExerciseOrder` so the two screens draw the same component. The move is `moveBlockSegment` from `block-order.ts`, reached through `moveRoutineLine` in `src/lib/exercise/routine-lines.ts`. There is no second ordering algorithm. `app/workout-live.tsx` was left alone for this change (other work was in flight on it); it still has its own copy of the plate and toggle, and switching it to the shared component is a mechanical follow-up.

**A line moves whole.** The helper reorders the array and copies nothing it does not have to, so every field typed on a line goes with it, including an edit made just before the move. Save is unchanged: `routineExerciseInputs` maps the lines in their current order and `updateRoutine` / `createRoutine` number `position` 1..n from that order (`insertLines`). The editor's line model (open, add, move, save mapping) moved out of the screen into `routine-lines.ts` so the tests round-trip the editor's own code, not a copy.

**The list is one reducer; the section is a plain function (review round).** The first cut kept `reordering` and the move in closures inside the screen, and its render check drew the Order plate on its own, so deleting the plate swap from the editor, flipping an arrow's direction or unwiring the toggle all left the suite green. Now the lines, the mode and the next key are one pure `routineListReducer` in `routine-lines.ts` (`add`, `update`, `remove`, `move`, `toggle-order`; `showsOrder` / `canReorderLines` are its selectors), and the editor holds it with `useReducer` and does nothing to it but dispatch. The list section (the Reorder door, the plate swap, the Exercises and Order plates, Add exercise) is `RoutineLinesSection`, a hook-free named export of `app/routine-edit.tsx` that takes the state and `dispatch`. That lets the render suite press the real Reorder button and the real arrow through the element tree, run the actions through the real reducer, and redraw.

**An Order row says its line's targets.** The picker allows one exercise twice (a heavy top set and a back-off line), and reorder mode folds away the fields that tell those lines apart, so the first cut drew two identical `Barbell Bench Press` rows with identical VoiceOver labels. `OrderItem` now takes an optional `detail`: the editor passes `routineLineTargets(line)`, drawn in mono under the name (`1 × 3 · 240 s rest`, `3 × 8–12 · 90 s rest`, `3 sets` for a hold) and spoken in the arrows' labels without the symbols ("Move Barbell Bench Press, 1 set of 3, 240 seconds rest, down"). The figures are the fields as typed; blank sets reads 3, the placeholder and what Save writes. The logger passes no detail, so its rows are unchanged.

**Supersets: a saved workout cannot carry one.** `routine_exercises` (0012) has no group column and `RoutineExerciseInput` has no bind. A session started from a saved workout begins with every block unbound, and a superset made during it lives on that session's sets only. So every editor line is `linkedToNext: false` (typed as the literal) and each is its own segment. If saved workouts ever store a superset, the session's rule, that a superset moves as one, already applies, and the test pins that.

**Should Finish offer to save a session's new order back to its saved workout? No (recommendation, not built).** Three reasons:
1. A session's order is often a fact about that day (the rack was taken, the cable station was busy). A question on every reordered Finish would ask about the one-offs as often as the real changes, and a question the owner learns to dismiss is noise at the moment he is closing a workout.
2. The session is not a copy of the saved workout. It drops the rep range (the logger takes only sets and rest from a line), it may have exercises added or removed mid-session, and it may hold a superset the saved workout cannot store. "Save this order back" would need rules for all three, and each rule is a way to quietly change a plan the owner did not open.
3. The permanent change now takes two taps where it belongs: Train › Saved workouts › Edit › Reorder.

If the owner asks for it, the smallest honest version is a quiet line after Finish, not a question in the Finish path.

**Tests.** `db/routines.test.mjs` §8: a stored routine opens with every line unbound; each press moves one line past one neighbour; the ends return null; a move copies no line; `moveRoutineLine` returns exactly what `moveBlockSegment` returns; an edit rides with its line; the reordered routine saves through `updateRoutine` and reopens in the new order with positions 1..n and every set count, rep range and rest intact, nulls included; a new routine reordered before its first Save is created in that order; the sets clamp; a bound pair moves as one unit whichever member is pressed; Save writes no bind. §9 drives `routineListReducer` as the editor does: open, Reorder, two down presses (the direction is checked), an end press that returns the same state, an add in Order mode with a fresh key that is never reused after a removal, a field edit that reaches its line wherever it now sits, then Save through `updateRoutine` in the new order; one line never shows the Order plate. §10 pins `routineLineTargets`, including that two lines of one movement read differently, drawn and spoken. `db/screens-render.test.mjs` (next to the A9 check): the whole editor draws the Reorder door with two lines and not with one or none; then `RoutineLinesSection` is drawn on the fields, its Reorder button pressed through the element tree, drawn again (the Order plate with the targets under each name, the two end arrows disabled, no target fields, no remove buttons, no superset copy), the plank's up arrow pressed, drawn in the new order, Done pressed, and the fields drawn back in that order with their values. A routine with the bench twice draws two distinct rows. Removing the plate swap, flipping the move direction or unwiring the toggle each fails the suite (checked by mutation).

**What only a device can settle:** that the mono targets line fits under a long exercise name at 375pt without crowding the arrows, that the toggle-then-arrows flow is quick enough for a six-line workout, and that the 40pt jump when the second line appears (the toggle row arriving above the list) reads as the door appearing rather than as the page lurching. The logger has the same jump.

---

## 15. Phase 11 — what a weight counts, and how a lift is trending (2026-09-23, migration 0062)

Two owner notes from the device, 2026-09-23:

1. *"indicate whether weight is per arm, total, etc. for different exercises"*
2. *"trends, prs, etc for exercises (i.e. fitbod)"*

### 15.1 The load basis — six answers to one question

Every movement that records a load says what its figure counts. `src/lib/exercise/load-basis.ts` is the one place that decides it; the logger heading, the detail screen, the Train hub, the self-review and the Coach's payloads all read it from there.

| Basis | Heading | What the figure is | Derived for |
| --- | --- | --- | --- |
| `total` | TOTAL | the whole load; a barbell counts the bar | barbell, EZ bar, trap bar, Smith, plate, medicine ball, band, other; a dumbbell or bell held in both hands (goblet, swing, pullover, French press / overhead triceps extension) |
| `per_hand` | PER HAND | one dumbbell, bell or handle; the other side carries the same | dumbbell and kettlebell by default; any cable movement named single-arm / one-arm / alternating, or unilateral with an upper-body pattern |
| `per_side` | PER SIDE | one side of a two-sided load: the plates on one side, or one of two cable stacks | a cable fly or crossover (two stacks, one handle each); a machine named iso-lateral or plate-loaded |
| `stack` | STACK | the number on a selectorised machine or cable stack | `machine` and `cable` otherwise |
| `bodyweight_plus` | ADDED | load added to bodyweight (belt, vest); blank is bodyweight alone | `weighted_bodyweight`, and any loaded movement on bodyweight / pull-up bar / suspension / bench equipment |
| `assisted` | ASSIST | the help a machine gives; a lower number is harder | `assisted_bodyweight` |

The order of the rules is the argument (`deriveLoadBasis`): the logging type first (weighted and assisted bodyweight say it outright), then equipment, with the name and aliases refining it where one piece of equipment is used two ways. A movement that records no load — a plank, a push-up, a run — has no basis at all (null), because there is no figure to describe. All 69 seeded rows are pinned in `db/exercise-catalog.test.mjs` §10, with fifteen rows the seed does not carry for the name rules.

**Plate-loaded machines: decided as "per side is the owner's correction, never a derivation from `machine`".** The catalog's `machine` covers a selectorised stack and a plate-loaded sled alike, so the seeded Leg Press and Hack Squat read `stack` until the owner says his are plate-loaded. Deriving `per_side` from the name "leg press" would be right in one gym and wrong in the next; the correction is one tap.

### 15.2 Migration 0062 — only the owner's correction is stored

```sql
ALTER TABLE exercises ADD COLUMN load_basis text CHECK (
  load_basis IS NULL
  OR load_basis IN ('total', 'per_hand', 'per_side', 'stack', 'bodyweight_plus', 'assisted')
);
```

- **NULL is ARC's reading; a value is the owner's.** The derivation is never written into the table: a stored copy of a derived value is a second definition that stops improving the day it is written. No backfill.
- **Choosing ARC's own reading writes NULL**, so a non-NULL can only ever mean "the owner disagreed" (`setExerciseLoadBasis`). The detail screen says *Set by you* when it is his — 0034's rule that an asserted value and a derived one must not wear the same face.
- **A correction relabels; it never rescales.** No `workout_sets` row is read or written. The owner typed the number on the dumbbell all along; only what the number is called changes.
- **Vocabulary-only CHECK, closed at six.** `exercises` parents three foreign keys, so widening this CHECK is the twelve-step rebuild; the question "what does this figure count" has no seventh answer (a band's tension is not a weight, a sled is `total`).

### 15.3 Is a per-hand figure doubled? No — and where that was checked

| Computation | Reads weight? | Per-hand figure doubled? | Why |
| --- | --- | --- | --- |
| Records, best at each rep count, live PR stamp, history PR mark | yes, within one movement | **no** | one movement's basis is the same on every set, so doubling changes no comparison and makes every number disagree with the dumbbell in his hand |
| e1RM / top-set / volume trends, direction of travel | yes, within one movement | **no** | same |
| Progression target, stall/deload, prefill | yes, within one movement | **no** | the target is the next dumbbell, and the increment is per dumbbell |
| Freshness, weekly volume, the strain pillar, `weekSummary` | **never** | n/a | 0055's header; a basis correction is pinned to move none of them (`db/training-engine.test.mjs` §12) |
| Coach payloads | as logged | **no** | the figure rides with `loadBasis` beside it; the model does its own arithmetic knowing what the number is |
| Anything summing load ACROSS movements (tonnage) | — | **only through `loadMovedKg`** | nothing does today. `per_hand` / `per_side` ×2, `total` / `stack` / `bodyweight_plus` ×1 (body excluded — ARC does not know what it weighed that day), `assisted` refuses |

**Assisted movements set no load records**, because a higher figure is an easier set: the heaviest, the best e1RM and the best at each rep count would all crown the easiest work. `loadRecordsApply` is the gate, and it is applied at the SOURCE rather than per screen: `personalRecordsOf` returns null load records and `repMaxesFrom` an empty table for an assisted movement, so the detail screen, the Coach's `exercise_stats` (which also leaves out `repMaxes` and `e1rmSeries` for one) and `personalRecords(db, id)` (which reads the basis itself) all agree. The records grid shows only the rep counts, as facts; the PR stamp stays silent (reps at different assistance are not comparable either); the self-review gives an assisted movement no e1RM delta row and no record; and `progressionFor` says *Take assistance off as the reps allow* rather than suggesting more assistance (it used to add the increment to the assistance — a latent bug with no seeded movement to trip it).

**An assisted session's top set is ranked the other way** (`setStrength` in training-stats.ts). The e1RM of the assistance picked the set with the MOST help, so the history and the hub row showed the easiest set of every session. It now ranks by reps, and among equal reps by less help — reps first because the movement's direction of travel reads reps, so the hub row's top set and its arrow describe the same thing. `exerciseSessionTopsFrom` takes the basis; `exerciseSessionTops(db, id)` reads it itself.

### 15.4 Where the basis is shown

- **Live logger and the session editor** (one screen): the load column heading is two lines, unit over basis — `LB` / `PER HAND`. Two lines because the column is about 63 pt at 375 pt and "KG · PER HAND" in tracked 10 pt capitals needs about 90 pt; one line would break wherever the text ran out. Label voice, no accent. The basis is read from the catalog, not the draft, and re-read on focus: the block title opens exercise detail, which is where it is corrected.
- **Exercise detail**: a *Weight* line under the meta (the basis, one sentence of what it means, *Set by you* when it is his, and *Change* opening the six chips), and a `kg · per hand` note on Records, Trend (weight metrics), Best at each rep count and History — once per section, not on every number.
- **Train hub**: each Exercises row's latest set reads "8 × 30 kg per hand", because that line has no heading above it.
- **Self-review report**: a movement is named with its basis — "Dumbbell Bench Press (per hand)" — because a report read months later has no column heading.
- **The Coach's `log_workout` card**: each set line says what the weight counts before he approves it — "Dumbbell Bench Press 8 × 60 lb per hand", "Barbell Bench Press 5 × 225 lb total". This is the write path where a misread basis does lasting harm: 60 lb per hand stored as a total would raise the movement's records for good. The basis is resolved per set from the catalog (`exerciseLoadBases`); a free-text movement states none. Card text, not schema — the §6 ceilings are untouched.
- **Not changed**: the manual logger (`workout-log.tsx`) and the photo-import review still take a bare weight; their inputs belong to the branch rewriting timed-set entry.

### 15.5 Fitbod, audited against ARC

| Fitbod gives, per exercise | ARC before 2026-09-23 | ARC now |
| --- | --- | --- |
| Estimated 1RM over time | a 120 pt sparkline of the last 12 session-dates, no extent, no direction | **Trend** field: one point per session (24), the latest value, the date extent and session count, and the direction against the previous three home sessions ("+4% on the previous 3 sessions"). It opens on the metric the data can draw (§15.7), not always e1RM |
| Max weight history | the single heaviest set | **Top set** trend chip, alongside the record |
| Max volume history | best single-set volume only | **Session volume** record and a **Volume** trend chip (Σ weight × reps per session) |
| Max reps history | nothing — and a push-up's whole records grid was three em-dashes | **Most reps** and **Session reps** records, and a **Most reps** trend chip; a push-up's grid is now its reps, and a pull-up logged at bodyweight gets a reps trend and direction |
| Best weight at each rep count | nothing | **Best at each rep count**: exact counts 1–20, the date each was first reached, home sessions only; when empty it says why ("No sets with added weight yet.") |
| A PR marked the moment you hit it | an e1RM-only "PR" at the block foot | **every record on the Records grid stamps** — best e1RM, heaviest, best at N reps, best set volume, best session volume, most reps, most reps in a session, longest, farthest, fastest pace, as the movement has them — and the foot says which: "Set 3: best e1RM, heaviest · Set 4: best session volume". Assisted movements are the one exception (§15.3) |
| PRs visible in history | nothing | **PR** on each history row whose session set a record at the time — the live stamp's own rule |
| PRs in the self-review | e1RM only, first-ever session counted, away sessions counted | still e1RM only (the report's line is an estimated 1RM), but through the live stamp's rule: home only, and it must beat an earlier best |
| A way into any exercise's history | the picker's records button, or a block title mid-session | **Exercises** on the Train hub: every movement trained, most recent first, latest top set and direction; six rows, then *Show all* |
| Time ranges (1M / 3M / 1Y) on the chart | — | **not built**: 24 sessions with a stated extent covers a year of a twice-weekly lift; a range picker is the next step if the owner wants it |

Not on Home (CLAUDE.md §5).

### 15.6 The PR rule — one function, four surfaces

The live stamp (`stampFor` → `recordsBeaten`), the history's mark (`recordSessionIds`) and the self-review's record line (`e1rmRecordOf`) all ask `kindsBeating` in `src/lib/exercise/records.ts`. The Records grid is drawn from the same list (`recordKindsFor` → `recordCellsFor` / `recordCellsOf`), so **every record on the grid is one a set can stamp, by construction** — a test walks every measure/basis pair and fails on a grid cell with no kind or a kind with no cell. (Until the review the screen chose its own cells: Set volume, Session volume, Session reps and a loaded lift's Most reps sat on the grid and never stamped, and a plank's grid carried a Top set and a Set volume it could never fill.)

- **Kinds by what the movement measures and counts** (`recordKindsFor`):

  | Movement | Kinds (each is a grid cell, except `rep_max`, which is the table) |
  | --- | --- |
  | reps + load | `e1rm`, `weight`, `rep_max`, `set_volume`, `session_volume`, `reps` |
  | reps + load, `bodyweight_plus` | `reps`, `session_reps`, `weight`, `e1rm`, `rep_max` — no volume: added-load volume leaves the body out and is not a figure anyone reads |
  | reps + load, `assisted` | none (§15.3); the grid shows Most reps · Session reps · Sessions as facts |
  | reps only | `reps`, `session_reps` |
  | load only | `weight` |
  | time / distance | `duration` / `distance`, and `pace` (over at least `PACE_PR_MIN_M`) with both |

- **Most reps on a loaded lift needs the load typed.** A blank weight on a bench set is a typo, not a record; where the load is optional (a push-up, an unweighted pull-up) a blank weight is the movement.
- **A session total stamps the set that carries it over.** Best session volume and most reps in a session belong to the session, so the one set that takes the running total past the old best is stamped — once per session, however many sets follow.
- **An away session stamps nothing** (0055). The rule lives in `recordsBeaten`, so no caller can award an away PR by forgetting to ask; turning Away on still clears the stamps already earned.
- **A record needs a previous best.** The first session of a movement sets its bars silently, and a first-ever set of three is not a "best at 3 reps". This changes one old behaviour: the e1RM-only stamp used to tag the first set of a never-done movement as a PR. The self-review follows the same rule — a movement's first-ever session is no longer listed as a personal record there.
- **Within a session a set must clear the sets already done — in every block of the movement.** bench → row → bench is one session of bench, so the second bench block is measured against the first (`stampFor` gathers done sets from every block with the same `exerciseId`; it used to read only the set's own block, and a repeated movement stamped the same record twice). The bar is read from the logged history (the live session is a draft until Finish, 0045) plus those sets; nothing is cached, and `DraftBlock.bestE1rm` is no longer read.
- **A done set whose numbers change is asked again.** `patchSet` in the logger re-runs `stampFor` when a done set's weight, reps, RPE, time, distance or set type changes, so a corrected typo (1100 back to 110), a changed rep count ("best at 5 reps" becoming 6) or a set cycled to warmup does not keep a claim about figures it no longer holds.
- **`stampFor` is the whole of the live question, as a function.** It takes the logger's own state (typed strings, blocks, the away flag, the editing flag) and is tested with block-shaped input in `db/training-engine.test.mjs` §13 — the screen only reads the history and passes it through.
- **The stamp names its kinds** on the draft (`DraftSet.prKinds`, optional and parsed leniently — no `DRAFT_VERSION` bump, the `ingestId` precedent). A set stamped by an older build resumes with the bare "PR".
- **`rep_max` is dropped from the line when the set is also the heaviest**: the heaviest set on record is necessarily the best at its own rep count.
- **The line is prose with its figures in mono.** `prSummaryParts` marks the set number and rep counts as measured; the screen sets the words in the serif and only those runs in mono ("Serif speaks, mono measures"). The same for the Trend's direction line (`trendPhraseParts`: "+4%" and "3 sessions" in mono).

### 15.7 Trends and the direction of travel

`sessionSeriesFrom` gives one value per session for `e1rm · top_weight · volume · reps · session_reps · duration · distance`; `trendMetricsFor` chooses which a movement offers from what it measures. `trendOf` compares the latest **home** session with the mean of up to three home sessions before it and reads *level* within ±2%. A mean of three, because one bad Tuesday is not a direction; home only, because a stiffer machine is not a regression. Away sessions stay on the chart, hollow.

**The direction and the chart it opens are one function** (`directionOf`). A lift reads its e1RM; when fewer than two home sessions carry one (sets past the e1RM rep cap, or logged below RPE 6) its top weight; and when its sets carry no weight at all — a pull-up or dip at bodyweight, the commonest way to do either — its most reps. Plank-type movements read their longest hold. **Anything that covers distance gets no arrow** — whether a run is "better" longer or faster depends on what it was for.

Exercise detail opens its Trend on `defaultTrendMetric`: the direction's own metric when there is one, so the hub's "+10%" on a leg extension opens on the Top set chart it came from rather than an empty e1RM one; otherwise the first metric with two sessions to draw; otherwise the first the movement offers. When a chosen chip has nothing to draw, `trendEmptyNote` says what is missing ("An estimated 1RM needs a set of 12 reps or fewer that is not logged below RPE 6. Fewer than two sessions have one.") rather than claiming two weighted sessions are needed when five are on record.

**The large figure is the session the direction line describes** (`trendHeadline`). When the last point on the chart is an away session, the figure shows the home value the "+4%" was read from, labelled *Latest at home*; with no direction to explain, the away value, labelled *Latest · away gym*.

**`exerciseSessionTopsFrom` compares a tier, then a value.** A set with no load, time or distance used to score a flat zero, so a push-up session's "top set" was whichever set came first; it now compares reps, in a tier below every loaded set so reps and kilograms never mix (a weighted dip of 10 kg × 8 outranks a bodyweight 15).

### 15.8 The Coach

Payload, never schema — coach-eval §6's ceilings are untouched:

- `query_records { domain: "exercise_stats" }` returns `loadBasis`, the extended `records`, and `repMaxes`, from one scan; the history's workout ids are stripped (a UUID per row answers nothing for the model). For an assisted movement the load records are null, `repMaxes` and `e1rmSeries` are left out, and the top sets are ranked by reps then less help (§15.3).
- `log_workout`'s confirmation card states the basis on each set line (§15.4).
- `query_records { domain: "exercise_catalog" }` rows carry `loadBasis` on loaded movements; the vocabulary sentence is on the domain's discovery call, where field notes live instead of the prompt.
- `get_training_recommendation` exercises carry `loadBasis`, so a 22.5 kg dumbbell-press target is read as one dumbbell.

The Coach cannot yet **correct** a basis; that would be an editable field on `exercise_catalog`, the parity rule's next step.

> **Built 2026-09-25** — the owner's *"Yes, let the Coach correct it too."* `loadBasis` is an editable field on the Coach's `exercise_catalog` domain, through `setExerciseLoadBasis`, the chooser's own function (so picking ARC's reading stores NULL, as a tap does). Its card says old → new in the chooser's words and closes on the chooser's consequence line, one constant now (`LOAD_BASIS_CONSEQUENCE`): *Change what the weight on "Leg Press" counts: on the stack → per side. Changing it relabels every set already logged. No number changes.* A movement that records no load, a no-op and a retire-and-relabel in one call are refused at card time. `docs/coach-domains.md` §10b; `db/coach-domains.test.mjs` §7d.

### 15.9 Tests

`db/exercise-catalog.test.mjs` §10–11 (every seeded row's basis, the name rules, correction storage and reset, relabel-not-rescale, the CHECK, the heading, the doubling table) · `db/training-engine.test.mjs` §10–12 (the three new records, rep maxes, every PR kind and its refusals, session totals stamping the set that carries them over, the grid and the stamp reading one list, the history mark, trends and direction, the hub list, the per-hand decision, a correction moving no freshness or volume) and §13 (the review fixes: the hub's metric and detail's default agreeing, a bodyweight pull-up's reps direction, the empty notes, assisted ranking and records, `stampFor` over block-shaped input — two blocks of one movement, away, editing, a corrected set — `e1rmRecordOf`, the Trend headline, the phrase parts) · `db/coach-domains.test.mjs` §4b (the payloads, an assisted movement's included) and `db/coach-tools.test.mjs` §11 and §26 (the basis on the `log_workout` card; the recommendation payload) · `db/reports.test.mjs` §2d (the named basis, an away session setting no record, a first-ever movement listed as no record, an assisted movement getting neither row) · `db/screens-render.test.mjs` §9 (the detail screen, a corrected basis, a push-up's records, a bodyweight pull-up's reps trend and rep-max note, an away last session's headline, a high-rep lift opening on Top set, the hub list, and — through a Reanimated stub — the live logger's headings, the session editor and a resumed PR line drawn as prose with a nested figure).

### 15.10 What only a device can settle

- **The two-line heading** at 375 pt, and whether "STACK" reads as a machine's number or needs to be "MACHINE".
- **Whether the derivation is right for his gym** — the seeded Leg Press, Hack Squat and calf raises read `stack`, and in many gyms they are plate-loaded.
- **The six-cell records grid**: "Session volume" wraps to two lines in a third of 311 pt.
- **Whether "a record needs a previous best" feels right** on the first session of a new movement, where nothing stamps.
- **Whether the fuller stamp is signal or noise.** Every grid record now stamps, so a strong set can read "Set 3: best e1RM, heaviest, best set volume, best session volume" in the block foot at 375 pt. If the volume stamps prove to be noise, the fix is to drop them from `recordKindsFor` — which takes their cells off the grid too, by construction.
- **The Exercises plate's length and place** on an already long hub, and whether six rows before *Show all* is the right number.
