/**
 * Which mission rows are snoozed — session state, held in a module rather than
 * in `useTodayMission`'s `useState`.
 *
 * ## The semantics do not change, and they are worth restating
 *
 * A snooze is **never persisted**. It says "not right now", it stops the row
 * claiming the hero, and it dies with the session or with the day. Writing it
 * to `log_entries` was considered and is still refused: it is not a decision
 * about the item, and a row that came back un-snoozed after a relaunch is the
 * honest behaviour — the reason to defer something rarely outlives the app
 * being closed.
 *
 * ## Why it left the hook
 *
 * The set was `useState` inside `useTodayMission`, so only Home could reach it:
 * a snooze could be made on Home and cleared by a status write or the rollover,
 * and by nothing else, anywhere. The mission item sheet is a PUSHED route, and
 * a pushed route cannot reach another screen's component state — so *Unsnooze*
 * had no way to exist. This is the same listener-set idiom `subscribeModeChange`
 * uses (src/lib/status/store.ts) and for the same reason: a screen that is not
 * mounted, or one presented over Home so Home never loses focus, still has to
 * be able to change what Home shows.
 *
 * The set reference is REPLACED on every mutation rather than mutated in place,
 * so a subscriber re-reading it gets a new identity and React re-renders; a
 * mutation that changes nothing emits nothing.
 *
 * Pure state and listeners — no database, no native, no UI.
 */

type Listener = () => void;

let snoozed: ReadonlySet<string> = new Set();
const listeners = new Set<Listener>();

/** Re-render hook for anything showing the snoozed set; returns unsubscribe. */
export function subscribeSnoozeChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** The current set. A new identity after every change that changed something. */
export function snoozedItems(): ReadonlySet<string> {
  return snoozed;
}

export function isSnoozed(id: string): boolean {
  return snoozed.has(id);
}

/** Defer a row from the hero. No-op if it is already snoozed. */
export function snoozeItem(id: string): void {
  if (snoozed.has(id)) return;
  snoozed = new Set(snoozed).add(id);
  emit();
}

/** Put a row back in the running. No-op if it was not snoozed. */
export function unsnoozeItem(id: string): void {
  if (!snoozed.has(id)) return;
  const next = new Set(snoozed);
  next.delete(id);
  snoozed = next;
  emit();
}

/**
 * Drop every snooze — the day rolled over, so the rows themselves are gone and
 * an id held from yesterday could only ever match by accident.
 */
export function clearSnoozed(): void {
  if (snoozed.size === 0) return;
  snoozed = new Set();
  emit();
}
