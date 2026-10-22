/**
 * Attention routing: record hygiene and medical events — pure detectors that
 * ONLY DETECT (docs/spikes/chief-of-staff-release.md §2, Track 2 item 6).
 *
 * Four families, each reading his own history to decide what is unusual:
 *
 *   1. **Gaps** against his own cadence — weight usually logged every day and
 *      none for four; meals usually logged and a day with none while the rest
 *      of his data says he was up and about.
 *   2. **Duplicate candidates** — the same meal or capture twice inside a few
 *      minutes; a lab report imported twice (same draw date, same values).
 *   3. **Implausible values** — a weight jump no body makes in a day, an HRV or
 *      resting-HR reading far outside his own baseline, a lab value outside
 *      what a living body produces (a unit or parse error, almost always).
 *   4. **Medical attention** — a lab marker that worsened between draws by more
 *      than its own noise, or that left its range; a symptom on most of the
 *      last several days; a vital out of his band for days running.
 *
 * ## What this module does NOT do — the whole point of it
 *
 * Nothing here writes, changes a plan, or decides. A finding is a FACT with its
 * evidence attached; what it means and whether to say anything is the Coach's
 * call, every time (docs/ai-coach.md, "judgment lives in the model"). So a
 * finding carries no advice and no instruction, and the headlines say what the
 * data shows, never what to do about it. db/findings.test.mjs asserts the
 * database is byte-identical after every entry point here.
 *
 * ## Where findings go — and where they do not
 *
 *   - **Not Home's brief.** Home is directive (CLAUDE.md §5); a duplicate meal
 *     is not a thing to do right now. `computeInsights` and
 *     `generateDailyBrief` never see a finding, so the brief, the per-turn
 *     `Signals:` line and the signal trigger are byte-identical.
 *   - **The coach pass's context** — a compact block ({@link findingsBlock})
 *     appended after the state block, so the unattended look sees them.
 *   - **`get_insights`'s result** — payload, not schema (the tool schemas are
 *     at their ceiling, db/coach-eval.test.mjs §6), so the chat Coach reaches
 *     them through the tool it is told to call first for open questions.
 *
 * ## Shaped for proposals
 *
 * A later piece of work lets the pass PROPOSE fixes. A proposal references a
 * finding by {@link Finding.id} — stable across days, so the same condition is
 * the same finding until it changes — and {@link findingById} re-derives it at
 * approval time, so a proposal for a finding that has since resolved finds
 * nothing and refuses. Each {@link FindingRow} names the table and id, and,
 * where the domain registry reaches the row, the `domain` and `domainId` that
 * `edit_record` / `delete_record` take.
 *
 * Statuses and excluded days are respected throughout: a day any status covers
 * (sick, travelling, fasting — whatever he declared), an excused day, a
 * timezone-change day or an away day is never counted as a missed log, never
 * sets a baseline, and never yields an "implausible" single reading.
 */
import type { Database } from '@/lib/db/database';
import {
  clockFromISO,
  getDayStartsAt,
  logicalDate,
  shiftISODate,
  todayISODate,
} from '@/lib/db/date';
import { excusedDatesIn } from '@/lib/db/repositories/mission';
import { statusDaysIn } from '@/lib/db/repositories/statuses';
import { baselineExclusionsIn } from '@/lib/home/baseline-exclusions';

import {
  DEFAULT_LAB_CV_PCT,
  FINDING_WINDOWS as W,
  getFindingThresholds,
  LAB_ANALYTIC_CV_PCT,
  LAB_NOISE_CV_PCT,
  PHYSIOLOGIC_BANDS,
  type FindingThresholds,
} from './finding-thresholds';
import { daysBetweenISO, endOfLocalDayUtc, round1, wearableArbitratedSeries } from './series';

/** The two insight kinds the brief never sees. */
export type FindingKind = 'record' | 'labs';

/** Which detector raised it. */
export type FindingCheck =
  'gap' | 'duplicate' | 'implausible' | 'worsened' | 'out-of-range' | 'persists';

/**
 * How much it matters, as a fact about the data — not an instruction:
 *   info       bookkeeping worth knowing (one day's meals missing);
 *   notice     the record is probably wrong or broken (a duplicate, a typo, a gap);
 *   attention  something about his body a clinician might want to hear.
 */
export type FindingSeverity = 'info' | 'notice' | 'attention';

/** The registry domains a finding's rows can be reached through. */
export type FindingDomain = 'meals' | 'captures' | 'lab_reports';

export type FindingRow = {
  table:
    | 'meals'
    | 'log_entries'
    | 'body_metrics'
    | 'wearable_data'
    | 'lab_reports'
    | 'lab_results'
    | 'symptoms';
  id: string;
  /**
   * `suspect` — the row the finding is about (the typo, the later duplicate's
   * twin); `candidate` — one of a duplicate pair, neither preferred; `context`
   * — evidence only.
   */
  role: 'suspect' | 'candidate' | 'context';
  date: string;
  label: string;
  /** Set only where `edit_record` / `delete_record` can reach the row. */
  domain?: FindingDomain;
  domainId?: string;
};

