# Design Directions — the archive

**Read this file before proposing any new visual direction.** It holds every direction ARC has explored, and which one is current.

> ## ✅ CURRENT: **the Conformed Set** — chosen 2026-08-08
>
> Documented as the design philosophy in `project-status.md` §3; spec of record `docs/design-research/implementation/00-design-spec.md`; ADR in `docs/decisions.md`. **It supersedes Direction A (Porcelain Ledger)**, which was the choice from 2026-07-24 and shipped for two weeks. Its own section is at the bottom of this file; the 2026-07-24 exploration below is kept unmodified as history.

---

## The 2026-07-24 exploration — six directions

Six complete visual directions were developed for ARC (four by parallel designer agents, two — D and E — authored directly after agent infrastructure failures), then audited by an independent critic for contrast, distinctness, and fit. All six passed the contrast audit; full mock-ups (Home + Coach, identical content) were reviewed by Matt.

**DECISION: Direction A — Porcelain Ledger — chosen 2026-07-24.** ~~It is implemented in the app~~ — **superseded 2026-08-08 by the Conformed Set** (see the top of this file, and its section at the bottom). Porcelain Ledger did ship, and three of its calls outlived it: light-mode only, no shadows/elevation/glow, and the `platformSelect` font-stack gotcha. The other five below are archived unmodified, in case we revisit.

Critique highlights worth remembering:
- **A and C are structural siblings** (warm paper + serif + mono numerals + one solid accent); they differ mainly in accent temperature (pine vs clay). If A ever feels too cool, C is the adjacent move, not a redesign.
- **F's categorical signal taxonomy** (green / blue / gold / red — four *hues*, not a saturation slide) was called the model to follow. A's olive `good` sits between green `optimal` and amber `caution`; accepted for now, revisit if the segment bar reads ambiguously on device.
- **B's flaw if revived:** its amber accent collides with its orange caution signal — separate them before use.

---

## A — Porcelain Ledger (light) — chosen 2026-07-24, **superseded 2026-08-08**

> ARC as a beautifully printed lab report that happens to be alive: bone-white paper, warm ink, hairline rules, and one deep pine-green stamp of authority. Nothing glows, nothing gamifies — the interface earns trust the way a well-set medical document does, through typography, whitespace, and restraint. Decades-durable because paper never goes out of style.

| Token | Hex | | Token | Hex |
|---|---|---|---|---|
| bg | `#F6F3EC` | | accent | `#1E5C46` |
| surface | `#FDFCF8` | | onAccent | `#F8F6EF` |
| border | `#E3DCCE` | | accentSoft | `#E7EEE6` |
| textPrimary | `#1C1917` | | signalOptimal | `#22684E` |
| textSecondary | `#544E45` | | signalGood | `#77803A` |
| textMuted | `#8B8272` | | signalCaution | `#B07C2A` |
| userBubble | `#1E5C46` / `#F8F6EF` | | signalPoor | `#96382C` |
| coachBubble | `#FDFCF8` / `#1C1917` | | | |

- **Type:** headlines `'Iowan Old Style', 'Palatino Linotype', Georgia, serif` at 600; body system sans; **numerals mono** (lab values). Eyebrows: uppercase, 2px tracking, 11px, textMuted, often over a hairline rule.
- **Shape:** cards 10px, buttons rounded-6, airy density.
- **Treatments:** hero = accentSoft card, 1px accent-tinted border, **3px solid accent rule across the top edge — a stamped ledger entry**; serif headline, mono metadata; Done solid accent, Snooze/Skip hairline ghosts. Segment bar: flat 6px rectangles, 2px gaps, no glow, mono-caps labels. All cards porcelain with hairline borders, **no shadows**. Metrics as mono lab values, units muted. Coach bubbles = bordered porcelain slips (one squared corner); user bubbles solid pine. Tab bar: hairline top rule, active in accent.
- Contrast audit: all pairings 7.3:1–17:1. Not a teal clone (pine is darker, warmer, on warm paper).

## B — Night Watch (dark) — archived

> A precision instrument you consult in the dark: a dive computer for your biology. True black conserves attention the way OLED conserves power — only the things that matter emit light. Amber phosphor says "trusted hardware, decades of service."

