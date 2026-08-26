# ARC AI Coach — Capability Specification

**Status:** v1 spec shipped; Coach live-wired — persistent key (iOS Keychain), model picker, prompt caching, and protocol write-back (2026-07-27)
**Last updated:** 2026-08-14 (§5 write receipts + phantom-write detection; §4 day-stamped thread history)
**Status:** v1 spec shipped; Coach live-wired — persistent key (iOS Keychain), model picker, prompt caching, protocol write-back (2026-07-27); Modes + Experiments tools shipped (2026-07-31/08-01); **perception layer shipped (2026-08-08** — per-turn "Current state" context block, readiness/sleep/training-engine/lab-trend visibility; see `docs/coach-intelligence-review.md` for the review that drove it and the phases that follow**)**
**Last updated:** 2026-08-08

> **Governing principle (owner call, 2026-08-08):** deterministic code **detects and grounds**; the **model decides**; tools **enact**; the user **confirms**. No pure function may encode a clinical judgment ("low HRV → cut volume") — detection can surface a signal, but what to do about it is always the model's call, weighed with the user. The review doc's §4 table is the reference.

This is the concrete capability surface of the Coach: every tool it has (shipped, stubbed, or planned), its proactive behaviors, memory, safety rails, and the sequenced long tail — each item flagged with what it depends on. **Items marked `⚑ MATT` are product decisions to steer before the long tail gets built.**

---

## 1. What the Coach is

The intelligent layer of ARC: a calm, precise, slightly ruthless chief of staff for the user's biology. Not a chatbot — an **agent**. It reasons over the real on-device data and acts in the app on the user's behalf through a tool/function-calling loop:

```
user turn ──▶ model (streaming) ──▶ tool calls ──▶ executed locally against SQLite
                    ▲                                        │
                    └──────────── tool results ◀─────────────┘
                                (loop until the model answers in text)
```

Everything runs on-device except the model call itself (local-first, offline-except-AI — the 2026-07-24 ADR). The model is the latest Claude (`claude-opus-5` default), called directly from the app over streaming `expo/fetch`; the model is now user-selectable in **Settings › Coach** — Opus 5 / Sonnet 5 / Haiku 4.5 (`COACH_MODELS` in `model-client.ts`).

**Architecture (shipped 2026-07-26):**

| Layer | File | Role |
| --- | --- | --- |
| Model client + agentic loop | `src/lib/ai/model-client.ts` | Streaming Messages API call, SSE parsing, tool-use loop. Pure; fetch-injected; unit-tested with a mocked wire (`db/model-client.test.mjs`). The system prompt + tool list carry prompt-cache breakpoints so the large fixed prefix bills at ~0.1× on a turn's later round-trips. |
| Tool registry | `src/lib/ai/tools/` | Typed `{name, description, inputSchema, readOnly, execute(db, input, ctx)}` per tool, each wrapping a repository. Headless-tested against real SQLite (`db/coach-tools.test.mjs`). |
| Insights engine | `src/lib/ai/insights.ts` | Deterministic trends/gaps/correlations + the daily brief. No model involved (`db/insights.test.mjs`). |
| Service seam | `src/lib/ai/coach-service.ts` | The ONE model-call site. Real agentic path when a key is set; honest mock otherwise. Owns the write-confirmation gate. |
| Persistence | `db/migrations/0008_ai_chat.sql` + `src/lib/db/repositories/ai-chat.ts` | Conversations + append-only messages with the per-turn tool-call record. |
| Reminders | `db/migrations/0009_reminders.sql` + `src/lib/db/repositories/reminders.ts` | The nudge store + in-app surfacing. |
| System prompt | `src/lib/ai/system-prompt.ts` | §6 character + §6 voice (STE register, anti-LLM-tells) + tool doctrine + safety rails (the refined form of §7 below). |
| UI | `app/(tabs)/coach.tsx` + `src/components/coach/*` | Thread, reminders list, write-confirmation card, session-key panel. **No brief** — it was removed from this tab on 2026-08-10 (owner: *"it is already on the home screen"*); `src/components/coach/daily-brief-card.tsx` is deleted and the tab no longer imports `generateDailyBrief`. See §3 › Daily brief. Key + model managed in `app/settings-coach.tsx`. |

**Key handling:** the key is the app's one secret. It's stored in the **iOS Keychain** via `expo-secure-store` (`src/lib/ai/api-key-store.ts`) — never in SQLite, the JS bundle, logs, or the system prompt — with an in-memory mirror hydrated at boot (`app/_layout.tsx`) so the hot read path stays synchronous. Managed in **Settings › Coach** (paste / replace / clear + model pick) and quick-connectable from the Coach screen. `expo-secure-store` is a native dep: until the next EAS dev build ships it, the store degrades to memory-only (session-lived) and the UI says so plainly. The key rides only the `x-api-key` header on the direct call to Anthropic — the user pastes their own key; ARC never sees it server-side (there is no server).

---

## 2. Tool set

Every tool the model can call. **Read tools run freely; every write suspends the loop until the user approves it in the UI** (see §5). Inputs are validated at the tool layer — bad input becomes an `is_error` tool result the model can correct, and never reaches a repository.

> **The registry today: 43 tools — 18 read + 25 write.** `COACH_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS]` (`src/lib/ai/tools/index.ts`) is the single source of truth; this doc is the spec. §2a and §2b below list the original slice (9 read + 10 write); the ones added since are in **§2c** (modes, experiments, knowledge, nutrition targets, screenings) and **§2f** (recipes + grocery, 3 read + 5 write), and the deliberately withheld ones are in **§2d**. Counted 2026-08-12 by importing the registry, not by adding up this document.
>
> ⚠️ **Both prompt-token ceilings are at their limit and were raised once, at 43** (`db/coach-eval.test.mjs` §6: schema 9,000 → 9,250, prompt 3,500 → 3,700). The standing rule holds and is stricter than it looks: **the next tool added must trim duplication before it may raise anything again**, and the accounting for any raise goes in that file. **The protocols rework (2026-08-25) is the first addition to obey it against the SCHEMAS** rather than the prompt: `update_protocol` grew phases + cadence (+95 tok), and 82 of that was paid back out of genuine duplication in `create_experiment`, `adjust_today`, `log_workout` and its own description — net **9,206 → 9,219**, neither ceiling moved, 31 tok of headroom left. The next trim digs in the same place: `get_metric_series` (354), `log_workout` (349) and `adjust_today` (~340) are now the fattest.

### 2a. Shipped — read (execute immediately)

