/**
 * The per-run Apple Health sync log (docs/wearables-subapp.md §14) — PURE
 * shapes and the pure normaliser, so the whole thing is pinned headlessly.
 *
 * **Why this exists.** On 2026-08-25 weight stopped arriving from Apple Health
 * and the app had nothing to say about it. Every failure in the pipeline is
 * deliberately silent — a refused query predicate returns `[]`, a sample that
 * cannot be attributed is dropped, one bad day never sinks a window — and every
 * one of those decisions is right on its own. Together they made an empty read
 * indistinguishable from a quiet week, so the only signal left was the owner
 * noticing a number had stopped moving and reporting "not working", which is the
 * least useful bug report a system can force a person to write.
 *
 * So every step now counts what it did, and Settings › Apple Health renders it:
 * samples HealthKit returned, which exclusion predicate survived, what each
 * guard rejected and why, rows landed, and any native error text. The screen
 * should always be able to name the step that produced zero.
 *
 * **Bounded to the last run.** This is diagnostics, not history: one record
 * under one KV key, overwritten every pass. Error strings are clamped at the
 * seam (200 chars) and the metric list is fixed-length by construction — the
 * fifteen read scopes — so the row cannot grow without a code change. A trend
 * of syncs would be a different feature and would need a table.
 */
import type { HealthExclusion } from './types';
import type { BodyIngestRejections } from './mapping';

/** What one metric did on the last pass, inbound. */
export type HealthMetricLog = {
  /** ARC's own metric name — `hrv`, `steps`, `weight_kg`. */
  metric: string;
  /** Human label for the screen. */
  label: string;
  /** Samples (or day-statistics) HealthKit handed back. */
  returned: number;
  /** Rows this metric produced for the database. */
  rows: number;
  /** Which own-write exclusion the query ran with. */
  exclusion: HealthExclusion;
  /** Native error text, when a query was refused. */
  error: string | null;
  /**
   * Per-guard rejections. Only the three body metrics can be non-zero — the
   * per-sample guard is scoped to the types ARC also writes (docs §10, guard 3).
   */
  rejected: BodyIngestRejections | null;
};

/** What the outbound half did on the last pass. */
export type HealthPublishLog = {
  /**
   * The pass only ARMED the cursor and deliberately wrote nothing. This is the
   * no-backfill rule (docs §10, rule 1) and it is the single most
   * failure-looking success in the app: a user who logs a weight, syncs, and
   * finds nothing in Health has hit the design, not a bug — but only if the
   * screen says so.
   */
  armed: boolean;
  /** A save was refused and the walk stopped, leaving the cursor put. */
  stalled: boolean;
  attempted: number;
  succeeded: number;
  /** Per published type, so a partial share grant is visible as such. */
  types: { label: string; attempted: number; succeeded: number }[];
};

/** One complete sync pass, inbound and outbound. */
export type HealthSyncLog = {
  /** ISO instant the pass ran. */
  at: string;
  /** Days of history this pass re-aggregated. */
  windowDays: number;
  /** Rows that actually CHANGED in the database this pass. */
  rowsWritten: number;
  metrics: HealthMetricLog[];
  publish: HealthPublishLog;
};

export function emptyPublishLog(): HealthPublishLog {
  return { armed: false, stalled: false, attempted: 0, succeeded: 0, types: [] };
}

const EXCLUSIONS: readonly HealthExclusion[] = ['source', 'metadata', 'none', 'refused'];

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function rejectionsOf(value: unknown): BodyIngestRejections | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  return {
    arcTag: num(r.arcTag),
    arcBundle: num(r.arcBundle),
    unattributed: num(r.unattributed),
    outOfBounds: num(r.outOfBounds),
    nonFinite: num(r.nonFinite),
  };
}

/**
 * Parse whatever is under the KV key into a usable log, or null.
 *
 * Defensive in the same way {@link getHealthSyncState} is: a log written by an
 * older build, or half-written, must read as "no log" and be replaced by the
 * next pass — never throw on a Settings screen whose whole job is to explain a
 * failure. Every field is re-derived, so an extra key from a future build is
 * dropped rather than rendered.
 */
