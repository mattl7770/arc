# C7 — Nutrition readiness verdict, reworked

**Status: BUILT** (2026-09-14, merge `a1bddbd`). The owner set the band (**+20% optimal · +50% caution** while gaining, mirrored for cutting) and chose the **pace curve**; what shipped — the projected end-of-day ratio, the protein lift, the quiet timezone day — is recorded in `docs/nutrition-subapp.md` §12f. This file stays as the reasoning behind it.
**Migration:** **none** — the one new stored fact rides `users.preferences`, a JSON column that already exists (`db/migrations/0001_init.sql:55`).
**Citations verified against `main` at `950c846`.** `main` moves several times a day; if a line number below misses, the surrounding quote is the anchor.
**This is the item most likely to need the owner's answer.** The questions in §6 are the ones that decide the design, not details of it.

---

## 1. Current state

### Where it lives

```
src/lib/home/readiness.ts:258-365    the Nutrition pillar
src/lib/home/readiness.ts:556-561    how deriveReadiness calls it
src/lib/home/readiness.ts:602        the Pillar it produces
src/components/home/readiness-strip.tsx:102-128,145-151   how it draws
db/readiness.test.mjs:554-650        what is pinned today
```

The pillar was reworked once already, on 2026-08-14, away from `mealCount > 0 ? 'good' : 'unknown'` — *"a fact about whether the app was opened"* (`readiness.ts:259-265`). What replaced it is the thing the owner is now calling out.

### The two rules the owner is complaining about, in code

**(1) "It only triggers late in the day."**

```ts
export const NUTRITION_DAY_CLOSE_HOUR = 20;            // readiness.ts:75
```

and the open-day branch of `nutritionVerdict` (`:338-353`):

```ts
// Day still open — only completed facts may grade it.
if (kcalTarget !== null && kcalTarget > 0 && totals.kcal > kcalTarget * KCAL_CEILING_RATIO) { … }
if (protein === 'optimal') { … }
return { level: 'unknown', note: `${nutritionProgressNote(totals, targets)} · day in progress` };
```

Before 20:00 there are exactly **two** ways to get a grade: eat more than `1.1 × kcal target` (`KCAL_CEILING_RATIO`, `:288`), or have already met the protein target. Every other state — including every ordinary day — falls through to `unknown` (`:352`). The pillar therefore shows a page-coloured mark and an em-dash for most of its waking life (`readiness-strip.tsx:135-143`), and the only two things that *can* fire before 20:00 are a large overshoot and a met protein target.

The reasoning is stated and it is not stupid (`:74`, `:304-310`): *"a day at 11am is not a failed day, and grading it as one is the same error as calling one logged meal 'good'."* It is right about the failure mode and wrong about the only alternative being silence.

**(2) "It doesn't take into account my full goal (currently, exceeding my calorie goal is a good thing)."**

```ts
/** Intake vs target → level. Symmetric: far UNDER is as wrong as far over. */
export function kcalLevel(ratio: number): SignalLevel {    // readiness.ts:267-274
  const off = Math.abs(1 - ratio);
  if (off <= 0.1) return 'optimal';
  …
}
```

`Math.abs` is the entire complaint. A bulking day at **2,800 against a 2,400 target** — a good day — grades `good` at best and, at 3,200, `poor`. Worse, the ceiling rule at `:340-345` fires at 2,640 and prints `"240 kcal over target already"` at 11am, which frames a *goal being met* as a completed fault.

**There is nowhere in the schema or the preferences that records which direction the owner is going.** `nutrition_targets` (`db/migrations/0015_nutrition_targets.sql:26-44`) has `kcal`, four macro columns, `created_by` and a free-text `notes`. No direction, no band, no phase.

### What else it does, and does well — none of which should be lost

- **No targets → `unknown`, and it names the fix** (`:317-320`, `'no daily targets set yet (Eat › Targets)'`). `nutrition_targets` deliberately seeds no default row, so this is the honest first-run state (`0015`).
- **Nothing logged → `unknown`, and it reads differently once the day has closed** (`:321-323`).
- **Day closed → `worse(kcal, protein)`** (`:333-337`), the same `worse()` every other pillar uses (`:94-98`) — *"so a hit protein target cannot paper over a 900-kcal overshoot"* (`:308-310`).
- **The note carries real denominators** (`nutritionProgressNote`, `:356-365`): `1,420 / 2,300 kcal · 94 / 180 g protein`, only for the halves that have targets.
- **`proteinLevel` is already one-sided** (`:280-285`) — *"overshooting a protein target is not a failure, so there is no upper band."* The asymmetry C7 needs for calories already exists for protein; it just was never generalised.

