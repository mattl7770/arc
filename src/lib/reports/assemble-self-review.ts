/**
 * The periodic self-review, assembled (docs/reports-subapp.md §3a).
 *
 * Pure over the {@link Database} interface — no React, no op-sqlite, no file
 * system, and the clock arrives as an argument — so the whole thing runs
 * headless against node:sqlite in db/reports.test.mjs, exactly like
 * db/export.test.mjs runs the serializer.
 *
 * ## This layer COMPOSES; it does not re-derive
 *
 * Every number here traces to a seam that already has its own test suite —
 * `trainingDailyTotals` / `muscleSetsInRange` / `e1rmSeries`,
 * `dailyIntakeSeries` / `activeNutritionTargets` / `metricIsComplete`,
 * `wearableArbitratedSeries` + `compareWindows` + `TREND_GATES`,
 * `bodyDailySeries`, `accountForDay`, `listExperiments`. Where a seam could
 * only answer for "this week" or "the last N days", it was GENERALISED in
 * place (`muscleSetsInRange`, and `weeklyMuscleSets` now calls it) rather than
 * copied here. A second definition of "sets worked" or "days logged" is how
 * two surfaces start disagreeing about the same week.
 *
 * ## Every honesty rule in §1 is a line of code here, not a copy convention
 *
 *   - **The ledger sums.** `completed + partial + skipped + excused + unmarked
 *     = planned`, per protocol and in the totals row. Asserted in the tests.
 *   - **Excused is decided per DAY, by the day's own mode**, through
 *     `accountForDay` — not by a period-wide flag.
 *   - **Nutrition averages exclude un-priced days and COUNT the exclusion.**
 *   - **A recovery delta prints a direction word only past `insights.ts`'s own
 *     bar.** Otherwise: "within your normal variation."
 *   - **Empty is authored.** Every section carries either rows or a written
 *     sentence, and the labs section is absent entirely rather than saying
 *     "no labs" every month.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import {
  daysBetweenISO,
  isoDatePlusDays,
  trainingDailyTotals,
  wearableArbitratedSeries,
  type SeriesPoint,
} from '@/lib/ai/series';
import { compareWindows } from '@/lib/ai/stats';
import { TREND_GATES } from '@/lib/ai/insights';
import { isAccumulatingMetric } from '@/lib/health/accumulating';
import { getActiveMode } from '@/lib/db/repositories/day-modes';
import { accountForDay, getModeDefinition, type ModeKey } from '@/lib/modes/registry';
import { e1rmSeries, muscleSetsInRange } from '@/lib/db/repositories/training-stats';
import {
  activeNutritionTargets,
  dailyIntakeSeries,
  listTodayMeals,
  partialMealMetrics,
} from '@/lib/db/repositories/nutrition';
import { metricIsComplete, sumRounded, type DayMetric } from '@/lib/nutrition/remaining';
import { listExperiments } from '@/lib/db/repositories/experiments';
import { getPreferences } from '@/lib/db/repositories/user';
import type { UnitPreferences } from '@/lib/user/types';

import {
  EM_DASH,
  average,
  count,
  joinList,
  minutes as fmtMinutes,
  namedThenCounted,
  num,
  pct,
  plural,
  signed,
} from './format';
import { accumulatingEnd, formatDate, formatDateLong, todayNote } from './period';
import {
  REPORT_DISCLAIMER,
  assembleBodyOver,
  assembleSymptoms,
  displayFor,
  toDisplay,
} from './sections';
import type {
  AdherenceRow,
  AdherenceSection,
  AssembleOptions,
  ChangeRow,
  ExperimentRow,
  ExperimentsSection,
  Figure,
  LabsInPeriodSection,
  MovementRow,
  MuscleVolumeRow,
  NutritionSection,
  Period,
  RecoveryRow,
  RecoverySection,
  SelfReviewData,
  TrainingSection,
  WhatChangedSection,
} from './types';

/** How many muscle groups the volume table shows, biggest first. */
const MUSCLE_ROWS = 8;

// --- 1. Coverage --------------------------------------------------------------

/**
 * Days in the period carrying at least one LOGGED entry.
 *
 * Deliberately excludes `wearable_data`: those rows arrive from Apple Health on
 * their own schedule, so counting them would mark every day of the period
 * "covered" the moment a phone with a step counter is in a pocket — which is
 * true of the data and false of the claim the line is making. The coverage
 * preamble exists to tell the reader how much of this report rests on the
 * user's own hand, and a synced step total is not a hand.
 */
