/**
 * Headless test of the experiment readout (src/lib/experiments/readout.ts)
 * against real SQLite via node:sqlite and the REAL migrations: the two equal
 * windows, the per-metric Welch gate, adherence of the intervention row,
 * status / timezone exclusions, the verdict-ready reasons, the reconciliation
 * with get_metric_series over the same days, the get_experiments payload, and
 * the snapshot stored with a conclusion. No model, no network.
 * Run: npm run db:test.
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { shiftISODate } from '../src/lib/db/date.ts';
import { createExperiment, getExperiment } from '../src/lib/db/repositories/experiments.ts';
import { startStatus } from '../src/lib/db/repositories/statuses.ts';
import { generateMissionForDay } from '../src/lib/db/repositories/mission-generate.ts';
import { setMissionStatus } from '../src/lib/db/repositories/mission.ts';
import { compareWindows, welchT } from '../src/lib/ai/stats.ts';
import { readMetricDays } from '../src/lib/ai/metric-catalog.ts';
import { DEFAULT_UNIT_PREFERENCES } from '../src/lib/user/types.ts';
import {
  ADHERENCE_FLOOR,
  attachReadoutNotes,
  experimentReadout,
  foldAdherenceDay,
  READOUT_MARKER,
  readoutWindows,
  splitReadoutNotes,
  summarizeAdherence,
} from '../src/lib/experiments/readout.ts';
import { toolByName } from '../src/lib/ai/tools/index.ts';

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass++;
  console.log(`  ok   ${n}`);
};
const bad = (n, e) => {
  fail++;
  console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

function makeDb(raw) {
  return {
    run: (sql, params = []) => {
      raw.prepare(sql).run(...params);
    },
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    transaction: (fn) => {
      raw.exec('BEGIN');
      try {
        fn();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = makeDb(raw);
  migrate(
    {
      exec: (sql) => raw.exec(sql),
      getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
      setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
      transaction: db.transaction,
    },
    MIGRATIONS
  );
  return db;
}

/** Local noon on a YYYY-MM-DD — clear of any day-boundary rule. */
const noonOf = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
};

const START = '2026-08-15';
const END = '2026-08-28'; // 14 days
const BASE_FROM = '2026-08-01';
const BASE_TO = '2026-08-14';
const AFTER = noonOf('2026-08-30'); // window closed

const days = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = shiftISODate(d, 1)) out.push(d);
  return out;
};
const NOISE = [-2, 1, 0, 2, -1, 1, -2, 0, 2, -1, 0, 1, -1, 2];

function wear(db, metric, unit, date, value) {
  db.run(
    `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device)
     VALUES (?, ?, ?, ?, ?, 'apple_watch')`,
    [randomUUID(), date, metric, value, unit]
  );
}
function weigh(db, date, kg) {
  db.run(`INSERT INTO body_metrics (id, measured_at, weight_kg) VALUES (?, ?, ?)`, [
    randomUUID(),
    `${date}T12:00:00.000Z`,
    kg,
  ]);
}
/** One intervention mission row on `date` (the shape mission-generate writes). */
function mark(db, expId, date, status, extra = {}) {
  db.run(`INSERT OR IGNORE INTO daily_logs (id, date) VALUES (?, ?)`, [randomUUID(), date]);
  const log = db.get(`SELECT id FROM daily_logs WHERE date = ?`, [date]);
  db.run(
    `INSERT INTO log_entries (id, daily_log_id, type, title, status, value)
     VALUES (?, ?, 'habit', 'intervention', ?, ?)`,
    [randomUUID(), log.id, status, JSON.stringify({ generated: true, experiment: expId, ...extra })]
  );
}
function experiment(db, metrics, startDate = START, durationDays = 14) {
  return createExperiment(db, {
    title: 'Magnesium PM',
    hypothesis: 'Magnesium lifts HRV',
    intervention: '400 mg magnesium at 21:00',
    metrics,
    startDate,
    durationDays,
  });
}
/** HRV baseline ~50, intervention ~50 + effect, same day-to-day noise. */
function seedHrv(db, effect, skip = new Set()) {
  days(BASE_FROM, BASE_TO).forEach((d, i) => skip.has(d) || wear(db, 'hrv', 'ms', d, 50 + NOISE[i]));
  days(START, END).forEach((d, i) => skip.has(d) || wear(db, 'hrv', 'ms', d, 50 + effect + NOISE[i]));
}
const metricOf = (readout, name) => readout.metrics.find((m) => m.metric === name);
const allDone = (db, id) => days(START, END).forEach((d) => mark(db, id, d, 'completed'));

