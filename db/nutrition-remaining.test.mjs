/**
 * Headless test of the Eat tab's guarded remainder (src/lib/nutrition/remaining.ts).
 *
 * This is the one piece of the redesign that could have shipped a lie. The tab
 * leads with what is LEFT, and a day's totals skip NULL by design — so
 * `target − eaten` is too large by exactly the meals nobody measured, on the
 * very day the ledger below shows an em-dash for them. Every assertion here
 * exists to pin the guard that stops that number from being drawn.
 *
 * Pure module, no database. Run: npm run db:test.
 */
import {
  DAY_METRIC_LABELS,
  dayFigure,
  mealsMissingValues,
  metricIsComplete,
  sumRounded,
  unguardedMetrics,
  unguardedNote,
} from '../src/lib/nutrition/remaining.ts';

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

/** A meal row with only the columns this module reads. */
const meal = (kcal, protein_g, carbs_g, fat_g) => ({
  id: `m-${Math.abs(kcal ?? 0)}-${Math.abs(protein_g ?? 0)}-${Math.abs(carbs_g ?? 0)}`,
  kcal,
  protein_g,
  carbs_g,
  fat_g,
});

const FULL_DAY = [meal(620, 42, 68, 20), meal(740, 46, 62, 33), meal(260, 24, 26, 8)];
const TARGETS = { kcal: 2400, protein_g: 180, carbs_g: 240, fat_g: 70 };

console.log('1. sumRounded: rounds each row, then adds — and skips NULL rather than zeroing it');
{
  sumRounded([100.4, 100.4, 100.4]) === 300
    ? ok('Σround(x) = 300, not round(Σx) = 301 — the ledger adds up to what is on screen')
    : bad('rounding policy', String(sumRounded([100.4, 100.4, 100.4])));

  sumRounded([620, null, 260]) === 880
    ? ok('NULL contributes nothing (880), never a fabricated 0 that reads as a measurement')
    : bad('null skip', String(sumRounded([620, null, 260])));

  sumRounded([]) === 0 ? ok('an empty day sums to 0') : bad('empty sum');
  sumRounded([undefined, null]) === 0 ? ok('undefined is skipped like null') : bad('undefined');
}

console.log('2. metricIsComplete: the gate the remainder rides on');
{
  metricIsComplete(FULL_DAY, 'kcal') ? ok('a fully recorded day is complete') : bad('complete day');
  metricIsComplete([], 'kcal')
    ? ok('an empty day is vacuously complete — nothing logged cannot be missing anything')
    : bad('empty day completeness');
  !metricIsComplete([meal(620, 42, 68, 20), meal(null, null, null, null)], 'kcal')
    ? ok('one meal without kcal makes the day incomplete for kcal')
    : bad('incomplete detection');
  metricIsComplete([meal(620, 42, 68, 20), meal(500, null, 30, 10)], 'kcal') &&
  !metricIsComplete([meal(620, 42, 68, 20), meal(500, null, 30, 10)], 'protein_g')
    ? ok('completeness is PER METRIC — kcal can be sound while protein is not')
    : bad('per-metric completeness');
}

console.log('3. dayFigure: a remainder only when the day has earned one');
{
  const kcal = dayFigure(FULL_DAY, 'kcal', 2400);
  kcal.mode === 'remaining' && kcal.eaten === 1620 && kcal.remaining === 780
    ? ok('complete day + target → 780 kcal left, and 1,620 + 780 = 2,400 reconciles')
    : bad('remaining', JSON.stringify(kcal));

  const noTarget = dayFigure(FULL_DAY, 'kcal', null);
  noTarget.mode === 'eaten' && noTarget.eaten === 1620 && noTarget.target === null
    ? ok('no target → eaten alone, and NO denominator is invented')
    : bad('no target', JSON.stringify(noTarget));

  const zeroTarget = dayFigure(FULL_DAY, 'kcal', 0);
  zeroTarget.mode === 'eaten' && zeroTarget.target === null
    ? ok('a 0 target is not a frame of reference — treated as no target, never divided by')
    : bad('zero target', JSON.stringify(zeroTarget));

  const negTarget = dayFigure(FULL_DAY, 'kcal', -50);
  negTarget.mode === 'eaten' && negTarget.target === null
    ? ok('a negative target degrades the same way rather than producing a nonsense remainder')
    : bad('negative target', JSON.stringify(negTarget));
}

