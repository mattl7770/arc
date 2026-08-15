/**
 * The user profile + preferences data layer.
 *
 * ARC is single-user, so `users` is a one-row profile (no auth, no user_id
 * tenancy — see the 2026-07-24 local-first ADR). This repo owns reading/creating
 * that row and reading/writing the `preferences` JSON blob. Unit preferences are
 * display-only (storage stays canonical SI), so nothing here converts values —
 * it just records the user's chosen units for the render layer to honour.
 *
 * Depends only on the {@link Database} interface — never op-sqlite — so the same
 * code runs on device and against node:sqlite in db/user.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { BiologicalSex, UserRow } from '../types';
import type { AppLockPreferences, Preferences, UnitPreferences } from '@/lib/user/types';
import { DEFAULT_UNIT_PREFERENCES } from '@/lib/user/types';

/**
 * The single profile row, creating a default one on first access. Deterministic
 * pick (oldest, then id) so a stray second row can never make this flip-flop.
 */
export function getOrCreateUser(db: Database): UserRow {
  const existing = db.get<UserRow>('SELECT * FROM users ORDER BY created_at, id LIMIT 1');
  if (existing) return existing;
  const id = newId(db);
  db.run('INSERT INTO users (id) VALUES (?)', [id]);
  // Read back so the caller gets the DB-applied defaults (timezone, preferences,
  // timestamps), not a hand-built partial.
  const created = db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  if (!created) throw new Error('user row vanished immediately after insert');
  return created;
}

export interface ProfileUpdate {
  fullName?: string | null;
  dateOfBirth?: string | null;
  biologicalSex?: BiologicalSex | null;
  timezone?: string;
}

/**
 * Patch the profile. Only the keys present in `update` change; the rest keep
 * their current values. The DB CHECKs (biological_sex vocabulary, date_of_birth
 * shape) still guard bad input, and the AFTER UPDATE trigger restamps updated_at.
 */
export function updateProfile(db: Database, update: ProfileUpdate): void {
  const user = getOrCreateUser(db);
  const fullName = update.fullName !== undefined ? update.fullName : user.full_name;
  const dob = update.dateOfBirth !== undefined ? update.dateOfBirth : user.date_of_birth;
  const sex = update.biologicalSex !== undefined ? update.biologicalSex : user.biological_sex;
  const tz = update.timezone !== undefined ? update.timezone : user.timezone;
  db.run(
    `UPDATE users SET full_name = ?, date_of_birth = ?, biological_sex = ?, timezone = ? WHERE id = ?`,
    [fullName, dob, sex, tz, user.id]
  );
}

/** Parse the preferences column into a plain object, tolerant of junk/empty. */
function parseObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to an empty object — a corrupt blob reads as defaults
  }
  return {};
}

/** One stored unit choice, or the default when absent/unrecognised. */
function pickUnit<K extends keyof UnitPreferences>(
  units: Record<string, unknown>,
  key: K,
  allowed: readonly UnitPreferences[K][]
): UnitPreferences[K] {
  const value = units[key];
  return allowed.includes(value as UnitPreferences[K])
    ? (value as UnitPreferences[K])
    : DEFAULT_UNIT_PREFERENCES[key];
}

function readUnits(obj: Record<string, unknown>): UnitPreferences {
  const raw = readSection(obj, 'units');
  return {
    weight: pickUnit(raw, 'weight', ['lb', 'kg']),
    distance: pickUnit(raw, 'distance', ['mi', 'km']),
    volume: pickUnit(raw, 'volume', ['oz', 'ml']),
    length: pickUnit(raw, 'length', ['in', 'cm']),
    temperature: pickUnit(raw, 'temperature', ['F', 'C']),
  };
}

