/**
 * Raw Porcelain Ledger values for APIs that cannot take a Tailwind class —
 * navigation themes, status bar, icon `color` props.
 *
 * KEEP IN SYNC with `tailwind.config.js`. That file is the source of truth for
 * anything styled with `className`; this one exists only because a few APIs
 * need literal colour strings. Design philosophy: docs/project-status.md §3.
 */

export const palette = {
  paper: '#F6F3EC',
  paperDeep: '#EFEADD',
  porcelain: '#FDFCF8',
  hairline: '#E3DCCE',
  hairlineSoft: '#EFEADD',
  hairlineStrong: '#C9C0AC',
  ink: '#1C1917',
  inkSecondary: '#544E45',
  inkMuted: '#8B8272',
  pine: '#1E5C46',
  pineOn: '#F8F6EF',
  pineSoft: '#E7EEE6',
  pineTint: '#CBDCCB',
  signal: {
    optimal: '#22684E',
    good: '#77803A',
    caution: '#B07C2A',
    poor: '#96382C',
    unknown: '#8B8272',
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
