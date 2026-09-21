# C6 — Nutrition readability

**Status: BUILT, 2026-09-14** (`claude/c2-c6-nutrition`). Approved and implemented as proposed, with the owner's three answers taken as recommended: §6 Q1 **(a)** the bar stops at the mark, Q2 **(a)** all four readings, Q3 **(a)** macros replace the item count. What shipped, the measured contrast table and what only a device can judge are recorded in `docs/nutrition-subapp.md` §12h; this file stays as the reasoning behind it.

> **PARTLY OVERRULED ON THE DEVICE, 2026-09-21** (`claude/fb-bars`). The owner, on the build that shipped this: *"colors for nutrition bars are hard to see, should be more colourful."* Two of this spike's decisions are reversed — **§3.1's 4px geometry** (now 6px, with a 3px terminator) and **§3.2's accent-only colour**, the restraint §4 argued for at length on firewall grounds. The bars are now filled with the **signal palette, graded by `macroGrade`** against the same bands the Home pillar uses, so the colour is the day's verdict rather than decoration. This spike's reasoning is left standing as written: it was correct about the rule, and the exception is narrow and recorded beside the rule itself in `docs/project-status.md` §3. What actually shipped is `docs/nutrition-subapp.md` §12h, *"OVERRULED on the device"*. One prediction of §3.2 survived and is worth noting — it warned that hue alone cannot carry a state on this sheet, and the four signal ink cuts turn out to be near-isoluminant too (4.17–4.56:1 against one ground), which is why the label's word and the mono figures stay exactly where they were.
**Migration:** **none.** Every number this proposal draws is already stored, already summed and already on the screen's props.
**Citations verified against `main` at `950c846`.** `main` moves several times a day; if a line number below misses, the surrounding quote is the anchor.

---

## 1. Current state

### The Eat tab draws exactly one bar, and on a normal day it is not drawn at all

```
app/nutrition.tsx:187-197   TargetRule
app/nutrition.tsx:483-485   the only call site
```

`TargetRule` is a 3px rail (`bg-paper-deep`) with a fill that is `bg-ink-secondary`, or `bg-ink` once `value >= target`, capped at 100% width. It is rendered **once**, under the kcal hero, and **only when `kcal.mode === 'eaten'`**:

```tsx
{kcal.mode === 'eaten' && kcal.target !== null ? (
  <TargetRule value={kcal.eaten} target={kcal.target} />
) : null}
```

`eaten` mode is the *fallback* mode. `dayFigure` returns `remaining` whenever a target exists and every meal on the day carries that metric (`src/lib/nutrition/remaining.ts:106-116`) — which is the ordinary, well-logged day. **So on the day the tab is working correctly, there is no bar anywhere on the screen.** That is the whole of C6's first half: the feature exists and is unreachable on a good day.

The stated reason is at `:183-186`:

> *"A square progress rule — drawn only under an EATEN reading, where a bar that fills as you eat agrees with the number above it. A remainder counts down, so it carries no rule: two opposite encodings of one quantity, adjacent, is the kind of mark §5 rules out."*

That reasoning is answered in §3.1, not ignored.

### The three macro cells have no bar at all, in any mode

```
app/nutrition.tsx:125-129   MACROS
app/nutrition.tsx:137-160   MacroCell
app/nutrition.tsx:494-500   the grid
```

`MacroCell` is three stacked texts: the mode label (`PROTEIN LEFT` / `PROTEIN OVER` / `PROTEIN`, label voice 11px, `:149-152`), the value (mono 20px, `:154`), and the denominator (`of 180 g`, mono 11px, `:157`). No rail, no fill, in either mode. Fiber is deliberately absent and the reason is good (`:121-124`).

### The shipped bar contradicts the sub-app spec

`docs/nutrition-subapp.md:130` says:

> *"Progress fills are ink-secondary; when a macro **meets** its target the fill turns pine — completion is what pine means."*

The code turns it **`bg-ink`**, not pine (`app/nutrition.tsx:192`). One of the two is wrong and has been for a while.

### The micros screen uses the same rail, twice

`app/nutrition-micros.tsx:159-161` and `:210-211` — `h-[3px] bg-paper-deep` with a `bg-ink-secondary` fill. Read-only, neutral, no pine, deliberately (`docs/nutrition-subapp.md:327`).

### A meal row's macros lose to its note

```
app/nutrition.tsx:200-259   MealRowItem
```

```tsx
const detail = meal.notes ?? [macros, itemCount > 0 ? `${itemCount} item…` : null].filter(Boolean).join(' · ');
```

