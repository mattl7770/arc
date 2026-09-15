# C13 — The gym away-note

**Status: BUILT** (2026-09-14). Approved by the owner on the three questions in
§6, all as recommended: (1a) never a PR, (2a) plotted and marked, (3a) not
sticky. Shipped as migration **`0055`** — `workouts.away`, one bit. The
implementation notes, including the one place it deviates from §3, are
`docs/exercise-subapp.md` §11; this file stays as the argument.

**The number moved twice, 0051 → 0054 → 0055.** Main's migration head reached
`0053` while this was being built (D4's timezone migration), and the runner
filters `version > user_version` — a file numbered below a shipped head is not
applied late, it is never applied at all. `0054` was then committed by D3
(ingested-workout pairing) on a parallel branch within the hour, caught by
re-checking the sibling worktrees rather than at merge. Every `0051` below reads
as `0055`.

**One deviation, §3.3b.** The proposal excluded away sessions inside
`exerciseSessionTops`. That reducer has a second consumer the proposal did not
account for — `app/exercise-detail.tsx`'s **History list** renders the same rows
— so dropping them there would have erased the session from the one screen built
to show it. The flag rides on `SessionTopSet` instead and `suggestProgression`
refuses it, which closes the false-deload path at the branch itself and leaves
the history honest.

**Backlog:** `docs/backlog-2026-09.md` C13 (Phase C, marked **[spec]**).

---

## 1. Current state

### A workout row has nowhere to say where it happened

`workouts` (`db/migrations/0003_exercise.sql:30-41`) is
`id · date · name · kind · duration_min · notes · created_at · updated_at`;
`0013` adds `routine_id` (`db/migrations/0013_workout_sets_enrich.sql:28`). There
is no location, no equipment context, no condition flag.

`notes` exists and is *dead in both directions*: `logWorkout` passes
`input.notes ?? null` through (`src/lib/db/repositories/exercise.ts:97-118`),
`replaceWorkout` preserves whatever was there
(`app/workout-live.tsx:619-624` passes `stored.notes` straight back), and **no
screen ever writes or renders it**. The live logger exposes no notes field at
all, and a session has no name either — *"workouts don't have them (owner,
2026-08-14)"* (`workout-live.tsx:626-627`; the column's dormancy is argued at
`exercise.ts:76-96`).

### The four reads that would misjudge an away session

**PR detection, live.** `toggleDone` (`workout-live.tsx:544-566`) tags a set as a
PR when its e1RM beats `block.bestE1rm`, then raises the bar so only the first
record-crossing set of the session tags (`:555-559`). `bestE1rm` is read once at
block build from `personalRecords(db, exerciseId).bestE1rmKg`
(`workout-live.tsx:209`).

**PR detection, stored.** `personalRecordsFrom`
(`src/lib/db/repositories/training-stats.ts:105-121`) scans **every** non-warmup
set for the exercise (`workingSets`, `:44-54`) for max weight, best e1RM and best
set volume. Nothing is excluded but warmups.

**Progression.** `exerciseSessionTops` (`:67-93`) reduces those rows to the best
working set per session, oldest → newest, and hands them to `suggestProgression`
(`src/lib/exercise/progression.ts:39-93`). The stall branch (`:71-84`) is the
false-regression path in plain sight: `STALL_SESSIONS` sessions with no strength
gain and reps below the top of the range ⇒ *"Stalled 3 sessions — drop ~10% and
rebuild."* Three weeks away from home on stiffer machines produces exactly that
input.

**Prefill.** `lastSessionSets` (`:157-178`) takes the sets of the **most recent**
session containing the exercise as the logger's placeholders. So an away session
seeds the next home session with away numbers — and a placeholder that gets
confirmed becomes real.

### The three reads that are already correct and must not change

**Freshness.** `recentMuscleLoads` (`:199-240`) emits `(muscle, roleWeight, reps,
rpe, weightKg, setType, whenIso)`, and `muscleFreshness`
(`src/lib/exercise/freshness.ts:179-229`) multiplies `roleWeight ×
effortWeight(rpe, failure) × e^(−Δh/τ)` (`:208-211`). **The weight is never read.**
Load is load: a set to RPE 8 on a stiff machine fatigues the muscle exactly as
much as one at home. Nothing needs doing, and the reason needs writing down so
nobody "fixes" it later.

**Volume.** `muscleSetsInRange` and `dailyMuscleSetLoad` (`:296-340`) count
role-weighted **sets** over `WORKING_SETS_IN_RANGE` (`:271-275`). You trained; it
counts.