function loggedDays(db: Database, period: Period): string[] {
  const p = [period.start, period.end];
  const rows = db.all<{ date: string }>(
    `SELECT DISTINCT date FROM (
       SELECT dl.date AS date FROM daily_logs dl
         JOIN log_entries le ON le.daily_log_id = dl.id
        WHERE dl.date >= ? AND dl.date <= ?
       UNION SELECT date FROM meals    WHERE date >= ? AND date <= ?
       UNION SELECT date FROM workouts WHERE date >= ? AND date <= ?
       UNION SELECT date FROM symptoms WHERE date >= ? AND date <= ?
       UNION SELECT substr(measured_at, 1, 10) AS date FROM body_metrics
        WHERE substr(measured_at, 1, 10) >= ? AND substr(measured_at, 1, 10) <= ?
     ) ORDER BY date`,
    [...p, ...p, ...p, ...p, ...p]
  );
  return rows.map((r) => r.date);
}

// --- 2. Adherence ledger ------------------------------------------------------

type StatusRow = {
  protocolId: string;
  protocolName: string;
  date: string;
  status: 'pending' | 'completed' | 'skipped' | 'partial';
  n: number;
};

/** An accumulator with the same five buckets the ledger prints. */
type Tally = {
  completed: number;
  partial: number;
  skipped: number;
  excused: number;
  unmarked: number;
};

const emptyTally = (): Tally => ({ completed: 0, partial: 0, skipped: 0, excused: 0, unmarked: 0 });

function tallyRow(name: string, t: Tally): AdherenceRow {
  const planned = t.completed + t.partial + t.skipped + t.excused + t.unmarked;
  // Accountable = everything the day still expected of you once the mode has
  // excused what it excuses. An all-excused protocol has no denominator, and
  // "0%" over nothing you were meant to do would be a lie in the other
  // direction — so the label is the em-dash and the prose says why.
  const accountable = planned - t.excused;
  return {
    protocolName: name,
    planned,
    completed: t.completed,
    partial: t.partial,
    skipped: t.skipped,
    excused: t.excused,
    unmarked: t.unmarked,
    completionLabel: accountable > 0 ? `${num((t.completed / accountable) * 100, 0)}%` : null,
  };
}

