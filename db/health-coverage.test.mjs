/**
 * Headless test of the metric audit (src/lib/health/coverage.ts).
 *
 * The point of this suite is the TRIPWIRE: every HealthKit type ARC asks to
 * read must have an audit row, and every audit row must name a real read scope.
 * A read scope with no row is a metric the audit silently says nothing about,
 * which is the failure this table was written to prevent — and it is exactly
 * the kind of drift that happens one well-meaning edit at a time.
 *
 * Pure — no DB, no native module.
 * Run: npm run db:test.
 */
import {
  GARMIN_ONLY_METRICS,
  METRIC_COVERAGE,
  uncoveredReadIdentifiers,
} from '../src/lib/health/coverage.ts';
import { HEALTH_READ_IDENTIFIERS, HEART_RATE_IDENTIFIER } from '../src/lib/health/mapping.ts';

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

console.log('1. the tripwire — the audit covers exactly the read scopes');
{
  const { missing, stale } = uncoveredReadIdentifiers();
  missing.length === 0
    ? ok('every read scope has an audit row')
    : bad('read scopes with no audit row', missing.join(', '));
  stale.length === 0
    ? ok('every audit row names a real read scope')
    : bad('audit rows for types ARC does not read', stale.join(', '));
  METRIC_COVERAGE.length === HEALTH_READ_IDENTIFIERS.length
    ? ok(`one row per scope (${METRIC_COVERAGE.length})`)
    : bad(
        'row count',
        `${METRIC_COVERAGE.length} rows vs ${HEALTH_READ_IDENTIFIERS.length} scopes`
      );

  const ids = METRIC_COVERAGE.map((m) => m.hkIdentifier);
  new Set(ids).size === ids.length ? ok('no duplicate rows') : bad('duplicate identifiers');
}

console.log('2. every row is actually filled in');
{
  const blank = METRIC_COVERAGE.filter(
    (m) => !m.label.trim() || !m.use.trim() || !m.garminNote.trim()
  );
  blank.length === 0
    ? ok('label, use and note are all present on every row')
    : bad('rows with an empty field', blank.map((m) => m.label).join(', '));

  const badVerdict = METRIC_COVERAGE.filter((m) => !['yes', 'no', 'unverified'].includes(m.garmin));
  badVerdict.length === 0 ? ok('every verdict is one of the three') : bad('bad verdict value');

  // An unverified row must SAY what could not be established — "unverified"
  // with no explanation is indistinguishable from a row nobody filled in.
  const silent = METRIC_COVERAGE.filter(
    (m) => m.garmin === 'unverified' && m.garminNote.length < 40
  );
  silent.length === 0
    ? ok('every unverified row explains itself')
    : bad('unexplained unverified rows', silent.map((m) => m.label).join(', '));
}

console.log('3. the days-to-verdict figures match the derivation');
{
  // src/lib/home/readiness.ts: BASELINE_MIN_DAYS = 5 prior days, so a verdict
  // needs a 6th day of readings; strain's window ends YESTERDAY, so 7.
  const byId = new Map(METRIC_COVERAGE.map((m) => [m.hkIdentifier, m]));
  byId.get('HKQuantityTypeIdentifierHeartRateVariabilitySDNN').verdictDays === 6
    ? ok('HRV → 6 days before Recovery can read')
    : bad('HRV verdictDays');
  byId.get('HKQuantityTypeIdentifierRestingHeartRate').verdictDays === 6
    ? ok('resting HR → 6 days (the Recovery fallback)')
    : bad('RHR verdictDays');
  byId.get('HKQuantityTypeIdentifierActiveEnergyBurned').verdictDays === 7
    ? ok('active energy → 7 days, because Strain grades yesterday')
    : bad('active energy verdictDays');
  byId.get('HKCategoryTypeIdentifierSleepAnalysis').verdictDays === 1
    ? ok('sleep needs no baseline — it reads from the first night')
    : bad('sleep verdictDays');

  const nonsense = METRIC_COVERAGE.filter((m) => m.verdictDays !== null && m.verdictDays < 1);
  nonsense.length === 0 ? ok('no row claims a verdict in under a day') : bad('verdictDays < 1');
}

