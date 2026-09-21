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
import { barFigure, macroGrade } from '../src/lib/nutrition/bar.ts';
import { kcalLevel, paceRatio, proteinLevel } from '../src/lib/home/readiness.ts';
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
      'exactly on target is MET — the fill reaches the terminator',
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

console.log('12b. macroGrade: the bar’s colour is the pillar’s own reading (FB2)');
{
  // The whole claim of FB2 is that a bar cannot disagree with the Home pillar,
  // because it is not graded by a second rule — it is graded by the pillar's own
  // two functions on the pillar's own projected ratio. These cases assert that
  // identity directly rather than re-deriving the bands: if KCAL_BANDS is ever
  // retuned, kcalLevel moves and so does every bar, with no edit here.
  const day = { direction: 'maintain', expected: 1, mealCount: 3 };
  const same = [
    ['kcal is kcalLevel, argument for argument', 'kcal', 2400, 2400],
    ['a 17% overshoot while maintaining', 'kcal', 2800, 2400],
    ['carbs take the SAME direction-aware table', 'carbs_g', 280, 240],
    ['and so does fat', 'fat_g', 40, 70],
  ];
  for (const [name, metric, eaten, target] of same) {
    const grade = macroGrade({ ...day, metric, eaten, target });
    const pillar = kcalLevel(paceRatio(eaten, target, 1), 'maintain');
    grade === pillar
      ? ok(`${name}: ${grade}`)
      : bad(name, `bar says ${grade}, the pillar says ${pillar}`);
  }

  // The one place a shared table would have LIED. Protein is one-sided in the
  // pillar — overshooting is not a failure in any direction — so a 200g day on a
  // 180g target must read optimal, where the calorie bands would call it caution.
  {
    const over = { ...day, metric: 'protein_g', eaten: 200, target: 180 };
    const asProtein = macroGrade(over);
    const asCalories = kcalLevel(paceRatio(200, 180, 1), 'maintain');
    asProtein === proteinLevel(paceRatio(200, 180, 1)) &&
    asProtein === 'optimal' &&
    asCalories !== 'optimal'
      ? ok(`protein over target is optimal, not ${asCalories} — the one-sided band holds`)
      : bad('protein band', `${asProtein} vs ${asCalories}`);
  }

  // Direction reaches the macros, not just the calories: the same carb day is a
  // different verdict depending on where the user is going.
  {
    const carbs = (direction) =>
      macroGrade({
        metric: 'carbs_g',
        eaten: 288,
        target: 240,
        direction,
        expected: 1,
        mealCount: 2,
      });
    // +20% is INSIDE `gain`'s loose band (optimal), the outer edge of `maintain`'s
    // even one (good), and exactly on the last rung of `cut`'s tight one
    // (caution). Three verdicts on one plate of rice, which is the point.
    carbs('gain') === 'optimal' && carbs('maintain') === 'good' && carbs('cut') === 'caution'
      ? ok('+20% carbs reads optimal gaining, good maintaining, caution cutting')
      : bad('direction on carbs', [carbs('gain'), carbs('maintain'), carbs('cut')].join(' / '));
  }

  // The four refusals, in the pillar's own order. Each is a state where
  // nutritionVerdict returns `unknown`, so a coloured bar here would be the Eat
  // tab judging a day Home has declined to judge.
  const base = {
    metric: 'kcal',
    eaten: 2400,
    target: 2400,
    direction: 'maintain',
    expected: 1,
    mealCount: 3,
  };
  macroGrade(base) === 'optimal'
    ? ok('the control case does grade — the refusals below are not vacuous')
    : bad('control case', macroGrade(base));
  const refusals = [
    ['a day that changed timezone is not graded at all', { ...base, timezoneChanged: true }],
    ['no target governing the metric', { ...base, target: null }],
    ['a zero target is no target', { ...base, target: 0 }],
    ['nothing logged is not a bad day', { ...base, mealCount: 0 }],
    ['before the pace clock starts, the projection is the whole target', { ...base, expected: 0 }],
  ];
  for (const [name, inputs] of refusals) {
    macroGrade(inputs) === 'unknown' ? ok(name) : bad(name, macroGrade(inputs));
  }

  // The morning the projection exists to protect: 15% of the day's calories
  // eaten at 10:00 is a good day, and grading the RAW fraction would call it
  // poor. This is why colour is projected while the fill is literal.
  {
    const morning = { ...base, eaten: 360, expected: 0.15 };
    macroGrade(morning) === 'optimal' && barFigure(360, 2400).fillPct === 15
      ? ok('on pace at 10:00: the bar is 15% inked and graded optimal, not poor')
      : bad('the morning case', `${macroGrade(morning)} at ${barFigure(360, 2400).fillPct}%`);
  }
}

