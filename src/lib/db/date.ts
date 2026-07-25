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
