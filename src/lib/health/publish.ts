/**
 * The OUTBOUND half of the Apple Health body channel (docs/wearables-subapp.md
 * §10; the inbound half is §11, in `sync.ts` + `mapping.ts`).
 *
 * The link is two-way over these three columns, but no single VALUE is: every
 * `body_metrics` row records where it came from, and this pass publishes only
 * rows ARC originated. Rows ingested FROM Apple Health carry
 * `source = 'apple_health'` and are excluded by `publishableBodyAfter` at the
 * SQL level — the structural half of echo suppression, and the one that holds
 * even if every provenance check upstream fails at once.
 *
 * Structure mirrors `sync.ts`: the policy is pure and exported for the headless
 * tests ({@link bodySamplesFor}), the orchestration glues the pure part to the
 * guarded seam, and absence of the native module is a silent no-op rather than
 * an error.
 *
 * TWO RULES DO ALL THE WORK HERE.
 *
 * 1. **Never publish history.** A publish is irreversible from inside ARC: the
 *    HealthKit sample UUID `saveQuantitySample` hands back has nowhere to live
 *    (no column stores it), so ARC cannot later delete what it wrote — only the
 *    user can, by hand, in the Health app. ARC may hold years of manual weight;
 *    a naive "publish everything" would post all of it in one burst, into a
 *    medical record, with no undo. So the first pass ARMS: the cursor jumps to
 *    the newest existing `body_metrics` row and nothing is written. Everything
 *    logged afterwards publishes. A bounded backfill was considered and dropped
 *    — every bound is arbitrary, the irreversibility is the same at any size,
 *    and the value of historical weight in Apple Health is close to zero given
 *    ARC keeps and renders that history itself.
 *
 * 2. **Never advance past a failure.** The cursor moves only over rows whose
 *    every sample HealthKit accepted; the first refusal stops the pass. A
 *    permanently refused write (share access denied) therefore publishes nothing
 *    and loses nothing, and Settings › Apple Health says why — iOS reports write
 *    authorization truthfully, so that state is knowable rather than guessed.
 */
import {
  newestBodyCursor,
  publishableBodyAfter,
  type BodyCursor,
  type PublishableBody,
} from '@/lib/db/repositories/body';
import type { Database } from '@/lib/db/database';
import { isHealthSyncEnabled } from '@/lib/db/repositories/user';
import {
  getHealthPublishState,
  setHealthPublishState,
  type HealthPublishState,
} from '@/lib/db/repositories/wearables';

import { ARC_WRITE_METADATA_KEY, BODY_PUBLISH_METRICS } from './mapping';
import { isHealthKitAvailable, saveHealthQuantity } from './healthkit';

/**
 * Rows walked per pass. Publishing only ever runs forward from the cursor, so
 * in steady state this is one or two rows; the cap exists so that a burst (a
 * scale import, a long-dormant install catching up) stays one bounded pass
 * instead of thousands of sequential XPC round-trips on a foreground sync.
 */
export const PUBLISH_BATCH_ROWS = 200;

/** One HealthKit sample ARC intends to write. */
export type BodySample = {
  hkIdentifier: string;
  hkUnit: string;
  /** Already converted into `hkUnit` — see BODY_PUBLISH_METRICS. */
  value: number;
  /** The measurement instant; discrete samples are start === end. */
  at: Date;
  /** Stamped as ARC_WRITE_METADATA_KEY — the originating body_metrics row. */
  sourceRowId: string;
};

/**
 * One `body_metrics` row → the samples it should produce — PURE, so the unit
 * conversions (notably body fat's 0–100 → 0.0–1.0) are pinned by the headless
 * tests rather than discovered on a device.
 *
 * A row can carry one column or all three; `logMetric` writes one at a time but
 * an import may not. Null columns produce nothing, and a non-finite value is
 * skipped rather than sent: HealthKit does not sanity-check magnitudes, so
 * anything doubtful is better absent than wrong.
 */
export function bodySamplesFor(row: PublishableBody): BodySample[] {
  const at = new Date(row.measuredAt);
  if (Number.isNaN(at.getTime())) return [];
  const values: Record<string, number | null> = {
    weight_kg: row.weightKg,
    body_fat_pct: row.bodyFatPct,
    waist_cm: row.waistCm,
  };
  const samples: BodySample[] = [];
  for (const spec of BODY_PUBLISH_METRICS) {
    const raw = values[spec.column];
    if (raw === null || raw === undefined || !Number.isFinite(raw)) continue;
    const value = spec.toHealthKit(raw);
    if (!Number.isFinite(value)) continue;
    samples.push({
      hkIdentifier: spec.hkIdentifier,
      hkUnit: spec.hkUnit,
      value,
      at,
      sourceRowId: row.id,
    });
  }
  return samples;
}

