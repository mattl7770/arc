/**
 * Ingested workouts → training data (backlog D3, migration 0054).
 *
 * `wearable_data` holds one row per HealthKit workout object; `workouts` holds
 * what the owner logged. Until 0054 nothing joined them, and that absence had
 * three consequences this module answers:
 *
 *   1. **A session recorded twice was counted twice.** The Coach reads ingested
 *      minutes through the `workout` metric AND reads `workouts` through
 *      get_training_summary. {@link unpairedWorkoutDailyMinutes} is the fix:
 *      once a HealthKit row is linked to an ARC session, the ingested read stops
 *      counting it, because the ARC side already does.
 *   2. **An ingested session contributed nothing to recovery.** A 45-minute run
 *      the watch recorded left the freshness ledger untouched.
 *      {@link ingestedMuscleLoads} is the fix, and every load it emits is marked
 *      `origin: 'ingested'` so a guess can never wear the face of a logged set.
 *   3. **A strength session the watch saw was simply lost.** ARC will not guess
 *      which muscles a lift worked, so {@link pendingIngestedStrength} turns it
 *      into a question with a one-tap answer instead of a silence.
 *
 * 0054 paired on span overlap alone, which meant only sessions from the LIVE
 * logger ever paired — everything else has no `started_at`. The owner overruled
 * that from the device on 2026-09-21, so there is now a second rule
 * ({@link pairByDay}) for exactly those sessions, and a refusal
 * ({@link unlinkIngestedWorkout}) so that a pair broken by hand stays broken.
 *
 * Depends only on the {@link Database} interface — never op-sqlite — so the same
 * code runs on device and against node:sqlite in db/wearables.test.mjs.
 */
import type { Database } from '../database';
import { logicalDate, shiftISODate, todayISODate } from '../date';
import { newId } from '../id';
import type { WearableDataRow, WearableDevice } from '../types';
import { attributedInstant, recentMuscleLoads } from './training-stats';
import {
  overlapFraction,
  parseSpan,
  readWorkoutHr,
  SAME_SESSION_OVERLAP,
  sourcePriorityOf,
  workoutSpan,
  type TimeSpan,
} from './wearables';
import { activityLoad, INFERRED_MIN_MINUTES } from '@/lib/exercise/activity-load';
import type { MuscleLoad, PairedIngest } from '@/lib/exercise/types';

/** `wearable_data.metric_type` for a HealthKit workout object. */
const WORKOUT_METRIC = 'workout';

/**
 * How far back a pairing pass looks, in days.
 *
 * Ninety, matching `FIRST_SYNC_DAYS` — the backfill a first sync pulls. The pass
 * only ever examines rows that are still UNLINKED, so on a settled device it
 * scans a handful; the window exists to bound the very first run on a device
 * that already holds three months of HealthKit history and three months of ARC
 * sessions, where every pair it can find is a double-count it removes.
 */
export const PAIR_LOOKBACK_DAYS = 90;

/**
 * How far back the blank inbox asks, in days. Fourteen.
 *
 * Without a horizon, switching this on against the 90-day backfill produces an
 * inbox of forty questions on day one — the single most likely way the feature
 * gets hated and turned off. An older unfilled session ages out silently: the
 * sets are not coming back after a fortnight, and a question nobody will answer
 * is not a question.
 */
export const BLANK_HORIZON_DAYS = 14;

/** One ingested HealthKit session, metadata decoded. */
export type IngestedWorkout = {
  /** `wearable_data.id`. */
  id: string;
  /** The local calendar day the session ENDED (how mapping.ts buckets it). */
  date: string;
  /** True duration in minutes — HealthKit's own, pauses excluded. */
  durationMin: number;
  startTime: string | null;
  endTime: string | null;
  sourceDevice: WearableDevice;
  /** HealthKit's readable label ("Running"); null if the metadata lacked one. */
  activity: string | null;
  /** The raw `HKWorkoutActivityType` int — the stable identity the table keys on. */
  activityTypeRaw: number | null;
  kcal: number | null;
  distanceKm: number | null;
  /**
   * Heart rate as the watch measured it during the session (docs §15) — both
   * fields or neither, nulls when the row carries no `metadata.hr` at all.
   */
  avgHr: number | null;
  maxHr: number | null;
};