### One thing that lowers the risk of this whole item

`deriveReadiness`'s top-line verdict is `worse(recovery, sleep)` (`:611`). **Nutrition does not feed it.** Whatever this pillar does, the headline "Primed / Ready / Back off today" is unaffected — only the third cell of the strip and its note change.

### What is pinned today, and would have to be rewritten

`db/readiness.test.mjs:554-650`, six blocks: no-targets → unknown; 11am under target → `unknown` + `'day in progress'`; 40% over at 11am → `poor` + `'800 kcal over target'`; protein met at 13:00 → **`optimal`**; a closed day on target → `optimal`; a closed half-eaten day with protein met → `poor` (worst-of); an empty day. **Four of the six assert behaviour this proposal deliberately changes.** That is a real cost and it is named here rather than discovered at the gate.

---

## 2. The owner's words

> *"It provides almost no value right now; it only triggers late in the day and doesn't take in account my full goal (currently, exceeding my calorie goal is a good thing). It needs a rethink and a rework."*
> — `docs/backlog-2026-09.md:41`

Three distinct claims: **no value** (it is `unknown` most of the time), **only late** (§1, rule 1), **doesn't know the goal** (§1, rule 2). All three are true of the code as written.

---

## 3. Proposed design

### 3.1 The goal direction — a preference, and no migration

```
users.preferences.goals.direction  ∈  'cut' | 'maintain' | 'gain'
```

`users.preferences` is `text NOT NULL DEFAULT '{}' CHECK (json_valid(preferences))` (`db/migrations/0001_init.sql:55`), and a `goals` section already exists there, holding the hydration target: `getWaterTarget` / `setWaterTarget` (`src/lib/db/repositories/user.ts:193-250`) read and merge `obj.goals` while preserving unrelated keys. Two new functions in exactly that shape:

```ts
export function getGoalDirection(db: Database): GoalDirection;   // defaults to 'maintain'
export function setGoalDirection(db: Database, d: GoalDirection): void;
```

Defaulting to `'maintain'` is the **no-change default**: `maintain`'s bands are today's symmetric `kcalLevel` (§3.3), so a user who never opens the setting sees the goal-direction half of this change do nothing at all.

**Set where the numbers are set** — `app/nutrition-targets.tsx`, a three-way chip row above the kcal field, each chip ≥44pt, outlined, label voice, the treatment `Other ways to log` wears (`app/nutrition.tsx:597-606`). It is not a Settings item: it qualifies the targets, and it belongs beside them.

**The trade-off, stated because the hydration goal already stated it.** The docblock above `getWaterTarget` (`user.ts`, immediately preceding `:192`) works through exactly this choice: `nutrition_targets` is versioned and immutable *"so a past day can be judged against the era it was lived in"*, whereas a preference is live, *"so raising it re-judges the history against the new number. For one user reading their own record that is the more useful reading, and it costs no migration — but it is a real trade-off."* The same words apply here, with one addition: a direction changes far less often than the numbers it qualifies, and when it does change the owner is usually *also* changing the numbers, which writes a new `nutrition_targets` version anyway. *(This is owner question 1.)*

**Not derived.** The obvious alternative — infer the direction from the kcal target against TDEE — dies on the fact that ARC has no TDEE. Inventing one would be the "no data, no number" breach (`docs/design-research/implementation/00-design-spec.md:171`).

### 3.2 Grading progressively — the expected-by-now curve

Replace the binary `now.getHours() >= 20` (`readiness.ts:560`) with a **pace** model:

```ts
/** The share of the day's target a normal day has taken by this hour. */
export function expectedDayFraction(now: Date, boundaryHour = 0): number;
```

Anchors, linearly interpolated, and they are **the specification** — retuning means coming here and saying so, the discipline `strainLevel`'s ladder already sets (`readiness.ts:160-175`):

| local hour | expected share | why |
| --- | --- | --- |
| ≤ 08:00 | 0.00 | before breakfast nothing is expected; the denominator is 0 and there is no grade |
| 10:00 | 0.15 | breakfast is in |
| 13:00 | 0.40 | lunch is in |
| 16:00 | 0.55 | the afternoon is flat |
| 19:00 | 0.85 | dinner is in |
| ≥ 21:00 | 1.00 | the day is closed |

