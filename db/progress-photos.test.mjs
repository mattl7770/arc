/**
 * Headless test of the progress-photo gallery — `progress_photos` +
 * `progress_photo_analyses` (0035), the repository, the file store over an
 * in-memory fake, the pure formatters, the picker wire-shape parsers, and the AI
 * reading's prompt/parse — against real SQLite via node:sqlite. Mirrors
 * db/nutrition-v2.test.mjs's photo section; op-sqlite is never loaded.
 *
 * Spec: docs/progress-photos-subapp.md §9 (this file is that section's contract).
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  allProgressPhotoFileNames,
  deleteProgressPhoto,
  getProgressPhoto,
  groupPhotosByMonth,
  importedAssetIds,
  insertProgressPhoto,
  insertProgressPhotoAnalysis,
  listPairAnalyses,
  listPhotoAnalyses,
  listProgressPhotos,
  nearestWeighIn,
  poseCount,
  progressPhotoCount,
  progressPhotoFileNames,
  updateProgressPhoto,
  WEIGH_IN_WINDOW_DAYS,
} from '../src/lib/db/repositories/progress-photos.ts';
import { photoFileName } from '../src/lib/media/photo-file-store.ts';
import { MEAL_PHOTO_DIR, sweepMealPhotos } from '../src/lib/media/meal-photo-store.ts';
import {
  deleteProgressPhotoWithFiles,
  importProgressPhotos,
  PROGRESS_PHOTO_DIR,
  progressPhotoUri,
  sweepProgressPhotos,
} from '../src/lib/media/progress-photo-store.ts';
import {
  formatPhotoDate,
  isRealCalendarDate,
  localDayOf,
  NO_WEIGH_IN,
  photoDayNumber,
  poseLetter,
  weighInCaption,
  weighInDistanceLabel,
} from '../src/lib/photos/format.ts';
import {
  assetLocalId,
  assetPhotoDate,
  defaultPoseFor,
  normalizeExifOffset,
  parseExifDateTime,
  workingCopyResize,
} from '../src/lib/photos/import.ts';
import {
  buildPhotoReadingRequest,
  parseSavedChanges,
  parseSavedObservations,
  PHOTO_ANALYSIS_PRIVACY_LINE,
  PHOTO_READING_SYSTEM_PROMPT,
  parsePhotoReading,
} from '../src/lib/photos/analyze.ts';

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
const rejects = (name, fn) => (throws(fn) ? ok(name) : bad(name));

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

/**
 * A fake file system: one map per directory, and a `PhotoFileStore` bound to
 * one of them — the same seam `nativeStoreIn(dir)` provides on device.
 *
 * Two directories rather than one because the point of the meal-sweep assertion
 * below is that a store cannot see outside the directory it was built for.
 */
function makeFakeFs() {
  const dirs = new Map();
  const dirOf = (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, new Map());
    return dirs.get(dir);
  };
  return {
    dirs,
    files: (dir) => dirOf(dir),
    storeIn: (dir) => ({
      list: () => [...dirOf(dir).keys()],
      exists: (name) => dirOf(dir).has(name),
      remove: (name) => {
        dirOf(dir).delete(name);
        return true;
      },
      write: (name, base64) => {
        dirOf(dir).set(name, base64);
        return true;
      },
      uri: (name) => (dirOf(dir).has(name) ? `file:///documents/${dir}/${name}` : null),
    }),
  };
}

/** Insert a weigh-in at a given local-ish instant. Raw SQL: this exercises the
 *  read-time date join, not the body repository. */
let weighInSeq = 0;
function weighIn(raw, measuredAt, kg) {
  weighInSeq++;
  raw
    .prepare('INSERT INTO body_metrics (id, measured_at, weight_kg, source) VALUES (?, ?, ?, ?)')
    .run(`w-${weighInSeq}`, measuredAt, kg, 'manual');
}

const KG = (kg) => `${kg.toFixed(1)} kg`;

// ---------------------------------------------------------------------------
{
  console.log('1. 0035 applies over the current head, and stamps its version');
  const { raw } = freshDb();
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  version >= 35
    ? ok(`user_version is ${version} (0035 ran, forward-only)`)
    : bad('user_version after migrate', String(version));

  const tables = raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'progress_%'`)
    .all()
    .map((r) => r.name)
    .sort();
  tables.join(',') === 'progress_photo_analyses,progress_photos'
    ? ok('both tables exist')
    : bad('tables', tables.join(','));

  const indexes = raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'progress_%'`)
    .all()
    .map((r) => r.name)
    .sort();
  ['progress_photo_analyses_compare_idx', 'progress_photos_asset_key'].every((n) =>
    indexes.includes(n)
  )
    ? ok('the dedupe key and the second FK index are both present')
    : bad('indexes', indexes.join(','));
}

