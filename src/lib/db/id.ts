import type { Database } from './database';

/**
 * App-generated primary keys, as RFC-4122 v4 UUID strings.
 *
 * Every id column is `text PRIMARY KEY NOT NULL` with no DB default (see
 * db/migrations/0001_init.sql), so the app supplies an id on every insert.
 *
 * The randomness comes from SQLite's `randomblob` rather than a JS `crypto`
 * global: Hermes has no `crypto`, and Expo's runtime doesn't install one (it
 * polyfills fetch/URL/TextDecoder but not crypto), so `crypto.randomUUID()`
 * would throw at runtime. `randomblob` is CSPRNG-backed, always available in
 * SQLite, and — because id generation only ever happens right before an insert,
 * where a `db` is already in hand — costs one trivial query. It also works
 * identically in the node:sqlite headless tests.
 */
export function newId(db: Database): string {
  const row = db.get<{ hex: string }>('SELECT lower(hex(randomblob(16))) AS hex');
  const h = row!.hex; // 32 lowercase hex chars = 16 random bytes
  // Set the version nibble to 4 and the variant bits to 10xx.
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return (
    h.slice(0, 8) +
    '-' +
    h.slice(8, 12) +
    '-4' +
    h.slice(13, 16) +
    '-' +
    variant +
    h.slice(17, 20) +
    '-' +
    h.slice(20, 32)
  );
}
