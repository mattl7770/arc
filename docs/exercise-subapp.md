# Exercise Sub-App — Design Spec

**Status:** Phase 3 — **periodization + volume + supersets + rest alerts built** on top of the Phase-2 slice (offline). Everything rule-based; AI-assist remains the only (stubbed) AI seam.
**Last updated:** 2026-07-27
**Window:** parallel build, migrations **0011–0013** + **0020** (integrator finalizes exact numbers at merge)
**Reads:** CLAUDE.md §4/§9 · `docs/information-architecture.md` · `docs/project-status.md` ("exercise as measured data") · `db/migrations/0003_exercise.sql`

> **Phase 3 shipped (2026-07-27).** **Programs / periodization** (migration **0020** `programs`+`program_days`+`program_weeks`): a multi-week mesocycle is a repeating weekly split (weekday→routine) with a length and marked deload/test weeks; one program is active at a time, and "Train today" derives the scheduled session from `active_start` + the calendar weekday, taking precedence over the freshness pick. Repo `programs.ts`, builder `app/program-edit.tsx`, a routine picker, hub Programs section + program-aware Train-today card. **Weekly volume vs MEV/MAV/MRV landmarks** (`src/lib/exercise/volume.ts` + `VOLUME_LANDMARKS`): `weeklyMuscleSets` → per-muscle add/hold/cut verdict, surfaced as the hub's "Weekly volume" section. **Supersets**: the reserved `workout_sets.superset_group` is now written — adjacent blocks link into a superset in `workout-live.tsx`. **Rest-timer background alerts**: `src/lib/notifications/rest-timer.ts` (mirrors `reminders.ts`; one-shot, guarded-native, no-op until the EAS rebuild — FLAGGED). Deload weeks pre-fill fewer sets in the logger. 46 new headless tests (programs 28 + volume/recommend/rest 18). `exercise.ts` exports still byte-stable.

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
| **Routine builder** | `app/routine-edit.tsx` | **new** — name, ordered exercises, targets. Exercise picker is an in-screen modal, not a route |
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
- `freshness_m = 100 × (1 − min(1, fatigue_m / F_full))`, `F_full = 8` (one full hard session's primary sets ≈ fully spent). Display buckets: ≥ 80 fresh · 50–79 recovering · < 50 fatigued.

Cardio logged with kind `cardio` subtracts a flat small fatigue (0.5) from quads/hamstrings/calves per 30 min — the FitBod cross-training adjustment, minimal version.

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

Readiness (sleep/HRV) does **not** modify volume yet — that lands with wearables via Apple Health and routes through the same one modifier function (`recommend.ts` takes an optional `readiness` argument, default neutral — the seam is in the signature from day one).

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
| **Coach model client** (`src/lib/ai/coach-service.ts`) | owned by the parallel Coach window — **not touched.** Slice D calls it through a typed seam (`src/lib/exercise/coach-assist.ts`, honest stub now). |
| New JS deps | **none** — no react-native-svg (existing Sparkline covers charts), no timer libs. |

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
