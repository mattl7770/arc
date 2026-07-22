/**
 * Regenerates src/types/database.ts from the linked Supabase project.
 *
 * Why this exists rather than a plain `supabase gen types ... > file`:
 * the shell truncates the target file before the CLI runs, so any failure
 * (not linked, no network, bad credentials) leaves you with an empty types
 * file and a broken build. This captures stdout and only writes on success.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'src', 'types', 'database.ts');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

let out;
try {
  out = execFileSync(npx, ['--no-install', 'supabase', 'gen', 'types', 'typescript', '--linked'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
} catch {
  console.error(
    '\nType generation failed — src/types/database.ts was left untouched.\n' +
      'Is the project linked? Run:  npx supabase link --project-ref <ref>\n'
  );
  process.exit(1);
}

// A successful exit with junk output would be worse than a clean failure.
if (!out.includes('export type Database')) {
  console.error('\nUnexpected generator output; refusing to overwrite the types file.\n');
  process.exit(1);
}

writeFileSync(target, out, 'utf8');
console.log(`Wrote ${out.split('\n').length} lines to src/types/database.ts`);