export type Finding = {
  /** Stable across days while the condition holds: `<check>-<8 hex>`. */
  id: string;
  kind: FindingKind;
  check: FindingCheck;
  severity: FindingSeverity;
  /** What it is about: 'weight', 'meals', 'hrv', a biomarker slug, 'symptom:headache'. */
  subject: string;
  /** One factual line with its numbers. Never advice. */
  headline: string;
  /** The day the condition first held. */
  since: string;
  rows: FindingRow[];
  /** The numbers behind the headline, unrounded where it matters. */
  numbers: Record<string, number | string | null>;
};

// --- small pure helpers -------------------------------------------------------

/** FNV-1a, 32-bit, as 8 hex — short, stable, dependency-free. */
function hash8(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const findingId = (check: FindingCheck, key: string): string => `${check}-${hash8(key)}`;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const norm = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

/** Days strictly between two dates. */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = shiftISODate(from, 1); d < to; d = shiftISODate(d, 1)) out.push(d);
  return out;
}

/**
 * Every day in the window that must not be judged: the union of the adherence
 * ledger's excused days (an excusing status, a frozen mode, a timezone change)
 * and the baselines' excluded days (EVERY status, away days, timezone days).
 * A non-excusing status still means "this day was not ordinary", which is all
 * a cadence or a baseline needs to know.
 */
function unjudgedDays(db: Database, from: string, to: string, today: string): Set<string> {
  if (to < from) return new Set();
  const out = new Set(excusedDatesIn(db, from, to));
  for (const day of baselineExclusionsIn(db, from, to, today).days) out.add(day);
  return out;
}

/** A number as a headline prints it: one decimal from 10 up, three significant below. */
const fmt = (value: number): string =>
  String(Math.abs(value) >= 10 ? round1(value) : Number(value.toPrecision(3)));

/** His own words in a headline, capped, so one long name cannot bloat the block. */
const quote = (text: string): string => {
  const clean = text.trim().replace(/\s+/g, ' ');
  return `"${clean.length > 40 ? `${clean.slice(0, 39)}…` : clean}"`;
};

/** An own-property lookup: a slug is data, and "constructor" is not a band. */
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

// --- 1. Gaps against his own cadence ------------------------------------------

type WeightRow = {
  id: string;
  measured_at: string;
  weight_kg: number;
  source: string;
  date: string;
};

function weightRows(db: Database, now: Date, sinceDaysAgo: number): WeightRow[] {
  const dayStartsAt = getDayStartsAt();
  return db
    .all<Omit<WeightRow, 'date'>>(
      `SELECT id, measured_at, weight_kg, source FROM body_metrics
       WHERE weight_kg IS NOT NULL AND measured_at >= ? AND measured_at < ?
       ORDER BY measured_at, id`,
      [shiftISODate(todayISODate(now), -(sinceDaysAgo + 1)), endOfLocalDayUtc(now)]
    )
    .map((row) => ({ ...row, date: logicalDate(new Date(row.measured_at), dayStartsAt) }));
}

/** A body_metrics weight row, reachable through `captures` only when typed by hand. */
function weightRow(row: WeightRow, role: FindingRow['role']): FindingRow {
  return {
    table: 'body_metrics',
    id: row.id,
    role,
    date: row.date,
    label: `${fmt(row.weight_kg)} kg`,
    ...(row.source === 'manual'
      ? { domain: 'captures' as const, domainId: `${row.id}:weight_kg` }
      : {}),
  };
}

function weightGap(db: Database, now: Date, today: string, t: FindingThresholds): Finding[] {
  const rows = weightRows(db, now, 400);
  const days = [...new Set(rows.map((r) => r.date))].sort();
  const last = days[days.length - 1];
  if (!last || last >= today) return [];

  // The cadence comes from the eight weeks ending at his LAST log, not today:
  // a month-long lapse must not erase the habit it is a lapse from.
  const windowFrom = shiftISODate(last, -(W.cadenceDays - 1));
  const logDays = days.filter((d) => d >= windowFrom);
  if (logDays.length < W.cadenceMinLogs) return [];

  const unjudged = unjudgedDays(db, windowFrom, today, today);
  const intervals: number[] = [];
  for (let i = 1; i < logDays.length; i++) {
    const skipped = datesBetween(logDays[i - 1]!, logDays[i]!).filter((d) =>
      unjudged.has(d)
    ).length;
    intervals.push(Math.max(1, daysBetweenISO(logDays[i - 1]!, logDays[i]!) - skipped));
  }
  const usual = median(intervals)!;
  if (usual > W.cadenceMaxIntervalDays) return [];

  // Whole days missed: after the last log, before today (today is not over),
  // and not a day any status, excusal, trip or timezone change covers.
  const between = datesBetween(last, today);
  const missed = between.filter((d) => !unjudged.has(d)).length;
  const threshold = Math.max(t.gapMinDays, Math.ceil(t.gapMultiple * usual));
  if (missed < threshold) return [];

  const lastRow = rows.filter((r) => r.date === last).pop()!;
  return [
    {
      id: findingId('gap', `weight|${last}`),
      kind: 'record',
      check: 'gap',
      severity: 'notice',
      subject: 'weight',
      headline:
        `No weight logged for ${missed} days (last ${last}); ` +
        `usually every ${usual === 1 ? 'day' : `${fmt(usual)} days`}`,
      since: shiftISODate(last, 1),
      rows: [weightRow(lastRow, 'context')],
      numbers: {
        missedDays: missed,
        usualEveryDays: usual,
        unjudgedDays: between.length - missed,
        threshold,
        lastDate: last,
      },
    },
  ];
}

