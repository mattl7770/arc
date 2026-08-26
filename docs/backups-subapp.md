# Backups sub-app — the ARCB1 encrypted snapshot

**Spec date:** 2026-08-25 · **Status:** built in the same window · **Migration:** none
**Read first:** CLAUDE.md §2 (nothing personal at rest in any cloud) and §3 (Backup bullet),
and the 2026-08-25 ADR in `docs/decisions.md`, which is where the *reasoning* lives. This file
is the mechanical spec: the container format, the flows, and where the code is.

The one-sentence version: ARC writes an **encrypted** snapshot of its SQLite file to
`Documents/backups/`, which **deliberately stays inside the iCloud/Finder device backup** — so
durability comes back without plaintext ever reaching a cloud. The key rides the Keychain
(and, once, the user's eyes, as a recovery code).

---

## 1. What is backed up, and what is not

| | In v1 | Why |
| --- | --- | --- |
| `arc.db` (the whole record) | ✅ | One `VACUUM INTO` file is the entire ARC record — labs, logs, protocols, meals, workouts, knowledge, Coach memory. |
| `-wal` / `-shm` | ✅, implicitly | `VACUUM INTO` writes a **consistent, checkpointed** copy of the live DB. The sidecars are never copied because they are never needed. |
| Progress / meal / recipe photos | ❌ (deliberate) | See §7. |
| The API key | ❌ (deliberate) | It is `WHEN_UNLOCKED_THIS_DEVICE_ONLY` by the 2026-08-23 ADR and stays that way — a restored phone re-enters it. |

## 2. The container format — ARCB1 (normative)

```
bytes 0..4    magic = ASCII "ARCB1"
bytes 5..8    headerLen : u32 big-endian
next          header    : ASCII JSON, exactly headerLen bytes
next          ciphertext chunk 0, chunk 1, …   (each = 4 MiB plain + 16-byte Poly1305 tag)
```

Header, all fields required, serialized by `JSON.stringify` over an object with **exactly these
keys in this order** — the byte string produced is load-bearing (§2.1):

```json
{"v":1,"createdAt":"<ISO>","salt":"<32 hex chars>","chunkSize":4194304,
 "totalChunks":N,"plainSize":M,"userVersion":V}
```

- `fileKey = hkdf(sha256, masterKey(32B), saltBytes(16B), ascii('arc-backup-v1'), 32)` — a
  fresh 16-byte salt per snapshot, so two snapshots under one master key never share a key
  stream even though the nonce scheme is deterministic.
- `nonce(i)` (24 bytes) = `saltBytes(16) || u64BE(i)`. XChaCha20's 192-bit nonce is what makes
  this safe to construct rather than random: the salt half is unique per file, the counter half
  unique per chunk, so (key, nonce) never repeats.
- `chunkSize` is 4 MiB; the last chunk is the remainder. `plainSize === 0` is invalid and throws
  — an empty DB is a bug, not a backup.

### 2.1 The header is the AAD

The exact header bytes are passed as additional authenticated data for **every** chunk. That is
what binds `totalChunks` and `plainSize` into each tag, so truncating the file, appending a
chunk, or editing a single digit of the header fails authentication rather than producing a
short-but-plausible database. The reader additionally verifies, cheaply and before any crypto:
`headerLen ≤ 4096`, salt exactly 16 bytes, reconstructed length `=== plainSize`, ciphertext
consumed **exactly** (no trailing bytes).

### 2.2 Failure taxonomy

`BackupFormatError` carries a `reason`, because the UI has to say different things:

| reason | Means | UI |
| --- | --- | --- |
| `bad-magic` | Not an ARC backup at all | "Not an ARC backup file" |
| `bad-header` | Header unparseable / out of bounds | Corrupt |
| `truncated` | File ends mid-chunk, or short of `plainSize` | Corrupt |
| `wrong-key-or-corrupt` | A Poly1305 tag did not verify | **Offer the recovery code** — this is the one recoverable failure |

The last row is the important one: AEAD cannot distinguish "wrong key" from "flipped bit", so
the honest label covers both and the UI's response is to ask for the recovery code rather than
to declare the file dead.

## 3. The key

One 32-byte master key, Keychain item **`arc.backup.key`**, stored as 64 lowercase hex chars.

**It is stored with DEFAULT accessibility (`WHEN_UNLOCKED`), NOT `*_THIS_DEVICE_ONLY`** — the
deliberate opposite of the API key, and the only Keychain item in ARC where that is correct. A
`THIS_DEVICE_ONLY` item does not migrate through an encrypted device backup, which would mean a
restored phone carries its own snapshot and cannot open it. See the ADR for the full argument;
`src/lib/backup/key.ts` carries it as a loud comment at the store site, because it looks like
the bug the 2026-08-23 ADR fixed and will be "corrected" by someone otherwise.

**A key that cannot be persisted is never minted.** `ensureBackupKey` returns `null` rather than
handing back a memory-only key: a snapshot encrypted under a key that dies with the process is
strictly worse than no snapshot, because it looks like protection. In Node (the headless suite)
and in any build without `expo-secure-store`, that is the state — `isBackupKeyPersistent()`
reports it and the Settings screen says so.

**Entropy** comes from SQLite's `randomblob` (`dbRandomBytes`), the same source as ARC's row ids
(`src/lib/db/id.ts`), for the same reason: Hermes has no `crypto` global. SQLite's PRNG is
ChaCha20 seeded from OS entropy, which is a real CSPRNG and not `Math.random`. It is not a
hardware RNG behind a formally-audited interface either, and that is a bar the owner explicitly
did not set. `Math.random` is never used for key material anywhere in this feature.

## 4. The recovery code

`formatRecoveryCode(key)` renders the 32 bytes as **Crockford base32**, in groups of four,
plus a final 4-character group carrying the **first 20 bits of `sha256(key)`** as a checksum.
`parseRecoveryCode` is deliberately tolerant — case-insensitive, ignores spaces and hyphens,
maps Crockford's ambiguity set (`I`,`L` → `1`, `O` → `0`) — and returns `null` on any length or
checksum failure. The checksum exists so a mistyped code is rejected *as a typo* instead of
decrypting to garbage and reporting `wrong-key-or-corrupt`.

It is shown reveal-on-tap in Settings › Backups, never printed at boot, never logged. It is the
whole key in human-transcribable form, which is exactly as sensitive as it sounds, and the
screen says so in one line above it.

## 5. Flows

### Back up (automatic + manual)

`createBackup` is the body of both, guarded by ONE module-level in-flight flag (a manual tap and
the boot/foreground pass must never collide on the same scratch file). It deliberately does
**not** read the "Automatic backups" preference — that is a *schedule* control, honoured only by
`autoBackupIfDue`; a hand-pressed button is intent that outranks a schedule (2026-08-25 review).

1. Store reachable? (`nativeBackupStore()`) → `'unavailable'` when the native file seam is absent.
2. `ensureBackupKey(random, allowMint)` → `'no-key'` when it cannot be persisted (§3) — **and
   minting is only allowed when the backups directory is empty.** A snapshot on disk with no key
   in the Keychain is the post-disaster state (a restore that did not carry the Keychain); sealing
   the empty database under a fresh key there would rotate the only real record toward
   destruction. Backups pause, and the UI names the way forward.
3. `VACUUM INTO` a unique path in `Paths.cache` — a consistent copy without holding a write lock
   over the whole file, and in Caches because Caches is never in the device backup, so the
   **plaintext** intermediate never rides one.
4. Read those bytes, `sealBackupAsync(...)` (a macrotask yield between 4 MiB chunks — this runs on
   the boot path) with `createdAt = now` and `userVersion` from `PRAGMA user_version`.
5. **Rotate:** `arc-current.arcb` → `arc-previous.arcb` via a NATIVE copy (`store.copy`, the bytes
   never enter the JS heap). A failed rotation **aborts the backup with both generations intact**
   — collapsing two generations to one while reporting `done` is the failure the second slot
   exists to prevent. Two generations, because the failure this guards against — a corrupt or
   half-written current — is exactly the one a single slot cannot survive.
6. `writeBytesAtomic` the new current (`.tmp` then `moveSync` over the target; an occupied
   destination is renamed aside, never deleted, until the new file is confirmed), delete the
   plaintext temp — success *and* failure paths.

`autoBackupIfDue(db)` wraps that: skip when the toggle
(`users.preferences.backup.enabled`, **default ON** — a safety net that requires ceremony to
switch on is not a safety net) is off, when the store is unavailable, or when the current
snapshot is **< 24 h old**; failures `console.warn` and are otherwise silent, because a
background safety net must never interrupt the day.

Called from `app/_layout.tsx`: deferred a few seconds past boot (first paint owns the JS
thread), immediate on the app-foreground listener.

### Restore

1. Store reachable? → `'unavailable'` — distinct from `'no-snapshot'`, which is a factual claim
   about the user's data that a missing native module must never make.
2. Read `arc-current.arcb` or `arc-previous.arcb` (both are offered — a generation that cannot be
   selected does not exist) → `'no-snapshot'`.
3. `await hydrateBackupKey()`, then `getBackupKey()` → `'no-key'`. Hydrated here, not trusted to
   the screen's mount effect: a tap that beats the boot-time Keychain read must not report a
   false `no-key` and steer the user into the recovery-code flow.
4. `openBackup` → `'bad-key'` on `wrong-key-or-corrupt`, which is where the UI offers
   recovery-code entry — **session-first**: `parseRecoveryCode` → `adoptRecoveryKey` (mirror
   only) → retry **once** → `persistAdoptedKey` *only on success* (an unproven code must never
   overwrite the stored key; its checksum proves it is *a* key, not *this install's* key). A
   failed retry puts the displaced session key back (`restoreSessionKey`).
5. `header.userVersion` above this build's migration head → `'newer-schema'`, refused outright:
   the forward-only runner would install it silently and never migrate it.
6. **Verify the plaintext begins with ASCII `SQLite format 3\0`.** A tag that verified proves the
   bytes are ours and unmodified; it does not prove they are a database. Cheap, and the last
   point at which a wrong file can be refused before it replaces the real one.
7. `replaceDatabaseFile(bytes)` (`src/lib/db/client.ts`): write the bytes IN FULL to
   `arc.db.restoring` first — every failure before the final move leaves the live database
   untouched — then close the cached raw op-sqlite handle, delete `-wal`/`-shm` (an old WAL must
   never replay over the restored file), `moveSync` the scratch over `arc.db`, and **re-apply the
   backup-exclusion xattr immediately** (the move mints a new inode; waiting for the next
   `getDb()` would let the restored plaintext ride an overnight iCloud backup). On any throw it
   returns `'failed'` and attempts nothing clever — the pre-migrate `.bak` philosophy: never
   brick. Every stale `Database` wrapper still held by a mounted screen fails from then on with
   one readable sentence — "ARC's database was restored — close and reopen ARC to finish."
6. **The UI then tells the user to close and reopen ARC**, and that instruction is persistent,
   not a toast. Every live hook, query cache and open statement in the process still refers to
   the old database; a relaunch is the honest way to get a consistent app, and pretending
   otherwise would be a subtle-corruption bug rather than a UX shortcut.

**An older snapshot restoring onto a newer binary is fine and is not a special case.** The next
`getDb()` runs `pendingMigrations` forward from the snapshot's `user_version`. That is precisely
the runner's job, and `header.userVersion` is recorded so the UI can say what it is opening.

### The virgin device

Restore the iPhone from its iCloud/Finder backup. That backup carries **the ciphertext snapshot**
(it lives in Documents, which is backed up) and, because the key is not device-bound, **the
Keychain item** too. Open ARC — the database is empty, because `arc.db` is excluded from the
device backup and always will be — then Settings › Backups → Restore, then relaunch. If the
Keychain item did not come across (an unencrypted backup, a different restore path), the
recovery code is the way in.

## 6. Files

```
src/lib/backup/
  format.ts             ← PURE: sealBackup / openBackup / peekBackupHeader, ARCB1, ASCII + u32/u64 codecs
  recovery-code.ts      ← PURE: Crockford base32 + 20-bit checksum, tolerant parse
  key.ts                ← guarded require of expo-secure-store; mirror + serialized persist queue
  backup-file-store.ts  ← guarded require of expo-file-system; Documents/backups, atomic write, cache temp
  snapshot.ts           ← orchestration: createBackup / autoBackupIfDue / restoreFromSnapshot / lastBackupInfo
src/lib/db/client.ts    ← + replaceDatabaseFile(bytes)
src/lib/db/repositories/user.ts
                        ← + isBackupEnabled / setBackupEnabled  (preferences blob, default ON)
src/lib/files/share-file.ts
                        ← + shareExistingFile(uri, …)  — shares WITHOUT deleting afterwards
app/settings-backups.tsx ← the screen; app/settings.tsx gains the row; app/_layout.tsx the two calls
db/backup.test.mjs      ← headless suite (npm run db:test)
```

**`backup-file-store.ts` must never call `excludeFromBackup`.** Riding the device backup is the
entire point of this feature, and the seam that excludes things (`src/lib/files/backup-exclusion.ts`)
is one import away. The file says so in a comment at the directory-creation site.

**`shareExistingFile` does not delete what it shared**, unlike `writeAndShareFile`, whose whole
job is to hand off a regenerable plaintext artifact and then destroy the on-device copy
(2026-08-23 ADR, decision 3). A snapshot is neither regenerable-on-demand nor plaintext, and it
has to still be there afterwards.

## 7. Photos are out of v1, deliberately

Not an oversight, and not "later, probably":

- **Progress photos** are working copies of originals the user picked from **iOS Photos**, which
  has its own backup that the user already relies on. The originals are not at risk.
- **Meal photos** are transient by design — an estimate input, not a record.
- Photos are also the bulk: an encrypted whole-library snapshot rewritten daily inside the device
  backup is a genuinely different size and rotation problem, not the same one with more bytes.

The follow-up path, if it is ever wanted, is a **per-file** encrypted mirror (each photo sealed
once, under the same master key and the same ARCB1 chunk scheme, named by content hash) rather
than folding photos into the DB snapshot — additive, no format change, no migration.

## 8. Tests — `db/backup.test.mjs`

Pure-and-real, no native mocks:

1. **Round-trip** at 1 byte, exactly one chunk (4 MiB), one chunk + 1, and a ~10 KB realistic
   payload — bytes identical.
2. **Tamper**: a flipped byte in a chunk body, in the final 16 bytes (the tag), and in the
   header; plus truncation (a dropped final chunk, a cut mid-chunk) → the right `reason` each time.
3. **Wrong key** → `wrong-key-or-corrupt`. `peekBackupHeader` reads without a key and returns
   `null` on garbage.
4. **Recovery code**: round-trip, tolerant parse (lowercase, spaces, no hyphens), the `I`/`L`/`O`
   mappings, checksum failure → `null`, wrong length → `null`.
5. **Integration against real SQLite**: build a migrated DB (`freshDb`), insert rows,
   `VACUUM INTO` a temp file, seal → open → write out → reopen with `node:sqlite`; row counts
   match and `PRAGMA user_version` matches `header.userVersion`.
6. **Orchestration**, honestly bounded: in Node the Keychain seam degrades to memory-only, so
   `ensureBackupKey` returns `null` by design and `createBackup`'s `'no-key'` path is what gets
   asserted. Rotation and sealing are covered through the pure layer instead of through a
   monkey-patched module.

Format tests inject a **deterministic counter `random`** so every sealed byte is reproducible;
the integration case uses `node:crypto` `randomBytes`.

## 9. Unverified

Everything native. `expo-secure-store` and `expo-file-system` are present in the current binary,
but **no snapshot has been written, read back, or restored on a device**, and no encrypted iCloud
device backup has been observed carrying one. The JS crypto path has no build gate — noble is
pure JavaScript and runs in the binary that exists today — so the first device pass is about the
file seam, the Keychain accessibility class actually migrating, and the relaunch story, not the
cipher. Verify in this order:

1. Back up now → a file appears in `Documents/backups/`, `peekBackupHeader` reads it back.
2. Force-quit, reopen → auto-backup does **not** fire again inside 24 h.
3. Restore → relaunch → the record is intact and `user_version` is at head.
4. Encrypted device backup → restore to a wiped phone → the snapshot AND the Keychain item are
   both present, and Restore works without the recovery code.
