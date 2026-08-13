/**
 * The impure half of data export: write the serialized database to the app's
 * Documents directory and offer it through the iOS share sheet.
 *
 * The write/share/degrade machinery moved to src/lib/files/share-file.ts on
 * 2026-08-12, when Reports needed the identical outcome ledger for an HTML
 * document (docs/reports-subapp.md §4). Read that file for WHY the ledger has
 * four states and why `content` is a thunk; what stays here is everything that
 * is about EXPORT — the serializer call, the filename convention, the JSON
 * type identifiers, and the sheet's title.
 *
 * The public API is unchanged: `exportDataToFile(db, now?)` still returns the
 * same four-state outcome, and `ExportOutcome` is still the name Settings
 * imports.
 */
import Constants from 'expo-constants';

import type { Database } from '@/lib/db/database';
import { writeAndShareFile, type FileOutcome } from '@/lib/files/share-file';
import { buildExport, exportFileName, serializeExport } from './serializer';

/**
 * The outcome ledger, now defined once in src/lib/files/share-file.ts. Kept as
 * an alias rather than replaced at the call sites: `ExportOutcome` is what
 * app/settings.tsx narrows on, and the name says which action it describes.
 */
export type ExportOutcome = FileOutcome;

/**
 * Serialize the whole database and write it to Documents, then try the share
 * sheet. Serialization runs inside the helper's try/catch (it is passed as a
 * thunk), so a serializer throw — the deliberate loud failure `assertScalar`
 * exists to produce — still surfaces as a `failed` outcome with its message
 * rather than as an unhandled rejection.
 */
export async function exportDataToFile(
  db: Database,
  now: Date = new Date()
): Promise<ExportOutcome> {
  const exportedAt = now.toISOString();
  return writeAndShareFile({
    fileName: exportFileName(exportedAt),
    content: () =>
      serializeExport(
        buildExport(db, { exportedAt, appVersion: Constants.expoConfig?.version ?? null })
      ),
    mimeType: 'application/json',
    uti: 'public.json',
    dialogTitle: 'Export ARC data',
  });
}
