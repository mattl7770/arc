/**
 * Headless test of the record-hygiene and medical-attention detectors
 * (src/lib/ai/findings.ts) against real SQLite via node:sqlite — every
 * detector with its false-positive guards, stable ids across days, the promise
 * that nothing here writes, the size of the pass's Findings block, and that
 * Home's brief does not move. Seeded relative to a fixed local-noon `NOW`;
 * no model call and no network. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { seedReferenceData } from '../src/lib/db/seed.ts';
import { shiftISODate, todayISODate } from '../src/lib/db/date.ts';
import { startStatus } from '../src/lib/db/repositories/statuses.ts';
import { logCapture } from '../src/lib/db/repositories/logs.ts';
import { importLabReport } from '../src/lib/db/repositories/labs.ts';
import { getOrCreateUser } from '../src/lib/db/repositories/user.ts';
import { convertUnit } from '../src/lib/labs/map.ts';
import { computeInsights, generateDailyBrief } from '../src/lib/ai/insights.ts';
import {
  computeFindings,
  findingById,
  findingsBlock,
  PASS_FINDINGS_SHOWN,
} from '../src/lib/ai/findings.ts';
import {
  DEFAULT_FINDING_THRESHOLDS,
  FINDING_THRESHOLD_SPECS,
  getFindingThresholds,
  resetFindingThresholds,
  saveFindingThresholds,
} from '../src/lib/ai/finding-thresholds.ts';
import { getPassState, markPassRan } from '../src/lib/ai/pass-schedule.ts';
import { domainByKey } from '../src/lib/ai/domains/index.ts';
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
const check = (cond, n, e) => (cond ? ok(n) : bad(n, typeof e === 'function' ? e() : e));

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

function freshDb({ user = true, seed = false } = {}) {
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
  if (seed) seedReferenceData(db);
  if (user) getOrCreateUser(db);
  return { raw, db };
}

// Local noon, so no seeded day sits near a boundary in any test zone.
const NOW = new Date(2026, 9, 21, 12, 0, 0, 0);
const TODAY = todayISODate(NOW);
const ago = (n) => shiftISODate(TODAY, -n);
const nextDay = (d, n = 1) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12, 0, 0, 0);
let seq = 0;
const uid = () => `t-${String(++seq).padStart(5, '0')}`;

/** The UTC instant of a local wall-clock time on a local date. */
const instant = (date, hh = 8, mm = 0) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm).toISOString();
};
const seedWeight = (raw, date, kg, hh = 8) => {
  const id = uid();
  raw
    .prepare(
      `INSERT INTO body_metrics (id, measured_at, weight_kg, source) VALUES (?, ?, ?, 'manual')`
    )
    .run(id, instant(date, hh), kg);
  return id;
};
const seedWearable = (raw, metric, date, value) =>
  raw
    .prepare(
      `INSERT INTO wearable_data (id, date, metric_type, value, source_device) VALUES (?, ?, ?, ?, 'manual')`
    )
    .run(uid(), date, metric, value);
const seedMeal = (raw, date, name, kcal, time = '12:00') => {
  const id = uid();
  raw
    .prepare(`INSERT INTO meals (id, date, time, name, kcal) VALUES (?, ?, ?, ?, ?)`)
    .run(id, date, time, name, kcal);
  return id;
};
const seedSymptom = (raw, date, name, severity = 4) =>
  raw
    .prepare(`INSERT INTO symptoms (id, date, name, severity) VALUES (?, ?, ?, ?)`)
    .run(uid(), date, name, severity);
const labResult = (slug, value, extra = {}) => ({
  slug,
  name: extra.name ?? slug,
  category: 'other',
  unit: extra.unit ?? null,
  value,
  standardLow: extra.standardLow ?? null,
  standardHigh: extra.standardHigh ?? null,
});
const importLabs = (db, date, results) =>
  importLabReport(db, {
    collectedOn: date,
    labName: 'Quest',
    filePath: null,
    rawJson: null,
    notes: null,
    results,
  });

const of = (findings, check, subject) =>
  findings.filter((f) => f.check === check && (subject === undefined || f.subject === subject));

/** Every table's every row, as text — the "nothing was written" oracle. */
function snapshot(raw) {
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  return JSON.stringify(
    tables.map((t) => [t, raw.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()])
  );
}