| Tool | Input | Reads | Returns |
| --- | --- | --- | --- |
| `get_today_snapshot` | — | mission (`log_entries`), `meals`, `workouts`, `symptoms`, ad-hoc captures, the day's mode, reminders due today, **the whole wearables plane**, readiness | Today's full picture in one call. `remindersDueToday` is **ranked today-first** and each item carries its pinned `date` + `daysOverdue`; capped at 10 with a sibling `remindersDueTodayOmitted` count — see "Reminder due-ness and ordering" below. `wearables` carries `today` (every metric with a value), `noDataToday` (core metrics **named**, never zeroed), `availableMetrics` (every `metric_type` on this device — all valid `get_metric_series` input) and an honest `note` when nothing has synced. `readiness` is the *same* derivation Home renders (`src/lib/home/readiness.ts`), reused rather than recomputed, so the Coach and Home can never disagree |
| `get_metric_series` | `metric` — **any** body metric or wearable `metric_type`, plus friendly aliases; `days?≤365` | `body_metrics` / `wearable_data` daily series | Daily points + min/avg/max in display units. See "The wearables plane" below |
| `get_training_summary` | `days?` (28) | `workouts` (+ recent sessions) | Totals, weekly rates, per-day load |
| `get_today_snapshot` | — | **readiness (`deriveReadiness` — the same verdict Home shows)**, the day's **mode**, mission (`log_entries`, **with item ids**), `meals`, `workouts`, `symptoms`, ad-hoc captures (in the user's units), reminders due today, **running experiments**, **profile (age/sex)** | Today's full picture in one call |
| `get_metric_series` | `metric: weight\|body_fat\|waist\|hrv\|rhr\|water\|sleep\|sleep_deep\|steps\|active_energy`, `days?≤365` | `body_metrics` / `wearable_data` daily series, windows closed at today | Daily points + min/avg/max (display units; sleep/steps/energy in fixed min/steps/kcal) |
| `get_training_summary` | `days?` (28) | `workouts` (+ recent sessions) | Totals, weekly rates, per-day load, `thisWeek` calendar block |
| `get_training_recommendation` | — | the whole training engine (`buildRecommendation`) | Today's session recommendation + per-exercise progression targets, muscle freshness ledger, program week/deload state, weekly volume vs MEV/MAV/MRV. **Reports state; the tool description tells the model the training decision is its own to make with the user** |
| `get_nutrition_summary` | `days?` (14) | `meals` | Per-day kcal/macros + averages across logged days |
| `get_symptom_history` | `days?` (30) | `symptoms` | Occurrences + counts by name w/ avg severity |
| `get_biomarkers` | `category?`, `biomarker?` | `biomarkers` ⋈ latest `lab_results` | Latest value per marker + optimal/standard ranges; explicit "no labs imported" when empty |
| `get_biomarker_history` | `biomarker` (slug or name) | all `lab_results` for one marker | The full series oldest-first + ranges; exact-match-first resolution that returns candidates on ambiguity instead of guessing |
| `get_protocols` | — | `protocols` ⋈ live `protocol_versions` | Each stack/routine/block with its live version number and its **phases** of items (title, time, dose, **cadence**), plus which phase is live today |
| `list_reminders` | — | `reminders` | Active reminders + due-today flags |
| `get_insights` | — | insights engine | Precomputed trends/gaps/correlations + the brief line |
| `get_experiments` | `include_completed?` | `experiments` | Active experiments w/ daysLeft + ready flags; recent verdicts on request |
| `search_knowledge` | `query`, `scope?` | RAG layer (0025) | Honest "not available yet" until the on-device embedder ships |

**Every turn also opens with a "Current state" system block** (`src/lib/ai/turn-context.ts`, 2026-08-08): date+weekday, profile+units, mode, readiness verdict+pillars, mission progress, running/ready experiments, and the deterministic brief — sent as a second uncached system block after the prompt-cache breakpoint. The model starts oriented and spends tool calls on depth, not on discovering what Home already shows.

#### The wearables plane — the Coach reads all of it (corrected 2026-08-09)

`get_metric_series` was documented here as taking `weight | body_fat | waist | hrv | rhr | water`. **That has not been true since the HealthKit pipeline landed, and this doc understated the tool badly** — it named six inputs while the tool already accepted every metric the pipeline declares: steps, the six sleep rows (asleep, time in bed, deep, REM, core, awake), active and resting energy, VO₂max, respiratory rate, blood oxygen, body and wrist temperature, and workout minutes — plus anything a future vendor ingests. Corrected rather than left as an aspiration, because a tool spec that lists fewer inputs than the tool accepts teaches the model not to ask.

**Why there is no enum to keep in sync.** `wearable_data.metric_type` is deliberately free text so a new vendor metric is never a migration (CLAUDE.md §9). A hardcoded readable list therefore rots on contact with the next ingest — which is exactly how it rotted here. So the readable set is built in two layers and never typed out by hand (`src/lib/ai/tools/read-tools.ts`):

1. **DERIVED from the ingest specs themselves** — `SAMPLE_METRICS` + `STATISTIC_METRICS` in `src/lib/health/mapping.ts`, the sleep rows `sleepDailyRows()` emits, plus the two manual-capture targets (`water_ml`, `workout`). Add a metric to the pipeline and it is readable with **no edit to the tool layer**.
2. **DISCOVERED from the data** — `SELECT DISTINCT metric_type`. Anything present that layer 1 does not describe is still readable, with its unit taken from the rows and **`inferred: true`** in the output so the model knows the semantics were guessed rather than declared. Ambiguous cadence defaults to arbitration, never summing: arbitration can only under-report, whereas a wrong sum silently doubles a day.

**What that buys the model, concretely:**

- **Discovery, not guessing.** `get_today_snapshot.wearables.availableMetrics` lists exactly what this device holds, and every entry is valid `get_metric_series` input. An unknown metric is an `is_error` naming the available set, not a silent empty series.
- **Aliases.** `sleep`, `deep_sleep`, `in_bed`, `active_calories`, `spo2`, `vo2`, `step_count`, `resting_heart_rate`, `workout_minutes`, … resolve to the real `metric_type`, so a reasonable guess works.
- **The user's units, always.** Volume and temperature resolve through Settings › Units — the Coach never cites °F to a °C user or oz to an ml user — and minute-valued metrics also report `hm` / `avgHm` ("7h 11m"), never a raw minute count.
- **The right daily aggregation per metric.** Genuinely accumulating metrics (`workout`, `water_ml`) are summed; everything else is **arbitrated** — one winning source per day, richest device first, the same rule Home and the Data tab use, so the three surfaces cannot disagree.
- **Absence is never a zero.** Every series carries an explicit `hasData`, and when it is false a `note` says so in words — distinguishing "never recorded on this device" from "nothing in this window, most recent value is from `<date>`". **These notes are additive, not alternative:** a discovered metric that is both `inferred` and empty gets both sentences, absence first. (It did not until 2026-08-09: they were two branches of one ternary, so precisely that case lost the absence warning — the confusion the design exists to prevent.)

### 2b. Shipped — write (confirmation-gated)

| Tool | Input | Writes via | Confirmation line |
| --- | --- | --- | --- |
| `log_metric` | `metric`, `value`, `unit?`, `date?` | `logMetric` (registry-converted to canonical) | "Log weight 178 lb" |
| `log_meal` | `name`, `time?`, macros?, `notes?`, `date?` | `logMeal` | "Log meal "Salmon bowl" · 700 kcal, 45 g protein" |
| `log_workout` | `name`, `kind`, `duration_min?`, `sets?` (weight in lb unless `unit:"kg"`), `date?` | `logWorkout` (transactional with sets) | "Log workout "Upper A" · 55 min · Bench 8 × 225 lb" |
| `log_symptom` | `name`, `severity?`, `body_area?`, `time?`, `notes?`, `date?` | `logSymptom` | "Log symptom "Headache" · 4/10" |
| `log_capture` | `type: supplement\|medication\|therapy`, `title`, `date?` | `logCapture` | "Log supplement: Creatine · 5 g" |
| `log_note` | `text`, `date?` | `logNote` | "Save note: …" |
| `set_reminder` | `title`, `time?`, `date?`, `repeat: once\|daily\|weekly`, `notes?` | `createReminder` (`created_by: 'ai'`) | "Set reminder "Take magnesium" at 21:00 · daily"; a one-off pinned to another day names it — "Set reminder "Call the clinic" at 09:00 · tomorrow (Sat 8 Aug)" |
| `complete_reminder` | `id` (one-offs only — refuses recurring) | `completeReminder` | "Mark reminder "Book DEXA" done" |
| `dismiss_reminder` | `id` | `dismissReminder` | "Dismiss reminder "Take magnesium"" |
| `update_protocol` | `protocol_slug`, `phases[]` (the COMPLETE new content), `change_notes` | `addVersion(…, 'ai')` — writes a NEW immutable version, never edits the live one — then re-derives TODAY | "Update "Evening Stack": 3 items (was 2) — added magnesium · applies to today's plan now" |
| `set_mode` | `mode`, `until?`, `note?` | `setMode` + `rederiveMissionForDay` (today reshapes immediately, work preserved) | "Set Sick mode for today" |
| `create_experiment` | `name`, `hypothesis`, `intervention`, `metrics[]`, `duration_days`, `success_criteria?` | `createExperiment` (starts today, computed end date) | "Start experiment "Magnesium PM" — 14 days" |
| `complete_experiment` | `id`, `conclusion`, `outcome_notes?` | `completeExperiment` (active-only guard) | "Conclude experiment "Magnesium PM"" |

