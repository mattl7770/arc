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
 * Depends only on the {@link Database} interface — never op-sqlite — so the same
 * code runs on device and against node:sqlite in db/wearables.test.mjs.
 */
import type { Database } from '../database';
import { shiftISODate, todayISODate } from '../date';
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

/** A manual session with a readable span — the left-hand side of a pair. */
type PairableWorkout = { id: string; date: string; span: TimeSpan };

/** An ingested session with a readable span — the right-hand side of a pair. */
type PairableIngest = {
  row: WearableDataRow;
  span: TimeSpan;
};

/**
 * Link every manual session that can be matched to an ingested one, and return
 * how many links this pass created.
 *
 * ## The rule, in one sentence
 *
 * A manual session and an ingested session are THE SAME SESSION when their spans
 * share at least {@link SAME_SESSION_OVERLAP} of the shorter one — the app's one
 * definition of that, borrowed whole from the duplicate collapse
 * `recentWearableWorkouts` already performs. There is no second threshold and no
 * second predicate; two definitions of "the same session" agree right up until
 * one of them is tuned.
 *
 * ## Why the manual side needs `started_at`
 *
 * A `workouts` row has `date`, `created_at` and `duration_min`. For a live
 * session those imply a span; for a BACKDATED one `created_at` is a different
 * day entirely and the implied span is meaningless. So 0054 added
 * `workouts.started_at`, the live logger writes it, and **a session with no
 * `started_at` never auto-pairs** — it can only be paired by hand, from the
 * blank inbox. That is the honest reading: a wrong auto-pair pulls a run's 600
 * kcal into a lifting session, and no screen would show that as wrong.
 *
 * ## The day is an INDEX FILTER; the overlap is the rule
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
 * linked is excluded from both sides by the `NOT EXISTS` clauses, and nothing
 * else can change its mind.
 */
export function pairIngestedWorkouts(
  db: Database,
  now: Date = new Date(),
  lookbackDays: number = PAIR_LOOKBACK_DAYS
): number {
  const since = sinceDay(now, lookbackDays);

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

  if (manual.length === 0) return 0;

  const ingested = db
    .all<WearableDataRow>(
      `SELECT * FROM wearable_data wd
       WHERE wd.metric_type = ? AND wd.date >= ?
         AND NOT EXISTS (SELECT 1 FROM workout_ingest_links l WHERE l.wearable_id = wd.id)
       ORDER BY wd.date, wd.start_time, wd.created_at, wd.id`,
      [WORKOUT_METRIC, since]
    )
    .map((row): PairableIngest | null => {
      const span = workoutSpan(row);
      return span ? { row, span } : null;
    })
    .filter((i): i is PairableIngest => i !== null);

  if (ingested.length === 0) return 0;

  const taken = new Set<string>();
  const links: { workoutId: string; wearableId: string; overlap: number }[] = [];

  for (const w of manual) {
    const before = shiftISODate(w.date, -1);
    const after = shiftISODate(w.date, 1);
    let best: { candidate: PairableIngest; overlap: number } | null = null;
    for (const candidate of ingested) {
      if (taken.has(candidate.row.id)) continue;
      if (candidate.row.date < before || candidate.row.date > after) continue;
      const shared = overlapFraction(w.span, candidate.span);
      if (shared < SAME_SESSION_OVERLAP) continue;
      if (best === null || beatsIncumbent(candidate, best.candidate)) {
        best = { candidate, overlap: shared };
      }
    }
    if (best === null) continue;
    taken.add(best.candidate.row.id);
    links.push({ workoutId: w.id, wearableId: best.candidate.row.id, overlap: best.overlap });
  }

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

/** The tie-break, in the order the docblock states it. */
function beatsIncumbent(challenger: PairableIngest, incumbent: PairableIngest): boolean {
  const cp = sourcePriorityOf(challenger.row.source_device);
  const ip = sourcePriorityOf(incumbent.row.source_device);
  if (cp !== ip) return cp < ip;
  const cLen = challenger.span.end - challenger.span.start;
  const iLen = incumbent.span.end - incumbent.span.start;
  if (cLen !== iLen) return cLen > iLen;
  if (challenger.row.created_at !== incumbent.row.created_at) {
    return challenger.row.created_at < incumbent.row.created_at;
  }
  return challenger.row.id < incumbent.row.id;
}

/**
 * Link one manual session to one ingested session BY HAND — the path the blank
 * inbox takes when the owner fills in the sets for a session the watch recorded.
 *
 * It replaces whatever was there: an assertion outranks an inference, which is
 * the same rule a hand-set freshness anchor applies to the sets behind it. The
 * delete-then-insert is one transaction, so the unique indexes never see a
 * moment where both links exist.
 */
export function linkIngestedWorkout(db: Database, workoutId: string, wearableId: string): void {
  db.transaction(() => {
    db.run('DELETE FROM workout_ingest_links WHERE workout_id = ? OR wearable_id = ?', [
      workoutId,
      wearableId,
    ]);
    db.run(
      `INSERT INTO workout_ingest_links (id, workout_id, wearable_id, linked_by, overlap)
       VALUES (?, ?, ?, 'user', NULL)`,
      [newId(db), workoutId, wearableId]
    );
  });
}

// --- Reading the pair --------------------------------------------------------

type LinkJoinRow = WearableDataRow & { workout_id: string; linked_by: 'auto' | 'user' };

const LINK_JOIN_SQL = `SELECT wd.*, l.workout_id AS workout_id, l.linked_by AS linked_by
   FROM workout_ingest_links l
   JOIN wearable_data wd ON wd.id = l.wearable_id`;

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
    linkedBy: row.linked_by,
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
