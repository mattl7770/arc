/**
 * Headless test of the Reports feature (docs/reports-subapp.md §10) against
 * real SQLite via node:sqlite. Mirrors db/export.test.mjs; op-sqlite and Expo
 * are never loaded.
 *
 * What this suite is FOR: the honesty rules are testable contracts, and this is
 * where they are enforced rather than hoped for —
 *
 *   - the adherence ledger SUMS, on every row and in the totals;
 *   - excused counts match the day's own mode, per day;
 *   - nutrition averages exclude un-priced days AND count the exclusion;
 *   - the recovery gate is `insights.ts`'s own object, not a copy;
 *   - the labs section is ABSENT when no draw falls in-period;
 *   - the doctor pack shows only measured markers, plus the coverage line;
 *   - no blood pressure and no BMI are claimed;
 *   - the self-review never carries `full_name` (⚑ MATT #3);
 *   - the render carries key figures VERBATIM and the authored empties;
 *   - the render contains no `undefined`, `NaN` or `[object`;
 *   - the same input renders identical bytes;
 *   - a persisted report re-renders from `data_json` byte-for-byte, and
 *     `narrative_text` never enters that blob.
 *
 * **Fixtures, not golden files** (spec §4). A byte-golden HTML churns on every
 * copy edit and says nothing useful when it fails; asserting the key figures
 * verbatim says exactly what broke.
 *
 * Run: node --import ./db/register-ts-hooks.mjs db/reports.test.mjs
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { newId } from '../src/lib/db/id.ts';
import { TREND_GATES } from '../src/lib/ai/insights.ts';
import { createProtocolWithVersion } from '../src/lib/db/repositories/protocols.ts';
import { updateProfile } from '../src/lib/db/repositories/user.ts';
import { addScreening } from '../src/lib/db/repositories/screenings.ts';
import { createExperiment } from '../src/lib/db/repositories/experiments.ts';
import { setNutritionTargets } from '../src/lib/db/repositories/nutrition.ts';
import {
  deleteReport,
  getReport,
  getReportSnapshot,
  insertReport,
  listReports,
  readNarrative,
} from '../src/lib/db/repositories/reports.ts';
import {
  formatDate,
  formatRange,
  lastCalendarMonth,
  lastCompleteWeek,
  periodFromBounds,
  priorEqualWindow,
  todayNote,
  validateCustomRange,
  MAX_CUSTOM_RANGE_DAYS,
} from '../src/lib/reports/period.ts';
import { assembleSelfReview } from '../src/lib/reports/assemble-self-review.ts';
import { assembleDoctorPack } from '../src/lib/reports/assemble-doctor-pack.ts';
import { escapeHtml, renderReportHtml, reportFileName } from '../src/lib/reports/render-html.ts';
import { COACH_READ_ATTRIBUTION } from '../src/lib/reports/coach-read.ts';

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
const is = (name, actual, expected) =>
  actual === expected
    ? ok(name)
    : bad(name, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
const yes = (name, condition, detail) => (condition ? ok(name) : bad(name, detail));

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
  return { raw, db };
}

// A Wednesday, so "last complete week" is unambiguous and never today's.
const NOW = new Date(2026, 7, 12, 10, 30, 0); // 2026-08-12 local
const PERIOD = periodFromBounds('custom', '2026-08-01', '2026-08-07', NOW);

/**
 * Plant a HISTORICAL day_modes row. The Modes feature's writers retired with
 * the feature (2026-08-25); reports still resolve these rows per past day, so
 * the excusal ledger below is exercised against rows a real device holds.
 */
let modeSeq = 0;
function insertDayMode(db, { mode, startDate, endDate = null }) {
  db.run(
    `INSERT INTO day_modes (id, mode, start_date, end_date, label, note)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
    [`rep-dm-${++modeSeq}`, mode, startDate, endDate]
  );
}

/** Add a daily_log + one protocol log entry with a given status. */
function logEntry(db, date, protocolId, status, title = 'Creatine') {
  let log = db.get('SELECT id FROM daily_logs WHERE date = ?', [date]);
  if (!log) {
    const id = newId(db);
    db.run('INSERT INTO daily_logs (id, date) VALUES (?, ?)', [id, date]);
    log = { id };
  }
  db.run(
    `INSERT INTO log_entries (id, daily_log_id, type, protocol_id, title, status)
     VALUES (?, ?, 'supplement', ?, ?, ?)`,
    [newId(db), log.id, protocolId, title, status]
  );
}

function addMeal(db, date, kcal, protein) {
  const id = newId(db);
  db.run(`INSERT INTO meals (id, date, name, kcal, protein_g) VALUES (?, ?, 'Meal', ?, ?)`, [
    id,
    date,
    kcal,
    protein,
  ]);
  return id;
}

function addWearable(db, date, metricType, value, unit = 'ms', device = 'apple_health') {
  db.run(
    `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId(db), date, metricType, value, unit, device]
  );
}

