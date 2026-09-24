/**
 * Headless test of the unit-display engine — resolveDisplay / roundToSpec /
 * formatMeasured in src/lib/log/metrics.ts. These are PURE functions (no DB), so
 * this suite just exercises the conversions + round-trips directly. Storage is
 * canonical SI (weight kg, waist cm, water ml); these functions are the only
 * place the lb/kg · in/cm · oz/ml display toggle lives.
 * Run: node --import ./db/register-ts-hooks.mjs db/units.test.mjs
 */
import {
  formatFigure,
  formatMeasured,
  metricByKey,
  ML_PER_OZ,
  OZ_TENTHS_BELOW,
  resolveDisplay,
  roundForDisplay,
  roundToSpec,
} from '../src/lib/log/metrics.ts';
import { fmtAmount } from '../src/lib/nutrition/format.ts';

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
const near = (a, b, eps = 1e-3) => typeof a === 'number' && Math.abs(a - b) < eps;

const IMPERIAL = { weight: 'lb', distance: 'mi', volume: 'oz', length: 'in', temperature: 'F' };
const METRIC = { weight: 'kg', distance: 'km', volume: 'ml', length: 'cm', temperature: 'C' };

const weight = metricByKey('weight');
const waist = metricByKey('waist');
const water = metricByKey('water');
const hrv = metricByKey('hrv');
const bodyFat = metricByKey('body_fat');

console.log('0. the metrics under test resolve');
weight && waist && water && hrv && bodyFat
  ? ok('weight / waist / water / hrv / body_fat descriptors exist')
  : bad('missing descriptors');

console.log('1. weight — imperial vs metric, with a canonical→display→canonical round-trip');
{
  const lb = resolveDisplay(weight, IMPERIAL);
  lb.unit === 'lb' && lb.decimals === 1
    ? ok('imperial weight spec is lb / 1dp')
    : bad('lb spec', JSON.stringify(lb));
  near(lb.fromCanonical(80), 176.3698)
    ? ok('80 kg → 176.37 lb')
    : bad('kg→lb', lb.fromCanonical(80));
  near(lb.toCanonical(lb.fromCanonical(80)), 80)
    ? ok('lb round-trips back to 80 kg (storage stays canonical)')
    : bad('lb round-trip', lb.toCanonical(lb.fromCanonical(80)));

  const kg = resolveDisplay(weight, METRIC);
  kg.unit === 'kg' && kg.fromCanonical(80) === 80 && kg.toCanonical(80) === 80
    ? ok('metric weight spec is kg and identity in both directions')
    : bad('kg spec', JSON.stringify(kg));
}

console.log('2. waist — cm canonical, inches display');
{
  const inch = resolveDisplay(waist, IMPERIAL);
  inch.unit === 'in' && near(inch.fromCanonical(100), 39.3701)
    ? ok('100 cm → 39.37 in')
    : bad('cm→in', JSON.stringify(inch));
  near(inch.toCanonical(inch.fromCanonical(93.4)), 93.4)
    ? ok('in round-trips back to canonical cm')
    : bad('in round-trip', inch.toCanonical(inch.fromCanonical(93.4)));
  const cm = resolveDisplay(waist, METRIC);
  cm.unit === 'cm' && cm.fromCanonical(93.4) === 93.4
    ? ok('metric waist spec is cm identity')
    : bad('cm spec', JSON.stringify(cm));
}

console.log('3. water — ml canonical, oz display; ENTERED in whole ounces, PRINTED finer');
{
  const oz = resolveDisplay(water, IMPERIAL);
  // `decimals` is the precision a value is entered and computed at (the keypad,
  // the Coach's card) and it did not change. What is printed is `tenthsBelow`,
  // section 6.
  oz.unit === 'oz' && oz.decimals === 0 && oz.tenthsBelow === OZ_TENTHS_BELOW
    ? ok('imperial water spec is oz / 0dp entered, tenths printed below 32')
    : bad('oz spec', JSON.stringify(oz));
  roundToSpec(oz, oz.fromCanonical(240)) === 8
    ? ok('240 ml → 8 oz at the ENTRY precision (roundToSpec is unchanged)')
    : bad('ml→oz', roundToSpec(oz, oz.fromCanonical(240)));
  near(oz.toCanonical(16), 473.176)
    ? ok('16 oz → 473 ml canonical')
    : bad('oz→ml', oz.toCanonical(16));
  const ml = resolveDisplay(water, METRIC);
  ml.unit === 'ml' && ml.fromCanonical(500) === 500
    ? ok('metric water spec is ml identity')
    : bad('ml spec', JSON.stringify(ml));
}

console.log('4. non-switchable metrics ignore the unit preference');
{
  // HRV and body-fat have no user-facing unit choice — same spec under either.
  const hrvI = resolveDisplay(hrv, IMPERIAL);
  const hrvM = resolveDisplay(hrv, METRIC);
  hrvI.unit === 'ms' && hrvM.unit === 'ms' && hrvI.fromCanonical(48) === 48
    ? ok('HRV stays ms (identity) regardless of prefs')
    : bad('hrv spec', JSON.stringify({ hrvI, hrvM }));
  const bf = resolveDisplay(bodyFat, METRIC);
  bf.unit === '%' && bf.fromCanonical(14.2) === 14.2
    ? ok('body-fat stays % regardless of prefs')
    : bad('body_fat spec', JSON.stringify(bf));
}

