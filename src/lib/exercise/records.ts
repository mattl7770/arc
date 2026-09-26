/**
 * Records, trends and the PR rule for one movement — pure, DB-free, offline.
 *
 * Owner, on the device, 2026-09-23: *"trends, prs, etc for exercises (i.e.
 * fitbod)"*. Everything a screen prints about how a lift is going is computed
 * here from the logged sets and nowhere else: the records grid, best at each
 * rep count, the per-session trend and its direction of travel, the PR stamp in
 * the live logger, the PR mark in the history and the self-review's records.
 *
 * ## One rule, four surfaces
 *
 * The live stamp ({@link stampFor} → {@link recordsBeaten}), the history's PR
 * mark ({@link recordSessionIds}) and the self-review's record line
 * ({@link e1rmRecordOf}) all ask {@link kindsBeating}, so a set stamped PR in the
 * gym is the session marked PR afterwards and the record the report lists. The
 * Records grid is drawn from the same list of kinds ({@link recordKindsFor} →
 * {@link recordCellsFor}), so every record the grid shows is one a set can
 * stamp — the grid cannot grow a record the stamp never checks.
 *
 * ## Three rules every function here keeps
 *
 * 1. **Away sessions set nothing** (0055). {@link baselineRows} is the one
 *    definition of "comparable to the home baseline"; records, rep maxes, the
 *    PR rule and the direction of travel all read through it. The trend CHART
 *    keeps away sessions and marks them, because the session happened.
 * 2. **A record needs a previous best.** The first session of a movement sets
 *    its bars silently; nothing is stamped PR until there is something it
 *    beat. The same holds per rep count: a first-ever set of three is not a
 *    "best at 3 reps", it is the first one.
 * 3. **Figures stay in the logged basis** (src/lib/exercise/load-basis.ts). A
 *    per-hand movement's records, volumes and trends are per hand; nothing here
 *    doubles anything, because every comparison is a movement against itself.
 *    Assisted movements set no records at all — a higher figure is an easier
 *    set, and reps at different assistance are not one scale either
 *    ({@link loadRecordsApply}). Their grid shows rep counts as facts.
 */
import { E1RM_MAX_RIR, E1RM_REP_CAP, PACE_PR_MIN_M } from './constants';
import { e1rmForSet } from './e1rm';
import {
  dayLabel,
  formatClock,
  formatDistance,
  formatPace,
  formatWeight,
  parseClock,
  toCanonicalKg,
  toCanonicalMetres,
} from './format';
import { loadRecordsApply, type LoadBasis } from './load-basis';
import { hasMeasure, maskByMeasures, type Measures } from './measures';
import type { PersonalRecords, SetType } from './types';
import type { DateString } from '@/lib/db/types';
import type { UnitPreferences } from '@/lib/user/types';

/**
 * One logged working set, as `workingSets` (repositories/training-stats.ts)
 * returns it — non-warmup, newest workout first. Declared here structurally so
 * this module needs nothing from the database layer.
 */
export type RecordRow = {
  workout_id: string;
  date: DateString;
  reps: number | null;
  weight_kg: number | null;
  rpe: number | null;
  set_type: SetType;
  duration_sec: number | null;
  distance_m: number | null;
  /** The session's away flag (0055). */
  away: 0 | 1;
};

/** A set about to be (or just) completed — canonical kg, seconds and metres. */
export type CandidateSet = {
  weightKg: number | null;
  reps: number | null;
  rpe: number | null;
  setType: SetType;
  durationSec: number | null;
  distanceM: number | null;
};

/** What the record rules need to know about the movement and the session. */
export type RecordContext = {
  measures: Measures;
  basis: LoadBasis | null;
};

/**
 * A run of prose with its measured values marked — how a line that is mostly
 * words but carries figures is handed to a screen, so the screen can set the
 * words in the serif and only the figures in mono ("Serif speaks, mono
 * measures", 00-design-spec.md §3). {@link phraseText} joins it back for
 * accessibility labels and tests.
 */
export type PhrasePart = { text: string; measured?: true };

/** The parts of a phrase as one plain string. */
export function phraseText(parts: readonly PhrasePart[]): string {
  return parts.map((p) => p.text).join('');
}

const EPS = 1e-6;

/** Rep counts past this are endurance sets, not a rep max worth tabling. */
export const REP_MAX_CAP = 20;

/**
 * The sets a record may be set from and a baseline may be drawn from — home
 * sessions only, warmups never (0055).
 *
 * ONE definition, because two would drift: the records grid, best at each rep
 * count, the live PR stamp, the history's PR mark and the direction of travel
 * all have to agree exactly about which sets are comparable to the home
 * baseline, or a movement could show a record the stamp never saw.
 *
 * The asymmetry is 0055's whole argument: a false PR from a friendlier machine
 * raises every bar PERMANENTLY and the next home sessions then read as a stall,
 * while a missed real PR is recoverable next session. So an away session sets
 * no record even when its numbers are the best on record.
 */
export function baselineRows<T extends { away: 0 | 1; set_type: SetType }>(
  rows: readonly T[]
): T[] {
  return rows.filter((r) => r.away === 0 && r.set_type !== 'warmup');
}

const candidateOf = (r: RecordRow): CandidateSet => ({
  weightKg: r.weight_kg,
  reps: r.reps,
  rpe: r.rpe,
  setType: r.set_type,
  durationSec: r.duration_sec,
  distanceM: r.distance_m,
});

const positive = (n: number | null): number | null => (n != null && n > 0 ? n : null);

/** weight × reps for one set — null unless both are positive. */
const volumeOf = (s: CandidateSet): number | null => {
  const w = positive(s.weightKg);
  const r = positive(s.reps);
  return w != null && r != null ? w * r : null;
};

const maxOf = (m: Map<string, number>): number | null =>
  m.size === 0 ? null : Math.max(...m.values());

// ---------------------------------------------------------------------------
// Personal records — the grid on app/exercise-detail.tsx
// ---------------------------------------------------------------------------

/**
 * Personal records for one movement, over {@link baselineRows}. Loads are kg in
 * the logged basis, distances metres, times seconds. Empty-safe (nulls).
 *
 * The three load records need a weight, so a plank and a run leave them null;
 * the three endurance records (longest, farthest, best pace) need their own
 * columns. The three added on 2026-09-23 — best SESSION volume, most reps in a
 * set, most reps in a session — are Fitbod's "max volume" and "max reps", and
 * the last two are the first records a push-up has ever had: until now a
 * bodyweight movement's grid was three em-dashes for ever.
 *
 * `basis` gates the load records: an ASSISTED movement has none, because its
 * heaviest figure is its easiest set. Every caller that knows the movement
 * passes it — the detail screen, the Coach's `exercise_stats` — so no surface
 * can crown the most-assisted set as a record.
 *
 * Best pace keeps its 0046 rule: pieces of at least {@link PACE_PR_MIN_M} only,
 * so a sprint cannot own the record for every distance.
 */