function mealGaps(db: Database, today: string): Finding[] {
  const baselineFrom = shiftISODate(today, -W.mealBaselineFromDaysAgo);
  const baselineTo = shiftISODate(today, -W.mealBaselineToDaysAgo);
  const yesterday = shiftISODate(today, -1);
  const unjudged = unjudgedDays(db, baselineFrom, yesterday, today);

  const mealDays = new Set(
    db
      .all<{ date: string }>('SELECT DISTINCT date FROM meals WHERE date >= ? AND date <= ?', [
        baselineFrom,
        yesterday,
      ])
      .map((r) => r.date)
  );
  const eligible: string[] = [];
  for (let d = baselineFrom; d <= baselineTo; d = shiftISODate(d, 1)) {
    if (!unjudged.has(d)) eligible.push(d);
  }
  if (eligible.length < W.mealMinEligibleDays) return [];
  const usualFraction = eligible.filter((d) => mealDays.has(d)).length / eligible.length;
  if (usualFraction < W.mealUsualFraction) return [];

  const steps = wearableArbitratedSeries(db, 'steps', baselineFrom, yesterday);
  const stepsByDay = new Map(steps.map((p) => [p.date, p.value]));
  const usualSteps = median(steps.filter((p) => p.date <= baselineTo).map((p) => p.value));

  const findings: Finding[] = [];
  for (let back = 1; back <= W.mealLookbackDays; back++) {
    const day = shiftISODate(today, -back);
    if (mealDays.has(day) || unjudged.has(day)) continue;

    // The evidence he was up and about — without it, an empty day is as
    // likely a day he did not open ARC at all, which is not a meal gap.
    const active: string[] = [];
    const daySteps = stepsByDay.get(day);
    if (
      daySteps != null &&
      usualSteps != null &&
      usualSteps > 0 &&
      daySteps >= usualSteps * W.mealActiveStepsFraction
    ) {
      active.push(`${Math.round(daySteps)} steps`);
    }
    const workouts = db.get<{ c: number }>('SELECT count(*) c FROM workouts WHERE date = ?', [
      day,
    ])!.c;
    if (workouts > 0) active.push(workouts === 1 ? 'a workout' : `${workouts} workouts`);
    const ticked = db.get<{ c: number }>(
      `SELECT count(*) c FROM log_entries le JOIN daily_logs dl ON dl.id = le.daily_log_id
       WHERE dl.date = ? AND le.status = 'completed'`,
      [day]
    )!.c;
    if (ticked > 0) active.push(`${ticked} item${ticked === 1 ? '' : 's'} ticked`);
    if (active.length === 0) continue;

    findings.push({
      id: findingId('gap', `meals|${day}`),
      kind: 'record',
      check: 'gap',
      severity: 'info',
      subject: 'meals',
      headline: `No meals logged on ${day}, a day with ${active.join(', ')}; meals are usually logged on ${Math.round(usualFraction * 100)}% of days`,
      since: day,
      rows: [],
      numbers: {
        date: day,
        usualLoggedPct: Math.round(usualFraction * 100),
        steps: daySteps ?? null,
        usualSteps: usualSteps ?? null,
        workouts,
        ticked,
      },
    });
  }
  return findings;
}

// --- 2. Duplicate candidates --------------------------------------------------

type MealRow = {
  id: string;
  date: string;
  time: string | null;
  name: string;
  kcal: number | null;
  created_at: string;
};

/** The instant a row happened, in minutes: the clock he gave, else when it was saved. */
function minutesOf(date: string, time: string | null, createdAt: string): number {
  if (time) {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    const [hh, mm] = time.split(':').map(Number) as [number, number];
    return new Date(y, m - 1, d, hh, mm).getTime() / 60_000;
  }
  return Date.parse(createdAt) / 60_000;
}

