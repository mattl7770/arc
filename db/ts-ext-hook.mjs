/**
 * Node ESM resolve hook for the headless db tests.
 *
 * The app's source uses two things raw Node ESM doesn't resolve but Metro/tsc
 * do: extensionless relative imports (`../id`) and the `@/` path alias
 * (`@/lib/log/metrics`, mapped to `src/` in tsconfig). This hook handles both so
 * `node --import ./db/register-ts-hooks.mjs` can run the real app modules (Node
 * strips the types on load). App source stays idiomatic; only the test harness
 * needs this.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

export async function resolve(specifier, context, nextResolve) {
  // "@/x" → "<repo>/src/x" (tsconfig paths), preferring the .ts file.
  if (specifier.startsWith('@/')) {
    const base = pathToFileURL(path.join(SRC, specifier.slice(2))).href;
    const candidate = path.extname(base) ? base : base + '.ts';
    try {
      return await nextResolve(candidate, context);
    } catch {
      return nextResolve(base, context);
    }
  }

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
