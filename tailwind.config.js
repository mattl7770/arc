/**
 * ARC design tokens — the Conformed Set (docs/project-status.md §3).
 *
 * "ARC is a working drawing set — the day is drafted, not listed." Adopted
 * 2026-08-08, superseding Porcelain Ledger; full spec and the RN port guide are
 * in docs/design-research/implementation/, and the ADR is in docs/decisions.md.
 *
 * The load-bearing idea is the SURFACE SYSTEM, not the palette: every content
 * block is a drafting device whose container encodes what it holds — ruled
 * plate (records), measured field (verdicts, corner ticks), margin annotation
 * (prose), ruled grid (metrics), recessed stock (inputs), stamped plate (the
 * one next action). See src/components/ui/block.tsx. A block gets exactly one
 * device, and devices never nest.
 *
 * Light mode IS the identity — there are deliberately no dark: variants in the
 * app (see the ADR in docs/decisions.md). Mirror any palette change into
 * src/constants/theme.ts, which exists for APIs that need literal colours.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: ['./app/**/*.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        // The sheet, its plates, and its recesses. Bone-neutral drafting stock.
        //   DEFAULT = the page · hi = plates/cards · dim = input wells · deep = recessed edges
        paper: { DEFAULT: '#E7E4DA', hi: '#F5F3EC', dim: '#D9D5C8', deep: '#C6C1B0' },
        // Alias of paper.hi. SHIM — ZERO CONSUMERS as of 2026-08-09 (swept over
        // all 191 source files in app/ + src/, class and palette.* mirror
        // alike). It used to say "kept so existing bg-porcelain usages don't
        // break"; there are no such usages, the Conformed Set sweep took them
        // all. Kept because a dead token is one line and deleting it can break
        // an unmerged branch — not because anything depends on it. Use
        // `bg-paper-hi`.
        porcelain: '#F5F3EC',
        // The rule. One weight does almost all the work.
        //
        // CONTRAST, and it is the one thing in this palette that does NOT clear
        // its threshold: WCAG 1.4.11 asks 3:1 of non-text visuals, and DEFAULT
        // measures paper-hi 2.29:1 · paper 2.00:1 · paper-dim 1.73 · paper-deep
        // 1.41. ACCEPTED for plate borders, row separators and the margin rule
        // (they enclose text that is itself >=5.97:1, so nothing needed to read
        // a value or identify a control depends on seeing them), OPEN for the
        // `well` device, whose border marks an input. Decision recorded in
        // docs/project-status.md §3 and the ADR. If it is ever darkened, the
        // measured landing point is #7E7767 (4.01 on paper-hi / 3.50 on paper)
        // at the same 1px weight — and it must move in src/constants/theme.ts
        // in the same change.
        //
        // `soft` and `strong` are SHIMS. As classes both have ZERO CONSUMERS as
        // of 2026-08-09 — but note palette.hairlineStrong (theme.ts) is LIVE in
        // app/(tabs)/settings.tsx, so `strong` cannot be retired from the pair
        // without editing that screen. `strong` is byte-identical to DEFAULT
        // anyway: it could not render differently even if it were used.
        hairline: { DEFAULT: '#A9A28E', soft: '#C6C1B0', strong: '#A9A28E' },
        // Warm-neutral ink, three voices. `muted` is the metadata layer, so it
        // must clear 4.5:1 on every surface it sits on. Measured, all four:
        // paper 5.97:1 ✓ · paper-hi 6.84:1 ✓ · paper-dim 5.17:1 ✓ ·
        // paper-deep 4.21:1 ✗ — muted FAILS on paper-deep. No screen puts it
        // there today (the one paper-deep chip, mode-control.tsx, carries
        // ink-secondary at 5.83:1), and none should: on paper-deep the
        // metadata voice is `ink-secondary`, not `ink-muted`.
        ink: { DEFAULT: '#1C1911', secondary: '#443F30', muted: '#5C5340' },
        // The one accent (petrol). Budget is a CEILING, not a quota: the Home
        // hero, ONE primary action per screen, completion stamps, the user's own
        // chat bubbles, the active tab, the Coach presence dot. Nothing else.
        // Settings carries no accent at all.
        //
        // Live as of 2026-08-09: DEFAULT, `deep` (5 class uses), `on` (33 class
        // + 21 palette.pineOn). ZERO CONSUMERS: `bright`, `soft`, `tint`.
        // `soft` is the first candidate for retirement — #E7EEE6 is a leftover
        // GREEN tint from the pre-petrol pine (green-dominant, G238 > B230),
        // while petrol is blue-dominant (B78 > G69), so it no longer harmonises
        // with the accent it is named after. `tint` at least leans blue.
        // Retiring any of them means editing src/constants/theme.ts in the same
        // change (the standing mirror rule).
        pine: {
          DEFAULT: '#12454E',
          deep: '#082A30',
          bright: '#4E96A1',
          on: '#F5F3EC',
          soft: '#E7EEE6',
          tint: '#9FBEC2',
        },
        // Biological state ONLY — pillars, freshness, biomarkers, overdue
        // screenings. Never interface chrome; the accent never marks biology.
        // This firewall was a finding in all six hostile reviews.
        //
        // TWO VALUES PER STATE, and they are not interchangeable
        // (00-design-spec.md §2):
        //   DEFAULT — the SWATCH. Fills and icons only, where 3:1 applies.
        //   ink     — the TEXT cut, darkened until it clears 4.5:1.
        //
        // The swatches are not text colours and never were: as text on paper-hi
        // they measure optimal 3.82 · good 5.13 · caution 3.41 · poor 5.44 —
        // two of the four fail outright and the pair that passes only does so
        // by luck of hue. The ink cuts clear 4.5:1 on paper (6.46 / 6.14 /
        // 5.91 / 6.11), on paper-hi (7.40 / 7.04 / 6.77 / 7.00) and on
        // paper-dim (5.60 / 5.32 / 5.12 / 5.29). On paper-deep only `optimal`
        // clears (4.56); good 4.34, caution 4.17 and poor 4.31 fall short, so
        // signal TEXT does not belong on paper-deep. No screen puts it there.
        //
        // `unknown` is the metadata ink itself — an absent reading is absent,
        // not a state — so it needs no separate cut.
        signal: {
          optimal: { DEFAULT: '#2E8B57', ink: '#185A36' },
          good: { DEFAULT: '#2C6C95', ink: '#24567A' },
          caution: { DEFAULT: '#A97B22', ink: '#6E4F15' },
          poor: { DEFAULT: '#AA402C', ink: '#8F3524' },
          unknown: '#5C5340',
        },
      },
      fontFamily: {
        // Three voices: label speaks in caps, serif speaks in prose, mono
        // measures. "Serif speaks, mono measures" — a standalone measurement in
        // the serif or label face is a bug.
        //
        // Deliberately plain CSS stacks, NOT nativewind/theme's platformSelect:
        // its custom-function syntax cannot carry a family name containing
        // spaces ("Iowan Old Style" compiled to an EMPTY declaration — verified
        // in the bundle registry). A quoted stack parses cleanly; native picks
        // the first family it has.
        //
        // These are iOS-NATIVE families. The browser mockup used Windows stacks
        // (Bahnschrift / Constantia) that do not exist on iOS — do not copy
        // those here. Confirm all three on a real device.
        label: ['Avenir Next Condensed', 'Helvetica Neue', 'system-ui', 'sans-serif'],
        serif: ['Iowan Old Style', 'Palatino', 'Georgia', 'serif'],
        mono: ['Menlo', 'Courier New', 'monospace'],
      },
      borderRadius: {
        // Square is the point: this is a drawing, not a bubble. `card` is kept
        // at 0 rather than deleted — but as a SHIM with ZERO CONSUMERS as of
        // 2026-08-09, not because anything still uses it. The old comment here
        // ("so any surviving `rounded-card` usage flattens automatically")
        // implied survivors; the sweep left none.
        card: '0px',
        btn: '2px',
      },
    },
  },
  plugins: [],
};
