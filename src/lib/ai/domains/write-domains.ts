/**
 * The domains Phase 2 makes WRITABLE that no read domain already covered —
 * workouts, recipes, the grocery list, screenings, appointments, muscle
 * anchors, protocol identity and policy, and Settings
 * (docs/coach-domains.md §10; the spike's Phase 2, commit C).
 *
 * Everything here obeys the same three rules as the rest of the registry, and
 * two of them do real work in this file specifically:
 *
 * **Read-modify-write, always.** `replaceWorkout` deletes every set and
 * re-inserts its argument. `updateRoutine`, `updateFood`, `updateScreening` and
 * `updateAppointment` all take the WHOLE row. A literal patch through any of
 * them would erase whatever it did not restate, behind a card that named one
 * field. Every `edit` below loads the row first and re-sends what the patch
 * leaves alone.
 *
 * **`content` is not a field of the protocol domain.** A protocol's document is
 * versioned like code and `update_protocol` takes the COMPLETE new set; putting
 * it behind a flat patch would be the same destruction one layer up, and the
 * bespoke tool is better at it anyway. What is here is the protocol's IDENTITY
 * (name, type, description) and its POLICY (active, carry-over, check-off mode,
 * the phase-clock anchor) — none of which `update_protocol` can reach.
 *
 * **A removal is the screen's removal.** Every `remove` here is `hard` over the
 * function that domain's screen deletes with — a logged session and a whole
 * protocol included (the owner's 2026-09-23 call) — and its `gone` prints what
 * the card must show before the gate: the row's date, its figures, and what
 * goes with it.
 *
 * **Settings is five calls, not a table.** The owner's Q3 answer (2026-09-19)
 * put profile, units, the day boundary, goal direction and the water target
 * within reach, gated like any write. The API key, the app lock, the Health
 * sync toggle and backups are NOT here and are asserted absent — they are the
 * security boundary, not a preference.
 */
import { clockFromISO, formatLocalDate, todayISODate } from '@/lib/db/date';
import { deleteWorkout, getWorkoutDetail, replaceWorkout } from '@/lib/db/repositories/exercise';
import { rederiveMissionFromToday } from '@/lib/db/repositories/mission-generate';
import {
  checkGroceryItem,
  getGroceryItem,
  listStaples,
  removeGroceryItem,
  setStaple,
  uncheckGroceryItem,
  updateGroceryItem,
} from '@/lib/db/repositories/grocery';
import {
  clearMuscleAnchor,
  listMuscleAnchors,
  setMuscleAnchor,
} from '@/lib/db/repositories/muscle-anchors';
import {
  deleteProtocol,
  getCurrentVersion,
  getProtocol,
  getProtocolBySlug,
  listProtocols,
  listVersions,
  reviseProtocol,
  setActive,
} from '@/lib/db/repositories/protocols';
import {
  deleteRecipe,
  getRecipe,
  listIngredients,
  parseSteps,
  setRecipeFavorite,
  updateRecipe,
} from '@/lib/db/repositories/recipes';
import {
  addAppointment,
  addScreening,
  deleteAppointment,
  deleteScreening,
  getAppointment,
  getScreening,
  setAppointmentStatus,
  updateAppointment,
  updateScreening,
} from '@/lib/db/repositories/screenings';
import {
  getDayStartsAtPreference,
  getGoalDirection,
  getOrCreateUser,
  getPreferences,
  getWaterTarget,
  setDayStartsAtPreference,
  setGoalDirection,
  setUnitPreference,
  setWaterTarget,
  updateProfile,
} from '@/lib/db/repositories/user';
import type { ProtocolRow } from '@/lib/db/types';
import type { GroceryItemRow } from '@/lib/grocery/types';
import { allItems, parseProtocolContent } from '@/lib/protocols/content';
import type { AppointmentRow, ScreeningRow } from '@/lib/screenings/types';
import { GOAL_DIRECTIONS } from '@/lib/user/types';

import {
  boolField,
  dateField,
  describeEdit,
  enumField,
  listed,
  numberField,
  plural,
  textField,
  type CoachDomainEntry,
  type DomainField,
} from './types';

