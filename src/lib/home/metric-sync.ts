/**
 * A blank metric is one tap from an Apple Health sync — the decision, pure
 * (docs/wearables-subapp.md §20).
 *
 * Owner, from the device, 2026-09-23: *"when hrv is blank, put quick apple
 * health sync button there"*. Home's metrics strip prints an em-dash for a
 * reading that has not arrived today, and the one thing that could change that
 * — a pass over Apple Health — was three screens away in Settings. This module
 * decides, per cell, what the blank becomes instead. It reads nothing itself:
 * the impure facts (link, module, running pass, cursor, last log) are gathered
 * by `useMetricSync` and handed in, so every case is pinned headlessly in
 * db/readiness.test.mjs.
 *
 * ## The cases, and why each lands where it does
 *
 *   - **A reading** — nothing changes. The control only ever replaces a blank.
 *   - **Module absent** (web preview, a build predating the module) — the plain
 *     blank, unchanged. A sync cannot run, and Settings › Apple Health in that
 *     build has nothing to switch on ("rides the next build"), so a door there
 *     would be a door to a dead end. The readiness line above already names the
 *     cause.
 *   - **Sync switched off** — the blank becomes a door to Settings › Apple
 *     Health, labelled Connect. That screen's Enable is the one tap that makes
 *     a sync possible, and "No data yet" would be a quiet lie in this state:
 *     nothing is on its way.
 *   - **HealthKit unavailable on this device** — the plain blank. A pass would
 *     return `unavailable` and there is no switch that changes it.
 *   - **Apple Health sent none of this metric on the last pass** — a statement,
 *     not a button: "Apple Health sent none in 14 days". This is the brief's
 *     "instead of offering the same button forever". The source is not writing
 *     this metric to Apple Health at all (a Garmin writes no HRV there —
 *     src/lib/health/coverage.ts), or read access was never granted, which iOS
 *     makes indistinguishable. Either way a tap on Home cannot change it, and the
 *     next foreground pass would pick up a source that starts writing it.
 *   - **A pass is running** (the foreground sync, Settings, or this control) —
 *     "Syncing", and not tappable. The control joins a running pass rather than
 *     starting a second (`startOrJoinHealthSync`).
 *   - **The last pass this control waited on failed** — the offer again, so it
 *     can be retried, with "sync failed at 09:14" beneath it. No alert. A later
 *     successful pass from anywhere supersedes the note.
 *   - **Otherwise** — the offer: "Sync Apple Health", with what the last pass
 *     found beneath it ("none as of 09:14", "not synced today").
 *
 * The statement outranks a running pass on purpose: a verdict about a whole
 * window does not flip to "Syncing" every time the app comes to the foreground.
 */
import { clockFromISO, localDayStart } from '@/lib/db/date';
import type { Database } from '@/lib/db/database';
import type { HealthSyncLog } from '@/lib/health/log';
import { startOrJoinHealthSync, type HealthSyncResult } from '@/lib/health/sync';
import type { Metric } from '@/types/home';

import type { HealthLink } from './readiness';

/** What readiness.ts prints for a missing reading. */
export const NO_READING = '—';

/** Everything the decision needs, gathered by `useMetricSync`. */
export type MetricSyncContext = {
  link: HealthLink;
  /** `isHealthKitAvailable()` — module present AND the OS has health data. */
  available: boolean;
  /** `isHealthSyncRunning()` — a tracked pass is in flight. */
  running: boolean;
  /** The ingest cursor: when the last pass, from anywhere, completed. */
  lastSyncedAt: string | null;
  /** When the last pass started or joined from a blank cell threw. */
  failedAt: string | null;
  /** The last pass's per-metric log (Settings › Apple Health renders the same). */
  log: HealthSyncLog | null;
  /** The day the strip shows — readiness's `today`. */
  today: string;
};

export type MetricSyncCell =
  | { kind: 'reading' }
  | { kind: 'blank' }
  | { kind: 'connect' }
  | { kind: 'syncing' }
  | { kind: 'offer'; note: string }
  | { kind: 'none'; note: string };

/**
 * The sync log's name for a metric, or null when the log cannot speak for it.
 *
 * Home's ids and the log's names coincide except for sleep: the log counts
 * every sleep sample under one `sleep` line. The ledger's stage rows (deep,
 * REM) get no answer from it — a source can send sleep and no stages, and one
 * count cannot tell those apart.
 */
