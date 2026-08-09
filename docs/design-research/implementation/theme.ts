/**
 * SUPERSEDED — ADOPTED 2026-08-08. Kept as the historical handoff.
 *
 * This was the drop-in candidate for src/constants/theme.ts. The SHIPPED
 * palette is that file, and it has since moved past this draft — it gained a
 * `signalInk` export (the text cut of each biological state) and `pineBright`.
 * DO NOT paste this over the shipped file. Spec:
 * docs/design-research/implementation/00-design-spec.md
 *
 * Every EXPORTED KEY NAME is unchanged from Porcelain Ledger — only the values
 * moved. `palette` is imported by 51 files as of 2026-08-09 (Ionicons `color`
 * props, the nav theme, a handful of computed styles); keeping the names meant
 * none of them needed editing. Read `pine` as "the one accent".
 *
 * KEEP IN SYNC with tailwind.config.js. That file is the source of truth for
 * anything styled with `className`; this exists only for APIs that need
 * literal colour strings.
 *
 * Also update on adoption (they hold their own copies of the page colour):
 *   - app.json          → splash backgroundColor
 *   - app/_layout.tsx   → porcelainTheme (reads navColors below)
 *   - app/(tabs)/_layout.tsx → tab bar styled imperatively from `palette`
 */

export const palette = {
  paper: '#E7E4DA',
  paperDeep: '#C6C1B0',
  /** Plate surface — cards, ruled records. Alias of paperHi. */
  porcelain: '#F5F3EC',
  paperHi: '#F5F3EC',
  /** Recessed stock — input wells, the chat thread. */
  paperDim: '#D9D5C8',
  hairline: '#A9A28E',
  hairlineSoft: '#C6C1B0',
  hairlineStrong: '#A9A28E',
  ink: '#1C1917',
  inkSecondary: '#443F30',
  /** The metadata layer: clears 4.5:1 on paper (5.97:1) AND paperDim (5.17:1). */
  inkMuted: '#5C5340',
  /** The one accent (petrol). Redline alternative: '#C4222E' / '#A21522'. */
  pine: '#12454E',
  pineOn: '#F5F3EC',
  pineSoft: '#E7EEE6',
  pineTint: '#9FBEC2',
  pineDeep: '#082A30',
  /**
   * Biological state ONLY — never interface chrome.
   * If the redline accent is adopted, `poor` MUST become '#7A4A1E' (umber):
   * crimson chrome and rust biology collapse into one hue at swatch size.
   */
  signal: {
    optimal: '#2E8B57',
    good: '#2C6C95',
    caution: '#A97B22',
    poor: '#AA402C',
    unknown: '#5C5340',
  },
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
  notification: palette.signal.caution,
} as const;
