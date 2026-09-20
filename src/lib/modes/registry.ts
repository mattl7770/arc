/**
 * **The frozen mode registry — history only. Nothing writes a mode any more.**
 *
 * Modes were retired on 2026-09-19 (migration 0061, docs/spikes/coach-status-
 * buttons-modes-retirement.md). What replaced them is `day_statuses` plus the
 * Coach: a status records the FACT the user states about himself, and what to
 * do about it is the model's call on the day, through gated writes. See
 * src/lib/db/repositories/statuses.ts.
 *
 * ## Why this file still exists
 *
 * `day_modes` and every row in it stay forever, because they decide how PAST
 * days were judged. Changing that would silently rewrite verdicts on days
 * already lived — a fortnight the owner correctly rested through would start
 * reading as a fortnight he failed. So one thing about a mode is still needed,
 * and only one: **did it excuse the day's skips?**
 *
 * That is `excusesSkips`, read by `excusedDatesIn`
 * (src/lib/db/repositories/mission.ts) as one of three reasons a day can be
 * excused, and `label`, read by the surfaces that have to NAME the reason
 * beside a count.
 *
 * ## What went, and why it is not coming back
 *
 * The other four levers — `dropTypes`, `addItems`, `heroFocus`, `coachTone` —
 * were the actual defect. Sick dropped every `workout` row and injected
 * "Immune support — Vitamin D, zinc"; Deload injected "cut training volume
 * ~40%". Clinical decisions as constants, against the standing rule that the
 * deterministic layer detects, grounds and routes attention and never decides
 * the response (docs/ai-coach.md). The owner's verdict on the built thing was
 * *"the modes switcher right now doesn't do much"*, and it was mechanically so:
 * a mode produced the standard list minus the workout.
 *
 * One asymmetry is preserved exactly as it stood, because it is the whole
 * argument in miniature: **Deload did not excuse.** A deload is a plan you are
 * still meant to execute. The new system keeps the rule as doctrine (a deload
 * is a PLAN change, never a status) and as a per-status `excuses` flag the
 * Coach sets — the owner's Q2(b).
 *
 * Still pure and DB-free: no React, no SQLite, no clock.
 */

/** The six keys `day_modes.mode` is CHECKed against. Closed forever. */
export type ModeKey = 'normal' | 'travel' | 'sick' | 'deload' | 'social' | 'custom';

/** Everything a retired mode still has to answer about a day it covered. */
export type ModeDefinition = {
  key: ModeKey;
  /** How a surface names it beside a count: "3 excused · Travel". */
  label: string;
  /** Were skipped mission items EXCUSED (the right call), not counted as misses? */
  excusesSkips: boolean;
};

const MODES: Record<ModeKey, ModeDefinition> = {
  normal: { key: 'normal', label: 'Normal', excusesSkips: false },
  travel: { key: 'travel', label: 'Travel', excusesSkips: true },
  sick: { key: 'sick', label: 'Sick', excusesSkips: true },
  // NOT a mistake and not an oversight: a deload is a plan you are still meant
  // to execute, so a skip under it was always a miss. db/data-trends.test.mjs
  // §13d is the control case.
  deload: { key: 'deload', label: 'Deload', excusesSkips: false },
  social: { key: 'social', label: 'Social', excusesSkips: true },
  custom: { key: 'custom', label: 'Custom', excusesSkips: false },
};

/** The definition for a mode key (defaults to Normal for an unknown key). */
export function getModeDefinition(mode: ModeKey): ModeDefinition {
  return MODES[mode] ?? MODES.normal;
}
