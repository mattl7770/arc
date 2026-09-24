/**
 * Training analytics reads — the data the rule-based engine and the exercise
 * detail screen run on (docs/exercise-subapp.md §4). Per-exercise history and
 * personal records, the e1RM trend, previous-set prefill, and the recent
 * per-muscle set loads that drive the freshness ledger.
 *
 * These reads compute e1RM/PRs by importing the PURE e1rm module (no DB), so
 * there is one estimator shared by screens, the recommender, and the tests.
 * The repo itself still depends only on the {@link Database} interface, so it
 * runs headless in db/training-engine.test.mjs. Warmup sets are excluded from
 * every stat (the Hevy/Strong rule).
 */
import type { Database } from '../database';
// `localWeekRange` comes from the shared date module, NOT from ./exercise (which
// merely re-exports it for the screens). Importing it from the repository made
// a cycle the moment ./exercise learned to join ingested workouts
// (exercise → workout-ingest → training-stats → exercise, 0054), and a stats
// module reaching into a repository for a date helper was the wrong direction
// regardless.
import { formatLocalDate, localWeekRange, logicalDate } from '../date';
import type { DateString } from '../types';
import { exerciseLoadBases } from './exercise-catalog';
import { e1rmForSet } from '@/lib/exercise/e1rm';
import type { LoadBasis } from '@/lib/exercise/load-basis';
import { asMeasures, type Measures } from '@/lib/exercise/measures';
import {
  directionOf,
  personalRecordsOf,
  type Trend,
  type TrendMetric,
} from '@/lib/exercise/records';
import type {
  E1rmPoint,
  Muscle,
  MuscleLoad,
  MuscleRole,
  PersonalRecords,
  SetType,
} from '@/lib/exercise/types';
import type { SessionTopSet } from '@/lib/exercise/progression';

const ROLE_WEIGHT: Record<MuscleRole, number> = { primary: 1, secondary: 0.5 };

export type SetRow = {
  workout_id: string;
  date: DateString;
  when_iso: string;
  reps: number | null;
  weight_kg: number | null;
  rpe: number | null;
  set_type: SetType;
  /** Seconds (0013) and metres (0046) — null on a movement that measures neither. */
  duration_sec: number | null;
  distance_m: number | null;
  /** The session's away flag (0055) — see `baselineRows` in src/lib/exercise/records.ts. */
  away: 0 | 1;
};

/**
 * Every non-warmup set logged for an exercise, newest workout first. Exported so
 * a screen can fetch the rows ONCE and derive several stats from the same scan
 * (exercise-detail does this), instead of re-querying per stat.
 *
 * The away flag (0055) rides along rather than being filtered out here, and
 * that is deliberate: the three reducers below want three different things from
 * it. The records and the progression input must EXCLUDE away sets; the e1RM
 * chart must KEEP and MARK them. A `WHERE w.away = 0` in this one query would
 * make the chart silently lose the sessions the owner will go looking for.
 */
export function workingSets(db: Database, exerciseId: string): SetRow[] {
  return db.all<SetRow>(
    `SELECT s.workout_id, w.date, w.created_at AS when_iso, w.away,
            s.reps, s.weight_kg, s.rpe, s.set_type, s.duration_sec, s.distance_m
     FROM workout_sets s
     JOIN workouts w ON w.id = s.workout_id
     WHERE s.exercise_id = ? AND s.set_type != 'warmup'
     ORDER BY w.date DESC, w.created_at DESC, s.set_index`,
    [exerciseId]
  );
}

/*
 * "Which sets may set a record" — home sessions only (0055) — is defined ONCE,
 * as `baselineRows` in src/lib/exercise/records.ts, where every record, the
 * live PR stamp and the direction of travel read it. It lived here as
 * `baselineSets` until 2026-09-23; the argument for it moved with it.
 */

