/**
 * expo-router stub for the headless screen-render suite. Params are settable
 * per render via __setParams; router methods record calls; useFocusEffect is
 * a no-op (a server render runs no effects — matching SSR semantics).
 */
export const __router = { pushes: [], replaces: [], backs: 0 };
let params = {};

export function __setParams(next) {
  params = next;
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