// ---------------------------------------------------------------------------
{
  console.log('2. CHECKs: the schema refuses what the repository must never write');
  const { raw, db } = freshDb();
  const good = {
    taken_on: '2026-01-12',
    pose: 'front',
    working_file_name: 'abc.jpg',
  };
  const id = insertProgressPhoto(db, good);
  getProgressPhoto(db, id) ? ok('a well-formed row inserts') : bad('baseline insert');

  const insertRaw = (cols, vals) =>
    raw
      .prepare(
        `INSERT INTO progress_photos (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`
      )
      .run(`x-${Math.random()}`, ...vals);

  rejects('an unknown pose is rejected', () =>
    insertRaw(['taken_on', 'pose', 'working_file_name'], ['2026-01-12', 'side_left', 'a.jpg'])
  );
  rejects('a malformed taken_on is rejected', () =>
    insertRaw(['taken_on', 'pose', 'working_file_name'], ['12 Jan 2026', 'front', 'b.jpg'])
  );
  rejects('a short taken_on is rejected', () =>
    insertRaw(['taken_on', 'pose', 'working_file_name'], ['2026-1-2', 'front', 'b2.jpg'])
  );
  // The shape passes; the calendar does not. This is the day/month slip a bare
  // YYYY-MM-DD field invites, and it would head a month plate "31 2026".
  rejects('a date-shaped NON-date is rejected (2026-31-12)', () =>
    insertRaw(['taken_on', 'pose', 'working_file_name'], ['2026-31-12', 'front', 'b3.jpg'])
  );
  insertProgressPhoto(db, { taken_on: '2028-02-29', pose: 'front', working_file_name: 'leap.jpg' });
  ok('...while a real leap day is admitted');
  // WHERE THE SCHEMA STOPS, stated rather than assumed: SQLite's julianday()
  // NORMALISES an overflowing day (2026-02-30 → 2 March) instead of returning
  // NULL, so the CHECK cannot catch that one. `isRealCalendarDate` can, and
  // does, by round-tripping the three fields — which is why both layers exist
  // and why the screens validate before they write.
  insertProgressPhoto(db, { taken_on: '2026-02-30', pose: 'front', working_file_name: 'norm.jpg' });
  ok('the CHECK admits 30 February (julianday normalises it) — a stated limit');
  !isRealCalendarDate('2026-02-30') &&
  !isRealCalendarDate('2026-31-12') &&
  !isRealCalendarDate('2025-02-29') &&
  isRealCalendarDate('2028-02-29') &&
  isRealCalendarDate('2026-01-12')
    ? ok('...and the screens refuse it before it can be written')
    : bad('isRealCalendarDate');
  rejects('an unknown date_origin is rejected', () =>
    insertRaw(
      ['taken_on', 'pose', 'working_file_name', 'date_origin'],
      ['2026-01-12', 'front', 'b5.jpg', 'guessed']
    )
  );
  rejects('a garbage taken_at is rejected', () =>
    insertRaw(
      ['taken_on', 'pose', 'working_file_name', 'taken_at'],
      ['2026-01-12', 'front', 'c.jpg', 'yesterday morning']
    )
  );
  rejects('a non-boolean is_important is rejected', () =>
    insertRaw(
      ['taken_on', 'pose', 'working_file_name', 'is_important'],
      ['2026-01-12', 'front', 'd.jpg', 2]
    )
  );
  rejects('an unknown source is rejected', () =>
    insertRaw(
      ['taken_on', 'pose', 'working_file_name', 'source'],
      ['2026-01-12', 'front', 'e.jpg', 'airdrop']
    )
  );
  rejects('a NULL id is rejected', () =>
    raw
      .prepare(
        'INSERT INTO progress_photos (id, taken_on, pose, working_file_name) VALUES (NULL, ?, ?, ?)'
      )
      .run('2026-01-12', 'front', 'f.jpg')
  );

  console.log('   ...and the 0033 name-not-a-path CHECK, grep-twinned');
  rejects('a POSIX path in working_file_name is rejected', () =>
    insertRaw(
      ['taken_on', 'pose', 'working_file_name'],
      ['2026-01-12', 'front', 'progress-photos/g.jpg']
    )
  );
  rejects('a Windows path in working_file_name is rejected', () =>
    insertRaw(
      ['taken_on', 'pose', 'working_file_name'],
      ['2026-01-12', 'front', 'progress-photos\\g.jpg']
    )
  );
  rejects('a non-jpg working_file_name is rejected', () =>
    insertRaw(['taken_on', 'pose', 'working_file_name'], ['2026-01-12', 'front', 'h.heic'])
  );
  rejects('a path in original_file_name is rejected', () =>
    insertRaw(
      ['taken_on', 'pose', 'working_file_name', 'original_file_name'],
      ['2026-01-12', 'front', 'i.jpg', 'sub/dir.jpg']
    )
  );
  rejects('two rows cannot claim one working file', () =>
    insertRaw(['taken_on', 'pose', 'working_file_name'], ['2026-01-13', 'front', 'abc.jpg'])
  );
  // ...and a NULL original is not a claim, so many rows may have none.
  insertProgressPhoto(db, { ...good, working_file_name: 'j.jpg' });
  insertProgressPhoto(db, { ...good, working_file_name: 'k.jpg' });
  progressPhotoCount(db) === 5
    ? ok('many rows may share "no original" (UNIQUE admits NULLs)')
    : bad('null originals', String(progressPhotoCount(db)));

  console.log('   ...and photoFileName() can never produce a name the CHECK rejects');
  const names = Array.from({ length: 200 }, () => photoFileName());
  names.every((n) => n.endsWith('.jpg') && !n.includes('/') && !n.includes('\\'))
    ? ok('200 generated names are all bare .jpg names')
    : bad('generated name shape');
  new Set(names).size === names.length
    ? ok('200 generated names are distinct')
    : bad('generated name collision');
}

// ---------------------------------------------------------------------------
{
  console.log('3. Dedupe: the partial UNIQUE on asset_id');
  const { db } = freshDb();
  const base = { taken_on: '2026-02-01', pose: 'front' };
  insertProgressPhoto(db, { ...base, working_file_name: 'a.jpg', asset_id: 'PK-1' });
  rejects('a duplicate asset_id is rejected', () =>
    insertProgressPhoto(db, { ...base, working_file_name: 'b.jpg', asset_id: 'PK-1' })
  );
  insertProgressPhoto(db, { ...base, working_file_name: 'c.jpg', asset_id: null });
  insertProgressPhoto(db, { ...base, working_file_name: 'd.jpg', asset_id: null });
  insertProgressPhoto(db, { ...base, working_file_name: 'e.jpg' });
  progressPhotoCount(db) === 4
    ? ok('many NULL asset_ids are admitted (partial index)')
    : bad('null asset_ids', String(progressPhotoCount(db)));

  const seen = importedAssetIds(db, ['PK-1', 'PK-2']);
  seen.size === 1 && seen.has('PK-1')
    ? ok('importedAssetIds reports only what is already in the gallery')
    : bad('importedAssetIds', [...seen].join(','));
  importedAssetIds(db, []).size === 0
    ? ok('an empty batch never touches the database (SQLite rejects IN ())')
    : bad('importedAssetIds empty');
}

