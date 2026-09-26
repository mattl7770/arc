/**
 * Headless test of the Log-tab data layer — the command parser, the metric
 * registry conversions + range validation, and the capture repository
 * (logs.ts) — against real SQLite via node:sqlite. Mirrors
 * db/data-layer.test.mjs; op-sqlite is never loaded. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { localDayUtcRange, todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  getCapture,
  listEntriesOn,
  listTodayEntries,
  logCapture,
  logMetric,
  logNote,
  recentSummary,
} from '../src/lib/db/repositories/logs.ts';
import { listMission } from '../src/lib/db/repositories/mission.ts';
import { logSymptom } from '../src/lib/db/repositories/symptoms.ts';
import { setHealthSyncEnabled } from '../src/lib/db/repositories/user.ts';
import { removeLogCapture, restoreLogCapture } from '../src/lib/health/publish.ts';
import { removeCaptureWithUndo } from '../src/lib/log/capture-undo.ts';
import { closeUndo, currentUndo, runUndo } from '../src/lib/nutrition/undo-store.ts';
import { ensureTodaySeeded } from '../src/lib/db/seed.ts';
import {
  formatCanonical,
  isLoggableCanonical,
  METRICS,
  metricByKey,
} from '../src/lib/log/metrics.ts';
import { parseCommand } from '../src/lib/log/parse.ts';

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

const TODAY = todayISODate();
const SEED = [
  {
    id: 'a',
    title: 'AM stack',
    scheduledTime: '07:15',
    category: 'Supplements',
    status: 'pending',
  },
  { id: 'b', title: 'Zone 2', scheduledTime: '17:00', category: 'Training', status: 'pending' },
];

console.log('1. parseCommand: notes vs. structured metrics (single-value)');
{
  const note = parseCommand('felt unusually sharp after morning light');
  note.kind === 'note' && note.text === 'felt unusually sharp after morning light'
    ? ok('free text with no metric → note (verbatim)')
    : bad('note passthrough', JSON.stringify(note));

  const w = parseCommand('weight 178');
  w.kind === 'metric' &&
  w.metric === 'weight' &&
  w.display === 178 &&
  near(w.canonical, 178 / 2.2046226218)
    ? ok('"weight 178" → weight, canonical kg')
    : bad('keyword weight', JSON.stringify(w));

  const wl = parseCommand('178 lb');
  wl.kind === 'metric' && wl.metric === 'weight' && near(wl.canonical, 178 / 2.2046226218)
    ? ok('"178 lb" → weight via unit inference')
    : bad('lb inference', JSON.stringify(wl));

  const wk = parseCommand('82 kg');
  wk.kind === 'metric' && wk.metric === 'weight' && near(wk.canonical, 82)
    ? ok('"82 kg" → weight, kg passed straight to canonical')
    : bad('kg passthrough', JSON.stringify(wk));

  // Unit preference: a BARE number is read in the user's display unit (the keypad
  // does the same), so the two Log-tab write paths never disagree. An explicit
  // unit token always wins over the preference.
  const KG_PREFS = { weight: 'kg', distance: 'km', volume: 'ml', length: 'cm', temperature: 'C' };
  const wkgPref = parseCommand('weight 80', KG_PREFS);
  wkgPref.kind === 'metric' && near(wkgPref.canonical, 80)
    ? ok('"weight 80" under kg preference → 80 kg canonical (not 36.3)')
    : bad('kg-pref bare weight', JSON.stringify(wkgPref));
  const wlbDefault = parseCommand('weight 80');
  wlbDefault.kind === 'metric' && near(wlbDefault.canonical, 80 / 2.2046226218)
    ? ok('"weight 80" with no preference → 80 lb canonical (imperial default unchanged)')
    : bad('default bare weight', JSON.stringify(wlbDefault));
  const wExplicit = parseCommand('180 lb', KG_PREFS);
  wExplicit.kind === 'metric' && near(wExplicit.canonical, 180 / 2.2046226218)
    ? ok('"180 lb" ignores the kg preference — an explicit unit wins')
    : bad('explicit over pref', JSON.stringify(wExplicit));
  const water20 = parseCommand('water 20', KG_PREFS);
  water20.kind === 'metric' && water20.metric === 'water' && near(water20.canonical, 20)
    ? ok('"water 20" under ml preference → 20 ml canonical (not 591 ml as oz)')
    : bad('ml-pref bare water', JSON.stringify(water20));

  const hrv = parseCommand('hrv 48');
  hrv.kind === 'metric' && hrv.metric === 'hrv' && near(hrv.canonical, 48)
    ? ok('"hrv 48" → hrv')
    : bad('hrv', JSON.stringify(hrv));

  const rhr = parseCommand('48 bpm');
  rhr.kind === 'metric' && rhr.metric === 'rhr'
    ? ok('"48 bpm" → resting HR via unit inference')
    : bad('bpm inference', JSON.stringify(rhr));

  const water = parseCommand('16 oz water');
  water.kind === 'metric' && water.metric === 'water' && near(water.canonical, 16 * 29.5735295625)
    ? ok('"16 oz water" → water, canonical ml')
    : bad('water parse', JSON.stringify(water));

  const bodyFat = parseCommand('body fat 15%');
  bodyFat.kind === 'metric' && bodyFat.metric === 'body_fat' && bodyFat.display === 15
    ? ok('"body fat 15%" → body-fat (space keyword variant)')
    : bad('body fat keyword', JSON.stringify(bodyFat));

  const meal = parseCommand('ate eggs + oats 45g protein');
  meal.kind === 'note'
    ? ok('rich food text → note (rich parse defers to the Coach)')
    : bad('meal → note', JSON.stringify(meal));
}

console.log('2. parseCommand: ADJACENCY — the number must be bound to the keyword/unit');
{
  const multi = parseCommand('took 2 pills, weight 181');
  multi.kind === 'metric' && multi.metric === 'weight' && multi.display === 181
    ? ok('"took 2 pills, weight 181" → weight 181 (adjacent), not the leading 2')
    : bad('adjacency weight', JSON.stringify(multi));

  const multi2 = parseCommand('ran 5k then hrv 48');
  multi2.kind === 'metric' && multi2.metric === 'hrv' && multi2.display === 48
    ? ok('"ran 5k then hrv 48" → hrv 48, not the leading 5')
    : bad('adjacency hrv', JSON.stringify(multi2));

  const dose = parseCommand('took 2 capsules dose 500 mg');
  dose.kind === 'metric' && dose.metric === 'dose' && dose.display === 500
    ? ok('"...dose 500 mg" → dose 500 (adjacent), not the leading 2')
    : bad('adjacency dose', JSON.stringify(dose));

  const distantWater = parseCommand('great water views today, walked 5 miles');
  distantWater.kind === 'note'
    ? ok('a note with "water" + a distant number stays a note (not 5 oz)')
    : bad('distant water', JSON.stringify(distantWater));

  const distantResting = parseCommand('resting hr felt low, slept 8 hrs');
  distantResting.kind === 'note'
    ? ok('a note with "resting" + a distant number stays a note (not 8 bpm)')
    : bad('distant resting', JSON.stringify(distantResting));

  const ambiguous = parseCommand('meditate 20 in the morning');
  ambiguous.kind === 'note'
    ? ok('"20 in the morning" stays a note ("in" never implies waist)')
    : bad('ambiguous unit guard', JSON.stringify(ambiguous));

  const negative = parseCommand('weight -5');
  negative.kind === 'note'
    ? ok('"weight -5" → note (a leading minus is not consumed as a value)')
    : bad('negative weight', JSON.stringify(negative));

  // Valid variants that must still parse.
  const glued = parseCommand('180lb');
  glued.kind === 'metric' && glued.metric === 'weight'
    ? ok('"180lb" (unit glued to the number) → weight')
    : bad('glued lb', JSON.stringify(glued));
  for (const kw of ['weigh 178', 'bw 178']) {
    const r = parseCommand(kw);
    r.kind === 'metric' && r.metric === 'weight'
      ? ok(`"${kw}" → weight (keyword synonym)`)
      : bad('weight synonym ' + kw, JSON.stringify(r));
  }
  const waterKw = parseCommand('water 16');
  waterKw.kind === 'metric' && waterKw.metric === 'water'
    ? ok('"water 16" → water (keyword-first, no unit)')
    : bad('water 16', JSON.stringify(waterKw));
  const waistIn = parseCommand('waist 33 in');
  waistIn.kind === 'metric' && waistIn.metric === 'waist' && near(waistIn.canonical, 33 * 2.54)
    ? ok('"waist 33 in" → waist (in → cm)')
    : bad('waist in', JSON.stringify(waistIn));

  // Domain-collision guards: an ambiguous unit alone (no keyword) stays a note,
  // so food logs aren't misread as water/dose/waist.
  for (const [text, why] of [
    ['16 oz steak', 'oz alone does not imply water'],
    ['500 mg magnesium', 'mg alone does not imply a dose'],
    ['10 in', 'in alone does not imply waist'],
  ]) {
    parseCommand(text).kind === 'note'
      ? ok(`"${text}" stays a note (${why})`)
      : bad('collision guard ' + text, JSON.stringify(parseCommand(text)));
  }
}

console.log('3. metric registry: conversions round-trip and validate ranges');
{
  let allOk = true;
  for (const m of METRICS) {
    const display = 42.5;
    const back = m.fromCanonical(m.toCanonical(display));
    if (!near(back, display)) {
      allOk = false;
      bad(`round-trip ${m.key}`, `${display} -> ${back}`);
    }
  }
  if (allOk) ok('display → canonical → display is stable for every metric');

  formatCanonical(metricByKey('weight'), metricByKey('weight').toCanonical(180)) === '180.0 lb'
    ? ok('weight 180 lb survives the kg round-trip at display precision')
    : bad('weight display round-trip');
  formatCanonical(metricByKey('waist'), 84) === '33.1 in'
    ? ok('formatCanonical converts cm → in for display')
    : bad('waist format', formatCanonical(metricByKey('waist'), 84));

  const w = metricByKey('weight');
  const bf = metricByKey('body_fat');
  isLoggableCanonical(w, w.toCanonical(0)) === false ? ok('weight 0 rejected') : bad('weight 0');
  isLoggableCanonical(w, w.toCanonical(180)) === true
    ? ok('weight 180 allowed')
    : bad('weight 180');
  isLoggableCanonical(w, w.toCanonical(3000)) === false
    ? ok('weight 3000 lb (>1000 kg) rejected — would trip the CHECK')
    : bad('weight 3000');
  isLoggableCanonical(bf, 150) === false ? ok('body-fat 150% rejected') : bad('bf 150');
  isLoggableCanonical(bf, 20) === true ? ok('body-fat 20% allowed') : bad('bf 20');
}

console.log(
  '3b. the range guard is load-bearing, and the command path saves an out-of-range value as a note'
);
{
  const { db } = freshDb();
  const w = metricByKey('weight');
  const throws = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  // Prove the guard matters: unguarded, these trip a body_metrics CHECK and throw.
  throws(() => logMetric(db, TODAY, 'weight', w.toCanonical(3000)))
    ? ok('logMetric(weight 3000 lb) throws a CHECK violation without the guard')
    : bad('weight 3000 should throw at the DB');
  throws(() => logMetric(db, TODAY, 'body_fat', 150))
    ? ok('logMetric(body-fat 150) throws a CHECK violation without the guard')
    : bad('body-fat 150 should throw at the DB');

  // The command-field composition: parse → out of range → saved as a note.
  const parsed = parseCommand('bf 150');
  const metric = parsed.kind === 'metric' ? metricByKey(parsed.metric) : undefined;
  if (parsed.kind === 'metric' && metric && !isLoggableCanonical(metric, parsed.canonical)) {
    logNote(db, TODAY, 'bf 150');
    const feed = listTodayEntries(db);
    feed.length === 1 && feed[0].note === true && feed[0].title === 'bf 150'
      ? ok('an out-of-range command ("bf 150") is saved as a note — input preserved, no crash')
      : bad('bf 150 note fallback', JSON.stringify(feed));
  } else {
    bad('bf 150 should parse as an out-of-range metric');
  }
}

console.log('4. logNote: appears in the feed, absent from the mission');
{
  const { db } = freshDb();
  logNote(db, TODAY, 'best focus this week');
  const feed = listTodayEntries(db);
  feed.length === 1 && feed[0].note === true && feed[0].title === 'best focus this week'
    ? ok('note is in the feed, flagged as a note')
    : bad('note in feed', JSON.stringify(feed));
  listMission(db, TODAY).length === 0
    ? ok('note does NOT leak into Home’s mission (adhoc filtered)')
    : bad('note leaked to mission');
}

console.log('5. logMetric weight → body_metrics (canonical kg), feed renders lb');
{
  const { db, raw } = freshDb();
  logMetric(db, TODAY, 'weight', metricByKey('weight').toCanonical(180));
  const row = raw.prepare('SELECT weight_kg, source FROM body_metrics').get();
  row && near(row.weight_kg, 180 / 2.2046226218) && row.source === 'manual'
    ? ok('weight stored as canonical kg in body_metrics')
    : bad('body_metrics write', JSON.stringify(row));
  const feed = listTodayEntries(db);
  feed.length === 1 && feed[0].title === '180.0 lb' && feed[0].category === 'Weight'
    ? ok('feed renders it back as "180.0 lb"')
    : bad('weight feed render', JSON.stringify(feed));
}

console.log('5b. logMetric backdates a body metric onto its day, not today');
{
  const { db, raw } = freshDb();
  const BACKDATE = '2026-07-20';
  logMetric(db, BACKDATE, 'weight', metricByKey('weight').toCanonical(178));
  // measured_at is a UTC instant at local noon of the backdate; its LOCAL day
  // must equal the backdate (the pre-fix bug stamped today, corrupting the series).
  const back = raw.prepare('SELECT measured_at FROM body_metrics').get();
  back && todayISODate(new Date(back.measured_at)) === BACKDATE
    ? ok('a backdated weight stamps measured_at on the backdated local day')
    : bad('backdate measured_at', back && back.measured_at);
  // A same-day log still stamps the real current instant.
  logMetric(db, TODAY, 'weight', metricByKey('weight').toCanonical(179));
  const latest = raw
    .prepare('SELECT measured_at FROM body_metrics ORDER BY measured_at DESC LIMIT 1')
    .get();
  latest && todayISODate(new Date(latest.measured_at)) === TODAY
    ? ok("today's weight still stamps the current day")
    : bad('today measured_at', latest && latest.measured_at);
}

console.log('6. logMetric water → wearable_data (ml), recentSummary sums the day');
{
  const { db, raw } = freshDb();
  const oz = metricByKey('water').toCanonical(16);
  logMetric(db, TODAY, 'water', oz);
  logMetric(db, TODAY, 'water', oz);
  const rows = raw
    .prepare(
      "SELECT metric_type, unit, source_device FROM wearable_data WHERE metric_type='water_ml'"
    )
    .all();
  rows.length === 2 && rows[0].unit === 'ml' && rows[0].source_device === 'manual'
    ? ok('two manual water rows land in wearable_data as water_ml/ml')
    : bad('water rows', JSON.stringify(rows));
  const summary = recentSummary(db, 'water', TODAY);
  summary.includes('32 oz')
    ? ok(`recentSummary sums today's water → "${summary}"`)
    : bad('water summary', summary);
  const feed = listTodayEntries(db);
  feed.length === 2 && feed.every((f) => f.title === '16 oz' && f.category === 'Water')
    ? ok('each water capture shows as "16 oz" in the feed')
    : bad('water feed', JSON.stringify(feed));
}

console.log('7. logMetric dose → log_entries(type=metric), adhoc, off the mission');
{
  const { db, raw } = freshDb();
  logMetric(db, TODAY, 'dose', metricByKey('dose').toCanonical(500));
  const row = raw.prepare("SELECT type, title, value FROM log_entries WHERE type='metric'").get();
  row && row.title === '500 mg' && JSON.parse(row.value).adhoc === true
    ? ok('dose is a type=metric log_entry, marked adhoc')
    : bad('dose write', JSON.stringify(row));
  const feed = listTodayEntries(db);
  feed.length === 1 && feed[0].title === '500 mg' && feed[0].category === 'Dose'
    ? ok('dose renders as "500 mg" · Dose in the feed')
    : bad('dose feed', JSON.stringify(feed));
  listMission(db, TODAY).length === 0 ? ok('dose stays off the mission') : bad('dose leaked');
}

console.log('7b. logCapture (supplement / therapy) persists ad-hoc and labels the feed');
{
  const { db, raw } = freshDb();
  logCapture(db, TODAY, 'supplement', 'Creatine · 5 g', { protocol: true });
  logCapture(db, TODAY, 'therapy', 'Sauna · 20 min · 82°C');
  const rows = raw.prepare('SELECT type, title, value FROM log_entries ORDER BY type').all();
  rows.length === 2 &&
  rows[0].type === 'supplement' &&
  rows[0].title === 'Creatine · 5 g' &&
  JSON.parse(rows[0].value).adhoc === true &&
  JSON.parse(rows[0].value).protocol === true
    ? ok('supplement stored as an ad-hoc log_entry with the protocol flag')
    : bad('capture write', JSON.stringify(rows));
  const feed = listTodayEntries(db);
  const supp = feed.find((f) => f.title === 'Creatine · 5 g');
  const ther = feed.find((f) => f.title === 'Sauna · 20 min · 82°C');
  supp && supp.category === 'Supplements' && ther && ther.category === 'Therapies'
    ? ok('feed labels supplement → Supplements, therapy → Therapies')
    : bad('capture feed categories', JSON.stringify(feed));
  listMission(db, TODAY).length === 0
    ? ok('captures stay off the mission')
    : bad('capture leaked to mission');
}

console.log('8. feed is newest-first, and excludes seeded mission items');
{
  const { db, raw } = freshDb();
  ensureTodaySeeded(db, TODAY, SEED);
  logNote(db, TODAY, 'first');
  logNote(db, TODAY, 'second');
  raw.exec(
    `UPDATE log_entries SET created_at='2000-01-01T01:00:00.000Z' WHERE title='first' AND json_extract(value,'$.adhoc')=1`
  );
  raw.exec(
    `UPDATE log_entries SET created_at='2000-01-01T02:00:00.000Z' WHERE title='second' AND json_extract(value,'$.adhoc')=1`
  );
  const feed = listTodayEntries(db);
  feed.length === 2
    ? ok('feed shows only the 2 real captures, not the 2 seeded mission items')
    : bad('feed excludes seed', JSON.stringify(feed.map((f) => f.title)));
  feed[0].title === 'second' && feed[1].title === 'first'
    ? ok('feed is ordered newest-first')
    : bad('feed order', JSON.stringify(feed.map((f) => f.title)));
  listMission(db, TODAY).length === 2
    ? ok('the seeded mission is intact and unpolluted by captures')
    : bad('mission intact', listMission(db, TODAY).length);
}

console.log('9. a note logged BEFORE Home opens does not suppress the day’s seed');
{
  const { db } = freshDb();
  logNote(db, TODAY, 'early note from the Log tab'); // Log tab opened first
  ensureTodaySeeded(db, TODAY, SEED); // Home mounts afterwards
  listMission(db, TODAY).length === SEED.length
    ? ok('mission still seeds despite a prior ad-hoc note (countMissionEntries guard)')
    : bad('seed suppressed by prior note', listMission(db, TODAY).length);
  listTodayEntries(db).length === 1
    ? ok('and the note still shows in the feed')
    : bad('note lost after seed');
}

console.log('10. listTodayEntries respects the local-day UTC range for body_metrics');
{
  const { db, raw } = freshDb();
  const fixedNow = new Date('2026-07-20T12:00:00.000Z');
  const { startUtc, endUtc } = localDayUtcRange(fixedNow);
  const insideAt = startUtc; // first instant of the local day (inclusive bound)
  const beforeAt = new Date(Date.parse(startUtc) - 1000).toISOString(); // 1s before → excluded
  const ins = raw.prepare(
    `INSERT INTO body_metrics (id, measured_at, weight_kg, source) VALUES (?, ?, ?, 'manual')`
  );
  ins.run('in', insideAt, 80);
  ins.run('before', beforeAt, 81);
  ins.run('next', endUtc, 82); // first instant of the NEXT day (exclusive bound) → excluded
  const feed = listTodayEntries(db, fixedNow);
  feed.length === 1 && feed[0].id === 'in:weight_kg'
    ? ok(
        'only the body metric within [start, end) appears (both the earlier and next-day rows excluded)'
      )
    : bad('body_metrics range', JSON.stringify(feed));
}

console.log('11. one body_metrics row with 3 measurements fans out to 3 feed rows');
{
  const { db, raw } = freshDb();
  raw
    .prepare(
      `INSERT INTO body_metrics (id, measured_at, weight_kg, body_fat_pct, waist_cm, source)
       VALUES ('b', ?, 80, 15, 84, 'manual')`
    )
    .run(new Date().toISOString());
  const feed = listTodayEntries(db);
  const cats = feed.map((f) => f.category).sort();
  feed.length === 3 && JSON.stringify(cats) === JSON.stringify(['Body-fat', 'Waist', 'Weight'])
    ? ok('a multi-column body row emits one feed row per measurement')
    : bad('body fan-out', JSON.stringify(feed));
}

console.log('12. recentSummary is empty-safe');
{
  const { db } = freshDb();
  recentSummary(db, 'weight', TODAY) === 'No readings yet'
    ? ok('weight with no data → "No readings yet"')
    : bad('empty weight summary', recentSummary(db, 'weight', TODAY));
  recentSummary(db, 'hrv', TODAY).startsWith('No readings yet')
    ? ok('hrv with no data notes the Apple Health fallback')
    : bad('empty hrv summary', recentSummary(db, 'hrv', TODAY));
}

// ---------------------------------------------------------------------------
// 13. A capture removed from the Log tab, and put back exactly (owner,
// 2026-09-25: "Add a delete with an Undo to each capture on the Log tab").
// Every kind the feed lists, through the ONE function the Log tab's × and the
// Coach's `captures` removal both call — `removeLogCapture` — with a recording
// Apple Health seam, so the Health half (a weight's and a glass's tagged
// sample) is proved beside the record half.
console.log('13. every capture removes, and its Undo puts back row and Health sample exactly');
{
  const { db } = freshDb();
  /** A recording Health seam: which tags it was asked to delete, what it saved. */
  const seam = (inHealth = new Set()) => {
    const deleted = [];
    const saved = [];
    return {
      deleted,
      saved,
      deps: {
        isAvailable: () => true,
        save: async (identifier, unit, value, start, _end, metadata) => {
          saved.push({ identifier, unit, value, at: start.toISOString(), metadata });
          return true;
        },
        deleteByTag: async (identifier, id) => {
          deleted.push(`${identifier}:${id}`);
          return inHealth.has(id) ? 1 : 0;
        },
      },
    };
  };
  /** Every column and the rowid of one row, for a byte-for-byte comparison. */
  const whole = (table, id) =>
    JSON.stringify(db.get(`SELECT rowid AS r, * FROM ${table} WHERE id = ?`, [id]) ?? null);
  const feed = () => listEntriesOn(db, TODAY);
  const feedRow = (id) => JSON.stringify(feed().find((e) => e.id === id) ?? null);

  // The record half, one kind at a time: note, supplement (with the "Part of a
  // protocol" flag), a generic metric, HRV typed by hand, a symptom.
  const noteId = logNote(db, TODAY, 'Slept badly, 3am wake');
  const creatineId = logCapture(db, TODAY, 'supplement', 'Creatine · 5 g', { protocol: true });
  logMetric(db, TODAY, 'dose', 5);
  logMetric(db, TODAY, 'hrv', 62);
  const symptomId = logSymptom(db, {
    date: TODAY,
    time: '14:00',
    name: 'Headache',
    severity: 6,
    bodyArea: null,
    notes: null,
  });
  const doseId = feed().find((e) => e.category === 'Dose').id;
  const hrvId = feed().find((e) => e.category === 'HRV').id;
  const TABLE = {
    [noteId]: 'log_entries',
    [creatineId]: 'log_entries',
    [doseId]: 'log_entries',
    [hrvId]: 'wearable_data',
    [symptomId]: 'symptoms',
  };
  setHealthSyncEnabled(db, true);
  const quiet = seam();
  const missionBefore = JSON.stringify(listMission(db, TODAY));
  const exact = Object.entries(TABLE).filter(([id, table]) => {
    const row = whole(table, id);
    const line = feedRow(id);
    const removed = removeLogCapture(db, id, quiet.deps);
    const goneOk = removed !== null && whole(table, id) === 'null' && feedRow(id) === 'null';
    void restoreLogCapture(db, removed, quiet.deps);
    return !(goneOk && whole(table, id) === row && feedRow(id) === line);
  });
  exact.length === 0
    ? ok('a note, a supplement, a dose, HRV and a symptom each go, and come back byte for byte')
    : bad('capture round trip', exact.map(([id]) => id).join(', '));
  quiet.deleted.length === 0
    ? ok('…and none of them touches Apple Health: none of them is ever published')
    : bad('an unpublished kind reached Health', quiet.deleted.join(', '));
  JSON.stringify(listMission(db, TODAY)) === missionBefore
    ? ok('…nor today’s mission: an ad-hoc capture ticks no item, so removing one unticks none')
    : bad('the mission moved');

  // A capture the feed does not list is not found, and nothing is removed.
  removeLogCapture(db, 'no-such-id', quiet.deps) === null &&
  getCapture(db, `${noteId}:weight_kg`) === undefined
    ? ok('an unknown id, or a body column that is not there, removes nothing')
    : bad('unknown capture');

  // WEIGHT: the row, and its sample in Apple Health — by the row's own tag.
  logMetric(db, TODAY, 'weight', 80);
  const weightId = feed().find((e) => e.category === 'Weight').id;
  const bodyId = weightId.split(':')[0];
  const bodyRow = whole('body_metrics', bodyId);
  const published = seam(new Set([bodyId]));
  const removedWeight = removeLogCapture(db, weightId, published.deps);
  const tookOut = await removedWeight.health;
  whole('body_metrics', bodyId) === 'null' &&
  tookOut === 1 &&
  JSON.stringify(published.deleted) ===
    JSON.stringify([`HKQuantityTypeIdentifierBodyMass:${bodyId}`])
    ? ok('a weight goes, and its Apple Health sample goes by its row’s tag')
    : bad('weight removal', JSON.stringify(published.deleted));
  const resent = await restoreLogCapture(db, removedWeight, published.deps);
  const sample = published.saved[0];
  whole('body_metrics', bodyId) === bodyRow &&
  resent === true &&
  published.saved.length === 1 &&
  sample.identifier === 'HKQuantityTypeIdentifierBodyMass' &&
  sample.value === 80 &&
  sample.metadata.ARCPublishedFrom === bodyId
    ? ok('…and its Undo puts the row back and re-sends the same reading under the same tag')
    : bad('weight restore', JSON.stringify(published.saved));

  // A weight that had NOT gone out yet: nothing to send back — the walk will.
  const unpublished = seam();
  const removedAgain = removeLogCapture(db, weightId, unpublished.deps);
  const resentNothing = await restoreLogCapture(db, removedAgain, unpublished.deps);
  resentNothing === false &&
  unpublished.saved.length === 0 &&
  whole('body_metrics', bodyId) === bodyRow
    ? ok('a weight that had not reached Apple Health is put back and sends nothing')
    : bad('unpublished weight', JSON.stringify(unpublished.saved));

  // WATER: the same path water's own Remove takes.
  logMetric(db, TODAY, 'water', 500);
  const waterId = feed().find((e) => e.category === 'Water').id;
  const glass = seam(new Set([waterId]));
  const removedGlass = removeLogCapture(db, waterId, glass.deps);
  await removedGlass.health;
  await restoreLogCapture(db, removedGlass, glass.deps);
  JSON.stringify(glass.deleted) ===
    JSON.stringify([`HKQuantityTypeIdentifierDietaryWater:${waterId}`]) &&
  glass.saved.length === 1 &&
  glass.saved[0].metadata.ARCPublishedFrom === waterId &&
  feedRow(waterId) !== 'null'
    ? ok('a glass goes and comes back the same way — row and sample, by its tag')
    : bad('water round trip', JSON.stringify({ d: glass.deleted, s: glass.saved }));

  // SYNC OFF: ARC touches nothing in Apple Health, in either direction.
  setHealthSyncEnabled(db, false);
  const off = seam(new Set([bodyId]));
  const removedOff = removeLogCapture(db, weightId, off.deps);
  await removedOff.health;
  await restoreLogCapture(db, removedOff, off.deps);
  off.deleted.length === 0 && off.saved.length === 0 && whole('body_metrics', bodyId) === bodyRow
    ? ok('with Apple Health sync off, the record half runs and Health is left alone')
    : bad('sync off', JSON.stringify(off));

  // A body row holding TWO readings loses only the one removed.
  db.run(
    `INSERT INTO body_metrics (id, measured_at, weight_kg, waist_cm, source)
     VALUES ('two-readings', ?, 81, 84, 'manual')`,
    [new Date().toISOString()]
  );
  const waistOnly = removeLogCapture(db, 'two-readings:waist_cm', off.deps);
  const kept = db.get(`SELECT weight_kg, waist_cm FROM body_metrics WHERE id = 'two-readings'`);
  kept.weight_kg === 81 && kept.waist_cm === null
    ? ok('a row with two readings keeps the other one when one is removed')
    : bad('two readings', JSON.stringify(kept));
  void restoreLogCapture(db, waistOnly, off.deps);
  db.get(`SELECT waist_cm FROM body_metrics WHERE id = 'two-readings'`).waist_cm === 84
    ? ok('…and its Undo puts the one reading back')
    : bad('two readings restore');

  // A put-back that cannot be exact refuses, writing nothing.
  const twice = removeLogCapture(db, noteId, off.deps);
  void restoreLogCapture(db, twice, off.deps);
  let refused = false;
  try {
    void restoreLogCapture(db, twice, off.deps);
  } catch {
    refused = true;
  }
  refused && feed().filter((e) => e.id === noteId).length === 1
    ? ok('an Undo that would put a row back twice refuses, and the row is there once')
    : bad('double restore');

  // THE TAP'S OWN PATH: the offer, its words, and Undo through the store.
  setHealthSyncEnabled(db, false);
  removeCaptureWithUndo(db, weightId);
  const offer = currentUndo();
  offer?.scope.on === 'log' &&
  offer.scope.date === TODAY &&
  offer.said === 'Removed weight' &&
  offer.figure === '176.4 lb' &&
  offer.icon === 'scale-outline'
    ? ok('the × offers “Removed weight · 176.4 lb” under today’s Log tab')
    : bad('capture offer', JSON.stringify(offer));
  runUndo() && whole('body_metrics', bodyId) === bodyRow && currentUndo() === null
    ? ok('…and Undo puts it back through restoreLogCapture, and closes the offer')
    : bad('capture undo');
  removeCaptureWithUndo(db, noteId);
  const noteOffer = currentUndo();
  noteOffer?.said === 'Removed the note “Slept badly, 3am wake”' && noteOffer.figure === null
    ? ok('a note’s Undo quotes the note; a capture of words has no mono figure')
    : bad('note offer', JSON.stringify(noteOffer));
  closeUndo();
  feedRow(noteId) === 'null'
    ? ok('closing the offer leaves the removal standing')
    : bad('closed offer restored the note');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
