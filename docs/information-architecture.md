# Information Architecture — where everything lives

**Decided 2026-07-25** (owner review), **shell revised 2026-08-09** (owner call on hardware — see "The tab bar" below). This maps every feature in `docs/project-status.md` §1 to a home in the app, specifies the Log tab, and defines the **Status** model (which replaced Modes on 2026-09-19). Read alongside `docs/home-screen.md` (Home detail) and `docs/decisions.md` (the ADR).

The shell is **six tabs** — Home · Coach · Log · Eat · Train · Data — plus **stack-pushed sub-screens** (Settings, the metric keypad, Protocols editor, Labs import, etc.) reached from within a tab. Not everything is a tab; deep domains are pushed screens.

> ⚠️ **One thing in this document is OPEN, not settled** (owner call from device use, 2026-08-10), flagged where it appears: **what the Eat, Train and Data tabs should contain** (the six-tab bar itself is settled). The second open item, **Modes**, was CLOSED on 2026-09-19 by retiring it — see §Status. The work queue for both is `docs/project-status.md` §1. The third — **the Protocol model** — was settled and built on 2026-08-25 (content schema 2: ordered phases, a cadence per item); see the Protocols entry below. Where this document reads as a locked spec, the one open section does not.

## Feature → destination

| Tab | What lives here |
| --- | --- |
| **Home** | Today's Mission, hero, readiness, brief, live metrics · designed states (travel/sick/data-gappy/first-run) · **Mode control** (see below) · proactive/predictive nudges surfaced · upcoming preventive screenings surfaced |
| **Coach** | Chat — **no brief here.** The daily brief lives on **Home only** (removed from this tab 2026-08-10, owner: *"it is already on the home screen"*; `docs/ai-coach.md` §3) · real model + RAG + tools · proactive corrections / evening accountability · n-of-1 experiments · predictive-alert generation · correlations & insights · Coach research · voice/vision input · conversation history |
| **Log** | Command + voice field (**free notes** + parse) · 6 quick-add tiles · **metric keypad** drill-in · today's recent entries. Two tiles are gateways to Nutrition and Exercise — which are now also tabs; see "The tab bar". |
| **Eat** ✅ *redrawn 2026-08-11* | The nutrition hub (`app/nutrition.tsx`, re-exported by `app/(tabs)/eat.tsx`), rebuilt as a tab root: **Today** (what's *left*, guarded) → the one **Log** button → **Eaten today** → **Kitchen** (recipe book · grocery list) → **Over time** (14-day energy + protein + micros). Every entry path — describe/photograph, catalog, barcode, template, cook a recipe, manual — lives inside the Log sheet. See "The Eat tab, redrawn" below. |
| **Train** ⚠️ *owner round 2026-08-11* | The exercise hub (`app/exercise.tsx`, re-exported by `app/(tabs)/train.tsx`): train-today recommendation, weekly volume, muscle freshness (a body figure, pushing its own screen), **saved workouts** (programs were retired 2026-08-11), manual log, recent sessions. The owner's own round re-cut it 2026-08-11; the on-device re-verdict is the open item — see "Eat and Train are provisional" below. |
| **Data** *(view + manage hub)* ⚠️ | Biomarker trends & optimal ranges · **Labs** (Function PDF import + results) · wearable history · body composition + the **progress-photo gallery** ✅ *(built 2026-08-12, migration 0036 — `/progress-photos` and its three pushed siblings `/progress-photo-add`, `/progress-photo-detail`, `/progress-photo-compare`; `docs/progress-photos-subapp.md`)* · **the mission execution record** (`app/mission-history.tsx`, behind the Mission trend row — see below) · **the water record** ✅ *(built 2026-08-14, no migration — `app/water.tsx` behind the Water trend row: track, log AND edit, and the first screen in ARC that can correct or delete a logged metric; see below)* · **Protocols editor** · **preventive screenings + medical calendar** (browse) · environment & lifestyle · genetics/cognitive (later) · **browsable knowledge base** ✅ *(built 2026-08-12, migration 0038 — authored as 0035, renumbered at merge; `/knowledge` (hub) → `/knowledge-entry` (reader, user entries and pack entries behind one route) · `/knowledge-entry-edit` · `/knowledge-import` · **`/coach-memory`** *(the memory editor, re-homed here by C14 — it used to hang off Settings)*; `docs/knowledge-subapp.md`)* · **Reports** ✅ *(self-review + doctor-visit pack — built 2026-08-12, migration 0039, authored as 0036 and renumbered at merge; `docs/reports-subapp.md`; pushed from a row whose body carries live state, "2 reports · last 12 Aug")* · **the row into Settings** (last on the sheet). ⚠️ **Open (2026-08-10, substantially answered 2026-08-12):** as built this read as an index of indexes — nothing on it was a *reading* — and 3 of the 8 "full file" rows were unbuilt. **All three are now built** (photos 0036 · knowledge 0038 · reports 0039), and the Reports row is the first whose body carries a live *reading* rather than a status chip; the pattern (`FileRow.state`) is generic and the other rows can adopt it a line at a time. **The status chips themselves were removed on 2026-08-14** (owner request — see below), so a row's body is now either a live reading or nothing. **Export is deliberately NOT on this tab** — it lives in Settings › Security & data, and the Reports screen points there with a margin annotation rather than a duplicate button (⚑ #4, decided). *(The lab-import-stamp complaint this note used to carry was resolved 2026-08-11 — the stamp and the biomarker ranges moved to the pushed Labs screen.)* What Data should lead with is an open question; the destinations listed here are not. |
| **Settings** *(pushed from Data)* | **App lock** (Face ID) · **provider/model/API-key** · **integrations** (Apple Health read, smart-bottle hydration, Apple Health write-back) · **backup/restore + recovery phrase** · **data export** · profile (DOB/sex/timezone/**day starts at**/units) · about |
| **Sub-screens** (pushed) | **Settings** (from the bottom of Data) · **metric keypad** (from numeric tiles) · **the Protocols sub-app** (from Home's mission area *and* from Data) · **the mission item sheet** (`/mission-item`, from a mission row's trailing chevron on Home) · Labs import (from Data) · **the Mission record** (from Data's Mission trend row) · the Nutrition and Exercise sub-app families (food search, meal detail, workout live, routine edit, …) |

## The tab bar (revised 2026-08-09, owner call on hardware)

The owner's first look at the app on a real phone: *"the workout and nutrition sections are hard to access and should be easier, possibly along the bottom bar? We could move settings to be at the bottom of data and have 6 on the bottom bar."* Both halves are now shipped, in `app/(tabs)/_layout.tsx`.

**What changed.** Nutrition and Exercise were pushed screens reached only through two of the Log tab's six quick-add tiles — a two-tap, one-guess path to the two domains a longevity app touches most days. They are now the **Eat** and **Train** tabs. Settings came off the bar and is a **stack-pushed screen** (`app/settings.tsx`) reached from the last row of the Data tab; it is the one surface here you visit a handful of times a year, so it was paying rent on the most expensive real estate in the app.

**Six fits, but only because the labels are short — this is a measurement, not a preference.** Labels render at 10px in Avenir Next Condensed Demi Bold with 0.6 letter-spacing; that face runs roughly 0.5em per uppercase glyph, so a character costs about 5.6pt drawn.

| Label | Chars | Drawn |
| --- | --- | --- |
| HOME | 4 | ≈ 23pt |
| COACH | 5 | ≈ 29pt |
| LOG | 3 | ≈ 17pt |
| EAT | 3 | ≈ 17pt |
| TRAIN | 5 | ≈ 29pt |
| DATA | 4 | ≈ 23pt |

Six slots on a 375pt iPhone are 62.5pt each, ~54pt after the tab item's own padding, so the widest label uses just over half its slot. It still clears at 320pt (53.3pt slots, ~45pt usable). **The obvious labels do NOT fit:** NUTRITION (9ch ≈ 52pt) and EXERCISE (8ch ≈ 46pt) overrun the usable width at 320pt and leave no air at 375pt. So the tabs are named for what you do — **Eat**, **Train**. (SETTINGS, 8ch ≈ 46pt, had the same problem; a small extra argument for the move.)

**The rule that falls out: a label on this bar is at most five characters.** A sixth character is the point at which six tabs stops working. If a seventh tab is ever proposed, this measurement has to be redone — 7 × 53.6pt at 375pt leaves ~45pt usable, which COACH and TRAIN still clear but which leaves nothing for a longer word.

**One hub, two ways in.** `app/(tabs)/eat.tsx` and `app/(tabs)/train.tsx` are one-line re-exports of `app/nutrition.tsx` and `app/exercise.tsx`, which stay the canonical screens and stay stack-pushable from the Log tiles and Data's trend rows. Nothing is duplicated. The Log tiles are deliberately left pointing at the same destinations: the tab is the ambient path ("I'm about to eat"), the tile is the in-flow path ("I'm capturing my day and food is part of it"). *(Open, low-priority: those two tiles could instead be re-spent on capture entry points — "Meal" and "Set" — now that the hubs have tabs. That is a change to `src/components/log/quick-add-grid.tsx`.)*

**~~Known cosmetic seam~~ — FIXED.** This section used to record that `app/nutrition.tsx` and `app/exercise.tsx` still opened with `<StackHeader>`, drawing a back chevron at a tab root. Both files now test the route shape instead — `useSegments()[0] === '(tabs)'` gives a plain serif title at the tab and keeps `StackHeader` on the pushed route. The test is deliberately **not** `router.canGoBack()`: with `backBehavior="history"` a tab root very often *can* go back, so that check would keep the chevron exactly where it is wrong.

### The Eat tab, redrawn (built 2026-08-11) — Train and Data still PROVISIONAL

**The bar is settled; two of the three bodies still are not.** Six tabs, the ≤5-character label rule and the measurement behind it all hold — do not re-litigate them. What was open is whether **re-exporting the hubs unchanged was the right content for those tabs**. For Eat, that question is now answered and built; Train and Data still read as the hubs they were.

The promotion had changed the route and the header and nothing else. A screen designed as a pushed *detail* — reached deliberately, from a specific in-flow intent — is not automatically a good tab *root*, which is entered ambiently and must answer "what do I want first" in its top third.

**EAT — the four faults and what replaced them.** The approval mockup (seven 375 × 812 sheets, drawn in live tokens) is `docs/design-research/eat-tab-redesign.html`; the screen is `app/nutrition.tsx`.

| The owner's reading, 2026-08-10 | What the tab does now |
| --- | --- |
| *"It leads with a retrospective total."* | The hero is **what is left** — `780` / `kcal left` — with the eaten ledger as the corner note it was subtracted from, so `1,620 + 780 = 2,400` reconciles on one line. The corner is still the way into the targets editor. |
| *"Five ways to log, presented as a menu."* | **One accent button reading `Log`** (owner's words, 2026-08-11: *"just call the button 'Log'"*), opening a full-screen picker sheet — `src/components/nutrition/log-sheet.tsx` — with six rows and no descriptions. Nothing was deleted; the paths moved one tap in and gained **Cook a recipe**. |
| *"The most consequential setup action is the quietest thing on the screen."* | While `targets` is null, **Set daily targets** is a full-width control under the grid, and it **retires** the moment targets exist. Outlined, not pine: the accent stays on `Log` in every state so the one action never moves. |
| *"Nothing on the tab spans more than today."* | **Over time** — 14-day energy and protein with sparklines, from one grouped query (`dailyIntakeSeries`), both opening History. Plus **Micronutrients**. Not a second dashboard: the same drill-downs, moved where they can be seen. |

Two further changes came out of the build:

- **Kitchen** — the recipe book and the grocery list, each carrying live state in the row body (`24 recipes · 3 cooked this month`, `12 to buy · 3 in the cart`). The grocery figure is `openGroceryLineCount` (the *lines* the list screen draws), never the raw row count, which disagrees the moment a name repeats. **Recipe import is NOT on the tab** — it is the recipe book's own primary action, and the iOS share sheet reaches it without passing through this screen.
- **The hero is guarded.** A day's totals skip NULL, so `target − eaten` is too large by exactly the meals nobody measured. A remainder is drawn only when a target exists **and** every meal carries that value; otherwise the metric falls back to the eaten-with-denominator reading and an authored line says why (`src/lib/nutrition/remaining.ts`, 28 assertions in `db/nutrition-remaining.test.mjs`). **Fiber is deliberately not in that grid** — it is summed from meal items, so a manual meal contributes none by construction; it lives on the micronutrients screen.

**TRAIN** still gets its top right — the "Train today" stamp is directive and should stay — then spends the next two sections on weekly analysis, parks two authoring surfaces (Programs, Routines, each with its own "New …" button) mid-screen, offers a *second* session logger under "Quick log" seven sections down, and leaves recent sessions dead last. **DATA** is in the same item for the adjacent reason. Both readings are recorded in full in `docs/project-status.md` §1 › *Screens still to build*. Nothing there is a defect — the tabs work; the complaint is what they lead with.

Until that rework lands, treat the Train row of the table above as *where that domain lives*, not as *what that screen should contain*.

**Deferred placement calls (revisit as they grow):**
- **Protocols** — ✅ **graduated to its own sub-app, 2026-08-25** (owner call, with the model rework: `docs/project-status.md` §1 › Data domains). It had been one row inside Data's foldable "The full file" section, three interactions deep for the thing that is the *only* source of Home's mission. Now: `/protocols` (the hub — Running / **Ended** / Paused, each row leading with what the protocol puts on TODAY) → `/protocol-detail` (the working screen: Now with tappable items, Coming up, adherence, the document; *Settings* in the header) → `/protocol-item` (one item) → `/protocol-settings` (identity, status, policy, Delete) → `/protocol-edit` (create, and structure on the edit path) → `/protocol-versions` (the timeline, with a **diff** between adjacent versions and **Restore**). **Two ways in, one hub**, like Nutrition and Exercise: a quiet label-voice link in Home's mission area, and Data's existing row. The first-run path from `mission-empty.tsx` lands on the hub rather than on a blank form, and the hub's empty state offers both "build it yourself" and "ask the Coach to draft one" — there is deliberately no template library, because the Coach can read a record a canned "Morning Stack" cannot. **The model behind it**: content schema 2 — ordered phases with durations, and a cadence per item (daily · specific weekdays · every-N-days · an N-per-week flexible quota); migration `0043` adds the phase clock. **An edit reaches TODAY**, through the same re-derive the Coach’s own protocol writes use, so the asymmetry that used to be explained in an 11px margin note is gone. **Since 2026-09-14 (C9/C10/C11, migration `0050`)** an item also carries a **time selector** (a collapsed line that states the time, opening to **the iOS time wheel** and Clear — the wheel since **2026-09-21**, on the owner's device note *"needs a real wheel like a calendar app"*; until then six anchor presets and the app's existing `HH:MM` field, and that typed field is still what draws wherever the picker module cannot load. It writes the same `HH:MM` either way; `src/components/protocols/time-wheel.tsx`) and a per-item **reminder** (off by default, only where there is a time; scheduled through the one OS reconciliation pass in `src/lib/notifications/`, cancelled by the same pass when the item is edited away, ticked, skipped or paused). The protocol ROW carries two toggles of execution **policy** — *If you miss it* (`carry_over`: a missed item is re-offered as a marked row for up to 7 days, never across a phase boundary and never out of an excused day — a status, a frozen mode, or a timezone change) and *When you check it off* (`checkoff_mode`: `strict` keeps the calendar, `adjusting` counts every-N-days from the last completion). A carried row is held out of every adherence denominator (`NOT_CARRIED_SQL`), so the missed day stays a miss and reads **"done late"** on the ledger — the design and its five departures from the spike are in `docs/spikes/protocol-carryover.md`.

  **The INTERFACE over that model was re-cut on 2026-09-19** (`docs/spikes/protocol-interface-rethink.md`, Phases 0–4). The sub-app had been organised as a **filing system** — documents, each with a reference sheet and one long editor — when what a daily user does with a protocol is *adjust it while running it*. A dose change cost five taps, two scrolls and a guess about which protocol a mission row came from. Five things changed:

  - **a mission row opens.** A trailing chevron on Home (a 44pt target beside the checkbox, plus a named VoiceOver action on the row; the row's tap is still the toggle) pushes `/mission-item` — what the item is, which protocol and phase put it there, its cadence and next day (or, for a quota, its allowance and no day), and the per-row verbs the repository already had and nothing drew: *Skip today*, *Move to …*, *Remove from today*, *Unsnooze*, *Put back*. Skipping a **carried** row settles the debt behind it too.
  - **a per-item editor** (`/protocol-item`) — title, dose, the **why-line**, time and reminder, cadence, phase. It writes through `addVersion`, so it cannot touch the protocol row, and it re-reads the live version at save so a Coach edit made while it is open is not reverted.
  - **the detail became the working screen**: Now with tappable items first, then **Coming up** (six projected days, carrying one honesty line — a computed day must not wear the face of a committed one), then adherence, then the document. *Settings* moved to the header.
  - **a settings sheet** (`/protocol-settings`) took identity, status, the two `0050` policies and Delete off the editor, which now carries the create path whole and, on the edit path, **structure only** — phases, items, order (new: an item moves within its phase, a phase moves among phases), the start date and the change note.
  - **the hub row leads with what the protocol is doing** — `3 today · next Wed` — with adherence at the foot; `contentCadenceSummary` and its "mixed" are deleted, and the description left the row for the detail.

  Two Coach defects were fixed in the same round, both in `get_protocols`' output and both at **zero** schema cost: it now emits each item's `notes` (without it, every `update_protocol` silently erased every rationale line in the protocol, because the tool is a complete replacement and the model could not see the field), plus `carryOver`, `checkoffMode` and `startedOn`. **No migration**: the only new persisted thing is a `skipped_via` key inside `log_entries.value`.
- **Preventive screenings + calendar** — browsable in Data; Home surfaces what's *due* ("colonoscopy in 3 weeks").
- **Knowledge base** — ✅ **built 2026-08-12** (0035, `docs/knowledge-subapp.md`). Browsable *and writable* from Data: your own entries first, ARC's shipped reference grouped by topic beneath, keyword search over both that needs no key and no network. The Coach reads the same store as its RAG corpus and cites entries as "your knowledge · \<topic\>"; when your entry and ARC's reference disagree it cites both and follows yours. Article import (URL or paste) and the confirmation-gated `save_knowledge_entry` tool are the two write paths besides the editor.

  **Coach memory lives here too, since C14 (2026-09-14)** — and this is the one place in the app where two different stores share a screen on purpose. Owner: *"the coach shouldn't be reading every scientific article put in there every turn, but I should be able to manually add stuff to coach memory that it should know every turn."* So `coach_memories` stayed its own table (no migration) and moved its **surface** off Settings onto this hub as the **first run**, above Personal and Scientific. The hub now reads **Coach memory → Personal → Scientific → ARC reference**, in order of how eagerly the Coach reads them: every turn, then when relevant, then last. One search field covers all three writable stores.

  **Settings › Coach memory is still there and is now a link**, carrying its tally (`In the Knowledge base · N held`) and pushing to `/knowledge` — the owner finds memory where he last looked for it, and there is exactly one list to keep true. `app/coach-memory.tsx` survives as the **editor for one memory** that the hub pushes at: no `id` to write, an `id` to edit, forget, restore or delete. No route was added or removed.

## The Log tab — direction A ("Open Line")

Chosen from a two-round design study (`ARC Log tab` artifacts; the six round-2 fusions are the reference). **Built and wired to the on-device DB 2026-07-25.** Capture works in **three layers**, each holding what matches its frequency:

1. **Command / voice field (hero, top).** The catch-all: free-text or spoken **notes** (a log with no metric bucket, written for the Coach to read), plus a parse of structured entries. *Wired:* an **offline** parser (`src/lib/log/parse.ts`) handles the common one-liners — `weight 178`, `16 oz water`, `hrv 48`, `180 lb` — and saves everything else verbatim as a note. Rich natural language ("ate eggs + oats, 45g protein" → a meal with macros) needs the on-device model and lands with the Coach (Phase 3). The pine action is a **mic** when the field is empty (voice arrives with the Coach) and a **send** arrow once there's text.
2. **Quick add — three door tiles and a water row.** The high-frequency structured captures: **Supplement · Weight · Therapy** as tiles, and **Water** as its own ruled row beneath them. *(Was 3×2 with two **gateway** tiles — Nutrition and Workout — until 2026-08-12, when the owner cut them: "we don't need the nutrition and workout buttons in the quick log anymore." They could go because Eat and Train became tab roots on 2026-08-09, so this block was offering a second, worse route to two screens the tab bar already reaches. It was then a 2×2 including Water until 2026-09-21 — see *Water* below.)*
   - Supplement and Therapy open the capture sheet; **Weight** opens the metric keypad.
   - **Water does not open anything — it logs, and every amount is visible** (2026-09-21, superseding the D2 tile of 2026-09-14; see *Water* below). **Glass / Bottle / Large / Other…** sit on the sheet at all times, one tap each, in the unit preference; nothing is behind a gesture. The remembered amount is printed beside the label as `usually 8 oz` and is tapped by nothing.
   - The block's contract is *every control lands somewhere that writes*; the three tiles open something that writes, and the vessels simply **write**.
   - **Layout.** Two columns is a hard constraint — at three across, "Supplement" truncates, which is why the six-tile grid was abandoned. Four vessels do not fit inside a half-width tile (≈35 pt each, under the 44 pt tap floor), so Water takes a full-width row where four cells are ≈72 pt. That leaves three doors, and the odd one **spans** rather than sitting beside a hole: a half-empty row reads as a tile that failed to load.
3. **Metric keypad (drill-in).** Single-number entry as a calibrated instrument: big mono readout, keypad, and metric chips (**Weight · Water · Body-fat % · Waist · HRV · Resting HR · Dose**). Reached by tapping Weight, or Water's **Other…**; other numbers switch via the chips. *(Tapping Water used to land here; since 2026-09-14 the Log tab logs water itself, and the keypad is the route for an amount that is not one of the three vessels.)* *Wired:* "Log" converts the typed display value to canonical units and writes it — body_metrics (weight/body-fat/waist, in kg/cm), wearable_data (water/HRV/RHR, in ml/…), or a log_entry (dose). **Water** shows additive quick-estimates (**Glass +8 · Bottle +16 · Large +24 oz**) just above the pad, and a live "N oz logged today" line.

**Where captures land (and why they don't pollute Home):** Log-tab captures are *ad-hoc* — a note, a spontaneous metric — and are marked `value.adhoc = true` (or live in `body_metrics` / `wearable_data`). Home's mission reads only the *planned* entries, so the two never mix; the Log feed shows only ad-hoc captures, newest first. Details in `src/lib/db/repositories/logs.ts`.

**Not tiles, on purpose:** notes/voice live in the hero field; other body numbers live in the keypad chips; **Medication/peptides** fold into the Supplement sheet as a type toggle (they're usually part of a protocol stack); **habits** are completed on Home's mission, not re-logged here.

### Nutrition & Exercise (sub-app screens → tabs 2026-08-09) — real as of 2026-07-25
**As of 2026-08-09 these two are tabs** (Eat, Train) as well as pushed routes — see "The tab bar". They remain sub-app *screens* in every other sense: the families beneath them (food search, meal detail, targets, templates, micros, history; workout live/log, routines, programs, exercise detail) are still stack-pushed from the hub.
Built out from the mockups and wired to the on-device DB. **Nutrition:** manual meal entry → `meals` table (0002); "Today" sums kcal + macros, "Eaten today" lists the day. Growing into photo/text logging (Phase 3, Coach), templates, micros, grocery, pantry, recipes. **Exercise:** live/past session logging (`app/workout-log.tsx`) → `workouts` + `workout_sets` (0003); week summary + recent sessions read live. Growing into templates, the fuller workout builder, VO₂max/mobility metrics, progressive-overload analytics. The **Supplement/Therapy capture sheet** is also real (one-tap quick-log + manual add → ad-hoc `log_entries`). All cross-link from Data (history/trends) later.

### Symptom logging (Log tab, 2026-07-25)
A **"Log a symptom" row** on the Log tab (kept separate from the routine quick-adds — it's a "something's off" capture, not a daily log) opens `app/symptom.tsx`: common-symptom chips, a 1–10 severity, an optional note → the `symptoms` table (0004). Surfaces in "Logged today"; the Coach correlates it against protocols/labs/wearables. Voice/NL symptom capture arrives with the Coach (Phase 3).

## "Today" — one day, set by the user (B3, built 2026-09-14)

Every surface that says *today* — Home's mission and its re-derive, the Log
feed, Eat's day and its history windows, water, readiness's today/yesterday, the
Data tab's day series, the mission record's judged window, the Coach's state
block, the exports — reads the same function, `todayISODate` in
`src/lib/db/date.ts`. **The day rolls over at a time the owner sets**
(Settings › Profile › *Day starts at*, default `00:00`), so under a 04:00 start a
1 am snack is filed under yesterday, and Home and the mission generator cannot
disagree about which day that is. The rule, the two calendar-day seams (Apple
Health buckets; a bare-time reminder's firing day) and the not-rewriting-history
decision are in `docs/data-model.md` › *Which day is this*; a source scan
(`db/day-boundary.test.mjs` §5) fails the build if a second "today" is ever
written anywhere else.

The control is on **Profile**, not Units, for the reason Units' own docblock
gives: Units is display-only and never changes what is stored, and this does. It
sits under Timezone because that is the adjacent fact — the boundary is a
wall-clock rule and says nothing about the zone (D4, below, builds on top of it).

### A day the timezone changed on (D4, built 2026-09-14)

iOS changes the device's zone by itself, and ARC now notices: the offset is
sampled when the database opens and on every foreground
(`observeTimezone`), and a change writes one row of `timezone_changes`
(migration `0053`). A **DST** shift writes nothing — the device's own
January/July offsets are the probe that tells the two apart without `Intl`, which
Hermes does not have. The design and the owner's three decisions are
`docs/spikes/timezone-days.md`.

**Every stored `date` keeps the day it was logged under.** A meal at 23:30 in
London was eaten at 23:30 in London; nothing is re-attributed, ever. What the day
gets is an annotation, and four consequences:

| Where | What it does |
| --- | --- |
| **Home** | One line, on that day only, directly under the folio line: *"Timezone changed (UTC−8 → UTC+1). Today is 15 hours long."* Then it is gone. Unmarked, no accent, no `signal-*` — a zone is a fact about the calendar, not the body. |
| **The records** | The same fact as a quiet register line on the day's row in **mission history**, **water** and **nutrition history**. The figures beside it are untouched: a 29-hour day genuinely held more water. |
| **Today's Mission** | That day's skipped and untouched items are **excused**, through the one shared definition (`excusedDatesIn`) — and **no status is set**. ARC cannot tell a flight from a Settings change, and a status is a thing the user states, which stays the owner's call. The record says *"excused · Timezone change"* rather than naming a status nobody declared. |
| **Readiness** | The day is excluded from every baseline window (HRV, resting HR, active energy) but still renders its own reading, and the **nutrition verdict goes quiet** on it — a one-day calorie target against a 29-hour day is the sharpest wrong number in the whole item. Fixed-length trend windows are untouched. |

The Coach is handed the fact and nothing else — no jet-lag rule table — for the
five days after a change, plus the one clause it cannot derive: that this day's
readings are out of the baselines.

## The Data tab — order, folding, and Settings (revised 2026-08-09)

Same owner review as the tab bar: *"sections should be foldable in the data tab, and biomarkers should be below 'the full file'."* Both shipped in `app/(tabs)/data.tsx`.

**Order, top to bottom (revised again 2026-08-11):** folio line + title → **Trends** → **The full file** → **Settings**.

> **The Labs stamp and Biomarkers both came off this screen**, on the owner's instruction: *"The big 'bring in your bloodwork' on the top of the data page should be within the labs & reports section. Furthermore, the 'biomarkers' should also be within the labs & reports only."* Both live on `app/labs.tsx` now, reached from the **Labs** row of The full file.
>
> What that actually fixed was a **duplication**, not only an ordering. `app/labs.tsx` was already drawing its own import action and its own complete biomarker list grouped by category; the Data tab was drawing a second, flatter copy of both. Two screens, the same rows, two treatments — and the Data root was carrying 65 marker rows its own sibling already owned.
>
> Two consequences worth recording. The Data tab's **accent budget is now zero** — the stamp was its one accent, and nothing left on the screen is directive. And the row that reaches Labs was relabelled from "Labs & reports" to **"Labs"**: "& reports" described only the imported-PDF list, which since this change is one of three things on that sheet.
>
> This also settles the ⚠️ open question logged against Data on 2026-08-10 and quoted in the tab table above — *"the unfoldable lab-import stamp headlines a few-times-a-year action"*. It no longer does. What stays open is the larger half: Data still reads as an index of indexes, and what it should *lead* with is unanswered.

**Why Biomarkers moved below the index first, and then off it entirely.** The catalogue is **65 markers** (`BIOMARKER_SEED`, `src/lib/labs/catalog.ts` — counted 2026-08-10; this passage read "66" in three places until then), and every one of them is drawn. Before a lab import that is 65 rows of em-dash sitting between the two sections you actually navigate with, and it would have buried the Settings row entirely. Demoting it below The full file (2026-08-09) treated the symptom; moving it to Labs treated the cause.

**Folding.** Trends and The full file each fold; the Settings row does not. *(Biomarkers and the import stamp left this screen for Labs on 2026-08-11 — the sentences below that mention them are kept where they still teach a rule, with their new home noted.)* Rules that govern it:

- **Defaults are per-section, and chosen from row count.** Trends (6, since Mission joined on 2026-08-12 and Water on 2026-08-14) and The full file (8) open — together about a screen and a half, which is the tab as it should first read. (Biomarkers (65) started **folded** while it lived here, for the same row-count reason; it now renders on Labs.)
- **A folded section still states what it holds.** Each header carries a mono tally that is true in both states — `2 of 6 tracked`, `8 of 8 built` (and `0 of 65 measured`, which moved to Labs with its section). Each tally is derived from the same array its section renders, so header and rows can never drift — which is also why **no number in this section is written by hand in the app**: the tally counts the rows it is printed above.
- **Folds go both ways.** One toggle (`!open`) with `accessibilityState.expanded` on the header. A one-way fold on Home was a real bug; the shape that caused it — a separate "expand" affordance with no inverse — is what this avoids.
- **Fold state is NOT persisted, deliberately.** `users.preferences` (the pattern behind unit choices, the app lock, Apple Health) holds things the user *sets* — durable statements about how the app should behave. A fold is a momentary "not now" about one screen. Persisting it means a tap from three weeks ago silently hides the tab's headline with nothing on screen to explain why, plus a DB write per chevron. The state that actually matters — fold, drill into a trend, come back — already survives, because tab screens stay mounted for the session. A cold start resets to the defaults above, which are the defaults *because* they are the right first read.
- **The fold chevron is `ink-muted`, never the accent.** A fold control is chrome — and since 2026-08-11 Data carries zero accent anyway (its one budgeted action, the lab-import stamp, moved to Labs).

**Settings at the foot.** One always-drawn row, last on the sheet, pushing to `app/settings.tsx`. Not foldable and not tucked inside another section — it is exactly as findable as "scroll to the bottom of Data", which is what the owner asked for. Neutral ink like every other row here. On the accent: **since 2026-08-11 Data spends zero** — its one budgeted primary action, the lab-import stamp, moved to Labs (which now spends that accent instead); Settings carries none anywhere in the app. (This sentence has now flipped twice: it read "Data is a reference surface with zero accent" until 2026-08-10 — wrong then, because the stamp lived here — and "Data spends one accent on the lab-import stamp" until 2026-08-12, stale the day the stamp moved.)

### Every trend row has a destination — and Mission's is the execution record (2026-08-12)

Owner request: *"There should be a new screen when you click on the button for Missions in the data tab under trends."* The six Trends rows push `/mission-history`, `/metric-entry`, `/water`, `/nutrition`, `/exercise`, `/symptom`. Mission's was the odd one: it ran `router.navigate('/')`, sending the reader to **Home**.

That was defensible on the reasoning that *the mission is Home's* — and it is wrong for a **trend** row, because a trend row asks about the days *behind* you and Home draws exactly one day. There was nowhere in the app that answered "how well am I actually executing, and where am I failing?", which is the only question that row implies.

**`app/mission-history.tsx` (title "Mission", parent "Data")** is that answer, and it is three objects, in the order the question is asked:

1. **Execution** — a `field` (a verdict, and the only one on the sheet): the adherence rate over a 14-day window, the four-way ledger beneath it (`done · skipped · partial · untouched`, summing to the denominator printed beside the rate), and the record's true extent.
2. **Where it's failing** — a `plate`, one row per **source**: a protocol, a mode, or an experiment. Worst-missed first, each row naming its own worst item and each tapping through to `/protocol-detail` where the protocol still exists (the doc said `/protocol-edit` until 2026-09-19; the code has always pushed the detail, and the detail’s Now rows now make an item two taps from the record). This sits **above** the day-by-day record on purpose: the protocol is the thing the user can change, and *"a protocol whose items are never done is a protocol to change"*.
3. **By day** — the record itself, newest first, one completion bar per day. It is the evidence for the two above it, so it is last. **Since 2026-09-19 each day row is a door**: it pushes `/mission-day` on that day. The record says how much of a day got done; the only way to see *what it asked for* was to have been there on the day.

2. **Where it's failing** — a `plate`, one row per **source**: a protocol or an experiment. Worst-missed first, each row naming its own worst item and each tapping through to `/protocol-detail` where the protocol still exists (the doc said `/protocol-edit` until 2026-09-19; the code has always pushed the detail, and the detail’s Now rows now make an item two taps from the record). This sits **above** the day-by-day record on purpose: the protocol is the thing the user can change, and *"a protocol whose items are never done is a protocol to change"*.
3. **By day** — the record itself, newest first, one completion bar per day. It is the evidence for the two above it, so it is last.

Then the row into **Protocols**, so a screen about a plan you are not executing reaches the plan.

### The mission's own day picker — `/mission-day`, pushed from HOME (2026-09-19)

**`app/mission-day.tsx` (title "Plan", parent "Home")**, reached by a `PLAN ›` link beside `PROTOCOLS ›` under Home's mission block — and drawn under an empty day too, because an every-3-days stack has empty days by design and those are the days worth checking tomorrow on. Owner's call, all four questions option (a). Built with no migration: two value keys on `log_entries.value`, `done_on` and `ahead`. Spec: `docs/spikes/mission-day-picker-and-future-checkoff.md`.

It is **pushed from Home and not on it**. Home answers *what should I do right now* and every section on it is about now; its mission is also a forward-clamped write target that must not move. So the other days live one push away, and the folio line still prints today.

Range: **six days forward** — every weekday once, and inside the days the reminder scheduler already reads, so nothing else in the app had to move — and back to the day the execution record begins.

- A **day ahead** is *computed on view*: looking writes nothing at all. The first tick commits the whole day and ticks that row in one transaction, and un-ticking the last tick un-commits it. Tick-only: no skip, no remove.
- A **past day** inside the carry window can be **backfilled** — a row you did and forgot to tick is ticked on its own day and reads *ticked N days later*. A carried copy is refused there (the debt is live on today's mission), as is a row a carried copy already settled; past seven days the record stands, and each refusal is one serif line.
- The **Coach** sees it but cannot act on it: `get_today_snapshot` gained `mission[].doneOn` (only when it differs from today) and an `ahead` array, both payload, neither a schema change. `adjust_today` stays today-only and acting on another day rides the parked whole-app-access item.

The shared `DayPicker` (built for the nutrition history, C1) took its first forward-looking caller here: `DayBounds.latest` stopped being a synonym for the logical today and `DayBounds.today` became a bound of its own, so the chin's words and the way home stay on today while the arrows reach a horizon.

Four rules govern what it may claim, all of them §5 (`00-design-spec.md`):

- **Today is never judged.** The rate and the failing list are computed over days that are **over**. A pending item at 09:00 is a morning, not a miss; folding today in would make the headline read worst first thing in the morning and best last thing at night, which is a fact about the clock. Today still appears in the by-day list, marked `today, still open`.
- **The window is clipped to the record** (`missionRecordStart`). A four-day-old install draws four rows and says `4 days on record` — never fourteen rows of empty, which read as fourteen days of not bothering. Under **seven** finished days the rate is stated *and disclaimed in words*.
- **Five absences, five different sentences:** never planned · the record starts today · days on record but none planned · planned and nothing missed · a day inside the record with no plan (`No plan` and an em-dash, never `0 of 0`). The middle pair matters most — *nothing was skipped* and *nothing was ever logged* are different facts, and this codebase has rendered them identically twice.
- **Mission completion is behaviour, not biology**, so no `signal-*` colour appears anywhere on it. The accent marks completion and is spent once per state: the per-day bars, or — on a database with no record at all — the single stamp into Protocols. Never both.

**No migration was needed**: `log_entries.status` and `log_entries.protocol_id` already carry it. The two new reads (`missionRecordStart`, `missionBySource`) live beside `missionDailySeries` in `src/lib/db/repositories/mission.ts` and interpolate the same `PLANNED_ROW_SQL` / `NOT_REMOVED_SQL` constants, so "the record" is exactly the rows Home draws — ad-hoc Log-tab captures and tombstoned removals excluded. Because `log_entries.protocol_id` is `ON DELETE SET NULL`, a **deleted** protocol keeps its history and its name (from the row's own extras) and simply loses its chevron.

**Deliberately not built: a streak.** A streak needs a rule for what breaks it, and answering it means deciding what a partially-excused day does to it, what a day with no plan does, and what a `partial` does — three product decisions, none forced by the data. The blocker it USED to have is gone: adherence honours excusal (§Status), so a streak would no longer punish the user for correctly resting while sick. It is unbuilt because nobody has asked for it, not because it would lie.

### Water: the one trend that tracks, logs AND edits (2026-08-14)

Owner request: *"Let's add a water screen in the trends section on the data screen, where you can track, also log, and edit water related entries."*

**`app/water.tsx` (title "Water", parent "Data")**, pushed from a new **Water** row in Trends — the sixth. Unlike the Weight row beside it, this one does *not* open the keypad: water is the metric whose record you correct about as often as you add to it (the same amount several times a day, occasionally mis-typed), and `app/metric-entry.tsx` is write-only. There was previously **no way at all to correct or remove a logged metric anywhere in ARC** — a mis-tapped 24 oz was permanent. This screen is the first that can.

**The storage question came first, and the answer is what made "edit" possible.** The brief warned that `water_ml` might be a *running daily total that quick-add mutates* — in which case there are no entries to edit, only a number that gets overwritten, and the feature would have needed a migration plus a backfill. **It is not.** Verified directly against SQLite (`db/water.test.mjs` §1) rather than read off the source:

- `logMetric` (the keypad) and `logWater` (this screen) both **INSERT**; neither ever UPDATEs a total.
- `wearable_data`'s only unique index is **partial** — `(source_device, source_raw_id) WHERE source_raw_id IS NOT NULL` — and a manual capture leaves `source_raw_id` NULL. Two 500 ml logs on one day are two rows of 500, and cannot collide.

So **no migration was needed**, and none was written. The mutable-daily-total trap is real but belongs to **HealthKit's inbound day buckets** (`hk:<metric>:<date>`, deliberately upserted so a re-sync updates one row per day) — which is exactly why republishing one to Health would make Health *sum* the versions. Water gained such a bucket on 2026-09-14 (`DietaryWater`, read only — see below), and it is the exact reason water must never be published **out**: a cumulative statistics query cannot exclude ARC's own samples, so a published total would come straight back doubled. The captures are untouched by that — they are still one INSERT each, still `source_raw_id` NULL, still individually editable. *(Superseded 2026-09-21: water is two-way. The bucket is still never published; the **captures** are, one sample each, and the read keeps them out of the bucket — `docs/wearables-subapp.md` §20.)*

Five objects:

1. **Today** — a `field` (the verdict): the selected day's total, its goal denominator *if one is set*, and a proportion bar.
2. **Add** — three unit-aware quick amounts (Glass / Bottle / Large, the same table the keypad uses) plus a free entry. Writes immediately, to the **selected** day, and says so in its header when that is not today.
3. **Entries** — the day's captures, each tapping open an inline editor with **Save** and a two-tap **Remove**. This is the half that answers "edit".
4. **By day** — the window, newest first; **every row selects that day**, which is how a *past* entry is reached and corrected without a second route.
5. **Daily goal** — set or clear it.

Rules it obeys, all §5 (`00-design-spec.md`):

- **There is no stock hydration goal and there must not be one.** An invented "2,000 ml" would manufacture a percentage, a bar and an implied failure out of a number ARC chose. Until the user sets one there is no denominator anywhere on the screen. The goal lives in `users.preferences` under `goals.waterMl` (canonical ml) — the same shape as the `health` section, no migration. **Trade-off, flagged:** unlike `nutrition_targets` (0015) it is *not* versioned, so raising the goal re-judges the history against the new number.
- **Units are the user's, never ml.** Everything renders through `resolveDisplay(water, units)`, and every typed number is read back through the same spec, so the oz/ml switch in Settings changes the whole screen without touching a stored row. Quick amounts are per-unit literals — a metric bottle is 500 ml, not a rounded 473.
- **Absence is never a zero.** A day with nothing logged reads `Nothing logged` and an em-dash. The flag is `entries === 0`, never `ml === 0`. On the Data tab's row this produces **three** states, not two: a total, an em-dash + `none logged today` when the record exists but today is untouched, and the authored empty when it does not.
- **The window is clipped to the record** and disclaimed under seven days (`Only 3 days on record — too little to read as a trend`), the same rule `mission-history` records.
- **Device-sourced rows are listed but not editable.** None exist today, but a synced row is a record of what a device reported; hand-editing it would be reverted silently by the next sync. The repository refuses (`AND source_raw_id IS NULL`) and the UI never offers the affordance.
- **Hydration against a goal is behaviour, not biology**, so no `signal-*` colour appears — the firewall runs both ways. The accent (pine) is spent once per state: the bars, or the first-run stamp.

#### Faster logging: the amounts are on the sheet, and Apple Health is the other door (D2, 2026-09-14; the Log tab corrected 2026-09-21)

Backlog D2 asked for "1, 2, 4 oz quick-add buttons for water" and the owner withdrew it himself: *"I actually want to find a way to make this logging faster and not necessarily just adding more quick buttons."* That correction is the whole design. More buttons on the water screen make the **last** tap cheaper, and the last tap was never the expensive one. The four paths were measured in `docs/spikes/water-fast-logging.md`; the two the spike recommended are built, and they cover two genuinely different cases — the phone in his hand, and the phone in another room.

**1. The Log tab logs water in place.** Four taps and three screen transitions become **two taps and one transition** (tab bar → an amount). It was the one quick-add tile where the first tap did not finish the job: `app/metric-entry.tsx`'s water amounts are *additive onto the readout*, so you still had to tap Log.

*What D2 shipped on 2026-09-14 was a single **Water tile** that committed the remembered amount, with the vessels behind a long-press. The owner's verdict off the 2026-09-21 build:*

> *"the water no longer really works, because the button just adds 8? need to do something different here, idk what tbh."*

*He had logged glasses most often, so the derivation settled on 8 oz, and he never found the gesture. The remembered amount was not the mistake — **hiding the choice was**. A long-press is invisible: nothing on the sheet says it exists, so a user who does not already know is left with whichever single amount the derivation picked, and the faster that tap is the more firmly the derivation trains itself on it. D2 measured taps and never measured discoverability. What follows is the shape after that correction.*

- **The vessels are the block's own row.** **Glass / Bottle / Large / Other…** sit on the sheet at all times, one tap each, in the unit preference. A tap writes that exact amount to today, in place — no push, no pop, no gesture. *Other…* is the existing keypad route, unchanged.
- **Nothing is behind a long-press.** The handler is deleted rather than kept as an alias: a gesture that duplicates a visible control is a second thing to keep working and a second thing to get wrong. A source scan in `db/screens-render.test.mjs` keeps it deleted.
- **Layout: a full-width row, and a door that spans.** Four cells do not fit inside a half-width tile — ≈35 pt each, under the 44 pt tap floor — and two rows of two inside it would make one cell of the grid twice the height of its neighbours. At full width the four cells are ≈72 pt. That leaves three door tiles, and three does not divide into two columns: a three-wide row truncates "Supplement" (the reason the six-tile grid was abandoned) and a 2 + 1 leaves a half-empty row. The odd door **spans** instead, so every row is complete and no label is squeezed. A side effect worth having: the tile grid holds one kind of thing again — every tile is a door, and water, which never was one, is its own object under its own label.
- **The remembered amount is a note now, not a button** (`usualWaterAmount`): the most frequent amount across **manual** captures in the last 14 days — the same window the screen uses — ties to the most recent. Manual only, so an Apple Health day total never becomes "his usual"; most frequent rather than most recent, so one 4 oz pill-swallow does not become the stated habit. It is printed beside the Water label as `usually 8 oz`, in the unit he reads in, and **nothing taps it**. With an empty record there is no note at all: an invented "usually" would be a claim about a habit that does not exist yet.
- **Marked, not reordered.** Floating the most-used vessel to the front of the row was refused. The vessels read small → large and sit in that order on this screen too, and a row that rearranges itself the week his habit shifts moves a target out from under his thumb — a quieter version of the bug being fixed. Positions are fixed; the note says which one he usually takes.
- **Undo, and why it is not a confirm.** A committing tap can be made by accident, so the block reports the write and offers **Undo**, which deletes by the id `logWater` returned — it can only remove the glass it just wrote. No timer: the design system has no motion or timing vocabulary, and an affordance you have to race is worse than one that waits. A confirm step was rejected outright; it would hand back the tap the whole change exists to save. The durable receipt is the ledger — "Logged today" reloads on the same screen, and this screen corrects it.
- The three quick amounts come from **one shared table** (`src/lib/log/water-amounts.ts`), read by this screen, the keypad and the Log tab. Two copies agreed by luck; three would not have.
- **Still unsettled, and only the phone can settle it:** whether four ≈72 pt cells are comfortable under a thumb, and whether the spanning door reads as deliberate rather than as a mistake.

**2. Apple Health hydration is read in.** `DietaryWater` is a read scope — a wrist tap or any hydration app on the phone becomes an ARC row at the next sync, **zero taps inside ARC**, and the only path that works when the phone is in another room. It arrives as one merged `apple_health` row per day, sums into Today / the goal percent / the By-day bars automatically, and is listed here **without** the edit affordance (*"From apple_health — edit it there"*) — a state this screen authored before a device row could exist. **ARC never publishes water and must not start**: a cumulative statistics query cannot exclude ARC's own samples, so a published total would be read back and doubled. Full argument, unit trap and echo assertions: `docs/wearables-subapp.md` §15. *(Superseded 2026-09-21, owner's device note "water should get 2 way health sync": every manual capture now publishes, the Undo and the water screen's edit and delete reach Health too, and the read keeps ARC's own glasses out of the day bucket. The premise above was wrong about the library — §20.)*

**The double-count rule, stated rather than engineered away.** A synced bucket and a manual capture are separate rows and the day sums both. They are not two copies of one event ARC could reconcile: a merged day total carries no per-drink identity, and ARC publishes nothing for the bucket to contain, so any dedupe would be a guess that silently deletes real intake. *(Since 2026-09-21 ARC does publish, and the bucket still contains none of it, because the read excludes ARC's own glasses. The rule is unchanged.)* So the rule is behavioural — **pick one door** — Settings › Apple Health says so in a sentence, and a double is visible here as two rows with the manual one removable.

**Deliberately not built:** a water button on Home (§5's question is *"what should I do right now"*, and the quick-actions dock was already cut once for duplicating the tab bar — if hydration matters on a given day it belongs there as a *mission item from a protocol*), a notification action (a reminder has to fire for it to exist, and thirst does not run on a schedule), and any widget / App Intent / Siri shortcut (all four are native work behind an EAS rebuild, and the outcome they promise — a wrist tap — is what reading Apple Health already gets for free).

### The "Set up" boxes are gone from The full file (2026-08-14)

Owner request: *"Let's remove the little 'set up' boxes on each of the Full File items."*

All eight rows carried a boxed `Set up` tag. By the time all eight were built the tag had stopped saying anything — a status column in which every cell reads the same is not a status column — and it was actively misleading: "Set up" reads as *this needs configuring* on rows that are simply destinations, several holding real data. The Reports row printed `1 report · last 12 Aug` and a `Set up` box on the same line.

**Nothing was stranded.** The chip was a plain `Text` inside the row's own `Pressable`, never a control; every row keeps the exact route it already had, and `built` still counts `onPress`, so the header tally is unchanged at `8 of 8 built`. What remains is `FileRow.state`, the row's live *reading* — the direction this tab has been moving in anyway. The `chip` field is deleted from the type; the `'later'` variant went with it, having had no user since the Knowledge base row was built. `db/screens-render.test.mjs` §14 now **refutes** both strings on the Data tab, so they cannot come back unnoticed.

## Status (Modes, retired)

**Locked and BUILT 2026-09-19** — migration `0061`, design in
`docs/spikes/coach-status-buttons-modes-retirement.md`. This section replaces
the Modes model that stood here from 2026-07-25, and answers the open question
that section closed with. **Revised 2026-09-21** on owner feedback from the
device: the Coach tab's five docked chips went behind the door Home already
had. **Revised again 2026-09-23**, two more device notes: the door now names the
running status, which retired Home's mono line and the Coach tab's open chip;
and the sentence the × seeds is now in his own voice. Nothing about what a
status IS changed — only where it is shown, and what one sentence says.

> **A status is a fact the user states about themself. What to do about it is
> the Coach's call, every time.**

### What a status is

A row in `day_statuses`: a free-text `label` ("sick", "traveling", "work
crunch"), a span, an `excuses` bit, and who set it. There is no registry behind
it. Nothing in the app branches on the value. **No status ever adds or removes a
mission item**, changes the hero, or changes anyone's tone.

Three things read the row, and all three are ACCOUNTING — the work that has to
happen on days the Coach is never opened at all:

1. **The adherence ledger.** An excusing status day is excused, through the ONE
   shared definition (`excusedDatesIn`), which now has three reasons: an
   excusing status, a frozen mode, a timezone change.
2. **The readiness baselines.** Every status day leaves the 30-day HRV, RHR and
   active-energy baselines, through the ONE shared helper
   (`src/lib/home/baseline-exclusions.ts`, which gained one member).
3. **The record.** The self-review names each reason; mission-history's by-day
   rows name their own.

Everything else — what today should actually become — is a Coach turn:
`adjust_today` for today, `update_protocol` for anything longer, both gated and
approved, with the user present.

### Why Modes went

The Modes section that stood here described four levers. Two of them
(`dropTypes`, `addItems`) were clinical decisions as constants: Sick dropped
every `workout` row and injected "Immune support — Vitamin D, zinc"; Deload
injected "cut training volume ~40%". That is the deterministic layer deciding
the response, which `docs/ai-coach.md` forbids in the same sentence it forbids
fabrication. The other two reached one banner line and one field in a tool
result.

The owner used it on hardware twice and called it thin both times, and the
second round of wiring did not fix it because the gap was never mechanical. The
question this section closed with — *should a mode be a profile the user
authors, versioned like a protocol?* — is **answered: no.** A registry with the
user as author is still a fixed response bound to a fact, and still a rule
deciding the day. The Coach is the adapter.

### The five chips, and the door they live behind

**Five chips** (the owner's Q1(a)): Sick · Traveling · Injured · Off day ·
Night out. Anything else he types is a first-class status the Coach records
with `set_status`; the five are a claim about frequency, not a taxonomy.
Deload is not among them and is not a status at all — a deload is a PLAN
change, `update_protocol`.

**They were docked above the Coach's composer from 2026-09-19. They are not any
more** — owner feedback from the device, **2026-09-21**, first item: *"buttons
for the status thing on the coach tab need to be moved and put behind another
button."* All five moved into **the sheet**, behind ONE control in the label
voice — and it is the same control Home was already opening beside the date
(`src/components/status/status-control.tsx`), not a second one. One component,
one sheet, two surfaces, so the five words cannot drift and neither can the
three gestures.

Three gestures, unchanged by the move and identical wherever a chip is drawn.
**Off → on** writes the row and *then* sends a canned prompt ("I'm sick right
now. Check what's up and adjust accordingly.") — that order is load-bearing: on
a plane the fact lands and only the turn fails. **Tapping an on-chip** is the
re-ask, day two of a five-day flu. **The ×** ends it and SEEDS the composer
rather than sending, because ending is bookkeeping that may not warrant a turn.
Inside the sheet the chips wrap to two rows rather than scrolling, and at most
two statuses beyond the five are drawn.

**The sentence the × seeds was rewritten on 2026-09-23.** The owner, on the
device: *"the message for unchecking a status feels weird but otherwise this is
ok."* For Sick it read *"Over the bug — back to normal. Re-check today and put
back what you took out."* — a phrase he would not type, then the mechanism
narrated back at the Coach. Each is now what he would actually say, ending in
the same sentence of his the other two gestures end in: *"I'm feeling better.
Check what's up and adjust accordingly."* · *"I'm back home. …"* · *"My injury's
better. …"*, and *"X is over. …"* for a status the Coach recorded, whose free
text cannot be conjugated. The ask stays on the end because on the day a status
ends that sentence is the Coach's only cue — the state block drops the status at
once, and its *"ended yesterday"* revert cue prints tomorrow.
(`src/lib/status/chips.ts`; Off day and Night out carry lines too, but end
tonight and draw no ×.)

**Two handoff defects, fixed 2026-09-23 (branch `claude/fb-followups`, no
migration).**

- *The revert cue was withheld while any other status ran.* It printed only
  when nothing was open, so ending Sick on day 3 of a trip told the Coach
  nothing the next morning. It now prints on its own `Status:` line whether or
  not another status is open, and is withheld for one case only: the same label
  running again today, where *"put back what it took out"* would contradict the
  open line (`src/lib/ai/turn-context.ts`; `db/turn-context.test.mjs` §S).
- *After one × on the Coach tab, Home's prompts stopped reaching the composer.*
  The tab kept the × seed in state and read it ahead of the `prompt` param, and
  never cleared it, so for as long as the tab stayed mounted a status tapped on
  Home wrote its row with no prompt following it. Both sources now go through
  one counter where the latest seed wins, and the tab drops the `prompt` param
  once it has taken it, so the same sentence sent twice from Home arrives twice
  (`src/lib/status/composer-seed.ts`; `db/statuses.test.mjs` §8). The render
  suite cannot drive a param change, so the wiring in `app/(tabs)/coach.tsx` is
  pinned by source, and that the composer reseeds on a real tab is a phone check.

**What the door shows — one face, on both surfaces (2026-09-23).** Until then
the two faces differed by what else was on the screen: Home's door read
`STATUS` whatever was on, carried *on* in its fill, and left the naming to a
mono line above the hero; the Coach tab's door stayed outlined, with the open
chip drawn beside it. The owner, on the device, of Home: *"the message is there,
but i think it would be better if the status button just changed to say 'Sick'
or whatever the currently active status is."* So:

- **Nothing on:** `STATUS ⌄`, outlined.
- **One on:** the status itself — `SICK ⌄`, `TRAVELING ⌄` — in the same label
  voice, filled. The word says WHICH, the fill says THAT, and they are one
  object rather than two.
- **Several on:** the newest by name and the rest as a mono count — `SICK +1 ⌄`
  — because a door that grows a word per status is the rail again. The spoken
  label names every one ("Status: Sick, Traveling. Re-check or change"). A long
  typed label truncates rather than pushing the date off Home's folio row.

Nothing is drawn beside it on either screen: a door naming the status next to a
line or a chip naming it again is the same fact twice. **The re-ask and the ×
live in the sheet**, on the rail's own chips, and not on the door — with two
statuses on, a × on `SICK +1` could not say which one it ends, and the same
component on Home would put a permanent end target beside the date. The price, on
the Coach tab, is one tap: the door, then the chip or its ×.

The door's anchored edge never moves with state — trailing on Home's folio row,
leading on the Coach's band, with only its width following the word — because a
control that moves between taps is not a control, the same rule that fixes the
order of the five chips. What the composer gets back is the rail's second row:
the band above the input is one 44pt line that **cannot wrap**, where five chips
at ~320–350pt against ~350pt usable at 390pt wrapped as their expected shape, and
since 2026-09-23 it holds the door and nothing else.

**Home had both a line and a control** (his Q5(c)) from 2026-09-19 to
2026-09-23. The line sat above the hero in the timezone line's register and
stated what was on, since when, whether skips were excused, and how many days
had left the baselines. **Once the door named the status, the line went**, and
what only it said moved into **the sheet's header, in mono**, directly under the
sheet's title — `Traveling since Sep 20 — skips excused · readiness baselines
exclude 4 status days` — in the line's own wording, escalation intact (*"no
recovery verdict until it ends"* replaces the count once the exclusion is what
stopped Recovery grading). The header derives the readiness view on the tap
that opens the sheet, so it is on the Coach tab too, which the line never was.
Tapping the line carried the re-ask to the Coach; that is now the door, then
the on-chip — one tap longer.

The control beside the date is ONE small target in the label voice opening the
five chips in a sheet: five chips inlined on the folio row would be five
controls competing with the one action Home exists for (CLAUDE.md §5). Home
never sends — it writes the row and carries the prompt to the Coach tab,
seeded. **Since 2026-09-21 the Coach tab reaches the chips through this same
control**, which is the argument above arriving from the other end: that
screen's one primary action is Send, and five permanent buttons on the
composer's band were four more than it had asked for. The Coach tab re-reads the
open statuses after every turn, so a status the Coach records with `set_status`
reaches the door without the tab having to lose focus first.

**"Never silently on"** — the rule the old mode indicator existed for — is kept
by the DOOR (by the line, until 2026-09-23) rather than by a picker. There is no
automatic expiry, because a timeout is a rule with a number about biology; what
replaces it is visibility gated on the consequence: the name on the door, on
both screens, every time either is open, and the consequence — the age, the
excusal, the excluded baseline days — in the header of the sheet it opens.

Neither the age nor the count stayed on Home. The forgotten status is caught by
the NAME: `SICK` beside the date on a morning he is well is the prompt to end
it, and it needs no number to be one. The count is the consequence, one tap
away — the owner's Q3(a) (*"Home and the Coach say how many days are
excluded"*) is now met through Home's door rather than on its face. That is a
reading of his note — it names the button, not the count — and worth
confirming with him on the device.

### Excusal is per status, not uniform

The owner's **Q2(b)**: the Coach decides, through an `excuses` flag on
`set_status`. A status it judged to be context without absolution is still a
status — it just does not forgive the skips, and the state block and the status
sheet's header both say so.

Two rules keep that honest:

- **The rail's own write defaults to excusing.** It happens before any model
  turn, so it needs a deterministic answer; all five chips say *don't judge me
  by today*, a wrong `true` is recoverable by the Coach on the same turn, and a
  wrong `false` silently counts a flu day as a run of misses. The argument is in
  the `0061` header.
- **An omitted flag never re-excuses.** `set_status` with no `excuses` leaves an
  open status exactly as it is. "Still sick" is a re-ask, not a re-decision.

**Baseline exclusion is uniform** (his **Q3(a)**), and that is not an
inconsistency: excusal asks *should this be held against him*, a baseline asks
*is this day evidence of what his normal looks like*. A fortnight of work
crunch the Coach declined to excuse is still a fortnight that should not define
a resting heart rate.

### The cost, stated once

A status never touches generation, so **the only thing that reshapes a day is a
Coach turn on that day**. Day two of a flu regenerates whole: the workout is on
the mission, in the hero if the protocol schedules it first, and its reminder
fires. That is strictly less than Modes did on that axis, and it is the price of
judgment over rules. It is paid down by the re-ask gesture — the door, then the
on-chip, on either screen (Home's line seeded it in one tap until 2026-09-23) —
and by the doctrine telling the Coach to bound a known length with
`update_protocol` and revert it on the "ended" cue.

### What the data does

`day_modes` and every row in it **stay forever**. They decide how past days were
judged, and rewriting that would silently change verdicts on days already lived.
The registry is a frozen shim holding `label` and `excusesSkips` and nothing
else; `0061` writes one `normal` row to end all mode coverage from its own date,
because every mode the owner ever set from Home was open-ended and the picker
that could have ended one is gone.
