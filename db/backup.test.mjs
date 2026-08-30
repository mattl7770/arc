/**
 * Headless test of the encrypted backup: the ARCB1 container (seal/open/peek),
 * the recovery code, and — as far as a Node process can reach them — the key
 * store and the snapshot orchestration.
 *
 * Two things this file exists to hold still:
 *
 *  1. THE CONTAINER IS THE WHOLE PROMISE. The ciphertext deliberately rides the
 *     iCloud device backup, so the only thing standing between the cloud and
 *     Matt's health record is that a wrong key, a flipped bit, a truncated file
 *     or an edited header FAIL LOUDLY rather than yielding plausible bytes. Every
 *     tamper below is that promise, written down.
 *  2. A BACKUP THAT CANNOT BE OPENED IS WORSE THAN NO BACKUP. So the round-trips
 *     go all the way to a real SQLite file: VACUUM INTO → seal → open → reopen
 *     the recovered bytes with node:sqlite and count the rows back.
 *
 * The crypto is pure JS (@noble/*), so it runs here exactly as it runs on device
 * — this suite is not a stand-in for the native path, it IS the path.
 *
 * Spec: docs/backups-subapp.md. Run: npm run db:test.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  BackupFormatError,
  openBackup,
  peekBackupHeader,
  sealBackup,
} from '../src/lib/backup/format.ts';
import { formatRecoveryCode, parseRecoveryCode } from '../src/lib/backup/recovery-code.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { applyConnectionPragmas } from '../src/lib/db/pragmas.ts';
import { seedReferenceData } from '../src/lib/db/seed.ts';

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass++;
  console.log(`  ok   ${n}`);
};
const bad = (n, e) => {
  fail++;
  console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));
/** A skip that is stated, never silent — a Node process genuinely cannot reach it. */
const skip = (n, why) => console.log(`  skip ${n} — ${why}`);

// --- byte helpers (the container is ASCII-by-construction, so latin1 is exact) --
const CHUNK = 4 * 1024 * 1024;
const MAGIC = 'ARCB1';
const SQLITE_MAGIC = 'SQLite format 3\0';

