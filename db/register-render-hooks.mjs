/**
 * Registers the screen-render hooks (render-hook.mjs) for the headless render
 * suite. Used via `node --import ./db/register-render-hooks.mjs <test>`.
 */
import { register } from 'node:module';

register('./render-hook.mjs', import.meta.url);