Log tools reject a **future** `date` (`optPastDate`, 2026-08-08) — a mis-parsed "next Tuesday" used to silently poison every trend window. `log_workout` sets now resolve their catalog **`exercise_id`** by unique exact name/alias match (never fuzzy), so Coach-logged training feeds e1RM/freshness/volume instead of being invisible to the engine; unmatched names are reported back in the tool result.

A Coach-logged row is indistinguishable from a hand-logged one downstream — the tools call the same repositories the capture screens use. Three contract rules, enforced in code and covered by tests: **units convert in code, never in the model** (values arrive as the user said them — lb, oz — and the registry/exercise helpers canonicalize); **backdating is explicit** (every log tool takes an optional real-calendar `date`; the confirmation line shows a backdate, and the system prompt instructs the model to pass one for "yesterday…" reports); **the confirmation line carries everything consequential** — macros, sets, dates, and the resolved *name* behind any id (the user never approves a bare identifier).

That last rule covers a day the tool **derives** as well as one the user passes. `set_reminder` pins the day of a bare-time one-off as it saves, so `CoachTool.confirmSummary` takes a **third argument — the same `CoachToolContext` (`{ now }`) instance `execute` gets** — and resolves the day through the very function `createReminder` uses. The card therefore reads "… at 09:00 · tomorrow (Sat 8 Aug)" instead of a bare "at 09:00" that quietly writes tomorrow's row. Day names are spelled out by hand because **Hermes has no `Intl`**, and the ISO day is split componentwise, never `new Date('YYYY-MM-DD')`.

**One clock per tool call — the contract, and why the argument is required.** The service layer (`src/lib/ai/coach-service.ts`) reads the turn's clock **exactly once per tool call**, above the confirmation gate, and hands that one `CoachToolContext` to both halves: `confirmSummary(input, db, context)` and, after the user approves, `execute(db, input, context)`. That is the whole point — the card the user approved and the row that lands must be computed from the same instant. When the argument was first added it was **optional**, and the only real call site quietly kept passing `(input, db)` while `execute` minted a fresh `new Date()` of its own; a card rendered at 08:59:30 for "at 09:00" then wrote a row dated *tomorrow* if approval arrived at 09:00:10. **Fixed 2026-08-08 by making the argument required**, so rendering a card without the turn clock is a type error. The freeze is scoped to **one tool call, not the whole turn** — a turn spans streaming, arbitrary approval latency and up to 8 model round-trips, so a turn-wide freeze would date a later `log_meal` to the wrong day across midnight. A summary that doesn't need a clock simply omits the parameter. Pinned by `db/coach-tools.test.mjs` §16, which drives the real `streamCoachReply` call site rather than the tool in isolation.

**Protocol edits are versioned, not patched.** `update_protocol` never mutates the live version: the model reads the current content with `get_protocols`, submits the COMPLETE new one (kept items + the change), and the tool writes a new immutable `protocol_versions` row via `addVersion(…, 'ai')`, bumping `current_version_id`. The confirmation line shows the item-count delta (`3 items (was 2)`) so a destructive replace cannot be approved as an innocent add; the old version is preserved. This is the concrete form of "add magnesium to my evening stack → the stack actually updates."

**Since content schema 2 (2026-08-25)** the argument is `phases`, not `items` — ordered phases of items, each item carrying an optional **cadence** as a compact string: `daily` (the default) · `mon,wed,fri` · `every 3 days` · `3/week` (any three days that week, the user picks). A string rather than a four-branch object union because both prompt ceilings are near full and the union costs several times the tokens for the same expressiveness; it is parsed at the tool boundary by `parseCadenceText`, and **anything outside the vocabulary is refused with a message naming it** rather than persisted broken. The same `validateContent` gate the editor passes through applies here, so a document the editor would reject cannot arrive by tool instead. An item the model re-sends unchanged **inherits its id**, so a complete-set replacement does not silently reset every N-per-week quota or break the version diff. `apply_today` is **gone**: an edit now always reaches today, through the same re-derive a mode change uses, and everything already completed / skipped / partial / ad-hoc is preserved.

### 2c. Shipped since — modes, experiments, knowledge, nutrition targets, screenings

Earlier revisions of this doc listed `set_mode` and `create_experiment` as unregistered stubs. **Every tool below is registered.**

| Tool | Kind | Notes |
| --- | --- | --- |
| `set_mode` | write | Sets today's mode (Normal/Travel/Sick/Deload/Social/Custom) so plan, priorities, tone and adherence adapt. Shipped with `day_modes` (**0026**); mid-day changes re-derive the mission as a diff that preserves completed work. The active mode also appears in `get_today_snapshot`. |
| `create_experiment` | write | n-of-1: hypothesis, intervention, watched metrics, duration, success criteria. Shipped with `experiments` (**0027**). Rejects empty metrics and durations under 3 days. |
| `complete_experiment` | write | Concludes a running experiment with a verdict. Refuses an unknown id, and refuses to re-conclude one that already has a verdict. |
| `abandon_experiment` | write | Drops a running experiment without a verdict. |
| `get_experiments` | read | Running (ready-to-read-out first), concluded, abandoned. |
| `set_nutrition_targets` | write | Versioned kcal/protein/carb/fat targets — takes the **COMPLETE** new set, never a delta. Added 2026-08-12 after the owner pass found the Coach reporting a shipped feature (0015) as absent, which is also what produced the coverage manifest. |
| `get_screenings` | read | The preventive-screening ledger and the medical calendar (**0007**) — what is due, overdue, and booked. Added 2026-08-12, same census. |
| `log_screening_done` | write | Marks a screening completed on a day and rolls its next-due date forward. |
| `save_knowledge_entry` | write | **Added 2026-08-12 with the knowledge base (0038).** Writes ONE reference entry — how something works, or a stance the user commits to — through the same repository path the editor and the import review screen use, so it is chunked and citable the moment it lands. `source='coach'`. Card: `Save knowledge entry "<title>" · <topic> · <N> words`. **The card is compact on purpose and is only safe because of the doctrine beside it:** the model must present the drafted body verbatim in its message *before* calling, so what the user approves is on screen and not just a title. Reach for it only on the user's request or clear invitation — never to file away your own output. See `docs/knowledge-subapp.md` §6. |
| `search_knowledge` | read | ⚠️ **WRITTEN BUT DELIBERATELY NOT REGISTERED** — `read-tools.ts` says so in as many words, and this doc claimed the opposite for weeks. Semantic RAG over the corpus via `sqlite-vec` (**0025**), which cannot return a passage until the on-device embedder model ships (§9): a registered tool that always fails teaches the model not to call it. `search_history` covers the same ground by keyword today, over the user's own writing, ARC's pack **and** their own knowledge entries. Re-register it the day the embedder ships — **batched** with whatever else is pending, per the token-ceiling note above. |

**Why the Coach owns experiments.** The browse screens (`app/experiments.tsx`, `app/experiment-detail.tsx`) are deliberately **read-only with zero pine**: the Coach designs and concludes experiments because it reads the watched metrics first. A "Conclude" button on a screen with no numbers behind it would invite a verdict with no evidence.

### 2d. Still stubbed — interface defined, NOT registered (`src/lib/ai/tools/stubs.ts`)

Withheld from the model on purpose: a tool that always fails teaches the model not to call it. `STUB_TOOLS` contains exactly two entries, and `db/coach-tools.test.mjs` asserts neither ever appears in the registry.

