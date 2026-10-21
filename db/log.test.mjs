/**
 * Headless test of the Log-tab data layer — the command parser, the metric
 * registry conversions + range validation, and the capture repository
 * (logs.ts) — against real SQLite via node:sqlite. Mirrors
 * db/data-layer.test.mjs; op-sqlite is never loaded. Run: npm run db:test.
 *
 * §13–§21 are screen time (docs/screen-time.md): the duration grammar, the
 * noon rule, the link's validation, the one-row-per-day repository with its
 * restoring Undo (one level, and bounded), the command field's filing
 * decision, the receipt's once-only rule, and when a link may write alone.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { redirectSystemPath } from '../app/+native-intent.ts';

import { localDayUtcRange, shiftISODate, todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  correctCapture,
  getCapture,
  listEntriesOn,
  listTodayEntries,
  logCapture,
  logMetric,
  logNote,
  recentSummary,
} from '../src/lib/db/repositories/logs.ts';
import {
  getScreenTime,
  lastShortcutsLink,
  latestScreenTime,
  markReceiptSeen,
  noteShortcutsLink,
  receiptSeenThrough,
  recentShortcutsWrite,
  recordScreenTime,
  screenTimeOn,
  screenTimeSeries,
  undoScreenTime,
} from '../src/lib/db/repositories/screen-time.ts';
import {
  defaultScreenTimeDay,
  filedDayWords,
  formatHm,
  keypadPress,
  keypadReadout,
  linkConfirmWords,
  linkWritesSilently,
  parseDuration,
  parseScreenTimeLink,
  pickReceipt,
  receiptWords,
  screenTimeDate,
  screenTimeFiling,
  undoneSentence,
} from '../src/lib/screen-time/entry.ts';
import { listMission } from '../src/lib/db/repositories/mission.ts';
import { logSymptom } from '../src/lib/db/repositories/symptoms.ts';
import {
  getPreferences,
  setHealthSyncEnabled,
  setUnitPreference,
} from '../src/lib/db/repositories/user.ts';
import {
  editLogCapture,
  removeLogCapture,
  restoreLogCapture,
} from '../src/lib/health/publish.ts';
import {
  captureDraft,
  captureDraftPatch,
  openCaptureEdit,
  saveCaptureEdit,
} from '../src/lib/log/capture-edit.ts';
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
import {
  ARC_INTENTS_MODULE,
  QUICK_LOG_EVENT,
  QUICK_LOG_ROUTE,
  createQuickLaunchLedger,
  isFreshRequest,
  isQuickLink,
  requestQuickLaunch,
  routeQuickLaunches,
} from '../src/lib/log/quick-launch.ts';
import { quickLineAction } from '../src/lib/log/quick-line.ts';

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
// Screen time (2026-09-25, docs/screen-time.md). The number is typed on Log or
// sent by a Shortcut's link; ONE row per day in wearable_data; filed to
// yesterday before noon. Sections 13–18 are its pure half and its repository.

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('13. screen time: a duration parses, and only a whole line is an entry');
{
  for (const [text, minutes] of [
    ['3h20', 200],
    ['3h 20m', 200],
    ['3 hours 20 minutes', 200],
    ['3h', 180],
    ['3.5h', 210],
    ['3:05', 185],
    ['200', 200],
    ['200 min', 200],
    ['45m', 45],
  ]) {
    parseDuration(text) === minutes
      ? ok(`parseDuration("${text}") → ${minutes}`)
      : bad(`parseDuration ${text}`, String(parseDuration(text)));
  }
  for (const text of ['', 'abc', '3h75', '3:75', 'three hours']) {
    parseDuration(text) === null
      ? ok(`parseDuration("${text}") → null`)
      : bad(`parseDuration ${text} should be null`, String(parseDuration(text)));
  }

  for (const [text, minutes, day] of [
    ['screen 3h20', 200, undefined],
    ['screen time 3h 20m', 200, undefined],
    ['Screentime 200', 200, undefined],
    ['st 200', 200, undefined],
    ['st: 3:20', 200, undefined],
    ['screen 3h20 yesterday', 200, 'yesterday'],
    ['st yesterday 200', 200, 'yesterday'],
    ['3h20 screen time', 200, undefined],
    ['200 min screen today', 200, 'today'],
  ]) {
    const r = parseCommand(text);
    r.kind === 'metric' && r.metric === 'screen_time' && r.canonical === minutes && r.day === day
      ? ok(`"${text}" → screen time ${minutes} min${day ? `, ${day}` : ''}`)
      : bad(`screen time parse ${text}`, JSON.stringify(r));
  }

  // The adjacency rule's stricter cousin: anything else on the line and it is
  // a note. Each of these would have filed a screen day under a keyword match.
  for (const [text, why] of [
    ['walked down 5th st 20 min', '"st" mid-sentence is a street'],
    ['20 st', 'a number before "st" is a weight in stone'],
    ['st200', 'the keyword needs a separator'],
    ['screen 3h75', 'a minutes part over 59 is a typo'],
    ['st yesterday 200 today', 'two days named'],
    ['screen time was rough today', 'no duration'],
    ['bought a new screen 2 days ago', 'words around the number'],
  ]) {
    const r = parseCommand(text);
    r.kind === 'note'
      ? ok(`"${text}" stays a note (${why})`)
      : bad(`note ${text}`, JSON.stringify(r));
  }

  // Out of range parses — so the command field's range guard can save it as a
  // note, exactly as "bf 150" is saved (§3b).
  const st = metricByKey('screen_time');
  const long = parseCommand('screen 30h');
  long.kind === 'metric' && long.canonical === 1800 && !isLoggableCanonical(st, long.canonical)
    ? ok('"screen 30h" parses and is refused by the range guard (a note, not a crash)')
    : bad('screen 30h', JSON.stringify(long));
  !isLoggableCanonical(st, 0) &&
  isLoggableCanonical(st, 1) &&
  isLoggableCanonical(st, 1440) &&
  !isLoggableCanonical(st, 1441) &&
  !isLoggableCanonical(st, 200.5)
    ? ok('screen time is loggable as whole minutes 1–1440 only')
    : bad('screen time range');

  // The rest of the grammar is untouched by the new first pass.
  const hrv = parseCommand('hrv 48');
  hrv.kind === 'metric' && hrv.metric === 'hrv' && hrv.day === undefined
    ? ok('"hrv 48" still parses as HRV, with no day')
    : bad('hrv after screen time', JSON.stringify(hrv));

  formatCanonical(st, 200) === '3h 20m' && formatHm(45) === '45m' && formatHm(180) === '3h 0m'
    ? ok('a duration prints "3h 20m" / "45m", the app’s sleep format')
    : bad('duration format', formatCanonical(st, 200));
}

console.log('14. screen time: which day a typed number is filed to');
{
  const at = (h, m, day = 25) => new Date(2026, 8, day, h, m, 0, 0);
  for (const [h, m, expected] of [
    [6, 0, 'yesterday'],
    [11, 59, 'yesterday'],
    [12, 0, 'today'],
    [23, 55, 'today'],
    [0, 30, 'yesterday'],
  ]) {
    defaultScreenTimeDay(at(h, m), '00:00') === expected
      ? ok(`${h}:${String(m).padStart(2, '0')} under a midnight day → ${expected}`)
      : bad(`noon rule ${h}:${m}`, defaultScreenTimeDay(at(h, m), '00:00'));
  }
  // Under a 04:00 start, 02:00 is still the previous day's evening: "today"
  // in ARC's terms, which is that previous calendar date.
  defaultScreenTimeDay(at(2, 0), '04:00') === 'today' &&
  screenTimeDate('today', at(2, 0), '04:00') === '2026-09-24'
    ? ok('02:00 under a 04:00 start files to that (logical) day, 24 Sep')
    : bad('boundary late night', screenTimeDate('today', at(2, 0), '04:00'));
  defaultScreenTimeDay(at(5, 0), '04:00') === 'yesterday' &&
  screenTimeDate('yesterday', at(5, 0), '04:00') === '2026-09-24'
    ? ok('05:00 under a 04:00 start is morning → yesterday, 24 Sep')
    : bad('boundary morning');
  screenTimeDate('yesterday', at(9, 0), '00:00') === '2026-09-24' &&
  screenTimeDate('today', at(9, 0), '00:00') === '2026-09-25'
    ? ok('yesterday/today name the dates they say')
    : bad('screenTimeDate');

  filedDayWords('2026-09-24', '2026-09-25') === 'yesterday, Thu 24 Sep' &&
  filedDayWords('2026-09-25', '2026-09-25') === 'today, Fri 25 Sep' &&
  filedDayWords('2026-09-22', '2026-09-25') === 'Tue 22 Sep'
    ? ok('a receipt names the day in words and as a date')
    : bad('filedDayWords', filedDayWords('2026-09-24', '2026-09-25'));
}

console.log('15. screen time: the link is validated before anything is written');
{
  const now = new Date(2026, 8, 25, 23, 55, 0, 0);
  const good = parseScreenTimeLink({ minutes: '200', date: '2026-09-25' }, now);
  eq(good, { ok: true, minutes: 200, date: '2026-09-25' })
    ? ok('minutes=200&date=2026-09-25 → accepted')
    : bad('good link', JSON.stringify(good));
  const repeated = parseScreenTimeLink({ minutes: ['200', '999'], date: ['2026-09-24'] }, now);
  repeated.ok && repeated.minutes === 200
    ? ok('a repeated param takes the first value')
    : bad('repeated param', JSON.stringify(repeated));
  parseScreenTimeLink({ minutes: '1440', date: '2026-09-25' }, now).ok &&
  parseScreenTimeLink({ minutes: '1', date: '2026-08-26' }, now).ok
    ? ok('the edges are inside: 1440 minutes, and 30 days back')
    : bad('edges');

  for (const [params, fragment] of [
    [{ date: '2026-09-25' }, 'no minutes'],
    [{ minutes: '200.0', date: '2026-09-25' }, 'whole number'],
    [{ minutes: '-5', date: '2026-09-25' }, 'whole number'],
    [{ minutes: '3h', date: '2026-09-25' }, 'whole number'],
    [{ minutes: '0', date: '2026-09-25' }, 'failed read'],
    [{ minutes: '1441', date: '2026-09-25' }, 'at most 1440'],
    [{ minutes: '200' }, 'no date'],
    [{ minutes: '200', date: '2026-9-25' }, 'YYYY-MM-DD'],
    [{ minutes: '200', date: '2026-02-30' }, 'not a real date'],
    [{ minutes: '200', date: '2026-09-26' }, 'in the future'],
    [{ minutes: '200', date: '2026-08-25' }, 'more than 30 days back'],
  ]) {
    const r = parseScreenTimeLink(params, now);
    !r.ok && r.reason.includes(fragment)
      ? ok(`refused (${fragment}): ${JSON.stringify(params)}`)
      : bad(`link should refuse ${JSON.stringify(params)}`, JSON.stringify(r));
  }
  // The link reaches the route untouched: app/+native-intent.ts redirects only
  // the share extension's deliveries, and `arc` is app.json's scheme.
  const url = 'arc://log/screen-time?minutes=200&date=2026-09-24';
  redirectSystemPath({ path: url, initial: true }) === url &&
  redirectSystemPath({ path: url, initial: false }) === url
    ? ok('the native-intent redirect passes the screen-time link through, cold or warm')
    : bad('native intent rewrote the link', redirectSystemPath({ path: url, initial: true }));
  JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo.scheme === 'arc'
    ? ok('app.json registers the arc:// scheme the link uses')
    : bad('scheme is not arc');

  // Apple's day is the calendar's: at 00:30 the new date is not the future,
  // even under a boundary that still calls it yesterday in ARC.
  parseScreenTimeLink({ minutes: '30', date: '2026-09-26' }, new Date(2026, 8, 26, 0, 30)).ok
    ? ok('at 00:30, the new calendar date is accepted')
    : bad('calendar today');
}

console.log('16. screen time: one row per day, a replace keeps what it replaced, Undo restores it');
{
  const { db, raw } = freshDb();
  const DAY = shiftISODate(TODAY, -1);
  const rowsOn = (date) =>
    raw
      .prepare(`SELECT * FROM wearable_data WHERE metric_type = 'screen_time_min' AND date = ?`)
      .all(date);

  const first = recordScreenTime(db, DAY, 185, 'typed');
  const row = rowsOn(DAY);
  first.wrote &&
  first.minutes === 185 &&
  first.via === 'typed' &&
  first.replaced.length === 0 &&
  row.length === 1 &&
  row[0].unit === 'min' &&
  row[0].source_device === 'manual' &&
  row[0].source_raw_id === null
    ? ok('the first write is one manual wearable_data row, unit min, via typed')
    : bad('first write', JSON.stringify({ first, row }));

  const second = recordScreenTime(db, DAY, 200, 'typed');
  second.wrote && eq(second.replaced, [{ minutes: 185, via: 'typed' }]) && rowsOn(DAY).length === 1
    ? ok('a second number for the same day REPLACES the first and names it')
    : bad('replace', JSON.stringify({ second, rows: rowsOn(DAY) }));

  const again = recordScreenTime(db, DAY, 200, 'typed');
  !again.wrote && again.id === second.id && eq(again.replaced, [{ minutes: 185, via: 'typed' }])
    ? ok('the same number from the same door writes nothing, and keeps the original replaced')
    : bad('idempotent', JSON.stringify(again));

  // The typed 200 as it stands, to compare against once Undo puts it back.
  const before = raw.prepare(`SELECT * FROM wearable_data WHERE id = ?`).get(second.id);
  const linked = recordScreenTime(db, DAY, 210, 'shortcuts');
  linked.via === 'shortcuts' && eq(linked.replaced, [{ minutes: 200, via: 'typed' }])
    ? ok('a Shortcuts write replaces a typed one and says so')
    : bad('shortcuts replace', JSON.stringify(linked));
  recentShortcutsWrite(db, DAY)?.id === linked.id &&
  recentShortcutsWrite(db, shiftISODate(DAY, 1)) === null
    ? ok('the Shortcuts receipt is found from the record, bounded by day')
    : bad('recentShortcutsWrite');

  // Undo: the linked write goes, and the typed 200 comes back — its id, value,
  // timestamp and door. NOT its own record of what it replaced: Undo is one
  // level deep, which is what keeps a row's metadata bounded (§19).
  undoScreenTime(db, linked.id) === true
    ? ok('Undo of the newest write succeeds')
    : bad('undo linked');
  const restored = rowsOn(DAY);
  restored.length === 1 &&
  restored[0].id === second.id &&
  restored[0].value === 200 &&
  restored[0].created_at === before.created_at &&
  JSON.parse(restored[0].metadata).via === 'typed' &&
  eq(getScreenTime(db, second.id)?.replaced, [])
    ? ok('Undo restores the replaced row: id, value, timestamp and door, one level deep')
    : bad('undo restore', JSON.stringify(restored));

  undoScreenTime(db, linked.id) === false && rowsOn(DAY).length === 1
    ? ok('a stale Undo (already undone) changes nothing')
    : bad('stale undo');

  // The restored row carries no Undo of its own, so taking it back empties the
  // day — and the first write, long gone, is not somehow resurrected.
  undoScreenTime(db, second.id) === true &&
  screenTimeOn(db, DAY) === null &&
  undoScreenTime(db, first.id) === false
    ? ok('undoing the restored row leaves the day with no number, and goes no further')
    : bad('undo to empty', JSON.stringify(rowsOn(DAY)));

  // Other days are never touched by a write to this one.
  const other = shiftISODate(DAY, -1);
  recordScreenTime(db, other, 90, 'typed');
  recordScreenTime(db, DAY, 120, 'typed');
  recordScreenTime(db, DAY, 130, 'typed');
  screenTimeOn(db, other)?.minutes === 90 && rowsOn(other).length === 1
    ? ok('a write to one day leaves its neighbour alone')
    : bad('neighbour');

  // Refusals throw before touching the table.
  let threw = 0;
  for (const fn of [
    () => recordScreenTime(db, DAY, 0, 'typed'),
    () => recordScreenTime(db, DAY, 1441, 'typed'),
    () => recordScreenTime(db, DAY, 12.5, 'typed'),
    () => recordScreenTime(db, '2026-9-1', 100, 'typed'),
  ]) {
    try {
      fn();
    } catch {
      threw++;
    }
  }
  threw === 4 && screenTimeOn(db, DAY)?.minutes === 130
    ? ok('0, 1441, 12.5 minutes and a malformed date all throw, and the day keeps 130')
    : bad('refusals', String(threw));

  // Reads: the latest DAY (not the latest row), recorded days only, no future.
  recordScreenTime(db, shiftISODate(TODAY, 2), 60, 'typed');
  latestScreenTime(db, TODAY)?.date === DAY
    ? ok('latestScreenTime is the latest day on or before today; a future row is ignored')
    : bad('latest', JSON.stringify(latestScreenTime(db, TODAY)));
  eq(screenTimeSeries(db, shiftISODate(TODAY, -13), TODAY), [
    { date: other, minutes: 90 },
    { date: DAY, minutes: 130 },
  ])
    ? ok('the series holds recorded days only — no stand-in zeros')
    : bad('series', JSON.stringify(screenTimeSeries(db, shiftISODate(TODAY, -13), TODAY)));
}

console.log('17. screen time reads back through the typed-metric paths');
{
  const { db, raw } = freshDb();
  recentSummary(db, 'screen_time', TODAY) === 'No screen time logged yet'
    ? ok('empty keypad line: no Apple Health fallback claimed (Health has no screen time)')
    : bad('empty screen summary', recentSummary(db, 'screen_time', TODAY));

  // logMetric — every door that reaches it — keeps one row per day.
  logMetric(db, TODAY, 'screen_time', 200);
  logMetric(db, TODAY, 'screen_time', 215);
  const rows = raw
    .prepare(`SELECT value FROM wearable_data WHERE metric_type = 'screen_time_min'`)
    .all();
  rows.length === 1 && rows[0].value === 215
    ? ok('logMetric(screen_time) replaces rather than appends')
    : bad('logMetric replace', JSON.stringify(rows));

  // A day's total is not a capture at a moment, so it stays out of the feed —
  // today's, and above all a number typed this morning for YESTERDAY, which a
  // feed row would stamp with a clock time that never happened on that day
  // (and the Coach's `captures` domain would report it). Water beside it still
  // lists, so the filter is the metric, not the table.
  recordScreenTime(db, shiftISODate(TODAY, -1), 200, 'typed');
  logMetric(db, TODAY, 'water', 500);
  const feed = listTodayEntries(db);
  const yesterdayFeed = listEntriesOn(db, shiftISODate(TODAY, -1));
  !feed.some((row) => row.category === 'Screen time') &&
  feed.some((row) => row.category === 'Water') &&
  yesterdayFeed.length === 0
    ? ok('screen time is not in the Log feed on either day; water still is')
    : bad('feed', JSON.stringify({ feed, yesterdayFeed }));
  recentSummary(db, 'screen_time', TODAY).startsWith('Last 3h 35m · ')
    ? ok('the keypad line names the latest day’s figure')
    : bad('screen summary', recentSummary(db, 'screen_time', TODAY));

  const words = receiptWords(
    { date: '2026-09-24', minutes: 200, via: 'shortcuts', replaced: [{ minutes: 185 }] },
    '2026-09-25'
  );
  words.said === 'Shortcuts filed screen time to yesterday, Thu 24 Sep' &&
  words.figure === '3h 20m, was 3h 5m' &&
  words.spoken === 'Undo screen time 3h 20m for Thu 24 Sep'
    ? ok('a receipt says where it came from, the day, the figure and what it replaced')
    : bad('receipt words', JSON.stringify(words));
  receiptWords({ date: '2026-09-25', minutes: 45, via: 'typed', replaced: [] }, '2026-09-25')
    .said === 'Screen time filed to today, Fri 25 Sep'
    ? ok('a typed first entry reads plainly')
    : bad('typed receipt');
}

console.log('18. screen time: the keypad types hours with its "." key');
{
  const typed = (keys) => keys.reduce((v, k) => keypadPress(v, k), '');
  for (const [keys, expected] of [
    [['h'], ''],
    [['3', 'h'], '3h'],
    [['3', 'h', 'h'], '3h'],
    [['3', 'h', '2', '0'], '3h20'],
    [['3', 'h', '2', '0', '5'], '3h20'],
    [['2', '0', '0', 'h'], '200'],
    [['1', '4', '4', '0', '1'], '1440'],
    [['0', '5'], '5'],
    [['3', 'h', 'del'], '3'],
  ]) {
    typed(keys) === expected
      ? ok(`${keys.join(' ')} → "${expected}"`)
      : bad(`keypad ${keys.join(' ')}`, typed(keys));
  }
  eq(keypadReadout(''), { figure: '0h 0m', unit: '' }) &&
  eq(keypadReadout('200'), { figure: '200', unit: 'min' }) &&
  eq(keypadReadout('3h'), { figure: '3h', unit: '' }) &&
  eq(keypadReadout('3h2'), { figure: '3h 2m', unit: '' })
    ? ok('the readout shows what was typed, with the placeholder naming the h key')
    : bad('readout', JSON.stringify(keypadReadout('3h2')));
}

console.log('19. screen time: a day written forty times keeps a small row');
{
  // The first build stored each predecessor's metadata whole, as a string, so
  // every replace re-escaped the one before it and the row DOUBLED: 863 bytes
  // after five writes, 3 MB after eighteen, and then JSON.stringify threw and
  // the day could never be saved again. Corrections, the keypad and a
  // Shortcut sending "today so far" twice all write the same day, so forty
  // alternating writes is not an exotic case.
  const { db, raw } = freshDb();
  const DAY = shiftISODate(TODAY, -1);
  let longest = 0;
  let last = null;
  for (let i = 0; i < 40; i++) {
    last = recordScreenTime(db, DAY, 100 + i, i % 2 === 0 ? 'typed' : 'shortcuts');
    const row = raw
      .prepare(`SELECT metadata FROM wearable_data WHERE metric_type = 'screen_time_min'`)
      .get();
    longest = Math.max(longest, row.metadata.length);
  }
  const rows = raw
    .prepare(`SELECT value, metadata FROM wearable_data WHERE metric_type = 'screen_time_min'`)
    .all();
  longest < 300 && rows.length === 1 && rows[0].value === 139
    ? ok(`forty writes to one day: one row, metadata never over ${longest} bytes`)
    : bad('metadata growth', `${longest} bytes, ${rows.length} rows`);
  eq(last.replaced, [{ minutes: 138, via: 'typed' }]) &&
  undoScreenTime(db, last.id) &&
  screenTimeOn(db, DAY)?.minutes === 138 &&
  screenTimeOn(db, DAY)?.via === 'typed'
    ? ok('the fortieth write still undoes to the thirty-ninth, door and all')
    : bad('undo after forty', JSON.stringify(last.replaced));
}

console.log('20. screen time: what the command field files, and where');
{
  // The whole of the command field's decision on send (src/components/log/
  // command-field.tsx), lifted into `screenTimeFiling`. Were a screen-time
  // line to take the generic metric path instead, it would land on TODAY
  // every morning — and nothing on screen would look wrong.
  const at = (h, m) => new Date(2026, 8, 25, h, m, 0, 0);
  const file = (text, h, m) => screenTimeFiling(parseCommand(text), at(h, m), '00:00');
  eq(file('st 200', 9, 0), { date: '2026-09-24', minutes: 200 })
    ? ok('"st 200" at 09:00 → yesterday, 24 Sep, 200 min')
    : bad('09:00 filing', JSON.stringify(file('st 200', 9, 0)));
  eq(file('st 200', 13, 0), { date: '2026-09-25', minutes: 200 })
    ? ok('"st 200" at 13:00 → today, 25 Sep')
    : bad('13:00 filing', JSON.stringify(file('st 200', 13, 0)));
  eq(file('screen 3h20 today', 9, 0), { date: '2026-09-25', minutes: 200 }) &&
  eq(file('screen 3h20 yesterday', 13, 0), { date: '2026-09-24', minutes: 200 })
    ? ok('a named day overrides the noon rule either side of noon')
    : bad('named day filing');
  file('screen 30h', 9, 0) === null &&
  file('hrv 48', 9, 0) === null &&
  file('walked down 5th st 20 min', 9, 0) === null
    ? ok('out of range, another metric and a note all file nothing (a note, or their own path)')
    : bad('non-filing lines');

  // And the command field actually takes that path — a render cannot fire the
  // send, so this is a source scan and says so.
  const field = readFileSync(
    new URL('../src/components/log/command-field.tsx', import.meta.url),
    'utf8'
  );
  /screenTimeFiling\(result, new Date\(\)\)/.test(field) &&
  /recordScreenTime\(db, filing\.date, filing\.minutes, 'typed'\)/.test(field) &&
  /result\.metric !== 'screen_time'/.test(field)
    ? ok('the command field files through screenTimeFiling, never the generic metric path')
    : bad('command field no longer files screen time through screenTimeFiling');
}

console.log('21. screen time: the receipt reports a write once, and a link asks when it should');
{
  const today = '2026-09-25';
  const yesterday = '2026-09-24';
  const entry = (id, date, createdAt, via) => ({ id, date, createdAt, via });

  // A Shortcuts write is news until it has been shown, and then it is not.
  const s = entry('s', yesterday, '2026-09-24T23:55:00.000Z', 'shortcuts');
  pickReceipt(null, s, today, null)?.id === 's' &&
  pickReceipt(null, s, today, s.createdAt) === null &&
  pickReceipt(null, entry('s2', today, '2026-09-25T23:55:00.000Z', 'shortcuts'), today, s.createdAt)
    ?.id === 's2'
    ? ok('a Shortcuts write is reported once; the next night’s is reported again')
    : bad('once-only');
  pickReceipt(null, entry('old', '2026-09-22', '2026-09-22T23:55:00.000Z', 'shortcuts'), today, null) ===
  null
    ? ok('a write for a day older than yesterday is not news')
    : bad('old write shown');

  // The reviewer's case: a Shortcut sent yesterday's 200, then 90 was typed
  // for today. The typed write is newer, so it is the receipt; once it has
  // been shown the stamp covers the Shortcut's too — so after its Undo, the
  // next focus does not arm yesterday's number under the same thumb.
  const t = entry('t', today, '2026-09-25T13:10:00.000Z', 'typed');
  pickReceipt(t, s, today, null)?.id === 't' && pickReceipt(null, s, today, t.createdAt) === null
    ? ok('after the typed write is shown and undone, the older Shortcuts write is not re-offered')
    : bad('re-arm after undo');
  // The correction flow: typed T replaced S on the same day; Undo T puts S
  // back with its ORIGINAL timestamp, which the stamp already covers.
  const correction = entry('c', yesterday, '2026-09-25T07:12:00.000Z', 'typed');
  pickReceipt(null, s, today, correction.createdAt) === null
    ? ok('a Shortcuts row an Undo restored is not reported as though it were new')
    : bad('restored row re-offered');

  undoneSentence('2026-09-24', 185) === 'Undone. Thu 24 Sep is back to 3h 5m.' &&
  undoneSentence('2026-09-24', null) === 'Undone. Nothing is on record for Thu 24 Sep.'
    ? ok('after an Undo the row says what the day holds, and offers nothing')
    : bad('undone sentence', undoneSentence('2026-09-24', 185));

  // The cursor: monotone, and the Shortcuts record survives a typed
  // correction — which is what Settings reads "has a Shortcut ever sent a
  // number" from.
  const { db } = freshDb();
  receiptSeenThrough(db) === null && lastShortcutsLink(db) === null
    ? ok('a fresh device has no cursor and no Shortcuts record')
    : bad('fresh cursor');
  markReceiptSeen(db, '2026-09-25T08:00:00.000Z');
  markReceiptSeen(db, '2026-09-24T08:00:00.000Z');
  receiptSeenThrough(db) === '2026-09-25T08:00:00.000Z'
    ? ok('the seen cursor never moves backwards')
    : bad('cursor went backwards', receiptSeenThrough(db));
  const DAY = shiftISODate(TODAY, -1);
  noteShortcutsLink(db, DAY, 200, '2026-09-24T23:55:00.000Z');
  recordScreenTime(db, DAY, 200, 'shortcuts');
  recordScreenTime(db, DAY, 205, 'typed');
  const link = lastShortcutsLink(db);
  recentShortcutsWrite(db, DAY) === null &&
  link?.date === DAY &&
  link.minutes === 200 &&
  receiptSeenThrough(db) === '2026-09-25T08:00:00.000Z'
    ? ok('a typed correction replaces the Shortcut’s row, and the Shortcuts record still says it ran')
    : bad('shortcuts record', JSON.stringify(link));

  // When a valid link may write alone: calendar today or yesterday, over
  // nothing or an earlier Shortcuts number.
  const night = new Date(2026, 8, 25, 23, 55);
  linkWritesSilently('2026-09-25', null, night) &&
  linkWritesSilently('2026-09-24', { minutes: 185, via: 'shortcuts' }, night) &&
  linkWritesSilently('2026-09-25', null, new Date(2026, 8, 26, 0, 30))
    ? ok('today, yesterday, and over an earlier Shortcuts number: written without a tap')
    : bad('silent cases');
  !linkWritesSilently('2026-09-24', { minutes: 185, via: 'typed' }, night) &&
  !linkWritesSilently('2026-09-23', null, night) &&
  !linkWritesSilently('2026-09-01', null, night)
    ? ok('a day holding a typed number, or older than yesterday, waits on a confirm card')
    : bad('confirm cases');

  const typedCard = linkConfirmWords('2026-09-24', 200, { minutes: 185, via: 'typed' });
  typedCard.said === 'Thu 24 Sep holds 3h 5m, typed on Log. The Shortcut sent 3h 20m.' &&
  typedCard.save === 'Replace with 3h 20m' &&
  typedCard.keep === 'Keep 3h 5m'
    ? ok('the card over a typed number names both numbers and both choices')
    : bad('typed card', JSON.stringify(typedCard));
  const olderCard = linkConfirmWords('2026-09-01', 200, null);
  olderCard.said.startsWith('The Shortcut sent 3h 20m for Tue 1 Sep.') &&
  olderCard.save === 'Save 3h 20m' &&
  olderCard.keep === 'Don’t save' &&
  linkConfirmWords('2026-09-01', 200, { minutes: 185, via: 'shortcuts' }).keep === 'Keep 3h 5m'
    ? ok('the card for an older day says why it asks, and what keeping means')
    : bad('older card', JSON.stringify(olderCard));
}

// ---------------------------------------------------------------------------
// 22. A capture removed from the Log tab, and put back exactly (owner,
// 2026-09-25: "Add a delete with an Undo to each capture on the Log tab").
// Every kind the feed lists, through the ONE function the Log tab's × and the
// Coach's `captures` removal both call — `removeLogCapture` — with a recording
// Apple Health seam, so the Health half (a weight's and a glass's tagged
// sample) is proved beside the record half.
console.log('22. every capture removes, and its Undo puts back row and Health sample exactly');
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

// ---------------------------------------------------------------------------
// 23. A capture corrected on the Log tab (owner, 2026-09-26: "Yes, an edit on
// the Log tab, and the Coach too."). Every kind the feed lists, through the
// tap's own path — the row opened (`captureDraft`), the draft changed, Save
// (`saveCaptureEdit` → `editLogCapture`, the one function the Coach's
// `captures` edit calls too) — with a recording Apple Health seam, so the
// Health half (a weight's and a glass's tagged sample, replaced) is proved
// beside the record half, and every side effect the delete traced is checked.
console.log('23. every capture corrects through the Log tab’s own path, and its Health copy follows');
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
  const whole = (table, id) =>
    JSON.stringify(db.get(`SELECT rowid AS r, * FROM ${table} WHERE id = ?`, [id]) ?? null);
  const units = () => getPreferences(db).units;
  const row = (id) => listEntriesOn(db, TODAY, units()).find((e) => e.id === id);
  /** The Save tap: the row opened to what it shows, the draft changed, Save. */
  const tap = (id, change, deps) => {
    const open = openCaptureEdit(db, id);
    const draft = { ...captureDraft(open.capture, open.units), ...change };
    return saveCaptureEdit(db, open, draft, deps);
  };
  setHealthSyncEnabled(db, true);
  const missionBefore = JSON.stringify(listMission(db, TODAY));

  // WORDS — a note and a supplement line. The line is the whole record.
  const noteId = logNote(db, TODAY, 'Slept badly');
  const creatineId = logCapture(db, TODAY, 'supplement', 'Creatine · 5 g', { protocol: true });
  const noteTime = row(noteId).time;
  const quiet = seam();
  const n = tap(noteId, { text: '  Slept badly, 3am wake ' }, quiet.deps);
  const c = tap(creatineId, { text: 'Creatine · 10 g' }, quiet.deps);
  n.saved &&
  c.saved &&
  row(noteId).title === 'Slept badly, 3am wake' &&
  row(noteId).time === noteTime &&
  row(creatineId).title === 'Creatine · 10 g'
    ? ok('a note and a supplement line take new words, trimmed, and keep their time')
    : bad('word edits', JSON.stringify({ n, c, note: row(noteId), line: row(creatineId) }));
  JSON.parse(db.get('SELECT value FROM log_entries WHERE id = ?', [creatineId]).value).protocol ===
  true
    ? ok('…and the supplement keeps its "Part of a protocol" flag: only the line changed')
    : bad('protocol flag lost');

  // NUMBERS that stay in ARC — a dose (a generic metric) and HRV typed by hand.
  logMetric(db, TODAY, 'dose', 5);
  logMetric(db, TODAY, 'hrv', 62);
  const doseId = listEntriesOn(db, TODAY).find((e) => e.category === 'Dose').id;
  const hrvId = listEntriesOn(db, TODAY).find((e) => e.category === 'HRV').id;
  const d = tap(doseId, { value: '10' }, quiet.deps);
  const h = tap(hrvId, { value: '58' }, quiet.deps);
  const doseValue = JSON.parse(db.get('SELECT value FROM log_entries WHERE id = ?', [doseId]).value);
  d.saved &&
  h.saved &&
  row(doseId).title === '10 mg' &&
  doseValue.canonical === 10 &&
  doseValue.metricKey === 'dose' &&
  db.get('SELECT value FROM wearable_data WHERE id = ?', [hrvId]).value === 58
    ? ok('a dose corrects its number and the line drawn from it; HRV its value')
    : bad('number edits', JSON.stringify({ d, h, doseValue }));
  quiet.deleted.length === 0 && quiet.saved.length === 0
    ? ok('…and none of the four touches Apple Health: none of them is ever published')
    : bad('an unpublished kind reached Health', JSON.stringify(quiet));

  // A SYMPTOM — its name and severity, each without the other.
  const symptomId = logSymptom(db, {
    date: TODAY,
    time: '14:00',
    name: 'Headache',
    severity: 6,
    bodyArea: 'forehead',
    notes: null,
  });
  tap(symptomId, { severity: '4' }, quiet.deps);
  const afterSeverity = row(symptomId).title;
  tap(symptomId, { text: 'Tension headache' }, quiet.deps);
  const afterName = row(symptomId).title;
  tap(symptomId, { severity: '' }, quiet.deps);
  const stored = db.get('SELECT name, severity, time, body_area FROM symptoms WHERE id = ?', [
    symptomId,
  ]);
  afterSeverity === 'Headache · 4/10' &&
  afterName === 'Tension headache · 4/10' &&
  row(symptomId).title === 'Tension headache' &&
  stored.severity === null &&
  stored.time === '14:00' &&
  stored.body_area === 'forehead'
    ? ok('a symptom corrects its severity, then its name, then goes unrated — each keeping the rest')
    : bad('symptom edits', JSON.stringify({ afterSeverity, afterName, stored }));
  const eleven = tap(symptomId, { severity: '11' }, quiet.deps);
  !eleven.saved && /1 to 10/.test(eleven.error) && row(symptomId).title === 'Tension headache'
    ? ok('a severity of 11 is refused with the line saying why, and nothing is written')
    : bad('severity 11', JSON.stringify(eleven));

  JSON.stringify(listMission(db, TODAY)) === missionBefore
    ? ok('today’s mission is untouched: an ad-hoc capture ticks no item, so a correction moves none')
    : bad('the mission moved');

  // UNTOUCHED — saving the figure the row prints writes nothing and sends
  // nothing: 176.4 lb converted back is 80.0136 kg, not the 80 kg on record.
  logMetric(db, TODAY, 'weight', 80);
  const weightId = listEntriesOn(db, TODAY).find((e) => e.category === 'Weight').id;
  const bodyId = weightId.split(':')[0];
  const bodyRow = whole('body_metrics', bodyId);
  const untouched = seam(new Set([bodyId]));
  const same = tap(weightId, {}, untouched.deps);
  captureDraft(getCapture(db, weightId, units()), units()).value === '176.4' &&
  same.saved &&
  same.edited === null &&
  whole('body_metrics', bodyId) === bodyRow &&
  untouched.deleted.length === 0
    ? ok('the editor opens to 176.4 lb, and saving it unchanged writes nothing and sends nothing')
    : bad('untouched weight', JSON.stringify({ same, deleted: untouched.deleted }));

  // WEIGHT, already in Apple Health: the record and the sample, by its tag.
  const published = seam(new Set([bodyId]));
  const w = tap(weightId, { value: '174.8' }, published.deps);
  const resent = await w.edited.health;
  const body = db.get('SELECT weight_kg, measured_at, created_at FROM body_metrics WHERE id = ?', [
    bodyId,
  ]);
  const sample = published.saved[0];
  near(body.weight_kg, 174.8 / 2.2046226218) &&
  row(weightId).title === '174.8 lb' &&
  resent === true &&
  JSON.stringify(published.deleted) ===
    JSON.stringify([`HKQuantityTypeIdentifierBodyMass:${bodyId}`]) &&
  published.saved.length === 1 &&
  sample.identifier === 'HKQuantityTypeIdentifierBodyMass' &&
  near(sample.value, body.weight_kg) &&
  sample.at === new Date(body.measured_at).toISOString() &&
  sample.metadata.ARCPublishedFrom === bodyId
    ? ok('a published weight is corrected in the record and replaced in Apple Health: same tag, same instant, new kg')
    : bad('published weight', JSON.stringify({ body, deleted: published.deleted, saved: published.saved }));

  // WEIGHT not in Apple Health yet: the record only — the walk sends the new one.
  const pending = seam();
  const p2 = tap(weightId, { value: '175' }, pending.deps);
  const pendingResent = await p2.edited.health;
  pendingResent === false && pending.saved.length === 0 && row(weightId).title === '175.0 lb'
    ? ok('a weight Apple Health has not been sent yet is corrected in the record and sends nothing')
    : bad('pending weight', JSON.stringify(pending));

  // WATER: the water screen's record half, and its sample replaced.
  logMetric(db, TODAY, 'water', 500);
  const waterId = listEntriesOn(db, TODAY).find((e) => e.category === 'Water').id;
  const glass = seam(new Set([waterId]));
  const g = tap(waterId, { value: '20' }, glass.deps);
  await g.edited.health;
  const ml = db.get('SELECT value, created_at FROM wearable_data WHERE id = ?', [waterId]);
  near(ml.value, 20 * 29.5735295625) &&
  JSON.stringify(glass.deleted) ===
    JSON.stringify([`HKQuantityTypeIdentifierDietaryWater:${waterId}`]) &&
  glass.saved.length === 1 &&
  glass.saved[0].metadata.ARCPublishedFrom === waterId &&
  glass.saved[0].at === new Date(ml.created_at).toISOString()
    ? ok('a glass corrected to 20 oz is replaced in Apple Health at the moment it was drunk')
    : bad('water edit', JSON.stringify({ ml, glass }));

  // SYNC OFF: ARC touches nothing in Apple Health.
  setHealthSyncEnabled(db, false);
  const off = seam(new Set([bodyId, waterId]));
  const o = tap(weightId, { value: '176' }, off.deps);
  await o.edited.health;
  off.deleted.length === 0 && off.saved.length === 0 && row(weightId).title === '176.0 lb'
    ? ok('with Apple Health sync off, the record is corrected and Health is left alone')
    : bad('sync off', JSON.stringify(off));

  // A body row holding TWO readings: only the one corrected moves.
  db.run(
    `INSERT INTO body_metrics (id, measured_at, weight_kg, waist_cm, source)
     VALUES ('two-readings', ?, 81, 84, 'manual')`,
    [new Date().toISOString()]
  );
  tap('two-readings:waist_cm', { value: '32' }, off.deps);
  const two = db.get(`SELECT weight_kg, waist_cm FROM body_metrics WHERE id = 'two-readings'`);
  two.weight_kg === 81 && near(two.waist_cm, 32 * 2.54)
    ? ok('a row with two readings keeps the other one when one is corrected')
    : bad('two readings', JSON.stringify(two));

  // A KG USER edits in kilograms — the unit the row prints.
  setUnitPreference(db, 'weight', 'kg');
  const kgDraft = captureDraft(getCapture(db, weightId, units()), units());
  tap(weightId, { value: '79' }, off.deps);
  kgDraft.value === '79.8' &&
  db.get('SELECT weight_kg FROM body_metrics WHERE id = ?', [bodyId]).weight_kg === 79
    ? ok('a kg user’s editor opens to 79.8 kg, and 79 is stored as exactly 79 kg')
    : bad('kg edit', JSON.stringify(kgDraft));
  setUnitPreference(db, 'weight', 'lb');

  // THE UNIT CHANGED WHILE THE EDITOR WAS OPEN (review, 2026-09-26). The Log
  // tab stays mounted while Settings › Units — or the Coach — switches lb to
  // kg, so Save must read the draft in the unit printed beside it when the
  // row was opened. Read in the unit in force at Save, an untouched "174.2"
  // would be stored as 174.2 kg and sent to Apple Health.
  setHealthSyncEnabled(db, true);
  const moved = seam(new Set([bodyId, waterId]));
  const openLb = openCaptureEdit(db, weightId);
  const lbDraft = captureDraft(openLb.capture, openLb.units);
  const openOz = openCaptureEdit(db, waterId);
  const ozDraft = captureDraft(openOz.capture, openOz.units);
  const bodyBeforeFlip = whole('body_metrics', bodyId);
  const waterBeforeFlip = whole('wearable_data', waterId);
  setUnitPreference(db, 'weight', 'kg');
  setUnitPreference(db, 'volume', 'ml');
  const flippedWeight = saveCaptureEdit(db, openLb, lbDraft, moved.deps);
  const flippedWater = saveCaptureEdit(db, openOz, ozDraft, moved.deps);
  lbDraft.value === '174.2' &&
  ozDraft.value === '20' &&
  flippedWeight.saved &&
  flippedWeight.edited === null &&
  flippedWater.saved &&
  flippedWater.edited === null &&
  whole('body_metrics', bodyId) === bodyBeforeFlip &&
  whole('wearable_data', waterId) === waterBeforeFlip &&
  moved.deleted.length === 0 &&
  moved.saved.length === 0
    ? ok('lb → kg and oz → ml while the editors were open: saving the untouched figures writes and sends nothing')
    : bad(
        'unit flipped under the editor',
        JSON.stringify({ lbDraft, ozDraft, flippedWeight, flippedWater, moved, body: whole('body_metrics', bodyId) })
      );
  const typedLb = saveCaptureEdit(db, openLb, { ...lbDraft, value: '175' }, moved.deps);
  await typedLb.edited?.health;
  const typedKg = db.get('SELECT weight_kg FROM body_metrics WHERE id = ?', [bodyId]).weight_kg;
  typedLb.saved &&
  near(typedKg, 175 / 2.2046226218) &&
  moved.saved.length === 1 &&
  near(moved.saved[0].value, typedKg)
    ? ok('…and 175 typed beside "lb" is stored and sent as 175 lb, though the preference now says kg')
    : bad('typed under a flipped unit', JSON.stringify({ typedLb, typedKg, moved }));
  setUnitPreference(db, 'weight', 'lb');
  setUnitPreference(db, 'volume', 'oz');
  setHealthSyncEnabled(db, false);

  // REFUSED, WRITING NOTHING — at the repository and on the tap.
  const noteBefore = whole('log_entries', noteId);
  let wrongKey = null;
  try {
    editLogCapture(db, noteId, { canonical: 5 }, off.deps);
  } catch (e) {
    wrongKey = e.message;
  }
  let wrongWords = null;
  try {
    correctCapture(db, weightId, { text: 'heavy' });
  } catch (e) {
    wrongWords = e.message;
  }
  /words, not a number/.test(wrongKey ?? '') &&
  /a number, not words/.test(wrongWords ?? '') &&
  whole('log_entries', noteId) === noteBefore
    ? ok('a number sent for a note, or words for a weight, is refused and writes nothing')
    : bad('wrong keys', `${wrongKey} | ${wrongWords}`);
  const blank = tap(noteId, { text: '   ' }, off.deps);
  const huge = tap(weightId, { value: '5000' }, off.deps);
  const junk = tap(weightId, { value: 'heavy' }, off.deps);
  !blank.saved &&
  blank.error === 'Type the words, or remove the entry.' &&
  !huge.saved &&
  huge.error === 'That weight is out of range.' &&
  !junk.saved &&
  junk.error === 'Type a number.' &&
  whole('log_entries', noteId) === noteBefore
    ? ok('empty words, 5000 lb and a word for a number each say why, and nothing is written')
    : bad('tap refusals', JSON.stringify({ blank, huge, junk }));
  const unchangedSymptom = captureDraftPatch(
    getCapture(db, symptomId, units()),
    { text: 'Tension headache ', value: '', severity: '' },
    units()
  );
  unchangedSymptom.patch === null
    ? ok('a draft that says what the row says is no correction at all')
    : bad('no-op draft', JSON.stringify(unchangedSymptom));

  // NOT A CAPTURE: screen time is a day's total, corrected where it is typed.
  const screen = recordScreenTime(db, TODAY, 200, 'typed');
  getCapture(db, screen.id) === undefined &&
  editLogCapture(db, screen.id, { canonical: 100 }, off.deps) === null &&
  editLogCapture(db, 'no-such-id', { text: 'x' }, off.deps) === null &&
  db.get('SELECT value FROM wearable_data WHERE id = ?', [screen.id]).value === 200
    ? ok('screen time and an unknown id are not captures: nothing is found, nothing is written')
    : bad('not a capture');

  // AFTER A CORRECTION, the × and its Undo still round-trip the corrected row.
  const corrected = whole('log_entries', creatineId);
  const removed = removeLogCapture(db, creatineId, off.deps);
  void restoreLogCapture(db, removed, off.deps);
  whole('log_entries', creatineId) === corrected
    ? ok('a corrected row removes and comes back as corrected')
    : bad('undo after edit');
}

