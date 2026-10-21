/**
 * Headless test of the chart models behind items 95 and 84 (2026-10-21):
 *
 *   - src/lib/nutrition/pace-curve.ts — the Eat tab's expected intake curve,
 *     learned from four weeks of meal timing, its default fallback, the logical
 *     day's hours, the ±10% band, and the pace words;
 *   - src/lib/charts/moving-average.ts — the 7-day trendline over daily readings
 *     with gaps (weight, HRV, resting HR);
 *   - src/lib/charts/geometry.ts — the scales and path strings every chart uses.
 *
 * Pure modules, no database. Run: npm run db:test.
 */
import {
  bandStatus,
  chartWindow,
  clockAt,
  CURVE_MIN_DAYS,
  CURVE_WINDOW_DAYS,
  defaultCurve,
  expectedShareAt,
  hourlyTotals,
  intakePace,
  landingRange,
  learnCurve,
  minuteOfLogicalDay,
  minuteOfNow,
  paceWords,
  todayIntake,
} from '../src/lib/nutrition/pace-curve.ts';
import {
  dailyMeans,
  latestAverage,
  trailingAverageSeries,
} from '../src/lib/charts/moving-average.ts';
import { linePath, linearScale, paddedDomain, stepPath } from '../src/lib/charts/geometry.ts';
import { localDaysList, logicalDate, shiftISODate } from '../src/lib/db/date.ts';
import { ON_PACE_BAND } from '../src/lib/home/readiness.ts';

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
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const TODAY = '2026-10-21';
const meal = (date, time, kcal, protein_g = null) => ({ date, time, kcal, protein_g });

/** `n` past days (yesterday backwards), each breakfast 08:00 500 · lunch 12:30 700 · dinner 19:00 800. */
function threeMealDays(n, from = 1) {
  const out = [];
  for (let k = from; k < from + n; k++) {
    const d = shiftISODate(TODAY, -k);
    out.push(meal(d, '08:00', 500, 30), meal(d, '12:30', 700, 50), meal(d, '19:00', 800, 60));
  }
  return out;
}

console.log('1. fewer than 7 days of timed meals → the default shape, labelled as such');
{
  const curve = learnCurve(threeMealDays(CURVE_MIN_DAYS - 1), 'kcal', TODAY, '00:00');
  check(curve.source === 'default', 'six days learned nothing — source is "default"', curve.source);
  check(
    curve.days === CURVE_MIN_DAYS - 1,
    'and it says how many days it had (6)',
    String(curve.days)
  );
  const def = defaultCurve('00:00');
  check(
    curve.shares.every((s, i) => near(s, def.shares[i])),
    'the fallback IS defaultCurve — the app’s own pace anchors'
  );
  check(
    near(def.shares[10], 0.15) && near(def.shares[13], 0.4) && near(def.shares[19], 0.85),
    'the default passes through the owner’s anchors: 15% by 10:00, 40% by 13:00, 85% by 19:00'
  );
  check(
    def.shares[0] === 0 && def.shares[24] === 1 && def.shares.length === 25,
    'it opens at 0 and closes at 1, 25 hour marks'
  );
  check(
    def.shares.every((s, i) => i === 0 || s >= def.shares[i - 1]),
    'the default is non-decreasing — a cumulative curve'
  );
  const def4 = defaultCurve('04:00');
  check(
    near(def4.shares[6], 0.15) && near(def4.shares[17], 1) && def4.shares[0] === 0,
    'under a 04:00 boundary the same anchors sit 4 hours earlier on the logical axis (10:00 is hour 6)',
    JSON.stringify([def4.shares[6], def4.shares[17]])
  );
  const exactly = learnCurve(threeMealDays(CURVE_MIN_DAYS), 'kcal', TODAY, '00:00');
  check(
    exactly.source === 'learned' && exactly.days === 7,
    'seven days is enough — the curve is learned'
  );
}

