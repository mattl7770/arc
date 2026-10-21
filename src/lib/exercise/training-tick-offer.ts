/**
 * What every app-side finish path calls once its session is committed (item
 * 70): tick the Training row the session earns, and offer its Undo.
 *
 * The tick itself is the repository's (src/lib/db/repositories/training-tick.ts),
 * which the Coach's `log_workout` calls directly. This adds the two things only
 * a screen has: the reminder re-sync every status write runs (it is what clears
 * a delivered protocol nudge for the row, exactly as Home's own tick does —
 * src/hooks/use-today-mission.ts), and the Undo row on whichever of Home or the
 * Train hub the logger returns to.
 *
 * The Undo takes the shared slot (src/lib/nutrition/undo-store.ts) for that
 * slot's reasons: the logger closes as it saves, and a pushed route cannot
 * reach the state of the screen it returns to. Its words are
 * "Ticked Training: Push Day", then Undo; it has no timer, and it closes when
 * the screen drawing it is left.
 *
 * Never throws: the session is already saved, and a tick problem must not
 * reach the save's "Save failed".
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import {
  tickTrainingForWorkout,
  untickTraining,
  type TrainingTick,
} from '@/lib/db/repositories/training-tick';
import { syncReminderNotifications } from '@/lib/notifications/reminders';
import { offerUndo, type UndoOffer } from '@/lib/nutrition/undo-store';

/** The words a tick's Undo row says, and VoiceOver reads. */
export function trainingTickWords(
  title: string
): Pick<UndoOffer, 'icon' | 'said' | 'figure' | 'spoken' | 'refusal'> {
  return {
    icon: 'barbell-outline',
    said: `Ticked Training: ${title}`,
    figure: null,
    spoken: `Undo ticking ${title}`,
    refusal: `Could not untick ${title} — it has changed since.`,
  };
}

/** The Undo offer for one tick. `sync` is the reminder re-sync, injectable for
 *  the headless suite. */
export function trainingTickOffer(
  db: Database,
  tick: TrainingTick,
  sync: (db: Database) => unknown = syncReminderNotifications
): UndoOffer {
  return {
    scope: { on: 'training', date: tick.date },
    ...trainingTickWords(tick.title),
    undo: () => {
      untickTraining(db, tick, todayISODate());
      void sync(db);
    },
    settle: () => {},
  };
}

/**
 * Tick and offer. Returns the tick, or null when the session earned none (not
 * today's, Away, no open Training row, or a row naming a different workout).
 */
export function tickTrainingAfterSave(
  db: Database,
  workoutId: string,
  sync: (db: Database) => unknown = syncReminderNotifications
): TrainingTick | null {
  try {
    const tick = tickTrainingForWorkout(db, workoutId, todayISODate());
    if (!tick) return null;
    void sync(db);
    offerUndo(trainingTickOffer(db, tick, sync));
    return tick;
  } catch (error) {
    console.warn('[exercise] training tick failed', error);
    return null;
  }
}
