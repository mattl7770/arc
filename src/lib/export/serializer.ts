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
 * assertScalar) — so the day a BLOB column lands, the export (and the tripwire
 * in db/export.test.mjs) demands an explicit decision instead of writing a
 * corrupted file. Reads are synchronous on a single connection, so the snapshot
 * is consistent without a transaction.
 *
 * The ONE thing enumeration must not swallow is a VIRTUAL table: the sqlite-vec
 * `vec0` index (`vec_chunks`, created lazily on device by
 * src/lib/db/repositories/rag.ts) plus the shadow tables SQLite materialises
 * under it hold packed float BLOBs, so a naive `SELECT *` over sqlite_master
 * would hit assertScalar and break export permanently the first time RAG runs.
 * They are therefore excluded by construction ({@link partitionTables}) and
 * named in the envelope, never silently dropped. Nothing of value is lost:
 * vectors are DERIVED — re-embeddable from the exported knowledge_chunks /
 * memory_chunks text — which is exactly why they, and not the chunk text, are
 * the part that may be left behind.
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
  /**
   * Tables deliberately left out: virtual tables and their shadow tables (the
   * `vec0` vector index). Recorded rather than silently dropped, so anyone
   * reading the file can see exactly what is NOT in it. `[]` until RAG has run
   * on device. Their content is derived and rebuildable — see the file header.
   */
  omittedTables: string[];
  tables: Record<string, Record<string, Scalar>[]>;
}

/** The candidate set: every table except SQLite's own `sqlite_*` internals. */
const USER_TABLES_SQL =
  "SELECT name, sql FROM sqlite_master WHERE type = 'table' " +
  "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name";

/**
 * The engine's OWN classification of each table (SQLite >= 3.37). `type` is
 * 'table' | 'view' | 'virtual' | 'shadow', decided by the loaded module rather
 * than by us guessing from a name.
 */
const TABLE_LIST_SQL =
  "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type IN ('virtual', 'shadow')";

/**
 * A virtual table, identified from its own stored DDL. sqlite_master.sql holds
 * the CREATE statement as written (minus `IF NOT EXISTS`, which SQLite strips),
 * so this matches whatever module made it — vec0, fts5, rtree — without a
 * hardcoded name list. Shadow tables do NOT match: their stored sql is a plain
 * `CREATE TABLE`, which is the whole reason a second rule is needed below.
 */
const CREATE_VIRTUAL_TABLE = /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i;

type SchemaRow = { name: string; sql: string | null };

export interface TablePartition {
  /** Real tables, alphabetical — what actually gets dumped. */
  exported: string[];
  /** Virtual + shadow tables, alphabetical — what is skipped, and reported. */
  omitted: string[];
}

/**
 * Split sqlite_master's tables into "dump this" and "skip this", using THREE
 * independent signals so no single engine assumption can break the export:
 *
 *  1. `CREATE VIRTUAL TABLE` in the table's own sqlite_master.sql — catches the
 *     virtual table itself on any engine, any SQLite version, no module
 *     cooperation required.
 *  2. SQLite's own shadow-table NAMING rule: a shadow table is `<vtab>_<suffix>`
 *     for some virtual table `<vtab>`. This is not a guess — it is the rule
 *     sqlite3ShadowTableName() applies for defensive mode, and it is what
 *     sqlite-vec follows (`vec_chunks` ⇒ `vec_chunks_chunks`,
 *     `vec_chunks_rowids`, `vec_chunks_vector_chunks00`, `vec_chunks_info`, …).
 *     Shadow rows look like ordinary tables in sqlite_master, so signal 1 alone
 *     would miss them — and they are the ones holding the BLOBs.
 *  3. `pragma_table_list.type` — the engine's own verdict, cross-checking 1+2.
 *     Wrapped in try/catch: it needs SQLite >= 3.37 and can be compiled out, and
 *     it depends on the module implementing xShadowName, so it is a bonus rather
 *     than the foundation. op-sqlite ships a modern SQLite and will answer it;
 *     if anything ever doesn't, 1+2 still stand on their own.
 *
 * Signals 1+2 are pure sqlite_master reads, which is why this is correct on
 * op-sqlite and not merely on node:sqlite (whose build has no vec0 at all).
 * The accepted ambiguity is SQLite's own: a REAL table literally named
 * `<vtab>_something` would be treated as a shadow. Nothing in the schema is
 * (`knowledge_chunks` / `memory_chunks` do not start with `vec_chunks_`), and
 * signal 2 lies dormant until a virtual table actually exists.
 */
export function partitionTables(db: Database): TablePartition {
  const rows = db.all<SchemaRow>(USER_TABLES_SQL);
  const known = new Set(rows.map((row) => row.name));
  const omitted = new Set<string>();

  // (1) The virtual tables themselves.
  const virtuals: string[] = [];
  for (const row of rows) {
    if (typeof row.sql === 'string' && CREATE_VIRTUAL_TABLE.test(row.sql)) {
      omitted.add(row.name);
      virtuals.push(row.name);
    }
  }

  // (2) Their shadow tables, by SQLite's `<vtab>_<suffix>` rule.
  if (virtuals.length > 0) {
    for (const row of rows) {
      if (omitted.has(row.name)) continue;
      const isShadow = virtuals.some(
        (vtab) => row.name.length > vtab.length + 1 && row.name.startsWith(`${vtab}_`)
      );
      if (isShadow) omitted.add(row.name);
    }
  }

  // (3) The engine's own classification, where the engine offers one.
  try {
    for (const row of db.all<{ name: string }>(TABLE_LIST_SQL)) {
      if (known.has(row.name)) omitted.add(row.name);
    }
  } catch {
    // Pre-3.37 or introspection pragmas compiled out — (1)+(2) already suffice.
  }

  return {
    exported: rows.map((row) => row.name).filter((name) => !omitted.has(name)),
    omitted: [...omitted].sort(),
  };
}

/**
 * Every REAL user table in the database, alphabetical. Excludes SQLite's own
 * internals (sqlite_sequence etc.) and virtual/shadow tables ({@link
 * partitionTables}) — reference/seed tables are included on purpose: an export
 * should restore to a working dataset, not a partial one.
 */
export function listExportTables(db: Database): string[] {
  return partitionTables(db).exported;
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
  const { exported, omitted } = partitionTables(db);
  const tables: Record<string, Record<string, Scalar>[]> = {};
  for (const name of exported) {
    tables[name] = readAllRows(db, name);
  }
  return {
    format: 'arc-export',
    formatVersion: 1,
    exportedAt: meta.exportedAt,
    appVersion: meta.appVersion ?? null,
    schemaVersion: schemaVersion(db),
    omittedTables: omitted,
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
