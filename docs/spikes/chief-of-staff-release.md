# The chief-of-staff release — plan (2026-10-21, for the owner's review)

**Status:** plan only. Nothing here is built. The owner reviews it on the decision page (see memory: the chief-of-staff release page), then building starts.

**The ask (owner, 2026-10-21):** "make the next release of ARC, with all of the changes you just did, make significant progress towards the stated goal of ARC being a 'highly competent personal chief of staff + coach'." The same day, he asked for the Coach to be called much more and do more, now that promotional API credits make that affordable, while staying efficient and **keeping the ability to reverse it** if the credits stop.

**Where this comes from:** two read-only analyses of main at `aecea71`, run 2026-10-21: a gap analysis against a competent human chief of staff + coach, and an inventory of every usage limit and every model call. Their key findings are summarised here with file references. Sizes are rough working days of build time.

---

## 1. Where ARC stands

**Solid:** chat with full context and tool access (43 tools, 27 domains, parity, read-modify-write, re-read after the gate); protocol versioning; safety and audit (receipts, phantom-write detection, nonce-bound approvals).

**Partial:** the morning brief (deterministic, `src/lib/ai/insights.ts:890`; never model-voiced, `docs/ai-coach.md:535`); proactive suggestions (the pass runs only when the app opens, on Haiku 4.5, without `query_records`, `src/lib/ai/coach-pass.ts:341,388-401`); correlations (eight detectors, one correlation, nothing on labs); n-of-1 experiments (no computed readout, `src/lib/ai/tools/read-tools.ts:1836-1867`); weekly review (user-initiated, no decisions, `docs/reports-subapp.md:180-182`); open loops; appointment and lab-draw prep; adapting to life changes (no calendar); memory (40 one-liners, a 30-message window, no semantic recall); adaptive training and nutrition; accountability (built, never on a device); escalation to a doctor (prompt rules only).

**Absent:** the home screen reflecting the Coach's judgment (the hero is the first open row by time, `src/lib/home/derive-mission.ts:46-71`); keeping the record clean as a Coach job.

**The structural blockers:**
1. The Coach acts only when the app is open (no server; iOS background limits; `docs/spikes/coach-notifications.md:80-96`).
2. The unattended Coach (the pass) sees less than the chat Coach and cannot even propose a write, so everything it concludes is prose the owner has to raise again in chat.
3. Perception gaps: no Garmin HRV, SpO2, respiration, VO2 max, Body Battery or Training Readiness reach Apple Health (`docs/spikes/garmin-hrv-routes.md:21`); no calendar.
4. The token ceilings leave ~114 schema and ~38 prompt tokens of headroom, so new capabilities can't add tools without a raise.
5. Everything after the phone's 0061 build (the whole notification layer, rounds two and three) has never run on hardware.

## 2. The shape of the release

Three tracks, in this order of dependency. Track 0 is the precondition; Tracks 1 and 2 build on it.

### Track 0 — ship safely (about 2 days, plus the owner's EAS build)

