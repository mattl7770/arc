# Information Architecture — where everything lives

**Decided 2026-07-25** (owner review), **shell revised 2026-08-09** (owner call on hardware — see "The tab bar" below). This maps every feature in `docs/project-status.md` §1 to a home in the app, specifies the Log tab, and defines the Modes model. Read alongside `docs/home-screen.md` (Home detail) and `docs/decisions.md` (the ADR).

The shell is **six tabs** — Home · Coach · Log · Eat · Train · Data — plus **stack-pushed sub-screens** (Settings, the metric keypad, Protocols editor, Labs import, etc.) reached from within a tab. Not everything is a tab; deep domains are pushed screens.

> ⚠️ **Three things in this document are OPEN, not settled** (owner calls from device use, 2026-08-10), and each is flagged where it appears: **what the Eat, Train and Data tabs should contain** (the six-tab bar itself is settled), **Modes** (built, still thin), and **the Protocol model** (no cadence). The work queue for all three is `docs/project-status.md` §1. Where this document reads as a locked spec, those three sections do not.

## Feature → destination

| Tab | What lives here |
| --- | --- |
| **Home** | Today's Mission, hero, readiness, brief, live metrics · designed states (travel/sick/data-gappy/first-run) · **Mode control** (see below) · proactive/predictive nudges surfaced · upcoming preventive screenings surfaced |
| **Coach** | Chat — **no brief here.** The daily brief lives on **Home only** (removed from this tab 2026-08-10, owner: *"it is already on the home screen"*; `docs/ai-coach.md` §3) · real model + RAG + tools · proactive corrections / evening accountability · n-of-1 experiments · predictive-alert generation · correlations & insights · Coach research · voice/vision input · conversation history |
| **Log** | Command + voice field (**free notes** + parse) · 6 quick-add tiles · **metric keypad** drill-in · today's recent entries. Two tiles are gateways to Nutrition and Exercise — which are now also tabs; see "The tab bar". |
| **Eat** ✅ *redrawn 2026-08-11* | The nutrition hub (`app/nutrition.tsx`, re-exported by `app/(tabs)/eat.tsx`), rebuilt as a tab root: **Today** (what's *left*, guarded) → the one **Log** button → **Eaten today** → **Kitchen** (recipe book · grocery list) → **Over time** (14-day energy + protein + micros). Every entry path — describe/photograph, catalog, barcode, template, cook a recipe, manual — lives inside the Log sheet. See "The Eat tab, redrawn" below. |
| **Train** ⚠️ *owner round 2026-08-11* | The exercise hub (`app/exercise.tsx`, re-exported by `app/(tabs)/train.tsx`): train-today recommendation, weekly volume, muscle freshness (a body figure, pushing its own screen), **saved workouts** (programs were retired 2026-08-11), manual log, recent sessions. The owner's own round re-cut it 2026-08-11; the on-device re-verdict is the open item — see "Eat and Train are provisional" below. |
| **Data** *(view + manage hub)* ⚠️ | Biomarker trends & optimal ranges · **Labs** (Function PDF import + results) · wearable history · body composition + **progress-photo gallery** · **Protocols editor** · **preventive screenings + medical calendar** (browse) · environment & lifestyle · genetics/cognitive (later) · **browsable knowledge base** · **progress reports** · **the row into Settings** (last on the sheet). ⚠️ **Open (2026-08-10):** as built this reads as an index of indexes — nothing on it is a *reading*, and 3 of the 8 "full file" rows are unbuilt (all three **specced 2026-08-12**: `docs/progress-photos-subapp.md` · `docs/knowledge-subapp.md` · `docs/reports-subapp.md`). *(The lab-import-stamp complaint this note used to carry was resolved 2026-08-11 — the stamp and the biomarker ranges moved to the pushed Labs screen.)* What Data should lead with is an open question; the destinations listed here are not. |
| **Settings** *(pushed from Data)* | **App lock** (Face ID) · **provider/model/API-key** · **integrations** (Apple Health read, smart-bottle hydration, Apple Health write-back) · **backup/restore + recovery phrase** · **data export** · profile (DOB/sex/timezone/units) · about |
| **Sub-screens** (pushed) | **Settings** (from the bottom of Data) · **metric keypad** (from numeric tiles) · Protocols editor (from Data) · Labs import (from Data) · the Nutrition and Exercise sub-app families (food search, meal detail, workout live, routine edit, …) |

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
- **Knowledge base** — browsable in Data; the Coach also reads it as its RAG corpus.

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

- **Defaults are per-section, and chosen from row count.** Trends (4) and The full file (8) open — together about a screen and a half, which is the tab as it should first read. (Biomarkers (65) started **folded** while it lived here, for the same row-count reason; it now renders on Labs.)
- **A folded section still states what it holds.** Each header carries a mono tally that is true in both states — `2 of 4 tracked`, `5 of 8 built` (and `0 of 65 measured`, which moved to Labs with its section). Each tally is derived from the same array its section renders, so header and rows can never drift — which is also why **no number in this section is written by hand in the app**: the tally counts the rows it is printed above.
- **Folds go both ways.** One toggle (`!open`) with `accessibilityState.expanded` on the header. A one-way fold on Home was a real bug; the shape that caused it — a separate "expand" affordance with no inverse — is what this avoids.
- **Fold state is NOT persisted, deliberately.** `users.preferences` (the pattern behind unit choices, the app lock, Apple Health) holds things the user *sets* — durable statements about how the app should behave. A fold is a momentary "not now" about one screen. Persisting it means a tap from three weeks ago silently hides the tab's headline with nothing on screen to explain why, plus a DB write per chevron. The state that actually matters — fold, drill into a trend, come back — already survives, because tab screens stay mounted for the session. A cold start resets to the defaults above, which are the defaults *because* they are the right first read.
- **The fold chevron is `ink-muted`, never the accent.** A fold control is chrome — and since 2026-08-11 Data carries zero accent anyway (its one budgeted action, the lab-import stamp, moved to Labs).

**Settings at the foot.** One always-drawn row, last on the sheet, pushing to `app/settings.tsx`. Not foldable and not tucked inside another section — it is exactly as findable as "scroll to the bottom of Data", which is what the owner asked for. Neutral ink like every other row here. On the accent: **since 2026-08-11 Data spends zero** — its one budgeted primary action, the lab-import stamp, moved to Labs (which now spends that accent instead); Settings carries none anywhere in the app. (This sentence has now flipped twice: it read "Data is a reference surface with zero accent" until 2026-08-10 — wrong then, because the stamp lived here — and "Data spends one accent on the lab-import stamp" until 2026-08-12, stale the day the stamp moved.)

## Modes

A **mode** is how ARC handles a day that isn't normal — the concrete form of "support imperfect days gracefully" (CLAUDE.md §5, `docs/home-screen.md`). You declare the context once and the day adapts, instead of the app showing the standard plan and marking half of it missed. A mode changes **four things**:

1. **The plan** — which mission items appear and their targets (Sick pulls training, adds rest/hydration/immune; Travel swaps in a circadian-adjustment routine + a portable supplement subset; Deload cuts volume).
2. **Priorities** — what the "Do this next" hero pushes (Social → "eat earlier / hydrate / cap it," not "hit your macros").
3. **The Coach's tone** — evidence-based but context-aware (Sick → recovery talk, no nagging about the missed workout; Social → harm-reduction, not adherence guilt).
4. **Adherence accounting** — a skipped workout in Sick mode is **excused, not a miss**; the streak/score isn't punished for doing the right thing.

**The set:** Normal (default) · Travel · Sick · Deload · Social · Custom.
**Duration:** just today, a date range (a whole trip), or on-until-turned-off.
**Where:** the **Home** screen — a quiet control near the date/status, because a mode is a fact about *today* set in the moment (landing in a new city, waking up sick); burying it in Settings would add friction exactly when it's needed. A small persistent indicator shows the active mode so it's never silently on; setting it visibly re-derives the mission and re-tones the brief.
**Data model — BUILT** (engine 2026-07-31, UI 2026-08-01). The override model this section used to describe as hypothetical shipped as migration **0026**, `day_modes` — the "small table for ranges" option, since it supports single-day, date-range, and open-ended-until-turned-off durations. What exists today:

- **`day_modes` (0026)** + a mode registry (Normal · Travel · Sick · Deload · Social · Custom), each mode carrying drop-types, injected items, a `heroFocus`, a `coachTone`, and whether it excuses skips — which is exactly the four-part change described above.
- **A mode-aware mission generator**, and **`rederiveMissionForDay`** for setting a mode mid-day. That re-derive is a **diff, never a wipe**: untouched pending machine-made items the new mode drops are removed, the new mode's items are added, and anything completed, skipped, **partial**, or ad-hoc is preserved. Declaring you're sick at 3pm must never erase the morning you actually did.
- **The Home control** (`src/components/home/mode-control.tsx`) — beside the date, deliberately neutral: a paper-deep/mono status chip when a mode is on, a bare muted "Set mode" when it isn't. Home's one pine stays with the hero, because a mode is a *state*, not an action.
- **The `set_mode` Coach tool** (registered, confirmation-gated) plus the active mode in `get_today_snapshot`, so the Coach both sees and can change the day's context.

Headless coverage: `db/modes.test.mjs`, 39 assertions, including the mid-day re-derive's preserve-work cases.

### ⚠️ Modes is OPEN for significant improvement (owner call, 2026-08-10)

**The spec above describes the intent. The build below it describes the mechanism. The owner has now used it on hardware twice and still finds it thin — so read the two together, not the spec alone.** This is the second round of the same feedback: the 2026-08-09 pass answered the first ("the modes switcher right now doesn't do much") by wiring three dormant levers, and it was not enough.

Where the shipped feature falls short of this section's own four-part promise:

1. **"The plan"** is a subtraction, not an adaptation. `dropTypes` removes a whole `LogEntryType` for the day and is used by exactly one mode (Sick → `workout`); `addItems` injects a fixed literal list. There is no "half the volume", no substitution, no interaction with the user's actual protocols. **Deload is the clearest case:** it drops nothing, so the planned workout lands exactly as written and the entire deload is a habit item that *tells you* to cut volume ~40%.
2. **"Priorities"** reaches one banner line above Home's hero (`modeDirective` → `ModeBanner`). Real, and the most visible thing a mode does — but it is a sentence, not a re-prioritisation.
3. **"The Coach's tone"** has exactly one consumer: `get_today_snapshot` hands `coachTone` to the model as `toneGuidance`. No app surface changes voice, so this lever only exists for a user who opens the Coach tab.
4. **"Adherence accounting"** is one Home line (`"3 skipped · excused under Sick"`) and nothing downstream. `log_entries` carry the mode in their extras and nothing ever reads it back — no "your adherence under Travel", no cost-of-Sick-days over a quarter.

Two capabilities this section specifies that the UI does not reach:

- **Duration.** The spec promises "just today, a date range, or on-until-turned-off", and `day_modes` (0026) supports all three. **The Home picker offers none of it** — it lists the six keys and calls `applyMode(key)` with no end date, so every mode set from Home is open-ended-until-changed. A trip or a deload week can only be ranged by asking the Coach's `set_mode`.
- **Custom.** "Your own context" currently means: no dropped types, no injected items, no `heroFocus`. `day_modes` has `label` and `note` columns for precisely this, and **`label` has no writer anywhere in the repo**. So the mode you were meant to define yourself is the one that changes nothing and cannot be named.

The full record, lever by lever, is in `docs/project-status.md` §1 › *Screens still to build* › **"Modes needs significant improvement"**. **The gap is conceptual, not mechanical** — every part above is built and tested. Switching mode reshapes a list and prints a banner; what the owner wants is for the day to genuinely *feel* different, which every other tab being mode-blind currently prevents. Worth deciding before building: whether a mode should be a **profile the user authors** — versioned, with its own items and rules, like a protocol — rather than a hard-coded registry entry. That is the shape the empty Custom mode is pointing at.
