/**
 * User profile + preferences view types.
 *
 * Preferences live in `users.preferences` (a JSON text column, 0001_init.sql) —
 * no dedicated table, no migration. Unit preferences are DISPLAY-only: storage
 * stays canonical SI (weight kg, waist cm, water ml — see src/lib/log/metrics.ts),
 * so switching lb↔kg / mi↔km / etc. never touches the database, only rendering.
 */

export type WeightUnit = 'lb' | 'kg';
export type DistanceUnit = 'mi' | 'km';
export type VolumeUnit = 'oz' | 'ml';
export type LengthUnit = 'in' | 'cm';
export type TemperatureUnit = 'F' | 'C';

export interface UnitPreferences {
  weight: WeightUnit;
  distance: DistanceUnit;
  volume: VolumeUnit;
  length: LengthUnit;
  temperature: TemperatureUnit;
}

export interface AppLockPreferences {
  /**
   * Require Face ID / device passcode on cold start and on return to the
   * foreground after a timeout. The lock is the security boundary of a
   * no-accounts app (CLAUDE.md §2) — but it's opt-in, so it defaults off.
   */
  enabled: boolean;
}

export interface Preferences {
  units: UnitPreferences;
  appLock: AppLockPreferences;
}

/**
 * Which way the user is deliberately moving — the fact that decides whether a
 * day over the calorie target is a fault or the point (C7, owner call
 * 2026-09-14: *"exceeding my calorie goal is a good thing"*).
 *
 * It qualifies the numbers in `nutrition_targets` without living in them: a
 * live preference, not a versioned row, so changing it re-judges past days
 * against today's direction. That is the same trade the hydration goal already
 * takes (the docblock above `getWaterTarget`), with one addition — a direction
 * changes far less often than the numbers it qualifies, and when it does change
 * the user is usually also changing the numbers, which writes a new target
 * version anyway.
 *
 * Deliberately NOT derived from the kcal target against TDEE: ARC has no TDEE,
 * and inventing one is the "no data, no number" breach
 * (docs/design-research/implementation/00-design-spec.md §5).
 */
export type GoalDirection = 'cut' | 'maintain' | 'gain';

/** Chip order on the targets screen: deficit → level → surplus, left to right. */
export const GOAL_DIRECTIONS: readonly GoalDirection[] = ['cut', 'maintain', 'gain'];

/**
 * The no-change default. `maintain`'s calorie bands are exactly the symmetric
 * ones the pillar graded with before C7, so someone who never opens the setting
 * sees the goal-direction half of that change do nothing at all.
 */
export const DEFAULT_GOAL_DIRECTION: GoalDirection = 'maintain';

/**
 * Defaults match the display units the metric registry ships today (lb / oz /
 * in), so a fresh profile renders exactly as it does now until the user flips a
 * toggle. Imperial-leaning because the owner is US-based.
 */
export const DEFAULT_UNIT_PREFERENCES: UnitPreferences = {
  weight: 'lb',
  distance: 'mi',
  volume: 'oz',
  length: 'in',
  temperature: 'F',
};

export const DEFAULT_APP_LOCK_PREFERENCES: AppLockPreferences = {
  enabled: false,
};

export const DEFAULT_PREFERENCES: Preferences = {
  units: DEFAULT_UNIT_PREFERENCES,
  appLock: DEFAULT_APP_LOCK_PREFERENCES,
};
