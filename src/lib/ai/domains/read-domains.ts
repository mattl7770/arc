/**
 * The READ-ONLY domains — everything `query_records` can look at that no
 * bespoke tool reaches (docs/coach-domains.md; the spike's Phase 1, commit B).
 *
 * ## What these are, and what they are not
 *
 * Every one of them is a repository function a SCREEN already calls. Nothing
 * here queries a table the app does not query the same way, and nothing here
 * invents an aggregate — `protocolAdherence` and `personalRecords` are the
 * Protocols and Exercise screens' own computations, read rather than
 * re-derived, so the Coach and the screen can never disagree about a number.
 *
 * They landed read-only in commit B and several gained `edit` and `remove` in
 * commit C, after the device week the audit's phase split exists for — a
 * model's SELECTION behaviour over a domain enum is the one thing the headless
 * suite cannot measure, so the read path shipped first and alone.
 *
 * Every domain here that holds rows says whether they can be removed, and a
 * removal follows the screens exactly as a read does (the owner's 2026-09-23
 * call): `hard` calls the function the screen's own delete calls, and
 * `refuse` names where the row lives when no screen deletes it.
 *
 * ## `list` vs `compute`, and why the distinction is in the type
 *
 * A `list` domain returns ROWS, each carrying the id a write would address. A
 * `compute` domain returns ONE typed object with no ids at all, because what it
 * describes is not stored anywhere: adherence is a ratio over a window,
 * per-exercise stats are a fold over every set ever logged, and a day's
 * micronutrients are a sum over item snapshots. Handing those back as a "list"
 * is how a model ends up asking for the third row of a number, so the type
 * refuses it: a compute domain REQUIRES an `id` and ignores `limit`.
 *
 * ## Photos and reports are here by owner call (2026-09-19)
 *
 * The 2026-08-12 decision withheld both, and its argument was prefix cost — a
 * bespoke photo tool against a catalog that is most of the cached prompt. A
 * registry key costs ~3 tokens, so that argument no longer applies, and the
 * owner reopened it: both are READ-ONLY here. **No pixels and no writes.** What
 * the model gets is what it could be asked about: a photo's date, pose and the
 * text of any stored reading; a report's kind, period and when it was made.
 */
import { clockFromISO, shiftISODate, todayISODate } from '@/lib/db/date';
import {
  archiveExercise,
  getExercise,
  listExercises,
  resolveExerciseByName,
} from '@/lib/db/repositories/exercise-catalog';
import {
  deleteFood,
  getFood,
  searchFoods,
  listFavoriteFoods,
  listRecentFoods,
  setFoodFavorite,
  updateFood,
} from '@/lib/db/repositories/foods';
import { listLabReports } from '@/lib/db/repositories/labs';
import { listEntriesOn } from '@/lib/db/repositories/logs';
import {
  deleteTemplate,
  getTemplate,
  listTemplateItems,
  listTemplates,
  renameTemplate,
} from '@/lib/db/repositories/meal-templates';
import {
  dayFiberTotal,
  dayMicroTotals,
  getMeal,
  listMealItems,
  listTodayMeals,
  mealPhotoFileNames,
  updateMealMeta,
  updateMealTime,
} from '@/lib/db/repositories/nutrition';
import { protocolAdherence } from '@/lib/db/repositories/protocol-adherence';
import { getProtocolBySlug, listProtocols, listVersions } from '@/lib/db/repositories/protocols';
import { listPhotoAnalyses, listProgressPhotos } from '@/lib/db/repositories/progress-photos';
import { listReports } from '@/lib/db/repositories/reports';
import {
  deleteRoutine,
  getRoutine,
  listRoutines,
  updateRoutine,
} from '@/lib/db/repositories/routines';
import {
  e1rmSeries,
  exerciseSessionTops,
  personalRecords,
} from '@/lib/db/repositories/training-stats';
import { getPreferences } from '@/lib/db/repositories/user';
import {
  deleteWaterEntry,
  listWaterEntries,
  updateWaterEntry,
  type WaterEntry,
} from '@/lib/db/repositories/water';
import type { RoutineDetail } from '@/lib/exercise/types';
import { deleteMealWithPhotos } from '@/lib/media/meal-photo-store';
import { fmtAmount, fmtInt, macroLine } from '@/lib/nutrition/format';
import type { FoodRow, MealRow } from '@/lib/nutrition/types';

import {
  describeEdit,
  listed,
  numberField,
  plural,
  textField,
  timeField,
  dateField,
  boolField,
  enumField,
  type CoachDomainEntry,
  type DomainField,
  type DomainReadArgs,
} from './types';

/** A read-only field: declared so `query_records` can name it, never patchable. */
const ro = (note: string): DomainField => ({
  editable: false,
  note,
  parse: () => {
    throw new Error('read-only');
  },
});