`meal.notes ?? …` — **if the meal has a note, the macros are not drawn at all.** And AI-estimated meals always have a note, because the estimator's `notes` field is written straight onto the meal (`app/meal-estimate.tsx:395`). So the meals most worth inspecting are the ones whose macros are hidden.

When they are drawn, they come from `macroLine` (`src/lib/nutrition/format.ts:29-40`) — `"P 42g · C 30g · F 18g"` — at **12px mono `ink-secondary`** (`app/nutrition.tsx:243`), sharing one line with the item count. The row's trailing kcal is mono 15px (`:253`).

### Type scale in use on this tab today

| size | what |
| --- | --- |
| 36 (`text-4xl`) | the kcal figure (`:469`) |
| 26 | the tab title (`:429`) |
| 20 | a macro cell's value (`:154`) |
| 17 | an Over-time value (`:348`) |
| 16 | row names (`:230`, `:291`, `:337`) |
| 15 | the Photo/Describe labels (`:578`, `:586`), a row's kcal (`:253`) |
| 13 | prose and secondary labels (`:235`, `:290`, `:338`, `:518`, `:603`) |
| 12 | mono detail (`:226`, `:243`, `:294`, `:353`) |
| 11 | label-voice eyebrows and denominators (`:151`, `:157`, `:453`) |

**The tab's current floor is 11px.** The 9.5–10px metadata band is used elsewhere in the sub-app (`app/meal-detail.tsx:677`, `app/meal-estimate.tsx:717`, `:747`) but not here. The spec's floor is 9px rendered, with the metadata layer at 9.5–10px *"so the floor isn't load-bearing"* (`docs/design-research/implementation/00-design-spec.md:102`).

### The measured colour facts this proposal has to survive

Computed against the shipped palette (`src/constants/theme.ts:25-131`):

| pair | ratio |
| --- | --- |
| `pine` `#12454E` on `paper-deep` `#C6C1B0` (the rail) | **5.87:1** |
| `ink-secondary` `#443F30` on `paper-deep` | **5.83:1** |
| `ink` `#1C1911` on `paper-deep` | **9.74:1** |
| **`pine` against `ink-secondary`** | **1.01:1** |
| `pine` against `ink` | 1.66:1 |

**`pine` and `ink-secondary` are the same luminance.** A bar that switches from `ink-secondary` to `pine` at target changes *nothing* in greyscale, at a glance, or for a reader not perceiving hue. This is the identical defect the pillar cells were rewritten to fix — the four signal swatches sit at 1.06–1.59:1 of each other, *"so to anyone not perceiving hue they are one grey"* (`src/components/home/readiness-strip.tsx:64-70`). Hue cannot be the only carrier of the state change, and §3.2 does not let it be.

---

## 2. The owner's words

> **Nutrition readability** — *Macro stats more visible (bars / colours against targets) **and** more macro information per individual meal on the overview.*
> — `docs/backlog-2026-09.md:40`, and in his own phrasing during the interview: *"colors? bars that fill up?"*

Two requests, and they are separate: **(a)** the day's macros, drawn as filling bars against targets; **(b)** per-meal macros on the overview list. §3.1–3.3 answer (a), §3.4 answers (b).

---

## 3. Proposed design

### 3.1 A bar under the kcal figure and under every macro cell, in **both** modes

The reason the bar is withheld in `remaining` mode (`app/nutrition.tsx:183-186`) is that a countdown number over a filling bar would be *"two opposite encodings of one quantity"*. That is a real objection and the answer is that they are not two encodings of one quantity — **they are the two halves of one sentence, and the spec requires both halves to be present:**

- the **bar** draws `eaten` against `target` — it fills;
- the **number** states `left` — it counts down;
- the **denominator** (`of 180 g`) names `target`.

`eaten + left = target` reconciles on the cell, which is the ledger rule stated positively (`00-design-spec.md:168`: *"If the Today card says 2,180 kcal, the visible meals must add to 2,180"*). The screen is already making that claim in words — the tab's own docblock says the hero, the corner and the target *"reconcile on one line"* (`app/nutrition.tsx:57`). The bar is the picture of the term that currently has no picture.

So: `TargetRule` becomes **`MacroBar`**, drawn under the kcal figure **and** under each of the three `MacroCell`s, in `remaining` and `eaten` mode alike, whenever a target governs that metric. A metric with no target draws no bar — no denominators until targets exist (`00-design-spec.md:171`).

The geometry is pure and testable:

```ts
// src/lib/nutrition/bar.ts
export function barFigure(eaten: number, target: number):
  { fillPct: number; met: boolean }   // fillPct = min(100, eaten / target * 100)
```

