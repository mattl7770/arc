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
import { palette } from '../src/constants/theme.ts';
import { barFigure } from '../src/lib/nutrition/bar.ts';
import {
  DAY_METRIC_LABELS,
  dayFigure,
  mealsMissingValues,
  metricIsComplete,
  recordFigure,
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
  note && note.startsWith('One meal is not fully counted for energy, protein, carbs or fat')
    ? ok(
        'the note names the metrics in display order, joined with OR — each meal is short on at least one, not on all four'
      )
    : bad('note copy', String(note));

  note && note.includes('what is left of today is not known')
    ? ok('and states the consequence, so the missing remainder is explained rather than absent')
    : bad('note consequence', String(note));

  const twoBlank = [...FULL_DAY, meal(null, 10, 10, 10), meal(null, 10, 10, 10)];
  const plural = unguardedNote(twoBlank, TARGETS);
  plural && plural.startsWith('2 meals are not fully counted for energy')
    ? ok('two meals missing only kcal → plural subject, and only energy is named')
    : bad('plural copy', String(plural));

  // AND the consequence is scoped: protein, carbs and fat are still counting
  // down in the cells above, so the note must not claim the whole day is
  // unknown. That generalisation was the defect.
  plural && plural.includes('what has been logged rather than what is left')
    ? ok('a partial fallback scopes its consequence to the metrics it names')
    : bad('scoped consequence', String(plural));
  plural && !plural.includes('what is left of today is not known')
    ? ok('and does not claim the whole day is unknown while three cells count down')
    : bad('over-broad consequence', String(plural));
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

console.log('11. a partially resolved recipe: the total is non-null AND knowingly short');
{
  // logRecipe writes the priced ingredients as items with snapshots and the
  // rest as name-only items with NULL macros, so the MEAL total is a sum over
  // the priced half. It is non-null, it looks complete, and it means "at least
  // this much" — subtracting it from a target over-states what is left, on
  // exactly the days the user cooked from the book.
  const cooked = { id: 'm-cooked', kcal: 620, protein_g: 42, carbs_g: 68, fat_g: 20 };
  const day = [meal(740, 46, 62, 33), cooked];
  const partial = { 'm-cooked': { kcal: true, protein_g: true } };

  const naive = dayFigure(day, 'kcal', 2400);
  naive.mode === 'remaining'
    ? ok('without the partial map the guard passes it — the columns are all non-null')
    : bad('control', JSON.stringify(naive));

  const guarded = dayFigure(day, 'kcal', 2400, partial);
  guarded.mode === 'eaten' && guarded.target === 2400
    ? ok('with it, kcal falls back to the eaten reading and keeps its denominator')
    : bad('partial guard', JSON.stringify(guarded));

  const fat = dayFigure(day, 'fat_g', 70, partial);
  fat.mode === 'remaining' && fat.remaining === 17
    ? ok('fat was fully priced in that meal, so it still counts down — per metric, not per meal')
    : bad('per-metric partial', JSON.stringify(fat));

  const note = unguardedNote(day, TARGETS, partial);
  note && note.startsWith('One meal is not fully counted for energy or protein')
    ? ok('and the note names exactly the two metrics that were short')
    : bad('partial note', String(note));

  mealsMissingValues(day, TARGETS, partial) === 1
    ? ok('the meal count sees a short total the same way it sees a NULL')
    : bad('partial meal count', String(mealsMissingValues(day, TARGETS, partial)));
}

console.log('\n12. a CLOSED day is a record, not a plan (C1 — the history screen’s day view)');
{
  // The defect this exists for, stated as the test that would have caught it:
  // an EMPTY day passes metricIsComplete vacuously (no meals, so no meal is
  // missing a value), so dayFigure hands back a full remainder — and the
  // history screen would have printed "2,400 kcal left" over a Tuesday that is
  // over and can never be eaten into again.
  const emptyDay = dayFigure([], 'kcal', 2400, {});
  emptyDay.mode === 'remaining' && emptyDay.remaining === 2400
    ? ok('an empty day earns a remainder — correct for TODAY, and the trap for yesterday')
    : bad('empty-day control', JSON.stringify(emptyDay));

  const closedEmpty = recordFigure(emptyDay);
  closedEmpty.mode === 'eaten' && closedEmpty.eaten === 0 && closedEmpty.target === 2400
    ? ok('read as a record it eats nothing, against the target it was judged by')
    : bad('closed empty day', JSON.stringify(closedEmpty));

  // A day that WAS fully logged keeps every number; only the countdown goes.
  const lived = dayFigure(FULL_DAY, 'kcal', 2400, {});
  const closed = recordFigure(lived);
  lived.mode === 'remaining' && lived.remaining === 780
    ? ok('a full day counts down while it is today')
    : bad('lived-day control', JSON.stringify(lived));
  closed.mode === 'eaten' && closed.eaten === 1620 && closed.target === 2400
    ? ok(
        '…and reads 1,620 of 2,400 once it is closed — the target survives, the countdown does not'
      )
    : bad('closed full day', JSON.stringify(closed));

  // Idempotent, and a no-op on a figure that was already a record: a screen
  // that applies it twice, or applies it to an untargeted metric, must not
  // change anything.
  const alreadyEaten = dayFigure(FULL_DAY, 'kcal', null, {});
  recordFigure(alreadyEaten) === alreadyEaten
    ? ok('an eaten reading is returned untouched — the same object, not a copy')
    : bad('recordFigure rewrote an eaten reading');
  JSON.stringify(recordFigure(recordFigure(lived))) === JSON.stringify(closed)
    ? ok('and applying it twice says the same thing')
    : bad('recordFigure is not idempotent');

  // An over-target day loses its "over" reading too, which is the point: "12
  // kcal over" is a warning about a day you can still act on. A closed day's
  // over-ness is visible in the ledger — 2,412 of 2,400 — without a countdown.
  const over = recordFigure(dayFigure([meal(2412, 0, 0, 0)], 'kcal', 2400, {}));
  over.mode === 'eaten' && over.eaten === 2412
    ? ok('an over-target day reads as its own total against the target')
    : bad('closed over-target day', JSON.stringify(over));
}

console.log('12. barFigure: the geometry of the Today-grid bars (C6)');
{
  const cases = [
    ['an empty day inks nothing', barFigure(0, 2400), 0, false],
    ['a part-logged day fills its fraction', barFigure(1620, 2400), 67.5, false],
    [
      'exactly on target is MET — the pine fill and the terminator',
      barFigure(2400, 2400),
      100,
      true,
    ],
    ['past target CAPS at the mark and stays met', barFigure(2800, 2400), 100, true],
    ['one gram short is not met', barFigure(179, 180), (179 / 180) * 100, false],
  ];
  for (const [name, figure, fillPct, met] of cases) {
    Math.abs(figure.fillPct - fillPct) < 1e-9 && figure.met === met
      ? ok(`${name} (${figure.fillPct.toFixed(1)}% · met ${figure.met})`)
      : bad(name, JSON.stringify(figure));
  }

  // dayFigure already refuses a non-positive target, so a bar is never asked to
  // divide by one. The backstop draws an EMPTY bar rather than a full one: with
  // no frame of reference there is no progress to claim.
  const noFrame = [barFigure(500, 0), barFigure(500, -100), barFigure(500, Number.NaN)];
  noFrame.every((f) => f.fillPct === 0 && f.met === false)
    ? ok('a non-positive or non-finite target draws an empty bar, never a full one')
    : bad('no-frame guard', JSON.stringify(noFrame));

  dayFigure([], 'kcal', 0).mode === 'eaten' && dayFigure([], 'kcal', 0).target === null
    ? ok('…and dayFigure never lets one through in the first place')
    : bad('dayFigure zero target', JSON.stringify(dayFigure([], 'kcal', 0)));
}

console.log('13. the bar’s colours, measured against the plate (C6)');
{
  // WCAG 1.4.11 asks 3:1 of a non-text visual against what it sits on. The
  // numbers are asserted rather than documented because the whole design of the
  // terminator rests on ONE of them — pine and ink-secondary are the same
  // luminance, so a fill that only changes hue at target changes nothing anyone
  // can see. If a future palette move makes them distinguishable, this test
  // should be the thing that says so.
  const luminance = (hex) => {
    const channel = (i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };
  const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const { ink, inkSecondary, pine, paperDeep, paper } = palette;

  const measured = [
    ['fill under target — ink-secondary on the rail', ratio(inkSecondary, paperDeep), 5.83],
    ['fill at/over target — pine on the rail', ratio(pine, paperDeep), 5.87],
    ['the terminator — ink on the rail', ratio(ink, paperDeep), 9.74],
    ['the terminator against the pine beside it', ratio(ink, pine), 1.66],
    ['THE REASON FOR THE TERMINATOR — pine against ink-secondary', ratio(pine, inkSecondary), 1.01],
    ['the rail itself on the sheet (a ground, not a mark)', ratio(paperDeep, paper), 1.42],
  ];
  for (const [name, value, expected] of measured) {
    Math.abs(value - expected) < 0.005
      ? ok(`${name}: ${value.toFixed(2)}:1`)
      : bad(name, `${value.toFixed(3)} — the docblock in app/nutrition.tsx says ${expected}`);
  }

  // The three that carry information clear the non-text floor; the two that
  // deliberately do not are the rail (a ground) and the hue step (which is why
  // hue is never the only cue).
  [ratio(inkSecondary, paperDeep), ratio(pine, paperDeep), ratio(ink, paperDeep)].every(
    (r) => r >= 3
  )
    ? ok('every mark that carries meaning clears WCAG 1.4.11’s 3:1')
    : bad('a bar mark is under the non-text floor');

  ratio(pine, inkSecondary) < 1.1
    ? ok('hue alone is NOT a visible state change — the terminator is load-bearing')
    : bad('pine and ink-secondary have separated; revisit the terminator’s reasoning');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