console.log('1. windows: equal length, immediately before; clipped at today while running');
{
  const w = readoutWindows(START, END, '2026-08-30');
  check(
    w.baseline.from === BASE_FROM && w.baseline.to === BASE_TO && w.baseline.days === 14,
    'baseline is the 14 days immediately before the start'
  );
  check(w.intervention.to === END && w.intervention.days === 14, 'a closed window runs to end_date');
  const running = readoutWindows(START, END, '2026-08-20');
  check(
    running.intervention.to === '2026-08-20' && running.intervention.days === 6 && running.baseline.days === 14,
    'a running window is clipped at today; the baseline keeps the full planned length'
  );
  check(readoutWindows(START, END, '2026-08-10').intervention.days === 0, 'not started → 0 intervention days');
}

console.log('2. a clear effect: the gate is met, the inputs are complete, no verdict word');
{
  const db = freshDb();
  const id = experiment(db, ['HRV', 'mood']);
  seedHrv(db, 10);
  allDone(db, id);
  const r = experimentReadout(db, getExperiment(db, id), AFTER);
  const hrv = metricOf(r, 'HRV');
  check(hrv?.readable && hrv.series === 'hrv' && hrv.unit === 'ms', '"HRV" resolves to the hrv series in ms');
  check(hrv.baseline.n === 14 && hrv.intervention.n === 14, 'n is 14 a side', JSON.stringify(hrv));
  check(Math.abs(hrv.diff - 10) < 1e-9 && hrv.baseline.mean === 50.14 && hrv.intervention.mean === 60.14,
    'means and the difference are the arithmetic of the seeded days', JSON.stringify(hrv));
  check(hrv.gateMet === true && hrv.welch && hrv.welch.t >= hrv.welch.critical, 'Welch gate met: t ≥ critical');
  check(hrv.bar.pct === 5 && hrv.bar.minPerWindow === 5, 'held to TREND_GATES.hrv (5%, 5 a side)');
  const mood = metricOf(r, 'mood');
  check(mood && mood.readable === false, 'an unreadable watched metric is flagged, not invented');
  check(r.adherence.done === 14 && r.adherence.rate === 1, 'adherence 14 of 14');
  check(r.verdictReady === true && r.notReady.length === 0, 'verdict-ready, no reasons', JSON.stringify(r.notReady));
  check(
    !/supported|refuted|worked|no effect|improv|effective|success/i.test(JSON.stringify(r)),
    'the readout carries no verdict word'
  );
}

console.log('3. a null effect: the gate is not met, and that does not block readiness');
{
  const db = freshDb();
  const id = experiment(db, ['hrv']);
  seedHrv(db, 0);
  allDone(db, id);
  const r = experimentReadout(db, getExperiment(db, id), AFTER);
  const hrv = metricOf(r, 'hrv');
  check(hrv.gateMet === false && hrv.diff === 0, 'no difference → gate not met', JSON.stringify(hrv));
  check(r.verdictReady === true, 'a null result is still a readable result');
}

console.log('4. low adherence: below the floor is a reason, stated with its numbers');
{
  const db = freshDb();
  const id = experiment(db, ['hrv']);
  seedHrv(db, 10);
  days(START, END).forEach((d, i) => mark(db, id, d, i < 8 ? 'completed' : 'skipped'));
  const r = experimentReadout(db, getExperiment(db, id), AFTER);
  check(r.adherence.done === 8 && r.adherence.skipped === 6 && r.adherence.owed === 14, 'tally 8 done, 6 skipped');
  check(r.adherence.rate < ADHERENCE_FLOOR && r.verdictReady === false, 'under the floor → not ready');
  check(r.notReady.some((s) => s.includes('8 of 14 owed days') && s.includes('80%')), 'the reason names 8 of 14 and the floor',
    JSON.stringify(r.notReady));
  check(metricOf(r, 'hrv').gateMet === true, 'the metric numbers are still reported (the Coach judges)');
}

