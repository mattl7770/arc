/**
 * The bundled exercise demonstration photos, for the headless render suite.
 *
 * `src/lib/exercise/images.generated.ts` is 69 static `require('…jpg')` calls,
 * because that is the only form Metro can resolve into the binary. Under Node
 * the module is transpiled to ESM, where `require` does not exist at all — so
 * importing it is a **resolve-time** ReferenceError, and any screen that touches
 * it cannot be rendered. That is why `app/exercise-detail.tsx` was never on the
 * render walk.
 *
 * It is on the walk since 2026-08-25, because that screen is the ONLY consumer
 * of the body figure's `mode: 'muscles'` — the branch with the design firewall
 * on it (a fact about an exercise must never wear the signal green), and the
 * branch that takes no gradient. Leaving the one screen with a rule on it
 * untested was the weakest spot in this area's coverage.
 *
 * Every photo resolves to absent here, which is a REAL state rather than a
 * fiction: a custom exercise has no bundled photo, and the screen's documented
 * fallback is the muscle schematic alone. So the stub renders the branch the
 * suite most wants to see.
 *
 * Test-harness only; app source is untouched.
 */
export const EXERCISE_IMAGES = {};

export function resolveExerciseImage() {
  return null;
}
