/**
 * The file side of the encrypted backup feature, behind one interface.
 *
 * Same shape as src/lib/media/photo-file-store.ts: a guarded `require` of
 * `expo-file-system` resolved lazily (Expo Router eagerly loads every route to
 * build its manifest, so a module-scope throw here would break app STARTUP, not
 * one screen), base names rather than paths, and every method total — no method
 * throws, because a failure to touch one file must never take down a boot-time
 * sweep. Its absence is a `null` store, which the orchestration layer reports as
 * `unavailable`.
 *
 * The seam also exists so `src/lib/backup/snapshot.ts` can be exercised against
 * an in-memory fake in the headless suites, which is the same trade `Database`
 * and `PhotoFileStore` already make in this codebase.
 *
 * ## ⚠️ THIS DIRECTORY DELIBERATELY *RIDES* THE iCLOUD DEVICE BACKUP
 *
 * Do NOT add an `excludeFromBackup(...)` call here, and do not "fix" its absence
 * by analogy with photo-file-store.ts or client.ts. Those exclude their
 * directories because they hold PLAINTEXT — the health record and body imagery —
 * and CLAUDE.md §2 forbids personal data at rest in any cloud. Everything in
 * `Documents/backups/` is XChaCha20-Poly1305 ciphertext under a key that never
 * leaves the Keychain, so the cloud carries an opaque blob and nothing else.
 * That blob riding the device backup IS the durability story: it is what a
 * restored phone finds waiting for it. Excluding this directory would silently
 * turn the entire feature back into "no backup at all".
 *
 * The scratch file used for `VACUUM INTO` is the opposite case — it is a
 * plaintext copy of the database — which is why {@link BackupFileStore.tempVacuumTarget}
 * hands out a path under Caches, a location iOS never backs up, and why the
 * caller deletes it the moment the sealed bytes exist.
 */

/** The backup directory, under Documents. See the header for why it is Documents. */
const BACKUP_DIR = 'backups';

/** Only these are snapshots; a `.tmp` half-write is not (and does not match). */
const SNAPSHOT_EXTENSION = '.arcb';

/** What a listing knows about one snapshot without opening it. */
export type SnapshotInfo = {
  /** Base name including extension, e.g. `arc-current.arcb`. */
  name: string;
  /** Size in bytes; 0 when it could not be read. */
  size: number;
  /** Last modification, epoch MILLISECONDS; 0 when unknown. */
  modifiedAt: number;
};

/**
 * Every method is best-effort and total: nothing here throws, so a caller can
 * treat a `false`/`null` as "it did not happen" without a try/catch of its own.
 */
export type BackupFileStore = {
  /** Whether the backup directory can be reached at all. */
  available(): boolean;
  /** The snapshots currently on disk ([] when the directory does not exist). */
  list(): SnapshotInfo[];
  readBytes(name: string): Uint8Array | null;
  /** Write via `${name}.tmp` then move over the target — never a torn snapshot. */
  writeBytesAtomic(name: string, bytes: Uint8Array): boolean;
  /**
   * Copy one snapshot over another natively (the rotation). Native rather than a
   * JS read-and-rewrite: a snapshot can be tens of MB and rotation runs on the
   * boot path, so the bytes never enter the JS heap.
   */
  copy(from: string, to: string): boolean;
  /** True when the file is gone afterwards — including when it already was. */
  remove(name: string): boolean;
  /** A `file://` URI the share sheet can hand off, or null when there is nothing there. */
  uriFor(name: string): string | null;
  /** A fresh scratch location under Caches for `VACUUM INTO` (plaintext — see header). */
  tempVacuumTarget(): { path: string; uri: string } | null;
  readBytesAtUri(uri: string): Uint8Array | null;
  removeAtUri(uri: string): boolean;
};