console.log('5. sparse data: too few readings, and too little coverage, are each a reason');
{
  const db = freshDb();
  const id = experiment(db, ['hrv']);
  const inter = days(START, END);
  seedHrv(db, 10, new Set(inter.slice(3))); // 3 intervention readings
  allDone(db, id);
  const r = experimentReadout(db, getExperiment(db, id), AFTER);
  check(metricOf(r, 'hrv').gateMet === null && metricOf(r, 'hrv').intervention.n === 3, 'n = 3 → untestable');
  check(r.notReady.some((s) => s.includes('3 intervention readings') && s.includes('5 a side')), 'reason names the shortfall',
    JSON.stringify(r.notReady));

  const db2 = freshDb();
  const id2 = experiment(db2, ['hrv']);
  seedHrv(db2, 10, new Set(inter.slice(6))); // 6 of 14
  allDone(db2, id2);
  const r2 = experimentReadout(db2, getExperiment(db2, id2), AFTER);
  check(r2.verdictReady === false && r2.notReady.some((s) => s.includes('6 of 14 usable intervention days')),
    'enough to test but 43% coverage → a coverage reason', JSON.stringify(r2.notReady));
}

console.log('6. a status-excused stretch leaves both windows and the adherence denominator');
{
  const db = freshDb();
  const id = experiment(db, ['hrv']);
  seedHrv(db, 10);
  startStatus(db, { label: 'sick', startDate: '2026-08-18', endDate: '2026-08-20', source: 'user', excuses: true });
  days(START, END).forEach((d) =>
    mark(db, id, d, d >= '2026-08-18' && d <= '2026-08-20' ? 'skipped' : 'completed')
  );
  const r = experimentReadout(db, getExperiment(db, id), AFTER);
  const hrv = metricOf(r, 'hrv');
  check(r.excludedBy.status === 3 && r.intervention.excluded === 3, 'three status days excluded', JSON.stringify(r.excludedBy));
  check(hrv.intervention.n === 11 && hrv.usable.intervention === 11, 'the metric reads 11 usable days');
  check(r.adherence.excused === 3 && r.adherence.owed === 11 && r.adherence.rate === 1,
    'the skipped sick days are excused, not missed', JSON.stringify(r.adherence));
  check(r.verdictReady === true, 'a forgiven stretch does not block readiness');
}

console.log('7. a timezone change: the marked days are excluded and excused');
{
  const db = freshDb();
  const id = experiment(db, ['hrv']);
  seedHrv(db, 10);
  allDone(db, id);
  db.run(`INSERT INTO timezone_changes (id, changed_at, from_offset_min, to_offset_min, from_local_date, to_local_date)
          VALUES ('out', '2026-08-05T07:00:00.000Z', -480, 60, '2026-08-05', '2026-08-05'),
                 ('back', '2026-08-07T07:00:00.000Z', 60, -480, '2026-08-07', '2026-08-07'),
                 ('trip', '2026-08-22T07:00:00.000Z', -480, -420, '2026-08-22', '2026-08-22'),
                 ('home', '2026-08-23T07:00:00.000Z', -420, -480, '2026-08-23', '2026-08-23')`);
  const r = experimentReadout(db, getExperiment(db, id), AFTER);
  const hrv = metricOf(r, 'hrv');
  const ex = new Set(r.excludedDates);
  check(['2026-08-05', '2026-08-07', '2026-08-22', '2026-08-23'].every((d) => ex.has(d)) && r.excludedBy['timezone-change'] === 4,
    'every marked day is excluded, by source', JSON.stringify(r));
  const exBase = r.excludedDates.filter((d) => d <= BASE_TO).length;
  const exIntv = r.excludedDates.filter((d) => d >= START).length;
  check(hrv.baseline.n === 14 - exBase && hrv.intervention.n === 14 - exIntv,
    'each window loses exactly its excluded days', JSON.stringify({ exBase, exIntv, hrv }));
  check(r.adherence.done === 14 && r.adherence.excused === 0, 'a completed day on a marked day stays done');
}

