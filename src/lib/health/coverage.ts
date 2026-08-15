/**
 * **The metric audit** — for every HealthKit type ARC asks to read: what ARC
 * does with it, whether the owner's Garmin can actually supply it, and how much
 * history ARC needs before it can show anything (docs/wearables-subapp.md §12).
 *
 * This exists because "the metric is blank" has at least four different causes
 * and the screens could not tell them apart:
 *
 *   1. the HealthKit module is not in this binary, so nothing can arrive;
 *   2. it can arrive, but the source never writes that type to Apple Health;
 *   3. it is arriving, but a derived verdict still needs N more days of it;
 *   4. it is arriving and today's reading is simply missing.
 *
 * (2) is the one no amount of waiting fixes, and it is the one the owner most
 * needs told: **a Garmin exports no HRV, no SpO2, no respiratory rate and no
 * VO₂max to Apple Health at all.** Those four ARC read scopes stay permanently
 * empty on a Garmin-only setup, however long anyone waits.
 *
 * PURE and free of any native import, so db/health-coverage.test.mjs can assert
 * the invariant that matters: every identifier in `HEALTH_READ_IDENTIFIERS` has
 * a row here, and every row here names a real read scope. A read scope with no
 * audit row is how this file would quietly start lying.
 *
 * ## On the honesty of the `garmin` column
 *
 * Garmin's own support article on Apple Health sharing is a JS-rendered page
 * that could not be retrieved, so the verdicts rest on Garmin Forums threads
 * (including Garmin-staff replies) and specialist coverage. Anything that could
 * not be pinned to such a source is `unverified` and says why — an honest
 * "unknown" is worth more here than a confident guess, because these rows are
 * the input to a possible direct-vendor-API decision.
 */
import { HEALTH_READ_IDENTIFIERS } from './mapping';

/**
 * Whether the source writes this type into Apple Health.
 *
 *   - `yes` / `no` — pinned to a citable source (see the module note).
 *   - `unverified` — could not be established either way. NOT a soft no.
 */
export type SourceVerdict = 'yes' | 'no' | 'unverified';

export type MetricCoverage = {
  /** The HealthKit identifier ARC requests. */
  hkIdentifier: string;
  /** Short human name, for the Settings list. */
  label: string;
  /** What ARC does with it once it lands. */
  use: string;
  /** Does Garmin Connect write it to Apple Health? */
  garmin: SourceVerdict;
  /** The evidence, or what was missing. One sentence. */
  garminNote: string;
  /**
   * Days of readings before the VERDICT this metric feeds can appear, or null
   * when it feeds no verdict (it shows as a number from the first reading).
   *
   * Five prior days clear `BASELINE_MIN_DAYS`, so a verdict lands on the sixth
   * day of readings — strain's window ends yesterday rather than today, which
   * makes it a seventh day from a standing start.
   */
  verdictDays: number | null;
};

/**
 * One row per read scope. Ordered as the Settings list reads: the metrics that
 * drive Home first, then the rest.
 */
