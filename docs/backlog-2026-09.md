# Backlog — September 2026 (the post-trip list)

**Source:** the owner's notes from two weeks of daily use on the TestFlight build (2026-08-29 → 2026-09-14), organised and clarified in one interview on 2026-09-14. **Every item below carries the owner's own answer** to the clarifying question it raised; where an answer is quoted, it is his wording. This file is the working plan; `project-status.md` records what has landed.

**Sequencing rule:** bugs and quick wins first; then the three *model* changes that other items depend on; then features; then the items that need a feasibility spike or a design proposal before code. Items marked **[spec]** get a short proposal put to the owner before they are built; **[spike]** get a feasibility answer first.

---

## Phase A — Bugs & quick wins

| # | Item | Owner's intent | Notes |
|---|---|---|---|
| A1 | **Losing a workout when the app closes mid-session** | Persist a live draft; *"necessary for fixing when app bugs."* | Data-safety — ARC data has one copy. First. |
| A2 | **Back button sometimes dead after saving a recipe** | Bug hunt. | Navigation-stack after save. |
| A3 | Auto-highlight the amount when editing a food's quantity | UX ease. | |
| A4 | Name meals properly from a barcode scan | Use the product name, not a placeholder. | |
| A5 | Stay unlocked on reopen "within ~some minutes" | Raise `APP_LOCK_RELOCK_MS` from 30 s. | Default **5 min**. |
| A6 | Keep source URL (+ source photo) when importing a recipe | Wire + render. | `source_url` / `source_image_url` already exist in 0031; the importer isn't capturing/rendering them. |
| A7 | Smarter exercise search — misspellings, alternative names | | |
| A8 | Important micros: **caffeine, fiber, sodium** | Track and surface. | `micros` is a JSON column → no migration. |
| A9 | Remove AI slop across the app (e.g. the protocol **"How it is going"** note) | Recopy; compile the full candidate list for one-pass owner approval. | Standing rule: no copy removed without sign-off. |

## Phase B — Foundations (model changes)

| # | Item | Owner's intent |
|---|---|---|
| B1 | **Exercise metric type** — reps / **time** / **distance** per exercise (planks, running) | *"Distance instead of reps for running… time for some exercises i.e. planks."* Unblocks C-items and ingested-workout mapping. |
| B2 | **`ml` as a new unit type** | *"Let's start by implementing ml as a new unit type; the AI should estimate how many ML a drink is, instead of grams, when using ml instead of g."* Deliberately one new unit; *"it could get complex having too many and being too creative."* |
| B3 | **Configurable day boundary** ("new day time changer") | The user's day rolls over at a time he sets (e.g. 4 am), not midnight. Threads through every "today". |

## Phase C — Features