function assembleAdherence(
  db: Database,
  period: Period,
  accEnd: string,
  modeByDate: Map<string, ModeKey>
): AdherenceSection {
  const provenance = {
    sources: 'log_entries · protocols · day_modes',
    range: accEnd === period.end ? period.rangeLabel : `${period.rangeLabel} (complete days only)`,
  };
  // Clipped to `accEnd`, exactly like training minutes and days-logged.
  //
  // ADHERENCE IS AN ACCUMULATING METRIC, which is easy to miss because it is a
  // ledger rather than a total. A day's mission items start `pending` and are
  // answered through the day, so on a custom range that reaches today, today's
  // untouched 21:00 magnesium is not an unmarked MISS — it is an item whose day
  // has not finished. Counting it would score the user down for the hours they
  // have not lived yet, and would do it worst on the range someone is most
  // likely to generate ("how has this month gone so far"). `todayNote` states
  // the exclusion; this is where it happens.
  const rows =
    accEnd >= period.start
      ? db.all<StatusRow>(
          `SELECT le.protocol_id AS protocolId, p.name AS protocolName, dl.date AS date,
                  le.status AS status, count(*) AS n
           FROM log_entries le
           JOIN daily_logs dl ON dl.id = le.daily_log_id
           JOIN protocols p   ON p.id = le.protocol_id
           WHERE le.protocol_id IS NOT NULL AND dl.date >= ? AND dl.date <= ?
           GROUP BY le.protocol_id, dl.date, le.status
           ORDER BY p.name COLLATE NOCASE, dl.date`,
          [period.start, accEnd]
        )
      : [];

  if (rows.length === 0) {
    return {
      title: 'Adherence',
      // 2026-08-13 review fix: when the whole period clips away (a range of
      // just today), "no protocol was active" would be false the moment the
      // user has pending items on today's mission. Name the clip instead.
      empty:
        accEnd < period.start
          ? 'This period holds only today, and adherence is scored on complete days — a two-hour-old day is not a day. Check back tomorrow.'
          : 'No protocol was active this period — nothing was scheduled, so nothing is being scored.',
      provenance,
      rows: [],
      totals: null,
      modeNote: null,
      reconciliation: null,
    };
  }

  const byProtocol = new Map<string, { name: string; tally: Tally }>();
  const totals = emptyTally();
  for (const row of rows) {
    let entry = byProtocol.get(row.protocolId);
    if (!entry) {
      entry = { name: row.protocolName, tally: emptyTally() };
      byProtocol.set(row.protocolId, entry);
    }
    const t = entry.tally;
    if (row.status === 'completed') {
      t.completed += row.n;
      totals.completed += row.n;
    } else if (row.status === 'partial') {
      t.partial += row.n;
      totals.partial += row.n;
    } else if (row.status === 'pending') {
      t.unmarked += row.n;
      totals.unmarked += row.n;
    } else {
      // The one bucket the DAY decides, not the period: a skip under Sick,
      // Travel or Social is the right call and is excused; under Normal or
      // Deload it is a miss. `accountForDay` is the single definition of that
      // judgment (src/lib/modes/registry.ts) and Home already renders it.
      const mode = modeByDate.get(row.date) ?? 'normal';
      const accounting = accountForDay(mode, { skipped: row.n });
      t.excused += accounting.excused;
      t.skipped += accounting.missed;
      totals.excused += accounting.excused;
      totals.skipped += accounting.missed;
    }
  }

  const ledger = [...byProtocol.values()].map(({ name, tally }) => tallyRow(name, tally));
  const totalsRow = tallyRow('All protocols', totals);

  // The mode ledger beneath the table — named, counted, and only for the modes
  // that actually change how a skip is judged.
  const excusingCounts = new Map<ModeKey, number>();
  for (const [, mode] of modeByDate) {
    if (!getModeDefinition(mode).excusesSkips) continue;
    excusingCounts.set(mode, (excusingCounts.get(mode) ?? 0) + 1);
  }
  const modeNote =
    excusingCounts.size === 0
      ? null
      : `${joinList(
          [...excusingCounts.entries()].map(
            ([mode, days]) => `${plural(days, `${getModeDefinition(mode).label} day`)}`
          )
        )} — skips on those days are excused, not missed.`;

  return {
    title: 'Adherence',
    empty: null,
    provenance,
    rows: ledger,
    totals: totalsRow,
    modeNote,
    reconciliation:
      'Completed + partial + skipped + excused + unmarked equals planned, on every row. ' +
      'The percentage is completions over accountable items — planned minus excused. ' +
      'Unmarked items were never answered either way; they are counted against the ' +
      'period rather than assumed done or assumed skipped.',
  };
}

// --- 3. Training --------------------------------------------------------------

