/**
 * A minimal stand-in for `react`, so a REAL app hook can be driven headlessly.
 *
 * The render suite (db/screens-render.test.mjs) renders once to a string with
 * react-dom/server: no effects, no state updates, nothing asynchronous. That
 * cannot exercise a hook whose whole job happens after the first render — a
 * Coach turn streams, suspends at the confirmation gate, and settles later.
 * No client renderer (react-test-renderer, a DOM) is installed, and the db
 * suites never `npm install`.
 *
 * So a test maps the `react` specifier here (see db/coach-fidelity.test.mjs §7)
 * and calls {@link renderHook}. Every `setState` re-runs the hook function
 * synchronously, and effects run after each render whose deps changed, with
 * their cleanup run on `unmount`. That is the slice of React's contract the
 * hooks under test rely on: call order is stable, a setter's identity is
 * stable, an updater may receive the previous value. Batching and concurrent
 * rendering are deliberately absent — a hook that only works because React
 * batched its updates is a hook these tests should catch.
 *
 * Test-harness only — app source is untouched.
 */

let rendering = null;

function slot(init) {
  const inst = rendering;
  if (!inst) throw new Error('hook called outside renderHook');
  const index = inst.cursor++;
  if (!(index in inst.slots)) inst.slots[index] = init();
  return [inst, inst.slots[index]];
}

const depsChanged = (prev, next) =>
  prev === undefined ||
  next === undefined ||
  prev.length !== next.length ||
  prev.some((value, i) => !Object.is(value, next[i]));

export function useState(initial) {
  const [inst, state] = slot(() => ({
    value: typeof initial === 'function' ? initial() : initial,
  }));
  if (!state.set) {
    state.set = (next) => {
      const value = typeof next === 'function' ? next(state.value) : next;
      if (Object.is(value, state.value)) return;
      state.value = value;
      if (inst.unmounted) return;
      if (rendering) throw new Error('setState during render');
      inst.render();
    };
  }
  return [state.value, state.set];
}

export function useRef(initial) {
  return slot(() => ({ current: initial }))[1];
}

export function useMemo(factory, deps) {
  const [, memo] = slot(() => ({ deps: undefined, value: undefined }));
  if (depsChanged(memo.deps, deps)) {
    memo.value = factory();
    memo.deps = deps;
  }
  return memo.value;
}

export function useCallback(fn, deps) {
  return useMemo(() => fn, deps);
}

export function useEffect(effect, deps) {
  const [inst, slotState] = slot(() => ({ deps: undefined, cleanup: undefined }));
  if (depsChanged(slotState.deps, deps)) {
    slotState.deps = deps;
    inst.pendingEffects.push(() => {
      slotState.cleanup?.();
      const cleanup = effect();
      slotState.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    });
  }
}

/**
 * Mount `hook` and return a live handle: `result` is always the latest render's
 * return value; `unmount` runs every effect cleanup, as React would.
 */
export function renderHook(hook) {
  const inst = { slots: [], cursor: 0, pendingEffects: [], unmounted: false, result: undefined };
  inst.render = () => {
    inst.cursor = 0;
    inst.pendingEffects = [];
    rendering = inst;
    try {
      inst.result = hook();
    } finally {
      rendering = null;
    }
    for (const run of inst.pendingEffects) run();
  };
  inst.render();
  return {
    get result() {
      return inst.result;
    },
    unmount() {
      inst.unmounted = true;
      for (const s of inst.slots) s?.cleanup?.();
    },
  };
}

export default { useState, useRef, useMemo, useCallback, useEffect };
