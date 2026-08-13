import { useEffect } from 'react';

/**
 * Keep the screen on — guarded, because `expo-keep-awake` is a native module
 * that is **not in the current binary**.
 *
 * ## Why this file exists at all
 *
 * `app/recipe-detail.tsx` opened with `import { useKeepAwake } from
 * 'expo-keep-awake'` at module scope. That module arrived in the same commit as
 * `expo-image-picker` (`c0a5e1a`, the recipe-book round) and rides the same
 * pending EAS build, so it throws on evaluation exactly as the picker does.
 *
 * That matters far more than one screen, because **Expo Router eagerly requires
 * every file under `app/` to build its route manifest**. One unguarded native
 * import, in one screen nobody has opened, is a hard error at app LAUNCH. The
 * owner saw the picker's version of it — *"cannot find native module
 * 'ExponentImagePicker'"* on every cold start — and this one was queued behind
 * it, waiting for the picker to be fixed to become the next startup error.
 *
 * Found by a sweep rather than by a report, which is the only reason it is not
 * a second round trip.
 *
 * ## The seam
 *
 * Same shape as `./photo-library.ts` and `src/lib/health/healthkit.ts`: a
 * `require` inside a try/catch, the shape checked before use, and absence
 * degrading to a no-op rather than a crash. Keeping the screen awake is a
 * comfort, not a correctness property — a cook-mode screen that dims on a
 * binary predating the module is a mildly worse recipe view, and that is the
 * right way for this to fail.
 *
 * It is a HOOK rather than a function because that is what the call site needs
 * and what makes the lifetime correct: activate on mount, release on unmount,
 * with no way for a caller to leak an activation by forgetting the second half.
 */

type KeepAwakeModule = {
  activateKeepAwakeAsync: (tag?: string) => Promise<void>;
  deactivateKeepAwake: (tag?: string) => Promise<void> | void;
};

function loadKeepAwake(): KeepAwakeModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-keep-awake') as Partial<KeepAwakeModule>;
    if (typeof mod.activateKeepAwakeAsync !== 'function') return null;
    if (typeof mod.deactivateKeepAwake !== 'function') return null;
    return mod as KeepAwakeModule;
  } catch {
    return null;
  }
}

/** Whether this binary can hold the screen on. */
export function isKeepAwakeAvailable(): boolean {
  return loadKeepAwake() !== null;
}

/**
 * Hold the screen on for as long as the calling component is mounted. A no-op
 * on a binary without the module.
 *
 * The tag scopes the activation, so two screens holding it at once release
 * independently rather than the first unmount dropping it for both.
 */
export function useKeepScreenAwake(tag = 'arc'): void {
  useEffect(() => {
    const keepAwake = loadKeepAwake();
    if (!keepAwake) return;

    let released = false;
    // Fire-and-forget: an activation that loses its race with unmount must
    // still be released, which is what `released` guards.
    void keepAwake
      .activateKeepAwakeAsync(tag)
      .then(() => {
        if (released) void keepAwake.deactivateKeepAwake(tag);
      })
      .catch(() => {
        // The module exists but the platform refused. Nothing to recover — the
        // screen dims, which is the same outcome as not having the module.
      });

    return () => {
      released = true;
      try {
        void keepAwake.deactivateKeepAwake(tag);
      } catch {
        // Releasing a lock that was never taken is not an error worth raising.
      }
    };
  }, [tag]);
}
