/**
 * Apple Health sync orchestration (docs/wearables-subapp.md §4–5, §10–11).
 *
 * A "sync" is genuinely both directions as of 2026-08-12. Inbound: the wearable
 * metrics ARC does not own (→ `wearable_data`) plus the three body measurements
 * it does (→ `body_metrics`, so a smart scale reaches the same trend a keypad
 * entry does). Outbound: those same three body measurements, published from
 * `body_metrics` (`publish.ts`). Ingest and publish share the enable flag and
 * this entry point and nothing else — separate cursors, separate windows,
 * separate failure handling.
 *
 * Strategy: trailing-window re-aggregation. Each sync recomputes the last
 * {@link SYNC_WINDOW_DAYS} days (first sync: {@link FIRST_SYNC_DAYS}) and
 * UPSERTs on the deterministic (source_device, source_raw_id) key, so
 * late-arriving Watch data, the Watch's delete-and-replace of resting-HR
 * estimates, and timezone shifts all converge on the next pass instead of
 * duplicating. No anchors, no background delivery — foreground windows are
 * enough for a daily operating system, and the whole flow no-ops whenever the
 * native module isn't in the binary — web/node, or a build predating the
 * module's 2026-08-25 EAS landing.
 *
 * **"Converge" now means converge, not merely overwrite (2026-09-14).** The pass
 * used to only INSERT and UPDATE, so a bucket whose samples MOVED off its day —
 * a timezone trip re-bucketing the fortnight, or a sample deleted in the Health
 * app — left its old row standing, describing nothing, and every baseline and
 * Coach correlation kept reading it (docs/spikes/timezone-days.md §1c). A pass
 * that produces buckets for a metric now also removes the buckets in its window
 * it did NOT produce, in the same transaction. The safety condition is that only
 * metrics read cleanly AND non-empty are reconciled — see `reconcilable` in
 * {@link syncHealthData}, and the scoping rules on `upsertWearableRows`.
 *
 * **"Timezone shifts converge on the next pass" used to mean converge on a NEW
 * answer (2026-09-19, 0060).** The pass re-derived every sample's day under the
 * device's CURRENT zone, so the first sync after landing re-dated a fortnight of
 * history and the prune above then deleted what the re-dating orphaned. A
 * sample is now bucketed under the offset that was in force WHEN IT HAPPENED,
 * read from the `timezone_changes` rows (`offsetHistory`), so a London night
 * keeps the London wake day it was lived on. Owner's Q4(a), and the price is
 * stated where it is paid (`localDayOf`): ARC and the Health app can disagree
 * about trip-adjacent days. The one-time reach back over history written under
 * the old rule is {@link rebucketWindowDays}.
 *
 * The window/day maths ({@link syncDayWindows}, {@link shouldAutoSync},
 * {@link rebucketWindowDays}) is pure and exported for the headless tests; the
 * entry points just glue the guarded reader → pure mapping → wearables repo
 * together.
 */
import type { Database } from '@/lib/db/database';
import {
  calendarDateAtOffset,
  dayStartAtOffset,
  formatLocalDate,
  localDayStart,
  localNoonOf,
  shiftISODate,
} from '@/lib/db/date';
import {
  earliestTimezoneDay,
  observeTimezone,
  offsetHistory,
} from '@/lib/db/repositories/day-meta';
import { daysBetween } from '@/lib/protocols/cadence';
import { NO_OFFSET_HISTORY, type OffsetLookup } from '@/lib/timezone/offset-history';
import type { HealthQuantitySample } from './types';
import {
  getHealthSyncState,
  setHealthSyncLog,
  setHealthSyncState,
  upsertWearableRows,
  workoutUuidsWithHr,
  type HealthSyncState,
  type WearableUpsert,
} from '@/lib/db/repositories/wearables';
import { isHealthSyncEnabled } from '@/lib/db/repositories/user';
import { pairIngestedWorkouts } from '@/lib/db/repositories/workout-ingest';

import { upsertHealthBodyRows } from '@/lib/db/repositories/body';

import {
  BODY_INGEST_METRICS,
  bodyIngestRows,
  isPublishedIdentifier,
  noBodyRejections,
  quantityDailyRows,
  SAMPLE_METRICS,
  sleepDailyRows,
  STATISTIC_METRICS,
  statisticDailyRows,
  workoutRows,
} from './mapping';
import {
  emptyPublishLog,
  rejectedTotal,
  WORKOUT_HR_METRIC,
  type HealthMetricLog,
  type HealthSyncLog,
} from './log';
import {
  isHealthKitAvailable,
  readDailyCumulative,
  readQuantitySamples,
  readSleepSamples,
  readWorkouts,
} from './healthkit';
import { publishBodyMetrics, publishWaterCaptures } from './publish';

