/**
 * Registers the .ts extension resolve hook (ts-ext-hook.mjs) for the headless
 * db tests. Used via `node --import ./db/register-ts-hooks.mjs <test>`.
 */
import { register } from 'node:module';

register('./ts-ext-hook.mjs', import.meta.url);