/** The slice of expo-file-system's File/Directory API this module uses. */
type FileInfoSlice = { exists: boolean; size?: number; modificationTime?: number };
type FileHandle = {
  uri: string;
  exists: boolean;
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
  /** A `Uint8Array` is written as raw bytes; the `encoding` option only shapes strings. */
  write(content: Uint8Array): void;
  bytesSync(): Uint8Array;
  info(): FileInfoSlice;
  moveSync(destination: unknown, options?: { overwrite?: boolean }): void;
  copySync(destination: unknown, options?: { overwrite?: boolean }): void;
  delete(): void;
};
type DirectoryHandle = {
  uri: string;
  exists: boolean;
  create(options?: { intermediates?: boolean; idempotent?: boolean }): void;
  list(): { name: string }[];
};
type FileSystemModule = {
  // `document` rides the device backup (deliberate, see header); `cache` never
  // does, which is why the plaintext VACUUM scratch file goes there.
  Paths: { document: unknown; cache: unknown };
  File: new (...parts: unknown[]) => FileHandle;
  Directory: new (...parts: unknown[]) => DirectoryHandle;
};

/**
 * The module, or null on a runtime without it (the web logic-check preview, the
 * headless suites). Resolved lazily and never at import time — see the header.
 */
function loadFileSystem(): FileSystemModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-file-system') as Partial<FileSystemModule>;
    if (typeof mod.File !== 'function' || typeof mod.Directory !== 'function' || !mod.Paths) {
      return null;
    }
    return mod as FileSystemModule;
  } catch {
    return null;
  }
}

/**
 * Normalize a filesystem timestamp to epoch milliseconds.
 *
 * `expo-file-system` documents `modificationTime` in milliseconds, but the same
 * field has historically been handed back in SECONDS by the iOS side of the
 * legacy API, and the throttle in snapshot.ts compares it against `Date.now()` —
 * reading seconds as milliseconds would date every snapshot to 1970 and back up
 * on every single foreground. Anything below the threshold cannot be a plausible
 * millisecond timestamp (it would predate 1973), so it is read as seconds.
 */
function toMillis(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
}

/**
 * The plain filesystem path behind a `file://` URI.
 *
 * SQLite's `VACUUM INTO` takes a PATH, not a URI, and the URI is
 * percent-encoded — an app container directory containing a space or any other
 * reserved character would otherwise produce a path SQLite cannot create.
 */
function pathFromUri(uri: string): string {
  const bare = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  try {
    return decodeURIComponent(bare);
  } catch {
    // Malformed escapes: the raw form is still likelier to work than nothing.
    return bare;
  }
}

/**
 * A collision-free scratch name (the photo-file-store convention).
 *
 * `Math.random` is correct HERE and nowhere else in this feature: this is a
 * temporary file name, not key material — nothing is protected by its
 * unpredictability, and the file is deleted seconds later. Key bytes come from
 * SQLite's `randomblob` through the injected `random` seam; never from this.
 */
function scratchName(): string {
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `arc-vacuum-${Date.now().toString(36)}-${rand()}.db`;
}

/**
 * The backup store, or null when `expo-file-system` is not reachable.
 *
 * The directory is created on demand rather than at boot, so an install that
 * has never taken a backup carries no empty folder.
 */