/** One nested preference object (`units`, `appLock`, …), or {} when absent/junk. */
function readSection(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = obj[key];
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function readAppLock(obj: Record<string, unknown>): AppLockPreferences {
  // Strict `=== true` so a corrupt/foreign value can only ever read as
  // disabled — the lock never turns itself on by accident.
  return { enabled: readSection(obj, 'appLock').enabled === true };
}

/** The user's preferences, normalised (every field present) from the JSON blob. */
export function getPreferences(db: Database): Preferences {
  const user = getOrCreateUser(db);
  const obj = parseObject(user.preferences);
  return { units: readUnits(obj), appLock: readAppLock(obj) };
}

/**
 * Whether Apple Health ingestion is enabled (Settings › Apple Health). A user
 * choice, so it lives in the preferences blob beside units — machine cursor
 * state (last-synced) lives in `health_sync_state` (0021) instead.
 */
export function isHealthSyncEnabled(db: Database): boolean {
  const obj = parseObject(getOrCreateUser(db).preferences);
  const health =
    obj.health && typeof obj.health === 'object' && !Array.isArray(obj.health)
      ? (obj.health as Record<string, unknown>)
      : {};
  return health.syncEnabled === true;
}

/** Flip the Apple Health toggle, preserving unrelated preference keys. */
export function setHealthSyncEnabled(db: Database, enabled: boolean): void {
  const user = getOrCreateUser(db);
  const obj = parseObject(user.preferences);
  const health =
    obj.health && typeof obj.health === 'object' && !Array.isArray(obj.health)
      ? (obj.health as Record<string, unknown>)
      : {};
  obj.health = { ...health, syncEnabled: enabled };
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(obj), user.id]);
}

/**
 * The daily hydration goal in canonical **ml**, or `null` when the user has
 * never set one — which is the default, and stays the default.
 *
 * **There is no stock target and there must not be one.** A denominator the user
 * did not choose turns every honest reading into a manufactured verdict: an
 * invented "2,000 ml" would print a percentage, a progress bar and an implied
 * failure out of a number ARC made up (00-design-spec.md §5, and the same
 * refusal `recent-logs.tsx` records for macros). Until a goal exists the water
 * screen shows the total and no denominator at all.
 *
 * It lives in the preferences blob rather than in a table because it is a single
 * durable thing the user *sets* — the same category as unit choices and the app
 * lock, and the same shape as the `health` section written just above, which is
 * likewise not on the `Preferences` type. That is deliberately NOT what
 * `nutrition_targets` (0015) is: macro targets are versioned and immutable so a
 * past day can be judged against the era it was lived in. A hydration goal here
 * is a live setting, so raising it re-judges the history against the new number.
 * For one user reading their own record that is the more useful reading, and it
 * costs no migration — but it is a real trade-off and is flagged as such in
 * docs/project-status.md.
 */
export function getWaterTarget(db: Database): number | null {
  const obj = parseObject(getOrCreateUser(db).preferences);
  const value = readSection(obj, 'goals').waterMl;
  // Strict: only a finite positive number is a goal. A junk or zero value reads
  // as "no goal", never as a target of zero — which would make every day a win.
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Set or clear (`null`) the daily hydration goal, preserving unrelated keys. */
export function setWaterTarget(db: Database, ml: number | null): void {
  const user = getOrCreateUser(db);
  const obj = parseObject(user.preferences);
  const next = ml !== null && Number.isFinite(ml) && ml > 0 ? ml : null;
  obj.goals = { ...readSection(obj, 'goals'), waterMl: next };
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(obj), user.id]);
}

/**
 * Set one unit preference and persist. Merges into the existing blob (unknown
 * preference keys are preserved), and returns the normalised result.
 */
export function setUnitPreference<K extends keyof UnitPreferences>(
  db: Database,
  key: K,
  value: UnitPreferences[K]
): Preferences {
  const user = getOrCreateUser(db);
  const obj = parseObject(user.preferences);
  obj.units = { ...readSection(obj, 'units'), [key]: value };
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(obj), user.id]);
  return { units: readUnits(obj), appLock: readAppLock(obj) };
}

/**
 * Turn the app lock on or off and persist. Merges into the existing blob
 * (unit choices and unknown keys are preserved), and returns the normalised
 * result. Whether the device can actually authenticate is the caller's check
 * (src/lib/security/app-lock.ts) — this layer just records the choice.
 */
export function setAppLockEnabled(db: Database, enabled: boolean): Preferences {
  const user = getOrCreateUser(db);
  const obj = parseObject(user.preferences);
  obj.appLock = { ...readSection(obj, 'appLock'), enabled };
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(obj), user.id]);
  return { units: readUnits(obj), appLock: readAppLock(obj) };
}
