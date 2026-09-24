/**
 * react-native-reanimated stub for the headless screen-render suite.
 *
 * The real package cannot load under node at all — it resolves into
 * react-native-worklets, whose ESM build imports an extensionless native
 * initializer — which is what kept app/workout-live.tsx off the walk until
 * 2026-09-23. A server render runs no animation anyway: the layout springs and
 * entering/exiting presets only ever describe motion, never content. So each
 * `Animated.*` component renders its react-native-web counterpart with those
 * three props dropped, and every preset is a chainable no-op
 * (`LinearTransition.springify().damping(19)…` has to survive being built at
 * module scope).
 *
 * What this cannot prove: anything about the motion itself. That stays a
 * device check (memory: verify on device, not web).
 */
import { createElement } from 'react';
import { ScrollView, Text, View } from 'react-native-web';

/** A preset builder: every property is a method returning the same builder. */
function preset() {
  const builder = new Proxy(function noop() {}, {
    get: (_target, prop) => (prop === 'then' ? undefined : () => builder),
    apply: () => builder,
  });
  return builder;
}

function strip(Component) {
  return function AnimatedStub({ entering, exiting, layout, ...rest }) {
    void entering;
    void exiting;
    void layout;
    return createElement(Component, rest);
  };
}

const Animated = {
  View: strip(View),
  Text: strip(Text),
  ScrollView: strip(ScrollView),
  createAnimatedComponent: (Component) => strip(Component),
};

export default Animated;
export const FadeIn = preset();
export const FadeOut = preset();
export const LinearTransition = preset();
export const ZoomIn = preset();