function duplicateMeals(db: Database, today: string, t: FindingThresholds): Finding[] {
  const from = shiftISODate(today, -(W.duplicateLookbackDays - 1));
  const meals = db.all<MealRow>(
    `SELECT id, date, time, name, kcal, created_at FROM meals
     WHERE date >= ? AND date <= ? ORDER BY date, created_at, id`,
    [from, today]
  );
  if (meals.length < 2) return [];
  // The top-level items of each meal, as a sorted signature: the same foods in
  // the same amounts is the same plate, whatever the meal was called.
  const items = db.all<{
    meal_id: string;
    food_id: string | null;
    name: string;
    amount: number | null;
    serving_qty: number | null;
  }>(
    `SELECT meal_id, food_id, name, amount, serving_qty FROM meal_items
     WHERE parent_item_id IS NULL AND meal_id IN (SELECT id FROM meals WHERE date >= ? AND date <= ?)`,
    [from, today]
  );
  const parts = new Map<string, string[]>();
  for (const item of items) {
    const part = `${item.food_id ?? norm(item.name)}@${Math.round(item.amount ?? item.serving_qty ?? 0)}`;
    parts.set(item.meal_id, [...(parts.get(item.meal_id) ?? []), part]);
  }
  const signature = (id: string): string => (parts.get(id) ?? []).sort().join('|');

  const same = (a: MealRow, b: MealRow): boolean => {
    const sa = signature(a.id);
    const sb = signature(b.id);
    if (sa !== '' || sb !== '') return sa === sb;
    if (norm(a.name) !== norm(b.name)) return false;
    if (a.kcal == null || b.kcal == null) return a.kcal == null && b.kcal == null;
    return Math.abs(a.kcal - b.kcal) <= Math.max(a.kcal, b.kcal) * 0.05 + 1;
  };

  const label = (m: MealRow): string =>
    `${m.name}${m.time ? ` ${m.time}` : ''}${m.kcal != null ? ` · ${Math.round(m.kcal)} kcal` : ''}`;

  const findings: Finding[] = [];
  for (let j = 1; j < meals.length; j++) {
    const b = meals[j]!;
    const atB = minutesOf(b.date, b.time, b.created_at);
    // Pair each meal with the nearest earlier twin only, so a triple yields two
    // pairs, not three.
    for (let i = j - 1; i >= 0; i--) {
      const a = meals[i]!;
      if (a.date !== b.date) break;
      const apart = Math.abs(atB - minutesOf(a.date, a.time, a.created_at));
      if (apart > t.duplicateWindowMin || !same(a, b)) continue;
      const ids = [a.id, b.id].sort();
      findings.push({
        id: findingId('duplicate', `meal|${ids.join('|')}`),
        kind: 'record',
        check: 'duplicate',
        severity: 'notice',
        subject: 'meals',
        headline: `${quote(b.name)} logged twice ${Math.round(apart)} min apart on ${b.date}`,
        since: b.date,
        rows: [a, b].map((m) => ({
          table: 'meals' as const,
          id: m.id,
          role: 'candidate' as const,
          date: m.date,
          label: label(m),
          domain: 'meals' as const,
          domainId: m.id,
        })),
        numbers: { minutesApart: Math.round(apart), kcalEach: b.kcal },
      });
      break;
    }
  }
  return findings;
}

function duplicateCaptures(db: Database, today: string, t: FindingThresholds): Finding[] {
  const from = shiftISODate(today, -(W.duplicateLookbackDays - 1));
  const rows = db.all<{ id: string; type: string; title: string; at: string; date: string }>(
    `SELECT le.id, le.type, le.title, coalesce(le.completed_at, le.created_at) AS at, dl.date AS date
     FROM log_entries le JOIN daily_logs dl ON dl.id = le.daily_log_id
     WHERE dl.date >= ? AND dl.date <= ? AND json_extract(le.value, '$.adhoc') = 1
     ORDER BY dl.date, at, le.id`,
    [from, today]
  );
  const findings: Finding[] = [];
  for (let j = 1; j < rows.length; j++) {
    const b = rows[j]!;
    for (let i = j - 1; i >= 0; i--) {
      const a = rows[i]!;
      if (a.date !== b.date) break;
      if (a.type !== b.type || norm(a.title) !== norm(b.title)) continue;
      const apart = Math.abs(Date.parse(b.at) - Date.parse(a.at)) / 60_000;
      if (apart > t.duplicateWindowMin) continue;
      const ids = [a.id, b.id].sort();
      findings.push({
        id: findingId('duplicate', `capture|${ids.join('|')}`),
        kind: 'record',
        check: 'duplicate',
        severity: 'notice',
        subject: `capture:${a.type}`,
        headline: `${quote(b.title)} (${b.type}) captured twice ${Math.round(apart)} min apart on ${b.date}`,
        since: b.date,
        rows: [a, b].map((r) => ({
          table: 'log_entries' as const,
          id: r.id,
          role: 'candidate' as const,
          date: r.date,
          label: `${r.title} · ${clockFromISO(r.at)}`,
          domain: 'captures' as const,
          domainId: r.id,
        })),
        numbers: { minutesApart: Math.round(apart) },
      });
      break;
    }
  }
  return findings;
}

function duplicateLabReports(db: Database, t: FindingThresholds): Finding[] {
  const reports = db.all<{ id: string; collected_at: string; created_at: string }>(
    'SELECT id, collected_at, created_at FROM lab_reports ORDER BY collected_at, created_at, id'
  );
  if (reports.length < 2) return [];
  const values = new Map<string, Map<string, number>>();
  for (const r of db.all<{ report_id: string; biomarker_id: string; value: number }>(
    'SELECT report_id, biomarker_id, value FROM lab_results WHERE report_id IS NOT NULL'
  )) {
    const map = values.get(r.report_id) ?? new Map<string, number>();
    map.set(r.biomarker_id, r.value);
    values.set(r.report_id, map);
  }

  const findings: Finding[] = [];
  for (let j = 1; j < reports.length; j++) {
    const b = reports[j]!;
    for (let i = j - 1; i >= 0; i--) {
      const a = reports[i]!;
      if (a.collected_at !== b.collected_at) break;
      const va = values.get(a.id) ?? new Map<string, number>();
      const vb = values.get(b.id) ?? new Map<string, number>();
      const shared = [...va.keys()].filter((k) => vb.has(k));
      if (shared.length < W.labDuplicateMinShared) continue;
      if (shared.length < Math.min(va.size, vb.size) * W.labDuplicateSharedFraction) continue;
      const matching = shared.filter((k) => {
        const x = va.get(k)!;
        const y = vb.get(k)!;
        const scale = Math.max(Math.abs(x), Math.abs(y));
        return scale === 0 || Math.abs(x - y) <= (scale * t.labDuplicateTolerancePct) / 100;
      }).length;
      if (matching < shared.length * W.labDuplicateMatchFraction) continue;
      findings.push({
        id: findingId('duplicate', `lab|${[a.id, b.id].sort().join('|')}`),
        kind: 'labs',
        check: 'duplicate',
        severity: 'notice',
        subject: 'lab_reports',
        headline: `Lab report for ${b.collected_at} imported twice: ${matching} of ${shared.length} shared values agree`,
        since: b.created_at.slice(0, 10),
        rows: [a, b].map((r) => ({
          table: 'lab_reports' as const,
          id: r.id,
          role: 'candidate' as const,
          date: r.collected_at,
          label: `${(values.get(r.id) ?? new Map()).size} values · imported ${r.created_at.slice(0, 10)}`,
          domain: 'lab_reports' as const,
          domainId: r.id,
        })),
        numbers: { shared: shared.length, matching, tolerancePct: t.labDuplicateTolerancePct },
      });
      break;
    }
  }
  return findings;
}

