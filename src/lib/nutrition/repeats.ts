/**
 * Repeat foods — what counts as "the same thing again", and the three uses the
 * owner made of it (device round 3, docs/nutrition-subapp.md §21):
 *
 * - **73/74** — after the third identical log of an estimated food, offer
 *   *Save as a food*, once; and the photo / describe estimators see his
 *   most-logged foods, so "my usual latte" resolves.
 * - **64** — a drink's *usual add-ons*: what he has added to that drink before,
 *   one tap to add again.
 *
 * Pure and DB-free: the repository (src/lib/db/repositories/food-history.ts)
 * reads the rows and hands them here, so the rules are tested without a
 * database and cannot drift between the three uses.
 *
 * ## "The same food" — two keys, on purpose
 *
 * - **A catalog food is its `food_id`.** Two logs of the same catalog food are
 *   the same food whatever the portion: the portion is a fact about the day,
 *   the food is not. The name is a snapshot and can be stale (a food renamed
 *   since), so the id, not the name, is the key.
 * - **An estimated or typed food has no id**, so its key is its name, normalized
 *   the way the catalog normalizes one (`normalizeFoodName`: case and runs of
 *   whitespace). Never a fuzzy match — the labs rule (CLAUDE.md §7): "Oat
 *   latte" is not "Oat latte, large".
 *
 * ## "Identical" — for the Save-as-a-food offer, the name is not enough
 *
 * The model names what it sees, so "Latte" covers a 120 kcal flat white and a
 * 300 kcal 16 oz one. Saving one figure for both would be a wrong food in the
 * catalog. So a log is IDENTICAL to the latest one only when its figures are
 * close too ({@link figuresClose}): the same unit, energy within 15 % (or
 * 15 kcal — label rounding on a small item), and each macro within 20 % (or
 * 3 g). That is "the same thing, the same size": the estimator's own
 * run-to-run spread on one photographed drink, and well short of a size step
 * (a small to a large latte is +40 % or more). Name-only would merge sizes;
 * figures-only would merge different foods; both together is the claim.
 */
import { normalizeFoodName } from '@/lib/db/repositories/foods';

import { parseMicros, scaleMicros, serializeMicros } from './micros';
import type { AmountUnit, EstimateConfidence, NewFood, NewMealItem } from './types';

/** The Save-as-a-food offer comes on the third identical log. */
export const REPEAT_OFFER_AFTER = 3;
/** How many usual foods the estimators see per call. */
export const USUAL_FOODS_LIMIT = 30;
/** "Usual" is a current habit: counted over this many days. */
export const USUAL_FOODS_DAYS = 90;
/** An add-on was logged within this many minutes of its drink, in its meal. */
export const ADD_ON_MINUTES = 15;
/** …and with that drink at least this many times — once is a coincidence. */
export const ADD_ON_MIN_TIMES = 2;
/** At most this many add-on chips under a drink. */
export const ADD_ON_LIMIT = 3;

/** A top-level logged item, as the history reads it (a composite's figures are
 *  its parts' sums; its amount only when the parts share a unit). */
export type LoggedFood = {
  id: string;
  meal_id: string;
  date: string;
  food_id: string | null;
  name: string;
  amount: number | null;
  unit: AmountUnit;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  micros: string | null;
  confidence: EstimateConfidence | null;
  serving_qty: number | null;
  piece_name: string | null;
  is_composite: 0 | 1;
  created_at: string;
};

/** The key two logs share when they are the same food. */
export function foodKey(item: { food_id: string | null; name: string }): string {
  return item.food_id != null ? `food:${item.food_id}` : `name:${normalizeFoodName(item.name)}`;
}

/** A free-form meal's totals carried as an item by a combine — not a food. */
export function isStandIn(name: string): boolean {
  return / \(as logged\)$/.test(name);
}

function near(a: number | null, b: number | null, share: number, slack: number): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= Math.max(share * Math.max(Math.abs(a), Math.abs(b)), slack);
}

/** Whether two logs carry the same figures, near enough — see the header. */
export function figuresClose(
  a: Pick<LoggedFood, 'unit' | 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g'>,
  b: Pick<LoggedFood, 'unit' | 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g'>
): boolean {
  return (
    a.unit === b.unit &&
    near(a.kcal, b.kcal, 0.15, 15) &&
    near(a.protein_g, b.protein_g, 0.2, 3) &&
    near(a.carbs_g, b.carbs_g, 0.2, 3) &&
    near(a.fat_g, b.fat_g, 0.2, 3)
  );
}