| Tool | Blocked on | Notes |
| --- | --- | --- |
| `complete_mission_item` | **Mission ids must be surfaced to the Coach** — the snapshot exposes titles/status read-only today | Would let the Coach tick off work you tell it you did. |
| `navigate_to` | **A navigation seam** — tools execute headless; navigation is a UI side effect the service must broker (an event the screen subscribes to) | "Pull up my labs" ends on the Labs screen, not in prose. |
Withheld from the model on purpose: a tool that always fails teaches the model not to call it. Each ships when its dependency lands. *(2026-08-08: `create_experiment` and `set_mode` graduated to registered writes — see 2b; the coach-assist wrapper stub was deleted outright.)*

| Tool | Blocked on | Notes |
| --- | --- | --- |
| `complete_mission_item` | Superseded by **`adjust_today`** (coach-intelligence-review.md §4 Phase 2) — snapshot now exposes mission ids, so the batch mission-write tool absorbs this | Snapshot exposes ids + titles/status read-only today. |
| `navigate_to` | **A navigation seam** — tools execute headless; navigation is a UI side effect the service must broker (an event the screen subscribes to; the listener-set idiom already ships 3× in-repo) | "Pull up my labs" ends on the Labs screen, not in prose. |

### 2f. Shipped — recipes + grocery (`docs/recipes-grocery.md` §6)

Eight tools that put the recipe book and the standing grocery list inside the Coach's reach, so *"we're out of milk"* and *"what should I cook tonight"* are the model calling a tool rather than a phrase detector firing. Judgment stays in the model; these only report and write.

| Tool | Kind | What it does, and the rule it carries |
| --- | --- | --- |
| `get_recipes` | read | The book as summaries, for suggesting what to cook and for finding the `recipe_id` the write tools need. `perServingKcal` is **null** whenever the recipe's honesty gate failed — the model must say so rather than guess. |
| `get_recipe` | read | One recipe in full: ingredient ids, resolution state, per-macro nulls. Without it the ids the other tools consume would be unobtainable. |
| `get_grocery_list` | read | Open items with ids and category labels, optionally including the cart. Every id a write tool consumes is an id a read tool returned. |
| `add_grocery_items` | write | **Batched** — up to 30 items in ONE call, so "milk, eggs and spinach" is one approval card, never three. |
| `complete_grocery_items` | write | Batched check-off by id. Names are resolved *before* the card is drawn, so the user never approves a bare identifier. |
| `add_recipe_to_grocery_list` | write | A recipe's ingredients, minus the ones already on the list. Refusing before the card when everything was excluded, rather than showing a card that would do nothing. |
| `log_recipe` | write | Cooking it: servings XOR grams, scaled from the recipe's own snapshots. When the result reports `uncountedIngredients > 0` the meal is a **known undercount** and the model must say so. Refuses before the card if the recipe has nothing loggable. |
| `save_recipe` | write | The Coach authoring a recipe (`source = 'ai'`). Its lines land **unresolved**, so its nutrition reads "not computed" until the user links foods in the app — never a fabricated total. |

**Prompt-cache note:** the tool list is part of the cached prefix, so adding tools invalidates it. These eight landed as one batch for that reason.

### 2e. Planned — not yet designed in code

- `explain_metric` — curated explainer per metric/biomarker; becomes real once the knowledge corpus is populated.
- `propose_today_adjustment` — restructure today's mission (needs mission write access; the highest-leverage write of all). `⚑ MATT`: this is where "slightly ruthless" becomes real — how much rope does the Coach get to rearrange a day unprompted?
- `generate_grocery_list` — meal templates now exist (0018), so this is unblocked and simply unbuilt.
- `log_labs` — manual lab-result entry by voice/chat. The Function PDF pipeline has since shipped and defines the import path; the dedupe rules for a *chat-entered* result are what remain.
- `adjust_today` — batch mission surgery (complete/skip/add/move/remove) behind ONE diff confirmation card; the lever that turns the model's judgment into a changed day. Design: coach-intelligence-review.md §4 Phase 2. `⚑ MATT` (ruthlessness rope) resolved conservatively: the confirmation gate IS the rope.
- `explain_metric` — curated explainer per metric/biomarker; becomes real with the knowledge base (RAG corpus).
- `generate_grocery_list` — needs meal templates (Protocols).
- `log_labs` — manual lab-result entry by voice/chat; its old blocker (the Function PDF pipeline's dedupe rules) shipped 2026-07-29 — needs a design pass now.

---

## 3. Proactive behaviors

The Coach's proactivity is **deterministic detection + model narration** — the insights engine (`src/lib/ai/insights.ts`) computes what is notable; the model decides how to say it and what to do about it. Every number the Coach cites from it is arithmetic, not generation.

### Shipped detectors (thresholds conservative on purpose — noise teaches the user to ignore the Coach)

| Detector | Fires when | Tone |
| --- | --- | --- |
| HRV trend | 7-day avg vs prior 21-day avg moves ≥ 5% (≥ 3 readings per window) | down = watch, up = good |
| Resting-HR trend | same windows, ≥ 3% | up = watch |
| Weight trend | same windows, ≥ 1% | info (direction-neutral) |
| Protein trend | per-logged-day avg, ≥ 10% — **full days only** (today is still being written and never counts) | down = watch |
| Training volume | last-7-full-day minutes vs the baseline's weekly rate, ≥ 25% — baseline divides by the weeks it **actually covers** (a 2-week-old user isn't compared to an empty third week), and "down" additionally requires the session **count** to agree (duration-less sessions are a data gap, not a collapse) | down = watch, up = good |
| Logging gap | weight unlogged > 7 days (having been logged before) | watch |
| Symptom volume | ≥ 3 this week AND > 1.5× prior weekly average | watch |
| Correlation | prior-day training minutes ↔ next-day HRV, ≥ 8 pairs, \|r\| ≥ 0.5 — days with no workout row count as **0-minute rest days**, which is the contrast the detector exists to see | negative = watch |

`⚑ MATT`: thresholds are my calls — tune once real data flows. Also: targets (protein g/day, training min/week) are deliberately NOT hardcoded; they should come from Protocols when it lands, not constants.

### Daily brief

`generateDailyBrief(db, now)` composes top insights + reminders due today into 1–3 sentences with no model call, so the brief is real even offline. **It is surfaced in exactly one place: Home** (`src/components/home/coach-brief.tsx` ← `useDailyBrief`). `src/lib/home/mock-day.ts` was deleted outright when Home was wired to it.

**The Coach tab's brief card was removed 2026-08-10** — owner: *"it is already on the home screen"*. It printed the same `generateDailyBrief` string one tab away from Home's, so the second copy bought nothing and cost a duplicated focus-reload. `src/components/coach/daily-brief-card.tsx` is deleted; `app/(tabs)/coach.tsx` no longer imports `generateDailyBrief`, and `onTurnComplete` no longer has a brief to refresh. Reminders are now the first thing in that scroll. If a brief ever returns to the Coach, it should be a *different* artefact than Home's, not a mirror of it.

Later: the model rewrites the deterministic skeleton in voice (one cheap call on app open) — the numbers stay the engine's.

**Reminders in the brief are split, not merged (2026-08-08).** Home is sacred (CLAUDE.md §5) and answers "what should I do right now", so a carried-over nudge may never be printed as if it were today's plan:

- **`On deck today: Take magnesium (21:00) · Stretch (07:00).`** — only items genuinely due on their own day (every recurring reminder, a one-off pinned to today, and an undated legacy one-off). First **3** named; anything beyond is counted, not dropped — ", and 3 more".
- **`Still open: Book bloodwork (09:00) — 4 mo overdue.`** — one-offs whose pinned day has passed and which the user has neither completed nor dismissed. First **2** named, oldest nag first, remainder counted the same way.