console.log('8. reconciles with get_metric_series over the same days');
{
  const db = freshDb();
  const id = experiment(db, ['hrv', 'weight', 'steps']);
  seedHrv(db, 10);
  days(BASE_FROM, BASE_TO).forEach((d, i) => {
    weigh(db, d, 80 + NOISE[i] / 10);
    wear(db, 'steps', 'count', d, 8000 + NOISE[i] * 100);
  });
  days(START, END).forEach((d, i) => {
    weigh(db, d, 79 + NOISE[i] / 10);
    wear(db, 'steps', 'count', d, 9000 + NOISE[i] * 100);
  });
  allDone(db, id);
  const r = experimentReadout(db, getExperiment(db, id), AFTER);
  const series = (metric, end) =>
    JSON.parse(toolByName('get_metric_series').execute(db, { metric, days: 14 }, { now: noonOf(end) }));
  for (const name of ['hrv', 'weight']) {
    const m = metricOf(r, name);
    const base = series(name, BASE_TO);
    const intv = series(name, END);
    check(base.stats.count === m.baseline.n && Math.abs(base.stats.avg - m.baseline.mean) < 0.051 &&
      intv.stats.count === m.intervention.n && Math.abs(intv.stats.avg - m.intervention.mean) < 0.051 &&
      base.unit === m.unit,
      `${name}: n, mean and unit match get_metric_series for both windows`,
      JSON.stringify({ base: base.stats, intv: intv.stats, m }));
  }
  // Steps accumulate: with the series' today on the window's last day, that
  // day is its `todaySoFar`, so reconcile against the points instead.
  const steps = metricOf(r, 'steps');
  const sp = series('steps', END).points.map((p) => p.value);
  check(sp.length === steps.intervention.n &&
    Math.abs(sp.reduce((a, b) => a + b, 0) / sp.length - steps.intervention.mean) < 0.01,
    'steps: the closed window counts every day get_metric_series lists');

  // Running: today's running total is held out, exactly as the series does.
  const now = noonOf('2026-08-20');
  const live = experimentReadout(db, getExperiment(db, id), now);
  const liveSteps = metricOf(live, 'steps');
  const liveSeries = series('steps', '2026-08-20');
  const liveDays = liveSeries.points.filter((p) => p.date >= START && !p.partial);
  check(liveSteps.todayHeldOut === true && liveSteps.intervention.n === liveDays.length && liveSteps.usable.intervention === 5,
    'mid-window, today’s steps are held out like the series holds them out', JSON.stringify(liveSteps));
  check(metricOf(live, 'hrv').intervention.n === 6, 'a level metric keeps today');

  const viaCatalog = readMetricDays(db, 'Resting HR', BASE_FROM, END, DEFAULT_UNIT_PREFERENCES);
  check(viaCatalog !== null && viaCatalog.metric === 'rhr' && viaCatalog.points.length === 0, '"Resting HR" resolves to rhr by exact alias, never fuzzily');
  // "sleep score" became a real metric with the Garmin link (sleep_score), so the
  // unreadable example is a name nothing in ARC records.
  check(readMetricDays(db, 'focus score', BASE_FROM, END, DEFAULT_UNIT_PREFERENCES) === null, '"focus score" is unreadable');
  const sleepScore = readMetricDays(db, 'sleep score', BASE_FROM, END, DEFAULT_UNIT_PREFERENCES);
  check(sleepScore !== null && sleepScore.metric === 'sleep_score', '"sleep score" resolves to Garmin\'s sleep_score');
}