export function nativeBackupStore(): BackupFileStore | null {
  const fs = loadFileSystem();
  if (!fs) return null;

  const dir = (): DirectoryHandle => new fs.Directory(fs.Paths.document, BACKUP_DIR);
  const file = (name: string): FileHandle => new fs.File(fs.Paths.document, BACKUP_DIR, name);

  const ensureDir = (): void => {
    const d = dir();
    if (!d.exists) d.create({ intermediates: true, idempotent: true });
    // NO excludeFromBackup here — that is the entire point of this module. See
    // the file header before you are tempted to add one.
  };

  const statOf = (name: string): SnapshotInfo => {
    try {
      const info = file(name).info();
      return { name, size: info.size ?? 0, modifiedAt: toMillis(info.modificationTime) };
    } catch {
      // A snapshot we cannot stat is still a snapshot: report it with zeroes
      // rather than hiding it from the list (and from the user's restore).
      return { name, size: 0, modifiedAt: 0 };
    }
  };

  return {
    available() {
      try {
        // Constructing the handle exercises the path validation; the directory
        // itself stays lazily created.
        return typeof dir().uri === 'string';
      } catch {
        return false;
      }
    },

    list() {
      try {
        const d = dir();
        if (!d.exists) return [];
        return d
          .list()
          .map((entry) => entry.name)
          .filter((name) => typeof name === 'string' && name.endsWith(SNAPSHOT_EXTENSION))
          .map(statOf);
      } catch {
        return [];
      }
    },

    readBytes(name) {
      try {
        const f = file(name);
        if (!f.exists) return null;
        return f.bytesSync();
      } catch {
        return null;
      }
    },

    writeBytesAtomic(name, bytes) {
      // A snapshot is only useful if it is whole. Writing straight over the
      // current one would leave a truncated, unopenable file if the app were
      // killed mid-write — and it would have destroyed the good copy to do it.
      // So: write beside it, then move over the target. HONESTY NOTE: iOS's
      // move-with-overwrite is itself remove-then-move, not an atomic rename, so
      // the destination is briefly absent even on the happy path. The window is
      // milliseconds, no partial file can ever exist at the target name, and the
      // rotation copy the caller takes first is the real safety net.
      //
      // The scratch handle is tracked in a variable so a failure anywhere below
      // can clean up after itself — a stray `.tmp` occupies as much space as the
      // whole database.
      let scratch: FileHandle | null = null;
      try {
        ensureDir();
        const tmp = file(`${name}.tmp`);
        // A leftover from a previous kill is stale by definition.
        if (tmp.exists) tmp.delete();
        tmp.create({ intermediates: true, overwrite: true });
        tmp.write(bytes);
        scratch = tmp;

        const target = file(name);
        try {
          tmp.moveSync(target, { overwrite: true });
        } catch {
          // Older native sides refuse an occupied destination outright. The
          // fallback must not DESTROY the occupant to make room — if the retry
          // move also failed, that would end with no snapshot at this name at
          // all. So the occupant is renamed ASIDE, restored if the move fails,
          // and only deleted once the new file is confirmed in place.
          const aside = file(`${name}.old`);
          if (target.exists) {
            if (aside.exists) aside.delete();
            target.moveSync(aside);
          }
          try {
            tmp.moveSync(file(name));
          } catch (moveError) {
            // Put the previous snapshot back where it was; the write failed but
            // nothing was lost.
            if (aside.exists) aside.moveSync(file(name));
            throw moveError;
          }
          if (aside.exists) aside.delete();
        }
        // The move consumed the scratch file (and `tmp.uri` now points at the
        // target), so there is nothing left to clean up — and clearing this
        // BEFORE the final check is what stops the cleanup below from deleting
        // the snapshot we just wrote.
        scratch = null;
        return file(name).exists;
      } catch {
        try {
          if (scratch && scratch.exists) scratch.delete();
        } catch {
          // Best-effort; a stray scratch file is not a failed backup's fault.
        }
        return false;
      }
    },

    copy(from, to) {
      try {
        const source = file(from);
        if (!source.exists) return false;
        try {
          source.copySync(file(to), { overwrite: true });
        } catch {
          // Same aside-not-delete shape as the atomic write: never destroy the
          // destination before its replacement is confirmed.
          const aside = file(`${to}.old`);
          const target = file(to);
          if (target.exists) {
            if (aside.exists) aside.delete();
            target.moveSync(aside);
          }
          try {
            source.copySync(file(to));
          } catch (copyError) {
            if (aside.exists) aside.moveSync(file(to));
            throw copyError;
          }
          if (aside.exists) aside.delete();
        }
        return file(to).exists;
      } catch {
        return false;
      }
    },

    remove(name) {
      try {
        const f = file(name);
        if (!f.exists) return true;
        f.delete();
        return true;
      } catch {
        return false;
      }
    },

    uriFor(name) {
      try {
        const f = file(name);
        // Null when there is nothing there: handing the share sheet a URI for a
        // file that does not exist fails opaquely, while a null lets the UI
        // disable the affordance up front.
        if (!f.exists) return null;
        return f.uri;
      } catch {
        return null;
      }
    },

    tempVacuumTarget() {
      try {
        const f = new fs.File(fs.Paths.cache, scratchName());
        // `VACUUM INTO` refuses to write over an existing file. The name is
        // unique by construction, but a clash costs nothing to rule out.
        if (f.exists) f.delete();
        const uri = f.uri;
        return { path: pathFromUri(uri), uri };
      } catch {
        return null;
      }
    },

    readBytesAtUri(uri) {
      try {
        const f = new fs.File(uri);
        if (!f.exists) return null;
        return f.bytesSync();
      } catch {
        return null;
      }
    },

    removeAtUri(uri) {
      try {
        const f = new fs.File(uri);
        if (!f.exists) return true;
        f.delete();
        return true;
      } catch {
        return false;
      }
    },
  };
}
