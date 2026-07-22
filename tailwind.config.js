/**
 * ARC design tokens.
 *
 * Kept deliberately small: a neutral ramp, one restrained accent, and the
 * signal colours the home screen needs to express readiness at a glance.
 * Add tokens only when a screen actually needs them — see docs/home-screen.md.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: ['./app/**/*.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Neutral ramp — cool, low-chroma, calm.
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
        // Single accent. Used for the "do this next" affordance, nothing else.
        accent: {
          DEFAULT: '#3FA7A0',
          muted: '#2C7A75',
          soft: '#E4F2F1',
        },
        // Readiness / adherence signals.
        signal: {
          optimal: '#4BA07A',
          good: '#7FB069',
          caution: '#D9A441',
          poor: '#C4614C',
          unknown: '#697386',
        },
      },
    },
  },
  plugins: [],
};