console.log('9. adherence fold: precedence, tombstones, excusal; the ledger sums');
{
  check(foldAdherenceDay([{ status: 'skipped', removed: true }], false, false) === 'removed', 'a tombstone alone → removed');
  check(foldAdherenceDay([{ status: 'skipped', removed: true }, { status: 'completed', removed: false }], false, false) === 'done',
    'a completion anywhere on the day wins');
  check(foldAdherenceDay([{ status: 'pending', removed: false }], false, false) === 'untouched', 'pending on a settled day → untouched');
  check(foldAdherenceDay([{ status: 'pending', removed: false }], true, true) === 'open', 'today stays open even when excused');
  check(foldAdherenceDay([], false, true) === 'excused' && foldAdherenceDay([], false, false) === 'noRow', 'no row: excused or noRow');
  check(foldAdherenceDay([{ status: 'partial', removed: false }], false, true) === 'partial', 'excusal never touches what was done');
  const a = summarizeAdherence(['done', 'partial', 'skipped', 'untouched', 'removed', 'noRow', 'excused', 'open']);
  check(a.done + a.partial + a.skipped + a.untouched + a.removed + a.noRow + a.excused + a.open === a.days &&
    a.owed === 6 && a.rate === 0.17, 'every state counted once; owed = days − excused − open', JSON.stringify(a));

  // The REAL generator writes the key this reads.
  const db = freshDb();
  const id = experiment(db, ['hrv'], '2026-08-15', 7);
  generateMissionForDay(db, '2026-08-15');
  generateMissionForDay(db, '2026-08-16');
  const row = db.get(`SELECT e.id FROM log_entries e JOIN daily_logs d ON d.id = e.daily_log_id
                       WHERE d.date = '2026-08-15' AND json_extract(e.value, '$.experiment') = ?`, [id]);
  setMissionStatus(db, row.id, 'completed', '2026-08-15');
  const r = experimentReadout(db, getExperiment(db, id), noonOf('2026-08-16'));
  check(r.adherence.done === 1 && r.adherence.open === 1 && r.adherence.days === 2,
    'a generated intervention row is counted: yesterday done, today open', JSON.stringify(r.adherence));
  check(r.notReady.some((s) => s.startsWith('The window is open: day 2 of 7')), 'a running window says so');
}

console.log('10. Welch: compareWindows decides on exactly the reported t and bar');
{
  const rng = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rand = rng(7);
  let agree = true;
  for (let k = 0; k < 200; k++) {
    const a = Array.from({ length: 5 + (k % 9) }, () => 50 + rand() * 10 + (k % 3));
    const b = Array.from({ length: 6 + (k % 7) }, () => 50 + rand() * 10);
    const c = compareWindows(a, b, 3, 3);
    const w = welchT(a, b);
    const practical = Math.abs(c.changePct) >= 3;
    if (c.significant !== (practical && w.t >= w.critical)) agree = false;
  }
  check(agree, 'over 200 random pairs, significant === practical && t ≥ critical');
  check(welchT([5, 5, 5], [6, 6, 6]) === null && compareWindows([6, 6, 6], [5, 5, 5], 5, 3).significant === true,
    'zero variance: no t, and the practical bar alone decides (unchanged)');
}

console.log('11. get_experiments carries the readout; its size is measured');
{
  const db = freshDb();
  const id = experiment(db, ['HRV', 'steps', 'weight', 'mood']);
  seedHrv(db, 10);
  allDone(db, id);
  const out = toolByName('get_experiments').execute(db, {}, { now: AFTER });
  const view = JSON.parse(out);
  const a = view.active[0];
  check(a.ready === true && a.readout && a.readout.v === 1 && a.readout.metrics.length === 4,
    'each active experiment carries its readout');
  check(['baseline', 'intervention', 'adherence', 'excludedBy', 'excludedDates', 'verdictReady', 'notReady'].every((k) => k in a.readout),
    'the readout has its windows, adherence, exclusions and readiness');
  const bytes = Buffer.byteLength(JSON.stringify(a.readout));
  console.log(`     (readout for 4 watched metrics: ${bytes} bytes; whole result ${Buffer.byteLength(out)} bytes)`);
  check(bytes < 2500, `the readout stays compact (${bytes} < 2,500 bytes)`);
  const schema = JSON.stringify(toolByName('get_experiments').inputSchema);
  check(schema === '{"type":"object","properties":{"include_completed":{"type":"boolean"}},"additionalProperties":false}',
    'the tool schema is unchanged — the readout rides the result, not the prefix');
}