// --- 3. Implausible values ----------------------------------------------------

function implausibleWeights(db: Database, now: Date, t: FindingThresholds): Finding[] {
  const rows = weightRows(db, now, W.weightLookbackDays);
  const findings: Finding[] = [];
  const pct = (a: number, b: number): number => (Math.abs(b - a) / a) * 100;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!;
    const cur = rows[i]!;
    if (daysBetweenISO(prev.date, cur.date) > W.weightPairMaxDays) continue;
    const jump = pct(prev.weight_kg, cur.weight_kg);
    if (jump <= t.weightJumpPct) continue;
    // A spike that comes straight back is the middle reading's fault; skip the
    // return leg so the reading that is RIGHT is never called implausible.
    const next = rows[i + 1];
    if (
      next &&
      daysBetweenISO(cur.date, next.date) <= W.weightPairMaxDays &&
      pct(prev.weight_kg, next.weight_kg) <= t.weightJumpPct
    ) {
      i++;
    }
    findings.push({
      id: findingId('implausible', `weight|${cur.id}`),
      kind: 'record',
      check: 'implausible',
      severity: 'notice',
      subject: 'weight',
      headline:
        `Weight ${fmt(cur.weight_kg)} kg on ${cur.date} is ${fmt(jump)}% from ` +
        `${fmt(prev.weight_kg)} kg on ${prev.date}`,
      since: cur.date,
      rows: [weightRow(cur, 'suspect'), weightRow(prev, 'context')],
      numbers: {
        value: cur.weight_kg,
        previous: prev.weight_kg,
        jumpPct: round1(jump),
        thresholdPct: t.weightJumpPct,
      },
    });
  }
  return findings;
}

type VitalSpec = { metric: 'hrv' | 'rhr'; label: string; unit: string; worrying: 'low' | 'high' };
const VITALS: readonly VitalSpec[] = [
  { metric: 'hrv', label: 'HRV', unit: 'ms', worrying: 'low' },
  { metric: 'rhr', label: 'Resting HR', unit: 'bpm', worrying: 'high' },
];

function wearableRowFor(db: Database, metric: string, date: string, value: number): FindingRow {
  const row = db.get<{ id: string; source_device: string; source_raw_id: string | null }>(
    `SELECT id, source_device, source_raw_id FROM wearable_data
     WHERE metric_type = ? AND date = ? ORDER BY abs(value - ?), id LIMIT 1`,
    [metric, date, value]
  );
  const manual = row?.source_device === 'manual' && row.source_raw_id == null;
  return {
    table: 'wearable_data',
    id: row?.id ?? '',
    role: 'suspect',
    date,
    label: `${fmt(value)}`,
    ...(row && manual ? { domain: 'captures' as const, domainId: row.id } : {}),
  };
}

