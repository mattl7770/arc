/**
 * Pure display helpers for the Exercise screens — unit conversion and the
 * little formatted lines. DB-free so both the UI and the headless tests can
 * import it.
 *
 * Storage is canonical kg (0003_exercise.sql, matching body_metrics); the UI
 * shows lb today, same as the metric registry's weight descriptor, so the
 * future Settings unit toggle stays a display concern.
 */
import type { RecentSession, WorkoutKind } from './types';

/** Keep in lockstep with src/lib/log/metrics.ts (same factor, same reason). */
export const LB_PER_KG = 2.2046226218;

export const lbToKg = (lb: number): number => lb / LB_PER_KG;
export const kgToLb = (kg: number): number => kg * LB_PER_KG;

/** Display label per workout kind (the chip row and the detail-line fallback). */
export const KIND_LABEL: Record<WorkoutKind, string> = {
  strength: 'Strength',
  cardio: 'Cardio',
  mobility: 'Mobility',
  other: 'Session',
};

const parseLocalDate = (date: string): Date => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

/**
 * The "Recent sessions" day column: Today · Yesterday · a short weekday for the
 * rest of the past week · "Jul 12" beyond that. `today` is passed in (from
 * todayISODate) so the whole list renders against one consistent day.
 */
export function dayLabel(date: string, today: string): string {
  if (date === today) return 'Today';
  const diffDays = Math.round(
    (parseLocalDate(today).getTime() - parseLocalDate(date).getTime()) / 86_400_000
  );
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) {
    return parseLocalDate(date).toLocaleDateString(undefined, { weekday: 'short' });
  }
  return parseLocalDate(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The session detail line: "18 sets · 52 min", either half alone, or the kind
 * label when a session has neither (numbers stay sans here — they sit inside
 * prose, the sanctioned exception to the mono rule).
 */
export function sessionDetail(session: RecentSession): string {
  const parts: string[] = [];
  if (session.setCount > 0) {
    parts.push(`${session.setCount} ${session.setCount === 1 ? 'set' : 'sets'}`);
  }
  if (session.durationMin != null) parts.push(`${Math.round(session.durationMin)} min`);
  return parts.length > 0 ? parts.join(' · ') : KIND_LABEL[session.kind];
}

/** "8 × 135 lb", "12 reps", "135 lb" — one draft/stored set, in display units. */
export function setLine(reps: number | null, weightLb: number | null): string {
  if (reps != null && weightLb != null) return `${reps} × ${weightLb} lb`;
  if (reps != null) return `${reps} ${reps === 1 ? 'rep' : 'reps'}`;
  if (weightLb != null) return `${weightLb} lb`;
  return '—';
}
