# Architecture Decision Records (ADR)

## 2026-08-25 — Modes is removed; off-normal days belong to the Coach

**Decision (owner call, 2026-08-25):** the Modes feature — the six-key day-state switcher (Normal/Travel/Sick/Deload/Social/Custom) locked 2026-07-25 and built 2026-07-31/08-01 — is **removed**. No deterministic switch replaces it: an off-normal day is stated to the Coach in conversation, and the model adjusts its tone from the stated fact and reshapes the plan through the existing confirmation-gated `adjust_today`. The system prompt says exactly this and forbids nagging about a skip the user already explained.

**Context.** The owner used Modes on hardware and twice judged it thin — 2026-08-09 (*"the modes switcher right now doesn't do much"*, answered by wiring three dormant levers) and 2026-08-10 (still thin; both docs flagged the feature ⚠️ OPEN with the diagnosis "conceptual, not mechanical"). A full evaluation on 2026-08-25 argued four positions to a verdict — remove it · make modes user-authored versioned profiles · replace the registry with Coach-owned free-text day context · keep the registry and finish its reach into Train/Eat/history — each position adversarially critiqued. The evaluation's own recommendation was to keep a deterministic substrate and extend its reach; the owner heard it and chose removal. This ADR records the removal as decided, and the evaluation's findings as context for whoever revisits the territory.

**What was removed:** the Home mode chip + banner + picker (`src/components/home/mode-control.tsx`), `src/lib/modes/store.ts`, `src/hooks/use-mode.ts`, the six `ModeDefinition` behaviors (drop-types, injected items, `heroFocus`, `coachTone`), the mode intercepts in `planForDay`, the `set_mode` Coach tool (registry 43 → 42; both prompt-token ceilings gain headroom), the turn-context `Mode:` line, the `mode` object in `get_today_snapshot`, the system-prompt Modes doctrine, the deterministic brief's excusing-mode branch, and the seed guard's `modeChangesPlan`.

**What deliberately survives, and why:**

- **`rederiveMissionForDay`** — the preserve-work diff was built for mid-day mode changes but was never mode-specific; it is the machinery behind `update_protocol apply_today` and the empty-day recovery path. Its preserve-work test fence moved to `db/mission-generate.test.mjs`, driven by protocol edits.
- **History.** `day_modes` rows already on the device keep deciding how PAST days are judged: the reports adherence ledger still excuses a skip lived under Sick/Travel/Social, and "What changed" still names mode runs. The six keys' labels + excusal flags are **frozen** in `src/lib/modes/registry.ts` (now a read-only shim) — changing them would silently rewrite verdicts on days already lived, the same immutability rule protocol versions carry. `db/reports.test.mjs` exercises the ledger against raw historical rows.
- **Migration 0026 and the `day_modes` table** (forward-only numbering; the generic export dumps it with everything else).

**Migration 0043 is part of the decision.** Every mode ever set from Home was open-ended (`end_date` NULL), and the surface that could clear one is gone — a forgotten open-ended Sick row would otherwise keep excusing every future day's skips in reports, forever, invisibly. 0043 appends **one open-ended `normal` row at the removal date**: under the existing newest-covering-row resolution it out-ranks every earlier open-ended or future-scheduled row for all dates from the removal on, while covering no date before it — so history is untouched by construction. (`date('now')` is UTC; a west-of-Greenwich evening install can leave the local *today* resolvable to an old mode for a few hours. Accepted: the alternative could re-judge an already-lived local yesterday, and preserving history outranks a one-day shutdown lag.) The production ordering — rows planted before 0043, retirement applied by an app update — is asserted headlessly in `db/modes.test.mjs` §2.

**Consequences:**

- Home's folio line returns to the date alone; the default day renders exactly as before, since Normal always drew nothing.
- Already-generated mode items on the device (a pending "Rest — no training today") are ordinary rows; they age out with their day and are preserved like any other row if the day re-derives.
- **The streak stays blocked, for a new reason.** The old blocker ("modes excuse skips and nothing downstream reads it back") is moot, but with Modes gone there is no excusal mechanism for future days at all, so a streak would still punish correctly resting while sick. If one is ever wanted, excusal must be redesigned first — the evaluation's leading candidate was **per-item skip-with-reason** (a `skip_reason` in `log_entries.extras`: offline, retroactive-capable, finer-grained than day-blanket excusal). That design is recorded there, not decided here.
- The Coach path is online-only, and that trade was made knowingly: on an airplane-mode morning the plan no longer reshapes deterministically — the user edits the mission by hand or waits for connectivity. If this grates in practice, the evaluation's other positions are the map of the alternatives.

---


## 2026-08-12 — The recipe-source fetch exception extends to article URLs (knowledge import)

**Decision (owner sign-off, 2026-08-12):** knowledge import extends the 2026-08-08 user-initiated import-fetch exception from recipe sources to **article URLs**: single-shot, at import time only, the URL the user explicitly pasted or shared, **HTML text only**, never media, never background. Failure degrades to paste-the-text, which stays first-class UI.

**Reasoning — this is a widening of scope, not a new capability.** The mechanism is byte-for-byte the one already sanctioned: one GET, a 10-second abort, the page reduced to readable text and capped before it can reach a prompt (`pageTextForModel`, now shared out of `src/lib/html/readable.ts` rather than forked). Nothing personal leaves the device; it is the same request the user's browser would make opening the link they already have. What changes is only *which* URLs qualify, and an article URL is not a different kind of risk from a recipe URL — the recipe ladder's generic `website` rung already fetched arbitrary pages.

**Bounds, which are the decision.** Never in the background. Never polling. Never a second request — there is no redirect-chasing rung, no oEmbed variant, no embed fallback, because articles need none. Never media. And the fetched bytes are untrusted throughout: parsed defensively with plain string work, never executed, never stored (the page is discarded; only the entry the user approves is saved).

**Why sign-off was required before it shipped rather than after.** Without it the feature was still fully useful — paste-the-text plus the manual editor cover every article, with zero new network surface — so the URL rung was genuinely optional. That is the same "ship under a pending decision" posture the recipes ladder took, and it is what makes this an approval rather than a fait accompli.

**Anti-fabrication carries over unchanged, and is the sharper rule here.** An article import that cannot read the page returns `found:false` and routes to paste. It never writes an entry synthesized from a headline — third application of the rule, after the recipes Flavorish case and the labs "never fuzzy-match a biomarker name". The reason it bites harder for knowledge than for recipes: a fabricated recipe is discovered the first time it is cooked, and a fabricated *doctrine entry* outranks ARC's own reference in the Coach's search and is cited back as the user's committed stance.

---


## 2026-08-11 — WITHDRAWN: the three drafting devices never "stopped paying rent". They were never drawn.

**Decision: the 2026-08-09 ADR below is withdrawn in full.** `field`, `margin` and `grid` draw their marks again — the corner ticks, the margin rule, the rules between grid cells — and the sheet's boxes are restored everywhere the same sweep removed them. The Coach thread staying off the `well`, which was the unrelated second half of that ADR, **stands**: that one was an owner call on hardware and has nothing to do with what follows.

**The whole reason, in one paragraph.** The 2026-08-09 decision rests entirely on one sentence of owner feedback: _"there are some weird boxes and lines in some places, notably the metrics and coach brief on the home screen, but there are more."_ It read that as the surface system failing to communicate — marks a viewer had to interpret before they helped, which §5 calls decoration. Now look at what the two named surfaces actually were. **The metrics** are `device="grid"`, whose cells drew `border-t border-hairline` and `border-r border-hairline`. **The coach brief** is `device="margin"`, which drew `border-l-2 border-hairline`. The third device, `field`, drew each corner tick as an 11×11 view carrying `border-l border-t border-ink-muted`. Every one of the three is a **one-sided border width against a whole-element border colour** — the precise pair identified in the 2026-08-10 ADR (§1a) as the shape React Native paints as a complete rectangle.

So the owner was not describing three devices that failed to communicate. They were describing three devices that **rendered wrong**, and they named the two worst offenders in the sentence that got quoted back as the justification for deleting them. A 2px margin rule came out as a box around the Coach brief. A 1px rule between two metric cells came out as a box around each metric. Two 11px corner brackets came out as two small boxes floating at opposite corners of the readiness block. _That_ is what "weird boxes and lines" means, and no argument about whether a bracket is self-explanatory was ever going to survive contact with the screen.

**This is the same bug and the same misdiagnosis as §1a below, one round earlier and against a different set of files.** §1a caught the plates; it did not occur to anyone that the three _unmarked_ devices had been deleted for the identical reason. The tell was there in that ADR's own text: it quotes the owner naming "the metrics and coach brief", which are not plates and were never part of the plate sweep, and it never asks why those two.

**How the marks are drawn now — filled views, never borders.** A background colour has no per-edge struct, no uniformity test and no bitmap path to fall off:

- **`field`** — `CornerTicks` draws each L as **two bars**, an 11×1 and a 1×11 sharing a corner, rather than one bordered square.
- **`margin`** — `Block` renders a row: a 2px `bg-hairline` column, then the content indented beside it. It cannot be a class on the container, so it is structural.
- **`grid`** — a new exported `GridCell` primitive owns the rules. It also retires by construction the trailing-rule bug the old CSS carried: the sheet's `nth-child(odd)` gives the left column a right-hand rule, so an **odd** number of cells rules off the last one into empty space. `GridCell` conditions the vertical on a cell actually _following_, not on the column.

**Also restored in the same pass, all of them the sheet's own marks that the sweeps took:**

