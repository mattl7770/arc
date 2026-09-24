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
 *
 * **Water (2026-09-21) is a second walk under the same two rules** — its own
 * cursor, over `wearable_data` rather than `body_metrics`, because water has no
 * body column and must not be given one. What it adds is the one thing rule 1
 * says the body channel cannot have: an undo. A capture's sample is tagged with
 * the capture's own id, so {@link removeWaterCapture} can find it again and
 * take it out, and {@link editWaterCapture} can replace it. See
 * docs/wearables-subapp.md §20 for the echo, which has a different shape from
 * weight's and is closed on the READ side.
 */
import {
  newestBodyCursor,
  publishableBodyAfter,
  type BodyCursor,
  type PublishableBody,
} from '@/lib/db/repositories/body';
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import { dayInstant } from '@/lib/db/repositories/logs';
import { isHealthSyncEnabled } from '@/lib/db/repositories/user';
import {
  deleteWaterEntry,
  getPublishableWater,
  newestWaterCursor,
  publishableWaterAfter,
  updateWaterEntry,
  type PublishableWater,
  type WaterCursor,
} from '@/lib/db/repositories/water';
import {
  getHealthPublishState,
  HEALTH_WATER_PUBLISH_KEY,
  setHealthPublishState,
  type HealthPublishState,
} from '@/lib/db/repositories/wearables';