function addBody(db, date, weightKg) {
  db.run(`INSERT INTO body_metrics (id, measured_at, weight_kg) VALUES (?, ?, ?)`, [
    newId(db),
    `${date}T12:00:00.000Z`,
    weightKg,
  ]);
}

// ============================================================================
console.log('1. period.ts — the calendar, and the cap');
{
  // 2026-08-12 is a Wednesday; the last COMPLETE Monday-week is Aug 3–9.
  const week = lastCompleteWeek(NOW);
  is('lastCompleteWeek starts Monday', week.start, '2026-08-03');
  is('lastCompleteWeek ends Sunday', week.end, '2026-08-09');
  is('…is 7 days', week.days, 7);
  is('…does not include today', week.includesToday, false);
  is('…prior window is the 7 days before', week.prior.start, '2026-07-27');
  is('…prior window ends the day before', week.prior.end, '2026-08-02');

  // A Monday must still get the PREVIOUS week, not the two-hours-old one.
  const monday = lastCompleteWeek(new Date(2026, 7, 10, 9, 0, 0));
  is('on a Monday, last week is still the finished one', monday.start, '2026-08-03');

  const month = lastCalendarMonth(NOW);
  is('lastCalendarMonth starts on the 1st', month.start, '2026-07-01');
  is('…ends on the last day', month.end, '2026-07-31');
  is('…is labelled by name', month.label, 'July 2026');
  is('…prior window is 31 days back', month.prior.start, '2026-05-31');

  // Month-length arithmetic must come from the calendar, not a table.
  const march = lastCalendarMonth(new Date(2024, 2, 15));
  is('February 2024 (leap) ends on the 29th', march.end, '2024-02-29');
  const january = lastCalendarMonth(new Date(2026, 0, 15));
  is('January rolls back across the year boundary', january.start, '2025-12-01');

  const prior = priorEqualWindow('2026-08-01', '2026-08-07');
  is('priorEqualWindow is the same length', prior.start, '2026-07-25');
  is('…and abuts the period', prior.end, '2026-07-31');

  const good = validateCustomRange('2026-07-01', '2026-07-31', NOW);
  yes('a sane custom range validates', good.ok === true);
  const backwards = validateCustomRange('2026-07-31', '2026-07-01', NOW);
  yes('a reversed range is rejected', backwards.ok === false);
  const future = validateCustomRange('2026-08-01', '2026-09-01', NOW);
  yes('a range ending in the future is rejected', future.ok === false);
  yes(
    '…and says which date has not happened',
    future.ok === false && future.message.includes('1 Sep 2026'),
    future.ok === false ? future.message : ''
  );
  const tooLong = validateCustomRange('2024-01-01', '2026-08-01', NOW);
  yes('a range past the cap is rejected', tooLong.ok === false);
  yes(
    `…and names the ${MAX_CUSTOM_RANGE_DAYS}-day cap`,
    tooLong.ok === false && tooLong.message.includes(String(MAX_CUSTOM_RANGE_DAYS))
  );
  const nonsense = validateCustomRange('2026-02-30', '2026-03-05', NOW);
  yes('a date that does not exist is rejected', nonsense.ok === false);
  const endsToday = validateCustomRange('2026-08-06', '2026-08-12', NOW);
  yes(
    'a range ending today is allowed and MARKED',
    endsToday.ok === true && endsToday.period.includesToday === true
  );

  is('formatDate drops the leading zero', formatDate('2026-08-03'), '3 Aug 2026');
  is('formatRange says the month once', formatRange('2026-08-03', '2026-08-09'), '3 – 9 Aug 2026');
  is(
    'formatRange spells both ends across a year',
    formatRange('2025-12-30', '2026-01-02'),
    '30 Dec 2025 – 2 Jan 2026'
  );
  yes(
    'periodFromBounds rejects a malformed range',
    periodFromBounds('custom', 'nope', 'x') === null
  );
}