/** "812 kcal · P 60g · C 90g · F 20g" — the Eat screens' own macro line. */
function macrosOf(row: {
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}): string {
  const parts = [row.kcal === null ? null : `${fmtInt(row.kcal)} kcal`, macroLine(row)];
  const shown = parts.filter((p): p is string => p !== null);
  return shown.length > 0 ? shown.join(' · ') : 'no figures recorded';
}

/** Every logical day in [from, to], capped at `limit`, newest first. */
function daysIn(args: DomainReadArgs, fallbackDays: number): string[] {
  const end = args.to ?? todayISODate(args.now);
  const start = args.from ?? shiftISODate(end, -(fallbackDays - 1));
  const out: string[] = [];
  for (let d = end; d >= start && out.length < args.limit; d = shiftISODate(d, -1)) out.push(d);
  return out;
}

// --- meals -------------------------------------------------------------------

const mealsDomain: CoachDomainEntry = {
  key: 'meals',
  label: 'meal',
  fields: {
    name: textField('what it was'),
    date: dateField('the day it was eaten', 'past'),
    time: timeField('HH:MM, or null for untimed'),
    notes: textField('free text'),
    // The MACROS are read-only through this path, and that is parity rather
    // than caution: the Eat screen has no field for them either. A free-form
    // meal's totals come from `log_meal`, and an ITEMIZED meal's are the sum of
    // its item snapshots — overwriting that sum would leave the total and the
    // items saying different things, with nothing on screen to say which is
    // right. Correcting an itemized meal means correcting an item, which is the
    // item editor's job on its own screen.
    kcal: ro('calories — from log_meal, or summed from the items'),
    protein_g: ro('protein, grams'),
    carbs_g: ro('carbohydrate, grams'),
    fat_g: ro('fat, grams'),
  },
  resolve: (db, id) => {
    const meal = getMeal(db, id);
    if (!meal) {
      throw new Error(`No meal with id ${id}. Find it with query_records { domain: "meals" }.`);
    }
    return {
      id: meal.id,
      name: meal.name,
      values: {
        name: meal.name,
        date: meal.date,
        time: meal.time,
        notes: meal.notes ?? null,
      },
      raw: meal,
    };
  },
  summarize: ({ row, patch }) => describeEdit('meal', row!, patch),
  // READ-MODIFY-WRITE. `updateMealMeta` rewrites name, time AND notes in one
  // statement, so a literal patch of `name` alone would clear the notes and
  // blank the clock behind a card that said "name X → Y". The row supplies
  // everything the patch does not.
  edit: (db, row, patch) => {
    const next = { ...row.values, ...patch } as {
      name: string;
      date: string;
      time: string | null;
      notes: string | null;
    };
    if (next.name.trim() === '') {
      throw new Error('A meal keeps its name — "" is not one.');
    }
    updateMealMeta(db, row.id, { name: next.name, time: next.time, notes: next.notes });
    if (next.date !== row.values.date) {
      updateMealTime(db, row.id, { date: next.date, time: next.time });
    }
  },
  // HARD, through the meal screen's own delete (app/meal-detail.tsx). A record
  // of a day, and removable anyway: the user can delete it by hand, so the
  // Coach may too — behind a card naming its day, its figures, its items and
  // its photos (the owner's 2026-09-23 call, reversing the 2026-09-19 undo-only
  // rule). `deleteMealWithPhotos`, never bare `deleteMeal`: the CASCADE takes
  // the photo ROWS and leaves the files, which is why the screen routes through
  // it. The items, the photos and a pending estimate are the meal's own parts.
  remove: {
    mode: 'hard',
    gone: (db, row) => {
      const meal = row.raw as MealRow;
      // What the meal screen draws as lines: a composite's parts sit under
      // their header, so the header is the line and its parts are not.
      const lines = listMealItems(db, row.id).filter((i) => i.parent_item_id === null).length;
      const photos = mealPhotoFileNames(db, row.id).length;
      return [
        meal.time ? `${meal.date} ${meal.time}` : meal.date,
        macrosOf(meal),
        lines > 0 ? plural(lines, 'item') : null,
        photos > 0 ? plural(photos, 'photo') : null,
      ]
        .filter((p): p is string => p !== null)
        .join(' · ');
    },
    run: (db, row) => deleteMealWithPhotos(db, row.id),
  },
  // The line the owner's Q2(b) answer SUPERSEDED (ADR 2026-09-19). It is
  // replaced by a narrower one, not simply dropped: a logged metric and a
  // capture still have no repository edit path and no screen delete, so the
  // Coach still cannot touch them — by parity, not by policy.
  retires: [
    'editing or deleting anything already logged — a meal, workout, metric, capture (its screen in Eat, Train or Data)',
  ],
  // The gap this closes: `get_nutrition_summary` gives TOTALS and
  // `get_today_snapshot` gives today. Nothing could list a past day's meals, or
  // any day's ITEMS — so "what was in yesterday's lunch" had no answer at all.
  read: {
    kind: 'list',
    run: (db, args) =>
      daysIn(args, 1).flatMap((date) =>
        listTodayMeals(db, date).map((m) => ({
          id: m.id,
          date,
          time: m.time,
          name: m.name,
          kcal: m.kcal,
          protein_g: m.protein_g,
          carbs_g: m.carbs_g,
          fat_g: m.fat_g,
          ...(m.notes ? { notes: m.notes } : {}),
          // Items only when ONE meal was asked for: a week of meals with every
          // item is a payload nobody asked for.
          ...(args.id === m.id
            ? {
                items: listMealItems(db, m.id).map((i) => ({
                  id: i.id,
                  name: i.name,
                  amount: i.amount,
                  kcal: i.kcal,
                  protein_g: i.protein_g,
                })),
              }
            : {}),
        }))
      ),
  },
  createVia: 'log_meal',
};

