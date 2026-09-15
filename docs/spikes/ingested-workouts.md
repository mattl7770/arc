# D3 — Ingested workouts → training data

**Status: BUILT** (2026-09-14, migration **0054** — see below for why not the
reserved 0052). The owner answered §6 —
(1a) an inferred load *moves* the freshness figure and is marked inferred;
(2a) it stays out of weekly set counts; (3a) ship pairing now, HR later — and all
three pieces shipped together: pairing, inference, and the blank.
Where the build differs from this proposal, the build is authoritative:

- **The activity table is ROLE WEIGHTS, not fractional sets per hour** (§3.A's
  numbers are superseded). Duration is dosed by 0046's endurance rule, which is
  the same arithmetic a logged run gets — so an ingested 45-minute run reads
  *exactly* as a logged one (quads 57) instead of on a second scale. The
  `CEILING = 6` is gone with it: `ENDURANCE_EFFORT_CAP` already caps a six-hour
  walk at the same place.
- **No `dismissed_at`.** Nothing in this slice writes a tombstone, so the column
  would have been schema that lies about the app; the 14-day horizon bounds the
  inbox instead. The two unique indexes are therefore plain (both columns NOT
  NULL) rather than partial.
- **The day is an index filter, not the rule** (§3.C.1 widened to ±1 day):
  `workouts.date` is a logical day and `wearable_data.date` is a calendar day,
  so one hour of training can carry two day strings. The overlap decides.
- **Auto-pairing is not gated behind a suggestion UI** (§3.C.6): the confidence
  bar it describes — same day, overlap ≥ 0.5, a real `started_at` — *is* the
  auto-pair condition, and a hand link from the blank inbox replaces an
  automatic one.

Shipped documentation: `docs/wearables-subapp.md` §17 (pairing, the link table,
the double-count) and `docs/exercise-subapp.md` §11 (inference, provenance, the
blank). Tests: `db/wearables.test.mjs` §21, `db/training-engine.test.mjs` §9,
`db/coach-tools.test.mjs` §38.

