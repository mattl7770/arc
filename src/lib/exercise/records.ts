/**
 * Records, trends and the PR rule for one movement — pure, DB-free, offline.
 *
 * Owner, on the device, 2026-09-23: *"trends, prs, etc for exercises (i.e.
 * fitbod)"*. Everything a screen prints about how a lift is going is computed
 * here from the logged sets and nowhere else: the records grid, best at each
 * rep count, the per-session trend and its direction of travel, the PR stamp in
 * the live logger, and the PR mark in the history. The live stamp and the
 * history mark are the SAME rule ({@link kindsBeating}), so a set stamped PR in
 * the gym is the session marked PR afterwards.
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
 *    Assisted movements set no load records at all — a higher figure is an
 *    easier set ({@link loadRecordsApply}).
 */
import { PACE_PR_MIN_M } from './constants';
import { e1rmForSet } from './e1rm';
import {
  formatClock,
  formatDistance,
  formatWeight,
  parseClock,
  toCanonicalKg,
  toCanonicalMetres,
} from './format';
import { loadRecordsApply, type LoadBasis } from './load-basis';
import { hasMeasure, isLoadedRepsMeasures, maskByMeasures, type Measures } from './measures';
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
 * Best pace keeps its 0046 rule: pieces of at least {@link PACE_PR_MIN_M} only,
 * so a sprint cannot own the record for every distance.
 */