// --- the food catalog --------------------------------------------------------

const foodCatalogDomain: CoachDomainEntry = {
  key: 'food_catalog',
  label: 'catalog food',
  fields: {
    name: textField('the food', { requiredOnCreate: true }),
    brand: textField('brand, or null'),
    kcal_per_100: numberField('calories per 100 of the basis — NEVER per serving', { min: 0 }),
    protein_g_per_100: numberField('protein per 100 of the basis', { min: 0 }),
    carbs_g_per_100: numberField('carbohydrate per 100 of the basis', { min: 0 }),
    fat_g_per_100: numberField('fat per 100 of the basis', { min: 0 }),
    basis: enumField(['g', 'ml'], 'what the per-100 numbers are of'),
    is_favorite: boolField('starred on the Eat tab'),
  },
  resolve: (db, id) => {
    const food = getFood(db, id);
    if (!food) {
      throw new Error(
        `No catalog food with id ${id}. Find it with query_records { domain: "food_catalog" }.`
      );
    }
    return {
      id: food.id,
      name: food.brand ? `${food.name} (${food.brand})` : food.name,
      values: {
        name: food.name,
        brand: food.brand,
        kcal_per_100: food.kcal_100g,
        protein_g_per_100: food.protein_g_100g,
        carbs_g_per_100: food.carbs_g_100g,
        fat_g_per_100: food.fat_g_100g,
        basis: food.basis,
        is_favorite: food.is_favorite === 1,
      },
      raw: food,
    };
  },
  summarize: ({ row, patch }) => describeEdit('food', row!, patch),
  // READ-MODIFY-WRITE, and here it is not optional: `updateFood` takes the
  // WHOLE food, so a literal patch of `kcal_per_100` alone would null the
  // barcode, the serving and every other macro.
  edit: (db, row, patch) => {
    const food = row.raw as {
      name: string;
      brand: string | null;
      barcode: string | null;
      serving_name: string | null;
      serving_amount: number | null;
      kcal_100g: number | null;
      protein_g_100g: number | null;
      carbs_g_100g: number | null;
      fat_g_100g: number | null;
      fiber_g_100g: number | null;
      micros: string | null;
      basis: 'g' | 'ml';
    };
    const next = { ...row.values, ...patch } as Record<string, unknown>;
    if (typeof next.name !== 'string' || next.name.trim() === '') {
      throw new Error('A food keeps its name — "" is not one.');
    }
    if ('is_favorite' in patch) setFoodFavorite(db, row.id, patch.is_favorite === true);
    updateFood(db, row.id, {
      name: next.name,
      brand: (next.brand as string | null) ?? null,
      barcode: food.barcode,
      serving_name: food.serving_name,
      serving_amount: food.serving_amount,
      kcal_100g: (next.kcal_per_100 as number | null) ?? null,
      protein_g_100g: (next.protein_g_per_100 as number | null) ?? null,
      carbs_g_100g: (next.carbs_g_per_100 as number | null) ?? null,
      fat_g_100g: (next.fat_g_per_100 as number | null) ?? null,
      fiber_g_100g: food.fiber_g_100g,
      micros: food.micros,
      basis: next.basis as 'g' | 'ml',
    });
  },
  // HARD, and safely so: `meal_items.food_id` is ON DELETE SET NULL (0014) and
  // every logged item carries its own macro snapshot, so eating history
  // survives catalog churn untouched. The same holds for recipe ingredients
  // (0031) and template items (0018).
  //
  // THE ONE REMOVAL AHEAD OF THE SCREENS. No screen deletes a catalog food —
  // `deleteFood` has no caller in app/ — and this policy was set on 2026-09-19,
  // before deletion followed the screens. It is kept because it strands
  // nothing; whether a screen gains the delete or the Coach loses it is the
  // owner's call, recorded in the 2026-09-23 ADR rather than decided here.
  remove: {
    mode: 'hard',
    gone: (_db, row) => {
      const food = row.raw as FoodRow;
      return `per 100 ${food.basis}: ${macrosOf({
        kcal: food.kcal_100g,
        protein_g: food.protein_g_100g,
        carbs_g: food.carbs_g_100g,
        fat_g: food.fat_g_100g,
      })}`;
    },
    run: (db, row) => deleteFood(db, row.id),
  },
  read: {
    kind: 'list',
    run: (db, args) => {
      // `searchFoods` returns nothing for a blank query by design (the screen
      // shows recents instead), so the no-query call mirrors the screen rather
      // than returning an empty list that reads as "you have no foods".
      const rows = args.query
        ? searchFoods(db, args.query, args.limit)
        : [...listFavoriteFoods(db), ...listRecentFoods(db, args.limit).map((r) => r.food)].slice(
            0,
            args.limit
          );
      return rows.map((f) => ({
        id: f.id,
        name: f.name,
        brand: f.brand,
        // NAMED FOR WHAT THEY ARE. Every catalog number is per 100 of the
        // food's own basis, and a field called `kcal` invites a model to read
        // it as a portion — which would quietly triple a chicken breast.
        kcal_per_100: f.kcal_100g,
        protein_g_per_100: f.protein_g_100g,
        basis: f.basis,
        ...(f.serving_name ? { serving: f.serving_name, servingAmount: f.serving_amount } : {}),
        ...(f.is_favorite === 1 ? { is_favorite: true } : {}),
      }));
    },
  },
  // The Eat blind spot, closed by this domain together with `micronutrients`
  // and `meal_templates` — the three things that one line named.
  retires: ['the food catalog, per-item micronutrients and saved meal templates (Eat)'],
};