Both lines are drawn from `dueRemindersFor(db, today)` (`src/lib/ai/insights.ts`), the shared ranked set described under "Reminder due-ness and ordering" in §9. Ages are hand-rolled (`1 day` / `12 days` / `4 wk` / `4 mo` / `2 yr`) on the same thresholds as the Screenings ledger — **Hermes has no `Intl`**. Covered by `db/insights.test.mjs` §§12–15.
`generateDailyBrief(db, now)` composes top insights + reminders due today into 1–3 sentences with no model call, so the brief is real even offline. Surfaced on the Coach screen's brief card AND Home (`useDailyBrief` — the old "integrator step" note here was stale; it shipped). Since 2026-08-08 the brief also rides the per-turn "Current state" block, so the model reads the same briefing the user does. Later: the model rewrites the deterministic skeleton in voice (one cheap call on app open) — the numbers stay the engine's.

### The coach pass — the one place the Coach speaks without being asked

Shipped 2026-08-08 (`src/lib/ai/coach-pass.ts`, `pass-schedule.ts`, `pass-store.ts`). Everything else in the Coach runs because the user typed something; this runs on its own.

**When.** `duePass()` decides, and only ever decides *whether to wake the model* — never what it should conclude. Two triggers: **daily** (once per calendar day, first app open, bounded by a stored date so ten launches cost one pass) and **signal** (a watch-tone insight that was not present at the last pass — keyed by insight id, so a standing HRV trend fires once, not every launch). A clock rolled backwards cannot re-fire the day.

**What it may do.** The pass is given the **read tools only**, so there is no write to gate and nothing it decides can change data unattended. When it concludes something should change, it says so, and acting on that happens in the thread where the confirmation gate lives and the user is present.

**It may say nothing.** The directive tells the model to reply with exactly `SKIP` when the day doesn't warrant a word, and the directive deliberately names **no scenario** — it does not mention recovery, or training, or any other domain. A coach that produces a paragraph every morning trains the user to ignore it.

**Four rules the implementation had to learn the hard way** (all four were live defects; see `coach-intelligence-review.md` §4b):

- **One runner.** Running and reading are separate: `pass-store.ts` owns the state, the root drives it, everything else subscribes. Mounting a single do-both hook in two places meant two model calls and two assistant turns per trigger.
- **After hydration.** The API key arrives from the Keychain *asynchronously*. A synchronous `has()` check on mount is always false on a cold start — which made the daily pass, the entire point of this feature, unable to fire at all.
- **Never while locked.** The pass reads health data and posts it to the model API. Behind the Face ID gate nobody has authenticated, so it waits and fires the moment the gate opens.
- **Offline is not silence.** `CoachPassStatus` distinguishes `spoke` / `silent` / `failed`. Silence is a *judgment* and consumes the day; a failure is an *absence* and must not — otherwise one aeroplane-mode morning cancels that day's pass and the user is told nothing by a system that never looked.

What it says is written into the thread as a normal assistant turn (auditable, in context on the Coach tab) and surfaced on Home as a dismissible "Coach noticed" card above readiness. It defaults to a cheap model — paying Opus rates for `SKIP` every morning is indefensible.

### Planned proactive surfaces (sequenced)

1. **Turn-level proactivity (shipped):** the system prompt instructs the model to voice notable insights it reads mid-conversation, unprompted.
2. **Self-initiated reminders (shipped):** the Coach can propose a nudge for a logging gap ("want a daily nudge?") → `set_reminder`, still user-confirmed.
3. **Evening accountability (shipped as a trigger):** `PassTrigger.checkin` carries a morning/evening part, and the evening directive compares what the day planned against what happened. `⚑ MATT`: cadence and quiet hours are still yours to set — it is off by default.
4. **Predictive alerts** — "3 poor sleeps + rising RHR: historically your next 2 days trend sick." Needs more history. Note the phrasing: the *detector* surfaces the pattern; whether it means a deload is the model's call, not a rule's.
5. **Mid-day corrections (shipped):** `adjust_today` + `set_mode`'s re-derive give the Coach real levers on the current day, behind one confirmation.

---

## 4. Memory

**Shipped now:**
- **Conversation persistence** — `ai_conversations` / `ai_messages` (0008). Append-only turns; every assistant turn stores its full tool-call record (`tool_calls` JSON), so a transcript is auditable: what the Coach said traces to what it actually read. Reload resumes the latest thread.
- **Bounded context** — the last 30 turns go to the model; the data itself is *not* stuffed into context — the model re-reads through tools, which is both fresher and cheaper.
- **Per-turn state (2026-08-08)** — the "Current state" block (`turn-context.ts`) means within-day orientation is free. It is NOT memory: nothing durable survives the 30-turn window yet — `coach_memories` + `remember`/`forget` are the next phase (coach-intelligence-review.md §4 Phase 3).
- **A thread that knows how old it is (2026-08-14)** — turns in the history window carry a relative day stamp (`[today]` / `[yesterday]` / `[4 days ago]`) at each calendar boundary (`history-window.ts`).

  Owner report: *"Coach also does weird things like recommending that I add stuff to my grocery list from dinner 2 nights ago, it needs to move past things without me telling it when time has past and I am obviously ignoring it."*

  The cause was not a suggestion engine with too wide a window. `buildWireHistory` shipped the last 30 turns as bare `{role, content}` with **no timestamp anywhere on them**. The "Current state" block gave the model today's date, but every prior turn arrived undated — so a thread spanning four days read as one unbroken present, and a dinner discussed on Monday was still live business on Thursday. The Coach was not ignoring the age of the thing; it could not see it. `recentDeclines` did not help either: the owner never *declined* anything at a confirmation gate, they simply did not act, and an ignored prose suggestion leaves no row.

  Stamped **on change only**, plus the first surviving turn — a same-day thread costs one `[today]` (~4 tokens), a week-long one a handful. Relative rather than absolute, because the judgment is about elapsed time and "3 days ago" states it without making the model do arithmetic against another block. Ages are **clamped at zero**: SQLite's `strftime('now')` reads a finer clock than `Date.now()` on Windows, so the newest turn can measure as fractionally in the future.

  The paired prompt rule gives the model the standing instruction and leaves the call to it, per the governing principle at the head of this doc: if it already raised something on a previous day and nothing came of it, let it go, and treat an old event as history rather than as today's business. **No rule table of what is worth suggesting** — the defect was a suggestion engine that could not see its own history, so it was given the facts, not a policy.

**Planned (sequenced):**
1. **Coach notes** — a `coach_memories` table (or `users.preferences` initially) of durable facts the model asks to remember ("prefers training fasted", "magnesium gives GI trouble"), written via a `remember` tool (confirmation-gated), injected into the system prompt. Small, curated, user-inspectable — memory the user can read and delete. `⚑ MATT`: where should this be visible/editable? (Settings vs Data)
2. **Conversation history UX** — list + search of past threads; "new conversation". Schema already supports it.
3. **RAG over history + knowledge base** — sqlite-vec embeddings over user history and the curated corpus (deliberately out of this slice; needs an embedding path and the knowledge base).
4. **Experiment memory** — experiments + readouts as first-class recall once `experiments` lands.

---

## 5. Safety & control

Enforced in code, not vibes:

1. **Consequential writes are user-confirmed.** The loop suspends on any non-`readOnly` tool; the UI shows "Coach wants to: <summary>" with Approve/Decline (`PendingWriteCard`). Decline sends the model an explicit "user declined — do not retry" result (recorded `declined: true`, *not* an error). Unmount/abort resolves as declined. Nothing writes without a tap. Each approval is **nonce-bound** to the request it was shown — in a multi-write turn, a double-tap racing the next gate cannot approve the following write sight-unseen.
2. **Never fabricate data.** The system prompt requires tool reads before any data claim and mandates "you haven't logged X" over invention; empty tools return explicitly empty JSON (`stats: null`, "No lab results imported yet") rather than omitting fields a model might fill in. The insights numbers are computed, not generated.
3. **Medical boundaries.** Prompt-enforced: never a doctor, no definitive diagnoses/dosing, flag what needs a clinician, show confidence, "based on your data + current evidence" framing. A model-level `refusal` stop reason is surfaced honestly, never retried.
4. **Auditability.** The per-turn tool-call record persists in `ai_messages.tool_calls`; the UI shows which tools each reply used (chips under the bubble). A turn that fails *after* tools executed still persists its partial record (`CoachTurnError` carries it out), so an approved write is never untraceable — note that retrying such a turn can legitimately re-ask to log the same thing; the audit trail is what makes a duplicate visible. Full turn-idempotency is future work (flagged §9).
5. **Key hygiene.** Session-only memory store; never persisted, never logged, never rendered back. UI copy says exactly this.
6. **Bounded agency.** Max 8 model round-trips per turn (runaway-loop guard); `days` windows clamped ≤ 365; input validation ahead of every repository call.
7. `⚑ MATT`: should *reads* ever be gated too (e.g. a visible "Coach read your labs" trail is enough?), and should some writes (log_note?) graduate to auto-approve once trust is established? Current stance: all writes gated, all reads free but visible.