function assembleTraining(db: Database, period: Period, accEnd: string): TrainingSection {
  const provenance = {
    sources: 'workouts · workout_sets · exercise_muscles',
    range: accEnd === period.end ? period.rangeLabel : `${period.rangeLabel} (complete days only)`,
  };
  const inWindow = accEnd >= period.start;
  const days = inWindow ? trainingDailyTotals(db, period.start, accEnd) : [];
  const sessions = days.reduce((a, d) => a + d.sessions, 0);
  const totalMinutes = days.reduce((a, d) => a + d.minutes, 0);
  const setsRow = inWindow
    ? db.get<{ n: number }>(
        `SELECT count(*) AS n FROM workout_sets s
         JOIN workouts w ON w.id = s.workout_id
         WHERE s.set_type != 'warmup' AND w.date >= ? AND w.date <= ?`,
        [period.start, accEnd]
      )
    : undefined;
  const sets = setsRow?.n ?? 0;

  if (sessions === 0) {
    return {
      title: 'Training',
      empty: 'No sessions logged.',
      provenance,
      headline: [],
      muscles: [],
      musclesNote: null,
      movements: [],
      personalRecords: [],
    };
  }

  const headline: Figure[] = [
    {
      label: 'Sessions',
      value: count(sessions),
      unit: null,
      note: `${plural(days.length, 'day')} trained`,
    },
    { label: 'Time', value: fmtMinutes(totalMinutes), unit: null, note: null },
    { label: 'Working sets', value: count(sets), unit: null, note: 'warm-ups excluded' },
  ];

  // Volume by muscle, this window against the equal one before it.
  const current = muscleSetsInRange(db, period.start, accEnd);
  const prior = muscleSetsInRange(db, period.prior.start, period.prior.end);
  const priorByMuscle = new Map(prior.map((m) => [m.muscle, m.sets]));
  const muscles: MuscleVolumeRow[] = current
    .slice()
    .sort((a, b) => b.sets - a.sets || (a.muscle < b.muscle ? -1 : 1))
    .slice(0, MUSCLE_ROWS)
    .map((m) => {
      const before = priorByMuscle.get(m.muscle);
      return {
        muscle: m.muscle,
        sets: num(m.sets, 1),
        priorSets: before == null ? EM_DASH : num(before, 1),
        // No prior figure is not a delta of zero — it is no comparison at all.
        delta: before == null ? EM_DASH : signed(m.sets - before, 1),
      };
    });
  const musclesNote =
    prior.length === 0 && muscles.length > 0
      ? `Nothing was logged in the window before this one (${period.prior.rangeLabel}), so these have nothing to be compared against.`
      : null;

  // Movements trained at least twice in-period, and the estimated-1RM move
  // across those sessions. e1rmSeries is an ALL-TIME read per exercise; the
  // period is a filter over what it returns, never a second query.
  const trained = db.all<{ exerciseId: string; name: string; sessions: number }>(
    `SELECT s.exercise_id AS exerciseId, e.name AS name,
            count(DISTINCT w.date) AS sessions
     FROM workout_sets s
     JOIN workouts w  ON w.id = s.workout_id
     JOIN exercises e ON e.id = s.exercise_id
     WHERE s.exercise_id IS NOT NULL AND s.set_type != 'warmup'
       AND w.date >= ? AND w.date <= ?
     GROUP BY s.exercise_id
     HAVING count(DISTINCT w.date) >= 2
     ORDER BY e.name COLLATE NOCASE`,
    [period.start, accEnd]
  );

  const weightSpec = displayFor('weight', getPreferences(db).units);
  const movements: MovementRow[] = [];
  const personalRecords: string[] = [];
  for (const row of trained) {
    // A generous limit, then filter: `e1rmSeries` slices the most recent N
    // session dates before sorting, so the cap has to comfortably exceed any
    // real training history inside a one-year period.
    const series = e1rmSeries(db, row.exerciseId, 1000);
    const inPeriod = series.filter((p) => p.date >= period.start && p.date <= accEnd);
    if (inPeriod.length >= 2) {
      const first = inPeriod[0]!;
      const last = inPeriod[inPeriod.length - 1]!;
      const firstDisplay = weightSpec ? weightSpec.fromCanonical(first.e1rm) : first.e1rm;
      const lastDisplay = weightSpec ? weightSpec.fromCanonical(last.e1rm) : last.e1rm;
      movements.push({
        exercise: row.name,
        sessions: row.sessions,
        first: num(firstDisplay, 1),
        last: num(lastDisplay, 1),
        delta: signed(lastDisplay - firstDisplay, 1),
        unit: weightSpec?.unit ?? 'kg',
      });
    }
    // A personal record IS in-period when the all-time best was FIRST reached
    // inside it. "First" matters: repeating your best in August does not make
    // August the month you set it, and reporting it as one would quietly
    // manufacture a PR every time a lift is matched.
    if (series.length > 0) {
      const best = series.reduce((a, b) => (b.e1rm > a.e1rm ? b : a));
      const firstAchieved = series.find((p) => p.e1rm === best.e1rm)!;
      if (firstAchieved.date >= period.start && firstAchieved.date <= accEnd) {
        const display = weightSpec ? weightSpec.fromCanonical(best.e1rm) : best.e1rm;
        personalRecords.push(
          `${row.name} — ${num(display, 1)} ${weightSpec?.unit ?? 'kg'} estimated 1RM on ${formatDate(firstAchieved.date)}`
        );
      }
    }
  }

  return {
    title: 'Training',
    empty: null,
    provenance,
    headline,
    muscles,
    musclesNote,
    movements,
    personalRecords,
  };
}

// --- 4. Nutrition vs targets --------------------------------------------------