function vitalFindings(db: Database, today: string, t: FindingThresholds): Finding[] {
  const from = shiftISODate(today, -W.vitalBaselineFromDaysAgo);
  const baselineTo = shiftISODate(today, -W.vitalBaselineToDaysAgo);
  const unjudged = unjudgedDays(db, from, today, today);
  const statusDays = statusDaysIn(db, from, today);
  const findings: Finding[] = [];

  for (const spec of VITALS) {
    const series = wearableArbitratedSeries(db, spec.metric, from, today);
    const baseline = series
      .filter((p) => p.date <= baselineTo && !unjudged.has(p.date))
      .map((p) => p.value);
    if (baseline.length < W.vitalBaselineMinPoints) continue;
    const center = median(baseline)!;
    const sd = 1.4826 * median(baseline.map((v) => Math.abs(v - center)))!;
    if (!(sd > 0)) continue;
    const z = (v: number): number => (v - center) / sd;
    const band = `median ${fmt(center)} ± ${fmt(sd)} ${spec.unit}`;

    // One reading far outside his band, on a day nothing explains.
    const implausibleFrom = shiftISODate(today, -(W.vitalImplausibleLookbackDays - 1));
    for (const p of series) {
      if (p.date < implausibleFrom || unjudged.has(p.date)) continue;
      const score = z(p.value);
      if (Math.abs(score) <= t.vitalImplausibleSd) continue;
      const row = wearableRowFor(db, spec.metric, p.date, p.value);
      findings.push({
        id: findingId('implausible', `${spec.metric}|${p.date}`),
        kind: 'record',
        check: 'implausible',
        severity: 'notice',
        subject: spec.metric,
        headline: `${spec.label} ${fmt(p.value)} ${spec.unit} on ${p.date} is ${fmt(Math.abs(score))} SD from your baseline (${band})`,
        since: p.date,
        rows: row.id ? [{ ...row, label: `${fmt(p.value)} ${spec.unit}` }] : [],
        numbers: {
          value: p.value,
          baselineMedian: round1(center),
          baselineSd: round1(sd),
          z: round1(score),
        },
      });
    }

    // A run, the worrying way, reaching yesterday or today. Every day counts,
    // a status day included — a sick week with RHR up five days running is
    // exactly the fact a clinician asks about — and the evidence says which.
    const recent = series.filter(
      (p) => p.date >= shiftISODate(today, -(W.vitalRunLookbackDays - 1))
    );
    const latest = recent[recent.length - 1];
    if (!latest || latest.date < shiftISODate(today, -1)) continue;
    const out = (v: number): boolean =>
      spec.worrying === 'low' ? z(v) <= -t.vitalPersistSd : z(v) >= t.vitalPersistSd;
    const run: typeof recent = [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const p = recent[i]!;
      if (!out(p.value)) break;
      if (run.length > 0 && daysBetweenISO(p.date, run[0]!.date) !== 1) break;
      run.unshift(p);
    }
    if (run.length < t.vitalPersistDays) continue;
    const start = run[0]!.date;
    findings.push({
      id: findingId('persists', `${spec.metric}|${spec.worrying}|${start}`),
      kind: 'record',
      check: 'persists',
      severity: 'attention',
      subject: spec.metric,
      headline:
        `${spec.label} ${spec.worrying === 'low' ? 'below' : 'above'} your band ${run.length} days running ` +
        `since ${start} (latest ${fmt(latest.value)} ${spec.unit}; ${band})`,
      since: start,
      rows: run
        .slice(-7)
        .map((p) => ({
          ...wearableRowFor(db, spec.metric, p.date, p.value),
          role: 'context' as const,
          label: `${fmt(p.value)} ${spec.unit}`,
        }))
        .filter((row) => row.id !== ''),
      numbers: {
        runDays: run.length,
        latest: latest.value,
        baselineMedian: round1(center),
        baselineSd: round1(sd),
        thresholdSd: t.vitalPersistSd,
        statusDays: run.filter((p) => statusDays.has(p.date)).length,
      },
    });
  }
  return findings;
}

// --- 3b / 4. Labs: implausible, out of range, worsened ------------------------

type LabResultRow = {
  id: string;
  value: number;
  collected_at: string;
  created_at: string;
  report_id: string | null;
  slug: string;
  name: string;
  unit: string | null;
  ol: number | null;
  oh: number | null;
  sl: number | null;
  sh: number | null;
  hib: 0 | 1 | null;
};

function labRow(r: LabResultRow, role: FindingRow['role']): FindingRow {
  return {
    table: 'lab_results',
    id: r.id,
    role,
    date: r.collected_at,
    label: `${r.name} ${fmt(r.value)}${r.unit ? ` ${r.unit}` : ''}`,
    ...(r.report_id ? { domain: 'lab_reports' as const, domainId: r.report_id } : {}),
  };
}

const outside = (v: number, low: number | null, high: number | null): boolean =>
  (low != null && v < low) || (high != null && v > high);

const distance = (v: number, low: number | null, high: number | null): number =>
  low != null && v < low ? low - v : high != null && v > high ? v - high : 0;

function bandText(low: number | null, high: number | null): string {
  if (low != null && high != null) return `${fmt(low)}–${fmt(high)}`;
  return low != null ? `≥${fmt(low)}` : `≤${fmt(high!)}`;
}

