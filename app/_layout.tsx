// Must be first: this is the stylesheet NativeWind compiles Tailwind into.
import '../global.css';

import { DefaultTheme, Stack, type Theme, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { ErrorBoundary } from '@/components/ui/error-boundary';
import { navColors } from '@/constants/theme';

/**
 * Root layout.
 *
 * ARC is light-mode only: Porcelain Ledger (docs/project-status.md §3) treats
 * bone-white paper as the identity, so there is no dark theme to switch to —
 * app.json pins userInterfaceStyle to "light" and this theme is unconditional.
 *
 * No auth gate: ARC is single-user and local-first (no accounts). Access is
 * guarded by a Face ID / passcode app lock, added in Phase 2 (CLAUDE.md §10).
 * The whole tree sits under an ErrorBoundary because the data layer opens SQLite
 * synchronously and throws on failure.
 */
const porcelainTheme: Theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, ...navColors },
};

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <ThemeProvider value={porcelainTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          {/* Pushed over the tabs from the Log tab (docs/information-architecture.md). */}
          <Stack.Screen name="nutrition" />
          <Stack.Screen name="exercise" />
          <Stack.Screen name="workout-log" />
          <Stack.Screen name="metric-entry" />
          <Stack.Screen name="capture" />
          <Stack.Screen name="symptom" />
          <Stack.Screen name="labs" />
          <Stack.Screen name="screenings" />
          <Stack.Screen name="screening-form" />
          <Stack.Screen name="appointment-form" />
        </Stack>
        <StatusBar style="dark" />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