function assembleNutrition(db: Database, period: Period, accEnd: string): NutritionSection {
  const provenance = {
    sources: 'meals · meal_items · nutrition_targets',
    range: accEnd === period.end ? period.rangeLabel : `${period.rangeLabel} (complete days only)`,
  };
  const windowDays = accEnd >= period.start ? daysBetweenISO(period.start, accEnd) + 1 : 0;
  const series = windowDays > 0 ? dailyIntakeSeries(db, windowDays, accEnd) : [];
  const logged = series.filter((d) => d.mealCount > 0);
  const coverageLine = `${count(logged.length)} of ${plural(windowDays, 'day')} logged.`;

  if (logged.length === 0) {
    return {
      title: 'Nutrition',
      empty: 'No meals logged this period, so there is nothing to average.',
      provenance,
      coverageLine,
      figures: [],
      exclusionNote: null,
      targetNote: null,
    };
  }

  // The `remaining.ts` guard, per day: a day whose meals are all priced can be
  // averaged; a day carrying a NULL macro, or a meal whose total is a sum over
  // items one of which was never priced, cannot. Reusing `metricIsComplete`
  // means the report and the Eat tab disqualify exactly the same days.
  const METRICS: DayMetric[] = ['kcal', 'protein_g'];
  const completeValues: Record<DayMetric, number[]> = {
    kcal: [],
    protein_g: [],
    carbs_g: [],
    fat_g: [],
  };
  const excludedDays = new Set<string>();
  for (const day of logged) {
    const meals = listTodayMeals(db, day.date);
    const partial = partialMealMetrics(db, day.date);
    for (const metric of METRICS) {
      if (metricIsComplete(meals, metric, partial)) {
        // `sumRounded`, not a raw sum: it rounds PER MEAL and then adds, which
        // is how the Eat tab arrives at the day's displayed total. Summing raw
        // and rounding once is defensible arithmetic and the wrong answer here
        // — it would let a report quote a daily average the screen the user
        // checks it against never showed.
        completeValues[metric].push(sumRounded(meals.map((meal) => meal[metric])));
      } else {
        excludedDays.add(day.date);
      }
    }
  }

  const targets = activeNutritionTargets(db, period.end);
  const kcalAvg = average(completeValues.kcal);
  const proteinAvg = average(completeValues.protein_g);

  const figures: Figure[] = [
    {
      label: 'Energy',
      value: kcalAvg == null ? null : count(kcalAvg),
      unit: 'kcal/day',
      note:
        kcalAvg == null
          ? 'No fully-priced day to average.'
          : targets?.kcal != null
            ? `against a ${count(targets.kcal)} kcal target · ${plural(completeValues.kcal.length, 'day')} averaged`
            : `${plural(completeValues.kcal.length, 'day')} averaged · no target set`,
    },
    {
      label: 'Protein',
      value: proteinAvg == null ? null : num(proteinAvg, 0),
      unit: 'g/day',
      note:
        proteinAvg == null
          ? 'No fully-priced day to average.'
          : targets?.protein_g != null
            ? `against a ${num(targets.protein_g, 0)} g target · ${plural(completeValues.protein_g.length, 'day')} averaged`
            : `${plural(completeValues.protein_g.length, 'day')} averaged · no target set`,
    },
  ];

  const exclusionNote =
    excludedDays.size === 0
      ? null
      : `${plural(excludedDays.size, 'logged day')} carried a meal that was never fully ` +
        'priced; each is excluded from the average of any metric that meal left unpriced ' +
        '(a day still counts toward the metrics it did price — the exclusion is per ' +
        'metric, not per day). The days are still logged; their totals are known-partial.';

  return {
    title: 'Nutrition',
    empty: null,
    provenance,
    coverageLine,
    figures,
    exclusionNote,
    // "Your target THEN, not today's" — read as of the period's last day.
    targetNote:
      targets == null
        ? 'No targets were set for this period, so intake is stated without judgment.'
        : `Measured against the targets in force on ${formatDate(period.end)}.`,
  };
}

// --- 5. Sleep & recovery ------------------------------------------------------

type RecoverySpec = {
  metricType: string;
  label: string;
  gate: { thresholdPct: number; minPerWindow: number };
  // Whether the value ACCUMULATES through the day — steps: today is partial;
  // a night's sleep: written once against the wake day, a whole fact — is NOT
  // declared here. {@link isAccumulatingMetric} answers it for the whole app
  // (lib/health/accumulating.ts); this was one of four lists holding a private
  // copy of that answer.
  format: (value: number) => string;
  unit: string;
  /** Which direction is the good one, for the verdict's wording. */
  upIsGood: boolean;
};

function recoverySpecs(units: UnitPreferences): RecoverySpec[] {
  const hrv = displayFor('hrv', units);
  const rhr = displayFor('rhr', units);
  return [
    {
      metricType: 'hrv',
      label: 'HRV',
      gate: TREND_GATES.hrv,
      format: (v) => toDisplay(hrv, v) ?? EM_DASH,
      unit: hrv?.unit ?? 'ms',
      upIsGood: true,
    },
    {
      metricType: 'rhr',
      label: 'Resting heart rate',
      gate: TREND_GATES.rhr,
      format: (v) => toDisplay(rhr, v) ?? EM_DASH,
      unit: rhr?.unit ?? 'bpm',
      upIsGood: false,
    },
    {
      metricType: 'sleep_duration_min',
      label: 'Sleep',
      gate: TREND_GATES.sleep,
      format: (v) => fmtMinutes(v),
      unit: '',
      upIsGood: true,
    },
    {
      metricType: 'steps',
      label: 'Daily steps',
      gate: TREND_GATES.steps,
      format: (v) => count(v),
      unit: '',
      upIsGood: true,
    },
  ];
}

