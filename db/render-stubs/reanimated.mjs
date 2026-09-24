/**
 * react-native-reanimated stub for the headless screen-render suite.
 *
 * The real package's ESM entry reaches into react-native-worklets, whose
 * extensionless internal imports do not resolve under node — so a screen that
 * imports Reanimated fails to LOAD, not merely to animate. A server render runs
 * no animation anyway: every animated component is its plain react-native-web
 * counterpart with the animation props (`layout`, `entering`, `exiting`)
 * dropped, and every layout-animation builder is a chain that accepts any call.
 *
 * It says nothing about how anything MOVES. That stays the device's
 * (memory: verify on device, not web).
 */
import { createElement } from 'react';
import { ScrollView, Text, View } from 'react-native-web';

const strip =
  (Component) =>
  ({ layout: _layout, entering: _entering, exiting: _exiting, ...props }) =>
    createElement(Component, props);

/** A builder that answers every chained call (`.springify().damping(19)…`) with itself. */
const chain = new Proxy(function builder() {}, {
  get: (_target, key) => (key === Symbol.toPrimitive ? () => '' : chain),
  apply: () => chain,
});

const Animated = {
  View: strip(View),
  Text: strip(Text),
  ScrollView: strip(ScrollView),
  createAnimatedComponent: (Component) => strip(Component),
};

export default Animated;
export const FadeIn = chain;
export const FadeOut = chain;
export const ZoomIn = chain;
export const ZoomOut = chain;
export const LinearTransition = chain;
export const Layout = chain;
export const Easing = chain;
export const useSharedValue = (value) => ({ value });
export const useAnimatedStyle = () => ({});
export const withTiming = (value) => value;
export const withSpring = (value) => value;
export const withRepeat = (value) => value;
export const withSequence = (...values) => values[values.length - 1];
export const withDelay = (_ms, value) => value;
export const cancelAnimation = () => {};
