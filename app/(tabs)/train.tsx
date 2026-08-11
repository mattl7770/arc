/**
 * The **Train** tab — the exercise sub-app, promoted from a pushed screen to a
 * first-class surface (owner call on hardware, 2026-08-09; see
 * app/(tabs)/_layout.tsx for the six-tab reasoning and the label measurement).
 *
 * A re-export for the same reason as app/(tabs)/eat.tsx: `app/exercise.tsx` is
 * the training hub and stays canonical — still pushed from the Log tab's
 * Workout tile and from Data's Training trend row, and still the screen the
 * session family (`/workout-live`, `/workout-log`, `/routine-edit`,
 * `/exercise-detail`, `/muscle-freshness`, `/workout-import`) returns to.
 * Copying it here would fork the hub; re-exporting keeps the tab and the pushed
 * route the same screen.
 *
 * The header is chosen by POSITION, not by a prop: `app/exercise.tsx` (~:138)
 * branches on `useSegments()[0] === '(tabs)'` — the tab root gets a plain serif
 * title, the pushed route keeps `StackHeader` and its back chevron.
 * `router.canGoBack()` is deliberately NOT the test: `backBehavior="history"`
 * makes it report true on a tab root reached after any navigation.
 */
export { default } from '../exercise';