const ascii = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
};
const readU32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const writeU32 = (b, at, v) => {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
};
const sameBytes = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
/** A copy with one bit flipped at `i` — the smallest possible corruption. */
const bend = (bytes, i) => {
  const copy = Uint8Array.from(bytes);
  copy[i] ^= 0x01;
  return copy;
};
/** A copy with one byte overwritten — used to edit the header's ASCII in place. */
const poke = (bytes, i, char) => {
  const copy = Uint8Array.from(bytes);
  copy[i] = char.charCodeAt(0);
  return copy;
};
function indexOfAscii(bytes, text, from = 0) {
  outer: for (let i = from; i + text.length <= bytes.length; i++) {
    for (let j = 0; j < text.length; j++) {
      if (bytes[i + j] !== text.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

/** Deterministic "entropy" so every sealed byte in this file is reproducible. */
function counterRandom(seed = 0) {
  let n = seed;
  return (count) => {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = n++ & 0xff;
    return out;
  };
}
/** Reproducible filler (an LCG — nothing here is security-relevant). */
function fill(n, seed = 7) {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = (x >>> 24) & 0xff;
  }
  return out;
}
const KEY_A = fill(32, 11);
const KEY_B = fill(32, 12);
const CREATED_AT = '2026-08-25T09:00:00.000Z';

/** Run `fn` and report how it failed, as a string a test can compare. */
function reasonOf(fn) {
  try {
    fn();
    return '<did not throw>';
  } catch (error) {
    if (error instanceof BackupFormatError) return error.reason;
    return `<${error?.name ?? 'Error'}: ${error?.message ?? ''}>`;
  }
}
const reasonIn = (fn, allowed, name) => {
  const reason = reasonOf(fn);
  check(allowed.includes(reason), name, `reason was "${reason}"`);
};

async function tryImport(spec) {
  try {
    return { mod: await import(spec), error: null };
  } catch (error) {
    return { mod: null, error };
  }
}

// ---------------------------------------------------------------------------
{
  console.log('1. Round-trip: one byte, one exact chunk, one chunk plus a byte, one real-ish DB');
  const cases = [
    ['a single byte', 1],
    ['a ~10 KB payload', 10 * 1024],
    ['exactly one chunk (4 MiB)', CHUNK],
    ['one chunk plus a byte (4 MiB + 1)', CHUNK + 1],
  ];
  for (const [label, size] of cases) {
    const plain = fill(size, size + 1);
    const sealed = sealBackup(KEY_A, plain, {
      createdAt: CREATED_AT,
      userVersion: 39,
      random: counterRandom(),
    });
    const wantChunks = Math.ceil(size / CHUNK);

    ascii(sealed.subarray(0, 5)) === MAGIC
      ? ok(`${label}: the file opens with the ASCII magic`)
      : bad(`${label}: magic`, ascii(sealed.subarray(0, 5)));

    const headerLen = readU32(sealed, 5);
    const header = peekBackupHeader(sealed);
    if (!header) {
      bad(`${label}: peekBackupHeader returned null on a freshly sealed file`);
      continue;
    }
    header.v === 1 &&
    header.createdAt === CREATED_AT &&
    header.chunkSize === CHUNK &&
    header.totalChunks === wantChunks &&
    header.plainSize === size &&
    header.userVersion === 39
      ? ok(`${label}: the header states v/createdAt/chunkSize/totalChunks/plainSize/userVersion`)
      : bad(`${label}: header fields`, JSON.stringify(header));
    /^[0-9a-f]{32}$/.test(header.salt)
      ? ok(`${label}: the salt is 32 hex chars (16 bytes)`)
      : bad(`${label}: salt`, header.salt);

    // The header BYTES are the AAD, so their exact serialization — key order
    // included — is part of the format, not an implementation detail. Pin it.
    const wanted = JSON.stringify({
      v: 1,
      createdAt: CREATED_AT,
      salt: header.salt,
      chunkSize: CHUNK,
      totalChunks: wantChunks,
      plainSize: size,
      userVersion: 39,
    });
    const headerText = ascii(sealed.subarray(9, 9 + headerLen));
    headerText === wanted
      ? ok(`${label}: the header is JSON in exactly the specified key order`)
      : bad(`${label}: header serialization`, headerText);
    headerLen <= 4096
      ? ok(`${label}: headerLen is inside the sane bound`)
      : bad('headerLen', headerLen);

    // Every byte accounted for: magic + len + header + plain + one tag per chunk.
    const wantLength = 5 + 4 + headerLen + size + 16 * wantChunks;
    sealed.length === wantLength
      ? ok(`${label}: the file is exactly plain + one 16-byte tag per chunk`)
      : bad(`${label}: length`, `${sealed.length} vs ${wantLength}`);

    const opened = openBackup(KEY_A, sealed);
    sameBytes(opened.plain, plain)
      ? ok(`${label}: opens back to identical bytes`)
      : bad(`${label}: round-trip bytes differ`);
    // Field-by-field rather than JSON.stringify: peek and open may build the
    // object by different routes, and key ORDER is not what is being asserted.
    ['v', 'createdAt', 'salt', 'chunkSize', 'totalChunks', 'plainSize', 'userVersion'].every(
      (field) => opened.header[field] === header[field]
    )
      ? ok(`${label}: open returns the same header peek did`)
      : bad(`${label}: header disagreement`, JSON.stringify(opened.header));
  }

  console.log('   ...and an empty database is refused rather than sealed');
  // plainSize 0 is not a backup, it is a bug upstream. A zero-byte "snapshot"
  // that opens cleanly is the worst possible outcome — it looks like durability.
  reasonOf(() =>
    sealBackup(KEY_A, new Uint8Array(0), {
      createdAt: CREATED_AT,
      userVersion: 39,
      random: counterRandom(),
    })
  ) !== '<did not throw>'
    ? ok('sealing zero bytes throws')
    : bad('zero-byte seal was accepted');
}

// ---------------------------------------------------------------------------
{
  console.log('2. The same inputs seal to the same bytes (nothing ambient leaks in)');
  const plain = fill(3000, 21);
  const opts = () => ({ createdAt: CREATED_AT, userVersion: 39, random: counterRandom() });
  const first = sealBackup(KEY_A, plain, opts());
  const second = sealBackup(KEY_A, plain, opts());
  sameBytes(first, second)
    ? ok('two seals with the same injected randomness are byte-identical')
    : bad('seal is not deterministic — something ambient (a clock, Math.random) is in the file');
  const third = sealBackup(KEY_A, plain, {
    createdAt: CREATED_AT,
    userVersion: 39,
    random: counterRandom(64),
  });
  !sameBytes(first, third)
    ? ok('...and a different salt produces a different file')
    : bad('salt does not reach the ciphertext');
}

// ---------------------------------------------------------------------------
{
  console.log('3. Tamper detection: one flipped bit anywhere must fail authentication');
  const plain = fill(10 * 1024, 33);
  const sealed = sealBackup(KEY_A, plain, {
    createdAt: CREATED_AT,
    userVersion: 39,
    random: counterRandom(),
  });
  const headerLen = readU32(sealed, 5);
  const ctStart = 9 + headerLen;

  reasonIn(
    () => openBackup(KEY_A, bend(sealed, ctStart + 5)),
    ['wrong-key-or-corrupt'],
    'a flipped bit in the ciphertext body is caught'
  );
  reasonIn(
    () => openBackup(KEY_A, bend(sealed, sealed.length - 1)),
    ['wrong-key-or-corrupt'],
    'a flipped bit in the final Poly1305 tag is caught'
  );
  reasonIn(
    () => openBackup(KEY_A, bend(sealed, 9 + 3)),
    ['bad-header', 'wrong-key-or-corrupt'],
    'a flipped bit inside the header is caught'
  );

  console.log('   ...and header EDITS that stay valid JSON, because the header is the AAD');
  // Same length, still-parseable JSON, geometry untouched: the only thing that
  // can catch this is the header being authenticated as associated data.
  const atYear = indexOfAscii(sealed, CREATED_AT);
  atYear >= 0
    ? reasonIn(
        () => openBackup(KEY_A, poke(sealed, atYear + 3, '7')),
        ['wrong-key-or-corrupt'],
        'rewriting createdAt (valid JSON, same length) fails authentication'
      )
    : bad('could not locate createdAt in the header');

  const atSalt = indexOfAscii(sealed, '"salt":"');
  if (atSalt >= 0) {
    const first = String.fromCharCode(sealed[atSalt + 8]);
    reasonIn(
      () => openBackup(KEY_A, poke(sealed, atSalt + 8, first === 'a' ? 'b' : 'a')),
      ['wrong-key-or-corrupt'],
      'rewriting one salt nibble fails (it derives both the file key and the nonces)'
    );
  } else {
    bad('could not locate the salt in the header');
  }

  const atSize = indexOfAscii(sealed, `"plainSize":${plain.length}`);
  atSize >= 0
    ? reasonIn(
        () => openBackup(KEY_A, poke(sealed, atSize + 12 + String(plain.length).length - 1, '9')),
        ['wrong-key-or-corrupt', 'truncated', 'bad-header'],
        'rewriting plainSize fails — the header binds the file’s length'
      )
    : bad('could not locate plainSize in the header');

  console.log('   ...and structural damage');
  reasonIn(
    () => openBackup(KEY_A, poke(sealed, 0, 'X')),
    ['bad-magic'],
    'a wrong magic is named as such'
  );
  const insaneLen = Uint8Array.from(sealed);
  writeU32(insaneLen, 5, 100000);
  reasonIn(
    () => openBackup(KEY_A, insaneLen),
    ['bad-header', 'truncated'],
    'an absurd headerLen is refused rather than read'
  );
  reasonIn(
    () => openBackup(KEY_A, sealed.slice(0, 8)),
    ['truncated', 'bad-magic', 'bad-header'],
    'a file cut before the header length is truncated'
  );
  reasonIn(
    () => openBackup(KEY_A, sealed.slice(0, 9 + headerLen - 1)),
    ['truncated', 'bad-header'],
    'a file cut inside the header is truncated'
  );
  reasonIn(
    () => openBackup(KEY_A, sealed.slice(0, sealed.length - 1)),
    ['truncated', 'wrong-key-or-corrupt'],
    'a file one byte short is truncated'
  );
  reasonIn(
    () => openBackup(KEY_A, sealed.slice(0, ctStart)),
    ['truncated'],
    'a header with no ciphertext at all is truncated'
  );
  const extended = new Uint8Array(sealed.length + 32);
  extended.set(sealed, 0);
  reasonIn(
    () => openBackup(KEY_A, extended),
    ['truncated', 'bad-header', 'wrong-key-or-corrupt'],
    'appended trailing bytes are refused (the ciphertext must be consumed exactly)'
  );

  console.log('   ...and the multi-chunk case, where a whole chunk can go missing');
  const bigPlain = fill(CHUNK + 1, 44);
  const big = sealBackup(KEY_A, bigPlain, {
    createdAt: CREATED_AT,
    userVersion: 39,
    random: counterRandom(),
  });
  const bigHeader = peekBackupHeader(big);
  bigHeader?.totalChunks === 2
    ? ok('4 MiB + 1 seals as two chunks')
    : bad('chunk count', JSON.stringify(bigHeader));
  reasonIn(
    () => openBackup(KEY_A, big.slice(0, big.length - 17)),
    ['truncated'],
    'dropping the entire final chunk is truncated, not silently short'
  );
  const bigHeaderLen = readU32(big, 5);
  reasonIn(
    () => openBackup(KEY_A, bend(big, 9 + bigHeaderLen + 12)),
    ['wrong-key-or-corrupt'],
    'a flipped bit in the FIRST chunk is caught (not just the last)'
  );
  sameBytes(openBackup(KEY_A, big).plain, bigPlain)
    ? ok('...and the untouched two-chunk file still opens intact')
    : bad('multi-chunk round-trip');
}

// ---------------------------------------------------------------------------
{
  console.log('4. The wrong key, and reading a header without any key at all');
  const plain = fill(2048, 55);
  const sealed = sealBackup(KEY_A, plain, {
    createdAt: CREATED_AT,
    userVersion: 39,
    random: counterRandom(),
  });
  reasonIn(
    () => openBackup(KEY_B, sealed),
    ['wrong-key-or-corrupt'],
    'a different 32-byte key cannot open the file'
  );
  reasonIn(
    () => openBackup(bend(KEY_A, 0), sealed),
    ['wrong-key-or-corrupt'],
    '...nor can the right key with one bit flipped'
  );

  const peeked = peekBackupHeader(sealed);
  peeked && peeked.plainSize === plain.length && peeked.userVersion === 39
    ? ok('peekBackupHeader reads the header with NO key — which is what Settings shows')
    : bad('peek without key', JSON.stringify(peeked));
  peekBackupHeader(new Uint8Array(0)) === null &&
  peekBackupHeader(fill(64, 99)) === null &&
  peekBackupHeader(sealed.slice(0, 6)) === null
    ? ok('peekBackupHeader returns null on empty, on garbage, and on a stub')
    : bad('peek on malformed input did not return null');
  const brokenJson = poke(sealed, 9 + 1, '#');
  peekBackupHeader(brokenJson) === null
    ? ok('...and on a header that is no longer JSON')
    : bad('peek accepted non-JSON header');
}

// ---------------------------------------------------------------------------
{
  console.log('5. The recovery code — the only way back when the Keychain is gone');
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  // Find a key whose code contains both a '0' and a '1', so the Crockford
  // ambiguity mapping below is actually exercised rather than vacuously true.
  let key = null;
  let code = null;
  for (let i = 0; i < 200; i++) {
    const candidate = Uint8Array.from(randomBytes(32));
    const text = formatRecoveryCode(candidate);
    if (text.includes('0') && text.includes('1')) {
      key = candidate;
      code = text;
      break;
    }
  }
  if (!key) {
    bad('could not produce a recovery code containing both 0 and 1 in 200 tries');
  } else {
    const groups = code.split('-');
    // 32 bytes = 256 bits = 52 base32 chars, + a 4-char checksum group = 56.
    code.replace(/-/g, '').length === 56
      ? ok('the code is 52 payload chars plus a 4-char checksum')
      : bad('code length', String(code.replace(/-/g, '').length));
    groups.length === 14 && groups.every((g) => g.length === 4)
      ? ok('...rendered as 14 groups of 4')
      : bad('grouping', code);
    /^[0-9A-Z-]+$/.test(code) && !/[ILOU]/.test(code)
      ? ok('...in the Crockford alphabet, with I/L/O/U never emitted')
      : bad('alphabet', code);

    sameBytes(parseRecoveryCode(code), key)
      ? ok('a code round-trips back to the exact 32 key bytes')
      : bad('round-trip');

    console.log('   ...typed back in by a human, in whatever shape that takes');
    sameBytes(parseRecoveryCode(code.toLowerCase()), key)
      ? ok('lowercase parses')
      : bad('lowercase');
    sameBytes(parseRecoveryCode(code.replace(/-/g, '')), key)
      ? ok('no hyphens parses')
      : bad('no hyphens');
    sameBytes(parseRecoveryCode(code.replace(/-/g, ' ')), key)
      ? ok('spaces instead of hyphens parses')
      : bad('spaces');
    sameBytes(parseRecoveryCode(`  ${code.toLowerCase().replace(/-/g, '  ')}  `), key)
      ? ok('leading/trailing/doubled whitespace with lowercase parses')
      : bad('messy whitespace');

    console.log('   ...including the four glyphs Crockford removed for exactly this reason');
    sameBytes(parseRecoveryCode(code.replace(/1/g, 'I')), key)
      ? ok('I is read as 1')
      : bad('I -> 1');
    sameBytes(parseRecoveryCode(code.replace(/1/g, 'l')), key)
      ? ok('lowercase l is read as 1')
      : bad('l -> 1');
    sameBytes(parseRecoveryCode(code.replace(/0/g, 'O')), key)
      ? ok('O is read as 0')
      : bad('O -> 0');
    sameBytes(parseRecoveryCode(code.replace(/0/g, 'o').replace(/1/g, 'i')), key)
      ? ok('...and both, lowercase, at once')
      : bad('o/i together');

    console.log('   ...and everything else is refused, never half-decoded');
    const swap = (text, at) => {
      const c = text[at];
      const i = alphabet.indexOf(c);
      const next = alphabet[(i + 1) % alphabet.length];
      return text.slice(0, at) + next + text.slice(at + 1);
    };
    const flat = code.replace(/-/g, '');
    parseRecoveryCode(swap(flat, 0)) === null
      ? ok('one wrong payload character fails the checksum')
      : bad('payload typo accepted');
    parseRecoveryCode(swap(flat, 20)) === null
      ? ok('...anywhere in the payload')
      : bad('mid-payload typo accepted');
    parseRecoveryCode(swap(flat, flat.length - 1)) === null
      ? ok('one wrong checksum character is refused')
      : bad('checksum typo accepted');
    parseRecoveryCode(flat.slice(0, -1)) === null
      ? ok('a code one character short is refused')
      : bad('short code accepted');
    parseRecoveryCode(`${flat}A`) === null
      ? ok('a code one character long is refused')
      : bad('long code accepted');
    parseRecoveryCode('') === null && parseRecoveryCode('   ') === null
      ? ok('empty and blank are refused')
      : bad('empty accepted');
    parseRecoveryCode('ABCD-EFGH') === null
      ? ok('a plainly-too-short string is refused')
      : bad('short string accepted');
    parseRecoveryCode(`$${flat.slice(1)}`) === null
      ? ok('a character outside the alphabet is refused')
      : bad('junk character accepted');
    // U is not in the alphabet and has no documented mapping — whichever way an
    // implementation treats it, the checksum must not survive the substitution.
    parseRecoveryCode(`U${flat.slice(1)}`) === null
      ? ok('U — the glyph Crockford dropped — is refused')
      : bad('U accepted');
  }

  console.log('   ...over a hundred random keys, so this is not one lucky example');
  let roundTripped = 0;
  for (let i = 0; i < 100; i++) {
    const k = Uint8Array.from(randomBytes(32));
    if (sameBytes(parseRecoveryCode(formatRecoveryCode(k)), k)) roundTripped++;
  }
  roundTripped === 100
    ? ok('100/100 random keys round-trip')
    : bad('random round-trips', `${roundTripped}/100`);
}

// ---------------------------------------------------------------------------
{
  console.log('6. End to end over a REAL database file: VACUUM INTO → seal → open → reopen');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-backup-'));
  try {
    const raw = new DatabaseSync(':memory:');
    applyConnectionPragmas((sql) => raw.exec(sql));
    const db = {
      run: (sql, params = []) => {
        raw.prepare(sql).run(...params);
      },
      all: (sql, params = []) => raw.prepare(sql).all(...params),
      get: (sql, params = []) => raw.prepare(sql).get(...params),
      transaction: (fn) => {
        raw.exec('BEGIN');
        try {
          fn();
          raw.exec('COMMIT');
        } catch (e) {
          raw.exec('ROLLBACK');
          throw e;
        }
      },
    };
    migrate(
      {
        exec: (sql) => raw.exec(sql),
        getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
        setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
        transaction: db.transaction,
      },
      MIGRATIONS
    );
    seedReferenceData(db);
    for (const [id, at, kg] of [
      ['b-1', '2026-08-20T06:30:00.000Z', 81.2],
      ['b-2', '2026-08-21T06:30:00.000Z', 80.9],
      ['b-3', '2026-08-22T06:30:00.000Z', 80.7],
    ]) {
      db.run('INSERT INTO body_metrics (id, measured_at, weight_kg, source) VALUES (?, ?, ?, ?)', [
        id,
        at,
        kg,
        'manual',
      ]);
    }
    const biomarkers = raw.prepare('SELECT count(*) c FROM biomarkers').get().c;
    const userVersion = raw.prepare('PRAGMA user_version').get().user_version;

    // The same statement createBackup runs on device (single-quote escaped).
    const vacuumPath = path.join(dir, 'snapshot.db').split(path.sep).join('/');
    raw.exec(`VACUUM INTO '${vacuumPath.replace(/'/g, "''")}'`);
    raw.close();

    const plain = Uint8Array.from(fs.readFileSync(vacuumPath));
    plain.length > 0
      ? ok(`VACUUM INTO produced ${plain.length} bytes`)
      : bad('vacuum produced nothing');
    ascii(plain.subarray(0, 16)) === SQLITE_MAGIC
      ? ok('...and they begin with the SQLite magic restoreFromSnapshot checks for')
      : bad('sqlite magic', JSON.stringify(ascii(plain.subarray(0, 16))));

    const key = Uint8Array.from(randomBytes(32));
    const sealed = sealBackup(key, plain, {
      createdAt: new Date().toISOString(),
      userVersion,
      random: (n) => Uint8Array.from(randomBytes(n)),
    });
    ascii(sealed.subarray(0, 16)) !== SQLITE_MAGIC
      ? ok('the sealed file does NOT begin with the SQLite magic — the cloud sees ciphertext')
      : bad('the sealed snapshot still looks like a database');
    indexOfAscii(sealed, 'body_metrics') === -1
      ? ok('...and a table name from the schema appears nowhere in it')
      : bad('plaintext leaked into the sealed snapshot');

    const opened = openBackup(key, sealed);
    sameBytes(opened.plain, plain)
      ? ok('the snapshot opens back to the exact database file')
      : bad('database bytes differ after round-trip');
    opened.header.userVersion === userVersion
      ? ok(`the header carries the schema version (${userVersion}) the file was taken at`)
      : bad('header userVersion', String(opened.header.userVersion));

    const restoredPath = path.join(dir, 'restored.db');
    fs.writeFileSync(restoredPath, Buffer.from(opened.plain));
    const restored = new DatabaseSync(restoredPath);
    restored.prepare('SELECT count(*) c FROM body_metrics').get().c === 3
      ? ok('the recovered file opens as SQLite with all three rows')
      : bad('restored row count');
    restored.prepare('SELECT count(*) c FROM biomarkers').get().c === biomarkers
      ? ok(`...and all ${biomarkers} seeded biomarkers`)
      : bad('restored biomarker count');
    restored.prepare('PRAGMA user_version').get().user_version === opened.header.userVersion
      ? ok('...at exactly the user_version the header claims')
      : bad('restored user_version');
    restored.prepare('SELECT weight_kg w FROM body_metrics ORDER BY measured_at').all()[2].w ===
    80.7
      ? ok('...with the values themselves intact, not merely the row count')
      : bad('restored values');
    restored.prepare('PRAGMA integrity_check').get().integrity_check === 'ok'
      ? ok('...and SQLite itself calls the recovered file sound')
      : bad('integrity_check on the restored file');
    restored.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
{
  console.log('7. The key store, in a process with no Keychain — the degraded truth');
  const { mod: keyStore, error } = await tryImport('../src/lib/backup/key.ts');
  if (!keyStore) {
    bad('src/lib/backup/key.ts could not be imported', String(error?.message ?? error));
  } else {
    await keyStore.hydrateBackupKey();
    await keyStore.hydrateBackupKey();
    ok('hydrateBackupKey is idempotent and does not throw without expo-secure-store');
    keyStore.isBackupKeyPersistent() === false
      ? ok('isBackupKeyPersistent is honest: false when the Keychain is unreachable')
      : bad('isBackupKeyPersistent claimed persistence in Node');
    keyStore.getBackupKey() === null
      ? ok('there is no key yet')
      : bad('a key appeared from nowhere');

    // THE INVARIANT THAT MATTERS MOST HERE. Minting a key that cannot be
    // persisted would produce a snapshot nobody can ever open again — strictly
    // worse than having no snapshot, because it looks like a safety net.
    const minted = await keyStore.ensureBackupKey(counterRandom());
    minted === null
      ? ok('ensureBackupKey REFUSES to mint a key it cannot persist')
      : bad('ensureBackupKey minted an unpersistable key', `${minted?.length} bytes`);
    keyStore.getBackupKey() === null
      ? ok('...and leaves the mirror empty, so nothing can be encrypted under it')
      : bad('a refused key was still mirrored');
  }

  console.log('   ...and the snapshot orchestration, as far as Node can reach it');
  const snapshot = await tryImport('../src/lib/backup/snapshot.ts');
  if (!snapshot.mod) {
    const message = String(snapshot.error?.message ?? snapshot.error);
    if (/op-sqlite|op-engineering|react-native/i.test(message)) {
      // snapshot.ts reaches replaceDatabaseFile in client.ts, which statically
      // imports op-sqlite — a native module. Not a defect; simply out of reach.
      skip('snapshot.ts orchestration', 'it pulls in op-sqlite through client.ts');
    } else {
      bad('src/lib/backup/snapshot.ts could not be imported', message);
    }
  } else {
    const {
      CURRENT_SNAPSHOT,
      PREVIOUS_SNAPSHOT,
      createBackup,
      dbRandomBytes,
      lastBackupInfo,
      autoBackupIfDue,
      restoreFromSnapshot,
    } = snapshot.mod;

    CURRENT_SNAPSHOT === 'arc-current.arcb' && PREVIOUS_SNAPSHOT === 'arc-previous.arcb'
      ? ok('the two snapshot names are the specified ones')
      : bad('snapshot names', `${CURRENT_SNAPSHOT} / ${PREVIOUS_SNAPSHOT}`);
    CURRENT_SNAPSHOT !== PREVIOUS_SNAPSHOT
      ? ok('...and the rotation target is not the rotation source')
      : bad('current and previous collide');

    const raw = new DatabaseSync(':memory:');
    applyConnectionPragmas((sql) => raw.exec(sql));
    const db = {
      run: (sql, params = []) => {
        raw.prepare(sql).run(...params);
      },
      all: (sql, params = []) => raw.prepare(sql).all(...params),
      get: (sql, params = []) => raw.prepare(sql).get(...params),
      transaction: (fn) => {
        raw.exec('BEGIN');
        try {
          fn();
          raw.exec('COMMIT');
        } catch (e) {
          raw.exec('ROLLBACK');
          throw e;
        }
      },
    };
    migrate(
      {
        exec: (sql) => raw.exec(sql),
        getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
        setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
        transaction: db.transaction,
      },
      MIGRATIONS
    );

    // Entropy from SQLite's own PRNG — the one source available to Hermes.
    const a = dbRandomBytes(db, 32);
    const b = dbRandomBytes(db, 32);
    a instanceof Uint8Array && a.length === 32 && b.length === 32
      ? ok('dbRandomBytes returns 32 bytes as a Uint8Array')
      : bad('dbRandomBytes shape', `${a?.constructor?.name}/${a?.length}`);
    !sameBytes(a, b) ? ok('...different on each call') : bad('dbRandomBytes repeated itself');
    dbRandomBytes(db, 16).length === 16 && dbRandomBytes(db, 1).length === 1
      ? ok('...and honours the requested length')
      : bad('dbRandomBytes length');
    let allZero = true;
    for (const byte of dbRandomBytes(db, 64)) if (byte !== 0) allZero = false;
    !allZero
      ? ok('...and is not a field of zeros (the hex parse actually works)')
      : bad('all zeros');

    // An in-memory store standing in for Documents/backups — with a WORKING
    // vacuum target backed by a real temp directory, so createBackup's whole
    // pipeline (VACUUM INTO → read back → seal → rotate → write) actually runs
    // here. The failure switches let single assertions prove the ordering
    // properties the module's header calls the point of injecting the store.
    const files = new Map();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-backup-orch-'));
    const removedUris = [];
    let vacuumCounter = 0;
    let failCopy = false;
    let failWrite = false;
    const store = {
      available: () => true,
      list: () =>
        [...files.entries()].map(([name, f]) => ({
          name,
          size: f.bytes.length,
          modifiedAt: f.modifiedAt,
        })),
      readBytes: (name) => files.get(name)?.bytes ?? null,
      writeBytesAtomic: (name, bytes) => {
        if (failWrite) return false;
        files.set(name, { bytes, modifiedAt: Date.now() });
        return true;
      },
      copy: (from, to) => {
        if (failCopy) return false;
        const source = files.get(from);
        if (!source) return false;
        files.set(to, { bytes: source.bytes, modifiedAt: Date.now() });
        return true;
      },
      remove: (name) => files.delete(name),
      uriFor: (name) => (files.has(name) ? `file:///documents/backups/${name}` : null),
      tempVacuumTarget: () => {
        vacuumCounter += 1;
        const p = path.join(tempDir, `vacuum-${vacuumCounter}.db`).split(path.sep).join('/');
        return { path: p, uri: `file://${p}` };
      },
      readBytesAtUri: (uri) => {
        try {
          return Uint8Array.from(fs.readFileSync(uri.replace(/^file:\/\//, '')));
        } catch {
          return null;
        }
      },
      removeAtUri: (uri) => {
        removedUris.push(uri);
        try {
          fs.rmSync(uri.replace(/^file:\/\//, ''), { force: true });
        } catch {
          // best-effort, like the real store
        }
        return true;
      },
    };

    lastBackupInfo({ store }) === null
      ? ok('lastBackupInfo is null when nothing has been backed up')
      : bad('lastBackupInfo invented a backup');
    store.writeBytesAtomic(CURRENT_SNAPSHOT, fill(1234, 3));
    const info = lastBackupInfo({ store });
    info && info.name === CURRENT_SNAPSHOT && info.size === 1234
      ? ok('...and reports name and size once one exists')
      : bad('lastBackupInfo', JSON.stringify(info));
    files.delete(CURRENT_SNAPSHOT);

    (await createBackup(db, { store: null })).status === 'unavailable'
      ? ok("createBackup with no file store is 'unavailable', not a crash")
      : bad('createBackup unavailable');

    // No Keychain in Node ⇒ ensureBackupKey refuses to mint (asserted above) ⇒
    // createBackup must stop BEFORE writing anything it could never decrypt.
    const noKey = await createBackup(db, { store });
    noKey.status === 'no-key'
      ? ok("createBackup without a persistable key is 'no-key'")
      : bad('createBackup with no key', JSON.stringify(noKey));
    files.size === 0
      ? ok('...and it wrote no file at all — never a snapshot without a key to open it')
      : bad('a keyless backup left files behind', [...files.keys()].join(','));

    // THE DISASTER SCENARIO the never-mint-over-ciphertext rule exists for: a
    // restored phone arrives with the snapshot but without the key. A backup
    // pass must pause at 'no-key' and leave the ciphertext EXACTLY as it found
    // it — never rotate it, never write over it.
    const survivor = fill(2048, 7);
    store.writeBytesAtomic(CURRENT_SNAPSHOT, survivor);
    const paused = await createBackup(db, { store });
    paused.status === 'no-key'
      ? ok("a snapshot with no key pauses the backup at 'no-key' (never a fresh mint over it)")
      : bad('mint gate', JSON.stringify(paused));
    sameBytes(files.get(CURRENT_SNAPSHOT)?.bytes, survivor) && !files.has(PREVIOUS_SNAPSHOT)
      ? ok('...and the orphaned ciphertext is byte-for-byte untouched, nothing rotated')
      : bad('the keyless pass disturbed the ciphertext');
    files.delete(CURRENT_SNAPSHOT);

    (await restoreFromSnapshot(undefined, { store: null })).status === 'unavailable'
      ? ok("restoreFromSnapshot with no file store is 'unavailable', never 'no-snapshot'")
      : bad('restore unavailable arm');
    (await restoreFromSnapshot(undefined, { store })).status === 'no-snapshot'
      ? ok("restoreFromSnapshot with an empty directory is 'no-snapshot'")
      : bad('restore with no snapshot');
    store.writeBytesAtomic(CURRENT_SNAPSHOT, fill(512, 8));
    const restored = await restoreFromSnapshot(undefined, { store });
    restored.status === 'no-key' || restored.status === 'bad-key'
      ? ok(`a snapshot with no key to open it is '${restored.status}', never 'restored'`)
      : bad('restore without a key', JSON.stringify(restored));
    files.delete(CURRENT_SNAPSHOT);

    console.log('   ...and the full pipeline once a recovery code puts a key in the mirror');
    // From here on the module-level mirror holds a key — which is exactly the
    // state a real device is in, and what lets Node exercise the whole
    // vacuum → seal → rotate → write pipeline through the injected store.
    const { mod: keyStore2 } = await tryImport('../src/lib/backup/key.ts');
    const sessionKey = Uint8Array.from(randomBytes(32));
    {
      const parsed = parseRecoveryCode(formatRecoveryCode(sessionKey));
      sameBytes(parsed, sessionKey) ? ok('a code parses back to its key') : bad('adopt parse');
      keyStore2.adoptRecoveryKey(parsed) === true
        ? ok('adoptRecoveryKey (mirror-only now) accepts it synchronously')
        : bad('adoptRecoveryKey refused a valid key');
      sameBytes(keyStore2.getBackupKey(), sessionKey)
        ? ok('...and it reaches the mirror, so this session can decrypt right now')
        : bad('adoptRecoveryKey did not reach the mirror');
      (await keyStore2.persistAdoptedKey()) === 'memory-only'
        ? ok("persistAdoptedKey is honest in Node: 'memory-only', the code must be kept")
        : bad('persistAdoptedKey claimed persistence without a Keychain');
      const displaced = keyStore2.getBackupKey();
      keyStore2.restoreSessionKey(null);
      keyStore2.getBackupKey() === null
        ? ok('restoreSessionKey(null) really clears the mirror (the failed-adopt undo)')
        : bad('restoreSessionKey left a key behind');
      keyStore2.restoreSessionKey(displaced);
      sameBytes(keyStore2.getBackupKey(), sessionKey)
        ? ok('...and puts the displaced key back for the retry that succeeded')
        : bad('restoreSessionKey round trip');
    }

    const { mod: user } = await tryImport('../src/lib/db/repositories/user.ts');
    if (user && typeof user.isBackupEnabled === 'function') {
      user.isBackupEnabled(db) === true
        ? ok('automatic backups default ON — a safety net that needs ceremony is not one')
        : bad('backups defaulted off');
      user.setBackupEnabled(db, false);
      user.isBackupEnabled(db) === false ? ok('the toggle persists off') : bad('toggle off');

      // The toggle is a SCHEDULE control. A hand-pressed backup outranks it —
      // gating the manual path on it left zero durability behind a live button.
      const manual = await createBackup(db, { store });
      manual.status === 'done'
        ? ok('a MANUAL backup runs with the schedule toggle off — intent outranks schedule')
        : bad('manual backup gated on the schedule toggle', JSON.stringify(manual));
      files.has(CURRENT_SNAPSHOT)
        ? ok(`...and a real snapshot landed (${files.get(CURRENT_SNAPSHOT).bytes.length} bytes)`)
        : bad('manual backup wrote nothing');

      // The AUTOMATIC path honours the same toggle.
      files.clear();
      await autoBackupIfDue(db, { store });
      files.size === 0
        ? ok('...while autoBackupIfDue honours the toggle and writes nothing')
        : bad('autoBackupIfDue ignored the schedule toggle');

      user.setBackupEnabled(db, true);
      user.isBackupEnabled(db) === true ? ok('the toggle persists back on') : bad('toggle on');
    } else {
      bad('isBackupEnabled/setBackupEnabled are missing from repositories/user.ts');
    }

    // The full pipeline, twice, to prove the generation history: the second
    // backup's PREVIOUS must be byte-for-byte the first backup's CURRENT.
    removedUris.length = 0;
    const first = await createBackup(db, { store });
    first.status === 'done'
      ? ok('createBackup runs the whole vacuum → seal → write pipeline against the store')
      : bad('first pipeline backup', JSON.stringify(first));
    const firstCurrent = files.get(CURRENT_SNAPSHOT)?.bytes;
    firstCurrent && !files.has(PREVIOUS_SNAPSHOT)
      ? ok('...first backup: a current snapshot and no previous generation yet')
      : bad('first backup file layout', [...files.keys()].join(','));
    removedUris.length > 0
      ? ok('...and the plaintext VACUUM temp was removed on the success path')
      : bad('the plaintext temp copy survived a successful backup');

    db.run(
      "INSERT INTO body_metrics (id, measured_at, weight_kg, source) VALUES ('orch-1', '2026-08-24T06:30:00.000Z', 80.4, 'manual')"
    );
    const second = await createBackup(db, { store });
    second.status === 'done' ? ok('a second backup runs clean') : bad('second backup');
    sameBytes(files.get(PREVIOUS_SNAPSHOT)?.bytes, firstCurrent)
      ? ok('rotation: previous now holds EXACTLY the first backup — one generation of history')
      : bad('rotation did not preserve the prior current');
    !sameBytes(files.get(CURRENT_SNAPSHOT)?.bytes, firstCurrent)
      ? ok('...and current moved on (new salt, new data — never the same bytes)')
      : bad('current did not change across backups');

    // A failed rotation must ABORT with both generations intact — overwriting
    // current after previous failed to rotate collapses two generations to one.
    const beforeCurrent = files.get(CURRENT_SNAPSHOT)?.bytes;
    const beforePrevious = files.get(PREVIOUS_SNAPSHOT)?.bytes;
    failCopy = true;
    const aborted = await createBackup(db, { store });
    failCopy = false;
    aborted.status === 'failed'
      ? ok("a failed rotation aborts the backup as 'failed'")
      : bad('rotation failure outcome', JSON.stringify(aborted));
    sameBytes(files.get(CURRENT_SNAPSHOT)?.bytes, beforeCurrent) &&
    sameBytes(files.get(PREVIOUS_SNAPSHOT)?.bytes, beforePrevious)
      ? ok('...leaving BOTH generations byte-for-byte intact')
      : bad('a failed rotation disturbed the snapshots');

    // A failed final write is honest too, and the temp never survives it.
    removedUris.length = 0;
    failWrite = true;
    const writeFail = await createBackup(db, { store });
    failWrite = false;
    writeFail.status === 'failed'
      ? ok("a failed snapshot write is 'failed', never silently 'done'")
      : bad('write-failure outcome', JSON.stringify(writeFail));
    removedUris.length > 0
      ? ok('...and the plaintext temp copy was removed on the failure path as well')
      : bad('the plaintext temp survived a failed backup');

    // The throttle, against the injected store: a fresh current is NOT due.
    const countBefore = files.get(CURRENT_SNAPSHOT)?.modifiedAt;
    await autoBackupIfDue(db, { store });
    files.get(CURRENT_SNAPSHOT)?.modifiedAt === countBefore
      ? ok('autoBackupIfDue is throttled by a fresh snapshot (nothing rewritten)')
      : bad('the throttle did not hold');

    // Restore, as far as Node can go: decrypt + magic + schema checks all pass,
    // and the pipe stops only at the native client seam.
    const nodeRestore = await restoreFromSnapshot(undefined, { store });
    nodeRestore.status === 'failed' && /database module/i.test(nodeRestore.message ?? '')
      ? ok('restore decrypts and verifies the snapshot, stopping only at the native DB seam')
      : bad('restore pipeline', JSON.stringify(nodeRestore));

    // A snapshot sealed by a NEWER ARC (higher user_version than this build's
    // migration head) must be refused before anything touches the database.
    {
      const fakeSqlite = new Uint8Array(64);
      for (let i = 0; i < SQLITE_MAGIC.length; i += 1) fakeSqlite[i] = SQLITE_MAGIC.charCodeAt(i);
      const futureSealed = sealBackup(sessionKey, fakeSqlite, {
        createdAt: new Date().toISOString(),
        userVersion: 9999,
        random: (n) => Uint8Array.from(randomBytes(n)),
      });
      store.writeBytesAtomic(CURRENT_SNAPSHOT, futureSealed);
      (await restoreFromSnapshot(undefined, { store })).status === 'newer-schema'
        ? ok("a snapshot from a newer ARC is refused as 'newer-schema', never installed")
        : bad('newer-schema refusal');
    }

    // And a snapshot sealed under a DIFFERENT key reads as 'bad-key' — the cue
    // for the recovery-code entry.
    {
      const otherKey = Uint8Array.from(randomBytes(32));
      const foreign = sealBackup(otherKey, fill(256, 5), {
        createdAt: new Date().toISOString(),
        userVersion: 1,
        random: (n) => Uint8Array.from(randomBytes(n)),
      });
      store.writeBytesAtomic(CURRENT_SNAPSHOT, foreign);
      (await restoreFromSnapshot(undefined, { store })).status === 'bad-key'
        ? ok("a snapshot under another key is 'bad-key' — the recovery-code cue")
        : bad('bad-key arm');
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
    raw.close();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
