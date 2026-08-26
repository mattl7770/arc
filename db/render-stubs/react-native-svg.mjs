/**
 * `react-native-svg` for the headless render suite.
 *
 * The body figure (src/components/exercise/muscle-figure.tsx) is `<Path>`
 * elements since 2026-08-25, so the three screens that draw it —
 * app/exercise.tsx, app/muscle-freshness.tsx, app/exercise-detail.tsx — cannot
 * be rendered under Node without this module resolving to something.
 *
 * ## Why not the package's own web build
 *
 * `react-native-svg` ships one (`lib/module/ReactNativeSVG.web.js`) and that was
 * tried first, since a real implementation beats a fake one. Metro reaches it
 * through platform-extension resolution — `./elements` → `elements.web.js` — and
 * Node's resolver has no such rule, so the render hook would have to grow one.
 * That was implemented and it worked, twice, and then the import graph walked
 * into `@react-native/assets-registry`, which is a native package with no web
 * entry at all. Teaching a test resolver enough of Metro to load a native SVG
 * library is a larger and more fragile thing than the suite it serves, and every
 * rule added to `resolveWithExtensions` also changes how the OTHER thirty
 * screens resolve their imports.
 *
 * ## What this is instead
 *
 * A pass-through to the DOM. Every element maps to its real SVG tag, and every
 * prop the component passes — `d`, `viewBox`, `fill`, `stroke`, `strokeWidth`,
 * `stopColor`, `fillOpacity`, `gradientUnits` — is already the camelCase name
 * React DOM wants for an SVG attribute, so `renderToString` emits genuine
 * `<svg><path d="M…C…Z" fill="url(#…)"/></svg>`.
 *
 * That is a more useful stub than an inert `<View>` would be: a malformed path
 * string, a gradient id that does not match its `url(#…)` reference, or a
 * `NaN` in a stroke width all show up in the rendered HTML where the suite can
 * see them, rather than being swallowed. What it does NOT do is rasterise —
 * looks stay the on-device check plus db/figure-preview.mjs (memory: verify on
 * device, not web).
 *
 * Test-harness only; app source is untouched.
 */
import { createElement } from 'react';

const tag = (name) => {
  const Component = (props) => createElement(name, props);
  Component.displayName = name;
  return Component;
};

export const Svg = tag('svg');
export const G = tag('g');
export const Path = tag('path');
export const Rect = tag('rect');
export const Circle = tag('circle');
export const Ellipse = tag('ellipse');
export const Line = tag('line');
export const Polygon = tag('polygon');
export const Polyline = tag('polyline');
export const Defs = tag('defs');
export const ClipPath = tag('clipPath');
export const Mask = tag('mask');
export const LinearGradient = tag('linearGradient');
export const RadialGradient = tag('radialGradient');
export const Stop = tag('stop');
export const Text = tag('text');
export const TSpan = tag('tspan');
export const Use = tag('use');
export const Symbol = tag('symbol');

export default Svg;
