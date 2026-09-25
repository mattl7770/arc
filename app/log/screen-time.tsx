import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import {
  screenTimeOn,
  recordScreenTime,
  undoScreenTime,
  type ScreenTimeWrite,
} from '@/lib/db/repositories/screen-time';
import { weekdayDate } from '@/lib/protocols/format';
import {
  filedDayWords,
  formatHm,
  parseScreenTimeLink,
  type ScreenTimeLinkParams,
} from '@/lib/screen-time/entry';

/**
 * **`arc://log/screen-time?minutes=N&date=YYYY-MM-DD`** — where a Shortcut
 * hands ARC a day's screen-time total with no typing.
 *
 * Built ahead of the owner's check (2026-09-25): iOS 26's Shortcuts has a
 * Screen Time action, "Get App & Website Data", and nobody has yet seen what
 * it returns. If it returns a day's total, a nightly Personal Automation can
 * open this link; if it does not, this screen is simply never reached. The
 * setup is docs/screen-time.md and Settings › Screen time.
 *
 * ## What is honest for a write nobody is awake for
 *
 * The automation may run at 23:55 with the phone on the nightstand. A confirm
 * card would wait for a tap that does not come and the number would be lost,
 * so there is none: **the link writes at once**, and honesty moves to what
 * happens after.
 *
 *   - **Strict before anything is written.** Whole minutes 1–1440, a real
 *     date, not in the future, not more than 30 days back, both params present
 *     (`parseScreenTimeLink`). A refused link writes nothing and this screen
 *     says exactly why, which is what he sees the first time he runs the
 *     Shortcut by hand.
 *   - **Marked as the Shortcut's.** The row says `via: shortcuts`; this screen,
 *     the Log tab's receipt and the Coach all report it that way.
 *   - **Undo on the next open, whichever screen that is.** If iOS keeps ARC in
 *     memory overnight, the next open is THIS screen, with its Undo. If iOS
 *     reclaims it, the Log tab's receipt finds the write from the record
 *     (src/components/log/screen-time-receipt.tsx). Undo takes the number off
 *     and puts back what the day held before (`undoScreenTime`).
 *   - **A repeated link is not a second write.** The same number for the same
 *     day writes nothing (`wrote: false`), so a Shortcut that fires twice, or
 *     this screen mounting twice, leaves one row and an Undo that still
 *     restores what the FIRST write replaced.
 *
 * No network and no model call: the number goes from the URL to SQLite.
 *
 * ## Why the write happens in render
 *
 * In a state initializer, and again (the "adjust state while rendering"
 * pattern) when the params change — which they do when a second night's link
 * reaches this screen while the first night's is still on top of the stack,
 * since a stack navigates to an existing route by updating its params. An
 * effect would miss nothing on device but would leave the headless render
 * suite unable to see the outcome; and the write is idempotent, so a render
 * that runs twice costs nothing.
 *
 * Surface: `StackHeader` with a bare chevron (the link can be opened over any
 * tab, so no parent can be named truthfully), a measured field for the figure,
 * a plate for what happened and the Undo, and a margin note for where the
 * number goes next. No accent: nothing here is the day's next action.
 */

type Outcome = { kind: 'filed'; write: ScreenTimeWrite } | { kind: 'refused'; reason: string };

type Landed = {
  /** The params this outcome is for — a new pair is a new link. */
  key: string;
  outcome: Outcome;
  /** After an Undo: what the day holds now, or that the write had already gone. */
  undone: null | { restored: string | null } | 'gone';
};

function paramKey(params: ScreenTimeLinkParams): string {
  return JSON.stringify([params.minutes ?? null, params.date ?? null]);
}

function land(params: ScreenTimeLinkParams): Landed {
  const link = parseScreenTimeLink(params, new Date());
  if (!link.ok) {
    return {
      key: paramKey(params),
      outcome: { kind: 'refused', reason: link.reason },
      undone: null,
    };
  }
  try {
    const write = recordScreenTime(getDb(), link.date, link.minutes, 'shortcuts');
    return { key: paramKey(params), outcome: { kind: 'filed', write }, undone: null };
  } catch (error) {
    console.warn('[screen-time] link write failed', error);
    return {
      key: paramKey(params),
      outcome: { kind: 'refused', reason: 'The number could not be saved to the record.' },
      undone: null,
    };
  }
}

