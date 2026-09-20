/**
 * **What offset was the phone under at this instant** — the `timezone_changes`
 * rows read as a step function over time (0060, docs/spikes/timezone-handling-
 * intelligent.md §3e, owner's Q4(a)).
 *
 * ## The defect this exists to close
 *
 * A HealthKit sample is an absolute instant, and ARC re-derives a calendar day
 * from it at map time under the device's CURRENT zone. The sync is a trailing
 * re-aggregation, so **the first sync after landing re-buckets the previous
 * fortnight of samples into the new zone's calendar days**: an HRV reading taken
 * at 20:00 in Los Angeles becomes a reading on the following morning in London,
 * a fortnight of history silently changes, and the prune then deletes what the
 * re-dating orphaned. D4's rule is *annotate the day, never re-attribute the
 * rows*, and its own docblock names this path as the one place ARC breaks it:
 * *"the one place ARC already re-attributes … is the bug, not the model"*.
 *
 * So: a sample is bucketed under the offset that was in force **when it was
 * lived**, not the one in force when it is read.
 *
 * ## The three branches, and why the first one is not the live getters
 *
 * Sending instants BEFORE the first row to the live getters would re-bucket
 * every pre-departure sample under the destination zone — which is the defect,
 * reintroduced for exactly the commonest case. `rows[0].from_offset_min` is in
 * the table and is the zone those samples were lived in, back to the home zone's
 * previous DST change. Before that it is an hour out, and only a 90-day pass
 * reaches there.
 *
 * `null` after the latest row means *"use the live local getters"*, which are
 * DST-correct for the zone the phone is actually in. An empty table is `null`
 * everywhere, so a build that has never observed a change behaves exactly as it
 * did before this file existed — which is also what makes the first pass on the
 * build that ships 0053 a no-op.
 *
 * Pure over rows; no clock, no zone, no database.
 */

/** The columns the step function reads. A subset of `timezone_changes`. */
export type OffsetHistoryRow = {
  /** ISO-8601 UTC. When ARC OBSERVED the change, not when the plane landed. */
  changed_at: string;
  from_offset_min: number;
  to_offset_min: number;
};

/** The shape every consumer takes, so a caller with no history passes nothing. */
export type OffsetLookup = (instant: Date) => number | null;

/** No history: every instant reads the device's live getters. */
export const NO_OFFSET_HISTORY: OffsetLookup = () => null;

/**
 * The offset in minutes EAST in force at `instant`, or `null` for *"ask the
 * runtime"*.
 *
 * `rows` must be ordered by `changed_at, rowid`, which is how every read of that
 * table already orders it.
 *
 * The lag is inherited and adds nothing new: `changed_at` is when ARC looked,
 * not when the plane landed, so samples taken in the gap between a landing and
 * the first foreground bucket under the OLD offset — inside the seam day, which
 * is marked and excluded from the baselines anyway.
 */
export function offsetAt(rows: OffsetHistoryRow[], instant: Date): number | null {
  if (rows.length === 0) return null;

  const at = instant.getTime();
  let latest = -1;
  for (let i = 0; i < rows.length; i++) {
    if (Date.parse(rows[i]!.changed_at) <= at) latest = i;
    else break;
  }

  // Before the first row: the zone the app was in when it started watching.
  if (latest === -1) return rows[0]!.from_offset_min;
  // After the latest row: the live getters, which know about DST and this does not.
  if (latest === rows.length - 1) return null;
  // Between two rows: what the earlier one arrived in.
  return rows[latest]!.to_offset_min;
}
