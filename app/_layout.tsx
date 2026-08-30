// Must be first: this is the stylesheet NativeWind compiles Tailwind into.
import '../global.css';

import { DefaultTheme, Stack, useRouter, type Theme, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, Modal } from 'react-native';

import { AppLockScreen } from '@/components/ui/app-lock-screen';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { navColors } from '@/constants/theme';
import { useAppLock } from '@/hooks/use-app-lock';
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { autoBackupIfDue } from '@/lib/backup/snapshot';
import { getDb } from '@/lib/db/client';
import { registerForegroundHealthSync, syncHealthIfEnabled } from '@/lib/health/sync';
import { runMealPhotoSweep } from '@/lib/media/meal-photo-store';
import { runProgressPhotoSweep } from '@/lib/media/progress-photo-store';
import { runRecipePhotoSweep } from '@/lib/media/recipe-photo-store';
import {
  configureNotificationPresentation,
  registerNotificationRouting,
  syncReminderNotifications,
} from '@/lib/notifications/reminders';
import { useCoachPassRunner } from '@/hooks/use-coach-pass';

/**
 * Root layout.
 *
 * ARC is light-mode only: the Conformed Set (docs/project-status.md §3) treats
 * the bone drafting sheet as the identity, so there is no dark theme to switch
 * to — app.json pins userInterfaceStyle to "light" and this theme is
 * unconditional. `navColors` is read imperatively from src/constants/theme.ts,
 * which means this file does NOT follow a Tailwind change; it and
 * app/(tabs)/_layout.tsx must both be re-checked whenever the palette moves
 * (docs/design-research/implementation/01-rn-port-guide.md §2). Verified against
 * the Conformed Set: background and card are the sheet (#E7E4DA), border is the
 * hairline, primary is the one accent.
 *
 * No auth gate: ARC is single-user and local-first (no accounts). Access is
 * guarded by the Face ID / passcode app lock below (useAppLock, CLAUDE.md §2):
 * a locked cold start early-returns the lock screen so the Stack never mounts;
 * a re-lock after time in the background covers the mounted Stack with an
 * opaque overlay instead, so navigation state survives.
 * The whole tree sits under an ErrorBoundary because the data layer opens SQLite
 * synchronously and throws on failure.
 */
const arcNavTheme: Theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, ...navColors },
};

