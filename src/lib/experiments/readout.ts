/**
 * The experiment readout — the numbers an n-of-1 verdict stands on, computed
 * once, deterministically, so the Coach stops rebuilding them by hand
 * (docs/spikes/chief-of-staff-release.md §2, Track 2 item 4; docs/ai-coach.md §6).
 *
 * For one experiment it states:
 *
 *   - **Two windows of equal length.** The intervention window is the
 *     experiment's own `start_date … end_date` (clipped at today while it
 *     runs); the baseline is the same number of days immediately before
 *     `start_date`. Equal length because the comparison is "this fortnight
 *     against the fortnight before it", not "this fortnight against whatever
 *     history happens to exist".
 *   - **Per watched metric**, both windows' n, mean and SD, the difference, and
 *     the SAME two bars insights.ts fires on: `compareWindows` (practical
 *     percentage AND Welch's t) at the `TREND_GATES` bar for that metric, with
 *     t, df and the critical value from `welchT` — the one implementation the
 *     gate itself uses, so the reported test cannot disagree with the gate.
 *   - **Excluded days**, through `baselineExclusionsIn` — the app's one list of
 *     "days that get no vote on what normal looks like" (status days, the day
 *     the timezone moved, days lived away). A day a status covers is evidence
 *     of the status, not of the intervention, so it leaves BOTH windows.
 *   - **Adherence** of the intervention's own mission row, day by day, with the
 *     days `excusedDatesIn` forgives held out of the denominator — the adherence
 *     ledger's one definition, not a second copy of it.
 *   - **`verdictReady`**, and when it is false, every reason in words.
 *
 * ## It never says what the numbers mean
 *
 * There is no "supported", "worked" or "no effect" anywhere in this file, by
 * rule: judgment lives in the model (memory: coach-judgment-not-rules). A gate
 * met is a fact about two windows of readings; whether it answers the
 * hypothesis — regression to the mean, a confound the user mentioned in chat,
 * a success criterion stated in other terms — is the Coach's call, every time.
 * `verdictReady` says only that the inputs are complete enough to judge.
 *
 * Pure over the {@link Database} interface; the arithmetic is the pure
 * {@link computeReadout}. Headless-tested in db/experiment-readout.test.mjs.
 */
import type { Database } from '@/lib/db/database';
import { shiftISODate, todayISODate } from '@/lib/db/date';
import { daysBetweenISO } from '@/lib/ai/series';
import { compareWindows, stdev, welchT } from '@/lib/ai/stats';
import { TREND_GATES } from '@/lib/ai/insights';
import { readMetricDays, type MetricDays } from '@/lib/ai/metric-catalog';
import type { Experiment } from '@/lib/db/repositories/experiments';
import { excusedDatesIn, NOT_CARRIED_SQL, PLANNED_ROW_SQL } from '@/lib/db/repositories/mission';
import { getPreferences } from '@/lib/db/repositories/user';
import { baselineExclusionsIn, type BaselineExclusionSource } from '@/lib/home/baseline-exclusions';

/** Below this share of owed days done, a readout cannot tell "it didn't work" from "it wasn't done". */
export const ADHERENCE_FLOOR = 0.8;
/** Below this share of usable days carrying a reading, a window is mostly missing data. */
export const COVERAGE_FLOOR = 0.6;

/** A watched metric with no `TREND_GATES` entry: the engine's general floor and a modest bar. */
const DEFAULT_GATE = { thresholdPct: 5, minPerWindow: 3 } as const;

/** Resolved series name → its `TREND_GATES` key (keyed by domain slug, not metric_type). */
const GATE_KEYS: Record<string, keyof typeof TREND_GATES> = {
  hrv: 'hrv',
  rhr: 'rhr',
  weight: 'weight',
  steps: 'steps',
  active_energy_kcal: 'active_energy',
  resting_energy_kcal: 'resting_energy',
  sleep_duration_min: 'sleep',
};

export type ReadoutWindow = {
  from: string;
  to: string;
  /** Calendar days in the window (0 when an experiment has not started). */
  days: number;
  /** Of those, the days {@link baselineExclusionsIn} bars. */
  excluded: number;
};

export type WindowStats = { n: number; mean: number | null; sd: number | null };

export type MetricReadout =
  | {
      /** The watched name as written on the experiment. */
      metric: string;
      readable: false;
    }
  | {
      metric: string;
      readable: true;
      /** The series it resolved to — what get_metric_series calls it. */
      series: string;
      label: string;
      unit: string;
      baseline: WindowStats;
      intervention: WindowStats;
      /** intervention mean − baseline mean, display units. Null without both means. */
      diff: number | null;
      changePct: number | null;
      /** Welch's t, its df and the α = 0.05 bar. Null below two readings a side or at zero variance. */
      welch: { t: number; df: number; critical: number } | null;
      /** The bars this metric is held to — the engine's own for it. */
      bar: { pct: number; minPerWindow: number };
      /** Both bars cleared; null when there are too few readings to test at all. */
      gateMet: boolean | null;
      /** Usable days (window days − excluded − a still-accumulating today) per side. */
      usable: { baseline: number; intervention: number };
      /** True when today's running total was held out (an accumulating metric, mid-window). */
      todayHeldOut?: true;
    };

