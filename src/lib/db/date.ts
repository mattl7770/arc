/**
 * "Today" as a local-calendar `YYYY-MM-DD` string — the shape `daily_logs.date`
 * stores. Deliberately local, not UTC: a day boundary should match the wall
 * clock where the user is, so a 11pm entry lands on today, not tomorrow. (When
 * a real user timezone lands in `users.timezone`, this is where it plugs in.)
 */
export function todayISODate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The UTC instant range `[startUtc, endUtc)` covering the *local* calendar day
 * that `now` falls in. Tables keyed by a local `date` column (daily_logs,
 * wearable_data) filter on that column directly; `body_metrics` only stores a
 * UTC `measured_at`, so it's filtered against these bounds instead of relying on
 * SQLite's `'localtime'` modifier (which would read the machine timezone and
 * make the headless tests non-deterministic).
 */
export function localDayUtcRange(now: Date = new Date()): { startUtc: string; endUtc: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { startUtc: start.toISOString(), endUtc: end.toISOString() };
}

/** Local wall-clock "HH:MM" for an ISO-8601 UTC instant — the Log feed's time column. */
export function clockFromISO(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