The grade is then `pace = eaten / (target × expectedDayFraction(now))`, run through the direction-aware bands of §3.3. Two consequences:

- **The pillar transmits from about 10:00** instead of 20:00. That is the "only triggers late in the day" complaint, answered.
- **Below 08:00 it is honestly `unknown`** — `expectedDayFraction` is 0, there is no denominator, and the note says so: `nothing expected yet — the pace clock starts at 08:00`. Manufacturing a grade there would be the same invented-denominator error the tab's own hero refuses (`src/lib/nutrition/remaining.ts:9-18`).

**The curve is an assumption and must be said out loud.** It assumes a three-meal day with lunch around one and dinner around seven. The note therefore always names the pace it is judging against (§3.5), so a 16:00 fast day reads *"behind the usual pace by this hour"* rather than a bare `caution` the owner has to reverse-engineer.

**B3 is a dependency and this is where it bites.** `docs/backlog-2026-09.md:29` — the configurable day boundary — changes what "today" and "this hour" mean. `expectedDayFraction` takes `boundaryHour` precisely so that when B3 lands the curve rebases on the owner's day rather than on midnight; until then it is 0 and the anchors are wall-clock local. Building C7 before B3 is fine; building it *without the parameter* is not.

### 3.3 Direction-aware bands

`kcalLevel(ratio)` becomes `kcalLevel(ratio, direction)`, and its `Math.abs` splits into two tolerances. Each row is `[optimal, good, caution]` as closed intervals on the ratio; outside the caution interval is `poor`.