// --- meal templates ----------------------------------------------------------

const mealTemplatesDomain: CoachDomainEntry = {
  key: 'meal_templates',
  label: 'meal template',
  fields: {
    name: textField('what the user calls it'),
    notes: textField('free text, or null'),
    kcal: ro('the template total, summed from its items'),
    protein_g: ro('the template total, summed from its items'),
  },
  resolve: (db, id) => {
    const template = getTemplate(db, id);
    if (!template) {
      throw new Error(
        `No meal template with id ${id}. Find it with query_records { domain: "meal_templates" }.`
      );
    }
    return {
      id: template.id,
      name: template.name,
      values: { name: template.name, notes: template.notes ?? null },
      raw: template,
    };
  },
  summarize: ({ row, patch }) => describeEdit('meal template', row!, patch),
  // `renameTemplate` rewrites name AND notes, so the row supplies the half the
  // patch omits.
  edit: (db, row, patch) => {
    const next = { ...row.values, ...patch } as { name: string; notes: string | null };
    if (next.name.trim() === '') throw new Error('A template keeps its name — "" is not one.');
    renameTemplate(db, row.id, { name: next.name, notes: next.notes });
  },
  // HARD: a template is a stamp, never a record of a day. Logged meals copied
  // its items as snapshots and are untouched by its removal. The figures are
  // the templates screen's own sums (`listTemplates`), not a second addition.
  remove: {
    mode: 'hard',
    gone: (db, row) => {
      const summary = listTemplates(db).find((t) => t.template.id === row.id);
      if (!summary) return plural(0, 'item');
      return `${plural(summary.itemCount, 'item')} · ${macrosOf(summary)}`;
    },
    run: (db, row) => deleteTemplate(db, row.id),
  },
  read: {
    kind: 'list',
    run: (db, args) =>
      listTemplates(db)
        .filter(
          (t) => !args.query || t.template.name.toLowerCase().includes(args.query.toLowerCase())
        )
        .slice(0, args.limit)
        .map((t) => ({
          id: t.template.id,
          name: t.template.name,
          itemCount: t.itemCount,
          kcal: t.kcal,
          protein_g: t.protein_g,
          ...(args.id === t.template.id
            ? {
                items: listTemplateItems(db, t.template.id).map((i) => ({
                  name: i.name,
                  amount: i.amount,
                  unit: i.unit,
                })),
              }
            : {}),
        })),
  },
};

// --- micronutrients ----------------------------------------------------------

const micronutrientsDomain: CoachDomainEntry = {
  key: 'micronutrients',
  label: 'micronutrient total',
  fields: {
    date: ro('the day, YYYY-MM-DD — pass it as "id"'),
  },
  // COMPUTE: a sum over item snapshots, with no row and no id of its own. An
  // EMPTY object is the honest answer for a free-form day — only itemized or
  // catalog-linked meals carry micros — and it must never read as zeroes.
  read: {
    kind: 'compute',
    needs: 'a day, YYYY-MM-DD',
    run: (db, args) => {
      const micros = dayMicroTotals(db, args.id);
      return {
        date: args.id,
        fiber_g: dayFiberTotal(db, args.id),
        micros,
        ...(Object.keys(micros).length === 0
          ? {
              note: 'No micronutrient data for this day. Only itemized or catalog-linked meals carry micros — this is an absence, not a set of zeroes.',
            }
          : {}),
      };
    },
  },
};