// ============================================================================
console.log('2. The adherence ledger SUMS, and the mode decides `excused`');
{
  const { db } = freshDb();
  const protocolId = createProtocolWithVersion(
    db,
    { name: 'Morning stack', type: 'supplement_stack' },
    { items: [{ title: 'Creatine', scheduled_time: '07:00', dose: '5 g', notes: null }] }
  );

  // Aug 1–7. Two skips land on a Travel day (excused) and two on normal days.
  insertDayMode(db, { mode: 'travel', startDate: '2026-08-04', endDate: '2026-08-05' });
  logEntry(db, '2026-08-01', protocolId, 'completed');
  logEntry(db, '2026-08-02', protocolId, 'completed');
  logEntry(db, '2026-08-03', protocolId, 'partial');
  logEntry(db, '2026-08-04', protocolId, 'skipped'); // Travel → excused
  logEntry(db, '2026-08-05', protocolId, 'skipped'); // Travel → excused
  logEntry(db, '2026-08-06', protocolId, 'skipped'); // normal → missed
  logEntry(db, '2026-08-07', protocolId, 'pending'); // never answered

  const report = assembleSelfReview(db, PERIOD, { now: NOW, appVersion: '0.2.0' });
  const row = report.adherence.rows[0];
  const totals = report.adherence.totals;

  is('planned counts every entry', row.planned, 7);
  is('completed', row.completed, 2);
  is('partial', row.partial, 1);
  is('skipped (accountable)', row.skipped, 1);
  is('excused (Travel days)', row.excused, 2);
  is('unmarked (still pending)', row.unmarked, 1);
  is(
    'THE LEDGER SUMS',
    row.completed + row.partial + row.skipped + row.excused + row.unmarked,
    row.planned
  );
  is(
    'the totals row sums too',
    totals.completed + totals.partial + totals.skipped + totals.excused + totals.unmarked,
    totals.planned
  );
  // Accountable = 7 − 2 excused = 5; completed 2 → 40%.
  is('completion is over ACCOUNTABLE items', row.completionLabel, '40%');
  yes(
    'the mode ledger names the excusing days',
    report.adherence.modeNote != null && report.adherence.modeNote.includes('Travel'),
    String(report.adherence.modeNote)
  );
  yes(
    'the reconciliation is stated in words',
    report.adherence.reconciliation != null &&
      report.adherence.reconciliation.includes('equals planned')
  );

  // TODAY IS NOT A MISS. A custom range that reaches today must not score the
  // hours the user has not lived yet: today's still-`pending` mission items are
  // an unfinished day, not an unmarked failure. Adherence accumulates through a
  // day exactly like training minutes do, so it clips to the same `accEnd`.
  {
    const { db: today } = freshDb();
    const p = createProtocolWithVersion(
      today,
      { name: 'Morning stack', type: 'supplement_stack' },
      { items: [] }
    );
    logEntry(today, '2026-08-11', p, 'completed'); // yesterday, answered
    logEntry(today, '2026-08-12', p, 'pending'); // TODAY, not yet answered
    logEntry(today, '2026-08-12', p, 'pending');
    const toToday = periodFromBounds('custom', '2026-08-10', '2026-08-12', NOW);
    is('the period is marked as reaching today', toToday.includesToday, true);
    yes(
      '…and carries the authored note naming the adherence ledger',
      String(todayNote(toToday)).includes('adherence ledger'),
      String(todayNote(toToday))
    );
    const partial = assembleSelfReview(today, toToday, { now: NOW });
    is('today’s pending items are NOT counted as unmarked', partial.adherence.rows[0].unmarked, 0);
    is('…only the finished days are scored', partial.adherence.rows[0].planned, 1);
    is('…and the completed one counts', partial.adherence.rows[0].completed, 1);
    yes(
      '…and the provenance says the range was clipped',
      partial.adherence.provenance.range.includes('complete days only'),
      partial.adherence.provenance.range
    );
  }

  // A day whose mode does NOT excuse must count the skip as a miss.
  const { db: db2 } = freshDb();
  const p2 = createProtocolWithVersion(
    db2,
    { name: 'Deload block', type: 'training_block' },
    { items: [] }
  );
  insertDayMode(db2, { mode: 'deload', startDate: '2026-08-01', endDate: '2026-08-07' });
  logEntry(db2, '2026-08-02', p2, 'skipped');
  const deload = assembleSelfReview(db2, PERIOD, { now: NOW });
  is('Deload does NOT excuse a skip', deload.adherence.rows[0].excused, 0);
  is('…it is a miss', deload.adherence.rows[0].skipped, 1);
  is(
    'and the ledger still sums',
    deload.adherence.rows[0].completed +
      deload.adherence.rows[0].partial +
      deload.adherence.rows[0].skipped +
      deload.adherence.rows[0].excused +
      deload.adherence.rows[0].unmarked,
    deload.adherence.rows[0].planned
  );
}

