/**
 * SUPERSEDED — ADOPTED 2026-08-08. Kept as the historical handoff.
 *
 * This was the drop-in `theme.extend` candidate. The SHIPPED tokens are in
 * tailwind.config.js and have since moved past this draft — most importantly
 * each `signal` state gained an `ink` cut, because the swatch values fail 4.5:1
 * as text. DO NOT paste this file over the shipped one.
 * Spec: docs/design-research/implementation/00-design-spec.md
 *
 * Two deliberate compatibility choices, both to keep the blast radius small:
 *
 *  1. KEY NAMES ARE UNCHANGED from Porcelain Ledger — `paper`, `porcelain`,
 *     `hairline`, `ink`, `pine`, `signal`. Only the VALUES move. `palette` in
 *     src/constants/theme.ts is imported by 44 files (almost all for Ionicons
 *     `color` props); reusing the names means those 44 files need zero edits.
 *     Read `pine` as "the one accent" and `hairline` as "the rule" — the names
 *     outlived their original hues, which is a fair trade against a rename sweep.
 *     (The 44 above was the count when this was drafted; it is 51 as of
 *     2026-08-09. docs/project-status.md §3 is the one home for these figures.)
 *     If you'd rather rename to accent/rule/line, do it as its own commit.
 *
 *  2. ACCENT DEFAULTS TO PETROL. The redline alternative is commented inline.
 *     Redline additionally REQUIRES swapping signal.poor to the umber value —
 *     crimson chrome and rust biology are one hue at swatch size (a finding in
 *     all six hostile reviews). See 00-design-spec.md §2.
 *
 * Light mode IS the identity — no dark: variants (ADR in docs/decisions.md).
 * Mirror any change into src/constants/theme.ts.
 */
module.exports = {
  colors: {
    // The sheet, its plates, and its recesses. Bone-neutral so it reads
    // clean under either accent.
    //   DEFAULT = the page · hi = plates/cards · deep = recessed edges
    paper: { DEFAULT: '#E7E4DA', hi: '#F5F3EC', dim: '#D9D5C8', deep: '#C6C1B0' },
    // Kept as an alias of paper.hi so existing `bg-porcelain` usages don't
    // break mid-migration. Prefer `bg-paper-hi` in new code.
    porcelain: '#F5F3EC',
    // The rule. One weight does almost all the work here; `soft` and `strong`
    // are retained for compatibility with existing components.
    hairline: { DEFAULT: '#A9A28E', soft: '#C6C1B0', strong: '#A9A28E' },
    // Warm-neutral ink, three voices.
    //   muted clears 4.5:1 on BOTH paper (5.97:1) and paper-dim (5.17:1) —
    //   it is the metadata layer, so it must survive every surface.
    ink: { DEFAULT: '#1C1911', secondary: '#443F30', muted: '#5C5340' },
    // The one accent. Hero + one primary action per screen + completion
    // stamps + the user's own chat bubbles + the active tab. Nothing else.
    // Settings carries none at all.
    pine: {
      DEFAULT: '#12454E', // redline: '#C4222E'
      deep: '#082A30', //    redline: '#A21522'
      bright: '#4E96A1', //  redline: '#E0202F'
      on: '#F5F3EC',
      soft: '#E7EEE6',
      tint: '#9FBEC2',
    },
    // Biological state ONLY — pillars, freshness, biomarkers, overdue
    // screenings. Never interface chrome. The accent never marks biology.
    signal: {
      optimal: '#2E8B57',
      good: '#2C6C95',
      caution: '#A97B22',
      poor: '#AA402C', // redline REQUIRES '#7A4A1E' (umber) — see the header note
      unknown: '#5C5340',
    },
  },
  fontFamily: {
    // Three voices: label speaks in caps, serif speaks in prose, mono measures.
    //
    // ⚠️ Plain arrays, NEVER nativewind/theme's platformSelect — its
    // custom-function syntax cannot carry family names containing spaces and
    // compiles to an EMPTY declaration (verified in the bundle registry).
    //
    // ⚠️ These are iOS-native families. The browser mockup used Windows stacks
    // (Bahnschrift / Constantia) that do not exist on iOS — do not copy those
    // here. Confirm all three on a real device before locking (00-design-spec §3).
    label: ['Avenir Next Condensed', 'Helvetica Neue', 'system-ui', 'sans-serif'],
    serif: ['Iowan Old Style', 'Palatino', 'Georgia', 'serif'],
    mono: ['Menlo', 'Courier New', 'monospace'],
  },
  borderRadius: {
    // Square is the point: this is a drawing, not a bubble. `card` is kept at
    // 0 rather than deleted so existing `rounded-card` usages flatten
    // automatically instead of erroring during the migration.
    card: '0px',
    btn: '2px',
  },
};