**Still open** (§3.E, the owner's answer 3a): avg/max HR needs a new HealthKit
read scope, a `METRIC_COVERAGE` row and a per-session sample query.

---

**Backlog:** `docs/backlog-2026-09.md` D3 (Phase D, marked **[spec]**).
**Migration:** `0054_ingested_workout_pairing.sql` — **not** the reserved `0052`.
D4 merged `0053` while this was being written, and the runner applies only
`version > user_version`, so a 0052 arriving after a 0053 would be skipped
silently and forever. Every `0052` below in §3–§5 means 0054.
**Assumes B1 has landed** — per-exercise metric types (reps / time / distance).

---

## 1. Current state

### What an ingested workout actually is

One row in `wearable_data` per HealthKit workout object
(`src/lib/health/mapping.ts:560-580`):

- `metric_type = 'workout'`, `value` = **true duration in minutes**
  (HealthKit's `duration`, which excludes pauses — never `end − start`, `:555-558`);
- `start_time` / `end_time` = the span; `date` = the local day the workout
  **ended**;
- `source_raw_id` = the HK sample **UUID**;
- `metadata` = `{ activity, activity_type_raw, kcal, distance_km, hk: { source } }`.

`ACTIVITY_NAMES` (`:519-548`) maps raw ints to labels, and the file says why the
int is the identity: *"raw ints are the stable identity; names have churned across
SDK versions"* (`:517-518`). **Any muscle table must key on the int.**

Coverage for the owner's likely device: Garmin syncs sessions as summaries —
duration, distance, energy — and **no GPS route**
(`src/lib/health/coverage.ts:113-121`). Nothing else about a session comes across.

### Identity and de-duplication are already solved — twice

Migration `0042` (`db/migrations/0042_workout_identity.sql`) keys a workout on the
**UUID alone** (a partial unique index, `:118-120`) and the upsert rewrites
`source_device` in its `DO UPDATE`
(`src/lib/db/repositories/wearables.ts:87-99`), so a re-bucketed source corrects
in place instead of duplicating.

`recentWearableWorkouts` (`:388-439`) solves the *other* duplicate — one run
recorded by both Garmin Connect and the iPhone, two genuine HK objects with two
UUIDs. It collapses rows sharing more than half of the **shorter** session's span
(`overlapFraction`, `:359-366`; `SAME_SESSION_OVERLAP = 0.5`, `:369`), keeping the
`SOURCE_PRIORITY` winner (`:213-224`) and, on a tie, the longer record
(`:407-412`). A row with no readable span is kept, never silently dropped.

> **That is 80% of the pairing algorithm already written and already reasoned
> about.** Pairing should reuse it, not invent a second definition of "the same
> session" — the failure mode `muscleSetsInRange`'s own docstring warns about
> (`src/lib/db/repositories/training-stats.ts:286-292`).

### Nothing links the ingested mirror to ARC's own training data

There is no column and no table joining `wearable_data` to `workouts`.
`recentMuscleLoads` (`training-stats.ts:199-240`) joins
`workout_sets → workouts → exercise_muscles`, so **an ingested session contributes
nothing** to freshness, volume, the strain pillar or the self-review.

Meanwhile the Coach reads `metric_type = 'workout'` minutes directly
(`docs/wearables-subapp.md:689-692`) *and* `get_training_summary` reads `workouts`
(`src/lib/ai/tools/read-tools.ts:1025-1107`). **A session logged in ARC and also
recorded by the watch is already counted twice**, in two different tools, with
nothing able to reconcile them. Pairing is what finally makes that reconcilable.

### The provenance rule this feature must obey

`0034`'s header (`db/migrations/0034_recipe_photo_autoresolve.sql:15-19`): the
danger is *"a number of unknown origin entering the rollup … wearing the same
face as a number the user asserted"*, and the answer is provenance as a column.
The same rule already lives inside the exercise module:
`MuscleFreshness.anchoredAt` is *"the flag that keeps an asserted number and a
derived one from wearing the same face"* (`src/lib/exercise/types.ts:401-412`).

The freshness model's own scale is the thing an inferred load has to enter:
`muscleFreshness` (`src/lib/exercise/freshness.ts:179-229`) sums
`roleWeight × effortWeight × e^(−Δh/τ)` in **fractional working sets**, calibrated
in the table at `:36-46` — 1 set ⇒ 88%, 4 ⇒ 61%, 8 ⇒ 37%, 17 ⇒ ~27%.
`recentMuscleLoads` attributes each load to an instant via `attributedInstant`
(`:248-258`).

---

## 2. The owner's words

> **D3 | Ingested workouts → training data [spec]** — Infer muscles where the
> type allows (*"a walking exercise… minorly effect the legs and not much
> else"*); **strength-training-coded** workouts leave a blank for the user;
> **auto-pair** an ingested session with a manually logged one by time, pulling
> calories and other data into the manual session. *"A topic to continue thinking
> on further."*

---

## 3. Proposed design

Three separable pieces: **pairing** (§3.C–§3.F), **inference** (§3.A–§3.B) and
**the blank** (§3.G). The recommended first slice is **pairing alone** — see §5.

### 3.A The HK type → muscle-load table

Keyed on `activity_type_raw`, never the label (`mapping.ts:517-518`).

```ts
/** Fractional-set load PER HOUR, in the same units recentMuscleLoads emits. */
const ACTIVITY_MUSCLES: Record<number, { muscle: Muscle; perHour: number }[]>
```

Per-hour, because a 20-minute walk and a two-hour hike are not the same load. The
contribution is `min(perHour × hours, CEILING)` per muscle per session, with:

- **`CEILING = 6`** fractional sets per muscle per session. A six-hour walk should
  not read as a leg day;
- **a floor**: sessions under 10 minutes contribute nothing. A four-minute walk
  row is noise, and there will be many of them.

Three outcomes, and they must stay distinguishable:

| outcome | meaning | behaviour |
| --- | --- | --- |
| **inferred** | a load row exists for this type | contributes fractional load, marked as inferred |
| **blank** | strength-coded; ARC deliberately does not guess | contributes nothing and **asks** (§3.G) |
| **refused** | ARC has no honest guess, and never will | contributes nothing and **never asks** |

Separating *refused* from *blank* is the honesty rule in operational form: a HIIT
session left "blank" would sit in an inbox forever asking a question ARC cannot
even frame.

#### What I would map

| raw | activity | load per hour (fractional sets) |
| --- | --- | --- |
| 52 | **Walking** | quads 0.4 · calves 0.4 · glutes 0.3 · hamstrings 0.2 — *the owner's own example: minor legs, nothing else* |
| 24 | Hiking | quads 1.2 · calves 1.0 · glutes 1.0 · hamstrings 0.6 · lower_back 0.3 |
| 37 | Running | calves 1.8 · quads 1.5 · hamstrings 1.2 · glutes 1.0 · abs 0.3 |
| 13 | Cycling | quads 2.0 · glutes 0.8 · calves 0.6 · hamstrings 0.5 |
| 35 | Rowing | lats 1.5 · upper_back 1.5 · quads 1.2 · biceps 0.8 · glutes 0.6 · lower_back 0.6 · hamstrings 0.4 |
| 46 | Swimming | lats 1.5 · front_delts 1.2 · upper_back 1.0 · triceps 0.8 · chest 0.6 · abs 0.5 |
| 16 | Elliptical | quads 1.0 · glutes 0.6 · calves 0.6 · hamstrings 0.4 |
| 44 / 68 | Stair climbing / Stairs | quads 1.6 · glutes 1.6 · calves 1.0 · hamstrings 0.6 |
| 60 | XC skiing | quads 1.4 · triceps 1.0 · lats 1.0 · glutes 0.8 · upper_back 0.6 · calves 0.6 |
| 64 | Jump rope | calves 2.0 · quads 0.8 · front_delts 0.3 · forearms 0.3 |
| 9 | Climbing | lats 2.0 · forearms 2.0 · biceps 1.5 · upper_back 1.2 · abs 1.0 · quads 0.6 |
| 61 | Downhill skiing | quads 1.6 · glutes 0.8 · calves 0.6 · abs 0.4 |

#### What I would refuse — and the two kinds of refusal

**Explicit zero** (a real fact, not an absence): 62 Flexibility · 33 Prep &
recovery · 80 Cooldown · 29 Mind & body · 57 Yoga · 66 Pilates. A stretch is not
fatigue, and pretending otherwise would depress a freshness figure the user then
distrusts.

**No honest guess**: 63 HIIT · 28 Martial arts · 73 Mixed cardio · 11 Cross
training · 69 Step training · 3000 Other · anything unmapped. HIIT could be
burpees or an assault bike; "Other" is nothing at all. These contribute zero and
say so if asked.

**Blank (asks the user)**: 50 Strength training · 20 Functional strength · 59 Core
training. The owner's instruction, verbatim. Core training is the debatable one —
"abs, primary" is tempting — but a session coded `Core training` on a Garmin is
frequently a whole circuit, so it goes in the blank bucket with the other two.

### 3.B Provenance — an inferred load must not wear the face of a logged set

This is `0034`'s rule, third application, and it is the part most likely to be
skipped.

1. **`MuscleLoad` gains `origin: 'set' | 'ingested'`**, defaulting to `'set'` so
   every existing construction site is untouched
   (`src/lib/exercise/types.ts:376-384`).
2. **`MuscleFreshness` gains `inferredShare: number`** — the fraction of the
   muscle's current fatigue that came from inferred loads — sitting beside the
   existing `anchoredAt` flag and read the same way.
3. **The muscle-freshness screen states it**, in the label voice, exactly as an
   anchored muscle already says it is hand-set: *"part inferred — 62-min walk"*.
4. **Weekly VOLUME takes no inferred load at all.** `muscleSetsInRange`
   (`training-stats.ts:296-308`) counts *sets worked* and is printed to the user
   as a set count; a walk contributes no sets. Freshness is a fatigue model and
   can legitimately take a fractional contribution; volume is a tally of a thing
   that happened. This is the inverse of `dailyMuscleSetLoad`'s own warning that
   its number *"must never be printed to the user as a set count"* (`:318-321`):
   the read that IS printed as a set count must not take an inferred load.
5. **`personalRecords`, `e1rmSeries`, `exerciseSessionTops` never see it** — an
   ingested session has no sets and cannot reach them. Structural, not a rule.

**Where it enters:** a new pure function `ingestedMuscleLoads(db, days, now)` in
`training-stats.ts`, emitting `MuscleLoad[]` with `origin: 'ingested'`,
concatenated with `recentMuscleLoads` at the two call sites — `buildRecommendation`
(`src/lib/db/repositories/training-recommend.ts:156-160`) and the freshness screen.
The attributed instant is the session's `end_time` (a genuine instant, unlike a
backdated logged workout), falling back to `attributedInstant(date, …)` when the
span is unreadable — reusing the existing helper rather than writing a second one.

**And the load-bearing line:**

> **A paired ingested session contributes NO inferred load.** The sets are the
> truth. One `WHERE NOT EXISTS (… workout_ingest_links …)`, and it is the single
> most important clause in the feature.

### 3.C Pairing — the algorithm

Given a manual `workouts` row **W** and ingested rows **I**:

1. **Candidates:** `metric_type = 'workout'`, same local `date` as W, readable
   span (`workoutSpan`, `wearables.ts:344-350`), **not already linked**.
2. **Overlap:** reuse `overlapFraction` (`:359-366`) — the shared fraction of the
   *shorter* span — at the existing `SAME_SESSION_OVERLAP = 0.5`. One definition
   of "the same session", not two.
3. **W needs a span.** A `workouts` row has `date`, `created_at` and
   `duration_min`, and nothing else. For a live session the logger writes at
   finish (`app/workout-live.tsx:612`), so `[created_at − duration_min,
   created_at]` is a fair synthetic span. For a **backdated** session
   `created_at` is a different day entirely and the span is meaningless — the
   same fact `attributedInstant` already encodes (`training-stats.ts:248-258`).
   So: **a backdated session never auto-pairs**; it can only be paired by hand.

   **Recommendation: fold `workouts.started_at` into `0052`.**
   ```sql
   ALTER TABLE workouts ADD COLUMN started_at text CHECK (
     started_at IS NULL OR started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'
   );
   ```
   The live logger already holds `startedAt` in state (`workout-live.tsx:388`).
   Writing it costs one column and one parameter, and it turns pairing from a
   heuristic into arithmetic. Nullable, so every existing row and every backdated
   log is simply "no span", which is the honest reading.
4. **Ties.** Two ingested rows both overlapping W resolve by `SOURCE_PRIORITY`
   (`wearables.ts:213-224`), then the **longer** span, then `created_at, id` —
   the exact ordering `0042`'s DELETE used (`:89-107`). Deterministic, so
   re-running changes nothing.
5. **One-to-one, enforced by the schema** — two unique indexes, below. Not by
   code, because code is where a one-to-one guarantee goes to die.
6. **Auto only when confident.** Auto-pair requires: same day **and** overlap ≥
   0.5 **and** W has a usable span. Everything else is offered as a *suggestion*
   the user confirms, never applied silently. A wrong auto-pair pulls a run's 600
   kcal into a lifting session, and no screen would show that as wrong.

**When it runs:** on workout save (`logWorkout` / `replaceWorkout`) and at the end
of each HealthKit sync — both directions, because either side can arrive second.

### 3.D Migration `0052` — the link table

```sql
CREATE TABLE workout_ingest_links (
  id text PRIMARY KEY NOT NULL,
  -- NULL when the ingested session was DISMISSED rather than linked.
  workout_id  text REFERENCES workouts (id)      ON DELETE CASCADE,
  wearable_id text NOT NULL
              REFERENCES wearable_data (id)      ON DELETE CASCADE,
  -- The 0034 rule again: who made this link.
  linked_by text NOT NULL DEFAULT 'auto' CHECK (linked_by IN ('auto', 'user')),
  -- The overlap fraction that justified an auto link; NULL for a hand link.
  overlap real CHECK (overlap IS NULL OR (overlap >= 0 AND overlap <= 1)),
  -- Set when the user said "not training". Exactly one of the two is set.
  dismissed_at text,
  CHECK ((workout_id IS NOT NULL) <> (dismissed_at IS NOT NULL)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX workout_ingest_links_workout_key
  ON workout_ingest_links (workout_id) WHERE workout_id IS NOT NULL;
CREATE UNIQUE INDEX workout_ingest_links_wearable_key
  ON workout_ingest_links (wearable_id);
```

Notes on the choices:

- **The two unique indexes ARE the one-to-one guarantee.** The workout-side one is
  partial so many dismissal rows (all with `workout_id IS NULL`) can coexist —
  SQLite's `UNIQUE` admits unlimited NULLs anyway, but the partial index states
  the intent.
- **CASCADE on both sides.** Deleting the manual session deletes the link and the
  ingested mirror survives, free to re-pair. Deleting the ingested row — which the
  trailing-window re-sync legitimately does — deletes the link and the manual
  session keeps everything it owns.
- **The cross-column CHECK is legal here** because this is `CREATE TABLE`, not
  `ADD COLUMN` on a populated table — the exact trap `0034`'s header documents
  (`:41-50`).
- A dismissal is a **tombstone, not a delete**, for the reason
  `removeMissionItem` gives (`src/lib/db/repositories/mission.ts:224-234`): the
  14-day re-sync would put a locally-deleted row straight back.
- Plus the `workouts.started_at` ALTER from §3.C (pairing).

### 3.E What gets pulled in, and where it lives

The owner asked for *"calories and other data"* pulled into the manual session.
Two ways:

| | approach | verdict |
| --- | --- | --- |
| (i) | **Copy** kcal / HR / distance onto the `workouts` row as new columns | Rejected |
| (ii) | **Join** through the link at read time | **Recommended** |

Why (ii):

- `wearable_data` is a *mirror* that re-syncs a trailing window and corrects
  itself (`docs/wearables-subapp.md:182-207`). A copy taken today goes stale when
  the source corrects a calorie figure, and nothing would ever repair it.
- Copying makes a second source of truth for a number the app already holds.
- The read is one indexed join, on a detail screen that already reads one row.

So `WorkoutDetail` gains an optional `ingested` sub-object — absent when
unlinked — and it is **rendered with its source named**, which is what makes it
visibly not-typed-by-you:

```
  From Garmin · 52 min · 612 kcal · 8.4 km
```

**On HR: it is not free, and it is the one thing on the owner's list that is
not.** `workoutRows` stores activity, kcal and distance only
(`mapping.ts:572-578`). Avg/max HR *during* a workout would need
`HKQuantityTypeIdentifierHeartRate` added to the read scopes, a new row in
`METRIC_COVERAGE` (its tripwire refuses a scope with no audit row —
`src/lib/health/coverage.ts:233-240`), and a per-session sample query over the
workout's span. Real work.

**Recommendation: v1 pulls kcal, distance, duration and activity — all already
stored, zero new scopes — and HR is a follow-up.** That is question 3.

### 3.F De-dup — the three guarantees

1. **No double load.** A paired ingested session contributes no inferred muscle
   load (§3.B).
2. **No double row in the UI.** A paired ingested session is hidden from the
   Data-tab wearables list — or shown as *"logged in ARC"* — extending
   `recentWearableWorkouts`'s existing collapse (`wearables.ts:388-439`) with a
   link check.
3. **No double minutes.** The Coach's `metric_type='workout'` sum subtracts
   paired rows, and `get_training_summary` gains an `ingestedSessions` array for
   the *unpaired* ones. **This fixes a defect that exists today** (§1): a session
   logged in ARC and recorded by the watch is currently counted by both tools with
   no way to tell.

### 3.G The "fill in the blank" UX

An **unpaired, strength-coded** ingested session is an open question, not a fact.

- **Where:** the **Exercise hub**, not the Data tab. It is a training task; Data
  is a reference surface you read, not one you act in
  (`app/protocol-detail.tsx:50-53` states that distinction for its own screen).
- **Form:** one `<Block device="plate">` under a `SectionLabel` reading
  **"From your watch"** — a plate because this is a record list, and a ruled row
  per session is exactly what a plate is for (`src/components/ui/block.tsx:16-18`).
  One ruled row per session: activity · date · duration · source, in the mono /
  label voices the rest of the exercise screens use.
- **Two actions per row**, both neutral ink — the hub's accent belongs to its
  primary action, not to an inbox:
  - **"Log the sets"** → pushes `workout-live` seeded with the session's date and
    duration; on Finish it creates the `workouts` row **and** the link in one
    transaction. This is the path that turns the blank into truth.
  - **"Not training"** → writes a dismissal row (§3.D).
- **A 14-day horizon.** Only sessions from the last 14 days are ever asked about;
  older unfilled ones age out silently. Without this, enabling the feature on a
  device holding the 90-day backfill produces an inbox of forty questions on day
  one — the single most likely way this feature gets hated and switched off.

### 3.H Tests that would pin it

Headless, `node:sqlite`, in `db/wearables.test.mjs`, `db/training-engine.test.mjs`
and `db/coach-tools.test.mjs`.

1. `0052` applies clean; the two unique indexes reject a second link on either
   side; the cross-column CHECK rejects a row that is both linked and dismissed,
   and one that is neither. `npm run db:validate` passes.
2. **Auto-pair:** a 17:00–18:00 manual session and a 17:05–17:58 Garmin row on the
   same day link, with `linked_by='auto'` and the recorded `overlap`.
3. **No pair:** a 17:00–18:00 session and a 19:00–20:00 row do not link (overlap
   0), and neither do two sessions on adjacent days.
4. **Tie:** two overlapping ingested rows (Garmin and iPhone/`other`) resolve to
   the `SOURCE_PRIORITY` winner; re-running is a no-op.
5. **Backdated:** a session written today about last Tuesday does not auto-pair.
6. **One-to-one:** a second auto-pair attempt against an already-linked wearable
   row is refused, not duplicated.
7. **De-dup:** a paired ingested session contributes **zero** inferred muscle
   load, and `muscleFreshness` over the day is identical to the manual-only case.
8. **Inference:** a 60-minute walk moves quads/calves/glutes/hamstrings and
   **nothing else**; a 30-minute one moves them half as much; a 5-minute one moves
   nothing (the floor); a 6-hour one is capped.
9. **Refusals:** Yoga, HIIT and `Other` contribute zero load and never enter the
   blank inbox; Strength training does enter it and contributes zero load.
10. **Volume firewall:** `muscleSetsInRange` is byte-identical with and without
    ingested sessions present.
11. **Provenance:** a muscle whose fatigue is part-inferred reports a non-zero
    `inferredShare`; one loaded only by logged sets reports 0.
12. `get_training_summary` counts a paired session once, and lists unpaired
    ingested sessions separately.
13. Deleting the manual workout removes the link and the ingested session
    re-enters the inbox; deleting the ingested row removes the link and leaves the
    manual session whole.

---

## 4. Alternatives considered

| # | Alternative | Verdict |
| --- | --- | --- |
| A | Infer loads from a **paired** ingested session too, and reconcile against the sets | Rejected. The sets *are* the session. Reconciliation is a second model of the same hour |
| B | **Copy** kcal / distance onto `workouts` | Rejected — staleness and a second source of truth (§3.E). The one argument for it: the copy survives the ingested row aging out of the re-sync window. Mitigation: the link CASCADEs and the detail screen shows what it always showed |
| C | Pair by **duration similarity** rather than span overlap | Rejected. Two 45-minute sessions on one day are not the same session. Overlap is the fact; duration is a coincidence |
| D | A **second** overlap threshold for pairing, tuned separately from the list collapse | Rejected. Two definitions of "the same session" agree until one of them is tuned |
| E | Let the **Coach** infer muscles per session instead of a table | Rejected. Non-deterministic, costs tokens per session, needs a network — and the whole exercise engine is *"rule-based, offline"* (`src/lib/exercise/progression.ts:1-10`). A freshness ledger must be reproducible |
| F | Make the muscle table **user-editable** | Not now. It is the natural v2 if the owner disputes a number, and it needs a settings screen nobody will open in month one |
| G | Store inferred loads as **rows** (materialised) rather than deriving them at read time | Rejected. They are a pure function of `wearable_data` + the table; materialising them means invalidating them on every re-sync |
| H | Treat an unpaired ingested strength session as a **workout row with no sets** | Rejected. It would enter `weekSummary` as a session and `workingSets` as nothing, so it would both count and not count. The link table keeps the two worlds separate until the user joins them |

---

## 5. Effort

| Piece | Size |
| --- | --- |
| **Pairing** — `0052` (link table + `workouts.started_at`), the pair-on-save / pair-on-sync passes, the joined read on the workout detail screen, hiding paired rows from the wearables list, the Coach minutes de-dup | **1–1.5 days** |
| **Inference** — the activity table, `ingestedMuscleLoads`, `origin` + `inferredShare` through `MuscleLoad` / `MuscleFreshness`, the screen's provenance line | ≈ 1 day (the table is judgement, not code) |
| **The blank** — the Exercise-hub inbox, the seeded logger push, dismissal | ≈ 1 day |
| HR ingestion (new read scope, coverage row, per-session sample query) | + 0.5–1 day |
| **All of it** | **≈ 3.5–4.5 days** |

### The first slice, concretely

**Pairing alone, ~1.5 days.** It removes a visible duplicate, puts calories on a
session the user already logged, and fixes the double-count that exists today.
It is also the piece the other two **depend on**: inference must know what is
paired, and the inbox is by definition "the unpaired strength ones". Shipping inference
or the blank first would mean building both of them again once pairing arrives.

---

## 6. Questions only the owner can answer

**1. Does an inferred load actually move the muscle-freshness figure, or only
annotate it?**

- (a) **← recommended** — it moves the figure, and the reading is marked
  part-inferred. An hour's run genuinely fatigues quads and calves, and a recovery
  model that ignores it will happily recommend legs the next morning;
- (b) it is shown as context beside the figure and changes nothing;
- (c) it moves the figure only for types with a clear primary (running, cycling,
  rowing, swimming) and annotates the rest.

**2. Weekly volume — confirm inferred load stays out of the set counts.**

- (a) **← recommended** — out. Freshness takes it, volume does not, so "12 sets of
  quads this week" keeps meaning twelve sets;
- (b) in, with an "of which inferred" figure beside it.

**3. Avg/max HR needs a new HealthKit read scope and a per-session sample query;
kcal, distance, duration and activity are already stored and free.**

- (a) **← recommended** — ship pairing now with what is already stored, and add HR
  as a follow-up once pairing is observed working on device;
- (b) hold pairing until HR is in, so the paired session is complete from day one;
- (c) drop HR permanently — the summary numbers are enough.