// ---------------------------------------------------------------------------
{
  console.log('4. CASCADE: an analysis is a caption, and a caption needs its picture');
  const { db } = freshDb();
  const jan = insertProgressPhoto(db, {
    taken_on: '2026-01-12',
    pose: 'front',
    working_file_name: 'jan.jpg',
  });
  const aug = insertProgressPhoto(db, {
    taken_on: '2026-08-09',
    pose: 'front',
    working_file_name: 'aug.jpg',
  });
  const single = insertProgressPhotoAnalysis(db, {
    photo_id: jan,
    model: 'claude-opus-5',
    summary: 'Baseline reading.',
    caveats: 'Lighting is uneven.',
    observations: JSON.stringify([{ area: 'midsection', note: 'soft definition' }]),
    confidence: 'medium',
  });
  const pair = insertProgressPhotoAnalysis(db, {
    photo_id: jan,
    compare_photo_id: aug,
    model: 'claude-opus-5',
    summary: 'Leaner through the waist.',
    caveats: 'Different lighting and a slightly different stance.',
    changes: JSON.stringify([{ area: 'waist', direction: 'leaner', note: 'clearer taper' }]),
    confidence: 'low',
  });
  listPhotoAnalyses(db, jan).length === 2
    ? ok('the earlier photo shows both its own reading and the pair')
    : bad('listPhotoAnalyses (earlier)');
  listPhotoAnalyses(db, aug).length === 1 && listPhotoAnalyses(db, aug)[0].id === pair
    ? ok('the LATER photo of a pair finds the reading too (both FK sides are read)')
    : bad('listPhotoAnalyses (later)');
  listPairAnalyses(db, jan, aug).length === 1
    ? ok('listPairAnalyses finds the reading of exactly that ordered pair')
    : bad('listPairAnalyses');
  listPairAnalyses(db, aug, jan).length === 0
    ? ok('...and not of the reversed pair, whose order was never read')
    : bad('listPairAnalyses reversed');

  rejects('a photo compared with itself is rejected', () =>
    insertProgressPhotoAnalysis(db, {
      photo_id: jan,
      compare_photo_id: jan,
      model: 'm',
      summary: 's',
      caveats: 'c',
    })
  );
  rejects('a reading with no caveats is rejected by the schema, not just the prompt', () =>
    insertProgressPhotoAnalysis(db, {
      photo_id: jan,
      model: 'm',
      summary: 's',
      caveats: null,
    })
  );
  rejects('non-JSON observations are rejected', () =>
    insertProgressPhotoAnalysis(db, {
      photo_id: jan,
      model: 'm',
      summary: 's',
      caveats: 'c',
      observations: 'not json',
    })
  );

  // Deleting the LATER photo takes the pair reading and leaves the single one.
  deleteProgressPhoto(db, aug);
  const left = listPhotoAnalyses(db, jan);
  left.length === 1 && left[0].id === single
    ? ok('deleting the later photo cascades the pair reading away')
    : bad('cascade via compare_photo_id', left.map((r) => r.id).join(','));
  deleteProgressPhoto(db, jan);
  listPhotoAnalyses(db, jan).length === 0
    ? ok('deleting the subject photo cascades its own reading away')
    : bad('cascade via photo_id');
}

// ---------------------------------------------------------------------------
{
  console.log('5. Repository reads: order, pose filter, month grouping');
  const { db } = freshDb();
  const rows = [
    ['2026-08-09', 'front', 'a.jpg'],
    ['2026-08-09', 'side', 'b.jpg'],
    ['2026-08-02', 'front', 'c.jpg'],
    ['2026-07-30', 'back', 'd.jpg'],
    ['2026-01-12', 'front', 'e.jpg'],
  ];
  for (const [taken_on, pose, working_file_name] of rows) {
    insertProgressPhoto(db, { taken_on, pose, working_file_name });
  }

  const all = listProgressPhotos(db);
  all.map((p) => p.working_file_name).join(',') === 'b.jpg,a.jpg,c.jpg,d.jpg,e.jpg' ||
  all.map((p) => p.working_file_name).join(',') === 'a.jpg,b.jpg,c.jpg,d.jpg,e.jpg'
    ? ok('newest shutter-day first, same-day order stable')
    : bad('ordering', all.map((p) => p.working_file_name).join(','));
  all[0].taken_on === '2026-08-09' && all[4].taken_on === '2026-01-12'
    ? ok('the extremes are in the right places')
    : bad('ordering extremes');

  const fronts = listProgressPhotos(db, 'front');
  fronts.length === 3 && fronts.every((p) => p.pose === 'front')
    ? ok('the pose filter returns only that pose')
    : bad('pose filter', String(fronts.length));

  const months = groupPhotosByMonth(all);
  months.map((m) => m.key).join(',') === '2026-08,2026-07,2026-01'
    ? ok('months group newest-first, no empty months invented')
    : bad('month keys', months.map((m) => m.key).join(','));
  months[0].label === 'August 2026' && months[2].label === 'January 2026'
    ? ok('month labels are hand-built (no Intl on Hermes)')
    : bad('month labels', months.map((m) => m.label).join(','));
  months[0].photos.length === 3 && months[1].photos.length === 1
    ? ok('every photo lands in exactly one month')
    : bad('month contents');
  poseCount(months[0].photos) === 2 && poseCount(months[2].photos) === 1
    ? ok('the month tally counts the poses of exactly the rows it heads')
    : bad('poseCount');
  groupPhotosByMonth([]).length === 0
    ? ok('an empty gallery groups to nothing')
    : bad('empty group');

  console.log('   ...and edits, which only write what changed');
  const target = all[4].id;
  const before = getProgressPhoto(db, target).updated_at;
  updateProgressPhoto(db, target, {});
  getProgressPhoto(db, target).updated_at === before
    ? ok('an empty edit writes nothing (updated_at unmoved)')
    : bad('empty edit bumped updated_at');
  console.log('   ...and editing the DAY rewrites its provenance');
  {
    const { db: db2 } = freshDb();
    const withExif = insertProgressPhoto(db2, {
      taken_on: '2026-01-12',
      taken_at: '2026-01-12T07:31:04.000Z',
      date_origin: 'exif',
      pose: 'front',
      working_file_name: 'exif.jpg',
    });
    const before = getProgressPhoto(db2, withExif);
    before.date_origin === 'exif' && before.taken_at !== null
      ? ok('an imported row carries its EXIF provenance and instant')
      : bad('exif row', JSON.stringify(before));
    updateProgressPhoto(db2, withExif, { taken_on: '2025-01-12' });
    const after = getProgressPhoto(db2, withExif);
    after.taken_on === '2025-01-12' && after.date_origin === 'manual' && after.taken_at === null
      ? ok('correcting the day clears the instant AND relabels the provenance')
      : bad('date edit provenance', JSON.stringify(after));
    // An edit that is NOT to the day leaves both alone.
    updateProgressPhoto(db2, withExif, { pose: 'side' });
    getProgressPhoto(db2, withExif).date_origin === 'manual'
      ? ok('...and an unrelated edit does not touch them again')
      : bad('unrelated edit');
  }

  updateProgressPhoto(db, target, { pose: 'back', notes: 'morning, fasted', is_important: true });
  const edited = getProgressPhoto(db, target);
  edited.pose === 'back' && edited.notes === 'morning, fasted' && edited.is_important === 1
    ? ok('an edit lands on every named field')
    : bad('edit', JSON.stringify(edited));
  rejects('an edit cannot smuggle in a bad pose', () =>
    updateProgressPhoto(db, target, { pose: 'nope' })
  );
}

