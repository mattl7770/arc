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
 *
 * **The body channel had that handle all along (found 2026-09-25).** Every body
 * sample has been saved with the same tag — `ARC_WRITE_METADATA_KEY` set to its
 * `body_metrics` row id, by {@link bodySamplesFor} — so rule 1's "cannot later
 * delete" was true of history, which ARC never sends, and never of a single
 * capture. When the Log tab or the Coach deletes a weight, body fat or waist
 * reading ({@link removeLogCapture}), its sample comes out of Apple Health by
 * that tag, exactly as a glass does; the walk checks after each save for a row
 * deleted while the save was in flight. Rule 1 stands for what it is about: a
 * burst of history, which no tag makes wise to post.
 *
 * **And water goes out when it is logged (2026-09-23), not on the next sync.**
 * {@link logWaterCapture} and {@link logMetricCapture} write the capture and
 * start a water-only walk behind it, through the same single in-flight pass the
 * full sync's walk uses, so the two never save one glass twice (§20.10).
 */
import {
  getPublishableBody,
  newestBodyCursor,
  publishableBodyAfter,
  type BodyCursor,
  type PublishableBody,
} from '@/lib/db/repositories/body';
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import {
  dayInstant,
  logMetric,
  restoreCapture,
  takeCapture,
  type TakenCapture,
} from '@/lib/db/repositories/logs';
import { getPreferences, isHealthSyncEnabled } from '@/lib/db/repositories/user';
import {
  deleteWaterEntry,
  getPublishableWater,
  logWater,
  newestWaterCursor,
  publishableWaterAfter,
  updateWaterEntry,
  type PublishableWater,
  type WaterCursor,
} from '@/lib/db/repositories/water';
import { metricByKey, type MetricKey } from '@/lib/log/metrics';
import {
  getHealthPublishState,
  HEALTH_WATER_PUBLISH_KEY,
  setHealthPublishState,
  type HealthPublishState,
} from '@/lib/db/repositories/wearables';

import { ARC_WRITE_METADATA_KEY, BODY_PUBLISH_METRICS, WATER_PUBLISH_METRIC } from './mapping';
import {
  deleteHealthQuantityByTag,
  healthWriteAccess,
  isHealthKitAvailable,
  saveHealthQuantity,
  type HealthWriteAccess,
} from './healthkit';

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
  /**
   * Remove every sample carrying this row's tag. Optional here — the body walk
   * uses it only to take back a sample whose capture was deleted while its
   * save was in flight — and required on {@link WaterPublishDeps}.
   */
  deleteByTag?: (identifier: string, sourceRowId: string) => Promise<number>;
};

const NATIVE_DEPS: PublishDeps = {
  isAvailable: isHealthKitAvailable,
  save: saveHealthQuantity,
  deleteByTag: deleteHealthQuantityByTag,
};

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
    await settleSavedBody(db, row, deps);
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

/**
 * After a body row's samples land, take back any whose reading is no longer
 * on the record (2026-09-25) — the body twin of {@link settleSavedWater}'s
 * first case.
 *
 * The walk reads its batch when the pass begins, and a weight deleted on the
 * Log tab after that read is still in the batch: its save lands after the
 * deletion's own tagged delete has looked and found nothing. So each saved
 * row is read again, and a sample whose column is gone — the row deleted, or
 * that one reading cleared — is removed by the row's tag. Best-effort and
 * never throws: a rejection here would end the pass before its cursor is
 * saved, and the next pass would re-post every row saved before it.
 */
