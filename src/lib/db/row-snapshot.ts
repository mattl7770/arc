/**
 * A row read whole before it is deleted, and put back exactly — the idiom an
 * Undo stands on outside food logging (2026-09-25: a catalog food, and each
 * capture on the Log tab).
 *
 * It is the pair `takeRows` / `putRow` in src/lib/db/repositories/nutrition.ts,
 * over the tables that Undo does not reach, and it keeps the same three
 * promises:
 *
 * - **Every column, verbatim.** The same id, the same figures, the same
 *   `created_at` — which is the order key of every list these rows appear in,
 *   so a capture put back sits at the time it was logged, not at the time of
 *   the Undo.
 * - **The same `rowid` where it is still free.** It is the tie-break the
 *   publish walks and the water list order by (a row inserted during the
 *   window may have taken it: SQLite without AUTOINCREMENT hands out
 *   max(rowid)+1). Without it the row still lands with its own `created_at`.
 * - **Column names come from the row the database returned**, never from
 *   input, and are quoted.
 *
 * An INSERT fires no `AFTER UPDATE` trigger, so a row put back carries its own
 * `updated_at` too. Nothing here decides WHETHER a row may come back; the
 * repository that took it says that.
 */
import type { Database, Scalar } from './database';

/** A row exactly as it stood: every column, and its `rowid`. */
export type SnapshotRow = { __rowid: number } & Record<string, Scalar>;

/** The tables whose removals are taken this way. */
export type SnapshotTable = 'foods' | 'log_entries' | 'wearable_data' | 'body_metrics' | 'symptoms';

/** Every row matching `where`, every column plus its `rowid`, in `rowid` order. */
export function snapshotRows(
  db: Database,
  table: SnapshotTable,
  where: string,
  params: Scalar[]
): SnapshotRow[] {
  return db.all<SnapshotRow>(
    `SELECT rowid AS __rowid, * FROM ${table} WHERE ${where} ORDER BY rowid`,
    params
  );
}

/** Re-insert one snapshot row verbatim. Throws what the INSERT throws. */
export function restoreRow(db: Database, table: SnapshotTable, row: SnapshotRow): void {
  const { __rowid, ...columns } = row;
  const names = Object.keys(columns);
  const values: Scalar[] = names.map((name) => columns[name] ?? null);
  const free =
    db.get<{ one: number }>(`SELECT 1 AS one FROM ${table} WHERE rowid = ?`, [__rowid]) ===
    undefined;
  const list = names.map((name) => `"${name.replace(/"/g, '""')}"`);
  const all = free ? ['rowid', ...list] : list;
  const params = free ? [__rowid, ...values] : values;
  db.run(
    `INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`,
    params
  );
}
