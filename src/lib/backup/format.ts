/**
 * ARCB1 — the encrypted backup container.
 *
 * This module is the whole cryptographic surface of ARC's backup feature, and
 * it is deliberately PURE: bytes in, bytes out, no filesystem, no Keychain, no
 * native modules, no clock, no randomness of its own. Everything that could
 * fail differently on a device than in a headless test has been pushed to the
 * callers (`snapshot.ts` supplies the clock and the entropy, `key.ts` supplies
 * the master key), which is what makes the format testable to the byte under
 * `node --import ./db/register-ts-hooks.mjs`.
 *
 * WHY a container at all, rather than "encrypt the file": the snapshot rides
 * INSIDE the iCloud/Finder device backup on purpose (that is the entire point —
 * the cloud carries ciphertext only), so the ciphertext is the one ARC artefact
 * an attacker can plausibly hold. It therefore has to fail loud on truncation
 * and extension, not just on a flipped byte. The header carries `totalChunks`
 * and `plainSize` and is used verbatim as the AEAD's associated data for EVERY
 * chunk, so dropping the last chunk, appending a chunk, or editing the declared
 * size all break authentication rather than silently producing a shorter DB.
 *
 * Layout:
 *
 *   bytes 0..4    magic = ASCII "ARCB1"
 *   bytes 5..8    headerLen: u32 big-endian
 *   next          header: ASCII JSON, exactly headerLen bytes
 *   next          chunk 0, chunk 1, ...  (each = 4 MiB of plaintext + 16-byte tag)
 *
 *   fileKey    = HKDF-SHA256(masterKey, salt, "arc-backup-v1", 32)
 *   nonce(i)   = salt(16 bytes) || u64 big-endian chunk index
 *   AAD        = the exact header bytes
 *
 * Chunking exists so restore can be reasoned about in bounded pieces and so a
 * single 16-byte tag never has to cover a multi-hundred-megabyte buffer; the
 * per-file random salt means the nonce for chunk i is unique per backup even
 * though the counter restarts at zero every time.
 *
 * Crypto is @noble/ciphers + @noble/hashes: audited, zero-dependency, pure JS.
 * Pure JS matters here — it works in the CURRENT app binary, so backups are not
 * gated behind an EAS rebuild the way every native seam in ARC is.
 *
 * Hermes has no `Buffer` and no dependable `TextEncoder`/`TextDecoder`, so all
 * byte<->string conversion goes through the local ASCII helpers below. That is
 * safe because the header is ASCII by construction (JSON of ISO timestamps,
 * lowercase hex and integers).
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';

/** The parsed ARCB1 header. Every field is required — a partial header is a bad header. */
export type BackupHeader = {
  v: 1;
  createdAt: string;
  salt: string;
  chunkSize: number;
  totalChunks: number;
  plainSize: number;
  userVersion: number;
};

/**
 * Why a read failed, in the terms the UI actually needs to distinguish:
 * `wrong-key-or-corrupt` is the one that should offer recovery-code entry, and
 * it is deliberately not split into "wrong key" vs "tampered" — an AEAD cannot
 * tell those apart, and pretending otherwise would be a lie to the user.
 */
export type BackupFailure = 'bad-magic' | 'bad-header' | 'wrong-key-or-corrupt' | 'truncated';

export class BackupFormatError extends Error {
  readonly reason: BackupFailure;

  constructor(reason: BackupFailure, message: string) {
    super(message);
    this.name = 'BackupFormatError';
    this.reason = reason;
  }
}

const MAGIC = 'ARCB1';
const MAGIC_BYTES = 5;
const HEADER_LEN_BYTES = 4;
const BODY_START = MAGIC_BYTES + HEADER_LEN_BYTES;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
/** HKDF context string — binds the derived key to this format version. */
const HKDF_INFO = 'arc-backup-v1';
/**
 * A sane ceiling for the header so a corrupt length prefix can't make the
 * reader try to slice (and JSON-parse) hundreds of megabytes before failing.
 */
const MAX_HEADER_BYTES = 4096;

/** Plaintext chunk size: 4 MiB. The last chunk is the remainder. */
export const CHUNK_SIZE = 4 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * ASCII + integer codecs (no Buffer, no TextEncoder — see module doc)
 * ------------------------------------------------------------------ */

/** ASCII string → bytes. Throws on any code point above 0x7f — see module doc. */
export function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) {
      throw new Error(`ARCB1 is ASCII-only; found a non-ASCII character at index ${i}.`);
    }
    out[i] = code;
  }
  return out;
}

