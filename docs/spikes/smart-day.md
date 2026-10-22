# Smart day: "Do this next" from facts, ordered by the Coach, learning from what he does

**Items 77 and 78.** Status: **BUILT 2026-10-21 (phases 1–3, headless only), under the owner's correction below.** What shipped is recorded in `docs/home-screen.md` › *Smart day*; this spike stays as the record of how it got there.

> ## ⚠️ Superseded in part — the owner's correction (2026-10-21)
>
> *"none of this should be hard-coded. a 'weigh-in' reminder is not what we want. we want an intelligent assistant/coach who reminds you to weigh in when it thinks you need that reminder. none of those ideas were things to be hard-coded, just examples of what the coach might do."*
>
> **Struck:** every rule-made **prompt** in §2 — "no weigh-in before 10:00", "nothing eaten in 5 h", their Settings thresholds and toggles, and the fallback order that mixed prompts into time order. Struck with them: §3's `NEXT`/`UNTIL`/`WHY` grammar over a candidate pool, §4.1's prompt-driven `done`/`expired`/`snoozed`/`offered` events, and the §4.2 schema as drawn.
>
> **What was built instead:**
>
> - **Facts, not rules** (`src/lib/home/day-facts.ts`). The deterministic layer gathers only statements that are true or false — the last weigh-in and his cadence, the last meal and today's intake, the wake time, open rows with times, workouts, the live session, open loops — and none implies an action. It never reads a status.
> - **The Coach plans the top of the day.** The pass may end with up to three `PLAN` lines: `PIN` an existing row, or `DO` a **Coach item** — a short title, one destination from a fixed enum, an optional `UNTIL`, and at most one ≤ 90-character reason marked as the Coach's (owner's Q3: yes). Parsed and validated by code (`src/lib/home/plan-lines.ts`); junk is dropped.
> - **Coach items appear in the checklist as uncounted rows** (owner's Q1: yes): no checkbox, never in "N of M", never in adherence; they clear when acted on, dismissed, expired, or replaced by the next plan.
> - **Without a live plan, Home is exactly the time order it always was.** There is no deterministic candidate pool any more, so the fallback is `deriveMissionView().next`, untouched.
> - **Learning** is migration **0067 `day_plan_events`** — `shown`, `started`, `dismissed`, `done`, `expired`, `replaced`, keyed by the plan that produced them — summarised to the pass as 14-day counts, never as a weight in code.
> - The turn-context "next" fix (§1.3) shipped: the chat Coach's state block now names what Home actually shows.
>
> Q2 ("which prompts ship first") is moot: there are no prompts. §5 (training learning) is Track 2 item 3 and is not part of this build.

The owner's notes, verbatim:

> 77: "make recommend workouts better + smart learning"
>
> 78: "a smarter system than just following protocols for the do this next, i.e., in the morning it prompts for a weight log, then says you should eat smth, then says workout time, and so on. based on protocols but not just them"

The owner's decision, which this spike works inside:

1. **Rules produce the CANDIDATES**: protocol rows, "no weigh-in yet" before 10:00, "nothing eaten in 5 h" while awake, the planned workout, and so on.
2. **The Coach's daily pass may reorder them or pin one.** Without the pass, the order is by time.
3. **Recommendations learn** from which suggestions he starts or skips.
4. Spike first, then build.

The standing rule: **judgment lives in the model, not in rules.** A candidate rule may state a fact ("no weight today, and it is 07:10"). It may not decide what the fact means ("you should weigh in before eating"). The owner's scenarios are examples, not specs.

**Migration:** one, **0067**, and only from phase 1 (§6). 0066 is reserved by another item, and main's head is 0065.

**Citations** are verified against `main` at `6991f6c`.

---

## 1. What happens today

### 1.1 The hero is the first open mission row, in time order

- `deriveMissionView` sorts every row by `scheduledTime`, untimed last (`src/lib/home/derive-mission.ts:36-54`).
- The hero is the first row that is neither completed nor skipped and not snoozed. If everything open is snoozed, the first snoozed row comes back (`:63`, `:71`).
- Home passes that row to `HeroCard` (`app/(tabs)/index.tsx:291-296`). It tells the list which row is the hero, so the two cannot disagree (`:331-334`).
- The hero has three buttons: **Done**, **Snooze** and **Skip** (`src/components/home/hero-card.tsx:181-211`). Done and Skip write `log_entries.status` (`src/hooks/use-today-mission.ts:157-167`).
- **Snooze is never stored.** It lives in a module set and dies with the session or the day (`src/lib/home/snooze-store.ts:7-12`).

The consequence: an 07:00 supplement nobody ticked keeps the hero all day. Nothing but a protocol row, an experiment, a carried debt or a Coach-added row can ever be the hero.

### 1.2 Where rows come from

Rows come from `planForDay` (`src/lib/db/repositories/mission-generate.ts:672`), and only from these sources:

- **Active protocol items**, by phase and cadence.
- **Carried debts** (0050, `:447`).
- **A running experiment's intervention**, untimed (`:766-797`).
- **Rows the Coach adds or moves** through `adjust_today`, behind a confirmation card (`src/lib/ai/tools/write-tools.ts:1300`).

Rows are read back in time order (`src/lib/db/repositories/mission.ts:354-366`).

**Nothing in the day looks at the world.** A weight that has not been logged, a meal that has not been eaten, a workout left open: none of these can reach the hero.

One partial exception: an open workout draft gets a mono "Resume" line above the hero, and it is not a candidate (`app/(tabs)/index.tsx:273-287`).

### 1.3 What the Coach can do about the order today

**In the thread.** It can move a row's time with `adjust_today`. That is a write, so the user approves a card first.

**In the pass.** The pass runs once on the first open of the day, again on the first open after 18:00, and on a new signal (`src/lib/ai/pass-schedule.ts:67`, `:165-181`). It is **read-only by construction** (`src/lib/ai/coach-pass.ts:13-17`).

The only thing the pass can propose beyond a note is `NUDGE` lines. Code parses those, caps them and writes them after the pass returns (`coach-pass.ts:27-31`; `src/lib/ai/pass-store.ts:344-348`). That is the precedent this spike follows.

**What the model is told about the day** is one line: `Mission: N of M done · next: "<title>"`.

- Its "next" is the first `pending` row in list order (`src/lib/ai/turn-context.ts:307-320`).
- It ignores snoozes and `partial` rows, so it can name a different row from the one the hero shows. Phase 1 fixes this regardless of anything else.

### 1.4 What is recorded about his behaviour today

**Completion.** `log_entries.completed_at` is stamped on completion (`mission.ts:668-675`).

**Skip.** A skip sets `status = 'skipped'` and clears `completed_at` (`:651-663`). Only `updated_at` dates it.

**Nothing else is kept:**

- which row was the hero, or for how long;
- snoozes;
- whether he opened anything from the hero;
- what Train today recommended.

`workouts.routine_id` records which saved workout a session was started from (`db/migrations/0013_workout_sets_enrich.sql:28`). But nothing records what was **offered**, so "recommended Upper A, did Lower B" cannot be reconstructed.

### 1.5 The day boundary and statuses

**The day boundary.** Logical days honour the user's `dayStartsAt` (`src/lib/db/date.ts:85`, `:125`, `:168`). Every time window below is wall-clock time on the logical day.

**Statuses.**

> "No status ever adds or removes a mission item, changes the hero, or changes anyone's tone." (`docs/information-architecture.md:337-338`)

The candidate rules below therefore never read `day_statuses`. Only the Coach's ranking may take a status into account, because that ranking is judgment.

---

## 2. The candidate set — ~~superseded~~ (owner's correction, 2026-10-21: no rule-made prompts; see the box at the top)

A **candidate** is anything that may claim "do this next". There are two kinds:

1. **Mission rows**, exactly as today. Nothing about how they are generated, stored or counted changes.
2. **Prompts.** These are new. A prompt is **derived on every Home read from data already on disk**. It is never written to `log_entries`, it is never counted in "N of M", and it never enters the adherence ledger.

A prompt is satisfied by the data turning up, for example a weight row or a meal row. Tapping a button does not satisfy it. That keeps adherence a statement about the protocols, and it means a prompt has nothing to carry or excuse.

| Candidate | Trigger (all must hold) | Satisfied / gone when | Time key (for the fallback order) | Why it is a fact, not a judgment |
|---|---|---|---|---|
| **Mission row** | open (`pending` or `partial`) | settled | its `scheduled_time`; untimed sorts last | the protocol says so; unchanged |
| **Weigh-in** | no `body_metrics.weight_kg` with `measured_at` (`db/migrations/0001_init.sql:301`) inside today's logical day; local time is before **10:00** | a weight row lands (typed, or synced from a scale through Health, `src/lib/db/repositories/body.ts:269`), or 10:00 passes | wake time (below) | "There is no weight today and it is before 10:00" is true or false. Whether a weight *should* be taken is not stated: the prompt only offers it. |
| **Eat** | no meal (`meals.date` + `time`, `db/migrations/0002_nutrition.sql:22-26`) and no queued meal estimate (`src/lib/db/repositories/pending-estimates.ts:125`) in the last **5 h**; now is after wake time; no open `meal`-type mission row due within 30 min | a meal or estimate is logged | `max(last meal + 5 h, wake time)` | Hours since the last logged meal is arithmetic. Fasting on purpose is a context the Coach can weigh, and the rule stays silent on it. |
| **The planned workout** | an open mission row of type `workout` (`mission-generate.ts:50-58`, `training_block → workout`) | settled; or a workout is finished today | the row's own time | It is a protocol row. What is new is the **Start** action, which opens the live logger on Train today's pick (`app/exercise.tsx:200-208`). |
| **Resume workout** | an unfinished live draft exists (`src/lib/exercise/draft.ts:775`) | finished or discarded | the draft's start time | The session is open. This promotes the existing Home line (`index.tsx:273-287`) into the pool. |

**Wake time** is the `end_time` of today's `sleep_duration_min` row (`src/lib/health/mapping.ts:566-576`). Without one (no watch, or not worn), it is the first time Home rendered a hero today, which phase 1 records. Home only evaluates prompts while it is on screen, so "while awake" is a time anchor, never a guess about sleep.

**Out of v1, but the same shape:**

- a watch-recorded strength session waiting for its sets (`src/lib/db/repositories/workout-ingest.ts:805`);
- a screening that has come due.

Each new prompt is one pure function plus one Settings toggle. It needs no migration, because prompts are never stored.

**Rules every candidate keeps:**

- **A rule reads data and the clock, never a status, a readiness verdict or a goal.** A sick morning still offers the weigh-in. Whether that is the right thing to do on a sick morning is the Coach's call (§3).
- **The thresholds (10:00, 5 h, 30 min) are Settings values, not code constants,** and each prompt has an on/off switch, defaulting to on.
- **The hero's primary action follows the candidate:**
  - Weigh-in: **Log weight**, which opens `app/metric-entry.tsx` on weight.
  - Eat: **Log a meal**, which opens the Eat log sheet.
  - Planned workout: **Start**.
  - Resume workout: **Resume**.
  - Mission row: **Done**, unchanged.

  Snooze is unchanged. **Skip on a prompt removes it for the rest of the day and is recorded** (§4), because a prompt that comes back after every relaunch is nagging.
- **Prompts also appear in the list,** as uncounted rows at their time key with no checkbox, and tapping one opens its logging screen. This keeps "the hero is a row of the list" true (`docs/home-screen.md:131`). This is open question Q1.

**The fallback order (no pass, no key, offline):**

- All open candidates sort by time key. When two keys tie, the one whose window closes first goes first (the weigh-in closes at 10:00; eat has no close).
- The hero is the first one that is not snoozed. This is today's rule (`derive-mission.ts:71`) with a larger pool.
- So the owner's morning (weigh-in, then eat, then workout time) falls out of time order alone whenever his training row is timed. **Without the Coach, the day still works.**

---

## 3. The Coach's pass: rank, and pin — grammar superseded by `PLAN` lines (see the box at the top)

### 3.1 What the pass is given

When at least two candidates are open, the pass directive gains one section. It follows the same pattern as `nudgeInstructions` (`coach-pass.ts:227-269`): it sits in the pass's own user message, outside the system prompt and the tool schemas.

```
Do this next. It is 07:12 on 2026-10-21. Open candidates, in the time order Home shows without you:
  c1 06:48 Weigh in (prompt; no weight today; gone at 10:00)
  c2 06:48 Eat (prompt; last meal 19:40 yesterday)
  c3 07:30 Creatine 5 g (Supplements · AM stack)
  c4 17:30 Strength session (Training · Strength block; Train today's pick: Upper A)
  c5 --:-- No screens after 22:00 (Experiment · day 4)
Last 14 days: <the outcome summary, §4.3>
You may end your reply with:
NEXT c2 c1 c4 [UNTIL HH:MM]
WHY one plain sentence, at most 90 characters, shown under the first.
Write no NEXT line to leave Home in time order.
```

The short tags `c1…cN` are mapped back to stable keys by code for that one pass: `m:<log_entry id>`, `p:weigh_in`, `p:eat`, `p:resume`.

### 3.2 What the pass may output, and what code does with it

**`NEXT`, at most 3 tags, in rank order:**

- Unknown, settled or duplicate tags are dropped.
- A `NEXT` line replaces the previous ranking.
- `NEXT NONE` clears it.

**`UNTIL`:**

- The ranking holds until the stated time, or **4 h after the pass** when no time is given.
- It never holds past the end of the logical day.
- After that, Home is back in time order.

**`WHY`:**

- One line, at most 90 characters, applied to the top-ranked candidate only.
- It is shown in the hero's italic line, attributed to the Coach, in place of the row's own `why`.

**How code applies the lines:**

- They are parsed out before the note is judged spoke-or-silent, exactly as `NUDGE` lines are (`coach-pass.ts:423-445`). A pass can say `SKIP` and still rank.
- The ranking is written to `users.preferences.dayPlan` as `{day, keys, until, why, passAt}`, following the `coachPass` pattern (`pass-schedule.ts:92-111`). It is also written as `ranked` events for the history (§4).
- **It changes order only.** It writes nothing to `log_entries`, and it cannot add, remove, skip or reschedule anything. That keeps it inside the pass's read-only contract in the same way an accepted nudge does: the owner already accepted nudges without a card (`docs/spikes/coach-notifications.md:250`).
- A thread record line rides the pass's turn ("Ordered Home: Eat, Weigh in, Strength session until 11:00"), so it is auditable, as nudge plans are (`pass-store.ts:356-365`).

**How Home uses it:**

- The hero is the first ranked key that is still open and not snoozed. Otherwise it falls back to the §2 time order.
- **The list stays chronological** (owner call 2026-07-24, `docs/home-screen.md:29`). Only the hero follows the rank, and the list already marks the hero row (`index.tsx:334`).

### 3.3 Cost, ceilings, offline

**Cost.**

- It rides passes that already run (daily, evening, signals, check-ins), so it adds **no new pass**.
- A pass costs about **$0.02** on Haiku 4.5 (`docs/spikes/coach-notifications.md:100`; `PASS_MODEL`, `coach-pass.ts:341`).
- The new section is about 250–400 tokens, re-sent uncached on each of 2–8 round trips: **≈$0.001–0.003 a pass**, under $0.01 a day.

**Ceilings.**

- The §6 ceilings (`db/coach-eval.test.mjs:1158`, `:1164`; 9,250 schema / 3,700 prompt) measure the static system prompt and the tool schemas. **This adds to neither**: no new tool, no schema change, no system-prompt line.
- The chat Coach does not get a ranking verb in v1. It can already move times with `adjust_today`. Adding a verb later would have to be paid for inside the schema headroom. That was ~157 tokens at the last recorded measurement (9,093 on 2026-09-25, `coach-eval.test.mjs:1155-1157`), and it must be re-measured first.

**Offline, without a key, or when the call fails.**

- `runCoachPass` returns `failed` (`coach-pass.ts:366-369`, `:448-451`). No ranking is written, and the day is not consumed (`pass-store.ts:335-339`).
- Home shows time order. A ranking from an earlier day is ignored because its `day` does not match.

**Staleness.** A morning ranking expires by early afternoon, and the evening pass ranks the evening. The gap between them is real. A midday pass would close it at about +$0.60 a month. **Phase 5 builds it only if two weeks of phase 1 data show the gap matters.**

---

## 4. The learning signal

### 4.1 What must be recorded that is not recorded now

The only behaviour on disk today is a mission row's final status (§1.4). The learning signal needs **exposure and response**, which the app currently does not keep:

| Event | Written when | By |
|---|---|---|
| `shown` | a candidate first becomes the hero today (once per candidate per day) | Home's render path, `useTodayMission` |
| `started` | the hero's primary action is tapped on a prompt or the planned workout (Log weight, Log a meal, Start, Resume); or Train today's Start | the button handlers |
| `snoozed` | Snooze | hero and item sheet |
| `skipped` | Skip **on a prompt** | hero |
| `done` | a prompt is satisfied by its data | the prompt deriver, on the next Home read that sees the data |
| `expired` | a prompt's window closed while it was still open (weigh-in at 10:00) | the deriver |
| `ranked` | one per key in a pass's `NEXT`, with its rank and `until` | pass-store |
| `offered` | Train today rendered a pick (once per pick per day) | the Train hub, and the Home workout candidate |

**Mission rows get no `done` or `skipped` event.** Their outcome is already `log_entries.status`, `completed_at` and `updated_at`, and a second copy of that fact would drift.

### 4.2 Storage: migration 0067

```sql
CREATE TABLE day_plan_events (
  id text PRIMARY KEY NOT NULL,
  day text NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  at text NOT NULL,                       -- ISO instant
  candidate text NOT NULL,                -- 'm:<id>' · 'p:weigh_in' · 'p:eat' · 'p:resume' · 'train:<routine id>'
  log_entry_id text REFERENCES log_entries (id) ON DELETE SET NULL,
  title text NOT NULL,                    -- snapshot: what it said at the time
  event text NOT NULL CHECK (event IN
    ('shown','started','snoozed','skipped','done','expired','ranked','offered')),
  ordered_by text CHECK (ordered_by IS NULL OR ordered_by IN ('time','coach')),
  rank integer CHECK (rank IS NULL OR rank BETWEEN 1 AND 3),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX day_plan_events_day_idx ON day_plan_events (day, candidate);
CREATE UNIQUE INDEX day_plan_events_once_idx ON day_plan_events (day, candidate, event)
  WHERE event IN ('shown','offered','done','expired');
-- + the per-table updated_at trigger (CLAUDE.md §9)
```

**Why this shape:**

- **`candidate` is free text** so a new prompt kind needs no migration. `event` is ARC's own vocabulary, so it gets a `CHECK`.
- **`ON DELETE SET NULL`** keeps history when a row goes (CLAUDE.md §9). The `title` snapshot is there for the same reason.
- **Volume:** roughly 20–40 rows a day, about 15k a year. That is small, and it is kept.
- **Backups:** it rides the ARCB1 encrypted snapshot like every other table, and nothing leaves the device.

### 4.3 How it reaches the model: as counts, never as a weight

A pure function summarises the last 14 days per source:

- **Sources:** each protocol item id (the stable `value.item`), each prompt kind, and Train today. A source is the protocol item, not the row, so a supplement's history spans days.
- **Counts:** times shown, started, done and skipped; the median minutes from shown to done; how many Coach-ranked tops were done before their `until`.
- **Format:** printed as one or two lines in the §3 directive section:

```
Last 14 days: weigh-in shown 12, done 11 (median 6 min); eat shown 9, done 4, skipped 3;
AM stack shown 14, done 13; Strength session shown 6, started 4; your top pick done before UNTIL 5 of 8.
```

**Nothing deterministic reads these counts to change anything:**

- The time order does not adapt.
- No prompt switches itself off after repeated skips.
- No candidate is suppressed.

If he skips the eat prompt six mornings in seven, the Coach can rank it last, or say "you skip this most days; turn it off?". The switch is in Settings.

**That is the learning:** the model sees what he does and orders tomorrow accordingly. On an offline day nothing learns, and nothing pretends to.

The chat Coach does not see the summary in v1. Exposing it later as a `query_records` domain would cost an enum entry against the schema ceiling, and is noted rather than planned.

---

## 5. Workout recommendation (item 77)

### 5.1 What it does now

**The pick.** `recommendToday` (`src/lib/exercise/recommend.ts:98-147`):

- Scores each saved workout by the mean freshness of its exercises' primary muscles.
- Picks the freshest, breaking ties toward the one started longest ago (`:105-131`).
- Flags caution below 60% (`ROUTINE_CAUTION`, `src/lib/exercise/constants.ts:132`).
- With no saved workouts, it offers the four freshest anchor muscles with one compound each (`src/lib/db/repositories/training-recommend.ts:105-133`).

**The inputs.** Freshness reads both logged sets and watch-inferred loads (`training-recommend.ts:173-177`).

**Per-exercise targets** are dynamic double progression (`src/lib/exercise/progression.ts:81-135`): add load at the top of the rep range, hold and add a rep otherwise, deload 10% after a 3-session stall.

**What it never derives.** It never decides how hard a day should be: `volumeScale` comes only from the Coach (`recommend.ts:30-41`).

**How the Coach reads it.** Through `get_training_recommendation` (`src/lib/ai/tools/read-tools.ts:1873`), which "reports numbers; it does not decide".

**What it does not know:**

- whether he took the pick;
- whether he hits, beats or misses the load targets;
- which exercises he drops or swaps from a saved workout;
- when in the day he usually trains.

### 5.2 What "smart learning" adds

All of these are facts handed to the model. None of them re-weights the freshness pick.

**1. Pick against choice.**

- Record `offered` (Train today's pick) and `started` (which routine, or ad hoc) in 0067.
- Joined with `workouts.routine_id`, this gives "offered Upper A 9 times, started it 5, started Lower B 3".
- The Coach can see a pattern the freshness rule cannot, for example that he never trains legs on a Monday.

**2. Targets against reality.**

- The engine's target for a past session is a pure function of the sessions before it, so it can be **recomputed without storing anything**.
- The result reads per exercise: "suggested 82.5 × 7, did 82.5 × 8 @ 8; beat the target 4 of the last 5".
- This shows when the increments are too timid or too aggressive for him.

**3. Swaps and drops.**

- Compare a session's exercises against its routine's lines (`routine_exercises`).
- A line dropped in 4 of the last 5 sessions is a fact worth a sentence.
- Caveat: routine lines may have been edited since, which the build must handle by reading the line set as of the session date where possible, or by saying so.

**4. The per-exercise mark** from `docs/spikes/pr-vs-overload.md`: progressing, holding or stalled, with sessions since the last new best.

**How it reaches the model.**

- All four ride `get_training_recommendation`'s **result**, which is payload, not schema, so it costs the §6 ceilings nothing (`read-tools.ts`, the 0062 note in its `execute`).
- The Home workout candidate's directive line (§3.1) names Train today's pick and the alternatives.

**Choosing a different saved workout.**

- The pass may add one line, `TRAIN <tag>`, choosing which saved workout the Home **Start** button opens.
- Train today's own card still shows the rule pick, so the two can differ. When they do, the Home hero says it is the Coach's choice.

---

## 6. Build plan

Each phase is shippable alone and reaches the phone only with the next TestFlight build. There is no native module, so no new EAS capability gate.

| Phase | What | Size | Visible change |
|---|---|---|---|
| **1. Record** | Migration **0067** + `npm run db:validate` assertions (CHECKs, partial unique index, SET NULL); repo `day-plan-events.ts`; write `shown` / `snoozed` / `started` from Home and `offered` / `started` from Train today. Fix the turn-context "next" to name the actual hero (`turn-context.ts:311`). | **S** (~1 day) | None. Data starts accruing, which phases 3–5 need. |
| **2. Candidates** | Pure `src/lib/home/candidates.ts` (facts in, prompts out, headless-tested across the day boundary, a 04:00 `dayStartsAt`, no sleep data, a queued estimate, a timed meal row); `deriveMissionView` takes prompts; per-kind primary action on the hero; uncounted list rows; Settings toggles and thresholds; `done` / `expired` / `skipped` prompt events. | **M** (~2–3 days) | Weigh-in, Eat and Resume can be the hero; time order. |
| **3. Coach ranking** | Directive section + 14-day summary; `NEXT` / `UNTIL` / `WHY` parser beside `parseNudgeReply`, stripped before the thread; `preferences.dayPlan`; expiry; thread record line; `ranked` events. Tests in `db/coach-pass.test.mjs`: tags map back, junk is dropped, `SKIP` + `NEXT` works, an offline pass leaves time order, and the §6 ceilings still pass **unchanged**. | **M** (~2 days) | The hero follows the Coach's pick until `UNTIL`. |
| **4. Training learning** | §5.2 items 1–4 in the tool result; `TRAIN <tag>`; Home **Start** opens the chosen saved workout. Depends on the PR/overload mark if that is built first. | **M** (~2 days) | The Coach's training advice cites what he actually does. |
| **5. Midday rank** (conditional) | One extra pass trigger: the first open after 12:00 when the morning ranking has expired and two or more candidates are open. Only if phase 1 data shows the afternoon running on stale or no ranking. | **S** | +~$0.60 a month. |

---

## 7. Risks

- **Hero churn.** Prompts appear and disappear as data lands, so the hero can change under his thumb.
  - Candidates are re-derived on focus and foreground only, as the mission already is (`use-today-mission.ts:107-134`), never on a timer.
  - A satisfied prompt leaves on the next read, not mid-tap.
- **Nagging.** Two prompts every morning, forever, is the failure that trains him to ignore the hero.
  - Mitigations are the per-prompt switches, Skip-for-the-day, and the Coach seeing the skip counts.
  - Nothing auto-disables. That would be a deterministic judgment about his behaviour.
- **A ranking leaks into the thread.** The `isPassSkip` lesson (`coach-pass.ts:72-127`) applies: the lines come out first, fenced or not, as `NUDGE` lines do. The parser is the guarantee, not the prompt.
- **Haiku ranks badly.** For example, a carried debt always last, or the workout pinned at 07:00.
  - It can only reorder the top three, it expires in hours, and time order is the floor.
  - The thread record makes every ranking visible.
  - Phase 3 should be judged on two weeks of `ranked` against what he actually did, from the phase 1 data.
- **The wake time is wrong.** A watch left on the charger means no sleep row. The fallback, first Home render, is late, never early, so the eat prompt can only appear later than it should.
- **Adherence drift.** Avoided by construction: prompts are not mission rows. A test should pin it: `missionDailySeries` is unchanged by any prompt.
- **The status rule erodes.** A future "don't offer the weigh-in when sick" is exactly the deterministic layer 0061 removed. The candidate module should carry that sentence, and a test should prove no candidate function reads `day_statuses`.
- **Cost creep.** Bounded by riding existing passes. Phase 5 is the only new pass and is gated on data.

---

## 8. Questions for the owner — answered 2026-10-21 (Q1 yes, Q3 yes, Q2 moot: no prompts)

Three remain. Everything else above is decided by the owner's direction or by existing rules.

**Q1. Do prompts appear in the checklist as well as the hero?**

- **Recommended: yes**, as uncounted rows at their time, with no checkbox, that open their logging screen.
- Hero-only would make the hero something the list does not contain, which breaks the rule that the two can never disagree (`docs/home-screen.md:131`).

**Q2. Which prompts ship first?**

- **Recommended: Weigh-in, Eat, and Resume workout.** The first two are yours. The third promotes the existing Resume line into the pool.
- "Fill in a watch-recorded session" and "a screening is due" come after you have lived with the first three.
- The defaults are 10:00 and 5 h, both editable in Settings.

**Q3. When the Coach pins the hero, may it put one sentence of reason under it?**

- **Recommended: yes**, at most 90 characters, attributed to the Coach, replacing the row's own `why` on the hero only.
- Without it, the order changes and nothing says why. The thread record line still exists either way.
