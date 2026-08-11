# ARC AI Coach — Capability Specification

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
| System prompt | `src/lib/ai/system-prompt.ts` | §6 voice + tool doctrine + safety rails (the refined form of §7 below). |
| UI | `app/(tabs)/coach.tsx` + `src/components/coach/*` | Thread, brief, reminders list, write-confirmation card, session-key panel. Key + model managed in `app/settings-coach.tsx`. |

**Key handling:** the key is the app's one secret. It's stored in the **iOS Keychain** via `expo-secure-store` (`src/lib/ai/api-key-store.ts`) — never in SQLite, the JS bundle, logs, or the system prompt — with an in-memory mirror hydrated at boot (`app/_layout.tsx`) so the hot read path stays synchronous. Managed in **Settings › Coach** (paste / replace / clear + model pick) and quick-connectable from the Coach screen. `expo-secure-store` is a native dep: until the next EAS dev build ships it, the store degrades to memory-only (session-lived) and the UI says so plainly. The key rides only the `x-api-key` header on the direct call to Anthropic — the user pastes their own key; ARC never sees it server-side (there is no server).

---

## 2. Tool set

Every tool the model can call. **Read tools run freely; every write suspends the loop until the user approves it in the UI** (see §5). Inputs are validated at the tool layer — bad input becomes an `is_error` tool result the model can correct, and never reaches a repository.

### 2a. Shipped — read (execute immediately)

| Tool | Input | Reads | Returns |
| --- | --- | --- | --- |
| `get_today_snapshot` | — | **readiness (`deriveReadiness` — the same verdict Home shows)**, the day's **mode**, mission (`log_entries`, **with item ids**), `meals`, `workouts`, `symptoms`, ad-hoc captures (in the user's units), reminders due today, **running experiments**, **profile (age/sex)** | Today's full picture in one call |
| `get_metric_series` | `metric: weight\|body_fat\|waist\|hrv\|rhr\|water\|sleep\|sleep_deep\|steps\|active_energy`, `days?≤365` | `body_metrics` / `wearable_data` daily series, windows closed at today | Daily points + min/avg/max (display units; sleep/steps/energy in fixed min/steps/kcal) |
| `get_training_summary` | `days?` (28) | `workouts` (+ recent sessions) | Totals, weekly rates, per-day load, `thisWeek` calendar block |
| `get_training_recommendation` | — | the whole training engine (`buildRecommendation`) | Today's session recommendation + per-exercise progression targets, muscle freshness ledger, program week/deload state, weekly volume vs MEV/MAV/MRV. **Reports state; the tool description tells the model the training decision is its own to make with the user** |
| `get_nutrition_summary` | `days?` (14) | `meals` | Per-day kcal/macros + averages across logged days |
| `get_symptom_history` | `days?` (30) | `symptoms` | Occurrences + counts by name w/ avg severity |
| `get_biomarkers` | `category?`, `biomarker?` | `biomarkers` ⋈ latest `lab_results` | Latest value per marker + optimal/standard ranges; explicit "no labs imported" when empty |
| `get_biomarker_history` | `biomarker` (slug or name) | all `lab_results` for one marker | The full series oldest-first + ranges; exact-match-first resolution that returns candidates on ambiguity instead of guessing |
| `get_protocols` | — | `protocols` ⋈ live `protocol_versions` | Each stack/routine/block with its live version number + current items (title, time, dose) |
| `list_reminders` | — | `reminders` | Active reminders + due-today flags |
| `get_insights` | — | insights engine | Precomputed trends/gaps/correlations + the brief line |
| `get_experiments` | `include_completed?` | `experiments` | Active experiments w/ daysLeft + ready flags; recent verdicts on request |
| `search_knowledge` | `query`, `scope?` | RAG layer (0025) | Honest "not available yet" until the on-device embedder ships |

**Every turn also opens with a "Current state" system block** (`src/lib/ai/turn-context.ts`, 2026-08-08): date+weekday, profile+units, mode, readiness verdict+pillars, mission progress, running/ready experiments, and the deterministic brief — sent as a second uncached system block after the prompt-cache breakpoint. The model starts oriented and spends tool calls on depth, not on discovering what Home already shows.

### 2b. Shipped — write (confirmation-gated)