function assembleRecovery(db: Database, period: Period, accEnd: string): RecoverySection {
  const provenance = { sources: 'wearable_data (source-arbitrated)', range: period.rangeLabel };
  const units = getPreferences(db).units;
  const rows: RecoveryRow[] = [];

  for (const spec of recoverySpecs(units)) {
    const end = isAccumulatingMetric(spec.metricType) ? accEnd : period.end;
    const current: SeriesPoint[] =
      end >= period.start ? wearableArbitratedSeries(db, spec.metricType, period.start, end) : [];
    const before = wearableArbitratedSeries(
      db,
      spec.metricType,
      period.prior.start,
      period.prior.end
    );
    if (current.length === 0 && before.length === 0) continue;

    const currentValues = current.map((p) => p.value);
    const priorValues = before.map((p) => p.value);
    const currentAvg = average(currentValues);
    const priorAvg = average(priorValues);

    // The SAME two bars insights.ts fires on, from the SAME object. A report
    // that names a direction the Coach's engine would not have mentioned is
    // the report inventing a trend.
    const comparison = compareWindows(
      currentValues,
      priorValues,
      spec.gate.thresholdPct,
      spec.gate.minPerWindow
    );

    let verdict: string;
    if (currentAvg == null) {
      verdict = 'No readings in this period.';
    } else if (priorAvg == null) {
      verdict = `Nothing recorded in the window before this one (${period.prior.rangeLabel}), so there is nothing to compare against.`;
    } else if (comparison == null) {
      verdict = `Too few readings to compare — ${spec.gate.minPerWindow} a side are needed.`;
    } else if (!comparison.significant) {
      verdict = 'Within your normal variation.';
    } else {
      const up = comparison.changePct > 0;
      const good = up === spec.upIsGood;
      verdict =
        `${up ? 'Up' : 'Down'} ${pct(comparison.changePct)} on the window before — ` +
        `${good ? 'the direction you want' : 'worth watching'}. ` +
        'The gap is larger than your normal day-to-day variation.';
    }

    rows.push({
      metric: spec.label,
      periodAvg: currentAvg == null ? null : spec.format(currentAvg),
      priorAvg: priorAvg == null ? null : spec.format(priorAvg),
      unit: spec.unit,
      observations: `${count(current.length)} vs ${count(before.length)} days`,
      verdict,
      significant: comparison?.significant === true,
    });
  }

  return {
    title: 'Sleep & recovery',
    empty:
      rows.length === 0
        ? 'No wearable readings in this period or the one before it. Apple Health syncs these; nothing is missing by hand.'
        : null,
    provenance,
    rows,
  };
}

// --- 8. Experiments -----------------------------------------------------------

function assembleExperiments(db: Database, period: Period, today: string): ExperimentsSection {
  const provenance = { sources: 'experiments', range: period.rangeLabel };
  const rows: ExperimentRow[] = [];
  for (const e of listExperiments(db)) {
    const startedIn = e.start_date >= period.start && e.start_date <= period.end;
    const closedIn = e.end_date >= period.start && e.end_date <= period.end;
    const concludedIn =
      e.status === 'completed' &&
      e.updated_at.slice(0, 10) >= period.start &&
      e.updated_at.slice(0, 10) <= period.end;
    const ranThrough = e.start_date <= period.start && e.end_date >= period.end;
    if (!startedIn && !closedIn && !concludedIn && !ranThrough) continue;

    const state = concludedIn
      ? 'Concluded'
      : startedIn
        ? 'Started'
        : closedIn
          ? e.status === 'active'
            ? 'Ready to read out'
            : 'Window closed'
          : 'Ran through';

    rows.push({
      title: e.title,
      state,
      intervention: e.intervention,
      metrics: e.metrics.length > 0 ? joinList(e.metrics) : EM_DASH,
      window: `${formatDate(e.start_date)} – ${formatDate(e.end_date)}`,
      conclusion: e.conclusion,
    });
  }

  // Deterministic order regardless of sort stability: state, then title.
  const stateRank = ['Concluded', 'Ready to read out', 'Window closed', 'Started', 'Ran through'];
  rows.sort(
    (a, b) =>
      stateRank.indexOf(a.state) - stateRank.indexOf(b.state) || (a.title < b.title ? -1 : 1)
  );

  return {
    title: 'Experiments',
    empty:
      rows.length === 0
        ? today >= period.end
          ? 'None running, started or concluded this period.'
          : 'None running this period.'
        : null,
    provenance,
    rows,
  };
}