// --- water entries -----------------------------------------------------------

const waterDomain: CoachDomainEntry = {
  key: 'water',
  label: 'water entry',
  fields: {
    ml: numberField('the amount, canonical millilitres', { min: 1 }),
    date: ro('the day it was logged on'),
  },
  resolve: (db, id, context) => {
    // Water lives in `wearable_data`, so a "water entry" is only ever found by
    // scanning the days it could be on. Today and the 30 before it is the span
    // a correction plausibly reaches back over.
    const today = todayISODate(context.now);
    for (let i = 0; i < 31; i++) {
      const date = shiftISODate(today, -i);
      const hit = listWaterEntries(db, date).find((e) => e.id === id);
      if (hit) {
        if (!hit.editable) {
          // §3.5: a DEVICE-ingested row is the Health upsert's, not the
          // Coach's. The predicate is `water.ts`'s own.
          throw new Error(
            'That water entry came from a device, not from a manual log. ' +
              'Device rows are Apple Health’s record and are not editable here.'
          );
        }
        return {
          id: hit.id,
          name: `${hit.ml} ml on ${date}`,
          values: { ml: hit.ml, date },
          raw: hit,
        };
      }
    }
    throw new Error(
      `No water entry with id ${id} in the last 31 days. ` +
        'Find it with query_records { domain: "water", from: "YYYY-MM-DD" }.'
    );
  },
  summarize: ({ row, patch }) => describeEdit('water entry', row!, patch),
  edit: (db, row, patch) => {
    if (!updateWaterEntry(db, row.id, patch.ml as number)) {
      throw new Error('That water entry could not be updated — it may be a device row.');
    }
  },
  // HARD, and narrowly: `deleteWaterEntry` refuses a device row itself, and no
  // foreign key points at a manual wearable row, so nothing is stranded. The
  // water screen's own Remove, and the Log tab's quick-add undo, both call it.
  remove: {
    mode: 'hard',
    // The name carries the canonical ml and the day; the card adds the clock
    // it was logged at and, for an oz user, the figure as they entered it.
    gone: (db, row) => {
      const entry = row.raw as WaterEntry;
      const volume = getPreferences(db).units.volume;
      const asEntered = volume === 'oz' ? `${fmtAmount(entry.ml, 'ml', 'oz')}, ` : '';
      return `${asEntered}logged at ${clockFromISO(entry.at)}`;
    },
    run: (db, row) => {
      if (!deleteWaterEntry(db, row.id)) {
        throw new Error('That water entry could not be deleted — it may be a device row.');
      }
    },
  },
  // `get_metric_series water` gives the day TOTALS. This is the individual
  // entries, which is what an edit or an undo needs an id for.
  read: {
    kind: 'list',
    run: (db, args) => {
      const units = getPreferences(db).units;
      return daysIn(args, 1).flatMap((date) =>
        listWaterEntries(db, date)
          .slice(0, args.limit)
          .map((e) => ({
            id: e.id,
            date,
            at: e.at,
            ml: e.ml,
            ...(units.volume === 'oz' ? { oz: Math.round((e.ml / 29.5735) * 10) / 10 } : {}),
            // A DEVICE-INGESTED water row is not the Coach's to touch (§3.5 of
            // the spike), and the predicate is the water screen's own.
            ...(e.editable ? {} : { editable: false, source: e.source }),
          }))
      );
    },
  },
  createVia: 'log_metric',
};

// --- captures (the Log feed, by day) -----------------------------------------

const capturesDomain: CoachDomainEntry = {
  key: 'captures',
  label: 'logged entry',
  fields: {
    title: ro('the line as the Log tab shows it'),
    category: ro('Note, Supplement, Medication, Therapy, Symptom or a metric'),
  },
  // The by-day read the app never had: the log tools have always backdated and
  // nothing could read a past day back (`listEntriesOn`, repositories/logs.ts).
  read: {
    kind: 'list',
    run: (db, args) => {
      const units = getPreferences(db).units;
      return daysIn(args, 1).flatMap((date) =>
        listEntriesOn(db, date, units)
          .slice(0, args.limit)
          .map((e) => ({ id: e.id, date, time: e.time, title: e.title, category: e.category }))
      );
    },
  },
  createVia: 'log_capture',
  // PARITY, and it refuses: the Log tab draws a capture and offers no delete
  // (repositories/logs.ts has none to call), so neither does the Coach.
  remove: {
    mode: 'refuse',
    because:
      'A logged capture has no delete on any screen, so it has none here either. ' +
      'It stays on its day in the Log tab.',
  },
};

