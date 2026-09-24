/**
 * A blank metric is one tap from an Apple Health sync — the decision, pure
 * (docs/wearables-subapp.md §22).
 *
 * Owner, from the device, 2026-09-23: *"when hrv is blank, put quick apple
 * health sync button there"*. Home's metrics strip prints an em-dash for a
 * reading that has not arrived today, and the one thing that could change that
 * — a pass over Apple Health — was three screens away in Settings. This module
 * decides, per cell, what the blank becomes instead. It reads nothing itself:
 * the impure facts (link, module, running pass, cursor, last log, recent
 * sources) are gathered by `useMetricSync` and handed in, so every case is
 * pinned headlessly in db/readiness.test.mjs.
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
 *   - **A pass is running** (the foreground sync, Settings, or this control) —
 *     "Syncing", and not tappable. A tap asks for a pass that reads from the
 *     moment of the tap (`requestFreshHealthSync`), so it never doubles one.
 *   - **The last pass this control waited on failed** — the offer again, so it
 *     can be retried, with "sync failed at 09:14" beneath it. No alert. A later
 *     successful pass from anywhere supersedes the note.
 *   - **Apple Health sent none of this metric on the last pass** — the cell
 *     says so, and names the cause when it is known: "Garmin never sends this
 *     to Apple Health" when a Garmin is among the recent sources and the audit
 *     (src/lib/health/coverage.ts) pins the metric as one Garmin never
 *     exports; "Apple Health sent none in 14 days" otherwise. The verb beneath
 *     the label changes from "Sync Apple Health" to "Sync again": the brief
 *     asked for the plain statement "instead of offering the same button
 *     forever", and the owner asked for a sync button on exactly this cell.
 *     Both hold. The statement is the news; the tap is still there because
 *     HRV can be empty for a reason one pass fixes — read access granted in
 *     iOS Settings a minute ago, or a new source that has started writing it.
 *   - **Otherwise** — the offer: "Sync Apple Health", with what the last pass
 *     found beneath it ("none as of 09:14", "not synced today").
 */
import { clockFromISO, localDayStart } from '@/lib/db/date';
import type { Database } from '@/lib/db/database';
import { METRIC_COVERAGE } from '@/lib/health/coverage';
import type { HealthSyncLog } from '@/lib/health/log';
import { SAMPLE_METRICS, STATISTIC_METRICS } from '@/lib/health/mapping';
import { requestFreshHealthSync, type HealthSyncResult } from '@/lib/health/sync';
import type { Metric } from '@/types/home';

import type { HealthLink } from './readiness';

/** What readiness.ts prints for a missing reading. */
export const NO_READING = '—';

/** The cause, when a Garmin is the source and the audit says it never exports the metric. */
export const GARMIN_NEVER_SENDS = 'Garmin never sends this to Apple Health';

/** Everything the decision needs, gathered by `useMetricSync`. */
export type MetricSyncContext = {
  link: HealthLink;
  /** `isHealthKitAvailable()` — module present AND the OS has health data. */
  available: boolean;
  /** `isHealthSyncRunning()` — a tracked pass is in flight or queued. */
  running: boolean;
  /** The ingest cursor: when the last pass, from anywhere, completed. */
  lastSyncedAt: string | null;
  /** When the last pass started or joined from a blank cell threw. */
  failedAt: string | null;
  /** The last pass's per-metric log (Settings › Apple Health renders the same). */
  log: HealthSyncLog | null;
  /** Every source that wrote a wearable row over the sync window (`recentSourceDevices`). */
  sources: readonly string[];
  /** The day the strip shows — readiness's `today`. */
  today: string;
};

export type MetricSyncCell =
  | { kind: 'reading' }
  | { kind: 'blank' }
  | { kind: 'connect' }
  | { kind: 'syncing' }
  | { kind: 'offer'; note: string }
  /** Sent none on the last pass: the statement, and "Sync again". */
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

const SLEEP_IDENTIFIER = 'HKCategoryTypeIdentifierSleepAnalysis';

/** The HealthKit type behind one of the log's metric names, or null. */
function hkIdentifierFor(logKey: string): string | null {
  if (logKey === 'sleep') return SLEEP_IDENTIFIER;
  const spec =
    SAMPLE_METRICS.find((s) => s.metricType === logKey) ??
    STATISTIC_METRICS.find((s) => s.metricType === logKey);
  return spec?.hkIdentifier ?? null;
}