// ---------------------------------------------------------------------------
{
  console.log('6. The nearest weigh-in — and its distance, which is never optional');
  const { raw, db } = freshDb();
  const id = insertProgressPhoto(db, {
    taken_on: '2026-08-09',
    pose: 'front',
    working_file_name: 'w.jpg',
  });
  const photo = getProgressPhoto(db, id);

  weighInCaption(nearestWeighIn(db, photo.taken_on), KG) === NO_WEIGH_IN
    ? ok('with no weigh-ins at all the caption is the authored empty')
    : bad('empty weigh-in caption');

  weighIn(raw, '2026-08-09T06:30:00.000Z', 81.0);
  let near = nearestWeighIn(db, photo.taken_on);
  near && near.delta_days === 0 && near.weight_kg === 81
    ? ok('a same-day weigh-in reports distance 0')
    : bad('same-day', JSON.stringify(near));
  weighInCaption(near, KG) === '81.0 kg · weighed same day'
    ? ok('the caption reads "weighed same day"')
    : bad('caption', weighInCaption(near, KG));

  // A closer reading two days LATER wins over the same-day one only if it is
  // nearer; it is not, so the same-day one must hold.
  weighIn(raw, '2026-08-11T06:30:00.000Z', 80.4);
  near = nearestWeighIn(db, photo.taken_on);
  near.delta_days === 0 ? ok('the nearest still wins over a later one') : bad('nearest wins');

  // Now a photo whose only nearby readings are 2 days later and 3 days earlier.
  const id2 = insertProgressPhoto(db, {
    taken_on: '2026-08-13',
    pose: 'front',
    working_file_name: 'w2.jpg',
  });
  near = nearestWeighIn(db, getProgressPhoto(db, id2).taken_on);
  near && near.delta_days === -2
    ? ok('an earlier weigh-in reports a negative distance')
    : bad('earlier distance', JSON.stringify(near));
  weighInCaption(near, KG) === '80.4 kg · weighed 2 days earlier'
    ? ok('the caption reads "weighed 2 days earlier"')
    : bad('caption earlier', weighInCaption(near, KG));

  // Just outside the window: nothing, and the caption says so.
  const id3 = insertProgressPhoto(db, {
    taken_on: '2026-08-20',
    pose: 'front',
    working_file_name: 'w3.jpg',
  });
  nearestWeighIn(db, getProgressPhoto(db, id3).taken_on) === null
    ? ok(`a weigh-in more than ${WEIGH_IN_WINDOW_DAYS} days away is not context`)
    : bad('window not enforced');

  // Exactly on the boundary: included, because ±3 means ±3.
  const id4 = insertProgressPhoto(db, {
    taken_on: '2026-08-14',
    pose: 'front',
    working_file_name: 'w4.jpg',
  });
  near = nearestWeighIn(db, getProgressPhoto(db, id4).taken_on);
  near && near.delta_days === -3
    ? ok('the boundary day is inside the window')
    : bad('boundary', JSON.stringify(near));

  // A weigh-in with no weight (a waist-only entry) is not a weigh-in.
  const { raw: raw2, db: db2 } = freshDb();
  raw2
    .prepare('INSERT INTO body_metrics (id, measured_at, waist_cm, source) VALUES (?, ?, ?, ?)')
    .run('nw-1', '2026-08-09T06:30:00.000Z', 84, 'manual');
  const id5 = insertProgressPhoto(db2, {
    taken_on: '2026-08-09',
    pose: 'front',
    working_file_name: 'w5.jpg',
  });
  nearestWeighIn(db2, getProgressPhoto(db2, id5).taken_on) === null
    ? ok('a body-metric row with no weight is skipped, not reported as 0')
    : bad('weightless row leaked');

  console.log('   ...and the distance phrasing, in every shape it takes');
  const phrasings = [
    [0, 'weighed same day'],
    [1, 'weighed 1 day later'],
    [-1, 'weighed 1 day earlier'],
    [3, 'weighed 3 days later'],
    [-3, 'weighed 3 days earlier'],
  ];
  phrasings.every(([delta, want]) => weighInDistanceLabel(delta) === want)
    ? ok('singular/plural and earlier/later are all correct')
    : bad('distance phrasing', phrasings.map(([d]) => weighInDistanceLabel(d)).join(' | '));
}