export function personalRecordsOf(
  rows: readonly RecordRow[],
  basis: LoadBasis | null = null
): PersonalRecords {
  let maxWeightKg: number | null = null;
  let bestE1rmKg: number | null = null;
  let bestSetVolumeKg: number | null = null;
  let bestReps: number | null = null;
  let bestDurationSec: number | null = null;
  let bestDistanceM: number | null = null;
  let bestPaceSecPerKm: number | null = null;
  const sessionVolume = new Map<string, number>();
  const sessionReps = new Map<string, number>();

  for (const r of baselineRows(rows)) {
    if (r.weight_kg != null) {
      if (maxWeightKg == null || r.weight_kg > maxWeightKg) maxWeightKg = r.weight_kg;
      if (r.reps != null) {
        const vol = r.weight_kg * r.reps;
        if (bestSetVolumeKg == null || vol > bestSetVolumeKg) bestSetVolumeKg = vol;
        if (r.weight_kg > 0 && r.reps > 0) {
          sessionVolume.set(r.workout_id, (sessionVolume.get(r.workout_id) ?? 0) + vol);
        }
      }
    }
    const e = e1rmForSet(r.weight_kg, r.reps, r.rpe, r.set_type);
    if (e != null && (bestE1rmKg == null || e > bestE1rmKg)) bestE1rmKg = e;

    const reps = positive(r.reps);
    if (reps != null) {
      if (bestReps == null || reps > bestReps) bestReps = reps;
      sessionReps.set(r.workout_id, (sessionReps.get(r.workout_id) ?? 0) + reps);
    }

    const dur = positive(r.duration_sec);
    const dist = positive(r.distance_m);
    if (dur != null && (bestDurationSec == null || dur > bestDurationSec)) bestDurationSec = dur;
    if (dist != null && (bestDistanceM == null || dist > bestDistanceM)) bestDistanceM = dist;
    if (dur != null && dist != null && dist >= PACE_PR_MIN_M) {
      const pace = dur / (dist / 1000);
      if (bestPaceSecPerKm == null || pace < bestPaceSecPerKm) bestPaceSecPerKm = pace;
    }
  }
  const loads = loadRecordsApply(basis);
  return {
    maxWeightKg: loads ? maxWeightKg : null,
    bestE1rmKg: loads ? bestE1rmKg : null,
    bestSetVolumeKg: loads ? bestSetVolumeKg : null,
    bestSessionVolumeKg: loads ? maxOf(sessionVolume) : null,
    bestReps,
    bestSessionReps: maxOf(sessionReps),
    bestDurationSec,
    bestDistanceM,
    bestPaceSecPerKm,
  };
}

// ---------------------------------------------------------------------------
// Best at each rep count
// ---------------------------------------------------------------------------

/** The heaviest load ever lifted for exactly `reps` reps, and the day it was first lifted. */
export type RepMax = { reps: number; weightKg: number; date: DateString };

/**
 * Best weight at each rep count on record — Fitbod's and Hevy's rep-max table.
 *
 * EXACT rep counts, not "at least n": a movement only ever done for eights
 * would otherwise show its eight-rep weight as a "1RM", which is a claim about
 * a single nobody has attempted. The e1RM is where an estimated single lives.
 *
 * The date is the FIRST day the best was reached: matching your best later does
 * not make that the day you set it (the self-review's rule, same reason).
 * Home sessions only; loaded sets of 1–{@link REP_MAX_CAP} reps only; none at
 * all for an assisted movement, whose "best" weight is its most help.
 */
export function repMaxesFrom(
  rows: readonly RecordRow[],
  basis: LoadBasis | null = null
): RepMax[] {
  if (!loadRecordsApply(basis)) return [];
  const best = new Map<number, { weightKg: number; date: DateString }>();
  for (const r of baselineRows(rows)) {
    const weight = positive(r.weight_kg);
    if (weight == null || r.reps == null) continue;
    const reps = Math.round(r.reps);
    if (reps < 1 || reps > REP_MAX_CAP) continue;
    const cur = best.get(reps);
    if (
      cur == null ||
      weight > cur.weightKg + EPS ||
      (Math.abs(weight - cur.weightKg) <= EPS && r.date < cur.date)
    ) {
      best.set(reps, { weightKg: weight, date: r.date });
    }
  }
  return [...best.entries()]
    .map(([reps, b]) => ({ reps, weightKg: b.weightKg, date: b.date }))
    .sort((a, b) => a.reps - b.reps);
}

/**
 * What the rep-max table says when it has no rows — the reason, not a blanket
 * "nothing logged" over a movement with three sessions on record.
 */
export function repMaxEmptyNote(rows: readonly RecordRow[], basis: LoadBasis | null): string {
  if (rows.length === 0) return 'Nothing logged yet.';
  const home = baselineRows(rows);
  if (home.length === 0) return 'Only away sessions so far, and they set no records.';
  if (basis === 'bodyweight_plus' && !home.some((r) => positive(r.weight_kg) != null)) {
    return 'No sets with added weight yet.';
  }
  return `No loaded set of ${REP_MAX_CAP} reps or fewer yet.`;
}

// ---------------------------------------------------------------------------
// Which records a movement has — the grid and the stamp read the same list
// ---------------------------------------------------------------------------

/** Which record a set beat. */
export type RecordKind =
  | 'e1rm'
  | 'weight'
  | 'rep_max'
  | 'set_volume'
  | 'reps'
  | 'session_volume'
  | 'session_reps'
  | 'duration'
  | 'distance'
  | 'pace';

/** Display order, and the vocabulary a draft may carry. */
export const RECORD_KINDS: readonly RecordKind[] = [
  'e1rm',
  'weight',
  'rep_max',
  'set_volume',
  'reps',
  'session_volume',
  'session_reps',
  'duration',
  'distance',
  'pace',
];

/**
 * The records a movement HAS: every kind a set of it can stamp, from what it
 * measures and what its weight counts.
 *
 *   reps + load        best e1RM · heaviest · best at N reps · best set volume ·
 *                      best session volume · most reps (on a LOADED set)
 *   + bodyweight_plus  most reps · most reps in a session · heaviest added ·
 *                      best e1RM · best at N reps — no volume: added-load
 *                      volume leaves the body out and is not a figure anyone reads
 *   + assisted         none (see the module note)
 *   reps, no load      most reps · most reps in a session
 *   load, no reps      heaviest
 *   time / distance    longest / farthest, and fastest pace when it has both
 */
export function recordKindsFor(measures: Measures, basis: LoadBasis | null): RecordKind[] {
  const reps = hasMeasure(measures, 'reps');
  const load = hasMeasure(measures, 'load');
  const loads = load && loadRecordsApply(basis);
  const time = hasMeasure(measures, 'time');
  const distance = hasMeasure(measures, 'distance');
  const out: RecordKind[] = [];
  if (reps && load) {
    if (loads && basis === 'bodyweight_plus') {
      out.push('reps', 'session_reps', 'weight', 'e1rm', 'rep_max');
    } else if (loads) {
      out.push('e1rm', 'weight', 'rep_max', 'set_volume', 'session_volume', 'reps');
    }
  } else if (reps) {
    out.push('reps', 'session_reps');
  } else if (loads) {
    out.push('weight');
  }
  if (time) out.push('duration');
  if (distance) out.push('distance');
  if (time && distance) out.push('pace');
  return out;
}

/** One cell of the Records grid: a record, or the session count beside them. */
export type RecordCell = Exclude<RecordKind, 'rep_max'> | 'sessions';

export const RECORD_CELL_LABEL: Record<RecordCell, string> = {
  e1rm: 'Best e1RM',
  weight: 'Top set',
  set_volume: 'Set volume',
  session_volume: 'Session volume',
  reps: 'Most reps',
  session_reps: 'Session reps',
  duration: 'Longest',
  distance: 'Farthest',
  pace: 'Best pace',
  sessions: 'Sessions',
};