/** A read-only field: named so a refusal can say what it is, never patchable. */
const ro = (note: string): DomainField => ({
  editable: false,
  note,
  parse: () => {
    throw new Error('read-only');
  },
});

// --- workouts ----------------------------------------------------------------

const WORKOUT_KINDS = ['strength', 'cardio', 'mobility', 'other'] as const;

const workoutsDomain: CoachDomainEntry = {
  key: 'workouts',
  label: 'workout',
  fields: {
    kind: enumField([...WORKOUT_KINDS], 'strength, cardio, mobility or other'),
    date: dateField('the day it was performed', 'past'),
    duration_min: numberField('minutes, or null', { min: 0 }),
    notes: textField('free text, or null'),
    away: boolField('performed away from home — excluded from the home baseline'),
    sets: ro('the sets — corrected on the session screen, never through a patch'),
  },
  read: { kind: 'bespoke', via: 'get_training_summary' },
  createVia: 'log_workout',
  resolve: (db, id) => {
    const workout = getWorkoutDetail(db, id);
    if (!workout) {
      throw new Error(`No workout with id ${id}. Find it with get_training_summary.`);
    }
    return {
      id: workout.id,
      name: `${workout.kind} on ${workout.date}`,
      values: {
        kind: workout.kind,
        date: workout.date,
        duration_min: workout.durationMin,
        notes: workout.notes,
        away: workout.away,
      },
      raw: workout,
    };
  },
  summarize: ({ row, patch }) => describeEdit('workout', row!, patch),
  /**
   * THE C10 CLASS, and the sharpest instance of it in the registry.
   *
   * `replaceWorkout` DELETES every set and re-inserts its argument. A literal
   * patch of `duration_min` would therefore empty the session — every rep,
   * every load, every PR the engine computes from those rows — behind a card
   * that said "duration 45 → 50". So the sets are re-sent from the row, every
   * time, and `sets` is not a field the model can send at all.
   */
  edit: (db, row, patch) => {
    const workout = row.raw as ReturnType<typeof getWorkoutDetail> & object;
    const next = { ...row.values, ...patch } as {
      kind: string;
      date: string;
      duration_min: number | null;
      notes: string | null;
      away: boolean;
    };
    replaceWorkout(
      db,
      row.id,
      {
        kind: next.kind as (typeof WORKOUT_KINDS)[number],
        date: next.date,
        durationMin: next.duration_min,
        notes: next.notes,
        away: next.away,
        routineId: workout.routineId,
      },
      workout.sets.map((s) => ({
        exercise: s.exercise,
        exerciseId: s.exerciseId,
        reps: s.reps,
        weightKg: s.weightKg,
        rpe: s.rpe,
        setType: s.setType,
        durationSec: s.durationSec,
        distanceM: s.distanceM,
        supersetGroup: s.supersetGroup,
      }))
    );
  },
  // HARD, through the session screen's own Delete (app/workout-live.tsx). A
  // record of a day, removable because the user can remove it by hand — the
  // owner's 2026-09-23 call, reversing the 2026-09-19 undo-only rule. The sets
  // CASCADE with it, which is the right cascade (a set has no meaning without
  // its session), so the card counts them and names the movements: that is
  // exactly what goes.
  remove: {
    mode: 'hard',
    gone: (_db, row) => {
      const workout = row.raw as NonNullable<ReturnType<typeof getWorkoutDetail>>;
      const movements = [...new Set(workout.sets.map((s) => s.exercise))];
      return [
        workout.durationMin === null ? null : `${Math.round(workout.durationMin)} min`,
        workout.sets.length === 0
          ? 'no sets'
          : `${plural(workout.sets.length, 'set')}: ${listed(movements)}`,
      ]
        .filter((p): p is string => p !== null)
        .join(' · ');
    },
    run: (db, row) => deleteWorkout(db, row.id),
  },
};

// --- recipes -----------------------------------------------------------------

