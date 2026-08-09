/**
 * Node ESM hooks for the HEADLESS SCREEN-RENDER suite (db/screens-render.test.mjs).
 *
 * Extends the db-test resolve rules (`@/` alias, extensionless relative
 * imports) with what rendering real .tsx screens under node needs:
 *  - .tsx resolution and JSX transpilation (the TypeScript compiler API —
 *    node's built-in type stripping cannot parse JSX),
 *  - 'react-native' → 'react-native-web' (installed; the repo's web target),
 *  - stubs for the native/runtime modules a server render can't load:
 *    expo-router (params/router/focus-effect), expo-keep-awake, Ionicons,
 *    react-native-safe-area-context, and '@/lib/db/client' (swapped for a
 *    node:sqlite-backed database running the REAL migrations).
 *
 * Test-harness only — app source is untouched.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const REPO = path.join(HERE, '..');

const STUBS = {
  'expo-router': pathToFileURL(path.join(HERE, 'render-stubs', 'expo-router.mjs')).href,
  'expo-keep-awake': pathToFileURL(path.join(HERE, 'render-stubs', 'expo-keep-awake.mjs')).href,
  '@expo/vector-icons/Ionicons': pathToFileURL(path.join(HERE, 'render-stubs', 'ionicons.mjs'))
    .href,
  'react-native-safe-area-context': pathToFileURL(path.join(HERE, 'render-stubs', 'safe-area.mjs'))
    .href,
  '@/lib/db/client': pathToFileURL(path.join(HERE, 'render-stubs', 'db-client.mjs')).href,
};

async function resolveWithExtensions(base, context, nextResolve) {
  if (path.extname(base)) return nextResolve(base, context);
  for (const ext of ['.ts', '.tsx']) {
    try {
      return await nextResolve(base + ext, context);
    } catch {
      // try the next extension
    }
  }
  return nextResolve(base, context);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier in STUBS) return { url: STUBS[specifier], shortCircuit: true };
  if (specifier === 'react-native') {
    return nextResolve('react-native-web', context);
  }
  if (specifier.startsWith('@/')) {
    const base = pathToFileURL(path.join(SRC, specifier.slice(2))).href;
    return resolveWithExtensions(base, context, nextResolve);
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {
    return resolveWithExtensions(specifier, context, nextResolve);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && (url.endsWith('.ts') || url.endsWith('.tsx'))) {
    const filePath = fileURLToPath(url);
    // Only transpile repo source — node_modules .ts would be unexpected anyway.
    if (filePath.startsWith(REPO)) {
      const source = readFileSync(filePath, 'utf8');
      const out = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
          isolatedModules: true,
        },
        fileName: filePath,
      });
      return { format: 'module', source: out.outputText, shortCircuit: true };
    }
  }
  return nextLoad(url, context);
}
