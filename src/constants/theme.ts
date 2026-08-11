/**
 * Raw Conformed Set values for APIs that cannot take a Tailwind class —
 * navigation themes, status bar, icon `color` props.
 *
 * KEEP IN SYNC with `tailwind.config.js`. That file is the source of truth for
 * anything styled with `className`; this one exists only because a few APIs
 * need literal colour strings. Design philosophy: docs/project-status.md §3,
 * full spec: docs/design-research/implementation/00-design-spec.md.
 *
 * Every EXPORTED KEY NAME is unchanged from Porcelain Ledger — only the values
 * moved. `palette` is imported by 51 files (almost all for Ionicons `color`
 * props), so keeping the names meant none of them needed editing. Read `pine`
 * as "the one accent" and `hairline` as "the rule": the names outlived their
 * original hues, which is a fair trade against a 51-file rename sweep.
 * (Recounted 2026-08-09; this comment read "~44" — true when the design kit was
 * drafted, then the restyle sweep added importers. 52 files import something
 * from this module; app/_layout.tsx takes only `navColors`.)
 *
 * Two other files hold their own copy of the page colour and do NOT follow a
 * Tailwind change — check both if the palette moves again:
 *   - app.json                → splash backgroundColor
 *   - app/(tabs)/_layout.tsx  → the tab bar, styled imperatively from `palette`
 */

export const palette = {
  /** The sheet — every screen background. */
  paper: '#E7E4DA',
  /** Recessed edges. */
  paperDeep: '#C6C1B0',
  /**
   * Alias of paperHi. SHIM — zero consumers as of 2026-08-09 (swept over all
   * 191 source files in app/ + src/). Kept because a dead token is one line;
   * NOT because anything depends on it. Use `paperHi`.
   */
  porcelain: '#F5F3EC',
  paperHi: '#F5F3EC',
  /** Recessed stock — input wells, the chat thread. */
  paperDim: '#D9D5C8',
  /**
   * The rule: plate borders and row separators.
   *
   * The one value in this palette that does not clear its threshold. WCAG
   * 1.4.11 asks 3:1 of non-text visuals; measured 2026-08-09 this is
   * paperHi 2.29:1 · paper 2.00:1 · paperDim 1.73 · paperDeep 1.41. ACCEPTED
   * for plate borders / row separators / the margin rule (they enclose text
   * that is itself >=5.97:1), OPEN for the `well` device, whose border marks an
   * input. Full decision: docs/project-status.md §3 + the ADR. A darker rule,
   * if ever wanted, is #7E7767 (4.01 / 3.50) — and it moves in
   * tailwind.config.js in the same change.
   */
  hairline: '#A9A28E',
  /** SHIM — zero consumers as of 2026-08-09. 1.62:1 on paperHi; barely a rule. */
  hairlineSoft: '#C6C1B0',
  /**
   * Byte-identical to `hairline` — it cannot render differently. The Tailwind
   * class `*-hairline-strong` has zero consumers, but THIS export is LIVE:
   * app/settings.tsx reads it twice (a Switch `trackColor` +
   * `ios_backgroundColor`). Retiring it means editing that screen first.
   * (Path corrected 2026-08-09: Settings came off the tab bar and moved
   * verbatim to `app/settings.tsx` when the shell went to six tabs —
   * `app/(tabs)/settings.tsx` no longer exists.)
   */
  hairlineStrong: '#A9A28E',
  ink: '#1C1911',
  inkSecondary: '#443F30',
  /**
   * The metadata layer. Measured on all four surfaces: paper 5.97:1 ✓,
   * paperHi 6.84:1 ✓, paperDim 5.17:1 ✓, paperDeep 4.21:1 ✗ — it FAILS on
   * paperDeep. Use `inkSecondary` (5.83:1 there) for metadata on that surface.
   */
  inkMuted: '#5C5340',
  /** The one accent (petrol). Redline alternative was '#C4222E' — see the ADR. */
  pine: '#12454E',
  /** Live — 21 reads here plus 33 `*-pine-on` class uses (2026-08-09). */
  pineOn: '#F5F3EC',
  /**
   * SHIM — zero consumers as of 2026-08-09, and the FIRST candidate for
   * retirement of the whole set: #E7EEE6 is a leftover GREEN tint from the
   * pre-petrol pine (green-dominant, G238 > B230) while petrol #12454E is
   * blue-dominant (B78 > G69), so it no longer harmonises with the accent whose
   * name it carries. The surface it served is gone too — the Home hero is a
   * `stamp` now, plate fill inside a 1.5px accent border, not a tinted panel.
   */
  pineSoft: '#E7EEE6',
  /** SHIM — zero consumers as of 2026-08-09. Unlike pineSoft it does lean blue. */
  pineTint: '#9FBEC2',
  /** Live — 5 `*-pine-deep` class uses (2026-08-09); no reads through here. */
  pineDeep: '#082A30',
  /**
   * Mirrors `pine.bright` in tailwind.config.js. Zero consumers as of
   * 2026-08-09, by either route — it exists so the two files stay
   * byte-comparable, per the standing rule that any palette change touches
   * both. Retire from BOTH together if it never earns a use.
   */
  pineBright: '#4E96A1',
  /**
   * Biological state ONLY — pillars, freshness, biomarker states, overdue
   * screenings. Never interface chrome, and the accent never marks biology.
   * (Petrol was chosen partly because it has no collision here; redline would
   * have forced `poor` to umber to keep the two readable apart.)
   *
   * These are the SWATCH cuts — fills, ticks and Ionicons `color`, where the
   * 3:1 non-text threshold applies. They are NOT text colours: as text on
   * paper-hi they measure 3.82 / 5.13 / 3.41 / 5.44, so half of them fail
   * 4.5:1. Text takes `signalInk` below (00-design-spec.md §2).
   */
  signal: {
    optimal: '#2E8B57',
    good: '#2C6C95',
    caution: '#A97B22',
    poor: '#AA402C',
    unknown: '#5C5340',
  },
  /**
   * The TEXT cut of each biological state — the same hue darkened until it
   * clears 4.5:1. On paper 6.46 / 6.14 / 5.91 / 6.11, on paperHi 7.40 / 7.04 /
   * 6.77 / 7.00, on paperDim 5.60 / 5.32 / 5.12 / 5.29. On paperDeep only
   * `optimal` clears (4.56); the other three land at 4.17–4.34, so signal text
   * does not belong on that surface.
   *
   * Any glyph that carries meaning by shape as well as colour — an icon — may
   * stay on the swatch cut. Anything read as words or digits takes this one.
   */
  signalInk: {
    optimal: '#185A36',
    good: '#24567A',
    caution: '#6E4F15',
    poor: '#8F3524',
    unknown: '#5C5340',
  },
} as const;

