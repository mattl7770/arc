import { useFocusEffect } from 'expo-router';
import { useCallback, useSyncExternalStore } from 'react';

import {
  closeUndo,
  currentUndo,
  offerDrawnOn,
  subscribeUndo,
  type UndoOffer,
  type UndoScope,
} from '@/lib/nutrition/undo-store';

/**
 * The open Undo this screen draws, or null — and the rule that closes it when
 * the screen is left (src/lib/nutrition/undo-store.ts, "The window").
 *
 * `on: 'list'` is a day list, keyed by the day it shows (the Eat tab's today,
 * the day picked in history): it draws a meal deleted from that day, or a
 * combine made on it. `on: 'meal'` is one meal's screen, keyed by its id: it
 * draws an item removed from THAT meal. Either closes its own kind of offer
 * when it loses focus.
 *
 * `useSyncExternalStore` with the same getter for the server snapshot, so the
 * headless render suite draws whatever offer a test has made.
 */
export function useUndoOffer(on: UndoScope['on'], key: string): UndoOffer | null {
  const offer = useSyncExternalStore(subscribeUndo, currentUndo, currentUndo);

  useFocusEffect(useCallback(() => () => closeUndo((scope) => scope.on === on), [on]));

  return offerDrawnOn(offer, on, key);
}
