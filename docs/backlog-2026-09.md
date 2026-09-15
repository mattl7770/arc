# Backlog — September 2026 (the post-trip list)

**Source:** the owner's notes from two weeks of daily use on the TestFlight build (2026-08-29 → 2026-09-14), organised and clarified in one interview on 2026-09-14. **Every item below carries the owner's own answer** to the clarifying question it raised; where an answer is quoted, it is his wording. This file is the working plan; `project-status.md` records what has landed.

**Status, 2026-09-14 late: CLOSED.** Every item is built and merged to `main` behind the full gate, or explicitly parked by the owner (the Parked set, plus D1's build). The four ✅ WAVE entries at the head of `project-status.md` §1 record each landing in detail; the **Landed** column here is the short form. Nothing has been pushed or built yet — see the migration ledger at the foot.

**Sequencing rule (as run):** bugs and quick wins first; then the three *model* changes that other items depend on; then features; then the items that needed a feasibility spike or a design proposal before code. Items marked **[spec]** had a short proposal put to the owner before they were built; **[spike]** got a feasibility answer first. Four of the twenty-three spec questions were put to the owner (video import timing; the verdict's band; its timing curve; future check-off); the rest took the recommended option.

---

## Phase A — Bugs & quick wins — ✅ wave 1

| # | Item | Owner's intent | Landed |
|---|---|---|---|
| A1 | ✅ **Losing a workout when the app closes mid-session** | Persist a live draft; *"necessary for fixing when app bugs."* | `0045_workout_drafts` — a separate draft store no training query can see, write-through per keystroke, versioned JSON, *Resume it / Start new* on every door into a logger. |
| A2 | ✅ **Back button sometimes dead after saving a recipe** | Bug hunt. | A missing route anchor on cold start (a share into a cold ARC built the stack one deep, so the header's back was dropped); `unstable_settings.anchor = '(tabs)'` app-wide. Nothing in the save path was wrong. |
| A3 | ✅ Auto-highlight the amount when editing a food's quantity | UX ease. | Amount fields select on focus (`selectTextOnFocus` paired with `onFocus` + `setSelection`; RN 0.86's New Architecture ignores the former alone on a tap). |
| A4 | ✅ Name meals properly from a barcode scan | Use the product name, not a placeholder. | `name · brand`, not the clock. |
| A5 | ✅ Stay unlocked on reopen "within ~some minutes" | Raise `APP_LOCK_RELOCK_MS` from 30 s. | **5 min**; the clock-wound-back case still expires. |
| A6 | ✅ Keep source URL (+ source photo) when importing a recipe | Wire + render. | Every import rung captures `source_url` / `source_image_url` (two were hardcoding null while discarding og tags they had just fetched); rendered under a named source line; the owner's own photo outranks the thumbnail. |
| A7 | ✅ Smarter exercise search — misspellings, alternative names | | Ranked matcher: exact > alias > prefix > contains > fuzzy on a folded key, bounded Damerau-Levenshtein for the rest; `pull-downs`, `skullcrusher`, `bnech press` all resolve; `Press` still refused. C12 builds on it. |
| A8 | ✅ Important micros: **caffeine, fiber, sodium** | Track and surface. | Caffeine (400 mg ceiling) and sodium (2,300 mg) first-class; fiber's plate now draws without a target; both estimator prompts return them or omit rather than guess. No migration — JSON column. |
| A9 | ✅ Remove AI slop across the app (e.g. the protocol **"How it is going"** note) | Recopy; compile the full candidate list for one-pass owner approval. | *How it is going* → *Adherence* with three honest empty states. **`docs/ai-slop-candidates-2026-09.md`** lists 46 candidates across 31 files; **nothing on it has been touched** — the owner approves removals in one pass. |

## Phase B — Foundations (model changes) — ✅ waves 1–2

| # | Item | Owner's intent | Landed |
|---|---|---|---|
| B1 | ✅ **Exercise metric type** — reps / **time** / **distance** per exercise (planks, running) | *"Distance instead of reps for running… time for some exercises i.e. planks."* Unblocks C-items and ingested-workout mapping. | `0046_exercise_measures` — `exercises.measures`, a CHECK'd text over all fifteen subsets of reps · load · time · distance; supersedes `logging_type` as the authority; `insertSet` nulls what a movement does not measure; Longest / Farthest / Best pace; endurance-aware freshness. |
| B2 | ✅ **`ml` as a new unit type** | *"Let's start by implementing ml as a new unit type; the AI should estimate how many ML a drink is, instead of grams, when using ml instead of g."* Deliberately one new unit; *"it could get complex having too many and being too creative."* | `0047_ml_unit` — `foods.basis` (`g`/`ml`), `meal_items.unit` snapshotted at log time, **no ml↔g conversion anywhere**; the estimator asks for `unit` and keeps it. |
| B3 | ✅ **Configurable day boundary** ("new day time changer") | The user's day rolls over at a time he sets (e.g. 4 am), not midnight. Threads through every "today". | No migration — `users.preferences.day.startsAt`; `logicalDate` / `todayISODate` in `src/lib/db/date.ts`, well over a hundred call sites across `app/` and `src/`; HealthKit buckets keep HealthKit's calendar day; a source scan bans independent "today" derivations. Settings › Profile › *Day starts at*. |

## Phase C — Features — ✅ waves 3–4

| # | Item | Owner's intent | Landed |
|---|---|---|---|
| C1 | ✅ See past days' food logs | Day picker on history; respects B3. | A shared `DayPicker` bounded by the *logical* today; each past day judged by the versioned targets that governed it; a closed day never counts down. |
| C2 | ✅ **AI add food** | *"Describe a food in words and AI fills the catalog entry's macros — yes."* | A separate food-entry seam (469 tokens under a 500 ceiling); nothing written until Save; an out-of-range figure dropped to null, never clamped; `foods.source = 'ai'`. |
| C3 | ✅ **Offline food logging** | Catalog/manual path fully works with no network; AI-dependent estimates **queue until back online**. | `0057_pending_estimates` — the catalog path pinned offline *as a source fact*; the AI path writes a visible NULL-macro placeholder and a queue row; the drain runs at boot and every foreground and applies the result in place. |
| C4 | ✅ **Composite foods** **[spec]** | *"Take a photo of a pepperoni pizza… one composite item (pepperoni pizza) as well as rows below that are pizza crust, cheese, and pepperoni. If I ate the whole pizza but took the pepperoni off half, I could change just one thing. If I ate only half, I could change the entire thing together."* Specifically composite foods like pizza, not a general modifier system. | `0058_composite_meal_items` — `parent_item_id` + `is_composite`; the header stores no numbers and every sum filters it out; *ate half* halves the corrected values exactly; one shared review table for estimate and revise. `docs/spikes/composite-foods.md`. |
| C5 | ✅ **Auto-ask clarifying questions** **[spec]** | Fires on anything ambiguous, from **any** logging method; **max 3 questions**; **button-answerable** (an "other / type here" option is allowed but only as a click); only for things that **matter** and that the user would **actually know** — *"we shouldn't ask questions the user likely doesn't know themselves (i.e. cooking methods in a restaurant)."* Archetype: *"how many shots are in this latte?"* | One call returns the estimate and ≤ 3 questions whose options carry their own arithmetic; dropped deterministically when every item is high-confidence; *Other* is the one second call; barcode and the offline rungs pinned as never asking. Estimator prompt ceiling 1,000 (922 used). `docs/spikes/auto-ask.md`. |
| C6 | ✅ **Nutrition readability** **[spec]** | Macro stats more visible (bars / colours against targets) **and** more macro information per individual meal on the overview. | Bars under the kcal hero and all three macro cells in both modes; per-meal macros as three mono cells replace the item count. `docs/spikes/nutrition-readability.md`. |
| C7 | ✅ **Nutrition readiness verdict rework** **[spec]** | *"It provides almost no value right now; it only triggers late in the day and doesn't take in account my full goal (currently, exceeding my calorie goal is a good thing). It needs a rethink and a rework."* | Goal direction as a preference (Cutting · Maintaining · Gaining) with asymmetric bands (owner: **+20% optimal · +50% caution** while gaining, mirrored for cutting); graded on a **pace curve** (owner's choice) against the projected end-of-day ratio, so a big breakfast is not `poor` at 10:00; protein lifts a borderline reading one step. `docs/spikes/nutrition-verdict.md`. |
| C8 | ✅ Estimate servings on recipe import from the quantities | | From weighed lines against a stated per-serving table, behind three floors that return null rather than guess; a stated yield wins; an unconfirmed estimate is unsaveable. |
| C9 | ✅ Protocol **time selector** | Items carry `scheduled_time`; the editor needs a picker. | `TimeControl` in `app/protocol-edit.tsx` — six preset chips plus a typed `HH:MM` field on the existing `scheduled_time` column (deliberately not a native wheel); no migration. |
| C10 | ✅ Protocol **reminders** | Notifications for scheduled items. | Rides the existing notification sync pass; the reminder flag lives in the versioned content; a Coach `update_protocol` now inherits `remind` by item id (it would otherwise have silently switched every reminder off). |
| C11 | ✅ Protocol **carry-over + check-off behaviour** **[spec]** | Two **per-protocol** toggles. (1) *Persistence:* *"if you miss something, it stays tomorrow until you check it off, versus currently it is just attached to each specific day."* (2) *Future check-off:* checking an item off a day ahead marks it and updates — **strict** keeps the original calendar; **adjusting** re-bases on when it was checked. Both per protocol. | `0050_protocol_carry_over` — `protocols.carry_over` + `checkoff_mode` on the row, not the versioned content; a carried item is a new row on the later day, a debt lives 7 days, a late completion never earns rate credit; *adjusting* re-reads every-N-days from the last completion. **Future check-off deferred** by the owner until the mission has a day picker. `docs/spikes/protocol-carryover.md`. |
| C12 | ✅ **AI add-exercise** replaces AI search — *catalog first* | | `0056_exercise_source` — AI search deleted; `offersAiEntry` draws *Add with AI* only when nothing matched above the weakest tier; the model returns a whole catalog row (aliases finally written), parsed against ARC's vocabulary and rejected whole when incomplete; `exercises.source` (`seed` · `user` · `ai`) records who authored the facts. |
| C13 | ✅ **Gym away-note** **[spec]** | Per-workout label *"for when I am not at my home gym, I can make note of that and ARC can adjust intelligently"* — a stiffer machine must not read as a regression. | `0055_workout_away` — one bit; PRs, the live stamp and progression exclude it, prefill deprioritises it, the e1RM chart keeps it hollow, freshness / volume / strain untouched because none reads a weight; off by default, never remembered. `docs/spikes/gym-away-note.md`. |
| C14 | ✅ **Coach memory → Knowledge Base (relocate)** | Owner chose **(b) relocate**: keep the memory store (one-liners injected every turn — *"the coach shouldn't be reading every scientific article put in there every turn"*), move its view/editing out of Settings into the Knowledge Base screen; *"I should be able to manually add stuff to coach memory that it should know every turn."* **The Coach must read AND write both** stores. | Four runs in the knowledge base ordered by how eagerly the Coach reads them; Settings keeps a link; search hits carry ids so `save_knowledge_entry` can rewrite and the new `retire_knowledge_entry` can retire; the pack stays read-only by construction. |

## Phase D — Spikes and proposals — ✅ answered; three of four built

| # | Item | Owner's intent | Landed |
|---|---|---|---|
| D1 | ✅ spike · ⏸ build **Recipe import from a caption-less video** **[spike]** | *"Some recipe import apps are able to figure out a recipe just from the video, with no captions. I want to see if that is feasible to implement and implement if so."* | **Feasible with conditions** — frames only; the audio the competitor apps transcribe is structurally unreachable without a native module. **Owner: build later, after this batch ships.** `docs/spikes/video-recipe-import.md`. A live defect the spike found (a shared movie returned null) was fixed in wave 2. |
| D2 | ✅ **Faster water logging** **[spec]** | Not just more quick buttons: *"I actually want to find a way to make this logging faster."* | Ranks 1–2 of `docs/spikes/water-fast-logging.md`: one tap on the Water tile logs the *usual* amount in place with an Undo that can only remove that glass; long-press for the vessel row; hydration read from Apple Health (`garmin: 'unverified'` until one evening on the device says otherwise). |
| D3 | ✅ **Ingested workouts → training data** **[spec]** | Infer muscles where the type allows (*"a walking exercise… minorly effect the legs and not much else"*); **strength-training-coded** workouts leave a blank for the user; **auto-pair** an ingested session with a manually logged one by time, pulling calories and other data into the manual session. *"A topic to continue thinking on further."* | `0054_ingested_workout_pairing` — pairing by span overlap, a link table whose two unique indexes are the one-to-one guarantee, pulled data joined never copied; inference in the role-weight scale dosed by 0046's endurance rule; strength-coded sessions leave the blank; HR deferred per the owner. `docs/spikes/ingested-workouts.md`. |
| D4 | ✅ **Automatic timezone handling** **[spec]** | Note when days have timezone changes, **automatically**; *"we will need to do more thinking on the subject to make sure it works intelligently."* | `0053_timezone_changes` — annotate the seam, never re-attribute; the day is excused without a mode, baselines exclude it, the nutrition verdict goes quiet with its figures shown; one line on Home on that day only. `docs/spikes/timezone-days.md`. |

## Parked — recorded, revisit later (owner's explicit instruction)

- **Protocol interface rethink** — *"just make a note in project status and we will continue later, it will require much rethinking."*
- **Modes revamp** — the shape is decided, the build is later: **status quick-buttons on the Coach screen** (Sick, Traveling, …) that send a canned prompt — *"I am traveling right now. Check what's up and adjust accordingly"* — after which the Coach adjusts mission items, the workout plan, etc. itself. Pairs with retiring the old Modes system (`claude/modes-feature-evaluation-579177`, which must renumber its migration on landing — its `0043` collides).
- **"Slices" as a food unit** — convenient for composite foods; back burner.
- **Whole-app read/write access for the Coach** — *"basically the entire app should be accessible for reading and writing for the coach, make a note of this and we will check on it later."*
- **Future check-off for protocols** (C11's second toggle) — deferred by the owner until the mission has a day picker.
- **Video recipe import build** (D1) — *later, after this batch ships*.

---

## Migration ledger — final (head is `0058`; next free is `0059`)

| Number | Item | File |
|---|---|---|
| `0045` | A1 | `workout_drafts` |
| `0046` | B1 | `exercise_measures` — landed *after* 0047 |
| `0047` | B2 | `ml_unit` |
| `0050` | C11 | `protocol_carry_over` — landed *after* 0053 |
| `0053` | D4 | `timezone_changes` |
| `0054` | D3 | `ingested_workout_pairing` — authored 0052 |
| `0055` | C13 | `workout_away` — authored 0051 |
| `0056` | C12 | `exercise_source` |
| `0057` | C3 | `pending_estimates` — authored 0048 |
| `0058` | C4 | `composite_meal_items` — authored 0049 |

**Dead gaps from this batch: `0048` · `0049` · `0051` · `0052`** (joining 0005 · 0006 · 0010 · 0019 · 0022 · 0023 · 0040 · 0041). A2–A9, B3, C1, C2, C5–C10, C14 and D2 needed no migration.

> **Landing order was not monotonic, and that is safe exactly once.** `pendingMigrations` applies only `version > user_version`, so a number at or below a device's stamp is never applied — silently, on the one database with no second copy. 0046 landed after 0047 and 0050 after 0053, which is fine **only because no device has stamped anything past `0044`**: nothing was pushed or built between the TestFlight build and this batch, so every real device applies 0045 → 0058 in file order in one go. **After the next build the rule is absolute again**: anything authored afterwards must be numbered above the shipped head, and a reservation does not hold a number — the head does. Re-check `git ls-tree main -- db/migrations/` at merge, every time; this batch renumbered four times.