/**
 * THE PAPER GRID — the faint drafting rule printed ON the sheet.
 *
 * The mockup has two grids and only one of them is the design:
 *   `--desk` / `--desk-grid`  the dark surround the mockup phone SITS ON.
 *                             Presentation chrome. Correctly dropped.
 *   `--paper-grid`            a 9px rule on the sheet itself, inside the
 *                             screen. THIS IS THE DESIGN, and the first port
 *                             dropped it along with the desk (owner caught it
 *                             on device, 2026-08-09).
 *
 * Drawn once by `PaperGrid` in `src/components/ui/screen.tsx`, behind every
 * screen, as absolutely-positioned 1pt `View`s — one per rule, sized to
 * `useWindowDimensions()`. RN has no `repeating-linear-gradient`, and the two
 * rounds that shipped a `<Image resizeMode="repeat">` tile instead never
 * rendered on the owner's device even once. The layer is static, non-scrolling
 * and `pointerEvents="none"`: it derives from nothing but the window size, so it
 * mounts once and never re-renders — no per-frame work, no touch interference.
 *
 * TUNING. `opacity` is the dial — change it here and nowhere else. Ink is drawn
 * at full alpha and the whole group is faded precisely so this one number is the
 * entire control, and so the crossings (verticals and horizontals DO overlap)
 * stay at the same weight as the rules rather than printing a darker lattice.
 *
 * GEOMETRY. A rule on every 9pt boundary in both axes — 42v + 75h = 117 Views on
 * a 375×667 SE, 44 + 95 = 139 on a 393×852 iPhone 16, 49 + 107 = 156 on a
 * 440×956 Pro Max. Each rule is 1pt (NOT `hairlineWidth`, which is a third of
 * that at @3x and would put the texture back under threshold), ink flat #1C1911,
 * and every offset is a whole multiple of 9 so nothing lands on a half-pixel.
 * This matches the retired PNG exactly: its 9×9 tile ruled its top and left
 * edge, i.e. the same two rules per cell.
 *
 * CALIBRATION — corrected 2026-08-10, after the owner reported for the SECOND
 * time that the sheet still read as blank. The dial was set below the eye's
 * detection threshold, and the comment that justified it contained an arithmetic
 * error that hid this for two rounds. (A THIRD report followed even after the
 * correction, which is what finally condemned the `Image` path itself; the
 * calibration below was sound, nothing was drawing it.)
 *
 * The error: this comment used to say the grid "sits at a bit over half the
 * weight" of `hairline`, reading 1.12:1 against 2.00:1 as ≈56%. But a contrast
 * ratio is anchored at 1.0, not 0 — the weight of a mark is how far it departs
 * from that anchor. The grid departed by 0.12 and the hairline by 1.00, so the
 * grid was at **12%** of a hairline's weight, not 56%. The stated intent was
 * right all along; the number under it implemented something eight times
 * fainter, and no amount of re-checking the coverage figure could reveal that.
 *
 * The measurements, composited over `paper` #E7E4DA and quantised to 8-bit the
 * way iOS actually composites them (`hairline` #A9A28E = 2.00:1 is the ceiling):
 *
 *   opacity   line colour   vs sheet   weight vs hairline
 *     0.06     #DBD8CE       1.12:1      12%   ← was: invisible on device
 *     0.10     #D3D0C6       1.21:1      21%
 *     0.14     #CBC8BE       1.32:1      32%
 *     0.20     #BEBBB2       1.51:1      51%   ← chosen
 *     0.26     #B2AFA6       1.72:1      72%
 *     0.30     #AAA79E       1.89:1      89%   ← too close to a real rule
 *     0.35     #A09D94       2.13:1     113%   ← exceeds the ceiling
 *
 * **0.20 is the value the prose always described**: a mark at half the weight of
 * the faintest thing that means "this encloses an object". A plate edge stays
 * unmistakably twice the departure of the texture under it, which is the gap
 * that keeps §4's "rules enclose objects, never pages" true, and it leaves ~0.5
 * of ratio in hand before the grid reaches hairline weight. Sane range
 * **0.16–0.24** (1.37:1 – 1.65:1). **If the grid starts reading as a rule rather
 * than as tooth in the paper it is too strong** — but note that the failure for
 * two rounds running was the opposite one, so err high rather than low.
 *
 * Why the dial and not the pitch: a 1pt rule at 1.12:1 is under threshold at any
 * spacing, so coarsening the pitch would only have produced fewer invisible
 * lines. 9pt is ~1mm on a @3x phone and subtends ~11 arcmin at reading distance
 * — an order of magnitude above visual acuity, so the spacing was never what was
 * failing to register. The individual rule's contrast was.
 *
 * `pitch` is now LIVE — `PaperGrid` reads it to place the rules, so changing it
 * changes the render with no asset step (it used to be baked into a PNG and was
 * documentation only). That also makes it the cost dial if the node count above
 * ever needs to come down: 18 halves it. Spec:
 * docs/design-research/implementation/00-design-spec.md §4a.
 */