// ---------------------------------------------------------------------------
console.log('1. Weight gap against his own cadence');
{
  const { raw, db } = freshDb();
  // Daily for 40 days, last weigh-in six days ago: five whole days missed.
  for (let i = 45; i >= 6; i--) seedWeight(raw, ago(i), 80 + (i % 3) * 0.1);
  const gaps = of(computeFindings(db, NOW), 'gap', 'weight');
  check(gaps.length === 1, 'a daily weigher with five missed days has a gap finding', () =>
    JSON.stringify(gaps)
  );
  const g = gaps[0];
  check(
    g && g.numbers.missedDays === 5 && g.numbers.usualEveryDays === 1 && g.severity === 'notice',
    'the evidence carries his own cadence and the missed count',
    () => JSON.stringify(g?.numbers)
  );
  check(
    g &&
      g.rows[0].table === 'body_metrics' &&
      g.rows[0].domain === 'captures' &&
      g.rows[0].domainId.endsWith(':weight_kg'),
    'the last reading is named, reachable through the captures domain',
    () => JSON.stringify(g?.rows)
  );
  const tomorrow = of(computeFindings(db, nextDay(NOW)), 'gap', 'weight')[0];
  check(
    tomorrow && g && tomorrow.id === g.id && tomorrow.numbers.missedDays === 6,
    'the id is stable across days while the gap stands',
    () => `${g?.id} vs ${tomorrow?.id}`
  );
  check(
    of(computeFindings(db, nextDay(NOW, -2)), 'gap', 'weight').length === 0,
    'three missed days is under the four-day floor — not a gap'
  );
  seedWeight(raw, ago(0), 80.1);
  check(of(computeFindings(db, NOW), 'gap', 'weight').length === 0, 'a weigh-in today closes it');
}
{
  // A status covering the lapse: a sick week is not a gap.
  const { raw, db } = freshDb();
  for (let i = 45; i >= 6; i--) seedWeight(raw, ago(i), 80);
  startStatus(db, { label: 'Sick', startDate: ago(5), endDate: ago(2), source: 'user' });
  const gaps = of(computeFindings(db, NOW), 'gap', 'weight');
  check(gaps.length === 0, 'a status-excused stretch is never counted as missed days', () =>
    JSON.stringify(gaps.map((f) => f.numbers))
  );
}
{
  // A weekly weigher: ten days is well inside three times his spacing.
  const { raw, db } = freshDb();
  for (let i = 66; i >= 10; i -= 7) seedWeight(raw, ago(i), 80);
  check(
    of(computeFindings(db, NOW), 'gap', 'weight').length === 0,
    'a weekly weigher ten days out is not a gap'
  );
  check(
    of(computeFindings(db, nextDay(NOW, 12)), 'gap', 'weight').length === 1,
    '…and twenty-two days out is'
  );
}

console.log('2. Meal gap: usually logged, a day with none while he was active');
const mealFixture = ({ skip = 3, steps = 8000, status = null, history = 35 } = {}) => {
  const { raw, db } = freshDb();
  for (let i = history; i >= 1; i--) {
    seedWearable(raw, 'steps', ago(i), i === skip ? steps : 8000);
    if (i !== skip) seedMeal(raw, ago(i), 'Lunch', 600);
  }
  if (status)
    startStatus(db, { label: status, startDate: ago(skip), endDate: ago(skip), source: 'user' });
  return { raw, db };
};
{
  const { db } = mealFixture();
  const gaps = of(computeFindings(db, NOW), 'gap', 'meals');
  check(
    gaps.length === 1 && gaps[0].numbers.date === ago(3) && gaps[0].severity === 'info',
    'the empty, active day is found',
    () => JSON.stringify(gaps)
  );
  check(
    gaps[0]?.headline.includes('8000 steps'),
    'with the activity that makes it stand out',
    () => gaps[0]?.headline
  );
}
{
  const { db } = mealFixture({ status: 'fasting' });
  check(
    of(computeFindings(db, NOW), 'gap', 'meals').length === 0,
    'a planned fast (a declared status) is not a gap'
  );
}
{
  const { db } = mealFixture({ steps: 400 });
  check(
    of(computeFindings(db, NOW), 'gap', 'meals').length === 0,
    'a day with no sign of activity is not called a missed log'
  );
}
{
  const { db } = mealFixture({ history: 10 });
  check(
    of(computeFindings(db, NOW), 'gap', 'meals').length === 0,
    'ten days of meal logging is not yet a habit to break'
  );
}