export default function RootLayout() {
  // Face ID / passcode gate (CLAUDE.md §2: the app lock is the security
  // boundary). Must be the first hook so its synchronous enabled-check settles
  // before anything below decides what to render.
  const lock = useAppLock();
  const router = useRouter();

  // Boot side effects, all fire-and-forget:
  //  - hydrate the Coach's API key + model from the Keychain into the in-memory
  //    mirror (the store emits when values land, so the Coach screen re-renders
  //    from preview to connected);
  //  - reconcile OS notifications with the active reminders, so a daily/weekly
  //    nudge keeps firing across launches and a reminder changed while the app
  //    was closed is picked up. Self-reporting and best-effort: it no-ops when
  //    the notifications native module isn't in the running binary or permission
  //    isn't granted, and the in-app reminders list stands on its own either way;
  //  - pull fresh Apple Health data (throttled), and again whenever the app
  //    returns to the foreground — wearables written while ARC was closed are
  //    waiting in HealthKit. No-ops until enabled, and (on web/node, or a
  //    build predating the module) while the native module is absent;
  //  - sweep expired meal photos off disk and reconcile the rows against the
  //    files (0033). Once per app open is the right cadence for a disk-space
  //    policy — a session left in the foreground for days defers its sweep to
  //    the next launch, which costs a few hundred kilobytes and saves running a
  //    timer against the file system for the life of the process. Synchronous
  //    (the expo-file-system File API is) and total: it swallows everything,
  //    including a database that has not reached 0033;
  //  - write the encrypted database snapshot if the last one is more than a day
  //    old, and again on every foreground — same shape as the health sync above
  //    and for the same reason: a durability net that needs a visit to Settings
  //    is a net nobody is under. Silent, throttled and re-entrancy-guarded
  //    inside `autoBackupIfDue`; the ciphertext lands in `Documents/backups/`,
  //    which deliberately DOES ride the iCloud device backup
  //    (docs/backups-subapp.md).
  useEffect(() => {
    void apiKeyStore.hydrate();
    runMealPhotoSweep(getDb());
    // And the recipe photo directory (0034). Same reconciliation, deliberately
    // NO expiry pass: a recipe photo is part of a document the owner keeps for
    // years, not evidence for one day's estimate.
    runRecipePhotoSweep(getDb());
    // And the progress-photo directory (0036). Same reconciliation, and the one
    // that goes furthest: no expiry pass AND no dangling-row deletion. A
    // progress photo's ROW is the record — its date, pose, notes and saved AI
    // readings — so a missing JPEG is reported and drawn as an authored empty,
    // never allowed to erase the history. See the sweep's own header.
    runProgressPhotoSweep(getDb());
    // Show notifications that fire while ARC is open (iOS drops them silently
    // otherwise) and route a tapped one where it belongs, instead of dumping
    // the user on Home with no idea why the phone buzzed.
    configureNotificationPresentation();
    void syncReminderNotifications(getDb());
    void syncHealthIfEnabled(getDb());
    // Deferred off the first frames: the pass VACUUMs and encrypts the whole
    // database, and even with the seal yielding between chunks, boot is the one
    // moment the JS thread has no slack to give. Four seconds is past the
    // splash, past the first Home paint, and far inside the throttle's 24h
    // tolerance. The foreground listener below stays immediate — by then the
    // app is idle-resumed, not racing to first paint.
    const backupTimer = setTimeout(() => void autoBackupIfDue(getDb()), 4000);
    const stopHealthSync = registerForegroundHealthSync(getDb());
    // The backup's own foreground listener. It is written out here rather than
    // hidden behind a `registerForegroundBackup` helper because
    // `src/lib/backup/snapshot.ts` is imported by the headless suites, and the
    // health module only owns its AppState seam by paying for a guarded require
    // to keep react-native out of node. One subscription at the root costs
    // nothing and keeps that cost from being paid twice.
    const backupSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void autoBackupIfDue(getDb());
    });
    const stopRouting = registerNotificationRouting((route) => {
      // Active reminders live on the Coach tab (its RemindersCard), so both
      // kinds land there — but a reminder tap carries its id so the specific
      // reminder can be surfaced rather than dropped, which is the whole point
      // of routing the tap at all (reminders.ts §registerNotificationRouting).
      // A check-in tap opens the tab as a plain conversation.
      if (route.kind === 'reminder') {
        router.push({ pathname: '/(tabs)/coach', params: { reminderId: route.id } });
      } else {
        router.push('/(tabs)/coach');
      }
    });
    return () => {
      clearTimeout(backupTimer);
      stopHealthSync();
      backupSub.remove();
      stopRouting();
    };
  }, [router]);

  // The Coach's own daily pass — driven HERE and only here, so it runs on app
  // open whichever tab the user lands on and runs exactly once. Home reads what
  // it said via useCoachPassMessage(); read-only by construction, so there is
  // no confirmation UI to host.
  //
  // Gated on the lock: while `locked`, the user has not authenticated, and a
  // pass would ship their health data to the model API on the say-so of whoever
  // is holding the phone. It fires the moment the gate opens.
  useCoachPassRunner(!lock.locked);

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
      <ThemeProvider value={arcNavTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          {/* Pushed over the tabs from the Log tab's Nutrition tile and from
              Data's Nutrition trend row (docs/information-architecture.md). The
              SAME screen is also the Eat tab, re-exported by
              app/(tabs)/eat.tsx — one hub, two ways in. Same for exercise/Train
              below. */}
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
          {/* INTEGRATOR-MERGE: recipes + grocery family (docs/recipes-grocery.md). */}
          <Stack.Screen name="recipes" />
          <Stack.Screen name="recipe-detail" />
          <Stack.Screen name="recipe-edit" />
          <Stack.Screen name="recipe-import" />
          {/* Plain-text AI recipe editing + the book's folders (0035), both
              2026-08-12 owner requests — docs/recipes-grocery.md. */}
          <Stack.Screen name="recipe-revise" />
          <Stack.Screen name="recipe-folders" />
          <Stack.Screen name="grocery" />
          <Stack.Screen name="exercise" />
          <Stack.Screen name="workout-log" />
          {/* INTEGRATOR-MERGE: Exercise sub-app routes (docs/exercise-subapp.md).
              program-edit was retired 2026-08-11 (programs → saved workouts). */}
          <Stack.Screen name="workout-live" />
          <Stack.Screen name="routine-edit" />
          <Stack.Screen name="exercise-detail" />
          <Stack.Screen name="muscle-freshness" />
          <Stack.Screen name="workout-import" />
          <Stack.Screen name="metric-entry" />
          <Stack.Screen name="capture" />
          <Stack.Screen name="symptom" />
          <Stack.Screen name="labs" />
          {/* INTEGRATOR-MERGE: labs pipeline route (docs/labs-subapp.md). */}
          <Stack.Screen name="lab-import" />
          {/* Settings — pushed from the last row of the Data tab. It was the
              fifth TAB until 2026-08-09, when the owner's first hardware review
              moved Nutrition and Exercise onto the bar and Settings off it
              (app/(tabs)/_layout.tsx). Being a stack screen rather than a hidden
              tab route is the point: it opens over the tab bar with a back
              chevron to Data, like Labs or Protocols. */}
          <Stack.Screen name="settings" />
          {/* Pushed from Settings. */}
          <Stack.Screen name="settings-profile" />
          <Stack.Screen name="settings-units" />
          <Stack.Screen name="settings-coach" />
          {/* The encrypted snapshot's own surface (docs/backups-subapp.md):
              status, the automatic-backup toggle, the recovery code, and the
              restore that replaces the database. */}
          <Stack.Screen name="settings-backups" />
          {/* What the Coach durably knows about you — inspectable and deletable
              (0030 coach_memories). Memory the user cannot read is memory the
              user cannot trust. */}
          <Stack.Screen name="coach-memory" />
          {/* INTEGRATOR-MERGE: wearables routes (docs/wearables-subapp.md). */}
          <Stack.Screen name="settings-health" />
          <Stack.Screen name="wearables" />
          {/* Pushed from the Data tab. */}
          {/* The execution record, behind Data's Mission trend row. That row
              used to navigate to Home, which is today's plan and therefore not
              an answer to a question about the days behind you. */}
          <Stack.Screen name="mission-history" />
          {/* The water record, behind Data's Water trend row — the one screen
              that tracks, logs AND edits a single metric. Water was already
              stored one row per capture (src/lib/db/repositories/water.ts),
              which is what makes editing a past entry expressible at all. */}
          <Stack.Screen name="water" />
          {/* Protocols became a sub-app root on 2026-08-25 — Home's mission
              area links straight to it, and Data keeps its row. The only source
              of the daily mission had been three taps inside a foldable
              section. */}
          <Stack.Screen name="protocols" />
          {/* Pushed from the hub: one protocol's live phase and its adherence. */}
          <Stack.Screen name="protocol-detail" />
          <Stack.Screen name="protocol-edit" />
          {/* Pushed from the protocol detail screen: the version timeline. */}
          <Stack.Screen name="protocol-versions" />
          <Stack.Screen name="screenings" />
          <Stack.Screen name="screening-form" />
          <Stack.Screen name="appointment-form" />
          {/* INTEGRATOR-MERGE: n-of-1 experiments surface (docs/ai-coach.md §6, migration 0027). */}
          <Stack.Screen name="experiments" />
          <Stack.Screen name="experiment-detail" />
          {/* INTEGRATOR-MERGE: progress photos (docs/progress-photos-subapp.md,
              migration 0036). Pushed from the Data tab's "Progress photos" row;
              the other three are pushed from the gallery. */}
          <Stack.Screen name="progress-photos" />
          <Stack.Screen name="progress-photo-add" />
          <Stack.Screen name="progress-photo-detail" />
          <Stack.Screen name="progress-photo-compare" />
          {/* INTEGRATOR-MERGE: the knowledge base (docs/knowledge-subapp.md,
              migration 0038 — authored as 0035, renumbered at merge) — the browsable/writable reference over the 0025
              RAG substrate. Pushed from the Data tab's "Knowledge base" row. */}
          <Stack.Screen name="knowledge" />
          <Stack.Screen name="knowledge-entry" />
          <Stack.Screen name="knowledge-entry-edit" />
          <Stack.Screen name="knowledge-import" />
          {/* INTEGRATOR-MERGE: Reports (docs/reports-subapp.md, migration 0039, authored as 0036 and renumbered at merge).
              Pushed from the Data tab's `Reports` row. `report-view` is both the
              draft preview and the persisted one — same renderer, two sources. */}
          <Stack.Screen name="reports" />
          <Stack.Screen name="report-view" />
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
