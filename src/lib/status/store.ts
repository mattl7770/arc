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

import { nightOutPrompt, type DrinkKind, type DrinksInput } from '@/lib/nutrition/drinks';

import { endPromptFor, promptFor, reaskFor, type RailChip } from './chips';
import { nightOutStepper, saveNightOutDrinks, type NightOutTarget } from './night-out';

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
 *
 * With `drinks` — Night out, from the drinks stepper — it is
 * {@link saveNightOut} instead, which returns null for a re-count too; `night`
 * is the night the stepper opened on, which that Save honours.
 */
export function toggleStatus(
  chip: RailChip,
  drinks?: DrinksInput,
  night?: NightOutTarget | null
): StatusPrompt | null {
  if (drinks !== undefined) return saveNightOut(drinks, night ?? null);
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

/**
 * Night out with its count (items 61/80, 2026-10-21) — the drinks stepper's
 * Save. Writes the status (if it is not already on) and the drinks as a meal on
 * the day, through `saveNightOutDrinks` (`recordNightOut`), which touches
 * nothing else. The morning after, it re-counts LAST night's row instead and
 * starts nothing (`nightOutDay`, src/lib/status/night-out.ts), so a count
 * corrected at 01:15 is a correction, not a second night out. Which night is
 * decided when the stepper OPENS (`currentNightOutDrinks`) and handed back
 * here as `night`, so a Save that lands after noon still writes the night the
 * panel showed.
 *
 * The FIRST save returns the sentence to send — a fact with the count
 * (`nightOutPrompt`), the same order as every chip: the row lands, then the
 * turn. A re-count later that evening returns null: the record changes and the
 * Coach reads the new count in its state block on its next turn, but a
 * correction is not a reason to start one. Null too when a write threw, for
 * toggleStatus's reason — fail quiet, never half a gesture from a tap.
 *
 * Emits either way, so the door and anything reading the day's nutrition
 * (Home's readiness pillars) re-read without losing focus.
 */
function saveNightOut(drinks: DrinksInput, night: NightOutTarget | null): StatusPrompt | null {
  let started = false;
  try {
    started = saveNightOutDrinks(getDb(), todayISODate(), drinks, new Date(), night).started;
  } catch (error) {
    console.warn('[status] could not record night out', error);
    emit();
    return null;
  }
  emit();
  return started ? { prompt: nightOutPrompt(drinks), send: true } : null;
}

/**
 * What the drinks stepper opens on — the recorded count, or null — and whether
 * it is last night's, the morning after (`nightOutStepper`); then its Save
 * re-counts that night. `night` is the night it chose, for the Save to hand
 * back to {@link toggleStatus}. Nothing recorded, not last night, and no night
 * (the Save decides) on any failure.
 */
export function currentNightOutDrinks(): {
  recorded: { count: number; kind: DrinkKind } | null;
  lastNight: boolean;
  night: NightOutTarget | null;
} {
  try {
    const { recorded, date, lastNight } = nightOutStepper(getDb(), todayISODate());
    return { recorded, lastNight, night: { date, lastNight } };
  } catch (error) {
    console.warn('[status] could not read the night out drinks', error);
    return { recorded: null, lastNight: false, night: null };
  }
}
