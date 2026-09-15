/**
 * Headless test of the water data layer — src/lib/db/repositories/water.ts over
 * `wearable_data` (0001, rebuilt in 0021) plus the hydration goal in the
 * preferences blob — against real SQLite via node:sqlite. Mirrors
 * db/symptoms.test.mjs; op-sqlite is never loaded. Run: npm run db:test.
 *
 * §1 is the one that justified the whole screen. The brief for app/water.tsx
 * warned that `water_ml` might be "a running daily total that quick-add
 * mutates", which would make *editing an entry* inexpressible — there would be
 * no entries, only a number that got overwritten. These assertions establish the
 * shape directly against SQLite rather than by reading the source: three logs on
 * one day are THREE ROWS, and correcting one leaves the others alone.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { logMetric } from '../src/lib/db/repositories/logs.ts';
import {
  getPreferences,
  getWaterTarget,
  setUnitPreference,
  setWaterTarget,
} from '../src/lib/db/repositories/user.ts';
import {
  deleteWaterEntry,
  listWaterEntries,
  logWater,
  updateWaterEntry,
  usualWaterAmount,
  USUAL_WINDOW_DAYS,
  waterDaySeries,
  waterRecordStart,
} from '../src/lib/db/repositories/water.ts';
import { upsertWearableRows } from '../src/lib/db/repositories/wearables.ts';
import { metricByKey, resolveDisplay, roundToSpec } from '../src/lib/log/metrics.ts';
import { WATER_QUICK_AMOUNTS } from '../src/lib/log/water-amounts.ts';
import { STATISTIC_METRICS, statisticDailyRows } from '../src/lib/health/mapping.ts';

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
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

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
const dayBefore = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return todayISODate(d);
};

// ---------------------------------------------------------------------------
console.log('1. Water is stored PER CAPTURE, not as a mutable daily total');
{
  const { db } = freshDb();

  logWater(db, TODAY, 500);
  logWater(db, TODAY, 500);
  logWater(db, TODAY, 500);

  const rows = db.all(`SELECT * FROM wearable_data WHERE metric_type = 'water_ml'`);
  rows.length === 3
    ? ok('three 500 ml logs on one day produce THREE rows, not one mutated total')
    : bad('per-capture rows', `expected 3 rows, got ${rows.length}`);

  const total = db.get(`SELECT sum(value) t FROM wearable_data WHERE metric_type = 'water_ml'`);
  total.t === 1500 ? ok('they sum to 1500 ml') : bad('sum', String(total.t));

  // This is WHY they cannot collide: the table's only unique index is partial,
  // and a manual capture leaves source_raw_id NULL, so the index never applies.
  rows.every((r) => r.source_raw_id === null && r.source_device === 'manual')
    ? ok('every manual row leaves source_raw_id NULL, so the partial unique index never applies')
    : bad('manual rows carry no raw id', JSON.stringify(rows));

  const idx = db.get(
    `SELECT sql FROM sqlite_master WHERE type='index' AND name='wearable_data_device_raw_id_key'`
  );
  idx && idx.sql.includes('WHERE source_raw_id IS NOT NULL')
    ? ok(
        'the unique index on (source_device, source_raw_id) is PARTIAL — the reason two logs coexist'
      )
    : bad('partial unique index', JSON.stringify(idx));

  // The keypad's path (logMetric) writes the SAME shape, so the two writers
  // cannot diverge and neither can shadow the other.
  logMetric(db, TODAY, 'water', 250);
  const after = db.all(`SELECT * FROM wearable_data WHERE metric_type = 'water_ml'`);
  after.length === 4 && after.every((r) => r.unit === 'ml')
    ? ok('logMetric (the keypad) appends an identical fourth row, canonical ml')
    : bad('logMetric parity', `${after.length} rows`);
}

// ---------------------------------------------------------------------------
console.log('\n2. Edit and delete hit exactly one entry');
{
  const { db } = freshDb();
  const a = logWater(db, TODAY, 500);
  const b = logWater(db, TODAY, 500);
  const c = logWater(db, TODAY, 500);

  updateWaterEntry(db, a, 750) === true
    ? ok('updateWaterEntry reports the correction landed')
    : bad('update returns true');

  const afterUpdate = listWaterEntries(db, TODAY);
  afterUpdate.length === 3 &&
  afterUpdate.find((e) => e.id === a).ml === 750 &&
  afterUpdate.find((e) => e.id === b).ml === 500 &&
  afterUpdate.find((e) => e.id === c).ml === 500
    ? ok('correcting one entry to 750 leaves the other two at 500 — no total was rewritten')
    : bad('per-entry update', JSON.stringify(afterUpdate));

  deleteWaterEntry(db, c) === true
    ? ok('deleteWaterEntry reports the removal landed')
    : bad('delete returns true');

  const afterDelete = listWaterEntries(db, TODAY);
  afterDelete.length === 2 && afterDelete.every((e) => e.id !== c)
    ? ok('the deleted entry is gone and the survivors are untouched')
    : bad('per-entry delete', JSON.stringify(afterDelete));

  const day = waterDaySeries(db, 1, TODAY)[0];
  day.ml === 1250 && day.entries === 2
    ? ok('the day total re-derives from the surviving rows (750 + 500 = 1250, 2 entries)')
    : bad('total after edit + delete', JSON.stringify(day));

  // An unknown id is a no-op that SAYS it did nothing, rather than silently
  // reporting success to a screen that would then claim it corrected something.
  updateWaterEntry(db, 'nope', 100) === false && deleteWaterEntry(db, 'nope') === false
    ? ok('an unknown id is a reported no-op, never a silent success')
    : bad('unknown id must return false');

  throws(() => logWater(db, TODAY, 0)) &&
  throws(() => logWater(db, TODAY, -5)) &&
  throws(() => updateWaterEntry(db, a, 0))
    ? ok('a zero or negative amount is rejected on write — an intake of nothing is not an event')
    : bad('non-positive amounts must throw');
}

// ---------------------------------------------------------------------------
console.log('\n3. Device-sourced rows are NOT editable');
{
  const { db } = freshDb();
  const manual = logWater(db, TODAY, 500);
  // A hypothetical future HealthKit water channel: a day-bucket row with a
  // deterministic raw id, which a re-sync UPDATEs. Editing it by hand would be
  // silently reverted on the next sync, so the repository refuses.
  upsertWearableRows(db, [
    {
      date: TODAY,
      metricType: 'water_ml',
      value: 900,
      unit: 'ml',
      sourceDevice: 'apple_health',
      sourceRawId: `hk:water_ml:${TODAY}`,
      startTime: null,
      endTime: null,
      metadata: {},
    },
  ]);

  const entries = listWaterEntries(db, TODAY);
  const synced = entries.find((e) => e.source === 'apple_health');
  entries.length === 2 && synced && synced.editable === false
    ? ok('a synced row is listed but flagged non-editable')
    : bad('synced row flagged', JSON.stringify(entries));

  entries.find((e) => e.id === manual).editable === true
    ? ok('the manual row beside it stays editable')
    : bad('manual row editable');

  updateWaterEntry(db, synced.id, 100) === false && deleteWaterEntry(db, synced.id) === false
    ? ok('editing or deleting a synced row is refused, not silently applied')
    : bad('synced rows must refuse edits');

  db.get(`SELECT value FROM wearable_data WHERE id = ?`, [synced.id]).value === 900
    ? ok('...and the synced value is genuinely unchanged')
    : bad('synced value must survive');

  // Both sources still count toward the day: the total is what you drank.
  const day = waterDaySeries(db, 1, TODAY)[0];
  day.ml === 1400 && day.entries === 2
    ? ok('the day total spans every source (500 manual + 900 synced)')
    : bad('total across sources', JSON.stringify(day));
}

// ---------------------------------------------------------------------------
console.log('\n4. The window: every day present, and absence is never a zero reading');
{
  const { db } = freshDb();
  waterRecordStart(db) === null
    ? ok('an untouched database has no record start')
    : bad('empty record start');

  const emptySeries = waterDaySeries(db, 14, TODAY);
  emptySeries.length === 14 && emptySeries.every((d) => d.ml === 0 && d.entries === 0)
    ? ok('an empty window is still 14 points, all { ml: 0, entries: 0 }')
    : bad('empty window shape', JSON.stringify(emptySeries));

  logWater(db, dayBefore(3), 1000);
  logWater(db, dayBefore(3), 500);
  logWater(db, TODAY, 2000);

  waterRecordStart(db) === dayBefore(3)
    ? ok('the record starts on the earliest day logged, not on the window edge')
    : bad('record start', waterRecordStart(db));

  const series = waterDaySeries(db, 14, TODAY);
  series.length === 14 ? ok('the window is exactly 14 points') : bad('window length');

  const three = series.find((d) => d.date === dayBefore(3));
  three.ml === 1500 && three.entries === 2
    ? ok('a day with two captures reports the SUM and the COUNT (1500 ml, 2 entries)')
    : bad('day aggregate', JSON.stringify(three));

  // The honesty seam: a day with nothing logged carries entries === 0, which is
  // what the screen keys its em-dash on. `ml === 0` alone could not distinguish
  // "nothing logged" from a genuine zero if one were ever storable.
  const quiet = series.find((d) => d.date === dayBefore(2));
  quiet.entries === 0 && quiet.ml === 0
    ? ok('a day with nothing logged reports entries === 0 — the flag the screen renders "—" from')
    : bad('quiet day', JSON.stringify(quiet));

  series[series.length - 1].date === TODAY && series[0].date === dayBefore(13)
    ? ok('the window runs oldest → newest and ends on today')
    : bad('window order', `${series[0].date} .. ${series[series.length - 1].date}`);

  // Rows outside the window must not leak into it.
  logWater(db, dayBefore(40), 999);
  const stillFourteen = waterDaySeries(db, 14, TODAY);
  stillFourteen.length === 14 && stillFourteen.every((d) => d.date >= dayBefore(13))
    ? ok('a capture 40 days back stays out of the 14-day window')
    : bad('window bound leak');
  waterRecordStart(db) === dayBefore(40)
    ? ok('...but it does move the record start, which is what clips the window')
    : bad('record start after backdated row');
}

// ---------------------------------------------------------------------------
console.log('\n5. Entries are ordered, and carry their clock');
{
  const { db } = freshDb();
  logWater(db, TODAY, 100);
  logWater(db, TODAY, 200);
  logWater(db, TODAY, 300);
  const entries = listWaterEntries(db, TODAY);
  entries.length === 3 && entries[0].ml === 100 && entries[2].ml === 300
    ? ok('entries come back earliest first, in capture order')
    : bad('entry order', JSON.stringify(entries.map((e) => e.ml)));
  entries.every((e) => typeof e.at === 'string' && e.at.endsWith('Z'))
    ? ok('each entry carries its ISO instant for the time column')
    : bad('entry timestamps');
  listWaterEntries(db, dayBefore(1)).length === 0
    ? ok('a day with no captures lists nothing (not a fabricated row)')
    : bad('empty day listing');
}

// ---------------------------------------------------------------------------
console.log('\n6. The hydration goal: absent by default, never invented');
{
  const { db } = freshDb();
  getWaterTarget(db) === null
    ? ok('no goal is set by default — a denominator the user never chose is not invented')
    : bad('default goal must be null', String(getWaterTarget(db)));

  setWaterTarget(db, 3000);
  getWaterTarget(db) === 3000 ? ok('a goal round-trips in canonical ml') : bad('goal round-trip');

  setWaterTarget(db, null);
  getWaterTarget(db) === null ? ok('a goal can be cleared back to none') : bad('goal clear');

  // A zero goal would make every day 100% of nothing — it reads as "no goal".
  setWaterTarget(db, 0);
  getWaterTarget(db) === null
    ? ok('a zero goal reads as no goal, never as a target of 0')
    : bad('zero goal');

  // The blob is SHARED, so the merge has to be real in both directions: a goal
  // must not clobber a unit choice, and a unit change must not clobber the goal.
  // (Units are defaults-on-read and only persist once explicitly set, so this
  // has to set one first to have anything to preserve.)
  setUnitPreference(db, 'volume', 'ml');
  setWaterTarget(db, 2500);
  const prefs = JSON.parse(db.get(`SELECT preferences FROM users LIMIT 1`).preferences);
  prefs.goals.waterMl === 2500 && prefs.units.volume === 'ml'
    ? ok('setting a goal preserves an existing unit choice in the shared blob')
    : bad('goal must not clobber units', JSON.stringify(prefs));

  setUnitPreference(db, 'volume', 'oz');
  getWaterTarget(db) === 2500 && getPreferences(db).units.volume === 'oz'
    ? ok('...and changing a unit afterwards preserves the goal')
    : bad('units must not clobber goal', JSON.stringify(getWaterTarget(db)));
}

// ---------------------------------------------------------------------------
console.log('\n7. The remembered amount — what the Log tab’s Water tile logs in one tap');
{
  // Resolved through the real display spec, so the values under test are the
  // exact doubles the tile would store rather than hand-picked round numbers.
  const specFor = (db) => resolveDisplay(metricByKey('water'), getPreferences(db).units);

  {
    const { db } = freshDb();
    usualWaterAmount(db, TODAY) === null
      ? ok('an empty record has no usual amount — the caller falls back to a Glass')
      : bad('empty record must be null', String(usualWaterAmount(db, TODAY)));
  }

  {
    const { db } = freshDb();
    const spec = specFor(db);
    const oz16 = spec.toCanonical(16);
    const oz8 = spec.toCanonical(8);
    for (let i = 0; i < 5; i++) logWater(db, TODAY, oz16);
    logWater(db, TODAY, oz8);
    logWater(db, TODAY, oz8);
    usualWaterAmount(db, TODAY) === oz16
      ? ok('five 16 oz against two 8 oz resolves to the 16 oz canonical value')
      : bad('most frequent wins', String(usualWaterAmount(db, TODAY)));

    // The invariant the tile rests on: the number it PRINTS is the number it
    // logs. Print = round(fromCanonical(usual)); log = toCanonical(print).
    const printed = roundToSpec(spec, spec.fromCanonical(usualWaterAmount(db, TODAY)));
    printed === 16 && spec.toCanonical(printed) === usualWaterAmount(db, TODAY)
      ? ok('...and it round-trips exactly: the printed 16 oz converts back to the stored value')
      : bad('print/log round trip', String(printed));
  }

  {
    // Not "last logged": one small dose must not retrain the button.
    const { db } = freshDb();
    const spec = specFor(db);
    for (let i = 0; i < 3; i++) logWater(db, TODAY, spec.toCanonical(16));
    logWater(db, TODAY, spec.toCanonical(4));
    usualWaterAmount(db, TODAY) === spec.toCanonical(16)
      ? ok('a single 4 oz pill-swallow logged last does NOT become the usual')
      : bad('frequency, not recency', String(usualWaterAmount(db, TODAY)));
  }

  {
    // A genuine tie goes to the more recent. created_at resolves to the
    // millisecond and both of these land inside one, so this is really pinning
    // the rowid tie-break.
    const { db } = freshDb();
    const spec = specFor(db);
    logWater(db, TODAY, spec.toCanonical(8));
    logWater(db, TODAY, spec.toCanonical(24));
    usualWaterAmount(db, TODAY) === spec.toCanonical(24)
      ? ok('a one-all tie goes to the more recent amount')
      : bad('tie-break', String(usualWaterAmount(db, TODAY)));
  }

  {
    // The window agrees with the water screen's WINDOW_DAYS. Three 8 oz logs
    // twenty days back must not outvote one 16 oz today.
    const { db } = freshDb();
    const spec = specFor(db);
    USUAL_WINDOW_DAYS === 14
      ? ok('the learning window is 14 days, matching the water screen')
      : bad('window drifted', String(USUAL_WINDOW_DAYS));
    for (let i = 0; i < 3; i++) logWater(db, dayBefore(20), spec.toCanonical(8));
    logWater(db, TODAY, spec.toCanonical(16));
    usualWaterAmount(db, TODAY) === spec.toCanonical(16)
      ? ok('captures outside the 14-day window are ignored, however many there are')
      : bad('window bound', String(usualWaterAmount(db, TODAY)));
  }

  {
    // An Apple Health DAY BUCKET is not a vessel and must never be learned
    // from. Inserted AFTER the manual row and far larger, so a missing filter
    // would let it win on both the count tie-break and the recency one.
    const { db } = freshDb();
    const spec = specFor(db);
    logWater(db, TODAY, spec.toCanonical(8));
    upsertWearableRows(db, [
      {
        date: TODAY,
        metricType: 'water_ml',
        value: 2400,
        unit: 'ml',
        sourceDevice: 'apple_health',
        sourceRawId: `hk:water_ml:${TODAY}`,
        startTime: null,
        endTime: null,
        metadata: { hk: { merged: true } },
      },
    ]);
    usualWaterAmount(db, TODAY) === spec.toCanonical(8)
      ? ok('a synced day bucket is ignored even when it is the largest and the most recent')
      : bad('device rows must not train the tile', String(usualWaterAmount(db, TODAY)));
  }

  {
    // The ml side. Under a metric preference the literals are the metric ones,
    // and nothing converts: 500 is a bottle, not 473.
    const { db } = freshDb();
    setUnitPreference(db, 'volume', 'ml');
    const spec = specFor(db);
    spec.unit === 'ml' && WATER_QUICK_AMOUNTS.ml[1].amount === 500
      ? ok('under ml the shared table offers 240 / 500 / 750, never a converted oz figure')
      : bad('ml literals', JSON.stringify(WATER_QUICK_AMOUNTS.ml));
    logWater(db, TODAY, spec.toCanonical(500));
    logWater(db, TODAY, spec.toCanonical(500));
    logWater(db, TODAY, spec.toCanonical(240));
    const usual = usualWaterAmount(db, TODAY);
    usual === 500 && roundToSpec(spec, spec.fromCanonical(usual)) === 500
      ? ok('...and the usual amount is stored and printed as 500 ml, unconverted')
      : bad('ml usual', String(usual));
  }
}

// ---------------------------------------------------------------------------
console.log('\n8. Apple Health hydration lands beside manual captures — and is NOT deduped');
{
  const { db } = freshDb();
  const spec = resolveDisplay(metricByKey('water'), getPreferences(db).units);

  // The real ingest path, not a hand-built row: the water spec out of
  // STATISTIC_METRICS, mapped by the same function the sync pass uses.
  const waterSpec = STATISTIC_METRICS.find((m) => m.metricType === 'water_ml');
  waterSpec &&
  waterSpec.hkIdentifier === 'HKQuantityTypeIdentifierDietaryWater' &&
  waterSpec.hkUnit === 'mL' &&
  waterSpec.unit === 'ml'
    ? ok("water rides the statistics pipeline as DietaryWater in 'mL', stored canonical ml")
    : bad('water statistic spec', JSON.stringify(waterSpec));

  const manual = logWater(db, TODAY, 500);
  const mapped = statisticDailyRows(waterSpec, [{ date: TODAY, value: 1200 }]);
  mapped.length === 1 &&
  mapped[0].sourceDevice === 'apple_health' &&
  mapped[0].sourceRawId === `hk:water_ml:${TODAY}` &&
  mapped[0].unit === 'ml'
    ? ok(`the mapper emits one apple_health row per day under hk:water_ml:<date>`)
    : bad('mapped water row', JSON.stringify(mapped));
  upsertWearableRows(db, mapped);

  // THE RULE. Two sources, two rows, one total, no reconciliation: a merged day
  // bucket carries no per-drink identity to match a manual capture against, and
  // ARC publishes no water, so the bucket does not contain what was logged here.
  const day = waterDaySeries(db, 1, TODAY)[0];
  day.ml === 1700 && day.entries === 2
    ? ok('the day total SUMS both sources (500 manual + 1,200 synced = 1,700, 2 entries)')
    : bad('day total across sources', JSON.stringify(day));

  const entries = listWaterEntries(db, TODAY);
  const synced = entries.find((e) => e.source === 'apple_health');
  entries.length === 2 && synced && synced.editable === false
    ? ok('both rows are listed, and the synced one is flagged non-editable')
    : bad('entry listing', JSON.stringify(entries));
  entries.find((e) => e.id === manual).editable === true
    ? ok('the manual capture beside it stays editable — that is how a double is corrected')
    : bad('manual row editable');

  updateWaterEntry(db, synced.id, 100) === false && deleteWaterEntry(db, synced.id) === false
    ? ok('the screen cannot offer an edit the next sync would silently revert')
    : bad('synced water row must refuse edits');
  db.get(`SELECT value FROM wearable_data WHERE id = ?`, [synced.id]).value === 1200
    ? ok('...and the synced value is genuinely untouched')
    : bad('synced value must survive');

  // A zero day is an ABSENCE, not a claim of drinking nothing.
  statisticDailyRows(waterSpec, [{ date: TODAY, value: 0 }]).length === 0
    ? ok('a zero-hydration day yields NO row — "0 ml" would be a claim, not an absence')
    : bad('zero day must be skipped');

  // Re-syncing the same day UPDATEs the one bucket rather than inserting a
  // second — the deterministic raw id doing its job — and the manual capture is
  // never touched by a sync.
  upsertWearableRows(db, statisticDailyRows(waterSpec, [{ date: TODAY, value: 1500 }]));
  const after = waterDaySeries(db, 1, TODAY)[0];
  after.entries === 2 && after.ml === 2000
    ? ok('a re-sync updates the one bucket (500 + 1,500), never appends a second')
    : bad('re-sync idempotency', JSON.stringify(after));
  db.get(`SELECT value FROM wearable_data WHERE id = ?`, [manual]).value === 500
    ? ok('...and the manual capture is untouched by the sync')
    : bad('manual row survives a sync');

  // The display unit is a render concern, not a storage one, on both rows.
  spec.unit === 'oz' && roundToSpec(spec, spec.fromCanonical(2000)) === 68
    ? ok('the summed day renders in the user’s unit (2,000 ml = 68 oz)')
    : bad('display of the summed day', String(roundToSpec(spec, spec.fromCanonical(2000))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
