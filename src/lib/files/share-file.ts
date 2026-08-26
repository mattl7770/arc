/**
 * Write a text document to the app's Documents directory and offer it through
 * the iOS share sheet — the one definition of that outcome ledger.
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
 *   - `expo-sharing` degrades the same way: on a binary predating it — every
 *     build before the owner's 2026-08-25 EAS build — the file is still
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
};
type DirectoryHandle = {
  exists: boolean;
  create(options?: { intermediates?: boolean; idempotent?: boolean }): void;
};
type FileSystemModule = {
  Paths: { document: unknown };
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
  /** Written to Documents; share sheet unavailable (no `expo-sharing` module —
   * web/node, or a build predating it). */
  | { status: 'saved'; fileName: string; uri: string }
  /** No file system module at all (web preview) — nothing was written. */
  | { status: 'unavailable' }
  /** Producing or writing the file failed; message is for the user-facing alert. */
  | { status: 'failed'; message: string };

export type ShareFileRequest = {
  /** Base name including extension: `arc-export-20260812-143308.json`. */
  fileName: string;
  /**
   * A directory under Documents, or omitted to write at the top level. Export
   * writes flat (it has since it shipped, and its files are occasional);
   * Reports uses `reports/` so a year of documents does not scatter through the
   * container root.
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

  let uri: string;
  try {
    const text = request.content();
    if (request.directory) {
      // Created on demand and idempotently: a user who never generates a report
      // never gets an empty folder in their backup, and two taps in the same
      // second cannot race each other into a throw.
      const dir = new fs.Directory(fs.Paths.document, request.directory);
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    }
    const file = request.directory
      ? new fs.File(fs.Paths.document, request.directory, request.fileName)
      : new fs.File(fs.Paths.document, request.fileName);
    if (!file.exists) file.create({ intermediates: true });
    file.write(text);
    uri = file.uri;
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }

  const share = sharing;
  if (share && typeof share.isAvailableAsync === 'function') {
    try {
      if (await share.isAvailableAsync()) {
        await share.shareAsync(uri, {
          mimeType: request.mimeType,
          UTI: request.uti,
          dialogTitle: request.dialogTitle,
        });
        return { status: 'shared', fileName: request.fileName, uri };
      }
    } catch {
      // The file is safely on disk — a share-sheet hiccup must not read as a
      // failed write. Fall through to 'saved'.
    }
  }
  return { status: 'saved', fileName: request.fileName, uri };
}