// --- protocol adherence ------------------------------------------------------

const adherenceDomain: CoachDomainEntry = {
  key: 'protocol_adherence',
  label: 'protocol adherence',
  fields: {
    protocol: ro('the protocol slug — pass it as "id"'),
    from: ro('window start, YYYY-MM-DD (default: 28 days back)'),
    to: ro('window end, YYYY-MM-DD (default: today)'),
  },
  // COMPUTE, and the per-item record's `itemId` is NULLABLE on purpose — a row
  // written before items carried ids has none, and inventing one would make a
  // renamed item look like two. The Protocols screen's own computation.
  read: {
    kind: 'compute',
    needs: 'a protocol slug from get_protocols',
    run: (db, args) => {
      const protocol = getProtocolBySlug(db, args.id);
      if (!protocol) {
        throw new Error(
          `No protocol with slug ${args.id}. Call get_protocols first. ` +
            `Known: ${listProtocols(db)
              .map((p) => p.slug)
              .join(', ')}.`
        );
      }
      const to = args.to ?? todayISODate(args.now);
      const from = args.from ?? shiftISODate(to, -27);
      // The repository's own `from`/`to` wins — it reports the window it
      // actually measured, which is null when there was nothing to measure.
      return { protocol: protocol.slug, ...protocolAdherence(db, protocol.id, from, to) };
    },
  },
};

// --- per-exercise stats ------------------------------------------------------

const exerciseStatsDomain: CoachDomainEntry = {
  key: 'exercise_stats',
  label: 'exercise record',
  fields: {
    exercise: ro('the movement — pass its catalog id or its exact name as "id"'),
  },
  // COMPUTE: a fold over every set ever logged for one movement. The Exercise
  // screen's own `personalRecords` / `e1rmSeries`, read rather than re-derived.
  read: {
    kind: 'compute',
    needs: 'an exercise id or its exact name, from the exercise_catalog domain',
    run: (db, args) => {
      const id = resolveExerciseByName(db, args.id) ?? args.id;
      const records = personalRecords(db, id);
      const tops = exerciseSessionTops(db, id, Math.min(args.limit, 12));
      if (tops.length === 0) {
        return { exercise: args.id, note: 'No sets logged for this movement.' };
      }
      return {
        exercise: args.id,
        records,
        e1rmSeries: e1rmSeries(db, id, Math.min(args.limit, 12)),
        recentTopSets: tops,
      };
    },
  },
};

// --- the exercise catalog ----------------------------------------------------

const exerciseCatalogDomain: CoachDomainEntry = {
  key: 'exercise_catalog',
  label: 'catalog exercise',
  fields: {
    name: ro('the movement'),
    equipment: ro('barbell, dumbbell, machine, cable, bodyweight, …'),
    primaryMuscles: ro('what it trains'),
    isCustom: ro('written by the user or the Coach rather than seeded'),
    status: enumField(['archived'], 'archived = retire it from the catalog; its history stays'),
  },
  resolve: (db, id) => {
    const exercise = getExercise(db, resolveExerciseByName(db, id) ?? id);
    if (!exercise) {
      throw new Error(
        `No catalog exercise ${id}. Find it with query_records { domain: "exercise_catalog" }.`
      );
    }
    return {
      id: exercise.id,
      name: exercise.name,
      values: { status: 'active' },
      raw: exercise,
    };
  },
  summarize: ({ row }) => `Retire exercise "${row!.name}" from the catalog`,
  edit: (db, row) => {
    archiveExercise(db, row.id);
  },
  // ARCHIVE ONLY, and the reason is a CASCADE. `routine_exercises.exercise_id`
  // is ON DELETE CASCADE (0012), so a hard delete would silently empty every
  // saved workout that used the movement. `archiveExercise` takes it out of the
  // catalog and leaves every set, every PR and every routine line intact — the
  // difference between retiring a movement and erasing the training that used
  // it. No screen deletes one either, so the domain REFUSES removal and the
  // retirement is a status patch.
  remove: {
    mode: 'refuse',
    because:
      'No screen deletes a catalog exercise: saved-workout lines cascade from it. ' +
      'Retire it with edit_record { status: "archived" }, which keeps every set and record.',
  },
  read: {
    kind: 'list',
    run: (db, args) =>
      listExercises(db, { search: args.query })
        .slice(0, args.limit)
        .map((e) => ({
          id: e.id,
          name: e.name,
          equipment: e.equipment,
          primaryMuscles: e.primaryMuscles,
          ...(e.isCustom ? { isCustom: true } : {}),
        })),
  },
};

// --- saved workouts ----------------------------------------------------------

