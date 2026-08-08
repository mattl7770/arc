# ARC AI Coach — Capability Specification

**Status:** v1 spec shipped; Coach live-wired — persistent key (iOS Keychain), model picker, prompt caching, and protocol write-back (2026-07-27)
**Last updated:** 2026-07-27

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

> **The registry today: 24 tools — 11 read + 13 write.** `COACH_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS]` (`src/lib/ai/tools/index.ts`) is the single source of truth; this doc is the spec. §2a and §2b below list the original slice (9 read + 10 write); the five added since are in **§2c**, and the two deliberately withheld are in **§2d**.

### 2a. Shipped — read (execute immediately)

| Tool | Input | Reads | Returns |
| --- | --- | --- | --- |
| `get_today_snapshot` | — | mission (`log_entries`), `meals`, `workouts`, `symptoms`, ad-hoc captures, the day's mode, reminders due today | Today's full picture in one call. `remindersDueToday` is **ranked today-first** and each item carries its pinned `date` + `daysOverdue`; capped at 10 with a sibling `remindersDueTodayOmitted` count — see "Reminder due-ness and ordering" below |
| `get_metric_series` | `metric: weight\|body_fat\|waist\|hrv\|rhr\|water`, `days?≤365` | `body_metrics` / `wearable_data` daily series | Daily points + min/avg/max in display units |
| `get_training_summary` | `days?` (28) | `workouts` (+ recent sessions) | Totals, weekly rates, per-day load |
| `get_nutrition_summary` | `days?` (14) | `meals` | Per-day kcal/macros + averages across logged days |
| `get_symptom_history` | `days?` (30) | `symptoms` | Occurrences + counts by name w/ avg severity |
| `get_biomarkers` | `category?`, `biomarker?` | `biomarkers` ⋈ latest `lab_results` | Latest value per marker + optimal/standard ranges; explicit "no labs imported" when empty |
| `get_protocols` | — | `protocols` ⋈ live `protocol_versions` | Each stack/routine/block with its live version number + current items (title, time, dose) |
| `list_reminders` | — | `reminders` | Active reminders + due-today flags |
| `get_insights` | — | insights engine | Precomputed trends/gaps/correlations + the brief line |

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
| `update_protocol` | `protocol_slug`, `items[]` (the COMPLETE new list), `change_notes` | `addVersion(…, 'ai')` — writes a NEW immutable version, never edits the live one | "Update "Evening Stack": 3 items (was 2) — added magnesium" |

A Coach-logged row is indistinguishable from a hand-logged one downstream — the tools call the same repositories the capture screens use. Three contract rules, enforced in code and covered by tests: **units convert in code, never in the model** (values arrive as the user said them — lb, oz — and the registry/exercise helpers canonicalize); **backdating is explicit** (every log tool takes an optional real-calendar `date`; the confirmation line shows a backdate, and the system prompt instructs the model to pass one for "yesterday…" reports); **the confirmation line carries everything consequential** — macros, sets, dates, and the resolved *name* behind any id (the user never approves a bare identifier).

That last rule covers a day the tool **derives** as well as one the user passes. `set_reminder` pins the day of a bare-time one-off as it saves, so `CoachTool.confirmSummary` takes a **third argument — the same `CoachToolContext` (`{ now }`) instance `execute` gets** — and resolves the day through the very function `createReminder` uses. The card therefore reads "… at 09:00 · tomorrow (Sat 8 Aug)" instead of a bare "at 09:00" that quietly writes tomorrow's row. Day names are spelled out by hand because **Hermes has no `Intl`**, and the ISO day is split componentwise, never `new Date('YYYY-MM-DD')`.

**One clock per tool call — the contract, and why the argument is required.** The service layer (`src/lib/ai/coach-service.ts`) reads the turn's clock **exactly once per tool call**, above the confirmation gate, and hands that one `CoachToolContext` to both halves: `confirmSummary(input, db, context)` and, after the user approves, `execute(db, input, context)`. That is the whole point — the card the user approved and the row that lands must be computed from the same instant. When the argument was first added it was **optional**, and the only real call site quietly kept passing `(input, db)` while `execute` minted a fresh `new Date()` of its own; a card rendered at 08:59:30 for "at 09:00" then wrote a row dated *tomorrow* if approval arrived at 09:00:10. **Fixed 2026-08-08 by making the argument required**, so rendering a card without the turn clock is a type error. The freeze is scoped to **one tool call, not the whole turn** — a turn spans streaming, arbitrary approval latency and up to 8 model round-trips, so a turn-wide freeze would date a later `log_meal` to the wrong day across midnight. A summary that doesn't need a clock simply omits the parameter. Pinned by `db/coach-tools.test.mjs` §16, which drives the real `streamCoachReply` call site rather than the tool in isolation.

