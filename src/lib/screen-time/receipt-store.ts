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
 */
type Listener = () => void;

let lastTypedId: string | null = null;
const listeners = new Set<Listener>();

export function noteTypedScreenTime(id: string | null): void {
  lastTypedId = id;
  for (const listener of listeners) listener();
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