const recipesDomain: CoachDomainEntry = {
  key: 'recipes',
  label: 'recipe',
  fields: {
    title: textField('what it is called'),
    servings: numberField('how many it makes, or null', { min: 0 }),
    notes: textField('free text, or null'),
    is_favorite: boolField('starred in the book'),
    ingredients: ro('its lines — edited in the recipe editor, which resolves foods'),
  },
  read: { kind: 'bespoke', via: 'get_recipes' },
  createVia: 'save_recipe',
  resolve: (db, id) => {
    const recipe = getRecipe(db, id);
    if (!recipe) throw new Error(`No recipe with id ${id}. Call get_recipes first.`);
    return {
      id: recipe.id,
      name: recipe.title,
      values: {
        title: recipe.title,
        servings: recipe.servings,
        notes: recipe.notes,
        is_favorite: recipe.is_favorite === 1,
      },
      raw: recipe,
    };
  },
  summarize: ({ row, patch }) => describeEdit('recipe', row!, patch),
  edit: (db, row, patch) => {
    const recipe = row.raw as {
      title: string;
      servings: number;
      notes: string | null;
      steps: string;
      total_weight_g: number | null;
      prep_min: number | null;
      cook_min: number | null;
    };
    const next = { ...row.values, ...patch } as Record<string, unknown>;
    if (typeof next.title !== 'string' || next.title.trim() === '') {
      throw new Error('A recipe keeps its title — "" is not one.');
    }
    if ('is_favorite' in patch) setRecipeFavorite(db, row.id, patch.is_favorite === true);
    // `updateRecipe` takes the whole header, so the untouched half rides along
    // from the row rather than being nulled.
    updateRecipe(db, row.id, {
      title: next.title,
      // A recipe's servings are its DENOMINATOR: every per-serving figure is
      // divided by it, so `null` is not a value the column can take and a
      // patch that clears it keeps what was there.
      servings: (next.servings as number | null) ?? recipe.servings,
      notes: (next.notes as string | null) ?? null,
      // `steps` is stored as JSON text and taken as an array — parse it back
      // rather than re-sending the wrong shape, which would stringify a string
      // and quietly double-encode the method.
      steps: parseSteps(recipe.steps),
      total_weight_g: recipe.total_weight_g,
      prep_min: recipe.prep_min,
      cook_min: recipe.cook_min,
    });
  },
  // HARD: a recipe is an object, not a day. `meals.recipe_id` (0031) and
  // `grocery_items.recipe_id` (0032) are both ON DELETE SET NULL, so every meal
  // cooked from it keeps its macros and simply stops naming a recipe that is
  // gone. Its ingredient lines are its own parts, and go with it.
  remove: {
    mode: 'hard',
    gone: (db, row) => {
      const recipe = row.raw as { servings: number };
      return `serves ${recipe.servings} · ${plural(listIngredients(db, row.id).length, 'ingredient')}`;
    },
    run: (db, row) => deleteRecipe(db, row.id),
  },
};

// --- the grocery list --------------------------------------------------------