console.log('2. a normal four weeks: the median share by each hour, today and older days excluded');
{
  const meals = [
    ...threeMealDays(10),
    // One wild day — everything at 23:00. The median must not bend for it.
    meal(shiftISODate(TODAY, -11), '23:00', 2400),
    // Today and anything past the window are not his "usual day".
    meal(TODAY, '06:00', 3000),
    meal(shiftISODate(TODAY, -(CURVE_WINDOW_DAYS + 1)), '05:00', 3000),
    // An untimed meal and a NULL-kcal meal add nothing to a day's shape.
    meal(shiftISODate(TODAY, -3), null, 900),
    meal(shiftISODate(TODAY, -4), '05:00', null),
  ];
  const curve = learnCurve(meals, 'kcal', TODAY, '00:00');
  check(
    curve.source === 'learned' && curve.days === 11,
    '11 qualifying days (today and day 29 excluded)',
    JSON.stringify(curve)
  );
  check(
    near(curve.shares[8], 0) && near(curve.shares[9], 0.25),
    'nothing before 08:00; 25% by 09:00 (breakfast 500 of 2,000)'
  );
  check(
    near(curve.shares[13], 0.6) && near(curve.shares[19], 0.6),
    '60% by 13:00, still 60% at 19:00'
  );
  check(near(curve.shares[20], 1) && curve.shares[24] === 1, 'all of it by 20:00');
  check(
    curve.shares.every((s, i) => i === 0 || s >= curve.shares[i - 1]),
    'the median of cumulative curves is itself non-decreasing'
  );
  check(
    near(expectedShareAt(curve, 8 * 60 + 30), 0.125),
    'within an hour it interpolates: 08:30 → 12.5%'
  );
  check(
    expectedShareAt(curve, 1440) === 1 && expectedShareAt(curve, 0) === 0,
    'the ends clamp at 0 and 1'
  );
  const protein = learnCurve(meals, 'protein_g', TODAY, '00:00');
  check(
    protein.source === 'learned' && near(protein.shares[9], 30 / 140),
    'protein learns its own shape from protein_g (30 of 140 g by 09:00)'
  );
}

console.log('3. the 04:00 boundary: a 01:30 snack is the END of the previous logical day');
{
  // The day it was filed under is decided at logging time, by logicalDate.
  const at = new Date(2026, 9, 21, 1, 30);
  check(
    logicalDate(at, '04:00') === '2026-10-20',
    'logicalDate files 01:30 on the 21st under the 20th'
  );
  check(
    minuteOfLogicalDay('01:30', '04:00') === 21 * 60 + 30,
    '01:30 is minute 1,290 — the 22nd hour of that day'
  );
  check(
    minuteOfLogicalDay('04:00', '04:00') === 0 && minuteOfLogicalDay('03:59', '04:00') === 1439,
    'the boundary is minute 0; a minute before is the last'
  );
  check(
    minuteOfLogicalDay('99:99', '00:00') === null && minuteOfLogicalDay(null, '00:00') === null,
    'a malformed or missing clock has no minute'
  );

  const days = [];
  for (let k = 1; k <= 7; k++) {
    const d = shiftISODate(TODAY, -k);
    days.push(meal(d, '19:00', 1500), meal(d, '01:30', 500));
  }
  const buckets = hourlyTotals(
    days.filter((m) => m.date === shiftISODate(TODAY, -1)),
    'kcal',
    '04:00'
  );
  check(
    buckets[21] === 500 && buckets[15] === 1500 && buckets[0] === 0,
    'hourly buckets: the snack in hour 21, dinner in hour 15, nothing at hour 0',
    JSON.stringify(buckets)
  );
  const curve = learnCurve(days, 'kcal', TODAY, '04:00');
  check(
    curve.shares[0] === 0 && near(curve.shares[21], 0.75) && near(curve.shares[22], 1),
    'the learned curve rises to 75% after dinner and reaches 100% only after the 01:30 snack — at the end, never the start',
    JSON.stringify(curve.shares)
  );
  const naive = learnCurve(days, 'kcal', TODAY, '00:00');
  check(
    near(naive.shares[2], 0.25),
    'under midnight the same rows would put the snack at the START (25% by 02:00) — the bug the boundary prevents'
  );

  const today = todayIntake(
    [meal(TODAY, '01:30', 300, 10), meal(TODAY, '09:00', 600, 40)],
    '04:00'
  );
  check(
    today.steps.length === 2 &&
      today.steps[0].minute === 300 &&
      today.steps[1].minute === 1290 &&
      today.steps[1].kcal === 900,
    'today, too: the 01:30 meal steps up LAST, after 09:00',
    JSON.stringify(today.steps)
  );
  check(
    minuteOfNow(new Date(2026, 9, 21, 2, 0), '04:00') === 22 * 60,
    'now at 02:00 is minute 1,320 of the logical day'
  );
  check(
    clockAt(1290, '04:00') === '01:30' && clockAt(0, '00:00') === '00:00',
    'clockAt turns a logical minute back into a wall clock'
  );
}

