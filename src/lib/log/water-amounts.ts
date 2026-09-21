/**
 * The water quick amounts — **one table, three screens**.
 *
 * Glass / Bottle / Large in the user's DISPLAY unit, as per-unit literals rather
 * than a converted figure: a metric bottle is 500 ml, not the 473 that 16 oz
 * rounds to, and a rounded conversion would log a number the user did not
 * choose.
 *
 * It lives here because three surfaces now offer the same three amounts and they
 * have to agree about what a bottle is:
 *
 *   - `app/water.tsx` — the record's Add block (each amount commits);
 *   - `app/metric-entry.tsx` — the keypad's additive estimates (each amount ADDS
 *     to the readout; the `+` on those faces is load-bearing, and the fact that
 *     they add rather than commit is a property of that screen, not of this
 *     table);
 *   - `src/components/log/quick-add-grid.tsx` — the Log tab's water row, four
 *     cells on the sheet at all times (each commits, like the water screen).
 *     Until 2026-09-21 these were behind a long-press there, which is the bug
 *     the owner reported off device; the table is unchanged, only its visibility.
 *
 * Two copies agreed by luck; a third would not have. The amounts are the only
 * thing shared — every screen keeps its own treatment, its own `+` semantics and
 * its own layout.
 *
 * Pure and DB-free: the caller resolves the user's volume unit
 * (`resolveDisplay(water, units)`) and indexes this with it.
 */

/** One labelled amount, in the display unit that keys it. */
export type WaterQuickAmount = { label: string; amount: number };

/** The three amounts, per volume unit. Keyed by `units.volume`. */
export const WATER_QUICK_AMOUNTS: Record<'oz' | 'ml', readonly WaterQuickAmount[]> = {
  oz: [
    { label: 'Glass', amount: 8 },
    { label: 'Bottle', amount: 16 },
    { label: 'Large', amount: 24 },
  ],
  ml: [
    { label: 'Glass', amount: 240 },
    { label: 'Bottle', amount: 500 },
    { label: 'Large', amount: 750 },
  ],
};

/*
 * `defaultWaterAmount(unit)` — "the amount a surface falls back to when it has
 * nothing else to go on, a Glass" — lived here from 2026-09-14 and is deleted
 * on 2026-09-21 with its one caller. It existed for the Log tab's Water tile,
 * which DERIVED the amount it would log and needed something to fall back to on
 * an empty record. That tile is gone: the Log tab now shows all three vessels
 * plus Other…, so there is no derivation left to fall back from and no surface
 * that has "nothing to go on".
 *
 * Nothing else called it. `app/water.tsx`'s first-run stamp still reaches for
 * `WATER_QUICK_AMOUNTS[unit][0]!` directly, as it always did — a single use is
 * not a duplication, and re-exporting a one-line accessor to serve it would put
 * the helper back with the same caller count it is being removed for.
 */