const groceryDomain: CoachDomainEntry = {
  key: 'grocery',
  label: 'grocery item',
  fields: {
    name: textField('what it is'),
    qty: textField('the quantity as text ("2 L"), or null'),
    status: enumField(['open', 'checked'], 'checked = in the cart; open = back on the list'),
    staple: boolField('a standing staple — offered again next shop'),
  },
  read: { kind: 'bespoke', via: 'get_grocery_list' },
  createVia: 'add_grocery_items',
  resolve: (db, id) => {
    const item = getGroceryItem(db, id);
    if (!item) throw new Error(`No grocery item with id ${id}. Call get_grocery_list first.`);
    return {
      id: item.id,
      name: item.name,
      values: {
        name: item.name,
        qty: item.qty_text,
        status: item.checked_at === null ? 'open' : 'checked',
        staple: listStaples(db).some((s) => s.name_norm === item.name_norm),
      },
      raw: item,
    };
  },
  summarize: ({ row, patch }) => describeEdit('grocery item', row!, patch),
  // UNCHECKING is the half `complete_grocery_items` could never do: checking
  // off is batched and one-way there, and "no, I did not get the milk" had no
  // path at all.
  edit: (db, row, patch) => {
    if ('status' in patch) {
      if (patch.status === 'checked') checkGroceryItem(db, row.id);
      else uncheckGroceryItem(db, row.id);
    }
    if ('name' in patch || 'qty' in patch) {
      const next = { ...row.values, ...patch } as { name: string; qty: string | null };
      if (next.name.trim() === '') throw new Error('A grocery item keeps its name.');
      updateGroceryItem(db, row.id, { name: next.name, qty_text: next.qty });
    }
    if ('staple' in patch) setStaple(db, (patch.name as string) ?? row.name, patch.staple === true);
  },
  // HARD: a shopping line is a working list, not a record of a day, and the
  // user removes one with a swipe on the same screen.
  remove: {
    mode: 'hard',
    gone: (_db, row) => {
      const item = row.raw as GroceryItemRow;
      return [item.qty_text, item.checked_at === null ? 'on the list' : 'in the cart']
        .filter((p): p is string => p !== null)
        .join(' · ');
    },
    run: (db, row) => removeGroceryItem(db, row.id),
  },
};

// --- screenings --------------------------------------------------------------

const SCREENING_CATEGORIES = [
  'imaging',
  'bloodwork',
  'exam',
  'dental',
  'vision',
  'derm',
  'cardio',
  'other',
] as const;

const screeningsDomain: CoachDomainEntry = {
  key: 'screenings',
  label: 'screening',
  fields: {
    name: textField('what it is', { requiredOnCreate: true }),
    category: enumField([...SCREENING_CATEGORIES], 'which kind of screening'),
    notes: textField('free text, or null'),
    next_due: dateField('when it is next owed — a doctor-told date overrides the cadence'),
    // THE CLINICAL DECISION STAYS THE USER'S (owner call, 2026-08-12, kept at
    // Q5(a) 2026-09-19). How often a colonoscopy is owed is a decision made
    // with a physician, not a field a model may set in passing. Untracking is
    // the affordance instead: `next_due: null` is not reachable here, and the
    // cadence is edited on its own screen.
    interval_months: ro('the cadence, in months — a clinical decision, set on the screen'),
    last_completed: ro('use log_screening_done, which rolls the next date forward'),
  },
  read: { kind: 'bespoke', via: 'get_screenings' },
  resolve: (db, id) => {
    const screening = getScreening(db, id);
    if (!screening) throw new Error(`No screening with id ${id}. Call get_screenings first.`);
    return {
      id: screening.id,
      name: screening.name,
      values: {
        name: screening.name,
        category: screening.category,
        notes: screening.notes,
        next_due: screening.next_due,
      },
      raw: screening,
    };
  },
  summarize: ({ op, row, patch }) =>
    op === 'create'
      ? `Track screening "${patch.name as string}"${patch.next_due ? ` — next due ${patch.next_due as string}` : ''}`
      : describeEdit('screening', row!, patch),
  create: (db, patch) => {
    if (typeof patch.name !== 'string') throw new Error('A screening needs a "name".');
    return addScreening(db, {
      name: patch.name,
      category: (patch.category as (typeof SCREENING_CATEGORIES)[number]) ?? 'other',
      // NO cadence from the Coach: a screening it adds is one-off until the
      // user sets the interval on the screen, which is where that decision
      // belongs.
      intervalMonths: null,
      nextDue: (patch.next_due as string | null) ?? null,
      notes: (patch.notes as string | null) ?? null,
    });
  },
  // `updateScreening` takes the whole row, so the cadence and the last
  // completion ride along from the row — a rename must never silently untrack.
  edit: (db, row, patch) => {
    const screening = row.raw as {
      interval_months: number | null;
      last_completed: string | null;
    };
    const next = { ...row.values, ...patch } as Record<string, unknown>;
    if (typeof next.name !== 'string' || next.name.trim() === '') {
      throw new Error('A screening keeps its name — "" is not one.');
    }
    updateScreening(db, row.id, {
      name: next.name,
      category: next.category as (typeof SCREENING_CATEGORIES)[number],
      intervalMonths: screening.interval_months,
      lastCompleted: screening.last_completed,
      nextDue: (next.next_due as string | null) ?? null,
      notes: (next.notes as string | null) ?? null,
    });
  },
  // HARD, and it is the UNTRACK the owner asked for: `appointments.screening_id`
  // is ON DELETE SET NULL (0007), so a booked appointment survives and simply
  // stops naming a screening the user no longer tracks — which the card says,
  // as the screen's own confirmation does.
  remove: {
    mode: 'hard',
    gone: (_db, row) => {
      const screening = row.raw as ScreeningRow;
      return [
        screening.interval_months === null
          ? 'no cadence'
          : `every ${plural(screening.interval_months, 'month')}`,
        screening.next_due === null ? null : `next due ${screening.next_due}`,
        screening.last_completed === null ? null : `last done ${screening.last_completed}`,
        'its appointments stay',
      ]
        .filter((p): p is string => p !== null)
        .join(' · ');
    },
    run: (db, row) => deleteScreening(db, row.id),
  },
  // `update_protocol` has created a protocol since §8.2, so this line was
  // already half false before the screenings half of it landed here.
  retires: ['creating a protocol or a screening from scratch'],
};