Beside `dayFigure` (`remaining.ts:106`), pinned in `db/nutrition-remaining.test.mjs`.

### 3.2 Colour — the accent, never a signal, and never hue alone

**Progress against a target is BEHAVIOUR, so it takes the accent.** `00-design-spec.md:78` — the firewall — is explicit in both directions: *"Signal colours mark **biological state only**… Never interface chrome. Conversely the accent never marks biology."* A macro bar is a reading of what the owner did today, not of what his body is. **`bio-caution` on a carbs bar would be the breach the spec calls sacred**, and it would also be the "red numbers over target" the sub-app rejected on cited behavioural grounds (`docs/nutrition-subapp.md:90`, `:282`).

| part | token | measured |
| --- | --- | --- |
| rail | `paper-deep` `#C6C1B0` | unchanged from today |
| fill, under target | `ink-secondary` `#443F30` | **5.83:1** on the rail — clears WCAG 1.4.11's 3:1 for non-text |
| fill, at or over target | `pine` `#12454E` | **5.87:1** on the rail |
| the terminator (at/over only) | `ink` `#1C1911`, the rightmost 2pt of the rail | **9.74:1** on the rail; **1.66:1** against the pine beside it |
| height | **4px**, up from 3px | 3px is 9 device pixels at @3x and reads as a hairline; 4px still reads as a rule rather than a gauge |

**The terminator is the whole point of that table.** Because `pine` and `ink-secondary` measure **1.01:1** against each other, switching the fill's hue at target is, on its own, an invisible state change. So the completion state carries **three** cues, only one of which is hue:

1. **geometry** — a filled 2pt `ink` terminator appears at the bar's right end. It is a drafting mark: this measurement is closed.
2. **hue** — the fill turns pine, which is what pine means everywhere else in this app (completion stamps, `00-design-spec.md:80`).
3. **words** — the cell's label already flips `PROTEIN LEFT` → `PROTEIN OVER` (`app/nutrition.tsx:143-145`), and the hero already says `kcal over` (`:476-479`).

This also **settles the contradiction** between `nutrition-subapp.md:130` (pine at target) and the shipped `bg-ink` (`app/nutrition.tsx:192`) in favour of the spec — and explains why the code's `bg-ink` was not simply wrong: `ink` against `ink-secondary` is 1.66:1, a real if small luminance step, which is more than pine alone gives. The terminator keeps that step *and* gets the meaning.

**Overshoot still caps the fill at 100%** and the number keeps counting (`nutrition-subapp.md:130`). Adherence-neutral: no warning colour, no shame state. *(Whether the bar should be allowed to run past the target mark is owner question 1 — and it is really a C7 question, because whether "over" is good depends on the goal direction.)*

**Accent budget.** The tab's accent is the Photo/Describe pair, and the docblock at `app/nutrition.tsx:534-570` argues at length that two pine buttons are one claim. A pine bar fill is **not a fourth claim**: the budget counts *claims to being the next action*, and a filled bar is a **state mark**, the class the budget already admits by name (*"completion stamps"*, `00-design-spec.md:80`). In practice it is also rare — nothing is pine until a target is met, so a normal morning has zero pine bars and an evening has one or two. **Flag for the device pass:** four bars plus two buttons is the most pine this screen has ever carried, and it is the one thing here that cannot be judged off a desktop.

### 3.3 The Today grid, redrawn

The `Block device="grid"` is unchanged — `GridCell` keeps drawing the rules between cells and there is no outer box, because the grid *is* the object (`00-design-spec.md:24`, `app/nutrition.tsx:99-107`). What changes is inside a cell:

```
PROTEIN LEFT          ← label voice, 11px, unchanged (:149-152)
86                    ← mono 20px, unchanged (:154)
of 180 g              ← mono 11px, unchanged (:157)
▬▬▬▬▬▬▬▬▬░░░░         ← NEW: MacroBar, 4px, mt-1.5
```

and under the hero:

```
780  kcal left        ← unchanged (:468-481)
▬▬▬▬▬▬▬▬▬▬▬▬▬░░░▮     ← MacroBar, now drawn in remaining mode too
1,620 of 2,400 kcal   ← the corner, unchanged (:169-181)
```

**What a tap does:** nothing new. The bar is not a control. The one tappable thing in this block stays the corner, which opens the targets editor (`:442-458`), and the `Set daily targets` control that retires once satisfied (`:511-522`). Adding a tap to a bar would create a second route to the same screen — *"two invitations to the same screen is one too many"* (`:167-168`).