function labFindings(db: Database, today: string, t: FindingThresholds): Finding[] {
  const rows = db.all<LabResultRow>(
    `SELECT lr.id, lr.value, lr.collected_at, lr.created_at, lr.report_id,
            b.slug, b.name, b.unit,
            b.optimal_range_low AS ol, b.optimal_range_high AS oh,
            b.standard_range_low AS sl, b.standard_range_high AS sh,
            b.higher_is_better AS hib
     FROM lab_results lr JOIN biomarkers b ON b.id = lr.biomarker_id
     ORDER BY b.slug, lr.collected_at, lr.created_at, lr.id`
  );
  const findings: Finding[] = [];
  const plausible = new Map<string, LabResultRow[]>();

  for (const r of rows) {
    const band = own(PHYSIOLOGIC_BANDS, r.slug);
    // Judged only in the band's own unit — a known unit difference is not a
    // typo, and the mapping layer already converts what it can.
    if (band && band.unit === r.unit && outside(r.value, band.low, band.high)) {
      findings.push({
        id: findingId('implausible', `lab|${r.id}`),
        kind: 'labs',
        check: 'implausible',
        severity: 'notice',
        subject: r.slug,
        headline:
          `${r.name} ${fmt(r.value)} ${r.unit} on ${r.collected_at} is outside what a body produces ` +
          `(${bandText(band.low, band.high)}); likely a unit or parse error`,
        since: r.collected_at,
        rows: [labRow(r, 'suspect')],
        numbers: { value: r.value, physiologicLow: band.low, physiologicHigh: band.high },
      });
      continue;
    }
    plausible.set(r.slug, [...(plausible.get(r.slug) ?? []), r]);
  }

  for (const [slug, results] of plausible) {
    // One value per draw date: a re-imported report is not a second draw (the
    // duplicate check raises it on its own).
    const byDate = new Map<string, LabResultRow>();
    for (const r of results) byDate.set(r.collected_at, r);
    const draws = [...byDate.values()];
    const latest = draws[draws.length - 1]!;
    const prev = draws.length > 1 ? draws[draws.length - 2]! : null;
    if (daysBetweenISO(latest.collected_at, today) > W.labMaxAgeDays) continue;
    const v = latest.value;
    const unit = latest.unit ? ` ${latest.unit}` : '';
    const prior = prev ? `; prior ${fmt(prev.value)} on ${prev.collected_at}` : '';
    const evidence = [labRow(latest, 'context'), ...(prev ? [labRow(prev, 'context')] : [])];
    const outStandard = outside(v, latest.sl, latest.sh);

    let range: Finding | null = null;
    if (outStandard) {
      range = {
        id: findingId('out-of-range', `${slug}|${latest.id}|standard`),
        kind: 'labs',
        check: 'out-of-range',
        severity: 'attention',
        subject: slug,
        headline: `${latest.name} ${fmt(v)}${unit} on ${latest.collected_at} is outside the lab's standard range (${bandText(latest.sl, latest.sh)})${prior}`,
        since: latest.collected_at,
        rows: evidence,
        numbers: {
          value: v,
          previous: prev?.value ?? null,
          range: 'standard',
          low: latest.sl,
          high: latest.sh,
        },
      };
    } else if (
      prev &&
      (latest.ol != null || latest.oh != null) &&
      outside(v, latest.ol, latest.oh) &&
      !outside(prev.value, latest.ol, latest.oh)
    ) {
      // Left optimal since the last draw. A marker that has sat outside
      // optimal for years is not news, so only the crossing is raised.
      range = {
        id: findingId('out-of-range', `${slug}|${latest.id}|optimal`),
        kind: 'labs',
        check: 'out-of-range',
        severity: 'notice',
        subject: slug,
        headline: `${latest.name} ${fmt(v)}${unit} on ${latest.collected_at} left ARC's optimal range (${bandText(latest.ol, latest.oh)})${prior}`,
        since: latest.collected_at,
        rows: evidence,
        numbers: {
          value: v,
          previous: prev.value,
          range: 'optimal',
          low: latest.ol,
          high: latest.oh,
        },
      };
    }
    if (range) findings.push(range);

    if (!prev || prev.value === 0) continue;
    const changePct = ((v - prev.value) / Math.abs(prev.value)) * 100;
    const cv = own(LAB_NOISE_CV_PCT, slug) ?? DEFAULT_LAB_CV_PCT;
    const rcv = t.labChangeZ * Math.SQRT2 * Math.sqrt(cv * cv + LAB_ANALYTIC_CV_PCT ** 2);
    if (Math.abs(changePct) <= rcv) continue;
    let worse: boolean;
    if (latest.hib === 0) worse = changePct > 0;
    else if (latest.hib === 1) worse = changePct < 0;
    else {
      // U-shaped: worse means further outside the band (optimal if ARC has
      // one, else the lab's). No band at all → no direction to judge.
      const hasOptimal = latest.ol != null || latest.oh != null;
      const low = hasOptimal ? latest.ol : latest.sl;
      const high = hasOptimal ? latest.oh : latest.sh;
      if (low == null && high == null) continue;
      worse = distance(v, low, high) > distance(prev.value, low, high);
    }
    if (!worse) continue;
    const moved = `${changePct > 0 ? 'rose' : 'fell'} ${fmt(Math.abs(changePct))}% between draws`;
    if (range) {
      // One marker, one line: the range finding already names both values, so
      // the worsening rides it rather than spending a second line in the block.
      range.headline += `; ${moved}, beyond its ${fmt(rcv)}% noise`;
      range.numbers.changePct = round1(changePct);
      range.numbers.referenceChangePct = round1(rcv);
      continue;
    }
    findings.push({
      id: findingId('worsened', `${slug}|${latest.id}`),
      kind: 'labs',
      check: 'worsened',
      severity: 'notice',
      subject: slug,
      headline:
        `${latest.name} ${moved} ` +
        `(${fmt(prev.value)} → ${fmt(v)}${unit}, ${prev.collected_at} → ${latest.collected_at}), ` +
        `beyond its ${fmt(rcv)}% noise`,
      since: latest.collected_at,
      rows: evidence,
      numbers: {
        value: v,
        previous: prev.value,
        changePct: round1(changePct),
        referenceChangePct: round1(rcv),
      },
    });
  }
  return findings;
}

// --- 4b. A symptom that persists ----------------------------------------------