export type AdherenceReadout = {
  /** Days from start to the last day counted (today, or end_date once closed). */
  days: number;
  done: number;
  partial: number;
  skipped: number;
  /** A row stood on the day and was never marked. */
  untouched: number;
  /** The user removed the intervention from the day. */
  removed: number;
  /** No intervention row on the day at all (the mission was never generated, or predates it). */
  noRow: number;
  /** Forgiven by an excusing status / mode / timezone change — out of the denominator. */
  excused: number;
  /** Today, still pending — not yet a decision, so out of the denominator too. */
  open: number;
  /** days − excused − open. */
  owed: number;
  /** done ÷ owed; null when nothing was owed. */
  rate: number | null;
};

export type ExperimentReadout = {
  /** Shape version, so a snapshot stored with a verdict stays readable. */
  v: 1;
  /** The day these numbers were computed. */
  asOf: string;
  windowClosed: boolean;
  baseline: ReadoutWindow;
  intervention: ReadoutWindow;
  /** Excluded days across both windows, by reason (non-zero sources only). */
  excludedBy: Partial<Record<BaselineExclusionSource, number>>;
  excludedDates: string[];
  adherence: AdherenceReadout;
  metrics: MetricReadout[];
  verdictReady: boolean;
  /** Every reason `verdictReady` is false, in words. Empty when it is true. */
  notReady: string[];
};

/** One day of the intervention's mission rows, folded. */
export type AdherenceDayState =
  'done' | 'partial' | 'skipped' | 'untouched' | 'removed' | 'noRow' | 'excused' | 'open';

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r1 = (v: number): number => Math.round(v * 10) / 10;
const pct = (v: number): string => `${Math.round(v * 100)}%`;
const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** The two windows. Pure date arithmetic. */
export function readoutWindows(
  startDate: string,
  endDate: string,
  today: string
): {
  baseline: { from: string; to: string; days: number };
  intervention: { from: string; to: string; days: number };
} {
  const length = daysBetweenISO(startDate, endDate) + 1;
  const to = endDate < today ? endDate : today;
  return {
    baseline: {
      from: shiftISODate(startDate, -length),
      to: shiftISODate(startDate, -1),
      days: length,
    },
    intervention: {
      from: startDate,
      to,
      days: to < startDate ? 0 : daysBetweenISO(startDate, to) + 1,
    },
  };
}

/**
 * Fold one day's intervention rows into one state. Precedence is "what did he
 * do": a completion anywhere on the day wins, a removal counts only when every
 * row was removed (a tombstone is stored `skipped`, so it is checked first).
 */
export function foldAdherenceDay(
  rows: { status: string; removed: boolean }[],
  isToday: boolean,
  excused: boolean
): AdherenceDayState {
  const live = rows.filter((r) => !r.removed);
  let state: AdherenceDayState;
  if (live.some((r) => r.status === 'completed')) state = 'done';
  else if (live.some((r) => r.status === 'partial')) state = 'partial';
  else if (live.some((r) => r.status === 'skipped')) state = 'skipped';
  else if (live.length > 0) state = isToday ? 'open' : 'untouched';
  else if (rows.length > 0) state = 'removed';
  else state = isToday ? 'open' : 'noRow';
  // The ledger's rule: an excused day forgives what was not done, never
  // converts it into a completion, and never touches a day still open.
  if (excused && state !== 'done' && state !== 'partial' && state !== 'open') return 'excused';
  return state;
}

/** Tally folded days into the adherence block. */
export function summarizeAdherence(states: AdherenceDayState[]): AdherenceReadout {
  const count = (s: AdherenceDayState) => states.filter((x) => x === s).length;
  const excused = count('excused');
  const open = count('open');
  const done = count('done');
  const owed = states.length - excused - open;
  return {
    days: states.length,
    done,
    partial: count('partial'),
    skipped: count('skipped'),
    untouched: count('untouched'),
    removed: count('removed'),
    noRow: count('noRow'),
    excused,
    open,
    owed,
    rate: owed > 0 ? r2(done / owed) : null,
  };
}

export type ReadoutInput = {
  startDate: string;
  endDate: string;
  today: string;
  /** Each watched name and its days across baseline.from … intervention.to (null = unreadable). */
  metrics: { name: string; days: MetricDays | null }[];
  excludedDates: ReadonlySet<string>;
  excludedBy: ReadonlyMap<BaselineExclusionSource, ReadonlySet<string>>;
  adherence: AdherenceReadout;
};