/** Bytes → ASCII string over `[start, end)`. Throws on any byte above 0x7f. */
export function bytesAscii(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let text = '';
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i];
    if (byte === undefined) throw new Error('ARCB1 read ran past the end of the buffer.');
    if (byte > 0x7f) throw new Error(`ARCB1 is ASCII-only; byte ${i} is 0x${byte.toString(16)}.`);
    text += String.fromCharCode(byte);
  }
  return text;
}

function writeU32BE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    throw new BackupFormatError('truncated', 'The backup ends inside its length prefix.');
  }
  // `>>> 0` so the top bit doesn't come back as a negative number.
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

/**
 * u64 big-endian as two u32 writes — no BigInt. Hermes has BigInt, but chunk
 * indices are bounded by (file size / 4 MiB), so the high word is 0 in every
 * real backup and the split costs nothing while keeping the wire format a true
 * 64-bit field for anyone reading these bytes in another language later.
 */
function writeU64BE(out: Uint8Array, offset: number, value: number): void {
  writeU32BE(out, offset, Math.floor(value / 0x100000000));
  writeU32BE(out, offset + 4, value >>> 0);
}

/* ------------------------------------------------------------------ *
 * Key + nonce derivation
 * ------------------------------------------------------------------ */

function deriveFileKey(masterKey: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, masterKey, salt, asciiBytes(HKDF_INFO), KEY_BYTES);
}

/**
 * XChaCha20's 24-byte nonce is exactly the per-file salt plus the chunk counter,
 * so uniqueness rests on the salt being fresh per backup rather than on a
 * counter that would otherwise repeat across files under the same file key.
 * (The file key is itself salt-derived, so this is belt and braces.)
 */
function nonceFor(salt: Uint8Array, index: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce.set(salt, 0);
  writeU64BE(nonce, SALT_BYTES, index);
  return nonce;
}

function hexOf(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}

/** Lowercase/uppercase hex → bytes, or null when the string isn't clean hex. */
function bytesFromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const pair = hex.slice(i * 2, i * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) return null;
    out[i] = parseInt(pair, 16);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Header parsing
 * ------------------------------------------------------------------ */

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

type ParsedHeader = {
  header: BackupHeader;
  /** The EXACT header bytes — this is the AAD, so it must never be re-serialized. */
  headerBytes: Uint8Array;
  salt: Uint8Array;
  /** Offset of the first ciphertext chunk. */
  bodyOffset: number;
};