bg `#000000` · surface `#12100C` · border `#2A2419` · text `#F2EDE4` / `#B0A794` / `#756D5E` · accent `#FFB000` (onAccent `#000000`, soft `#1F1608`) · signals `#48D66C` / `#A8D96A` / `#FF8A3D` / `#FF5A52` · user bubble amber/black · coach bubble `#16130E`.
Sans headlines 600; **all numerals ui-monospace tabular**; mono uppercase eyebrows like instrument labels. Cards 12px, hairline-bordered on true black, never elevation. Hero: accentSoft + 3px amber **left** rule. Segment bars 3px with a faint same-hue glow — the only glow in the app. Contrast 8.8:1–18:1. **Known fix needed: separate amber accent from orange caution.** Candidate future role: ARC's dark companion mode if Porcelain Ledger ever gains one.

## C — Clay Almanac (light) — archived

> A beautifully kept field journal: the calm authority of a printed almanac crossed with the rigor of a lab notebook. A single disciplined stroke of fired clay marks exactly one thing: what to do next.

bg `#F6F1E6` · surface `#FDFAF2` · border `#E3D9C6` · text `#2A211A` / `#584B3E` / `#8B7B68` · accent `#B24422` clay (onAccent `#FFF8EF`, soft `#F4E4D6`) · signals `#3D7A46` / `#6F7D3C` / `#C07C2B` / `#8F2F35` · user bubble clay · coach bubble paper.
Georgia serif 700 headlines; mono numerals; **eyebrows set in clay** like a printed folio line. Cards 14px, airy. Verdict word in serif italic. Metrics separated by hairline rules, not tiles. Contrast 5.3:1–15:1 (onAccent 5.3:1 is the thinnest margin of the set). Structural sibling of A.

## D — Ultraviolet (dark) — archived · authored in-session, not by a designer agent

> Recovery as a competitive edge: slate-indigo night, one electric violet, athletic but premium — no gamer RGB.

bg `#0D0C16` · surface `#16142A` · border `#272345` · text `#EDEBFB` / `#A9A3CC` / `#6E6890` · accent `#9D7BFF` (onAccent `#16102E`, soft `#1E1838`) · signals `#3ECF8E` / `#5EA8FF` / `#F5B63F` / `#FF6B6B` (categorical, per critique) · user bubble violet · coach bubble `#1B1834`.
Sans throughout, headlines 700, pills, cards 16px, metric tiles as cards.

## E — Eucalypt (light) — archived · authored in-session, not by a designer agent

> A well-tended greenhouse for your biology: sage-tinted surfaces (the page itself is green-cast, not white), deep forest ink, soft pill geometry, lowercase wide-tracked eyebrows. Spa-calm but data-credible.

bg `#EEF1E8` · surface `#F9FAF4` · border `#D9DFC9` · text `#243122` / `#4D5B48` / `#79856F` · accent `#3B6647` (onAccent `#F3F7EE`, soft `#DFE8D6`) · signals `#2E7B4F` / `#6C8F3B` / `#C3922E` / `#A8503A` · user bubble forest · coach bubble surface.
All sans, headlines 600, cards 20px, pills everywhere, airy. Metric tiles as soft cards.

## F — Carbon Ledger (light) — archived

> A permanent record, not an app: a paper ledger kept for decades, where the only ink that isn't black is the signal itself. Severe, honest, immune to trend decay.

bg `#F6F5F1` · surface `#FFFFFF` · border `#1C1C1A` (1px black rules) · text `#111110` / `#3F3F3A` / `#6E6E66` · accent = black `#141412` (onAccent paper) · signals `#177245` green / `#2456A6` blue / `#8F6400` gold / `#B3261E` red — **the reference categorical taxonomy** · user bubble black block · coach bubble white, hairline-ruled.
Mono headlines 700; body sans; 2px corners; square buttons (primary = solid black); compact. Hero fully inverted: the single black mass on a white page. 2px offset hard shadows, zero blur. Contrast 9.7:1–18.9:1 — strongest audit numbers of the set; rejected as a whole for austerity, but its signal taxonomy and inverted-hero idea are worth stealing.

---

# The 2026-08-08 exploration — the Conformed Set

## ✅ CHOSEN — the Conformed Set (light) — adopted 2026-08-08

> **ARC is a working drawing set — the day is *drafted*, not listed.** Where Porcelain Ledger was a beautifully printed lab report, this is the architect's set that produced it: the same calm and the same restraint, but **the container tells you what kind of thing it holds**. It leans on ARC's own name — *Architecture for Resilience & Continuity* — without ever asking the user to learn the metaphor.

