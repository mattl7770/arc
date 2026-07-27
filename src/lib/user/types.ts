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

export interface Preferences {
  units: UnitPreferences;
}

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

export const DEFAULT_PREFERENCES: Preferences = {
  units: DEFAULT_UNIT_PREFERENCES,
};
