import { useFocusEffect } from 'expo-router';
import { useCallback, useSyncExternalStore } from 'react';

import {
  closeUndo,
  currentUndo,
  subscribeUndo,
  type UndoOffer,
  type UndoScope,
} from '@/lib/nutrition/undo-store';

/**
 * The open Undo this screen draws, or null — and the rule that closes it when
 * the screen is left (src/lib/nutrition/undo-store.ts, "The window").
 *
 * `on: 'list'` is a day list (the Eat tab, a past day in history): it draws a
 * deleted meal or a combine. `on: 'meal'` is one meal's screen: it draws an
 * item removed from THAT meal, and closes any item offer when it loses focus.
 *
 * `useSyncExternalStore` with the same getter for the server snapshot, so the
 * headless render suite draws whatever offer a test has made.
 */
export function useUndoOffer(on: UndoScope['on'], mealId?: string): UndoOffer | null {
  const offer = useSyncExternalStore(subscribeUndo, currentUndo, currentUndo);

  useFocusEffect(useCallback(() => () => closeUndo((scope) => scope.on === on), [on]));

  if (!offer || offer.scope.on !== on) return null;
  if (offer.scope.on === 'meal' && offer.scope.mealId !== mealId) return null;
  return offer;
}