export const paperGrid = {
  /**
   * Points between rules, in both axes. Matches the mockup's `--paper-grid` at
   * 9px — the mockup phone is ~1 CSS px ≈ 1pt, so 9 transfers 1:1 and the
   * angular size on device matches what was reviewed. Read by `PaperGrid`.
   */
  pitch: 9,
  /**
   * The dial. The mockup's `rgba(28, 24, 14, .06)` was picked in a browser on a
   * bright desktop monitor and did not survive the transfer to a phone; 0.20 is
   * the calibrated device value. See the table above before changing it.
   */
  opacity: 0.2,
} as const;

/**
 * Colours handed to React Navigation (expo-router's ThemeProvider). ARC is
 * light-mode only by design — see the ADR in docs/decisions.md.
 */
export const navColors = {
  primary: palette.pine,
  background: palette.paper,
  card: palette.paper,
  text: palette.ink,
  border: palette.hairline,
  /**
   * NOT a signal value, deliberately. React Navigation spends `notification` on
   * tab-bar badge backgrounds — pure interface chrome — and the firewall above
   * `palette.signal` runs both ways: signal marks biology only, so it must never
   * be wired into a chrome slot. (That comment sits on the signal object and
   * does not reach down here, which is how `signal.caution` survived review in
   * this line: nothing renders a badge today, so the breach was dormant rather
   * than visible.) The accent is on-budget for the active tab, so a badge that
   * hangs off a tab takes the accent too.
   */
  notification: palette.pine,
} as const;
