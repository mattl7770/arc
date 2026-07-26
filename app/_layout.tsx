// Must be first: this is the stylesheet NativeWind compiles Tailwind into.
import '../global.css';

import { DefaultTheme, Stack, type Theme, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { navColors } from '@/constants/theme';

/**
 * Root layout.
 *
 * ARC is light-mode only: Porcelain Ledger (docs/project-status.md §3) treats
 * bone-white paper as the identity, so there is no dark theme to switch to —
 * app.json pins userInterfaceStyle to "light" and this theme is unconditional.
 *
 * Auth is deliberately not gated here yet. `useSession` (src/hooks/use-session.ts)
 * exposes the Supabase session and `/login` is routable, but nothing redirects —
 * so the shell runs before auth is wired. Add the guard here when auth lands
 * (CLAUDE.md §10, priority 4).
 */
const porcelainTheme: Theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, ...navColors },
};

export default function RootLayout() {
  return (
    <ThemeProvider value={porcelainTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="login" />
        {/* Pushed over the tabs from the Log tab (docs/information-architecture.md). */}
        <Stack.Screen name="nutrition" />
        <Stack.Screen name="exercise" />
        <Stack.Screen name="metric-entry" />
        <Stack.Screen name="capture" />
      </Stack>
      <StatusBar style="dark" />
    </ThemeProvider>
  );
}