/**
 * Whether the audit pins this metric as one a Garmin never writes to Apple
 * Health (`garmin: 'no'` in coverage.ts — HRV, blood oxygen, respiratory rate,
 * VO₂max). `unverified` is not a no, so it never counts here.
 */
export function garminNeverSends(metric: string): boolean {
  const key = appleHealthLogKey(metric);
  const id = key === null ? null : hkIdentifierFor(key);
  if (id === null) return false;
  return METRIC_COVERAGE.some((row) => row.hkIdentifier === id && row.garmin === 'no');
}

/**
 * What the cell says when the last pass establishes that Apple Health sent none
 * of this metric, or null when it does not.
 *
 * Only a clean, empty read counts. A read that reported a native error may have
 * been refused rather than empty, and a metric the log does not name has no
 * evidence either way — both return null and leave the cell as it was.
 *
 * When a Garmin is among the recent sources and the audit says a Garmin never
 * exports this metric, that is the cause, and it is what the cell says. It is
 * true whatever else is going on (a declined read grant included): a Garmin
 * writing this type is the one thing that cannot be the fix.
 */
export function noneFromAppleHealth(
  log: HealthSyncLog | null,
  metric: string,
  sources: readonly string[] = []
): string | null {
  const key = appleHealthLogKey(metric);
  if (log === null || key === null) return null;
  const entry = log.metrics.find((m) => m.metric === key);
  if (!entry || entry.error !== null || entry.returned > 0) return null;
  if (sources.includes('garmin') && garminNeverSends(metric)) return GARMIN_NEVER_SENDS;
  if (log.windowDays <= 0) return 'Apple Health sent none';
  return `Apple Health sent none in ${log.windowDays} ${log.windowDays === 1 ? 'day' : 'days'}`;
}

/**
 * What an EMPTY row of Data › Wearables says in its descriptor slot instead of
 * "No data yet", or null to keep "No data yet". The same words as Home's cell,
 * and only while sync is on: a log left behind by a pass before the switch
 * went off describes a pipe that is no longer running.
 */
export function ledgerEmptyNote(input: {
  supported: boolean;
  enabled: boolean;
  empty: boolean;
  log: HealthSyncLog | null;
  metric: string;
  sources: readonly string[];
}): string | null {
  if (!input.empty || !input.supported || !input.enabled) return null;
  return noneFromAppleHealth(input.log, input.metric, input.sources);
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
  // Ahead of the sent-none statement too: a tap on that cell has to show it is
  // working, and a pass that is running may be the one that brings the metric.
  if (ctx.running) return { kind: 'syncing' };
  if (failureStands(ctx) && ctx.failedAt !== null) {
    // Also ahead of sent-none: the failed pass never got to re-check it.
    return { kind: 'offer', note: `sync failed at ${clockFromISO(ctx.failedAt)}` };
  }
  const none = noneFromAppleHealth(ctx.log, metric.id, ctx.sources);
  if (none !== null) return { kind: 'none', note: none };
  return { kind: 'offer', note: offerNote(ctx) };
}

/**
 * Where a tap on the cell goes: the Connect door opens Settings › Apple Health,
 * the offer and "Sync again" run a pass, and everything else — a reading, the
 * plain blank, a cell already syncing — takes no tap at all.
 */
export function metricCellPress(cell: MetricSyncCell): 'settings' | 'sync' | null {
  switch (cell.kind) {
    case 'connect':
      return 'settings';
    case 'offer':
    case 'none':
      return 'sync';
    default:
      return null;
  }
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
  run: (db) => requestFreshHealthSync(db),
  now: () => new Date(),
};

/**
 * Run the sync a blank cell offers — the same pass Settings' *Sync now* runs,
 * reading from the moment of the tap (queued behind a running pass rather than
 * doubled beside it). Never throws: a failure is recorded for the cell to
 * state, and nothing else hears about it.
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
    for (const listener of failureListeners) {
      try {
        listener();
      } catch {
        // A subscriber that throws re-reads on the next event; the tap still never throws.
      }
    }
    return 'failed';
  }
}