// --- appointments ------------------------------------------------------------

const appointmentsDomain: CoachDomainEntry = {
  key: 'appointments',
  label: 'appointment',
  fields: {
    title: textField('what it is for', { requiredOnCreate: true }),
    provider: textField('who with, or null'),
    scheduled_at: textField('the ISO-8601 UTC instant', { requiredOnCreate: true }),
    location: textField('where, or null'),
    notes: textField('free text, or null'),
    status: enumField(['scheduled', 'completed', 'cancelled'], 'where the booking stands'),
  },
  read: { kind: 'bespoke', via: 'get_screenings' },
  resolve: (db, id) => {
    const appointment = getAppointment(db, id);
    if (!appointment) {
      throw new Error(`No appointment with id ${id}. Call get_screenings first.`);
    }
    return {
      id: appointment.id,
      name: appointment.title,
      values: {
        title: appointment.title,
        provider: appointment.provider,
        scheduled_at: appointment.scheduled_at,
        location: appointment.location,
        notes: appointment.notes,
        status: appointment.status,
      },
      raw: appointment,
    };
  },
  summarize: ({ op, row, patch }) =>
    op === 'create'
      ? `Book "${patch.title as string}" for ${patch.scheduled_at as string}`
      : describeEdit('appointment', row!, patch),
  create: (db, patch) => {
    if (typeof patch.title !== 'string' || typeof patch.scheduled_at !== 'string') {
      throw new Error('An appointment needs a "title" and a "scheduled_at" instant.');
    }
    return addAppointment(db, {
      title: patch.title,
      provider: (patch.provider as string | null) ?? null,
      scheduledAt: patch.scheduled_at,
      location: (patch.location as string | null) ?? null,
      notes: (patch.notes as string | null) ?? null,
    });
  },
  edit: (db, row, patch) => {
    const appointment = row.raw as { screening_id: string | null };
    const next = { ...row.values, ...patch } as Record<string, unknown>;
    if ('status' in patch) {
      setAppointmentStatus(db, row.id, patch.status as 'scheduled' | 'completed' | 'cancelled');
    }
    if (Object.keys(patch).some((k) => k !== 'status')) {
      updateAppointment(db, row.id, {
        title: next.title as string,
        provider: (next.provider as string | null) ?? null,
        scheduledAt: next.scheduled_at as string,
        location: (next.location as string | null) ?? null,
        screeningId: appointment.screening_id,
        notes: (next.notes as string | null) ?? null,
      });
    }
  },
  // HARD: the appointment form deletes one the same way. The card prints the
  // booking at the user's own clock — the stored instant is UTC.
  remove: {
    mode: 'hard',
    gone: (_db, row) => {
      const appointment = row.raw as AppointmentRow;
      const at = appointment.scheduled_at;
      return [
        `${formatLocalDate(new Date(at))} ${clockFromISO(at)}`,
        appointment.provider === null ? null : `with ${appointment.provider}`,
        appointment.status,
      ]
        .filter((p): p is string => p !== null)
        .join(' · ');
    },
    run: (db, row) => deleteAppointment(db, row.id),
  },
  retires: ['booking, moving or cancelling an appointment (Data, Screenings)'],
};

