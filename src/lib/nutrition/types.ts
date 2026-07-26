/**
 * Types for the Nutrition domain, mirroring db/migrations/0002_nutrition.sql.
 *
 * Kept beside the nutrition feature rather than in src/lib/db/types.ts (the
 * 0001 rows) so parallel schema work doesn't collide in one file; same
 * hand-authored, lockstep-with-the-schema contract. Scalar shapes (Timestamp,
 * DateString…) are shared from the db types.
 */
import type { DataSource, DateString, TimeString, Timestamp } from '@/lib/db/types';

/** A `meals` row as SELECT returns it. */
export type MealRow = {
  id: string;
  date: DateString;
  time: TimeString | null;
  name: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  source: DataSource;
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/**
 * What the app supplies when logging a meal. The id, source ('manual' — the
 * photo/NL path stamps its own when it lands) and timestamps are filled in by
 * the repository / DB defaults. Absent macros store as NULL, never 0 — "not
 * recorded" and "zero grams" are different facts.
 */
export type NewMeal = {
  date: DateString;
  time: TimeString | null;
  name: string;
  kcal?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
  notes?: string | null;
};

/** The day's summed intake for the "Today" card. NULL macros sum as absent. */
export type DayTotals = {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  /** Number of meals logged — lets the UI tell "no meals" from "all zeros". */
  mealCount: number;
};
