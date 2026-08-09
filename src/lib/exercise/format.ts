/**
 * Pure display helpers for the Exercise screens — unit conversion and the
 * little formatted lines. DB-free so both the UI and the headless tests can
 * import it.
 *
 * Storage is canonical kg (0003_exercise.sql, matching body_metrics); the UI
 * shows lb today, same as the metric registry's weight descriptor, so the
 * future Settings unit toggle stays a display concern.
 */
import { BAR_KG, WARMUP_MIN_WORK_MULTIPLE, WARMUP_RAMP } from './constants';
import type { RecentSession, SetType, WorkoutKind } from './types';
import { metricByKey, resolveDisplay, roundToSpec, type DisplaySpec } from '@/lib/log/metrics';
import type { UnitPreferences } from '@/lib/user/types';

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
 * Hand-rolled month/weekday names, indexed to match `getDay()` (Sunday-first)
 * and `getMonth()`.
 *
 * Hermes ships without Intl, so `toLocaleDateString(undefined, {...})` silently
 * ignores its options object on device and returns a different shape than the
 * web preview shows — which is how a "Mon" column turns into a full date string
 * on a real iPhone. Same reason, same fix as src/components/home/date-eyebrow.tsx
 * (and src/lib/ai/tools/write-tools.ts, src/hooks/use-data-overview.ts).
 */
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

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
  const when = parseLocalDate(date);
  if (diffDays > 1 && diffDays < 7) {
    return WEEKDAY_SHORT[when.getDay()] ?? '';
  }
  return `${MONTH_SHORT[when.getMonth()] ?? ''} ${when.getDate()}`;
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

// ---------------------------------------------------------------------------
// Unit-aware display (0011+): the training screens render canonical-kg loads
// through the app's unit preference (lb/kg) via the metric registry, so the
// Settings toggle reaches the training domain too. Storage stays kg.
// ---------------------------------------------------------------------------

/** The weight metric's display spec for the current unit preference. */
export function weightSpec(units: UnitPreferences): DisplaySpec {
  // metricByKey('weight') is a static registry entry — always present.
  return resolveDisplay(metricByKey('weight')!, units);
}

/** Canonical kg → a rounded display number in the user's weight unit. */
export function displayWeight(kg: number, units: UnitPreferences): number {
  const spec = weightSpec(units);
  return roundToSpec(spec, spec.fromCanonical(kg));
}

/** Canonical kg → "135 lb" / "61 kg" (trailing ".0" trimmed). */
export function formatWeight(kg: number, units: UnitPreferences): string {
  const spec = weightSpec(units);
  const n = roundToSpec(spec, spec.fromCanonical(kg));
  const text = Number.isInteger(n) ? String(n) : n.toFixed(spec.decimals);
  return `${text} ${spec.unit}`;
}

/** A display-unit weight the user typed → canonical kg to store. */
export function toCanonicalKg(displayWeightValue: number, units: UnitPreferences): number {
  return weightSpec(units).toCanonical(displayWeightValue);
}

/**
 * Snap a canonical-kg load to the nearest weight the user can actually load,
 * rounding in their display unit (5 lb, i.e. a plate pair; or 2.5 kg) then
 * converting back. Keeps generated warmups/targets on real plate math.
 */
export function snapLoadKg(kg: number, units: UnitPreferences): number {
  const spec = weightSpec(units);
  const step = spec.unit === 'kg' ? 2.5 : 5;
  const display = spec.fromCanonical(kg);
  const snapped = Math.round(display / step) * step;
  return spec.toCanonical(snapped);
}

/** One set as reps × display-weight for the current unit: "8 × 135 lb". */
export function setLineKg(
  reps: number | null,
  weightKg: number | null,
  units: UnitPreferences
): string {
  const w = weightKg == null ? null : formatWeight(weightKg, units);
  if (reps != null && w != null) return `${reps} × ${w}`;
  if (reps != null) return `${reps} ${reps === 1 ? 'rep' : 'reps'}`;
  if (w != null) return w;
  return '—';
}

/** Short caps tag for a non-normal set type (warmup/failure/drop); '' for normal. */
export function setTypeTag(setType: SetType): string {
  switch (setType) {
    case 'warmup':
      return 'W';
    case 'failure':
      return 'F';
    case 'drop':
      return 'D';
    default:
      return '';
  }
}

/** "2:14" mm:ss from whole seconds (rest timer, timed sets). */
export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Warmup ramp for a working weight (canonical kg): a bar set plus the percentage
 * ladder, each load snapped to real plates. Empty when the working weight is
 * too light to warrant it (< 1.5× the bar) — bodyweight/isolation don't ramp.
 */
export function warmupSets(
  workingKg: number,
  units: UnitPreferences
): { weightKg: number; reps: number }[] {
  if (!Number.isFinite(workingKg) || workingKg < BAR_KG * WARMUP_MIN_WORK_MULTIPLE) return [];
  const out = [{ weightKg: BAR_KG, reps: 5 }];
  for (const step of WARMUP_RAMP) {
    const snapped = snapLoadKg(workingKg * step.pct, units);
    if (snapped > BAR_KG && snapped < workingKg) out.push({ weightKg: snapped, reps: step.reps });
  }
  return out;
}
