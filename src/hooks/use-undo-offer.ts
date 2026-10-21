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
 * `closeOnLeave: false` draws without the closing rule — for a LOGGING screen
 * pushed over a day list (Add food, the scanner), which shows a join receipt
 * (item 58) that must survive being left: the list it returns to draws the same
 * offer, and closes it by its own rule.
 *
 * `useSyncExternalStore` with the same getter for the server snapshot, so the
 * headless render suite draws whatever offer a test has made.
 */
export function useUndoOffer(
  on: UndoScope['on'],
  key: string,
  { closeOnLeave = true }: { closeOnLeave?: boolean } = {}
): UndoOffer | null {
  const offer = useSyncExternalStore(subscribeUndo, currentUndo, currentUndo);

  useFocusEffect(
    useCallback(
      () => () => {
        if (closeOnLeave) closeUndo((scope) => scope.on === on);
      },
      [on, closeOnLeave]
    )
  );

  return offerDrawnOn(offer, on, key);
}