/** Decode one `wearable_data` workout row's metadata blob. Total — never throws. */
function decodeIngested(row: WearableDataRow): IngestedWorkout {
  let activity: string | null = null;
  let activityTypeRaw: number | null = null;
  let kcal: number | null = null;
  let distanceKm: number | null = null;
  let hr: { avgHr: number | null; maxHr: number | null } = { avgHr: null, maxHr: null };
  try {
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    if (typeof meta.activity === 'string') activity = meta.activity;
    if (typeof meta.activity_type_raw === 'number' && Number.isFinite(meta.activity_type_raw)) {
      activityTypeRaw = meta.activity_type_raw;
    }
    if (typeof meta.kcal === 'number' && Number.isFinite(meta.kcal)) kcal = meta.kcal;
    if (typeof meta.distance_km === 'number' && Number.isFinite(meta.distance_km)) {
      distanceKm = meta.distance_km;
    }
    hr = readWorkoutHr(meta);
  } catch {
    // Metadata is CHECK-validated JSON; a parse miss just drops the extras.
  }
  return {
    id: row.id,
    date: row.date,
    durationMin: row.value,
    startTime: row.start_time,
    endTime: row.end_time,
    sourceDevice: row.source_device,
    activity,
    activityTypeRaw,
    kcal,
    distanceKm,
    avgHr: hr.avgHr,
    maxHr: hr.maxHr,
  };
}

/** The coarse lower day bound for a window of `days` ending at `now`. */
function sinceDay(now: Date, days: number): string {
  return shiftISODate(todayISODate(now), -days);
}

// --- Pairing -----------------------------------------------------------------

/** A manual session with a readable span — the left-hand side of a span pair. */
type PairableWorkout = { id: string; date: string; span: TimeSpan };

/** An ingested session with a readable span — the right-hand side of a span pair. */
type PairableIngest = {
  row: WearableDataRow;
  span: TimeSpan;
};

/**
 * One link a pass has decided to make, before it is written.
 *
 * `overlap` is the whole provenance record: a number is the fraction of clock
 * the two sessions SHARED, which only the span rule can know, and `null` means
 * the day rule made this link with no clock to justify it. See
 * {@link pairedMethod}, which reads it back.
 */
type PendingLink = { workoutId: string; wearableId: string; overlap: number | null };

/**
 * The DAY rule's duration tolerance: **the shorter of the two durations must be
 * at least half the longer**.
 *
 * It is 0.5 because {@link SAME_SESSION_OVERLAP} is — the app has one number for
 * "close enough to be the same session" and this is that number applied to the
 * only quantity the day rule can compare. A 60-minute log and a 25-minute watch
 * record on one day are two different sessions and stay unpaired; a 60 and a 47
 * are one session measured twice.
 *
 * It applies ONLY when several ingested sessions share the day. With exactly one
 * candidate there is nothing to choose between, and the tolerance is deliberately
 * not consulted: one session logged and one session recorded on one day is the
 * owner's own case, and a duration that disagrees there is the watch measuring
 * the hour differently, not a different hour.
 */
export const DAY_PAIR_MIN_RATIO = 0.5;

// --- Refusals: an unpaired link the next sync must not remake ----------------

/**
 * `health_sync_state` key holding the pairing pass's own state.
 *
 * A SECOND key rather than a field on the `'apple_health'` cursor row, which is
 * named for the sync cursor and would become a lie about its own contents — the
 * exact objection 0045's header raises against parking a live workout there.
 * 0021 shaped this table as "one row per key, value free JSON", and 0060 already
 * used that freedom for a second cursor; a second KEY costs even less.
 *
 * **No migration**, and none is possible on the link table: `linked_by` is
 * `CHECK (linked_by IN ('auto','user'))` so there is no third value to mean
 * "refused", both id columns are NOT NULL so there is no tombstone shape, and a
 * kept row would sit inside the two unique indexes — blocking the workout and the
 * wearable from ever pairing with anything else — while looking like a live link
 * to {@link pairedIngestFor}, the Data tab's list and the `UNPAIRED_WORKOUT`
 * predicate. A refusal is not a link and does not belong in the link table.
 */
const PAIRING_STATE_KEY = 'workout_pairing';

/** One pair the owner has said is NOT one session. */
export type PairRefusal = {
  workoutId: string;
  wearableId: string;
  /**
   * The logged session's own `workouts.date`. It is what BOUNDS the list: a
   * pass never looks further back than {@link PAIR_LOOKBACK_DAYS}, so a refusal
   * older than that can never be consulted again and is pruned.
   */
  date: string;
};

/** The two ids as one comparable key. NUL because no id can contain one. */
const refusalKey = (workoutId: string, wearableId: string): string =>
  `${workoutId}\u0000${wearableId}`;

/**
 * Every pair the owner has unpaired by hand. Corrupt or absent state reads as
 * an empty list — the same posture `getHealthSyncState` takes, and the same
 * cost: at worst the pass re-proposes a pair the owner can unpair again.
 */
export function pairingRefusals(db: Database): PairRefusal[] {
  const row = db.get<{ value: string }>('SELECT value FROM health_sync_state WHERE key = ?', [
    PAIRING_STATE_KEY,
  ]);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as { refusals?: unknown };
    if (!Array.isArray(parsed.refusals)) return [];
    return parsed.refusals.filter((r): r is PairRefusal => {
      const c = r as Partial<PairRefusal>;
      return (
        typeof c?.workoutId === 'string' &&
        typeof c?.wearableId === 'string' &&
        typeof c?.date === 'string'
      );
    });
  } catch {
    return [];
  }
}