// ---------------------------------------------------------------------------
{
  console.log('7. The file store: files first, rollback on failure, two files per row');
  const { db } = freshDb();
  const fs = makeFakeFs();
  const store = fs.storeIn(PROGRESS_PHOTO_DIR);

  const ids = importProgressPhotos(
    db,
    [
      { taken_on: '2026-08-09', pose: 'front', workingBase64Jpeg: '/9j/front' },
      { taken_on: '2026-08-09', pose: 'side', workingBase64Jpeg: '/9j/side' },
      {
        taken_on: '2026-08-09',
        pose: 'back',
        workingBase64Jpeg: '/9j/back',
        originalBase64Jpeg: '/9j/back-full',
        is_important: true,
      },
    ],
    store
  );
  ids.length === 3 && progressPhotoCount(db) === 3
    ? ok('a batch of three imports as one unit')
    : bad('batch import', String(progressPhotoCount(db)));
  fs.files(PROGRESS_PHOTO_DIR).size === 4
    ? ok('four files on disk — three working copies and one full-size original')
    : bad('file count', String(fs.files(PROGRESS_PHOTO_DIR).size));

  const flagged = getProgressPhoto(db, ids[2]);
  flagged.original_file_name && flagged.is_important === 1
    ? ok('the flagged photo carries a second name')
    : bad('important photo');
  progressPhotoFileNames(db, ids[2]).length === 2
    ? ok('the delete path reads BOTH names')
    : bad('file names');
  progressPhotoUri(flagged.working_file_name, store)?.startsWith(
    'file:///documents/progress-photos/'
  )
    ? ok('a name resolves to a file:// URI at read time (never a stored path)')
    : bad('uri');
  progressPhotoUri('gone.jpg', store) === null
    ? ok('a missing file resolves to null, not a broken frame')
    : bad('missing uri');
  progressPhotoUri(null, store) === null ? ok('no name is null too') : bad('null name');

  console.log('   ...a rejected row takes its files back off disk');
  const before = fs.files(PROGRESS_PHOTO_DIR).size;
  const dupAsset = importProgressPhotos(
    db,
    [{ taken_on: '2026-08-10', pose: 'front', workingBase64Jpeg: '/9j/dup', asset_id: 'PK-9' }],
    store
  );
  dupAsset.length === 1 ? ok('a first import with an assetId lands') : bad('assetId import');
  const afterFirst = fs.files(PROGRESS_PHOTO_DIR).size;
  let threw = false;
  try {
    importProgressPhotos(
      db,
      [
        { taken_on: '2026-08-11', pose: 'front', workingBase64Jpeg: '/9j/ok' },
        { taken_on: '2026-08-11', pose: 'side', workingBase64Jpeg: '/9j/dup2', asset_id: 'PK-9' },
      ],
      store
    );
  } catch {
    threw = true;
  }
  threw ? ok('a batch containing a duplicate throws') : bad('duplicate batch did not throw');
  progressPhotoCount(db) === 4
    ? ok('...and NOT ONE row of that batch survived (transaction)')
    : bad('partial batch landed', String(progressPhotoCount(db)));
  fs.files(PROGRESS_PHOTO_DIR).size === afterFirst
    ? ok('...and every file it had written is gone (explicit rollback)')
    : bad('leaked files', String(fs.files(PROGRESS_PHOTO_DIR).size - afterFirst));
  before < afterFirst
    ? ok('the sequence really did write files in between')
    : bad('no-op sequence');

  console.log('   ...a failed write never leaves a half-kept promise');
  const failingStore = {
    ...store,
    write: (name, bytes) => (bytes === '/9j/second' ? false : store.write(name, bytes)),
  };
  const countBefore = fs.files(PROGRESS_PHOTO_DIR).size;
  threw = false;
  try {
    importProgressPhotos(
      db,
      [
        {
          taken_on: '2026-08-12',
          pose: 'front',
          workingBase64Jpeg: '/9j/first',
          originalBase64Jpeg: '/9j/second',
          is_important: true,
        },
      ],
      failingStore
    );
  } catch {
    threw = true;
  }
  threw ? ok('a failed original write throws') : bad('failed write swallowed');
  fs.files(PROGRESS_PHOTO_DIR).size === countBefore
    ? ok('...and the working copy it had already written is removed')
    : bad('orphaned working copy');

  console.log('   ...and no store at all is an honest throw, not a silent no-op');
  throws(() => importProgressPhotos(db, [], null))
    ? ok('importing without expo-file-system throws rather than pretending')
    : bad('null store import');

  console.log('   ...delete takes the row, then the files, and never the camera roll');
  const doomed = getProgressPhoto(db, ids[2]);
  deleteProgressPhotoWithFiles(db, ids[2], store);
  getProgressPhoto(db, ids[2]) === undefined ? ok('the row is gone') : bad('row survived delete');
  !fs.files(PROGRESS_PHOTO_DIR).has(doomed.working_file_name) &&
  !fs.files(PROGRESS_PHOTO_DIR).has(doomed.original_file_name)
    ? ok('both of its files are gone')
    : bad('files survived delete');
}

