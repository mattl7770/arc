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
 *   - `src/components/log/quick-add-grid.tsx` — the Log tab's Water tile and the
 *     amounts its long-press reveals (each commits, like the water screen).
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

/**
 * The amount a surface falls back to when it has nothing else to go on — a
 * Glass, in the user's unit. Its own function rather than
 * `WATER_QUICK_AMOUNTS[unit][0]!` repeated at the call sites, because "the
 * default is a glass" is a product decision and deserves one place to change.
 */
export function defaultWaterAmount(volumeUnit: 'oz' | 'ml'): number {
  return WATER_QUICK_AMOUNTS[volumeUnit][0]!.amount;
}