### What changed is reported by the RECORD, not by the reply (2026-08-14)

Owner report: *"Coach is still frequently thinking that it has done something but not actually calling the tool — i.e. saying that a recipe has been saved when the tool was not called and not actually saved."*

This is the worst failure the app has, because it is silent. The owner learns about it days later, when the recipe is not there, and by then every other claim the Coach has made is in doubt.

**Two causes, both reproduced against the real call site** (`db/coach-fidelity.test.mjs` §2):

1. **The model asserts a completed write and calls no tool.** The turn settles `end_turn` with `toolCalls: []` and outcome `complete`. Until this change the thread rendered it *identically* to a turn that really wrote — the only difference was the absence of a small mono tool chip, which nobody reads.
2. **The narration fallback.** `settledText` prefers the post-tool answer and falls back to the pre-tool narration when there is none. That fallback is correct and load-bearing, but when the second round-trip returns no text after a **declined** write, the turn settles on the model's own promise — "I'll save that recipe to your book now." — with nothing written.

**The fix is structural, and the important half needs no text analysis.**

- **`CoachToolCall.receipt`** — the line the user approved on the confirmation card, recorded in `coach-service.ts` **on the far side of `tool.execute`**. A declined write returns before it; a throwing one lands in the catch; a read never sets it. *A receipt therefore cannot exist unless a tool ran to completion*, and the model cannot reach that statement by writing a sentence. It rides the existing `tool_calls` JSON, so it needed **no migration**; rows written before it fall back to the tool name.
- **The thread prints receipts on every writing turn**, not only on a cut-off one as before (`message-bubble.tsx`). This is what makes the absence legible: when a real save always shows a receipt, a save with no receipt is visibly not a save.
- **`claimsCompletedWrite`** (`src/lib/ai/write-claim.ts`) — the loud half. When a turn lands **zero** writes and the prose nonetheless claims one, the bubble says "Nothing saved" and states it plainly, because an absence alone asks the reader to notice something missing and nobody does. Deliberately conservative: three guards (negation, offer/question, second-person actor) throw a sentence out before any rule is tried, so "You have not logged weight in 11 days" and "Want me to save that?" are silent. It only ever runs on turns that wrote nothing, so a real write can never be mislabelled. Derived on load rather than stored — both inputs are already persisted, so a reloaded thread reaches the same verdict.
- **One prompt rule**, in the cached prefix: never report a change as done before its tool result arrives, and the app prints a receipt from the tool record.

The prompt rule is the weakest of the four and is stated last on purpose. The receipt is what actually holds, because it is not advice.

---

## 6. Personality & voice

### Character (unchanged)

- Calm, precise, evidence-seeking, honest about uncertainty
- Slightly ruthless about prioritization ("that is low leverage. Skip it.")
- Deeply familiar; direct but respectful; never hypey
- Quantified over vague: "HRV is down 14% against your 30-day baseline"
- Phone-screen concise; leads with the answer

### Voice (rewritten 2026-08-10)

Owner report: the Coach *"speaks a bit AIy, i.e. with emdashes and the like."* The em dash is the tell, not the cause. The `VOICE` block in `src/lib/ai/system-prompt.ts` now names the register concretely and pairs it with a controlled-language positive half.

**Two causes, both fixed rather than papered over:**

1. **The prompt was teaching the register it was supposed to prevent.** The old voice bullets — and `TOOL_DOCTRINE`, which is far longer — are written in dense em-dash prose. A model imitates the style of its own system prompt, so an abstract "be calm and precise" was competing with ~40 worked examples of the opposite and losing. `VOICE` is now written **without em dashes** (the only ones left sit inside the labelled `NOT:` examples), and it closes by telling the model not to copy the punctuation of the dense sections below it.
2. **Markdown is never rendered.** `src/components/coach/message-bubble.tsx` puts `message.content` straight into a React Native `<Text>`; there is no markdown renderer anywhere in the thread. So `**bold**` reaches the phone as literal asterisks. **"No markdown" is a correctness rule here, not a taste one** — revisit that bullet only if a renderer is ever added.

**Named and banned** (a vague "sound natural" does nothing): em dashes · "it's not just X, it's Y" and other reframing flourishes · adjective triads and three-clause rhythm · hedge stacks ("might be worth potentially considering") · restating the question before answering · summarizing what it just said · opening with "Great question" · closing with a generic offer of further help · markdown and emoji.

Note the one carve-out: a **specific** proposed next action ("Want me to move the rest of the day?") is not the banned closing offer. That distinction is drawn in the prompt and shown in its example.

**Simplified Technical English, the parts that fit.** STE is the aerospace-maintenance controlled language (ASD-STE100). Adopted: one idea per sentence · sentences under ~20 words · active voice · instructions as imperatives · **the same word for the same thing every time** (if the protocol is the Evening Stack, it is the Evening Stack in every sentence, never "your nightly regimen") · plain nouns instead of metaphor · no empty qualifiers (very, quite, actually, somewhat) · noun clusters capped at three.

**Deliberately NOT adopted:** STE's telegraphic register. The prompt explicitly keeps articles and ordinary grammar, because this is the user's chief of staff, not a parts catalogue. It also carries an explicit licence to say a hard thing plainly, so that "slightly ruthless" survives the compression rather than being flattened into hedged politeness.