// --- 9. New labs (absent by rule when there was no draw) ----------------------

function assembleLabsInPeriod(db: Database, period: Period): LabsInPeriodSection | null {
  const reports = db.all<{ collectedAt: string; n: number }>(
    `SELECT r.collected_at AS collectedAt,
            (SELECT count(*) FROM lab_results WHERE report_id = r.id) AS n
     FROM lab_reports r
     WHERE r.collected_at >= ? AND r.collected_at <= ?
     ORDER BY r.collected_at DESC, r.created_at DESC`,
    [period.start, period.end]
  );
  // Absent ENTIRELY, not an authored empty: labs are episodic, and a monthly
  // "no labs this period" line is noise on a document meant to be read.
  if (reports.length === 0) return null;

  const markers = db.all<{
    name: string;
    value: number;
    optimalLow: number | null;
    optimalHigh: number | null;
    standardLow: number | null;
    standardHigh: number | null;
  }>(
    `SELECT b.name AS name, lr.value AS value,
            b.optimal_range_low AS optimalLow, b.optimal_range_high AS optimalHigh,
            b.standard_range_low AS standardLow, b.standard_range_high AS standardHigh
     FROM lab_results lr
     JOIN biomarkers b ON b.id = lr.biomarker_id
     WHERE lr.collected_at >= ? AND lr.collected_at <= ?
     ORDER BY b.name COLLATE NOCASE`,
    [period.start, period.end]
  );

  const outsideStandard: string[] = [];
  const outsideOptimal: string[] = [];
  for (const m of markers) {
    const standardBad =
      (m.standardLow != null && m.value < m.standardLow) ||
      (m.standardHigh != null && m.value > m.standardHigh);
    const optimalBad =
      (m.optimalLow != null && m.value < m.optimalLow) ||
      (m.optimalHigh != null && m.value > m.optimalHigh);
    if (standardBad) outsideStandard.push(m.name);
    else if (optimalBad) outsideOptimal.push(m.name);
  }

  return {
    title: 'New labs',
    empty: null,
    provenance: { sources: 'lab_reports · lab_results · biomarkers', range: period.rangeLabel },
    draws: reports.map((r) => `${formatDate(r.collectedAt)} — ${plural(r.n, 'marker')}`),
    figures: [
      { label: 'Markers measured', value: count(markers.length), unit: null, note: null },
      {
        label: 'Outside standard range',
        value: count(outsideStandard.length),
        unit: null,
        note: outsideStandard.length > 0 ? namedThenCounted(outsideStandard, 6) : null,
      },
      {
        label: 'Outside optimal only',
        value: count(outsideOptimal.length),
        unit: null,
        note: outsideOptimal.length > 0 ? namedThenCounted(outsideOptimal, 6) : null,
      },
    ],
    outsideStandard,
    outsideOptimal,
  };
}

// --- 10. What changed ---------------------------------------------------------

