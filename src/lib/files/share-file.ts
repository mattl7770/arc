/**
 * Write a text document to the app's (non-backed-up) Caches directory and offer
 * it through the iOS share sheet — the one definition of that outcome ledger.
 *
 * WHERE it is written is a privacy decision: exports and reports are whole-
 * health-data artifacts, so they go under Caches (never in an iCloud/iTunes
 * backup) rather than Documents (which is), and a successfully-shared file is
 * deleted immediately afterward. Both are safe because every artifact here is
 * regenerated on demand from the database.
 *
 * Lifted out of src/lib/export/export-file.ts on 2026-08-12, when Reports
 * needed the identical dance for an HTML file (docs/reports-subapp.md §4,
 * "named refactor, small"). Export's public API and its behaviour are
 * unchanged; it now supplies a filename, a MIME type and a thunk, and this
 * module owns the rest.
 *
 * ## The outcome ledger, and why it has four states rather than a boolean
 *
 * Fully offline: the file never leaves the device unless the user picks a share
 * target themselves. Both native modules are required in try/catch (the
 * api-key-store pattern) and degrade HONESTLY rather than silently:
 *
 *   - `expo-file-system` ships inside the current dev build (it is a dependency
 *     of the `expo` package), so writing works today; if it is somehow absent
 *     (the web logic-check preview, the headless suites), the outcome is
 *     `unavailable` and NOTHING was written — distinct from a failure.
 *   - `expo-sharing` is NOT in the current binary — it rides the next EAS build
 *     (docs/project-status.md, Known caveats). Until then the file is still
 *     written and the outcome is `saved` WITH THE FULL PATH, so the document is
 *     usable (Finder / Xcode container download) rather than silently
 *     unshareable. That distinction is the whole reason `saved` exists: "we
 *     wrote it, you just cannot hand it over from here yet" is a different
 *     thing to tell the user than "it worked" or "it failed".
 *   - A share-sheet hiccup after a successful write falls through to `saved`.
 *     The file is safely on disk; reporting a failure would be false.
 *
 * ## `content` is a THUNK, and that is load-bearing
 *
 * The serializer (or the report renderer) runs INSIDE this module's try/catch,
 * so a throw while producing the bytes is a `failed` outcome carrying its
 * message to the user-facing alert — not an exception escaping into a caller
 * that has no better answer than a red screen. Taking a ready-made string
 * instead would have moved that risk back out to every call site, and export
 * has relied on this behaviour since it shipped.
 */

/** The slice of expo-file-system's File/Directory API this module uses. */
type FileHandle = {
  uri: string;
  exists: boolean;
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
  write(content: string): void;
  delete(): void;
};
type DirectoryHandle = {
  exists: boolean;
  create(options?: { intermediates?: boolean; idempotent?: boolean }): void;
};
type FileSystemModule = {
  // `cache` is the app's Library/Caches directory — iOS never includes it in an
  // iCloud/iTunes backup, which is why a whole-health-data export or a report
  // (biomarkers, body metrics) is written HERE, not under Documents. See header.
  Paths: { document: unknown; cache: unknown };
  File: new (...parts: unknown[]) => FileHandle;
  Directory: new (...parts: unknown[]) => DirectoryHandle;
};

/** The slice of expo-sharing this module uses. */
type SharingModule = {
  isAvailableAsync(): Promise<boolean>;
  shareAsync(
    url: string,
    options?: { mimeType?: string; UTI?: string; dialogTitle?: string }
  ): Promise<void>;
};

let fileSystem: FileSystemModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  fileSystem = require('expo-file-system') as FileSystemModule;
} catch {
  fileSystem = null;
}

let sharing: SharingModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sharing = require('expo-sharing') as SharingModule;
} catch {
  sharing = null;
}

export type FileOutcome =
  /** Written AND handed to the share sheet. */
  | { status: 'shared'; fileName: string; uri: string }
  /** Written to Caches; share sheet unavailable until the next build. */
  | { status: 'saved'; fileName: string; uri: string }
  /** No file system module at all (web preview) — nothing was written. */
  | { status: 'unavailable' }
  /** Producing or writing the file failed; message is for the user-facing alert. */
  | { status: 'failed'; message: string };

export type ShareFileRequest = {
  /** Base name including extension: `arc-export-20260812-143308.json`. */
  fileName: string;
  /**
   * A directory under Caches, or omitted to write at the top level. Export
   * writes flat (it has since it shipped, and its files are occasional);
   * Reports uses `reports/` so a year of documents does not scatter through the
   * cache root.
   */
  directory?: string;
  /** Produces the bytes. Runs inside the try/catch — see the header. */
  content: () => string;
  mimeType: string;
  /** The iOS Uniform Type Identifier, which is what actually drives the sheet. */
  uti: string;
  dialogTitle: string;
};