/** The readout from already-read inputs. Pure: no database, no clock. */
export function computeReadout(input: ReadoutInput): ExperimentReadout {
  const { startDate, endDate, today } = input;
  const windows = readoutWindows(startDate, endDate, today);
  const inWindow = (date: string, w: { from: string; to: string }) =>
    date >= w.from && date <= w.to;
  const excludedIn = (w: { from: string; to: string; days: number }) =>
    w.days === 0 ? 0 : [...input.excludedDates].filter((d) => inWindow(d, w)).length;

  const baseline: ReadoutWindow = { ...windows.baseline, excluded: excludedIn(windows.baseline) };
  const intervention: ReadoutWindow = {
    ...windows.intervention,
    excluded: excludedIn(windows.intervention),
  };
  const windowClosed = endDate < today;

  const metrics: MetricReadout[] = input.metrics.map(({ name, days }) => {
    if (!days) return { metric: name, readable: false };
    // A running total is not a finished day: held out exactly as
    // get_metric_series holds it out of `stats`.
    const holdToday =
      days.accumulating && inWindow(today, intervention) && !input.excludedDates.has(today);
    const usable = (p: { date: string }) =>
      !input.excludedDates.has(p.date) && !(holdToday && p.date === today);
    const base = days.points
      .filter((p) => inWindow(p.date, baseline) && usable(p))
      .map((p) => p.value);
    const intv =
      intervention.days === 0
        ? []
        : days.points
            .filter((p) => inWindow(p.date, intervention) && usable(p))
            .map((p) => p.value);
    const gate = GATE_KEYS[days.metric] ? TREND_GATES[GATE_KEYS[days.metric]!] : DEFAULT_GATE;
    const comparison = compareWindows(intv, base, gate.thresholdPct, gate.minPerWindow);
    const welch = welchT(intv, base);
    const baseMean = mean(base);
    const intvMean = mean(intv);
    const sd = (xs: number[]) => {
      const s = stdev(xs);
      return s === null ? null : r2(s);
    };
    return {
      metric: name,
      readable: true,
      series: days.metric,
      label: days.label,
      unit: days.unit,
      baseline: { n: base.length, mean: baseMean === null ? null : r2(baseMean), sd: sd(base) },
      intervention: { n: intv.length, mean: intvMean === null ? null : r2(intvMean), sd: sd(intv) },
      diff: baseMean === null || intvMean === null ? null : r2(intvMean - baseMean),
      changePct: comparison ? r1(comparison.changePct) : null,
      welch: welch ? { t: r2(welch.t), df: r1(welch.df), critical: welch.critical } : null,
      bar: { pct: gate.thresholdPct, minPerWindow: gate.minPerWindow },
      gateMet: comparison ? comparison.significant : null,
      usable: {
        baseline: baseline.days - baseline.excluded,
        intervention: intervention.days - intervention.excluded - (holdToday ? 1 : 0),
      },
      ...(holdToday ? { todayHeldOut: true as const } : {}),
    };
  });

  const notReady: string[] = [];
  if (today < startDate) {
    notReady.push(`It has not started; it begins ${startDate}.`);
  } else if (!windowClosed) {
    notReady.push(
      `The window is open: day ${intervention.days} of ${baseline.days}; it closes ${endDate}.`
    );
  }
  const a = input.adherence;
  if (a.rate === null) {
    if (today >= startDate) notReady.push('No settled day has owed the intervention yet.');
  } else if (a.rate < ADHERENCE_FLOOR) {
    notReady.push(
      `The intervention was done on ${a.done} of ${a.owed} owed days (${pct(a.rate)}), under the ${pct(ADHERENCE_FLOOR)} floor.`
    );
  }
  const readable = metrics.filter((m) => m.readable);
  if (readable.length === 0) {
    notReady.push(
      'None of the watched metrics is a series ARC records, so there are no numbers to compare.'
    );
  }
  for (const m of readable) {
    if (!m.readable) continue;
    if (m.baseline.n < m.bar.minPerWindow || m.intervention.n < m.bar.minPerWindow) {
      notReady.push(
        `${m.label}: ${m.baseline.n} baseline and ${m.intervention.n} intervention readings; ${m.bar.minPerWindow} a side are needed.`
      );
      continue;
    }
    for (const side of ['baseline', 'intervention'] as const) {
      const usableDays = m.usable[side];
      const n = m[side].n;
      if (usableDays <= 0 || n / usableDays < COVERAGE_FLOOR) {
        notReady.push(
          `${m.label}: readings on ${n} of ${usableDays} usable ${side} days, under the ${pct(COVERAGE_FLOOR)} floor.`
        );
      }
    }
  }

  const excludedBy: Partial<Record<BaselineExclusionSource, number>> = {};
  for (const [source, dates] of input.excludedBy) {
    if (dates.size > 0) excludedBy[source] = dates.size;
  }

  return {
    v: 1,
    asOf: today,
    windowClosed,
    baseline,
    intervention,
    excludedBy,
    excludedDates: [...input.excludedDates].sort(),
    adherence: input.adherence,
    metrics,
    verdictReady: notReady.length === 0,
    notReady,
  };
}

