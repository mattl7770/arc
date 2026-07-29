/**
 * The impure half of data export: write the serialized database to the app's
 * Documents directory and offer it through the iOS share sheet.
 *
 * Fully offline — the file never leaves the device unless the user picks a
 * share target themselves. Both native modules are required in try/catch
 * (the api-key-store pattern) and degrade honestly:
 *
 *  - `expo-file-system` ships inside the current dev build (it's a dependency
 *    of the `expo` package), so writing works today; if it's somehow absent
 *    (web logic-check preview), the outcome is 'unavailable'.
 *  - `expo-sharing` is NOT in the current build — it rides the next EAS build.
 *    Until then the file is still written and the outcome is 'saved' with the
 *    full path, so the export is usable (Finder/Xcode container download)
 *    rather than silently unshareable.
 */
import Constants from 'expo-constants';

import type { Database } from '@/lib/db/database';
import { buildExport, exportFileName, serializeExport } from './serializer';

/** The slice of expo-file-system's File API this module uses. */
type FileHandle = {
  uri: string;
  exists: boolean;
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
  write(content: string): void;
};
type FileSystemModule = {
  Paths: { document: unknown };
  File: new (...parts: unknown[]) => FileHandle;
};

let fileSystem: FileSystemModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  fileSystem = require('expo-file-system') as FileSystemModule;
} catch {
  fileSystem = null;
}

/** The slice of expo-sharing this module uses. */
type SharingModule = {
  isAvailableAsync(): Promise<boolean>;
  shareAsync(
    url: string,
    options?: { mimeType?: string; UTI?: string; dialogTitle?: string }
  ): Promise<void>;
};

let sharing: SharingModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sharing = require('expo-sharing') as SharingModule;
} catch {
  sharing = null;
}

export type ExportOutcome =
  /** Written AND handed to the share sheet. */
  | { status: 'shared'; fileName: string; uri: string }
  /** Written to Documents; share sheet unavailable until the next build. */
  | { status: 'saved'; fileName: string; uri: string }
  /** No file system module at all (web preview) — nothing was written. */
  | { status: 'unavailable' }
  /** The write itself failed; message is for the user-facing alert. */
  | { status: 'failed'; message: string };

/**
 * Serialize the whole database and write it to Documents, then try the share
 * sheet. The serialize+write is synchronous (op-sqlite and the new
 * expo-file-system API both are); only the share step awaits.
 */
export async function exportDataToFile(
  db: Database,
  now: Date = new Date()
): Promise<ExportOutcome> {
  const fs = fileSystem;
  if (!fs || typeof fs.File !== 'function') return { status: 'unavailable' };

  const exportedAt = now.toISOString();
  const fileName = exportFileName(exportedAt);

  let uri: string;
  try {
    const json = serializeExport(
      buildExport(db, { exportedAt, appVersion: Constants.expoConfig?.version ?? null })
    );
    const file = new fs.File(fs.Paths.document, fileName);
    if (!file.exists) file.create({ intermediates: true });
    file.write(json);
    uri = file.uri;
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }

  const share = sharing;
  if (share && typeof share.isAvailableAsync === 'function') {
    try {
      if (await share.isAvailableAsync()) {
        await share.shareAsync(uri, {
          mimeType: 'application/json',
          UTI: 'public.json',
          dialogTitle: 'Export ARC data',
        });
        return { status: 'shared', fileName, uri };
      }
    } catch {
      // The file is safely on disk — a share-sheet hiccup must not read as a
      // failed export. Fall through to 'saved'.
    }
  }
  return { status: 'saved', fileName, uri };
}
