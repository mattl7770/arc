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
  // "@/x" → "<repo>/src/x" (tsconfig paths), preferring the .ts file. The .ts
  // candidate is tried FIRST even when the name looks like it has an extension:
  // `path.extname` reads a dotted module name (`migrations.generated`) as
  // ".generated" and would skip the append, breaking every aliased import of a
  // dotted .ts module. A genuinely extensioned specifier just fails the first
  // attempt and resolves on the fallback.
  if (specifier.startsWith('@/')) {
    const base = pathToFileURL(path.join(SRC, specifier.slice(2))).href;
    try {
      return await nextResolve(base + '.ts', context);
    } catch {
      return nextResolve(base, context);
    }
  }

  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  // Same dotted-name reasoning as the alias branch; ".ts"/".mjs"/".js" are the
  // only real extensions in this repo's import graph.
  if (isRelative && !/\.(ts|tsx|mjs|js|json)$/.test(specifier)) {
    try {
      return await nextResolve(specifier + '.ts', context);
    } catch {
      // Not a .ts module — fall through to normal resolution.
    }
  }
  return nextResolve(specifier, context);
}
