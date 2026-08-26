/**
 * Display helpers for the Protocols screens — the human labels for the
 * `protocols.type` vocabulary (the text + CHECK enum in 0001_init.sql), for the
 * cadence vocabulary (content schema 2), and for where a protocol is up to in
 * its phases.
 *
 * All hand-rolled string building: Hermes has no `Intl`, so nothing here may
 * reach for it (same constraint as src/lib/experiments/format.ts).
 */
import type { ProtocolType } from '@/lib/db/types';

import { WEEKDAY_LABELS } from './cadence';
import type { PhaseState } from './phase';
import type { Cadence, ProtocolContent } from './types';

/** Every schema type, in the order the editor's chips present them. */
export const PROTOCOL_TYPES: { type: ProtocolType; label: string }[] = [
  { type: 'daily_routine', label: 'Daily routine' },
  { type: 'supplement_stack', label: 'Supplement stack' },
  { type: 'meal_template', label: 'Meal template' },
  { type: 'training_block', label: 'Training block' },
  { type: 'therapy_protocol', label: 'Therapy' },
  { type: 'sleep_protocol', label: 'Sleep' },
  { type: 'other', label: 'Other' },
];

export function protocolTypeLabel(type: ProtocolType): string {
  return PROTOCOL_TYPES.find((t) => t.type === type)?.label ?? type;
}

const MONTHS_SHORT = [
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
];

/** "2026-08-01" → "1 Aug". Split on '-', never `new Date(string)` (UTC-shift trap). */
export function shortDate(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  if (!m || !d) return date;
  return `${d} ${MONTHS_SHORT[m - 1] ?? '?'}`;
}

/**
 * How a cadence reads on screen. Sentence-shaped, unlike `cadenceText`'s terse
 * round-trippable form, because these are read by a person on a row rather than
 * parsed by a model.
 */
export function cadenceLabel(cadence: Cadence): string {
  switch (cadence.kind) {
    case 'daily':
      return 'Every day';
    case 'weekdays':
      return cadence.days.length === 0
        ? 'No days chosen'
        : cadence.days.map((d) => WEEKDAY_LABELS[d - 1] ?? '?').join(' · ');
    case 'every_n_days':
      return `Every ${cadence.n} days`;
    case 'quota':
      return cadence.per_week === 7 ? 'Every day' : `${cadence.per_week}× a week`;
  }
}

/** The shortest honest form, for a dense row: "daily", "3×/wk", "Mon Wed Fri". */
export function cadenceShort(cadence: Cadence): string {
  switch (cadence.kind) {
    case 'daily':
      return 'daily';
    case 'weekdays':
      return cadence.days.length === 0
        ? 'no days'
        : cadence.days.map((d) => WEEKDAY_LABELS[d - 1] ?? '?').join(' ');
    case 'every_n_days':
      return `every ${cadence.n}d`;
    case 'quota':
      return `${cadence.per_week}×/wk`;
  }
}

/**
 * One line summarising what a whole protocol asks of a week — "daily",
 * "3×/wk", or "mixed" once its items disagree. Null for a protocol with no
 * items: there is no frequency to state and inventing one would be furniture.
 */
export function contentCadenceSummary(content: ProtocolContent): string | null {
  const items = content.phases.flatMap((p) => p.items);
  if (items.length === 0) return null;
  const forms = new Set(items.map((item) => cadenceShort(item.cadence)));
  return forms.size === 1 ? [...forms][0]! : 'mixed';
}

/** Days as the unit a person would say: "28 days" reads better as "4 weeks". */
export function durationLabel(days: number): string {
  if (days % 7 === 0 && days >= 7) {
    const weeks = days / 7;
    return weeks === 1 ? '1 week' : `${weeks} weeks`;
  }
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * Where the protocol is up to, in one line — "Phase 2 of 3 · day 4 of 28",
 * "Ended 12 Jul", "Starts 1 Sep". Null when there is exactly one open-ended
 * phase, i.e. when there is no phase story to tell.
 */
export function phaseSummary(state: PhaseState): string | null {
  if (state.kind === 'not_started') return `Starts ${shortDate(state.startsOn)}`;
  if (state.kind === 'ended') return `Ended ${shortDate(state.endedOn)}`;
  const { window, phaseCount } = state;
  const name = window.phase.title ?? `Phase ${window.index + 1}`;
  const where = phaseCount > 1 ? `${name} of ${phaseCount}` : name;
  if (window.length === null) {
    return phaseCount > 1 ? `${where} · day ${window.dayInPhase + 1}` : null;
  }
  return `${where} · day ${window.dayInPhase + 1} of ${window.length}`;
}

/** A rate as a whole percent, or an em-dash when there is no rate to state. */
export function rateText(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

/** "6 weeks", "12 days" — how long a record has been running. */
export function spanLabel(days: number): string {
  if (days <= 0) return 'today';
  if (days < 14) return days === 1 ? '1 day' : `${days} days`;
  return `${Math.floor(days / 7)} weeks`;
}