console.log('3. Duplicate candidates');
{
  const { raw, db } = freshDb();
  const a = seedMeal(raw, TODAY, 'Oatmeal', 350, '08:00');
  const b = seedMeal(raw, TODAY, 'Oatmeal', 350, '08:04');
  seedMeal(raw, TODAY, 'Oatmeal', 350, '14:00'); // the second bowl, six hours later
  seedMeal(raw, TODAY, 'Snack', 150, '10:00');
  seedMeal(raw, TODAY, 'Snack', 600, '10:03'); // same word, a different plate
  const dups = of(computeFindings(db, NOW), 'duplicate', 'meals');
  check(dups.length === 1, 'two identical meals four minutes apart, and only those', () =>
    JSON.stringify(dups.map((f) => f.headline))
  );
  const ids = dups[0]?.rows.map((r) => r.domainId).sort();
  check(
    ids &&
      ids.join() === [a, b].sort().join() &&
      dups[0].rows.every((r) => r.domain === 'meals' && r.role === 'candidate'),
    'both rows named, each reachable through the meals domain for a later proposal',
    () => JSON.stringify(dups[0]?.rows)
  );
  check(
    dups[0] && findingById(db, dups[0].id, NOW)?.id === dups[0].id,
    'findingById re-derives it'
  );
  raw.prepare('DELETE FROM meals WHERE id = ?').run(b);
  check(
    dups[0] && findingById(db, dups[0].id, NOW) === null,
    '…and finds nothing once the twin is gone, so a stale proposal refuses'
  );
}
{
  // The same plate through items: different names, identical foods and amounts.
  const { raw, db } = freshDb();
  const m1 = seedMeal(raw, TODAY, 'Breakfast', 400, '07:30');
  const m2 = seedMeal(raw, TODAY, 'Eggs & toast', 400, '07:36');
  for (const m of [m1, m2]) {
    raw
      .prepare(`INSERT INTO meal_items (id, meal_id, name, amount) VALUES (?, ?, 'Egg', 100)`)
      .run(uid(), m);
    raw
      .prepare(`INSERT INTO meal_items (id, meal_id, name, amount) VALUES (?, ?, 'Toast', 40)`)
      .run(uid(), m);
  }
  check(
    of(computeFindings(db, NOW), 'duplicate', 'meals').length === 1,
    'a twin capture of one plate is caught by its items'
  );
}
{
  const { db } = freshDb();
  logCapture(db, TODAY, 'supplement', 'Creatine 5 g');
  logCapture(db, TODAY, 'supplement', 'Creatine 5 g');
  logCapture(db, TODAY, 'supplement', 'Magnesium 400 mg');
  const dups = computeFindings(db, NOW).filter(
    (f) => f.check === 'duplicate' && f.subject.startsWith('capture')
  );
  check(
    dups.length === 1 && dups[0].rows.every((r) => r.domain === 'captures'),
    'a capture tapped twice is one candidate pair',
    () => JSON.stringify(dups)
  );
}
{
  const { raw, db } = freshDb({ seed: true });
  const panel = [
    labResult('apob', 82),
    labResult('ldl_c', 104),
    labResult('hdl_c', 55),
    labResult('triglycerides', 70),
  ];
  importLabs(db, ago(20), panel);
  importLabs(db, ago(20), panel);
  // Two partial panels the same morning share nothing — not a re-import.
  importLabs(db, ago(40), [labResult('apob', 80), labResult('ldl_c', 100), labResult('hdl_c', 50)]);
  importLabs(db, ago(40), [
    labResult('tsh', 1.8),
    labResult('free_t4', 1.2),
    labResult('ferritin', 90),
  ]);
  const dups = of(computeFindings(db, NOW), 'duplicate', 'lab_reports');
  check(
    dups.length === 1 && dups[0].numbers.matching === 4 && dups[0].kind === 'labs',
    'the re-imported report, and not the two partial panels',
    () => JSON.stringify(dups)
  );
  check(
    raw.prepare('SELECT count(*) c FROM lab_reports').get().c === 4,
    'the duplicate is detected, never removed'
  );
  check(
    !computeFindings(db, NOW).some((f) => f.check === 'worsened' && f.numbers.changePct === 0),
    'a re-import is not read as a second draw'
  );
}