export function personalRecordsOf(rows: readonly RecordRow[]): PersonalRecords {
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
  const maxOf = (m: Map<string, number>): number | null =>
    m.size === 0 ? null : Math.max(...m.values());
  return {
    maxWeightKg,
    bestE1rmKg,
    bestSetVolumeKg,
    bestSessionVolumeKg: maxOf(sessionVolume),
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
 * Home sessions only; loaded sets of 1–{@link REP_MAX_CAP} reps only.
 */
export function repMaxesFrom(rows: readonly RecordRow[]): RepMax[] {
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

// ---------------------------------------------------------------------------
// The PR rule — live stamp and history mark alike
// ---------------------------------------------------------------------------

/** Which record a set beat. */
export type RecordKind = 'e1rm' | 'weight' | 'rep_max' | 'reps' | 'duration' | 'distance' | 'pace';

/** Display order, and the vocabulary a draft may carry. */
export const RECORD_KINDS: readonly RecordKind[] = [
  'e1rm',
  'weight',
  'rep_max',
  'reps',
  'duration',
  'distance',
  'pace',
];

/** The running bests one set is measured against. */
type Bars = {
  e1rm: number | null;
  weight: number | null;
  repMax: Map<number, number>;
  reps: number | null;
  duration: number | null;
  distance: number | null;
  pace: number | null;
};

const emptyBars = (): Bars => ({
  e1rm: null,
  weight: null,
  repMax: new Map(),
  reps: null,
  duration: null,
  distance: null,
  pace: null,
});

const higher = (a: number | null, b: number | null): number | null =>
  a == null ? b : b == null ? a : Math.max(a, b);

function paceOf(set: CandidateSet): number | null {
  const dur = positive(set.durationSec);
  const dist = positive(set.distanceM);
  if (dur == null || dist == null || dist < PACE_PR_MIN_M) return null;
  return dur / (dist / 1000);
}

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
  bars.reps = higher(bars.reps, positive(set.reps));
  bars.duration = higher(bars.duration, positive(set.durationSec));
  bars.distance = higher(bars.distance, positive(set.distanceM));
  const pace = paceOf(set);
  if (pace != null && (bars.pace == null || pace < bars.pace)) bars.pace = pace;
}

function barsOf(sets: readonly CandidateSet[]): Bars {
  const bars = emptyBars();
  for (const s of sets) fold(bars, s);
  return bars;
}

/**
 * Which records `set` beats, against `prior` (the bests before this session)
 * and `session` (the bests of the OTHER sets already done in it).
 *
 * A kind is only in play when `prior` has a value for it — rule 2 in the module
 * note — and a set must clear both bars, so the second of two record sets in
 * one session stamps only if it beats the first. Which kinds exist for a
 * movement is decided by what it measures and its load basis:
 *
 *   e1rm, weight, rep_max   reps + load, and not an assisted movement
 *   reps                    a set with no load on a movement whose load is
 *                           optional or absent — a push-up, an unweighted
 *                           pull-up. Never a loaded lift with the weight left
 *                           blank, which would be a typo scoring a record.
 *   duration, distance      the movement records it
 *   pace                    time and distance, over at least PACE_PR_MIN_M
 */
function kindsBeating(
  raw: CandidateSet,
  prior: Bars,
  session: Bars,
  ctx: RecordContext
): RecordKind[] {
  if (raw.setType === 'warmup') return [];
  const masked = maskByMeasures(ctx.measures, raw);
  const set: CandidateSet = { ...raw, ...masked };
  const beats = (value: number | null, before: number | null, mine: number | null): boolean =>
    value != null && before != null && value > before + EPS && (mine == null || value > mine + EPS);
  const kinds: RecordKind[] = [];

  const loadOk = hasMeasure(ctx.measures, 'load') && loadRecordsApply(ctx.basis);
  const weight = positive(set.weightKg);
  if (loadOk && isLoadedRepsMeasures(ctx.measures)) {
    const e = e1rmForSet(set.weightKg, set.reps, set.rpe, set.setType);
    if (beats(e, prior.e1rm, session.e1rm)) kinds.push('e1rm');
  }
  if (loadOk && beats(weight, prior.weight, session.weight)) kinds.push('weight');
  if (loadOk && weight != null && set.reps != null) {
    const reps = Math.round(set.reps);
    if (reps >= 1 && reps <= REP_MAX_CAP) {
      const before = prior.repMax.get(reps) ?? null;
      if (beats(weight, before, session.repMax.get(reps) ?? null)) kinds.push('rep_max');
    }
  }
  const bodyweightReps =
    hasMeasure(ctx.measures, 'reps') &&
    weight == null &&
    (!hasMeasure(ctx.measures, 'load') || ctx.basis === 'bodyweight_plus');
  if (bodyweightReps && beats(positive(set.reps), prior.reps, session.reps)) kinds.push('reps');
  if (
    hasMeasure(ctx.measures, 'time') &&
    beats(positive(set.durationSec), prior.duration, session.duration)
  ) {
    kinds.push('duration');
  }
  if (
    hasMeasure(ctx.measures, 'distance') &&
    beats(positive(set.distanceM), prior.distance, session.distance)
  ) {
    kinds.push('distance');
  }
  const pace = paceOf(set);
  if (
    pace != null &&
    prior.pace != null &&
    pace < prior.pace - EPS &&
    (session.pace == null || pace < session.pace - EPS)
  ) {
    kinds.push('pace');
  }
  return kinds;
}

/**
 * The live PR stamp: which records a just-completed set beats.
 *
 * `history` is `workingSets` for the movement — the logged sessions, which by
 * construction do not include this one (the live session is a draft until
 * Finish, 0045). `session` is the other sets already marked done in this
 * block. **An away session stamps nothing** (0055) — the rule lives here rather
 * than at the call site, so no future caller can award an away PR by
 * forgetting to ask.
 */
export function recordsBeaten(
  set: CandidateSet,
  history: readonly RecordRow[],
  session: readonly CandidateSet[],
  ctx: RecordContext & { away: boolean }
): RecordKind[] {
  if (ctx.away) return [];
  return kindsBeating(set, barsOf(baselineRows(history).map(candidateOf)), barsOf(session), ctx);
}

/**
 * The sessions that set at least one record at the time they were logged —
 * the PR mark in the detail screen's history. Walks the home sessions oldest
 * first, asks each set the live stamp's own question against everything before
 * its session, then folds the session in. Away sessions are neither marked nor
 * folded. Returns workout ids.
 */
export function recordSessionIds(rows: readonly RecordRow[], ctx: RecordContext): Set<string> {
  const sessions: { id: string; sets: CandidateSet[] }[] = [];
  const byId = new Map<string, CandidateSet[]>();
  // rows arrive newest-first; first appearance order, reversed, is oldest-first.
  for (const r of baselineRows(rows)) {
    let sets = byId.get(r.workout_id);
    if (!sets) {
      sets = [];
      byId.set(r.workout_id, sets);
      sessions.push({ id: r.workout_id, sets });
    }
    sets.push(candidateOf(r));
  }
  sessions.reverse();
  const bars = emptyBars();
  const none = emptyBars();
  const marked = new Set<string>();
  for (const s of sessions) {
    if (s.sets.some((set) => kindsBeating(set, bars, none, ctx).length > 0)) marked.add(s.id);
    for (const set of s.sets) fold(bars, set);
  }
  return marked;
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

/** How one record reads in a line: "best e1RM", "best at 5 reps". */
export function recordKindLabel(kind: RecordKind, reps: number | null): string {
  switch (kind) {
    case 'e1rm':
      return 'best e1RM';
    case 'weight':
      return 'heaviest';
    case 'rep_max':
      return reps === 1 ? 'best single' : `best at ${reps ?? '—'} reps`;
    case 'reps':
      return 'most reps';
    case 'duration':
      return 'longest';
    case 'distance':
      return 'farthest';
    case 'pace':
      return 'fastest pace';
  }
}

/**
 * The live logger's PR line for one block: "Set 3: best e1RM, heaviest ·
 * Set 4: best at 5 reps", or null when nothing was beaten.
 *
 * `rep_max` is dropped from a set that is also the heaviest ever: the heaviest
 * set on record is necessarily the best at its own rep count, and saying both
 * is one fact twice.
 */
export function prSummary(
  sets: readonly { index: number; reps: number | null; kinds: readonly RecordKind[] }[]
): string | null {
  const parts = sets
    .filter((s) => s.kinds.length > 0)
    .map((s) => {
      const kinds = RECORD_KINDS.filter(
        (k) => s.kinds.includes(k) && !(k === 'rep_max' && s.kinds.includes('weight'))
      );
      return `Set ${s.index}: ${kinds.map((k) => recordKindLabel(k, s.reps)).join(', ')}`;
    });
  return parts.length > 0 ? parts.join(' · ') : null;
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

/**
 * The one value per session the Train hub's direction of travel is read from,
 * or null when there is no honest single direction.
 *
 * Anything that covers distance gets none: whether a run is "better" as longer
 * or as faster depends on what the run was for, and an arrow cannot say which.
 */
export function primaryTrendMetric(
  measures: Measures,
  basis: LoadBasis | null
): TrendMetric | null {
  if (hasMeasure(measures, 'distance')) return null;
  return trendMetricsFor(measures, basis)[0] ?? null;
}

/**
 * One point per SESSION (workout), oldest → newest, the most recent `limit`.
 * A session with no value for the metric (every set blank) is absent, not zero.
 * Away sessions are kept and marked (0055).
 */
export function sessionSeriesFrom(
  rows: readonly RecordRow[],
  metric: TrendMetric,
  limit = 24
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
  const latest = home[home.length - 1]!;
  const prior = home.slice(-1 - TREND_WINDOW, -1);
  const baseline = prior.reduce((a, p) => a + p.value, 0) / prior.length;
  if (!(baseline > 0)) return null;
  const changePct = ((latest.value - baseline) / baseline) * 100;
  const direction = Math.abs(changePct) < TREND_LEVEL_PCT ? 'level' : changePct > 0 ? 'up' : 'down';
  return { direction, changePct, latest: latest.value, baseline, compared: prior.length };
}

/** "+4%", "−3%" or "level" — the Train hub's direction token (mono). */
export function trendToken(trend: Trend): string {
  if (trend.direction === 'level') return 'level';
  const pct = Math.round(Math.abs(trend.changePct));
  return `${trend.direction === 'up' ? '+' : '−'}${pct}%`;
}

/**
 * The same, as a phrase: "+4% on the previous 3 sessions", "level with the
 * previous session". `spoken` says it in words for VoiceOver.
 */
export function trendPhrase(trend: Trend, options: { spoken?: boolean } = {}): string {
  const against =
    trend.compared === 1 ? 'the previous session' : `the previous ${trend.compared} sessions`;
  if (trend.direction === 'level') return `level with ${against}`;
  const pct = Math.round(Math.abs(trend.changePct));
  if (options.spoken) return `${trend.direction} ${pct} percent on ${against}`;
  return `${trendToken(trend)} on ${against}`;
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