/** The intervention's mission rows, folded per day over `from … to`. */
function adherenceStates(
  db: Database,
  experimentId: string,
  from: string,
  to: string,
  today: string
): AdherenceDayState[] {
  if (to < from) return [];
  // The ledger's predicates, verbatim: an ad-hoc capture is not the
  // intervention, and a carried copy is a reminder of an older day, not a new
  // obligation. Tombstones are deliberately KEPT (unlike the ledger, which
  // reads a removed row as never owed): an intervention taken off the day is
  // the most direct statement there is that it was not done that day.
  const rows = db.all<{ date: string; status: string; removed: number | null }>(
    `SELECT d.date AS date, e.status AS status, json_extract(e.value, '$.removed') AS removed
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE json_extract(e.value, '$.experiment') = ?
        AND d.date >= ? AND d.date <= ?
        AND ${PLANNED_ROW_SQL}
        AND ${NOT_CARRIED_SQL}`,
    [experimentId, from, to]
  );
  const byDate = new Map<string, { status: string; removed: boolean }[]>();
  for (const row of rows) {
    const list = byDate.get(row.date) ?? [];
    list.push({ status: row.status, removed: row.removed != null && row.removed !== 0 });
    byDate.set(row.date, list);
  }
  const excused = excusedDatesIn(db, from, to);
  const states: AdherenceDayState[] = [];
  for (let date = from; date <= to; date = shiftISODate(date, 1)) {
    states.push(foldAdherenceDay(byDate.get(date) ?? [], date === today, excused.has(date)));
  }
  return states;
}

/** The readout for one experiment, as of `now`. */
export function experimentReadout(
  db: Database,
  experiment: Pick<Experiment, 'id' | 'start_date' | 'end_date' | 'metrics'>,
  now: Date = new Date()
): ExperimentReadout {
  const today = todayISODate(now);
  const { baseline, intervention } = readoutWindows(
    experiment.start_date,
    experiment.end_date,
    today
  );
  const spanTo = intervention.days > 0 ? intervention.to : baseline.to;
  const units = getPreferences(db).units;
  const exclusions = baselineExclusionsIn(db, baseline.from, spanTo, today);
  return computeReadout({
    startDate: experiment.start_date,
    endDate: experiment.end_date,
    today,
    metrics: experiment.metrics.map((name) => ({
      name,
      days: readMetricDays(db, name, baseline.from, spanTo, units),
    })),
    excludedDates: exclusions.days,
    excludedBy: exclusions.bySource,
    adherence: summarizeAdherence(
      intervention.days > 0
        ? adherenceStates(db, experiment.id, intervention.from, intervention.to, today)
        : []
    ),
  });
}

// --- The snapshot stored with a verdict ---------------------------------------

/**
 * The line that opens the stored readout inside `outcome_notes`. That column
 * is the readout by its own migration comment (0027: "how the watched metrics
 * moved"), so the numbers go there rather than into a new column — no
 * migration — behind a marker no prose would carry, with the Coach's words
 * kept in front of it.
 */
export const READOUT_MARKER = '[ARC readout at conclusion]';

/** `notes` with the readout appended after the marker. */
export function attachReadoutNotes(notes: string | null, readout: ExperimentReadout): string {
  const prose = notes?.trim() ?? '';
  return `${prose.length > 0 ? `${prose}\n\n` : ''}${READOUT_MARKER}\n${JSON.stringify(readout)}`;
}

/** Split stored `outcome_notes` back into the Coach's words and the stored readout. */
export function splitReadoutNotes(text: string | null): {
  notes: string | null;
  readout: ExperimentReadout | null;
} {
  if (!text) return { notes: null, readout: null };
  const at = text.lastIndexOf(READOUT_MARKER);
  if (at < 0 || (at > 0 && text[at - 1] !== '\n')) return { notes: text, readout: null };
  const prose = text.slice(0, at).trim();
  let readout: ExperimentReadout | null = null;
  try {
    const parsed: unknown = JSON.parse(text.slice(at + READOUT_MARKER.length));
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as { v?: unknown }).v === 1 &&
      Array.isArray((parsed as { metrics?: unknown }).metrics)
    ) {
      readout = parsed as ExperimentReadout;
    }
  } catch {
    readout = null;
  }
  // An unparseable tail is left in the notes rather than silently dropped.
  if (!readout) return { notes: text, readout: null };
  return { notes: prose.length > 0 ? prose : null, readout };
}
