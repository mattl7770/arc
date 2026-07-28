// Must be first: this is the stylesheet NativeWind compiles Tailwind into.
import '../global.css';

import { DefaultTheme, Stack, type Theme, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { ErrorBoundary } from '@/components/ui/error-boundary';
import { navColors } from '@/constants/theme';
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { getDb } from '@/lib/db/client';
import { syncReminderNotifications } from '@/lib/notifications/reminders';

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
  // Boot side effects, both fire-and-forget:
  //  - hydrate the Coach's API key + model from the Keychain into the in-memory
  //    mirror (the store emits when values land, so the Coach screen re-renders
  //    from preview to connected);
  //  - reconcile OS notifications with the active reminders, so a daily/weekly
  //    nudge keeps firing across launches and a reminder changed while the app
  //    was closed is picked up. No-ops until the native module ships (rebuild).
  useEffect(() => {
    void apiKeyStore.hydrate();
    void syncReminderNotifications(getDb());
  }, []);

  return (
    <ErrorBoundary>
      <ThemeProvider value={porcelainTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          {/* Pushed over the tabs from the Log tab (docs/information-architecture.md). */}
          <Stack.Screen name="nutrition" />
          {/* Nutrition sub-app family (docs/nutrition-subapp.md). INTEGRATOR-MERGE:
              these routes were added on the nutrition-sub-app branch. */}
          <Stack.Screen name="food-search" />
          <Stack.Screen name="food-new" />
          <Stack.Screen name="meal-detail" />
          <Stack.Screen name="nutrition-targets" />
          <Stack.Screen name="meal-templates" />
          <Stack.Screen name="nutrition-micros" />
          <Stack.Screen name="nutrition-history" />
          <Stack.Screen name="barcode-scan" />
          <Stack.Screen name="meal-estimate" />
          <Stack.Screen name="exercise" />
          <Stack.Screen name="workout-log" />
          {/* INTEGRATOR-MERGE: Exercise sub-app routes (docs/exercise-subapp.md). */}
          <Stack.Screen name="workout-live" />
          <Stack.Screen name="routine-edit" />
          <Stack.Screen name="exercise-detail" />
          <Stack.Screen name="program-edit" />
          <Stack.Screen name="metric-entry" />
          <Stack.Screen name="capture" />
          <Stack.Screen name="symptom" />
          <Stack.Screen name="labs" />
          {/* Pushed from Settings. */}
          <Stack.Screen name="settings-profile" />
          <Stack.Screen name="settings-units" />
          <Stack.Screen name="settings-coach" />
          {/* Pushed from the Data tab. */}
          <Stack.Screen name="protocols" />
          <Stack.Screen name="protocol-edit" />
          <Stack.Screen name="screenings" />
          <Stack.Screen name="screening-form" />
          <Stack.Screen name="appointment-form" />
        </Stack>
        <StatusBar style="dark" />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
