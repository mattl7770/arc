/**
 * ARC design tokens — Porcelain Ledger (docs/project-status.md §3).
 *
 * "A beautifully printed lab report that happens to be alive." Chosen from six
 * candidate directions on 2026-07-24; the full exploration is archived in
 * docs/design-directions.md.
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
        // The page and its recessed variant (input fields, quiet chips).
        paper: { DEFAULT: '#F6F3EC', deep: '#EFEADD' },
        // Card surface — slightly whiter than the page, like coated stock.
        porcelain: '#FDFCF8',
        // Rules and dividers. soft = row separators, strong = ghost-button edges.
        hairline: { DEFAULT: '#E3DCCE', soft: '#EFEADD', strong: '#C9C0AC' },
        // Warm ink, three voices: primary, supporting, incidental.
        ink: { DEFAULT: '#1C1917', secondary: '#544E45', muted: '#8B8272' },
        // The one accent: a deep pine-green stamp. Hero + primary actions +
        // the user's own chat bubbles. Nothing else.
        pine: { DEFAULT: '#1E5C46', on: '#F8F6EF', soft: '#E7EEE6', tint: '#CBDCCB' },
        // Readiness / adherence signals.
        signal: {
          optimal: '#22684E',
          good: '#77803A',
          caution: '#B07C2A',
          poor: '#96382C',
          unknown: '#8B8272',
        },
      },
      fontFamily: {
        // Headlines and verdicts. System serifs — no font downloads; these
        // ship with the OS and will still be there in twenty years.
        //
        // Deliberately a plain CSS stack, NOT nativewind/theme's
        // platformSelect: its custom-function syntax cannot carry a family
        // name containing spaces ("Iowan Old Style" compiled to an EMPTY
        // declaration — verified in the bundle registry). A quoted CSS stack
        // parses cleanly; native picks the first family, so iOS renders Iowan
        // and Android falls back to its default until we ship a serif there.
        serif: ['Iowan Old Style', 'Palatino', 'Georgia', 'serif'],
        // Data voice: every numeral that represents a measurement.
        mono: ['Menlo', 'Courier New', 'monospace'],
      },
      borderRadius: {
        card: '10px',
        btn: '6px',
      },
    },
  },
  plugins: [],
};