console.log('4. THE DEFECT THIS MODULE EXISTS FOR: an unmeasured meal must not inflate "left"');
{
  const dayWithDinner = [...FULL_DAY, meal(null, null, null, null)];
  const naive = 2400 - sumRounded(dayWithDinner.map((m) => m.kcal));
  const figure = dayFigure(dayWithDinner, 'kcal', 2400);

  naive === 780
    ? ok('the naive subtraction still says 780 kcal left — wrong by a whole dinner')
    : bad('naive control', String(naive));

  figure.mode === 'eaten'
    ? ok('dayFigure refuses to print it, and falls back to the shipped eaten reading')
    : bad('guard did not fire', JSON.stringify(figure));

  figure.mode === 'eaten' && figure.target === 2400
    ? ok('the fallback keeps its denominator, so the day still has a frame of reference')
    : bad('fallback denominator', JSON.stringify(figure));
}

console.log('5. an empty day: the whole target is what is left');
{
  const figure = dayFigure([], 'kcal', 2400);
  figure.mode === 'remaining' && figure.eaten === 0 && figure.remaining === 2400
    ? ok('nothing logged → 2,400 kcal left, the state the tab wakes into every morning')
    : bad('empty day', JSON.stringify(figure));
}

console.log('6. over target: a negative remainder, and no red anywhere near it');
{
  const heavy = [...FULL_DAY, meal(900, 40, 90, 30)];
  const figure = dayFigure(heavy, 'kcal', 2400);
  figure.mode === 'remaining' && figure.remaining === -120
    ? ok('2,520 eaten against 2,400 → −120, which the screen renders as "120 over"')
    : bad('over target', JSON.stringify(figure));
}

console.log('7. partial targets: kcal may be null while the macros are set');
{
  const kcal = dayFigure(FULL_DAY, 'kcal', null);
  const protein = dayFigure(FULL_DAY, 'protein_g', 180);
  kcal.mode === 'eaten' && protein.mode === 'remaining' && protein.remaining === 68
    ? ok(
        'the hero falls back while the protein cell still counts down — per metric, not per screen'
      )
    : bad('partial targets', JSON.stringify({ kcal, protein }));
}

console.log('8. the authored line: what it names, and when it stays silent');
{
  unguardedNote(FULL_DAY, TARGETS) === null
    ? ok('a fully recorded day prints no note — the grid says it all')
    : bad('note on a clean day', String(unguardedNote(FULL_DAY, TARGETS)));

  const dayWithDinner = [...FULL_DAY, meal(null, null, null, null)];
  const missing = unguardedMetrics(dayWithDinner, TARGETS);
  missing.length === 4
    ? ok('one unmeasured meal unguards all four targeted metrics')
    : bad('unguarded metrics', JSON.stringify(missing));

  mealsMissingValues(dayWithDinner, TARGETS) === 1
    ? ok('the count is of MEALS, not of metrics — one meal, however many blanks it has')
    : bad('meals missing', String(mealsMissingValues(dayWithDinner, TARGETS)));

  const note = unguardedNote(dayWithDinner, TARGETS);
  note && note.startsWith('One meal has no energy, protein, carbs and fat recorded')
    ? ok('the note names the metrics in display order and reads as a sentence')
    : bad('note copy', String(note));

  note && note.includes('what is left of today is not known')
    ? ok('and states the consequence, so the missing remainder is explained rather than absent')
    : bad('note consequence', String(note));

  const twoBlank = [...FULL_DAY, meal(null, 10, 10, 10), meal(null, 10, 10, 10)];
  const plural = unguardedNote(twoBlank, TARGETS);
  plural && plural.startsWith('2 meals have no energy recorded')
    ? ok('two meals missing only kcal → plural subject, and only energy is named')
    : bad('plural copy', String(plural));
}

console.log('9. an untargeted metric is never named as missing');
{
  const dayWithDinner = [...FULL_DAY, meal(620, null, 68, 20)];
  const targets = { kcal: 2400, protein_g: null, carbs_g: 240, fat_g: 70 };
  const missing = unguardedMetrics(dayWithDinner, targets);
  missing.length === 0
    ? ok('protein is blank but untargeted, so nothing is unguarded and no note is printed')
    : bad('untargeted named', JSON.stringify(missing));

  unguardedNote(dayWithDinner, targets) === null
    ? ok('the screen stays quiet about a metric it was never counting down')
    : bad('note for untargeted');

  mealsMissingValues(dayWithDinner, targets) === 0
    ? ok('and the meal count ignores blanks in untargeted metrics')
    : bad('meal count over untargeted');
}

console.log('10. the labels the note is built from are product nouns');
{
  DAY_METRIC_LABELS.kcal === 'energy' &&
  DAY_METRIC_LABELS.protein_g === 'protein' &&
  DAY_METRIC_LABELS.carbs_g === 'carbs' &&
  DAY_METRIC_LABELS.fat_g === 'fat'
    ? ok('"energy", not "kcal_g" — the user never reads a column name')
    : bad('labels', JSON.stringify(DAY_METRIC_LABELS));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
