/**
 * The last screen-time number typed in this session — its row id and nothing
 * else — so the Log tab can report it and offer Undo whichever door took it.
 *
 * Two doors write a typed number: the Log tab's command field, which is on the
 * Log tab, and the metric keypad, which is a pushed screen that goes back to
 * wherever it came from. A receipt held in the command field's own state would
 * miss every keypad entry, so the id lives here and the Log tab's receipt row
 * subscribes (src/components/log/screen-time-receipt.tsx).
 *
 * Only the ID is held. Everything the receipt prints is read back from the row
 * (src/lib/db/repositories/screen-time.ts), so a row that has since been undone
 * or replaced simply stops drawing — the store can never report a number the
 * record no longer holds. A Shortcuts write needs no entry here: its row says
 * where it came from and the receipt finds it by that.
 *
 * Session-scoped by design, like the water receipt: the next typed write
 * replaces it, and a relaunch clears it.
 *
 * **Noting a write tells the receipt; forgetting one does not.** An Undo
 * forgets the id it took back, and if that woke the receipt it would re-read
 * the record and arm the next write it found — a Shortcuts number for another
 * day, or the very row the Undo just restored — under the thumb that is still
 * on the button. So {@link forgetTypedScreenTime} is silent, and the receipt
 * holds its own "Undone" line until the next write or the next focus.
 */
type Listener = () => void;

let lastTypedId: string | null = null;
const listeners = new Set<Listener>();

/** A typed write just landed: remember its id and tell the receipt. */
export function noteTypedScreenTime(id: string): void {
  lastTypedId = id;
  for (const listener of listeners) listener();
}

/**
 * Stop reporting a typed write — `id` only if it is still the one held, or
 * whatever is held when omitted. Tells nobody (see the header).
 */
export function forgetTypedScreenTime(id?: string): void {
  if (id === undefined || id === lastTypedId) lastTypedId = null;
}

export function lastTypedScreenTime(): string | null {
  return lastTypedId;
}

export function subscribeTypedScreenTime(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
