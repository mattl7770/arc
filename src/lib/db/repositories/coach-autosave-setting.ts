/**
 * The "Save simple logs at once" switch in Settings › Coach (2026-10-21,
 * docs/decisions.md "Simple logs save at once, with Undo"): whether a simple
 * log the Coach makes in chat — a weight, a supplement taken, a note in his
 * own words — saves without a card, with an Undo under the reply.
 *
 * **On** unless he turned it off (`!== false`): the owner's own default, so a
 * fresh install and a corrupt blob both read ON. Off sends every write back to
 * a card. One boolean in the preferences blob, so no migration — the calendar
 * switch's pattern (calendar-setting.ts).
 *
 * Read by the chat only (coach-service.ts). The unattended pass and an
 * approved proposal never consult it: neither can save anything at once.
 */
import type { Database } from '../database';
import { getOrCreateUser } from './user';

const PREF_KEY = 'coachSaveAtOnce';

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

/** Whether simple logs save at once. */
export function getSaveLogsAtOnce(db: Database): boolean {
  const section = parsePreferences(getOrCreateUser(db).preferences)[PREF_KEY];
  if (!section || typeof section !== 'object' || Array.isArray(section)) return true;
  return (section as Record<string, unknown>).simpleLogs !== false;
}

/** Write the switch, preserving every other preference; returns what is stored. */
export function setSaveLogsAtOnce(db: Database, on: boolean): boolean {
  const user = getOrCreateUser(db);
  const preferences = parsePreferences(user.preferences);
  preferences[PREF_KEY] = { simpleLogs: on !== false };
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(preferences), user.id]);
  return on !== false;
}