/**
 * The Records grid's cells, in order: {@link recordKindsFor} less `rep_max`
 * (which is the table below the grid), plus the session count. So every record
 * on the grid is one a set can stamp, by construction.
 *
 *   reps + load        Best e1RM · Top set · Set volume / Session volume · Most reps · Sessions
 *   bodyweight_plus    Most reps · Session reps · Sessions / Top set · Best e1RM
 *   reps, or assisted  Most reps · Session reps · Sessions
 *   anything else      its records, then Sessions — a plank is Longest · Sessions
 *
 * The one exception is an ASSISTED movement, which has no stamping kinds but
 * still shows its rep counts: they are facts about what was done, not records
 * anything is measured against.
 */
export function recordCellsFor(measures: Measures, basis: LoadBasis | null): RecordCell[] {
  const reps = hasMeasure(measures, 'reps');
  if (reps && hasMeasure(measures, 'load') && !loadRecordsApply(basis)) {
    return ['reps', 'session_reps', 'sessions'];
  }
  const cells = recordKindsFor(measures, basis).filter(
    (k): k is Exclude<RecordKind, 'rep_max'> => k !== 'rep_max'
  );
  if (cells[0] === 'e1rm') {
    return ['e1rm', 'weight', 'set_volume', 'session_volume', 'reps', 'sessions'];
  }
  if (cells[0] === 'reps') {
    // A bodyweight movement's records are its reps, so they lead; a weighted
    // pull-up's added-load records follow on the second row.
    return [
      'reps',
      'session_reps',
      'sessions',
      ...cells.filter((c) => c !== 'reps' && c !== 'session_reps'),
    ];
  }
  return [...cells, 'sessions'];
}

/**
 * The grid, ready to draw: each cell's label and its value in the user's
 * units, or null for a record not yet set (the screen draws an em-dash).
 */
export function recordCellsOf(
  measures: Measures,
  basis: LoadBasis | null,
  prs: PersonalRecords,
  sessionCount: number,
  units: UnitPreferences
): { cell: RecordCell; label: string; value: string | null }[] {
  const w = (kg: number | null) => (kg == null ? null : formatWeight(kg, units));
  const n = (v: number | null) => (v == null ? null : String(Math.round(v)));
  const valueOf = (cell: RecordCell): string | null => {
    switch (cell) {
      case 'e1rm':
        return w(prs.bestE1rmKg);
      case 'weight':
        return w(prs.maxWeightKg);
      case 'set_volume':
        return w(prs.bestSetVolumeKg);
      case 'session_volume':
        return w(prs.bestSessionVolumeKg);
      case 'reps':
        return n(prs.bestReps);
      case 'session_reps':
        return n(prs.bestSessionReps);
      case 'duration':
        return prs.bestDurationSec == null ? null : formatClock(prs.bestDurationSec);
      case 'distance':
        return prs.bestDistanceM == null ? null : formatDistance(prs.bestDistanceM, units);
      case 'pace':
        return prs.bestPaceSecPerKm == null ? null : formatPace(prs.bestPaceSecPerKm, units);
      case 'sessions':
        return sessionCount > 0 ? String(sessionCount) : null;
    }
  };
  return recordCellsFor(measures, basis).map((cell) => ({
    cell,
    label: RECORD_CELL_LABEL[cell],
    value: valueOf(cell),
  }));
}

// ---------------------------------------------------------------------------
// The PR rule — live stamp, history mark and report alike
// ---------------------------------------------------------------------------

/** The running bests one set is measured against. */
type Bars = {
  e1rm: number | null;
  weight: number | null;
  repMax: Map<number, number>;
  setVolume: number | null;
  reps: number | null;
  duration: number | null;
  distance: number | null;
  pace: number | null;
};

/** The bests before this session: per-set bars plus the best SESSION totals. */
type PriorBars = Bars & { sessionVolume: number | null; sessionReps: number | null };

/** This session so far: the other sets' bars, and their running totals. */
type SoFar = { bars: Bars; volume: number; reps: number };

const emptyBars = (): Bars => ({
  e1rm: null,
  weight: null,
  repMax: new Map(),
  setVolume: null,
  reps: null,
  duration: null,
  distance: null,
  pace: null,
});

const emptyPrior = (): PriorBars => ({ ...emptyBars(), sessionVolume: null, sessionReps: null });
const emptySoFar = (): SoFar => ({ bars: emptyBars(), volume: 0, reps: 0 });

const higher = (a: number | null, b: number | null): number | null =>
  a == null ? b : b == null ? a : Math.max(a, b);

function paceOf(set: CandidateSet): number | null {
  const dur = positive(set.durationSec);
  const dist = positive(set.distanceM);
  if (dur == null || dist == null || dist < PACE_PR_MIN_M) return null;
  return dur / (dist / 1000);
}

/** A set with the columns its movement does not measure blanked, as Finish stores it. */
const masked = (set: CandidateSet, measures: Measures): CandidateSet => ({
  ...set,
  ...maskByMeasures(measures, set),
});

/** Raise `bars` by one set. Warmups never count. */
function fold(bars: Bars, set: CandidateSet): void {
  if (set.setType === 'warmup') return;
  bars.e1rm = higher(bars.e1rm, e1rmForSet(set.weightKg, set.reps, set.rpe, set.setType));
  const weight = positive(set.weightKg);
  bars.weight = higher(bars.weight, weight);
  if (weight != null && set.reps != null) {
    const reps = Math.round(set.reps);
    if (reps >= 1 && reps <= REP_MAX_CAP) {
      bars.repMax.set(reps, Math.max(bars.repMax.get(reps) ?? 0, weight));
    }
  }
  bars.setVolume = higher(bars.setVolume, volumeOf(set));
  bars.reps = higher(bars.reps, positive(set.reps));
  bars.duration = higher(bars.duration, positive(set.durationSec));
  bars.distance = higher(bars.distance, positive(set.distanceM));
  const pace = paceOf(set);
  if (pace != null && (bars.pace == null || pace < bars.pace)) bars.pace = pace;
}

/** Add one set to the session so far. */
function addToSoFar(soFar: SoFar, set: CandidateSet): void {
  if (set.setType === 'warmup') return;
  fold(soFar.bars, set);
  soFar.volume += volumeOf(set) ?? 0;
  soFar.reps += positive(set.reps) ?? 0;
}

/** Fold one finished session into the prior bests — its sets, and its totals. */
function addSession(prior: PriorBars, sets: readonly CandidateSet[]): void {
  const soFar = emptySoFar();
  for (const s of sets) {
    fold(prior, s);
    addToSoFar(soFar, s);
  }
  // Same inclusion as `personalRecordsOf`: a session with no loaded set has
  // no volume to be a best of, and one with no reps no rep total.
  if (soFar.volume > 0) prior.sessionVolume = higher(prior.sessionVolume, soFar.volume);
  if (soFar.reps > 0) prior.sessionReps = higher(prior.sessionReps, soFar.reps);
}

/** The logged home sessions, oldest first, each with its sets in logged order. */
function sessionsOldestFirst(
  rows: readonly RecordRow[]
): { id: string; date: DateString; sets: CandidateSet[] }[] {
  const sessions: { id: string; date: DateString; sets: CandidateSet[] }[] = [];
  const byId = new Map<string, CandidateSet[]>();
  // rows arrive newest-first; first appearance order, reversed, is oldest-first.
  for (const r of baselineRows(rows)) {
    let sets = byId.get(r.workout_id);
    if (!sets) {
      sets = [];
      byId.set(r.workout_id, sets);
      sessions.push({ id: r.workout_id, date: r.date, sets });
    }
    sets.push(candidateOf(r));
  }
  return sessions.reverse();
}