**Example voice** (the prompt's own `THIS:` case):
"Recovery is down. HRV averaged 41 ms over the last 7 days, against 48 ms on your 30-day baseline. Cut today's strength volume by 25% and keep the Zone 2 block. Want me to move the rest of the day?"

**Not yet verified on device.** This is a prompt change, so nothing here is proven until the owner reads a real reply on hardware. The two mechanical claims *are* verified by reading the code: `VOICE` reaches the model (`buildCoachSystemPrompt` concatenates it), and the bubble renders plain text.

## 7. System prompt

The real prompt lives in `src/lib/ai/system-prompt.ts` (personality + voice + tool doctrine + safety rails + date/context tail) and is the refined form of the old skeleton. Keep the two in sync; note voice changes in `docs/decisions.md`.

**Cache note.** The whole system string is one cached block (`buildMessagesRequest`, `model-client.ts`) with a single breakpoint at its end; the tool list carries the second. Adding `VOICE` did not move either breakpoint — it invalidates the cache exactly once, on first send after deploy. But the block is billed on **every** turn, so keep prompt edits concrete and short: a "write this, not that" pair earns its tokens, a paragraph of adjectives does not.
The real prompt lives in `src/lib/ai/system-prompt.ts` (personality + tool doctrine + safety rails) and is the refined form of the old skeleton. Since 2026-08-08 it is **two system blocks**: the static block (this file's doctrine — carries the prompt-cache breakpoint; the reminders line is runtime capability truth via `notificationsAvailable()`, so the Coach never denies a delivery channel the binary actually has) and the uncached per-turn "Current state" block from `turn-context.ts` (which owns the date — keeping it out of the static block is what lets the cache survive midnight). Keep the two in sync with this doc; note voice changes in `docs/decisions.md`.

---

## 7b. Cost model — what a turn actually costs, and why

Model tokens are ARC's only recurring cost, so this is a first-class design constraint, not an afterthought. First live testing (2026-08-10) burned **48,312 tokens on three trivial questions (~$0.20)**. The post-mortem is worth keeping, because the cause was not what it looked like.

**The fixed payload.** Every model round-trip re-sends the same prefix:

| Component | Tokens | Cached? |
| --- | ---: | --- |
| Tool schemas (31 tools) | 6,960 | yes |
| Static system prompt | 1,949 | yes |
| Per-turn context block | ~124 | no — deliberately after the breakpoint |

Tools are ~78% of it. That is the price of a Coach that can actually *do* things, and it is paid on every round-trip of every turn — so it must be cached, and the cache must actually hit.

**What went wrong.** Caching was configured correctly (breakpoints on the last tool and the static system block; the prefix was verified stable, with no interpolated date). It was on the **default 5-minute TTL**. Coach use is bursty — ask, read the answer, think, ask again — so nearly every *user-initiated* question arrived cold and re-paid a 1.25× cache **write** on the whole prefix. Three spaced-out questions × (write + read) × $5/MTok on Opus reproduces the observed $0.206 almost exactly.

**The fixes** (`CACHE_TTL` in `src/lib/ai/model-client.ts`):

1. **1-hour cache TTL.** Writes at 2× instead of 1.25×, but survives the gaps. One turn is already 2–3 round-trips, so it breaks even inside the first question and every question for the next hour reads at 0.1×.
2. **Tool-description diet.** 8,206 → 6,960 tokens, by deleting doctrine that the system prompt already states globally (the unit rule, "judgment is yours, not a rule's"), a doc path the model cannot open, and property descriptions restating their own field names. Descriptions fell 4,300 → 3,083; the remaining 3,202 is JSON Schema structure, which can only shrink by removing parameters.
3. **Default model → Sonnet 5** ($2/$10 introductory through 2026-08-31, then $3/$15) rather than Opus 5 ($5/$25). A measure-then-decide default; Opus is one tap away in Settings.

Net: **~$0.069 → ~$0.004 per question** in steady state, ~19×.

**Two traps this leaves behind**, both guarded by tests in `db/coach-eval.test.mjs` §6:

- **Prompt-cache minimums differ by model** — 512 tokens on Opus 5, 1,024 on Sonnet 5, but **4,096 on Haiku 4.5**, which is what the unattended coach pass runs on with the READ tools only. That prefix is ~4,599 tokens: it clears the floor by 12%. Trim read-tool descriptions much further and Haiku's caching stops *silently* — no error, just `cache_creation_input_tokens: 0` and full price forever.
- **Tool schemas creep.** Every new tool is a permanent tax on every request. The budget test fails past 7,600 tokens; trim before adding.

**Round two (same day): killing round-trips, not just bytes.** "How many steps have I taken today?" still cost ~10k tokens. The cause was structural, not prefix size: the state block carried readiness *levels* but not today's actual numbers, and the system prompt ordered a read tool "before answering anything about today". So the model spent an entire extra round-trip on `get_metric_series` — re-sending the whole ~9k prefix — to fetch one integer already on disk.

- **Today's wearable numbers now ride in the state block** (`Today so far: 8,432 steps · 412 kcal active · slept 7h02 · …`). **23 uncached tokens**, and the commonest class of question drops from two round-trips to one. Only metrics with data for today appear, so a quiet morning adds nothing and the model still knows to reach for a tool rather than inferring a zero.
- **The prompt now says to answer from the block when it already holds the answer**, and reserves tools for history, windows, breakdowns, and any day but today. Without this the first change would have achieved nothing — the old rail *required* the wasted call.

**The floor.** One round-trip carries ~9k cached tokens no matter how trivial the question. That is the price of 31 always-available tools. Cached, it bills ~$0.002; the raw *count* still looks alarming in a provider dashboard, which is why `usageCaption` now breaks out `cache write` / `cached` / `in` / `out` separately — a warm re-read and a cold write are a 20× cost difference that a single lump total completely hides. The one remaining lever on raw count is sending fewer tools per request (read-only subset: 2,650 vs 6,960), which trades against the Coach's ability to offer an action unprompted.

**Still unmeasured:** output tokens. Sonnet 5 and Opus 5 both run adaptive thinking by default, billed as output ($10 and $25 per MTok respectively). After the cache fix, output is likely the dominant cost — `usageCaption` records input/cache/output per turn, so the next real session decides whether to touch `effort` or `thinking: {type: "disabled"}` (Opus 5 allows the latter only at effort `high` or lower).

## 8. Verified scenarios (the two required flows)

1. **"How's my training trend?"** → model calls `get_training_summary` / `get_insights` → answers with the real totals, weekly rates, and the window-over-window trend behind them. (Loop + tools covered by `db/model-client.test.mjs` + `db/coach-tools.test.mjs`; the live end-to-end needs an on-device check — paste a key, ask, watch the tool chips.)
2. **"Remind me to take magnesium at 9pm"** → model calls `set_reminder` → confirmation card → Approve → row persists (`created_by: 'ai'`) → surfaces in the Coach screen's Reminders card (and `list_reminders`), survives reload. As a one-off with a time and no date, its **day is pinned right then** — 9pm today if it's still ahead, otherwise tomorrow — and the **confirmation card names that day before you approve** ("· tomorrow (Sat 8 Aug)"), while the result's `date` says which day it landed on so the Coach can repeat it back. It then stays on the in-app due list from that day onward until completed or dismissed (§ below). An OS notification is then attempted, and the result's `notification` field reports what **actually** happened (`scheduled` / `module-unavailable` / `permission-not-granted` / `moment-passed` …) — the Coach relays that verdict rather than promising an alert (§9).

---

## 9. Flags & dependencies (the honest ledger)

**Native deps — ADDED since this section was written** (both `expo-secure-store` and `expo-notifications` are in `package.json` + `app.json` and wired in code):
- `expo-secure-store` ✅ — Keychain key storage, plus the Settings › Coach provider/model/key screen.
- `expo-notifications` ✅ — OS delivery for reminders. `syncReminderNotifications` (`src/lib/notifications/reminders.ts`) schedules from the `reminders` rows at boot and after Coach turns. **Two caveats that are load-bearing, not hedging:** iOS asks permission the first time a timed reminder is scheduled and the user may decline, and a reminder with **no time** surfaces in-app only. ⚠️ **Whether the build carrying this module is installed on the device is still unconfirmed — the last EAS build failed on a provisioning error, so no new binary is known to have landed** (matching caveat in `docs/project-status.md`). **That no longer makes anything overclaim, though:** `set_reminder` reports the *observed* outcome per reminder, so on a binary without the module it degrades to `module-unavailable` — "this build cannot schedule OS notifications … it surfaces in the app only" — instead of a false promise. Also: a one-off given a time and no date has its firing day resolved once at creation (today or tomorrow) and stored, so it fires **exactly once** and then lapses; the trigger never re-derives that day. (The bug this replaced: `reminderTrigger` used to resolve an undated one-off to *today* at its clock time and return null once that moment passed — quiet for the rest of the day, never rolled forward — but each **new day's** first resync re-resolved "today" and scheduled it afresh, so it fired daily forever. Per-new-day, not per-resync.)
- Vision/photo ✅ — lab-PDF parsing and food-photo / free-text meal estimation both run through `runCoachTurn`. **Voice input (mic) is still unbuilt.**

### Reminder due-ness and ordering

**In-app due-ness is a separate rule from notification delivery, deliberately.** `isDueOn` treats a one-off's date as a **"not before" floor**: it is due on that day *and every day after*, until the user completes or dismisses it — so an unfinished nudge keeps appearing in `get_today_snapshot.remindersDueToday`, `list_reminders.dueToday` and `generateDailyBrief` rather than silently vanishing the next morning because a day got pinned to it. An undated (legacy) one-off is due any day; daily is always due; weekly is due on its anchor's weekday. Notifications do **not** follow this floor — `reminderTrigger` still lapses a passed one-off to null on every resync, so nothing here can bring the daily-forever bug back (`db/reminders.test.mjs` §6(i) asserts both halves at once). Consequence: a deliberately back-dated one-off is due in-app the moment it is written.

**Because the floor makes the due set unbounded, it is ranked before anyone truncates it (2026-08-08).** `listActiveReminders` sorts by **clock time only**, so a months-old 06:00 nudge outranked today's genuine daily and weekly reminders unconditionally — and the brief's `slice(0, 3)` duly served three dead nudges instead of the day's plan. One shared function now defines "today's due set" for both consumers:

`dueRemindersFor(db, today)` (`src/lib/ai/insights.ts`) → `{ reminder, daysOverdue }[]`, ordered **items due on their own day first (in their existing clock order), then overdue one-offs, oldest first**, with a source-index tiebreak so nothing depends on `Array.prototype.sort` stability. `daysOverdue` is > 0 **only** for a one-off whose pinned date is strictly before today; recurring reminders and undated one-offs are 0, because with no floor there is no age that can honestly be claimed.

What each consumer does with it:

| Consumer | Behaviour |
| --- | --- |
| `generateDailyBrief` | Splits into "On deck today" vs "Still open", each named-then-counted (§3 › Daily brief) |
| `get_today_snapshot.remindersDueToday` | `{ id, title, time, date, repeat, daysOverdue }`, capped at **10** with a sibling `remindersDueTodayOmitted` count that always ships (0 in the common case). Today-first ranking means the cap drops the stalest tail **first** — not a promise today's own survive, since more than 10 due on their own day trims those too; `remindersDueTodayOmitted` reports it either way. The tool description tells the model that `daysOverdue > 0` is a carried-over obligation it must **not** present as today's plan |
| `list_reminders` | **Unchanged** — every active reminder, unranked and uncapped, with a `dueToday` boolean and no `daysOverdue`. It never truncates, so nothing can hide there |

Neither `isDueOn` nor the notification path changed; only ranking, labelling and projection did. ⚠️ **Not yet ranked:** the Coach screen's Reminders card (`src/components/coach/reminders-card.tsx` ← `useReminders` → `listActiveReminders`) still lists every active reminder in clock order with no overdue label, so an old nudge sits interleaved with today's and gives no hint of its age. Nothing is dropped there — it under-informs rather than misleads — but pointing it at `dueRemindersFor` is the obvious follow-up.

**Integrator-merge points — all resolved:**
- Migrations landed as **0008** (`ai_conversations` / `ai_messages`) and **0009** (`reminders`), *not* 0005/0006 — they were renumbered at integration to stay above Screenings' 0007. **0005 and 0006 are permanently dead gap numbers** and must never be reused: the runner skips any migration numbered below a device's `PRAGMA user_version`, silently.
- Home reads `generateDailyBrief` ✅. Mission-id exposure for `complete_mission_item` is still undecided — that tool remains withheld (§2d).
- Row types remain slice-local per convention (`src/lib/ai/types.ts`, `src/lib/reminders/types.ts`).

**Feature deps — status:** Protocols ✅ (`update_protocol` live) · Modes ✅ (`set_mode` live, 0026) · `experiments` ✅ (0027, four tools live) · sqlite-vec + chunking ✅ (0025; `search_knowledge` written but **deliberately unregistered** — see §2c) — **the on-device embedder model is still missing**, so *semantic* retrieval degrades to an honest "not available yet" and `explain_metric` waits on it. The **corpus is no longer empty and no longer read-only**: the knowledge base shipped 2026-08-12 (0038), so the user writes entries and `search_history` retrieves them by keyword today. Navigation seam ✗ → `navigate_to` still withheld. `propose_today_adjustment` and `generate_grocery_list` are unblocked but unbuilt.
**Feature deps (updated 2026-08-08):** ~~Protocols → `update_protocol`~~, ~~Modes → `set_mode`~~, ~~experiments migration → `create_experiment`~~ — all shipped. Still dependent: mission write access → `adjust_today` (design in coach-intelligence-review.md §4 Phase 2) · protocol-derived targets → target-adherence signals (Phase 5) · knowledge base + on-device embedder → working RAG + `explain_metric` (Phase 6) · navigation seam → `navigate_to`.

**Known approximations (reviewed 2026-07-26, accepted for now):**
- `body_metrics` daily series group by the **UTC** day of `measured_at` while window boundaries are local days — an evening weigh-in near the boundary can land on the adjacent day. Weight thresholds are conservative and the tone is info; the clean fix (store a local `date` alongside, like every other table) is a future migration.
- A thread that ends in a user turn with no reply (app killed mid-stream) reloads without a retry affordance — typing anything re-engages; a "Coach didn't reply · Retry" pill is a small follow-up.
- Duplicate-write protection across a retried turn is the audit trail, not dedup — see §5.4.
- **The phantom-write detector covers whole claims, not partial ones (2026-08-14).** `claimsCompletedWrite` runs only when a turn landed **zero** writes, which is what makes it safe to caption a turn "Nothing saved" — a turn that really wrote is never examined and so can never be mislabelled. The cost of that safety is the mixed case: a turn that genuinely saves the recipe **and** also claims it added the ingredients to the grocery list shows one receipt and no warning. Closing it means reconciling each claim against each tool call, which is a much less certain judgment than "nothing ran at all"; the receipt is the honest partial answer today, since the grocery line simply is not on it.
- **The tool chips cannot tell two reminder tools apart.** `humanizeToolName` strips a leading `get|list|log|set|complete|dismiss`, so `set_reminder` and `complete_reminder` both render as **"reminder"**, and the verb-stripping is inconsistent besides (`save_recipe` keeps its verb and reads "save recipe"). Cosmetic while the chips are only a transparency trail, but that same string is the receipt fallback for rows written before receipts existed.

**Product decisions for Matt:** every `⚑ MATT` above — ruthlessness rope (§2d), thresholds/targets ownership (§3), accountability cadence (§3), memory visibility (§4), read-gating/write-graduation (§5). Plus: default model choice (currently `claude-opus-5`) and whether per-turn token spend should be surfaced in the UI.

---

## 10. Implementation phases (updated)

**v1 — SHIPPED:** agentic chat over real data · 9 read + 10 write tools · confirmation gate · deterministic insights + brief · reminders (data + in-app) · persistence · session key affordance · honest mock fallback.
**v1 — SHIPPED:** agentic chat over real data · **13 read + 13 write tools** (2026-08-08 count) · confirmation gate · deterministic insights + brief · reminders (data + in-app + OS scheduling layer) · persistence · Keychain key + model picker · honest mock fallback · per-turn "Current state" context block.

**v1.5 — SHIPPED:** Keychain key + provider/model Settings screen ✅ · OS notification delivery ✅ · Home brief wiring ✅ · prompt-cached system+tool prefix ✅. *Conversation history UX (browsing past threads) is still unbuilt — a reload resumes the current thread, but there is no thread list.*

**v2 — SHIPPED:** protocol tools + versioning ✅ · modes tool ✅ · model-voiced brief ✗ (the brief is still the deterministic skeleton) · Coach notes memory ~ (`memory_chunks` + `ingestMemory` exist at 0025, gated on the embedder) · evening accountability ✗.

**v3 — PARTLY SHIPPED:** experiment engine ✅ (0027) · photo meal logging ✅ · **writable knowledge base ✅ (0038** — browse, author, article import, `save_knowledge_entry`) · RAG ~ (schema, chunker, retrieval and `search_knowledge` all *written* at 0025, the tool held back until **the embedder model**, which is the missing piece) · predictive alerts ✗ · correlations at scale ✗ · voice-first ✗ · navigation ✗.

**Current tool total: 24 registered (11 read + 13 write)**, plus 2 written-but-withheld (§2d).