console.log('4. today: timed steps, untimed meals counted, merged minutes');
{
  const t = todayIntake(
    [
      meal(TODAY, '12:00', 400, 30),
      meal(TODAY, '08:00', 300, 20),
      meal(TODAY, '12:00', 100, null),
      meal(TODAY, null, 250, 15),
    ],
    '00:00'
  );
  check(
    t.steps.length === 2 && t.steps[1].kcal === 800 && t.steps[1].protein_g === 50,
    'two meals at 12:00 merge into one step; running totals 300 → 800',
    JSON.stringify(t.steps)
  );
  check(
    t.untimed.count === 1 && t.total.kcal === 1050 && t.total.protein_g === 65,
    'the untimed meal is still eaten: total 1,050 kcal / 65 g'
  );
}

console.log('5. the ±10% band: edges inclusive, and the landing range');
{
  check(
    bandStatus(2160, 2400) === 'in' && bandStatus(2640, 2400) === 'in',
    '2,160 and 2,640 on a 2,400 goal are IN — the edges count'
  );
  check(
    bandStatus(2159, 2400) === 'under' && bandStatus(2641, 2400) === 'over',
    'one kcal past either edge is out'
  );
  check(bandStatus(2200 * 1.1, 2200) === 'in', '1.1 × goal is in despite IEEE-754 (1.1 − 1 ≠ 0.1)');
  const r = landingRange(1240, 2400);
  check(
    near(r.min, 920) && near(r.max, 1400),
    '1,240 eaten of 2,400: 920–1,400 more lands the day in range'
  );
  const past = landingRange(2700, 2400);
  check(
    past.min === 0 && past.max === 0,
    'past the top: nothing more lands it — both ends floor at 0'
  );
  const inside = landingRange(2200, 2400);
  check(inside.min === 0 && near(inside.max, 440), 'already in range: up to 440 more stays in it');
}

console.log('6. pace against the curve, and the words the fold shows');
{
  const on = intakePace(1200, 2400, 0.5);
  check(on.word === 'on pace' && on.delta === 0 && !on.closed, 'exactly on the curve is on pace');
  const edge = intakePace(1200 + 2400 * ON_PACE_BAND, 2400, 0.5);
  check(
    edge.word === 'on pace',
    `+${ON_PACE_BAND * 100}% of the goal is still on pace — Home's own threshold`
  );
  const ahead = intakePace(1380, 2400, 0.5);
  check(
    ahead.word === 'ahead' && paceWords(ahead, 'kcal') === '180 kcal ahead',
    '"180 kcal ahead"',
    paceWords(ahead, 'kcal')
  );
  const behind = intakePace(960, 2400, 0.5);
  check(
    paceWords(behind, 'kcal') === '240 kcal behind',
    '"240 kcal behind"',
    paceWords(behind, 'kcal')
  );
  const closedIn = intakePace(2300, 2400, 1);
  check(
    closedIn.closed && paceWords(closedIn, 'kcal') === 'in range',
    'once the curve closes, the band speaks: "in range"'
  );
  const closedUnder = intakePace(2000, 2400, 1);
  check(
    paceWords(closedUnder, 'kcal') === '400 kcal under range',
    '"400 kcal under range"',
    paceWords(closedUnder, 'kcal')
  );
  const closedOver = intakePace(2900, 2400, 1);
  check(paceWords(closedOver, 'kcal') === '500 kcal over range', '"500 kcal over range"');
}