export function appleHealthLogKey(metric: string): string | null {
  if (metric === 'sleep' || metric === 'sleep_duration_min') return 'sleep';
  if (metric.startsWith('sleep_')) return null;
  return metric;
}

/**
 * "Apple Health sent none in 14 days", or null when the last pass does not
 * establish that.
 *
 * Only a clean, empty read counts. A read that reported a native error may have
 * been refused rather than empty, and a metric the log does not name has no
 * evidence either way — both return null and leave the cell as it was.
 */
export function noneFromAppleHealth(log: HealthSyncLog | null, metric: string): string | null {
  const key = appleHealthLogKey(metric);
  if (log === null || key === null) return null;
  const entry = log.metrics.find((m) => m.metric === key);
  if (!entry || entry.error !== null || entry.returned > 0) return null;
  if (log.windowDays <= 0) return 'Apple Health sent none';
  return `Apple Health sent none in ${log.windowDays} ${log.windowDays === 1 ? 'day' : 'days'}`;
}

/** A failure stands until a pass completes after it. ISO instants sort as text. */
function failureStands(ctx: MetricSyncContext): boolean {
  if (ctx.failedAt === null) return false;
  return ctx.lastSyncedAt === null || ctx.failedAt > ctx.lastSyncedAt;
}

/**
 * What the last pass found, under the offer. "As of" only when that pass ran
 * after today's day began — a pass from yesterday evening never looked at
 * today's bucket, so quoting its time would claim a check that did not happen.
 */
function offerNote(ctx: MetricSyncContext): string {
  if (ctx.lastSyncedAt === null) return 'never synced';
  const at = new Date(ctx.lastSyncedAt);
  if (Number.isNaN(at.getTime())) return 'never synced';
  return at >= localDayStart(ctx.today)
    ? `none as of ${clockFromISO(ctx.lastSyncedAt)}`
    : 'not synced today';
}

/** What one metrics-strip cell renders. */
export function metricSyncCell(
  metric: Pick<Metric, 'id' | 'value'>,
  ctx: MetricSyncContext
): MetricSyncCell {
  if (metric.value !== NO_READING) return { kind: 'reading' };
  if (ctx.link === 'unsupported') return { kind: 'blank' };
  if (ctx.link === 'disconnected') return { kind: 'connect' };
  if (!ctx.available) return { kind: 'blank' };

  const failed = failureStands(ctx);
  const none = failed ? null : noneFromAppleHealth(ctx.log, metric.id);
  if (none !== null) return { kind: 'none', note: none };
  if (ctx.running) return { kind: 'syncing' };
  if (failed && ctx.failedAt !== null) {
    return { kind: 'offer', note: `sync failed at ${clockFromISO(ctx.failedAt)}` };
  }
  return { kind: 'offer', note: offerNote(ctx) };
}

// ── The tap ─────────────────────────────────────────────────────────────────
//
// Session memory only. A failure is worth one quiet line until the next pass
// succeeds; it is not worth a row in the database.

let failedAt: string | null = null;
const failureListeners = new Set<() => void>();

/** When the last pass a blank cell waited on threw, or null. */
export function blankSyncFailedAt(): string | null {
  return failedAt;
}

/** Called when a new failure is recorded; returns the unsubscribe. */
export function subscribeBlankSyncFailure(listener: () => void): () => void {
  failureListeners.add(listener);
  return () => {
    failureListeners.delete(listener);
  };
}

export type BlankSyncDeps = {
  run: (db: Database) => Promise<HealthSyncResult>;
  now: () => Date;
};

const NATIVE: BlankSyncDeps = {
  run: (db) => startOrJoinHealthSync(db),
  now: () => new Date(),
};

/**
 * Run the sync a blank cell offers — the same pass Settings' *Sync now* runs,
 * joined rather than doubled if one is already going. Never throws: a failure
 * is recorded for the cell to state, and nothing else hears about it.
 *
 * `disabled` / `unavailable` are not failures. They mean the switch or the
 * device changed between render and tap, and the cell re-reads those facts and
 * shows the truth (a door, or the plain blank).
 */
export async function syncFromBlank(
  db: Database,
  deps: BlankSyncDeps = NATIVE
): Promise<'synced' | 'skipped' | 'failed'> {
  try {
    const result = await deps.run(db);
    return result.status === 'synced' ? 'synced' : 'skipped';
  } catch {
    failedAt = deps.now().toISOString();
    for (const listener of failureListeners) listener();
    return 'failed';
  }
}
