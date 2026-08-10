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
 *
 * ## 2026-08-09 — making the other three levers do something
 *
 * Owner feedback on hardware: "the modes switcher right now doesn't do much."
 * Correct, and mechanically so. Of the five levers only `dropTypes` and
 * `addItems` reached the screen; `heroFocus` was read exclusively by the Coach
 * snapshot, and `excusesSkips` was a fact reported to the model and to nobody
 * else. Worse, the injected items mostly carried NO `scheduledTime`, and
 * src/lib/home/derive-mission.ts sorts an untimed item to
 * `MAX_SAFE_INTEGER` — so Sick's "Rest — no training today" landed at the
 * BOTTOM of the day, under the 21:00 magnesium, and the hero still led with a
 * protocol item. Switching to Sick produced the standard list minus the
 * workout, which is exactly what the feedback describes.
 *
 * Three changes, all here:
 *
 *   1. **Every `addItems` entry now carries a `scheduledTime`**, chosen for when
 *      the instruction actually applies, so mode items interleave into the day
 *      instead of piling up as an appendix. The consequence that matters is the
 *      hero: Sick/Travel/Deload lead at 07:00, ahead of anything a protocol
 *      schedules, so "do this next" becomes the mode's own instruction the
 *      moment the mode is set. Social deliberately does NOT — a night out bends
 *      the evening, not the morning, and claiming otherwise would be a lie the
 *      user can see. This is enforced by a test rather than left to care:
 *      an untimed mode item is a regression, not a style choice.
 *   2. {@link modeDirective} — `heroFocus` as one sentence any surface can lead
 *      with, with a `tagline` fallback so it is never empty for a mode that is
 *      on. Home renders it above the hero (components/home/mode-control.tsx →
 *      `ModeBanner`); the Coach keeps reading the raw field.
 *   3. {@link accountForDay} — `excusesSkips` turned into an actual count. A
 *      skip under Sick/Travel/Social is EXCUSED and is stated as such on Home,
 *      so the day is judged differently rather than merely described
 *      differently to the model.
 *
 * Still pure and DB-free: no React, no SQLite, no clock. Everything here is a
 * value or a function of values, which is why db/modes.test.mjs can assert on
 * it headlessly.
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

/**
 * A standard mission item a mode injects into the day.
 *
 * `scheduledTime` is REQUIRED, not optional. It used to be optional and mostly
 * omitted, which quietly sank every mode item to the bottom of the mission —
 * see the header. Requiring it makes the omission a type error instead of a
 * layout surprise, and forces the author of a new mode to answer the question
 * that actually matters: when in the day does this instruction apply?
 */
export type ModeItem = {
  title: string;
  type: LogEntryType;
  /** 'HH:MM'. Where the item sits in the day's one chronological list. */
  scheduledTime: string;
  why?: string;
};

