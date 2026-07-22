/**
 * Raw theme values for APIs that cannot take a Tailwind class — navigation
 * options, status bar, native tab bars.
 *
 * KEEP IN SYNC with `tailwind.config.js`. That file is the source of truth for
 * anything styled with `className`; this one exists only because React
 * Navigation needs literal colour strings.
 */

export const palette = {
  ink: {
    50: '#F6F7F9',
    100: '#ECEEF2',
    200: '#D9DDE4',
    300: '#B8BFCB',
    400: '#8C96A7',
    500: '#697386',
    600: '#525B6B',
    700: '#3E4552',
    800: '#252B35',
    900: '#151A21',
    950: '#0B0F14',
  },
  accent: {
    DEFAULT: '#3FA7A0',
    muted: '#2C7A75',
    soft: '#E4F2F1',
  },
  signal: {
    optimal: '#4BA07A',
    good: '#7FB069',
    caution: '#D9A441',
    poor: '#C4614C',
    unknown: '#697386',
  },
} as const;

type ThemeColors = {
  background: string;
  surface: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
};

export const theme: Record<'light' | 'dark', ThemeColors> = {
  light: {
    background: '#FFFFFF',
    surface: palette.ink[50],
    border: palette.ink[200],
    text: palette.ink[900],
    textMuted: palette.ink[500],
    accent: palette.accent.muted,
  },
  dark: {
    background: palette.ink[950],
    surface: palette.ink[900],
    border: palette.ink[800],
    text: palette.ink[50],
    textMuted: palette.ink[400],
    accent: palette.accent.DEFAULT,
  },
};
