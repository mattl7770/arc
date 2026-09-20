import ExpoModulesCore
import Foundation

/**
 ARC's one native module: mark a file or directory as excluded from the
 iCloud / iTunes device backup.

 Why it exists: `arc.db` is the entire health record and the photo directories
 are body imagery, and both live in locations iOS replicates to iCloud by
 default. CLAUDE.md §2 forbids personal data sitting at rest in any cloud, and
 the 2026-08-23 ADR ("At-rest data must not ride the iCloud backup") settled the
 remedy: `NSURLIsExcludedFromBackupKey`, which no JavaScript API in this stack
 exposes — not `expo-file-system`, not `op-sqlite`. Hence these few lines.

 The deliberate counter-case is `Documents/backups/`: the ARCB1 sealed snapshots
 *want* the device backup, because ciphertext in the cloud is how a restored
 phone finds its data. Nothing here is ever called on that directory — see the
 header of `src/lib/backup/backup-file-store.ts`.

 The JS seam is `src/lib/files/backup-exclusion.ts`; the module name below is
 the string it passes to `requireOptionalNativeModule`, so the two must stay
 identical (a headless assertion in `db/backup.test.mjs` pins that).
 */
public class ArcBackupModule: Module {
  public func definition() -> ModuleDefinition {
    // Must equal the name in requireOptionalNativeModule('ArcBackup').
    Name("ArcBackup")

    // Synchronous on purpose: the callers run while opening the database and
    // while creating a photo directory, and a promise would let the first
    // unexcluded write land before the flag did.
    Function("excludeFromBackup") { (pathOrUri: String) -> Bool in
      return arcExcludeFromBackup(pathOrUri)
    }
  }
}

/**
 Best-effort and total: every failure returns `false` rather than throwing. A
 missed exclusion is a privacy problem to fix; an error raised across the bridge
 would take down app boot or a photo write, which is worse and helps no one.
 */
private func arcExcludeFromBackup(_ pathOrUri: String) -> Bool {
  do {
    // The callers hand over two different shapes — op-sqlite's `getDbPath()` is
    // a plain path, expo-file-system's `.uri` is a `file://` URL — so normalize
    // here rather than making every call site care. `URL(string:)` is the one
    // that percent-decodes, which is what a directory with a space in its name
    // depends on.
    var url: URL
    if pathOrUri.hasPrefix("file://") {
      guard let parsed = URL(string: pathOrUri) else { return false }
      url = parsed
    } else {
      url = URL(fileURLWithPath: pathOrUri)
    }

    // A missing file is normal here, not an error: the `-wal`/`-shm` sidecars
    // often do not exist yet at the moment getDb() asks. Setting the flag on a
    // path with nothing behind it throws, so answer honestly instead.
    guard FileManager.default.fileExists(atPath: url.path) else { return false }

    // Works on a directory as well as a file — the photo stores pass their
    // directory, and the flag covers everything written inside it.
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
    return true
  } catch {
    return false
  }
}