1. **Fix the re-billing queue.** A queued meal estimate that fails for a reason that won't fix itself (an unparseable reply, a 400/401/429) is re-sent and re-billed on every app open with no attempt cap (`src/lib/nutrition/estimate-queue.ts:274-279`, `pending-estimates.ts:125-127,172`). Confirm with a test, then cap attempts and park the row with a sentence.
2. **A spend ledger.** Nothing records what ARC spends (`src/hooks/use-coach-chat.ts:388,406-413`; passes and one-shot calls record nothing). Record every model call's usage and estimated cost by day and by call type (in `users.preferences` JSON, no migration, or a small table if the owner wants history: the next free number at merge). Show it in Settings › Coach: today, this week, this month.
3. **Current models and prices.** Add Sonnet 5.5, Opus 5.5 and Haiku 5.5 to `COACH_MODELS` (`src/lib/ai/model-client.ts:82-86`), `PRICES` (`src/lib/ai/cost.ts:23`) and the web-search version table (`src/lib/ai/web-search.ts:90-94`) together. Today the three tables must move in step or a model silently loses its cost line and its search. Verify every price against the live pricing page at build time, and fix the stale Sonnet 5 note.
4. **Cache the conversation.** A third cache breakpoint on the last message, so the per-turn state block and history aren't re-sent at full price on every round trip of a turn (`model-client.ts:329-336`). This is pure savings and pays for much of Track 1.
5. **Release readiness.** The build moves the phone from migration 0061 to 0066 in one launch, with the phone holding the only copy of the data. The tests already rehearse 61→66 on a populated database, but the owner should export his data (the 0061 build's export) immediately before installing. This build also brings encrypted backups to the phone for the first time. Then: the App Intent's metadata step in the EAS log must not say "skipped"; web search must be enabled for his Anthropic organisation (or turned off in Settings); the device checklist for nudges, the morning check-in, web search, the session bar, the quick-log box and the Action Button.

**Recommended:** cut **Build A** from main as soon as Track 0 lands. It puts rounds two and three, the notification layer and backups on the phone, and starts the device verification that Track 2 depends on. Track 2 then ships as **Build B**. The alternative is one build with everything; it is simpler, but it stacks new behaviour on a layer nobody has seen fire.

### Track 1 — a reversible usage policy (about 3 days)

**The design.** One module, `src/lib/ai/usage-policy.ts`, with named levels:
- **Lean**: exactly today's values, frozen. It is also the fallback whenever the setting is missing or unreadable.
- **Standard** and **Generous**: looser values.
- An optional **end date**: after it, the app reverts to Lean by itself, so the credits ending reverts ARC with nobody touching it.
- A **soft daily budget** per level, read from the spend ledger: past it, the rest of the day runs Lean.
- A switch in Settings › Coach. A test pins Lean to a literal snapshot of every value, so "revert" is guaranteed by the suite, not by memory.

**What moves into the policy** (today scattered across ~20 files; full list in the inventory): max tokens and round trips per turn; web searches per Coach turn and per estimate; the pass's model and tools; history window, tool-digest length, summary window (kept tied to the history window); memories injected per turn; search excerpt sizes and `query_records` limits; the usual-foods and corrections sizes; the evening-pass time, a cap on signal passes, a midday pass; a model per call type (chat vs utility); effort per call type.

**What stays out of the policy** (decisions about attention, privacy or quality, not money): 2 nudges a day and quiet hours; the 3-question cap; the read-only pass (proposals in Track 2 keep it that way); the doctor pack never carrying model prose; search queries never carrying health data; the deterministic thread summary; the lab-parse output floor; image downscaling.

**Proposed Generous values (for review):** pass on the chat model with `query_records` and web search; chat on Opus 5.5 and one-shot calls (estimates, imports) on Sonnet 5.5; history 30→60 messages and digests 240→600 chars; memories 40→80; searches 3→5 per Coach turn and 2→3 per estimate; round trips 8→12; explicit effort per call type (high for chat, xhigh for the weekly review and lab parse, low for estimates).

**The prompt ceilings are a separate, one-time decision.** The profile changes runtime values only, never the cached prefix, so switching levels never throws the cache away. Track 2 wants room in the prefix (a few field names in the schema, the ranking verb for chat, `search_knowledge` once an embedder exists), so the plan proposes **one** recorded raise, from 9,250 to 11,000 for tool schemas and from 3,700 to 4,500 for the system prompt. Under 1-hour caching, 1,000 more prefix tokens cost about $0.004 per cold turn, roughly $0.50 a month. Undoing a raise is a commit, not a switch. CLAUDE.md §6's "not raised a fourth time" is amended with the reason.

**Rough cost at his realistic usage** (8 chat turns, 4 estimates, 2 passes a day; to be replaced by the ledger's real numbers): today ~$18–25 a month on Sonnet 5. Generous with Opus 5.5 for chat: roughly $45–70 a month, before the conversation cache's savings. The ledger and the soft budget keep this visible and bounded.

### Track 2 — chief-of-staff capabilities (ranked; about 25–30 days in all)

Each rides existing passes and tool results where it can, keeps cards before writes and the status rule, and is verified headlessly first, then on the device.

1. **Smart day, phases 1–3: the hero follows the Coach** (~5–6 days, migration **0067**). Records what was shown, started, snoozed and skipped (`day_plan_events`); weigh-in, eat and resume prompts from facts; the pass may reorder or pin the hero with one line of reason; the turn-context "next" is fixed to name the real hero. Plan of record: `docs/spikes/smart-day.md`. **Blocked on** the owner's three smart-day questions (round-three page).
2. **A stronger pass that proposes ("Coach proposals")** (~4–5 days). The pass runs on the chat model with `query_records`, and gains triggers: a lab import, a screening coming due, an appointment within 7 days, an experiment ready, a record-hygiene finding (item 6). It may end with at most 3 proposals a day: real tool calls drafted, validated by the tool's own parser, drawn as the tool's own card, and shown on Home's Coach card and in the thread for one-tap Approve / Decline. Nothing writes without the tap; at approval the row is re-read and a stale proposal refuses. The pass itself stays read-only. A **model-voiced morning brief** rides the same pass (~+$0.20 a month). **Owner call:** proposals from the unattended Coach.
3. **Training that learns** (~4 days). The overload mark, option C, from `docs/spikes/pr-vs-overload.md`, sharing one rule with the deload; plus smart-day phase 4: whether he took the suggested workout, targets against what he lifted, exercises he swaps or drops, all in `get_training_recommendation`'s result (payload, not schema). **Blocked on** the overload questions (round-three page). Uses 0067.
4. **Experiments end to end** (~2–3 days, no migration). A deterministic readout per experiment (baseline window vs intervention window per watched metric with the existing Welch gates, adherence, excluded status and timezone days, a verdict-ready flag) returned by `get_experiments` and shown on the experiment screen; the Coach writes the verdict through `edit_record`.
5. **A weekly review that ends in decisions** (~3 days, no migration). On the first open on or after Sunday 18:00, last week's self-review is built deterministically; the Coach reads it with tools and returns at most 3 decisions as proposals (item 2); the report is saved with its read. Numbers in the read must trace to the report (the existing provenance harness). Depends on item 2.
6. **Attention routing: record hygiene and medical events** (~3 days, no migration). Pure detectors that only detect: logging gaps against his own cadence, duplicate candidates, implausible values, a lab marker that worsened or left its range, a symptom that persists. They feed the pass; the Coach decides and proposes the fix or a doctor flag. Thresholds are conservative and editable.
7. **Calendar context, read-only** (~3 days plus the EAS build for `expo-calendar`). The next 7 days' event titles, times and locations reach the Coach, so it can plan around travel and busy days before they happen. Never writes to the calendar; denial degrades honestly. **Owner call:** this sends a new category of personal data to the model.
8. **Garmin** (owner's open round-two decisions). Stage 0 needs no build and can happen today: Pulse Ox "During Sleep", request the full Garmin export, test Health Sync's HRV overnight. The in-app link (the unofficial API, recommended after the export arrives and a throwaway-account spike) is 1–2 days of spike plus 3–5 of build, needs an EAS build and an amendment to CLAUDE.md §3's egress rule. **Blocked on** the Garmin questions (round-two page).

**If the release must shrink:** keep Track 0, Track 1, and Track 2 items 1, 2 and 3; Garmin Stage 0 in any case.

**Not in this release, deliberately:** a server or background execution (the architecture forbids it; the morning check-in doorbell is the answer); auto-approving writes without a card (an open owner question, revisit once proposals have a track record); semantic memory (needs an on-device embedder; separate spike).

## 3. How we'll know it worked

After two weeks on Build B, from the ledger and `day_plan_events`:
- He follows the hero the Coach pinned more often than the time-ordered one.
- At least half of the Coach's proposals are approved, and none was wrong in a way that needed undoing (the revert criterion in the style of `docs/coach-domains.md` §13).
- The weekly review produced at least one decision he acted on.
- Spend matches the level's estimate within 50%, and the soft budget never had to bite more than twice a week.
- Nothing in the device checklist failed.

## 4. Decisions for the owner

On the decision page, each with a recommendation:
1. One build or two (Build A now, Build B with the chief-of-staff work).
2. The default usage level, and the credits' end date if known.
3. The pass on the chat model, or keep Haiku.
4. Chat and one-shot calls on separate models (Opus 5.5 for chat, Sonnet 5.5 for estimates).
5. The one-time prompt-ceiling raise.
6. Coach proposals from the unattended pass, capped at 3 a day.
7. Auto-approving bookkeeping writes: not in this release.
8. Calendar context sent to the model.
9. The weekly review on Sunday evening.
10. What to cut first if the release must shrink.

Already open elsewhere and needed: the smart-day questions and the PR-vs-overload questions (round-three page); the Garmin questions (round-two page); the auto-tick question (round-three page).

**Owner actions that unblock things, no build needed:** enable web search for his Anthropic organisation; Garmin Stage 0; one real Function PDF through the lab import; 5–10 usage captions from real Coach turns (to replace the cost estimates).
