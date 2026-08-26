/**
 * Which metrics are still GROWING at the moment you read them — the one
 * declaration of "is today finished".
 *
 * ## The question, and the one next to it
 *
 * A metric's day is either a WHOLE FACT the moment it is written (a night's
 * sleep, an HRV sample, a VO2max estimate) or a RUNNING TOTAL that keeps
 * climbing until midnight (steps, energy burned, water sipped, workout minutes).
 * Only the second kind must be held out of an average, a baseline or a
 * trend — a two-hour-old total compared against seven complete days reads as a
 * collapse every single morning, and stating it as a daily figure is a
 * fabricated number, the "no data, no number" rule broken from the other side.
 *
 * This is NOT the same axis as `agg` (`sum` vs `arbitrated`, in
 * ai/tools/read-tools.ts). `agg` answers *how many rows fold into one day*;
 * this answers *whether that folded day is finished*. `steps` is `arbitrated`
 * — HealthKit merges the day and two devices must pick a winner rather than
 * double-count — **and** accumulating. Keying the partial-day rule off
 * `agg === 'sum'` alone would silently miss steps and both energy metrics,
 * i.e. the entire original complaint.
 *
 * ## Why it is one exported list and not four
 *
 * It was four: `WearableMetricSpec.accumulating` (read-tools.ts), and a
 * hand-written `accumulating: boolean` on `WEARABLE_TRENDS`, on
 * `BRIEF_FLOOR_METRICS` (both ai/insights.ts) and on `RecoverySpec`
 * (reports/assemble-self-review.ts). They agreed — which is the only reason
 * nothing was visibly wrong — but a metric classified accumulating in one and
 * level in another means the Coach averages today in through one tool and not
 * the other, and then gives two different answers about the same day. That is
 * the exact shape of the bug that started the 2026-08-09/10 rounds (the
 * readable-metric set derived from the wrong source of truth), so it gets the
 * same fix: **derive every consumer from one declaration**, and derive that
 * declaration from the ingest specs wherever the ingest already knows.
 *
 * Consumers hold no boolean of their own any more. The type that used to carry
 * the flag no longer has the field, so a new consumer cannot re-declare it
 * without adding one back — and db/health-mapping.test.mjs §13 scans the source
 * of all four for a stray `accumulating:` literal and fails on it.
 *
 * ## What is on the list, and why each is here rather than declared per-call
 *
 *   - **every {@link STATISTIC_METRICS} type** (steps, active energy, resting
 *     energy) — a HealthKit *statistic* is a cumulative sum over the day,
 *     rewritten as the day grows. Accumulating BY CONSTRUCTION, so a metric
 *     added to that pipeline is classified here with no edit to this file.
 *   - **`workout`** — many sessions a day, one row each (mapping.ts's
 *     `workoutRows`), so the day's minutes are a sum that is not final until
 *     the day is.
 *   - **`water_ml`** — one row per sip logged by hand (repositories/water.ts).
 *     The only entry with no HealthKit ingest spec to derive from, which is why
 *     the list is composed here and not inside mapping.ts.
 *
 * Everything else is a level reading, INCLUDING metrics discovered from the
 * table rather than declared (read-tools.ts's layer 2). An unknown cadence is
 * treated as level deliberately: holding a real same-day reading out of the
 * statistics is the more damaging guess of the two, and those specs already
 * carry `inferred: true` so the model knows the semantics were assumed.
 */
import { STATISTIC_METRICS } from './mapping';

/** Metric types whose value for a given day is not final until that day is. */
export const ACCUMULATING_METRIC_TYPES: readonly string[] = [
  ...STATISTIC_METRICS.map((spec) => spec.metricType),
  // Sessions logged through the day (HealthKit workouts).
  'workout',
  // Sips logged through the day (manual capture — no HealthKit channel).
  'water_ml',
];

const ACCUMULATING = new Set(ACCUMULATING_METRIC_TYPES);

/**
 * Does `metricType`'s day keep growing until midnight? The single predicate
 * behind every partial-day exclusion in the app — trends, the brief's floor
 * line, `get_metric_series`' `partialDate`, and the self-review's recovery
 * section all ask it rather than answering it themselves.
 */
export function isAccumulatingMetric(metricType: string): boolean {
  return ACCUMULATING.has(metricType);
}
