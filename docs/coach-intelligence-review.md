# Coach Intelligence — Hostile Review & Plan

**Date:** 2026-08-07
**Method:** 11-agent adversarial review (7 subsystem mappers + 4 hostile critics), every claim verified against code at `file:line`.
**Question asked:** does the Coach *feel actually intelligent* — does it do things (almost) on its own, e.g. detect low recovery and adjust the day's workout?

---

> **BUILD STATUS (2026-08-08): all six phases are implemented and hardened.** 1,407 headless tests pass (`npm run db:test`, 42 suites), `tsc` clean, 0 lint errors. Section 4's plan is now a record of what shipped, annotated per phase. The single deliberate exception is the on-device embedder for *semantic* RAG (Phase 6 #25), which needs a native module and its own EAS build — everything up to that boundary is built, and the curated corpus is searchable by keyword today. Scores in §1 describe the state the review FOUND; the "after" column notes what changed.
>
> A **second adversarial pass** over the Phase 2–6 diff then found **22 confirmed defects, none refuted** — including two that made the flagship feature (the coach pass) non-functional. All 22 are fixed with reproduction tests; see **§4b**.
>
> **Still unproven on device.** Everything here is verified headlessly against `node:sqlite`. The pass has never made a real API call, the notification and Health seams no-op on any binary without their modules (both are in the owner’s since the 2026-08-25 rebuild), and the labs pipeline has never seen a real Function PDF. Headless green is necessary, not sufficient.

## 1. Verdict

**ARC has built an excellent chassis for an intelligent coach, and almost none of the intelligence.** The plumbing is genuinely good — a correct streaming tool loop, 24 registered tools, a nonce-bound write-confirmation gate, honest empty states, headless tests everywhere. But scored against the actual bar ("does things on its own"):

| Dimension | Score (as found) | One-line verdict | What shipped since |
| --- | --- | --- | --- |
| Autonomy & proactivity | **1.5 / 10** | The model runs *only* when the user types. Nothing ever speaks first. | The **coach pass** (Phase 4): a read-only, system-initiated turn on first app open each day and whenever a new watch-signal appears, surfaced as a "Coach noticed" card on Home. It may reply `SKIP` and usually should. |
| Context & memory | **2 / 10** | Every turn starts blind (only the date in context); no durable memory of any kind. | Per-turn context block (Phase 1) + **`coach_memories`** with `remember`/`forget`, declines replayed, tool-result digests, a rolling thread summary, and keyword recall over the user's own writing (Phase 3). |
| Agency (the closed loop) | **3 / 10** | 13 write tools, almost none of which can touch *today*. | **`adjust_today`** (batch mission surgery behind one card), honest `update_protocol` day semantics + `apply_today`, schedulable `set_mode`, and a model-controlled **volume dial** that compiles a decision into real sets (Phase 2). |
| Intelligence quality & trust | **4 / 10** | Solid number plumbing under statistically naive detectors and several trust leaks. | Welch-gated detectors with critical-value tables, honest cold-start/stable/sparse/mode-aware briefs, target-adherence signals, **token-cost captions**, and a **number-provenance eval harness** (Phase 5). |