function priorOf(history: readonly RecordRow[]): PriorBars {
  const prior = emptyPrior();
  for (const s of sessionsOldestFirst(history)) addSession(prior, s.sets);
  return prior;
}

/**
 * Which records `raw` beats, against `prior` (the bests before this session)
 * and `soFar` (the other sets already done in it).
 *
 * The kinds in play are {@link recordKindsFor}'s — nothing here can stamp a
 * record the grid does not show. A kind is only in play when `prior` has a
 * value for it (rule 2 in the module note), and a set must clear both bars, so
 * the second of two record sets in one session stamps only if it beats the
 * first. Two conditions are the set's own:
 *
 *   * **Most reps on a loaded lift needs the load typed.** A blank weight on a
 *     bench set is a typo, not a record; where the load is optional (a push-up,
 *     an unweighted pull-up) a blank weight IS the movement.
 *   * **A session total stamps the set that carries it over.** Best session
 *     volume and most reps in a session are properties of the session, so the
 *     one set that takes the running total past the old best is the one
 *     stamped — once per session, however many sets follow.
 */
function kindsBeating(
  raw: CandidateSet,
  prior: PriorBars,
  soFar: SoFar,
  ctx: RecordContext
): RecordKind[] {
  if (raw.setType === 'warmup') return [];
  const has = new Set(recordKindsFor(ctx.measures, ctx.basis));
  if (has.size === 0) return [];
  const set = masked(raw, ctx.measures);
  const mine = soFar.bars;
  const beats = (value: number | null, before: number | null, own: number | null): boolean =>
    value != null && before != null && value > before + EPS && (own == null || value > own + EPS);
  const crosses = (add: number | null, total: number, before: number | null): boolean =>
    add != null && before != null && total <= before + EPS && total + add > before + EPS;
  const out = new Set<RecordKind>();

  const weight = positive(set.weightKg);
  const reps = positive(set.reps);
  if (has.has('e1rm')) {
    const e = e1rmForSet(set.weightKg, set.reps, set.rpe, set.setType);
    if (beats(e, prior.e1rm, mine.e1rm)) out.add('e1rm');
  }
  if (has.has('weight') && beats(weight, prior.weight, mine.weight)) out.add('weight');
  if (has.has('rep_max') && weight != null && reps != null) {
    const n = Math.round(reps);
    if (
      n >= 1 &&
      n <= REP_MAX_CAP &&
      beats(weight, prior.repMax.get(n) ?? null, mine.repMax.get(n) ?? null)
    ) {
      out.add('rep_max');
    }
  }
  const volume = volumeOf(set);
  if (has.has('set_volume') && beats(volume, prior.setVolume, mine.setVolume)) {
    out.add('set_volume');
  }
  const repsCount =
    weight != null || !hasMeasure(ctx.measures, 'load') || ctx.basis === 'bodyweight_plus';
  if (has.has('reps') && repsCount && beats(reps, prior.reps, mine.reps)) out.add('reps');
  if (has.has('session_volume') && crosses(volume, soFar.volume, prior.sessionVolume)) {
    out.add('session_volume');
  }
  if (has.has('session_reps') && crosses(reps, soFar.reps, prior.sessionReps)) {
    out.add('session_reps');
  }
  if (has.has('duration') && beats(positive(set.durationSec), prior.duration, mine.duration)) {
    out.add('duration');
  }
  if (has.has('distance') && beats(positive(set.distanceM), prior.distance, mine.distance)) {
    out.add('distance');
  }
  const pace = paceOf(set);
  if (
    has.has('pace') &&
    pace != null &&
    prior.pace != null &&
    pace < prior.pace - EPS &&
    (mine.pace == null || pace < mine.pace - EPS)
  ) {
    out.add('pace');
  }
  return RECORD_KINDS.filter((k) => out.has(k));
}

/**
 * Which records a just-completed set beats.
 *
 * `history` is `workingSets` for the movement — the logged sessions, which by
 * construction do not include this one (the live session is a draft until
 * Finish, 0045). `session` is the other sets already marked done in this
 * session. **An away session stamps nothing** (0055) — the rule lives here
 * rather than at the call site, so no future caller can award an away PR by
 * forgetting to ask.
 */
export function recordsBeaten(
  set: CandidateSet,
  history: readonly RecordRow[],
  session: readonly CandidateSet[],
  ctx: RecordContext & { away: boolean }
): RecordKind[] {
  if (ctx.away) return [];
  const soFar = emptySoFar();
  for (const s of session) addToSoFar(soFar, masked(s, ctx.measures));
  return kindsBeating(set, priorOf(history), soFar, ctx);
}

/** A set as the live logger holds it: typed strings (`DraftSet`'s shape). */
export type TypedSet = {
  key: number;
  weight: string;
  reps: string;
  rpe: string;
  time: string;
  distance: string;
  setType: SetType;
  done: boolean;
  storedWeightKg?: number | null;
  storedWeightText?: string;
};

/** A live logger block, as far as the stamp needs it (`DraftBlock`'s shape). */
export type TypedBlock = { exerciseId: string | null; sets: readonly TypedSet[] };

/**
 * The live PR stamp for one set, from the live logger's own state — the whole
 * of what ticking a set asks, so it is tested as a function rather than as a
 * screen (the screen only reads `history` and passes this through).
 *
 *   * **Editing a past session stamps nothing**: a stamp is a claim about right
 *     now, and that set happened days ago. Nor does a free-text block, which
 *     has no movement to hold records.
 *   * **The session is every block of the same movement**, not the set's own
 *     block: bench → row → bench is one session of bench, and the second bench
 *     block must clear the records the first already set.
 *   * `set` is the set AS IT NOW READS — the ticked set, or a done set whose
 *     numbers were just edited, which is re-asked rather than left carrying a
 *     stamp for figures it no longer holds.
 */
export function stampFor(input: {
  set: TypedSet;
  exerciseId: string | null;
  measures: Measures;
  blocks: readonly TypedBlock[];
  history: readonly RecordRow[];
  basis: LoadBasis | null;
  away: boolean;
  editing: boolean;
  units: UnitPreferences;
}): RecordKind[] {
  if (input.editing || input.exerciseId == null) return [];
  const session = input.blocks
    .filter((b) => b.exerciseId === input.exerciseId)
    .flatMap((b) => b.sets.filter((s) => s.done && s.key !== input.set.key))
    .map((s) => candidateFromTyped(s, input.units));
  return recordsBeaten(candidateFromTyped(input.set, input.units), input.history, session, {
    away: input.away,
    measures: input.measures,
    basis: input.basis,
  });
}

/**
 * The sessions that set at least one record at the time they were logged —
 * the PR mark in the detail screen's history. Walks the home sessions oldest
 * first, asks each set the live stamp's own question against everything before
 * its session and the sets before it in that session, then folds the session
 * in. Away sessions are neither marked nor folded. Returns workout ids.
 */
export function recordSessionIds(rows: readonly RecordRow[], ctx: RecordContext): Set<string> {
  const prior = emptyPrior();
  const marked = new Set<string>();
  for (const s of sessionsOldestFirst(rows)) {
    const soFar = emptySoFar();
    for (const set of s.sets) {
      if (kindsBeating(set, prior, soFar, ctx).length > 0) marked.add(s.id);
      addToSoFar(soFar, set);
    }
    addSession(prior, s.sets);
  }
  return marked;
}

/**
 * The self-review's "personal record set this period" for one movement: its
 * all-time best e1RM, the day it was first reached, and only when reaching it
 * BEAT an earlier best — the live stamp's `e1rm` kind, asked of the history.
 * Null for a movement whose best is still its first session (nothing was
 * beaten), for an assisted one, and for one with no e1RM at all.
 */