console.log('4. the findings that drive the vendor-API question');
{
  const byId = new Map(METRIC_COVERAGE.map((m) => [m.hkIdentifier, m]));
  const neverSent = [
    'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
    'HKQuantityTypeIdentifierOxygenSaturation',
    'HKQuantityTypeIdentifierRespiratoryRate',
    'HKQuantityTypeIdentifierVO2Max',
  ];
  neverSent.every((id) => byId.get(id).garmin === 'no')
    ? ok('HRV, SpO2, respiratory rate and VO₂max are all recorded as never sent')
    : bad('a permanently-empty scope is not marked "no"');

  // The Recovery pillar's whole fallback design depends on this pair.
  byId.get('HKQuantityTypeIdentifierHeartRateVariabilitySDNN').garmin === 'no' &&
  byId.get('HKQuantityTypeIdentifierRestingHeartRate').garmin === 'yes'
    ? ok('no HRV but yes resting HR — so Recovery runs on the fallback, not the primary')
    : bad('the Recovery source pair changed');

  GARMIN_ONLY_METRICS.length >= 2 &&
  GARMIN_ONLY_METRICS.every((m) => m.label.trim() && m.note.trim())
    ? ok('Body Battery / Training Readiness recorded as Garmin-only')
    : bad('GARMIN_ONLY_METRICS incomplete');
}

console.log('5. in-workout heart rate — unverified, and honest about WHY a blank can be blank');
{
  const row = METRIC_COVERAGE.find((m) => m.hkIdentifier === HEART_RATE_IDENTIFIER);

  // The tripwire in §1 already refuses a scope with no row. This says what the
  // row has to CONTAIN, because the honest content is the whole point: nothing
  // in this repository establishes that Garmin Connect writes in-workout heart
  // rate to Apple Health at all, at what cadence, or whether it associates the
  // samples with the session. `unverified` is not a soft no.
  row && row.garmin === 'unverified'
    ? ok('the row exists and claims nothing about Garmin it cannot support')
    : bad('heart-rate coverage row', JSON.stringify(row));
  row?.verdictDays === null
    ? ok('…and feeds no verdict, so it waits on no baseline')
    : bad('heart rate claims a verdict window', row?.verdictDays);

  // The sentence that matters most on this row. iOS never reveals whether a
  // READ grant was given, so a blank heart-rate line has two causes the screen
  // cannot tell apart — Garmin sending nothing, and the owner having declined
  // the sheet — and only one of them is recoverable. Reading a zero as a fact
  // about Garmin before checking is the mistake this line exists to prevent.
  row?.garminNote.includes('Privacy & Security')
    ? ok('…and names the iOS Settings path before anyone reads a zero as a Garmin fact')
    : bad('no declined-grant sentence', row?.garminNote);
  row?.use.includes('never a daily figure')
    ? ok('…and says out loud that this never becomes a daily number')
    : bad('use line', row?.use);
}

console.log('6. the notes are written to the reader of Settings, not to a code reviewer');
{
  // Slop pass 3 (docs/ai-slop-candidates-2026-09.md §10). Every `garminNote`
  // renders on Settings › Apple Health, but this file is not a screen, so the
  // string-walks of app/ never read it. Two notes opened "Nothing in this
  // repository establishes…" — an audit memo's register, addressed to someone
  // reading the code — and argued their verdicts ("which presupposes it", "which
  // is the point of reading it") instead of stating them. The facts stay: what
  // is unconfirmed, the one-evening test, the declined-grant caveat, the route.
  const voice = /repository|presupposes|point of reading it|none of the three was checked/i;
  const leaks = [
    ...METRIC_COVERAGE.map((m) => m.garminNote),
    ...GARMIN_ONLY_METRICS.map((m) => m.note),
  ].filter((note) => voice.test(note));
  leaks.length === 0
    ? ok('no note speaks of a repository or argues its own verdict')
    : bad('audit-memo voice on a Settings screen', leaks.join(' | '));

  const water = METRIC_COVERAGE.find(
    (m) => m.hkIdentifier === 'HKQuantityTypeIdentifierDietaryWater'
  );
  // Settled on the owner's phone (checklist 2026-09-21, confirmed 2026-09-23),
  // so the note states the verdict and the one-total-per-day shape; the
  // other-apps fact survives from the unconfirmed version.
  water?.garmin === 'yes' &&
  water.garminNote.startsWith('Confirmed on your phone') &&
  water.garminNote.includes('one total per day') &&
  water.garminNote.includes('Any other hydration app on the phone also fills this')
    ? ok('water: confirmed, one total per day, and the other-apps fact survives')
    : bad('water note', water?.garminNote);

  const steps = METRIC_COVERAGE.find((m) => m.hkIdentifier === 'HKQuantityTypeIdentifierStepCount');
  steps?.garminNote.includes('step counts in the two apps can differ')
    ? ok('steps: the FAQ is kept as the caveat it is to a reader — the counts can differ')
    : bad('steps note', steps?.garminNote);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