import { ARC_WRITE_METADATA_KEY, BODY_PUBLISH_METRICS, WATER_PUBLISH_METRIC } from './mapping';
import { deleteHealthQuantityByTag, isHealthKitAvailable, saveHealthQuantity } from './healthkit';

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
  /**
   * Stamped as ARC_WRITE_METADATA_KEY — the originating row: a `body_metrics`
   * id, or for water a `wearable_data` id. For water it is also the handle the
   * sample is deleted by, so it must be the capture's own id and nothing else.
   */
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
  /** Samples this pass tried to write, accepted or not. */
  samplesAttempted: number;
  /**
   * Per published type, attempted vs accepted. Split per type because a PARTIAL
   * share grant is a real and invisible state: weight authorised and body fat
   * refused publishes some rows and stalls on others, and one aggregate count
   * cannot tell that from a general refusal.
   */
  byType: { label: string; attempted: number; succeeded: number }[];
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
  const idle = { samplesWritten: 0, armed: false, stalled: false, samplesAttempted: 0, byType: [] };
  if (!isHealthSyncEnabled(db)) return { status: 'disabled', ...idle };
  if (!deps.isAvailable()) return { status: 'unavailable', ...idle };

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
  let samplesAttempted = 0;
  let stalled = false;
  // Keyed by hkIdentifier so a type that was never reached this pass simply
  // does not appear, rather than appearing as a zero that reads like a refusal.
  const tally = new Map<string, { label: string; attempted: number; succeeded: number }>();
  const labelFor = (identifier: string) =>
    BODY_PUBLISH_METRICS.find((m) => m.hkIdentifier === identifier)?.label ?? identifier;

  for (const row of publishableBodyAfter(db, cursor, PUBLISH_BATCH_ROWS)) {
    let rowComplete = true;
    for (const sample of bodySamplesFor(row)) {
      let entry = tally.get(sample.hkIdentifier);
      if (!entry) {
        entry = { label: labelFor(sample.hkIdentifier), attempted: 0, succeeded: 0 };
        tally.set(sample.hkIdentifier, entry);
      }
      entry.attempted++;
      samplesAttempted++;
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
      entry.succeeded++;
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

  return {
    status: 'published',
    samplesWritten,
    armed,
    stalled,
    samplesAttempted,
    byType: [...tally.values()],
  };
}

// --- Water (2026-09-21) -----------------------------------------------------------

/**
 * One manual capture → the one sample it publishes, or null when there is
 * nothing honest to send — PURE, so the instant and the unit are pinned by the
 * headless tests rather than discovered on a device.
 *
 * **The instant.** A capture typed on the day it counts toward goes out at the
 * moment it was typed — drink o'clock, which is the whole value of a glass in
 * the Health app's day. A BACKDATED capture (the water screen can log onto a
 * past day) goes out at local noon of that day, via the same {@link dayInstant}
 * `logMetric` uses for a backdated weight, so it lands on the intended day in
 * Health rather than on the day it happened to be typed.
 */
export function waterSampleFor(row: PublishableWater): BodySample | null {
  const typed = new Date(row.createdAt);
  if (Number.isNaN(typed.getTime())) return null;
  const value = WATER_PUBLISH_METRIC.toHealthKit(row.ml);
  // A capture is always positive (logWater refuses anything else), but the
  // table has no CHECK saying so, and HealthKit does not sanity-check.
  if (!Number.isFinite(value) || value <= 0) return null;
  const at = todayISODate(typed) === row.date ? typed : new Date(dayInstant(row.date));
  if (Number.isNaN(at.getTime())) return null;
  return {
    hkIdentifier: WATER_PUBLISH_METRIC.hkIdentifier,
    hkUnit: WATER_PUBLISH_METRIC.hkUnit,
    value,
    at,
    sourceRowId: row.id,
  };
}

/** The body pass's deps plus the one call only water can make. */
export type WaterPublishDeps = PublishDeps & {
  /** Remove every sample carrying this row's tag; resolves to how many went. */
  deleteByTag: (identifier: string, sourceRowId: string) => Promise<number>;
};

const NATIVE_WATER_DEPS: WaterPublishDeps = {
  ...NATIVE_DEPS,
  deleteByTag: deleteHealthQuantityByTag,
};

/** The single in-flight water pass — the same reasoning as {@link inFlight}. */
let waterInFlight: Promise<HealthPublishResult> | null = null;

/**
 * One water publish pass: arm if needed, then walk the manual captures forward
 * from the cursor, one sample each, until the batch is exhausted or a save is
 * refused. The same two rules as {@link publishBodyMetrics}, under a cursor of
 * its own (`HEALTH_WATER_PUBLISH_KEY`), and the same one switch for both
 * directions.
 *
 * Only manual captures are ever walked — `publishableWaterAfter` takes
 * `source_device = 'manual' AND source_raw_id IS NULL`, so an inbound `hk:`
 * bucket can never be sent back. That is what bounds the echo (docs §20).
 */
export function publishWaterCaptures(
  db: Database,
  now: Date = new Date(),
  deps: WaterPublishDeps = NATIVE_WATER_DEPS
): Promise<HealthPublishResult> {
  if (waterInFlight) return waterInFlight;
  waterInFlight = runWaterPass(db, now, deps).finally(() => {
    waterInFlight = null;
  });
  return waterInFlight;
}

async function runWaterPass(
  db: Database,
  now: Date,
  deps: WaterPublishDeps
): Promise<HealthPublishResult> {
  const idle = { samplesWritten: 0, armed: false, stalled: false, samplesAttempted: 0, byType: [] };
  if (!isHealthSyncEnabled(db)) return { status: 'disabled', ...idle };
  if (!deps.isAvailable()) return { status: 'unavailable', ...idle };

  const state = getHealthPublishState(db, HEALTH_WATER_PUBLISH_KEY);
  let cursor: WaterCursor | null =
    state.cursorCreatedAt !== null && state.cursorId !== null
      ? { createdAt: state.cursorCreatedAt, id: state.cursorId }
      : null;

  // First pass ever: everything already on record is history (rule 1).
  const armed = state.armedAt === null;
  if (armed) cursor = newestWaterCursor(db);

  let attempted = 0;
  let written = 0;
  let stalled = false;
  for (const row of publishableWaterAfter(db, cursor, PUBLISH_BATCH_ROWS)) {
    const sample = waterSampleFor(row);
    if (sample) {
      attempted++;
      const saved = await deps.save(
        sample.hkIdentifier,
        sample.hkUnit,
        sample.value,
        sample.at,
        sample.at,
        { [ARC_WRITE_METADATA_KEY]: sample.sourceRowId }
      );
      if (!saved) {
        stalled = true; // rule 2: the cursor stays on the last accepted row
        break;
      }
      written++;
      // Undone while the save was in flight: the row is gone, so the sample it
      // just produced has no capture behind it. Take it straight back out —
      // this is the one ordering in which the Undo's own delete runs first and
      // finds nothing.
      // Never allowed to throw: a rejection here would end the pass before its
      // cursor is saved, and the next pass would re-post every row saved above.
      if (getPublishableWater(db, row.id) === null) {
        await deps.deleteByTag(sample.hkIdentifier, row.id).catch(() => 0);
      }
    }
    // A row with nothing honest to send is stepped over: it can never become
    // publishable, and stalling on it would stop every capture behind it.
    cursor = { createdAt: row.createdAt, id: row.id };
  }

  const next: HealthPublishState = {
    armedAt: state.armedAt ?? now.toISOString(),
    cursorCreatedAt: cursor?.createdAt ?? null,
    cursorId: cursor?.id ?? null,
    lastPublishedAt: written > 0 ? now.toISOString() : state.lastPublishedAt,
  };
  setHealthPublishState(db, next, HEALTH_WATER_PUBLISH_KEY);

  return {
    status: 'published',
    samplesWritten: written,
    armed,
    stalled,
    samplesAttempted: attempted,
    byType:
      attempted > 0 ? [{ label: WATER_PUBLISH_METRIC.label, attempted, succeeded: written }] : [],
  };
}

/** Whether a Health write may happen right now — the one switch, and a module. */
function mayTouchHealth(db: Database, deps: WaterPublishDeps): boolean {
  return isHealthSyncEnabled(db) && deps.isAvailable();
}

/**
 * Delete one manual water capture AND the sample it published — the Log tab's
 * Undo and the water screen's delete both come through here.
 *
 * Returns exactly what `deleteWaterEntry` returns (whether ARC's row went), and
 * ARC's row goes first and synchronously: the record the user is looking at is
 * the thing that must change now. The Health half is best-effort and
 * fire-and-forget — it resolves to 0 for a capture the walk never reached,
 * which is the ordinary case for an Undo made seconds after the tap, and the
 * walk's own post-save check covers the one ordering where the Undo runs
 * before the save lands.
 *
 * Gated on the same switch as publishing. *Turn off* means ARC stops touching
 * Apple Health in either direction, and a delete is a write; a capture removed
 * while sync is off leaves its copy in the Health app, where it can be removed
 * by hand, exactly like a weight.
 *
 * The Coach's `delete_record` / `edit_record` for water come through here and
 * `editWaterCapture` too (`src/lib/ai/domains/read-domains.ts`), by the parity
 * rule: a Coach removal or correction reaches Apple Health exactly as the
 * screen's does. Pinned in `db/coach-domains.test.mjs`.
 */
export function removeWaterCapture(
  db: Database,
  id: string,
  deps: WaterPublishDeps = NATIVE_WATER_DEPS
): boolean {
  const removed = deleteWaterEntry(db, id);
  if (removed && mayTouchHealth(db, deps)) {
    void deps.deleteByTag(WATER_PUBLISH_METRIC.hkIdentifier, id).catch(() => 0);
  }
  return removed;
}

/**
 * Correct one manual capture's amount AND, if it was already published, the
 * sample in Apple Health — the water screen's edit.
 *
 * Only what was out there is replaced: the tagged delete doubles as the
 * question "was it published?", and a capture the walk has not reached yet
 * needs nothing — it will carry the corrected amount when it gets there. The
 * replacement keeps the capture's original instant and its tag, so it is the
 * same glass with a new amount rather than a new glass.
 *
 * Without this the Health app would keep the old amount forever, which is the
 * one outcome two-way sync exists to prevent. Best-effort like the delete: if
 * the re-save is refused after the delete succeeded, the glass is missing from
 * Health rather than wrong there, and ARC's own record is untouched.
 */
export function editWaterCapture(
  db: Database,
  id: string,
  ml: number,
  deps: WaterPublishDeps = NATIVE_WATER_DEPS
): boolean {
  const changed = updateWaterEntry(db, id, ml);
  if (changed && mayTouchHealth(db, deps)) void republishWater(db, id, deps);
  return changed;
}

async function republishWater(db: Database, id: string, deps: WaterPublishDeps): Promise<void> {
  try {
    const removed = await deps.deleteByTag(WATER_PUBLISH_METRIC.hkIdentifier, id);
    if (removed === 0) return;
    const row = getPublishableWater(db, id);
    const sample = row ? waterSampleFor(row) : null;
    if (!sample) return;
    await deps.save(sample.hkIdentifier, sample.hkUnit, sample.value, sample.at, sample.at, {
      [ARC_WRITE_METADATA_KEY]: sample.sourceRowId,
    });
  } catch {
    // Best-effort: see the note on editWaterCapture.
  }
}