**Provenance — how this one was arrived at, and why it is not a seventh sibling of the six above.** A second, larger exploration was run: **six complete sets**, each fully specified against the app's real screen inventory, and each put through a **hostile review** for usability and anti-slop — **89 findings across the six**. The sets were then *converged* into this one rather than voted between, and the convergence was **re-reviewed hostilely and driven to zero high findings**, then fixed and verified. The whole trail is in `docs/design-research/`: the screen inventory (`00`), the evidence brief (`01`), the framework (`02`), the anti-slop and cohesion gate (`03`), the evidence ledger and precedent map (`04`), the validation protocol (`05`), the overhaul brief (`06`), the precedent atlas (`07`), the critical-claim ledger (`08`) and the screen traceability matrix (`09`). The mockup of record is `docs/design-research/arc-conformed-set.html` — 14 sheets: 10 canonical screens plus 4 alternate states.

**The load-bearing idea is the surface system, not the palette.** Every content block is a drafting *device* whose container encodes what it holds — `plate` (records), `field` (a verdict; corner ticks, no enclosure), `margin` (prose), `grid` (metrics; rules between cells only), `well` (capture surfaces), `stamp` (the one next action). A block gets exactly one device, and devices never nest. Under Porcelain Ledger everything was a card, so the container said nothing; here it is the first thing that says what you are looking at.

| Token | Hex | | Token | Hex |
|---|---|---|---|---|
| paper (the sheet) | `#E7E4DA` | | accent (petrol) | `#12454E` |
| paper-hi (plates) | `#F5F3EC` | | accentDeep | `#082A30` |
| paper-dim (wells) | `#D9D5C8` | | accentBright | `#4E96A1` |
| paper-deep (edges) | `#C6C1B0` | | onAccent | `#F5F3EC` |
| hairline (the rule) | `#A9A28E` | | signalOptimal | `#2E8B57` / ink `#185A36` |
| ink | `#1C1911` | | signalGood | `#2C6C95` / ink `#24567A` |
| inkSecondary | `#443F30` | | signalCaution | `#A97B22` / ink `#6E4F15` |
| inkMuted | `#5C5340` | | signalPoor | `#AA402C` / ink `#8F3524` |

- **Two cuts per biological state** — the plain token is the **swatch** (fills and icons, 3:1); the `-ink` cut is **text** (4.5:1). They are not interchangeable; as text on `paper-hi` two of the four swatches fail outright.
- **Type — three voices:** label `Avenir Next Condensed → Helvetica Neue → system-ui` (uppercase labels, eyebrows, chips and **every** button), serif `Iowan Old Style → Palatino → Georgia` (prose), mono `Menlo → Courier New` (**every** measured value). *Serif speaks, mono measures.* These are **iOS-native substitutions**: the mockup's Bahnschrift and Constantia are Windows faces and do not exist on iOS.
- **Shape:** square. `rounded-card` → `0px`, buttons 2px. No shadows, no gradients, no glow. Rules enclose objects, never pages.
- **Accent budget (a ceiling):** Home hero · one primary action per screen · completion stamps · user chat bubbles · active tab · Coach presence dot. **Settings and reference surfaces carry zero.**
- **The firewall runs both ways:** signal colours mark biology only and never chrome; the accent never marks biology.

**Why petrol and not the redline alternative (`#C4222E`)?** Redline forces `signalPoor` to shift to umber `#7A4A1E`, because crimson chrome and rust biology read as one hue at swatch size — a finding in **all six** hostile reviews. ARC's worst health state is red by every convention the user already has, so a red accent puts permanent strain on the firewall. Petrol has no such collision. This is the same failure mode the 2026-07-24 critique flagged in Direction B (amber accent vs orange caution): **an accent must not share a hue with a signal.** That is now a general rule, not a note on one archived direction.

⚠️ **Judged in a browser only — no iPhone has rendered it.** The typefaces were browser-chosen, and `Avenir Next Condensed`, `border-dashed` and the rotated-diamond markers are all first-of-kind in this tree and **fail silently** if unsupported. `project-status.md` §3 carries the full unverified list.

**If this ever needs replacing,** the useful ideas still on the shelf: F's categorical signal taxonomy (already effectively adopted — the four signals are four hues, not a saturation slide, which fixes A's olive `good`), F's inverted hero, and B (Night Watch) as the designed candidate should ARC ever want a night mode.