console.log('12. concluding stores the readout of that moment with the verdict');
{
  const db = freshDb();
  const id = experiment(db, ['hrv', 'mood']);
  seedHrv(db, 10);
  allDone(db, id);
  const edit = toolByName('edit_record');
  const expected = experimentReadout(db, getExperiment(db, id), AFTER);
  edit.execute(db, { domain: 'experiments', id, fields: {
    status: 'concluded', conclusion: 'HRV rose ~10 ms; supported', outcome_notes: 'Steady from day 3.' } }, { now: AFTER });
  const row = getExperiment(db, id);
  const split = splitReadoutNotes(row.outcome_notes);
  check(row.status === 'completed' && row.outcome_notes.includes(READOUT_MARKER), 'outcome_notes carries the marker');
  check(split.notes === 'Steady from day 3.', 'the Coach’s words survive in front of it');
  check(JSON.stringify(split.readout) === JSON.stringify(expected), 'the stored readout is the readout at that moment');

  // The evidence does not move afterwards.
  wear(db, 'hrv', 'ms', '2026-08-16', 200);
  const later = JSON.parse(toolByName('get_experiments').execute(db, { include_completed: true }, { now: AFTER }));
  const c = later.completed[0];
  check(c.readoutAtConclusion && JSON.stringify(c.readoutAtConclusion) === JSON.stringify(expected),
    'get_experiments returns the stored numbers, not a recomputation');

  const db2 = freshDb();
  const id2 = experiment(db2, ['hrv']);
  edit.execute(db2, { domain: 'experiments', id: id2, fields: { status: 'concluded', conclusion: 'x' } }, { now: AFTER });
  const s2 = splitReadoutNotes(getExperiment(db2, id2).outcome_notes);
  check(s2.notes === null && s2.readout?.v === 1, 'with no prose, the notes split back to null and the readout');

  check(splitReadoutNotes('plain prose').readout === null && splitReadoutNotes('plain prose').notes === 'plain prose',
    'legacy prose reads back untouched');
  const broken = `words\n\n${READOUT_MARKER}\n{not json`;
  check(splitReadoutNotes(broken).notes === broken, 'an unparseable tail is kept, never silently dropped');
  check(splitReadoutNotes(attachReadoutNotes(null, expected)).readout.asOf === expected.asOf, 'attach/split round-trips');

  // Abandoning stores no numbers: there is no verdict to cite them.
  const db3 = freshDb();
  const id3 = experiment(db3, ['hrv']);
  edit.execute(db3, { domain: 'experiments', id: id3, fields: { status: 'abandoned', reason: 'got sick' } }, { now: AFTER });
  check(getExperiment(db3, id3).outcome_notes === 'got sick', 'abandon keeps its reason verbatim');
}

console.log('13. east of UTC: a weigh-in is filed under its own local day (Pacific/Auckland)');
{
  const tzBefore = process.env.TZ;
  process.env.TZ = 'Pacific/Auckland';
  try {
    const offset = new Date(2026, 7, 15, 7, 0, 0).getTimezoneOffset();
    check(offset === -720, 'TZ=Pacific/Auckland took effect (NZST, UTC+12), so this is not vacuous', offset);
    const db = freshDb();
    // A 07:00 local weigh-in every day — 19:00 UTC the day BEFORE. 82 kg before
    // the start day, 80 kg from it on.
    days(BASE_FROM, END).forEach((d) => {
      const [y, m, dd] = d.split('-').map(Number);
      db.run(`INSERT INTO body_metrics (id, measured_at, weight_kg) VALUES (?, ?, ?)`, [
        randomUUID(),
        new Date(y, m - 1, dd, 7, 0, 0).toISOString(),
        d < START ? 82 : 80,
      ]);
    });
    const id = experiment(db, ['weight']);
    const r = experimentReadout(db, getExperiment(db, id), noonOf('2026-08-30'));
    const w = metricOf(r, 'weight');
    // Reported in the default display unit, lb: 82 kg → 180.8, 80 kg → 176.4.
    check(w.baseline.n === 14 && w.baseline.mean === 180.8 && w.intervention.n === 14 && w.intervention.mean === 176.4,
      'the start day’s reading is the intervention’s, not the baseline’s', JSON.stringify(w));
    const series = (end) =>
      JSON.parse(toolByName('get_metric_series').execute(db, { metric: 'weight', days: 14 }, { now: noonOf(end) }));
    const base = series(BASE_TO);
    const intv = series(END);
    check(base.stats.count === 14 && base.stats.avg === 180.8 && base.points[0].date === BASE_FROM &&
      intv.stats.count === 14 && intv.stats.avg === 176.4 && intv.points.at(-1).date === END,
      'get_metric_series files the same readings under the same local days', JSON.stringify({ base: base.stats, intv: intv.stats }));
    check(base.stats.count === w.baseline.n && base.stats.avg === w.baseline.mean &&
      intv.stats.count === w.intervention.n && intv.stats.avg === w.intervention.mean,
      'and the readout still equals it, window for window');
  } finally {
    if (tzBefore === undefined) delete process.env.TZ;
    else process.env.TZ = tzBefore;
  }
}