| Tool | Input | Writes via | Confirmation line |
| --- | --- | --- | --- |
| `log_metric` | `metric`, `value`, `unit?`, `date?` | `logMetric` (registry-converted to canonical) | "Log weight 178 lb" |
| `log_meal` | `name`, `time?`, macros?, `notes?`, `date?` | `logMeal` | "Log meal "Salmon bowl" · 700 kcal, 45 g protein" |
| `log_workout` | `name`, `kind`, `duration_min?`, `sets?` (weight in lb unless `unit:"kg"`), `date?` | `logWorkout` (transactional with sets) | "Log workout "Upper A" · 55 min · Bench 8 × 225 lb" |
| `log_symptom` | `name`, `severity?`, `body_area?`, `time?`, `notes?`, `date?` | `logSymptom` | "Log symptom "Headache" · 4/10" |
| `log_capture` | `type: supplement\|medication\|therapy`, `title`, `date?` | `logCapture` | "Log supplement: Creatine · 5 g" |
| `log_note` | `text`, `date?` | `logNote` | "Save note: …" |
| `set_reminder` | `title`, `time?`, `date?`, `repeat: once\|daily\|weekly`, `notes?` | `createReminder` (`created_by: 'ai'`) | "Set reminder "Take magnesium" at 21:00 · daily" |
| `complete_reminder` | `id` (one-offs only — refuses recurring) | `completeReminder` | "Mark reminder "Book DEXA" done" |
| `dismiss_reminder` | `id` | `dismissReminder` | "Dismiss reminder "Take magnesium"" |
| `update_protocol` | `protocol_slug`, `items[]` (the COMPLETE new list), `change_notes` | `addVersion(…, 'ai')` — writes a NEW immutable version, never edits the live one | "Update "Evening Stack": 3 items (was 2) — added magnesium" |
| `set_mode` | `mode`, `until?`, `note?` | `setMode` + `rederiveMissionForDay` (today reshapes immediately, work preserved) | "Set Sick mode for today" |
| `create_experiment` | `name`, `hypothesis`, `intervention`, `metrics[]`, `duration_days`, `success_criteria?` | `createExperiment` (starts today, computed end date) | "Start experiment "Magnesium PM" — 14 days" |
| `complete_experiment` | `id`, `conclusion`, `outcome_notes?` | `completeExperiment` (active-only guard) | "Conclude experiment "Magnesium PM"" |

Log tools reject a **future** `date` (`optPastDate`, 2026-08-08) — a mis-parsed "next Tuesday" used to silently poison every trend window. `log_workout` sets now resolve their catalog **`exercise_id`** by unique exact name/alias match (never fuzzy), so Coach-logged training feeds e1RM/freshness/volume instead of being invisible to the engine; unmatched names are reported back in the tool result.

A Coach-logged row is indistinguishable from a hand-logged one downstream — the tools call the same repositories the capture screens use. Three contract rules, enforced in code and covered by tests: **units convert in code, never in the model** (values arrive as the user said them — lb, oz — and the registry/exercise helpers canonicalize); **backdating is explicit** (every log tool takes an optional real-calendar `date`; the confirmation line shows a backdate, and the system prompt instructs the model to pass one for "yesterday…" reports); **the confirmation line carries everything consequential** — macros, sets, dates, and the resolved *name* behind any id (the user never approves a bare identifier).

**Protocol edits are versioned, not patched.** `update_protocol` never mutates the live version: the model reads the current items with `get_protocols`, submits the COMPLETE new item list (kept items + the change), and the tool writes a new immutable `protocol_versions` row via `addVersion(…, 'ai')`, bumping `current_version_id`. The confirmation line shows the item-count delta (`3 items (was 2)`) so a destructive replace can't be approved as an innocent add; the old version is preserved. This is the concrete form of "add magnesium to my evening stack → the stack actually updates."

### 2c. Stubbed — interface defined, NOT registered (`src/lib/ai/tools/stubs.ts`)

Withheld from the model on purpose: a tool that always fails teaches the model not to call it. Each ships when its dependency lands. *(2026-08-08: `create_experiment` and `set_mode` graduated to registered writes — see 2b; the coach-assist wrapper stub was deleted outright.)*

