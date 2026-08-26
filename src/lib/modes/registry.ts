/**
 * The FROZEN remnant of the Modes feature — REMOVED 2026-08-25 (owner call;
 * ADR in docs/decisions.md, retirement migration 0043).
 *
 * Modes (Normal/Travel/Sick/Deload/Social/Custom) shipped as `day_modes`
 * (0026) plus a six-entry behavior registry here: drop-types, injected items,
 * a hero directive, Coach tone, and excused-skip accounting. The owner used it
 * on hardware and twice judged it thin ("the modes switcher right now doesn't
 * do much", 2026-08-09; still thin after the lever-wiring pass, 2026-08-10),
 * and on 2026-08-25 called for removal. The mission generator, the Home
 * control, the Coach's set_mode tool and the turn-context Mode line are gone.
 *
 * What CANNOT go is history: `day_modes` rows already on the device still
 * decide how PAST days are judged — the reports adherence ledger excuses a
 * skip that landed under Sick/Travel/Social, and the "What changed" ledger
 * names mode runs. Deleting those semantics would silently rewrite verdicts
 * on days the owner already lived. So this file keeps, verbatim and frozen,
 * the two facts per retired key that judgment needs: its label and whether it
 * excused skips. Migration 0043 ends mode coverage at the removal date, so no
 * day AFTER removal can resolve to anything but Normal; every day before it
 * reads exactly as it always did.
 *
 * Still pure and DB-free, asserted headlessly in db/modes.test.mjs.
 */

/** The six retired mode keys — the `day_modes.mode` CHECK vocabulary (0026). */
export type ModeKey = 'normal' | 'travel' | 'sick' | 'deload' | 'social' | 'custom';

/** What historical judgment needs to know about a retired mode — nothing more. */
export type RetiredModeDefinition = {
  label: string;
  /** Were skipped mission items EXCUSED (the right call), not counted as misses? */
  excusesSkips: boolean;
};

/**
 * Frozen from the registry as it shipped: Travel/Sick/Social excused skips;
 * Normal/Deload/Custom did not (a deload was still a plan to execute). These
 * values must NEVER change — they are the judgment past days were lived under.
 */
const RETIRED_MODES: Record<ModeKey, RetiredModeDefinition> = {
  normal: { label: 'Normal', excusesSkips: false },
  travel: { label: 'Travel', excusesSkips: true },
  sick: { label: 'Sick', excusesSkips: true },
  deload: { label: 'Deload', excusesSkips: false },
  social: { label: 'Social', excusesSkips: true },
  custom: { label: 'Custom', excusesSkips: false },
};

/** The frozen definition for a historical mode key (Normal for an unknown key). */
export function getModeDefinition(mode: ModeKey): RetiredModeDefinition {
  return RETIRED_MODES[mode] ?? RETIRED_MODES.normal;
}

/**
 * How a day's skips are JUDGED under its historical mode — the concrete meaning
 * of `excusesSkips`, consumed by the reports adherence ledger
 * (src/lib/reports/assemble-self-review.ts).
 *
 * Under Sick, Travel or Social a skipped item was the right call, so it counts
 * as `excused` and never as `missed`; under Normal, Deload or Custom a skip is
 * a miss. `note` is the one line a surface may state this in, and is null
 * whenever there is nothing to say.
 */
export type DayAccounting = {
  /** Skips that were the right call under this mode — not misses. */
  excused: number;
  /** Skips still counted against the day. */
  missed: number;
  /** One line for a ledger; null when the mode has nothing to add. */
  note: string | null;
};

export function accountForDay(mode: ModeKey, counts: { skipped: number }): DayAccounting {
  const def = getModeDefinition(mode);
  // A negative or fractional count is a caller bug; clamp so the copy can never
  // read "-1 skipped" on a report.
  const skipped = Math.max(0, Math.trunc(counts.skipped));
  if (!def.excusesSkips) return { excused: 0, missed: skipped, note: null };
  return {
    excused: skipped,
    missed: 0,
    note: skipped === 0 ? null : `${skipped} skipped · excused under ${def.label}`,
  };
}