/**
 * The "best" of a session's sets, as one comparable pair: a tier, then a value.
 *
 * Tier 1 is the old single number — e1RM, else load, else distance, else
 * duration — and among tier-1 sets nothing changed: a session of loaded sets
 * still picks its best e1RM, and a run still reports its longest piece.
 *
 * Tier 0 is a set that carries none of those, compared by REPS. Until
 * 2026-09-23 such a set scored a flat zero, so every push-up session's "top
 * set" was whichever set the query returned first rather than the most reps.
 * It is a separate tier, never mixed into tier 1, because reps and kilograms
 * are not one scale: a weighted dip of 10 kg × 8 is the top set of a session
 * that also held a bodyweight 15, and comparing 12.7 against 15 would say
 * otherwise.
 *
 * An ASSISTED movement (0062) ranks the other way. Its figure is help, so the
 * e1RM of it crowns the set with the MOST assistance — the easiest one. Its
 * sets are ranked by reps, and among equal reps the one with less help wins:
 * reps first because its direction of travel reads reps (records.ts), so the
 * hub row's top set and its arrow describe the same thing.
 */
function setStrength(s: SetRow, basis: LoadBasis | null): number[] {
  if (basis === 'assisted') {
    const reps = s.reps != null && s.reps > 0 ? s.reps : 0;
    return [reps > 0 ? 1 : 0, reps, -(s.weight_kg ?? 0)];
  }
  const e = e1rmForSet(s.weight_kg, s.reps, s.rpe, s.set_type);
  if (e != null) return [1, e];
  if (s.weight_kg != null && s.weight_kg > 0) return [1, s.weight_kg];
  if (s.distance_m != null && s.distance_m > 0) return [1, s.distance_m];
  if (s.duration_sec != null && s.duration_sec > 0) return [1, s.duration_sec];
  return [0, s.reps ?? 0];
}