function assembleWhatChanged(
  db: Database,
  period: Period,
  modeByDate: Map<string, ModeKey>
): WhatChangedSection {
  const rows: ChangeRow[] = [];

  // Protocol revisions. `created_at` is a UTC instant and the period is local
  // days; bucketing on its date substring is the same approximation
  // `bodyDailySeries` and the Coach's history reads already make, and it is
  // stated here rather than left to be discovered.
  const versions = db.all<{
    name: string;
    versionNumber: number;
    changeNotes: string | null;
    createdBy: string;
    createdAt: string;
  }>(
    `SELECT p.name AS name, v.version_number AS versionNumber, v.change_notes AS changeNotes,
            v.created_by AS createdBy, v.created_at AS createdAt
     FROM protocol_versions v
     JOIN protocols p ON p.id = v.protocol_id
     WHERE substr(v.created_at, 1, 10) >= ? AND substr(v.created_at, 1, 10) <= ?
     ORDER BY v.created_at`,
    [period.start, period.end]
  );
  for (const v of versions) {
    rows.push({
      kind: 'Protocol',
      what: `${v.name} — version ${count(v.versionNumber)}${v.createdBy === 'ai' ? ', proposed by the Coach and approved' : ''}`,
      when: formatDate(v.createdAt.slice(0, 10)),
      note: v.changeNotes,
    });
  }

  const targets = db.all<{
    effectiveDate: string;
    kcal: number | null;
    protein: number | null;
    notes: string | null;
  }>(
    `SELECT effective_date AS effectiveDate, kcal AS kcal, protein_g AS protein, notes AS notes
     FROM nutrition_targets
     WHERE effective_date >= ? AND effective_date <= ?
     ORDER BY effective_date, created_at`,
    [period.start, period.end]
  );
  for (const t of targets) {
    const parts: string[] = [];
    if (t.kcal != null) parts.push(`${count(t.kcal)} kcal`);
    if (t.protein != null) parts.push(`${num(t.protein, 0)} g protein`);
    rows.push({
      kind: 'Nutrition targets',
      what: parts.length > 0 ? `New targets — ${joinList(parts)}` : 'New targets set',
      when: formatDate(t.effectiveDate),
      note: t.notes,
    });
  }

  // The period's mode ledger — contiguous runs, not one row per day.
  for (const run of modeRuns(modeByDate)) {
    if (run.mode === 'normal') continue;
    const def = getModeDefinition(run.mode);
    rows.push({
      kind: 'Mode',
      what: `${def.label} — ${plural(run.days, 'day')}`,
      when:
        run.start === run.end
          ? formatDate(run.start)
          : `${formatDate(run.start)} – ${formatDate(run.end)}`,
      note: def.excusesSkips ? 'Skips on these days are excused.' : null,
    });
  }

  return {
    title: 'What changed',
    empty:
      rows.length === 0
        ? 'No protocol revision, target change or mode this period — the plan you started with is the plan you finished with.'
        : null,
    provenance: {
      sources: 'protocol_versions · nutrition_targets · day_modes',
      range: period.rangeLabel,
    },
    rows,
  };
}

/** Contiguous same-mode runs over the period's days, oldest first. */
function modeRuns(
  modeByDate: Map<string, ModeKey>
): { mode: ModeKey; start: string; end: string; days: number }[] {
  const runs: { mode: ModeKey; start: string; end: string; days: number }[] = [];
  // Map insertion order is the period's day order (see assembleSelfReview), but
  // sort anyway so this function is correct for any caller.
  const dates = [...modeByDate.keys()].sort();
  for (const date of dates) {
    const mode = modeByDate.get(date)!;
    const last = runs[runs.length - 1];
    if (last && last.mode === mode && isoDatePlusDays(last.end, 1) === date) {
      last.end = date;
      last.days += 1;
    } else {
      runs.push({ mode, start: date, end: date, days: 1 });
    }
  }
  return runs;
}

// --- The assembly ------------------------------------------------------------

export function assembleSelfReview(
  db: Database,
  period: Period,
  options: AssembleOptions = {}
): SelfReviewData {
  const now = options.now ?? new Date();
  const today = todayISODate(now);
  const accEnd = accumulatingEnd(period, now);

  // Every day's mode, read once and shared by the adherence ledger and the
  // what-changed ledger, so the two can never disagree about the period.
  const modeByDate = new Map<string, ModeKey>();
  for (let i = 0; i < period.days; i++) {
    const date = isoDatePlusDays(period.start, i);
    modeByDate.set(date, getActiveMode(db, date));
  }

  const covered = loggedDays(db, period);

  return {
    kind: 'self_review',
    meta: {
      type: 'self_review',
      // ⚑ MATT #3, decided 2026-08-12: the self-review carries NO name. It is
      // the report most casually shared, and `users.full_name` is deliberately
      // never read on this path.
      title: 'Self-review',
      generatedAt: now.toISOString(),
      generatedOn: formatDateLong(today),
      appVersion: options.appVersion ?? null,
      disclaimer: REPORT_DISCLAIMER,
    },
    period,
    coverageLine: `${count(covered.length)} of ${plural(period.days, 'day')} in this period carry at least one logged entry.`,
    todayNote: todayNote(period),
    adherence: assembleAdherence(db, period, accEnd, modeByDate),
    training: assembleTraining(db, period, accEnd),
    nutrition: assembleNutrition(db, period, accEnd),
    recovery: assembleRecovery(db, period, accEnd),
    body: assembleBodyOver(db, period.start, period.end, period.rangeLabel),
    symptoms: assembleSymptoms(db, period.start, period.end, period.rangeLabel),
    experiments: assembleExperiments(db, period, today),
    labs: assembleLabsInPeriod(db, period),
    changed: assembleWhatChanged(db, period, modeByDate),
  };
}
