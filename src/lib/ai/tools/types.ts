/**
 * The Coach tool contract — how the model's function calls become repository
 * calls (docs/ai-coach.md, "Tool set").
 *
 * Every tool is a pure description + an execute over the {@link Database}
 * interface, so the registry is headless-testable against node:sqlite
 * (db/coach-tools.test.mjs) and knows nothing about the model client or UI.
 * `readOnly` is the safety pivot: the service layer runs read tools freely and
 * routes every write through the user-confirmation gate before execute runs.
 *
 * Input arrives as whatever JSON the model produced — never trust its shape.
 * The `parse` helpers below validate and throw plain Errors; the agentic loop
 * turns a throw into an `is_error` tool result, which the model sees and can
 * correct. Bad input must never reach a repository.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';

export type CoachToolContext = {
  /**
   * The clock for ONE tool call — injectable so headless tests are
   * deterministic, and read exactly once per call by the service layer
   * (src/lib/ai/coach-service.ts) so {@link CoachTool.confirmSummary} and
   * {@link CoachTool.execute} cannot disagree about what time it is.
   */
  now: Date;
};

export type CoachTool = {
  /** Wire name the model calls, snake_case. */
  name: string;
  /** Wire description — prescriptive about WHEN to call, not just what it does. */
  description: string;
  /** JSON Schema for the input (the wire `input_schema`). */
  inputSchema: Record<string, unknown>;
  /** Read tools run freely; writes go through the user-confirmation gate. */
  readOnly: boolean;
  /**
   * Writes only: the one human line the confirmation card shows
   * ("Log weight 178.0 lb"). Built from validated input; `db` is available so
   * an id-shaped input can be resolved to what it actually names — the user
   * must never approve a bare identifier blind.
   *
   * `context` is the SAME {@link CoachToolContext} instance {@link execute}
   * gets — the service layer reads the clock once per tool call and passes that
   * one object to both halves. That matters because some writes derive part of
   * what they store from `now`: set_reminder pins the day of a bare-time
   * one-off, which is tomorrow once that clock time has gone by. A card built
   * off a different instant than the row is exactly how "at 09:00" gets
   * approved and a row dated tomorrow lands.
   *
   * REQUIRED, not optional. It was optional once, to spare call sites that
   * passed only `(input, db)` — and the single real call site then quietly kept
   * doing that, so the clock-sharing this parameter exists for never happened.
   * Requiring it makes rendering a card without the turn clock a type error.
   * A summary that doesn't need the clock simply omits the parameter.
   *
   * The same shared clock is what lets a summary VALIDATE. A knowable failure —
   * a log date in the future — must
   * throw HERE, judged against the same instant execute will use, rather than
   * costing the user an Approve tap on a write that can only error.
   */
  confirmSummary?: (
    input: Record<string, unknown>,
    db: Database,
    context: CoachToolContext
  ) => string;
  /**
   * Run the tool against the on-device database. Returns the tool_result
   * content (JSON), or a Promise of it — most tools are synchronous SQL, but a
   * few (e.g. search_knowledge, which embeds the query on-device) are async.
   * The service layer awaits either. Throws / rejects on invalid input or
   * repository failure.
   */
  execute: (
    db: Database,
    input: Record<string, unknown>,
    context: CoachToolContext
  ) => string | Promise<string>;
};

// --- Input validation helpers ------------------------------------------------

export function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Tool input must be a JSON object.');
  }
  return input as Record<string, unknown>;
}

export function reqString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`"${key}" must be a non-empty string.`);
  }
  return value.trim();
}

export function optString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new Error(`"${key}" must be a string.`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function reqNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`"${key}" must be a finite number.`);
  }
  return value;
}

export function optNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`"${key}" must be a finite number.`);
  }
  return value;
}

export function optEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const value = input[key];
  if (value == null) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`"${key}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

export function reqEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T {
  const value = optEnum(input, key, allowed);
  if (value === undefined) throw new Error(`"${key}" must be one of: ${allowed.join(', ')}.`);
  return value;
}

/** "HH:MM", 24-hour, with real clock values (the DB GLOB only checks shape). */
export function optTime(input: Record<string, unknown>, key: string): string | undefined {
  const value = optString(input, key);
  if (value === undefined) return undefined;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error(`"${key}" must be a 24-hour "HH:MM" time, e.g. "21:00".`);
  }
  return value;
}

/** "YYYY-MM-DD", and a real calendar day — "2026-13-45" must not reach the DB
 * (its GLOB CHECK is shape-only and would happily store an inert value). */
export function optDate(input: Record<string, unknown>, key: string): string | undefined {
  const value = optString(input, key);
  if (value === undefined) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  const roundTrips =
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
  if (!roundTrips) {
    throw new Error(`"${key}" must be a real "YYYY-MM-DD" calendar date.`);
  }
  return value;
}

/**
 * A "YYYY-MM-DD" that must not be in the future — the shape every log
 * backdate takes. A future date (the model mis-parsing "next Tuesday", a
 * typo'd year) would poison every trend window it lands in, so it is rejected
 * with a message the model can correct from. `now` is the turn's clock
 * (CoachToolContext.now), so tests stay deterministic.
 */
export function optPastDate(
  input: Record<string, unknown>,
  key: string,
  now: Date
): string | undefined {
  const value = optDate(input, key);
  if (value === undefined) return undefined;
  const today = todayISODate(now);
  if (value > today) {
    throw new Error(
      `"${key}" (${value}) is in the future — logs record what already happened. ` +
        `Today is ${today}; pass a past date or omit "${key}" for today.`
    );
  }
  return value;
}

/** Days-window argument, defaulted and clamped so a wild value can't scan years. */
export function daysWindow(
  input: Record<string, unknown>,
  fallback: number,
  max: number = 365
): number {
  const days = optNumber(input, 'days');
  if (days === undefined) return fallback;
  if (!Number.isInteger(days) || days < 1) throw new Error('"days" must be a positive integer.');
  return Math.min(days, max);
}
