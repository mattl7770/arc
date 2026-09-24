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
import { readFileSync } from 'node:fs';

import { palette } from '../src/constants/theme.ts';
import { barFigure, macroGrade, OVERFLOW_CAP } from '../src/lib/nutrition/bar.ts';
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

  // FB3 — the run past the mark. The fill above still caps at the rail; the
  // excess is a second number, a share of the RAIL's length, stopped at
  // OVERFLOW_CAP of it (150% in all), with `capped` only when there is more than
  // the room can draw.
  const runs = [
    ['under target draws no run', barFigure(1620, 2400), 0, false],
    ['on target draws no run — the mark, and nothing past it', barFigure(2400, 2400), 0, false],
    [
      '3 g past a 180 g target is a sliver, not nothing',
      barFigure(183, 180),
      (3 / 180) * 100,
      false,
    ],
    [
      '2,900 on 2,400 runs a fifth of the rail past the mark',
      barFigure(2900, 2400),
      (500 / 2400) * 100,
      false,
    ],
    [
      'exactly 150% fills the room and takes no +',
      barFigure(3600, 2400),
      OVERFLOW_CAP * 100,
      false,
    ],
    [
      'past 150% the run stops at the cap and takes the +',
      barFigure(300, 180),
      OVERFLOW_CAP * 100,
      true,
    ],
  ];
  for (const [name, figure, overPct, capped] of runs) {
    Math.abs(figure.overPct - overPct) < 1e-9 && figure.capped === capped
      ? ok(`${name} (${figure.overPct.toFixed(2)}% of the rail · capped ${figure.capped})`)
      : bad(name, JSON.stringify(figure));
  }
  // The two halves never trade: on every over day the in-budget fill is exactly
  // the rail, and met, whatever the run does — the excess never rescales it.
  const overDays = [183 / 180, 2900 / 2400, 3600 / 2400, 300 / 180].map((r) => barFigure(r, 1));
  overDays.every((f) => f.fillPct === 100 && f.met && f.overPct > 0)
    ? ok('on every over day the fill is the full rail and the excess is drawn only past it')
    : bad('fill/run split', JSON.stringify(overDays));

  // dayFigure already refuses a non-positive target, so a bar is never asked to
  // divide by one. The backstop draws an EMPTY bar rather than a full one: with
  // no frame of reference there is no progress to claim.
  const noFrame = [barFigure(500, 0), barFigure(500, -100), barFigure(500, Number.NaN)];
  noFrame.every((f) => f.fillPct === 0 && f.met === false && f.overPct === 0 && !f.capped)
    ? ok('a non-positive or non-finite target draws an empty bar, never a full one or a run')
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

