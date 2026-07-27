# ARC AI Coach — Capability Specification

**Status:** v1 spec + first vertical slice SHIPPED (2026-07-26)
**Last updated:** 2026-07-26

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

Everything runs on-device except the model call itself (local-first, offline-except-AI — the 2026-07-24 ADR). The model is the latest Claude (`claude-opus-5` today), called directly from the app over streaming `expo/fetch`; provider/model become Settings-editable later.

**Architecture (shipped 2026-07-26):**

| Layer | File | Role |
| --- | --- | --- |
| Model client + agentic loop | `src/lib/ai/model-client.ts` | Streaming Messages API call, SSE parsing, tool-use loop. Pure; fetch-injected; unit-tested with a mocked wire (`db/model-client.test.mjs`). |
| Tool registry | `src/lib/ai/tools/` | Typed `{name, description, inputSchema, readOnly, execute(db, input, ctx)}` per tool, each wrapping a repository. Headless-tested against real SQLite (`db/coach-tools.test.mjs`). |
| Insights engine | `src/lib/ai/insights.ts` | Deterministic trends/gaps/correlations + the daily brief. No model involved (`db/insights.test.mjs`). |
| Service seam | `src/lib/ai/coach-service.ts` | The ONE model-call site. Real agentic path when a key is set; honest mock otherwise. Owns the write-confirmation gate. |
| Persistence | `db/migrations/0005_ai_chat.sql` + `src/lib/db/repositories/ai-chat.ts` | Conversations + append-only messages with the per-turn tool-call record. |
| Reminders | `db/migrations/0006_reminders.sql` + `src/lib/db/repositories/reminders.ts` | The nudge store + in-app surfacing. |
| System prompt | `src/lib/ai/system-prompt.ts` | §6 voice + tool doctrine + safety rails (the refined form of §7 below). |
| UI | `app/(tabs)/coach.tsx` + `src/components/coach/*` | Thread, brief, reminders list, write-confirmation card, session key panel. |

**Key handling (temporary, deliberate):** the key is pasted per session into a clearly-labelled panel and lives in process memory only (`src/lib/ai/session-key-store.ts`) — never persisted, gone on restart. The durable home is the iOS Keychain via `expo-secure-store` → **native dep → EAS rebuild → flagged, Settings phase**.

---

## 2. Tool set

Every tool the model can call. **Read tools run freely; every write suspends the loop until the user approves it in the UI** (see §5). Inputs are validated at the tool layer — bad input becomes an `is_error` tool result the model can correct, and never reaches a repository.

### 2a. Shipped — read (execute immediately)

| Tool | Input | Reads | Returns |
| --- | --- | --- | --- |
| `get_today_snapshot` | — | mission (`log_entries`), `meals`, `workouts`, `symptoms`, ad-hoc captures, reminders due today | Today's full picture in one call |
| `get_metric_series` | `metric: weight\|body_fat\|waist\|hrv\|rhr\|water`, `days?≤365` | `body_metrics` / `wearable_data` daily series | Daily points + min/avg/max in display units |
| `get_training_summary` | `days?` (28) | `workouts` (+ recent sessions) | Totals, weekly rates, per-day load |
| `get_nutrition_summary` | `days?` (14) | `meals` | Per-day kcal/macros + averages across logged days |
| `get_symptom_history` | `days?` (30) | `symptoms` | Occurrences + counts by name w/ avg severity |
| `get_biomarkers` | `category?`, `biomarker?` | `biomarkers` ⋈ latest `lab_results` | Latest value per marker + optimal/standard ranges; explicit "no labs imported" when empty |
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
| `set_reminder` | `title`, `time?`, `date?`, `repeat: once\|daily\|weekly`, `notes?` | `createReminder` (`created_by: 'ai'`) | "Set reminder "Take magnesium" at 21:00 · daily" |
| `complete_reminder` | `id` (one-offs only — refuses recurring) | `completeReminder` | "Mark reminder "Book DEXA" done" |
| `dismiss_reminder` | `id` | `dismissReminder` | "Dismiss reminder "Take magnesium"" |

A Coach-logged row is indistinguishable from a hand-logged one downstream — the tools call the same repositories the capture screens use. Three contract rules, enforced in code and covered by tests: **units convert in code, never in the model** (values arrive as the user said them — lb, oz — and the registry/exercise helpers canonicalize); **backdating is explicit** (every log tool takes an optional real-calendar `date`; the confirmation line shows a backdate, and the system prompt instructs the model to pass one for "yesterday…" reports); **the confirmation line carries everything consequential** — macros, sets, dates, and the resolved *name* behind any id (the user never approves a bare identifier).

### 2c. Stubbed — interface defined, NOT registered (`src/lib/ai/tools/stubs.ts`)

Withheld from the model on purpose: a tool that always fails teaches the model not to call it. Each ships when its dependency lands.

