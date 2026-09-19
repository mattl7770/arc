/**
 * Plain JS shapes crossing the HealthKit seam (docs/wearables-subapp.md §5).
 *
 * The guarded reader (`healthkit.ts`) converts whatever the native library
 * returns into these — plain strings/numbers, ISO instants, no Date objects,
 * no hybrid-object methods — so the pure mapping layer (`mapping.ts`) and its
 * headless tests never touch anything native.
 */

/**
 * Which own-write exclusion a read actually ran with (docs §10, guard 1). Lives
 * here rather than in the seam so the DB layer and the Settings screen can name
 * it without importing anything native.
 *
 *   - `source`   — the categorical `currentAppSource()` NOT predicate;
 *   - `metadata` — the `ARCPublishedFrom` NOT predicate;
 *   - `none`     — no exclusion applied (statistics always; a read-only type
 *                  whose every predicate HealthKit refused);
 *   - `refused`  — every predicate was refused on a PUBLISHED type, so the read
 *                  returned nothing rather than risk the echo loop. This is the
 *                  state that used to be indistinguishable from a quiet day.
 */
export type HealthExclusion = 'source' | 'metadata' | 'none' | 'refused';

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

/**
 * A session's heart rate, as HealthKit computed it (docs §15).
 *
 * Both members or neither — an average with no maximum is half a reading, and a
 * half reading printed in the owner's mono voice is a claim ARC would be making
 * on its own. Integers, in bpm.
 *
 * `method` is a diagnostic, never rendered: both derivations are HealthKit's own
 * time-weighted average and maximum over the writer's exported samples for the
 * span, and they differ only in whether the writer ASSOCIATED those samples with
 * the workout. Marking one on screen would claim a distinction the numbers do
 * not have.
 *
 *   - `workout` — the HKWorkout's own statistic, what the Health app prints;
 *   - `source`  — the same writer's samples over the span, floored (docs §15).
 */
export type WorkoutHr = {
  avg: number;
  max: number;
  method: 'workout' | 'source';
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
  /**
   * Heart rate for this session, when either door answered. ABSENT, never
   * nulled — `parseWorkoutSample` is pure and synchronous and never sets it;
   * `collectWorkouts` spreads it in from the async probe.
   */
  hr?: WorkoutHr;
};

/**
 * What ARC has ASKED Apple Health for — the `apple_health_scopes` KV.
 *
 * A record of ARC's own behaviour, NOT of grants: iOS never reveals whether a
 * read was authorised. It exists so a scope added after the user answered the
 * permission sheet can be asked for explicitly, from a control that knows it is
 * not a no-op. See `unaskedReadScopes` in ./mapping.ts.
 */
export type HealthScopeStamp = {
  /** Read identifiers a processed `requestAuthorization` call has covered. */
  askedFor: string[];
};