**Protocol edits are versioned, not patched.** `update_protocol` never mutates the live version: the model reads the current items with `get_protocols`, submits the COMPLETE new item list (kept items + the change), and the tool writes a new immutable `protocol_versions` row via `addVersion(…, 'ai')`, bumping `current_version_id`. The confirmation line shows the item-count delta (`3 items (was 2)`) so a destructive replace can't be approved as an innocent add; the old version is preserved. This is the concrete form of "add magnesium to my evening stack → the stack actually updates."

### 2c. Shipped since — modes, experiments, knowledge (registered)

Earlier revisions of this doc listed `set_mode` and `create_experiment` as unregistered stubs and `search_knowledge` as "not yet designed". **All five tools below are registered**, counted in the 24 above.

| Tool | Kind | Notes |
| --- | --- | --- |
| `set_mode` | write | Sets today's mode (Normal/Travel/Sick/Deload/Social/Custom) so plan, priorities, tone and adherence adapt. Shipped with `day_modes` (**0026**); mid-day changes re-derive the mission as a diff that preserves completed work. The active mode also appears in `get_today_snapshot`. |
| `create_experiment` | write | n-of-1: hypothesis, intervention, watched metrics, duration, success criteria. Shipped with `experiments` (**0027**). Rejects empty metrics and durations under 3 days. |
| `complete_experiment` | write | Concludes a running experiment with a verdict. Refuses an unknown id, and refuses to re-conclude one that already has a verdict. |
| `get_experiments` | read | Running (ready-to-read-out first), concluded, abandoned. |
| `search_knowledge` | read | RAG over the curated longevity corpus via `sqlite-vec`. Registered and wired (**0025**); it degrades to an honest "not available yet" until the on-device embedder model lands — see §9. |

**Why the Coach owns experiments.** The browse screens (`app/experiments.tsx`, `app/experiment-detail.tsx`) are deliberately **read-only with zero pine**: the Coach designs and concludes experiments because it reads the watched metrics first. A "Conclude" button on a screen with no numbers behind it would invite a verdict with no evidence.

### 2d. Still stubbed — interface defined, NOT registered (`src/lib/ai/tools/stubs.ts`)

Withheld from the model on purpose: a tool that always fails teaches the model not to call it. `STUB_TOOLS` contains exactly two entries, and `db/coach-tools.test.mjs` asserts neither ever appears in the registry.

| Tool | Blocked on | Notes |
| --- | --- | --- |
| `complete_mission_item` | **Mission ids must be surfaced to the Coach** — the snapshot exposes titles/status read-only today | Would let the Coach tick off work you tell it you did. |
| `navigate_to` | **A navigation seam** — tools execute headless; navigation is a UI side effect the service must broker (an event the screen subscribes to) | "Pull up my labs" ends on the Labs screen, not in prose. |

### 2e. Planned — not yet designed in code

- `explain_metric` — curated explainer per metric/biomarker; becomes real once the knowledge corpus is populated.
- `propose_today_adjustment` — restructure today's mission (needs mission write access; the highest-leverage write of all). `⚑ MATT`: this is where "slightly ruthless" becomes real — how much rope does the Coach get to rearrange a day unprompted?
- `generate_grocery_list` — meal templates now exist (0018), so this is unblocked and simply unbuilt.
- `log_labs` — manual lab-result entry by voice/chat. The Function PDF pipeline has since shipped and defines the import path; the dedupe rules for a *chat-entered* result are what remain.

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

`generateDailyBrief(db, now)` composes top insights + reminders due today into 1–3 sentences with no model call, so the brief is real even offline. Surfaced on the Coach screen's brief card **and on Home** — the integrator step is **done**: Home reads `generateDailyBrief` through `useDailyBrief`, and `src/lib/home/mock-day.ts` has since been deleted outright. Later: the model rewrites the deterministic skeleton in voice (one cheap call on app open) — the numbers stay the engine's.

**Reminders in the brief are split, not merged (2026-08-08).** Home is sacred (CLAUDE.md §5) and answers "what should I do right now", so a carried-over nudge may never be printed as if it were today's plan:

- **`On deck today: Take magnesium (21:00) · Stretch (07:00).`** — only items genuinely due on their own day (every recurring reminder, a one-off pinned to today, and an undated legacy one-off). First **3** named; anything beyond is counted, not dropped — ", and 3 more".
- **`Still open: Book bloodwork (09:00) — 4 mo overdue.`** — one-offs whose pinned day has passed and which the user has neither completed nor dismissed. First **2** named, oldest nag first, remainder counted the same way.

