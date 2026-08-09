# Information Architecture — where everything lives

**Decided 2026-07-25** (owner review). This maps every feature in `docs/project-status.md` §1 to a home in the app, specifies the Log tab, and defines the Modes model. Read alongside `docs/home-screen.md` (Home detail) and `docs/decisions.md` (the ADR).

The shell is **five tabs** — Home · Coach · Log · Data · Settings — plus **stack-pushed sub-screens** (Nutrition, Exercise, the metric keypad, Protocols editor, Labs import, etc.) reached from within a tab. Not everything is a tab; deep domains are pushed screens.

## Feature → destination

| Tab | What lives here |
| --- | --- |
| **Home** | Today's Mission, hero, readiness, brief, live metrics · designed states (travel/sick/data-gappy/first-run) · **Mode control** (see below) · proactive/predictive nudges surfaced · upcoming preventive screenings surfaced |
| **Log** | Command + voice field (**free notes** + parse) · 6 quick-add tiles · **metric keypad** drill-in · today's recent entries. Two tiles are gateways to sub-screens (Nutrition, Workout → Exercise). |
| **Coach** | Chat + daily brief · real model + RAG + tools · proactive corrections / evening accountability · n-of-1 experiments · predictive-alert generation · correlations & insights · Coach research · voice/vision input · conversation history |
| **Data** *(view + manage hub)* | Biomarker trends & optimal ranges · **Labs** (Function PDF import + results) · wearable history · body composition + **progress-photo gallery** · **Protocols editor** · **preventive screenings + medical calendar** (browse) · environment & lifestyle · genetics/cognitive (later) · **browsable knowledge base** · **progress reports** |
| **Settings** | **App lock** (Face ID) · **provider/model/API-key** · **integrations** (Apple Health read, smart-bottle hydration, Apple Health write-back) · **backup/restore + recovery phrase** · **data export** · profile (DOB/sex/timezone/units) · about |
| **Sub-screens** (pushed) | **Nutrition** (from Log/Meal) · **Exercise** (from Log/Workout) · **metric keypad** (from numeric tiles) · Protocols editor (from Data) · Labs import (from Data) |

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

### Nutrition & Exercise (sub-app screens) — real as of 2026-07-25
Built out from the mockups and wired to the on-device DB. **Nutrition:** manual meal entry → `meals` table (0002); "Today" sums kcal + macros, "Eaten today" lists the day. Photo/text logging, templates, micros, and (2026-08-08) **recipes + the grocery list** have all shipped — the recipes/grocery family (`recipes` · `recipe-detail` · `recipe-edit` · `recipe-import` · `grocery`) pushes from the Nutrition hub's Kitchen rows (`docs/recipes-grocery.md`); pantry stays deferred. **Exercise:** live/past session logging (`app/workout-log.tsx`) → `workouts` + `workout_sets` (0003); week summary + recent sessions read live. Growing into templates, the fuller workout builder, VO₂max/mobility metrics, progressive-overload analytics. The **Supplement/Therapy capture sheet** is also real (one-tap quick-log + manual add → ad-hoc `log_entries`). All cross-link from Data (history/trends) later.

### Symptom logging (Log tab, 2026-07-25)
A **"Log a symptom" row** on the Log tab (kept separate from the routine quick-adds — it's a "something's off" capture, not a daily log) opens `app/symptom.tsx`: common-symptom chips, a 1–10 severity, an optional note → the `symptoms` table (0004). Surfaces in "Logged today"; the Coach correlates it against protocols/labs/wearables. Voice/NL symptom capture arrives with the Coach (Phase 3).

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