// --- muscle anchors ----------------------------------------------------------

const musclesDomain: CoachDomainEntry = {
  key: 'muscle_anchors',
  label: 'muscle anchor',
  fields: {
    freshness: numberField('0–100; the engine reads from here instead of the log', {
      min: 0,
      max: 100,
    }),
  },
  read: {
    kind: 'list',
    run: (db) =>
      listMuscleAnchors(db).map((a) => ({
        id: a.muscle,
        muscle: a.muscle,
        freshness: a.freshness,
      })),
  },
  resolve: (db, id) => {
    const anchor = listMuscleAnchors(db).find((a) => a.muscle === id);
    return {
      id,
      name: id,
      values: { freshness: anchor?.freshness ?? null },
      raw: anchor ?? null,
    };
  },
  summarize: ({ row, patch }) => describeEdit('muscle anchor', row!, patch),
  edit: (db, row, patch) => {
    if (patch.freshness === null) clearMuscleAnchor(db, row.id as never);
    else setMuscleAnchor(db, row.id as never, patch.freshness as number);
  },
  // HARD, and it is a CLEAR rather than a destruction: an anchor overrides the
  // engine's own reading, so removing one restores the derived figure.
  remove: {
    mode: 'hard',
    gone: (_db, row) => {
      // `resolve` answers for any muscle, anchored or not, so a clear of
      // nothing is refused here rather than costing an Approve tap.
      if (row.values.freshness === null) {
        throw new Error(`There is no anchor on ${row.name}, so there is nothing to clear.`);
      }
      return `freshness ${String(row.values.freshness)}; the engine’s own reading returns`;
    },
    run: (db, row) => clearMuscleAnchor(db, row.id as never),
  },
};

// --- protocol identity and policy (never `content`) --------------------------

const PROTOCOL_TYPES = [
  'daily_routine',
  'supplement_stack',
  'meal_template',
  'training_block',
  'therapy_protocol',
  'sleep_protocol',
  'other',
] as const;