Both lines are drawn from `dueRemindersFor(db, today)` (`src/lib/ai/insights.ts`), the shared ranked set described under "Reminder due-ness and ordering" in §9. Ages are hand-rolled (`1 day` / `12 days` / `4 wk` / `4 mo` / `2 yr`) on the same thresholds as the Screenings ledger — **Hermes has no `Intl`**. Covered by `db/insights.test.mjs` §§12–15.

### Planned proactive surfaces (sequenced)

1. **Turn-level proactivity (shipped):** the system prompt instructs the model to voice notable insights it reads mid-conversation, unprompted.
2. **Self-initiated reminders (shipped):** the Coach can propose a nudge for a logging gap ("want a daily nudge?") → `set_reminder`, still user-confirmed.
3. **Evening accountability** — an end-of-day check-in comparing plan vs. actuals. Needs: a scheduled trigger (OS notification or app-open-in-evening heuristic). `⚑ MATT`: how nagging may the Coach be? (opt-in cadence, quiet hours)
4. **Predictive alerts** — "3 poor sleeps + rising RHR: historically your next 2 days trend sick; consider Deload." Needs: more history + Modes.
5. **Mid-day corrections** — needs Modes + mission write access.

---

## 4. Memory

**Shipped now:**
- **Conversation persistence** — `ai_conversations` / `ai_messages` (0008). Append-only turns; every assistant turn stores its full tool-call record (`tool_calls` JSON), so a transcript is auditable: what the Coach said traces to what it actually read. Reload resumes the latest thread.
- **Bounded context** — the last 30 turns go to the model; the data itself is *not* stuffed into context — the model re-reads through tools, which is both fresher and cheaper.

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

The real prompt lives in `src/lib/ai/system-prompt.ts` (personality + tool doctrine + safety rails + date/context tail) and is the refined form of the old skeleton. Keep the two in sync; note voice changes in `docs/decisions.md`.

---

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

**Feature deps — status:** Protocols ✅ (`update_protocol` live) · Modes ✅ (`set_mode` live, 0026) · `experiments` ✅ (0027, three tools live) · sqlite-vec + chunking ✅ (0025; `search_knowledge` registered) — **but the on-device embedder model is still missing**, so knowledge retrieval degrades to an honest "not available yet"; `explain_metric` and a populated corpus wait on it. Navigation seam ✗ → `navigate_to` still withheld. `propose_today_adjustment` and `generate_grocery_list` are unblocked but unbuilt.

**Known approximations (reviewed 2026-07-26, accepted for now):**
- `body_metrics` daily series group by the **UTC** day of `measured_at` while window boundaries are local days — an evening weigh-in near the boundary can land on the adjacent day. Weight thresholds are conservative and the tone is info; the clean fix (store a local `date` alongside, like every other table) is a future migration.
- A thread that ends in a user turn with no reply (app killed mid-stream) reloads without a retry affordance — typing anything re-engages; a "Coach didn't reply · Retry" pill is a small follow-up.
- Duplicate-write protection across a retried turn is the audit trail, not dedup — see §5.4.

**Product decisions for Matt:** every `⚑ MATT` above — ruthlessness rope (§2d), thresholds/targets ownership (§3), accountability cadence (§3), memory visibility (§4), read-gating/write-graduation (§5). Plus: default model choice (currently `claude-opus-5`) and whether per-turn token spend should be surfaced in the UI.

---

## 10. Implementation phases (updated)

**v1 — SHIPPED:** agentic chat over real data · 9 read + 10 write tools · confirmation gate · deterministic insights + brief · reminders (data + in-app) · persistence · session key affordance · honest mock fallback.

**v1.5 — SHIPPED:** Keychain key + provider/model Settings screen ✅ · OS notification delivery ✅ · Home brief wiring ✅ · prompt-cached system+tool prefix ✅. *Conversation history UX (browsing past threads) is still unbuilt — a reload resumes the current thread, but there is no thread list.*

**v2 — SHIPPED:** protocol tools + versioning ✅ · modes tool ✅ · model-voiced brief ✗ (the brief is still the deterministic skeleton) · Coach notes memory ~ (`memory_chunks` + `ingestMemory` exist at 0025, gated on the embedder) · evening accountability ✗.

**v3 — PARTLY SHIPPED:** experiment engine ✅ (0027) · photo meal logging ✅ · RAG ~ (schema, chunker, retrieval and `search_knowledge` all shipped at 0025; **the embedder model is the missing piece**) · predictive alerts ✗ · correlations at scale ✗ · voice-first ✗ · navigation ✗.

**Current tool total: 24 registered (11 read + 13 write)**, plus 2 written-but-withheld (§2d).
