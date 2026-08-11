# The Conformed Set — design specification

**Status: ADOPTED 2026-08-08** — this is the shipped visual system and the spec of record. Supersedes **Porcelain Ledger** (chosen 2026-07-24). The adoption ADR, including the accent and typeface decisions, is in `docs/decisions.md`; what actually shipped is recorded in `02-migration-plan.md`.
**Mockup of record:** `docs/design-research/arc-conformed-set.html` (14 sheets: 10 canonical screens + 4 alternate states).
**Provenance:** convergence of a six-set exploration, each hostile-reviewed for usability + anti-slop; this set re-reviewed at 0 high findings, then fixed and verified. Full trail in `docs/design-research/`.

> **The philosophy in one line:** ARC is a working drawing set — the day is *drafted*, not listed.

Where Porcelain Ledger is a printed lab report, this is the architect's set that produced it: the same calm and the same restraint, but the container tells you what kind of thing it holds. It leans on ARC's own name — *Architecture for Resilience & Continuity*.

---

## 1. The surface system — "devices" (the load-bearing idea)

Every content block is a drafting container, and **the container encodes the content type**. This is the whole design. A plate on everything reads flat; boxing nothing reads unreadable. Each kind of content gets its correct drawing device.

> **AMENDED 2026-08-09, on the owner's first look at real hardware.** Three of the six devices lost their marks and now draw nothing, and the chat thread stopped being a capture surface. The table below is what `src/components/ui/block.tsx` and `app/(tabs)/coach.tsx` actually do today; the reasoning is under it. The previous wording — corner ticks, a margin rule, between-cell hairlines, "chat thread" as a well — described marks that no longer render anywhere in the app.

| Content | Device | Treatment **as shipped** |
| --- | --- | --- |
| Schedules, ledgers, record lists (mission, Data trends, Settings rows, Protocols, Screenings) | **Ruled plate** — a record is a table | `paper-hi` fill, 1px `paper-line` border, ruled rows inside |
| Readiness / status verdict | **Measured field** — a verdict, not a box | **draws nothing.** Set apart by air and by type |
| Prose (Coach brief, rationale) | **Margin annotation** | **draws nothing.** No rule, no indent — prose sits on the sheet |
| Metric grids | **Ruled grid, no outer box** — the grid *is* the object | **draws nothing.** The grid is built from alignment and whitespace; cells carry no rules |
| Capture surfaces (the Log command field, the Coach composer) | **Recessed stock** — an input well | `paper-dim` fill, `paper-deep` border |
| The one next action | **Stamped plate** | `paper-hi` fill, 1.5px accent border |

**Why three devices stopped drawing.** Seeing the Conformed Set on a phone for the first time, the owner's first note was: *"there are some weird boxes and lines in some places, notably the metrics and coach brief on the home screen, but there are more."* That is the surface system reading as **noise instead of structure**, which is the one failure mode it cannot survive — the marks were not being read as a drawing vocabulary, they were being read as artefacts. §5's own rule settles it: **drafting chrome pays rent or goes**, and a mark a viewer has to interpret before it helps them is decoration.

- **Field** — was two 11px L-shaped corner ticks at opposite corners. The most abstract device in the set and the least self-explanatory: nothing on screen teaches you that a bracket means *"this region was measured"*, so a lone L with no outer edge reads as a stray glyph or a clipped border.
- **Margin** — was a 2px left rule and a 12px indent. Beside a paragraph that IS the section rather than an aside to one, the rule annotates nothing and reads as a rendering glitch.
- **Grid** — was hairlines between cells (top rule on every cell, plus a vertical between the two columns). On a phone that reads as a half-drawn box: an L of lines floating with no outer edge. Columns line up on their own, and a two-column block of label / value / detail is legible as a table without a single stroke (`src/components/home/metrics-strip.tsx` is the reference form).

All three are **kept as named devices rather than deleted**, because the call site still declares what kind of content it holds — that declaration is the documentation the surface system exists for — and because restoring a mark is one line in `DEVICE` if the owner ever wants one back. The padding went with the marks: with nothing enclosing the content, an inset only knocks those sections out of alignment with the unboxed sections above and below.

**What is left drawn is the set where enclosure does real work:** `plate` closes a record, `well` recesses a capture surface, `stamp` marks the one next action. Everything else is separated by air and distinguished by type — which is what this design already says sections do (§4: *rules enclose objects, never pages*).