const protocolsDomain: CoachDomainEntry = {
  key: 'protocols',
  label: 'protocol',
  fields: {
    name: textField('what the user calls it'),
    type: enumField([...PROTOCOL_TYPES], 'which kind of protocol'),
    description: textField('free text, or null'),
    is_active: boolField('paused protocols plan nothing and keep every version'),
    carry_over: boolField('a missed item stays owed tomorrow'),
    checkoff_mode: enumField(
      ['strict', 'adjusting'],
      'whether an every-N clock re-bases on the day it was actually ticked'
    ),
    started_on: dateField('the phase clock’s anchor'),
    // THE DOCUMENT IS NOT A FIELD. Protocol content is versioned like code and
    // `update_protocol` takes the COMPLETE new set; a flat patch of it would
    // drop every item it did not restate, which is the whole class of
    // destruction this registry's read-modify-write rule exists to prevent —
    // and the bespoke tool validates phases and cadences besides.
    content: ro('the phases and items — use update_protocol, which takes the complete set'),
  },
  read: { kind: 'bespoke', via: 'get_protocols' },
  createVia: 'update_protocol',
  resolve: (db, id) => {
    const protocol = getProtocolBySlug(db, id) ?? getProtocol(db, id);
    if (!protocol) {
      throw new Error(
        `No protocol ${id}. Call get_protocols first. ` +
          `Known: ${listProtocols(db)
            .map((p) => p.slug)
            .join(', ')}.`
      );
    }
    return {
      id: protocol.id,
      name: protocol.name,
      values: {
        name: protocol.name,
        type: protocol.type,
        description: protocol.description,
        is_active: protocol.is_active === 1,
        carry_over: protocol.carry_over === 1,
        checkoff_mode: protocol.checkoff_mode,
        started_on: protocol.started_on,
      },
      raw: protocol,
    };
  },
  summarize: ({ row, patch }) => describeEdit('protocol', row!, patch),
  edit: (db, row, patch, context) => {
    const next = { ...row.values, ...patch } as Record<string, unknown>;
    if (typeof next.name !== 'string' || next.name.trim() === '') {
      throw new Error('A protocol keeps its name — "" is not one.');
    }
    // `reviseProtocol` with `content: null` is the EDITOR'S OWN SAVE minus the
    // document: identity, the active flag and the execution policy in one
    // transaction, no new version minted. A policy is not a new plan, and the
    // whole object is re-sent from the row so a rename cannot flip a flag.
    reviseProtocol(db, row.id, {
      name: next.name,
      type: next.type as (typeof PROTOCOL_TYPES)[number],
      description: (next.description as string | null) ?? null,
      active: next.is_active === true,
      content: null,
      carryOver: next.carry_over as boolean,
      checkoffMode: next.checkoff_mode as 'strict' | 'adjusting',
      ...('started_on' in patch ? { startedOn: patch.started_on as string } : {}),
    });
    // Resuming a paused protocol ANCHORS an unanchored phase clock to today,
    // which `reviseProtocol` does not do — that is `setActive`'s, and it is the
    // difference between resuming a titration and restarting it.
    if (patch.is_active === true && row.values.is_active !== true) {
      setActive(db, row.id, true, todayISODate(context.now));
    }
    // The write reaches TODAY, exactly as the Settings sheet's save does
    // (app/protocol-settings.tsx): a pause takes this protocol's untouched rows
    // off today, a resume puts them back, a carry-over or check-off-mode change
    // re-plans the day, and anything already done or skipped is preserved by
    // the same diff. Without it a Coach pause took effect tomorrow, silently —
    // the exact defect the rethink fixed for the sheet. The reminder re-sync
    // follows every Coach write already (app/(tabs)/coach.tsx).
    rederiveMissionFromToday(db, todayISODate(context.now));
  },
  // HARD, through Protocols › settings' own Delete (app/protocol-settings.tsx),
  // and the same two steps it runs. This REFUSED until 2026-09-23 on the
  // ground that a deletion was "a decision made on the screen that shows what
  // it would take with it" — so the card now shows it, in the screen's own
  // words: the versions go (they CASCADE, 0001), and logged days keep their
  // entries, unlinked (`log_entries.protocol_id` is SET NULL, which is what
  // keeps CLAUDE.md §9's never-destroy-execution-history true). Pausing is
  // still `is_active: false`; which of the two the user meant is judgment.
  remove: {
    mode: 'hard',
    gone: (db, row) => {
      const protocol = row.raw as ProtocolRow;
      const versions = listVersions(db, protocol.id).length;
      const items = allItems(
        parseProtocolContent(getCurrentVersion(db, protocol.id)?.content ?? null)
      ).length;
      return (
        `${protocol.is_active === 1 ? 'active' : 'paused'}, ${plural(items, 'item')}; ` +
        `its ${plural(versions, 'version')} ${versions === 1 ? 'goes' : 'go'} with it, ` +
        'and logged days keep their entries, unlinked'
      );
    },
    run: (db, row, context) => {
      deleteProtocol(db, row.id);
      // The screen's second step: a deleted protocol must stop putting rows on
      // today. (Its third, the notification resync, is the Coach tab's own
      // after every turn — app/(tabs)/coach.tsx `onTurnComplete`.)
      rederiveMissionFromToday(db, todayISODate(context.now));
    },
  },
};

// --- Settings (the owner's Q3(a): all five, gated like any write) ------------