**What it says back (VoiceOver):** the bar is decorative relative to the cell's own text and takes `accessibilityElementsHidden`; the cell already speaks the same fact in words. Drawing a bar that VoiceOver reads as "seventy-two percent" beside a number that says "86 left" would be two readings of one quantity — which is, for once, exactly the thing `:183-186` was right to worry about.

### 3.4 Per-meal macros on the overview

**The one-line fix first, because it is the larger of the two losses.** `meal.notes ?? …` (`app/nutrition.tsx:212-216`) means an AI-estimated meal — which always carries the model's note (`app/meal-estimate.tsx:395`) — shows **no macros at all**. The row becomes two lines under the name rather than one:

```
08:40   Greek yogurt, berries, walnuts                         420
        Dressing not visible; estimate assumes none.        ← notes, serif 13px (unchanged)
        P 31g    C 28g    F 19g                             ← NEW, always, when macros exist
```

**Aligned cells, not a joined string.** The three macros sit in fixed-width mono cells so they form **columns down the day** — protein is scannable at a glance, which is what "more macro information per meal" actually buys. A record is a table (`00-design-spec.md:21`), and a table's value is its columns.

**The width arithmetic, because this is where it either fits or it does not.** Inside `Screen`'s `px-5` gutter (`src/components/ui/screen.tsx:296`) and the plate's `px-3.5` (`src/components/ui/block.tsx:151`), a row is `375 − 40 − 28 − 2 = 305pt` on a 375pt phone. `MealRowItem` spends `w-12` (48pt) on the time, two `gap-3`s (24pt) and ~45pt on the trailing kcal, leaving **188pt** for the body. Three cells at 52pt = 156pt — fits, with 32pt spare for a three-digit carb figure.

On a 320pt device the body is 133pt and the cells do not fit. The fallback is one line and no new code: `macroLine(meal)` (`src/lib/nutrition/format.ts:29-40`) joined, `numberOfLines={1}`, which is what is drawn today. Worth stating that **today's 12px line already overflows at 320pt** for a three-digit meal (24 chars × ~7.2pt = 173pt > 133pt), so this is a pre-existing condition the proposal narrows rather than creates.

**Size: 11px, and the 10px floor is deliberately not spent.** The metadata band is 9.5–10px (`00-design-spec.md:102`) and it is for *labels, captions, timestamps*. **A macro the owner has just asked to see more of is not metadata** — it is the row's second measurement. 11px keeps the tab's existing floor (§1) and drops the strip one step below today's 12px, which is what buys the column widths above. Mono, because they are measurements (`00-design-spec.md:87`). `ink-secondary` — 9.46:1 on the plate's `paper-hi`.

**No bar on a meal row.** Four gauges per row, twenty rows deep, and the plate stops being a table and becomes the data dump CLAUDE.md §5 exists to prevent. The bars live in the Today grid, where there is one set of them and they answer the day's question. **This is the boundary of C6's second half** and it should be written down: per-meal gets *numbers*, the day gets *bars*.

**The item count.** It shares today's line with the macros and cannot share the new one at 320pt (adding `3 items · ` costs 10 characters, ~66pt). It is not lost either way — it already appears on `meal-detail`'s `Items` label — but removing visible copy needs sign-off (the standing rule behind backlog item A9). *That is owner question 3.*

### 3.5 Model / prompt changes

**None.** C6 touches no model call, no prompt and no token budget. `db/coach-eval.test.mjs:651` (9,250) and `:657` (3,700) are untouched, as is the estimator prompt (~296 prose tokens, `src/lib/nutrition/estimate.ts:127-153`). Recorded explicitly so the merge note does not have to re-derive it.

### 3.6 The tests that would pin it

1. `barFigure(1620, 2400)` → `{ fillPct: 67.5, met: false }`; `barFigure(2400, 2400)` → `met: true`; `barFigure(2800, 2400)` → `{ fillPct: 100, met: true }` — the cap; `barFigure(0, 2400)` → `0`; `target <= 0` never reaches it (`dayFigure` already refuses a non-positive target, `remaining.ts:113`).
2. `db/screens-render.test.mjs`: the Eat tab with targets set and a fully-counted day renders **four** bars — the regression that currently ships as zero.
3. Same suite: a meal carrying **both** a note and macros renders both strings. *This is the silent loss in §1, asserted.*
4. Same suite: a meal with NULL macros renders no macro strip and no fabricated zeros (`macroLine` already returns null — `format.ts:39`).
5. A meal with only protein recorded renders `P 31g` and nothing for carbs or fat — absence is an absence, not a `0`.
6. The bar is absent for a metric with no target, with the eaten figure still drawn (`00-design-spec.md:171`).
7. Contrast is documented here, not asserted in code — the numbers in §1 and §3.2 are the record, in the same form `theme.ts:66-70` and `:114-123` keep theirs.