console.log('13. the bar’s colours, measured against the plate (FB2 → FB3, 2026-09-21)');
{
  // Asserted rather than documented, because the choice of CUT rests entirely on
  // these numbers. FB2 asked WCAG 1.4.11's 3:1 of the fills; FB3 asks 4.5:1 of
  // every graded one, because FB2's — legible at 4.17–4.56 — still read as hard
  // to see on the device. If the palette ever moves, this is what says so.
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
  // OKLab (Ottosson, 2020) — the space CSS Color 4 measures colour difference
  // in. Chroma is the distance from the grey axis, hue the angle around it, and
  // ΔEok the plain distance between two colours, with ~0.02 as one
  // just-noticeable difference. `fromLch` is the inverse, used only to find the
  // chroma CEILING below.
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const oklab = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  const chroma = (hex) => Math.hypot(oklab(hex)[1], oklab(hex)[2]);
  const hue = (hex) => (Math.atan2(oklab(hex)[2], oklab(hex)[1]) * 180) / Math.PI;
  const deltaE = (a, b) => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i]));
  const fromLch = (L, C, h) => {
    const [a, b] = [C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  };
  const toHex = (linear) =>
    '#' +
    linear
      .map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055))
      .map((c) =>
        Math.round(Math.min(1, Math.max(0, c)) * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('');
  const { ink, paperDeep, paper, pine, pineOn, signal, signalInk, signalBar } = palette;
  const LEVELS = ['optimal', 'good', 'caution', 'poor'];

  // The device draws tailwind.config.js; this section measures its mirror in
  // src/constants/theme.ts. The standing mirror rule keeps the two equal — and
  // for the four cuts this section exists to measure, it is checked, not
  // trusted.
  const config = readFileSync(new URL('../tailwind.config.js', import.meta.url), 'utf8');
  LEVELS.every((l) => new RegExp(`${l}: \\{[^}]*\\bbar: '${signalBar[l]}'`).test(config))
    ? ok('the four bar cuts measured here are the four tailwind.config.js draws')
    : bad('tailwind.config.js and src/constants/theme.ts disagree on a bar cut');

  const measured = [
    ['fill · optimal — signal-optimal-bar on the rail', ratio(signalBar.optimal, paperDeep), 4.59],
    ['fill · good — signal-good-bar on the rail', ratio(signalBar.good, paperDeep), 4.59],
    ['fill · caution — signal-caution-bar on the rail', ratio(signalBar.caution, paperDeep), 4.56],
    ['fill · poor — signal-poor-bar on the rail', ratio(signalBar.poor, paperDeep), 4.56],
    ['fill · optimal on the paper', ratio(signalBar.optimal, paper), 6.5],
    ['fill · good on the paper', ratio(signalBar.good, paper), 6.5],
    ['fill · caution on the paper', ratio(signalBar.caution, paper), 6.46],
    ['fill · poor on the paper', ratio(signalBar.poor, paper), 6.46],
    ['fill · unknown — the metadata ink on the rail', ratio(signalInk.unknown, paperDeep), 4.21],
    ['fill · unknown on the paper', ratio(signalInk.unknown, paper), 5.97],
    ['the terminator — ink on the bare rail, where it matters', ratio(ink, paperDeep), 9.74],
    ['the rail itself on the sheet (a ground, not a mark)', ratio(paperDeep, paper), 1.42],
    ['the run past the mark — pine on the sheet it runs over', ratio(pine, paper), 8.31],
    ['the + — pine-on knocked out of the run', ratio(pineOn, pine), 9.52],
    ['the run against the terminator it follows (why the gutter)', ratio(pine, ink), 1.66],
  ];
  for (const [name, value, expected] of measured) {
    Math.abs(value - expected) < 0.005
      ? ok(`${name}: ${value.toFixed(2)}:1`)
      : bad(name, `${value.toFixed(3)} — the docblock in app/nutrition.tsx says ${expected}`);
  }

  // WHY FB3 LEFT BOTH OLDER CUTS. The swatch is under WCAG's own 3:1 on this
  // rail for optimal (2.36) and caution (2.10) — FB2's finding, still true — and
  // the ink cut FB2 took instead is a TEXT cut: three of its four states sit
  // under 4.5:1 here. Both asserted, so a palette move that changes either
  // invites the revisit.
  LEVELS.some((l) => ratio(signal[l], paperDeep) < 3)
    ? ok(
        `the SWATCH cut fails on this rail (${LEVELS.map((l) => ratio(signal[l], paperDeep).toFixed(2)).join(' / ')})`
      )
    : bad('the swatch cut now clears 3:1 on paperDeep; revisit which cut the fill should take');
  LEVELS.filter((l) => ratio(signalInk[l], paperDeep) < 4.5).length === 3
    ? ok(
        `FB2’s INK cut is short of 4.5:1 in three of four states (${LEVELS.map((l) => ratio(signalInk[l], paperDeep).toFixed(2)).join(' / ')})`
      )
    : bad('the ink cuts moved on paperDeep; revisit why the fill left them');

  // THE FLOOR FB3 SETS — 4.5:1 for every graded fill, stronger than the 3:1 FB2
  // asserted. `unknown` stays under it deliberately, and under every graded
  // fill: a withheld verdict must never out-shout a stated one. It still clears
  // the non-text floor.
  LEVELS.every((l) => ratio(signalBar[l], paperDeep) >= 4.5)
    ? ok('every graded fill clears 4.5:1 against the rail')
    : bad('a graded fill is under 4.5:1 on the rail');
  const quietestGraded = Math.min(...LEVELS.map((l) => ratio(signalBar[l], paperDeep)));
  const unknownOnRail = ratio(signalInk.unknown, paperDeep);
  unknownOnRail >= 3 && unknownOnRail < quietestGraded
    ? ok('unknown clears 3:1 and sits below every graded fill — absence is quieter than a verdict')
    : bad('the unknown fill', unknownOnRail.toFixed(2));

  // MORE POP, measured: at every state the bar cut carries more chroma than the
  // ink cut it replaces, on the swatch's own hue to within a degree — the same
  // colour, more of it, not a new colour.
  const turn = (a, b) => Math.abs(((hue(a) - hue(b) + 540) % 360) - 180);
  LEVELS.every(
    (l) => chroma(signalBar[l]) > chroma(signalInk[l]) && turn(signalBar[l], signal[l]) <= 1
  )
    ? ok(
        `more chroma than the ink cut at every hue (${LEVELS.map((l) => `+${((chroma(signalBar[l]) / chroma(signalInk[l]) - 1) * 100).toFixed(0)}%`).join(' / ')}), each within 1° of its swatch`
      )
    : bad('a bar cut lost chroma or left its hue');

  // THE CEILING. "There is no more pop available here" is a claim, so it is
  // measured: along each swatch's own hue, the most chroma any in-gamut colour
  // reaches while still clearing 4.5:1 on the rail — and every bar cut is within
  // 2% of it. (One may sit a hair above: its hue is within a degree of the
  // swatch's, not exactly on it.) A cut that drifts duller, or a rail that starts
  // allowing more, fails here.
  const ceiling = (h) => {
    let best = 0;
    for (let L = 0.2; L <= 0.8; L += 0.001) {
      let [lo, hi] = [0, 0.4];
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (fromLch(L, mid, h).every((c) => c >= -1e-4 && c <= 1 + 1e-4)) lo = mid;
        else hi = mid;
      }
      if (lo > best && ratio(toHex(fromLch(L, lo, h)), paperDeep) >= 4.5) best = lo;
    }
    return best;
  };
  const share = LEVELS.map((l) => chroma(signalBar[l]) / ceiling(hue(signal[l])));
  share.every((s) => s >= 0.98)
    ? ok(
        `each bar cut is at the chroma ceiling its hue has at 4.5:1 (${share.map((s) => `${(s * 100).toFixed(0)}%`).join(' / ')})`
      )
    : bad('a bar cut is below its ceiling', share.map((s) => s.toFixed(3)).join(' / '));

  // DISTINGUISHABLE FROM ITS NEIGHBOURS — the other half of FB3's target. Every
  // pair of graded fills is at least five JNDs apart (ΔEok ≥ 0.10), which the
  // ink cuts were not (caution–poor, 0.091); and all six pairs moved apart.
  const pairs = LEVELS.flatMap((a, i) => LEVELS.slice(i + 1).map((b) => [a, b]));
  const nearest = Math.min(...pairs.map(([a, b]) => deltaE(signalBar[a], signalBar[b])));
  const nearestBefore = Math.min(...pairs.map(([a, b]) => deltaE(signalInk[a], signalInk[b])));
  nearest >= 0.1 && nearestBefore < 0.1
    ? ok(
        `nearest pair of fills ΔEok ${nearest.toFixed(3)}, the ink cuts’ ${nearestBefore.toFixed(3)} — five JNDs, which FB2 did not reach`
      )
    : bad('neighbour separation', `${nearest.toFixed(3)} vs ${nearestBefore.toFixed(3)}`);
  pairs.every(([a, b]) => deltaE(signalBar[a], signalBar[b]) > deltaE(signalInk[a], signalInk[b]))
    ? ok('all six pairs of fills are further apart than FB2’s')
    : bad('a pair of fills moved closer together');

  // WHAT COLOUR DOES NOT CARRY, asserted so it cannot be quietly forgotten. The
  // four cuts sit AT the floor — that is where the chroma is — so they are
  // near-isoluminant against one ground, and to anyone not perceiving hue they
  // are one dark mark: the readiness-strip finding, which is why the cell's label
  // word and the figures above the bar stay put.
  const spread = Math.max(...LEVELS.map((l) => ratio(signalBar[l], paperDeep)));
  const floor = Math.min(...LEVELS.map((l) => ratio(signalBar[l], paperDeep)));
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
  const onFill = LEVELS.map((l) => ratio(ink, signalBar[l]));
  Math.min(...onFill) > 1.66 && Math.max(...onFill) < 3
    ? ok(
        `the terminator on a graded fill: ${Math.min(...onFill).toFixed(2)}–${Math.max(...onFill).toFixed(2)}:1 — under the floor, and better than C6’s 1.66:1`
      )
    : bad('terminator-on-fill', onFill.map((r) => r.toFixed(2)).join(' / '));

  // THE RUN AND THE FILL IT FOLLOWS (FB3). Pine sits at the fills' luminance
  // (1.28–1.29:1 against every one) and nearest `good` in colour — closer than
  // any two fills come — so a hue change alone would not keep the two marks
  // apart. The 2px gutter of sheet does: paper clears 4.5:1 against the run and
  // against every fill, so both edges of the gap are crisp.
  const runOnFill = LEVELS.map((l) => ratio(pine, signalBar[l]));
  const closest = Math.min(...LEVELS.map((l) => deltaE(pine, signalBar[l])));
  Math.max(...runOnFill) < 1.5 &&
  closest < nearest &&
  [pine, ...LEVELS.map((l) => signalBar[l])].every((c) => ratio(paper, c) >= 4.5)
    ? ok(
        `the run against a fill: ${Math.min(...runOnFill).toFixed(2)}–${Math.max(...runOnFill).toFixed(2)}:1, nearest ΔEok ${closest.toFixed(3)} — so a gutter of sheet, ≥ 4.5:1 against both, keeps them two marks`
      )
    : bad(
        'run/fill separation',
        `${runOnFill.map((r) => r.toFixed(2)).join(' / ')} · ${closest.toFixed(3)}`
      );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