export function e1rmRecordOf(
  rows: readonly RecordRow[],
  ctx: RecordContext
): { e1rmKg: number; date: DateString } | null {
  const prior = emptyPrior();
  let record: { e1rmKg: number; date: DateString } | null = null;
  for (const s of sessionsOldestFirst(rows)) {
    const soFar = emptySoFar();
    for (const set of s.sets) {
      if (kindsBeating(set, prior, soFar, ctx).includes('e1rm')) {
        const e = e1rmForSet(set.weightKg, set.reps, set.rpe, set.setType);
        if (e != null) record = { e1rmKg: e, date: s.date };
      }
      addToSoFar(soFar, set);
    }
    addSession(prior, s.sets);
  }
  // Every stamp raised the bar, so the last one is the all-time best — unless
  // the best is still the first session's, which stamped nothing.
  return record != null && prior.e1rm != null && record.e1rmKg >= prior.e1rm - EPS
    ? record
    : null;
}

/**
 * A draft set's fields as typed → canonical numbers, the same conversion
 * Finish performs. Blank or unparseable reads as null. An untouched weight
 * loaded from a stored session keeps its exact stored kg.
 */
export function candidateFromTyped(
  t: {
    weight: string;
    reps: string;
    rpe: string;
    time: string;
    distance: string;
    setType: SetType;
    storedWeightKg?: number | null;
    storedWeightText?: string;
  },
  units: UnitPreferences
): CandidateSet {
  const num = (s: string): number | null => {
    if (s.trim() === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const typedWeight = num(t.weight);
  const weightKg =
    t.storedWeightText != null && t.weight === t.storedWeightText
      ? (t.storedWeightKg ?? null)
      : typedWeight == null
        ? null
        : toCanonicalKg(typedWeight, units);
  const distance = num(t.distance);
  return {
    weightKg,
    reps: num(t.reps),
    rpe: num(t.rpe),
    setType: t.setType,
    durationSec: parseClock(t.time),
    distanceM: distance == null ? null : toCanonicalMetres(distance, units),
  };
}

/** How one record reads in a line, with its figure marked: "best at `5 reps`". */
function recordKindParts(kind: RecordKind, reps: number | null): PhrasePart[] {
  switch (kind) {
    case 'e1rm':
      return [{ text: 'best e1RM' }];
    case 'weight':
      return [{ text: 'heaviest' }];
    case 'rep_max':
      return reps === 1
        ? [{ text: 'best single' }]
        : [{ text: 'best at ' }, { text: `${reps ?? '—'} reps`, measured: true }];
    case 'set_volume':
      return [{ text: 'best set volume' }];
    case 'reps':
      return [{ text: 'most reps' }];
    case 'session_volume':
      return [{ text: 'best session volume' }];
    case 'session_reps':
      return [{ text: 'most reps in a session' }];
    case 'duration':
      return [{ text: 'longest' }];
    case 'distance':
      return [{ text: 'farthest' }];
    case 'pace':
      return [{ text: 'fastest pace' }];
  }
}

/** How one record reads in a line: "best e1RM", "best at 5 reps". */
export function recordKindLabel(kind: RecordKind, reps: number | null): string {
  return phraseText(recordKindParts(kind, reps));
}

/**
 * The live logger's PR line for one block, as parts: "Set 3: best e1RM,
 * heaviest · Set 4: best at 5 reps", with the set numbers and rep counts
 * marked as figures. Null when nothing was beaten.
 *
 * `rep_max` is dropped from a set that is also the heaviest ever: the heaviest
 * set on record is necessarily the best at its own rep count, and saying both
 * is one fact twice.
 */
export function prSummaryParts(
  sets: readonly { index: number; reps: number | null; kinds: readonly RecordKind[] }[]
): PhrasePart[] | null {
  const parts: PhrasePart[] = [];
  for (const s of sets) {
    const kinds = RECORD_KINDS.filter(
      (k) => s.kinds.includes(k) && !(k === 'rep_max' && s.kinds.includes('weight'))
    );
    if (kinds.length === 0) continue;
    if (parts.length > 0) parts.push({ text: ' · ' });
    parts.push({ text: 'Set ' }, { text: String(s.index), measured: true }, { text: ': ' });
    kinds.forEach((k, i) => {
      if (i > 0) parts.push({ text: ', ' });
      parts.push(...recordKindParts(k, s.reps));
    });
  }
  return parts.length > 0 ? parts : null;
}

/** {@link prSummaryParts} as one string. */
export function prSummary(
  sets: readonly { index: number; reps: number | null; kinds: readonly RecordKind[] }[]
): string | null {
  const parts = prSummaryParts(sets);
  return parts == null ? null : phraseText(parts);
}

// ---------------------------------------------------------------------------
// Trends — one value per session, and the direction of travel
// ---------------------------------------------------------------------------

/** What a trend can plot, per session. */
export type TrendMetric =
  'e1rm' | 'top_weight' | 'volume' | 'reps' | 'session_reps' | 'duration' | 'distance';

export const TREND_METRIC_LABEL: Record<TrendMetric, string> = {
  e1rm: 'e1RM',
  top_weight: 'Top set',
  volume: 'Volume',
  reps: 'Most reps',
  session_reps: 'Session reps',
  duration: 'Longest',
  distance: 'Farthest',
};

/** One session on a trend. `away` marks it — plotted, never a baseline. */
export type TrendPoint = { workoutId: string; date: DateString; value: number; away?: true };

/**
 * The metrics a movement's trend can show, in chip order, from what it measures.
 *
 *   reps + load        e1RM · Top set · Volume · Most reps
 *   reps, no load      Most reps · Session reps   (and an assisted movement)
 *   load, no reps      Top set                    (a carry, a weighted hold)
 *   + distance / time  Farthest / Longest
 */
export function trendMetricsFor(measures: Measures, basis: LoadBasis | null): TrendMetric[] {
  const reps = hasMeasure(measures, 'reps');
  const load = hasMeasure(measures, 'load') && loadRecordsApply(basis);
  const out: TrendMetric[] = [];
  if (reps && load) out.push('e1rm', 'top_weight', 'volume', 'reps');
  else {
    if (load) out.push('top_weight');
    if (reps) out.push('reps', 'session_reps');
  }
  if (hasMeasure(measures, 'distance')) out.push('distance');
  if (hasMeasure(measures, 'time')) out.push('duration');
  return out;
}

/** The order a single direction is looked for in — the first with an answer wins. */
const DIRECTION_ORDER: readonly TrendMetric[] = ['e1rm', 'top_weight', 'reps', 'duration'];

/**
 * The metrics a movement's direction of travel may be read from, best first.
 *
 * A lift reads its e1RM; when fewer than two home sessions carry one (sets past
 * the e1RM rep cap, or logged below RPE 6) its top weight; and when its sets
 * carry no weight at all — a pull-up or a dip logged at bodyweight, the
 * commonest way to do either — its most reps. Anything that covers distance
 * gets none: whether a run is "better" as longer or as faster depends on what
 * the run was for, and an arrow cannot say which.
 */
export function directionMetricsFor(measures: Measures, basis: LoadBasis | null): TrendMetric[] {
  if (hasMeasure(measures, 'distance')) return [];
  const offered = trendMetricsFor(measures, basis);
  return DIRECTION_ORDER.filter((m) => offered.includes(m));
}

/** The first metric a direction is looked for in, or null when there is none. */
export function primaryTrendMetric(
  measures: Measures,
  basis: LoadBasis | null
): TrendMetric | null {
  return directionMetricsFor(measures, basis)[0] ?? null;
}

/**
 * How many sessions a series holds unless asked for more. The Train hub's
 * direction reads through this default; exercise detail's Trend drew exactly
 * this many until it had ranges (2026-09-25), and its default range still
 * shows every one of them ({@link defaultTrendRange}).
 */
export const TREND_SESSION_LIMIT = 24;

/**
 * One point per SESSION (workout), oldest → newest, the most recent `limit`.
 * A session with no value for the metric (every set blank) is absent, not zero.
 * Away sessions are kept and marked (0055).
 */
export function sessionSeriesFrom(
  rows: readonly RecordRow[],
  metric: TrendMetric,
  limit = TREND_SESSION_LIMIT
): TrendPoint[] {
  const order: string[] = [];
  const agg = new Map<string, { date: DateString; away: boolean; value: number | null }>();
  for (const r of rows) {
    if (r.set_type === 'warmup') continue;
    let cur = agg.get(r.workout_id);
    if (!cur) {
      cur = { date: r.date, away: r.away === 1, value: null };
      agg.set(r.workout_id, cur);
      order.push(r.workout_id);
    }
    const weight = positive(r.weight_kg);
    const reps = positive(r.reps);
    let v: number | null = null;
    let sum = false;
    switch (metric) {
      case 'e1rm':
        v = e1rmForSet(r.weight_kg, r.reps, r.rpe, r.set_type);
        break;
      case 'top_weight':
        v = weight;
        break;
      case 'volume':
        v = weight != null && reps != null ? weight * reps : null;
        sum = true;
        break;
      case 'reps':
        v = reps;
        break;
      case 'session_reps':
        v = reps;
        sum = true;
        break;
      case 'duration':
        v = positive(r.duration_sec);
        break;
      case 'distance':
        v = positive(r.distance_m);
        break;
    }
    if (v == null) continue;
    cur.value = cur.value == null ? v : sum ? cur.value + v : Math.max(cur.value, v);
  }
  // `order` is newest-first (rows are); keep the latest `limit`, then flip.
  return order
    .filter((id) => agg.get(id)!.value != null)
    .slice(0, limit)
    .reverse()
    .map((id) => {
      const p = agg.get(id)!;
      return {
        workoutId: id,
        date: p.date,
        value: p.value as number,
        ...(p.away ? { away: true as const } : {}),
      };
    });
}

/** Sessions before the latest that the latest is compared with. */
export const TREND_WINDOW = 3;
/** Within this many percent either way, the lift reads level. */
export const TREND_LEVEL_PCT = 2;

/** The direction of travel of one movement. */
export type Trend = {
  direction: 'up' | 'down' | 'level';
  /** Latest home session against the mean of the ones before it, percent. */
  changePct: number;
  latest: number;
  baseline: number;
  /** How many sessions the baseline averages — 1 to {@link TREND_WINDOW}. */
  compared: number;
};

/**
 * Where a movement is heading: the latest HOME session against the mean of the
 * up-to-{@link TREND_WINDOW} home sessions before it, level within
 * ±{@link TREND_LEVEL_PCT}%.
 *
 * A mean of three rather than the last session alone, because one bad Tuesday
 * is not a direction; and home sessions only, because a stiffer machine is not
 * a regression (0055) — an away session is on the chart, never in the
 * comparison. Null with fewer than two home sessions: one point has no
 * direction.
 */
export function trendOf(points: readonly TrendPoint[]): Trend | null {
  const home = points.filter((p) => p.away !== true);
  if (home.length < 2) return null;
  return compareTrend(home[home.length - 1]!.value, home.slice(-1 - TREND_WINDOW, -1));
}

/** The latest value against the mean of `prior` — the arithmetic both directions share. */
function compareTrend(latest: number, prior: readonly TrendPoint[]): Trend | null {
  const baseline = prior.reduce((a, p) => a + p.value, 0) / prior.length;
  if (!(baseline > 0)) return null;
  const changePct = ((latest - baseline) / baseline) * 100;
  const direction = Math.abs(changePct) < TREND_LEVEL_PCT ? 'level' : changePct > 0 ? 'up' : 'down';
  return { direction, changePct, latest, baseline, compared: prior.length };
}

/**
 * A movement's direction of travel and the metric it was read from — the Train
 * hub's arrow, and the metric exercise detail opens its Trend on. The first
 * metric of {@link directionMetricsFor} with a direction wins; null when none
 * has one.
 *
 * The row and the screen it opens agree because the screen's first direction
 * line is this figure, computed the same way ({@link trendView}: `trendOf`
 * over `sessionSeriesFrom(rows, metric)`) on every range chip. The change
 * across a range is a second line under it, naming its range, and is allowed
 * to point the other way: a lift up 20% on the month can be down 8% on the
 * last three sessions, and both are true. (One edge is outside this: the hub
 * reads each movement's latest eight sessions, so when five or more of them
 * were away sessions its baseline holds fewer home sessions than detail's.)
 */
export function directionOf(
  rows: readonly RecordRow[],
  measures: Measures,
  basis: LoadBasis | null
): { metric: TrendMetric; trend: Trend } | null {
  for (const metric of directionMetricsFor(measures, basis)) {
    const trend = trendOf(sessionSeriesFrom(rows, metric));
    if (trend) return { metric, trend };
  }
  return null;
}

/**
 * The metric exercise detail's Trend opens on, chosen by the data rather than
 * by position: the direction's own metric when there is one (so the hub's
 * "+10%" opens on the chart it came from); otherwise the first metric with two
 * sessions to draw — direction metrics first, then the rest (a run's distance);
 * otherwise the first the movement offers, whose empty note then says what is
 * missing ({@link trendEmptyNote}).
 */
export function defaultTrendMetric(
  rows: readonly RecordRow[],
  measures: Measures,
  basis: LoadBasis | null
): TrendMetric | null {
  const direction = directionOf(rows, measures, basis);
  if (direction) return direction.metric;
  const offered = trendMetricsFor(measures, basis);
  const preferred = directionMetricsFor(measures, basis);
  const ordered = [...preferred, ...offered.filter((m) => !preferred.includes(m))];
  return ordered.find((m) => sessionSeriesFrom(rows, m).length >= 2) ?? offered[0] ?? null;
}

/**
 * Why a Trend has nothing to draw — what is actually missing, not a blanket
 * "needs two sessions" over a movement with five on record.
 */
export function trendEmptyNote(metric: TrendMetric, rows: readonly RecordRow[]): string {
  switch (metric) {
    case 'e1rm': {
      const weighted = new Set(
        rows
          .filter(
            (r) =>
              r.set_type !== 'warmup' && positive(r.weight_kg) != null && positive(r.reps) != null
          )
          .map((r) => r.workout_id)
      ).size;
      return weighted < 2
        ? 'An estimated-1RM trend needs two weighted sessions.'
        : `An estimated 1RM needs a set of ${E1RM_REP_CAP} reps or fewer that is not logged below RPE ${
            10 - E1RM_MAX_RIR
          }. Fewer than two sessions have one.`;
    }
    case 'top_weight':
      return 'A top-set trend needs two sessions with a weight logged.';
    case 'volume':
      return 'A volume trend needs two sessions with weight and reps logged.';
    case 'reps':
    case 'session_reps':
      return 'A reps trend needs two sessions with reps logged.';
    case 'duration':
      return 'A time trend needs two sessions with a time logged.';
    case 'distance':
      return 'A distance trend needs two sessions with a distance logged.';
  }
}

/**
 * The Trend's large figure, and what it is. The direction line under it is
 * read from the latest HOME session, so when the last point on the chart is an
 * away session the figure must not silently be a different session from the
 * one the line describes: it shows the home value the line was read from and
 * says so, or — with no direction to explain — the away value, marked.
 */
export function trendHeadline(
  series: readonly TrendPoint[],
  trend: Trend | null
): { value: number; label: string } | null {
  const last = series[series.length - 1];
  if (!last) return null;
  if (last.away !== true) return { value: last.value, label: 'Latest' };
  if (trend) return { value: trend.latest, label: 'Latest at home' };
  return { value: last.value, label: 'Latest · away gym' };
}

/** "+4%", "−3%" or "level" — the Train hub's direction token (mono). */
export function trendToken(trend: Trend): string {
  if (trend.direction === 'level') return 'level';
  const pct = Math.round(Math.abs(trend.changePct));
  return `${trend.direction === 'up' ? '+' : '−'}${pct}%`;
}

/**
 * The direction as a phrase, with its figures marked: "`+4%` on the previous
 * `3 sessions`", "level with the previous session".
 */
export function trendPhraseParts(trend: Trend): PhrasePart[] {
  const against: PhrasePart[] =
    trend.compared === 1
      ? [{ text: 'the previous session' }]
      : [{ text: 'the previous ' }, { text: `${trend.compared} sessions`, measured: true }];
  if (trend.direction === 'level') return [{ text: 'level with ' }, ...against];
  return [{ text: trendToken(trend), measured: true }, { text: ' on ' }, ...against];
}

/**
 * The same, as one string: "+4% on the previous 3 sessions". `spoken` says it
 * in words for VoiceOver.
 */
export function trendPhrase(trend: Trend, options: { spoken?: boolean } = {}): string {
  if (options.spoken && trend.direction !== 'level') {
    const against =
      trend.compared === 1 ? 'the previous session' : `the previous ${trend.compared} sessions`;
    const pct = Math.round(Math.abs(trend.changePct));
    return `${trend.direction} ${pct} percent on ${against}`;
  }
  return phraseText(trendPhraseParts(trend));
}

/** A trend value in the user's units: "102.5 kg", "14 reps", "1:30", "5.2 km". */
export function formatTrendValue(
  metric: TrendMetric,
  value: number,
  units: UnitPreferences
): string {
  switch (metric) {
    case 'e1rm':
    case 'top_weight':
    case 'volume':
      return formatWeight(value, units);
    case 'reps':
    case 'session_reps': {
      const n = Math.round(value);
      return `${n} ${n === 1 ? 'rep' : 'reps'}`;
    }
    case 'duration':
      return formatClock(value);
    case 'distance':
      return formatDistance(value, units);
  }
}

// ---------------------------------------------------------------------------
// Ranges — how far back the Trend looks (owner, 2026-09-25: "Add range chips")
// ---------------------------------------------------------------------------

/** How far back exercise detail's Trend looks. */
export type TrendRange = '1m' | '3m' | '1y' | 'all';

/** Chip order, shortest first — {@link defaultTrendRange} depends on it. */
export const TREND_RANGES: readonly TrendRange[] = ['1m', '3m', '1y', 'all'];

export const TREND_RANGE_LABEL: Record<TrendRange, string> = {
  '1m': '1M',
  '3m': '3M',
  '1y': '1Y',
  all: 'All',
};

/** The range in words — what the direction line, the empty note and VoiceOver name. */
export const TREND_RANGE_WORDS: Record<TrendRange, string> = {
  '1m': 'the last month',
  '3m': 'the last 3 months',
  '1y': 'the last year',
  all: 'everything on record',
};

const RANGE_MONTHS: Record<Exclude<TrendRange, 'all'>, number> = { '1m': 1, '3m': 3, '1y': 12 };

/**
 * The same calendar date `months` earlier, clamped to the month's length — a
 * month before 31 March is 28 (or 29) February. Arithmetic on the YYYY-MM-DD
 * string, so no time zone is involved; `Date.UTC` only counts a month's days.
 */
function monthsBefore(date: DateString, months: number): DateString {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) - months;
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  const day = Math.min(d, new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  const two = (n: number) => String(n).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${two(month + 1)}-${two(day)}`;
}

/**
 * The first date a range includes, or null for All: on or after the same date
 * one, three or twelve months before `today`.
 */
export function trendRangeStart(range: TrendRange, today: DateString): DateString | null {
  return range === 'all' ? null : monthsBefore(today, RANGE_MONTHS[range]);
}

/** The points of a series inside a range, oldest → newest. */
export function inTrendRange(
  points: readonly TrendPoint[],
  range: TrendRange,
  today: DateString
): TrendPoint[] {
  const from = trendRangeStart(range, today);
  return from == null ? points.slice() : points.filter((p) => p.date >= from);
}

/**
 * The range the Trend opens on: **the shortest one that still shows every
 * session the Trend showed before it had ranges** — the latest
 * {@link TREND_SESSION_LIMIT}, or all of them when there are fewer.
 *
 * So the default never hides a session the owner could see before, and never
 * draws more history than it has to. For a lift trained twice a week it is
 * 3M; for a movement started this month, 1M; for one done weekly for a year,
 * 1Y. With the owner's history as it stands (logging since August 2026) almost
 * every movement opens on 1M or 3M. A fixed chip could not promise both
 * halves: 3M hides half of a weekly lift's last 24 sessions, and All draws
 * years of a daily one. `points` is the whole series, unlimited.
 */
export function defaultTrendRange(points: readonly TrendPoint[], today: DateString): TrendRange {
  const shown = Math.min(TREND_SESSION_LIMIT, points.length);
  return TREND_RANGES.find((r) => inTrendRange(points, r, today).length >= shown) ?? 'all';
}

/**
 * The direction of travel ACROSS a range: the latest home session in it
 * against the mean of the first up-to-{@link TREND_WINDOW} home sessions in
 * it. Null with fewer than two home sessions.
 *
 * The same arithmetic as {@link trendOf}, with the baseline taken from the far
 * end of the range instead of from just behind the latest session — the
 * question a range asks is "where has this gone over three months?".
 *
 * It is exercise detail's SECOND direction line. The first is the Train hub's
 * own figure ({@link trendOf}, momentum: the latest against the three before
 * it), so the row the owner tapped and the screen it opens say the same thing
 * first, whatever chip is selected. This line is drawn under it only when its
 * baseline is different sessions ({@link trendView}): when the range holds
 * exactly the latest home session and the ones the first line compared it
 * with, the two are one figure and this line would only repeat it.
 */
export function rangeTrendOf(points: readonly TrendPoint[]): Trend | null {
  const home = points.filter((p) => p.away !== true);
  if (home.length < 2) return null;
  return compareTrend(
    home[home.length - 1]!.value,
    home.slice(0, Math.min(TREND_WINDOW, home.length - 1))
  );
}

function rangeBaselineParts(trend: Trend, range: TrendRange): PhrasePart[] {
  const first: PhrasePart[] =
    trend.compared === 1
      ? [{ text: 'the first session' }]
      : [{ text: 'the first ' }, { text: `${trend.compared} sessions`, measured: true }];
  return [...first, { text: range === 'all' ? ' on record' : ` of ${TREND_RANGE_WORDS[range]}` }];
}

/**
 * A range's direction as a phrase that names the range it measured:
 * "`+12%` on the first `3 sessions` of the last 3 months", "level with the
 * first session of the last month", "`+30%` on the first `3 sessions` on
 * record". Figures marked, as in {@link trendPhraseParts}.
 */
export function rangeTrendPhraseParts(trend: Trend, range: TrendRange): PhrasePart[] {
  const against = rangeBaselineParts(trend, range);
  if (trend.direction === 'level') return [{ text: 'level with ' }, ...against];
  return [{ text: trendToken(trend), measured: true }, { text: ' on ' }, ...against];
}

/** The same, as one string; `spoken` says it in words for VoiceOver. */
export function rangeTrendPhrase(
  trend: Trend,
  range: TrendRange,
  options: { spoken?: boolean } = {}
): string {
  if (options.spoken && trend.direction !== 'level') {
    const pct = Math.round(Math.abs(trend.changePct));
    return `${trend.direction} ${pct} percent on ${phraseText(rangeBaselineParts(trend, range))}`;
  }
  return phraseText(rangeTrendPhraseParts(trend, range));
}

/**
 * Why a range has nothing to draw. When the movement has two sessions to plot
 * but this range holds fewer, the range is the reason and the note says so;
 * otherwise the metric is, and {@link trendEmptyNote} says what is missing.
 */
export function trendRangeEmptyNote(
  metric: TrendMetric,
  rows: readonly RecordRow[],
  range: TrendRange,
  today: DateString
): string {
  const all = sessionSeriesFrom(rows, metric, Number.POSITIVE_INFINITY);
  const inRange = inTrendRange(all, range, today).length;
  if (range === 'all' || all.length < 2 || inRange >= 2) return trendEmptyNote(metric, rows);
  return inRange === 0
    ? `Nothing to plot in ${TREND_RANGE_WORDS[range]}. Choose a longer range.`
    : `One session to plot in ${TREND_RANGE_WORDS[range]}; a trend needs two. Choose a longer range.`;
}

/**
 * A day on the extent line: the hub's day column, with the year added when it
 * is not this year's — a 1Y or All chart reaches back past January.
 */
function extentDay(date: DateString, today: DateString): string {
  const label = dayLabel(date, today);
  return date.slice(0, 4) !== today.slice(0, 4) && /\d/.test(label)
    ? `${label} ${date.slice(0, 4)}`
    : label;
}

/** "Jul 3 – Today · 11 sessions" — what the chart spans. Null under two points. */
export function trendExtent(series: readonly TrendPoint[], today: DateString): string | null {
  if (series.length < 2) return null;
  const first = extentDay(series[0]!.date, today);
  const last = extentDay(series[series.length - 1]!.date, today);
  return `${first} – ${last} · ${series.length} sessions`;
}

/** Everything exercise detail's Trend draws — each figure computed here, none in the screen. */
export type TrendView = {
  /** The metric chips, in order; the screen draws them when there are two. */
  metrics: TrendMetric[];
  metric: TrendMetric;
  range: TrendRange;
  /**
   * The range chips: all four when the movement has two sessions of this
   * metric to plot at all, none otherwise — with nothing to draw in any range
   * there is nothing to narrow, and the note says what is missing.
   */
  ranges: readonly TrendRange[];
  /** The points drawn, oldest → newest. */
  series: TrendPoint[];
  /**
   * The FIRST direction line: the Train hub's own figure for this metric
   * ({@link trendOf}, the latest home session against the three before it) —
   * the same on every range chip. Null when nothing is drawn, or when the
   * session it is read from is not on the chart (a range holding only away
   * sessions).
   */
  trend: Trend | null;
  /**
   * The SECOND line: the change across the range ({@link rangeTrendOf}). Null
   * when it would be the first line again — its baseline the same sessions —
   * or when the range has no direction.
   */
  rangeTrend: Trend | null;
  headline: { value: number; label: string } | null;
  /** The first line with its figures marked ("+6% on the previous 3 sessions"), and as VoiceOver says it. */
  phrase: PhrasePart[] | null;
  spoken: string | null;
  /** The second line, naming its range ("+19% on the first 3 sessions on record"), and spoken. */
  rangePhrase: PhrasePart[] | null;
  rangeSpoken: string | null;
  extent: string | null;
  /** Why nothing is drawn, when nothing is. */
  emptyNote: string | null;
  /** A hollow point is on the chart, so the key under it is drawn. */
  away: boolean;
};

/**
 * Exercise detail's Trend, whole. `choice` is what the owner picked, each null
 * until he picks: the metric then defaults to {@link defaultTrendMetric} (the
 * Train hub's arrow opens on the chart it was read from) and the range to
 * {@link defaultTrendRange} for that metric's series. A picked range survives
 * a change of metric. Null for a movement with nothing to trend.
 *
 * **Two direction lines, and why** (review, 2026-09-25). The first is the hub
 * row's figure: `trendOf` over `sessionSeriesFrom(rows, metric)`, exactly what
 * {@link directionOf} computes, so the "−8%" the owner tapped is the first
 * thing the screen says under the chart, on every chip. The second is the
 * change across the chosen range, naming it. The two answer different
 * questions and can point opposite ways — latest against the last three,
 * latest against where the range began — which is why neither replaces the
 * other. The second is left out when its baseline is the first line's own
 * sessions: the range then holds exactly the latest home session and the
 * `compared` home sessions before it, and the figure would be repeated.
 */
export function trendView(
  rows: readonly RecordRow[],
  measures: Measures,
  basis: LoadBasis | null,
  choice: { metric: TrendMetric | null; range: TrendRange | null },
  today: DateString
): TrendView | null {
  const metrics = trendMetricsFor(measures, basis);
  const metric =
    choice.metric != null && metrics.includes(choice.metric)
      ? choice.metric
      : defaultTrendMetric(rows, measures, basis);
  if (metric == null) return null;
  const all = sessionSeriesFrom(rows, metric, Number.POSITIVE_INFINITY);
  const range = choice.range ?? defaultTrendRange(all, today);
  const series = inTrendRange(all, range, today);
  const drawn = series.length >= 2;
  const homeInRange = series.filter((p) => p.away !== true).length;
  // The hub's figure, as `directionOf` computes it. Its latest session is the
  // latest home session on record, which is on the chart exactly when the
  // range holds any home session; otherwise the line would describe a session
  // the chart does not show, and the headline could not be the one it reads.
  const trend = drawn && homeInRange > 0 ? trendOf(sessionSeriesFrom(rows, metric)) : null;
  const across = drawn ? rangeTrendOf(series) : null;
  // A range's home sessions are the latest ones on record, so its baseline is
  // the first line's exactly when it holds the latest plus the `compared`
  // before it.
  const rangeTrend = across && !(trend && homeInRange === trend.compared + 1) ? across : null;
  return {
    metrics,
    metric,
    range,
    ranges: all.length >= 2 ? TREND_RANGES : [],
    series,
    trend,
    rangeTrend,
    headline: drawn ? trendHeadline(series, trend ?? across) : null,
    phrase: trend ? trendPhraseParts(trend) : null,
    spoken: trend ? trendPhrase(trend, { spoken: true }) : null,
    rangePhrase: rangeTrend ? rangeTrendPhraseParts(rangeTrend, range) : null,
    rangeSpoken: rangeTrend ? rangeTrendPhrase(rangeTrend, range, { spoken: true }) : null,
    extent: trendExtent(series, today),
    emptyNote: drawn ? null : trendRangeEmptyNote(metric, rows, range, today),
    away: drawn && series.some((p) => p.away === true),
  };
}