The docs' own example voice line — *"Recovery is meaningfully down (HRV −14%). I'm dropping today's strength volume 25% and moving the Zone 2 block to tomorrow"* (`docs/ai-coach.md` §6) — is **architecturally impossible on every axis**: no trigger (the Coach can't run unprompted), no perception (it can't see readiness or sleep), no lever (it can't modify today's mission or any training volume). Run it as a probe: Matt sleeps terribly, HRV tanks. At 7am the mission is byte-identical to a great-recovery day, the readiness strip renders "Back off today" that nothing downstream reads, the brief's 7-vs-21-day windows sleep through one bad night, and the phone stays silent. **The app watches you walk into the wall it measured.**

> **Scope note (owner correction, 2026-08-08):** the low-recovery scenario is *one example probe* of the real requirement — a coach that exercises **judgment across every domain, mostly on its own initiative** — not a feature to hardcode. Scaling back a workout after a bad night is *not* an always-correct rule (planned overreach, program phase, the actual cause of the dip, what today's session even is — a million factors go into that call). The plan below therefore never encodes "low recovery → reduce volume" (or any other clinical judgment) as a deterministic rule. See "Where the intelligence lives" in §4.

---

## 2. The five structural failures

### F1 — No autonomy substrate: the Coach cannot run unless the user types

- `streamCoachReply` has exactly one caller — the chat hook's `run()`, reached only from `send()`/`retry()` (`src/hooks/use-coach-chat.ts:154`). No app-open turn, no scheduler, no background task, no notification handler exists anywhere (verified: no `TaskManager`/`BackgroundFetch`/`setNotificationHandler` in the repo).
- The "daily brief" is a deterministic string template rendered to the *user* and never shown to the *model* (`app/(tabs)/coach.tsx:45`, `coach-service.ts:98`).
- Detector output never causes or proposes a state change — no one-tap mode switch, no auto-created reminder, no mission edit. Insights are narration.
- Notifications (post-EAS-build) can only carry static reminder titles frozen at creation (`src/lib/notifications/reminders.ts:148-157`); the `reminderId` payload is attached and never consumed; no foreground handler, so an in-app fire is silently dropped.
- Of `docs/ai-coach.md` §3's five proactive surfaces, the two trivial ones shipped; evening accountability, predictive alerts, and mid-day corrections have zero code *and zero substrate to hang them on*.

### F2 — Turn-blind context and zero durable memory

- The system prompt is built with **only the date** (`coach-service.ts:98`); the `summary` context slot (`system-prompt.ts:20`) has never been passed a value — every production turn literally ends *"No precomputed summary this turn."* "How am I doing?" costs 1–3 sequential Opus round-trips before the Coach can say one grounded word.
- The promised `coach_memories` table + `remember` tool (`docs/ai-coach.md` §4.1) **does not exist in any migration or file**. "Magnesium wrecks my gut" is guaranteed forgotten once it scrolls past the window.
- History replayed to the model is flat `{role, content}` — prior turns' tool results are persisted (`ai_messages.tool_calls`) but **never replayed** (`coach-service.ts:86`), so the Coach cannot see the numbers it cited two turns ago; it paraphrases its own prose and drifts.
- One eternal thread (`ai-chat.ts:32-37`), last-30-*messages* window (a count, not tokens), no rolling summary, no new-thread UX, and `loadThread` loads the entire thread into React state forever.
- **RAG is theater**: `search_knowledge` is registered and pitched to the model, but `embedText` returns `null` unconditionally (`src/lib/rag/embedder.ts:87`), `ingestMemory` and `insertKnowledgeChunk` are called **only from tests**, and there is zero corpus content in the repo. This violates the codebase's own stub doctrine (`stubs.ts`: "a tool that always fails teaches the model not to call it"). Five dependencies stand before the first retrieved passage (ONNX runtime, its own EAS build, tokenizer spike, ~200–300 MB download UX, corpus curation).

### F3 — Sensory blind spots: the Coach can't see what the app knows

- **Readiness is invisible.** `deriveReadiness`'s only consumer is a display hook. Not in `get_today_snapshot`, not an insight, not a tool. Home can say "Back off today" while `get_insights` says nothing is wrong — two disconnected recovery models (30-day baseline ratios vs 7-vs-21-day means, different device arbitration) that can contradict each other on the same morning.
- `get_metric_series` reads six keys (`read-tools.ts:111`): **no sleep, no steps, no energy** — of ~15 ingested wearable metric types the Coach can read 3. The prompt itself pitches sleep experiments whose readout tool cannot read sleep.
- **The entire exercise engine is walled off.** The app computes e1RM trends, per-muscle freshness, double-progression targets with stall/deload detection, volume vs MEV/MAV/MRV, program week/deload state — and `get_training_summary` returns session counts and minutes. Asked "am I progressing on bench?", the model has no tool that can answer. The one designed bridge, `coach-assist.ts`, is an uncalled stub whose header claim (model client "not yet merged") is false in this tree, and `enhanceRecommendation` has zero call sites.
- Worse, **Coach-logged workouts make the engine dumber**: `log_workout` never resolves `exercise_id` (`write-tools.ts:323`), and every freshness/volume/e1RM query filters on it — the more Matt logs through the Coach, the blinder "Train today" gets.
- Also unreadable: lab *history* (latest-value only; `biomarkerSeries` exists unexposed), nutrition targets (built table, no tool), mission item ids (deliberately stripped at `read-tools.ts:75-79`), active experiments and user profile/age (absent from snapshot).

### F4 — No levers on today: decisions can't become actions

- **No tool can touch today's mission at item level** — complete, skip, add, move: all impossible. `setMissionStatus`, `insertMissionItem`, and mission ids all exist in the repository layer; `complete_mission_item` sits unregistered in stubs; `propose_today_adjustment` ("the highest-leverage write of all") was never designed.
- `update_protocol` approved at 9am **silently does nothing until tomorrow** (generation is idempotent-per-day, `mission-generate.ts:13-16`) — the Coach says "done", Home shows nothing — *except* it inconsistently DOES hit today if a mode change happens later (documented "KNOWN, ACCEPTED", `:211-215`). Approved changes that land never/tomorrow/today depending on unrelated events corrode the approve button.
- `set_mode` is the only day-shaping lever: five frozen registry presets, start hard-anchored to today (`write-tools.ts:691` — "I fly out Monday" cannot be scheduled), and Deload's entire training effect is **one habit row reading "cut training volume ~40%"** — a sticky note beside the unchanged workout (`registry.ts:95-110`, `dropTypes: []`).
- Declines teach nothing durable: the "user declined" string lives one turn, then is stripped with the rest of tool history. Decline the same suggestion three weeks running; it comes back a fourth time.
- **Experiments have a dead middle**: create and conclude work; between them nothing monitors. The intervention never enters the mission (zero adherence signal), insights/brief never mention experiments (a `ready` readout surfaces only if the model spontaneously calls `get_experiments` in a chat the user starts), `abandonExperiment` exists unregistered (a broken experiment can only be "concluded" with a fabricated verdict), and the schema's own example metric ("sleep score") is unreadable by any tool.

### F5 — Statistical naivety and trust leaks

- Detectors fire on noise while muting cold starts: HRV fires at a 5% shift of 3-vs-3 readings (day-to-day HRV CV is typically 5–15%); the correlation detector fires at |r| ≥ 0.5 with n = 8 — **p ≈ 0.20**, so one in five null users gets told training tanks their HRV. Meanwhile a new user gets the same canned "not enough logged" line for ~10 days, and a data-rich stable user gets told to "keep the cadence" — factually wrong and mildly insulting. The brief is mode-blind (Sick-mode mornings still get cadence-nagging).
- The two deferred trend-math items are still live and worse than recorded: future-dated rows (which the Coach's own `date` params can create — no upper-bound validation) poison every subsequent window, silence the weight-gap detector (negative `daysBetween`), and appear in `stats.last`.
- Truncated replies (`max_tokens`, 8-round-trip cap) are computed into `stopReason` and then **ignored by the UI** — half-answers render and persist as complete (`use-coach-chat.ts:165-183`; contrast the labs parser, which handles this correctly).
- Cost is a black box: Opus 5 default with adaptive thinking ON (no `thinking` param sent), usage fields discarded, nothing surfaced — and `model-client.ts:44` cites a "per-interaction cost analysis in docs/ai-coach.md" **that does not exist**. Realistic "how am I doing" turn: ~$0.10–0.20 and 20–45 s.
- The prompt contains a latent lie: "OS push notifications aren't wired yet" (`system-prompt.ts:43`) became false the moment that EAS build shipped, and nothing flagged the string.
- Doc drift in both directions: `docs/ai-coach.md` still lists `set_mode`/`create_experiment` as stubs and `search_knowledge` as undesigned (all shipped); `project-status.md` §1/§2 still call the Coach "a mock" in two places its own later rows refute.

---

## 3. What is genuinely good (don't break these)

- The model-client loop: SSE parsing, thinking-block round-tripping, 8-round-trip cap, mid-turn failure preserving the write audit (`CoachTurnError`), prompt-cache breakpoints.
- The write gate: nonce-bound, declined-by-default, unmount-declines, human confirmation lines that carry the consequential detail ("3 items (was 2)").
- `rederiveMissionForDay` — true diff-based mission surgery that preserves completed/partial/ad-hoc work. This is the proof-of-concept for every "adjust today" feature the Coach needs.
- The deterministic-detection + model-narration split (`insights.ts`): every number the Coach cites from it is arithmetic. Right architecture, wrong statistics.
- Honest degradation everywhere: the mock coach, the guarded native seams, empty tool results that say "no data" instead of omitting fields.
- The headless test culture (1,139 tests) — every fix below is testable in the existing pattern.

---

## 4. The plan

Ordered by dependency and leverage. Phases 1–3 need **no new native modules and no EAS build**. Migration numbers start at **0028** (0025–0027 shipped; 0005/0006/0010/0019/0022/0023 are permanently dead).

**Where the intelligence lives (the governing principle):**

| Layer | Job | Explicitly NOT its job |
| --- | --- | --- |
| Deterministic code | **Perceive** (derive readiness, series, engine state), **ground** (exact numbers), **route attention** (flag "the Coach should look at this"), bookkeeping | Making judgment calls. No pure function ever decides *what to do about* a signal ("low HRV → deload" is banned as a rule) |
| The model | **Judgment.** Weighs the signal against program phase, cause, schedule, experiments, memory, the user's own words — and decides: adjust, hold, swap, or say nothing | Arithmetic. It cites computed numbers, never re-derives them |
| Tools | **Enactment** — precise, versioned, reversible levers over the day/protocols/experiments | Deciding when to fire themselves |
| The user | One-tap confirmation on consequential writes | Doing the coach's thinking |

Every phase below is in service of that split: Phase 1 gives the model perception, Phase 2 gives it levers, Phase 3 memory, Phase 4 initiative. The deterministic layer's only new "smarts" are detection quality and knowing *when to wake the model* — never what the model should conclude.

### Phase 1 — Perception & grounding (small diffs, transformative) — ✅ SHIPPED 2026-08-08

The Coach cannot be smart about what it cannot see. *(All seven items below landed 2026-08-08 — `turn-context.ts`, the two-block system prompt, the completed snapshot, sleep/steps/energy series, `get_training_recommendation` + `get_biomarker_history`, exercise-id resolution, closed windows + future-date rejection, the truncation chip, and the runtime notifications line. One sub-item stays deferred: local-day weight bucketing (item 6) — a JS local-day regroup makes the headless suite timezone-dependent, so it wants its own change. An adversarial diff review then caught and fixed four more issues pre-merge: future log dates now throw at CARD time, not after the user's Approve tap; `set_reminder`'s description no longer contradicts the prompt's capability line; the prompt's notifications claim is permission-conditional, never an overclaim; and sleep/steps series read through the wearables repo's source arbitration so a dual-writer night can't make the Coach cite a pooled average no app surface shows. Accepted-for-now from that review: non-ASCII/archived-exercise resolution edge cases, the per-turn recompute cost, and the pre-existing hrv/rhr pooled-vs-arbitrated divergence. Tests: +60, `npm run db:test` 1,199 across 37 suites.)*

1. **Wire the dead `summary` slot** (`coach-service.ts:98`): inject a deterministic per-turn preamble — readiness verdict + failing pillars, active mode, the brief line, mission progress, active/`ready` experiments, unit preferences, age/sex. (Recent declines join the preamble in Phase 3, once #14 persists them.) All already-computed on-device SQL. **Cache-safely**: split the system prompt into two blocks — static PERSONALITY/DOCTRINE/SAFETY with the `cache_control` breakpoint, dynamic date+context tail uncached (today the date interpolation busts the system cache daily anyway; this is also a cache win).
2. **Complete the snapshot** (`read-tools.ts:63`): add `readiness` (via `deriveReadiness` — one import), mission item **ids** + type + why, active experiments, profile.
3. **Extend `SERIES_METRICS`** with `sleep_duration_min`, `sleep_deep_min`, `steps`, `active_energy_kcal` — `wearableDailySeries` already reads arbitrary metric types.
4. **Expose the training engine**: new `get_training_recommendation` read tool wrapping `buildRecommendation` (routine, per-exercise progression targets, freshness, program week/deload, volume verdicts). Delete the falsely-premised `coach-assist.ts` stub. Add `get_biomarker_history` wrapping the existing `biomarkerSeries`.
5. **Fix `log_workout` exercise identity**: exact-name catalog lookup (the labs pipeline's exact-match discipline) so Coach-logged sets stop being invisible to e1RM/freshness/volume.
6. **Trend-math hardening** (the sanctioned deferred items + the write-side hole): closed `[since, today]` windows in `series.ts`; reject future dates in tool `date` params with a correctable error; align weight bucketing to local day.
7. **Truth fixes**: surface `stopReason` truncation as a quiet "reply cut short" chip; pass `units` to `listTodayEntries` in the snapshot; make the prompt's notification line read the runtime capability flag instead of a hardcoded lie.

### Phase 2 — Levers + one recovery truth — ✅ SHIPPED 2026-08-08

The model decides; these give its decisions teeth. Nothing here decides anything by itself.

8. **Unify recovery**: insights gains a `readiness` *detector* that fires exactly when `deriveReadiness` says caution/poor, so Home and the Coach can never disagree about the *facts*; share the baseline/device-arbitration math. (Detection only — what to do about a caution morning is the model's call, made in chat or a Phase-4 pass.)
9. **`adjust_today` write tool** (the missing `propose_today_adjustment`): batch ops `[{action: complete|skip|add|move|remove, …}]` over the existing mission primitives, **one confirmation card rendering the whole diff** ("Skip: Strength · Add: 30-min Zone 2 walk · Move: Sauna → 20:00"). Reuse `rederiveMissionForDay`'s defence-in-depth delete guards. Fold in and delete the `complete_mission_item` stub. This is the lever that lets *whatever* the model concludes actually reshape the day.
10. **Parameterize the training engine — model-driven, never automatic**: `recommendToday`/`buildRecommendation` gain an optional, caller-supplied adjustment (e.g. `volumeScale`, or a substitute-session request) so that when the Coach *decides* "today should be lighter" — for whatever reason it judged — the engine compiles that decision into precise per-exercise sets/loads instead of a sticky note. `deriveReadiness` is **not** auto-wired in as a modifier; readiness reaches the model as perception (Phase 1) and the model chooses if/how to use the dial. (This also corrects `docs/exercise-subapp.md` §4.4's false "readiness seam" claim in the honest direction: the seam is a dial the Coach holds, not an automatic input.)
11. **Make `update_protocol` honest about today**: confirmation card + result state "takes effect tomorrow"; optional `apply_today: true` calls `rederiveMissionForDay` (turning the accidental mode-change behavior into a deliberate feature).
12. **`set_mode` gains a `start` date** ("I fly out Monday" becomes a plan). Modes stay what they are — user-intent presets — not an auto-triggered response to data.

### Phase 3 — Memory that works today (no ONNX required) — ✅ SHIPPED 2026-08-08

13. **Migration 0028: `coach_memories`** + `remember`/`forget` write tools (confirmation-gated — "Remember: 'trains fasted'") + injection into the Phase-1 preamble ("What you know about this user:") + a read-only Settings list (resolves the ⚑ MATT visibility question the Porcelain-Ledger way). This single table is what makes the Coach *feel* like it knows Matt — and it's where the model's own judgment context lives ("prefers to train through mild fatigue", "deload weeks feel wasted to him").
14. **Durable declines**: persist `approved|declined` on the `tool_calls` record; preamble lists recent declines so refused suggestions stop resurrecting.
15. **Stop stripping tool history**: append compact digests of prior turns' tool reads to replayed content ("[read get_metric_series(hrv,30d) → avg 48 ms, last 44]"), capped per message.
16. **Thread lifecycle**: rolling conversation summary past ~40 messages (deterministic first; Haiku upgrade optional), "new conversation" affordance, paginated `loadThread`.
17. **Honest recall now**: move `search_knowledge` to stubs (per the codebase's own doctrine) and ship `search_history` on **SQLite FTS5** (no native dep) over notes, messages, protocol notes, experiment conclusions. Start firing `ingestMemory` from write paths so the corpus accrues vector-less; when EmbeddingGemma ships, backfill and swap the backend behind the same tool contract.

### Phase 4 — Initiative: the Coach speaks first (and decides) — ✅ SHIPPED 2026-08-08

This is where judgment calls actually happen unprompted — the model, with Phase-1 perception, Phase-2 levers, and Phase-3 memory, looking at the day and deciding what (if anything) warrants action. Across *all* domains: a rough night, yes — but equally a lab report that just imported, an experiment ready to read out, a symptom cluster building, protein chronically under target, a screening overdue.

18. **The coach pass** (the keystone): a system-initiated model turn, triggered (a) on first app focus of a calendar day, and (b) when the attention router flags an event — any watch-tone insight newly firing, an experiment turning `ready`, a lab import landing. Guarded by a `last_pass_date`/per-event dedupe pref + key-present check; silent no-op offline. The directive is deliberately open: *"Proactive pass: read the snapshot, insights, and anything they point to. Decide whether anything warrants action or a word from you today. Propose actions via your tools if so; else reply in ≤2 sentences or SKIP."* No scenario is named — the judgment is the model's. Writes stay confirmation-gated: the pass **proposes**, Matt taps once. Force a cheap model for the pass regardless of the chat setting. Zero background execution — fully local-first.
19. **Notification substrate** (post-EAS-build): `setNotificationHandler` (foreground fires currently dropped silently), response routing (`reminderId` → Coach tab; `kind:'checkin'` → Coach tab, which runs the pass on focus). A user-scheduled "Morning check-in" notification becomes the doorbell; the on-open pass is the intelligence — **no server, no background compute**. Evening accountability (§3.3) falls out free: a second optional check-in whose directive is plan-vs-actuals.
20. **Experiment monitoring**: inject the running intervention into the mission (adherence becomes visible + skippable, diff machinery handles it); insights detectors for "reads out today" and "day N of M" (attention-routing — the *readout verdict* stays the model's); register `abandon_experiment`; validate watched metrics against readable series at create time ("'sleep score' is not a readable series — readout will be qualitative").

### Phase 5 — Statistical rigor & the trust ledger — ✅ SHIPPED 2026-08-08

21. **Detector hardening** (better attention-routing, not decision-making): effect-size gates (k·SD/√n via small lookup tables, no stats lib), MIN_POINTS 4–5 for HRV/RHR, correlation n ≥ 14 with critical-r table and ≥3 nonzero training days; cold-start copy ("Baseline building — day 6 of 10"); a brief that distinguishes *stable* (good news, say so) from *sparse* (nudge), and reads the mode.
22. **Targets, not just trends**: expose `nutrition_targets` to the Coach; a target-adherence *signal* (consistently 40 g under protein target with a flat trend is currently invisible forever — whether and how to intervene is the model's call).
23. **Cost honesty**: capture usage per round-trip into `CoachTurnResult`, persist, render a muted per-reply caption ("3 reads · ~$0.12"); write the real cost analysis or delete the phantom citation; then decide the default model with data.
24. **Eval harness**: golden transcripts replayed headless through `runCoachTurn` (the `db/model-client.test.mjs` pattern) + a number-provenance checker asserting every numeric literal in a reply traces to a tool result — the first real test of the never-fabricate rail.

### Phase 6 — The long pole (RAG proper) — ◐ CORPUS SHIPPED 2026-08-08; embedder still device-gated

25. EmbeddingGemma on-device: ONNX runtime spike → tokenizer decision → its own EAS build → download-on-first-run UX → curated corpus shipped as a **pre-embedded pack** (embedded offline on a desktop; never bundle 300 MB). Backfill accrued `memory_chunks`. The tool contract from #17 doesn't change; recall quality upgrades from keyword to semantic.

### Doc hygiene (with Phase 1)

- Rewrite `docs/ai-coach.md`'s tool inventory (stale in both directions), fix `project-status.md`'s four self-contradictions about the Coach, correct `docs/exercise-subapp.md` §4.4's false signature claim.

---

## 4b. Second adversarial pass — 22 confirmed defects, all fixed (2026-08-08)

A five-reviewer adversarial sweep over the Phase 2–6 diff returned **22 confirmed findings, none refuted**. Recording them here because several were in code written to fix this very review, and the pattern is worth keeping: *shipping a capability and verifying it works are different jobs.*

The worst two were in the flagship feature. The coach pass — the whole of Phase 4, the thing that makes the Coach speak first — **could not fire at all on a cold start** (it checked `apiKeyStore.has()` synchronously while `hydrate()` was still in flight), and when it did fire it fired **twice** (the same hook was mounted at the root *and* on Home, so one trigger meant two model calls and two assistant turns).

| # | Area | Defect | Fix |
| --- | --- | --- | --- |
| 10/19 | Pass | Hydration race — the daily pass never fired on app open | Runner waits for `isHydrated()`, and re-checks when the key store emits |
| 11/20 | Pass | Mounted twice → two model calls per trigger | `src/lib/ai/pass-store.ts`: one runner (root), read-only subscribers everywhere else |
| 13/22 | Pass | Ran behind the Face ID lock, shipping health data pre-auth | Runner gated on `!lock.locked` |
| 14 | Pass | Offline was indistinguishable from "nothing to say", so one aeroplane-mode morning consumed the day | `CoachPassStatus = 'spoke' \| 'silent' \| 'failed'`; only a judgment marks the day |
| 15 | Pass | Root won the race, so Home never rendered the note | Store publishes; Home subscribes |
| 1 | Mission | `adjust_today` `add` on an ungenerated day suppressed the entire protocol mission, permanently | `generateMissionForDay` first (idempotent) |
| 2 | Mission | complete/skip rewrote settled rows and destroyed `completed_at` | Settled rows refused; completion idempotent via `COALESCE` |
| 5 | Mission | An approved removal was resurrected by the next mode re-derive | Tombstone (`value.removed` + `skipped`) instead of `DELETE` — hidden from `listMission`, visible to the re-derive |
| 12/21 | Mission | Experiment interventions injected with no date-window filter — closed and unstarted experiments planted a task every day | New `experimentsRunningOn()`; `activeExperiments` keeps its readout semantics |
| 3 | Modes | `set_mode normal` silently cancelled scheduled future modes | The card names them: "also cancels Travel (2026-08-10)" |
| 4 | Modes | Card rendered windows `execute` would reject | Shared `resolveModeWindow()` — the card validates with the same code and clock |
| 6 | Memory | Prompt silently capped at 40 while Settings showed 200 | Context block states the count hidden and names the escape hatch; `get_memories` returns all |
| 7 | Memory | `recentDeclines` unbounded — a refusal from March was injected as "recently declined" | 30-day horizon, parameterised |
| 8 | Memory | Text-less assistant turns dropped, taking their tool digest with them | Render first, filter empty after |
| 9 | Memory | Rolling summary re-read the whole thread after every turn | Bounded head/tail scan; the skipped middle is stated, not elided |
| 16 | Stats | Provenance passed almost anything — substring matching (`"48"` inside `"2048"`) and a ±1% band over every number in the turn | Token comparison + rounding-consistency at the written precision |
| 17 | Stats | `tCritical` stepped **up**, returning a smaller critical value than its own doc promised — and the test asserted the bug | Steps down; monotonicity asserted |
| 18 | Cost | Sonnet 5 priced at $3/$15 while introductory $2/$10 is in effect through 2026-08-31 — wrong for the one comparison the module exists for | Corrected, with a dated `REVISIT` |

Each fix carries a reproduction test (`R1`–`R9` blocks in `db/coach-levers.test.mjs`, `db/coach-memory.test.mjs`, `db/coach-pass.test.mjs`, plus `6b` in `db/modes.test.mjs`). Battery after: **1,407 headless tests passing, `tsc` clean, 0 lint errors.**

Two of these are worth remembering as classes, not incidents:

- **A confirmation card is a promise.** #4 and #3 are the same bug wearing different clothes: the card said one thing and the tool did another. Any validation in `execute` belongs in `confirmSummary` too, and anything `execute` destroys must be named on the card.
- **A test can encode the bug.** #17 shipped with a passing assertion whose *description* contradicted its *expected value*. The prose said "steps DOWN (a larger bar)"; the number was the step-up answer. Green tests are evidence only when the assertion says what you meant.

---

## 5. Open product decisions (the ⚑ MATT ledger, updated)

| Decision | Blocks | Recommended default |
| --- | --- | --- |
| Ruthlessness rope — how much may the Coach reshape a day? | #9, #18 | The confirmation gate **is** the rope: Coach proposes anything, Matt taps once. Revisit only if tapping grates. |
| Auto-apply tiers — graduate reversible logs past the modal? | Agent "feel" | Opt-in Settings tiers: Tier 1 auto-approves pure bookkeeping (log_*) with inline receipts; plan-shaping writes stay carded forever. |
| Memory visibility | #13 | Settings › Coach memory: a quiet, deletable list. |
| Check-in cadence / quiet hours | #19 | Off by default; one morning + optional evening, user-scheduled. |
| Default model + cost surfacing | #23 | Instrument first (#23), then decide with data; the pass (#18) uses a cheap model regardless. |
| Corpus delivery (bundle vs pack) | #25 | Downloadable pre-embedded pack. |

---

## 6. The bottom line

The gap is not effort or code quality — it's that **every investment so far went into the chassis** (tools, gates, persistence, honest states) **and none into the four things that constitute felt intelligence**: perceiving everything (Phase 1), having levers (Phase 2), remembering the person (Phase 3), and acting first (Phase 4). Each phase is independently shippable, headless-testable, and local-first — and none of them hardcodes a judgment: the deterministic layer notices and grounds, the model decides, the tools enact, Matt confirms. When Phases 1, 2, and 4 exist, the low-recovery morning works — not because anyone wrote a rule for it, but because a coach with eyes, hands, and initiative handles it the way it handles the thousand scenarios nobody wrote down: it looks at the day, weighs what it knows, and makes a call.
