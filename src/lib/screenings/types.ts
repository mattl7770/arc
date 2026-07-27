/**
 * Types for the Screenings slice — row shapes mirroring db/migrations/
 * 0007_screenings.sql plus the view-models the screens consume.
 *
 * These live here (not in src/lib/db/types.ts) by the parallel-work
 * convention: several slices are being built at once, and the integrator
 * reconciles the shared type file afterwards. Keep the `Row` types in
 * lockstep with the migration, same as db/types.ts does for 0001.
 */
import type { DateString, Timestamp } from '@/lib/db/types';

/** screenings.category — text + CHECK in the schema. */
export type ScreeningCategory =
  'imaging' | 'bloodwork' | 'exam' | 'dental' | 'vision' | 'derm' | 'cardio' | 'other';

/** appointments.status — text + CHECK in the schema. */
export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled';

/** One `screenings` row, as a SELECT returns it. */
export type ScreeningRow = {
  id: string;
  name: string;
  category: ScreeningCategory;
  interval_months: number | null;
  last_completed: DateString | null;
  next_due: DateString | null;
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** One `appointments` row, as a SELECT returns it. */
export type AppointmentRow = {
  id: string;
  title: string;
  provider: string | null;
  /** ISO-8601 UTC instant (built from the local wall-clock the user picked). */
  scheduled_at: Timestamp;
  location: string | null;
  status: AppointmentStatus;
  screening_id: string | null;
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/**
 * Input for creating or fully updating a screening. `nextDue` is an explicit
 * override (a doctor's told-you date); when absent, the repository derives
 * next_due from lastCompleted + intervalMonths, or stores NULL (untracked).
 */
export type ScreeningInput = {
  name: string;
  category: ScreeningCategory;
  /** Cadence in whole months (12 = yearly, 120 = decennial); null = one-off. */
  intervalMonths?: number | null;
  lastCompleted?: DateString | null;
  nextDue?: DateString | null;
  notes?: string | null;
};

/** Input for creating or fully updating an appointment (status is set apart). */
export type AppointmentInput = {
  title: string;
  provider?: string | null;
  /** ISO-8601 UTC instant. */
  scheduledAt: Timestamp;
  location?: string | null;
  screeningId?: string | null;
  notes?: string | null;
};

/** Where a screening stands relative to today — dueScreenings' verdict. */
export type DueStatus = 'overdue' | 'due';

/** A due/overdue screening, as Home's "what's due" surfacing will consume it. */
export type DueScreening = ScreeningRow & { dueStatus: DueStatus };

/** An upcoming appointment with its linked screening's name for display. */
export type UpcomingAppointment = AppointmentRow & { screening_name: string | null };