/** Steady-state re-aggregation window (self-healing horizon). */
export const SYNC_WINDOW_DAYS = 14;
/** First-enable backfill (per-day rows are tiny; query time is the only cost). */
export const FIRST_SYNC_DAYS = 90;
/** Ceiling on a gap-catch-up window, so a year-long absence stays one pass. */
export const MAX_SYNC_DAYS = 365;
/** Foreground auto-syncs are throttled to at most one per this many minutes. */
export const AUTO_SYNC_THROTTLE_MIN = 15;

export type SyncDay = { date: string; start: Date; end: Date };

/**
 * The local-midnight day buckets to (re-)aggregate, oldest first, ending with
 * today. Built with the calendar (never +86400s) so DST days stay correct.
 *
 * **Midnight-to-midnight, not the user's day boundary** — never `todayISODate`.
 * These windows produce the `hk:<metric>:<date>` rows, and the full argument for
 * keeping HealthKit on the calendar day is on `localDayOf` in ./mapping.ts. The
 * two must agree: the window that queries the samples and the function that
 * buckets them are the same day definition or the upsert key misses — which is
 * why `offsetOf` is threaded through both and why it is the SAME lookup instance
 * in a pass.
 *
 * **Midnight WHERE** is the 0060 change. With an offset history, each day's
 * bounds are taken in the zone that day was lived in; with none — or for days
 * after the latest recorded change — they are the device's current local
 * components, DST-correct, exactly as before.
 */
export function syncDayWindows(
  now: Date,
  days: number,
  offsetOf: OffsetLookup = NO_OFFSET_HISTORY
): SyncDay[] {
  const today = dateAt(now, offsetOf);
  const result: SyncDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = shiftISODate(today, -i);
    result.push({ date, start: dayStart(date, offsetOf), end: dayStart(shiftISODate(date, 1), offsetOf) });
  }
  return result;
}

/** The calendar day an instant falls on, under whatever offset was in force. */
function dateAt(instant: Date, offsetOf: OffsetLookup): string {
  const offset = offsetOf(instant);
  return offset === null ? formatLocalDate(instant) : calendarDateAtOffset(instant, offset);
}

/**
 * The instant a calendar day begins, under the offset in force ON that day.
 *
 * Probed at the day's NOON, never its midnight: noon exists in every zone on
 * every day, and a midnight probe on a seam day would be asking the step
 * function about the very boundary it is trying to place.
 *
 * Because a day's END is probed as the NEXT day's start, a seam day's bounds
 * come out spanning its real `24 + Δ` hours with no special case — the start is
 * under the old offset and the end is under the new one. That is the property
 * that makes the window cover a 33-hour day rather than clipping nine hours off
 * one end of it.
 */
function dayStart(date: string, offsetOf: OffsetLookup): Date {
  const offset = offsetOf(localNoonOf(date));
  return offset === null ? localDayStart(date) : dayStartAtOffset(date, offset);
}

/**
 * The sample/sleep query span for a window: from noon before the window's
 * first day (so the first night's sleep session is fully covered) to `now`.
 *
 * The noon lead-in is a 12-hour cushion, and under a stored offset it is taken
 * in THAT day's own zone rather than in the zone the phone is in now — so a
 * date-line hop cannot shift the cushion out from under the night it exists to
 * cover. The 12-hour limit itself is unchanged: a Pacific hop can still truncate
 * the seam night, which is the one the seam day owns anyway.
 */
export function sampleQuerySpan(
  now: Date,
  days: number,
  offsetOf: OffsetLookup = NO_OFFSET_HISTORY
): { start: Date; end: Date } {
  const leadIn = shiftISODate(dateAt(now, offsetOf), -days);
  const start = new Date(dayStart(leadIn, offsetOf).getTime() + 12 * 3_600_000);
  return { start, end: now };
}

/**
 * How many days back this pass should (re-)aggregate — pure, and the whole
 * windowing policy in one place:
 *
 *   - never synced (or a previous pass wrote nothing) → the full first-enable
 *     backfill, so a denied-then-granted permission still gets its 90 days;
 *   - otherwise the steady-state re-aggregation window, EXTENDED to cover every
 *     day since the last sync. Without that extension a >14-day absence (app
 *     unopened, or the toggle switched off and back on months later) would leave
 *     a permanent hole: HealthKit still has the data, but no later pass would
 *     ever look at those days again.
 *
 * Capped at {@link MAX_SYNC_DAYS} so a years-dormant install stays one pass.
 */
