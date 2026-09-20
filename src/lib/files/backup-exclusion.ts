/**
 * Keep an on-device file or directory OUT of the iCloud / iTunes device backup
 * (iOS `NSURLIsExcludedFromBackupKey`).
 *
 * Why this exists: `arc.db` (the whole health record) and the progress/meal/
 * recipe photo directories live in backup-included locations by default, so
 * without this they replicate to iCloud — personal data at rest in the cloud,
 * the one thing ARC forbids (CLAUDE.md §2). There is NO JavaScript API for the
 * exclusion flag in this stack (neither `expo-file-system` nor `op-sqlite`
 * exposes it), so it rides a tiny native module named `ArcBackup`.
 *
 * ## Guarded, exactly like api-key-store / photo-file-store
 *
 * The native module is loaded through `requireOptionalNativeModule`, which
 * returns `null` when the module is not linked into the running binary — the web
 * logic-check preview, the headless suites, and any build that does not yet
 * include the `ArcBackup` module. In every one of those cases this is a silent
 * no-op: nothing is excluded, nothing crashes. The exclusion therefore activates
 * automatically the moment the native module ships in an EAS build.
 *
 * The `ArcBackup` native module now EXISTS, in this repo, at `modules/arc-backup/`
 * (written 2026-09-19; specced by the 2026-08-23 "At-rest data must not ride the
 * iCloud backup" ADR in `docs/decisions.md`, and missing from the build that
 * shipped two days after it — during which this seam excluded precisely nothing).
 * The guarded load above stays exactly as it is regardless: it is what keeps the
 * web logic-check preview and the headless suites running, and what keeps a
 * build that predates the module a no-op rather than a crash. Do not "simplify"
 * it into a bare `requireNativeModule`.
 *
 * Accepts a plain filesystem path (op-sqlite's `getDbPath()`) or a `file://` URI
 * (expo-file-system's `.uri`); the native side normalizes both. Best-effort and
 * total: it never throws.
 */
type BackupModule = { excludeFromBackup(pathOrUri: string): boolean };

let cached: BackupModule | null = null;
let loaded = false;

function load(): BackupModule | null {
  if (loaded) return cached;
  loaded = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require('expo-modules-core') as {
      requireOptionalNativeModule?: (name: string) => BackupModule | null;
    };
    const mod = core.requireOptionalNativeModule?.('ArcBackup') ?? null;
    cached = mod && typeof mod.excludeFromBackup === 'function' ? mod : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Exclude one path/URI from the device backup. No-op when the native module is absent. */
export function excludeFromBackup(pathOrUri: string): void {
  try {
    load()?.excludeFromBackup(pathOrUri);
  } catch {
    // Best-effort: a failed exclusion must never take down a write or app boot.
  }
}