async function settleSavedBody(
  db: Database,
  sent: PublishableBody,
  deps: PublishDeps
): Promise<void> {
  const deleteByTag = deps.deleteByTag;
  if (!deleteByTag) return;
  const now = getPublishableBody(db, sent.id);
  const still = new Set(now ? bodySamplesFor(now).map((s) => s.hkIdentifier) : []);
  for (const sample of bodySamplesFor(sent)) {
    if (still.has(sample.hkIdentifier)) continue;
    await deleteByTag(sample.hkIdentifier, sent.id).catch(() => 0);
  }
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
 * The capture the walk is saving right now, from the moment it re-reads the
 * row until Health holds what the row says. {@link republishWater} leaves this
 * one row to the walk, which checks it again after its save and corrects what
 * it sent (§20.5, the edit race). One walk runs at a time, so one id is enough.
 *
 * Set in the same synchronous step as the re-read before the save, and cleared
 * in the same step as the read that finds Health right, so an edit that stands
 * aside is always seen by a later read of the walk's. The `finally` in
 * runWaterPass clears it for the exits that stop writing the row altogether: a
 * refused save (the glass is missing from Health, which §20.5 accepts), a throw,
 * or a row that is gone and cannot be edited.
 */
let waterSaving: string | null = null;

/**
 * How many times the walk re-sends one capture that was corrected while it was
 * being saved. An edit takes a tap and a save a fraction of a second, so a
 * second correction is already beyond what a person can do; the bound only
 * stops a loop.
 */
const WATER_RESAVE_LIMIT = 3;

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
  for (const listed of publishableWaterAfter(db, cursor, PUBLISH_BATCH_ROWS)) {
    // Read again, now. The batch was read when the pass began, and a backlog of
    // stalled glasses takes seconds to walk, long enough to open the water
    // screen and correct one. Sending the listed amount would put the old one
    // in Health for good: the edit's own re-send asks "was it published?" and
    // hears no, because the walk had not reached it yet.
    const row = getPublishableWater(db, listed.id);
    const sample = row ? waterSampleFor(row) : null;
    if (sample) {
      attempted++;
      waterSaving = listed.id;
      try {
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
        await settleSavedWater(db, listed.id, sample, deps);
      } finally {
        waterSaving = null;
      }
    }
    // A row with nothing honest to send is stepped over: it can never become
    // publishable, and stalling on it would stop every capture behind it. So
    // is one removed since the batch was read, which has nothing to send.
    cursor = { createdAt: listed.createdAt, id: listed.id };
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

/**
 * After the walk's save lands, make Health hold what the row holds NOW.
 *
 * - **Undone while the save was in flight:** the row is gone, so the sample
 *   just saved has no capture behind it. Take it straight back out. This is
 *   the one ordering in which the Undo's own delete runs first and finds
 *   nothing.
 * - **Corrected while the save was in flight:** the edit's re-send stood aside
 *   for this row ({@link waterSaving}), so the walk replaces what it sent with
 *   the corrected amount, same instant, same tag. Then it checks again, since
 *   the re-save was in flight too.
 *
 * Never allowed to throw: a rejection here would end the pass before its
 * cursor is saved, and the next pass would re-post every row saved before it.
 * A refused re-save leaves the glass missing from Health rather than wrong
 * there, the same outcome {@link editWaterCapture} accepts.
 */
async function settleSavedWater(
  db: Database,
  id: string,
  sent: BodySample,
  deps: WaterPublishDeps
): Promise<void> {
  let inHealth = sent;
  for (let resaves = 0; ; resaves++) {
    const row = getPublishableWater(db, id);
    if (row === null) {
      await deps.deleteByTag(inHealth.hkIdentifier, id).catch(() => 0);
      return;
    }
    const now = waterSampleFor(row);
    const settled =
      now !== null &&
      now.value === inHealth.value &&
      now.at.getTime() === inHealth.at.getTime();
    if (settled || resaves >= WATER_RESAVE_LIMIT) {
      // Let go of the row in the SAME step as the read that decided to stop.
      // Letting go in runWaterPass's `finally` is a microtask later, and an edit
      // landing in between would stand aside for a walk that never reads the row
      // again, leaving the old amount in Health (§20.5, 2026-09-25). From here
      // an edit takes the ordinary path: Health holds this row's one sample and
      // nothing of the walk's is still in flight for it.
      waterSaving = null;
      return;
    }
    await deps.deleteByTag(inHealth.hkIdentifier, id).catch(() => 0);
    if (now === null) return;
    const saved = await deps
      .save(now.hkIdentifier, now.hkUnit, now.value, now.at, now.at, {
        [ARC_WRITE_METADATA_KEY]: now.sourceRowId,
      })
      .catch(() => false);
    if (!saved) return;
    inHealth = now;
  }
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
  // The walk is saving this very row. Its save may land after the delete below
  // has looked, or before it, so either answer here could be wrong; the walk
  // re-reads the row once its save lands and replaces the amount itself
  // (settleSavedWater). Two re-sends at once would leave two glasses.
  if (waterSaving === id) return;
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

// --- A capture deleted from the Log tab, and put back (2026-09-25) ----------------

/**
 * The Apple Health type a capture published under, or null for one ARC never
 * publishes (a note, a supplement, a symptom, HRV or resting HR typed by hand).
 */
function publishedIdentifier(taken: TakenCapture): string | null {
  const { capture } = taken;
  if (capture.kind === 'wearable') {
    return capture.metricType === WATER_PUBLISH_METRIC.metricType
      ? WATER_PUBLISH_METRIC.hkIdentifier
      : null;
  }
  if (capture.kind === 'body' && capture.column !== null) {
    return BODY_PUBLISH_METRICS.find((m) => m.column === capture.column)?.hkIdentifier ?? null;
  }
  return null;
}

/** The one sample a capture row publishes under `identifier`, read as it is now. */
function publishedSample(db: Database, identifier: string, id: string): BodySample | null {
  if (identifier === WATER_PUBLISH_METRIC.hkIdentifier) {
    const row = getPublishableWater(db, id);
    return row ? waterSampleFor(row) : null;
  }
  const row = getPublishableBody(db, id);
  return row ? (bodySamplesFor(row).find((s) => s.hkIdentifier === identifier) ?? null) : null;
}

/** What {@link removeLogCapture} did — the record half and the Health half. */
export type RemovedCapture = {
  taken: TakenCapture;
  /**
   * How many samples the tagged delete took out of Apple Health: 0 when none
   * had gone out yet, when sync is off, or when the capture is not a published
   * kind. The Undo reads it to know whether there is anything to send back.
   */
  health: Promise<number>;
};

/**
 * Delete one capture from the Log tab's record AND undo every side effect it
 * had — the ONE function the Log tab's × and the Coach's `captures` removal
 * both call (owner, 2026-09-25). The record half is `takeCapture`
 * (src/lib/db/repositories/logs.ts), which traces each kind; what it cannot
 * reach is the sample a weight, a body-fat or waist reading, or a glass of
 * water put into Apple Health. Each carries its row's id as its tag, so it is
 * removed by that tag — the path {@link removeWaterCapture} has taken since
 * two-way water, now for the body channel too.
 *
 * ARC's row goes first and synchronously; the Health half is best-effort and
 * gated on the same one switch as every Health write. A sample whose save is in
 * flight at this moment is taken back by the walk once it lands
 * (settleSavedWater, settleSavedBody). Null when the feed lists no such
 * capture, and then nothing is touched.
 */
export function removeLogCapture(
  db: Database,
  feedId: string,
  deps: WaterPublishDeps = NATIVE_WATER_DEPS
): RemovedCapture | null {
  const taken = takeCapture(db, feedId, getPreferences(db).units);
  if (!taken) return null;
  const identifier = publishedIdentifier(taken);
  let health: Promise<number> = Promise.resolve(0);
  try {
    if (identifier !== null && mayTouchHealth(db, deps)) {
      health = deps.deleteByTag(identifier, taken.capture.rowId).catch(() => 0);
    }
  } catch {
    // The record half is done; a Health seam that throws must not undo it.
  }
  return { taken, health };
}

/**
 * Put back what {@link removeLogCapture} took, exactly: the row (throwing,
 * synchronously and writing nothing, when it cannot come back — the Undo row
 * then says so) and, when the deletion took a sample out of Apple Health, that
 * sample again — the same value, the same instant, the same tag, so it is the
 * reading that was there rather than a new one.
 *
 * A capture that had not gone out yet needs nothing sent: it is back on the
 * record with its own `created_at`, ahead of the publish cursor, and the next
 * walk sends it. Resolves to whether a sample was re-sent; the screen ignores
 * it and the headless suite awaits it.
 */
export function restoreLogCapture(
  db: Database,
  removed: RemovedCapture,
  deps: WaterPublishDeps = NATIVE_WATER_DEPS
): Promise<boolean> {
  restoreCapture(db, removed.taken);
  const identifier = publishedIdentifier(removed.taken);
  if (identifier === null) return Promise.resolve(false);
  const id = removed.taken.capture.rowId;
  return removed.health
    .then(async (taken) => {
      if (taken === 0 || !mayTouchHealth(db, deps)) return false;
      const sample = publishedSample(db, identifier, id);
      if (!sample) return false;
      return deps.save(sample.hkIdentifier, sample.hkUnit, sample.value, sample.at, sample.at, {
        [ARC_WRITE_METADATA_KEY]: sample.sourceRowId,
      });
    })
    .catch(() => false);
}

// --- A glass goes out when it is logged (2026-09-23) --------------------------------
//
// Until this, nothing after a write started a publish: a glass reached Apple
// Health on the next sync pass — boot, a foreground return at least
// AUTO_SYNC_THROTTLE_MIN after the last pass, Sync now, or a blank Home metric.
// The obvious test — tap Glass, open the Health app — showed nothing. Every door
// that writes a manual capture now starts a water-only pass straight after the
// write (docs/wearables-subapp.md §20.10).

/**
 * The follow-up water pass queued behind the running one, not yet started. The
 * water walk's half of the rule `sync.ts` keeps for whole passes (§22.2): never
 * more than one waits.
 */
let waterQueued: Promise<HealthPublishResult> | null = null;

/**
 * A water pass that sees every capture written before this call.
 *
 * {@link publishWaterCaptures} JOINS a running pass. That is right for the full
 * sync, because the pass it joins does all its work, and wrong for a capture
 * just written: a pass that began before the tap read its rows before the tap,
 * so joining it would leave the new glass for the next sync. So this never
 * joins a running pass. It queues ONE follow-up behind it, and a later ask
 * shares that follow-up, which has not started and so will read later still.
 *
 * Every water walk goes through {@link publishWaterCaptures}: this one, its
 * follow-up and the full sync's. Its single in-flight pass is the gate, so two
 * walks never read the water cursor at once. A capture saved by one walk is
 * behind the cursor before the next walk reads it, which is what stops the next
 * sync from saving it a second time.
 */
export function requestWaterPublish(
  db: Database,
  now: Date = new Date(),
  deps: WaterPublishDeps = NATIVE_WATER_DEPS
): Promise<HealthPublishResult> {
  if (waterQueued) return waterQueued;
  const running = waterInFlight;
  if (!running) return publishWaterCaptures(db, now, deps);
  const ignore = (): void => undefined;
  const queued = running.then(ignore, ignore).then(() => {
    waterQueued = null;
    // Its own clock, read when it actually starts.
    return publishWaterCaptures(db, new Date(), deps);
  });
  waterQueued = queued;
  return queued;
}

/**
 * Start sending the manual water captures to Apple Health, without waiting for
 * the next sync. What every door that writes a glass calls straight after the
 * write, through {@link logWaterCapture} and {@link logMetricCapture}.
 *
 * - **Nothing is scheduled** with sync off or no HealthKit (the web preview, a
 *   build without the module, node). It is the same one switch as every other
 *   Health write, checked before anything is queued.
 * - **Never on the tap's time.** The pass starts on the next macrotask, after
 *   the handler has returned and the new row is drawn, and every native call
 *   in it is asynchronous. The tap pays for one preference read.
 * - **Never throws or rejects.** The capture is already written. A refused
 *   save stalls on the cursor (rule 2) and the next sync retries it.
 *
 * Resolves to the pass's result, or null when nothing ran. The screens ignore
 * it; the headless suite awaits it.
 */
export function publishWaterOnLog(
  db: Database,
  deps: WaterPublishDeps = NATIVE_WATER_DEPS
): Promise<HealthPublishResult | null> {
  try {
    if (!mayTouchHealth(db, deps)) return Promise.resolve(null);
  } catch {
    return Promise.resolve(null);
  }
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
    .then(() => requestWaterPublish(db, new Date(), deps))
    .catch(() => null);
}

/**
 * Log one water capture AND start sending it to Apple Health: the Log tab's
 * vessels and the water screen's Add. Returns `logWater`'s id, which the Undo
 * deletes by. The write is synchronous and first, exactly as before; the
 * publish is {@link publishWaterOnLog}, which cannot fail the write.
 */
export function logWaterCapture(
  db: Database,
  date: string,
  ml: number,
  deps: WaterPublishDeps = NATIVE_WATER_DEPS
): string {
  const id = logWater(db, date, ml);
  void publishWaterOnLog(db, deps);
  return id;
}

/**
 * `logMetric`, plus: a water capture starts its publish the way
 * {@link logWaterCapture}'s does. For the keypad, the Log tab's command line
 * and the Coach's `log_metric`, which by the parity rule calls what the keypad
 * calls. Every other metric is `logMetric` unchanged, so a weight still goes out
 * on the next sync.
 */
export function logMetricCapture(
  db: Database,
  date: string,
  metricKey: MetricKey,
  canonical: number,
  deps: WaterPublishDeps = NATIVE_WATER_DEPS
): void {
  logMetric(db, date, metricKey, canonical);
  const target = metricByKey(metricKey)?.target;
  if (target?.kind === 'wearable' && target.metricType === WATER_PUBLISH_METRIC.metricType) {
    void publishWaterOnLog(db, deps);
  }
}

// --- Where a glass cannot go yet ------------------------------------------------------

/** What the water screen needs to say whether a glass logged there can go out. */
export type WaterPublishFacts = {
  /** The one switch, `isHealthSyncEnabled`. */
  syncEnabled: boolean;
  /**
   * Settings' own classifier (`healthWriteAccess`), scoped to Water alone, so
   * weight's August grant cannot answer for it.
   */
  access: HealthWriteAccess;
};

/**
 * Water was never put to the user: the write scope arrived after he connected.
 * It names the control, because *Allow publishing* is the one tap that fixes
 * it, and it is shown in exactly this state (`unaskedWriteIdentifiers`).
 */
export const WATER_UNASKED_LINE =
  'Not sent to Apple Health yet — tap Allow publishing in Settings › Apple Health';
/** Water was asked and refused. The fix is in iOS Settings, which that screen names. */
export const WATER_REFUSED_LINE =
  'Apple Health is refusing water from ARC — see Settings › Apple Health';

/**
 * The one line the water screen shows while a glass logged there cannot reach
 * Apple Health, or null. PURE, so the show/hide rule is pinned headlessly.
 *
 * Shown only while sync is on: with it off nothing is sent by design, and
 * Settings already says so. Unsupported (no module) and unknown (no status API)
 * say nothing, because nothing honest can be said. Granted says nothing, which
 * is how the line goes away once he taps *Allow publishing*.
 */
export function waterPublishPointer(facts: WaterPublishFacts): string | null {
  if (!facts.syncEnabled) return null;
  switch (facts.access) {
    case 'undetermined':
    case 'incomplete':
      return WATER_UNASKED_LINE;
    case 'denied':
    case 'partial':
      return WATER_REFUSED_LINE;
    default:
      return null;
  }
}

/**
 * Send what stalled, once the water screen's line has gone: the screen calls
 * this with the line it showed before a re-read and the line it shows after.
 *
 * *Allow publishing* runs a sync of its own, but a refusal is lifted in the iOS
 * Settings app, and coming back from there starts a sync only if the last one
 * was at least `AUTO_SYNC_THROTTLE_MIN` ago. Without this the glasses logged
 * meanwhile would wait for the next tap or the next sync, behind a screen that
 * had just stopped saying they could not go out.
 *
 * Starts nothing unless a line was showing and is gone. If it went because sync
 * was turned off, {@link publishWaterOnLog} starts nothing either. Never throws.
 */
export function releaseStalledWater(
  db: Database,
  before: string | null,
  after: string | null,
  deps: WaterPublishDeps = NATIVE_WATER_DEPS
): Promise<HealthPublishResult | null> {
  if (before === null || after !== null) return Promise.resolve(null);
  return publishWaterOnLog(db, deps);
}

/** The facts, read: the same switch and the same classifier Settings reads. */
export function waterPublishFacts(db: Database): WaterPublishFacts {
  return {
    syncEnabled: isHealthSyncEnabled(db),
    access: healthWriteAccess([WATER_PUBLISH_METRIC.hkIdentifier]),
  };
}
