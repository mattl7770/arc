/**
 * Plain JS shapes crossing the HealthKit seam (docs/wearables-subapp.md §5).
 *
 * The guarded reader (`healthkit.ts`) converts whatever the native library
 * returns into these — plain strings/numbers, ISO instants, no Date objects,
 * no hybrid-object methods — so the pure mapping layer (`mapping.ts`) and its
 * headless tests never touch anything native.
 */

/** Who wrote a sample, straight off HKSourceRevision. All best-effort. */
export type HealthProvenance = {
  /** User-facing source name, e.g. "Matt's Apple Watch", "Oura". */
  sourceName: string | null;
  /** App bundle id (e.g. com.ouraring.oura) or a BLE-device UUID. */
  bundleId: string | null;
  /** Device model string, e.g. "Watch7,1", "iPhone16,2". */
  productType: string | null;
  /**
   * The sample carries ARC's own write-metadata key (`ARCPublishedFrom`) — so
   * ARC published it, whatever the bundle id says. Independent evidence from
   * `bundleId`: the metadata survives even if `sourceRevision` arrives in a
   * shape this seam cannot read, which is exactly the case where bundle-based
   * echo detection would fail open. See `isIngestableSample` in mapping.ts.
   */
  arcWritten: boolean;
};

/** One HKQuantitySample, value already in the unit the reader requested. */
export type HealthQuantitySample = {
  value: number;
  startISO: string;
  endISO: string;
  provenance: HealthProvenance;
};

/** One HKCategorySample (sleep analysis: value is the stage enum 0–5). */
export type HealthCategorySample = {
  value: number;
  startISO: string;
  endISO: string;
  provenance: HealthProvenance;
};

/** One HealthKit-merged daily statistic (cumulative metrics only). */
export type HealthDailyStatistic = {
  /** Local calendar day the bucket covers. */
  date: string;
  value: number;
};

/** One HKWorkout, flattened. */
export type HealthWorkoutSample = {
  /** HealthKit's own object UUID — the dedup key. */
  uuid: string;
  /** HKWorkoutActivityType raw value (stable UInt). */
  activityTypeRaw: number;
  /** True duration in seconds (excludes pauses; ≠ end − start). */
  durationSec: number;
  startISO: string;
  endISO: string;
  kcal: number | null;
  distanceKm: number | null;
  provenance: HealthProvenance;
};