**The week summary and the strain pillar.** `weekSummary` (`exercise.ts:248`) and
`dailyMuscleSetLoad`'s consumer in `src/lib/home/readiness.ts` count sessions,
minutes and tissue loaded. Same answer.

### The Coach cannot see what does not exist

`get_training_summary` (`src/lib/ai/tools/read-tools.ts:1025-1107`) returns
per-day totals, weekly rates, `thisWeek`, and `recentSessions` — each
`{date, kind, duration_min, movements}` (`:1057-1076`). There is no field that
could carry "this was somewhere else", so the Coach will read a down week as a
down week and say so.

### The precedent this feature is an instance of

Migration `0034`'s header (`db/migrations/0034_recipe_photo_autoresolve.sql:15-19`)
states the rule: the danger is *"a number of unknown origin entering the rollup …
wearing the same face as a number the user asserted"*, and the answer is
**provenance as a column**. `MuscleFreshness.anchoredAt`
(`src/lib/exercise/types.ts:401-412`) applies the same rule inside the exercise
module — *"the flag that keeps an asserted number and a derived one from wearing
the same face"*.

---

## 2. The owner's words

> **C13 | Gym away-note [spec]** — Per-workout label *"for when I am not at my
> home gym, I can make note of that and ARC can adjust intelligently"* — a
> stiffer machine must not read as a regression.

---

## 3. Proposed design

### 3.1 The flag: migration `0055`, one column, one bit

```sql
ALTER TABLE workouts ADD COLUMN away integer NOT NULL DEFAULT 0
  CHECK (away IN (0, 1));
```

**A column, not `notes`.** Every consumer that must change behaviour is SQL
(`workingSets`, `exerciseSessionTops`, `personalRecordsFrom`, `e1rmSeries`,
`lastSessionSets`). A flag buried in free text is not queryable, not indexable and
not assertable in a headless test — and the `0034` rule is explicit that
provenance is a column.

**`NOT NULL DEFAULT 0`,** so every workout already on the device reads "home",
which is true: there was no other option when it was logged.