export const METRIC_COVERAGE: readonly MetricCoverage[] = [
  {
    hkIdentifier: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
    label: 'Heart-rate variability',
    use: "Home's Recovery pillar — today against a 30-day baseline",
    garmin: 'no',
    garminNote:
      'Garmin exports no overnight HRV to Apple Health in any form — not SDNN, not RMSSD. A years-old feature request is still open, so ARC falls back to resting heart rate for Recovery.',
    verdictDays: 6,
  },
  {
    hkIdentifier: 'HKQuantityTypeIdentifierRestingHeartRate',
    label: 'Resting heart rate',
    use: "Corroborates HRV, and becomes Home's Recovery pillar on its own when HRV never arrives",
    garmin: 'yes',
    garminNote: 'Syncs, and uncontested across every source checked.',
    verdictDays: 6,
  },
  {
    hkIdentifier: 'HKQuantityTypeIdentifierActiveEnergyBurned',
    label: 'Active energy',
    use: "Home's Strain pillar — yesterday's load against its baseline",
    garmin: 'yes',
    garminNote: 'Syncs as part of the standard calorie export.',
    verdictDays: 7,
  },
  {
    hkIdentifier: 'HKCategoryTypeIdentifierSleepAnalysis',
    label: 'Sleep, with stages',
    use: "Home's Sleep pillar and the sleep metric; stages feed the Wearables ledger",
    garmin: 'yes',
    garminNote:
      'Duration syncs, and sleep STAGES have synced since Garmin Connect iOS v4.71 (Sept 2023) — Garmin Light maps to Apple Core. A pre-2023 bug filed REM as Awake; unconfirmed whether it still bites.',
    verdictDays: 1,
  },
  {
    hkIdentifier: 'HKQuantityTypeIdentifierStepCount',
    label: 'Steps',
    use: "Home's metrics strip and the Wearables ledger",
    garmin: 'yes',
    garminNote:
      "Syncs — Garmin publishes a dedicated FAQ about step counts DIFFERING between the two apps, which presupposes it.",
    verdictDays: null,
  },
  {
    hkIdentifier: 'HKWorkoutTypeIdentifier',
    label: 'Workouts',
    use: 'The Wearables workout list, and the Coach reads the daily minutes',
    garmin: 'yes',
    garminNote:
      'Sessions sync as summaries (duration, distance, energy). The GPS route does NOT come across — ARC stores no route, so nothing is lost here.',
    verdictDays: null,
  },
  {
    hkIdentifier: 'HKQuantityTypeIdentifierBasalEnergyBurned',
    label: 'Resting energy',
    use: 'The Wearables ledger; not yet used in any verdict',
    garmin: 'unverified',
    garminNote:
      'Sources say "calories" without separating active from basal, so whether the resting half is written could not be established either way.',
    verdictDays: null,
  },
  {
    hkIdentifier: 'HKQuantityTypeIdentifierOxygenSaturation',
    label: 'Blood oxygen',
    use: 'The Wearables ledger',
    garmin: 'no',
    garminNote:
      "Pulse Ox is not exportable — the toggle does not exist in Garmin Connect, confirmed by Garmin staff on the forums as recently as 2024. CIRQA measures Pulse Ox2; it stays in Garmin Connect.",
    verdictDays: null,
  },
  {
    hkIdentifier: 'HKQuantityTypeIdentifierRespiratoryRate',
    label: 'Respiratory rate',
    use: 'The Wearables ledger',
    garmin: 'no',
    garminNote:
      'Same Garmin-staff confirmation as blood oxygen — the Apple Health category exists but cannot be switched on for syncing from Connect.',
    verdictDays: null,
  },
  {
    hkIdentifier: 'HKQuantityTypeIdentifierVO2Max',
    label: 'VO₂max',
    use: 'The Wearables ledger',
    garmin: 'no',
    garminNote:
      'Named in the same long-running, still-unimplemented Garmin feature request as blood oxygen and respiratory rate.',
    verdictDays: null,
  },
  {
    hkIdentifier: 'HKQuantityTypeIdentifierBodyTemperature',
    label: 'Body temperature',
    use: 'The Wearables ledger',
    garmin: 'unverified',
    garminNote:
      'No source found either way. Garmin reports skin temperature as a nightly DEVIATION from a 3-night baseline, which is not the absolute reading this type holds — so an export may not be meaningful even if one exists.',
    verdictDays: null,
  },
  {
    hkIdentifier: 'HKQuantityTypeIdentifierAppleSleepingWristTemperature',
    label: 'Sleeping wrist temperature',
    use: 'The Wearables ledger',
    garmin: 'unverified',
    garminNote:
      'An Apple-authored type; whether a third party may write it at all could not be confirmed. Moot in practice — Garmin has no equivalent absolute measurement to write.',
    verdictDays: null,
  },
  {
    hkIdentifier: 'HKQuantityTypeIdentifierBodyMass',
    label: 'Weight',
    use: 'Body metrics and the weight trend — ARC also publishes this one outward',
    garmin: 'yes',
    garminNote: 'The Garmin Index scale syncs weight; long-standing and uncontested.',
    verdictDays: null,
  },
  {
    hkIdentifier: 'HKQuantityTypeIdentifierBodyFatPercentage',
    label: 'Body fat',
    use: 'Body metrics — ARC also publishes this one outward',
    garmin: 'yes',
    garminNote:
      "Supported, but with a history of breaking — including a spell filing body fat as BMI. Treat an implausible figure as the sync's fault before your own.",
    verdictDays: null,
  },
  {
    hkIdentifier: 'HKQuantityTypeIdentifierWaistCircumference',
    label: 'Waist',
    use: 'Body metrics — ARC also publishes this one outward',
    garmin: 'unverified',
    garminNote:
      'No Garmin product appears to measure a waist at all, so there is nothing for it to export. Values here will be ones you or another app entered.',
    verdictDays: null,
  },
];

/**
 * Metrics a Garmin keeps to itself entirely — they have **no HealthKit type at
 * all**, so this is not a Garmin policy choice ARC could wait out. Recorded
 * because the owner's question was about what a Garmin can deliver, and the
 * honest answer includes what it never will.
 */
export const GARMIN_ONLY_METRICS: readonly { label: string; note: string }[] = [
  {
    label: 'Body Battery',
    note: 'No HealthKit type exists for it, so it cannot leave Garmin Connect even in principle.',
  },
  {
    label: 'Training Readiness and training status',
    note: "Garmin-proprietary scores with no HealthKit equivalent. ARC's Recovery pillar is its own derivation and does not need them.",
  },
];

/**
 * **The audit tripwire**, asserted empty by db/health-coverage.test.mjs.
 *
 * Every read scope must have a coverage row and every coverage row must name a
 * real read scope. Without this, adding a scope silently produces a metric the
 * audit table claims nothing about — which is exactly the state this whole file
 * was written to end.
 *
 * A pure function rather than a module-scope assertion: Expo Router eagerly
 * requires everything reachable from `app/`, so a throw at import time is an
 * app-STARTUP crash rather than a test failure.
 */
export function uncoveredReadIdentifiers(): { missing: string[]; stale: string[] } {
  const covered = new Set(METRIC_COVERAGE.map((m) => m.hkIdentifier));
  const scopes = new Set(HEALTH_READ_IDENTIFIERS);
  return {
    missing: HEALTH_READ_IDENTIFIERS.filter((id) => !covered.has(id)),
    stale: METRIC_COVERAGE.map((m) => m.hkIdentifier).filter((id) => !scopes.has(id)),
  };
}
