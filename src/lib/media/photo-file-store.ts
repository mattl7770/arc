/**
 * The file side of every stored image, behind one interface.
 *
 * Lifted out of src/lib/media/meal-photo-store.ts on 2026-08-12, when recipes
 * gained a picture too (0034). The two features share nothing but this: a
 * directory under the app's Documents folder, base names rather than paths, and
 * a store whose every method is total. Their POLICIES differ completely — a
 * meal photo expires after a week, a recipe photo never does — and those live
 * with their own feature.
 *
 * ## Why an interface at all
 *
 * Not indirection for its own sake: the reconciliation passes are the part of
 * an image feature most likely to be wrong (two stores, an ordering that
 * matters) and the part least testable on a device. Behind this seam they run
 * against an in-memory fake with the REAL database underneath, which is the
 * same trade `MigrationExecutor` and `Database` already make in this codebase.
 *
 * ## Native modules, guarded
 *
 * `expo-file-system` ships inside the current binary (it is a dependency of the
 * `expo` package itself) — but it is still native, and the modules built on
 * this one are imported by route files. Expo Router eagerly loads every route
 * to build its manifest, so a module-scope throw here would break app STARTUP
 * rather than one screen. Hence the require lives in a function, in a try/catch,
 * and its absence is a `null` store that every caller already handles: no photo
 * is written, no photo is shown, and nothing crashes. That is also what lets
 * the headless suites import these files.
 */

/**
 * Every method is best-effort and total: no method throws, because a failure to
 * touch one file must never take down an app-open sweep.
 */
export type PhotoFileStore = {
  /** Base names currently in the photo directory ([] when it does not exist). */
  list(): string[];
  exists(name: string): boolean;
  /** True when the file is gone afterwards — including when it was already. */
  remove(name: string): boolean;
  /** Write a base64 JPEG under `name`; false if nothing landed. */
  write(name: string, base64Jpeg: string): boolean;
  /** A `file://` URI an `<Image>` can load, or null. */
  uri(name: string): string | null;
};

/** The slice of expo-file-system's File/Directory API these modules use. */
type FileHandle = {
  uri: string;
  exists: boolean;
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
  write(content: string, options?: { encoding?: 'utf8' | 'base64' }): void;
  delete(): void;
};
type DirectoryHandle = {
  uri: string;
  exists: boolean;
  name: string;
  create(options?: { intermediates?: boolean; idempotent?: boolean }): void;
  list(): { name: string }[];
};
type FileSystemModule = {
  Paths: { document: unknown };
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
 * A store over one directory under Documents, or null when
 * `expo-file-system` is not reachable.
 *
 * The directory is created on demand rather than at boot: a user who never
 * photographs anything never gets an empty folder in their backup, and a create
 * that races itself is idempotent.
 */
export function nativeStoreIn(directory: string): PhotoFileStore | null {
  const fs = loadFileSystem();
  if (!fs) return null;

  const dir = (): DirectoryHandle => new fs.Directory(fs.Paths.document, directory);
  const file = (name: string): FileHandle => new fs.File(fs.Paths.document, directory, name);

  return {
    list() {
      try {
        const d = dir();
        if (!d.exists) return [];
        // Entries are File | Directory; ours only ever hold .jpg files, and
        // filtering on that keeps a stray subdirectory out of the orphan pass
        // (which would try to delete it as a file and fail every launch).
        return d
          .list()
          .map((entry) => entry.name)
          .filter((name) => typeof name === 'string' && name.endsWith('.jpg'));
      } catch {
        return [];
      }
    },
    exists(name) {
      try {
        return file(name).exists;
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
    write(name, base64Jpeg) {
      try {
        const d = dir();
        if (!d.exists) d.create({ intermediates: true, idempotent: true });
        const f = file(name);
        if (!f.exists) f.create({ intermediates: true });
        // `encoding: 'base64'` writes the DECODED bytes; without it the base64
        // text itself lands on disk and every reader gets a corrupt JPEG.
        f.write(base64Jpeg, { encoding: 'base64' });
        return f.exists;
      } catch {
        return false;
      }
    },
    uri(name) {
      try {
        return file(name).uri;
      } catch {
        return null;
      }
    },
  };
}

/**
 * A name for a new photo file.
 *
 * Deliberately NOT `newId(db)`: that one is minted by SQLite's `randomblob`
 * (src/lib/db/id.ts — Hermes has no `crypto` global) and it is a ROW's id. This
 * only has to be a collision-free base name, and the schema's uniqueness
 * constraints are what make that enforceable rather than hoped for: a collision
 * fails the insert, the write is undone, and nothing is silently overwritten.
 */
export function photoFileName(): string {
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand()}${rand()}.jpg`;
}