// ============================================================================
console.log('3. Nutrition — averages exclude un-priced days AND count them');
{
  const { db } = freshDb();
  setNutritionTargets(db, { effective_date: '2026-07-01', kcal: 2400, protein_g: 180 });
  addMeal(db, '2026-08-01', 2000, 150);
  addMeal(db, '2026-08-02', 2200, 170);
  // A day with a meal whose kcal was never recorded — honest as a ledger row,
  // dishonest as a term in an average.
  db.run(
    `INSERT INTO meals (id, date, name, protein_g) VALUES (?, '2026-08-03', 'Dinner out', 40)`,
    [newId(db)]
  );

  const report = assembleSelfReview(db, PERIOD, { now: NOW });
  const kcal = report.nutrition.figures.find((f) => f.label === 'Energy');
  const protein = report.nutrition.figures.find((f) => f.label === 'Protein');

  is('days-logged is stated FIRST', report.nutrition.coverageLine, '3 of 7 days logged.');
  is('kcal averages only the two complete days', kcal.value, '2,100');
  yes('…and says how many it averaged', kcal.note.includes('2 days averaged'), kcal.note);
  // Protein IS recorded on all three days, so its average legitimately uses all
  // three — the guard is PER METRIC, exactly as remaining.ts computes it.
  is('protein averages all three days (all recorded)', protein.value, '120');
  yes(
    'the exclusion is counted in prose',
    report.nutrition.exclusionNote != null &&
      report.nutrition.exclusionNote.includes('1 logged day'),
    String(report.nutrition.exclusionNote)
  );
  yes(
    'targets are read as of the period end, not today',
    report.nutrition.targetNote.includes('7 Aug 2026'),
    report.nutrition.targetNote
  );

  const { db: empty } = freshDb();
  const none = assembleSelfReview(empty, PERIOD, { now: NOW });
  is(
    'an unlogged period says so',
    none.nutrition.empty,
    'No meals logged this period, so there is nothing to average.'
  );
  yes('…and prints no figures', none.nutrition.figures.length === 0);
  yes(
    '…and still states the coverage',
    none.nutrition.coverageLine === '0 of 7 days logged.',
    none.nutrition.coverageLine
  );
}

// ============================================================================
console.log('4. Recovery — the significance gate is insights.ts’s own');
{
  const { db } = freshDb();
  // Prior window (Jul 25–31): a flat 50 ms. Period (Aug 1–7): a flat 50 ms.
  for (let d = 25; d <= 31; d++) addWearable(db, `2026-07-${d}`, 'hrv', 50);
  for (let d = 1; d <= 7; d++) addWearable(db, `2026-08-0${d}`, 'hrv', 50);
  const flat = assembleSelfReview(db, PERIOD, { now: NOW });
  const flatRow = flat.recovery.rows.find((r) => r.metric === 'HRV');
  is('a flat comparison is not significant', flatRow.significant, false);
  is('…and says so in the reader’s words', flatRow.verdict, 'Within your normal variation.');
  yes('…and names NO direction', !/\bUp\b|\bDown\b/.test(flatRow.verdict), flatRow.verdict);

  // A genuinely large, low-variance move clears both bars.
  const { db: db2 } = freshDb();
  for (let d = 25; d <= 31; d++) addWearable(db2, `2026-07-${d}`, 'hrv', 50 + (d % 2));
  for (let d = 1; d <= 7; d++) addWearable(db2, `2026-08-0${d}`, 'hrv', 30 + (d % 2));
  const moved = assembleSelfReview(db2, PERIOD, { now: NOW });
  const movedRow = moved.recovery.rows.find((r) => r.metric === 'HRV');
  is('a real move IS significant', movedRow.significant, true);
  yes('…and names the direction', movedRow.verdict.startsWith('Down'), movedRow.verdict);

  // Below insights.ts's own minimum for HRV, nothing may be claimed.
  const { db: db3 } = freshDb();
  for (let d = 1; d <= 3; d++) addWearable(db3, `2026-08-0${d}`, 'hrv', 30);
  for (let d = 29; d <= 31; d++) addWearable(db3, `2026-07-${d}`, 'hrv', 60);
  const thin = assembleSelfReview(db3, PERIOD, { now: NOW });
  const thinRow = thin.recovery.rows.find((r) => r.metric === 'HRV');
  is('a halved average below the minimum is NOT significant', thinRow.significant, false);
  yes(
    '…and the verdict names the bar the engine uses',
    thinRow.verdict.includes(String(TREND_GATES.hrv.minPerWindow)),
    thinRow.verdict
  );
  is('the gate object is insights.ts’s HRV bar', TREND_GATES.hrv.thresholdPct, 5);
  is('…and its minimum per window', TREND_GATES.hrv.minPerWindow, 5);
}