export type HealthPublishResult = {
  status: 'published' | 'disabled' | 'unavailable';
  /** Samples HealthKit accepted this pass. */
  samplesWritten: number;
  /** True when this pass only armed the cursor (first ever pass). */
  armed: boolean;
  /** True when a save was refused and the pass stopped early. */
  stalled: boolean;
};

/**
 * The two native calls this pass makes, injectable so db/wearables.test.mjs can
 * drive the whole thing against real SQLite with a recording saver.
 *
 * Worth the parameter: everything dangerous about publishing lives in the walk —
 * that arming writes nothing, that the cursor never steps over a refusal, that
 * the same-millisecond keyset doesn't drop a row. None of that is provable if
 * the pass exits at the availability check, which is what it does under node.
 */
export type PublishDeps = {
  isAvailable: () => boolean;
  save: (
    identifier: string,
    unit: string,
    value: number,
    start: Date,
    end: Date,
    metadata: Record<string, unknown>
  ) => Promise<boolean>;
};

const NATIVE_DEPS: PublishDeps = { isAvailable: isHealthKitAvailable, save: saveHealthQuantity };

/**
 * The single in-flight publish pass, shared across every caller.
 *
 * A publish is irreversible (rule 1) and its safety rests entirely on the walk
 * running once against an un-advanced cursor: two overlapping passes — a boot or
 * foreground auto-sync racing a manual Settings "Sync now" (which bypasses the
 * throttle) — each read the SAME cursor, walk the SAME pending rows, and call
 * `save` for every sample twice, landing permanent duplicates in Apple Health
 * that ARC has no UUID to delete. So overlapping callers await the ONE pass
 * already running instead of starting a second; the awaited result is honest for
 * every caller because the running pass did all the work. The inbound upsert is
 * idempotent and needs no such guard — this protects only the outbound walk.
 */
let inFlight: Promise<HealthPublishResult> | null = null;

/**
 * One publish pass: arm if needed, then walk forward from the cursor writing
 * samples until the batch is exhausted or a save is refused.
 *
 * Gated on the SAME preference as ingestion. One Apple Health switch, both
 * directions — "Turn off" that left ARC still writing would be a lie.
 *
 * Serialized behind {@link inFlight}: a call that arrives while a pass is running
 * joins that pass rather than opening a concurrent one (see the note above).
 */
export function publishBodyMetrics(
  db: Database,
  now: Date = new Date(),
  deps: PublishDeps = NATIVE_DEPS
): Promise<HealthPublishResult> {
  if (inFlight) return inFlight;
  inFlight = runPublishPass(db, now, deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runPublishPass(
  db: Database,
  now: Date,
  deps: PublishDeps
): Promise<HealthPublishResult> {
  if (!isHealthSyncEnabled(db)) {
    return { status: 'disabled', samplesWritten: 0, armed: false, stalled: false };
  }
  if (!deps.isAvailable()) {
    return { status: 'unavailable', samplesWritten: 0, armed: false, stalled: false };
  }

  const state = getHealthPublishState(db);
  let cursor: BodyCursor | null =
    state.cursorCreatedAt !== null && state.cursorId !== null
      ? { createdAt: state.cursorCreatedAt, id: state.cursorId }
      : null;

  // First pass ever: park the cursor on the newest existing row so that
  // everything already logged counts as history and is left alone (rule 1).
  const armed = state.armedAt === null;
  if (armed) cursor = newestBodyCursor(db);

  let samplesWritten = 0;
  let stalled = false;
  for (const row of publishableBodyAfter(db, cursor, PUBLISH_BATCH_ROWS)) {
    let rowComplete = true;
    for (const sample of bodySamplesFor(row)) {
      const saved = await deps.save(
        sample.hkIdentifier,
        sample.hkUnit,
        sample.value,
        sample.at,
        sample.at,
        { [ARC_WRITE_METADATA_KEY]: sample.sourceRowId }
      );
      if (!saved) {
        rowComplete = false;
        break;
      }
      samplesWritten++;
    }
    // Advance only over rows published in FULL (rule 2). A half-published row
    // stays pending: re-saving its accepted samples next pass writes a duplicate
    // into Health, which is visible and correctable, whereas skipping the
    // refused one loses the reading outright.
    if (!rowComplete) {
      stalled = true;
      break;
    }
    cursor = { createdAt: row.createdAt, id: row.id };
  }

  const next: HealthPublishState = {
    armedAt: state.armedAt ?? now.toISOString(),
    cursorCreatedAt: cursor?.createdAt ?? null,
    cursorId: cursor?.id ?? null,
    lastPublishedAt: samplesWritten > 0 ? now.toISOString() : state.lastPublishedAt,
  };
  setHealthPublishState(db, next);

  return { status: 'published', samplesWritten, armed, stalled };
}