export function syncWindowDays(
  state: { lastSyncedAt: string | null; firstSyncedAt: string | null },
  now: Date
): number {
  if (!state.firstSyncedAt) return FIRST_SYNC_DAYS;
  const last = state.lastSyncedAt === null ? Number.NaN : new Date(state.lastSyncedAt).getTime();
  if (Number.isNaN(last)) return FIRST_SYNC_DAYS;
  const elapsedDays = Math.ceil((now.getTime() - last) / 86_400_000);
  // +1 so the day the last sync happened on is itself re-aggregated (it was
  // partial at the time).
  return Math.min(MAX_SYNC_DAYS, Math.max(SYNC_WINDOW_DAYS, elapsedDays + 1));
}

/**
 * Drop rows dated outside the window this pass is responsible for — pure, and
 * load-bearing rather than defensive.
 *
 * {@link sampleQuerySpan} deliberately starts at NOON of the day *before* the
 * window's first day, so the first night's sleep session is fully covered. But
 * the mappers bucket every sample by its own local day, so that half-day tail
 * also produces rows dated one day before the window — rebuilt from AFTERNOON
 * SAMPLES ONLY. Those rows carry the same deterministic `hk:<metric>:<date>` id
 * as the complete rows written while that day was inside the window, so the
 * upsert would overwrite a correct full-day aggregate with a partial one.
 *
 * Because the boundary day advances with `now`, that would corrupt every day of
 * history exactly once — on the day it aged out of the window. A daily HRV mean
 * would silently become "the value of whatever was recorded after noon", and a
 * 7-hour night would be replaced by a 30-minute nap (the only sleep session
 * ending on that day within the truncated span). Baselines and every Coach
 * correlation read those rows, so the damage would be invisible and permanent.
 */
export function clampRowsToWindow(rows: WearableUpsert[], days: SyncDay[]): WearableUpsert[] {
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;
  if (first === undefined || last === undefined) return [];
  return rows.filter((row) => row.date >= first && row.date <= last);
}