// ---------------------------------------------------------------------------
// 24–27. The quick-log box behind the Action Button (item 63; ADR "Action
// Button via a native App Intent", 2026-10-21). §24 the gate, §25 what a line
// does, §26 the link and the screens it reaches, §27 the native wiring — the
// Swift is uncompiled on this machine, so its names are pinned at the source.
console.log('24. quick launch: held while the lock is up, delivered once when it lifts');
{
  const NOW = Date.UTC(2026, 9, 21, 9, 0, 0);
  const fakeSource = () => {
    const listeners = new Set();
    return {
      stamp: null,
      takes: 0,
      take() {
        this.takes++;
        const s = this.stamp;
        this.stamp = null;
        return s;
      },
      onRequest(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      fire() {
        for (const l of [...listeners]) l();
      },
      get listening() {
        return listeners.size;
      },
    };
  };
  const fakeGate = (ready = false) => ({
    ready,
    delivered: 0,
    isReady() {
      return this.ready;
    },
    deliver() {
      this.delivered++;
    },
  });

  // COLD, LOCKED: the intent ran before JavaScript; the stamp is waiting.
  const ledger = createQuickLaunchLedger();
  const source = fakeSource();
  source.stamp = NOW - 1500;
  const gate = fakeGate(false);
  const routing = routeQuickLaunches(source, gate, ledger, () => NOW);
  gate.delivered === 0 && ledger.pending === true && source.stamp === null
    ? ok('a cold intent launch under the lock is taken (once) and HELD, not routed')
    : bad('cold locked', JSON.stringify({ d: gate.delivered, p: ledger.pending }));
  routing.flush();
  routing.flush();
  gate.delivered === 0
    ? ok('state changes while still locked deliver nothing')
    : bad('delivered under the lock');
  gate.ready = true;
  routing.flush();
  routing.flush();
  routing.check();
  gate.delivered === 1 && ledger.pending === false
    ? ok('the lock lifts: delivered exactly once, however many re-checks follow')
    : bad('once after unlock', String(gate.delivered));

  // WARM: the event, and a second press, before Face ID — one box.
  gate.ready = false;
  source.stamp = NOW;
  source.fire();
  source.stamp = NOW;
  source.fire();
  gate.ready = true;
  routing.flush();
  gate.delivered === 2
    ? ok('two warm presses behind the lock open ONE box when it lifts')
    : bad('warm coalesce', String(gate.delivered));
  // The event and the foreground re-check race on one press: whoever reads first.
  source.stamp = NOW;
  source.fire();
  routing.check();
  gate.delivered === 3
    ? ok('the event and the foreground re-check on one press deliver once')
    : bad('event vs foreground', String(gate.delivered));

  // THE LINK DOOR: arc://quick while the app is open and unlocked goes straight through.
  requestQuickLaunch(ledger);
  gate.delivered === 4
    ? ok('an arc://quick request wakes the router and delivers at once when the gate is open')
    : bad('link wake', String(gate.delivered));

  // STALE / SKEWED stamps.
  source.stamp = NOW - 3 * 60 * 1000;
  routing.check();
  source.stamp = NOW + 2000;
  routing.check();
  gate.delivered === 5 &&
  isFreshRequest(NOW - 119_000, NOW) &&
  !isFreshRequest(NOW - 121_000, NOW) &&
  !isFreshRequest(NOW + 6000, NOW) &&
  !isFreshRequest(null, NOW) &&
  !isFreshRequest(Number.NaN, NOW)
    ? ok('a stamp older than two minutes is dropped; a few seconds of clock skew is not')
    : bad('freshness', String(gate.delivered));

  // STOP: nothing is delivered after it, and a waiting request survives it.
  routing.stop();
  requestQuickLaunch(ledger);
  source.listening === 0 && gate.delivered === 5 && ledger.pending === true
    ? ok('a stopped router delivers nothing and lets go of the event; the request waits')
    : bad('stop', JSON.stringify({ l: source.listening, d: gate.delivered }));
  const again = routeQuickLaunches(null, gate, ledger, () => NOW);
  gate.delivered === 6 && ledger.pending === false
    ? ok('the next registration (a remounted layout) delivers what waited, once')
    : bad('remount', String(gate.delivered));
  again.stop();

  // A LINK BEFORE ANY ROUTER EXISTS — the cold initial URL is read first.
  const early = createQuickLaunchLedger();
  requestQuickLaunch(early);
  const lockedGate = fakeGate(false);
  const late = routeQuickLaunches(null, lockedGate, early, () => NOW);
  lockedGate.delivered === 0 && early.pending
    ? ok('a link read before the layout registers waits, and is held by a locked gate')
    : bad('early link');
  lockedGate.ready = true;
  late.flush();
  late.flush();
  lockedGate.delivered === 1
    ? ok('…and is delivered once when the gate opens')
    : bad('early link delivery', String(lockedGate.delivered));
  late.stop();

  // FAILURES: a throwing gate holds; a throwing delivery is not retried.
  const shaky = createQuickLaunchLedger();
  let attempts = 0;
  const r = routeQuickLaunches(
    null,
    {
      isReady: () => {
        throw new Error('no state');
      },
      deliver: () => attempts++,
    },
    shaky
  );
  requestQuickLaunch(shaky);
  r.stop();
  const r2 = routeQuickLaunches(
    null,
    {
      isReady: () => true,
      deliver: () => {
        attempts++;
        throw new Error('push failed');
      },
    },
    shaky
  );
  r2.flush();
  r2.stop();
  attempts === 1 && shaky.pending === false
    ? ok('a gate that throws holds the request; a delivery that throws is attempted once')
    : bad('failures', JSON.stringify({ attempts, pending: shaky.pending }));
}

console.log('25. quick box: a metric files as the Log tab files it, anything else is food');
{
  // 09:00 under a midnight boundary: screen time files to yesterday (noon rule).
  const at = new Date(2026, 9, 21, 9, 0, 0, 0);
  const act = (line) => quickLineAction(line, undefined, at, '00:00');
  const cases = [
    ['weight 178', (a) => a.kind === 'metric' && a.metric === 'weight'],
    ['weight 178 this morning', (a) => a.kind === 'metric' && a.metric === 'weight'],
    ['16 oz water', (a) => a.kind === 'metric' && a.metric === 'water'],
    ['hrv 48', (a) => a.kind === 'metric' && a.metric === 'hrv' && a.canonical === 48],
    ['bf 18', (a) => a.kind === 'metric' && a.metric === 'body_fat' && a.canonical === 18],
    ['180 lb', (a) => a.kind === 'metric' && a.metric === 'weight'],
    ['48 ms', (a) => a.kind === 'metric' && a.metric === 'hrv'],
    ['st 200', (a) => eq(a, { kind: 'screen_time', date: '2026-10-20', minutes: 200 })],
    ['weight 0', (a) => eq(a, { kind: 'note', text: 'weight 0' })],
    ['screen 30h', (a) => a.kind === 'note'],
    ['2 eggs and toast', (a) => eq(a, { kind: 'food', description: '2 eggs and toast' })],
    ['1 lb ground beef', (a) => a.kind === 'food'],
    ['chicken thighs 0.5 kg', (a) => a.kind === 'food'],
    ['grilled salmon, ½ cup rice, steamed broccoli', (a) => a.kind === 'food'],
    ['black coffee', (a) => a.kind === 'food'],
    ['glass of water', (a) => a.kind === 'food'],
    ['  oats  with   berries ', (a) => eq(a, { kind: 'food', description: 'oats  with   berries' })],
    ['   ', (a) => a.kind === 'empty'],
  ];
  const wrong = cases.filter(([line, pass]) => !pass(act(line)));
  wrong.length === 0
    ? ok(`${cases.length} sample lines land as metric, screen time, note, food or nothing as expected`)
    : bad('quick lines', wrong.map(([l]) => `${l} → ${JSON.stringify(act(l))}`).join('; '));

  // The one place the box is stricter than the Log tab, and why.
  parseCommand('1 lb ground beef').kind === 'metric' && act('1 lb ground beef').kind === 'food'
    ? ok('a unit-only weight inside a food line ("1 lb ground beef") is food here, not a weigh-in')
    : bad('unit-only hazard');

  // A line that is a metric here is the SAME metric the Log tab files.
  const same = ['weight 178', '16 oz water', 'hrv 48', 'bf 18'].every((line) => {
    const a = act(line);
    const p = parseCommand(line);
    return a.kind === 'metric' && p.kind === 'metric' && a.metric === p.metric && near(a.canonical, p.canonical);
  });
  same ? ok('every metric line files the value parseCommand gives the Log tab') : bad('metric parity');

  // Past midnight under a 04:00 boundary, screen time files wherever the
  // command field's own rule files it (§14/§20: Apple's day is the calendar's),
  // because the box calls the same `screenTimeFiling` with the same boundary.
  const small = new Date(2026, 9, 21, 1, 0, 0, 0);
  const late = quickLineAction('st 200', undefined, small, '04:00');
  eq(late, { kind: 'screen_time', ...screenTimeFiling(parseCommand('st 200'), small, '04:00') })
    ? ok('past midnight under a 04:00 boundary, screen time files exactly as the command field files it')
    : bad('boundary parity', JSON.stringify(late));
  // And the metric rows land under the LOGICAL day: at 01:00 under a 04:00
  // boundary that is still the 20th (the screen passes todayISODate(now)).
  todayISODate(small, '04:00') === '2026-10-20'
    ? ok('at 01:00 under a 04:00 boundary the box files to the 20th, the logical day')
    : bad('logical day', todayISODate(small, '04:00'));
}

console.log('26. quick box: arc://quick, the route it reaches, and the hand-offs');
{
  const yes = ['arc://quick', 'arc:///quick', 'arc://quick/', 'arc://quick?from=shortcut', '/quick', 'quick', 'ARC://Quick'];
  const no = ['arc://quick-log', 'arc://quickly', 'arc://log/quick', 'arc://', 'arc://log/screen-time?minutes=200', 'arc://expo-sharing'];
  yes.every(isQuickLink) && !no.some(isQuickLink)
    ? ok('arc://quick (any slash, query or case) is the link; its neighbours are not')
    : bad('isQuickLink', JSON.stringify({ y: yes.filter((p) => !isQuickLink(p)), n: no.filter(isQuickLink) }));

  // The redirect queues on the APP ledger and navigates nowhere on its own.
  const gate = { delivered: 0, isReady: () => true, deliver() { this.delivered++; } };
  const routing = routeQuickLaunches(null, gate);
  const cold = redirectSystemPath({ path: 'arc://quick', initial: true });
  const warm = redirectSystemPath({ path: 'arc://quick', initial: false });
  routing.stop();
  cold === null && warm === null && gate.delivered === 2
    ? ok('+native-intent hands arc://quick to the gate and returns null, cold or warm')
    : bad('redirect', JSON.stringify({ cold, warm, d: gate.delivered }));
  redirectSystemPath({ path: 'arc://quick-log', initial: false }) === 'arc://quick-log' &&
  redirectSystemPath({ path: 'arc://expo-sharing', initial: true }) === '/recipe-import'
    ? ok('every other path is untouched, and a share still goes to /recipe-import')
    : bad('redirect neighbours');

  const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const layout = src('app/_layout.tsx');
  QUICK_LOG_ROUTE === '/quick-log' &&
  /<Stack\.Screen name="quick-log" \/>/.test(layout) &&
  /registerQuickLaunchRouting\(\{\s*isReady: \(\) =>\s*!coveredRef\.current &&\s*navRef\.isReady\(\) &&\s*appNavigatorMounted\(/.test(layout) &&
  /router\.push\(QUICK_LOG_ROUTE\)/.test(layout) &&
  /quickRef\.current\?\.flush\(\);/.test(layout) &&
  /if \(state === 'active'\) quick\.check\(\);/.test(layout)
    ? ok('the layout gates the box on the cover AND the mounted Stack, and re-checks on unlock and foreground')
    : bad('layout wiring');

  const screen = src('app/quick-log.tsx');
  /quickLineAction\(text, units, now\)/.test(screen) &&
  /pathname: '\/meal-estimate', params: \{ describe: action\.description \}/.test(screen) &&
  /pathname: '\/meal-estimate', params: \{ start: 'camera' \}/.test(screen) &&
  /todayISODate\(now\)/.test(screen) &&
  /logMetricCapture\(db, date, action\.metric, action\.canonical\)/.test(screen) &&
  /recordScreenTime\(db, action\.date, action\.minutes, 'typed'\)/.test(screen) &&
  /autoFocus/.test(screen)
    ? ok('the screen focuses its box, files metrics on the logical day, and hands food and the camera to /meal-estimate')
    : bad('quick-log screen');

  const estimate = src('app/meal-estimate.tsx');
  /describe\?: string/.test(estimate) &&
  /useState\(handoff\)/.test(estimate) &&
  /void run\(\{ kind: 'text', description: handoff \}\)/.test(estimate)
    ? ok('meal-estimate fills its field from `describe` and runs it once')
    : bad('meal-estimate handoff');
}

console.log('27. quick box: the App Intent and its module are wired into the build');
{
  const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const exists = (p) => {
    try {
      readFileSync(new URL(`../${p}`, import.meta.url));
      return true;
    } catch {
      return false;
    }
  };
  const intent = src('modules/arc-intents/app-target/ArcQuickLogIntent.swift');
  const module = src('modules/arc-intents/ios/ArcIntentsModule.swift');
  const podspec = src('modules/arc-intents/ios/ArcIntents.podspec');
  const config = JSON.parse(src('modules/arc-intents/expo-module.config.json'));
  const plugin = src('modules/arc-intents/app.plugin.js');
  const app = JSON.parse(src('app.json')).expo;

  /^import AppIntents$/m.test(intent) &&
  /struct ArcQuickLogIntent: AppIntent \{/.test(intent) &&
  /static let title: LocalizedStringResource = "Log in ARC"/.test(intent) &&
  /static let openAppWhenRun: Bool = true/.test(intent) &&
  /func perform\(\) async throws -> some IntentResult \{/.test(intent) &&
  /struct ArcAppShortcuts: AppShortcutsProvider \{/.test(intent) &&
  /static var appShortcuts: \[AppShortcut\] \{/.test(intent) &&
  /intent: ArcQuickLogIntent\(\)/.test(intent)
    ? ok('the Swift declares the "Log in ARC" intent (opens the app) and its AppShortcutsProvider')
    : bad('intent declarations');
  const phrases = [...intent.matchAll(/^\s*"([^"]*)",?$/gm)].map((m) => m[1]);
  phrases.length >= 1 && phrases.every((p) => (p.match(/\\\(\.applicationName\)/g) ?? []).length === 1)
    ? ok(`every App Shortcut phrase names the app exactly once (${phrases.length} phrases)`)
    : bad('phrases', JSON.stringify(phrases));

  // The three strings, spelled in three places.
  const key = /"arc\.quickLog\.requestedAt"/;
  const note = /Notification\.Name\("ArcQuickLogRequested"\)/;
  key.test(intent) && key.test(module) && note.test(intent) && note.test(module)
    ? ok('the intent and the module agree on the UserDefaults key and the notification name')
    : bad('stamp strings');
  module.includes(`Name("${ARC_INTENTS_MODULE}")`) &&
  module.includes(`let arcQuickLogEvent = "${QUICK_LOG_EVENT}"`) &&
  /Events\(arcQuickLogEvent\)/.test(module) &&
  /Function\("takeQuickLogRequest"\)/.test(module) &&
  /takeQuickLogRequest/.test(src('src/lib/log/quick-launch.ts'))
    ? ok('the module name, event and function match what quick-launch.ts asks for')
    : bad('module ↔ JS names');

  eq(config, { platforms: ['apple'], apple: { modules: ['ArcIntentsModule'] } }) &&
  /public class ArcIntentsModule: Module/.test(module) &&
  /s\.name\s+= 'ArcIntents'/.test(podspec) &&
  /s\.dependency 'ExpoModulesCore'/.test(podspec)
    ? ok('expo-module.config.json, the class and the podspec name one module (autolinked from modules/)')
    : bad('module config');

  // The intent rides the APP target, never the pod: outside ios/, and a plugin puts it there.
  !exists('modules/arc-intents/ios/ArcQuickLogIntent.swift') &&
  app.plugins.includes('./modules/arc-intents/app.plugin.js') &&
  /withBuildSourceFile/.test(plugin) &&
  /'app-target', INTENT_FILE/.test(plugin) &&
  /const INTENT_FILE = 'ArcQuickLogIntent\.swift'/.test(plugin) &&
  !/AppShortcutsProvider/.test(module)
    ? ok('app.json runs the plugin that compiles the intent into the app target; the pod holds no second provider')
    : bad('plugin wiring');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