// ============================================================================
console.log('5. Labs in-period are ABSENT by rule, and the self-review has no name');
{
  const { db } = freshDb();
  updateProfile(db, {
    fullName: 'Matt Lawrence',
    dateOfBirth: '1990-04-11',
    biologicalSex: 'male',
  });
  const noLabs = assembleSelfReview(db, PERIOD, { now: NOW });
  is('no draw in-period → the section is absent entirely', noLabs.labs, null);

  const serialized = JSON.stringify(noLabs);
  yes(
    'the self-review never carries full_name (⛑ MATT #3)',
    !serialized.includes('Matt Lawrence'),
    'the name appeared in the serialized self-review'
  );

  // A draw inside the period brings the section back.
  const reportId = newId(db);
  db.run(`INSERT INTO lab_reports (id, collected_at) VALUES (?, '2026-08-04')`, [reportId]);
  const marker = db.get(`SELECT id FROM biomarkers ORDER BY slug LIMIT 1`);
  if (marker) {
    db.run(
      `INSERT INTO lab_results (id, biomarker_id, report_id, value, collected_at)
       VALUES (?, ?, ?, 999, '2026-08-04')`,
      [newId(db), marker.id, reportId]
    );
  }
  const withLabs = assembleSelfReview(db, PERIOD, { now: NOW });
  yes('a draw in-period brings the section back', withLabs.labs != null);
  yes(
    '…and it names the draw date',
    withLabs.labs.draws.some((d) => d.includes('4 Aug 2026')),
    JSON.stringify(withLabs.labs?.draws)
  );
}

