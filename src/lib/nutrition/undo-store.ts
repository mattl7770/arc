/**
 * The one open Undo in food logging (owner, device, 2026-09-23: *"undo for
 * removing a food"*) — held in a module, not in a screen's state.
 *
 * ## Why a module
 *
 * Deleting a whole meal happens on the meal screen, which then closes: the
 * Undo has to be offered on the day list it returns to, and a pushed route
 * cannot reach another screen's component state. This is the listener-set
 * idiom `snooze-store.ts` uses for the same reason. Pure state and listeners —
 * no database, no native, no UI; what an Undo DOES arrives as closures, built
 * by the screen that made the removal over the repository's own functions.
 *
 * ## The window — the precedent, and where this differs from it
 *
 * The precedent is the Log tab's water Undo (src/components/log/quick-add-grid.tsx):
 * no timer — *"an affordance you have to race is worse than one that waits"* —
 * and replaced by the next write. Both hold here: there is no timer, and the
 * next removal or combine replaces the offer (settling the one before it).
 *
 * One rule is added: **the offer closes when the screen showing it is left.**
 * The day list closes a list offer when it loses focus; the meal screen closes
 * an item offer when it does. Two reasons, both about what an Undo would
 * otherwise put back:
 *
 * - An item put back after a detour through the meal's other editors, or a
 *   revision, lands beside whatever replaced it — a meal nobody logged.
 * - A deleted meal's photo files are held on disk until the offer closes
 *   (src/lib/media/held-files.ts); an offer that outlived the visit would keep
 *   them for an Undo nobody is looking at.
 *
 * Only one offer exists at a time, which is what makes "Undo" unambiguous: it
 * always means the last thing removed.
 */

/** Where an offer is drawn. */
export type UndoScope =
  /** The day list — the Eat tab, or a past day in history. A deleted meal and
   *  a combine are offered here. */
  | { on: 'list' }
  /** One meal's own screen — an item removed from it. */
  | { on: 'meal'; mealId: string };

export type UndoOffer = {
  scope: UndoScope;
  /** Ionicons glyph for the row — the thing acted on, as the water row draws
   *  a drop. */
  icon: 'restaurant-outline' | 'git-merge-outline';
  /** What was done, as the row says it: "Removed Greek yogurt". */
  said: string;
  /** The measured half, set in mono after it — "150 kcal" — or null. */
  figure: string | null;
  /** The whole instruction VoiceOver reads for the button. */
  spoken: string;
  /** Put it back. Throwing means it could not be — the offer is settled. */
  undo: () => void;
  /** The window closed without an Undo: finish the removal (a meal's files). */
  settle: () => void;
};

type Listener = () => void;

let current: UndoOffer | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function settleQuietly(offer: UndoOffer | null): void {
  if (!offer) return;
  try {
    offer.settle();
  } catch (error) {
    // A settle is disk housekeeping; the sweep's orphan pass is its backstop.
    console.warn('[undo] settle failed', error);
  }
}

/** Re-render hook for anything drawing the offer; returns unsubscribe. */
export function subscribeUndo(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The open offer, or null. The same reference until it changes. */
export function currentUndo(): UndoOffer | null {
  return current;
}

/** Offer an Undo for what was just done — settling the one before it. */
export function offerUndo(offer: UndoOffer): void {
  const previous = current;
  current = offer;
  settleQuietly(previous);
  emit();
}

/** Close the open offer without undoing it — when `match` accepts its scope,
 *  or unconditionally when no `match` is given. */
export function closeUndo(match?: (scope: UndoScope) => boolean): void {
  if (!current || (match && !match(current.scope))) return;
  const closing = current;
  current = null;
  settleQuietly(closing);
  emit();
}

/**
 * Take the Undo. True when it was put back; false when there was nothing to
 * undo, or it could not be done — in which case the removal is finished
 * (settled), so nothing is left held for a restore that will never happen.
 */
export function runUndo(): boolean {
  const offer = current;
  if (!offer) return false;
  current = null;
  try {
    offer.undo();
    emit();
    return true;
  } catch (error) {
    console.warn('[undo] could not put it back', error);
    settleQuietly(offer);
    emit();
    return false;
  }
}

/** Scope matchers, so a screen asks one question the same way everywhere. */
export const onList = (scope: UndoScope): boolean => scope.on === 'list';
export const onMeal = (scope: UndoScope): boolean => scope.on === 'meal';