console.log('14. HRV status is a category: counted, never averaged, never read as numbers');
{
  const db = freshDb();
  const codes = [4, 3, 4, 2, 4];
  days(BASE_FROM, END).forEach((d, i) => {
    db.run(
      `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device, source_raw_id)
       VALUES (?, ?, 'hrv_status', ?, 'code', 'garmin', ?)`,
      [randomUUID(), d, codes[i % 5], `gp:hrv_status:${d}`]
    );
  });
  seedHrv(db, 10);
  const s = JSON.parse(toolByName('get_metric_series').execute(db, { metric: 'hrv_status', days: 14 }, { now: noonOf(END) }));
  const count = (word) => s.counts?.find((c) => c.status === word)?.days;
  check(s.stats === null && s.counts?.length === 4 && count('Balanced') + count('Unbalanced') + count('Low') === 14 &&
    count('Poor') === 0,
    'get_metric_series: no min/avg/max, days per status with the status words', JSON.stringify(s));
  check(s.points.every((p) => typeof p.status === 'string') && s.points.find((p) => p.value === 2)?.status === 'Low',
    'each day carries its status word');
  check(readMetricDays(db, 'hrv_status', BASE_FROM, END, DEFAULT_UNIT_PREFERENCES) === null,
    'readMetricDays refuses it — a status code has no mean to compare');
  const id = experiment(db, ['hrv_status', 'hrv']);
  allDone(db, id);
  const r = experimentReadout(db, getExperiment(db, id), AFTER);
  check(metricOf(r, 'hrv_status').readable === false && metricOf(r, 'hrv').readable === true &&
    metricOf(r, 'hrv').intervention.n === 14,
    'an experiment watching it reads it qualitatively; HRV beside it is untouched');
  const h = JSON.parse(toolByName('get_metric_series').execute(db, { metric: 'hrv', days: 14 }, { now: noonOf(END) }));
  check(h.stats?.count === 14 && h.counts === undefined && h.points.every((p) => p.status === undefined),
    'hrv itself keeps its min/avg/max and gains nothing');

  // create_experiment's warning asks the catalog, so it is true of every name.
  const made = JSON.parse(toolByName('create_experiment').execute(db, {
    name: 'Garmin watch', hypothesis: 'h', intervention: 'i', duration_days: 14,
    metrics: ['sleep score', 'Body Battery wake', 'stress_avg', 'HRV', 'hrv_status', 'focus score'],
  }, { now: AFTER }));
  check(JSON.stringify(made.unreadableMetrics) === JSON.stringify(['hrv_status', 'focus score']),
    'create_experiment: Garmin’s numeric metrics are readable; the status code and an unknown name are flagged',
    JSON.stringify(made));
  for (const name of ['sleep score', 'Body Battery wake', 'stress_avg']) {
    check(readMetricDays(db, name, BASE_FROM, END, DEFAULT_UNIT_PREFERENCES) !== null,
      `"${name}" — the note's "readable" is readMetricDays' readable`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