console.log('4. Implausible values');
{
  const { raw, db } = freshDb();
  seedWeight(raw, ago(5), 80.0);
  seedWeight(raw, ago(4), 80.2);
  const typo = seedWeight(raw, ago(3), 88.0); // 80.0 typed as 88.0
  seedWeight(raw, ago(2), 80.1);
  const found = of(computeFindings(db, NOW), 'implausible', 'weight');
  check(
    found.length === 1 && found[0].rows[0].id === typo && found[0].rows[0].role === 'suspect',
    'the spike is the suspect, and the reading after it is not',
    () => JSON.stringify(found)
  );
}
{
  const { raw, db } = freshDb();
  // A deliberate cut: 85 → 80 kg over five weeks, weighed daily.
  for (let i = 35; i >= 0; i--) seedWeight(raw, ago(i), 85 - (5 * (35 - i)) / 35);
  check(
    of(computeFindings(db, NOW), 'implausible', 'weight').length === 0,
    'a deliberate cut is not implausible'
  );
}
{
  const { raw, db } = freshDb();
  seedWeight(raw, ago(2), 80);
  seedWeight(raw, ago(1), 176.4); // the same body, in pounds
  check(
    of(computeFindings(db, NOW), 'implausible', 'weight').length === 1,
    'a lb/kg mix-up is caught'
  );
}
const vitalFixture = (metric, center, spread) => {
  const { raw, db } = freshDb();
  // Baseline: days 30–89 back, a small deterministic wobble.
  for (let i = 89; i >= 30; i--)
    seedWearable(raw, metric, ago(i), center + (((i * 7) % 5) - 2) * spread);
  return { raw, db };
};
{
  const { raw, db } = vitalFixture('hrv', 50, 2);
  seedWearable(raw, 'hrv', ago(1), 4); // a dropped-out sensor night
  const found = of(computeFindings(db, NOW), 'implausible', 'hrv');
  check(
    found.length === 1 && found[0].numbers.z < -4,
    'an HRV reading far outside his own band is implausible',
    () => JSON.stringify(found)
  );
}
{
  const { raw, db } = vitalFixture('hrv', 50, 2);
  seedWearable(raw, 'hrv', ago(1), 4);
  startStatus(db, { label: 'Sick', startDate: ago(1), endDate: ago(1), source: 'user' });
  check(
    of(computeFindings(db, NOW), 'implausible', 'hrv').length === 0,
    'the same reading on a status day is not called implausible'
  );
}
{
  const { raw, db } = vitalFixture('rhr', 55, 1);
  for (let i = 3; i >= 0; i--) seedWearable(raw, 'rhr', ago(i), 62);
  const found = of(computeFindings(db, NOW), 'persists', 'rhr');
  check(
    found.length === 1 && found[0].numbers.runDays === 4 && found[0].severity === 'attention',
    'resting HR above his band four days running is persistent',
    () => JSON.stringify(found)
  );
  const tomorrow = of(computeFindings(db, nextDay(NOW)), 'persists', 'rhr');
  check(tomorrow[0]?.id === found[0]?.id, 'the same run keeps its id the next morning');
  const later = of(computeFindings(db, nextDay(NOW, 2)), 'persists', 'rhr');
  check(later.length === 0, 'and is not raised once the run no longer reaches yesterday', () =>
    JSON.stringify(later)
  );
}
{
  const { raw, db } = vitalFixture('rhr', 55, 1);
  for (let i = 1; i >= 0; i--) seedWearable(raw, 'rhr', ago(i), 62);
  check(of(computeFindings(db, NOW), 'persists', 'rhr').length === 0, 'two days is not yet a run');
}
{
  const { db } = freshDb({ seed: true });
  importLabs(db, ago(30), [labResult('fasting_glucose', 5.5), labResult('hemoglobin', 15)]);
  const found = of(computeFindings(db, NOW), 'implausible');
  check(
    found.length === 1 && found[0].subject === 'fasting_glucose' && found[0].kind === 'labs',
    'a glucose of 5.5 stored as mg/dL is a unit error',
    () => JSON.stringify(found)
  );
  check(
    !computeFindings(db, NOW).some(
      (f) => f.subject === 'fasting_glucose' && f.check !== 'implausible'
    ),
    'and an implausible value feeds no medical finding'
  );
}
{
  const { raw, db } = freshDb({ seed: true });
  // A known unit difference, converted by the mapping layer before it lands…
  importLabs(db, ago(30), [
    labResult('fasting_glucose', convertUnit('fasting_glucose', 5.5, 'mmol/l', 'mg/dl')),
  ]);
  // …and a catalog row carrying a different unit than the band is written in.
  raw.prepare(`UPDATE biomarkers SET unit = 'g/L' WHERE slug = 'hemoglobin'`).run();
  importLabs(db, ago(29), [labResult('hemoglobin', 150)]);
  check(
    of(computeFindings(db, NOW), 'implausible').length === 0,
    'a known unit difference is never called a typo'
  );
}

