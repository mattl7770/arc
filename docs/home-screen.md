# Home Screen Information Architecture

**Status:** Target design — Foundation phase  
**Principle:** The home screen exists to answer one question extremely well:

> “What should I do right now, and what are the non-negotiables for today?”

Full data and exploration live in other tabs. The home screen must stay directive, calm, and fast.

---

## Layout (Top → Bottom)

### 1. Top Status Bar (persistent)
- Current recovery / readiness signal (color + short label)
- Optional: Biological age or aging velocity (small)
- Optional: Multi-pillar mini status (Sleep • Recovery • Nutrition • Strain)
- Date / day context

### 2. Hero Card — “Do This Next”
- Single highest-priority action right now
- Clear title + estimated time
- One-tap “Done” / “Snooze” / “Skip”
- Very short reason why (“Recovery is low — prioritize this”)

### 3. Today’s Mission
Ordered, dynamic checklist of the day’s non-negotiables.

**One chronological list — not category groups** (owner call, 2026-07-24). The day is sorted by scheduled time, top to bottom, so the order you read is the order you act. Grouping by category (Morning, Nutrition, Training…) was tried first and cut: it let a 21:45 supplement sit above an 08:00 breakfast, so the list order stopped matching the day, and the hero ("do this next") could point somewhere other than the top of the list. Category is now a **label on each row**, doing the identification work the section heading used to.