- **The Log tab's quick-add tiles are boxed again** and the block is a `plate`. It was marked `device="grid"` in the port, which was never right — the sheet puts `.cf-tilegrid` (a `gap: 7px` grid of closed `1px` boxes) inside a plain `.cf-block`, and `.cf-tilegrid` is not `.cf-dims`, so the selector that strips the plate off a metric grid never matched it. The tiles then inherited the metric grid's cell rules, drew as boxes, and the fix chosen was to delete the rules _and_ reject the sheet's boxes on the ground that "it puts a drawn enclosure inside `device='grid'`". The premise was false: it was never a grid. Gateway tiles (Nutrition, Workout) carry the sheet's chevron again.
- **The `Set up` / `Later` tag boxes on the Data index** (`.cf-lrow-tag`), removed with "a border around one word encloses nothing" — another rule invented mid-sweep.
- **The hatched cap** (`.cf-card--accent::before`): a 3pt accent/ink barber hatch over the top edge of every accent card. This one was never removed — it was never built. It is the loudest drafting mark in the set and most of what separates "a card with a coloured border" from "a drawing that has been stamped". It ships as an opt-in `cap` prop on `Block` because the sheet is opt-in about it: `.cf-card--accent` carries it, `.cf-hero` is a separate class with the same accent border and no cap.
- **No new dependency for any of it.** The hatch is an `overflow: hidden` band with rotated filled bars inside — there is no `expo-linear-gradient` in this project and adding one would force a fresh EAS cloud build.

**One live instance of the original bug was still shipping** and is fixed: `app/coach-memory.tsx` ruled both its lists with `border-t border-hairline-soft`. It was missed by the 58-site sweep because that screen predates the Conformed Set entirely and rules in the _soft_ hairline, so a grep for the standard token walked past it.

**The lesson, and it is now the second time it has cost a round of this project.** From `paperGrid` (`src/constants/theme.ts`), where an opacity was tripled to compensate for a layer that was not rendering at all: **establish that a thing draws before concluding anything about how it looks.** Four rounds of "weird boxes" produced three rounds of design changes, every one of them wrong, because nobody compiled the classes and asked what the platform did with them. A complaint about appearance on device is a _rendering_ question until proven otherwise. And when the reporter names specific surfaces, go and read what those surfaces are made of before generalising about the system they belong to.

**What is NOT restored, and why — so this does not swing the other way.** The presentation chrome stays out: no folio bars (`Log · SHEET L-01 · SCALE NTS`), no sheet numbers, no registration ticks. Those sit **outside `.cf-phone`** in the mockup's own markup, on the desk surround, and the mockup's CSS header says so itself; §5 forbids them independently ("no sheet numbers, tile keys, or designator badges inside the app that key no user action"). They are visible in any screenshot of the mockup, which makes them an easy thing to ask for — the answer is that they were never on the screen.

## 2026-08-11 — The Eat tab leads with what is LEFT, and the number is guarded

**Decision:** the Eat tab's hero is the day's **remainder**, not its total — and a remainder is computed **per metric**, rendered only when a target governs that metric **and** every meal logged today carries a value for it. Otherwise that metric falls back to the shipped eaten-with-denominator reading, and an authored line names what is missing. `src/lib/nutrition/remaining.ts` is the whole rule; `db/nutrition-remaining.test.mjs` pins it.

**Why the flip.** The owner's reading from the device (2026-08-10): *"it leads with a retrospective total… 'what am I short / what should this meal be' exists only as a `/ 140g` denominator on a 3px progress rule."* Opening the tab you are usually about to eat.

**Why the guard, which is the part that matters.** A day's totals **skip NULL by design** — `sumRounded` adds a meal's value or nothing at all, and the ledger row honestly renders an em-dash for a meal logged by name with no numbers. Eaten-so-far survives that; it is "what has been recorded", and the visible rows add to it. *What's left* does not: `target − incomplete sum` is too large by exactly the meals nobody measured, and it would print as a confident figure on the very day the screen below it admits it has no number. That is §5's *"no data, no number… never a plausible-looking estimate"*, and it is the one place this redesign could have shipped a lie. An empty day passes the test vacuously, which is right — with nothing logged, the whole target is what's left.

**Consequences.**

- The hero has two shapes, distinguished by the word beside it (`780 kcal left` / `1,620 kcal`), and the macro cells carry the mode in their **label** (`PROTEIN LEFT` vs `PROTEIN`) so a mixed grid is never ambiguous.
- **No progress rule under a remainder.** A bar that fills as you eat, drawn under a number that counts down, is two opposite encodings of one quantity — the mark is drawn only in the eaten fallback, where it agrees with the figure above it.
- **Fiber left the top grid.** It is summed from `meal_items`, so a manually-entered meal contributes none *by construction* and there is no per-meal column to test completeness against. It stays on the micronutrients screen, read against a reference rather than counted down.
- Over-target renders as `120 over` in the same ink as every other state. Adherence-neutral: no red, no streak, no badge.

---

## 2026-08-11 — The macro cells are boxed (an owner override of the `grid` device)

**Decision:** the three macro cells at the top of the Eat tab are drawn as boxes — `border border-hairline bg-paper-hi`, a 9pt gutter between them — while the kcal hero stays unboxed.

**Why, and by whom.** Owner instruction, 2026-08-11: *"maybe put boxes for the nutrition info at the top for now though"*, given in the same breath as *"lets make it all a bit more readable"* while the paper grid was being retuned separately. Small figures are what struggle against a textured sheet; a box gives them their own ground. The hero is exempt because at 36px it holds itself, and five boxes stacked would read as a slab rather than a set of readings.

**What it departs from.** `Block device="grid"` draws **nothing** — between-cell hairlines were cut on 2026-08-09 because an L of rules with no outer edge reads as a half-drawn box, and the owner has reported "weird boxes" four separate times. Four bordered cells abreast is close to the shape that was removed from Home in that same pass. **This is therefore an override, not a reinterpretation**, and it is recorded as one so the next person does not "fix" it back or cite it as precedent elsewhere.

**How to unwind it if hardware disagrees:** remove the border/fill from the cell class in `app/nutrition.tsx` and let the lifted type scale carry the legibility on its own. Nothing else depends on the boxes.

---

## 2026-08-11 — One `Log` button, and the entry-method chooser moves into a sheet

**Decision:** the Eat tab spends its single accent on one full-width button reading **`Log`**, which opens a full-screen modal (`src/components/nutrition/log-sheet.tsx`) holding every entry path: describe-or-photograph, add food, scan a barcode, from a template, cook a recipe, enter it manually.

**Why.** Owner, 2026-08-10: five parallel affordances in the tab's most valuable strip is *"an entry-method chooser, which is pushed-screen grammar"*. An intermediate round replaced them with a stamp plus a fold, which was the same menu one tap deeper; the owner's next call was blunter and better — *"condense all the logging into just one Log button… and tone it down on the word salad, just call the button 'Log'"*.

**Why a modal rather than a pushed route.** It matches the mode picker and the exercise picker, and it dismisses instead of stacking: logging a meal must never leave a back-stack entry pointing at a chooser. Because a `Modal` builds its own root it also prints its own `PaperGrid` — six surfaces in this app already had to learn that, and a seventh on blank stock would be visible immediately.

**What it bought.** ~150pt of the first screen, which is why Kitchen now reaches the fold on a three-meal day. **Cook a recipe** is new: logging from the book previously required opening the recipe first.

---

## 2026-08-08 — Recipes are first-class tables; one standing grocery list

**Decision:** recipes get their own tables (`recipes` + `recipe_ingredients`, migration 0031) rather than being modelled as protocol content or as an extension of `meal_templates`; and the grocery list is **one standing list** (`grocery_items` + a `grocery_name_prefs` memory table, 0032) rather than per-recipe lists or a per-trip document.

**Reasoning.** A template is *what I ate* — a snapshot to re-log. A recipe is *how to cook one batch*: it has servings, instructions, a source, and ingredient lines that are text first and resolved foods second. Forcing that into `meal_templates` would have meant a nullable half of every template row and a "kind" column doing the work a table should. Protocols were rejected for the same reason in the other direction: a protocol is a versioned intention, and a recipe is not something you adhere to.

**The ingredient model is the load-bearing part.** Each line keeps its **raw text as the source of truth**, with a parsed qty/unit/name overlay and an **optional, explicit** link to a catalog food — never fuzzy-matched (the labs rule: `Testosterone` is a substring of `Testosterone, Free`). Per-serving nutrition is computed only from resolved lines and is gated: `resolved = grams IS NOT NULL AND kcal IS NOT NULL`, enforced by a table-level `CHECK ((grams IS NULL) = (kcal IS NULL))`, and the screen says "not computed" rather than showing a partial sum as a total.

**One list, because that is how a kitchen works.** You do not keep a list per recipe; you keep a list, and recipes contribute to it. Check-off is **soft** (`checked_at`, cleared by hand) so history can feed autocomplete and staples, and consolidation is a **view** — `consolidatedOpenList` merges same-name lines for display and never destroys the member rows. That distinction is why the Eat tab counts `openGroceryLineCount` (lines drawn) rather than raw rows (which double when two recipes both want milk).

**Cooking a recipe logs through the existing meal path** (`logMealWithItems`), scaled from the recipe's own per-batch snapshots — never a live catalog read, so editing a food next month cannot rewrite what you ate last month (the 0018 snapshot discipline). Deleting a recipe `SET NULL`s `meals.recipe_id`: eating history outlives the book.

---

## 2026-08-08 — A third sanctioned network exception: user-initiated recipe-source fetches

**Decision:** at import time, and only then, the app may fetch **the URL the user explicitly shared or pasted** plus its derived oEmbed / embed-captioned variants, reading caption and metadata **text** only. This joins Open Food Facts (barcode lookup) and air quality as the third non-AI network exception in a local-first, offline-except-AI app.