console.log('5. Medical attention: labs, symptoms');
{
  const { db } = freshDb({ seed: true });
  importLabs(db, ago(200), [labResult('ldl_c', 90), labResult('apob', 70)]);
  importLabs(db, ago(10), [labResult('ldl_c', 130), labResult('apob', 73)]);
  const all = computeFindings(db, NOW);
  const left = of(all, 'out-of-range', 'ldl_c');
  check(
    left.length === 1 &&
      left[0].numbers.range === 'optimal' &&
      left[0].numbers.changePct > left[0].numbers.referenceChangePct,
    'LDL-C 90 → 130 left the optimal range, by more than its own noise',
    () => JSON.stringify(left)
  );
  check(
    of(all, 'worsened', 'ldl_c').length === 0 && /beyond its/.test(left[0]?.headline),
    '…as one line, not two',
    () => left[0]?.headline
  );
  check(
    of(all, 'worsened', 'apob').length === 0 && of(all, 'out-of-range', 'apob').length === 0,
    'ApoB up 4% inside its range is noise, not news'
  );
  check(
    !/should|consider|recommend|talk to|see a/i.test(all.map((f) => f.headline).join(' ')),
    'headlines state facts, never advice'
  );
}
{
  // Worse beyond noise while still inside optimal: its own finding.
  const { db } = freshDb({ seed: true });
  importLabs(db, ago(200), [labResult('apob', 50)]);
  importLabs(db, ago(10), [labResult('apob', 75)]);
  const worse = of(computeFindings(db, NOW), 'worsened', 'apob');
  check(
    worse.length === 1 && worse[0].severity === 'notice' && worse[0].numbers.changePct === 50,
    'ApoB 50 → 75 worsened inside its range',
    () => JSON.stringify(worse)
  );
  // Lower is better for ApoB, so the same move downward is not a worsening.
  const { db: down } = freshDb({ seed: true });
  importLabs(down, ago(200), [labResult('apob', 75)]);
  importLabs(down, ago(10), [labResult('apob', 50)]);
  check(of(computeFindings(down, NOW), 'worsened').length === 0, '…and 75 → 50 is not');
}
{
  const { db } = freshDb({ seed: true });
  importLabs(db, ago(15), [
    labResult('marker_x', 15, { name: 'Marker X', unit: 'mg/L', standardLow: 1, standardHigh: 10 }),
  ]);
  const found = of(computeFindings(db, NOW), 'out-of-range', 'marker_x');
  check(
    found.length === 1 &&
      found[0].severity === 'attention' &&
      found[0].numbers.range === 'standard',
    'outside the lab’s standard range is attention',
    () => JSON.stringify(found)
  );
  check(
    of(computeFindings(db, nextDay(NOW, 400)), 'out-of-range').length === 0,
    'a draw more than a year old stops being raised'
  );
}
{
  const { raw, db } = freshDb();
  for (const i of [6, 4, 2, 0]) seedSymptom(raw, ago(i), 'Headache', 5);
  seedSymptom(raw, ago(3), 'headache ', 7); // same name, typed differently
  const found = of(computeFindings(db, NOW), 'persists').filter(
    (f) => f.subject === 'symptom:headache'
  );
  check(
    found.length === 1 && found[0].numbers.daysInWindow === 5 && found[0].numbers.maxSeverity === 7,
    'a symptom on five of the last seven days persists',
    () => JSON.stringify(found)
  );
  const later = of(computeFindings(db, nextDay(NOW)), 'persists').filter(
    (f) => f.subject === 'symptom:headache'
  );
  check(later[0]?.id === found[0]?.id, 'the episode keeps its id the next day');
  check(
    found[0]?.rows.every((r) => r.table === 'symptoms' && r.domain === 'captures'),
    'its rows are the symptom entries'
  );
}
{
  const { raw, db } = freshDb();
  for (const i of [6, 3, 0]) seedSymptom(raw, ago(i), 'Knee pain');
  check(of(computeFindings(db, NOW), 'persists').length === 0, 'three of seven is not persistent');
}