| Tool | Blocked on | Notes |
| --- | --- | --- |
| `update_protocol` | **Protocols feature** (Data tab editor + protocol→mission generator) | Proposes a new immutable version with change notes; `created_by: 'ai'`. The schema (0001) is ready. |
| `create_experiment` | **`experiments` table** (Coach Phase 2 migration) | n-of-1: hypothesis, intervention, metrics, duration, success criteria. |
| `set_mode` | **Modes** (docs/information-architecture.md) | Sets today's mode so plan/priorities/tone/adherence adapt. |
| `complete_mission_item` | **Home integration decision** — mission ids must be surfaced to the Coach; Home is integrator-owned | Snapshot already exposes titles/status read-only. |
| `navigate_to` | **A navigation seam** — tools execute headless; navigation is a UI side effect the service must broker (an event the screen subscribes to) | "Pull up my labs" ends on the Labs screen, not in prose. |

### 2d. Planned — not yet designed in code

- `explain_metric` — curated explainer per metric/biomarker; becomes real with the knowledge base (RAG corpus).
- `propose_today_adjustment` — restructure today's mission (needs Protocols + mission write access; the highest-leverage write of all). `⚑ MATT`: this is where "slightly ruthless" becomes real — how much rope does the Coach get to rearrange a day unprompted?
- `generate_grocery_list` — needs meal templates (Protocols).
- `search_knowledge` — RAG over the curated longevity corpus via sqlite-vec (deliberately out of this slice).
- `log_labs` — manual lab-result entry by voice/chat; deferred until the Function PDF pipeline defines the dedupe rules.

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

`generateDailyBrief(db, now)` composes top insights + reminders due today into 1–3 sentences with no model call, so the brief is real even offline. Surfaced today on the Coach screen's brief card. **Integrator step (flagged, not done): replace Home's `mockDay.brief` with this.** Later: the model rewrites the deterministic skeleton in voice (one cheap call on app open) — the numbers stay the engine's.

### Planned proactive surfaces (sequenced)

1. **Turn-level proactivity (shipped):** the system prompt instructs the model to voice notable insights it reads mid-conversation, unprompted.
2. **Self-initiated reminders (shipped):** the Coach can propose a nudge for a logging gap ("want a daily nudge?") → `set_reminder`, still user-confirmed.
3. **Evening accountability** — an end-of-day check-in comparing plan vs. actuals. Needs: a scheduled trigger (OS notification or app-open-in-evening heuristic). `⚑ MATT`: how nagging may the Coach be? (opt-in cadence, quiet hours)
4. **Predictive alerts** — "3 poor sleeps + rising RHR: historically your next 2 days trend sick; consider Deload." Needs: more history + Modes.
5. **Mid-day corrections** — needs Modes + mission write access.

---

## 4. Memory

**Shipped now:**
- **Conversation persistence** — `ai_conversations` / `ai_messages` (0005). Append-only turns; every assistant turn stores its full tool-call record (`tool_calls` JSON), so a transcript is auditable: what the Coach said traces to what it actually read. Reload resumes the latest thread.
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

**Feature deps:** Protocols → `update_protocol` / `propose_today_adjustment` / grocery lists / real targets · Modes → `set_mode` · `experiments` migration → `create_experiment` · knowledge base + sqlite-vec → RAG + `explain_metric` · navigation seam → `navigate_to`.

**Known approximations (reviewed 2026-07-26, accepted for now):**
- `body_metrics` daily series group by the **UTC** day of `measured_at` while window boundaries are local days — an evening weigh-in near the boundary can land on the adjacent day. Weight thresholds are conservative and the tone is info; the clean fix (store a local `date` alongside, like every other table) is a future migration.
- A thread that ends in a user turn with no reply (app killed mid-stream) reloads without a retry affordance — typing anything re-engages; a "Coach didn't reply · Retry" pill is a small follow-up.
- Duplicate-write protection across a retried turn is the audit trail, not dedup — see §5.4.

**Product decisions for Matt:** every `⚑ MATT` above — ruthlessness rope (§2d), thresholds/targets ownership (§3), accountability cadence (§3), memory visibility (§4), read-gating/write-graduation (§5). Plus: default model choice (currently `claude-opus-5`) and whether per-turn token spend should be surfaced in the UI.

---

## 10. Implementation phases (updated)

**v1 — SHIPPED (this slice):** agentic chat over real data · 8 read + 9 write tools · confirmation gate · deterministic insights + brief · reminders (data + in-app) · persistence · session key affordance · honest mock fallback.

**v1.5 — integrator + Settings:** Keychain key + provider/model Settings screen · OS notification delivery · Home brief wiring · conversation history UX.

**v2:** Coach notes memory · protocols tools + versioning · modes tool · evening accountability · model-voiced brief.

**v3:** experiment engine · RAG (sqlite-vec) · predictive alerts · correlations at scale · voice-first, photo meal logging · navigation.