function persistingSymptoms(db: Database, today: string, t: FindingThresholds): Finding[] {
  const windowDays = Math.max(t.symptomWindowDays, t.symptomDays);
  const windowFrom = shiftISODate(today, -(windowDays - 1));
  const rows = db.all<{ id: string; date: string; name: string; severity: number | null }>(
    `SELECT id, date, name, severity FROM symptoms WHERE date >= ? AND date <= ? ORDER BY date, id`,
    [shiftISODate(today, -W.symptomHistoryDays), today]
  );
  const byName = new Map<string, typeof rows>();
  for (const r of rows) byName.set(norm(r.name), [...(byName.get(norm(r.name)) ?? []), r]);
  const statusDays = statusDaysIn(db, windowFrom, today);
  // Two occurrences this close still belong to one episode — the widest gap a
  // run can have and still put N days inside M.
  const bridge = Math.max(1, windowDays - t.symptomDays + 1);

  const findings: Finding[] = [];
  for (const [name, entries] of byName) {
    const inWindow = entries.filter((e) => e.date >= windowFrom);
    const days = [...new Set(inWindow.map((e) => e.date))];
    if (days.length < t.symptomDays) continue;
    // The episode's first day, traced back through the history: stable for as
    // long as the episode continues, which is what keeps the id stable.
    const allDays = [...new Set(entries.map((e) => e.date))].sort();
    let start = allDays[allDays.length - 1]!;
    for (let i = allDays.length - 2; i >= 0; i--) {
      if (daysBetweenISO(allDays[i]!, start) > bridge) break;
      start = allDays[i]!;
    }
    const severities = inWindow.map((e) => e.severity).filter((s): s is number => s != null);
    const shown = inWindow[inWindow.length - 1]!.name;
    findings.push({
      id: findingId('persists', `symptom|${name}|${start}`),
      kind: 'record',
      check: 'persists',
      severity: 'attention',
      subject: `symptom:${name}`,
      headline:
        `${quote(shown)} logged on ${days.length} of the last ${windowDays} days (since ${start})` +
        (severities.length > 0 ? `; severity up to ${Math.max(...severities)}/10` : ''),
      since: start,
      rows: inWindow.slice(-7).map((e) => ({
        table: 'symptoms' as const,
        id: e.id,
        role: 'context' as const,
        date: e.date,
        label: `${e.name}${e.severity != null ? ` ${e.severity}/10` : ''}`,
        domain: 'captures' as const,
        domainId: e.id,
      })),
      numbers: {
        daysInWindow: days.length,
        windowDays,
        maxSeverity: severities.length > 0 ? Math.max(...severities) : null,
        statusDays: days.filter((d) => statusDays.has(d)).length,
      },
    });
  }
  return findings;
}

// --- Assembly -----------------------------------------------------------------

const SEVERITY_RANK: Record<FindingSeverity, number> = { attention: 0, notice: 1, info: 2 };

/**
 * Every finding the data supports right now, most serious first, then newest.
 * Reads only — see the module header.
 */
export function computeFindings(
  db: Database,
  now: Date = new Date(),
  thresholds: FindingThresholds = getFindingThresholds(db)
): Finding[] {
  const today = todayISODate(now);
  const findings = [
    ...labFindings(db, today, thresholds),
    ...persistingSymptoms(db, today, thresholds),
    ...vitalFindings(db, today, thresholds),
    ...weightGap(db, now, today, thresholds),
    ...mealGaps(db, today),
    ...duplicateMeals(db, today, thresholds),
    ...duplicateCaptures(db, today, thresholds),
    ...duplicateLabReports(db, thresholds),
    ...implausibleWeights(db, now, thresholds),
  ];
  return findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.since < b.since ? 1 : a.since > b.since ? -1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Re-derive one finding by id — what a proposal checks at approval time. Null
 * when the condition no longer holds (the duplicate was deleted, a weight was
 * logged), so a stale proposal refuses instead of acting on a fact that has
 * gone.
 */
export function findingById(db: Database, id: string, now: Date = new Date()): Finding | null {
  return computeFindings(db, now).find((finding) => finding.id === id) ?? null;
}

/** How many new findings the pass's block spells out before it counts the rest. */
export const PASS_FINDINGS_SHOWN = 6;

/**
 * The compact block the coach pass reads after its state block, and the ids it
 * spelled out (what `markPassRan` records as seen). Empty text when there is
 * nothing — the pass's context is then byte-identical to before.
 *
 * Findings an earlier pass already saw (`seen`, the ids `markPassRan` stored)
 * are COUNTED, not repeated: the pass has no memory of its last note beyond
 * the thread, and re-listing a standing duplicate every morning is how a
 * finding gets raised daily. The full set, rows and all, is in get_insights.
 */
export function findingsBlock(
  findings: Finding[],
  seen: ReadonlySet<string> = new Set()
): { text: string; shown: string[] } {
  if (findings.length === 0) return { text: '', shown: [] };
  const fresh = findings.filter((f) => !seen.has(f.id));
  const shown = fresh.slice(0, PASS_FINDINGS_SHOWN);
  const standing = findings.length - fresh.length;
  const lines = [
    'Findings (deterministic record and lab checks; facts, not advice, and nothing was changed):',
    ...shown.map((f) => `- ${f.severity}: ${f.headline} [${f.id}]`),
  ];
  const more = fresh.length - shown.length;
  if (more > 0) lines.push(`- and ${more} more`);
  if (standing > 0) {
    lines.push(
      `${fresh.length === 0 ? '' : 'Also '}${standing} raised at an earlier pass and still standing.`
    );
  }
  lines.push('Rows and numbers for each: get_insights › findings.');
  return { text: lines.join('\n'), shown: shown.map((f) => f.id) };
}

/** How many findings ride `get_insights` in full before the rest are counted. */
export const INSIGHTS_FINDINGS_MAX = 12;
