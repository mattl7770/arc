/**
 * Node ESM resolve hook for the headless db tests.
 *
 * The app's source uses extensionless relative imports (`../id`), which Metro
 * and tsc resolve but raw Node ESM does not. This hook appends `.ts` to
 * extensionless relative specifiers so `node --import ./db/register-ts-hooks.mjs`
 * can run the real app modules (Node strips the types on load). App source stays
 * idiomatic; only the test harness needs this. Aliased `@/` imports in those
 * modules are all `import type`, so they're erased and never hit this hook.
 */
import path from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  if (isRelative && !path.extname(specifier)) {
    try {
      return await nextResolve(specifier + '.ts', context);
    } catch {
      // Not a .ts module — fall through to normal resolution.
    }
  }
  return nextResolve(specifier, context);
}
