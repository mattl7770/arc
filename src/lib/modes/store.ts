/**
 * The day-mode write seam + change broadcast.
 *
 * Setting a mode has two consequences beyond the `day_modes` row: today's
 * ALREADY-GENERATED mission must re-shape to the new mode
 * ({@link rederiveMissionForDay} — a diff that preserves completed/partial work
 * and ad-hoc captures), and every mounted view showing mode-derived state (the
 * Home control, the mission list, the Coach brief) must re-read. Screens can't
 * rely on focus alone here: the mode is set from a modal ON Home, so Home never
 * loses focus. Hence the listener set — the same idiom as
 * `subscribeHealthSync` (src/lib/health/sync.ts) and the api-key store.
 *
 * Pure over the {@link Database} interface + the repositories; no native, no UI.
 */
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { clearMode, getActiveMode, setMode } from '@/lib/db/repositories/day-modes';
import { rederiveMissionForDay } from '@/lib/db/repositories/mission-generate';

import type { ModeKey } from './registry';

type Listener = () => void;
const listeners = new Set<Listener>();

/** Re-render hook for anything showing mode-derived state; returns unsubscribe. */
export function subscribeModeChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitModeChanged(): void {
  for (const listener of listeners) listener();
}

/**
 * Set today's mode, re-derive today's mission to match, and notify listeners.
 * `endDate` follows the repository contract: omit for open-ended ("on until
 * turned off"), pass a date for a range, pass today for just today. Choosing
 * `normal` clears instead (an open-ended reset, so an earlier range ends too).
 */
export function applyMode(mode: ModeKey, opts: { endDate?: string | null } = {}): void {
  const db = getDb();
  const today = todayISODate();
  if (mode === 'normal') clearMode(db, today);
  else setMode(db, { mode, startDate: today, endDate: opts.endDate ?? null });
  // Re-shape today's plan to the new mode without destroying work already done.
  rederiveMissionForDay(db, today);
  emitModeChanged();
}

/** Today's active mode, read fresh. */
export function currentMode(): ModeKey {
  return getActiveMode(getDb(), todayISODate());
}