console.log('6. Thresholds: one place, editable, clamped');
{
  const { raw, db } = freshDb();
  check(
    JSON.stringify(getFindingThresholds(db)) === JSON.stringify(DEFAULT_FINDING_THRESHOLDS),
    'defaults until he moves one'
  );
  check(
    FINDING_THRESHOLD_SPECS.every((s) => s.default >= s.min && s.default <= s.max),
    'every default sits inside its own range'
  );
  seedWeight(raw, ago(2), 80);
  seedWeight(raw, ago(1), 85); // 6.25%
  check(
    of(computeFindings(db, NOW), 'implausible', 'weight').length === 1,
    'a 6% jump fires at the 4% default'
  );
  const saved = saveFindingThresholds(db, { weightJumpPct: 8, gapMinDays: 999 });
  check(
    saved.weightJumpPct === 8 && saved.gapMinDays === 30,
    'a save is clamped to the spec range',
    () => JSON.stringify(saved)
  );
  check(
    of(computeFindings(db, NOW), 'implausible', 'weight').length === 0,
    'and the detectors read the saved value'
  );
  const prefs = JSON.parse(raw.prepare('SELECT preferences FROM users').get().preferences);
  check(
    prefs.coachFindings &&
      Object.keys(prefs.coachFindings).sort().join() === 'gapMinDays,weightJumpPct',
    'only the moved keys are stored'
  );
  resetFindingThresholds(db);
  check(
    !(
      'coachFindings' in JSON.parse(raw.prepare('SELECT preferences FROM users').get().preferences)
    ),
    'reset removes the key'
  );
}

console.log('7. Nothing here writes');
{
  const build = () => {
    const { raw, db } = freshDb({ seed: true });
    for (let i = 45; i >= 6; i--) seedWeight(raw, ago(i), 80);
    seedMeal(raw, TODAY, 'Oatmeal', 350, '08:00');
    seedMeal(raw, TODAY, 'Oatmeal', 350, '08:03');
    importLabs(db, ago(20), [
      labResult('fasting_glucose', 5.5),
      labResult('ldl_c', 90),
      labResult('apob', 80),
    ]);
    importLabs(db, ago(20), [
      labResult('fasting_glucose', 5.5),
      labResult('ldl_c', 90),
      labResult('apob', 80),
    ]);
    for (const i of [3, 2, 1, 0]) seedSymptom(raw, ago(i), 'Cough');
    return { raw, db };
  };
  const { raw, db } = build();
  const before = snapshot(raw);
  const findings = computeFindings(db, NOW);
  findingsBlock(findings, new Set());
  findingById(db, findings[0].id, NOW);
  JSON.parse(await toolByName('get_insights').execute(db, {}, { now: NOW }));
  check(findings.length >= 4, `the fixture raises findings (${findings.length})`);
  check(
    snapshot(raw) === before,
    'every table is byte-identical after computeFindings, the block, findingById and get_insights'
  );

  // No user row at all: reading the thresholds must not create one.
  const empty = freshDb({ user: false });
  const emptyBefore = snapshot(empty.raw);
  computeFindings(empty.db, NOW);
  check(
    snapshot(empty.raw) === emptyBefore,
    'not even the user row is created to read the thresholds'
  );
}

