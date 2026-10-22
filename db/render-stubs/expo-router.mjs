/**
 * expo-router stub for the headless screen-render suite. Params are settable
 * per render via __setParams; router methods record calls; useFocusEffect is
 * a no-op (a server render runs no effects — matching SSR semantics).
 */
export const __router = { pushes: [], replaces: [], backs: 0, dismissTos: [], dismisses: [] };
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
    dismissTo: (to) => {
      __router.dismissTos.push(to);
    },
    dismiss: (count = 1) => {
      __router.dismisses.push(count);
    },
  };
}

/**
 * The navigation container's root state, as `useNavigationContainerRef()`
 * hands it out — read by the session bar's tap to decide whether the live
 * logger is already on the stack (src/components/exercise/session-bar.tsx).
 * Undefined by default: no navigation state, as a server render has none.
 */
let rootState;

export function __setRootState(next) {
  rootState = next;
}

export function useNavigationContainerRef() {
  return { getRootState: () => rootState, isReady: () => rootState !== undefined };
}

export function useFocusEffect() {}

/**
 * The navigation handle the two workout loggers (app/workout-live.tsx,
 * app/workout-log.tsx) take for their unsaved-work guard. They only ever call
 * it inside an effect — `addListener('beforeRemove', …)` — and a server render
 * runs no effects, so the handle only has to exist for the screens to render.
 */
export function useNavigation() {
  return {
    addListener: () => () => {},
    dispatch: () => {},
    // The navigator this screen sits in — read by `Screen` to decide whether it
    // draws the session bar at its foot (src/lib/exercise/session-bar.ts).
    getState: () => (route.navigator ? { type: route.navigator } : undefined),
  };
}

/**
 * Where the rendered screen sits (item 71, the session bar). `navigator` is the
 * containing navigator's type ('stack' for a pushed screen, 'tab' for a tab
 * root). It defaults to NONE — no navigation state — so every screen this suite
 * rendered before the bar existed renders exactly as it did; a suite that is
 * about the bar says where the screen is.
 */
let route = { name: 'screen', navigator: undefined };

export function __setRoute(next) {
  route = { name: 'screen', navigator: undefined, ...next };
}

export function useRoute() {
  return { key: `${route.name}-key`, name: route.name, params };
}

/** A server render is a screen on top. */
export function useIsFocused() {
  return true;
}

/**
 * The static singleton some components import for imperative navigation
 * outside the render tree (e.g. src/components/exercise/exercise-picker.tsx,
 * which the routine-edit walk pulled in — A9). Records the same way
 * useRouter()'s handle does, so either import path is visible in __router.
 */
export const router = {
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
