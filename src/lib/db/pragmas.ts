/**
 * The connection-level pragmas ARC's schema depends on, in one place so the app
 * connection (src/lib/db/client.ts) and every headless harness apply exactly
 * the same set. Extracting it is what makes a device-only regression catchable:
 * if the app's open path ever dropped FK enforcement, a test that routes through
 * this helper fails, rather than the mistake surfacing only on a phone (the
 * suites each set the pragma themselves otherwise, so they would stay green).
 *
 * SQLite defaults foreign_keys OFF, and the schema relies on FK enforcement:
 * deleting a protocol NULLs log_entries.protocol_id (ON DELETE SET NULL, which
 * preserves execution history), and deleting a lab_report CASCADEs to its
 * lab_results. Both are silent no-ops without this pragma.
 *
 * recursive_triggers is deliberately left at its default OFF — the updated_at
 * triggers depend on that (see 0001_init.sql). Never enable it.
 *
 * `exec` is passed in rather than a concrete handle so the one helper serves
 * op-sqlite's executeSync on device and node:sqlite's exec in the tests.
 */
export function applyConnectionPragmas(exec: (sql: string) => void): void {
  exec('PRAGMA foreign_keys = ON');
}