console.log('5. formatMeasured renders a canonical value per the resolved spec');
{
  formatMeasured(resolveDisplay(weight, IMPERIAL), 80) === '176.4 lb'
    ? ok('80 kg formats as "176.4 lb"')
    : bad('format lb', formatMeasured(resolveDisplay(weight, IMPERIAL), 80));
  formatMeasured(resolveDisplay(weight, METRIC), 80) === '80.0 kg'
    ? ok('80 kg formats as "80.0 kg" under metric')
    : bad('format kg', formatMeasured(resolveDisplay(weight, METRIC), 80));
  // CORRECTED 2026-09-21. This pinned "8 oz", and that pin was the defect:
  // 240 ml is 8.115 oz, and printing it as 8 is the whole-ounce rounding the
  // owner saw on Garmin water ("units are heavily rounded"). Section 6 holds
  // the reproduction.
  formatMeasured(resolveDisplay(water, IMPERIAL), 240) === '8.1 oz'
    ? ok('240 ml formats as "8.1 oz" (it is 8.115 oz; "8 oz" was the defect)')
    : bad('format oz', formatMeasured(resolveDisplay(water, IMPERIAL), 240));
  // Every other spec prints exactly as before: fixed at its own decimals.
  formatMeasured(resolveDisplay(weight, IMPERIAL), 79.3787) === '175.0 lb' &&
  formatMeasured(resolveDisplay(water, METRIC), 1893) === '1893 ml'
    ? ok('non-ounce specs keep fixed decimals ("175.0 lb", "1893 ml" with no comma)')
    : bad('fixed-decimal specs moved');
}

console.log('6. the Garmin water rounding, reproduced (owner, 2026-09-21: "heavily rounded")');
{
  const oz = resolveDisplay(water, IMPERIAL);
  const ml = resolveDisplay(water, METRIC);
  const f = (v) => formatFigure(oz, v);
  // A Garmin bucket arrives in millilitres (stored to the whole mL by
  // statisticDailyRows, a loss of at most 0.5 mL = 0.017 oz). These are the
  // figures the water screen printed before the fix, and what it prints now:
  //   250 mL = 8.4535 oz   was "8"  (−5.36 %)   now "8.5"
  //   100 mL = 3.3814 oz   was "3"  (−11.28 %)  now "3.4"
  //   200 mL = 6.7628 oz   was "7"  (+3.51 %)   now "6.8"
  //   500 mL = 16.9070 oz  was "17" (+0.55 %)   now "16.9"
  //   473 mL = 15.9940 oz  was "16" (−0.04 %)   now "16"
  f(250) === '8.5' && f(100) === '3.4' && f(200) === '6.8' && f(500) === '16.9' && f(473) === '16'
    ? ok('metric Garmin buckets print to the tenth: 250→8.5, 100→3.4, 200→6.8, 500→16.9, 473→16')
    : bad('garmin buckets', JSON.stringify([f(250), f(100), f(200), f(500), f(473)]));
  // A capture TYPED in ounces round-trips exactly and prints as typed, with no
  // ".0". That is why the rounding never showed on manual water, and why the
  // owner's note was on the Garmin item.
  f(oz.toCanonical(8)) === '8' && f(oz.toCanonical(16)) === '16' && f(oz.toCanonical(24)) === '24'
    ? ok('typed 8 / 16 / 24 oz print as "8" / "16" / "24", exactly as typed')
    : bad('typed ounces', JSON.stringify([8, 16, 24].map((n) => f(oz.toCanonical(n)))));
  // The 32 oz line, decided on the value as printed.
  f(31.94 * ML_PER_OZ) === '31.9' &&
  f(31.96 * ML_PER_OZ) === '32' &&
  f(oz.toCanonical(32)) === '32' &&
  f(2957) === '100' &&
  f(68.44 * ML_PER_OZ) === '68'
    ? ok('whole ounces from 32 up: 31.94→31.9, 31.96→32, 2957 mL goal→100, 68.44→68')
    : bad('32 oz line', JSON.stringify([f(31.94 * ML_PER_OZ), f(31.96 * ML_PER_OZ), f(2957)]));
  // The ledger. Three metric cups printed 8 + 8 + 8 = 24 under a printed day
  // total of 25, which broke the rule that a ledger sums to its own total. At a
  // tenth the rows print 8.5 each and the total 25.4: off by 0.1, not 1.
  const rows = [250, 250, 250].map((v) => Number(f(v)));
  const total = Number(f(750));
  rows.join(',') === '8.5,8.5,8.5' &&
  total === 25.4 &&
  Math.abs(rows.reduce((a, b) => a + b, 0) - total) < 0.1 + 1e-9
    ? ok('three 250 mL rows print 8.5 + 8.5 + 8.5 under a day of 25.4 (was 8 + 8 + 8 under 25)')
    : bad('ledger', JSON.stringify({ rows, total }));
  // One quantity, one answer. Nutrition has printed millilitres this way since
  // 0047, and water now agrees with it.
  formatMeasured(oz, 250) === fmtAmount(250, 'ml', 'oz') && fmtAmount(250, 'ml', 'oz') === '8.5 oz'
    ? ok('water and nutrition print 250 mL identically under oz: "8.5 oz"')
    : bad('two answers', `${formatMeasured(oz, 250)} vs ${fmtAmount(250, 'ml', 'oz')}`);
  // The edit field is prefilled with the printed value, not a whole ounce.
  roundForDisplay(oz, 250) === 8.5 && roundForDisplay(oz, 2957) === 100
    ? ok('roundForDisplay gives the edit field the printed figure (250 mL → 8.5)')
    : bad('prefill', JSON.stringify([roundForDisplay(oz, 250), roundForDisplay(oz, 2957)]));
  // Millilitres are untouched: whole mL, with the thousands comma.
  formatFigure(ml, 1893) === '1,893' &&
  formatFigure(ml, 250) === '250' &&
  ml.tenthsBelow === undefined
    ? ok('ml prints whole, grouped ("1,893"), with no tenths rule')
    : bad('ml figure', JSON.stringify([formatFigure(ml, 1893), formatFigure(ml, 250)]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