const savedWorkoutsDomain: CoachDomainEntry = {
  key: 'saved_workouts',
  label: 'saved workout',
  fields: {
    name: textField('what the user calls it'),
    exercises: ro('its movements, in order — edited on the Train screen'),
  },
  resolve: (db, id) => {
    const routine = getRoutine(db, id);
    if (!routine) {
      throw new Error(
        `No saved workout with id ${id}. Find it with query_records { domain: "saved_workouts" }.`
      );
    }
    return { id: routine.id, name: routine.name, values: { name: routine.name }, raw: routine };
  },
  summarize: ({ row, patch }) => describeEdit('saved workout', row!, patch),
  // RENAME ONLY, and the lines are read-only for the `replaceWorkout` reason:
  // `updateRoutine` replaces every line, so a patch that did not restate the
  // whole list would empty the routine behind a card that said "name X → Y".
  // Re-sending the lines it already has is the read-modify-write.
  edit: (db, row, patch) => {
    const routine = row.raw as {
      name: string;
      notes: string | null;
      exercises: {
        exerciseId: string;
        targetSets: number;
        repLow: number | null;
        repHigh: number | null;
        restSec: number | null;
      }[];
    };
    const name = (patch.name as string | null) ?? routine.name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('A saved workout keeps its name — "" is not one.');
    }
    updateRoutine(db, row.id, {
      name,
      notes: routine.notes,
      exercises: routine.exercises.map((x) => ({
        exerciseId: x.exerciseId,
        targetSets: x.targetSets,
        repLow: x.repLow,
        repHigh: x.repHigh,
        restSec: x.restSec,
      })),
    });
  },
  // HARD: a routine is a plan, not a record of a day, and `workouts.routine_id`
  // is ON DELETE SET NULL (0013) — the sessions performed from it keep every
  // set and simply stop naming a template that no longer exists.
  remove: {
    mode: 'hard',
    gone: (_db, row) => {
      const routine = row.raw as RoutineDetail;
      const sets = routine.exercises.reduce((n, x) => n + x.targetSets, 0);
      const names = routine.exercises.map((x) => x.exerciseName);
      return `${plural(sets, 'set')} of ${plural(names.length, 'exercise')}${
        names.length > 0 ? `: ${listed(names)}` : ''
      }`;
    },
    run: (db, row) => deleteRoutine(db, row.id),
  },
  // "Saved workouts (Train)" was a CANNOT line. The parked Modes revamp assumes
  // the Coach can adjust the workout plan itself, and no tool reached a saved
  // workout at all — this is the read half of closing that.
  read: {
    kind: 'list',
    run: (db, args) =>
      listRoutines(db)
        .filter((r) => !args.query || r.name.toLowerCase().includes(args.query.toLowerCase()))
        .slice(0, args.limit)
        .map((r) => ({
          id: r.id,
          name: r.name,
          exerciseCount: r.exerciseCount,
          totalSets: r.totalSets,
          lastStartedAt: r.lastStartedAt,
          ...(args.id === r.id
            ? {
                exercises: (getRoutine(db, r.id)?.exercises ?? []).map((x) => ({
                  name: x.exerciseName,
                  targetSets: x.targetSets,
                  repLow: x.repLow,
                  repHigh: x.repHigh,
                })),
              }
            : {}),
        })),
  },
  retires: ['saved workouts (Train)'],
};

// --- protocol versions -------------------------------------------------------

const protocolVersionsDomain: CoachDomainEntry = {
  key: 'protocol_versions',
  label: 'protocol version',
  fields: {
    protocol: ro('the protocol slug — pass it as "id"'),
    versionNumber: ro('which version'),
    changeNotes: ro('why it changed'),
  },
  // The history `get_protocols` cannot show: it returns the LIVE version only,
  // and "what did this look like in August" had no answer. Immutable rows, so
  // there is nothing here to edit — a past version is restored on its screen.
  remove: {
    mode: 'refuse',
    because:
      'A protocol version is the immutable record a past day was lived under, and no screen ' +
      'deletes one: Protocols › the protocol › Versions restores an old one, never removes it.',
  },
  read: {
    kind: 'list',
    run: (db, args) => {
      if (!args.id) {
        throw new Error('Pass "id": the protocol slug whose history you want (get_protocols).');
      }
      const protocol = getProtocolBySlug(db, args.id);
      if (!protocol) throw new Error(`No protocol with slug ${args.id}. Call get_protocols first.`);
      return listVersions(db, protocol.id)
        .slice(0, args.limit)
        .map((v) => ({
          id: v.id,
          versionNumber: v.versionNumber,
          createdAt: v.createdAt,
          createdBy: v.createdBy,
          changeNotes: v.changeNotes,
          itemCount: v.itemCount,
        }));
    },
  },
};

// --- lab reports -------------------------------------------------------------