/** "3h 5m typed on Log" / "3h 20m from Shortcuts" — what a replaced number was. */
function replacedWords(write: ScreenTimeWrite): string | null {
  const was = write.replaced[write.replaced.length - 1];
  if (!was) return null;
  return `${formatHm(was.minutes)} ${was.via === 'shortcuts' ? 'from Shortcuts' : 'typed on Log'}`;
}

export default function ScreenTimeLinkScreen() {
  const params = useLocalSearchParams<ScreenTimeLinkParams>();
  const [landed, setLanded] = useState(() => land(params));
  // A second link while this screen is still mounted: its own write, its own
  // outcome, its own Undo.
  if (landed.key !== paramKey(params)) setLanded(land(params));

  const today = todayISODate();
  const { outcome, undone } = landed;
  const write = outcome.kind === 'filed' ? outcome.write : null;

  const undo = () => {
    if (!write) return;
    try {
      const db = getDb();
      if (!undoScreenTime(db, write.id)) {
        setLanded({ ...landed, undone: 'gone' });
        return;
      }
      const now = screenTimeOn(db, write.date);
      setLanded({ ...landed, undone: { restored: now ? formatHm(now.minutes) : null } });
    } catch (error) {
      console.warn('[screen-time] undo failed', error);
    }
  };

  // The sentence the plate carries — one of five, each a plain statement of
  // what the record now holds.
  let said: string;
  if (!write) {
    said = `Nothing saved. ${outcome.kind === 'refused' ? outcome.reason : ''}`;
  } else if (undone === 'gone') {
    said = 'This number is no longer on record, so there was nothing to undo.';
  } else if (undone) {
    said = undone.restored
      ? `Undone. ${weekdayDate(write.date)} is back to ${undone.restored}.`
      : `Undone. Nothing is on record for ${weekdayDate(write.date)}.`;
  } else if (!write.wrote) {
    said = `Already on record for ${filedDayWords(write.date, today)}. The link carried the same number.`;
  } else {
    const was = replacedWords(write);
    said = was
      ? `Saved for ${filedDayWords(write.date, today)}. It replaced ${was}.`
      : `Saved for ${filedDayWords(write.date, today)}.`;
  }

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Screen time" />
      </View>

      {/* The figure — a measured field, like the keypad's readout. An em-dash
          when nothing was saved: no data, no number. */}
      <View className="mt-6">
        <Block device="field">
          <Text
            className={
              write && !undone
                ? 'text-center font-mono text-5xl font-semibold text-ink'
                : 'text-center font-mono text-5xl font-semibold text-ink-muted'
            }>
            {write ? formatHm(write.minutes) : '—'}
          </Text>
          <Text className="mt-2 text-center font-mono text-[11px] text-ink-muted">
            {write ? `${weekdayDate(write.date)} · from Shortcuts` : 'Nothing saved'}
          </Text>
        </Block>
      </View>

      <View className="mt-6">
        <Block device="plate">
          <SectionLabel label="From a Shortcut" />
          <Text className="mt-2 font-serif text-[15px] leading-6 text-ink">{said}</Text>
          {write && undone === null ? (
            <View className="mt-3">
              <Divider />
              <View className="mt-2 min-h-[44px] flex-row items-center gap-3">
                <Text className="flex-1 font-serif text-[13px] leading-5 text-ink-secondary">
                  Undo takes it off and puts back what the day held before.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Undo screen time ${formatHm(write.minutes)} for ${weekdayDate(write.date)}`}
                  onPress={undo}
                  className="min-h-[44px] items-center justify-center px-2 active:opacity-60">
                  <Text className="font-label text-[12px] font-semibold text-ink">Undo</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </Block>
      </View>

      {/* Where the number went, or where the link is explained. Nothing after
          an Undo: the plate above already says what the day holds. */}
      {undone === null ? (
        <View className="mt-6">
          <Block device="margin">
            <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
              {write
                ? 'The number is on the Data tab’s Screen time row, and the Coach sees it with the rest of the day.'
                : 'The link format and the Shortcut steps are in Settings › Screen time.'}
            </Text>
          </Block>
        </View>
      ) : null}
    </Screen>
  );
}