export function parseSyncLog(value: unknown): HealthSyncLog | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const at = str(raw.at);
  if (!at) return null;
  const metrics = Array.isArray(raw.metrics) ? raw.metrics : [];
  const publish =
    typeof raw.publish === 'object' && raw.publish !== null
      ? (raw.publish as Record<string, unknown>)
      : {};
  const types = Array.isArray(publish.types) ? publish.types : [];
  return {
    at,
    windowDays: num(raw.windowDays),
    rowsWritten: num(raw.rowsWritten),
    metrics: metrics.flatMap((entry): HealthMetricLog[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const m = entry as Record<string, unknown>;
      const metric = str(m.metric);
      if (!metric) return [];
      const exclusion = EXCLUSIONS.find((e) => e === m.exclusion) ?? 'none';
      return [
        {
          metric,
          label: str(m.label) ?? metric,
          returned: num(m.returned),
          rows: num(m.rows),
          exclusion,
          error: str(m.error),
          rejected: rejectionsOf(m.rejected),
        },
      ];
    }),
    publish: {
      armed: publish.armed === true,
      stalled: publish.stalled === true,
      attempted: num(publish.attempted),
      succeeded: num(publish.succeeded),
      types: types.flatMap((entry): HealthPublishLog['types'] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const t = entry as Record<string, unknown>;
        const label = str(t.label);
        if (!label) return [];
        return [{ label, attempted: num(t.attempted), succeeded: num(t.succeeded) }];
      }),
    },
  };
}

/** Total rejections across every guard, for one metric. */
export function rejectedTotal(rejected: BodyIngestRejections | null): number {
  if (!rejected) return 0;
  return (
    rejected.arcTag +
    rejected.arcBundle +
    rejected.unattributed +
    rejected.outOfBounds +
    rejected.nonFinite
  );
}

/**
 * The one sentence explaining a metric's result, or null when the plain counts
 * already say everything.
 *
 * Written as findings, not as reassurance: a line appears only when it names
 * something the counts alone do not. "Nothing recorded in this window" is a real
 * finding; "3 samples, 3 rows" is not, and gets no sentence.
 */
export function metricNote(entry: HealthMetricLog): string | null {
  if (entry.error !== null && entry.returned === 0) {
    return entry.exclusion === 'refused'
      ? `Apple Health refused both echo-suppression filters, so nothing was read. ${entry.error}`
      : `Apple Health returned an error. ${entry.error}`;
  }
  const rejected = rejectedTotal(entry.rejected);
  if (rejected > 0 && entry.rejected) {
    const { arcTag, arcBundle, unattributed, outOfBounds, nonFinite } = entry.rejected;
    const parts: string[] = [];
    if (arcTag > 0) parts.push(`${arcTag} written by ARC`);
    if (arcBundle > 0) parts.push(`${arcBundle} from ARC's own app`);
    if (unattributed > 0) parts.push(`${unattributed} with no readable source`);
    if (outOfBounds > 0) parts.push(`${outOfBounds} outside the allowed range`);
    if (nonFinite > 0) parts.push(`${nonFinite} unreadable`);
    return `Skipped ${parts.join(', ')}.`;
  }
  if (entry.returned === 0 && entry.exclusion !== 'refused') {
    return 'Nothing recorded in this window.';
  }
  return null;
}

/**
 * What the outbound half should say, in words. Never null — publishing always
 * has a state worth stating, and "0 published" on its own is the sentence that
 * sent the owner looking for a bug in a working feature.
 */
export function publishNote(publish: HealthPublishLog): string {
  if (publish.armed) {
    return 'Armed — your next weight, body fat or waist entry will publish. Measurements recorded before you connected stay in ARC.';
  }
  if (publish.stalled) {
    return 'Apple Health refused a write, so the pass stopped and will retry from the same place. Check Settings → Privacy & Security → Health → ARC.';
  }
  if (publish.attempted === 0) {
    return 'Nothing new to publish.';
  }
  if (publish.succeeded === publish.attempted) {
    return 'Everything queued was accepted.';
  }
  return 'Some writes were not accepted and will be retried.';
}
