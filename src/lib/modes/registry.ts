/**
 * The Modes registry (docs/information-architecture.md §Modes) — the concrete
 * behavior of each mode, in one pure, DB-free table so the mission generator,
 * the Coach, and the Home control all read one definition.
 *
 * A mode changes four things (the spec): the PLAN (which mission items appear —
 * `dropTypes` removes generated items of a type, `addItems` injects standard
 * ones), PRIORITIES (`heroFocus`), the Coach's TONE (`coachTone`, surfaced to
 * the model via get_today_snapshot), and ADHERENCE (`excusesSkips` — a skip
 * under an excusing mode is the right call, not a miss).
 */
import type { LogEntryType } from '@/lib/db/types';

export type ModeKey = 'normal' | 'travel' | 'sick' | 'deload' | 'social' | 'custom';

export const MODE_KEYS: readonly ModeKey[] = [
  'normal',
  'travel',
  'sick',
  'deload',
  'social',
  'custom',
];

/** A standard mission item a mode injects into the day. */
export type ModeItem = {
  title: string;
  type: LogEntryType;
  scheduledTime?: string | null;
  why?: string;
};

export type ModeDefinition = {
  key: ModeKey;
  label: string;
  /** One line for the Home indicator / mode picker. */
  tagline: string;
  /** Generated protocol items of these types are DROPPED for the day. */
  dropTypes: LogEntryType[];
  /** Standard items this mode ADDS to the day's mission. */
  addItems: ModeItem[];
  /** What the "Do this next" hero should push under this mode. */
  heroFocus: string;
  /** Tone guidance shown to the Coach (via get_today_snapshot) under this mode. */
  coachTone: string;
  /** Are skipped mission items EXCUSED (the right call), not counted as misses? */
  excusesSkips: boolean;
};

const MODES: Record<ModeKey, ModeDefinition> = {
  normal: {
    key: 'normal',
    label: 'Normal',
    tagline: 'Standard plan',
    dropTypes: [],
    addItems: [],
    heroFocus: '',
    coachTone: '',
    excusesSkips: false,
  },
  travel: {
    key: 'travel',
    label: 'Travel',
    tagline: 'Adjust to the new time zone',
    dropTypes: [],
    addItems: [
      {
        title: 'Morning light + move',
        type: 'habit',
        scheduledTime: '07:00',
        why: 'Anchor circadian rhythm to local time',
      },
      { title: 'Hydrate extra', type: 'habit', why: 'Flights + new climate dehydrate' },
    ],
    heroFocus: 'Adjust to the new time zone: morning light, movement, extra fluids.',
    coachTone:
      'Travel mode: favor circadian adjustment and portable habits. A missed gym session is not a miss — do not nag about it.',
    excusesSkips: true,
  },
  sick: {
    key: 'sick',
    label: 'Sick',
    tagline: 'Recover — rest, fluids, sleep',
    dropTypes: ['workout'],
    addItems: [
      { title: 'Rest — no training today', type: 'habit', why: 'Recovery beats training when ill' },
      { title: 'Extra fluids', type: 'habit', why: 'Hydration supports recovery' },
      { title: 'Immune support', type: 'supplement', why: 'Vitamin D, zinc, prioritize sleep' },
    ],
    heroFocus: 'Recover: sleep, fluids, rest. No training today.',
    coachTone:
      'Sick mode: recovery talk only. NEVER nag about the missed workout — resting is the right call. Watch for symptoms worsening and flag if a doctor is warranted.',
    excusesSkips: true,
  },
  deload: {
    key: 'deload',
    label: 'Deload',
    tagline: 'Lighter training, full recovery',
    dropTypes: [],
    addItems: [
      {
        title: 'Deload — cut training volume ~40%',
        type: 'habit',
        why: 'Planned lower load lets adaptation catch up',
      },
    ],
    heroFocus: 'Lighter training, full recovery — the deload IS the work.',
    coachTone:
      'Deload mode: frame the reduced volume as the plan, not slacking. Encourage keeping intensity light and sleep high.',
    excusesSkips: false,
  },
  social: {
    key: 'social',
    label: 'Social',
    tagline: 'Eat earlier, hydrate, cap it',
    dropTypes: [],
    addItems: [
      { title: 'Eat earlier', type: 'habit', why: 'Protect sleep + glucose' },
      { title: 'Hydrate between drinks', type: 'habit', why: 'Pace and rehydrate' },
      { title: 'Cap it', type: 'habit', why: 'Decide the limit up front' },
    ],
    heroFocus: 'Eat earlier, hydrate between drinks, cap it — not macros tonight.',
    coachTone:
      'Social mode: harm-reduction, not adherence guilt. Give practical guardrails, never lecture about a broken diet.',
    excusesSkips: true,
  },
  custom: {
    key: 'custom',
    label: 'Custom',
    tagline: 'Your own context',
    dropTypes: [],
    addItems: [],
    heroFocus: '',
    coachTone:
      'Custom mode: the user set their own context for today — ask what it means if unclear.',
    excusesSkips: false,
  },
};

/** The definition for a mode key (defaults to Normal for an unknown key). */
export function getModeDefinition(mode: ModeKey): ModeDefinition {
  return MODES[mode] ?? MODES.normal;
}

/** True if `mode` reshapes the day at all (Normal / an empty Custom do not). */
export function modeChangesPlan(mode: ModeKey): boolean {
  const def = getModeDefinition(mode);
  return def.dropTypes.length > 0 || def.addItems.length > 0;
}
