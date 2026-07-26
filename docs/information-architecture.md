# Information Architecture — where everything lives

**Decided 2026-07-25** (owner review). This maps every feature in `docs/project-status.md` §1 to a home in the app, specifies the Log tab, and defines the Modes model. Read alongside `docs/home-screen.md` (Home detail) and `docs/decisions.md` (the ADR).

The shell is **five tabs** — Home · Coach · Log · Data · Settings — plus **stack-pushed sub-screens** (Nutrition, Exercise, the metric keypad, Protocols editor, Labs import, etc.) reached from within a tab. Not everything is a tab; deep domains are pushed screens.

## Feature → destination

| Tab | What lives here |
| --- | --- |
| **Home** | Today's Mission, hero, readiness, brief, live metrics · designed states (travel/sick/data-gappy/first-run) · **Mode control** (see below) · proactive/predictive nudges surfaced · upcoming preventive screenings surfaced |
| **Log** | Command + voice field (**free notes** + parse) · 6 quick-add tiles · **metric keypad** drill-in · today's recent entries. Two tiles are gateways to sub-screens (Meal → Nutrition, Workout → Exercise). |
| **Coach** | Chat + daily brief · real model + RAG + tools · proactive corrections / evening accountability · n-of-1 experiments · predictive-alert generation · correlations & insights · Coach research · voice/vision input · conversation history |
| **Data** *(view + manage hub)* | Biomarker trends & optimal ranges · **Labs** (Function PDF import + results) · wearable history · body composition + **progress-photo gallery** · **Protocols editor** · **preventive screenings + medical calendar** (browse) · environment & lifestyle · genetics/cognitive (later) · **browsable knowledge base** · **progress reports** |
| **Settings** | **App lock** (Face ID) · **provider/model/API-key** · **integrations** (Apple Health read, smart-bottle hydration, Apple Health write-back) · **backup/restore + recovery phrase** · **data export** · profile (DOB/sex/timezone/units) · about |
| **Sub-screens** (pushed) | **Nutrition** (from Log/Meal) · **Exercise** (from Log/Workout) · **metric keypad** (from numeric tiles) · Protocols editor (from Data) · Labs import (from Data) |

**Deferred placement calls (revisit as they grow):**
- **Protocols** sits in Data for now. It's central (it drives the mission), so it's the leading candidate to graduate to its own sub-app screen like Nutrition/Exercise did.
- **Preventive screenings + calendar** — browsable in Data; Home surfaces what's *due* ("colonoscopy in 3 weeks").
- **Knowledge base** — browsable in Data; the Coach also reads it as its RAG corpus.

## The Log tab — direction A ("Open Line")

Chosen from a two-round design study (`ARC Log tab` artifacts; the six round-2 fusions are the reference). Capture works in **three layers**, each holding what matches its frequency:

1. **Command / voice field (hero, top).** The catch-all: free-text or spoken **notes** (a log with no metric bucket, written for the Coach to read), plus natural-language parse of structured entries. The fast path — "ate eggs + oats, 45g protein" logs in one line without opening a sub-screen.
2. **Quick-add tiles (3×2).** The high-frequency structured captures. Two kinds:
   - **Quick-capture** → a lightweight sheet or the keypad: **Supplement · Water · Weight · Therapy**.
   - **Gateway** → pushes a full sub-screen: **Meal → Nutrition**, **Workout → Exercise**.
3. **Metric keypad (drill-in).** Single-number entry as a calibrated instrument: big mono readout, keypad, and metric chips (**Weight · Body-fat % · Waist · HRV · Resting HR · Dose**). Reached by tapping Weight (or Water); other body numbers switch via the chips.

**Not tiles, on purpose:** notes/voice live in the hero field; other body numbers live in the keypad chips; **Medication/peptides** fold into the Supplement sheet as a type toggle (they're usually part of a protocol stack); **habits** are completed on Home's mission, not re-logged here.

### Nutrition & Exercise (sub-app screens)
Placeholders now, built out later. **Nutrition:** food logging by photo / text / manual, meal templates, macros/micros, grocery list, pantry, recipe bank, CAL-AI-style photo analysis. **Exercise:** workout builder, set/rep logging, Zone 2 / VO2max / mobility / balance metrics, progressive-overload tracking. Both are reachable from the Log tiles now and cross-linked from Data (history/trends) later.

## Modes

A **mode** is how ARC handles a day that isn't normal — the concrete form of "support imperfect days gracefully" (CLAUDE.md §5, `docs/home-screen.md`). You declare the context once and the day adapts, instead of the app showing the standard plan and marking half of it missed. A mode changes **four things**:

1. **The plan** — which mission items appear and their targets (Sick pulls training, adds rest/hydration/immune; Travel swaps in a circadian-adjustment routine + a portable supplement subset; Deload cuts volume).
2. **Priorities** — what the "Do this next" hero pushes (Social → "eat earlier / hydrate / cap it," not "hit your macros").
3. **The Coach's tone** — evidence-based but context-aware (Sick → recovery talk, no nagging about the missed workout; Social → harm-reduction, not adherence guilt).
4. **Adherence accounting** — a skipped workout in Sick mode is **excused, not a miss**; the streak/score isn't punished for doing the right thing.

**The set:** Normal (default) · Travel · Sick · Deload · Social · Custom.
**Duration:** just today, a date range (a whole trip), or on-until-turned-off.
**Where:** the **Home** screen — a quiet control near the date/status, because a mode is a fact about *today* set in the moment (landing in a new city, waking up sick); burying it in Settings would add friction exactly when it's needed. A small persistent indicator shows the active mode so it's never silently on; setting it visibly re-derives the mission and re-tones the brief.
**Data model (later — the override model doesn't exist yet):** a mode on the day (a field on `daily_logs`, or a small `day_modes` table for ranges) plus mode-specific protocol variants the mission generator reads. Recorded now because Protocols and the mission generator must accommodate it when they're built.