**Auto-collapse, not collapsible.** The one concession to a long day: the run of already-settled items at the very top folds into a single "N earlier today" line, so the list always opens at *now*. Tapping it expands them. This is the sanctioned reading of the PDF's "progressive disclosure", bounded by a hard rule — **disclosure may hide history, never work.** Anything still pending is always visible, *including things you're late for*; an item settled out of order also stays in place rather than folding, because hiding it would misrepresent where you are in the day. (This is the specific, bounded form of the "collapsible if needed" idea the earlier draft rejected outright — the rejection was of hiding pending work, which this doesn't do.)

Each item shows:
- Checkbox / completion state
- Scheduled time (mono), which is also the sort key
- Category label (Nutrition, Training, Supplements…)
- Short context or “Why” line (shown on the active item)
- Source protocol (if any)

### 4. AI Coach Daily Brief
- 3–6 sentence personalized summary
- Generated from last night’s data + today’s plan + longer trends
- Tone: calm, precise, slightly direct
- Tappable to open full chat

### 5. Minimal Live Metrics Strip
Only the highest-signal current numbers:
- Sleep last night (score + key stages)
- Current recovery / HRV context
- Steps or strain progress
- Next meal / hydration status (optional)

### 6. Quick Actions Dock — ~~cut 2026-07-24~~
Originally: log something, chat with Coach, override modes, jump to Dashboard. *(Modes themselves were retired on 2026-09-19 — see Status above.)*

**Removed** (owner call). Three of its four buttons — Log, Coach, Data — were the tab bar sitting two inches above itself, and the fourth (Mode) was inert. The home screen ends at the metrics strip. Mode override needs a real home when the override model exists; it is not a dock button.

---

## Behavioral Rules

- The checklist must be achievable. Ruthlessly prioritize.
- Incomplete items from earlier in the day should surface intelligently.
- Support “imperfect days” gracefully (partial credit, a status you declare).
- Everything on this screen should be completable or actionable in ≤ 2 taps when possible.
- Never turn this screen into a dashboard.

---

## States to Design For

- Perfect execution day
- Low recovery day
- Travel day
- Sick / deload day
- Data-gappy day (missing wearables or labs)
- First-time / onboarding day

---

## Implementation Notes (v1)

- Start with static + rule-based generation of the checklist
- Move to AI-generated / AI-adjusted “Today’s Mission” once core data flows exist
- Mock data is fine for the first visual version
- Measure time-to-clarity: user should understand what to do within 3 seconds of opening the app

---

## Implementation Status

**Shipped:** `app/(tabs)/index.tsx` renders five sections, and **every one of them is now real** — nothing on this screen is mock.

- **Mission** — reads from and writes to on-device SQLite (`src/hooks/use-today-mission.ts` → repositories in `src/lib/db/`), generated from the user's own active protocols (`mission-generate.ts`).
- **Readiness + pillars + metrics** — derived from `wearable_data` (`useReadiness` → `src/lib/home/readiness.ts`: 30-day baselines, a ≥5-day evidence gate, documented thresholds, and an honest "No recovery signal yet" when the data isn't there). Two of the four pillars read something other than a wearable: **Strain** grades ARC's own logged sets, and **Nutrition** grades the day's meals against the user's versioned targets (below).
- **Coach brief** — the deterministic insights engine (`useDailyBrief` → `generateDailyBrief`), so it is real even offline.

Components live in `src/components/home/`; the pure mission derivation (sort + fold + hero) is in `src/lib/home/derive-mission.ts`.

> **`src/lib/home/mock-day.ts` was deleted (2026-08-07).** It was the last mock on this screen, surviving as the "no protocols yet" seed — and it was actively harmful: it planted six invented protocol names into the user's real `log_entries`, **two of them pre-marked completed**, so a fresh install opened on work that had never happened and `get_today_snapshot` reported that invented work to the Coach as genuinely done. The day is now only ever the user's own protocols and their own entries — and, since 2026-09-19, not even a status changes that: nothing in the deterministic layer adds or removes a mission item any more. Devices that already ran the old build still hold the planted rows; purging them is an owner call.

**Section order revised (2026-07-24, owner decision — supersedes the Layout order above for v1):** only the **date eyebrow** sits above the hero, so the first real element on screen is the action. The readiness block (verdict + pillar **segment bar**, option D from the mock-up round) moved **below** the hero as supporting evidence. Reviewed on a real device via the dev build.

**Shipped order:** date → hero → readiness → mission → Coach brief → metrics. Six sections became five when the quick actions dock was cut.

**No horizontal rules between sections (2026-07-24, owner call, after device review).** The first build separated the date and the metrics strip with hairlines. On a real screen a rule above and below one short block closes a box around it, and the owner read all three as "weird little boxes". Sections are now separated by whitespace only. Hairlines remain correct for **card edges** and **row separators inside a list** (mission rows) — the distinction is that those enclose something that genuinely is one object, whereas a page-slicing rule just adds furniture.

Key design decisions:

- **The hero card is derived, not authored.** "Do this next" is the first pending mission item in time order, so completing it advances the screen automatically — the checklist and the hero can never disagree. This is what makes the screen directive rather than a static mockup.
- **The accent colour is reserved for the hero.** Everything else is neutral ink. Restraint is what keeps this from becoming a dashboard.
- **Pillars render as a segment bar** (`readiness-strip.tsx`): four slim signal-coloured segments with labels beneath — more scannable than dots, still not a chart.
- **Chronological, with history that auto-collapses.** The mission is one time-sorted list (see §3); the only thing that ever folds is the run of already-finished items at the top, so the screen opens at *now*. Pending work is never hidden. `deriveMissionView` owns the sort and the fold; the list is dumb.
- **An empty day is stated, not disguised.** When the mission has no items, the hero slot renders `src/components/home/mission-empty.tsx` and the Mission section is omitted entirely — rather than the hero's "Today is handled" (a lie on a fresh install) or a "0 of 0" progress bar over nothing. Two variants: *no active protocols* → "Today has no plan yet" → **Build your first protocol** (`/protocol-edit`); *protocols exist but expand to nothing today* → "Your protocols put nothing on today" → **Open your protocols**. It takes over the hero's pine slot, so the screen's one-pine budget is unchanged.

**Status — BUILT 2026-09-19** (migration `0061`, replacing the mode control that stood here from 2026-08-01; the full record is `docs/information-architecture.md` §Status). Home carries **two** things, which is the owner's Q5(c) answered as *both*:

1. **One mono line above the hero** — `Traveling since Sep 12 — skips excused · readiness baselines exclude 4 status days`. It takes the mode banner's place and deliberately not its shape: the banner was a `field` printing a DIRECTIVE a registry had written ("Recover: sleep, fluids, rest."), and that hardcoded clinical layer is exactly what the retirement removes. What is left is a FACT, so it takes the timezone line's register — mono, 11px, muted, zero height on every ordinary day. The last clause ESCALATES rather than accumulating: above zero excluded days it names the count; once the exclusion is what stopped Recovery grading it says *"no recovery verdict until it ends"* instead. Tapping it carries the re-ask to the Coach, seeded, so the second morning of a trip is two taps from a re-check.
2. **One small target beside the date**, in the label voice, opening the Coach rail's OWN five chips in a sheet (`src/components/home/status-control.tsx` → `src/components/status/status-rail.tsx`). Filled = something is on, outlined = nothing is — the vocabulary the mode chip established. It does NOT name the status, because the line three lines below already does, and the same fact twice is what CLAUDE.md §5 forbids. Five chips inlined on the folio row would be five controls competing with the one action this screen exists for; a door is one.

Home never sends a turn. A tap writes the `day_statuses` row FIRST and then carries the canned prompt to the Coach tab as a seeded `prompt` param — a status Home wrote that no prompt followed would be the old Modes failure under a new name. The write broadcasts (`src/lib/status/store.ts`), so the line and the readiness view both re-read: a sheet presented over Home never costs Home its focus.

**First-run state — BUILT 2026-08-07** (`mission-empty.tsx`, above). `useTodayMission` also gained `useFocusEffect(refresh)`, so creating a first protocol and coming back to Home fills the day immediately instead of waiting for a background/foreground cycle. ⚠️ **Verified by typecheck, lint and headless tests only — it has never been rendered on a device.** Per the project's standing rule (verify on device, not web), check it on hardware before calling it done.

**Travel / sick / injured** are handled by **Status**, not by bespoke Home states — see above. A **deload** is handled by neither: it is a change to the training plan, made with `update_protocol`, and never a status.

**Not yet built:** the **data-gappy** state. The Home brief IS status-aware as of 2026-09-19 — an excusing status short-circuits its cadence-nagging branch, because the brief is the one surface that would otherwise spend a sick day contradicting what the user just said. A NON-excusing status does not silence it: it excused nothing.

---

## The Nutrition pillar — direction-aware bands on a pace curve (C7, 2026-09-14)

The third cell of the readiness strip was the one the owner said had stopped earning its place: *"It provides almost no value right now; it only triggers late in the day and doesn't take in account my full goal (currently, exceeding my calorie goal is a good thing)."* Two complaints, both true of the code — before 20:00 exactly two things could produce a grade (a >10% overshoot, or a protein target already met), and the calorie band was `Math.abs`, so a bulking day at 2,800 on a 2,400 target read as a fault.

The design round is `docs/spikes/nutrition-verdict.md` (Model A, approved); the Eat-tab side of it — where the goal direction is set — is `docs/nutrition-subapp.md` §12f. **No migration**, no model call: this pillar stays deterministic, so Home renders it on a plane with no key.

### The two constants, which are the specification

**The bands.** Gaining: **+20% optimal · +35% good · +50% caution · beyond that poor**, and the mirror image for cutting (under target is the point, over it is the fault). Maintaining is symmetric and is *exactly* the band this pillar graded with before C7 — which is what makes `maintain` the no-change default for a profile that never opens the setting. The loose side is deliberately not unbounded: a 3,700-kcal day on a 2,400 target is a binge whatever the goal, and a pillar that says `optimal` to anything above target has stopped being an instrument.

**The pace curve.** How much of the day's target a normal day has taken by each hour: **~15% by 10:00 · 40% by 13:00 · 85% by 19:00**, with the day closed at 21:00, linearly interpolated and nowhere else. The pillar therefore **transmits from mid-morning** instead of from dinner — the first complaint, answered as a number: 500 kcal of 2,400 at 11:00 used to read `unknown / day in progress` and now reads a grade.

Both tables live in `src/lib/home/readiness.ts` (`KCAL_BANDS`, `PACE_ANCHORS`) and are pinned row by row in `db/readiness.test.mjs` §10. Retuning either means editing the table and saying so — the discipline `strainLevel`'s ladder already sets.

### What it grades, and why not the obvious thing

The number both halves are graded on is the **projected end-of-day ratio if the rest of the day goes to plan** — `(eaten + the share still expected) ÷ target` — and *not* `eaten ÷ expected-by-now`. The naive ratio has a tiny denominator in the morning and explodes: a 700-kcal breakfast at 10:00 is 1.94× the 360 kcal expected by then, which lands in `poor` in every direction. A 700-kcal breakfast is not a bad day; it is a breakfast. Measuring the gap as a share of the day's whole budget keeps one constant denominator all day, and at the close the expression collapses to plain `eaten ÷ target`, so the band table means exactly what it says about a finished day.

**Protein weighs alongside calories**, and the rule is one sentence in each direction: a **hit** protein target lifts a borderline calorie reading one step (`good` → `optimal`, `caution` → `good`) and cannot rescue a `poor` one; a **missed** one caps the pillar at protein's own level, via the same `worse()` every other pillar uses. Carbs, fat and fiber are not graded — a four-way `worse()` reads amber on nearly every real day, and composition belongs on the Eat tab's bars where it can be seen without being judged.

### The pillar says what it graded against

The note is a measuring sentence, not encouragement, and it always names the pace it judged: *"On pace — 1,140 of ~1,250 expected by 13:00"*. The `~` is not decoration — the expected figure is a point on an assumed curve, and once the day closes there is nothing approximate left, so the clause switches to the flat day figure. The direction is named **only when it changed the reading** (`strainNote`'s discipline): *"Over target — 2,800 of 2,400 kcal for the day · ahead of target, which is the point while gaining"*. So is protein, and only when it lifted or capped.

### The four states that are not a grade

- **Timezone changed today** → `unknown`, *"timezone changed today — not graded"*. A 31-hour day cannot be judged against a 24-hour target (`docs/spikes/timezone-days.md` §7 Q2(b): better quiet than clever). The marker itself is D4's (`0053`, another branch); the seam here is one predicate, `isTimezoneChangedDay(db, date)`, honestly false until it lands.
- **No targets set** → `unknown`, and it names the fix. Never an invented denominator.
- **Nothing logged** → `unknown`, reading differently once the day has closed.
- **Before 10:00** → `unknown`, *"nothing expected yet — the pace clock starts at 10:00"*. The denominator would be zero and a verdict built on it would be manufactured.

Every "now" here is the **local** clock measured against the **logical** day (`src/lib/db/date.ts`), so with a 04:00 boundary a 02:00 instant is the end of that day and not the small hours of the next.

**The design firewall is unchanged.** These are signal colours on a biological reading; the pillar takes `signal-*` exactly as it did, and the Eat tab's own bars (C6) take the accent. Nothing in this change touches the strip's drawing.

**Device-only:** the note is now up to three clauses and can run to two wrapped lines at 11px serif under a four-cell strip — the one thing typecheck and the headless tests cannot judge.