**A bit, not a vocabulary.** `'home' | 'away' | 'hotel' | 'travel'` was
considered and rejected: the *behaviour* is binary — either these numbers are
comparable to the home baseline or they are not — and a four-value enum invites a
taxonomy nobody maintains. Widening a CHECK later is a full table rebuild (the
`0024` labs rebuild is the worked example, cited again in `0036`'s header);
adding a nullable `gym_id` **beside** a bit is one additive ALTER. The cheap
option is also the one that keeps the door open (§4, and question 3's context).

**Name: `away`.** One bit answering the owner's own sentence. Not `location`
(which implies a value), not `is_home` (which makes the default the negated case).

### 3.2 The governing principle

> **An away session is real training and unreal measurement.**
> It happened, it fatigued you, it counts as volume. Its *numbers* are not
> comparable to the home baseline — in either direction.

Everything that counts **work** includes it. Everything that compares **load**
excludes it from the baseline while still showing it.

### 3.3 What "adjust intelligently" means, per consumer

#### (a) PR detection — exclude, never award

- `toggleDone` (`workout-live.tsx:544-566`): the live PR tag is suppressed for an
  away session, one condition beside the existing `!editing` guard at `:550`.
- `personalRecordsFrom` (`training-stats.ts:105-121`): away sets are filtered out
  of the scan entirely, at the `workingSets` query (`:44-54`) so the exclusion has
  one definition.

The asymmetry decides this. **`bestE1rm` is a bar every future session must
beat.** A false PR raises it permanently, and the next four home sessions then
read as a stall — which is the exact complaint this feature exists to prevent,
arriving one month later and much harder to diagnose. A *missed* real PR is
recoverable next session.

The corner case the owner will hit: the away gym's machine is **easier** and he
genuinely moves more weight. Still no PR. That is stated in the control's one line
of copy so it is never a surprise.

#### (b) e1RM progression — exclude from the baseline, keep in the trend

- `exerciseSessionTops` (`:67-93`) — the input to `suggestProgression` — skips
  away sessions. This is the whole point: without it, two away weeks trip the
  stall branch (`progression.ts:71-84`) and ARC recommends a 10% deload on a lift
  that never stalled.
- `e1rmSeries` (`:124-147`) — the chart — **keeps** away points and marks them.
  Deleting them would be a different lie: the session happened and the user will
  look for it. `E1rmPoint` gains `away?: true`; the point renders hollow rather
  than in another colour. No accent, no signal colour — this is behaviour, not
  biology.
- `personalRecords` — excluded, per (a).

#### (c) Prefill — prefer the last home session

`lastSessionSets` (`:157-178`) currently takes the most recent session outright. A
placeholder carrying away numbers is a false regression by the quietest route
available: the user confirms the placeholder and it becomes a real logged set.

New rule: **the most recent non-away session**, falling back to the most recent
session of any kind when there is none — a placeholder from an away session beats
no placeholder at all.

Deliberately *not* done in v1: prefilling an away session from the last **away**
session. It is genuinely better (a given machine's numbers are stable across
visits) but it is only meaningful once ARC knows *which* away gym — which is the
strongest argument for the named-gym list, and it is not a v1 argument.

#### (d) Freshness — untouched, and recorded as a decision

`recentMuscleLoads` and `muscleFreshness` never read the weight
(`freshness.ts:208-211`). An away session already fatigues correctly. **No
change** — written down with its reason so a later pass does not "complete" the
feature by adding one.

#### (e) Volume, the week summary, the strain pillar, the self-review — untouched

`muscleSetsInRange`, `dailyMuscleSetLoad`, `weekSummary`,
`src/lib/reports/assemble-self-review.ts` all count sets and minutes. You trained;
it counts.

#### (f) The Coach must SEE the flag

This is the owner's actual ask — *"ARC can adjust intelligently"* — and it needs
no arithmetic at all.

`get_training_summary.recentSessions` (`read-tools.ts:1057-1076`) gains
`away: true` on those rows, and the tool description gains one sentence:

> *`away: true` means the session was logged away from the usual gym — different
> equipment, so its loads are not comparable to the baseline. Do not read lower
> numbers as a regression.*

Token cost: a handful per session row plus one sentence, against prompt ceilings
that are already near full (the same pressure `cadenceText` cites at
`src/lib/protocols/cadence.ts:105-110`). Worth it: the alternative is a Coach that
nags about a decline that did not happen, which is the failure the owner reported.

`buildRecommendation` (`src/lib/db/repositories/training-recommend.ts:148-176`)
reads freshness and volume, neither of which changes — nothing to do there.

#### (g) The session list and the detail screen

`RecentSession` and `WorkoutDetail` carry the flag so a past session **says** so,
in the label voice. A session whose numbers read low and does not say why is the
confusion this feature exists to remove.

### 3.4 The control, in Conformed Set vocabulary

**One quiet control, off by default, remembered per session and not per app.**

- **Where:** the live logger's session header row, beside the elapsed clock. Not a
  block of its own — devices never nest (`src/components/ui/block.tsx:129-137`)
  and the set tables on that screen are already plates.
- **What:** one neutral pressable in the **label voice** — the same chip
  vocabulary the protocol editor uses (`app/protocol-edit.tsx:166-197`). Off, it
  reads as a hairline outline: `AWAY GYM`. On, it takes the `border-ink
  bg-paper-dim` selected treatment. **No accent** — that screen's budget is
  exactly one primary action (Finish workout) plus the completion stamps
  (`workout-live.tsx:64-67`).
- **Copy, when on** — one serif, muted line beneath it:

  > *Loads from this session won't set records or steer progression. It still
  > counts as training.*

  That sentence is the entire feature, said where the decision is made.

- **Not sticky.** The flag is state on the live screen, defaults to `0` on every
  new session, and is written once at `finish()` (`:580-647`). It does **not**
  persist a preference. The failure modes are asymmetric: forgetting to turn it
  *on* costs one session's PR fidelity and can be fixed afterwards; forgetting to
  turn it *off* silently kills PR detection at home, indefinitely, with no symptom
  the user would notice.
- **Editable afterwards.** The past-session editor already loads `stored` and
  writes `kind`/`duration`/`notes` back (`:619-624`); the flag joins them. This is
  free, and it is a genuine architectural gift: **nothing needs re-deriving**,
  because PRs are awarded live and never stored (`:259-262`) and every other
  affected read is computed from the sets on demand. Flipping the flag on a
  two-week-old session simply changes what the next read returns.

### 3.5 Tests that would pin it

Headless, `node:sqlite`, in `db/exercise.test.mjs`, `db/training-engine.test.mjs`
and `db/coach-tools.test.mjs`.

1. `0055` leaves every existing workout at `away = 0`; `npm run db:validate`
   passes.
2. An away session never appears in `personalRecordsFrom` — **even when its
   numbers are the highest on record.**
3. `exerciseSessionTops` skips away sessions: a three-session away block does not
   trip the `deload` branch on a lift whose home sessions were progressing.
4. `e1rmSeries` **keeps** the away point and marks it `away: true`.
5. `lastSessionSets` prefers the most recent home session, and falls back to an
   away one when there is no home session at all.
6. **The no-change test:** `muscleFreshness` over the same sets is identical with
   the flag on and off.
7. The same for `muscleSetsInRange`, `dailyMuscleSetLoad` and `weekSummary`.
8. `get_training_summary` emits `away: true` on the right `recentSessions` rows.
9. Flipping the flag on a stored session changes `personalRecords` on the very
   next read — the "nothing to re-derive" property, asserted rather than assumed.

---

## 4. Alternatives considered

| # | Alternative | Verdict |
| --- | --- | --- |
| A | Put it in `workouts.notes` | Rejected. Not queryable, not testable; every consumer that must change is SQL; `0034` says provenance is a column |
| B | A `location` / `gym` **text** column now | Rejected for v1. The behaviour is binary, and free text produces "Hotel gym", "hotel gym" and "Hotel" as three gyms within a month |
| C | A four-value enum (`home`/`away`/`hotel`/`travel`) | Rejected. Nothing branches on the third and fourth values, and widening a CHECK later is a table rebuild |
| D | **Per-set** rather than per-workout | Rejected. The owner said per-workout, and one session at one gym is one equipment context. A single machine substitution inside a home session is a different feature (a per-set note) and is not this |
| E | **Annotate rather than exclude** — award the PR, mark it "away" | Rejected. `bestE1rm` is a bar all future sessions must clear; an away PR raises it permanently and the next home block then reads as a stall |
| F | Hide away points from the e1RM chart entirely | Rejected. The session happened; the user will look for it. Marked-but-present is the honest rendering |
| G | Auto-detect from location / HealthKit | Rejected. No location permission, no gym geofence, and a wrong auto-detect is worse than none |
| H | **A named-gym list, now** | Rejected now — argued below |

### The named-gym list — against, now

**Against.** What it buys is per-gym *baselines*: a PR "at Anytime Fitness", a
prefill that remembers the hotel's machine. That is a real feature, and a much
larger one — every stat read forks to per-`(exercise, gym)`, the e1RM chart
becomes multi-series, and the concept of "my best ever" splits in two. It also
needs a `gyms` table, a picker, an edit path and a merge path for typos, all to
answer a question ("*which* away gym?") the owner has not yet said he needs
answered.

**And the bit is forward-compatible.** Adding
`gym_id text REFERENCES gyms (id) ON DELETE SET NULL` later is one additive
ALTER — no rebuild — and `away = 1 AND gym_id IS NULL` reads perfectly well as
"somewhere else". Nothing is foreclosed.

**The one argument for it,** stated so the owner can overrule: if he travels to
the *same* hotel gym repeatedly, per-gym prefill is genuinely valuable, and it is
the one thing a single bit cannot give (§3.3c).

---

## 5. Effort

| Piece | Size |
| --- | --- |
| `0055` + `LogWorkoutInput` / `WorkoutDetail` / `RecentSession` plumbing | small |
| The control + copy in `workout-live.tsx`, live and editing | small |
| The four read changes (PR live, `workingSets` exclusion, `exerciseSessionTops`, `lastSessionSets`) | small — each is a predicate |
| `e1rmSeries` marking + the chart's hollow point | small |
| The Coach field + one sentence of tool description | trivial |
| The nine headless tests | half a day |
| **Total** | **≈ half a day to a day** |

The cheapest of the three September `[spec]` items on this branch, and the one
with the clearest payoff per line changed.

---

## 6. Questions only the owner can answer

**1. Can an away session ever set a PR?**

- (a) **← recommended** — never. Away sets are invisible to `personalRecords` and
  the live stamp, even when the numbers are the best on record. The reason is the
  asymmetry: `bestE1rm` is a bar every future session must clear;
- (b) it sets a PR, and the record is marked "away" wherever it is shown.

**2. Away sessions and the e1RM trend chart:**

- (a) **← recommended** — plot them, marked (hollow point), but they never steer
  progression;
- (b) hide them, so the trend is strictly home-to-home;
- (c) plot them as a separate faint series.

(a) keeps the session visible without letting it move the recommendation.

**3. Sticky or not?** The proposal is: the flag defaults **off** on every new
session and is never remembered.

- (a) **← recommended** — not sticky. Forgetting to turn it *off* would silently
  kill PR detection at home with no visible symptom;
- (b) remember the previous session's setting;
- (c) a default in Settings ("I'm travelling this week").