export type ModeDefinition = {
  key: ModeKey;
  label: string;
  /** One line for the Home indicator / mode picker. */
  tagline: string;
  /** Generated protocol items of these types are DROPPED for the day. */
  dropTypes: LogEntryType[];
  /**
   * Standard items this mode ADDS to the day's mission, authored in the order
   * they occur. The EARLIEST is the mode's lead — when it beats every protocol
   * item on the clock it becomes the hero, which is how a mode takes over "do
   * this next" without any surface having to special-case it.
   */
  addItems: ModeItem[];
  /**
   * The one sentence the day should lead with under this mode — rendered on
   * Home above the hero and handed to the Coach as `heroFocus`. Empty for modes
   * that have no opinion (Normal, Custom); read it through
   * {@link modeDirective}, which falls back to the tagline.
   */
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
        // 07:00 leads the day: the circadian anchor is the first thing that
        // matters on a travel day, and it has to beat the protocol items to the
        // hero slot for the mode to be the thing you see.
        scheduledTime: '07:00',
        why: 'Anchor circadian rhythm to local time',
      },
      {
        title: 'Hydrate extra',
        type: 'habit',
        scheduledTime: '13:00',
        why: 'Flights and an unfamiliar climate both dehydrate',
      },
      {
        title: 'Find dinner that works',
        type: 'meal',
        scheduledTime: '19:00',
        why: 'Unfamiliar food environment — decide before you are hungry',
      },
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
      {
        title: 'Rest — no training today',
        type: 'habit',
        // Deliberately the earliest item on a Sick day. Rest is the
        // INSTRUCTION, not the absence of one, so it has to hold the hero slot
        // rather than sit at the bottom of the list as an afterthought.
        scheduledTime: '07:00',
        why: 'Recovery beats training when ill — this is the work today',
      },
      {
        title: 'Extra fluids',
        type: 'habit',
        scheduledTime: '11:00',
        why: 'Hydration supports recovery',
      },
      {
        title: 'Immune support',
        type: 'supplement',
        scheduledTime: '20:00',
        why: 'Vitamin D, zinc, and an early night',
      },
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
        // 07:00 so the instruction is set before the session, not discovered
        // after it. Deload drops VOLUME, not training, so the protocol's own
        // workout deliberately stays on the list (dropTypes is empty) and this
        // item tells you how to run it.
        scheduledTime: '07:00',
        why: 'Same sessions, ~40% less volume — planned lower load lets adaptation catch up',
      },
      {
        title: 'Sleep — protect the full window',
        type: 'habit',
        scheduledTime: '22:00',
        why: 'Adaptation happens in the recovery, not the session',
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
    // Social is the one mode that does NOT take the 07:00 lead. A night out
    // bends the evening, not the morning: until ~17:30 the day is the normal
    // day, and claiming otherwise on the hero would be visibly false. The mode
    // still announces itself in the banner from the moment it is set.
    addItems: [
      {
        title: 'Eat earlier',
        type: 'habit',
        scheduledTime: '17:30',
        why: 'Protect sleep and glucose — eat before, not after',
      },
      {
        title: 'Hydrate between drinks',
        type: 'habit',
        scheduledTime: '20:00',
        why: 'Pace and rehydrate',
      },
      {
        title: 'Cap it',
        type: 'habit',
        scheduledTime: '22:00',
        why: 'Decide the limit up front, not at the bar',
      },
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

/**
 * The one sentence today leads with under `mode` — `heroFocus`, falling back to
 * the tagline so a mode that is ON always has something to say, and empty
 * string for Normal (which has no opinion and should render nothing).
 *
 * This exists so `heroFocus` stops being Coach-only. It was previously read by
 * exactly one caller, `get_today_snapshot`, which meant the single most visible
 * thing a mode could do — change what the day leads with — happened only inside
 * a chat the user might never open.
 */
export function modeDirective(mode: ModeKey): string {
  const def = getModeDefinition(mode);
  if (def.key === 'normal') return '';
  return def.heroFocus || def.tagline;
}

/**
 * How today's skips are JUDGED under `mode` — the concrete meaning of
 * `excusesSkips`.
 *
 * Under Sick, Travel or Social a skipped item is the right call, so it is
 * counted as `excused` and never as `missed`; under Normal or Deload a skip is
 * a miss, because a deload is still a plan you are meant to execute. `note` is
 * the line Home states this in, and is null whenever there is nothing to say —
 * either the mode does not excuse, or nothing was skipped.
 *
 * Pure and count-based (no rows, no dates) so it can be asserted directly and
 * reused by any surface that judges a day.
 */
export type DayAccounting = {
  /** Skips that are the right call under this mode — not misses. */
  excused: number;
  /** Skips still counted against the day. */
  missed: number;
  /** One line for Home; null when the mode has nothing to add. */
  note: string | null;
};

export function accountForDay(mode: ModeKey, counts: { skipped: number }): DayAccounting {
  const def = getModeDefinition(mode);
  // A negative or fractional count is a caller bug; clamp so the copy can never
  // read "-1 skipped" on the owner's home screen.
  const skipped = Math.max(0, Math.trunc(counts.skipped));
  if (!def.excusesSkips) return { excused: 0, missed: skipped, note: null };
  return {
    excused: skipped,
    missed: 0,
    note: skipped === 0 ? null : `${skipped} skipped · excused under ${def.label}`,
  };
}