// --- 73/74 — the Save-as-a-food offer ----------------------------------------

/** A food logged {@link REPEAT_OFFER_AFTER}+ times identically, not yet saved. */
export type RepeatFood = {
  key: string;
  /** The latest log, whose figures a saved food would carry. */
  latest: LoggedFood;
  /** How many identical logs there are. */
  times: number;
};

/**
 * The food to offer *Save as a food* for on `date`, or null.
 *
 * `items` is the history, NEWEST FIRST. Considered: plain items with no catalog
 * food (a catalog food is already saved), not a combine's stand-in, with an
 * amount to make a per-100 figure from. The latest log must be on `date` — the
 * offer follows the third log, not a browse of old history — and the food must
 * not have been offered before (`offered`) or already be in the catalog under
 * that name (`catalogNames`, normalized). When two qualify, the newest.
 */
export function pickRepeatFood(
  items: readonly LoggedFood[],
  date: string,
  offered: ReadonlySet<string>,
  catalogNames: ReadonlySet<string>
): RepeatFood | null {
  const groups = new Map<string, LoggedFood[]>();
  for (const item of items) {
    if (item.food_id !== null || item.is_composite === 1 || isStandIn(item.name)) continue;
    const key = foodKey(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  for (const [key, group] of groups) {
    const latest = group[0]!;
    if (latest.date !== date || offered.has(key)) continue;
    if (catalogNames.has(normalizeFoodName(latest.name))) continue;
    if (latest.amount === null || !(latest.amount > 0)) continue;
    const times = group.filter((item) => figuresClose(item, latest)).length;
    if (times >= REPEAT_OFFER_AFTER) return { key, latest, times };
  }
  return null;
}

/**
 * The catalog food a repeat becomes: per 100 of its own unit (the catalog's
 * shape), with one serving — the portion he keeps logging — so adding it from
 * search defaults to exactly that. An estimate stays marked as one (`ai`, the
 * `est` mark); a typed food is his own (`user`).
 */
export function foodFromRepeat(latest: LoggedFood): NewFood {
  const amount = latest.amount ?? 0;
  const per100 = (value: number | null): number | null =>
    value === null || !(amount > 0) ? null : (value * 100) / amount;
  return {
    name: latest.name.trim(),
    serving_name: 'serving',
    serving_amount: amount > 0 ? amount : null,
    kcal_100g: per100(latest.kcal),
    protein_g_100g: per100(latest.protein_g),
    carbs_g_100g: per100(latest.carbs_g),
    fat_g_100g: per100(latest.fat_g),
    fiber_g_100g: per100(latest.fiber_g),
    micros:
      amount > 0 ? serializeMicros(scaleMicros(parseMicros(latest.micros), 100 / amount)) : null,
    source: latest.confidence !== null ? 'ai' : 'user',
    basis: latest.unit,
  };
}

// --- 73 — the estimators' per-call context -----------------------------------

/** One usual food, as the estimator is told it. */
export type UsualFood = {
  key: string;
  name: string;
  times: number;
  amount: number | null;
  unit: AmountUnit;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  lastAt: string;
};

/**
 * His most-logged foods: grouped by {@link foodKey}, logged at least twice (a
 * food eaten once is not "usual", and every line is paid for on every call),
 * most-logged first, ties to the more recent, at most `limit`. Each carries its
 * LATEST log's name, portion and figures — the usual latte is the one he has
 * now, not an average of every one he ever had. `items` is newest first.
 */
export function rankUsualFoods(
  items: readonly LoggedFood[],
  limit: number = USUAL_FOODS_LIMIT
): UsualFood[] {
  const groups = new Map<string, UsualFood>();
  for (const item of items) {
    if (isStandIn(item.name)) continue;
    const key = foodKey(item);
    const seen = groups.get(key);
    if (seen) {
      seen.times += 1;
      continue;
    }
    groups.set(key, {
      key,
      name: item.name,
      times: 1,
      amount: item.amount,
      unit: item.unit,
      kcal: item.kcal,
      protein_g: item.protein_g,
      carbs_g: item.carbs_g,
      fat_g: item.fat_g,
      lastAt: item.created_at,
    });
  }
  return [...groups.values()]
    .filter((food) => food.times >= 2)
    .sort((a, b) => b.times - a.times || (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0))
    .slice(0, limit);
}

/** A food's name as one plain line: no line breaks, no list marker, capped. */
export function oneLine(name: string): string {
  return name
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-*•\s]+/, '')
    .trim()
    .slice(0, 60);
}

