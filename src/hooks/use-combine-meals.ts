import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { getDb } from '@/lib/db/client';
import { CombineRefused, planCombine, type CombinePlan } from '@/lib/nutrition/combine';
import type { MealRow } from '@/lib/nutrition/types';
import { combineWithUndo } from '@/lib/nutrition/undo-offers';

/** A combine in progress: the meals chosen, the name typed for the result
 *  (null while untouched), and why the last Combine tap was refused (null when
 *  it was not). */
export type CombineChoice = {
  /** The day the choice was made on — a choice never survives the day it was
   *  made on being changed under it (History's picker). */
  day: string;
  chosen: ReadonlySet<string>;
  name: string | null;
  refused: string | null;
};

export type CombineMeals = {
  /** The choice being made, or null when not combining. */
  choice: CombineChoice | null;
  /** Whether the day has two meals that could become one — the only day the
   *  `Combine` control is drawn on. A meal waiting on its estimate cannot. */
  combinable: boolean;
  /** The plan the chosen meals make — the same one `combineMeals` runs. */
  plan: CombinePlan<MealRow>;
  /** `Combine` / `Cancel` on the list's label line. */
  toggle: () => void;
  /** A row tapped while choosing. */
  toggleChosen: (id: string) => void;
  /** The name field. */
  setName: (name: string) => void;
  /** The Combine button: combine through the repository and offer the Undo. */
  run: () => void;
};

/**
 * Combining one day's meals — the Eat tab's today, and (2026-09-25) a past day
 * in History (the owner: *"also allow combine on past days, from History"*).
 *
 * One hook, so the two lists cannot come to disagree about the rules: the plan
 * is `planCombine`'s (src/lib/nutrition/combine.ts), the write and its Undo are
 * `combineWithUndo`'s (src/lib/nutrition/undo-offers.ts), and nothing in either
 * assumes today — the plan checks the chosen meals share a day, the combine
 * keeps the earliest meal's own row (its date included), the Undo restores each
 * absorbed row verbatim, and the offer is scoped to the kept meal's date, which
 * is the day History is showing (`useUndoOffer('list', view.date)`).
 *
 * `day` is the day the list shows. A choice made on one day reads as no choice
 * once the list shows another, so stepping History's picker never carries a
 * half-made combine onto a different day's meals. A choice made and walked away
 * from is not resumed on the way back either: the day may have changed under
 * it.
 */
export function useCombineMeals(
  day: string,
  meals: MealRow[],
  pending: ReadonlySet<string>,
  reload: () => void
): CombineMeals {
  const [state, setState] = useState<CombineChoice | null>(null);
  useFocusEffect(useCallback(() => () => setState(null), []));

  const choice = state !== null && state.day === day ? state : null;
  const combinable = meals.filter((meal) => !pending.has(meal.id)).length >= 2;
  const plan = planCombine(
    choice ? meals.filter((meal) => choice.chosen.has(meal.id)) : [],
    pending
  );

  const toggle = () =>
    setState((prev) =>
      prev !== null && prev.day === day
        ? null
        : { day, chosen: new Set(), name: null, refused: null }
    );
  // A change to the choice or the name is a new attempt: the last refusal no
  // longer describes it.
  const toggleChosen = (id: string) =>
    setState((prev) => {
      if (prev === null || prev.day !== day) return prev;
      const chosen = new Set(prev.chosen);
      if (chosen.has(id)) chosen.delete(id);
      else chosen.add(id);
      return { ...prev, chosen, refused: null };
    });
  const setName = (name: string) =>
    setState((prev) => (prev !== null && prev.day === day ? { ...prev, name, refused: null } : prev));

  const run = () => {
    if (!choice || plan.kind !== 'ok') return;
    try {
      // `combineWithUndo` combines through the repository and offers the Undo
      // on the kept meal's own day; the plan it runs is this one.
      combineWithUndo(getDb(), [plan.keep.id, ...plan.absorb.map((meal) => meal.id)], choice.name);
      setState(null);
    } catch (error) {
      // Refused, writing nothing — most likely the day moved under a stale
      // screen (an estimate queued, a meal deleted). Stay in combine mode and
      // say why at the foot, over the fresh day the reload reads.
      console.warn('[nutrition] combine refused', error);
      const refused =
        error instanceof CombineRefused
          ? error.message
          : 'These meals could not be combined. Nothing was changed.';
      setState((prev) => (prev ? { ...prev, refused } : prev));
    }
    reload();
  };

  return { choice, combinable, plan, toggle, toggleChosen, setName, run };
}
