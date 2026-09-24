/**
 * The status write seam, and the change broadcast.
 *
 * **The row is written BEFORE any model turn, and never waits on one.** That is
 * the whole reason the rail writes at all rather than merely sending a
 * sentence: on a plane the fact lands in `day_statuses` and the turn fails as
 * every turn fails offline, so tomorrow's ledger, baselines and daily pass all
 * see the day the user actually had. It is also why the chip's write needs a
 * deterministic `excuses` default with no model in the loop — argued in the
 * 0061 migration header.
 *
 * Every gesture returns the sentence its surface should put in front of the
 * user, and whether to SEND it or merely seed it. Nothing here navigates,
 * renders or calls a model: the Coach screen sends through `chat.send`, and
 * Home carries the sentence to the Coach tab as a `prompt` param
 * (app/protocols.tsx's seam), so the two surfaces cannot drift on what a tap
 * means.
 *
 * The listener set is the same idiom the retired modes store used, for the
 * same reason: a status set from a sheet presented OVER Home never costs Home
 * its focus, so `useFocusEffect` alone would leave the door beside the date —
 * which names the running status since 2026-09-23 — reading what was on before
 * the tap. It covers the door's own gestures only; a status the Coach records
 * in a turn is written by its tool, never through here, which is why the Coach
 * tab re-reads after every turn as well.
 */
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import {
  endStatus,
  openStatuses,
  startStatus,
  type DayStatusRow,
} from '@/lib/db/repositories/statuses';

import { endPromptFor, promptFor, reaskFor, type RailChip } from './chips';

type Listener = () => void;
const listeners = new Set<Listener>();

/** Re-render hook for anything showing status-derived state; returns unsubscribe. */
export function subscribeStatusChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Today's running statuses, read fresh. Empty on any failure. */
export function currentStatuses(): DayStatusRow[] {
  try {
    return openStatuses(getDb(), todayISODate());
  } catch (error) {
    console.warn('[status] could not read open statuses', error);
    return [];
  }
}

/** What a surface should do with the sentence a gesture produced. */
export type StatusPrompt = {
  prompt: string;
  /**
   * True: send it. A quick-button that needs a second tap on send is not a
   * quick-button, and the empty-thread plate already sends through the same
   * function.
   *
   * False: SEED the composer (the `chat-input.tsx` rule). Ending a status is
   * bookkeeping that may not warrant a turn, so the user gets the sentence and
   * decides.
   */
  send: boolean;
};

/**
 * Tap a chip. Off → on writes the row and returns the prompt to SEND; a tap on
 * an already-on chip writes nothing (the repository's re-tap guard would
 * no-op anyway) and returns the re-ask.
 *
 * Returns null only when the write threw — React error boundaries do not catch
 * throws from event handlers, so an unguarded DB failure here would take the
 * app down from a tap. Fail quiet: nothing is recorded and nothing is sent,
 * which is strictly better than a half-done gesture.
 */
export function toggleStatus(chip: RailChip): StatusPrompt | null {
  if (chip.openId !== null) return { prompt: reaskFor(chip.label), send: true };
  try {
    const today = todayISODate();
    startStatus(getDb(), {
      label: chip.label,
      startDate: today,
      // Off day and Night out END TONIGHT (the owner's Q4(a)) — written bounded
      // at today rather than left open for something to close later.
      endDate: chip.endsTonight ? today : null,
      source: 'user',
      // Left to the repository's default, which is `true`. The argument for
      // that default is in the migration header and belongs there, not
      // restated at each call site.
    });
  } catch (error) {
    console.warn('[status] could not start status', error);
    return null;
  }
  emit();
  return { prompt: promptFor(chip.label), send: true };
}

/** The × on an on-chip. Ends it; today stays covered. Seeded, never sent. */
export function endOpenStatus(chip: RailChip & { openId: string }): StatusPrompt | null {
  try {
    endStatus(getDb(), chip.openId, todayISODate());
  } catch (error) {
    console.warn('[status] could not end status', error);
    return null;
  }
  emit();
  return { prompt: endPromptFor(chip.label), send: false };
}
