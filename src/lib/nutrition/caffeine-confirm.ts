/**
 * The caffeine cut-off's prompt (item 72) — the one call every hand food-save
 * path makes before it writes: `confirmCaffeine(items, save, { into })`.
 *
 * It **warns, never blocks.** No warning: `save` runs at once, exactly as it
 * did before this existed. A warning: a native Alert — *This has about 80 mg
 * caffeine, 3 h before Push Day (18:00). Your rule: none within 6 h. Log
 * anyway?* — with **Cancel** (nothing is written, the screen stays as it was)
 * and **Log anyway** (`save` runs). Neither button is destructive-red: the
 * prompt states his own rule and passes no judgment on breaking it.
 *
 * A check that fails for any reason lets the save through. A reminder that
 * cost him a meal record would be worse than no reminder.
 *
 * Every path the owner is present to answer calls it — docs/nutrition-subapp.md
 * §22 lists them, and the ones that do not (the offline queue's drain, Night
 * out, a manual entry with no caffeine figure) with why.
 */
import { Alert } from 'react-native';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { caffeineCheck, type LogWhen, mealWhen } from '@/lib/db/repositories/caffeine-check';
import { getCaffeineCutoff } from '@/lib/db/repositories/user';
import { arriveDay } from '@/lib/db/seed';

import {
  CAFFEINE_FLOOR_MG,
  CAFFEINE_WARNING_TITLE,
  type CaffeineItem,
  type CaffeineWarning,
  caffeineMgOf,
  caffeineWarningMessage,
} from './caffeine-cutoff';

export type ConfirmCaffeineOptions = {
  /** The meal these items are being added INTO — they are logged at its time.
   *  Absent or null: a new meal, logged now. */
  into?: string | null;
  /** What the same meal already held (a revision): only added caffeine asks. */
  priorMg?: number;
};

/** The warning for this save, or null — never throws. */
function warningFor(
  items: readonly CaffeineItem[],
  options: ConfirmCaffeineOptions
): CaffeineWarning | null {
  try {
    const db = getDb();
    // The common case first, before anything touches the mission: the rule is
    // off, or nothing here carries caffeine.
    if (!getCaffeineCutoff(db).enabled || caffeineMgOf(items) < CAFFEINE_FLOOR_MG) return null;
    let when: LogWhen | null = null;
    if (options.into) {
      when = mealWhen(db, options.into);
      if (when === null) return null;
    }
    // This save may be the first touch of the day (a cold launch from the
    // Action Button straight into Describe): arrive it, as Home does on every
    // read and as the training tick does, so today's rows exist to be read.
    arriveDay(db, todayISODate());
    return caffeineCheck(db, items, when, { priorMg: options.priorMg });
  } catch (error) {
    console.warn('[caffeine] cut-off check unavailable', error);
    return null;
  }
}

/** Run `save` — at once, or after *Log anyway* when the save breaks his rule. */
export function confirmCaffeine(
  items: readonly CaffeineItem[],
  save: () => void,
  options: ConfirmCaffeineOptions = {}
): void {
  const warning = warningFor(items, options);
  if (warning === null) {
    save();
    return;
  }
  Alert.alert(CAFFEINE_WARNING_TITLE, caffeineWarningMessage(warning), [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Log anyway', onPress: save },
  ]);
}