// ============================================================================
console.log('6. Doctor pack — measured markers only, no BP, no BMI');
{
  const { db } = freshDb();
  updateProfile(db, {
    fullName: 'Matt Lawrence',
    dateOfBirth: '1990-04-11',
    biologicalSex: 'male',
  });
  createProtocolWithVersion(
    db,
    { name: 'Evening stack', type: 'supplement_stack' },
    {
      items: [
        { title: 'Magnesium glycinate', scheduled_time: '21:00', dose: '400 mg', notes: null },
      ],
    }
  );
  // Decennial, last done 2010 → next due 2020-01-01, which is overdue as of NOW.
  addScreening(db, {
    name: 'Colonoscopy',
    category: 'exam',
    intervalMonths: 120,
    lastCompleted: '2010-01-01',
  });
  addWearable(db, '2026-08-11', 'rhr', 52, 'bpm');
  addBody(db, '2026-08-01', 80);

  const reportId = newId(db);
  db.run(`INSERT INTO lab_reports (id, collected_at) VALUES (?, '2026-06-01')`, [reportId]);
  const markers = db.all(`SELECT id, slug FROM biomarkers ORDER BY slug LIMIT 2`);
  for (const m of markers) {
    db.run(
      `INSERT INTO lab_results (id, biomarker_id, report_id, value, collected_at)
       VALUES (?, ?, ?, 1.5, '2026-06-01')`,
      [newId(db), m.id, reportId]
    );
  }

  const pack = assembleDoctorPack(db, { now: NOW, appVersion: '0.2.0' });
  is('the pack is point-in-time', pack.kind, 'doctor_pack');
  yes('the patient header is complete', pack.patient.incomplete === false);
  yes(
    'and it carries the name (unlike the self-review)',
    pack.patient.fields.some((f) => f.value === 'Matt Lawrence')
  );

  const shownMarkers = pack.labs.groups.flatMap((g) => g.rows);
  is('only measured markers appear', shownMarkers.length, markers.length);
  const catalogSize = db.get('SELECT count(*) AS n FROM biomarkers').n;
  is(
    'the coverage line carries the absence',
    pack.labs.coverageLine,
    `${markers.length} of ${catalogSize} tracked markers measured.`
  );
  yes(
    'the optimal-range column is labelled a personal target',
    pack.labs.optimalRangeLabel.includes('Personal target') &&
      pack.labs.optimalRangeLabel.includes('Not a clinical reference range'),
    pack.labs.optimalRangeLabel
  );
  yes('the regimen lists the active protocol', pack.regimen.groups.length === 1);
  is('…with its item', pack.regimen.groups[0].protocols[0].items[0].title, 'Magnesium glycinate');
  yes(
    'no blood pressure is claimed',
    pack.vitals.notMeasured.includes('does not record blood pressure'),
    pack.vitals.notMeasured
  );
  yes('no BMI is claimed', pack.vitals.notMeasured.includes('no BMI'), pack.vitals.notMeasured);
  const packText = JSON.stringify(pack);
  yes(
    'and neither word appears as a measured row',
    !packText.includes('"metric":"Blood pressure"') && !packText.includes('"metric":"BMI"')
  );
  yes('screenings are listed', pack.screenings.rows.length === 1);
  yes('an overdue screening is flagged', pack.screenings.rows[0].overdue === true);

  // A blank profile prints authored blanks and reports what is missing.
  const { db: blank } = freshDb();
  const blankPack = assembleDoctorPack(blank, { now: NOW });
  yes('an empty profile is flagged incomplete', blankPack.patient.incomplete === true);
  yes(
    '…and names every missing field',
    blankPack.patient.missing === 'full name, date of birth, biological sex',
    String(blankPack.patient.missing)
  );
  yes(
    '…and the fields print null, never a guess',
    blankPack.patient.fields[0].value === null &&
      blankPack.patient.fields[0].note.includes('Settings › Profile')
  );
  yes(
    'a lab-less pack says so instead of printing sixty em-dashes',
    blankPack.labs.empty != null && blankPack.labs.groups.length === 0
  );
}