---

## 4. Alternatives considered

| Alternative | Why not |
| --- | --- |
| **Rings / donuts** | *"No rings. A goal ring is a gamified gauge; ARC's equivalent is a thin horizontal track"* — `docs/nutrition-subapp.md:129`. A ring is also a worse shape for scanning four metrics in a row. |
| **Signal colours on the bars** (green on target, amber under, red over) | The firewall, `00-design-spec.md:78`. It is also the "red numbers over target" the sub-app rejected with cited reasoning (`nutrition-subapp.md:90`, `:282`) — and it would be actively wrong for C7's gaining case, where over target is a good day. |
| **Keep the bar out of `remaining` mode** (today's rule) | It means the bar never appears on a well-logged day, which is the complaint. §3.1 answers the objection rather than overruling it. |
| **Hue alone for the completion state** (`ink-secondary` → `pine`) | Measured at **1.01:1**. It is not a state change; it is a change nobody can see. The same lesson `readiness-strip.tsx:64-70` already paid for. |
| **A bar per meal row** | Four gauges × twenty rows. CLAUDE.md §5, and the plate stops being a table. |
| **Percent-of-target per meal** ("this meal was 24% of your protein") | A derived number nothing acts on, and it changes retroactively when the target changes. Grams are the fact. |
| **Macros at 10px to buy width** | 10px is the metadata band (`00-design-spec.md:102`). Spending the floor on the thing the owner asked to see *more* of is backwards. |
| **Thicker bars (6–8px)** | Crosses from rule into gauge. `00-design-spec.md:99-100`: layering is borders and the paper triad; a fat filled bar is the one thing on this sheet that would read as a widget. |

---

## 5. Effort

| | |
| --- | --- |
| `barFigure` + `MacroBar` (rail, fill, terminator) | 1 h |
| Wire into the hero and the three `MacroCell`s, both modes | 1 h |
| Reconcile `nutrition-subapp.md:130` with the code, and record which won | 0.25 h |
| `MealRowItem` two-line body + aligned cells + the narrow fallback | 2 h |
| The 6 tests + the gate (`typecheck · lint · format:check · db:test · expo export ios`) | 1.5 h |
| **Total** | **~half a day.** |

**No migration, no native dependency, no EAS rebuild, no model call.** The cheapest item in this set, and the one whose result is most visible on the owner's phone on the next OTA.

**Sequencing:** C6 is independent of C4 and C5 (different files). It **interacts with C7** at exactly one point — whether the bar may run past the target mark depends on whether over-target is a good day, which is C7's goal direction. If C7 lands first, C6 inherits the answer; if C6 lands first, the bar caps at 100% and gains the overrun later.

---

## 6. Questions only the owner can answer

**Q1. When you go over a target, does the bar run past the mark, or stop at it?**

- **(a) Stop at the mark.** The fill caps at 100%, turns pine, gains the terminator; the number above says `12 OVER`. **← recommended for now** — it is adherence-neutral, and how far past is "too far" is C7's question, not this one.
- (b) Run past it, up to ~125% of the rail, with a tick where the target was. More honest as a picture; it makes every bar's scale 125%, so a bar at target looks four-fifths full on a good day.
- (c) Stop at the mark, and add a second short pine segment *below* the rail for the overrun. Drawable, and it is a second mark to learn.

**Q2. Bars on all four readings, or only the macros?**

- **(a) All four — the kcal hero and the three macro cells.** **← recommended.** Calories are the reading you look at first; leaving it as the only bare number would be odd.
- (b) The three macro cells only, leaving the 36px kcal figure to stand alone as the screen's one unadorned headline.
- (c) The kcal hero only (today's design, just fixed so it actually appears). Least change, and it answers *"macro stats more visible"* least.

**Q3. On a meal row, macros **and** the item count, or macros instead of it?**
They do not both fit on a narrow phone (§3.4).

- **(a) Macros replace the item count.** The count still appears on the meal's own screen. **← recommended** — the count told you how the meal was entered, not what was in it, and you asked for what was in it.
- (b) Keep both, joined on one line, truncated when it does not fit (`3 items · P 31g · C 28…`). Nothing is removed; the macros get clipped on exactly the meals with the most of them.
- (c) Keep both on separate lines — notes, macros, count. Three metadata lines under a meal name, and the ledger stops being scannable.
