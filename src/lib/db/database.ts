/**
 * The minimal database surface repositories depend on — a tiny interface, not
 * op-sqlite directly, so the same repository code runs against op-sqlite on
 * device (src/lib/db/client.ts) and against node:sqlite in the headless tests
 * (db/data-layer.test.mjs). Nothing in this file imports op-sqlite, so it's
 * safe to import from either world.
 */

/** A value bindable to a positional `?` placeholder. Booleans are stored 0|1. */
export type Scalar = string | number | null;

export interface Database {
  /** Run a statement for its effect (INSERT/UPDATE/DELETE/DDL). */
  run(sql: string, params?: Scalar[]): void;
  /** Return every matching row. */
  all<T = Record<string, Scalar>>(sql: string, params?: Scalar[]): T[];
  /** Return the first matching row, or undefined. */
  get<T = Record<string, Scalar>>(sql: string, params?: Scalar[]): T | undefined;
  /** Run `fn` inside a transaction; on throw, roll back and rethrow. */
  transaction(fn: () => void): void;
}