// ---------------------------------------------------------------------------
{
  console.log('8. The sweep: reconcile, never expire, and never delete a row');
  const { db } = freshDb();
  const fs = makeFakeFs();
  const store = fs.storeIn(PROGRESS_PHOTO_DIR);
  const ids = importProgressPhotos(
    db,
    [
      { taken_on: '2026-08-09', pose: 'front', workingBase64Jpeg: '/9j/a' },
      {
        taken_on: '2026-08-09',
        pose: 'side',
        workingBase64Jpeg: '/9j/b',
        originalBase64Jpeg: '/9j/b-full',
        is_important: true,
      },
    ],
    store
  );

  let result = sweepProgressPhotos(db, store);
  result.dangling === 0 && result.orphans === 0
    ? ok('a reconciled store sweeps to nothing')
    : bad('clean sweep', JSON.stringify(result));
  fs.files(PROGRESS_PHOTO_DIR).size === 3
    ? ok('the full-size original is CLAIMED, not reclaimed as an orphan')
    : bad('original reclaimed', [...fs.files(PROGRESS_PHOTO_DIR).keys()].join(','));

  // A restore that carried the database but not the media.
  const gone = getProgressPhoto(db, ids[0]).working_file_name;
  fs.files(PROGRESS_PHOTO_DIR).delete(gone);
  fs.files(PROGRESS_PHOTO_DIR).set('orphan.jpg', '/9j/nobodys');
  result = sweepProgressPhotos(db, store);
  result.dangling === 1 && result.orphans === 1
    ? ok('one dangling row counted, one orphan file reclaimed')
    : bad('sweep counts', JSON.stringify(result));
  progressPhotoCount(db) === 2
    ? ok('THE ROW SURVIVES — a missing JPEG never deletes a decade of record')
    : bad('sweep deleted a row', String(progressPhotoCount(db)));
  !fs.files(PROGRESS_PHOTO_DIR).has('orphan.jpg')
    ? ok('the orphan file is off disk')
    : bad('orphan survived');

  const again = sweepProgressPhotos(db, store);
  again.orphans === 0 && again.dangling === 1
    ? ok('a second sweep reclaims nothing and still reports the gap')
    : bad('second sweep', JSON.stringify(again));

  // THE ONE THAT COULD HAVE COST A PHOTOGRAPH. `exists()` and `list()` are two
  // independent file-system probes and both swallow their exceptions, so they
  // can disagree. If the claimed set were built from `exists()`, a store whose
  // stat lies would let the orphan pass delete a file a row still points at —
  // a photo ARC cannot re-fetch. Claiming is driven by the ROWS alone.
  const lyingStore = { ...store, exists: () => false };
  const beforeLie = [...fs.files(PROGRESS_PHOTO_DIR).keys()].sort().join(',');
  const lied = sweepProgressPhotos(db, lyingStore);
  [...fs.files(PROGRESS_PHOTO_DIR).keys()].sort().join(',') === beforeLie
    ? ok('a store whose exists() lies cannot make the sweep delete a claimed file')
    : bad('claimed file deleted on a lying exists()', beforeLie);
  lied.dangling === 2
    ? ok('...it is reported as a gap instead, which is recoverable')
    : bad('lying sweep dangling', JSON.stringify(lied));
  sweepProgressPhotos(db, null).dangling === 0 && progressPhotoCount(db) === 2
    ? ok('with no store the sweep is inert')
    : bad('null-store sweep');

  console.log('   ...and the MEAL sweep cannot reach this directory');
  PROGRESS_PHOTO_DIR !== MEAL_PHOTO_DIR
    ? ok(`the two directories differ ("${PROGRESS_PHOTO_DIR}" vs "${MEAL_PHOTO_DIR}")`)
    : bad('directories collide');
  const progressFilesBefore = [...fs.files(PROGRESS_PHOTO_DIR).keys()].sort().join(',');
  const mealSweep = sweepMealPhotos(db, fs.storeIn(MEAL_PHOTO_DIR), new Date());
  mealSweep.expired === 0 && mealSweep.dangling === 0 && mealSweep.orphans === 0
    ? ok('a meal sweep over its own directory finds nothing of ours')
    : bad('meal sweep touched something', JSON.stringify(mealSweep));
  [...fs.files(PROGRESS_PHOTO_DIR).keys()].sort().join(',') === progressFilesBefore
    ? ok('every progress file is exactly where it was — no retention here, ever')
    : bad('meal sweep reached the progress directory');
  allProgressPhotoFileNames(db).length === 2
    ? ok('and every progress row too')
    : bad('rows changed');
}

