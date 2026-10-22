/**
 * The Calendar switch in Settings › Coach (2026-10-21, docs/decisions.md
 * "Calendar context to the model"): whether the Coach may see the next 7 days
 * of the phone's calendar events.
 *
 * **Off** unless he turned it on (`=== true`, the caffeine cut-off's reading:
 * a new category of personal data reaching the model is his choice, never a
 * default). One boolean in the preferences blob, so no migration.
 *
 * This is the ONLY calendar-related thing ARC ever writes to the database. The
 * events themselves are read fresh from iOS and held in memory for a few
 * minutes (src/lib/calendar/context.ts); no row, cache table or log line ever
 * holds a title, a time or a place.
 */
import type { Database } from '../database';
import { getOrCreateUser } from './user';

const PREF_KEY = 'calendar';

function parsePreferences(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // a corrupt blob reads as defaults
  }
  return {};
}

/** Whether the Coach may read the calendar. */
export function getCalendarContextOn(db: Database): boolean {
  const section = parsePreferences(getOrCreateUser(db).preferences)[PREF_KEY];
  return (
    !!section &&
    typeof section === 'object' &&
    !Array.isArray(section) &&
    (section as Record<string, unknown>).coachSees === true
  );
}

/** Write the switch, preserving every other preference; returns what is stored. */
export function setCalendarContextOn(db: Database, on: boolean): boolean {
  const user = getOrCreateUser(db);
  const preferences = parsePreferences(user.preferences);
  preferences[PREF_KEY] = { coachSees: on === true };
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(preferences), user.id]);
  return on === true;
}