| # | Item | Owner's intent |
|---|---|---|
| C1 | See past days' food logs | Day picker on history; respects B3. |
| C2 | **AI add food** | *"Describe a food in words and AI fills the catalog entry's macros — yes."* |
| C3 | **Offline food logging** | Catalog/manual path fully works with no network; AI-dependent estimates **queue until back online**. |
| C4 | **Composite foods** **[spec]** | *"Take a photo of a pepperoni pizza… one composite item (pepperoni pizza) as well as rows below that are pizza crust, cheese, and pepperoni. If I ate the whole pizza but took the pepperoni off half, I could change just one thing. If I ate only half, I could change the entire thing together."* Specifically composite foods like pizza, not a general modifier system. |
| C5 | **Auto-ask clarifying questions** **[spec]** | Fires on anything ambiguous, from **any** logging method; **max 3 questions**; **button-answerable** (an "other / type here" option is allowed but only as a click); only for things that **matter** and that the user would **actually know** — *"we shouldn't ask questions the user likely doesn't know themselves (i.e. cooking methods in a restaurant)."* Archetype: *"how many shots are in this latte?"* |
| C6 | **Nutrition readability** **[spec]** | Macro stats more visible (bars / colours against targets) **and** more macro information per individual meal on the overview. |
| C7 | **Nutrition readiness verdict rework** **[spec]** | *"It provides almost no value right now; it only triggers late in the day and doesn't take in account my full goal (currently, exceeding my calorie goal is a good thing). It needs a rethink and a rework."* |
| C8 | Estimate servings on recipe import from the quantities | |
| C9 | Protocol **time selector** | Items carry `scheduled_time`; the editor needs a picker. |
| C10 | Protocol **reminders** | Notifications for scheduled items. |
| C11 | Protocol **carry-over + check-off behaviour** **[spec]** | Two **per-protocol** toggles. (1) *Persistence:* *"if you miss something, it stays tomorrow until you check it off, versus currently it is just attached to each specific day."* (2) *Future check-off:* checking an item off a day ahead marks it and updates — **strict** keeps the original calendar; **adjusting** re-bases on when it was checked. Both per protocol. |
| C12 | **AI add-exercise** replaces AI search — *catalog first* | |
| C13 | **Gym away-note** **[spec]** | Per-workout label *"for when I am not at my home gym, I can make note of that and ARC can adjust intelligently"* — a stiffer machine must not read as a regression. |
| C14 | **Coach memory → Knowledge Base (relocate)** | Owner chose **(b) relocate**: keep the memory store (one-liners injected every turn — *"the coach shouldn't be reading every scientific article put in there every turn"*), move its view/editing out of Settings into the Knowledge Base screen; *"I should be able to manually add stuff to coach memory that it should know every turn."* **The Coach must read AND write both** stores. |

## Phase D — Spikes and proposals

| # | Item | Owner's intent |
|---|---|---|
| D1 | **Recipe import from a caption-less video** **[spike]** | *"Some recipe import apps are able to figure out a recipe just from the video, with no captions. I want to see if that is feasible to implement and implement if so."* |
| D2 | **Faster water logging** **[spec]** | Not just more quick buttons: *"I actually want to find a way to make this logging faster."* |
| D3 | **Ingested workouts → training data** **[spec]** | Infer muscles where the type allows (*"a walking exercise… minorly effect the legs and not much else"*); **strength-training-coded** workouts leave a blank for the user; **auto-pair** an ingested session with a manually logged one by time, pulling calories and other data into the manual session. *"A topic to continue thinking on further."* |
| D4 | **Automatic timezone handling** ✅ **built 2026-09-14** (`0053`) | Note when days have timezone changes, **automatically**; *"we will need to do more thinking on the subject to make sure it works intelligently."* Annotate and never re-attribute; the day is excused without a mode; the nutrition verdict goes quiet. `docs/spikes/timezone-days.md`. |

## Parked — recorded, revisit later (owner's explicit instruction)

- **Protocol interface rethink** — *"just make a note in project status and we will continue later, it will require much rethinking."*
- **Modes revamp** — the shape is decided, the build is later: **status quick-buttons on the Coach screen** (Sick, Traveling, …) that send a canned prompt — *"I am traveling right now. Check what's up and adjust accordingly"* — after which the Coach adjusts mission items, the workout plan, etc. itself. Pairs with retiring the old Modes system (`claude/modes-feature-evaluation-579177`, which must renumber its migration on landing).
- **"Slices" as a food unit** — convenient for composite foods; back burner.
- **Whole-app read/write access for the Coach** — *"basically the entire app should be accessible for reading and writing for the coach, make a note of this and we will check on it later."*

---

## Migration numbers reserved (head is `0044`; re-check `git ls-tree main -- db/migrations/` at merge — seven collisions in a week)

`0045` A8 micros (only if the JSON column proves insufficient) · `0046` B1 exercise metric type · `0047` B2 ml unit · `0048` B3 day boundary (if a preference column is needed) · `0049` C4 composite foods · `0050` C11 protocol toggles (if not expressible in content JSON) · `0051` C13 gym note · `0052` D3 ingested-workout pairing · ~~`0053` D4 timezone~~ — **USED** (`0053_timezone_changes.sql`, built 2026-09-14).