/** Whether an automatic (boot/foreground) sync should run yet — pure. */
export function shouldAutoSync(lastSyncedAt: string | null, now: Date): boolean {
  if (!lastSyncedAt) return true;
  const last = new Date(lastSyncedAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= AUTO_SYNC_THROTTLE_MIN * 60_000;
}

export type HealthSyncResult = {
  status: 'synced' | 'disabled' | 'unavailable';
  /**
   * Rows processed INBOUND this pass — `wearable_data` plus `body_metrics`.
   *
   * ⚠️ MIXED SEMANTICS: the `body_metrics` half (`upsertHealthBodyRows`) counts
   * rows that actually CHANGED, but the `wearable_data` half (`upsertWearableRows`)
   * counts rows ATTEMPTED, so an unchanged re-sync still reports the full
   * aggregate count. Honest parity needs `upsertWearableRows` to accumulate
   * `db.changes()` across its DO UPDATE … WHERE-CHANGED statements — a change to
   * `src/lib/db/repositories/wearables.ts`.
   *
   * Stale day buckets REMOVED by the reconcile pass are counted in too. A delete
   * is a change the pass made, and a run that only cleaned up would otherwise
   * report "0 rows changed" on the one occasion that mattered.
   */
  rowsWritten: number;
  /** Samples PUBLISHED outward this pass (weight / body fat / waist). */
  samplesPublished: number;
  syncedAt: string | null;
};

// The boot/foreground sync is fire-and-forget, so screens already mounted when
// it lands need a poke to re-read (useSyncExternalStore-style, like the
// api-key-store's listeners). Emitted after every completed sync pass.
type Listener = () => void;
const listeners = new Set<Listener>();

/** Re-render hook for readiness/history views; returns the unsubscribe. */
export function subscribeHealthSync(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitSynced(): void {
  for (const listener of listeners) listener();
}

/**
 * One full sync pass: read every scope over the window, map pure, upsert.
 * Serial per metric (HK statistics ride XPC; parallelism buys nothing) and
 * per-metric failures degrade to empty reads inside the seam, so a single bad
 * identifier can't sink the pass.
 */
/**
 * The window, widened ONCE so the offset-aware bucketing can reach the history
 * that was written under the old rule (0060).
 *
 * ARC stores no samples — it stores `hk:<metric>:<date>` aggregates — so there
 * is nothing a migration could walk. The only way to re-bucket is to read
 * HealthKit again, and a sync pass IS that read. This is that migration,
 * spelled the only way this data model can spell one.
 *
 * Three properties, each load-bearing:
 *
 *   - **No rows, no widening.** A build that has never observed a zone change
 *     has nothing bucketed wrongly: with an empty table the step function is
 *     `null` everywhere and the pass is byte-identical to the one before it.
 *     That is what makes shipping this in the same binary as 0053 a no-op on
 *     first launch — the risk moment is the first sync after the first observed
 *     TRIP, not the first launch.
 *   - **Only back to the oldest row.** Reaching further would re-read days no
 *     row speaks for, where the answer is unchanged by construction.
 *   - **Capped at {@link FIRST_SYNC_DAYS}**, so this can never become a
 *     year-long read.
 *
 * `rebucketedAt` lives in the `health_sync_state` JSON, which 0021 made free
 * precisely so a second cursor would not be a schema change. It is stamped only
 * once a pass has both landed data AND had rows to widen for, so a denied
 * permission — or a build that simply has not travelled yet — cannot burn the
 * one-time reach.
 */
export function rebucketWindowDays(db: Database, state: HealthSyncState, now: Date): number {
  const base = syncWindowDays(state, now);
  if (state.rebucketedAt !== null) return base;
  const oldest = earliestTimezoneDay(db);
  if (oldest === null) return base;
  const reach = daysBetween(oldest, formatLocalDate(now)) + 1;
  return Math.min(FIRST_SYNC_DAYS, Math.max(base, reach));
}

export type SyncOptions = {
  /**
   * Re-aggregate exactly this many days instead of whatever {@link
   * syncWindowDays} would choose. The one caller is Settings' *Read heart rate
   * (90 days)* control, which needs the pass to revisit history a newly-granted
   * scope was never asked for during.
   *
   * An override rather than clearing `firstSyncedAt`: that cursor's re-stamp is
   * conditional on `written > 0` precisely so a denied permission cannot burn
   * the one-time backfill, and clearing it would hand that guard a second,
   * unrelated job. `lastSyncedAt` is still stamped as on any pass, which only
   * resets the elapsed-time widening below — harmless, since the pass just
   * covered 90 days.
   */
  windowDays?: number;
};

export async function syncHealthData(
  db: Database,
  now: Date = new Date(),
  options: SyncOptions = {}
): Promise<HealthSyncResult> {
  if (!isHealthSyncEnabled(db)) {
    return { status: 'disabled', rowsWritten: 0, samplesPublished: 0, syncedAt: null };
  }
  if (!isHealthKitAvailable()) {
    return { status: 'unavailable', rowsWritten: 0, samplesPublished: 0, syncedAt: null };
  }

  // OBSERVE BEFORE WINDOWING (0060). A third sanctioned observation site beside
  // the database open and the foreground listener, and the only one that is here
  // for an ordering rather than for coverage: this pass buckets every sample by
  // the offset in force when it happened, so a change ARC has not yet recorded
  // would send the whole window to the live getters and re-bucket the fortnight
  // under the new zone — the exact defect this is closing. The foreground
  // listener normally gets there first; this makes the pass self-sufficient
  // rather than dependent on it. Cost is one preference read, and the auto path
  // is already throttled to one pass per AUTO_SYNC_THROTTLE_MIN minutes.
  try {
    observeTimezone(db, now);
  } catch {
    // A sync must never fail over an annotation. The next foreground retries.
  }
  const offsetOf = offsetHistory(db);

  const state = getHealthSyncState(db);
  const windowDays =
    options.windowDays !== undefined && Number.isFinite(options.windowDays)
      ? Math.min(MAX_SYNC_DAYS, Math.max(1, Math.trunc(options.windowDays)))
      : rebucketWindowDays(db, state, now);
  const days = syncDayWindows(now, windowDays, offsetOf);
  const span = sampleQuerySpan(now, windowDays, offsetOf);

  const rows: WearableUpsert[] = [];
  // The per-run log (docs §14). Built as the pass goes so that every zero on the
  // Settings screen can name the step that produced it.
  const metrics: HealthMetricLog[] = [];
  // Metric types this pass may RECONCILE — i.e. whose stale `hk:` buckets inside
  // the window it is allowed to delete (docs/spikes/timezone-days.md §1c, and
  // the note on `upsertWearableRows`). The bar is deliberately high, and it is
  // set HERE because this is the only place that can tell an empty read from a
  // failed one:
  //
  //   - the read produced at least one row this pass, AND
  //   - the read reported no native error.
  //
  // A metric that read nothing prunes nothing, so a denied permission or a
  // refused predicate can never be mistaken for "HealthKit no longer has this"
  // and cost a fortnight of history. For a statistics read `error !== null`
  // means at least one DAY of the window threw, which makes the window
  // incomplete and the pass unfit to judge absence; for a sample read it may
  // only mean an exclusion rung was refused before a later one succeeded — but
  // declining to prune is the safe direction of that ambiguity, and the next
  // clean pass reconciles anyway.
  const reconcilable = new Set<string>();
  const allowReconcile = (mapped: readonly WearableUpsert[], error: string | null): void => {
    if (error !== null) return;
    for (const row of mapped) reconcilable.add(row.metricType);
  };

  for (const spec of SAMPLE_METRICS) {
    const read = await readQuantitySamples(spec.hkIdentifier, spec.hkUnit, span.start, span.end);
    const mapped = quantityDailyRows(spec, read.samples, offsetOf);
    rows.push(...mapped);
    allowReconcile(mapped, read.error);
    metrics.push({
      metric: spec.metricType,
      label: spec.metricType,
      returned: read.samples.length,
      rows: mapped.length,
      exclusion: read.exclusion,
      error: read.error,
      rejected: null,
    });
  }
  for (const spec of STATISTIC_METRICS) {
    // A statistic ARC also PUBLISHES (water, since 2026-09-21) reads through the
    // exclusion ladder and fails closed: its merged total would otherwise hold
    // ARC's own captures, and the day would count them twice (docs §20). Every
    // other statistic reads exactly as it always has.
    const read = await readDailyCumulative(spec.hkIdentifier, spec.hkUnit, days, {
      failClosed: isPublishedIdentifier(spec.hkIdentifier),
    });
    const mapped = statisticDailyRows(spec, read.samples);
    rows.push(...mapped);
    allowReconcile(mapped, read.error);
    metrics.push({
      metric: spec.metricType,
      label: spec.metricType,
      returned: read.samples.length,
      rows: mapped.length,
      exclusion: read.exclusion,
      error: read.error,
      rejected: null,
    });
  }

  const sleep = await readSleepSamples(span.start, span.end);
  const sleepMapped = sleepDailyRows(sleep.samples, offsetOf);
  rows.push(...sleepMapped);
  // Sleep produces several metric types from one read, and only the ones it
  // actually emitted are reconcilable — a source that stopped writing STAGES
  // emits no `sleep_deep_min` at all this pass, so nothing licenses deleting
  // last week's.
  allowReconcile(sleepMapped, sleep.error);
  metrics.push({
    metric: 'sleep',
    label: 'sleep',
    returned: sleep.samples.length,
    rows: sleepMapped.length,
    exclusion: sleep.exclusion,
    error: sleep.error,
    rejected: null,
  });

  // Sessions whose stored row already carries a heart-rate figure. Door 2 — the
  // derived per-source fallback — is skipped for these; door 1, the writer's own
  // association, still runs for every session, because that is the path by which
  // a revised association can still land.
  const hrSkip = workoutUuidsWithHr(db);
  const workouts = await readWorkouts(span.start, span.end, { hrSkip });
  const workoutMapped = workoutRows(workouts.samples, offsetOf);
  rows.push(...workoutMapped);
  metrics.push({
    metric: 'workout',
    label: 'workout',
    returned: workouts.samples.length,
    rows: workoutMapped.length,
    exclusion: workouts.exclusion,
    error: workouts.error,
    rejected: null,
  });

  // In-workout heart rate gets its OWN row (docs §15). `returned` is the
  // workouts examined this pass and `rows` the ones that produced a figure —
  // the direction HealthMetricLog declares and Settings renders as
  // `returned → rows`, so "31 → 0" is readable as "every session was seen, none
  // had a heart rate". `exclusion: 'none'`: statistics carry no own-write
  // exclusion, exactly as `readDailyCumulative` reports.
  const hrRows = workouts.samples.filter((w) => w.hr !== undefined);
  const byWorkout = hrRows.filter((w) => w.hr?.method === 'workout').length;
  metrics.push({
    metric: WORKOUT_HR_METRIC,
    label: 'Heart rate during workouts',
    returned: workouts.samples.length,
    rows: hrRows.length,
    exclusion: 'none',
    error: workouts.hrError,
    rejected: null,
    detail: [
      workouts.associated ? `associated: ${workouts.associated.join(', ') || 'none'}` : null,
      `by workout ${byWorkout}`,
      `by source ${hrRows.length - byWorkout}`,
    ]
      .filter((part): part is string => part !== null)
      .join(' · '),
  });

  // The body channel's INBOUND half (docs §11). It lands in `body_metrics`, not
  // `wearable_data`, because that is the table that owns weight / body fat /
  // waist — a scale reading has to reach the same trend, the same Coach tools
  // and the same export as a number typed into ARC, or the two-way link would
  // only be two-way on paper.
  //
  // `failClosed` is what makes reading a PUBLISHED type safe: no unfiltered
  // retry, so a rejected exclusion predicate yields nothing instead of yielding
  // ARC's own samples back. Rows are NOT clamped by `clampRowsToWindow` — that
  // clamp exists for day AGGREGATES rebuilt from a truncated tail, and these are
  // individual measurements at their own instants, so a sample from the span's
  // half-day lead-in is simply a real measurement, complete and correctly dated.
  const bodyInput: {
    spec: (typeof BODY_INGEST_METRICS)[number];
    samples: HealthQuantitySample[];
  }[] = [];
  // Kept alongside the samples so the log can report the query's own outcome
  // (which exclusion survived, and any native error) separately from the
  // per-sample guard verdicts. They are different failures with different fixes.
  const bodyReads = new Map<
    string,
    { exclusion: HealthMetricLog['exclusion']; error: string | null }
  >();
  for (const spec of BODY_INGEST_METRICS) {
    const read = await readQuantitySamples(spec.hkIdentifier, spec.hkUnit, span.start, span.end, {
      failClosed: true,
    });
    bodyInput.push({ spec, samples: read.samples });
    bodyReads.set(spec.hkIdentifier, { exclusion: read.exclusion, error: read.error });
  }
  const body = bodyIngestRows(bodyInput);
  const bodyWritten = upsertHealthBodyRows(db, body.rows);

  for (const spec of BODY_INGEST_METRICS) {
    const read = bodyReads.get(spec.hkIdentifier);
    const rejected = body.rejected[spec.hkIdentifier] ?? noBodyRejections();
    const returned = bodyInput.find((b) => b.spec === spec)?.samples.length ?? 0;
    metrics.push({
      metric: spec.column,
      label: spec.label,
      returned,
      // A body sample becomes a COLUMN on a row keyed by its instant, and one
      // weigh-in can fill three columns on one row — so "rows" here is what
      // survived the guards, not a row count. Reporting the merged row count
      // would make two of the three metrics look like they landed nothing.
      rows: returned - rejectedTotal(rejected),
      exclusion: read?.exclusion ?? 'none',
      error: read?.error ?? null,
      rejected,
    });
  }

  // Ingest and reconcile in one transaction (docs §4). `workout` is never
  // reconcilable — a workout row is keyed by its HealthKit UUID rather than by
  // an `hk:<metric>:<date>` bucket, so the prune's `hk:` scope skips it anyway;
  // it is left out of the allow-list too so the intent is stated and not merely
  // implied by a GLOB.
  reconcilable.delete('workout');
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;
  const written =
    upsertWearableRows(
      db,
      clampRowsToWindow(rows, days),
      first !== undefined && last !== undefined
        ? { first, last, metricTypes: [...reconcilable] }
        : undefined
    ) + bodyWritten;

  // Pair ingested sessions with the ones ARC logged (0054). It runs HERE as well
  // as on workout save because either side can arrive second, and the mirror is
  // usually the one that does: the owner finishes a session in ARC and the watch
  // hands the same hour to HealthKit minutes later. Idempotent by construction —
  // anything already linked is excluded from both sides of the pass — so a
  // fifteen-minute foreground sync re-pairs nothing and duplicates nothing.
  //
  // After the upsert, deliberately: pairing reads the rows this pass just wrote,
  // and their spans are what it matches on.
  pairIngestedWorkouts(db, now);

  const syncedAt = now.toISOString();
  setHealthSyncState(db, {
    lastSyncedAt: syncedAt,
    // Only claim a completed first sync once a pass actually LANDED data.
    // A pass can complete having written nothing — most importantly when the
    // user denied read access (HealthKit makes denial indistinguishable from
    // "no data"), and stamping firstSyncedAt then would burn the one-time
    // backfill: after granting access later, every pass would use the short
    // steady-state window and days 15-90 of history would be unreachable.
    firstSyncedAt: state.firstSyncedAt ?? (written > 0 ? syncedAt : null),
    // The one-time offset-aware re-read (0060). Stamped only when the pass both
    // LANDED data and had rows to widen for: a denied permission must not burn
    // it, and neither must a build that has simply not travelled yet — on that
    // build there is nothing bucketed wrongly, and the reach is still owed for
    // the first sync after the first observed trip.
    rebucketedAt:
      state.rebucketedAt ??
      (written > 0 && earliestTimezoneDay(db) !== null ? syncedAt : null),
  });

  // The outbound half of the same pass (docs §10). It runs AFTER the ingest
  // cursor is stamped so a publish problem can never cost the ingest its
  // progress, and it carries its own cursor and its own failure posture — the
  // two directions share only the enable flag. Degrades to zero on throw for
  // the same reason every reader here does: Settings shows the honest counts,
  // and the next pass retries from an unmoved cursor.
  let samplesPublished = 0;
  const publish = emptyPublishLog();
  // Two walks, one log: the body walk and (since 2026-09-21) the water walk,
  // each with its own cursor and each allowed to fail without costing the other
  // its pass. `types` keeps them apart for the reader; the totals add.
  for (const walk of [publishBodyMetrics, publishWaterCaptures]) {
    try {
      const result = await walk(db, now);
      samplesPublished += result.samplesWritten;
      publish.armed = publish.armed || result.armed;
      publish.stalled = publish.stalled || result.stalled;
      publish.attempted += result.samplesAttempted;
      publish.succeeded += result.samplesWritten;
      publish.types = [...publish.types, ...result.byType];
    } catch {
      // Degrades to zero for this walk; the next pass retries from its cursor.
    }
  }

  // Written LAST and outside the ingest cursor's write, so a log failure can
  // never cost the pass its progress. Best-effort for the same reason: a
  // diagnostic that can break the thing it describes is worse than no
  // diagnostic.
  const log: HealthSyncLog = {
    at: syncedAt,
    windowDays,
    rowsWritten: written,
    metrics,
    publish,
  };
  try {
    setHealthSyncLog(db, log);
  } catch {
    // The screen falls back to "no log yet" and the next pass rewrites it.
  }

  emitSynced();
  return { status: 'synced', rowsWritten: written, samplesPublished, syncedAt };
}

// ── One pass at a time (2026-09-23) ─────────────────────────────────────────
//
// A pass can now be started from three places while the app is open: the
// foreground hook below, Settings' *Sync now*, and a blank cell on Home's
// metrics strip (docs/wearables-subapp.md §22). Nothing stopped two of them
// running at once. That is harmless to the data — every write is an upsert on
// a deterministic key — but it doubles the HealthKit reads, and a control
// cannot honestly say "syncing" about a pass it cannot see.
//
// So a pass started through the functions below is TRACKED: visible to
// `isHealthSyncRunning`, announced to `subscribeHealthSyncRunning` when it
// starts and when it settles. `syncHealthData` is unchanged and is still the
// pass. Callers differ in what an already-running pass is worth to them:
//
//   - `requestFreshHealthSync` — an explicit ask (a tap on Home, *Sync now*,
//     a return from another app). It must read Apple Health from NOW on: the
//     user may have just synced Garmin Connect, and a pass that started before
//     that read before it too. So it never joins a running pass; it queues ONE
//     follow-up behind it, and later asks join that follow-up.
//   - `startOrJoinHealthSync` — the boot pass and a return that never left the
//     app (the Face ID sheet, Control Centre). The user was not in another app
//     pushing data, so the pass already running is as good as a new one.
//   - `startHealthSync` — Settings' three setup flows. A pass of their own.

const runningPasses: Promise<HealthSyncResult>[] = [];
/** The one follow-up queued behind the running pass, not yet started. */
let queuedPass: Promise<HealthSyncResult> | null = null;
const runningListeners = new Set<Listener>();

function emitRunning(): void {
  for (const listener of runningListeners) {
    // One subscriber that throws must not jam the gate for the others, nor
    // escape into `startHealthSync` and strand a pass in the running list.
    try {
      listener();
    } catch {
      // The subscriber re-reads on the next event.
    }
  }
}

/** Whether a tracked pass is in flight, or queued to start when one settles. */
export function isHealthSyncRunning(): boolean {
  return runningPasses.length > 0 || queuedPass !== null;
}

/** Called when a tracked pass starts and again when it settles; returns the unsubscribe. */
export function subscribeHealthSyncRunning(listener: Listener): () => void {
  runningListeners.add(listener);
  return () => {
    runningListeners.delete(listener);
  };
}

/**
 * Start a tracked pass now, beside any other. For Settings' three setup flows,
 * whose pass must read AFTER the permission sheet they just showed — and the
 * 90-day heart-rate flow carries a window no ordinary pass would.
 */
export function startHealthSync(
  db: Database,
  now: Date = new Date(),
  options: SyncOptions = {}
): Promise<HealthSyncResult> {
  const pass = syncHealthData(db, now, options);
  runningPasses.push(pass);
  // Attached BEFORE the pass is announced, so nothing a subscriber does can
  // leave it listed; and before any caller can await `pass`, so the list is
  // already clear by the time a caller's own continuation runs.
  const settle = (): void => {
    const index = runningPasses.indexOf(pass);
    if (index !== -1) runningPasses.splice(index, 1);
    emitRunning();
  };
  pass.then(settle, settle);
  emitRunning();
  return pass;
}

/**
 * A pass that reads Apple Health from `now` on. Starts one if nothing is
 * running; otherwise queues one follow-up behind the newest running pass, or
 * joins the follow-up already queued (it has not started, so it will read from
 * later still). Never more than one pass waits.
 */
export function requestFreshHealthSync(
  db: Database,
  now: Date = new Date()
): Promise<HealthSyncResult> {
  if (queuedPass) return queuedPass;
  const newest = runningPasses[runningPasses.length - 1];
  if (!newest) return startHealthSync(db, now);
  const ignore = (): void => undefined;
  const queued = newest.then(ignore, ignore).then(() => {
    queuedPass = null;
    // Its own clock, read when it actually starts.
    return startHealthSync(db, new Date());
  });
  queuedPass = queued;
  return queued;
}

/** Join the newest tracked pass (a queued follow-up counts) if there is one; otherwise start one. */
export function startOrJoinHealthSync(
  db: Database,
  now: Date = new Date()
): Promise<HealthSyncResult> {
  return queuedPass ?? runningPasses[runningPasses.length - 1] ?? startHealthSync(db, now);
}

/**
 * The boot/foreground hook (app/_layout.tsx): throttled, best-effort, silent.
 * A failed or skipped background sync must never surface — Settings › Apple
 * Health shows the honest last-synced state, and the next foreground retries.
 *
 * `fresh` is set for a return from the BACKGROUND — the user was in another
 * app, possibly Garmin Connect pushing last night — so a pass still running
 * from before the trip is not good enough. Otherwise a running pass is joined.
 */
export async function syncHealthIfEnabled(
  db: Database,
  now: Date = new Date(),
  options: { fresh?: boolean } = {}
): Promise<void> {
  try {
    if (!isHealthSyncEnabled(db) || !isHealthKitAvailable()) return;
    if (!shouldAutoSync(getHealthSyncState(db).lastSyncedAt, now)) return;
    await (options.fresh ? requestFreshHealthSync(db, now) : startOrJoinHealthSync(db, now));
  } catch {
    // Best-effort by design.
  }
}

/**
 * What an AppState change asks of the foreground hook: `fresh` when the app is
 * active again after a trip to the background, `join` when it is active again
 * without having left (iOS passes through `inactive` for the Face ID sheet,
 * Control Centre and a notification pulled down), and nothing otherwise. Pure,
 * one tracker per subscription, so the headless suite can walk it.
 */
export function foregroundTracker(): (state: string) => 'fresh' | 'join' | null {
  let wentBackground = false;
  return (state) => {
    if (state === 'background') {
      wentBackground = true;
      return null;
    }
    if (state !== 'active') return null;
    const fresh = wentBackground;
    wentBackground = false;
    return fresh ? 'fresh' : 'join';
  };
}

/**
 * Re-sync when the app returns to the foreground (throttled above). AppState
 * is loaded through a guarded require so this module — whose pure window maths
 * the headless tests import — never pulls react-native into node.
 */
export function registerForegroundHealthSync(db: Database): () => void {
  type AppStateModule = {
    AppState: {
      addEventListener(type: 'change', handler: (state: string) => void): { remove(): void };
    };
  };
  let subscription: { remove(): void } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppState } = require('react-native') as AppStateModule;
    const next = foregroundTracker();
    subscription = AppState.addEventListener('change', (state) => {
      const trigger = next(state);
      if (trigger) void syncHealthIfEnabled(db, new Date(), { fresh: trigger === 'fresh' });
    });
  } catch {
    subscription = null;
  }
  return () => subscription?.remove();
}
