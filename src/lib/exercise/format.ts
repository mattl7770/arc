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
 * What to call a session in a list, now that sessions have no names (owner,
 * 2026-08-14: *"Workouts dont need names, remove this"*).
 *
 * The movements are the answer: "Lat Pulldown · Barbell Row · Seated Cable Row"
 * says what the session WAS, which a typed name only approximated and a
 * generated one ("Session 14") would have faked outright. Three movements is
 * the width budget on a 375pt screen; a fourth and beyond become "+2 more" so
 * the line stays honest about being a summary rather than silently truncating.
 *
 * A session with no movements — cardio, mobility, a duration-only log — falls
 * back to its kind label, which is the whole truth about it.
 */
export function sessionTitle(session: RecentSession): string {
  const shown = session.movements.slice(0, 3);
  if (shown.length === 0) return KIND_LABEL[session.kind];
  const rest = session.movements.length - shown.length;
  return rest > 0 ? `${shown.join(' · ')} +${rest} more` : shown.join(' · ');
}

/**
 * The session detail line: "18 sets · 52 min", either half alone, or the kind
 * label when a session has neither (numbers stay sans here — they sit inside
 * prose, the sanctioned exception to the mono rule).
 *
 * An away session says so, last (0055). A past session whose numbers read low
 * and does not say WHY is the confusion the flag exists to remove, and the list
 * is where the owner meets those numbers again weeks later. It is appended
 * rather than prefixed because it qualifies the session, it does not name it —
 * and it survives the `parts.length === 0` branch, so a duration-less cardio
 * session logged away still carries the mark.
 */
export function sessionDetail(session: RecentSession): string {
  const parts: string[] = [];
  if (session.setCount > 0) {
    parts.push(`${session.setCount} ${session.setCount === 1 ? 'set' : 'sets'}`);
  }
  if (session.durationMin != null) parts.push(`${Math.round(session.durationMin)} min`);
  if (parts.length === 0) parts.push(KIND_LABEL[session.kind]);
  if (session.away) parts.push('Away gym');
  return parts.join(' · ');
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

// ---------------------------------------------------------------------------
// Time and distance (0046) — hand-rolled, because Hermes ships no Intl
// ---------------------------------------------------------------------------

/**
 * Seconds a user typed into a `mm:ss` field, or null.
 *
 * TOLERANT, because a number pad on iOS has no colon and this field therefore
 * takes the full `numbers-and-punctuation` keyboard, where the user can type
 * anything:
 *
 *   "45:00"    → 2700   the intended form
 *   "45:0"     → 2700   a half-typed second
 *   "1:05:30"  → 3930   h:mm:ss, tolerated rather than rejected
 *   "90"       →   90   NO COLON MEANS SECONDS — "60" on a plank is a minute,
 *                       which is what someone holding a plank means by it
 *   "5:"       →  300   trailing colon, mid-typing
 *
 * Returns null for anything with a non-numeric part, so the caller can leave
 * the field alone rather than correcting it under the cursor. Minutes and
 * seconds are NOT range-checked (":90" is 90 seconds): the schema's own
 * `duration_sec < 36000` bound is the only limit, and it is checked at save.
 */
export function parseClock(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parts = trimmed.split(':');
  if (parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    // An empty segment is a colon the user has typed but not filled ("5:").
    const n = part === '' ? 0 : Number(part);
    if (!Number.isFinite(n) || n < 0) return null;
    total = total * 60 + n;
  }
  return Math.round(total);
}

/** Metres per display unit — the only two distance units ARC offers. */
const M_PER_KM = 1000;
const M_PER_MI = 1609.344;

const distanceFactor = (units: UnitPreferences): number =>
  units.distance === 'km' ? M_PER_KM : M_PER_MI;

/** Canonical metres → a number in the user's distance unit, 2dp. */
export function displayDistance(metres: number, units: UnitPreferences): number {
  return Math.round((metres / distanceFactor(units)) * 100) / 100;
}

/** A distance the user typed, in their unit → canonical metres. */
export function toCanonicalMetres(value: number, units: UnitPreferences): number {
  return value * distanceFactor(units);
}

/** Canonical metres → "5.2 km" / "3.1 mi" (trailing zeros trimmed). */
export function formatDistance(metres: number, units: UnitPreferences): string {
  return `${displayDistance(metres, units)} ${units.distance}`;
}

/**
 * Pace as "4:35 /km" or "7:22 /mi", from seconds per KILOMETRE (how
 * `PersonalRecords.bestPaceSecPerKm` stores it) rendered in the user's own
 * unit. Rounded to the second — nobody reads a pace to a tenth.
 */
export function formatPace(secPerKm: number, units: UnitPreferences): string {
  const perUnit = units.distance === 'km' ? secPerKm : secPerKm * (M_PER_MI / M_PER_KM);
  return `${formatClock(Math.round(perUnit))} /${units.distance}`;
}

/**
 * One set as a single mono line, in whatever it actually measured: "8 × 135 lb",
 * "1:30", "26:40 · 5.2 km", "60 lb · 0.04 km". The em-dash is the honest answer
 * for a set that recorded nothing.
 *
 * Order follows the canonical measure order (reps, load, time, distance) — the
 * same order the logger draws its columns in — with reps × load kept as the one
 * compound form, because "8 × 135 lb" is how a lift is read aloud and splitting
 * it would be worse.
 */
export function measuredSetLine(
  set: {
    reps: number | null;
    weightKg: number | null;
    durationSec: number | null;
    distanceM: number | null;
  },
  units: UnitPreferences
): string {
  const parts: string[] = [];
  const lift = setLineKg(set.reps, set.weightKg, units);
  if (lift !== '—') parts.push(lift);
  if (set.durationSec != null) parts.push(formatClock(set.durationSec));
  if (set.distanceM != null) parts.push(formatDistance(set.distanceM, units));
  return parts.length > 0 ? parts.join(' · ') : '—';
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
