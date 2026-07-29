/**
 * Whole-database export serialization — the "easy export" half of the
 * data-ownership non-negotiable (CLAUDE.md §2), pure and headless.
 *
 * Everything here depends only on the {@link Database} interface, so the same
 * code runs on device and against node:sqlite in db/export.test.mjs. The dump
 * is GENERIC — tables are enumerated from sqlite_master, not hand-listed — so
 * a new migration's tables ride along automatically and the export can never
 * silently fall behind the schema. "Never silently" is enforced, not assumed:
 * every value must be a JSON-safe scalar or the export FAILS LOUD (see
 * assertScalar) — so the day a BLOB column or a sqlite-vec vec0 table lands,
 * the export (and the tripwire in db/export.test.mjs) demands an explicit
 * decision instead of writing a corrupted file. Reads are synchronous on a
 * single connection, so the snapshot is consistent without a transaction.
 *
 * Format: one JSON document, every table as an array of row objects, plus
 * enough envelope (schema version, format version, timestamp) for a future
 * importer to know exactly what it is holding. JSON over CSV-per-table was
 * deliberate: SQLite's types survive (null vs '' stays unambiguous), and the
 * share sheet hands off ONE file — CSV-per-table needs a zip step to be
 * portable, which can ride a later build on top of this same serializer.
 */
import type { Database, Scalar } from '@/lib/db/database';

export interface ArcExport {
  format: 'arc-export';
  /** Bump when the envelope shape changes, so an importer can branch. */
  formatVersion: 1;
  /** ISO-8601 moment the export was taken (caller-supplied, keeps this pure). */
  exportedAt: string;
  /** App version that wrote the export, or null off-device. */
  appVersion: string | null;
  /** The DB's PRAGMA user_version — which migrations the tables reflect. */
  schemaVersion: number;
  tables: Record<string, Record<string, Scalar>[]>;
}

/**
 * Every user table in the database, alphabetical. Excludes only SQLite's own
 * internals (sqlite_sequence etc.) — reference/seed tables are included on
 * purpose: an export should restore to a working dataset, not a partial one.
 */
export function listExportTables(db: Database): string[] {
  return db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
    )
    .map((row) => row.name);
}

/** Names come from sqlite_master, but quote anyway so odd names can't break SQL. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Refuse any value JSON.stringify would corrupt instead of round-tripping:
 * BLOBs become `{}`, Infinity/NaN become `null`, BigInt throws cryptically —
 * all silent (or opaque) data loss in the one feature whose whole job is
 * fidelity. The schema is scalar-only today (no blob columns; enforced by a
 * tripwire in db/export.test.mjs), so this throwing means a migration changed
 * that without teaching the exporter — fail the export loudly (the UI shows
 * 'failed' with this message) rather than ship a lying file.
 */
function assertScalar(value: unknown, table: string, column: string): Scalar {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(
    `export: unsupported value in ${table}.${column} (${typeof value}) — ` +
      'the serializer only round-trips SQLite text/integer/real/null'
  );
}

/**
 * All rows of one table, in rowid (insertion) order so exports are
 * deterministic and diffable. Falls back to engine order for any future
 * WITHOUT ROWID table rather than failing the whole export. Every value is
 * checked JSON-safe ({@link assertScalar}) on the way through.
 */
export function readAllRows(db: Database, table: string): Record<string, Scalar>[] {
  let rows: Record<string, Scalar>[];
  try {
    rows = db.all(`SELECT * FROM ${quoteIdent(table)} ORDER BY rowid`);
  } catch {
    rows = db.all(`SELECT * FROM ${quoteIdent(table)}`);
  }
  for (const row of rows) {
    for (const [column, value] of Object.entries(row)) {
      assertScalar(value, table, column);
    }
  }
  return rows;
}

/** The DB's PRAGMA user_version (0 on a virgin database). */
export function schemaVersion(db: Database): number {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  return row ? Number(row.user_version) : 0;
}

/** Assemble the full export document. Pure given the db + metadata. */
export function buildExport(
  db: Database,
  meta: { exportedAt: string; appVersion?: string | null }
): ArcExport {
  const tables: Record<string, Record<string, Scalar>[]> = {};
  for (const name of listExportTables(db)) {
    tables[name] = readAllRows(db, name);
  }
  return {
    format: 'arc-export',
    formatVersion: 1,
    exportedAt: meta.exportedAt,
    appVersion: meta.appVersion ?? null,
    schemaVersion: schemaVersion(db),
    tables,
  };
}

/** The document as pretty-printed JSON — the exact bytes written to disk. */
export function serializeExport(document: ArcExport): string {
  return JSON.stringify(document, null, 2);
}

/**
 * Filename for an export taken at `exportedAt` (ISO-8601):
 * `arc-export-20260729-143308.json`. Second precision — a same-second re-run
 * overwrites, which for identical content is the right dedupe.
 */
export function exportFileName(exportedAt: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(exportedAt);
  if (!match) return 'arc-export.json';
  const [, y, mo, d, h, mi, s] = match;
  return `arc-export-${y}${mo}${d}-${h}${mi}${s}.json`;
}
