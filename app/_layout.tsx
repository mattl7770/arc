// Must be first: this is the stylesheet NativeWind compiles Tailwind into.
import '../global.css';

import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';

/**
 * Root layout.
 *
 * Auth is deliberately not gated here yet. `useSession` (src/hooks/use-session.ts)
 * exposes the Supabase session and `/login` is routable, but nothing redirects —
 * so the shell runs before a Supabase project exists. Add the guard here when
 * auth lands (CLAUDE.md §10, priority 4).
 */
export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="login" />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