function writePairingRefusals(db: Database, refusals: readonly PairRefusal[]): void {
  db.run(
    `INSERT INTO health_sync_state (id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [newId(db), PAIRING_STATE_KEY, JSON.stringify({ refusals })]
  );
}

/**
 * Link every manual session that can be matched to an ingested one, and return
 * how many links this pass created.
 *
 * ## TWO rules, and which one applies is decided by the manual side alone
 *
 * A manual session either has a knowable span or it does not, and the two cases
 * are disjoint — so the two rules can never fight over a `workouts` row:
 *
 *   · **`started_at` present → the SPAN rule.** The two sessions are THE SAME
 *     SESSION when their spans share at least {@link SAME_SESSION_OVERLAP} of the
 *     shorter one — the app's one definition of that, borrowed whole from the
 *     duplicate collapse `recentWearableWorkouts` already performs.
 *   · **`started_at` NULL → the DAY rule** ({@link pairByDay}). No span exists,
 *     so the day is all there is, and the duration arbitrates.
 *
 * The span rule runs FIRST and the day rule works over what it leaves, because
 * they DO compete for `wearable_data` rows and a clock beats a calendar.
 *
 * ## Why the day rule exists (owner, 2026-09-21)
 *
 * 0054 shipped the span rule alone and said so in as many words: *"a session
 * with no `started_at` never auto-pairs"*. Only the live logger writes
 * `started_at`, so a manual log, a backdated session, a photo import and
 * anything the Coach writes all sat unpaired forever, at the top of the Train
 * hub, beside the watch's copy of the same hour. The owner overruled that from
 * the device — *"the apple health found workouts should be attempted to be
 * linked to workouts i've logged that are around the same time automatically"* —
 * and the refusal is what {@link unlinkIngestedWorkout} is for: one tap, and the
 * pass never proposes that pair again.
 *
 * ## The day is an INDEX FILTER for the span rule; the overlap is the rule
 *
 * Candidates are pre-filtered to the session's own day ±1 rather than to the
 * day exactly. `workouts.date` is a LOGICAL day (it can start at 04:00,
 * src/lib/db/date.ts) and `wearable_data.date` is the CALENDAR day the workout
 * ended, so an evening session near midnight — or any session at all under a
 * non-default day boundary — can legitimately carry two different day strings
 * for one hour of training. Widening the pre-filter cannot create a false pair,
 * because the overlap test is what decides and two genuinely different sessions
 * do not share a clock.
 *
 * ## Ties, resolved deterministically and stated
 *
 * Two ingested rows overlapping one manual session (a run recorded by both the
 * watch and the phone) resolve by:
 *
 *   1. {@link SOURCE_PRIORITY} — the same arbitration every other metric gets;
 *   2. then the LONGER span — a truncated copy tells you less about the session;
 *   3. then `created_at`, then `id` — the exact ordering 0042's de-duplicating
 *      DELETE used.
 *
 * Two manual sessions overlapping one ingested row resolve by iteration order:
 * `date`, then `started_at`, then `created_at`, then `id` — earliest first. Both
 * orderings are total, so **re-running the pass is a no-op**: everything already
 * linked is excluded from both sides by the `NOT EXISTS` clauses, everything
 * unpaired by hand is excluded by the refusal list, and nothing else can change
 * its mind.
 */
export function pairIngestedWorkouts(
  db: Database,
  now: Date = new Date(),
  lookbackDays: number = PAIR_LOOKBACK_DAYS
): number {
  const since = sinceDay(now, lookbackDays);
  const refused = prunedRefusalKeys(db, since);

  // Read once, for both rules. The span rule wants only the rows with a readable
  // span; the day rule wants all of them, because a row whose clock is missing
  // still knows what day it was.
  const ingested = db.all<WearableDataRow>(
    `SELECT * FROM wearable_data wd
       WHERE wd.metric_type = ? AND wd.date >= ?
         AND NOT EXISTS (SELECT 1 FROM workout_ingest_links l WHERE l.wearable_id = wd.id)
       ORDER BY wd.date, wd.start_time, wd.created_at, wd.id`,
    [WORKOUT_METRIC, since]
  );
  if (ingested.length === 0) return 0;

  const taken = new Set<string>();
  const links: PendingLink[] = [];

  pairBySpan(db, since, ingested, refused, taken, links);
  pairByDay(db, since, ingested, refused, taken, links);

  if (links.length === 0) return 0;
  db.transaction(() => {
    for (const link of links) {
      db.run(
        `INSERT INTO workout_ingest_links (id, workout_id, wearable_id, linked_by, overlap)
         VALUES (?, ?, ?, 'auto', ?)`,
        [newId(db), link.workoutId, link.wearableId, link.overlap]
      );
    }
  });
  return links.length;
}

/** The 0054 rule, unchanged: a shared clock, and the day only pre-filters. */
function pairBySpan(
  db: Database,
  since: string,
  ingested: readonly WearableDataRow[],
  refused: ReadonlySet<string>,
  taken: Set<string>,
  links: PendingLink[]
): void {
  const manual = db
    .all<{
      id: string;
      date: string;
      started_at: string;
      duration_min: number;
    }>(
      `SELECT w.id, w.date, w.started_at, w.duration_min
       FROM workouts w
       WHERE w.date >= ?
         AND w.started_at IS NOT NULL
         AND w.duration_min IS NOT NULL AND w.duration_min > 0
         AND NOT EXISTS (SELECT 1 FROM workout_ingest_links l WHERE l.workout_id = w.id)
       ORDER BY w.date, w.started_at, w.created_at, w.id`,
      [since]
    )
    .map((w): PairableWorkout | null => {
      const start = new Date(w.started_at).getTime();
      if (!Number.isFinite(start)) return null;
      const span = parseSpan(w.started_at, new Date(start + w.duration_min * 60_000).toISOString());
      return span ? { id: w.id, date: w.date, span } : null;
    })
    .filter((w): w is PairableWorkout => w !== null);

  if (manual.length === 0) return;

  const candidates = ingested
    .map((row): PairableIngest | null => {
      const span = workoutSpan(row);
      return span ? { row, span } : null;
    })
    .filter((i): i is PairableIngest => i !== null);

  for (const w of manual) {
    const before = shiftISODate(w.date, -1);
    const after = shiftISODate(w.date, 1);
    let best: { candidate: PairableIngest; overlap: number } | null = null;
    for (const candidate of candidates) {
      if (taken.has(candidate.row.id)) continue;
      if (refused.has(refusalKey(w.id, candidate.row.id))) continue;
      if (candidate.row.date < before || candidate.row.date > after) continue;
      const shared = overlapFraction(w.span, candidate.span);
      if (shared < SAME_SESSION_OVERLAP) continue;
      if (best === null || beatsIncumbent(measured(candidate), measured(best.candidate))) {
        best = { candidate, overlap: shared };
      }
    }
    if (best === null) continue;
    taken.add(best.candidate.row.id);
    links.push({ workoutId: w.id, wearableId: best.candidate.row.id, overlap: best.overlap });
  }
}

/**
 * The DAY rule (owner, 2026-09-21) — for the manual sessions the span rule
 * cannot see at all, because they have no `started_at`.
 *
 * A logged session on logical day **D** is offered the ingested sessions whose
 * own logical day is also D, and then:
 *
 *   · **the day holds exactly one → pair it.** One session logged and one
 *     session recorded on one day is the owner's own case, and no tolerance is
 *     consulted (see {@link DAY_PAIR_MIN_RATIO});
 *   · **the day holds several, and the log has a `duration_min` → the CLOSEST
 *     duration wins**, and only if it clears {@link DAY_PAIR_MIN_RATIO}.
 *     Otherwise nothing is linked: the point of a tolerance is that failing it
 *     is an answer;
 *   · **the day holds several, and the log has no duration → nothing is
 *     linked.** There is no ground left to choose on, and choosing anyway is a
 *     coin toss with the owner's calories on it.
 *
 * **"Exactly one" counts the DAY, not what is still available**, and that
 * distinction is load-bearing. Two logs and two records on one day: the first
 * log takes the nearer record on duration, and the second must then clear the
 * tolerance against what is left rather than inheriting a free pass because it
 * now faces a single candidate. Otherwise a 25-minute walk rejected for one
 * session would be accepted by the next one down the list, and whether a pair
 * was made would depend on iteration order.
 *
 * ## The day is the app's LOGICAL day on both sides
 *
 * `workouts.date` is already logical — a 01:00 session under a 04:00 boundary is
 * filed under the previous day (src/lib/db/date.ts). `wearable_data.date` is
 * NOT: it is the plain calendar day the session ended, because Apple Health
 * keeps calendar days and the boundary deliberately does not reach the wearable
 * pipeline. So the ingested side is re-read through {@link logicalDate} from its
 * own `end_time`, and the two sides are then answering the same question. The
 * stored `date` is the fallback for a row with no readable clock, and the known
 * cost is stated rather than hidden: the re-read uses the device's CURRENT zone,
 * so a session lived abroad and re-read at home can land a day out. The span
 * rule has no such exposure — it compares instants — which is one more reason
 * it goes first.
 *
 * ## Ties
 *
 * Two candidates equidistant from the logged duration resolve by exactly the
 * arbitration the span rule uses ({@link beatsIncumbent}): source priority, then
 * the longer session, then `created_at`, then `id`. Total, so the pass stays a
 * no-op on re-run.
 */
function pairByDay(
  db: Database,
  since: string,
  ingested: readonly WearableDataRow[],
  refused: ReadonlySet<string>,
  taken: Set<string>,
  links: PendingLink[]
): void {
  const manual = db.all<{ id: string; date: string; duration_min: number | null }>(
    `SELECT w.id, w.date, w.duration_min
       FROM workouts w
       WHERE w.date >= ?
         AND w.started_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM workout_ingest_links l WHERE l.workout_id = w.id)
       ORDER BY w.date, w.created_at, w.id`,
    [since]
  );
  if (manual.length === 0) return;

  const byDay = new Map<string, MeasuredIngest[]>();
  for (const row of ingested) {
    const day = ingestedLogicalDay(row);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(measuredRow(row));
    else byDay.set(day, [measuredRow(row)]);
  }

  for (const w of manual) {
    const onTheDay = byDay.get(w.date) ?? [];
    const candidates = onTheDay.filter(
      (c) => !taken.has(c.row.id) && !refused.has(refusalKey(w.id, c.row.id))
    );
    if (candidates.length === 0) continue;
    const chosen =
      onTheDay.length === 1 ? candidates[0]! : closestByDuration(candidates, w.duration_min);
    if (chosen === null) continue;
    taken.add(chosen.row.id);
    // `overlap` NULL, because no clock justified this one — the whole of how a
    // link's method is read back. See {@link pairedMethod}.
    links.push({ workoutId: w.id, wearableId: chosen.row.id, overlap: null });
  }
}

/** The LOGICAL day an ingested session belongs to — see {@link pairByDay}. */
function ingestedLogicalDay(row: WearableDataRow): string {
  if (row.end_time !== null) {
    const ended = Date.parse(row.end_time);
    if (Number.isFinite(ended)) return logicalDate(new Date(ended));
  }
  return row.date;
}

/**
 * The closest candidate by duration, or null when the log has no duration to
 * compare or the closest one still fails {@link DAY_PAIR_MIN_RATIO}.
 */
function closestByDuration(
  candidates: readonly MeasuredIngest[],
  durationMin: number | null
): MeasuredIngest | null {
  if (durationMin === null || !(durationMin > 0)) return null;
  let best: MeasuredIngest | null = null;
  let bestGap = Infinity;
  for (const candidate of candidates) {
    const gap = Math.abs(candidate.row.value - durationMin);
    if (gap < bestGap || (gap === bestGap && best !== null && beatsIncumbent(candidate, best))) {
      best = candidate;
      bestGap = gap;
    }
  }
  if (best === null) return null;
  const longer = Math.max(best.row.value, durationMin);
  const shorter = Math.min(best.row.value, durationMin);
  return longer > 0 && shorter / longer >= DAY_PAIR_MIN_RATIO ? best : null;
}

/**
 * An ingested row plus how long it lasted in milliseconds — the one quantity
 * {@link beatsIncumbent} needs beyond the row itself. The span rule measures it
 * off the clock; the day rule takes the stored duration, which is HealthKit's
 * own (pauses excluded) and the more honest of the two anyway.
 */
type MeasuredIngest = { row: WearableDataRow; lengthMs: number };

const measured = (c: PairableIngest): MeasuredIngest => ({
  row: c.row,
  lengthMs: c.span.end - c.span.start,
});

const measuredRow = (row: WearableDataRow): MeasuredIngest => ({
  row,
  lengthMs: row.value * 60_000,
});

/** The tie-break, in the order the docblock states it. Shared by both rules. */
function beatsIncumbent(challenger: MeasuredIngest, incumbent: MeasuredIngest): boolean {
  const cp = sourcePriorityOf(challenger.row.source_device);
  const ip = sourcePriorityOf(incumbent.row.source_device);
  if (cp !== ip) return cp < ip;
  if (challenger.lengthMs !== incumbent.lengthMs) return challenger.lengthMs > incumbent.lengthMs;
  if (challenger.row.created_at !== incumbent.row.created_at) {
    return challenger.row.created_at < incumbent.row.created_at;
  }
  return challenger.row.id < incumbent.row.id;
}

/**
 * The refusal list as lookup keys, pruning anything older than the window this
 * pass can even see. Written back only when something was actually dropped, so
 * a settled device's fifteen-minute sync costs no write.
 */
function prunedRefusalKeys(db: Database, since: string): Set<string> {
  const stored = pairingRefusals(db);
  const live = stored.filter((r) => r.date >= since);
  if (live.length !== stored.length) writePairingRefusals(db, live);
  return new Set(live.map((r) => refusalKey(r.workoutId, r.wearableId)));
}

/**
 * Link one manual session to one ingested session BY HAND — the path the blank
 * inbox takes when the owner fills in the sets for a session the watch recorded.
 *
 * It replaces whatever was there: an assertion outranks an inference, which is
 * the same rule a hand-set freshness anchor applies to the sets behind it. The
 * delete-then-insert is one transaction, so the unique indexes never see a
 * moment where both links exist.
 *
 * It also clears any REFUSAL touching either side, for the same reason: the
 * owner asserting a pair outranks the owner having once refused one, and a
 * refusal left standing behind a live link is a fact about the app that is no
 * longer true.
 */
export function linkIngestedWorkout(db: Database, workoutId: string, wearableId: string): void {
  db.transaction(() => {
    db.run('DELETE FROM workout_ingest_links WHERE workout_id = ? OR wearable_id = ?', [
      workoutId,
      wearableId,
    ]);
    const stored = pairingRefusals(db);
    const kept = stored.filter((r) => r.workoutId !== workoutId && r.wearableId !== wearableId);
    // Only when there was one. Filling in a blank is the common path and it
    // should not write a state row on a device that has never unpaired anything.
    if (kept.length !== stored.length) writePairingRefusals(db, kept);
    db.run(
      `INSERT INTO workout_ingest_links (id, workout_id, wearable_id, linked_by, overlap)
       VALUES (?, ?, ?, 'user', NULL)`,
      [newId(db), workoutId, wearableId]
    );
  });
}

/**
 * Break the pair on one logged session — one tap, and it stays broken.
 *
 * The DELETE alone would not: the next sync would find the same session and the
 * same watch record with the same day and the same duration and remake exactly
 * the link the owner just rejected. So the pair is recorded as a REFUSAL
 * ({@link PAIRING_STATE_KEY}), which both rules consult, and it is recorded for
 * that PAIR rather than for either row alone — the owner said these two are not
 * one session, not that this session was never recorded by anything.
 *
 * Nothing of the owner's is destroyed, which is why it needs no confirmation:
 * the sets stay, the watch's row stays, and the only thing that goes is an
 * inference. What DOES change is the ledger — an unpaired ingested session
 * starts inferring load again, which is the correct reading once ARC has been
 * told it is a session of its own.
 */
export function unlinkIngestedWorkout(db: Database, workoutId: string): void {
  const link = db.get<{ wearable_id: string }>(
    'SELECT wearable_id FROM workout_ingest_links WHERE workout_id = ?',
    [workoutId]
  );
  if (!link) return;
  const workout = db.get<{ date: string }>('SELECT date FROM workouts WHERE id = ?', [workoutId]);
  db.transaction(() => {
    db.run('DELETE FROM workout_ingest_links WHERE workout_id = ?', [workoutId]);
    const refusal: PairRefusal = {
      workoutId,
      wearableId: link.wearable_id,
      date: workout?.date ?? todayISODate(),
    };
    const kept = pairingRefusals(db).filter(
      (r) => refusalKey(r.workoutId, r.wearableId) !== refusalKey(workoutId, link.wearable_id)
    );
    writePairingRefusals(db, [...kept, refusal]);
  });
}

// --- Reading the pair --------------------------------------------------------

type LinkJoinRow = WearableDataRow & {
  workout_id: string;
  linked_by: 'auto' | 'user';
  link_overlap: number | null;
};

const LINK_JOIN_SQL = `SELECT wd.*, l.workout_id AS workout_id, l.linked_by AS linked_by,
          l.overlap AS link_overlap
   FROM workout_ingest_links l
   JOIN wearable_data wd ON wd.id = l.wearable_id`;

/**
 * How this link was made, derived rather than stored — **there is no column for
 * it and 0054 needs no sequel to add one**, because the two it already has say
 * it between them:
 *
 * | `linked_by` | `overlap` | method |
 * | --- | --- | --- |
 * | `'user'` | NULL | by hand, from the blank inbox |
 * | `'auto'` | a fraction | by SPAN — the number IS the justification |
 * | `'auto'` | NULL | by DAY — nothing on the clock justified it |
 *
 * It is total because the three writers are: the span rule always records the
 * fraction it matched on, the day rule has none to record, and a hand link needs
 * none. `workouts.started_at` agrees with the answer (a day link only ever
 * attaches to a session with no span) but is NOT consulted — the editor can
 * rewrite a workout, and a derivation should read the row that cannot change
 * under it.
 */
function pairedMethod(row: LinkJoinRow): PairedIngest['pairedBy'] {
  if (row.linked_by === 'user') return 'user';
  return row.link_overlap === null ? 'day' : 'span';
}

function toPairedIngest(row: LinkJoinRow): PairedIngest {
  const decoded = decodeIngested(row);
  return {
    wearableId: decoded.id,
    activity: decoded.activity,
    durationMin: decoded.durationMin,
    kcal: decoded.kcal,
    distanceKm: decoded.distanceKm,
    avgHr: decoded.avgHr,
    maxHr: decoded.maxHr,
    sourceDevice: decoded.sourceDevice,
    pairedBy: pairedMethod(row),
  };
}

/** The watch's record of one logged session, or null when it has no pair. */
export function pairedIngestFor(db: Database, workoutId: string): PairedIngest | null {
  const row = db.get<LinkJoinRow>(`${LINK_JOIN_SQL} WHERE l.workout_id = ?`, [workoutId]);
  return row ? toPairedIngest(row) : null;
}

/**
 * The same read for a PAGE of sessions, keyed by workout id — one statement for
 * the list rather than the N+1 the catalog repo already refuses. An empty input
 * short-circuits rather than building `IN ()`, which SQLite rejects.
 */
export function pairedIngestForMany(
  db: Database,
  workoutIds: readonly string[]
): Map<string, PairedIngest> {
  const byWorkout = new Map<string, PairedIngest>();
  if (workoutIds.length === 0) return byWorkout;
  const rows = db.all<LinkJoinRow>(
    `${LINK_JOIN_SQL} WHERE l.workout_id IN (${workoutIds.map(() => '?').join(',')})`,
    [...workoutIds]
  );
  for (const row of rows) byWorkout.set(row.workout_id, toPairedIngest(row));
  return byWorkout;
}

// --- The de-duplicated ingested reads (the double-count fix) -----------------

/**
 * `wearable_data` workout rows that are NOT paired to an ARC session — the ONE
 * predicate behind every "ingested minutes" read.
 *
 * This is the whole double-count fix, and it is a predicate rather than a rule
 * in each reader for the reason 0045's header gives about draft contamination:
 * a rule every future reader must remember is a rule that will be forgotten
 * once, silently, in a number the owner then acts on.
 */
const UNPAIRED_WORKOUT = `metric_type = '${WORKOUT_METRIC}'
     AND NOT EXISTS (SELECT 1 FROM workout_ingest_links l WHERE l.wearable_id = wearable_data.id)`;

/**
 * Daily ingested workout MINUTES with paired sessions removed — what the Coach
 * reads for the `workout` metric instead of a bare sum.
 *
 * A session the owner logged in ARC and the watch also recorded is one session.
 * `get_training_summary` counts it from `workouts`, where it carries sets, a
 * kind and a duration the owner stands behind; counting its watch copy here as
 * well made the same hour appear in two tools with nothing able to reconcile
 * them. Pairing is what makes the subtraction possible, and this is where it
 * happens.
 *
 * Summed across sources by definition — a workout row is per-object, and the
 * same-session collapse `recentWearableWorkouts` performs is a DISPLAY rule that
 * a total cannot borrow without arbitrating rows it never looked at.
 */
export function unpairedWorkoutDailyMinutes(
  db: Database,
  sinceDate: string,
  untilDate?: string
): { date: string; value: number }[] {
  return db.all<{ date: string; value: number }>(
    `SELECT date, sum(value) AS value FROM wearable_data
     WHERE ${UNPAIRED_WORKOUT} AND date >= ?${untilDate ? ' AND date <= ?' : ''}
     GROUP BY date ORDER BY date`,
    untilDate ? [sinceDate, untilDate] : [sinceDate]
  );
}

/**
 * The unpaired ingested sessions themselves, newest first — the other half of
 * the de-duplication. `get_training_summary` lists them beside the sessions ARC
 * logged so the model can see the training that only the watch knows about,
 * without any of it being double-counted in the totals above.
 */
export function unpairedIngestedSessions(
  db: Database,
  sinceDate: string,
  limit: number
): IngestedWorkout[] {
  return db
    .all<WearableDataRow>(
      `SELECT * FROM wearable_data
       WHERE ${UNPAIRED_WORKOUT} AND date >= ?
       ORDER BY date DESC, start_time DESC LIMIT ?`,
      [sinceDate, limit]
    )
    .map(decodeIngested);
}

// --- The blank: strength-coded sessions ARC will not guess at ----------------

/** One ingested session, by id — what the seeded logger reads on mount. */
export function getIngestedWorkout(db: Database, wearableId: string): IngestedWorkout | null {
  const row = db.get<WearableDataRow>(
    `SELECT * FROM wearable_data WHERE id = ? AND metric_type = ?`,
    [wearableId, WORKOUT_METRIC]
  );
  return row ? decodeIngested(row) : null;
}

/**
 * Unpaired, strength-coded ingested sessions inside the {@link
 * BLANK_HORIZON_DAYS} horizon, newest first — the Train hub's "From your watch"
 * list.
 *
 * These are the sessions where ARC knows something happened and deliberately
 * refuses to say what it worked (the owner's instruction: strength-coded
 * workouts *"leave a blank for the user"*). A REFUSED type — yoga, HIIT,
 * "Other" — never appears here: it contributes zero load and never asks, because
 * a question ARC cannot frame is worse than no question at all.
 */
export function pendingIngestedStrength(
  db: Database,
  now: Date = new Date(),
  days: number = BLANK_HORIZON_DAYS
): IngestedWorkout[] {
  return db
    .all<WearableDataRow>(
      `SELECT * FROM wearable_data
       WHERE ${UNPAIRED_WORKOUT} AND date >= ?
       ORDER BY date DESC, start_time DESC`,
      [sinceDay(now, days)]
    )
    .map(decodeIngested)
    .filter((w) => w.activityTypeRaw != null && activityLoad(w.activityTypeRaw).kind === 'blank');
}

// --- Inference: an ingested session's muscle load ----------------------------

/**
 * What the freshness model is told an ingested set MEASURES.
 *
 * `'time,distance'` is the signature `isEnduranceMeasures` keys on (0046), and
 * it is the correct switch here even for a swim or a climb, which record no
 * distance ARC can see: the question the flag answers is *"is this work dosed by
 * the clock?"*, and for every activity in the table the answer is yes. Without
 * it a three-hour hike would cost exactly what a ten-minute one does.
 */
const INGESTED_MEASURES = 'time,distance' as const;

/**
 * Recent ingested workouts expanded into muscle loads — the ingested half of the
 * freshness ledger's fuel, concatenated with `recentMuscleLoads`.
 *
 * Four rules, and each is load-bearing:
 *
 *   1. **A PAIRED session infers nothing.** The sets are the truth; the owner
 *      typed them. This is the single most important clause in the feature —
 *      without it a session logged in ARC and recorded by the watch would
 *      deplete its muscles twice, which is the fatigue-model version of the
 *      double-count the Coach tools had.
 *   2. **Refused and blank types contribute zero.** A stretch is not fatigue; a
 *      strength session is a question, not a guess.
 *   3. **Short sessions contribute nothing** ({@link INFERRED_MIN_MINUTES}) —
 *      HealthKit emits a workout object every time the Watch decides you walked
 *      to the car.
 *   4. **Every load is marked `origin: 'ingested'`**, which is what lets
 *      `muscleFreshness` report an `inferredShare` and the screens say so.
 *
 * The attributed instant is the session's `end_time` — a genuine instant, unlike
 * a backdated log's — falling back to {@link attributedInstant} when the span is
 * unreadable, reusing the existing helper rather than writing a second one.
 *
 * Nothing is materialised: these loads are a pure function of `wearable_data`
 * plus the activity table, so storing them would mean invalidating them on every
 * re-sync. `now` injected for deterministic tests.
 *
 * Callers want {@link muscleLoadsForFreshness}, not this — the freshness ledger
 * is logged sets PLUS inferred ones, and the two screens that draw it (the hub's
 * body figure and the per-muscle ledger) must never be able to concatenate
 * different halves.
 */
/**
 * **Everything the freshness ledger runs on**: the sets the owner logged, plus
 * the loads inferred from unpaired ingested sessions.
 *
 * One function rather than a concatenation at each call site, for the reason
 * `muscleSetsInRange`'s own docstring gives about its move out of the reports
 * module: two assemblies of "what fatigued this muscle" agree until one of them
 * learns about a new source. Both drawings of the ledger — the hub's body figure
 * and the per-muscle screen — read this.
 *
 * Weekly VOLUME deliberately does NOT: `muscleSetsInRange` counts sets WORKED
 * and is printed to the owner as a set count, and a walk contributes no sets.
 * Freshness is a fatigue model and can take a fractional contribution; volume is
 * a tally of a thing that happened. The firewall is structural — volume reads
 * `workout_sets` and an ingested session has none — not a predicate anyone has
 * to remember.
 */
export function muscleLoadsForFreshness(
  db: Database,
  days: number,
  now: Date = new Date()
): MuscleLoad[] {
  return [...recentMuscleLoads(db, days, now), ...ingestedMuscleLoads(db, days, now)];
}

export function ingestedMuscleLoads(
  db: Database,
  days: number,
  now: Date = new Date()
): MuscleLoad[] {
  const cutoffMs = now.getTime() - days * 86_400_000;
  const rows = db.all<WearableDataRow>(
    `SELECT * FROM wearable_data
     WHERE ${UNPAIRED_WORKOUT} AND date >= ?`,
    [sinceDay(now, days + 1)]
  );
  const loads: MuscleLoad[] = [];
  for (const row of rows) {
    const session = decodeIngested(row);
    if (session.activityTypeRaw == null) continue;
    if (!Number.isFinite(session.durationMin) || session.durationMin < INFERRED_MIN_MINUTES) {
      continue;
    }
    const outcome = activityLoad(session.activityTypeRaw);
    if (outcome.kind !== 'inferred') continue;
    const whenIso = session.endTime ?? attributedInstant(session.date, row.created_at);
    if (Date.parse(whenIso) < cutoffMs) continue;
    for (const { muscle, roleWeight } of outcome.muscles) {
      loads.push({
        muscle,
        roleWeight,
        reps: null,
        rpe: null,
        weightKg: null,
        setType: 'normal',
        whenIso,
        measures: INGESTED_MEASURES,
        durationSec: Math.round(session.durationMin * 60),
        origin: 'ingested',
      });
    }
  }
  return loads;
}
