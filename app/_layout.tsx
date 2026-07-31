// Must be first: this is the stylesheet NativeWind compiles Tailwind into.
import '../global.css';

import { DefaultTheme, Stack, type Theme, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Modal } from 'react-native';

import { AppLockScreen } from '@/components/ui/app-lock-screen';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { navColors } from '@/constants/theme';
import { useAppLock } from '@/hooks/use-app-lock';
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { getDb } from '@/lib/db/client';
import { registerForegroundHealthSync, syncHealthIfEnabled } from '@/lib/health/sync';
import { syncReminderNotifications } from '@/lib/notifications/reminders';

/**
 * Root layout.
 *
 * ARC is light-mode only: Porcelain Ledger (docs/project-status.md §3) treats
 * bone-white paper as the identity, so there is no dark theme to switch to —
 * app.json pins userInterfaceStyle to "light" and this theme is unconditional.
 *
 * No auth gate: ARC is single-user and local-first (no accounts). Access is
 * guarded by the Face ID / passcode app lock below (useAppLock, CLAUDE.md §2):
 * a locked cold start early-returns the lock screen so the Stack never mounts;
 * a re-lock after time in the background covers the mounted Stack with an
 * opaque overlay instead, so navigation state survives.
 * The whole tree sits under an ErrorBoundary because the data layer opens SQLite
 * synchronously and throws on failure.
 */
const porcelainTheme: Theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, ...navColors },
};

export default function RootLayout() {
  // Face ID / passcode gate (CLAUDE.md §2: the app lock is the security
  // boundary). Must be the first hook so its synchronous enabled-check settles
  // before anything below decides what to render.
  const lock = useAppLock();

  // Boot side effects, all fire-and-forget:
  //  - hydrate the Coach's API key + model from the Keychain into the in-memory
  //    mirror (the store emits when values land, so the Coach screen re-renders
  //    from preview to connected);
  //  - reconcile OS notifications with the active reminders, so a daily/weekly
  //    nudge keeps firing across launches and a reminder changed while the app
  //    was closed is picked up. No-ops until the native module ships (rebuild);
  //  - pull fresh Apple Health data (throttled), and again whenever the app
  //    returns to the foreground — wearables written while ARC was closed are
  //    waiting in HealthKit. No-ops until enabled + the native module ships.
  useEffect(() => {
    void apiKeyStore.hydrate();
    void syncReminderNotifications(getDb());
    void syncHealthIfEnabled(getDb());
    return registerForegroundHealthSync(getDb());
  }, []);

  // Cold start while locked: the lock screen is the ONLY thing that mounts —
  // no Stack, no screens, nothing rendered to reveal. After the first unlock
  // the Stack stays mounted and a re-lock covers it with the overlay below,
  // preserving navigation state.
  if (lock.coldStart && lock.locked) {
    return (
      <ErrorBoundary>
        <AppLockScreen unlocking={lock.unlocking} onUnlock={lock.retry} />
        <StatusBar style="dark" />
      </ErrorBoundary>
    );
  }

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
          {/* INTEGRATOR-MERGE: labs pipeline route (docs/labs-subapp.md). */}
          <Stack.Screen name="lab-import" />
          {/* Pushed from Settings. */}
          <Stack.Screen name="settings-profile" />
          <Stack.Screen name="settings-units" />
          <Stack.Screen name="settings-coach" />
          {/* INTEGRATOR-MERGE: wearables routes (docs/wearables-subapp.md). */}
          <Stack.Screen name="settings-health" />
          <Stack.Screen name="wearables" />
          {/* Pushed from the Data tab. */}
          <Stack.Screen name="protocols" />
          <Stack.Screen name="protocol-edit" />
          <Stack.Screen name="screenings" />
          <Stack.Screen name="screening-form" />
          <Stack.Screen name="appointment-form" />
        </Stack>
        <StatusBar style="dark" />
        {/* Re-lock / privacy cover. A NATIVE full-screen Modal, not an
            absolute-fill View: RN Modals (the exercise/routine pickers)
            present above the root view on iOS, so only another Modal —
            presented from the topmost view controller — can cover one that's
            already open. `covered` mounts it the moment the app backgrounds,
            so the app-switcher snapshot shows the lock surface, never data;
            a cancelled prompt leaves it in place (locked stays true). */}
        <Modal
          visible={lock.locked || lock.covered}
          animationType="none"
          presentationStyle="fullScreen"
          onRequestClose={() => {
            // iOS-only app: there is no back button, and the lock never
            // dismisses except through the state machine.
          }}>
          <AppLockScreen unlocking={lock.unlocking} onUnlock={lock.retry} />
        </Modal>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
