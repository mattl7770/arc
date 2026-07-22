/**
 * Regenerates src/types/database.ts from the linked Supabase project.
 *
 * Two things this handles that a plain
 *   `supabase gen types typescript --linked > src/types/database.ts`
 * does not:
 *
 * 1. The shell truncates the target file *before* the CLI runs, so any
 *    failure (not linked, no network, bad credentials) leaves you with an
 *    empty types file and a broken build. This buffers stdout and only
 *    writes on success.
 *
 * 2. Resolving the CLI. The `supabase` npm package ships its bin as a plain
 *    JS file, so we run it with the current Node binary. Going via `npx` or
 *    `node_modules/.bin/supabase.cmd` fails on Windows with EINVAL — since
 *    the CVE-2024-27980 mitigation, Node refuses to spawn .cmd/.bat without
 *    `shell: true`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'src', 'types', 'database.ts');

/** Absolute path to the Supabase CLI's JS entry point, or null. */
function resolveCli() {
  try {
    const pkgPath = require.resolve('supabase/package.json');
    const { bin } = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const rel = typeof bin === 'string' ? bin : bin?.supabase;
    if (rel) {
      const resolved = join(dirname(pkgPath), rel);
      if (existsSync(resolved)) return resolved;
    }
  } catch {
    // Fall through to the conventional location.
  }
  const fallback = join(root, 'node_modules', 'supabase', 'dist', 'supabase.js');
  return existsSync(fallback) ? fallback : null;
}

const cli = resolveCli();
if (!cli) {
  console.error('\nCould not find the Supabase CLI. Run:  npm install\n');
  process.exit(1);
}

let out;
try {
  out = execFileSync(process.execPath, [cli, 'gen', 'types', 'typescript', '--linked'], {
    cwd: root,
    encoding: 'utf8',
    // stderr passes through so the CLI's own diagnostics are the ones you read.
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (err) {
  console.error(
    `\nType generation failed (${err.code ?? `exit ${err.status}`}).\n` +
      'src/types/database.ts was left untouched.\n' +
      'If the project is not linked yet:  npx supabase link --project-ref <ref>\n'
  );
  process.exit(1);
}

// A zero exit with unexpected output would be worse than a clean failure.
if (!out.includes('export type Database')) {
  console.error('\nUnexpected generator output; refusing to overwrite the types file.\n');
  process.exit(1);
}

writeFileSync(target, out, 'utf8');
console.log(`Wrote ${out.split('\n').length} lines to src/types/database.ts`);