**The chat thread is not a well.** It was drawn as one, on the reading "a capture surface, and the turns are marks made on it". On hardware that read as a conversation put in a box for no reason (owner, 2026-08-09) — and the reading was wrong anyway: a well is for a surface you *capture into*, and the thing you capture into on the Coach screen is the composer, which wears the well already. The conversation is not a record filed on the page, it **is** the page. So the thread sits directly on the sheet with no device and no section label, and only the turns are drawn (`app/(tabs)/coach.tsx`, `src/components/coach/message-bubble.tsx`). The turns themselves did not change: the user speaks in solid accent, the Coach answers on bordered `paper-hi` slips.

**Rule:** a block gets exactly one device. Never nest devices (no plate inside a plate). This still holds for the three unmarked devices — they draw nothing, but the call site is still a claim about content. It is enforced at runtime in `__DEV__`: a nested `Block` logs a `console.error` naming both devices.

## 2. Colour

Ground is a neutral drafting bone that reads clean under either accent.

| Token | Hex | Use |
| --- | --- | --- |
| `paper` | `#E7E4DA` | the sheet — every screen background |
| `paper-hi` | `#F5F3EC` | plates (cards, ruled records) |
| `paper-dim` | `#D9D5C8` | recessed stock (inputs, chat) |
| `paper-deep` | `#C6C1B0` | recessed edges |
| `paper-line` | `#A9A28E` | the default rule: plate borders, row separators |
| `ink` | `#1C1911` | primary text |
| `ink-soft` | `#443F30` | supporting text, prose |
| `ink-faint` | `#5C5340` | the metadata layer — labels, captions, timestamps — **clears 4.5:1 on both `paper` (5.97:1) and `paper-dim` (5.17:1)** *(it used to draw the corner ticks too; those are gone, see §1)* |

**Accent — DECIDED 2026-08-08: petrol.** Redline was rejected (ADR in `docs/decisions.md`): it forces `bio-poor` to umber and permanently strains the chrome/biology firewall in a product whose worst health state *is* red. Petrol has no such collision. Redline's values are kept below only so the rejected alternative stays legible.

| | **petrol — shipped** | redline *(rejected)* |
| --- | --- | --- |
| `accent` | **`#12454E`** | `#C4222E` |
| `accent-deep` | **`#082A30`** | `#A21522` |
| `accent-bright` | **`#4E96A1`** | `#E0202F` |

**Biology signals — never chrome:**

| Token | Hex |
| --- | --- |
| `bio-optimal` / ink | `#2E8B57` / `#185A36` |
| `bio-good` / ink | `#2C6C95` / `#24567A` |
| `bio-caution` / ink | `#A97B22` / `#6E4F15` |
| `bio-poor` / ink | `#AA402C` / `#8F3524` |

> **The firewall rule (sacred).** Signal colours mark **biological state only** — pillars, freshness, biomarker states, overdue screenings. Never interface chrome. Conversely the accent never marks biology. Redline *would have* forced `bio-poor` to umber `#7A4A1E` / `#5E3A16`, because crimson chrome and rust biology read as one hue at swatch size — a finding in all six hostile reviews. Petrol has no such collision, which is the main reason it was **chosen** (ADR, 2026-08-08). The umber values are recorded only so the rejected branch stays legible.

**Accent budget (a ceiling, not a quota).** The accent appears only on: the Home hero, **one** primary action per screen, completion stamps, the user's own chat bubbles, the active tab, and the Coach presence dot. **Settings carries no accent at all.**

## 3. Typography — three voices

| Voice | Stack | Used for |
| --- | --- | --- |
| **Label** | Bahnschrift SemiCondensed → Franklin Gothic Medium → Segoe UI Semibold → Century Gothic | uppercase section labels, eyebrows, buttons, chips |
| **Mono** | Consolas → Cascadia Mono → ui-monospace → SF Mono → Menlo | **every measured value** — times, counters, versions, metrics, dimension strings |
| **Serif** | Constantia → Sitka Text → Palatino Linotype → Georgia | prose — briefs, coach turns, why-lines, item titles |

"Serif speaks, mono measures." A standalone measurement set in the label or serif face is a bug.