console.log('13. the bar’s colours, measured against the plate (FB2, 2026-09-21)');
{
  // WCAG 1.4.11 asks 3:1 of a non-text visual against what it sits on. These are
  // asserted rather than documented because the choice of CUT rests entirely on
  // them: the palette says the swatch is the fill value, and on THIS rail two of
  // the four swatches are under the floor, so the fill takes the ink cut
  // instead. If the palette ever moves, this is the thing that says so.
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
  const { ink, paperDeep, paper, signal, signalInk } = palette;
  const LEVELS = ['optimal', 'good', 'caution', 'poor'];

  const measured = [
    ['fill · optimal — signal-optimal-ink on the rail', ratio(signalInk.optimal, paperDeep), 4.56],
    ['fill · good — signal-good-ink on the rail', ratio(signalInk.good, paperDeep), 4.34],
    ['fill · caution — signal-caution-ink on the rail', ratio(signalInk.caution, paperDeep), 4.17],
    ['fill · poor — signal-poor-ink on the rail', ratio(signalInk.poor, paperDeep), 4.31],
    ['fill · unknown — the metadata ink on the rail', ratio(signalInk.unknown, paperDeep), 4.21],
    ['the terminator — ink on the bare rail, where it matters', ratio(ink, paperDeep), 9.74],
    ['the rail itself on the sheet (a ground, not a mark)', ratio(paperDeep, paper), 1.42],
  ];
  for (const [name, value, expected] of measured) {
    Math.abs(value - expected) < 0.005
      ? ok(`${name}: ${value.toFixed(2)}:1`)
      : bad(name, `${value.toFixed(3)} — the docblock in app/nutrition.tsx says ${expected}`);
  }

  // THE MEASUREMENT THAT CHOSE THE CUT. The palette specifies the swatch for
  // fills, and on this rail optimal (2.36) and caution (2.10) are under the
  // non-text floor — half the states invisible is the same defect C6 had, in new
  // hues. Every ink cut clears it. If a palette move ever lifts the swatches
  // over 3:1 on paperDeep, this is the assertion that invites the revisit.
  LEVELS.some((l) => ratio(signal[l], paperDeep) < 3)
    ? ok(
        `the SWATCH cut fails on this rail (${LEVELS.map((l) => ratio(signal[l], paperDeep).toFixed(2)).join(' / ')}) — which is why the fill takes the ink cut`
      )
    : bad('the swatch cut now clears 3:1 on paperDeep; revisit which cut the fill should take');

  ['optimal', 'good', 'caution', 'poor', 'unknown'].every(
    (l) => ratio(signalInk[l], paperDeep) >= 3
  )
    ? ok('every graded fill clears WCAG 1.4.11’s 3:1 against the rail')
    : bad('a graded fill is under the non-text floor');

  // WHAT COLOUR DOES NOT CARRY, asserted so it cannot be quietly forgotten. The
  // four cuts are near-isoluminant against one ground, so to anyone not
  // perceiving hue they are one dark mark — the readiness-strip finding, which
  // is why the cell's label word and the figures above the bar stay put.
  const spread = Math.max(...LEVELS.map((l) => ratio(signalInk[l], paperDeep)));
  const floor = Math.min(...LEVELS.map((l) => ratio(signalInk[l], paperDeep)));
  spread / floor < 1.2
    ? ok(
        `the four graded fills are near-isoluminant (${floor.toFixed(2)}–${spread.toFixed(2)}) — hue is reinforcement, never the sole cue`
      )
    : bad(
        'the graded fills have separated in luminance; the docblock’s reasoning needs revisiting'
      );

  // The terminator against the fill it lands on. UNDER the floor and accepted:
  // `met` is carried by the fill reaching the rail's end and by the label's own
  // word, and the terminator's real job — marking where the target is — happens
  // on the bare rail at 9.74:1. Asserted so the number stays honest, and because
  // it is still strictly better than C6's 1.66:1 on ink-secondary.
  const onFill = LEVELS.map((l) => ratio(ink, signalInk[l]));
  Math.min(...onFill) > 1.66 && Math.max(...onFill) < 3
    ? ok(
        `the terminator on a graded fill: ${Math.min(...onFill).toFixed(2)}–${Math.max(...onFill).toFixed(2)}:1 — under the floor, and better than C6’s 1.66:1`
      )
    : bad('terminator-on-fill', onFill.map((r) => r.toFixed(2)).join(' / '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
