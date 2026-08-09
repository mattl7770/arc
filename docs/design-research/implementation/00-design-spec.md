# The Conformed Set — design specification

**Status: ADOPTED 2026-08-08** — this is the shipped visual system and the spec of record. Supersedes **Porcelain Ledger** (chosen 2026-07-24). The adoption ADR, including the accent and typeface decisions, is in `docs/decisions.md`; what actually shipped is recorded in `02-migration-plan.md`.
**Mockup of record:** `docs/design-research/arc-conformed-set.html` (14 sheets: 10 canonical screens + 4 alternate states).
**Provenance:** convergence of a six-set exploration, each hostile-reviewed for usability + anti-slop; this set re-reviewed at 0 high findings, then fixed and verified. Full trail in `docs/design-research/`.

> **The philosophy in one line:** ARC is a working drawing set — the day is *drafted*, not listed.

Where Porcelain Ledger is a printed lab report, this is the architect's set that produced it: the same calm and the same restraint, but the container tells you what kind of thing it holds. It leans on ARC's own name — *Architecture for Resilience & Continuity*.

---

## 1. The surface system — "devices" (the load-bearing idea)

Every content block is a drafting container, and **the container encodes the content type**. This is the whole design. A plate on everything reads flat; boxing nothing reads unreadable. Each kind of content gets its correct drawing device:

| Content | Device | Treatment |
| --- | --- | --- |
| Schedules, ledgers, record lists (mission, Data trends, Settings rows, Protocols, Screenings) | **Ruled plate** — a record is a table | `paper-hi` fill, 1px `paper-line` border, ruled rows inside |
| Readiness / status verdict | **Measured field** — corner ticks, no enclosure | transparent, 11px L-shaped ticks at top-left + bottom-right |
| Prose (Coach brief, rationale) | **Margin annotation** | transparent, 2px left rule, indented |
| Metric grids | **Ruled grid, no outer box** — the grid *is* the object | transparent, hairline between cells only |
| Capture surfaces (command field, chat thread) | **Recessed stock** — an input well | `paper-dim` fill, `paper-deep` border |
| The one next action | **Stamped plate** | `paper-hi` fill, 1.5px accent border |

**Rule:** a block gets exactly one device. Never nest devices (no plate inside a plate).

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
| `ink-faint` | `#5C5340` | labels, captions, corner ticks — **clears 4.5:1 on both `paper` (5.97:1) and `paper-dim` (5.17:1)** |

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
- **No shadows, no elevation, no glow, no gradients** inside the screen. Layering is borders + the paper/paper-hi/paper-dim triad. (The desk-and-registration chrome in the mockup lives *outside* the phone and is presentation only — it does not ship.)
- **Rules enclose objects, never pages.** A hairline is correct on a plate edge and between rows of one list. Sections are separated by whitespace.
- **Tap targets:** every tappable row/button ≥ 44pt. Single-line rows need an explicit `min-height`.
- **Text floor:** nothing below 9px rendered; the metadata layer should sit at 9.5–10px so the floor isn't load-bearing.

## 5. Honesty rules (carried from the hostile reviews)

These are design requirements, not copy suggestions — each one was a real finding:

- **Ledgers must sum to their own totals.** If the Today card says 2,180 kcal, the visible meals must add to 2,180.
- **Tallies must reconcile.** "3 of 11" with a fold means folded + visible = 11, and *skipped ≠ done*.
- **Empty is authored, never blank.** "No reading yet", "Import labs to populate", "Nothing logged yet today."
- **No data, no number.** VO₂max with no wearable source is an em-dash — never a plausible-looking estimate. No denominators until targets exist.
- **A pending write is a live decision.** The confirmation card is the *last* thread object, its consequence in future tense ("On approve: v2 is written; v1 is kept"), with nothing after it and the composer disabled. Never draw a decision and its outcome simultaneously.
- **No invented reference codes.** No sheet numbers, tile keys, or designator badges inside the app that key no user action. Drafting chrome must pay rent or go.
- **Product nouns, not conceit vocabulary.** It is "Today's Mission", not "Issue Schedule". The user should never have to learn the metaphor.