console.log('8. Home’s brief, the insights and the signal set do not move');
{
  const base = () => {
    const { raw, db } = freshDb({ seed: true });
    for (let i = 27; i >= 0; i--) {
      seedWearable(raw, 'steps', ago(i), 8000 + (i % 4) * 300);
      seedWeight(raw, ago(i), 80 + (i % 3) * 0.1);
    }
    return { raw, db };
  };
  const plain = base();
  const noisy = base();
  // Findings only: a re-imported report with a unit error in it, a capture
  // tapped twice. None of it is anything the brief reads.
  const panel = [labResult('fasting_glucose', 5.5), labResult('ldl_c', 90), labResult('apob', 80)];
  importLabs(noisy.db, ago(5), panel);
  importLabs(noisy.db, ago(5), panel);
  logCapture(noisy.db, TODAY, 'supplement', 'Creatine 5 g');
  logCapture(noisy.db, TODAY, 'supplement', 'Creatine 5 g');
  check(computeFindings(noisy.db, NOW).length >= 3, 'the noisy fixture has findings');
  check(computeFindings(plain.db, NOW).length === 0, 'the plain one has none');
  check(
    generateDailyBrief(noisy.db, NOW) === generateDailyBrief(plain.db, NOW),
    'Home’s brief is byte-identical with or without findings',
    () => `${generateDailyBrief(noisy.db, NOW)} | ${generateDailyBrief(plain.db, NOW)}`
  );
  const ids = (db) =>
    computeInsights(db, NOW)
      .map((i) => `${i.id}:${i.kind}`)
      .join();
  check(
    ids(noisy.db) === ids(plain.db),
    'computeInsights returns the same set (no finding kind enters it)'
  );
  const insights = JSON.parse(await toolByName('get_insights').execute(noisy.db, {}, { now: NOW }));
  check(
    Array.isArray(insights.findings) &&
      insights.findings.every((f) => f.kind === 'record' || f.kind === 'labs'),
    'get_insights carries the findings as payload, kinds record/labs',
    () => JSON.stringify(insights).slice(0, 300)
  );
  const plainInsights = JSON.parse(
    await toolByName('get_insights').execute(plain.db, {}, { now: NOW })
  );
  check(!('findings' in plainInsights), '…and adds nothing when there are none');
}

console.log('9. Every row a finding names is reachable the way it says');
{
  const domains = new Set();
  const { raw, db } = freshDb({ seed: true });
  for (let i = 45; i >= 6; i--) seedWeight(raw, ago(i), 80);
  seedMeal(raw, TODAY, 'Oatmeal', 350, '08:00');
  seedMeal(raw, TODAY, 'Oatmeal', 350, '08:03');
  importLabs(db, ago(20), [labResult('ldl_c', 90), labResult('apob', 80), labResult('hdl_c', 50)]);
  importLabs(db, ago(20), [labResult('ldl_c', 90), labResult('apob', 80), labResult('hdl_c', 50)]);
  for (const i of [3, 2, 1, 0]) seedSymptom(raw, ago(i), 'Cough');
  logCapture(db, TODAY, 'supplement', 'Creatine 5 g');
  logCapture(db, TODAY, 'supplement', 'Creatine 5 g');
  const rows = computeFindings(db, NOW).flatMap((f) => f.rows);
  for (const row of rows) if (row.domain) domains.add(row.domain);
  check(
    [...domains].every((d) => domainByKey(d)) && domains.size >= 3,
    `every named domain is in the registry (${[...domains].join(', ')})`
  );
  check(
    rows.every(
      (r) => raw.prepare(`SELECT count(*) c FROM "${r.table}" WHERE id = ?`).get(r.id).c === 1
    ),
    'every row id exists in the table it names'
  );
}

