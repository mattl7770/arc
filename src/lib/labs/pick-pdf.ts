/**
 * Picking a lab PDF off the device and reading it as base64.
 *
 * Both halves come from `expo-file-system` — `File.pickFileAsync` opens the iOS
 * document picker and `file.base64()` reads the bytes. That is deliberately ONE
 * module rather than the two this would have taken (`expo-document-picker` to
 * pick, `expo-file-system` to read): expo-file-system is a dependency of `expo`
 * itself, so it is already autolinked into the existing dev build and this path
 * needs **no new native module and no extra EAS rebuild**.
 *
 * It is still a native module, so it is reached through a guarded require —
 * the same pattern as api-key-store and the estimator's streaming fetch. On the
 * web logic-check preview, and in the headless tests that import this module's
 * siblings, the require simply fails and {@link isPdfPickerAvailable} reports
 * false so the UI can say so plainly instead of crashing.
 *
 * The picker returns a temporary COPY on iOS, so `uri` points at a cache file.
 * That is what gets stored in `lab_reports.file_path`, and it is exactly as
 * durable as the cache — see the note on {@link PickedPdf.uri}.
 */

export type PickedPdf = {
  /** The file's bytes, base64-encoded, ready for a `document` content block. */
  base64: string;
  /**
   * Where the picked file lives. iOS hands back a temporary copy in the app's
   * cache, which the OS may reclaim — so this is a best-effort provenance
   * pointer, not a guaranteed-resolvable path. Phase 4 (media + iCloud backup)
   * is where the original earns a durable home; until then the raw extraction
   * in `lab_reports.raw_extracted_json` is the reliable record.
   */
  uri: string;
  name: string;
  sizeBytes: number;
};

/** Thrown when the native picker isn't reachable in this build. */
export class PdfPickerUnavailableError extends Error {
  constructor() {
    super('Picking a file needs a native build — this preview can’t open the file picker.');
    this.name = 'PdfPickerUnavailableError';
  }
}

/** The slice of expo-file-system's `File` this module uses. */
type PickedFile = {
  uri: string;
  name: string;
  size: number;
  base64(): Promise<string>;
};
type FileStatic = {
  pickFileAsync(options: {
    mimeTypes?: string | string[];
  }): Promise<{ canceled: false; result: PickedFile } | { canceled: true; result: null }>;
};

function loadFileApi(): FileStatic | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-file-system') as { File?: unknown };
    const File = mod.File as FileStatic | undefined;
    return File && typeof File.pickFileAsync === 'function' ? File : null;
  } catch {
    return null;
  }
}

/** Whether the document picker can be opened in this build. */
export function isPdfPickerAvailable(): boolean {
  return loadFileApi() !== null;
}

/**
 * Open the system picker for a PDF and read it. Resolves to null when the user
 * cancels — a cancel is not an error and must not surface as one. Throws
 * {@link PdfPickerUnavailableError} when the native module isn't present.
 */
export async function pickLabPdf(): Promise<PickedPdf | null> {
  const File = loadFileApi();
  if (!File) throw new PdfPickerUnavailableError();

  const picked = await File.pickFileAsync({ mimeTypes: 'application/pdf' });
  if (picked.canceled || picked.result === null) return null;

  const file = picked.result;
  return {
    base64: await file.base64(),
    uri: file.uri,
    name: file.name,
    sizeBytes: file.size,
  };
}