const labReportsDomain: CoachDomainEntry = {
  key: 'lab_reports',
  label: 'lab report',
  fields: {
    collectedOn: ro('the draw date'),
    lab: ro('who ran it'),
    resultCount: ro('how many markers it carried'),
  },
  // The report LIST, not the PDF. `get_biomarkers` answers "what is my ApoB";
  // this answers "when was I last drawn, and how much did that panel cover".
  // `deleteLabReport` exists and no screen calls it — so, by parity, the Coach
  // does not either. Its results would CASCADE with it (0001).
  remove: {
    mode: 'refuse',
    because:
      'No screen deletes a lab report, and its results would go with it. ' +
      'It stays in Data › Labs.',
  },
  read: {
    kind: 'list',
    run: (db, args) =>
      listLabReports(db)
        .slice(0, args.limit)
        .map((r) => ({
          id: r.id,
          collectedOn: r.collectedAt,
          lab: r.labName,
          resultCount: r.resultCount,
        })),
  },
  // The old line named the files AND the import together; the list being
  // readable makes the whole of it false, so it is replaced by a narrower one
  // rather than kept and left half-wrong.
  retires: ['lab report files and the PDF import (Data, Labs)'],
};

// --- progress photos (metadata + stored readings; NO pixels) -----------------

const progressPhotosDomain: CoachDomainEntry = {
  key: 'progress_photos',
  label: 'progress photo',
  fields: {
    taken_on: ro('the date of the shutter'),
    date_origin: ro('where that date came from — EXIF, the user, or the import day'),
    pose: ro('front, side or back'),
    readings: ro('the summary text of any reading the user already asked for'),
  },
  // Owner call, 2026-09-19, reopening the 2026-08-12 one. READ-ONLY, and the
  // pixels are not here and never will be: what the model gets is the dates,
  // the poses and the TEXT of any reading the user already asked for on the
  // screen. A reading is only ever generated there, on demand.
  //
  // HELD BELOW PARITY. The photo screen does delete (with its files), and the
  // 2026-09-23 parity rule would reach it — but Q4(a) opened these as
  // read-only, "no pixels, no writes", and the owner's deletion call was about
  // logged rows. Opening it is this one entry: `hard` over
  // `deleteProgressPhotoWithFiles`, the screen's own function.
  remove: {
    mode: 'refuse',
    because:
      'Progress photos are read-only to you by the owner’s call: no pixels, no writes. ' +
      'The user deletes one on Data › Progress photos.',
  },
  read: {
    kind: 'list',
    run: (db, args) =>
      listProgressPhotos(db)
        .slice(0, args.limit)
        .map((p) => {
          const analyses = listPhotoAnalyses(db, p.id);
          return {
            id: p.id,
            taken_on: p.taken_on,
            // Where the date came from. EXIF or the user's own correction is a
            // fact about the photo; the import day is a fact about the import,
            // and the two must never read alike (0036).
            date_origin: p.date_origin,
            pose: p.pose,
            ...(analyses.length > 0
              ? {
                  readings: analyses.map((a) => ({
                    createdAt: a.created_at,
                    comparePhotoId: a.compare_photo_id,
                    summary: a.summary,
                  })),
                }
              : {}),
          };
        }),
  },
  retires: ['progress photos and their AI readings (Data › Progress photos)'],
};

// --- generated reports -------------------------------------------------------

const reportsDomain: CoachDomainEntry = {
  key: 'reports',
  label: 'report',
  fields: {
    kind: ro('self-review or doctor pack'),
    period: ro('the window it covers'),
    generatedAt: ro('when it was made'),
    hasNarrative: ro('whether the user attached a Coach read to it'),
  },
  // The LIST only. Generation ends in a share sheet the model cannot drive and
  // a preview the doctrine requires anyway, and no model prose ever enters a
  // doctor pack (docs/reports-subapp.md). What this fixes is narrower and real:
  // the Coach denying the feature exists when asked about a past report.
  // HELD BELOW PARITY for the same Q4(a) reason as photos: the report screen
  // deletes one (`deleteReport`), and opening it is this one entry.
  remove: {
    mode: 'refuse',
    because:
      'Generated reports are read-only to you by the owner’s call. ' +
      'The user deletes one on Data › Reports.',
  },
  read: {
    kind: 'list',
    run: (db, args) =>
      listReports(db)
        .slice(0, args.limit)
        .map((r) => ({
          id: r.id,
          kind: r.reportType,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          generatedAt: r.generatedAt,
          hasNarrative: r.hasNarrative,
        })),
  },
  retires: ['generated reports and doctor packs (Data › Reports)'],
};

export const READ_DOMAINS: CoachDomainEntry[] = [
  mealsDomain,
  foodCatalogDomain,
  mealTemplatesDomain,
  micronutrientsDomain,
  waterDomain,
  capturesDomain,
  adherenceDomain,
  exerciseStatsDomain,
  exerciseCatalogDomain,
  savedWorkoutsDomain,
  protocolVersionsDomain,
  labReportsDomain,
  progressPhotosDomain,
  reportsDomain,
];