// ============================================================================
console.log('7. Render — verbatim figures, authored empties, tripwires, determinism');
{
  const { db } = freshDb();
  const protocolId = createProtocolWithVersion(
    db,
    { name: 'Morning stack', type: 'supplement_stack' },
    { items: [{ title: 'Creatine', scheduled_time: '07:00', dose: '5 g', notes: null }] }
  );
  logEntry(db, '2026-08-01', protocolId, 'completed');
  logEntry(db, '2026-08-02', protocolId, 'skipped');
  addMeal(db, '2026-08-01', 2000, 150);
  addBody(db, '2026-08-01', 80);
  createExperiment(db, {
    title: 'Magnesium at night',
    hypothesis: 'It lifts deep sleep',
    intervention: 'Magnesium glycinate 400 mg at 21:00',
    metrics: ['HRV', 'sleep'],
    startDate: '2026-08-02',
    durationDays: 5,
  });

  const full = assembleSelfReview(db, PERIOD, { now: NOW, appVersion: '0.2.0' });
  const html = renderReportHtml(full);

  yes(
    'the document is self-contained (no external fetch)',
    !/src=|href=|@import|<script/i.test(html),
    'found an external reference'
  );
  yes('it carries a print stylesheet', html.includes('@media print'));
  yes('the period is printed', html.includes(formatRange('2026-08-01', '2026-08-07')));
  yes('the coverage preamble is printed', html.includes(full.coverageLine));
  // The ledger's own numbers, verbatim.
  const row = full.adherence.rows[0];
  yes(
    'the ledger figures appear verbatim',
    html.includes(`>${row.planned}<`) && html.includes(`>${row.completed}<`),
    `planned=${row.planned} completed=${row.completed}`
  );
  yes(
    'an authored empty is printed, not a zero',
    html.includes('None logged.'),
    'symptoms empty missing'
  );
  yes('the experiment is printed', html.includes('Magnesium at night'));
  yes('the disclaimer is printed', html.includes('not a medical record'));

  // THE TRIPWIRES.
  yes('no "undefined" anywhere in the render', !html.includes('undefined'), 'found undefined');
  yes('no "NaN" anywhere in the render', !html.includes('NaN'), 'found NaN');
  yes('no "[object" anywhere in the render', !html.includes('[object'), 'found [object');

  is('same input renders identical bytes', renderReportHtml(full), html);

  // The sparse and empty fixtures must render too, and stay clean.
  const { db: sparse } = freshDb();
  addBody(sparse, '2026-08-02', 80);
  const sparseHtml = renderReportHtml(assembleSelfReview(sparse, PERIOD, { now: NOW }));
  const { db: bare } = freshDb();
  const bareData = assembleSelfReview(bare, PERIOD, { now: NOW });
  const bareHtml = renderReportHtml(bareData);
  for (const [name, doc] of [
    ['sparse', sparseHtml],
    ['empty', bareHtml],
  ]) {
    yes(`${name}: no undefined`, !doc.includes('undefined'));
    yes(`${name}: no NaN`, !doc.includes('NaN'));
    yes(`${name}: no [object`, !doc.includes('[object'));
  }
  yes(
    'an empty period authors every section rather than printing zeros',
    bareData.adherence.empty != null &&
      bareData.training.empty != null &&
      bareData.nutrition.empty != null &&
      bareData.symptoms.empty != null &&
      bareData.experiments.empty != null &&
      bareData.changed.empty != null
  );
  yes('…and omits the labs section entirely', bareData.labs === null);

  // Escaping: a protocol named with markup must not become markup.
  const { db: hostile } = freshDb();
  const hostileId = createProtocolWithVersion(
    hostile,
    { name: '<script>alert(1)</script> & "quotes"', type: 'supplement_stack' },
    { items: [] }
  );
  logEntry(hostile, '2026-08-01', hostileId, 'completed');
  const hostileHtml = renderReportHtml(assembleSelfReview(hostile, PERIOD, { now: NOW }));
  yes('user text is escaped, never injected', !hostileHtml.includes('<script>alert(1)</script>'));
  yes('…and is still readable', hostileHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));

  // The doctor pack renders with no narrative parameter at all.
  const packHtml = renderReportHtml(assembleDoctorPack(db, { now: NOW }), {
    text: 'THIS MUST NEVER APPEAR',
    attribution: 'x',
    model: 'm',
  });
  yes(
    'NO MODEL PROSE IN THE DOCTOR PACK, even when one is passed',
    !packHtml.includes('THIS MUST NEVER APPEAR'),
    'model text reached the clinical document'
  );
  yes('…and no read section is drawn', !packHtml.includes("Coach's read"));

  // The self-review DOES carry it, attributed.
  const readHtml = renderReportHtml(full, {
    text: 'The week held together.',
    attribution: COACH_READ_ATTRIBUTION,
    model: 'claude-opus-5',
  });
  yes('the self-review carries the read', readHtml.includes('The week held together.'));
  // ESCAPED-verbatim: the rubric contains an apostrophe ("Coach's read"), and a
  // renderer that let that through unescaped would be the bug. So the assertion
  // is that the rubric survives escaping intact — not that raw markup appears.
  yes(
    '…under the attribution rubric verbatim (escaped)',
    readHtml.includes(escapeHtml(COACH_READ_ATTRIBUTION)),
    escapeHtml(COACH_READ_ATTRIBUTION)
  );

  is(
    'the filename follows the export convention',
    reportFileName('self_review', '2026-08-12T14:33:08.123Z'),
    'arc-report-self-review-20260812-143308.html'
  );
  is(
    '…and names the doctor pack differently',
    reportFileName('doctor_pack', '2026-08-12T14:33:08.123Z'),
    'arc-report-doctor-20260812-143308.html'
  );
}

