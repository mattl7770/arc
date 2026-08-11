/**
 * Registers the screen-render hooks (render-hook.mjs) for the headless render
 * suite. Used via `node --import ./db/register-render-hooks.mjs <test>`.
 */
import { register } from 'node:module';

/**
 * `__DEV__` is a React Native global that Metro injects; Node has never heard
 * of it. `src/components/ui/block.tsx` reads it to decide whether to log the
 * nested-device error, so every screen that renders a `<Block>` — which, since
 * the Conformed Set, is all of them — throws `__DEV__ is not defined` without
 * this line.
 *
 * It is set to **false**, i.e. production semantics: the dev-only guard is a
 * `console.error` about a mistake the suite is not trying to provoke, and
 * leaving it on would turn the render output into noise.
 */
globalThis.__DEV__ = false;

register('./render-hook.mjs', import.meta.url);