// ---------------------------------------------------------------------------
{
  console.log('9. The picker wire shapes, parsed defensively (UNVERIFIED on device)');
  // The iOS EXIF shape as expo-image-picker documents it: colon-separated date,
  // wall-clock time, offset in its own tag.
  let date = assetPhotoDate({
    uri: 'file:///x.jpg',
    assetId: 'PK/L0/001',
    exif: { DateTimeOriginal: '2026:01:12 08:31:04', OffsetTimeOriginal: '+01:00' },
  });
  date.takenOn === '2026-01-12' && date.origin === 'exif'
    ? ok('EXIF DateTimeOriginal gives the LOCAL day')
    : bad('exif day', JSON.stringify(date));
  date.takenAt === '2026-01-12T07:31:04.000Z'
    ? ok('...and with an offset tag, a true UTC instant')
    : bad('exif instant', String(date.takenAt));

  date = assetPhotoDate({ exif: { DateTimeOriginal: '2026:01:12 08:31:04' } });
  date.takenOn === '2026-01-12' && date.takenAt === null
    ? ok('without an offset the day stands and the INSTANT stays null (no data, no number)')
    : bad('zoneless exif', JSON.stringify(date));

  date = assetPhotoDate({ exif: { '{Exif}': { DateTimeOriginal: '2025:12:31 23:59:59' } } });
  date.takenOn === '2025-12-31'
    ? ok('the nested {Exif} dictionary is read too')
    : bad('nested exif', JSON.stringify(date));

  date = assetPhotoDate({ exif: { DateTimeDigitized: '2024:06:01 10:00:00' } });
  date.takenOn === '2024-06-01' ? ok('DateTimeDigitized is a fallback') : bad('digitized fallback');

  date = assetPhotoDate({ creationTime: Date.UTC(2026, 4, 20, 12, 0, 0) });
  date.origin === 'asset' && date.takenAt !== null
    ? ok('a picker-supplied epoch fills both fields')
    : bad('epoch', JSON.stringify(date));

  for (const shape of [
    undefined,
    null,
    'nope',
    {},
    { exif: null },
    { exif: 'weird' },
    { exif: { DateTimeOriginal: '' } },
    { exif: { DateTimeOriginal: 'yesterday' } },
    { exif: { DateTimeOriginal: '0000:00:00 00:00:00' } },
    { exif: { DateTimeOriginal: '2026:13:45 99:99:99' } },
    { creationTime: -1 },
    { creationTime: 'soon' },
  ]) {
    const parsed = assetPhotoDate(shape);
    if (parsed.takenOn !== null || parsed.origin !== 'none') {
      bad(`unreadable shape leaked a date: ${JSON.stringify(shape)}`);
      continue;
    }
  }
  ok('twelve unreadable shapes all yield "no date" — and NEVER today');

  // The offset must come from the key PAIRED with the date key that won. A scan
  // with a digitisation clock and a surviving shutter-zone tag must not combine
  // the two into one wrong instant.
  date = assetPhotoDate({
    exif: { DateTimeDigitized: '2024:06:01 10:00:00', OffsetTimeOriginal: '+05:00' },
  });
  date.takenOn === '2024-06-01' && date.takenAt === null
    ? ok('an offset belonging to a DIFFERENT date key is not applied')
    : bad('offset mispairing', JSON.stringify(date));
  date = assetPhotoDate({
    exif: { DateTimeDigitized: '2024:06:01 10:00:00', OffsetTimeDigitized: '+05:00' },
  });
  date.takenAt === '2024-06-01T05:00:00.000Z'
    ? ok('...and its OWN offset key is')
    : bad('offset pairing', String(date.takenAt));

  assetLocalId({ assetId: 'PK/L0/001' }) === 'PK/L0/001' &&
  assetLocalId({ assetId: null }) === null &&
  assetLocalId({}) === null &&
  assetLocalId('x') === null
    ? ok('assetLocalId is total')
    : bad('assetLocalId');

  parseExifDateTime('2026:01:12T08:31:04.250') !== null
    ? ok('a T separator and sub-seconds parse')
    : bad('exif T separator');
  normalizeExifOffset('-0800') === '-08:00' &&
  normalizeExifOffset('Z') === 'Z' &&
  normalizeExifOffset('+99:00') === null &&
  normalizeExifOffset('east') === null
    ? ok('offset normalization is total')
    : bad('offset normalization');

  defaultPoseFor(undefined) === 'front' && defaultPoseFor({ pose: 'back' }) === 'back'
    ? ok('a batch carries the previous pose forward, defaulting to front')
    : bad('defaultPoseFor');

  // The working copy is bounded by the LONGEST edge. Getting this backwards
  // costs 1.8x the pixels on every portrait photo — the difference between the
  // ~0.5 GB/decade the owner accepted and nearly a gigabyte.
  JSON.stringify(workingCopyResize(3024, 4032, 1600)) === '{"height":1600}'
    ? ok('a portrait photo is bounded by its HEIGHT')
    : bad('portrait resize', JSON.stringify(workingCopyResize(3024, 4032, 1600)));
  JSON.stringify(workingCopyResize(4032, 3024, 1600)) === '{"width":1600}'
    ? ok('a landscape photo is bounded by its width')
    : bad('landscape resize');
  JSON.stringify(workingCopyResize(2000, 2000, 1600)) === '{"width":1600}' &&
  JSON.stringify(workingCopyResize(null, null, 1600)) === '{"width":1600}' &&
  JSON.stringify(workingCopyResize(null, 4032, 1600)) === '{"width":1600}'
    ? ok('a square photo, and dimensions the picker never reported, fall back to width')
    : bad('resize fallback');

  console.log('   ...and reading a saved reading back out of its JSON columns');
  parseSavedObservations(JSON.stringify([{ area: 'waist', note: 'taper' }])).length === 1 &&
  parseSavedObservations(null).length === 0 &&
  parseSavedObservations('{not json').length === 0 &&
  parseSavedObservations('{"not":"an array"}').length === 0
    ? ok('stored observations parse defensively — json_valid is not a shape guarantee')
    : bad('parseSavedObservations');
  parseSavedChanges(JSON.stringify([{ area: 'arms', direction: 'nope', note: 'x' }]))[0]
    ?.direction === 'unclear'
    ? ok('a stored direction this build does not know degrades to "unclear"')
    : bad('parseSavedChanges');

  console.log('   ...and the display formatters');
  formatPhotoDate('2026-01-12') === '12 Jan 2026' &&
  formatPhotoDate('2026-08-09') === '9 Aug 2026' &&
  formatPhotoDate('nonsense') === 'nonsense'
    ? ok('dates render hand-built, and an unparseable one is not faked')
    : bad('formatPhotoDate', formatPhotoDate('2026-01-12'));
  photoDayNumber('2026-08-09') === '9' && photoDayNumber('x') === '—'
    ? ok('the cell day number is unpadded, with an em-dash for nothing')
    : bad('photoDayNumber');
  poseLetter('front') === 'F' && poseLetter('back') === 'B' && poseLetter('other') === 'O'
    ? ok('pose letters')
    : bad('poseLetter');
}