| direction | optimal | good | caution |
| --- | --- | --- | --- |
| `maintain` | 0.90 – 1.10 | 0.80 – 1.20 | 0.70 – 1.30 | *(identical to today's `kcalLevel`)* |
| `cut` | 0.85 – 1.02 | 0.75 – 1.10 | 0.65 – 1.20 |
| `gain` | 0.98 – 1.20 | 0.90 – 1.35 | 0.80 – 1.50 |

Worked, at the day's close, against a 2,400 kcal target:

| eaten | ratio | cut | maintain | gain |
| --- | --- | --- | --- | --- |
| 1,700 | 0.71 | caution | caution | poor |
| 2,150 | 0.90 | optimal | optimal | good |
| 2,400 | 1.00 | optimal | optimal | optimal |
| **2,800** | **1.17** | **caution** | **good** | **optimal** |
| 3,200 | 1.33 | poor | poor | good |
| 3,700 | 1.54 | poor | poor | poor |

The bolded row **is the owner's sentence made arithmetic**: the same day is a fault while cutting, unremarkable while maintaining, and the best possible reading while gaining.

Two judgment calls inside that table, both deliberate:

- **`gain` is not unbounded.** A 3,700-kcal day on a 3,000-kcal bulk is a binge, not a bulk, and a pillar that says `optimal` to anything above target has stopped being an instrument. The line is drawn at +50%. *(Owner question 2.)*
- **`cut` still punishes a large shortfall.** A 40% deficit is not a good cutting day. The band is *wide below and tight above*, not one-sided.

`proteinLevel` (`:280-285`) needs no direction — it is already one-sided in the right direction for all three goals — but it does need looser bands on **pace**, because protein is legitimately back-loaded (dinner, then a shake). Against the pace ratio: `≥0.85 optimal · ≥0.65 good · ≥0.45 caution · else poor`, versus the day-end `≥1.0 / ≥0.85 / ≥0.7` it keeps for a closed day.

### 3.4 Weighting: protein, calories, and "the rest"

**Keep `worse()`.** It is the rule every pillar and the top-line verdict use (`:94-98`, `:611`), and a weighted average would let a met protein target paper over a 900-kcal miss — the thing `:308-310` explicitly refuses. One change:

> **A protein target already met (against the DAY target, not the pace target) floors the pillar at `good`. It does not raise it to `optimal`.**

Today that case returns `optimal` outright (`:346-351`), which is how "protein met at 13:00 with 1,200 of 2,400 kcal" currently reads as the best possible day. The floor keeps the honest half of that rule — a met target is a completed fact and cannot be undone by the afternoon — without letting it hide the calorie half. *(This changes `db/readiness.test.mjs:611-619`, which asserts `optimal`.)*

**Carbs, fat and fiber are not graded, and this is the "the rest" answer.** They can carry targets (`0015:31-33`), and `unguardedNote` already tracks all four macros on the Eat tab (`src/lib/nutrition/remaining.ts:120-126`). But a four-way `worse()` reads `caution` on almost every real day, because hitting four bands simultaneously is not a thing people do — and a pillar that is always amber is a pillar nobody reads. Calories are the *budget*; protein is the *floor*; the rest is **composition**, which belongs on the Eat tab's bars (C6) where it can be seen without being judged. Fiber has an additional disqualification already recorded: it is summed from meal items, so a manually-entered meal contributes none by construction (`app/nutrition.tsx:121-124`, `remaining.ts:32-37`).

### 3.5 Saying in words what it graded

The pillar already prints its note in every state — `{ label: 'Nutrition', level: nutrition.level, note: nutrition.note }` (`readiness.ts:602`), unlike Sleep and Recovery which print one only when `unknown` (`:575-585`, `:590-600`). Notes are grouped by text and rendered at serif 11px `ink-muted` (`readiness-strip.tsx:145-151`). So the plumbing exists; only the sentence changes.

`nutritionProgressNote` (`:356-365`) grows a second clause — **what it graded, and against what**:

| state | note |
| --- | --- |
| before 08:00 | `nothing expected yet — the pace clock starts at 08:00` |
| 11:00, on pace, gaining | `500 / 2,400 kcal · on pace for a gaining day` |
| 13:00, behind | `640 / 2,400 kcal · about 320 behind the usual pace by now` |
| 13:00, protein lagging | `52 / 180 g protein · 20 g behind by this hour` |
| 21:00, over on a bulk | `2,800 / 2,400 kcal · 400 over, which is the point while gaining` |
| 21:00, over on a cut | `2,800 / 2,400 kcal · 400 over target` |
| no targets | `no daily targets set yet (Eat › Targets)` *(unchanged, `:319`)* |

Three rules for that copy: it names the **direction** whenever the direction changed the reading; it states the pace as a **number of calories**, never as a percentage of a curve nobody can see; and it never apologises. Same register as `strainNote` (`:245-256`), which names *the input that decided the level* rather than the larger of two.

### 3.6 The shape of the function

`nutritionVerdict` takes an inputs object, the way `strainVerdict` does (`readiness.ts:183-234`) — so the curve, the clock and the direction are all injectable and the whole thing stays pure and headless-testable:

```ts
export type NutritionInputs = {
  totals: NutritionTotals;                 // unchanged (:290)
  targets: NutritionTargets | null;        // unchanged (:291)
  direction: GoalDirection;                // from preferences, default 'maintain'
  expected: number;                        // expectedDayFraction(now, boundaryHour) ∈ [0, 1]
};
export function nutritionVerdict(inputs: NutritionInputs): { level: SignalLevel; note?: string };
```

`deriveReadiness` (`:560-565`) reads `getGoalDirection(db)` and computes `expected` from the `now` it already has (`:488`). No new database read on the hot path beyond the one `getOrCreateUser` call the preferences accessors already make.

### 3.7 Model / prompt changes

**None.** This pillar is deterministic by design — *"no model call; the Coach interprets, this derives"* (`readiness.ts:6-7`). Both Coach ceilings are untouched: `db/coach-eval.test.mjs:651` (9,250, tool schemas) and `:657` (3,700, system prompt).

One downstream note: the pillar and its text reach the Coach through `turn-context.ts`, so the note's new wording arrives in the Coach's per-turn context block — which sits **after** the cache breakpoint (`src/lib/ai/model-client.ts:262-267`) and so cannot invalidate the cached prefix. A slightly longer note costs a handful of uncached tokens per turn and nothing else.

### 3.8 The tests that would pin it

`db/readiness.test.mjs` §10 is **rewritten**, not extended — four of its six blocks assert behaviour this changes. The replacement:

1. `expectedDayFraction`: 0 at 07:00, 0.15 at 10:00, 0.2333 at 11:00 (the interpolation), 0.40 at 13:00, 1.0 at 22:00. With `boundaryHour = 4` (B3), the same shape rebased.
2. **The direction table of §3.3, asserted row by row** — twelve cases, three directions × four ratios, including the bolded 2,800/2,400 reading `caution` / `good` / `optimal`.
3. **Default is `maintain`, and `maintain` reproduces today's `kcalLevel` exactly** for the ratios `db/readiness.test.mjs` already uses. The no-change default, asserted.
4. 500 kcal of 2,400 at 11:00 grades **`good`** (pace 0.89) instead of today's `unknown` + `'day in progress'`. *The "only triggers late" complaint, asserted as a number.*
5. Below 08:00, any intake, any direction → `unknown` + the pace-clock note. No manufactured grade.
6. Protein met against the DAY target, calories 50% short, at 13:00 → **`good`, not `optimal`** (the floor, §3.4).
7. 2,800 of 2,000 at 11:00 stays `poor` on `cut` and `maintain` — the ceiling still fires (the existing block at `:598-607`, preserved) — and does **not** fire on `gain` below the over-band.
8. No targets / nothing logged / empty-day-open vs empty-day-closed: the existing assertions at `:575-583` and `:640-648`, preserved verbatim. These are the parts that were already right.
9. The note names the direction whenever the direction changed the reading, and never otherwise (the `strainNote` discipline, `:236-244`).
10. `db/screens-render.test.mjs`: the targets screen renders the three direction chips with one selected.

---

## 4. Three verdict models, with their trade-offs

### Model A — **Pace band** *(recommended)*

Direction-aware bands + the expected-by-now curve + `worse(kcal, protein)` with the protein floor. Everything above.

- **For:** answers all three of the owner's claims. Deterministic, pure, no model call, no migration. Transmits from ~10:00. Reuses `worse()`, `proteinLevel` and the note plumbing that already work.
- **Against:** the curve is an assumption about how he eats, and a legitimately unusual day (a fast, one huge late dinner, a travel day) reads `caution` in the afternoon and recovers by evening. The note explains it, which is a mitigation and not a fix.

### Model B — **Ceiling and floor only**

Keep today's rule — grade only what is a completed fact at any hour — and make it direction-aware. The ceiling becomes the direction's over-band instead of a flat 1.1×; the protein floor stays.

- **For:** the smallest possible change, and the most conservative. Nothing is ever graded on an assumption. Fixes "exceeding my goal is a good thing" completely.
- **Against:** **does not fix "only triggers late in the day"**, which is the first half of the complaint. The pillar stays `unknown` most of the day for exactly the reasons it is today.

### Model C — **Runway**

Stop grading before the day closes. Instead the pillar reports what is *available*: `880 kcal and 60 g protein left — about two meals`. Grade only after close, with direction-aware bands.

- **For:** the most ARC-ish reading. It answers Home's actual question — *"what should I do right now"* (CLAUDE.md §5) — rather than scoring the past, and it matches the Eat tab, which already leads with what is left (`app/nutrition.tsx:56-58`). Never makes an assumption about pace.
- **Against:** it breaks the strip's shape. Four cells, four verdicts, each with a mark and a condition word (`readiness-strip.tsx:102-128`); a cell with no verdict has to print *something* in the condition slot, and anything it prints (`on track`, `ahead`) is a verdict arrived at by a hidden rule. It also duplicates the Eat tab rather than adding to it.

**Recommendation: A, with C's language folded into A's note.** The bands are what the owner explicitly asked for, the curve is what makes the pillar exist before dinner, and the note can carry the runway sentence — *"640 / 2,400 kcal · about 320 behind the usual pace by now"* is already half a runway reading, and `880 left, about two meals` can be the clause that follows it on an under-pace day. That gets Model C's usefulness without giving the cell two jobs.

---

## 5. Alternatives considered *(beyond the three models)*

| Alternative | Why not |
| --- | --- |
| **A `goal_direction` column on `nutrition_targets`** (a migration) | Honestly the better *modelling* — the direction qualifies the numbers and should version with them, so March is judged as March. Rejected for this round because the backlog expects no migration here, the direction changes far less often than the numbers, and a direction change is usually accompanied by a target change that writes a version anyway. **Offered as owner question 1(b)** — if he wants versioned history this is a 20-line migration and it should be taken now rather than later. |
| **Infer the direction from weight trend** (losing → cutting) | Plausible and quietly wrong: a bulk that is not working looks exactly like maintaining. It would also make the pillar's judgement change under him without him doing anything, which is the "silent black-box auto-adjustment" the sub-app rejects (`docs/nutrition-subapp.md:89`). |
| **Let the Coach grade it** | The module's first line is *"no model call; the Coach interprets, this derives"* (`readiness.ts:6-7`). Home must render offline, instantly, with no key — a model-graded pillar would be blank on a plane. The Coach already interprets this pillar through `turn-context.ts`. |
| **A weighted score** (0.6 × calories + 0.4 × protein) | Produces a number nobody can act on, and it is exactly the paper-over `:308-310` refuses. `worse()` is the house rule for a reason. |
| **Grade carbs, fat and fiber too** | §3.4. A four-way `worse()` is amber every day. |
| **Raise `NUTRITION_DAY_CLOSE_HOUR` to 22 and leave the rest** | Makes the "too late" problem worse, and does nothing for the goal direction. |
| **Drop the pillar entirely** and give the slot to something else | Tempting given *"almost no value right now"* — but the owner asked for a rethink, not a removal, and nutrition is the one pillar that reflects a decision he makes twenty times a day. |

---

## 6. Effort

| | |
| --- | --- |
| `getGoalDirection` / `setGoalDirection` in `repositories/user.ts` (the `waterMl` pattern) | 0.75 h |
| Direction chips on `app/nutrition-targets.tsx` | 1 h |
| `expectedDayFraction` + `kcalLevel(ratio, direction)` + the pace-band `proteinLevel` | 1.5 h |
| `nutritionVerdict` re-shaped to `NutritionInputs`; `deriveReadiness` wiring | 1 h |
| The note's second clause (7 cases) | 1 h |
| **Rewriting `db/readiness.test.mjs` §10** (10 blocks; 4 existing assertions change) | 2.5 h |
| The gate + a doc pass (`docs/data-model.md`, `docs/home-screen.md`) | 1 h |
| **Total** | **~1 focused day**, of which a quarter is rewriting tests that currently pass. |

**No migration, no native dependency, no EAS rebuild, no model call.**

**Depends on B3** (`docs/backlog-2026-09.md:29`) only for correctness of "this hour" under a non-midnight day boundary — `expectedDayFraction` takes `boundaryHour` from the start so B3 is a one-line wiring change when it lands, not a rewrite. **Interacts with C6** at one point: whether the Eat tab's bar may run past the target mark depends on whether over-target is good, which is this item's answer.

---

## 7. Questions only the owner can answer

**Q1. Should the goal direction be a live preference, or versioned with the targets?**
It decides whether last March is judged as March.

- **(a) A live preference** — `users.preferences.goals.direction`, no migration, one chip row on the targets screen. Changing it re-judges past days against today's direction. **← recommended.** It is the same trade the hydration goal already takes (`user.ts`, the docblock above `:192`), and for one person reading his own record the live reading is the more useful one.
- (b) **A `goal_direction` column on `nutrition_targets`**, versioned and immutable like the numbers it qualifies (a migration — the next free number at merge, **not** `0049`, which is C4's). Strictly better modelling; costs a migration and means changing your mind requires writing a new target version.
- (c) Both — the preference now, the column later if history ever matters. Two sources for one fact, which is how they drift.

**Q2. While gaining, where does "over target is good" stop being good?**
A 2,400 kcal target, and you eat 3,700.

- **(a) +20% is optimal, +35% is still good, +50% is caution, past that is poor.** **← recommended** — a 3,700-calorie day on a 2,400 target is a binge whatever the goal, and a pillar that says `optimal` to anything above target is not an instrument.
- (b) Never graded down. Over target is simply always good while gaining, however far over.
- (c) Tighter — +20% optimal, +35% caution. Treats a bulk as a *controlled* surplus.
- (d) You name the band yourself: a second number on the targets screen ("aim for 2,400–2,900"), and the pillar grades the band you typed. Most honest, most setup.

**Q3. Does the pillar grade progressively against an assumed eating curve, or stay silent until the day closes?**
This is the "only triggers late in the day" half, and it is the biggest call here.

- **(a) Model A — pace.** It assumes a normal day is ~15% eaten by 10:00, ~40% by 13:00, ~85% by 19:00, and grades against that, naming the assumption in words. Transmits from mid-morning; a fast or a late-dinner day reads `caution` for a few hours before recovering. **← recommended.**
- (b) Model B — ceiling and floor only. Grades only completed facts, direction-aware. Never wrong, and stays `unknown` most of the day — which fixes half your complaint and not the other half.
- (c) Model C — runway. Before the day closes the cell reports what is left (`880 kcal, ~2 meals`) rather than a verdict, and grades only after close. Most directive; it makes the nutrition cell a different kind of object from the other three.
- (d) A — but with anchors you set yourself, once, on the targets screen (roughly when you eat). Removes the assumption; adds a setup step you will do once and never revisit.
