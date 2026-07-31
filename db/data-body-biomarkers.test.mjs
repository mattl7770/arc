/**
 * Headless test of the Body and Biomarkers data layers — `body_metrics`,
 * `biomarkers` and `lab_results` (0001_init.sql) and their repositories
 * (body.ts, biomarkers.ts) — against real SQLite via node:sqlite. Mirrors
 * db/nutrition.test.mjs; op-sqlite is never loaded.
 * Run: node --import ./db/register-ts-hooks.mjs db/data-body-biomarkers.test.mjs
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { newId } from '../src/lib/db/id.ts';
import { bodySeries, latestBody } from '../src/lib/db/repositories/body.ts';
import { listBiomarkerRanges } from '../src/lib/db/repositories/biomarkers.ts';
import { seedReferenceData } from '../src/lib/db/seed.ts';
import { BIOMARKER_SEED } from '../src/lib/labs/catalog.ts';

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
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-6;

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

function insertBodyMetric(db, { measuredAt, weightKg, waistCm }) {
  db.run(`INSERT INTO body_metrics (id, measured_at, weight_kg, waist_cm) VALUES (?, ?, ?, ?)`, [
    newId(db),
    measuredAt,
    weightKg ?? null,
    waistCm ?? null,
  ]);
}

function insertLabReport(db, collectedAt) {
  const id = newId(db);
  db.run(`INSERT INTO lab_reports (id, collected_at) VALUES (?, ?)`, [id, collectedAt]);
  return id;
}

function insertLabResult(db, { biomarkerId, reportId, value, collectedAt }) {
  db.run(
    `INSERT INTO lab_results (id, biomarker_id, report_id, value, collected_at)
     VALUES (?, ?, ?, ?, ?)`,
    [newId(db), biomarkerId, reportId ?? null, value, collectedAt]
  );
}

function biomarkerIdBySlug(db, slug) {
  return db.get(`SELECT id FROM biomarkers WHERE slug = ?`, [slug]).id;
}

// Wed 2026-07-22, noon LOCAL.
const NOW = new Date(2026, 6, 22, 12, 0, 0);

console.log('0. migrations: 0001 (biomarkers, lab_results, body_metrics) applied');
{
  const { raw } = freshDb();
  const tables = ['biomarkers', 'lab_reports', 'lab_results', 'body_metrics'].map(
    (name) =>
      !!raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)
  );
  tables.every(Boolean)
    ? ok('biomarkers/lab_reports/lab_results/body_metrics tables exist')
    : bad('tables missing', JSON.stringify(tables));
}

console.log('1. bodySeries: ordering, date window, and per-column null skip');
{
  const { db } = freshDb();
  // Within the trailing-30-day window (cutoff = 2026-06-22T12:00:00 local).
  insertBodyMetric(db, { measuredAt: new Date(2026, 6, 10, 8, 0, 0).toISOString(), weightKg: 81 });
  insertBodyMetric(db, { measuredAt: new Date(2026, 6, 20, 8, 0, 0).toISOString(), weightKg: 80 });
  // A row with weight_kg NULL but waist_cm set — must not appear in the weight
  // series but must appear in the waist series.
  insertBodyMetric(db, { measuredAt: new Date(2026, 6, 15, 8, 0, 0).toISOString(), waistCm: 90 });
  // Outside the window: older than the 30-day cutoff.
  insertBodyMetric(db, { measuredAt: new Date(2026, 4, 1, 8, 0, 0).toISOString(), weightKg: 85 });
  // Outside the window: after `now`.
  insertBodyMetric(db, { measuredAt: new Date(2026, 7, 1, 8, 0, 0).toISOString(), weightKg: 79 });

  const weight = bodySeries(db, 'weight_kg', 30, NOW);
  weight.length === 2
    ? ok('weight_kg series has only the two in-window, non-null rows')
    : bad('weight_kg length', JSON.stringify(weight));
  weight.length === 2 && weight[0].value === 81 && weight[1].value === 80
    ? ok('weight_kg series is ordered oldest -> newest')
    : bad('weight_kg order', JSON.stringify(weight));

  const waist = bodySeries(db, 'waist_cm', 30, NOW);
  waist.length === 1 && waist[0].value === 90
    ? ok('waist_cm series picks up the row weight_kg series skipped (per-column null)')
    : bad('waist_cm series', JSON.stringify(waist));
}

console.log('2. bodySeries: window bounds are inclusive at both ends');
{
  const { db } = freshDb();
  const cutoff = new Date(NOW);
  cutoff.setDate(cutoff.getDate() - 30);
  insertBodyMetric(db, { measuredAt: cutoff.toISOString(), weightKg: 70 });
  insertBodyMetric(db, { measuredAt: NOW.toISOString(), weightKg: 71 });
  const series = bodySeries(db, 'weight_kg', 30, NOW);
  series.length === 2 && series[0].value === 70 && series[1].value === 71
    ? ok('exact cutoff instant and exact `now` instant are both included')
    : bad('inclusive bounds', JSON.stringify(series));
}

console.log('3. bodySeries: empty-safe on a fresh database');
{
  const { db } = freshDb();
  const series = bodySeries(db, 'body_fat_pct', 30, NOW);
  Array.isArray(series) && series.length === 0
    ? ok('bodySeries is an empty array with no rows')
    : bad('empty bodySeries', JSON.stringify(series));
}

console.log('4. latestBody: most recent non-null reading, ignoring newer null rows');
{
  const { db } = freshDb();
  insertBodyMetric(db, { measuredAt: new Date(2026, 6, 1, 8, 0, 0).toISOString(), weightKg: 82 });
  insertBodyMetric(db, { measuredAt: new Date(2026, 6, 10, 8, 0, 0).toISOString(), weightKg: 80 });
  // Most recent row overall, but weight_kg is NULL here — latestBody must skip it.
  insertBodyMetric(db, { measuredAt: new Date(2026, 6, 20, 8, 0, 0).toISOString(), waistCm: 91 });

  const latest = latestBody(db, 'weight_kg');
  latest &&
  latest.value === 80 &&
  latest.measuredAt === new Date(2026, 6, 10, 8, 0, 0).toISOString()
    ? ok('latestBody returns the most recent row where the column is non-null')
    : bad('latestBody', JSON.stringify(latest));

  latestBody(db, 'body_fat_pct') === null
    ? ok('latestBody is null when no row ever set that column')
    : bad('latestBody null case', JSON.stringify(latestBody(db, 'body_fat_pct')));
}

console.log('5. listBiomarkerRanges: full seeded catalogue, all latest values null');
{
  const { db } = freshDb();
  seedReferenceData(db);
  const ranges = listBiomarkerRanges(db);
  // Sized off the catalog rather than a hard-coded number: the seed grows as
  // ARC learns more markers (the labs pipeline took it from 12 to 65), and a
  // snapshot count would just have to be bumped on every addition.
  ranges.length === BIOMARKER_SEED.length
    ? ok(`all ${ranges.length} seeded biomarkers returned`)
    : bad('count', `${ranges.length} of ${BIOMARKER_SEED.length}`);
  ranges.every((r) => r.latestValue === null && r.latestAt === null)
    ? ok('every biomarker has latestValue/latestAt null on an empty lab_results table')
    : bad(
        'non-null latest on empty db',
        JSON.stringify(ranges.filter((r) => r.latestValue !== null))
      );

  const apob = ranges.find((r) => r.slug === 'apob');
  apob &&
  apob.name === 'ApoB' &&
  apob.category === 'cardiovascular' &&
  apob.unit === 'mg/dL' &&
  apob.optimalHigh === 80 &&
  apob.higherIsBetter === 0
    ? ok('a seeded row carries its catalogue fields through (apob)')
    : bad('apob row', JSON.stringify(apob));

  // The ordering CONTRACT rather than a snapshot of it: category priority
  // ascending, then name within a category. Asserting the property survives
  // catalog growth; asserting a fixed slug list did not.
  // Mirrors the CASE in listBiomarkerRanges. Every category has its own rank —
  // an ELSE bucket would let two categories interleave, which makes the Labs
  // screen repeat a section header (its grouping folds contiguous runs).
  const PRIORITY = {
    cardiovascular: 0,
    metabolic: 1,
    inflammation: 2,
    nutrient: 3,
    hematology: 4,
    hormone: 5,
    immune: 6,
    organ: 7,
    cancer: 8,
    toxin: 9,
    microbiome: 10,
    biological_age: 11,
  };
  const rank = (r) => PRIORITY[r.category] ?? 12;
  let orderOk = true;
  let firstBreak = null;
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1];
    const cur = ranges[i];
    const inOrder = rank(prev) < rank(cur) || (rank(prev) === rank(cur) && prev.name <= cur.name);
    if (!inOrder) {
      orderOk = false;
      firstBreak = `${prev.category}/${prev.name} then ${cur.category}/${cur.name}`;
      break;
    }
  }
  orderOk ? ok('deterministic order: category priority, then name') : bad('order', firstBreak);

  // The head of the list is still the cardiovascular block, alphabetically.
  ranges[0].slug === 'apob' && ranges[1].slug === 'hdl_c'
    ? ok('cardiovascular sorts first, by name')
    : bad('head of list', JSON.stringify(ranges.slice(0, 2).map((r) => r.slug)));
}

console.log('6. listBiomarkerRanges: latestValue picks the most recent lab_result by collected_at');
{
  const { db } = freshDb();
  seedReferenceData(db);
  const apobId = biomarkerIdBySlug(db, 'apob');
  const hdlId = biomarkerIdBySlug(db, 'hdl_c');

  const oldReport = insertLabReport(db, '2026-01-01');
  const newReport = insertLabReport(db, '2026-06-01');
  // Two results for the same biomarker, different reports — respects the
  // unique(report_id, biomarker_id) idempotency guard.
  insertLabResult(db, {
    biomarkerId: apobId,
    reportId: oldReport,
    value: 90,
    collectedAt: '2026-01-01',
  });
  insertLabResult(db, {
    biomarkerId: apobId,
    reportId: newReport,
    value: 75,
    collectedAt: '2026-06-01',
  });
  // A manual entry (report_id NULL) for a different biomarker, to prove NULL
  // report_id doesn't break the latest-per-biomarker join.
  insertLabResult(db, { biomarkerId: hdlId, reportId: null, value: 55, collectedAt: '2026-05-15' });

  const ranges = listBiomarkerRanges(db);
  const apob = ranges.find((r) => r.slug === 'apob');
  const hdl = ranges.find((r) => r.slug === 'hdl_c');
  const ldl = ranges.find((r) => r.slug === 'ldl_c');

  apob && near(apob.latestValue, 75) && apob.latestAt === '2026-06-01'
    ? ok('apob latestValue is the newer of its two results (75, not 90)')
    : bad('apob latest', JSON.stringify(apob));
  hdl && near(hdl.latestValue, 55) && hdl.latestAt === '2026-05-15'
    ? ok('hdl_c picks up a manual (report_id NULL) result')
    : bad('hdl_c latest', JSON.stringify(hdl));
  ldl && ldl.latestValue === null && ldl.latestAt === null
    ? ok('a biomarker with no lab_results stays null')
    : bad('ldl_c latest', JSON.stringify(ldl));
}

console.log('6b. listBiomarkerRanges: same collected_at tie broken by created_at (newest wins)');
{
  const { db } = freshDb();
  seedReferenceData(db);
  const apobId = biomarkerIdBySlug(db, 'apob');
  const r1 = insertLabReport(db, '2026-06-01');
  const r2 = insertLabReport(db, '2026-06-01');
  // Two results for the same biomarker on the SAME collected_at, in two reports
  // (unique(report_id, biomarker_id) permits it). created_at is stamped
  // EXPLICITLY and distinctly so the `created_at DESC` tie-break is actually
  // exercised — the column defaults to ms-precision 'now', and two synchronous
  // inserts can collide, dropping the tie to the random-UUID id DESC.
  db.run(
    `INSERT INTO lab_results (id, biomarker_id, report_id, value, collected_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId(db), apobId, r1, 90, '2026-06-01', '2026-06-01T08:00:00.000Z']
  );
  db.run(
    `INSERT INTO lab_results (id, biomarker_id, report_id, value, collected_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId(db), apobId, r2, 72, '2026-06-01', '2026-06-01T09:30:00.000Z']
  );
  const apob = listBiomarkerRanges(db).find((r) => r.slug === 'apob');
  apob && near(apob.latestValue, 72) && apob.latestAt === '2026-06-01'
    ? ok('same-day tie broken by created_at DESC — newer 72 wins over 90')
    : bad('same-day tie-break', JSON.stringify(apob));
}

console.log('7. lab_results respects unique(report_id, biomarker_id)');
{
  const { db } = freshDb();
  seedReferenceData(db);
  const apobId = biomarkerIdBySlug(db, 'apob');
  const report = insertLabReport(db, '2026-01-01');
  insertLabResult(db, {
    biomarkerId: apobId,
    reportId: report,
    value: 90,
    collectedAt: '2026-01-01',
  });
  let threw = false;
  try {
    insertLabResult(db, {
      biomarkerId: apobId,
      reportId: report,
      value: 91,
      collectedAt: '2026-01-02',
    });
  } catch {
    threw = true;
  }
  threw
    ? ok('a duplicate (report_id, biomarker_id) pair is rejected by the unique constraint')
    : bad('duplicate result accepted');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