function parseHeader(sealed: Uint8Array): ParsedHeader {
  if (sealed.length < BODY_START) {
    throw new BackupFormatError('truncated', 'The file is too short to be an ARCB1 backup.');
  }
  let magic: string;
  try {
    magic = bytesAscii(sealed, 0, MAGIC_BYTES);
  } catch {
    throw new BackupFormatError('bad-magic', 'This file is not an ARC backup.');
  }
  if (magic !== MAGIC) {
    throw new BackupFormatError('bad-magic', 'This file is not an ARC backup.');
  }

  const headerLen = readU32BE(sealed, MAGIC_BYTES);
  if (headerLen === 0 || headerLen > MAX_HEADER_BYTES) {
    throw new BackupFormatError('bad-header', `Implausible header length (${headerLen} bytes).`);
  }
  const bodyOffset = BODY_START + headerLen;
  if (sealed.length < bodyOffset) {
    throw new BackupFormatError('truncated', 'The file ends inside its header.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytesAscii(sealed, BODY_START, bodyOffset));
  } catch {
    throw new BackupFormatError('bad-header', 'The backup header is not readable JSON.');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BackupFormatError('bad-header', 'The backup header is not an object.');
  }

  const fields = raw as Record<string, unknown>;
  if (fields.v !== 1) {
    throw new BackupFormatError('bad-header', `Unsupported backup version: ${String(fields.v)}.`);
  }
  const createdAt = fields.createdAt;
  const saltHex = fields.salt;
  const { chunkSize, totalChunks, plainSize, userVersion } = fields;
  if (typeof createdAt !== 'string' || createdAt.length === 0) {
    throw new BackupFormatError('bad-header', 'The backup header has no createdAt.');
  }
  if (typeof saltHex !== 'string' || saltHex.length !== SALT_BYTES * 2) {
    throw new BackupFormatError('bad-header', 'The backup salt is not 16 bytes of hex.');
  }
  const salt = bytesFromHex(saltHex);
  if (salt === null || salt.length !== SALT_BYTES) {
    throw new BackupFormatError('bad-header', 'The backup salt is not 16 bytes of hex.');
  }
  if (!isPositiveInt(chunkSize) || !isPositiveInt(totalChunks) || !isPositiveInt(plainSize)) {
    // plainSize === 0 lands here on purpose: an empty snapshot is never a
    // legitimate backup, and treating it as one would let "restore" wipe the DB.
    throw new BackupFormatError('bad-header', 'The backup header has implausible sizes.');
  }
  if (typeof userVersion !== 'number' || !Number.isInteger(userVersion) || userVersion < 0) {
    throw new BackupFormatError('bad-header', 'The backup header has no schema version.');
  }
  // The chunk count is derivable from the other two, so a disagreement means the
  // header was edited — catch it here rather than half-way through decryption.
  if (totalChunks !== Math.ceil(plainSize / chunkSize)) {
    throw new BackupFormatError('bad-header', 'The backup header contradicts itself.');
  }

  return {
    header: { v: 1, createdAt, salt: saltHex, chunkSize, totalChunks, plainSize, userVersion },
    headerBytes: sealed.subarray(BODY_START, bodyOffset),
    salt,
    bodyOffset,
  };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Encrypt `plain` into an ARCB1 container.
 *
 * `random` is injected rather than imported so this module never reaches for a
 * `crypto` global that Hermes doesn't have: in the app it is SQLite's
 * `randomblob` (see `dbRandomBytes`), in tests it is a deterministic counter.
 */
export function sealBackup(
  masterKey: Uint8Array,
  plain: Uint8Array,
  opts: { createdAt: string; userVersion: number; random: (n: number) => Uint8Array }
): Uint8Array {
  // These are programmer errors, not file-format failures, so they throw plain
  // Errors — BackupFormatError is reserved for things a real file can be.
  if (masterKey.length !== KEY_BYTES) {
    throw new Error(`The backup master key must be ${KEY_BYTES} bytes.`);
  }
  if (plain.length === 0) {
    throw new Error('Refusing to seal an empty backup.');
  }

  const salt = opts.random(SALT_BYTES);
  if (salt.length !== SALT_BYTES) {
    throw new Error(
      `The injected random source returned ${salt.length} bytes, expected ${SALT_BYTES}.`
    );
  }

  const totalChunks = Math.ceil(plain.length / CHUNK_SIZE);
  const header: BackupHeader = {
    v: 1,
    createdAt: opts.createdAt,
    salt: hexOf(salt),
    chunkSize: CHUNK_SIZE,
    totalChunks,
    plainSize: plain.length,
    userVersion: opts.userVersion,
  };
  // Serialized once and reused verbatim as the AAD — never re-stringified, so
  // the bytes on disk and the bytes authenticated are the same bytes by
  // construction rather than by hoping two JSON.stringify calls agree.
  const headerBytes = asciiBytes(JSON.stringify(header));
  if (headerBytes.length > MAX_HEADER_BYTES) {
    throw new Error('The backup header is implausibly large.');
  }

  const fileKey = deriveFileKey(masterKey, salt);
  const sealed = new Uint8Array(
    BODY_START + headerBytes.length + plain.length + totalChunks * TAG_BYTES
  );
  sealed.set(asciiBytes(MAGIC), 0);
  writeU32BE(sealed, MAGIC_BYTES, headerBytes.length);
  sealed.set(headerBytes, BODY_START);

  let readAt = 0;
  let writeAt = BODY_START + headerBytes.length;
  for (let i = 0; i < totalChunks; i += 1) {
    const end = Math.min(readAt + CHUNK_SIZE, plain.length);
    const chunk = xchacha20poly1305(fileKey, nonceFor(salt, i), headerBytes).encrypt(
      plain.subarray(readAt, end)
    );
    sealed.set(chunk, writeAt);
    writeAt += chunk.length;
    readAt = end;
  }
  return sealed;
}

/**
 * {@link sealBackup}, yielding to the event loop between chunks.
 *
 * The automatic backup runs on the boot/foreground path, and sealing is a tight
 * typed-array loop Hermes cannot JIT away — a multi-MB database sealed
 * synchronously holds the JS thread through the app's first frames and drops
 * touches. One macrotask per 4 MiB chunk keeps the UI responsive while
 * producing the exact same bytes as the synchronous form (the chunking, nonces
 * and AAD are identical by construction — both loops call the same primitives
 * in the same order).
 */
export async function sealBackupAsync(
  masterKey: Uint8Array,
  plain: Uint8Array,
  opts: { createdAt: string; userVersion: number; random: (n: number) => Uint8Array }
): Promise<Uint8Array> {
  // Validation and layout are delegated wholesale: a zero-length plain or a bad
  // key throws here exactly as it would synchronously. For a single-chunk
  // database (< 4 MiB — years of ARC data) this resolves in one step with no
  // yield at all.
  if (plain.length <= CHUNK_SIZE) return sealBackup(masterKey, plain, opts);

  if (masterKey.length !== KEY_BYTES) {
    throw new Error(`The backup master key must be ${KEY_BYTES} bytes.`);
  }
  const salt = opts.random(SALT_BYTES);
  if (salt.length !== SALT_BYTES) {
    throw new Error(
      `The injected random source returned ${salt.length} bytes, expected ${SALT_BYTES}.`
    );
  }

  const totalChunks = Math.ceil(plain.length / CHUNK_SIZE);
  const header: BackupHeader = {
    v: 1,
    createdAt: opts.createdAt,
    salt: hexOf(salt),
    chunkSize: CHUNK_SIZE,
    totalChunks,
    plainSize: plain.length,
    userVersion: opts.userVersion,
  };
  const headerBytes = asciiBytes(JSON.stringify(header));
  if (headerBytes.length > MAX_HEADER_BYTES) {
    throw new Error('The backup header is implausibly large.');
  }

  const fileKey = deriveFileKey(masterKey, salt);
  const sealed = new Uint8Array(
    BODY_START + headerBytes.length + plain.length + totalChunks * TAG_BYTES
  );
  sealed.set(asciiBytes(MAGIC), 0);
  writeU32BE(sealed, MAGIC_BYTES, headerBytes.length);
  sealed.set(headerBytes, BODY_START);

  let readAt = 0;
  let writeAt = BODY_START + headerBytes.length;
  for (let i = 0; i < totalChunks; i += 1) {
    const end = Math.min(readAt + CHUNK_SIZE, plain.length);
    const chunk = xchacha20poly1305(fileKey, nonceFor(salt, i), headerBytes).encrypt(
      plain.subarray(readAt, end)
    );
    sealed.set(chunk, writeAt);
    writeAt += chunk.length;
    readAt = end;
    // The yield. setTimeout rather than a resolved-promise microtask: a
    // microtask runs before the frame is allowed to paint, which would defeat
    // the purpose.
    if (i + 1 < totalChunks) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return sealed;
}

/**
 * Decrypt an ARCB1 container. Throws {@link BackupFormatError} on every failure
 * path so the caller can branch on `reason` — in particular `wrong-key-or-corrupt`,
 * which is the restore screen's cue to offer recovery-code entry.
 */
export function openBackup(
  masterKey: Uint8Array,
  sealed: Uint8Array
): { plain: Uint8Array; header: BackupHeader } {
  if (masterKey.length !== KEY_BYTES) {
    // Surfaced as a key problem rather than a crash: the user-facing fix (enter
    // the recovery code) is the same one a genuinely wrong key needs.
    throw new BackupFormatError(
      'wrong-key-or-corrupt',
      `The backup key must be ${KEY_BYTES} bytes.`
    );
  }
  const { header, headerBytes, salt, bodyOffset } = parseHeader(sealed);

  const expectedBody = header.plainSize + header.totalChunks * TAG_BYTES;
  const available = sealed.length - bodyOffset;
  if (available < expectedBody) {
    throw new BackupFormatError('truncated', 'The backup is shorter than its header declares.');
  }
  if (available > expectedBody) {
    // Trailing bytes mean the file isn't what the header says it is. The tags
    // would never notice, because nothing authenticates bytes nobody reads.
    throw new BackupFormatError(
      'bad-header',
      'The backup has trailing bytes after its last chunk.'
    );
  }

  const fileKey = deriveFileKey(masterKey, salt);
  const plain = new Uint8Array(header.plainSize);
  let readAt = bodyOffset;
  let writeAt = 0;
  for (let i = 0; i < header.totalChunks; i += 1) {
    const plainLen = Math.min(header.chunkSize, header.plainSize - writeAt);
    const sealedLen = plainLen + TAG_BYTES;
    let chunk: Uint8Array;
    try {
      chunk = xchacha20poly1305(fileKey, nonceFor(salt, i), headerBytes).decrypt(
        sealed.subarray(readAt, readAt + sealedLen)
      );
    } catch {
      // noble throws 'invalid tag'. Wrong key, flipped byte, edited header —
      // all indistinguishable, and all mean the same thing to the caller.
      throw new BackupFormatError(
        'wrong-key-or-corrupt',
        `The backup could not be authenticated (chunk ${i}). The key is wrong or the file is damaged.`
      );
    }
    plain.set(chunk, writeAt);
    writeAt += chunk.length;
    readAt += sealedLen;
  }
  if (writeAt !== header.plainSize) {
    throw new BackupFormatError('truncated', 'The backup decrypted to the wrong length.');
  }
  return { plain, header };
}

/**
 * Read the header without the key — the Backups screen shows when a snapshot
 * was taken and which schema version it holds even when the Keychain is empty.
 * Returns null rather than throwing: this is display code, and a file that
 * can't be read is simply a file with nothing to show.
 */
export function peekBackupHeader(sealed: Uint8Array): BackupHeader | null {
  try {
    return parseHeader(sealed).header;
  } catch {
    return null;
  }
}