const settingsDomain: CoachDomainEntry = {
  key: 'settings',
  label: 'setting',
  fields: {
    date_of_birth: dateField('YYYY-MM-DD — every reference range depends on it', 'past'),
    biological_sex: enumField(['male', 'female'], 'used by reference ranges, not identity'),
    weight_unit: enumField(['lb', 'kg'], 'how weights are shown'),
    volume_unit: enumField(['oz', 'ml'], 'how volumes are shown'),
    length_unit: enumField(['in', 'cm'], 'how lengths are shown'),
    distance_unit: enumField(['mi', 'km'], 'how distances are shown'),
    temperature_unit: enumField(['F', 'C'], 'how temperatures are shown'),
    day_starts_at: textField('"HH:MM" — when the user’s day rolls over'),
    goal_direction: enumField([...GOAL_DIRECTIONS], 'cut, maintain or gain'),
    water_target_ml: numberField('the daily hydration goal in ml, or null to clear', { min: 1 }),
  },
  // ONE ROW, and it is the settings themselves. `id` is ignored: there is
  // nothing to pick between.
  read: {
    kind: 'list',
    run: (db) => {
      const user = getOrCreateUser(db);
      const units = getPreferences(db).units;
      return [
        {
          id: 'settings',
          date_of_birth: user.date_of_birth,
          biological_sex: user.biological_sex,
          weight_unit: units.weight,
          volume_unit: units.volume,
          length_unit: units.length,
          distance_unit: units.distance,
          temperature_unit: units.temperature,
          day_starts_at: getDayStartsAtPreference(db),
          goal_direction: getGoalDirection(db),
          water_target_ml: getWaterTarget(db),
        },
      ];
    },
  },
  resolve: (db) => {
    const user = getOrCreateUser(db);
    const units = getPreferences(db).units;
    return {
      id: 'settings',
      name: 'Settings',
      values: {
        date_of_birth: user.date_of_birth,
        biological_sex: user.biological_sex,
        weight_unit: units.weight,
        volume_unit: units.volume,
        length_unit: units.length,
        distance_unit: units.distance,
        temperature_unit: units.temperature,
        day_starts_at: getDayStartsAtPreference(db),
        goal_direction: getGoalDirection(db),
        water_target_ml: getWaterTarget(db),
      },
      raw: user,
    };
  },
  summarize: ({ row, patch }) => describeEdit('setting', row!, patch),
  edit: (db, row, patch) => {
    if ('date_of_birth' in patch || 'biological_sex' in patch) {
      const next = { ...row.values, ...patch } as Record<string, unknown>;
      updateProfile(db, {
        dateOfBirth: (next.date_of_birth as string | null) ?? null,
        biologicalSex: (next.biological_sex as 'male' | 'female' | null) ?? null,
      });
    }
    const unitKeys = {
      weight_unit: 'weight',
      volume_unit: 'volume',
      length_unit: 'length',
      distance_unit: 'distance',
      temperature_unit: 'temperature',
    } as const;
    for (const [field, key] of Object.entries(unitKeys)) {
      if (field in patch) setUnitPreference(db, key, patch[field] as never);
    }
    // THE DAY BOUNDARY DOES NOT RE-ATTRIBUTE A SINGLE EXISTING ROW: a stored
    // date is the day an entry was filed under when it happened. The running
    // app installs the new value at its next read; nothing already written
    // moves, which is the whole contract the setting's own screen states.
    if ('day_starts_at' in patch) {
      setDayStartsAtPreference(db, patch.day_starts_at as string);
    }
    if ('goal_direction' in patch) {
      setGoalDirection(db, patch.goal_direction as 'cut' | 'maintain' | 'gain');
    }
    if ('water_target_ml' in patch) {
      setWaterTarget(db, (patch.water_target_ml as number | null) ?? null);
    }
  },
  // Nothing to delete: a setting is cleared by patching it to null where that
  // is meaningful, and there is no row to remove.
  retires: ['Settings: profile, units, Health sync, app lock, API key'],
};

export const WRITE_DOMAINS: CoachDomainEntry[] = [
  workoutsDomain,
  recipesDomain,
  groceryDomain,
  screeningsDomain,
  appointmentsDomain,
  musclesDomain,
  protocolsDomain,
  settingsDomain,
];