| Tool | Blocked on | Notes |
| --- | --- | --- |
| `complete_mission_item` | Superseded by **`adjust_today`** (coach-intelligence-review.md §4 Phase 2) — snapshot now exposes mission ids, so the batch mission-write tool absorbs this | Snapshot exposes ids + titles/status read-only today. |
| `navigate_to` | **A navigation seam** — tools execute headless; navigation is a UI side effect the service must broker (an event the screen subscribes to; the listener-set idiom already ships 3× in-repo) | "Pull up my labs" ends on the Labs screen, not in prose. |

### 2d. Planned — not yet designed in code

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

---

## 6. Personality & tone (unchanged, now enforced in the prompt)

- Calm, precise, evidence-seeking, honest about uncertainty
- Slightly ruthless about prioritization ("this is low leverage — skip it")
- Deeply familiar; direct but respectful; never hypey
- Quantified over vague: "HRV is down 14% vs your 30-day baseline"
- Phone-screen concise; leads with the answer

**Example voice:**
"Recovery is meaningfully down (HRV -14% vs your 30-day baseline). I'm dropping today's strength volume 25% and moving the Zone 2 block to tomorrow. Highest leverage move right now is the 12-minute walk and morning light. Want me to adjust the rest of the day?"

## 7. System prompt

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
2. **"Remind me to take magnesium at 9pm"** → model calls `set_reminder` → confirmation card → Approve → row persists (`created_by: 'ai'`) → surfaces in the Coach screen's Reminders card (and `list_reminders`), survives reload. OS push delivery is flagged (below), not wired.

---

## 9. Flags & dependencies (the honest ledger)

**Native deps (EAS rebuild — NOT added in this slice):**
- `expo-secure-store` — Keychain key storage (+ the Settings provider/model/key screen)
- `expo-notifications` — OS delivery for reminders (schedule from the existing `reminders` rows)
- Voice input (mic) and vision/photo meal logging — Phase 3+

**Integrator-merge points:**
- `src/lib/db/migrations.generated.ts` (regenerated for 0005+0006)
- `package.json` `db:test` line (5 new suites appended)
- Row types kept slice-local per convention (`src/lib/ai/types.ts`, `src/lib/reminders/types.ts`) — fold into `src/lib/db/types.ts` if preferred
- Home: wire `generateDailyBrief` into the brief card; decide mission-id exposure for `complete_mission_item`

**Feature deps (updated 2026-08-08):** ~~Protocols → `update_protocol`~~, ~~Modes → `set_mode`~~, ~~experiments migration → `create_experiment`~~ — all shipped. Still dependent: mission write access → `adjust_today` (design in coach-intelligence-review.md §4 Phase 2) · protocol-derived targets → target-adherence signals (Phase 5) · knowledge base + on-device embedder → working RAG + `explain_metric` (Phase 6) · navigation seam → `navigate_to`.

**Known approximations (reviewed 2026-07-26, accepted for now):**
- `body_metrics` daily series group by the **UTC** day of `measured_at` while window boundaries are local days — an evening weigh-in near the boundary can land on the adjacent day. Weight thresholds are conservative and the tone is info; the clean fix (store a local `date` alongside, like every other table) is a future migration.
- A thread that ends in a user turn with no reply (app killed mid-stream) reloads without a retry affordance — typing anything re-engages; a "Coach didn't reply · Retry" pill is a small follow-up.
- Duplicate-write protection across a retried turn is the audit trail, not dedup — see §5.4.

**Product decisions for Matt:** every `⚑ MATT` above — ruthlessness rope (§2d), thresholds/targets ownership (§3), accountability cadence (§3), memory visibility (§4), read-gating/write-graduation (§5). Plus: default model choice (currently `claude-opus-5`) and whether per-turn token spend should be surfaced in the UI.

---

## 10. Implementation phases (updated)

**v1 — SHIPPED:** agentic chat over real data · **13 read + 13 write tools** (2026-08-08 count) · confirmation gate · deterministic insights + brief · reminders (data + in-app + OS scheduling layer) · persistence · Keychain key + model picker · honest mock fallback · per-turn "Current state" context block.

**v1.5 — integrator + Settings:** Keychain key + provider/model Settings screen · OS notification delivery · Home brief wiring · conversation history UX.

**v2:** Coach notes memory · protocols tools + versioning · modes tool · evening accountability · model-voiced brief.

**v3:** experiment engine · RAG (sqlite-vec) · predictive alerts · correlations at scale · voice-first, photo meal logging · navigation.