// ============================================================================
console.log('8. Persistence — the migration, the CHECKs, and re-render from the snapshot');
{
  const { db, raw } = freshDb();
  is('the migration applied', raw.prepare('PRAGMA user_version').get().user_version >= 39, true);
  const cols = raw
    .prepare('PRAGMA table_info(reports)')
    .all()
    .map((c) => c.name);
  yes(
    'the table has the specified shape',
    [
      'id',
      'report_type',
      'period_start',
      'period_end',
      'generated_at',
      'file_name',
      'file_path',
      'data_json',
      'narrative_text',
      'app_version',
    ].every((c) => cols.includes(c)),
    JSON.stringify(cols)
  );

  const reject = (name, sql, params) => {
    try {
      db.run(sql, params);
      bad(name, 'the row was accepted');
    } catch {
      ok(name);
    }
  };
  reject(
    'CHECK: an unknown report_type is rejected',
    `INSERT INTO reports (id, report_type, generated_at, file_name, file_path, data_json)
     VALUES (?, 'weekly_digest', '2026-08-12T00:00:00.000Z', 'a.html', 'reports/a.html', '{}')`,
    [newId(db)]
  );
  reject(
    'CHECK: invalid JSON in data_json is rejected',
    `INSERT INTO reports (id, report_type, generated_at, file_name, file_path, data_json)
     VALUES (?, 'self_review', '2026-08-12T00:00:00.000Z', 'a.html', 'reports/a.html', 'not json')`,
    [newId(db)]
  );
  reject(
    'CHECK: half a period is rejected',
    `INSERT INTO reports (id, report_type, period_start, generated_at, file_name, file_path, data_json)
     VALUES (?, 'self_review', '2026-08-01', '2026-08-12T00:00:00.000Z', 'a.html', 'reports/a.html', '{}')`,
    [newId(db)]
  );
  reject(
    'CHECK: a doctor pack may not carry a period',
    `INSERT INTO reports (id, report_type, period_start, period_end, generated_at, file_name, file_path, data_json)
     VALUES (?, 'doctor_pack', '2026-08-01', '2026-08-07', '2026-08-12T00:00:00.000Z', 'a.html', 'reports/a.html', '{}')`,
    [newId(db)]
  );

  // A real round trip.
  addMeal(db, '2026-08-01', 2000, 150);
  const data = assembleSelfReview(db, PERIOD, { now: NOW, appVersion: '0.2.0' });
  const original = renderReportHtml(data);
  const id = insertReport(db, {
    data,
    read: { text: 'A quiet week.', attribution: COACH_READ_ATTRIBUTION, model: 'claude-opus-5' },
    fileName: 'arc-report-self-review-20260812-143308.html',
    filePath: 'reports/arc-report-self-review-20260812-143308.html',
  });

  const stored = getReport(db, id);
  is('the period lands on the row', stored.period_start, '2026-08-01');
  is('…both ends', stored.period_end, '2026-08-07');
  is('the app version is recorded', stored.app_version, '0.2.0');
  is('the narrative lands in its own column', stored.narrative_text, 'A quiet week.');
  yes(
    'NARRATIVE_TEXT NEVER ENTERS data_json',
    !stored.data_json.includes('A quiet week.') && !stored.data_json.includes('narrative'),
    'model prose reached the deterministic snapshot'
  );

  const snapshot = getReportSnapshot(db, id);
  is('history re-renders FROM the snapshot, byte-identical', renderReportHtml(snapshot), original);

  const back = readNarrative(stored, COACH_READ_ATTRIBUTION);
  is('the read comes back out', back.text, 'A quiet week.');
  is('…re-wrapped with the CURRENT rubric', back.attribution, COACH_READ_ATTRIBUTION);

  const list = listReports(db);
  is('the history lists it', list.length, 1);
  is('…and knows it has a read', list[0].hasNarrative, true);

  // A doctor pack persists with no period at all.
  const packId = insertReport(db, {
    data: assembleDoctorPack(db, { now: NOW }),
    read: null,
    fileName: 'arc-report-doctor-20260812-143308.html',
    filePath: 'reports/arc-report-doctor-20260812-143308.html',
  });
  const packRow = getReport(db, packId);
  is('a doctor pack stores no period', packRow.period_start, null);
  is('…and no narrative', packRow.narrative_text, null);

  // The generic export picks the table up with no new code (spec §5).
  const { listExportTables, readAllRows } = await import('../src/lib/export/serializer.ts');
  yes(
    'the table rides the whole-DB export automatically',
    listExportTables(db).includes('reports')
  );
  is('…with every row, scalar-safe', readAllRows(db, 'reports').length, 2);

  deleteReport(db, id);
  is('delete removes the row', listReports(db).length, 1);
  yes('an unknown id reads as null, not a throw', getReportSnapshot(db, 'nope') === null);
}

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