// ---------------------------------------------------------------------------
{
  console.log('10. The AI reading: prompt build and defensive parse');
  const single = buildPhotoReadingRequest({
    kind: 'single',
    photo: {
      base64Jpeg: '/9j/one',
      takenOn: '2026-08-09',
      pose: 'front',
      weighIn: '81.0 kg · weighed same day',
      notes: 'morning, fasted',
    },
  });
  single.messages[0].content[0].type === 'image'
    ? ok('the image block comes first')
    : bad('image first');
  const singleText = single.messages[0].content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  singleText.includes('9 Aug 2026') && singleText.includes('Front')
    ? ok('the date and pose ride alongside the pixels')
    : bad('single prompt facts', singleText);
  singleText.includes('81.0 kg · weighed same day')
    ? ok('...and the weigh-in WITH ITS DISTANCE, exactly as the screen printed it')
    : bad('weigh-in distance missing from prompt');
  single.system.includes('must not invent') || single.system.includes('Never invent')
    ? ok('the system prompt forbids inventing numbers')
    : bad('no-invented-numbers instruction missing');
  /body.fat|percentage/i.test(single.system)
    ? ok('...and names body-fat percentages as the thing not to output')
    : bad('BF% prohibition missing');
  PHOTO_READING_SYSTEM_PROMPT.toLowerCase().includes('caveat')
    ? ok('caveats are demanded in the prompt')
    : bad('caveats not demanded');

  const pair = buildPhotoReadingRequest({
    kind: 'pair',
    earlier: {
      base64Jpeg: '/9j/jan',
      takenOn: '2026-01-12',
      pose: 'front',
      weighIn: '84.2 kg · weighed same day',
    },
    later: {
      base64Jpeg: '/9j/aug',
      takenOn: '2026-08-09',
      pose: 'front',
      weighIn: '81.0 kg · weighed 2 days later',
    },
  });
  const images = pair.messages[0].content.filter((b) => b.type === 'image');
  images.length === 2 && images[0].source.data === '/9j/jan'
    ? ok('a pair sends two images, earlier first')
    : bad('pair image order');
  const pairText = pair.messages[0].content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  pairText.indexOf('12 Jan 2026') < pairText.indexOf('9 Aug 2026')
    ? ok('...and the prose states that order')
    : bad('pair order not stated');
  pairText.includes('Image 1') && pairText.includes('Image 2')
    ? ok('...by numbered image, so the model cannot mix them up')
    : bad('images not numbered');

  console.log('   ...and the parse, which refuses a reading with no caveats');
  const good = parsePhotoReading(
    JSON.stringify({
      summary: 'Leaner through the waist.',
      observations: [{ area: 'waist', note: 'clearer taper' }],
      changes: [{ area: 'waist', direction: 'leaner', note: 'visibly narrower' }],
      caveats: 'Lighting differs and the stance is not identical.',
      confidence: 'medium',
    })
  );
  good.summary === 'Leaner through the waist.' && good.confidence === 'medium'
    ? ok('a well-formed reading parses')
    : bad('good parse', JSON.stringify(good));
  good.observations.length === 1 && good.changes.length === 1
    ? ok('observations and changes both survive')
    : bad('arrays lost');

  const fenced = parsePhotoReading(
    '```json\n' +
      JSON.stringify({ summary: 'S', caveats: 'C', observations: [] }) +
      '\n```\nHope that helps!'
  );
  fenced.summary === 'S' ? ok('a fenced reply with trailing prose parses') : bad('fenced parse');
  fenced.confidence === null
    ? ok('a missing confidence is null, never invented as "high"')
    : bad('confidence invented');

  rejects('a reading with no caveats is REFUSED', () =>
    parsePhotoReading(JSON.stringify({ summary: 'S', observations: [] }))
  );
  rejects('...and one whose caveats are blank', () =>
    parsePhotoReading(JSON.stringify({ summary: 'S', caveats: '   ' }))
  );
  rejects('a reading with no summary is refused', () =>
    parsePhotoReading(JSON.stringify({ caveats: 'C' }))
  );
  rejects('malformed JSON is refused', () => parsePhotoReading('not json at all'));
  rejects('an empty reply is refused', () => parsePhotoReading(''));
  rejects('a JSON array is refused', () => parsePhotoReading('[1,2,3]'));

  const noisy = parsePhotoReading(
    JSON.stringify({
      summary: 'S',
      caveats: 'C',
      observations: [{ area: 'waist', note: 'x' }, 'garbage', { note: 'no area' }, null],
      changes: [
        { area: 'arms', direction: 'sideways', note: 'y' },
        { area: 'legs', direction: 'fuller', note: 'z' },
      ],
      confidence: 'certain',
    })
  );
  noisy.observations.length === 1
    ? ok('junk observation entries are dropped, not rendered')
    : bad('junk observations', JSON.stringify(noisy.observations));
  noisy.changes[0].direction === 'unclear'
    ? ok('an unknown direction degrades to "unclear" — uncertainty is surfaced')
    : bad('direction fallback', noisy.changes[0].direction);
  noisy.confidence === null
    ? ok('an unknown confidence becomes null rather than a guess')
    : bad('confidence fallback');

  // Owner call, 2026-08-12: qualitative only.
  parsePhotoReading(JSON.stringify({ summary: 'S', caveats: 'C', body_fat_pct: 14 })).summary ===
  'S'
    ? ok('a numeric body-composition field the model volunteers is simply dropped')
    : bad('bf% leaked into the parse');

  PHOTO_ANALYSIS_PRIVACY_LINE.includes('leave your phone') &&
  PHOTO_ANALYSIS_PRIVACY_LINE.includes('your key')
    ? ok('the privacy line names what leaves and under whose key')
    : bad('privacy line', PHOTO_ANALYSIS_PRIVACY_LINE);
  // Verbatim against the spec: this string is a promise about where data goes,
  // so a drift in it is a drift in the promise.
  PHOTO_ANALYSIS_PRIVACY_LINE ===
  'These photos leave your phone for this one reading — sent to your model provider under your key. Nothing is stored anywhere but here.'
    ? ok('...and it is the spec’s sentence character for character')
    : bad('privacy line drifted from the spec', PHOTO_ANALYSIS_PRIVACY_LINE);
}

// ---------------------------------------------------------------------------
{
  console.log('11. The local-day rendering of a stored UTC instant');
  // `created_at` is UTC. Slicing its first ten characters prints TOMORROW for
  // anything saved after 5pm on the US west coast — the body_metrics trap the
  // 0035 header cites, and the reason SavedReading does not slice.
  const instant = '2026-08-10T03:30:00.000Z';
  const expected = (() => {
    const d = new Date(Date.parse(instant));
    const p = (n) => (n < 10 ? `0${n}` : String(n));
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  localDayOf(instant) === expected
    ? ok(`a UTC instant renders as its LOCAL day (${expected} in this timezone)`)
    : bad('localDayOf', `${localDayOf(instant)} vs ${expected}`);
  localDayOf('not a date') === 'not a date'
    ? ok('...and an unparseable one is not faked')
    : bad('localDayOf fallback');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
