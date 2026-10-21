/**
 * `react-native-gesture-handler` (and its `/ReanimatedSwipeable` entry) for the
 * headless render suite.
 *
 * app/workout-live.tsx draws every set row inside a swipeable since round 3
 * (2026-10-21): swipe left to reveal Delete, the owner's pick. The real
 * package cannot load under Node — the swipeable is built on Reanimated
 * worklets and the root view on a native module — and a server render fires
 * no gestures anyway.
 *
 * ## What this is
 *
 * The OPEN frame, not the closed one. The swipeable draws its row and, after
 * it, whatever `renderRightActions` returns — the Delete that a swipe reveals —
 * so a render can assert the action exists, carries its label, and is wired:
 * the suite walks the element tree and presses it. On a device the row covers
 * it until swiped; that half (the gesture itself, the slide, the threshold) is
 * a device fact this stub cannot speak to. `GestureHandlerRootView` is a View.
 *
 * Test-harness only; app source is untouched.
 */
import { createElement } from 'react';
import { View } from 'react-native';

export function GestureHandlerRootView({ children, ...rest }) {
  return createElement(View, rest, children);
}

export default function ReanimatedSwipeable({ children, renderRightActions }) {
  const noop = () => {};
  const methods = { close: noop, openLeft: noop, openRight: noop, reset: noop };
  return createElement(
    View,
    null,
    children,
    renderRightActions ? renderRightActions({ value: 1 }, { value: -88 }, methods) : null
  );
}
