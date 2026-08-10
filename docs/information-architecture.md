# Information Architecture — where everything lives

**Decided 2026-07-25** (owner review), **shell revised 2026-08-09** (owner call on hardware — see "The tab bar" below). This maps every feature in `docs/project-status.md` §1 to a home in the app, specifies the Log tab, and defines the Modes model. Read alongside `docs/home-screen.md` (Home detail) and `docs/decisions.md` (the ADR).

The shell is **six tabs** — Home · Coach · Log · Eat · Train · Data — plus **stack-pushed sub-screens** (Settings, the metric keypad, Protocols editor, Labs import, etc.) reached from within a tab. Not everything is a tab; deep domains are pushed screens.

## Feature → destination

| Tab | What lives here |
| --- | --- |
| **Home** | Today's Mission, hero, readiness, brief, live metrics · designed states (travel/sick/data-gappy/first-run) · **Mode control** (see below) · proactive/predictive nudges surfaced · upcoming preventive screenings surfaced |
| **Coach** | Chat + daily brief · real model + RAG + tools · proactive corrections / evening accountability · n-of-1 experiments · predictive-alert generation · correlations & insights · Coach research · voice/vision input · conversation history |
| **Log** | Command + voice field (**free notes** + parse) · 6 quick-add tiles · **metric keypad** drill-in · today's recent entries. Two tiles are gateways to Nutrition and Exercise — which are now also tabs; see "The tab bar". |
| **Eat** | The nutrition hub (`app/nutrition.tsx`, re-exported by `app/(tabs)/eat.tsx`): today's intake vs targets, meal logging, the food catalog, templates, micros, history. |
| **Train** | The exercise hub (`app/exercise.tsx`, re-exported by `app/(tabs)/train.tsx`): train-today recommendation, muscle freshness, weekly volume, programs, routines, recent sessions. |
| **Data** *(view + manage hub)* | Biomarker trends & optimal ranges · **Labs** (Function PDF import + results) · wearable history · body composition + **progress-photo gallery** · **Protocols editor** · **preventive screenings + medical calendar** (browse) · environment & lifestyle · genetics/cognitive (later) · **browsable knowledge base** · **progress reports** · **the row into Settings** (last on the sheet) |
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

**Known cosmetic seam:** `app/nutrition.tsx` and `app/exercise.tsx` still open with `<StackHeader>`, which draws a back chevron. As tab roots that chevron works — the tab navigator runs `backBehavior="history"`, so it returns you to the tab you came from — but a back control is the wrong grammar for a tab root, where every other tab owns a plain serif title. One line in each of those two files.

**Deferred placement calls (revisit as they grow):**
- **Protocols** sits in Data for now. It's central (it drives the mission), so it's the leading candidate to graduate to its own sub-app screen like Nutrition/Exercise did.
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

**Order, top to bottom:** folio line + title → the **Labs import stamp** (this screen's one accent, and the only directive thing on it) → **Trends** → **The full file** → **Biomarkers** → **Settings**.

**Why Biomarkers moved below the index.** The catalogue is **66 markers** (`src/lib/labs/catalog.ts`), and every one of them is drawn. Before a lab import that is 66 rows of em-dash sitting between the two sections you actually navigate with — and it would have buried the new Settings row entirely.

**Folding.** Trends, The full file and Biomarkers each fold; the import stamp and the Settings row do not. Rules that govern it:

- **Defaults are per-section, and chosen from row count.** Trends (4) and The full file (8) open — together about a screen and a half, which is the tab as it should first read. Biomarkers (66) starts **folded**: until a report is imported it has nothing to say that its own tally does not say better.
- **A folded section still states what it holds.** Each header carries a mono tally that is true in both states — `2 of 4 tracked`, `5 of 8 built`, `0 of 66 measured`. Each tally is derived from the same array its section renders, so header and rows can never drift. (This is why the Biomarkers note is now always the full ratio and never the old "No readings yet" — that string hid the fact that 66 rows were waiting inside.)
- **Folds go both ways.** One toggle (`!open`) with `accessibilityState.expanded` on the header. A one-way fold on Home was a real bug; the shape that caused it — a separate "expand" affordance with no inverse — is what this avoids.
- **Fold state is NOT persisted, deliberately.** `users.preferences` (the pattern behind unit choices, the app lock, Apple Health) holds things the user *sets* — durable statements about how the app should behave. A fold is a momentary "not now" about one screen. Persisting it means a tap from three weeks ago silently hides the tab's headline with nothing on screen to explain why, plus a DB write per chevron. The state that actually matters — fold, drill into a trend, come back — already survives, because tab screens stay mounted for the session. A cold start resets to the defaults above, which are the defaults *because* they are the right first read.
- **The fold chevron is `ink-muted`, never the accent.** Data's one accent is the import stamp; a fold control is chrome.

**Settings at the foot.** One always-drawn row, last on the sheet, pushing to `app/settings.tsx`. Not foldable and not tucked inside another section — it is exactly as findable as "scroll to the bottom of Data", which is what the owner asked for. Neutral ink like every other row here. Precisely — and line 86 already has this right: Data spends **one** accent, its budgeted primary action, on the lab-import stamp, and nothing else; Settings carries none anywhere in the app. (This sentence read "Data is a reference surface with zero accent" until 2026-08-10. The code has never done that and the spec never asked for it — §2's budget allows one primary action per screen and singles out Settings alone for zero.)

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
