# Information Architecture — where everything lives

**Decided 2026-07-25** (owner review), **shell revised 2026-08-09** (owner call on hardware — see "The tab bar" below). This maps every feature in `docs/project-status.md` §1 to a home in the app and specifies the Log tab. *(It also used to define the Modes model — **removed 2026-08-25**, owner call; see §Modes below for the record.)* Read alongside `docs/home-screen.md` (Home detail) and `docs/decisions.md` (the ADR).

The shell is **six tabs** — Home · Coach · Log · Eat · Train · Data — plus **stack-pushed sub-screens** (Settings, the metric keypad, Protocols editor, Labs import, etc.) reached from within a tab. Not everything is a tab; deep domains are pushed screens.

> ⚠️ **Two things in this document are OPEN, not settled** (owner calls from device use, 2026-08-10), and each is flagged where it appears: **what the Eat, Train and Data tabs should contain** (the six-tab bar itself is settled) and **the Protocol model** (no cadence). The work queue for both is `docs/project-status.md` §1. *(Modes was the third open item; the owner resolved it by **removal**, 2026-08-25.)* Where this document reads as a locked spec, those two sections do not.

## Feature → destination

| Tab | What lives here |
| --- | --- |
| **Home** | Today's Mission, hero, readiness, brief, live metrics · designed states (data-gappy/first-run) · proactive/predictive nudges surfaced · upcoming preventive screenings surfaced *(the Mode control left with the Modes feature, 2026-08-25 — off-normal days are the Coach's job now)* |
| **Coach** | Chat — **no brief here.** The daily brief lives on **Home only** (removed from this tab 2026-08-10, owner: *"it is already on the home screen"*; `docs/ai-coach.md` §3) · real model + RAG + tools · proactive corrections / evening accountability · n-of-1 experiments · predictive-alert generation · correlations & insights · Coach research · voice/vision input · conversation history |
| **Log** | Command + voice field (**free notes** + parse) · 6 quick-add tiles · **metric keypad** drill-in · today's recent entries. Two tiles are gateways to Nutrition and Exercise — which are now also tabs; see "The tab bar". |
| **Eat** ✅ *redrawn 2026-08-11* | The nutrition hub (`app/nutrition.tsx`, re-exported by `app/(tabs)/eat.tsx`), rebuilt as a tab root: **Today** (what's *left*, guarded) → the one **Log** button → **Eaten today** → **Kitchen** (recipe book · grocery list) → **Over time** (14-day energy + protein + micros). Every entry path — describe/photograph, catalog, barcode, template, cook a recipe, manual — lives inside the Log sheet. See "The Eat tab, redrawn" below. |
| **Train** ⚠️ *owner round 2026-08-11* | The exercise hub (`app/exercise.tsx`, re-exported by `app/(tabs)/train.tsx`): train-today recommendation, weekly volume, muscle freshness (a body figure, pushing its own screen), **saved workouts** (programs were retired 2026-08-11), manual log, recent sessions. The owner's own round re-cut it 2026-08-11; the on-device re-verdict is the open item — see "Eat and Train are provisional" below. |
| **Data** *(view + manage hub)* ⚠️ | Biomarker trends & optimal ranges · **Labs** (Function PDF import + results) · wearable history · body composition + the **progress-photo gallery** ✅ *(built 2026-08-12, migration 0036 — `/progress-photos` and its three pushed siblings `/progress-photo-add`, `/progress-photo-detail`, `/progress-photo-compare`; `docs/progress-photos-subapp.md`)* · **the mission execution record** (`app/mission-history.tsx`, behind the Mission trend row — see below) · **the water record** ✅ *(built 2026-08-14, no migration — `app/water.tsx` behind the Water trend row: track, log AND edit, and the first screen in ARC that can correct or delete a logged metric; see below)* · **Protocols editor** · **preventive screenings + medical calendar** (browse) · environment & lifestyle · genetics/cognitive (later) · **browsable knowledge base** ✅ *(built 2026-08-12, migration 0038 — authored as 0035, renumbered at merge; `/knowledge` (hub) → `/knowledge-entry` (reader, user entries and pack entries behind one route) · `/knowledge-entry-edit` · `/knowledge-import`; `docs/knowledge-subapp.md`)* · **Reports** ✅ *(self-review + doctor-visit pack — built 2026-08-12, migration 0039, authored as 0036 and renumbered at merge; `docs/reports-subapp.md`; pushed from a row whose body carries live state, "2 reports · last 12 Aug")* · **the row into Settings** (last on the sheet). ⚠️ **Open (2026-08-10, substantially answered 2026-08-12):** as built this read as an index of indexes — nothing on it was a *reading* — and 3 of the 8 "full file" rows were unbuilt. **All three are now built** (photos 0036 · knowledge 0038 · reports 0039), and the Reports row is the first whose body carries a live *reading* rather than a status chip; the pattern (`FileRow.state`) is generic and the other rows can adopt it a line at a time. **The status chips themselves were removed on 2026-08-14** (owner request — see below), so a row's body is now either a live reading or nothing. **Export is deliberately NOT on this tab** — it lives in Settings › Security & data, and the Reports screen points there with a margin annotation rather than a duplicate button (⚑ #4, decided). *(The lab-import-stamp complaint this note used to carry was resolved 2026-08-11 — the stamp and the biomarker ranges moved to the pushed Labs screen.)* What Data should lead with is an open question; the destinations listed here are not. |
| **Settings** *(pushed from Data)* | **App lock** (Face ID) · **provider/model/API-key** · **integrations** (Apple Health read, smart-bottle hydration, Apple Health write-back) · **backup/restore + recovery phrase** · **data export** · profile (DOB/sex/timezone/units) · about |
| **Sub-screens** (pushed) | **Settings** (from the bottom of Data) · **metric keypad** (from numeric tiles) · Protocols editor (from Data) · Labs import (from Data) · **the Mission record** (from Data's Mission trend row) · the Nutrition and Exercise sub-app families (food search, meal detail, workout live, routine edit, …) |

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
- **Protocols** sits in Data for now — one row inside the foldable "The full file" section, which is three interactions deep for the thing that is the *only* source of Home's mission. It's central, so it's the leading candidate to graduate to its own sub-app screen like Nutrition/Exercise did. ⚠️ **A rework of the protocol MODEL is open** (owner call 2026-08-10, `docs/project-status.md` §1 › Data domains): chiefly that a `ProtocolItem` carries no cadence, so every item of every active protocol lands on every day. Settle the model before spending a tab-adjacent placement decision on it.
- **Preventive screenings + calendar** — browsable in Data; Home surfaces what's *due* ("colonoscopy in 3 weeks").
- **Knowledge base** — ✅ **built 2026-08-12** (0035, `docs/knowledge-subapp.md`). Browsable *and writable* from Data: your own entries first, ARC's shipped reference grouped by topic beneath, keyword search over both that needs no key and no network. The Coach reads the same store as its RAG corpus and cites entries as "your knowledge · \<topic\>"; when your entry and ARC's reference disagree it cites both and follows yours. Article import (URL or paste) and the confirmation-gated `save_knowledge_entry` tool are the two write paths besides the editor.

## The Log tab — direction A ("Open Line")

Chosen from a two-round design study (`ARC Log tab` artifacts; the six round-2 fusions are the reference). **Built and wired to the on-device DB 2026-07-25.** Capture works in **three layers**, each holding what matches its frequency:

1. **Command / voice field (hero, top).** The catch-all: free-text or spoken **notes** (a log with no metric bucket, written for the Coach to read), plus a parse of structured entries. *Wired:* an **offline** parser (`src/lib/log/parse.ts`) handles the common one-liners — `weight 178`, `16 oz water`, `hrv 48`, `180 lb` — and saves everything else verbatim as a note. Rich natural language ("ate eggs + oats, 45g protein" → a meal with macros) needs the on-device model and lands with the Coach (Phase 3). The pine action is a **mic** when the field is empty (voice arrives with the Coach) and a **send** arrow once there's text.
2. **Quick-add tiles (3×2).** The high-frequency structured captures. Two kinds:
   - **Quick-capture** → the keypad or a capture sheet: **Supplement · Water · Weight · Therapy**.
   - **Gateway** → pushes a full sub-screen: **Nutrition**, **Workout → Exercise**.
   - *Layout:* the two gateway tiles sit together in the right column; quick captures fill the left and middle (owner call, 2026-07-25). Row 1: Supplement · Water · Nutrition. Row 2: Weight · Therapy · Workout.
3. **Metric keypad (drill-in).** Single-number entry as a calibrated instrument: big mono readout, keypad, and metric chips (**Weight · Water · Body-fat % · Waist · HRV · Resting HR · Dose**). Reached by tapping Weight or Water; other numbers switch via the chips. *Wired:* "Log" converts the typed display value to canonical units and writes it — body_metrics (weight/body-fat/waist, in kg/cm), wearable_data (water/HRV/RHR, in ml/…), or a log_entry (dose). **Water** shows additive quick-estimates (**Glass +8 · Bottle +16 · Large +24 oz**) just above the pad, and a live "N oz logged today" line.

**Where captures land (and why they don't pollute Home):** Log-tab captures are *ad-hoc* — a note, a spontaneous metric — and are marked `value.adhoc = true` (or live in `body_metrics` / `wearable_data`). Home's mission reads only the *planned* entries, so the two never mix; the Log feed shows only ad-hoc captures, newest first. Details in `src/lib/db/repositories/logs.ts`.

**Not tiles, on purpose:** notes/voice live in the hero field; other body numbers live in the keypad chips; **Medication/peptides** fold into the Supplement sheet as a type toggle (they're usually part of a protocol stack); **habits** are completed on Home's mission, not re-logged here.

### Nutrition & Exercise (sub-app screens → tabs 2026-08-09) — real as of 2026-07-25
**As of 2026-08-09 these two are tabs** (Eat, Train) as well as pushed routes — see "The tab bar". They remain sub-app *screens* in every other sense: the families beneath them (food search, meal detail, targets, templates, micros, history; workout live/log, routines, programs, exercise detail) are still stack-pushed from the hub.
Built out from the mockups and wired to the on-device DB. **Nutrition:** manual meal entry → `meals` table (0002); "Today" sums kcal + macros, "Eaten today" lists the day. Growing into photo/text logging (Phase 3, Coach), templates, micros, grocery, pantry, recipes. **Exercise:** live/past session logging (`app/workout-log.tsx`) → `workouts` + `workout_sets` (0003); week summary + recent sessions read live. Growing into templates, the fuller workout builder, VO₂max/mobility metrics, progressive-overload analytics. The **Supplement/Therapy capture sheet** is also real (one-tap quick-log + manual add → ad-hoc `log_entries`). All cross-link from Data (history/trends) later.

### Symptom logging (Log tab, 2026-07-25)
A **"Log a symptom" row** on the Log tab (kept separate from the routine quick-adds — it's a "something's off" capture, not a daily log) opens `app/symptom.tsx`: common-symptom chips, a 1–10 severity, an optional note → the `symptoms` table (0004). Surfaces in "Logged today"; the Coach correlates it against protocols/labs/wearables. Voice/NL symptom capture arrives with the Coach (Phase 3).

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
2. **Where it's failing** — a `plate`, one row per **source**: a protocol, an experiment, or (on historical days) a retired mode's items. Worst-missed first, each row naming its own worst item and each tapping through to `/protocol-edit` where the protocol still exists. This sits **above** the day-by-day record on purpose: the protocol is the thing the user can change, and *"a protocol whose items are never done is a protocol to change"*.
3. **By day** — the record itself, newest first, one completion bar per day. It is the evidence for the two above it, so it is last.

Then the row into **Protocols**, so a screen about a plan you are not executing reaches the plan.

Four rules govern what it may claim, all of them §5 (`00-design-spec.md`):

- **Today is never judged.** The rate and the failing list are computed over days that are **over**. A pending item at 09:00 is a morning, not a miss; folding today in would make the headline read worst first thing in the morning and best last thing at night, which is a fact about the clock. Today still appears in the by-day list, marked `today, still open`.
- **The window is clipped to the record** (`missionRecordStart`). A four-day-old install draws four rows and says `4 days on record` — never fourteen rows of empty, which read as fourteen days of not bothering. Under **seven** finished days the rate is stated *and disclaimed in words*.
- **Five absences, five different sentences:** never planned · the record starts today · days on record but none planned · planned and nothing missed · a day inside the record with no plan (`No plan` and an em-dash, never `0 of 0`). The middle pair matters most — *nothing was skipped* and *nothing was ever logged* are different facts, and this codebase has rendered them identically twice.
- **Mission completion is behaviour, not biology**, so no `signal-*` colour appears anywhere on it. The accent marks completion and is spent once per state: the per-day bars, or — on a database with no record at all — the single stamp into Protocols. Never both.

**No migration was needed**: `log_entries.status` and `log_entries.protocol_id` already carry it. The two new reads (`missionRecordStart`, `missionBySource`) live beside `missionDailySeries` in `src/lib/db/repositories/mission.ts` and interpolate the same `PLANNED_ROW_SQL` / `NOT_REMOVED_SQL` constants, so "the record" is exactly the rows Home draws — ad-hoc Log-tab captures and tombstoned removals excluded. Because `log_entries.protocol_id` is `ON DELETE SET NULL`, a **deleted** protocol keeps its history and its name (from the row's own extras) and simply loses its chevron.

**Deliberately not built: a streak.** A streak needs a rule for what breaks it, and every candidate is currently a lie — with Modes removed (§Modes below) there is no excusal mechanism for future days at all, so a streak would punish the user for correctly resting while sick. It becomes possible only after excusal is redesigned (per-item skip reasons were the leading candidate in the 2026-08-25 evaluation).

### Water: the one trend that tracks, logs AND edits (2026-08-14)

Owner request: *"Let's add a water screen in the trends section on the data screen, where you can track, also log, and edit water related entries."*

**`app/water.tsx` (title "Water", parent "Data")**, pushed from a new **Water** row in Trends — the sixth. Unlike the Weight row beside it, this one does *not* open the keypad: water is the metric whose record you correct about as often as you add to it (the same amount several times a day, occasionally mis-typed), and `app/metric-entry.tsx` is write-only. There was previously **no way at all to correct or remove a logged metric anywhere in ARC** — a mis-tapped 24 oz was permanent. This screen is the first that can.

**The storage question came first, and the answer is what made "edit" possible.** The brief warned that `water_ml` might be a *running daily total that quick-add mutates* — in which case there are no entries to edit, only a number that gets overwritten, and the feature would have needed a migration plus a backfill. **It is not.** Verified directly against SQLite (`db/water.test.mjs` §1) rather than read off the source:

- `logMetric` (the keypad) and `logWater` (this screen) both **INSERT**; neither ever UPDATEs a total.
- `wearable_data`'s only unique index is **partial** — `(source_device, source_raw_id) WHERE source_raw_id IS NOT NULL` — and a manual capture leaves `source_raw_id` NULL. Two 500 ml logs on one day are two rows of 500, and cannot collide.

So **no migration was needed**, and none was written. The mutable-daily-total trap is real but belongs to **HealthKit's inbound day buckets** (`hk:<metric>:<date>`, deliberately upserted so a re-sync updates one row per day) — which is exactly why republishing one to Health would make Health *sum* the versions. Water has never been on that path: `src/lib/health/mapping.ts` has no water channel in either direction.

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

### The "Set up" boxes are gone from The full file (2026-08-14)

Owner request: *"Let's remove the little 'set up' boxes on each of the Full File items."*

All eight rows carried a boxed `Set up` tag. By the time all eight were built the tag had stopped saying anything — a status column in which every cell reads the same is not a status column — and it was actively misleading: "Set up" reads as *this needs configuring* on rows that are simply destinations, several holding real data. The Reports row printed `1 report · last 12 Aug` and a `Set up` box on the same line.

**Nothing was stranded.** The chip was a plain `Text` inside the row's own `Pressable`, never a control; every row keeps the exact route it already had, and `built` still counts `onPress`, so the header tally is unchanged at `8 of 8 built`. What remains is `FileRow.state`, the row's live *reading* — the direction this tab has been moving in anyway. The `chip` field is deleted from the type; the `'later'` variant went with it, having had no user since the Knowledge base row was built. `db/screens-render.test.mjs` §14 now **refutes** both strings on the Data tab, so they cannot come back unnoticed.

## Modes — REMOVED (owner call, 2026-08-25)

A **mode** was how ARC handled a day that isn't normal: declare Travel/Sick/Deload/Social once and the day adapted — the plan (drop types, inject items), the hero's directive, the Coach's tone, and adherence accounting (excused skips). It shipped as migration 0026 (`day_modes`), a six-key registry, a Home control beside the date, and a gated `set_mode` Coach tool, with the preserve-work re-derive built to serve it.

The owner judged it thin on hardware twice — 2026-08-09 (*"the modes switcher right now doesn't do much"*, answered by wiring three dormant levers) and again 2026-08-10 after real use — and on **2026-08-25 called for removal** after a full evaluation of the alternatives (deepen the registry's reach, make modes user-authored profiles, or hand day-context to the Coach). The ADR is in `docs/decisions.md`.

**What replaced it: nothing deterministic — the Coach.** An off-normal day is stated in conversation ("I'm sick", "flying out Monday"); the model adjusts its tone from the stated fact and reshapes the plan through the existing gated `adjust_today`. The system prompt says exactly this, and forbids nagging about a skip the user already explained.

**What was removed:** the Home mode chip + banner (`mode-control.tsx`), the mode store and hook, the six-definition registry's behavior (drop types, injected items, `heroFocus`, `coachTone`), the mode intercepts in the mission generator, the `set_mode` tool, the turn-context Mode line, the snapshot's `mode` object, and the brief's excusing-mode branch.

**What deliberately survives:**

- **`rederiveMissionForDay`** — the preserve-work diff was never mode-specific; it is the machinery behind `update_protocol`'s `apply_today` and the empty-day recovery path. Its preserve-work test fence moved to `db/mission-generate.test.mjs`, driven by protocol edits.
- **History.** `day_modes` rows already on a device keep deciding how PAST days are judged: the reports adherence ledger still excuses a skip that landed under Sick/Travel/Social, and "What changed" still names mode runs. The label + excusal semantics are frozen in `src/lib/modes/registry.ts` (now a small read-only shim) and must never drift — that would silently rewrite verdicts on days already lived.
- **Migration 0026** (forward-only numbering) and the table itself. Migration **0043** ends live coverage: one open-ended Normal row at the removal date, so no later day can resolve to a mode — necessary because every Home-set mode was open-ended and the surface that could clear one is gone.

**Consequence for the streak question:** the old blocker ("modes excuse skips and nothing downstream reads it") is moot, but a streak is *not* thereby unblocked — with Modes gone there is no excusal mechanism for future days at all, so a streak would still punish correctly resting while sick. If a streak is ever wanted, excusal has to be redesigned first (per-item skip reasons were the leading candidate in the evaluation).
