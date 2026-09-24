/**
 * `react-native-reanimated` for the headless render suite.
 *
 * app/workout-live.tsx — the set grid, and the only screen that draws the
 * stopwatch clock field in all three of its modes (live, editing a stored
 * session, filling in a watch session) — imports Reanimated for the superset
 * bind's spring and the seam chip's stamp. The real package cannot load under
 * Node: its entry pulls in `react-native-worklets`, whose ESM build resolves
 * native initializers that exist only in a binary. So the screen could not be
 * rendered here at all, and its fields had no headless gate.
 *
 * ## What this is
 *
 * The settled frame. `Animated.View` is a plain `View` with the three animation
 * props (`entering`, `exiting`, `layout`) dropped, and each layout-animation
 * builder is a chain whose modifiers return the chain, so
 * `LinearTransition.springify().damping(19).stiffness(210).mass(0.6)` evaluates
 * at module scope and means nothing. A server render draws the layout after
 * every animation has finished, which is the only frame the suite asserts about.
 *
 * The builder names are listed rather than proxied, so an animation this stub
 * does not know fails loudly instead of rendering as nothing.
 *
 * Test-harness only; app source is untouched.
 */
import { createElement } from 'react';
import { Text, View } from 'react-native';

const chain = {};
for (const modifier of ['springify', 'damping', 'stiffness', 'mass', 'duration', 'delay']) {
  chain[modifier] = () => chain;
}

export const FadeIn = chain;
export const FadeOut = chain;
export const LinearTransition = chain;
export const ZoomIn = chain;

const settled = (Host) => {
  const Component = ({ entering: _entering, exiting: _exiting, layout: _layout, ...rest }) =>
    createElement(Host, rest);
  return Component;
};

const Animated = { View: settled(View), Text: settled(Text) };

export default Animated;
