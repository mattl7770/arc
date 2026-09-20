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
 * They carry no `edit`, no `create` and no `remove` in this commit. Writes
 * arrive in Phase 2, after a week of the read path on a device — the audit's
 * whole reason for splitting the phases is that a model's *selection* behaviour
 * over a domain enum is the thing the headless suite cannot measure.
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
import { shiftISODate, todayISODate } from '@/lib/db/date';
import { listExercises, resolveExerciseByName } from '@/lib/db/repositories/exercise-catalog';
import { searchFoods, listFavoriteFoods, listRecentFoods } from '@/lib/db/repositories/foods';
import { listLabReports } from '@/lib/db/repositories/labs';
import { listEntriesOn } from '@/lib/db/repositories/logs';
import { listTemplateItems, listTemplates } from '@/lib/db/repositories/meal-templates';
import {
  dayFiberTotal,
  dayMicroTotals,
  listMealItems,
  listTodayMeals,
} from '@/lib/db/repositories/nutrition';
import { protocolAdherence } from '@/lib/db/repositories/protocol-adherence';
import { getProtocolBySlug, listProtocols, listVersions } from '@/lib/db/repositories/protocols';
import { listPhotoAnalyses, listProgressPhotos } from '@/lib/db/repositories/progress-photos';
import { listReports } from '@/lib/db/repositories/reports';
import { getRoutine, listRoutines } from '@/lib/db/repositories/routines';
import {
  e1rmSeries,
  exerciseSessionTops,
  personalRecords,
} from '@/lib/db/repositories/training-stats';
import { getPreferences } from '@/lib/db/repositories/user';
import { listWaterEntries } from '@/lib/db/repositories/water';

import type { CoachDomainEntry, DomainField, DomainReadArgs } from './types';

/** A read-only field: declared so `query_records` can name it, never patchable. */
const ro = (note: string): DomainField => ({
  editable: false,
  note,
  parse: () => {
    throw new Error('read-only');
  },
});

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
    name: ro('what it was'),
    time: ro('HH:MM'),
    kcal: ro('calories'),
    protein_g: ro('protein, grams'),
    carbs_g: ro('carbohydrate, grams'),
    fat_g: ro('fat, grams'),
    notes: ro('free text'),
  },
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
    name: ro('the food'),
    brand: ro('brand, if any'),
    kcal_per_100: ro('calories per 100 of the basis below — NEVER per serving'),
    protein_g_per_100: ro('protein per 100 of the basis below'),
    basis: ro('what the per-100 numbers are of — g or ml'),
    is_favorite: ro('starred on the Eat tab'),
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
    name: ro('what the user calls it'),
    kcal: ro('the template total'),
    protein_g: ro('the template total'),
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
    ml: ro('the amount, canonical millilitres'),
    date: ro('the day, YYYY-MM-DD'),
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
    name: ro('what the user calls it'),
    exercises: ro('its movements, in order, with target sets and rep range'),
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
