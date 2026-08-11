/**
 * expo-router stub for the headless screen-render suite. Params are settable
 * per render via __setParams; router methods record calls; useFocusEffect is
 * a no-op (a server render runs no effects — matching SSR semantics).
 */
export const __router = { pushes: [], replaces: [], backs: 0 };
let params = {};
/**
 * The route the screen believes it is rendering at. `app/nutrition.tsx` and
 * `app/exercise.tsx` pick their header by POSITION — `useSegments()[0] ===
 * '(tabs)'` gives the tab root's plain serif title, anything else keeps the
 * pushed route's StackHeader — so a suite that renders the Eat tab has to be
 * able to say which of the two it is rendering. Defaults to the PUSHED route,
 * because that is what every other screen in this suite is.
 */
let segments = ['nutrition'];

export function __setParams(next) {
  params = next;
}

/** Render the next screen as if it were the tab root (or not). */
export function __setSegments(next) {
  segments = next;
}

export function useSegments() {
  return segments;
}

export function useLocalSearchParams() {
  return params;
}

export function useRouter() {
  return {
    push: (to) => {
      __router.pushes.push(to);
    },
    replace: (to) => {
      __router.replaces.push(to);
    },
    back: () => {
      __router.backs += 1;
    },
  };
}

export function useFocusEffect() {}
