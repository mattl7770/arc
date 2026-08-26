/**
 * The recovery code — the 32-byte backup master key, rendered as something a
 * human can copy onto paper and type back in.
 *
 * WHY this exists: the master key lives in the iOS Keychain with default
 * (`WHEN_UNLOCKED`) accessibility precisely so it migrates through an encrypted
 * device backup, which is what lets a restored iPhone decrypt its own snapshot
 * without the user doing anything. But that path only covers ONE failure mode.
 * If the Keychain item is gone — a wipe with no encrypted backup, a restore
 * from an unencrypted one, a fresh device holding only the `.arcb` file the
 * user exported — the ciphertext is mathematically unrecoverable. The recovery
 * code is the whole answer to "what if the Keychain isn't there", so it is
 * shown once and the user is told plainly that it unlocks the backup.
 *
 * Encoding is Crockford base32: no I, L, O or U in the alphabet, so the shapes
 * people confuse when reading handwriting (1/I/l, 0/O) cannot both be valid
 * symbols, and the decoder folds the confusable ones back. Grouped in fours
 * because that is what people can track with a finger.
 *
 * 32 bytes = 256 bits = 52 symbols (the last symbol carries 1 real bit and 4
 * bits of zero padding), plus a 4-symbol / 20-bit checksum over sha256(key).
 * That is 56 symbols in 14 groups. The checksum is not security — it cannot be,
 * since anyone holding the code holds the key — it is purely so a mistyped code
 * fails immediately with "that isn't the code" instead of silently deriving the
 * wrong key and reporting the backup as corrupt.
 *
 * As with format.ts this module is pure and Hermes-safe: no Buffer, no
 * TextEncoder, no crypto global.
 */
import { sha256 } from '@noble/hashes/sha2';

/** Crockford base32 — I, L, O and U are deliberately absent. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const KEY_BYTES = 32;
const KEY_BITS = KEY_BYTES * 8;
/** ceil(256 / 5) — the last symbol is 1 data bit plus 4 zero pad bits. */
const KEY_SYMBOLS = Math.ceil(KEY_BITS / 5);
/** 20 bits of sha256(key), which is exactly 4 symbols. */
const CHECKSUM_BITS = 20;
const CHECKSUM_SYMBOLS = CHECKSUM_BITS / 5;
const TOTAL_SYMBOLS = KEY_SYMBOLS + CHECKSUM_SYMBOLS;
const GROUP = 4;

/**
 * Read `bitCount` bits out of `source`, most-significant bit first, as base32
 * symbols. A trailing partial symbol is zero-padded on the right.
 */
function encodeSymbols(source: Uint8Array, bitCount: number): string {
  let text = '';
  for (let start = 0; start < bitCount; start += 5) {
    let value = 0;
    for (let offset = 0; offset < 5; offset += 1) {
      const bitIndex = start + offset;
      let bit = 0;
      if (bitIndex < bitCount) {
        const byte = source[bitIndex >> 3] ?? 0;
        bit = (byte >> (7 - (bitIndex & 7))) & 1;
      }
      value = (value << 1) | bit;
    }
    // charAt (not []) because it returns string, not string | undefined, and
    // value is structurally bounded to 0..31 by the five-bit accumulation above.
    text += ALPHABET.charAt(value);
  }
  return text;
}

/** Symbols (5 bits each, MSB-first) → the first `byteCount` bytes they encode. */
function decodeBytes(symbols: number[], byteCount: number): Uint8Array | null {
  const out = new Uint8Array(byteCount);
  for (let bitIndex = 0; bitIndex < byteCount * 8; bitIndex += 1) {
    const symbol = symbols[Math.floor(bitIndex / 5)];
    if (symbol === undefined) return null;
    const bit = (symbol >> (4 - (bitIndex % 5))) & 1;
    const at = bitIndex >> 3;
    out[at] = (((out[at] ?? 0) << 1) | bit) & 0xff;
  }
  return out;
}

/**
 * Render the master key as the code shown (once) in Settings › Backups.
 * Throws on a wrong-sized key — that would be a bug in the key store, not
 * something a user can cause.
 */
export function formatRecoveryCode(key: Uint8Array): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`A recovery code encodes exactly ${KEY_BYTES} bytes.`);
  }
  const symbols = encodeSymbols(key, KEY_BITS) + encodeSymbols(sha256(key), CHECKSUM_BITS);
  const groups: string[] = [];
  for (let i = 0; i < symbols.length; i += GROUP) {
    groups.push(symbols.slice(i, i + GROUP));
  }
  return groups.join('-');
}

/**
 * Parse a typed-back recovery code, or null if it isn't one.
 *
 * Deliberately forgiving about everything that isn't the key: case, hyphens,
 * whitespace of any kind, and the Crockford confusables (I and L read as 1, O
 * reads as 0). U is NOT folded — it is excluded from the alphabet rather than
 * confusable with anything, so a U means the code was mistyped and the honest
 * answer is to reject it rather than guess at an intended symbol.
 */
export function parseRecoveryCode(text: string): Uint8Array | null {
  const symbols: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    // Separators the user may or may not have typed back.
    if (char === '-' || char.trim() === '') continue;
    const upper = char.toUpperCase();
    const normalized = upper === 'I' || upper === 'L' ? '1' : upper === 'O' ? '0' : upper;
    const value = ALPHABET.indexOf(normalized);
    if (value < 0) return null;
    symbols.push(value);
  }
  if (symbols.length !== TOTAL_SYMBOLS) return null;

  const key = decodeBytes(symbols, KEY_BYTES);
  if (key === null) return null;

  // Compare in symbol space so the padding-bit question never arises: we are
  // asking "do the last four symbols match what this key would produce", which
  // is exactly the typo check we want.
  let typed = '';
  for (let i = KEY_SYMBOLS; i < symbols.length; i += 1) {
    typed += ALPHABET.charAt(symbols[i] ?? 0);
  }
  if (typed !== encodeSymbols(sha256(key), CHECKSUM_BITS)) return null;

  return key;
}
