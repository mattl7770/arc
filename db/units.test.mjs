/**
 * Headless test of the unit-display engine — resolveDisplay / roundToSpec /
 * formatMeasured in src/lib/log/metrics.ts. These are PURE functions (no DB), so
 * this suite just exercises the conversions + round-trips directly. Storage is
 * canonical SI (weight kg, waist cm, water ml); these functions are the only
 * place the lb/kg · in/cm · oz/ml display toggle lives.
 * Run: node --import ./db/register-ts-hooks.mjs db/units.test.mjs
 */
import {
  formatMeasured,
  metricByKey,
  resolveDisplay,
  roundToSpec,
} from '../src/lib/log/metrics.ts';

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

console.log('3. water — ml canonical, oz display, rounded to whole units');
{
  const oz = resolveDisplay(water, IMPERIAL);
  oz.unit === 'oz' && oz.decimals === 0
    ? ok('imperial water spec is oz / 0dp')
    : bad('oz spec', JSON.stringify(oz));
  roundToSpec(oz, oz.fromCanonical(240)) === 8
    ? ok('240 ml → 8 oz (rounded whole)')
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
  formatMeasured(resolveDisplay(water, IMPERIAL), 240) === '8 oz'
    ? ok('240 ml formats as "8 oz"')
    : bad('format oz', formatMeasured(resolveDisplay(water, IMPERIAL), 240));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