console.log('10. The pass’s Findings block: compact, and nothing raised twice');
{
  check(
    findingsBlock([], new Set()).text === '',
    'no findings, no block — the pass context is unchanged'
  );
  // A worst case: many long findings at once.
  const { raw, db } = freshDb({ seed: true });
  for (const [i, slug] of [
    'ldl_c',
    'apob',
    'triglycerides',
    'hs_crp',
    'fasting_insulin',
    'ferritin',
    'tsh',
    'alt',
  ].entries()) {
    importLabs(db, ago(300 + i), [labResult(slug, slug === 'hs_crp' ? 0.5 : 20)]);
  }
  importLabs(db, ago(5), [
    labResult('ldl_c', 160),
    labResult('apob', 120),
    labResult('triglycerides', 300),
    labResult('hs_crp', 9),
    labResult('fasting_insulin', 60),
    labResult('ferritin', 600),
    labResult('tsh', 9),
    labResult('alt', 90),
  ]);
  for (let i = 6; i >= 0; i--)
    seedSymptom(raw, ago(i), 'Lower back pain, right side, worse after sitting');
  const findings = computeFindings(db, NOW);
  const block = findingsBlock(findings, new Set());
  const tokens = Math.round(block.text.length / 3.6);
  check(
    findings.length > PASS_FINDINGS_SHOWN,
    `the worst case has more findings than the block spells out (${findings.length})`
  );
  check(
    block.shown.length === PASS_FINDINGS_SHOWN,
    `the block spells out ${PASS_FINDINGS_SHOWN} and counts the rest`
  );
  check(tokens <= 350, `the worst-case block is ~${tokens} tokens (≤ 350, chars/3.6)`, block.text);
  console.log(
    block.text
      .split('\n')
      .map((l) => `       ${l}`)
      .join('\n')
  );
  check(
    block.text.startsWith('Findings') && block.text.includes(findings[0].id),
    'it leads with the most serious, id attached'
  );

  // Seen at a pass → counted, not re-listed; past the cap → still new.
  markPassRan(db, NOW, { findingsShown: block.shown });
  const seen = new Set(getPassState(db).seenFindings);
  check(
    seen.size === PASS_FINDINGS_SHOWN && block.shown.every((id) => seen.has(id)),
    'markPassRan records only what the block spelled out'
  );
  const next = findingsBlock(computeFindings(db, NOW), seen);
  check(
    block.shown.every((id) => !next.text.includes(id)) &&
      next.text.includes(`${PASS_FINDINGS_SHOWN} raised at an earlier pass`),
    'the next pass counts them instead of re-raising them',
    next.text
  );
  const unseen = findings.filter((f) => !seen.has(f.id)).map((f) => f.id);
  check(
    next.shown.length === Math.min(PASS_FINDINGS_SHOWN, unseen.length) &&
      next.shown.every((id) => unseen.includes(id)),
    '…and spells out the ones it never saw',
    () => JSON.stringify(next.shown)
  );
}

console.log('11. runCoachPass carries the block after the state block');
{
  const sse = (text) =>
    [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      '',
      '',
    ].join('\n');
  const requests = [];
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const body = sse('SKIP');
    return {
      ok: true,
      status: 200,
      text: async () => '',
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) return { done: true };
              done = true;
              return { done: false, value: new TextEncoder().encode(body) };
            },
          };
        },
      },
    };
  };
  const { apiKeyStore } = await import('../src/lib/ai/api-key-store.ts');
  await apiKeyStore.setKey('test-key');
  const { runCoachPass } = await import('../src/lib/ai/coach-pass.ts');

  const { raw, db } = freshDb();
  const clean = await runCoachPass(db, { trigger: { kind: 'daily' }, now: NOW, fetchImpl });
  const cleanContext = requests[0].system[1].text;
  check(
    !cleanContext.includes('Findings') && clean.findingsShown.length === 0,
    'no findings: the context carries no block'
  );

  seedMeal(raw, TODAY, 'Oatmeal', 350, '08:00');
  seedMeal(raw, TODAY, 'Oatmeal', 350, '08:03');
  const result = await runCoachPass(db, { trigger: { kind: 'daily' }, now: NOW, fetchImpl });
  const context = requests[1].system[1].text;
  check(
    context.includes('\n\nFindings (') && context.includes('"Oatmeal" logged twice'),
    'the pass sees the duplicate in its context'
  );
  const typical = Math.round(context.slice(context.indexOf('Findings (')).length / 3.6);
  check(typical <= 80, `a one-finding block costs ~${typical} tokens (≤ 80)`);
  check(
    requests[1].messages.every((m) => !JSON.stringify(m.content).includes('Findings (')),
    'only in the context — the directive is untouched'
  );
  check(
    result.findingsShown.length === 1 && result.status === 'silent',
    'and reports which ids it showed, for markPassRan'
  );
  await apiKeyStore.clearKey();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