**Clarification — "buttons" means every button, at every weight.** Filled primary, outlined secondary, and bare text buttons all take the Label voice, as do chips. The face is what makes a control read as a control; a button that falls back to the reading face stops looking pressable and starts looking like a sentence. Weight is expressed by *size and casing*, never by face: full-width primary actions sit at 15px sentence case, compact and inline actions at 11–13px uppercase with ~1.2px tracking. The one exception is a measured value inside a label — `v3`, `280 g`, `12 sets` — which stays mono, per the rule above.

⚠️ **iOS reality check.** These are Windows-first stacks chosen for the browser mockup. On iOS the first families resolve differently — Bahnschrift and Constantia do not exist there. Before implementation, either (a) re-pick iOS-native equivalents (e.g. label → *Avenir Next Condensed / Helvetica Neue*, serif → *Iowan Old Style / Palatino*, mono → *Menlo / SF Mono*), or (b) ship a real face via `expo-font` (already installed). **This is a required decision — see `02-migration-plan.md`.**

## 4. Geometry & rhythm

- **Corners: square.** No radii on plates or rows (a departure from Porcelain Ledger's 10px cards). Buttons take a 2px radius at most.
- **No shadows, no elevation, no glow, no gradients** inside the screen. Layering is borders + the paper/paper-hi/paper-dim triad.
- **Rules enclose objects, never pages.** A hairline is correct on a plate edge and between rows of one list. Sections are separated by whitespace.
- **Tap targets:** every tappable row/button ≥ 44pt. Single-line rows need an explicit `min-height`.
- **Text floor:** nothing below 9px rendered; the metadata layer should sit at 9.5–10px so the floor isn't load-bearing.

### 4a. The paper grid — the sheet is drafting stock, not blank paper

**The mockup has two grids, and only one of them is the design.** Getting this wrong is not hypothetical: the first RN port dropped both, and the owner's first look at real hardware was *"the architecture themed blueprint background is missing."* Fixed 2026-08-09.

| Mockup token | What it is | Ships? |
| --- | --- | --- |
| `--desk` `#0A0B0C` + `--desk-grid` / `--desk-grid-strong` (14px / 74px, on `.cf-desk`) | the dark studio surround the mockup *phone* sits on, plus the registration ticks at its corners | **No.** Presentation chrome — it is outside the phone bezel and there is no such surface in an app. |
| `--paper-grid` `rgba(28, 24, 14, 0.06)` (9px, on `.cf-screen`) | a faint drafting rule printed **on the sheet itself**, inside the screen, under every block | **Yes. This is the design.** Without it the ground is flat white-ish card and the whole set stops reading as a working drawing. |

**The mockup's drawing** (`arc-conformed-set.html`, `.cf-screen`) is two stacked `repeating-linear-gradient`s, horizontal and vertical, `0 1px` ink then `1px 9px` transparent. **Uniform** — no major/minor emphasis; the 14/74 two-tier scheme belongs to the desk, not the sheet.

**The shipped implementation** (`PaperGrid` in `src/components/ui/screen.tsx`) is **absolutely-positioned 1pt `View`s — one per rule**, sized to `useWindowDimensions()`. React Native has no `repeating-linear-gradient` and this had to land with **zero new native dependencies** (the owner runs a dev client; a new package costs a ~20-minute cloud rebuild), so the two candidates were a repeat-tiled PNG or Views. The PNG was tried first, on the node-count arithmetic below. **It shipped twice and never rendered on the owner's device once** — see the box after the calibration table. Views cannot fail to draw, and after three rounds on this one texture, certainty outranks elegance.

- **Rules:** one `View` per 9pt boundary in each axis, `position: 'absolute'`, `backgroundColor: palette.ink`, spanning the layer (`top: 0, bottom: 0, width: 1` for verticals; `left: 0, right: 0, height: 1` for horizontals). Offsets are whole multiples of 9, so no rule lands on a half-pixel.
- **1pt, not `StyleSheet.hairlineWidth`.** A hairline is one *physical* pixel — a third of a point at @3x. That is a third of the ink the calibration below assumes, which would put the texture straight back under the detection threshold that already failed twice. The mockup's rule is 1 CSS px and the retired PNG baked 1pt at every density; 1pt is the match.
- **Ink `#1C1911` at full alpha; the strength is the group's `opacity`.** Deliberate, for two reasons. It makes the calibration a **single number**. And verticals and horizontals *cross* — two translucent rules stacked would composite to ~0.36 and print a visible dot lattice at every intersection, where one faded group lands every rule and every crossing at the same weight, exactly as the tile did.
- **Sizes itself.** `useWindowDimensions()` means the line count follows the device and re-derives on rotation; the layer sits behind a full-bleed root, so window dimensions are the right measure.
- Drawn **behind** everything and **outside** the `SafeAreaView` so it runs edge to edge with no seam at the status-bar inset.
- **It does not scroll.** The paper is the fixed thing; content moves over it. Matches the mockup (`--paper-grid` is on the screen, not on the content) and costs nothing per frame.
- `pointerEvents="none"` and `accessibilityElementsHidden` — inert to touch and invisible to VoiceOver.

**The node count, honestly.** At 9pt: **117** Views on a 375 × 667 SE (42 vertical + 75 horizontal), **139** on a 393 × 852 iPhone 16 (44 + 95), **156** on a 440 × 956 Pro Max (49 + 107). That was the original argument *against* Views, and it is a real cost — but it was overstated. The layer derives from nothing but the window size, so it **mounts once per root and never re-renders**: it never measures, never animates, never scrolls, and holds no state. Core Animation caches the faded group and each frame is a composite of flat sublayers. ~140 inert leaves is less than a single populated list screen. The "several hundred on a long scroll" in the old argument was simply wrong — the layer is fixed, so its size is the *window*, not the content.

If it ever does need to be cheaper, `paperGrid.pitch` is now **live** (`PaperGrid` reads it) rather than baked into an asset, so 18 halves the count with a one-number edit and no regeneration step. **9pt stays for now**: it is the reviewed value, it transfers 1:1 from the mockup, and changing the render method and the pitch in the same round would make the next diagnosis harder than it needs to be.

**Calibration — the point is texture, not a grid.** `paperGrid` in `src/constants/theme.ts` is the whole control surface:

| | Value | Why |
| --- | --- | --- |
| `pitch` | **9pt** | Straight from the mockup. The mockup phone is ~1 CSS px ≈ 1pt, so 9 transfers 1:1 and the angular size on device matches what was reviewed. |
| `opacity` | **0.20** | Puts a grid line at **1.51:1** against the sheet — half the weight of a `hairline`, which is the intent this section always stated. Raised from 0.06 on 2026-08-10; see below. |

**Two rules per cell is what the mockup asks for.** `.cf-screen` stacks a `0deg` *and* a `90deg` `repeating-linear-gradient`, so a rule on both axes at every boundary is exactly what was reviewed — and it is what the retired PNG did too (its 9 × 9 tile ruled its top edge and its left edge: 17 of 81 opaque pixels, 20.99%, identical at @2x and @3x). The View layer reproduces that geometry line for line. **The geometry was never the fault**, in either implementation.

**The number that justifies the calibration is contrast, not coverage.** Composited over `paper` `#E7E4DA` and quantised to 8-bit the way iOS actually composites, against a ceiling of `paper-line` `#A9A28E` = **2.00:1** (the surface system's real rule, on the same ground):

| `opacity` | Line colour | vs sheet | Weight vs `hairline` | |
| --- | --- | --- | --- | --- |
| 0.06 | `#DBD8CE` | 1.12:1 | 12% | the old value — **invisible on device** |
| 0.10 | `#D3D0C6` | 1.21:1 | 21% | |
| 0.14 | `#CBC8BE` | 1.32:1 | 32% | |
| **0.20** | **`#BEBBB2`** | **1.51:1** | **51%** | **shipped** |
| 0.26 | `#B2AFA6` | 1.72:1 | 72% | |
| 0.30 | `#AAA79E` | 1.89:1 | 89% | too close to a real rule |
| 0.35 | `#A09D94` | 2.13:1 | 113% | over the ceiling |

> **Calibration corrected 2026-08-10, after the owner reported a second time that the sheet read as blank.** The dial was set below the eye's detection threshold, and **an arithmetic error in this very paragraph concealed that for two rounds**: it read *"the grid sits at a bit over half the weight of the faintest thing that means 'this encloses an object'"*, taking 1.12:1 against 2.00:1 as ≈56%. But a contrast ratio is anchored at **1.0, not 0** — a mark's weight is how far it *departs* from that anchor. The grid departed by 0.12 and the hairline by 1.00, so the grid was at **12%** of a hairline, roughly an eighth of the stated intent. The prose was right; the number under it was not, and re-checking the *coverage* figure (which two rounds did) could never surface it.
>
> **Then the owner reported it a THIRD time — at 0.20, after a full restart.** That is what condemned the `Image` path. The paragraph above had claimed *"this was never a rendering fault"*; it was. A restart clears the Metro cache, so a stale asset registry was ruled out, and 1.51:1 is not a value anyone squints at — the layer simply was not drawing. The prime suspect is `resizeMode="repeat"`, the least-exercised resize mode on iOS with a history of not tiling, but **the honest position is that the cause was never proven**, and that is precisely why the fix is not another attempt at the image. Rewritten as plain `View`s, 2026-08-10.

Three lessons worth keeping. **Compare departures from the anchor, never the ratios themselves** — the specific mistake that shipped an invisible grid twice. **A browser on a bright desktop monitor is not a phone**: the mockup's 6% was chosen there and did not survive the transfer, so any value from `arc-conformed-set.html` is a starting point to re-measure on hardware, not a spec. And **when the same device report arrives a third time, stop refining the parameter and change the mechanism** — two rounds went into tuning a layer that was not rendering at all, because each round found a real-looking fault (the tile, then the dial) and shipped the fix for it instead of testing whether anything was drawing.

**Why the dial and not the pitch.** A 1pt rule at 1.12:1 is under threshold at *any* spacing, so coarsening the pitch would only have produced fewer invisible lines. At 9pt the grid is ~1 mm on a @3x phone and subtends ~11 arcmin at reading distance — an order of magnitude above visual acuity. The spacing was never what failed to register; the individual rule's contrast was. 9pt stays.

**The guard rail, restated.** A plate edge must stay unmistakably about twice the departure of the texture beneath it — that gap is what keeps §4's *"rules enclose objects, never pages"* true, and it is the thing to preserve if the dial moves again. Sane range **0.16–0.24** (1.37:1 – 1.65:1). **If the grid starts reading as a rule rather than as tooth in the paper it is too strong** — but every failure so far has been the opposite one, so err high rather than low. `opacity` is the dial — change it there and nowhere else.

**Changing the pitch** is now a one-number edit: `paperGrid.pitch` in `src/constants/theme.ts` is read by `PaperGrid`, there is no asset to regenerate, and the line count re-derives from `useWindowDimensions()`. The three PNG tiles (`assets/images/paper-grid*.png`) and their `zlib` generation recipe were **deleted** with the `Image` path — nothing requires them, and leaving a recipe for an approach that never worked on device is how it gets tried a fourth time.

**The known gap, since closed.** The grid used to reach exactly as far as `Screen` did, so the six surfaces that build their own root instead — the Coach tab, the exercise and routine pickers, the mode-control sheet, the app-lock screen and the error boundary — printed on plain sheet. The layer was lifted out into an exported **`PaperGrid`** component (`src/components/ui/screen.tsx`) and all six now render it, so `paperGrid.opacity` is still the single dial — and so the View rewrite reached all seven roots in one edit, with no call site touched. **Still ungridded:** the tab bar and any stack header. Both are chrome bands rather than sheet, so this is arguably right, but it has not been judged on a device.

## 5. Honesty rules (carried from the hostile reviews)

These are design requirements, not copy suggestions — each one was a real finding:

- **Ledgers must sum to their own totals.** If the Today card says 2,180 kcal, the visible meals must add to 2,180.
- **Tallies must reconcile.** "3 of 11" with a fold means folded + visible = 11, and *skipped ≠ done*.
- **Empty is authored, never blank.** "No reading yet", "Import labs to populate", "Nothing logged yet today."
- **No data, no number.** VO₂max with no wearable source is an em-dash — never a plausible-looking estimate. No denominators until targets exist.
- **A pending write is a live decision.** The confirmation card is the *last* thread object, its consequence in future tense ("On approve: v2 is written; v1 is kept"), with nothing after it and the composer disabled. Never draw a decision and its outcome simultaneously.
- **No invented reference codes.** No sheet numbers, tile keys, or designator badges inside the app that key no user action. Drafting chrome must pay rent or go.
- **Product nouns, not conceit vocabulary.** It is "Today's Mission", not "Issue Schedule". The user should never have to learn the metaphor.