/** Lexicographic: the first place two strengths differ decides it. */
function stronger(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Best working set per session for an exercise, oldest → newest, capped at
 * `limit` most-recent sessions — the input to progression + the e1RM trend.
 */
export function exerciseSessionTops(
  db: Database,
  exerciseId: string,
  limit = 12,
  basis: LoadBasis | null = basisOf(db, exerciseId)
): SessionTopSet[] {
  return exerciseSessionTopsFrom(workingSets(db, exerciseId), limit, basis);
}

/** One movement's effective load basis, for the DB forms that were not handed it. */
function basisOf(db: Database, exerciseId: string): LoadBasis | null {
  return exerciseLoadBases(db, [exerciseId]).get(exerciseId) ?? null;
}

/**
 * The pure reducer behind {@link exerciseSessionTops}: takes pre-fetched
 * {@link workingSets} rows (newest workout first) so a screen can derive several
 * stats from one scan. Same result as the DB form.
 *
 * ## Away sessions are MARKED here, not dropped (0055)
 *
 * The spike proposed dropping them at this reducer, because its consumer is
 * `suggestProgression` and a three-session away block trips the stall branch on
 * a lift that never stalled. It has a second consumer the spike did not
 * account for: app/exercise-detail.tsx's **History list**, which renders these
 * same rows. Dropping them here would erase the session from the one screen
 * built to show it — the same lie as hiding it from the chart.
 *
 * So the flag rides on {@link SessionTopSet} and the ENGINE refuses it
 * (`suggestProgression` filters on it, src/lib/exercise/progression.ts). The
 * false-deload path closes at the branch itself, the history stays honest, and
 * a future caller cannot feed the engine away numbers by accident.
 *
 * `basis` (0062) matters only for an assisted movement, whose ranking is
 * inverted — see {@link setStrength}. Every caller that knows the movement
 * passes it.
 */
export function exerciseSessionTopsFrom(
  rows: SetRow[],
  limit = 12,
  basis: LoadBasis | null = null
): SessionTopSet[] {
  const byWorkout = new Map<string, { date: DateString; best: SetRow }>();
  for (const r of rows) {
    const cur = byWorkout.get(r.workout_id);
    if (!cur || stronger(setStrength(r, basis), setStrength(cur.best, basis))) {
      byWorkout.set(r.workout_id, { date: r.date, best: r });
    }
  }
  // rows are newest-first, so map insertion order is newest-first; take the most
  // recent `limit` and flip to oldest-first for the progression walk.
  const sessions = [...byWorkout.values()].slice(0, limit).reverse();
  return sessions.map(({ date, best }) => ({
    workoutId: best.workout_id,
    date,
    weightKg: best.weight_kg,
    reps: best.reps,
    rpe: best.rpe,
    durationSec: best.duration_sec,
    distanceM: best.distance_m,
    away: best.away === 1,
  }));
}

/**
 * Personal records for one exercise (all canonical kg). Empty-safe (nulls).
 * Reads the movement's load basis itself, so an assisted movement's records
 * are its rep counts only, whoever asks.
 */
export function personalRecords(db: Database, exerciseId: string): PersonalRecords {
  return personalRecordsFrom(workingSets(db, exerciseId), basisOf(db, exerciseId));
}

/**
 * The pure reducer behind {@link personalRecords}: takes pre-fetched
 * {@link workingSets} rows so a screen can derive several stats from one scan.
 * Same result as the DB form. Empty-safe (nulls).
 *
 * The reduction itself is `personalRecordsOf` in src/lib/exercise/records.ts
 * (2026-09-23), so the live PR stamp and the history's PR mark read the same
 * bars this grid prints. This name stays because every caller knows it.
 *
 * ## Away sessions are invisible here (0055)
 *
 * Every record is scanned over `baselineRows`, so a session logged away from
 * the usual gym sets none of them — not the heaviest set, not the best e1RM,
 * not the longest hold — even when its numbers are the highest on record. That
 * is the feature, not a rounding of it.
 *
 * ## Three records added 2026-09-23
 *
 * Best session volume, most reps in a set and most reps in a session — see
 * `personalRecordsOf`. The last two are the first records a push-up has had.
 *
 * ## Six records, and each one only exists where the column does (0046)
 *
 * The three load records — heaviest set, best e1RM, best set volume — need a
 * weight, so a plank and a run leave all three null; `e1rmForSet` already
 * refuses a set with no load or no reps, which is what makes "a plank can never
 * set an estimated 1RM" true arithmetically rather than by a special case.
 *
 * The three new ones are the honest analogues, and the honesty is in which
 * questions are NOT answered:
 *
 *   * **Longest** — the plank record. Unambiguous: one set, one clock.
 *   * **Farthest** — the longest single piece. Also unambiguous.
 *   * **Best pace** — seconds per kilometre, and the only one that needed a
 *     rule. Pace is meaningless without a distance to hold it over (a 20 m
 *     sprint would own the record for every distance forever), so only pieces
 *     of at least `PACE_PR_MIN_M` are eligible. It is still a single
 *     number across every distance, which is a real simplification — a 5 km PR
 *     pace and a half-marathon PR pace are different achievements and this
 *     reports only the faster. Per-distance bests are a table, not a record,
 *     and they wait until there is history worth tabling.
 */
export function personalRecordsFrom(
  rows: SetRow[],
  basis: LoadBasis | null = null
): PersonalRecords {
  return personalRecordsOf(rows, basis);
}

/** Best e1RM per session date, oldest → newest, capped at `limit` — the trend. */
export function e1rmSeries(db: Database, exerciseId: string, limit = 12): E1rmPoint[] {
  return e1rmSeriesFrom(workingSets(db, exerciseId), limit);
}

/**
 * The pure reducer behind {@link e1rmSeries}: takes pre-fetched
 * {@link workingSets} rows (date DESC) so a screen can derive several stats from
 * one scan. Same result as the DB form.
 *
 * ## Away points stay, marked (0055)
 *
 * This is the one baseline-adjacent read that KEEPS away sessions, and the
 * reason is that deleting them would be a different lie from awarding them a
 * record: the session happened, and the owner will go looking for the week he
 * trained in a hotel. Marked-but-present is the honest rendering; the chart
 * draws such a point hollow (app/exercise-detail.tsx), never in another colour
 * — this is behaviour, not biology, so no signal ink.
 *
 * The mark belongs to the row that actually WON the date: a day holding both a
 * home session and an away one plots the higher number and says where that
 * number came from.
 */
export function e1rmSeriesFrom(rows: SetRow[], limit = 12): E1rmPoint[] {
  const byDate = new Map<DateString, { e1rm: number; away: boolean }>();
  for (const r of rows) {
    const e = e1rmForSet(r.weight_kg, r.reps, r.rpe, r.set_type);
    if (e == null) continue;
    const cur = byDate.get(r.date);
    if (cur == null || e > cur.e1rm) byDate.set(r.date, { e1rm: e, away: r.away === 1 });
  }
  // byDate keys arrive newest-first (rows are date DESC); take latest `limit`,
  // then sort ascending by date for the chart.
  return [...byDate.entries()]
    .slice(0, limit)
    .map(([date, best]) => ({
      date,
      e1rm: Math.round(best.e1rm * 10) / 10,
      // Omitted on a home point rather than `false`: the flag is a mark on the
      // exceptions, not a column on every row.
      ...(best.away ? { away: true as const } : {}),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------------------------------------------------------------------------
// The Train hub's Exercises list (2026-09-23)
// ---------------------------------------------------------------------------

/** One movement the owner has trained — a row of the Train hub's Exercises list. */
export type TrainedExercise = {
  exerciseId: string;
  name: string;
  measures: Measures;
  /** What its weight figure counts (0062), or null when it records no load. */
  loadBasis: LoadBasis | null;
  /** The day it was last trained. */
  lastDate: DateString;
  /** Distinct sessions it has been trained in, all time. */
  sessions: number;
  /** The best set of the most recent session — marked `away` when it was one. */
  latest: SessionTopSet;
  /** Direction of travel over HOME sessions; null with one session or no honest single value. */
  trend: Trend | null;
  /** Which per-session value {@link trend} was read from. */
  trendMetric: TrendMetric | null;
};

/**
 * The latest top set and the direction of travel for one movement, from its
 * working sets (newest workout first) — the pure half of
 * {@link trainedExercises}, and the only place the hub's arrow is computed.
 *
 * The direction is `directionOf` (src/lib/exercise/records.ts) — a lift's
 * e1RM, else its top weight (sets past the e1RM rep cap), else its most reps (a
 * pull-up logged at bodyweight); none for anything covering distance. It is
 * the SAME function exercise detail opens its Trend with, so the arrow on this
 * row and the chart it opens are always the same series.
 */
export function trainedExerciseFrom(
  rows: SetRow[],
  measures: Measures,
  basis: LoadBasis | null
): Pick<TrainedExercise, 'latest' | 'trend' | 'trendMetric'> | null {
  const tops = exerciseSessionTopsFrom(rows, 1, basis);
  const latest = tops[tops.length - 1];
  if (!latest) return null;
  const direction = directionOf(rows, measures, basis);
  return direction
    ? { latest, trend: direction.trend, trendMetric: direction.metric }
    : { latest, trend: null, trendMetric: null };
}

/** How many of each movement's latest sessions the hub reads — the trend needs four home ones. */
const TRAINED_SESSIONS_READ = 8;

/**
 * Every movement with at least one working set, most recently trained first,
 * each with its latest top set and direction of travel — the Train hub's way
 * into any exercise's history (owner, 2026-09-23: *"trends, prs, etc for
 * exercises"*; until now the only doors were the picker's records button and a
 * block title mid-session).
 *
 * One windowed statement rather than a `workingSets` per movement: it reads the
 * latest {@link TRAINED_SESSIONS_READ} sessions of every movement at once, which
 * keeps a hub focus cheap after years of history. Archived movements are
 * included — history outlives the catalog, and exercise-detail opens them.
 */
export function trainedExercises(db: Database): TrainedExercise[] {
  const rows = db.all<SetRow & { exercise_id: string; name: string; measures: string }>(
    `WITH ranked AS (
       SELECT s.exercise_id, s.workout_id, w.date, w.created_at AS when_iso, w.away,
              s.reps, s.weight_kg, s.rpe, s.set_type, s.duration_sec, s.distance_m, s.set_index,
              dense_rank() OVER (
                PARTITION BY s.exercise_id
                ORDER BY w.date DESC, w.created_at DESC, w.id DESC
              ) AS session_rank
       FROM workout_sets s
       JOIN workouts w ON w.id = s.workout_id
       WHERE s.exercise_id IS NOT NULL AND s.set_type != 'warmup'
     )
     SELECT r.*, e.name, e.measures
     FROM ranked r
     JOIN exercises e ON e.id = r.exercise_id
     WHERE r.session_rank <= ?
     ORDER BY r.date DESC, r.when_iso DESC, r.workout_id DESC, r.set_index`,
    [TRAINED_SESSIONS_READ]
  );
  if (rows.length === 0) return [];
  const counts = new Map(
    db
      .all<{ id: string; n: number }>(
        `SELECT exercise_id AS id, count(DISTINCT workout_id) AS n FROM workout_sets
         WHERE exercise_id IS NOT NULL AND set_type != 'warmup'
         GROUP BY exercise_id`
      )
      .map((r) => [r.id, r.n])
  );
  const grouped = new Map<string, { name: string; measures: Measures; rows: SetRow[] }>();
  for (const r of rows) {
    let g = grouped.get(r.exercise_id);
    if (!g) {
      g = { name: r.name, measures: asMeasures(r.measures), rows: [] };
      grouped.set(r.exercise_id, g);
    }
    g.rows.push(r);
  }
  const bases = exerciseLoadBases(db, [...grouped.keys()]);
  const out: TrainedExercise[] = [];
  // Map insertion order is first appearance in a newest-first scan: most
  // recently trained first.
  for (const [exerciseId, g] of grouped) {
    const basis = bases.get(exerciseId) ?? null;
    const summary = trainedExerciseFrom(g.rows, g.measures, basis);
    if (!summary) continue;
    out.push({
      exerciseId,
      name: g.name,
      measures: g.measures,
      loadBasis: basis,
      lastDate: g.rows[0]!.date,
      sessions: counts.get(exerciseId) ?? 1,
      ...summary,
    });
  }
  return out;
}

/** One prior set for the previous-values prefill in the logger. */
export type PrevSet = {
  reps: number | null;
  weightKg: number | null;
  rpe: number | null;
  /** 0046 — so a run's Prev column shows last week's time and distance. */
  durationSec: number | null;
  distanceM: number | null;
};

/**
 * The sets from the most recent session that included this exercise, in set
 * order — the placeholders the logger pre-fills so a repeat is one confirm per
 * set. Includes warmups (the logger shows them too). Empty when never done.
 *
 * ## The most recent HOME session, falling back to any (0055)
 *
 * A placeholder carrying away numbers is a false regression by the quietest
 * route available: the user confirms the placeholder and it becomes a real
 * logged set, at which point a stiffer machine's load is indistinguishable from
 * a home one forever. So the prefill prefers the most recent non-away session
 * and only falls back to an away one when there is no home session at all — a
 * placeholder from somewhere else beats no placeholder.
 *
 * The ORDER BY does the whole of it: `w.away` ascending puts every home session
 * ahead of every away one, and the existing date/time ordering then picks the
 * most recent within whichever group won. One statement, no second query for
 * the fallback.
 *
 * Deliberately NOT done: prefilling an away session from the last AWAY session.
 * It is genuinely better — a given machine's numbers are stable across visits —
 * but it is only meaningful once ARC knows *which* away gym, which is the
 * named-gym list, which is not v1 (spike §3.3c).
 */
export function lastSessionSets(db: Database, exerciseId: string): PrevSet[] {
  const latest = db.get<{ workout_id: string }>(
    `SELECT s.workout_id
     FROM workout_sets s JOIN workouts w ON w.id = s.workout_id
     WHERE s.exercise_id = ?
     ORDER BY w.away, w.date DESC, w.created_at DESC
     LIMIT 1`,
    [exerciseId]
  );
  if (!latest) return [];
  const rows = db.all<{
    reps: number | null;
    weight_kg: number | null;
    rpe: number | null;
    duration_sec: number | null;
    distance_m: number | null;
  }>(
    // No warmup filter: the prefill reproduces the whole session (warmups
    // included) so a repeat is one confirm per set, as the docstring promises —
    // unlike the stat reads above, which follow the Hevy/Strong exclude-warmups
    // rule. The latest-workout subquery already makes no warmup distinction.
    `SELECT reps, weight_kg, rpe, duration_sec, distance_m FROM workout_sets
     WHERE workout_id = ? AND exercise_id = ?
     ORDER BY set_index`,
    [latest.workout_id, exerciseId]
  );
  return rows.map((r) => ({
    reps: r.reps,
    weightKg: r.weight_kg,
    rpe: r.rpe,
    durationSec: r.duration_sec,
    distanceM: r.distance_m,
  }));
}

/**
 * Every non-warmup set in the last `days`, expanded to (muscle, role-weight)
 * loads — the fuel for the freshness ledger. One input row becomes one output
 * row per muscle it works. `now` injected for deterministic tests.
 *
 * ## When did a set actually happen? (backdating, 2026-08-11)
 *
 * A live session's sets happened when its row was WRITTEN, so `created_at` is
 * the honest instant. A BACKDATED session — "log a past session", or a workout
 * imported from a photo of another app — is written today about an earlier
 * `date`, and attributing its fatigue to `created_at` would tell the freshness
 * model the muscle was just trained when it actually recovered days ago. So:
 * when the workout's calendar `date` is a different local day than its
 * `created_at`, the set is attributed to that date at local noon — the honest
 * middle of a day whose clock time nobody recorded. The SQL window filters on
 * BOTH columns so a backdated-but-in-window session isn't excluded by its
 * write time, and the JS re-cut drops anything whose attributed instant falls
 * outside the window.
 */
export function recentMuscleLoads(
  db: Database,
  days: number,
  now: Date = new Date()
): MuscleLoad[] {
  const cutoffMs = now.getTime() - days * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString();
  // Local calendar day of the cutoff, for the date-column side of the window.
  // A COARSE lower bound on the date column (the JS re-cut below is the
  // precise filter), so this is the calendar day of a rolling-hours cutoff —
  // `formatLocalDate`, not a "today".
  const cutoffDate = formatLocalDate(new Date(cutoffMs));
  const rows = db.all<{
    reps: number | null;
    weight_kg: number | null;
    rpe: number | null;
    set_type: SetType;
    duration_sec: number | null;
    measures: string;
    when_iso: string;
    date: string;
    muscle: Muscle;
    role: MuscleRole;
  }>(
    // `exercises` joins in for `measures` alone (0046): the freshness model
    // doses ENDURANCE work by duration rather than by the set, and nothing else
    // in the row says whether this set is endurance. The join is free — the
    // existing `exercise_muscles` join already implies the exercise row exists
    // (its own FK cascades with it).
    `SELECT s.reps, s.weight_kg, s.rpe, s.set_type, s.duration_sec, e.measures,
            w.created_at AS when_iso, w.date, m.muscle, m.role
     FROM workout_sets s
     JOIN workouts w ON w.id = s.workout_id
     JOIN exercise_muscles m ON m.exercise_id = s.exercise_id
     JOIN exercises e ON e.id = s.exercise_id
     WHERE s.exercise_id IS NOT NULL AND s.set_type != 'warmup'
       AND (w.created_at >= ? OR w.date >= ?)`,
    [cutoff, cutoffDate]
  );
  return rows
    .map((r) => ({
      muscle: r.muscle,
      roleWeight: ROLE_WEIGHT[r.role],
      reps: r.reps,
      rpe: r.rpe,
      weightKg: r.weight_kg,
      setType: r.set_type,
      whenIso: attributedInstant(r.date, r.when_iso),
      measures: asMeasures(r.measures) as Measures,
      durationSec: r.duration_sec,
    }))
    .filter((load) => Date.parse(load.whenIso) >= cutoffMs);
}

/**
 * The instant a workout's fatigue is attributed to: `created_at` when the row
 * was written on its own calendar day (a live or same-day log), else the
 * workout's `date` at local noon (a backdated log or photo import). Exported
 * for the headless tests.
 */
export function attributedInstant(date: string, createdAtIso: string): string {
  const created = new Date(createdAtIso);
  if (Number.isNaN(created.getTime())) return `${date}T12:00:00.000Z`;
  // Compared against `date`, which is a LOGICAL day, so this must be one too.
  const createdLocalDate = logicalDate(created);
  if (createdLocalDate === date) return createdAtIso;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12, 0, 0, 0).toISOString();
}

/**
 * What "a working set" IS, held once: non-warmup, resolved to a catalog
 * movement, expanded to one row per muscle it works, inside an inclusive
 * `[start, end]` range on the workout's own calendar **date** (not its write
 * time — a backdated session belongs to the day it happened).
 *
 * Two readers share it for the reason {@link muscleSetsInRange} already gives
 * about its own move out of the reports module: two definitions of "sets
 * worked" agree right up until one of them learns about a new set type. Both
 * take the same two bound parameters in the same order.
 */
const WORKING_SETS_IN_RANGE = `FROM workout_sets s
     JOIN workouts w ON w.id = s.workout_id
     JOIN exercise_muscles m ON m.exercise_id = s.exercise_id
     WHERE s.exercise_id IS NOT NULL AND s.set_type != 'warmup'
       AND w.date >= ? AND w.date <= ?`;

/** The primary-1.0 / secondary-0.5 weighting, in SQL — mirrors {@link ROLE_WEIGHT}. */
const ROLE_WEIGHTED_SETS = `sum(CASE WHEN m.role = 'primary' THEN 1.0 ELSE 0.5 END)`;

/**
 * Fractional set count per muscle (primary 1.0, secondary 0.5) over an
 * arbitrary inclusive `[start, end]` day range. Empty-safe.
 *
 * The range form exists because {@link weeklyMuscleSets} could only ever answer
 * for the Monday-week containing a given instant, and the self-review needs the
 * same number over a calendar month, a custom range, and the equal-length
 * window BEFORE any of those (src/lib/reports/assemble-self-review.ts). The
 * alternative — a second copy of this SQL in the reports module — is exactly
 * the "compose, never re-derive" rule's failure mode: two definitions of
 * "sets worked" that agree until one of them learns about a new set type.
 *
 * So the query moved here and `weeklyMuscleSets` became its one-line caller.
 * Behaviour for existing callers is unchanged, which db/training-volume.test.mjs
 * still proves.
 *
 * ## A set is a set here, even a 45-minute one (0046)
 *
 * Freshness weights an endurance set by its DURATION; this does not, and the
 * asymmetry is deliberate. The two numbers answer different questions against
 * different yardsticks. Freshness models systemic fatigue, where an hour of
 * running plainly costs more than a minute of it. Weekly volume is measured
 * against MEV/MAV/MRV — landmarks derived entirely from RESISTANCE-training
 * sets (Renaissance Periodization, see VOLUME_LANDMARKS) — so scaling a run to
 * 4.5 "sets" of quads would compare it to a scale it was never on and report
 * that an easy hour had taken the owner past his weekly maximum recoverable
 * volume. One row, one set, is the honest reading here.
 */
export function muscleSetsInRange(
  db: Database,
  start: DateString,
  end: DateString
): { muscle: Muscle; sets: number }[] {
  const rows = db.all<{ muscle: Muscle; sets: number }>(
    `SELECT m.muscle AS muscle, ${ROLE_WEIGHTED_SETS} AS sets
     ${WORKING_SETS_IN_RANGE}
     GROUP BY m.muscle`,
    [start, end]
  );
  return rows.map((r) => ({ muscle: r.muscle, sets: Math.round(r.sets * 10) / 10 }));
}

/**
 * Role-weighted working sets **per day**, over the same substrate as
 * {@link muscleSetsInRange} — the training-volume input to Home's strain pillar
 * (`src/lib/home/readiness.ts`).
 *
 * One unit is one set of one muscle at its role weight, so a compound (one
 * primary + two secondaries) costs 2.0 and a single-joint isolation 1.0–1.5:
 * the number is *tissue loaded*, not sets performed, which is what a systemic
 * strain reading wants and is why it must never be printed to the user as a set
 * count.
 *
 * **A day with no logged training has no row.** That absence is load-bearing:
 * it is what lets the caller average over TRAINING days rather than over
 * calendar days, and it is the only thing separating a rest day from a day
 * before ARC was installed at the point where the caller decides whether it has
 * evidence at all.
 */
export function dailyMuscleSetLoad(
  db: Database,
  start: DateString,
  end: DateString
): { date: DateString; sets: number }[] {
  const rows = db.all<{ date: DateString; sets: number }>(
    `SELECT w.date AS date, ${ROLE_WEIGHTED_SETS} AS sets
     ${WORKING_SETS_IN_RANGE}
     GROUP BY w.date
     ORDER BY w.date`,
    [start, end]
  );
  return rows.map((r) => ({ date: r.date, sets: Math.round(r.sets * 10) / 10 }));
}

/**
 * Fractional weekly set count per muscle for the current Monday-start week —
 * the volume side of the freshness ledger. Empty-safe.
 */
export function weeklyMuscleSets(
  db: Database,
  now: Date = new Date()
): { muscle: Muscle; sets: number }[] {
  const { start, end } = localWeekRange(now);
  return muscleSetsInRange(db, start, end);
}