/**
 * True when a write could happen at all. Callers use it to disable an
 * affordance up front rather than offering an action that can only report
 * `unavailable`.
 */
export function fileWritingAvailable(): boolean {
  return fileSystem != null && typeof fileSystem.File === 'function';
}

/**
 * Write, then try to share. The write is synchronous (op-sqlite and the
 * expo-file-system File API both are); only the share step awaits.
 */
export async function writeAndShareFile(request: ShareFileRequest): Promise<FileOutcome> {
  const fs = fileSystem;
  if (!fs || typeof fs.File !== 'function') return { status: 'unavailable' };

  let file: FileHandle;
  try {
    const text = request.content();
    // Written under Caches, NOT Documents: these are whole-health-data artifacts
    // (a full DB export, a doctor pack) and Documents rides the iCloud device
    // backup, which would put personal data at rest in the cloud — the exact
    // thing ARC forbids. Caches is never backed up. It is also purgeable under
    // storage pressure, which is fine: every artifact here is regenerated on
    // demand from the DB, and reports carry `data_json` so "Share again"
    // re-renders (see report-file.ts).
    if (request.directory) {
      // Created on demand and idempotently: two taps in the same second cannot
      // race each other into a throw.
      const dir = new fs.Directory(fs.Paths.cache, request.directory);
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    }
    file = request.directory
      ? new fs.File(fs.Paths.cache, request.directory, request.fileName)
      : new fs.File(fs.Paths.cache, request.fileName);
    if (!file.exists) file.create({ intermediates: true });
    file.write(text);
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  const uri = file.uri;

  const share = sharing;
  if (share && typeof share.isAvailableAsync === 'function') {
    try {
      if (await share.isAvailableAsync()) {
        await share.shareAsync(uri, {
          mimeType: request.mimeType,
          UTI: request.uti,
          dialogTitle: request.dialogTitle,
        });
        // Handed off: the share sheet has already copied the bytes to wherever
        // the user chose, so the on-device copy has done its job. Remove it so no
        // plaintext whole-health-data file lingers (it regenerates on demand).
        try {
          file.delete();
        } catch {
          // Best-effort: a failed delete is not a failed share.
        }
        return { status: 'shared', fileName: request.fileName, uri };
      }
    } catch {
      // The file is safely on disk — a share-sheet hiccup must not read as a
      // failed write. Fall through to 'saved'.
    }
  }
  // Share unavailable (expo-sharing rides the next build): keep the file so the
  // user can still retrieve it from the app container. It is in Caches, so it is
  // out of iCloud regardless.
  return { status: 'saved', fileName: request.fileName, uri };
}

/**
 * Offer a file that ALREADY EXISTS to the share sheet — no write, and **no
 * delete afterwards**.
 *
 * Added for the encrypted backup snapshot (docs/backups-subapp.md), which is
 * the one artifact in this module's world that is not regenerated on demand.
 * Everything `writeAndShareFile` handles is a derived document: an export or a
 * report can be rebuilt from the database at any time, so deleting the on-device
 * copy after a successful hand-off costs nothing and keeps plaintext health data
 * from lingering in Caches. The snapshot is the opposite on both counts — it IS
 * the durable copy (`Documents/backups/arc-current.arcb`, deliberately riding the
 * device backup), and it is ciphertext, so there is nothing to keep from
 * lingering. Deleting it after a share would destroy the very thing the feature
 * exists to preserve.
 *
 * Two outcomes, not four: nothing is written here, so `saved` and `failed` have
 * no meaning. Either the sheet took it or the sheet is not in this binary
 * (`expo-sharing` rides the next EAS build) — and a hiccup mid-sheet is reported
 * as `unavailable` rather than as a failure, because the file is untouched
 * either way.
 */
export async function shareExistingFile(
  uri: string,
  opts: { mimeType: string; uti: string; dialogTitle: string }
): Promise<'shared' | 'unavailable'> {
  const share = sharing;
  if (!share || typeof share.isAvailableAsync !== 'function') return 'unavailable';
  try {
    if (!(await share.isAvailableAsync())) return 'unavailable';
    await share.shareAsync(uri, {
      mimeType: opts.mimeType,
      UTI: opts.uti,
      dialogTitle: opts.dialogTitle,
    });
    return 'shared';
  } catch {
    return 'unavailable';
  }
}