const figure = (n: number | null): string => (n === null ? '?' : String(Math.round(n)));

/**
 * The per-call context block — the user turn, never the system prompt, which
 * sits at its ceiling (src/lib/nutrition/estimate.ts). Null when there is
 * nothing usual yet: a cold start costs no tokens.
 *
 * Food names and their figures only. No dates, no times, no meal names, no
 * notes, no brands: the model needs what the usual latte IS, not when he drank
 * it. The sentence that heads it is the only instruction it carries, and it is
 * scoped so a listed food is never added to a meal that does not show or name
 * it.
 */
export function usualFoodsContext(foods: readonly UsualFood[]): string | null {
  if (foods.length === 0) return null;
  const lines = foods.map((food) => {
    const portion =
      food.amount !== null && food.amount > 0 ? `${figure(food.amount)} ${food.unit}` : '1 portion';
    return `- ${oneLine(food.name)}: ${portion} · ${figure(food.kcal)} kcal · ${figure(
      food.protein_g
    )}/${figure(food.carbs_g)}/${figure(food.fat_g)}`;
  });
  return [
    'Foods this person logs often (usual portion · kcal · protein/carbs/fat g). Not part of this meal unless it shows or names one; when it does ("my usual …"), use those figures:',
    ...lines,
  ].join('\n');
}

// --- 64 — a drink's usual add-ons --------------------------------------------

/** One chip: what to add, as it was last added. */
export type UsualAddOn = {
  key: string;
  name: string;
  /** How many times it went with this drink. */
  times: number;
  /** The last time's row — what one tap logs again. */
  latest: LoggedFood;
};

/**
 * Rank a drink's add-ons. `companions` holds, for each earlier log of the drink
 * (`occurrence`), the items logged in its meal within {@link ADD_ON_MINUTES}.
 * Counted once per occurrence; kept when it went with the drink at least
 * {@link ADD_ON_MIN_TIMES} times; never the drink itself, never something the
 * meal already holds (`present`); most frequent first, ties to the more
 * recent; at most {@link ADD_ON_LIMIT}. Cold start — no history — is empty.
 */
export function rankAddOns(
  drinkKey: string,
  companions: readonly { occurrence: string; item: LoggedFood }[],
  present: ReadonlySet<string>
): UsualAddOn[] {
  const groups = new Map<string, { occurrences: Set<string>; latest: LoggedFood }>();
  for (const { occurrence, item } of companions) {
    if (isStandIn(item.name)) continue;
    const key = foodKey(item);
    if (key === drinkKey || present.has(key)) continue;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { occurrences: new Set([occurrence]), latest: item });
      continue;
    }
    group.occurrences.add(occurrence);
    if (item.created_at > group.latest.created_at) group.latest = item;
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, name: g.latest.name, times: g.occurrences.size, latest: g.latest }))
    .filter((addOn) => addOn.times >= ADD_ON_MIN_TIMES)
    .sort(
      (a, b) =>
        b.times - a.times ||
        (a.latest.created_at < b.latest.created_at
          ? 1
          : a.latest.created_at > b.latest.created_at
            ? -1
            : 0)
    )
    .slice(0, ADD_ON_LIMIT);
}

/** The item one tap on an add-on logs: the last one, as it was logged. */
export function addOnItem(addOn: UsualAddOn): NewMealItem {
  const i = addOn.latest;
  return {
    food_id: i.food_id,
    name: i.name,
    amount: i.amount,
    unit: i.unit,
    serving_qty: i.serving_qty,
    piece_name: i.piece_name,
    kcal: i.kcal,
    protein_g: i.protein_g,
    carbs_g: i.carbs_g,
    fat_g: i.fat_g,
    fiber_g: i.fiber_g,
    confidence: i.confidence,
    micros: i.micros,
  };
}