**Reasoning.** The alternative is a proxy server, which the architecture forbids outright. The fetch is single-shot, user-initiated, and carries nothing personal — it is the same request the user's browser would make opening the link they already have. Every rung degrades: if the fetch fails or the page carries no recipe, the UI falls back to paste-the-caption and screenshot-vision, which must remain first-class paths rather than error states.

**Bounds, which are the decision.** Never in the background. Never polling. Never media downloads — no video, no audio, no images fetched for storage. And the App Store framing follows from that: this is "save recipes you were sent", not "download from Instagram", which is the canonical 5.2.3 rejection case.

**Anti-fabrication is doctrine, not a preference.** If the source does not contain the recipe, the import says so. It never generates a plausible recipe from a dish name and hashtags — the documented competitor failure (Flavorish), and the labs "never fuzzy-match" rule applied to food.

---


## 2026-08-10 — A rule needs an enclosure; and the paper grid goes to 0.20

Two calls from the same hardware pass, both about marks that were reasoned about in a browser and judged on a phone.

### 1. **A hairline separates rows only inside an enclosure. Unplated lists are separated by air.**

**Decision, stated so nobody has to guess again:** a `border-t border-hairline` between sibling rows is legitimate **only when those rows sit inside a `plate`**. When the plate comes off, the rule comes off with it. Nothing replaces it — the vertical padding the rows already carry *is* the separation.

**Why.** §4 of the spec is *"rules enclose objects, never pages"*. A rule between two rows of a plated list is the plate's own edge continued inward: it subdivides an enclosed object, which is what a rule is for. Strip the plate and the same stroke has nothing to subdivide. It terminates in mid-air at both ends and reads as a line someone drew on the sheet — exactly the "artefact, not structure" failure the 2026-08-09 ADR below was written about.

**This was already the practice in two of three places and needs to stop being a coin flip.** The de-plating sweep reasoned it out correctly and independently twice — `app/screenings.tsx` (*"with no plate to run between, a hairline here would close nothing and read as a stroke lying loose on the sheet"*) and `app/protocol-edit.tsx` (*"a rule separates rows inside an enclosure, and with the enclosure gone they are strokes floating on the sheet"*) — and then reasoned the opposite way in `app/settings.tsx`, whose "Not yet built" list kept an `index === 0 ? '' : 'border-t border-hairline'`.