console.log('7. the chart window: eating hours plus one either side, now always inside');
{
  const learned = learnCurve(threeMealDays(10), 'kcal', TODAY, '00:00');
  const [s, e] = chartWindow(learned, [], 14 * 60);
  check(
    s === 7 * 60 && e === 21 * 60,
    'curve 08:00–20:00 → axis 07:00–21:00',
    JSON.stringify([s, e])
  );
  const [s2, e2] = chartWindow(learned, [{ minute: 23 * 60 + 10, kcal: 1, protein_g: 0 }], 5 * 60);
  check(
    s2 === 4 * 60 && e2 === 24 * 60,
    'an early now (05:00) and a 23:10 meal widen it to 04:00–24:00',
    JSON.stringify([s2, e2])
  );
}

console.log('8. the 7-day trendline with gaps');
{
  const dates = localDaysList('2026-10-21', 14);
  const at = (i) => dates[i];
  const readings = [
    { date: shiftISODate(dates[0], -2), value: 90 }, // lookback, before the axis
    { date: at(0), value: 80 },
    { date: at(1), value: 82 },
    { date: at(2), value: 84 },
    // gap: days 3..9 have nothing
    { date: at(10), value: 70 },
    { date: at(11), value: 71 },
    { date: at(12), value: 72 },
  ];
  const t = trailingAverageSeries(readings, dates);
  check(t.length === 14 && t[0].date === dates[0], 'one point per axis day, oldest first');
  check(
    near(t[1].average, 84),
    'day 1: two axis readings plus the lookback make three → (90+80+82)/3',
    JSON.stringify(t[1])
  );
  check(
    near(t[2].average, (90 + 80 + 82 + 84) / 4),
    'day 2: the lookback reading counts — (90+80+82+84)/4'
  );
  check(
    t[0].average === null,
    'day 0: lookback + one = two readings, under the floor of three → no average'
  );
  check(
    t[5].value === null && near(t[5].average, (80 + 82 + 84) / 3),
    'inside the gap the window still holds three → an average with no dot'
  );
  check(
    t[9].average === null,
    'deeper in the gap the window thins below three → the line BREAKS (null), never a guess'
  );
  check(
    near(t[12].average, 71),
    'after the gap it resumes once three readings are back (70, 71, 72)'
  );
  check(near(latestAverage(t), 71), 'latestAverage is the newest non-null average');
  check(latestAverage(trailingAverageSeries([], dates)) === null, 'no readings, no average');

  const means = dailyMeans(
    [
      { measuredAt: new Date(2026, 9, 20, 7, 0).toISOString(), value: 80 },
      { measuredAt: new Date(2026, 9, 20, 21, 0).toISOString(), value: 81 },
      { measuredAt: new Date(2026, 9, 21, 1, 30).toISOString(), value: 82 },
    ],
    '04:00'
  );
  check(
    means.length === 1 && means[0].date === '2026-10-20' && near(means[0].value, 81),
    'two weigh-ins and a 01:30 reading under a 04:00 boundary are ONE logical day, averaged (81)',
    JSON.stringify(means)
  );
}

console.log('9. geometry: scales and paths');
{
  const sx = linearScale([0, 10], [0, 100]);
  check(sx(5) === 50 && sx(10) === 100, 'linearScale maps the domain onto the range');
  check(
    linearScale([3, 3], [0, 100])(3) === 50,
    'a flat domain maps to the middle, never divides by zero'
  );
  const id = (v) => v;
  const d = linePath(
    [
      { x: 0, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: null },
      { x: 3, y: 4 },
      { x: 4, y: null },
      { x: 5, y: 6 },
      { x: 6, y: 7 },
    ],
    id,
    id
  );
  check(d === 'M0 1 L1 2 M5 6 L6 7', 'linePath breaks at gaps and drops a lone point', d);
  check(
    stepPath(
      [
        { x: 0, y: 0 },
        { x: 2, y: 5 },
        { x: 4, y: 9 },
      ],
      id,
      id
    ) === 'M0 0 H2 V5 H4 V9',
    'stepPath holds, then jumps'
  );
  check(stepPath([{ x: 0, y: 0 }], id, id) === '', 'a one-point step path draws nothing');
  const dom = paddedDomain([10, null, 20]);
  check(near(dom[0], 8.5) && near(dom[1], 21.5), 'paddedDomain pads the range 15% each side');
  check(
    paddedDomain([null]) === null && paddedDomain([5])[0] === 4,
    'no values → no domain; a flat one gets ±1'
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
