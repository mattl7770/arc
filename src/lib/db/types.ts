/**
 * Hand-authored row types mirroring db/migrations/0001_init.sql.
 *
 * These replace the retired Supabase generator (`src/types/database.ts`): with
 * an on-device SQLite schema there is nothing to introspect at build time, and
 * hand-authoring keeps the types honest about SQLite's realities — enums are
 * `text` unions, booleans are `0 | 1`, timestamps/dates/times/json are all
 * `string`, and every column the schema leaves nullable is `T | null` here.
 *
 * Keep this file in lockstep with the schema: when a migration changes a table,
 * update the matching type. `Row` types describe what a SELECT returns; inserts
 * are handled per-repository (ids and timestamps are supplied by the app / DB
 * defaults, so insert shapes differ and live next to their queries).
 */

// --- Enum vocabularies (text + CHECK in the schema) --------------------------

export type BiologicalSex = 'male' | 'female' | 'intersex' | 'prefer_not_to_say';

/** Widened by migration 0024 — keep in lockstep with that file's CHECK. */
export type BiomarkerCategory =
  | 'cardiovascular'
  | 'metabolic'
  | 'hormone'
  | 'inflammation'
  | 'nutrient'
  | 'organ'
  | 'immune'
  | 'hematology'
  | 'cancer'
  | 'toxin'
  | 'microbiome'
  | 'biological_age'
  | 'other';

export type DataSource =
  | 'function_pdf'
  | 'manual'
  | 'api'
  | 'device_sync'
  | 'apple_health'
  | 'health_connect'
  | 'terra'
  | 'ai_suggested'
  | 'import';

export type ProtocolType =
  | 'daily_routine'
  | 'supplement_stack'
  | 'meal_template'
  | 'training_block'
  | 'therapy_protocol'
  | 'sleep_protocol'
  | 'other';

export type Authorship = 'user' | 'ai';

export type LogEntryType =
  'habit' | 'meal' | 'workout' | 'supplement' | 'medication' | 'therapy' | 'metric' | 'note';

export type LogEntryStatus = 'pending' | 'completed' | 'skipped' | 'partial';

export type WearableDevice =
  | 'oura'
  | 'whoop'
  | 'ultrahuman'
  | 'apple_watch'
  | 'garmin'
  | 'eight_sleep'
  | 'withings'
  // HealthKit's merged cross-device daily statistic (steps/energy) — no single
  // device exists for these by design (0021; docs/wearables-subapp.md §4).
  | 'apple_health'
  | 'manual'
  | 'other';

// --- Scalar shapes stored as text --------------------------------------------

/** ISO-8601 UTC instant, e.g. "2026-07-24T07:00:00.000Z". */
export type Timestamp = string;
/** "YYYY-MM-DD". */
export type DateString = string;
/** "HH:MM", 24-hour. */
export type TimeString = string;
/** A JSON document stored as text (guarded by json_valid in the schema). */
export type JsonText = string;
/** SQLite boolean: 0 or 1. */
export type SqliteBool = 0 | 1;

// --- Table rows --------------------------------------------------------------

export type UserRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  date_of_birth: DateString | null;
  biological_sex: BiologicalSex | null;
  timezone: string;
  preferences: JsonText;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BiomarkerRow = {
  id: string;
  slug: string;
  name: string;
  category: BiomarkerCategory;
  unit: string | null;
  description: string | null;
  optimal_range_low: number | null;
  optimal_range_high: number | null;
  standard_range_low: number | null;
  standard_range_high: number | null;
  higher_is_better: SqliteBool | null;
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type LabReportRow = {
  id: string;
  source: DataSource;
  collected_at: DateString;
  file_path: string | null;
  raw_extracted_json: JsonText | null;
  parsed_at: Timestamp | null;
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type LabResultRow = {
  id: string;
  biomarker_id: string;
  report_id: string | null;
  value: number;
  collected_at: DateString;
  lab_name: string | null;
  source: DataSource;
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type ProtocolRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: ProtocolType;
  is_active: SqliteBool;
  current_version_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type ProtocolVersionRow = {
  id: string;
  protocol_id: string;
  version_number: number;
  content: JsonText;
  change_notes: string | null;
  created_by: Authorship;
  created_at: Timestamp;
  // No updated_at — versions are immutable by design.
};

export type DailyLogRow = {
  id: string;
  date: DateString;
  summary: string | null;
  overall_adherence_score: number | null;
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type LogEntryRow = {
  id: string;
  daily_log_id: string;
  type: LogEntryType;
  protocol_id: string | null;
  title: string;
  status: LogEntryStatus;
  scheduled_time: TimeString | null;
  completed_at: Timestamp | null;
  value: JsonText | null;
  source: DataSource;
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type WearableDataRow = {
  id: string;
  date: DateString;
  metric_type: string;
  value: number;
  unit: string | null;
  source_device: WearableDevice;
  source_raw_id: string | null;
  start_time: Timestamp | null;
  end_time: Timestamp | null;
  metadata: JsonText;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BodyMetricRow = {
  id: string;
  measured_at: Timestamp;
  weight_kg: number | null;
  body_fat_pct: number | null;
  muscle_mass_kg: number | null;
  bone_mass_kg: number | null;
  visceral_fat_rating: number | null;
  waist_cm: number | null;
  hip_cm: number | null;
  source: DataSource;
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};