**The interesting part is why nobody caught it.** That list holds **one** row. `index === 0` suppresses the rule on the only row there is, so **the screen rendered identically under both rules** and the disagreement was invisible on device — a trap armed for whoever adds the second row, who would have got a stroke that no other unplated list in the app draws. The conditional is now gone rather than left dormant — a rule that renders nowhere today is still a rule the next row inherits. (An earlier draft of this ADR added "it was also a dynamically-built class name, which this codebase does not do." That was wrong and is struck: a ternary **selecting between two complete literal class strings** is the house pattern, used throughout, and is safe — Tailwind's scanner sees both literals in source. What the codebase bans is interpolating a class **fragment**, `` `text-${x}` ``, because the assembled name never appears in source for the scanner to find. The `settings.tsx` conditional was the safe kind; it was removed for the enclosure reason above, and only for that.) Fixed in `app/settings.tsx`; `screenings.tsx` and `protocol-edit.tsx` were already conformant.

**How to apply it:** if you are adding a rule between rows, find the `plate` it belongs to. If there isn't one, you want spacing, not a stroke.

**Correction, same day.** The rule above survives, but two of its three worked examples do not, because §1a — the plate rule they were derived alongside — has been withdrawn (below). `app/settings.tsx`'s "Not yet built" list is plated again and its rows are ruled again; `app/screenings.tsx`'s horizon notes are back inside a plate and ruled. Only `app/protocol-edit.tsx` remains an unplated, unruled list, and it is unplated for the nesting reason in §1a rather than for anything in this section. Read this section as *"a rule needs an enclosure"* and nothing more — it is not, and never was, an argument for removing enclosures. Note also that the rule must now be drawn with `Divider`, not with `border-t border-hairline`: the latter renders as a full rectangle on React Native (§1a).

### 1a. **WITHDRAWN — "a plate encloses a multi-row record; no plate around one row or an empty state" was never a real rule.**

**This section previously asserted a plate rule and used it to strip `<Block device="plate">` off roughly twenty screens over three rounds. The rule was invented by the agents doing the sweeping, the owner rejected it outright — *"All the wrong boxes were removed, bring them back!"* — and every plate it removed has been restored.** The original text is not preserved: it was three rounds of increasingly confident rationalisation for a change nobody asked for, and leaving it in the record would keep teaching it.

**What actually happened.** The owner reported *"weird boxes and lines"* from hardware four times. Each round, an agent read "boxes" as a design complaint, went looking for enclosures that could be argued away, and swept plates off screens — first the empty branches, then single rows, then message screens including `mission-empty.tsx`, the first thing a fresh install draws. Each round made the app read *worse*, and the reports kept coming, which was the signal that the diagnosis was wrong and was misread as a signal that the sweep had not gone far enough.

**The real cause, settled by a screenshot plus a compiled-CSS check.** Rows written as

```tsx
className={index === 0 ? '' : 'border-t border-hairline'}
```

render as a **complete rectangle** on device — a line on all four sides — not as a top divider. `.border-t` compiles to `border-top-width: 1px` alone and `.border-hairline` to a colour alone. In CSS that pair is one line. React Native resolves it into per-edge width and colour structs, and a row that is uniform in colour but *not* uniform in width falls off the CoreAnimation fast path onto a generated border bitmap that paints all four edges. A plate (`border border-hairline`, uniform on all four sides) never goes near that path. The screenshot shows it exactly: plates fine, the first row of each list clean, every row below it boxed.

**So the plates were never the problem, and the design was never the problem.** A plate encloses a record; that is the Conformed Set working as specified. The correct fix is at the divider, not the enclosure — see the `Divider` / `VerticalDivider` primitives in `src/components/ui/block.tsx`, which draw a filled 1px view instead of a one-sided border.

**Restored:** `app/(tabs)/data.tsx` (Settings row), `app/(tabs)/log.tsx` (symptom row), `app/+not-found.tsx`, `app/barcode-scan.tsx` (both "Scan another" rows), `app/exercise-detail.tsx` (History), `app/exercise.tsx` (Programs, Routines, Quick log, Recent sessions), `app/experiments.tsx` (empty state), `app/food-search.tsx` (catalog actions), `app/meal-detail.tsx` (Items, Actions), `app/meal-estimate.tsx` (Items), `app/nutrition.tsx` (Eaten today), `app/protocol-versions.tsx`, `app/protocols.tsx`, `app/routine-edit.tsx` (Exercises), `app/screenings.tsx` (horizon axis, empty ledger, Calendar), `app/settings-health.tsx` (status, Wearable history), `app/settings.tsx` ("Not yet built"), `app/wearables.tsx` (Workouts), `app/workout-log.tsx` (Sets), `src/components/exercise/exercise-picker.tsx` (Catalog), `src/components/home/mission-empty.tsx`, `src/components/log/recent-logs.tsx`, `src/components/ui/error-boundary.tsx`.

**Deliberately NOT restored — `app/protocol-edit.tsx`.** The de-plating there was fixing a bug the owner *did* report, on the New Protocol screen specifically: *"boxes on top of other boxes"*. That screen is a form, and the plate is `border-hairline` on **raised** `paper-hi` while every field inside it is `border-paper-deep` on **recessed** `paper-dim` — a raised box whose entire contents are recessed boxes, which is the surface inversion `block.tsx` exists to prevent, pointing the wrong way. That is a genuine nested enclosure, and the rule that covers it is the standing one: **devices never nest**. It needs no new rule and it stays de-plated. `capture.tsx`, `symptom.tsx`, `screening-form.tsx` and `appointment-form.tsx` are the reference form for a screen that is all controls.

**The lesson, since it is the expensive part.** Three rounds of design changes were made in response to a rendering bug, each justified by a rule written after the fact to fit the change. When a report repeats after a fix, the fix was wrong — do not escalate it. And a complaint about how something *looks on device* is a rendering question before it is a taste question: compile the classes, read what the platform does with them, and look at the screenshot.

### 2. **`paperGrid.opacity` 0.06 → 0.20.**

The owner reported a second time that the sheet still read as blank paper. It was never a rendering fault — the layer draws on all seven full-screen roots and nothing paints over it. The dial was simply below the eye's detection threshold on a phone, and **an arithmetic error inside the previous round's correction concealed that for two rounds**: 1.12:1 against 2.00:1 was read as ≈56% ("a bit over half the weight of the faintest real rule"), but a contrast ratio is anchored at **1.0, not 0**, so the honest comparison is departures — 0.12 against 1.00 = **12%**, roughly an eighth of the stated intent. At 0.20 a grid line is 1.51:1, a true half-weight hairline. Sane range 0.16–0.24; `src/constants/theme.ts` is the single dial. Full working, the contrast table, and the two lessons are in **`docs/design-research/implementation/00-design-spec.md` §4a**; the superseded sentence is left standing in the 2026-08-09 ADR below with a correction beneath it, because the failure mode is worth keeping.

**The lesson that generalises past this pixel:** a value chosen in a browser on a bright desktop monitor is a starting point to re-measure on hardware, not a spec — and when a correction restates a number, re-derive the number, don't re-check the arithmetic around it.

## 2026-08-09 — Three drafting devices lose their marks; the Coach thread comes off the well

**Decision:** the `field`, `margin` and `grid` devices now **draw nothing at all** — no ticks, no rule, no between-cell hairlines, and no padding either — and the Coach **thread** is no longer a `well`. The Conformed Set is otherwise unchanged. `src/components/ui/block.tsx` is the implementation; `docs/design-research/implementation/00-design-spec.md` §1 is the amended spec; §1.2 and §1.3 of the port guide and the device passages in the migration plan are marked **superseded** rather than edited, because how the marks were built is still worth having.

**Why — and this is the whole reason, so it is recorded in full.** The Conformed Set shipped across 83 files without ever being run on a phone (the migration plan's own de-risking step was skipped). The first time the owner saw it on hardware, the first note back was: *"there are some weird boxes and lines in some places, notably the metrics and coach brief on the home screen, but there are more."* The marks were not being read as a drawing vocabulary. They were being read as **artefacts** — a stray glyph, a clipped border, a half-drawn box — which is the surface system reading as noise instead of structure, the one failure mode it cannot survive. The spec's own §5 decides it: **drafting chrome pays rent or goes**, and a mark a viewer must interpret before it helps them is decoration.

Device by device: the **field**'s two 11px corner ticks were the most abstract mark in the set and the least self-explanatory — nothing on screen teaches you that a bracket means "this region was measured". The **margin**'s 2px left rule sat beside a paragraph that *was* the section rather than an aside to one, so it annotated nothing. The **grid**'s hairlines drew an L of lines with no outer edge, which reads as a box someone failed to finish; columns align on their own, and label / value / detail is legible as a table without a stroke. The **thread** was a `well` on the reading "a capture surface, the turns are marks on it" — but a well is for a surface you capture *into*, and that is the composer, which wears it already. A conversation is not a record filed on the page; it is the page.

**Kept, not deleted.** All three remain named devices with empty class strings, because the call site is still a claim about what kind of content it holds — that declaration is the documentation the surface system exists for — and because restoring a mark is one line in `DEVICE`. What survives drawn is the set where enclosure does real work: `plate` closes a record, `well` recesses a capture surface, `stamp` marks the one next action.

**The cost, stated plainly:** the design's load-bearing claim is that the container encodes the content type, and half the containers now encode it by drawing nothing. What still separates them is air, type voice and the section label — which is what §4 already said sections do. Whether that is enough is a device question, and it is now the thing to look at on the next hardware pass.

**A second, unrelated correction made in the same pass:** the paper grid's calibration arithmetic was wrong in both places it was stated (`00-design-spec.md` §4a and `src/constants/theme.ts`), which claimed "6% ink over an **11%** ruled area … ~0.7% average darkening". The tile rules its **top and left** edge, so it is **17 of 81 pixels = 21% ruled** and **~1.26% darkening** — verified by decoding the shipped PNGs at all three densities. The render was never wrong (the mockup stacks a 0deg *and* a 90deg gradient); only the reasoning was, and the reasoning is what the next person tunes against. The number that actually justifies `opacity: 0.06` is contrast, now recorded alongside it: a composited grid line is **1.12:1** against the sheet where `hairline` is **2.00:1**, so the grid sits at a bit over half the weight of the faintest real rule and does not compete with the surface system.

> ⚠️ **The last sentence above is wrong, and it is the reason the grid shipped invisible a second time — corrected 2026-08-10, see the ADR at the top of this file and `00-design-spec.md` §4a.** The coverage half of this paragraph stands (21% ruled, verified against the PNGs). But "a bit over half the weight" reads 1.12:1 against 2.00:1 as ≈56%, and **a contrast ratio is anchored at 1.0, not 0** — a mark's weight is how far it *departs* from the anchor. The grid departed by 0.12 where the hairline departs by 1.00, so the grid was at **12%** of a hairline, about an eighth of the intent this very sentence claimed to be recording. `opacity` is **0.20** now. This paragraph is left standing rather than rewritten because the failure is the interesting part: a value chosen in a browser on a bright desktop monitor was below the eye's detection threshold on a phone, and a plausible-sounding arithmetic error inside the correction concealed it for two more rounds. Re-checking the *coverage* figure — which is what this pass did — could never have surfaced it.

## 2026-08-08 — Visual direction: the Conformed Set (supersedes Porcelain Ledger)

**Decision:** ARC's design system is **the Conformed Set** — "ARC is a working drawing set; the day is *drafted*, not listed." It **supersedes Porcelain Ledger** (the 2026-07-24 ADR below), and is implemented across the whole app, not on one screen. Full spec: `docs/design-research/implementation/00-design-spec.md`; the shipped, living description is `docs/project-status.md` §3; what actually happened phase-by-phase is `docs/design-research/implementation/02-migration-plan.md`.

The load-bearing idea is **not the palette** — it is the **surface system**. Every content block is a drafting device whose container encodes what it holds: *plate* (records/ledgers), *field* (a verdict, corner ticks, no enclosure), *margin* (prose), *grid* (metrics, rules between cells only), *well* (capture surfaces), *stamp* (the one next action). A block gets exactly one device and devices never nest — enforced at runtime in `__DEV__` by a context check inside `src/components/ui/block.tsx`, because prose alone was the only guard on a primitive that now has **137 call sites across 58 files** (plate 63 · margin 35 · well 16 · field 11 · grid 7 · stamp 5 — recounted 2026-08-09: `rg -o 'device="(plate|field|margin|grid|well|stamp)"' app src | wc -l` → 137, `rg -l …| wc -l` → 58; this ADR, the Status Board and §3 all read "54 files" until then, while 137 was correct throughout, and all three carried a per-device split that was wrong in three of its six terms).

> ⚠️ **The three treatments in italics above did not survive the first hardware pass** — `field`, `margin` and `grid` draw nothing as of the 2026-08-09 ADR at the top of this file, and the Coach thread is no longer a `well`. The *assignments* stand; only the marks are gone. The one-device/never-nest rule is unaffected.

Four sub-decisions were made at adoption, and each is recorded here because none of them is recoverable from the diff:

**1. The accent is PETROL `#12454E`, not redline `#C4222E`.** The spec offered both. Petrol wins on one structural argument, not on taste: redline forces `bio-poor` to shift from `#AA402C` to umber `#7A4A1E`, because crimson chrome and rust biology read as the same hue at swatch size. That was a finding in **all six** hostile reviews of the exploration. ARC's *worst* health state is red by every convention the user already knows, so an accent that competes with it puts permanent strain on the chrome/biology firewall — in a product where that firewall is the thing keeping "this is important to tap" from reading as "this is bad for you". Petrol has no such collision, so the firewall costs nothing to hold. (`palette.pine` = petrol; the redline alternative is recorded in the token comment.)

**2. Typefaces are iOS-native substitutions; the mockup's are Windows faces that do not exist on iOS.** The mockup was authored in a browser on Windows and specified **Bahnschrift SemiCondensed** (label) and **Constantia** (serif). Neither ships on iOS. Rather than add `expo-font` payloads — a real face is a download, a licence question, and a decade-long dependency for an app meant to run for decades — the three voices ship as iOS-native stacks: **label** `Avenir Next Condensed → Helvetica Neue → system-ui`, **serif** `Iowan Old Style → Palatino → Georgia` (unchanged from Porcelain Ledger), **mono** `Menlo → Courier New`. Shipping a real face stays available if the label voice reads generic on hardware.

**3. Token KEY NAMES are deliberately unchanged; only the values moved.** `palette` (`src/constants/theme.ts`) is imported by **51 files**, almost all of them for Ionicons `color` props. Renaming `pine` → `accent` and `hairline` → `rule` would have been a 51-file sweep whose entire yield is that the names match the hues again. So **read `pine` as "the one accent" and `hairline` as "the rule"** — the names outlived their original colours, which is a fair trade. Shims survive for the same reason: `porcelain` as an alias of `paper-hi`, and `rounded-card` mapped to **`0px`** rather than deleted.

> **Corrected 2026-08-09, twice over.** (a) This paragraph read **~44 files** — true when the design kit was drafted, but the Conformed Set sweep itself added importers, so it was already stale on the day this ADR was written. Recounted: `rg -lU "import\s*\{[^}]*\bpalette\b[^}]*\}\s*from\s*'[^']*constants/theme'" app src | wc -l` → **51** (52 files import *something* from the module; `app/_layout.tsx` takes only `navColors`). (b) The shims were justified here as protecting "any surviving usage" — **there is no surviving usage.** Swept 2026-08-09 across all 191 source files in `app/` + `src/`, for both the class and the `palette.*` mirror: `porcelain`, `rounded-card`, `hairline-soft`, `pine-soft`, `pine-tint` and `pine-bright` all have **zero consumers**, and `hairline-strong` has zero as a class but **two live `palette.hairlineStrong` reads in `app/settings.tsx`** *(cited here as `app/(tabs)/settings.tsx` until 2026-08-09 — that was true when the sweep ran, and went stale hours later when Settings came off the tab bar and moved verbatim to `app/settings.tsx`; the reads are lines 262–263)*. The decision to keep them stands — a dead token is one config line, and deleting one can break an unmerged branch — but it now rests on cheapness, not on a compatibility need that does not exist. Full record and the retirement order (`pine-soft` first — it is a green tint left over from the pre-petrol accent) in `docs/project-status.md` §3.

**4. The type SCALE sweep was NOT done, and is not a prerequisite.** The three type *voices* ship, because a voice is a `fontFamily` token that the whole app inherits. The *scale* — replacing arbitrary `text-[11px]` / `tracking-[2px]` values with named tokens — is untouched: **63 files still carry arbitrary type values, and `tailwind.config.js` defines no `fontSize` or `letterSpacing` tokens.** It was judged optional because it is an *enforceability* refactor (it stops the next person inventing a fourteenth size), not a visual one — highest file count in the whole plan, lowest visual return.

**Reasoning:**
- The direction is more distinctive than Porcelain Ledger and it *encodes information*: under Porcelain, every block was a card, so the container told the reader nothing. Under the Conformed Set the container is the first thing that says what kind of thing you are looking at.
- It has been reviewed harder than anything else in the repo: six fully-specified sets, each hostile-reviewed for usability and anti-slop (89 findings), converged into this one, re-reviewed to **zero high findings**, then fixed and verified.
- It leans on ARC's own name — *Architecture for Resilience & Continuity* — without making the user learn the metaphor (the honesty rules forbid conceit vocabulary: it is "Today's Mission", never "Issue Schedule").
- The honest case *against*, recorded so it is not lost: Porcelain Ledger was shipped, working and coherent, the app's real gaps are functional (RAG embedder, Phase 4 backup, the EAS build) rather than visual, and a restyle buys no user capability. It was adopted anyway, on the owner's call, because the surface system is a genuine information gain and the cost is presentation-only.

**Consequences:**
- **Nothing about this has been seen on a device.** See the risk block below — this is the single most important consequence and it is not resolved.
- Light-only survives unchanged: `userInterfaceStyle: "light"`, zero `dark:` variants. No shadows, no gradients, no glow — layering is borders plus the paper/paper-hi/paper-dim triad.
- **Corners went square.** `rounded-card` is `0px`; buttons keep a 2px radius. This is the visible departure from Porcelain Ledger's 10px cards.
- **Biological signals now carry two cuts per state** — `signal-{state}` is the **swatch** (fills and icons, 3:1) and `signal-{state}-ink` is the **text cut** (4.5:1). They are not interchangeable: as text on `paper-hi` the swatches measure 3.82 / 5.13 / 3.41 / 5.44, so two of the four fail outright and the two that pass do so by luck of hue.
- The firewall is now stated in both directions and holds in the nav theme too: React Navigation's `notification` slot (tab-bar badges — pure chrome) takes the accent, not `signal.caution` as it previously did.
- **The rules do not clear WCAG 1.4.11's 3:1 non-text floor, and that was accepted — recorded 2026-08-09, having gone unmeasured at adoption.** `hairline` `#A9A28E` draws every plate edge and row separator and measures **2.29:1 on `paper-hi`, 2.00:1 on `paper`** (1.73 on paper-dim, 1.41 on paper-deep). **Accepted for plate borders, row separators and the `margin` rule**, which enclose text that is itself ≥5.97:1: nothing there is *required* to identify a control or read a value, and a rule dark enough to pass is the heavy furniture the 2026-07-24 de-boxing pass removed. **Not accepted, and left open, for the `well` device** — a well marks an *input*, which 1.4.11 covers by name, and its `paper-deep` border reads **1.42:1** against the page. Both go to the first device review rather than being changed sight-unseen. If a change is needed the answer is a darker hairline, not a heavier one: `#7E7767` clears 3:1 on both real surfaces (4.01 / 3.50) at the same 1px weight. Numbers and reasoning in `docs/project-status.md` §3, "Contrast, measured".
- No new dependency was added, so **this restyle needs no EAS rebuild of its own** — but see below for why it needed a build to be judged.
- The mockup's desk background, registration marks, sheet numbers and title blocks are presentation chrome and deliberately **do not ship**. Inside the phone every mark must pay rent.
- Docs updated in the same change (CLAUDE.md §9 convention): `docs/project-status.md` §3, `docs/design-directions.md`, `02-migration-plan.md`, CLAUDE.md, and the header comments of `tailwind.config.js` + `src/constants/theme.ts`.

**⚠️ The unretired risk — NOTHING HAS BEEN SEEN ON A DEVICE.** Verification to date is `tsc`, ESLint, Prettier and the headless suites. Per the standing rule that the web preview is a logic-check surface only and never a look/feel judgement, **none of that is evidence about how this looks.** Three things in this restyle are first-of-kind in this tree and **fail silently** if iOS does not support them:
- **`Avenir Next Condensed`** — the label voice. In `font-label` it is the head of a CSS stack, so native falls through to Helvetica Neue if it is absent. **But the tab bar sets `fontFamily` imperatively as a single string** (`app/(tabs)/_layout.tsx`), and React Native takes no fallback list there — if that exact family is missing, the five tab labels silently drop to the system face while every other label in the app renders correctly. That is the one place the voice can break in isolation.
- **`border-dashed`** (`app/protocol-versions.tsx`) — the proposed/suspended version marker. First use of a dashed border anywhere in the app.
- **Rotated-square diamond markers** (`app/screenings.tsx`, `transform: [{ rotate: '45deg' }]`) — the horizon-axis terminals. First use of a transform for a visual mark.

None of these throws when unsupported; each just quietly renders as something else. **This needed an EAS build to be judged.** That build shipped 2026-08-25; the styling claims in `project-status.md` §3 were in fact judgable before it either way, since the build gated dormant native modules and not the stylesheet.

---

## 2026-07-25 — Nutrition / Exercise / Capture / Symptoms went real (parallel build)

**Decision:** the four Log sub-surfaces were built for real, replacing the mockups. Nutrition and Exercise were built **in parallel** in separate Claude (Fable) windows on their own worktrees/branches; Capture and Symptoms were built in the main window, which also **integrated** everything.

**Data model** — each feature got its own additive table rather than overloading `log_entries` (whose `type` is a fixed CHECK vocabulary, and which holds *planned* mission rows, not records of what happened):
- **`meals`** (0002) — one row per eaten meal, canonical macros, summed into the day's intake.
- **`workouts`** + **`workout_sets`** (0003) — a session and its strength sets; `weight_kg` canonical; sets `ON DELETE CASCADE` with their workout (a set has no meaning outside its session — unlike log history, which survives its protocol via SET NULL).
- **`symptoms`** (0004) — name + 1–10 severity + body area + note, so the Coach can correlate against protocols/labs/wearables.
Capture (Supplement/Therapy) needed no table — it writes ad-hoc `log_entries`. All four surface in the Log feed's "Logged today".

**Parallel-build coordination (what kept the merge clean):** distinct reserved migration numbers per stream (0002/0003/0004); each window in its own git worktree; feature-local types (`src/lib/<feature>/types.ts`) instead of the shared `src/lib/db/types.ts`; and the integrator owning the shared files at merge — the generated migration bundle (re-run `db:bundle`), the `db:test` script line, and all docs. The merge itself only conflicted on those two generated/shared files. `migrate.test.mjs` was hardened during the build to assert `user_version === max(version)` rather than the migration *count*, since parallel numbering leaves gaps on a branch until merge.

**Pre-migration backup, now live:** 0002–0004 are the first migrations to run against a device that already has data, so `backupBeforeMigrate` (a stub that threw in `__DEV__`) was wired to take a real snapshot via SQLite **`VACUUM INTO`** before migrating — a consistent single-file copy with **no new native dependency**. It warns-and-proceeds on failure rather than blocking boot (pre-release, single-user, re-seedable). Phase 4's encrypted iCloud backup supersedes it.

**Scope this pass:** functional cores only — manual entry that persists and matches the mockups. Photo/text natural-language logging (snap-a-meal, spoken symptoms) is blocked on the on-device model and lands with the Coach (Phase 3); meal templates, the workout builder's deeper features, and progressive-overload analytics are follow-ups.

**Consequences:** four new tables (schema of record now 14 tables across 4 migrations); `db:test` grew to 140 across six suites; the reserved-number + integrator-owns-shared-files pattern is the template for future parallel feature work.

---

## 2026-07-25 — iOS-only target, and the last Supabase remnants purged

**Decision (owner):**
- **ARC targets iOS only.** Android is not a target "in any form." Removed the `android` block from `app.json`, the Android build entries from `eas.json`, the `android` npm script, and the three Android adaptive-icon assets. **Web is kept** — not as a shipped target but as the dev-time logic-check preview path (see [[verify-on-device-not-web]]); it can be dropped later if we want a pure-iOS tree.
- **All Supabase remnants deleted.** The owner decommissioned the remote project, so the last artifacts went too: the whole `supabase/` folder (config, the Postgres-origin migration, seed, functions) and the `EXPO_PUBLIC_SUPABASE_*` lines in `.env`. This finishes the removal the 2026-07-25 review started (which had deleted the client island but kept `supabase/` as "history"). Nothing Supabase remains in the tree; the Postgres origin lives in git history only.

**Reasoning:** a single-user iOS app has no reason to carry Android config, icons, or an EAS Android profile — it's pure surface area to keep correct. The Supabase project being gone removes the last reason to keep its origin files or a live anon key in `.env`. Both are reversible via git history if ever needed.

**Consequences:** the `0001_init.sql` header no longer points at the deleted `supabase/` path (regenerated `migrations.generated.ts` to match); docs (README, folder-structure, CLAUDE.md §9/§11, data-model, dev-build, project-status) drop their Android and `supabase/`-origin references. Gates stay green.

---

## 2026-07-25 — Full-app review: fixes, and pulling the Supabase removal forward

**Context:** a full-app review ran five read-only reviewers in parallel (correctness/DB, UI/design-system, security/privacy, architecture/docs, plus the Log-wiring diff). Findings converged; the top three correctness bugs were reproduced against real SQLite. This ADR records the decisions in the fixes; the mechanical fixes themselves are self-explanatory.

**Decisions:**

- **The command parser requires ADJACENCY.** It was matching "a keyword anywhere + the first number anywhere", which silently mis-logged notes containing a common word (`took 2 pills, weight 181` → 2 lb; `great water views, walked 5 miles` → 5 oz). A note must never become a wrong measurement, so a number now only becomes a metric when it sits next to that metric's keyword/unit, and only a narrow set of unambiguous units (`lb/kg`, `bpm`, `ms`) may imply a metric with no keyword — `oz`/`ml`/`mg` require their keyword (food is logged in oz/g, so `16 oz` alone must not mean water). Everything else stays a note. (`src/lib/log/parse.ts`, `metrics.ts` `inferUnits`.)
- **Writes validate against the schema's domain.** Out-of-range values (`body-fat 150`, `weight 0`) tripped a `body_metrics` CHECK and threw out of the tap handler. `isLoggableCanonical` now gates both surfaces: the keypad disables "Log" with an inline hint; the command field saves the raw text as a note rather than crash or lose it (plus a try/catch backstop). (`metrics.ts`, `command-field.tsx`, `metric-entry.tsx`.)
- **The seed guard counts planned entries only.** Logging a note before opening Home on a new day left the daily_log non-empty and suppressed the whole day's seeded mission. The guard now uses `countMissionEntries` (ad-hoc-excluded), matching the mission filter. (`seed.ts`, `mission.ts`.)
- **The dead Supabase island was deleted now, not deferred to Phase 2.** `supabase.ts`, `env.ts`, `use-session.ts`, `types/database.ts`, `login.tsx`, `gen-types.mjs`, the `@supabase/supabase-js` + `@react-native-async-storage/async-storage` deps, and the `db:push`/`db:types` scripts were removed. Rationale: security + architecture reviewers agreed it's a closed graph nothing live imports (the app boots without `.env`), and `types/database.ts` was *actively wrong* (Postgres/RLS shape the SQLite port dropped) — a stray import would type-check against a schema that no longer exists. Deferring it bundled two unrelated things ("remove Supabase" + "add Face ID"); the removal is separable and zero-runtime-risk, so it shipped early. **Face ID app lock remains the real Phase 2 work.** *(Owner action still outstanding: decommission the remote Supabase project and strip `EXPO_PUBLIC_SUPABASE_*` from `.env` — a bundled anon key is why removing the code matters.)*
- **The Coach seam was corrected to the adopted architecture.** Comments across `coach-service.ts`, `system-prompt.ts`, `coach.tsx` still described the retired "Supabase Edge Function" plan; they now describe the direct, on-device model call (Keychain key), and `isCoachBackendLive` was renamed `isCoachKeyConfigured`. Comment/rename only — no behavior change.

**Consequences:** headless coverage grew to `db:test` log-layer 43/43 (adjacency, out-of-range, log-then-seed, UTC-range boundary, multi-measurement fan-out); the `@/` alias now resolves in the test loader. UI polish also landed (off-token radii → `rounded-btn`; decorative icons hidden from a11y; a keypad Dynamic-Type cap; a Coach keyboard offset; an app-wide `ErrorBoundary`; the migration-backup stub throws in `__DEV__`). **Deliberately deferred (flagged to the owner, not fixed here):** SQLCipher at-rest encryption (Phase 4) and the Face ID app lock (Phase 2); and one design call left to the owner — colour-only state on Home's pillar strip (WCAG 1.4.1) — because changing the approved Home visual is a product decision, not a review fix.

---

## 2026-07-25 — Wiring the Log tab: canonical units, an ad-hoc marker, and an offline parser

**Decision:** the Log tab now persists to the on-device DB. The shape of that wiring:

- **Storage is canonical SI; display is a conversion.** Every metric is stored in a canonical unit — weight **kg**, waist **cm**, water **ml** — and rendered in the user's display unit (lb / in / oz) through a single **metric registry** (`src/lib/log/metrics.ts`) that owns each metric's label, display unit, decimals, both conversion directions, and its persistence target. This makes the future lb/kg · in/cm · oz/ml **unit toggle a display-layer preference, not a migration** (it plugs into `fromCanonical`), and matches the schema's already-canonical `body_metrics.weight_kg` / `waist_cm`.
- **Persistence routing (one place, the registry):** weight / body-fat / waist → `body_metrics`; water / HRV / RHR → `wearable_data` (`source_device='manual'`, free-text `metric_type` — `water_ml`, `hrv`, `rhr`); dose and free notes → `log_entries`.
- **An `value.adhoc = true` marker separates Log captures from Home's mission.** `log_entries` holds both the planned mission (Home) and ad-hoc Log captures (a note, a spontaneous dose). Rather than a schema column, ad-hoc captures carry `adhoc:true` in their `value` JSON: `listMission` filters them **out**, the Log feed filters them **in**. Body/wearable captures live in their own tables, so they never touch the mission. (Seeded/planned entries carry no flag, so they're unaffected — and the Log feed correctly starts empty until the user logs something real.)
- **The command-field parser is deterministic and offline.** `src/lib/log/parse.ts` handles the common one-liners (`weight 178`, `16 oz water`, `hrv 48`, `180 lb`) via metric keywords and strong units; everything else is saved verbatim as a **note for the Coach**. Everyday-word units (`in`, `l`) never *imply* a metric on their own, so a plain sentence isn't misread as a measurement. Rich natural language ("ate eggs + oats, 45g protein" → a meal) needs the on-device model and lands with the Coach (Phase 3).
- **Water is modeled as `wearable_data(water_ml)`** with additive quick-estimates (Glass +8 / Bottle +16 / Large +24 oz). A smart bottle via Apple Health later adds rows to the same `metric_type`, no migration — as the hydration ADR intended.

**Small refinements to the 2026-07-25 Log-tab ADR below** (owner calls, same day): the **Meal tile is renamed Nutrition**; the tile grid is regrouped so the two gateway tiles share the right column (Row 1: Supplement · Water · Nutrition; Row 2: Weight · Therapy · Workout); **Nutrition, Exercise, and the Supplement/Therapy capture sheet ship as design mockups** (real layout, mock content, a quiet "mockup" footer) ahead of wiring.

**Reasoning:** canonical storage is the standard fix for a unit toggle and costs nothing now; a JSON marker avoids a migration for a distinction that may dissolve once the protocol→mission generator exists; an offline parser keeps fast capture working with the network unplugged (the offline-except-AI principle), and a note is never a wrong interpretation, so the fallback is safe.

**Consequences:** the registry is the single source of truth for units/targets — add a metric there, not in three UIs. `listMission` gained an `adhoc IS NULL` filter (verified: seeded mission intact, captures excluded). Headless coverage added: `npm run db:test` log-layer 26/26 (parser, conversions, routing, feed union/order, mission isolation). The test loader now resolves the `@/` alias (`db/ts-ext-hook.mjs`) so repositories can use it for runtime value imports. No new native deps → no dev rebuild to see it.

---

## 2026-07-25 — Log tab direction, Nutrition/Exercise sub-apps, and the Modes model

**Decision:** Full map + rationale in `docs/information-architecture.md`. In brief:

- **Log tab = direction A ("Open Line")** — chosen from a two-round design study. Three capture layers: a command/voice field (free notes + parse), a 3×2 quick-add tile grid, and a single-number metric keypad drill-in.
- **Quick-add tiles:** Supplement · Meal · Water · Weight · Workout · Therapy. **Meal and Workout are gateways** that push full sub-app screens (**Nutrition**, **Exercise**); the rest are quick-capture (sheet/keypad). Notes live in the command field; other body numbers in the keypad chips; medication folds into the Supplement sheet; habits are completed on Home, not re-logged.
- **Nutrition and Exercise are stack-pushed sub-app screens** (placeholders now), not Data sections — they're deep enough to own their space, which also keeps the Data hub from overloading. **Protocols stays in Data** for now but is the leading candidate to graduate the same way.
- **Modes** (Normal/Travel/Sick/Deload/Social/Custom) live on **Home** and adapt four things — the plan, priorities, the Coach's tone, and adherence accounting (excused misses). The override data model is built later with Protocols + the mission generator.

**Reasoning:** capture frequency drives layer (daily-many → tile, deep domain → sub-app, anything/notes → the field); Home owns "today" so the Mode control belongs there, not Settings; sub-app screens beat Data-sections for food/exercise because both are real mini-apps. Everything is defensible for v1 and reversible.

**Consequences:** the placement map in `docs/information-architecture.md` is the source of truth for where features go; `docs/home-screen.md` and CLAUDE.md §11 point to it. Building starts with the Log skeleton (structure on mock content; persistence/parsing is the next step).

---

## 2026-07-25 — Backup key: user-recorded recovery phrase, envelope-encrypted

**Decision:** The encrypted iCloud backup (Phase 4) is protected by a key the user can recover **from a one-time recovery phrase**, not by a device-only key. Concretely:

- **Envelope encryption.** A random 256-bit **data key (DEK)** encrypts the backup. The DEK never changes, so every past backup stays decryptable forever. The DEK is stored **wrapped** (encrypted) by a **key-encryption key (KEK)** derived from the recovery phrase, and the wrapped DEK travels with the backup (useless without the phrase).
- **Recovery phrase.** At backup setup the app generates a one-time phrase (wallet-seed / 1Password-Secret-Key style), shows it once, and makes the user confirm they've stored it (password manager / paper). This is the sole durable recovery path.
- **Day-to-day is frictionless.** The DEK (or the phrase) lives in the Face-ID-protected Keychain on the active device, so routine backups need no re-entry. The user only touches the phrase at **setup** and at **restore on a new phone**.
- **iCloud Keychain is a deferred, optional convenience.** Because of envelope encryption, syncing a second KEK via iCloud Keychain can be added later as an *additional* wrap of the same DEK — zero re-encryption, no migration. Not built now.

**Reasoning:**
- **Ownership and portability win the tie.** A recovery phrase is the user's, full stop — it works if ARC ever ports off iOS, if data is exported to the user's own storage, or if Apple changes iCloud Keychain in a decade. An iCloud-Keychain-only key chains a decade of health data to the survival of one Apple ID. For an ownership-first, decades-horizon, single-user app, that is decisive (CLAUDE.md §2).
- **Fewest long-term dependencies.** Recovery depends only on a string the user controls, not on Apple's escrow infrastructure remaining intact and accessible.
- **It's also less work now.** `expo-secure-store` does not expose the iCloud-Keychain sync flag (`kSecAttrSynchronizable`), so the sync option would need custom native code; the recovery-phrase path does not.
- **Fixes the audit finding directly** (2026-07-24 pre-Phase-1 audit): a device-only Keychain key makes the backup undecryptable after the exact event it exists to survive. The DEK is also kept strictly separate from the **model API key** — the "spend limit / rotate on device loss" mitigations are API-key concerns and are *harmful* applied to a backup key (rotating it orphans old blobs); the DEK never rotates.

**Consequences:**
- **The one accepted risk:** losing the phone **and** the recovery phrase means the backup is unrecoverable. That is the price of nobody-but-the-user being able to decrypt it. Mitigations: strong setup UX (generate, prompt to store, confirm), and the manual **data export** as an independent second escape hatch.
- **Phase 4 implementation notes** (not binding, decided at build): KDF Argon2id preferred (PBKDF2-HMAC-SHA256 as the widely-available fallback), AES-256-GCM for the wrap and the backup. Worth evaluating **SQLCipher** (op-sqlite supports it) so the on-device DB is encrypted at rest and a backup is just a copy of the already-encrypted file — one scheme covering both at-rest and backup.

---

## 2026-07-24 — Local-first, single-user, no-server architecture

**Decision:** ARC is a **local-first, single-user, server-less** app. All personal data lives **on the device** in SQLite, with `sqlite-vec` for on-device RAG. The Coach calls a frontier model **directly from the app** using a key the user supplies, held in the **iOS Keychain** and swappable at runtime via a settings screen (provider + model + key). The longevity **knowledge base lives on-device** and is writable — the user, and later the Coach's own research, can expand it. Media (food / progress photos) is **referenced from the iOS Photos library** (PhotoKit) or stored compressed, never duplicated wholesale. Backup is an **encrypted snapshot to iCloud**, the device holding the key. There is **no backend, no auth, no RLS, and no personal data at rest in any cloud.** Supabase is removed.

**This supersedes** the 2026-07-22 "Coach: client → Edge Function, never a client-side key" ADR, the cloud posture of the 2026-07-21 schema/RLS ADRs, and the 2026-07-24 data-ownership *deferral* (we are not deferring local-first — we are adopting it now).

**Reasoning:**
- **One user for the foreseeable future.** Auth, RLS, `user_id` tenancy and a hosted Postgres all exist to isolate *many* users over a network. For one person on one phone they are pure overhead — removing them makes the app *simpler to build and to run*, not merely cheaper.
- **The client-side-key objection doesn't apply here.** The original ADR banned a client-held model key because a *distributed* app would ship a shared secret to thousands of devices. This key is *yours*, in hardware-backed Keychain, on *your* device — revocable and spend-limited. The threat that justified the server is absent.
- **Privacy by construction.** Personal health data never sits at rest in anyone's cloud; the only cloud copy is an encrypted blob the device alone can decrypt. This satisfies CLAUDE.md §2's "local-first or strongly encrypted" directly instead of deferring it.
- **Storage fits comfortably.** Structured data + on-device vectors total well under 1 GB per decade; photos are the only variable and stay small via compression or PhotoKit references. Single-digit GB over ten years on a 128–256 GB phone. (Worked through with the owner, 2026-07-24.)
- **Zero recurring cost but tokens.** No server, no hosting bill; ongoing cost is per-token model usage plus the $99/yr Apple membership any iOS app needs.
- **The model stays swappable.** `coach-service.ts` already isolates the model call; a settings screen makes provider/model/key user-editable at runtime.

**Consequences:**
- **Removed:** Supabase (client, hosted project, migration-as-live-schema), email auth, RLS policies, `useSession` as a gate. The live Supabase project becomes vestigial (free tier — the owner can delete it whenever).
- **The schema survives as the app's spine**, ported Postgres → SQLite (enums → `text` + `CHECK`, `uuid` → `text`, `timestamptz` → ISO-8601 `text`, `jsonb` → `text`). Table and column names are preserved so the UI and view-model types barely move.
- **New surfaces:** an on-device migration runner, a local data-access layer, a settings screen for provider/model/key, `sqlite-vec` RAG, PhotoKit media references, and encrypted iCloud backup/restore.
- **On-device key posture:** Keychain storage (`expo-secure-store`) + a provider-side spend limit + key rotation on device loss are the three mitigations that keep this safe.
- **Upgrade path preserved.** If ARC ever goes multi-user or ships publicly with a shared key, a thin server returns *behind the same `coach-service.ts` seam* — the app doesn't change. Nothing here burns that bridge.
- CLAUDE.md §3 (stack) and §9 (DB conventions — RLS / `auth.uid()`) and `docs/data-model.md` need updating to match; tracked in the plan.

**Full step-by-step:** `docs/architecture-migration.md`.

---

## 2026-07-24 — Reconciling the app with the source brief (`Health App Idea`)

**Context:** The owner's original product brief (`Health App Idea`, kept outside the repo) was diffed against the shipped app and the docs. Most of it already agreed; the decisions below resolve the points that didn't. The full diff and the resulting backlog additions live in `docs/project-status.md` §1.

**Decisions:**

1. **Today's Mission is one chronological list, not category groups.** The brief calls the home screen "directive and **chronological**"; the first build grouped items by category (Morning, Nutrition, Training…), which let a 21:45 supplement render above an 08:00 meal. Sorting by scheduled time makes the reading order the acting order, and guarantees the derived hero ("do this next") always points at the top of the list. Category survives as a per-row label. See `docs/home-screen.md` §3, `src/lib/home/derive-mission.ts`, and `src/hooks/use-today-mission.ts`.

2. **Progressive disclosure is allowed to hide history, never work.** The brief wants "beautiful progressive disclosure"; the home-screen doctrine had flatly refused collapsing. Both are honoured by a narrow rule: the run of already-settled items at the *top* of the day folds into one line so the list opens at *now*, and nothing else ever collapses. Anything still pending — including overdue items, and items settled out of order — stays visible. This is the bounded form of "collapsible if needed"; the thing the doctrine rejected (hiding pending work) is still rejected.

3. **The status bar / quick-actions questions were already settled this session** and the brief does not reopen them: the date-only header (readiness moved below the hero) stands, and the quick-actions dock stays cut (see the ADR below). The brief's "overrides for travel/sick/social" is retained as the **Mode override** backlog item, which needs a real home, not a restored dock.

4. **Data-ownership posture: cloud-first for v1, deferred deliberately.** ~~The brief and CLAUDE.md §2 both ask for "local-first or strongly encrypted". v1 is plain cloud Supabase with RLS; the ownership guarantee for now is **easy full data export**, not local-first or client-side encryption. Client-side encryption is rejected for v1 because it would blind the Coach's server-side RAG to most of the data. Revisit before genetics or mental-health data lands.~~
   > **SUPERSEDED 2026-07-24 (same day) by the "Local-first, single-user, no-server" ADR at the top of this file.** We are *not* deferring local-first — we adopted it. Personal data lives on-device; there is no cloud Supabase and no server-side RAG to protect. The Coach's RAG runs on-device, so the earlier objection (client-side encryption would blind server RAG) no longer applies. This decision is kept only as a record of the reasoning we changed our minds about.

5. **Wearable choice stays open.** The brief lists Garmin CIRQA / WHOOP / Ultrahuman / Oura as undecided. CLAUDE.md §8 had asserted a firmer dual-device preference; it's been relaxed to match — all four are candidates, everything normalises into ARC's own schema, so no code depends on the decision and it costs nothing to defer.

**Consequences:**
- The brief's exhaustive feature set seeded a large batch of backlog items (preventive screenings + medical calendar, food/pantry/recipe/photo-analyzer model, microbiome + epigenetic-clock lab breadth, exercise-as-measured-data, environment breadth, education module, reporting + export, predictive alerts, vector memory). All are in §1, marked as appetite not sequence.
- **§1 is now explicitly an unordered catalogue.** The owner builds in the order they choose; the doc stopped implying a phase order (the earlier "per CLAUDE.md priority order" framing is gone).

---

## 2026-07-24 — Rules enclose objects, never pages; the quick actions dock is cut

**Decision:** Two changes from the first on-device review of the Porcelain Ledger build.

1. **No horizontal rules between Home sections.** Hairlines are for **card edges** and **row separators inside a list**. Sections are separated by whitespace alone. The `border-b` folio rule under the date eyebrow and the `border-t` rules above the metrics strip and the dock are gone.
2. **Section 6 of `docs/home-screen.md`, the Quick Actions Dock, is removed** — component deleted, not hidden. The Home screen now ends at the metrics strip.

**Reasoning:**
On a real screen, a rule above a short block and a rule below it draw a box around it. The owner's words were "a few weird little boxes… around the date at the top and around the wearables data at the bottom" — three rules, read as three boxes. This is a general lesson, not three one-off fixes: a rule is legitimate when it traces the boundary of one object, and furniture when it slices the page.

The dock failed a different test. Its four buttons were Log, Coach, Mode, Data — and Log, Coach and Data are *tabs*, sitting an inch below in the tab bar. Mode was inert. It was a row of duplicate navigation charging rent at the bottom of the most protected screen in the app (CLAUDE.md §5: "Never let the home screen become a data dump" — a nav dump is the same failure).

**Consequences:**
- `src/components/home/quick-actions.tsx` is deleted. `docs/home-screen.md` §6 is struck through with the reasoning, so the IA doc can't be read later as a spec for rebuilding it.
- **Mode override (Travel/Sick/Social/Manual) no longer exists anywhere in the UI.** It was only ever an inert button. When the override model is real it needs a deliberate home — most likely the hero or a Settings-level day-state control — not a restored dock.
- The metrics strip is now the last element on the screen, with no rule and no heading. A heading was considered and rejected: every cell already carries a caps label, so a caps section header stacks caps on caps.
- Home section rhythm (`mt-5`–`mt-9`) is now the *only* separator between sections. Tightening it has more consequence than it used to.

---

## 2026-07-24 — Visual direction: Porcelain Ledger

> **SUPERSEDED 2026-08-08 by "Visual direction: the Conformed Set" at the top of this file.** Porcelain Ledger shipped and worked for two weeks; the Conformed Set replaces it wholesale. Kept because three of its calls **survive the supersession unchanged** and are still binding: light-mode only (no `dark:` variants, Night Watch as the designed night candidate if one is ever wanted), no shadows/elevation/glow, and the `platformSelect` font-stack gotcha below. The token *names* it introduced also survive — see sub-decision 3 of the new ADR.

**Decision:** ARC's design system is **Porcelain Ledger** — bone-white paper, warm ink, hairline rules, serif headlines, mono data, one deep pine-green accent. Chosen by Matt from six fully-specified candidate directions (archived in `docs/design-directions.md`) after reviewing complete Home + Coach mock-ups. Replaces the original cool-gray + teal theme. Full token set and usage rules: `docs/project-status.md` §3.

**Reasoning:**
The owner wasn't sold on the original colours or vibe. Six deliberately distinct territories were explored in parallel and audited for contrast and distinctness; Porcelain Ledger won because its metaphor — a beautifully printed lab report that happens to be alive — *is* the product: a permanent, trustworthy, decades-durable record of one person's biology. Print conventions (paper, hairlines, serif authority, mono data) age better than app trends.

**Consequences:**
- **Light-mode only.** Paper is the identity; `dark:` variants were removed rather than restyled, `userInterfaceStyle` is pinned to `light`. A future night mode would be the archived Night Watch (B) direction as a second complete theme, not bolted-on variants.
- **Three typographic voices with meaning:** serif speaks (headlines/verdicts), sans talks (body), mono measures (every datum). System fonts only — no font downloads to break in a decade.
- The accent discipline survives the restyle: pine marks the hero, primary actions, the user's chat voice, and the active tab. Nothing else.
- Fonts must be declared as plain CSS stacks in the Tailwind config — NativeWind's `platformSelect` silently drops family names containing spaces (verified against the compiled style registry).

---

## 2026-07-22 — Coach: client → Edge Function, never a client-side key

**Decision:** The Coach's model call lives behind a single service seam (`src/lib/ai/coach-service.ts`). The client never holds a provider API key; the real implementation will be a Supabase Edge Function that holds the key server-side and streams the reply back. Today that seam returns an honest mock with simulated streaming.

**Reasoning:**
An `EXPO_PUBLIC_ANTHROPIC_KEY` would be inlined into every client bundle — a shipped secret (see `.env.example`). Routing through an Edge Function keeps the key server-side and gives one place to run the agent loop, RAG, and tools later. Isolating it behind one function means the entire chat UI — hook, components, streaming contract — is written against the final interface today and does not change when the backend lands.

**Consequences:**
- The chat streams token-by-token now, so the UX that ships today is the UX that ships with the real model.
- `isCoachKeyConfigured` (renamed from `isCoachBackendLive` on 2026-07-25, when the Edge-Function plan was retired for the direct on-device call) is the single flag the UI reads to show the "Preview" affordance.
- Conversations are in-memory until the `ai_conversations` / `ai_messages` migration lands.

---

## 2026-07-22 — The mock Coach is honest, not fake-smart

**Decision:** The placeholder Coach never fabricates data-grounded answers. It replies in-character but transparent — it states that it is a preview not yet connected to the model or the user's data — and the daily brief carries a visible "Preview" badge.

**Reasoning:**
A coach that confidently invents HRV numbers or protocol advice while disconnected from real data would train the user to distrust it exactly when it becomes real. Honesty about its own wiring is on-brand for "calm, precise, evidence-seeking" (docs/ai-coach.md) and avoids demoing fake intelligence.

---

## 2026-07-22 — Project Naming

**Decision:** Name the project **ARC** (Architecture for Resilience & Continuity)

**Reasoning:**  
Short, strong, systemic. Works as both a word and an acronym. Avoids collision with Bryan Johnson’s “Blueprint” while capturing the OS / protocol / long-term resilience nature of the system.

---

## 2026-07-22 — Starting Tech Stack

**Decision:** Begin with Expo + React Native (TypeScript) + Supabase.

**Reasoning:**  
Maximum iteration speed while discovering the correct UX and data model. User already has strong Expo experience. AI coding tools currently perform better on this stack. Clean path to native SwiftUI later once the product is proven.

**Consequences:**  
- Faster earlying of home screen, coach, and core loops  
- Will eventually need a native port decision  
- HealthKit integration via Expo modules + possible custom native code later

---

## 2026-07-22 — Lab Strategy

**Decision:** Use Function Health as the primary comprehensive lab backend. Ingest via PDF download + structured parsing.

**Reasoning:**  
Best current combination of breadth (160+ biomarkers), quality, and accessibility. Avoids building phlebotomy/logistics. PDF parsing is reliable enough in 2026 with strong LLMs.

---

## 2026-07-22 — Home Screen Philosophy

**Decision:** The home screen is sacred and must remain ruthlessly directive. Full data exploration lives elsewhere.

**Reasoning:**  
The primary job of the app is to make the highest-leverage next action obvious. Information density is the enemy of daily execution.

---

## 2026-07-22 — Scoring System

**Decision:** Do not start with a single composite “Don’t Die Score.” Begin with multi-pillar status + clear actions. Revisit biological age / velocity later.

**Reasoning:**  
Composite scores force arbitrary weightings and can demotivate. Better to keep signals separate and let the Coach synthesize.

---

## 2026-07-21 — Enum vs. Text in the Schema

**Decision:** Use a Postgres enum where ARC owns the vocabulary; use `text` where an external system owns it. In practice: enums for `biological_sex`, `biomarker_category`, `data_source`, `protocol_type`, `authorship`, `log_entry_type`, `log_entry_status`, `wearable_device`; plain `text` for `wearable_data.metric_type`.

**Reasoning:**  
Enums give typo protection and generate exact string unions in `src/types/database.ts`, which is worth a migration when we control the list. `metric_type` is the exception: Oura, WHOOP, Ultrahuman and Terra add metrics on their schedule, and an enum there would mean a migration every time a vendor ships a new field.

**Consequences:**  
- Adding an enum value is a one-line migration (`alter type ... add value`), never a data rewrite.
- `metric_type` is guarded by a `^[a-z0-9_]+$` check constraint instead of the type system, so the normalisation layer must own that vocabulary.

---

## 2026-07-21 — `user_id` on Child Tables + Composite Foreign Keys

**Decision:** Carry `user_id` on `log_entries` and `protocol_versions` even though the spec derives ownership through the parent. Enforce consistency with composite foreign keys — `(daily_log_id, user_id) → daily_logs(id, user_id)` and `(protocol_id, user_id) → protocols(id, user_id)` — backed by `unique (id, user_id)` on the parents. Same pattern for `lab_results → lab_reports`.

**Reasoning:**  
`docs/data-model.md` asks for “user_id on everything.” Denormalising it lets every RLS policy be a flat `auth.uid() = user_id` rather than an `EXISTS` subquery against the parent, which is materially faster per row. The composite FK is what makes the denormalised column trustworthy: it is structurally impossible to attach a row to another user’s parent. Verified by test.

**Consequences:**  
- Parent tables carry a redundant `unique (id, user_id)` index to serve as the FK target.
- Writers must set `user_id` explicitly on child inserts.

---

## 2026-07-21 — Delete Semantics

**Decision:** Deleting a protocol sets `log_entries.protocol_id` to NULL rather than cascading. Deleting a lab report cascades to the `lab_results` parsed out of it. Deleting a daily log cascades to its entries.

**Reasoning:**  
Execution history is the record of what actually happened and must survive protocol churn — losing a year of adherence data because a supplement stack was retired would be unacceptable. Parsed lab results, by contrast, are derived data: they can be regenerated from the stored PDF, so they follow their report. Manually entered results have `report_id` NULL and are untouched.

---

## 2026-07-21 — Protocol Versions Are Immutable

**Decision:** `protocol_versions` has `created_at` but deliberately no `updated_at` and no update path. Changing a protocol means inserting a new version and moving `protocols.current_version_id`.

**Reasoning:**  
“Protocols are versioned and treatable like code” (CLAUDE.md §2). A version you can edit in place is not a version. This also keeps n-of-1 experiments honest: an experiment can reference the exact version it ran against.

---

## 2026-07-21 — RLS Policy Shape

**Decision:** One `FOR ALL` policy per owned table, with `auth.uid()` wrapped in a scalar subquery: `using ((select auth.uid()) = user_id)`. `biomarkers` is global reference data with a read-only policy for authenticated users and no write policy at all.

**Reasoning:**  
The predicate is identical across select/insert/update/delete, so four separate policies would be four copies of one line. Wrapping `auth.uid()` in a subquery lets Postgres evaluate it once per statement as an InitPlan rather than once per row — the documented Supabase performance pattern. Biomarker rows are seeded by the service role, which bypasses RLS, so no write policy is needed or wanted.
