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
 * The window/day maths ({@link syncDayWindows}, {@link shouldAutoSync}) is pure
 * and exported for the headless tests; the entry points just glue the guarded
 * reader → pure mapping → wearables repo together.
 */
import type { Database } from '@/lib/db/database';
import type { HealthQuantitySample } from './types';
import {
  getHealthSyncState,
  setHealthSyncState,
  upsertWearableRows,
  type WearableUpsert,
} from '@/lib/db/repositories/wearables';
import { isHealthSyncEnabled } from '@/lib/db/repositories/user';

import { upsertHealthBodyRows } from '@/lib/db/repositories/body';

import {
  BODY_INGEST_METRICS,
  bodyIngestRows,
  quantityDailyRows,
  SAMPLE_METRICS,
  sleepDailyRows,
  STATISTIC_METRICS,
  statisticDailyRows,
  workoutRows,
} from './mapping';
import {
  isHealthKitAvailable,
  readDailyCumulative,
  readQuantitySamples,
  readSleepSamples,
  readWorkouts,
} from './healthkit';
import { publishBodyMetrics } from './publish';

/** Steady-state re-aggregation window (self-healing horizon). */
export const SYNC_WINDOW_DAYS = 14;
/** First-enable backfill (per-day rows are tiny; query time is the only cost). */
export const FIRST_SYNC_DAYS = 90;
/** Ceiling on a gap-catch-up window, so a year-long absence stays one pass. */
export const MAX_SYNC_DAYS = 365;
/** Foreground auto-syncs are throttled to at most one per this many minutes. */
export const AUTO_SYNC_THROTTLE_MIN = 15;

export type SyncDay = { date: string; start: Date; end: Date };

/** Local YYYY-MM-DD of a Date (mirrors src/lib/db/date.ts, kept import-free). */
function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * The local-midnight day buckets to (re-)aggregate, oldest first, ending with
 * today. Built with the calendar (never +86400s) so DST days stay correct.
 */
export function syncDayWindows(now: Date, days: number): SyncDay[] {
  const result: SyncDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1, 0, 0, 0, 0);
    result.push({ date: localDate(start), start, end });
  }
  return result;
}

/**
 * The sample/sleep query span for a window: from noon before the window's
 * first day (so the first night's sleep session is fully covered) to `now`.
 */
export function sampleQuerySpan(now: Date, days: number): { start: Date; end: Date } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12, 0, 0, 0);
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
  /** Rows landed INBOUND this pass — `wearable_data` plus `body_metrics`. */
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
export async function syncHealthData(
  db: Database,
  now: Date = new Date()
): Promise<HealthSyncResult> {
  if (!isHealthSyncEnabled(db)) {
    return { status: 'disabled', rowsWritten: 0, samplesPublished: 0, syncedAt: null };
  }
  if (!isHealthKitAvailable()) {
    return { status: 'unavailable', rowsWritten: 0, samplesPublished: 0, syncedAt: null };
  }

  const state = getHealthSyncState(db);
  const windowDays = syncWindowDays(state, now);
  const days = syncDayWindows(now, windowDays);
  const span = sampleQuerySpan(now, windowDays);

  const rows: WearableUpsert[] = [];

  for (const spec of SAMPLE_METRICS) {
    const samples = await readQuantitySamples(spec.hkIdentifier, spec.hkUnit, span.start, span.end);
    rows.push(...quantityDailyRows(spec, samples));
  }
  for (const spec of STATISTIC_METRICS) {
    const stats = await readDailyCumulative(spec.hkIdentifier, spec.hkUnit, days);
    rows.push(...statisticDailyRows(spec, stats));
  }
  rows.push(...sleepDailyRows(await readSleepSamples(span.start, span.end)));
  rows.push(...workoutRows(await readWorkouts(span.start, span.end)));

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
  for (const spec of BODY_INGEST_METRICS) {
    bodyInput.push({
      spec,
      samples: await readQuantitySamples(spec.hkIdentifier, spec.hkUnit, span.start, span.end, {
        failClosed: true,
      }),
    });
  }
  const bodyWritten = upsertHealthBodyRows(db, bodyIngestRows(bodyInput));

  const written = upsertWearableRows(db, clampRowsToWindow(rows, days)) + bodyWritten;

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
  });

  // The outbound half of the same pass (docs §10). It runs AFTER the ingest
  // cursor is stamped so a publish problem can never cost the ingest its
  // progress, and it carries its own cursor and its own failure posture — the
  // two directions share only the enable flag. Degrades to zero on throw for
  // the same reason every reader here does: Settings shows the honest counts,
  // and the next pass retries from an unmoved cursor.
  let samplesPublished = 0;
  try {
    samplesPublished = (await publishBodyMetrics(db, now)).samplesWritten;
  } catch {
    samplesPublished = 0;
  }

  emitSynced();
  return { status: 'synced', rowsWritten: written, samplesPublished, syncedAt };
}

/**
 * The boot/foreground hook (app/_layout.tsx): throttled, best-effort, silent.
 * A failed or skipped background sync must never surface — Settings › Apple
 * Health shows the honest last-synced state, and the next foreground retries.
 */
export async function syncHealthIfEnabled(db: Database, now: Date = new Date()): Promise<void> {
  try {
    if (!isHealthSyncEnabled(db) || !isHealthKitAvailable()) return;
    if (!shouldAutoSync(getHealthSyncState(db).lastSyncedAt, now)) return;
    await syncHealthData(db, now);
  } catch {
    // Best-effort by design.
  }
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
    subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncHealthIfEnabled(db);
    });
  } catch {
    subscription = null;
  }
  return () => subscription?.remove();
}
