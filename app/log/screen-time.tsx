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
  noteShortcutsLink,
  recordScreenTime,
  screenTimeOn,
  undoScreenTime,
  type ScreenTimeEntry,
  type ScreenTimeWrite,
} from '@/lib/db/repositories/screen-time';
import { weekdayDate } from '@/lib/protocols/format';
import {
  filedDayWords,
  formatHm,
  linkConfirmWords,
  linkWritesSilently,
  parseScreenTimeLink,
  undoneSentence,
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
 * so for the case the automation exists for there is none. The plan of record
 * (docs/spikes/screen-time.md §4 (e)) said "confirm and write"; this departs
 * from it only as far as that case needs:
 *
 *   - **Strict before anything is written.** Whole minutes 1–1440, a real
 *     date, not in the future, not more than 30 days back, both params present
 *     (`parseScreenTimeLink`). A refused link writes nothing and this screen
 *     says exactly why, which is what he sees the first time he runs the
 *     Shortcut by hand.
 *   - **Silent only for calendar today or yesterday, and only over nothing or
 *     an earlier Shortcuts number** (`linkWritesSilently`). An older date, or a
 *     day holding a number he TYPED, gets a confirm card instead — Save or
 *     Keep, nothing written until a tap. An automation never sends an older
 *     date, and his own reading of a day is not something one replaces behind
 *     his back.
 *   - **The same number is not a write.** A link carrying what the day already
 *     holds, from either door, writes nothing and says so.
 *   - **Marked as the Shortcut's.** The row says `via: shortcuts`; this screen,
 *     the Log tab's receipt, Data and the Coach all report it that way. Every
 *     valid link is also noted in the Shortcuts cursor, which is how Settings
 *     can say an automation has been running after a typed correction has
 *     replaced its row.
 *   - **Where the Undo is.** On this screen while it is open — if iOS keeps
 *     ARC in memory overnight, it is what he sees on unlock. If iOS reclaims
 *     the app, a cold start opens on Home, and the Undo is on the Log tab's
 *     receipt the next time he opens that tab: it finds a Shortcuts write for
 *     yesterday or today from the record and shows it once
 *     (src/components/log/screen-time-receipt.tsx). Undo takes the number off
 *     and puts back what the day held before (`undoScreenTime`).
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
 * that runs twice costs nothing. A confirm card writes only on its tap, after
 * re-reading the day: if it moved while the card was up, the card is redrawn
 * for what the day holds now rather than replacing something it never named.
 *
 * Surface: `StackHeader` with a bare chevron (the link can be opened over any
 * tab, so no parent can be named truthfully), a measured field for the figure,
 * a plate for what happened and the Undo (or the choice), and a margin note
 * for where the number goes next. The confirm card's Save is the screen's one
 * pine action, and only while a choice is waiting; nothing else is accented.
 */

type Outcome =
  | { kind: 'filed'; write: ScreenTimeWrite }
  | { kind: 'confirm'; date: string; minutes: number; held: ScreenTimeEntry | null }
  | { kind: 'declined'; date: string; held: ScreenTimeEntry | null }
  | { kind: 'refused'; reason: string };

type Landed = {
  /** The params this outcome is for — a new pair is a new link. */
  key: string;
  outcome: Outcome;
  /** After an Undo: what the day holds now, or that the write had already gone. */
  undone: null | { said: string } | 'gone';
};

function paramKey(params: ScreenTimeLinkParams): string {
  return JSON.stringify([params.minutes ?? null, params.date ?? null]);
}

function land(params: ScreenTimeLinkParams): Landed {
  const key = paramKey(params);
  const now = new Date();
  const link = parseScreenTimeLink(params, now);
  if (!link.ok) {
    return { key, outcome: { kind: 'refused', reason: link.reason }, undone: null };
  }
  try {
    const db = getDb();
    noteShortcutsLink(db, link.date, link.minutes);
    const held = screenTimeOn(db, link.date);
    if (held && held.minutes === link.minutes) {
      // Already on record, from either door: nothing to write.
      return { key, outcome: { kind: 'filed', write: { ...held, wrote: false } }, undone: null };
    }
    if (!linkWritesSilently(link.date, held, now)) {
      return {
        key,
        outcome: { kind: 'confirm', date: link.date, minutes: link.minutes, held },
        undone: null,
      };
    }
    const write = recordScreenTime(db, link.date, link.minutes, 'shortcuts');
    return { key, outcome: { kind: 'filed', write }, undone: null };
  } catch (error) {
    console.warn('[screen-time] link write failed', error);
    return {
      key,
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
  // Undo only for a number this door put there. "Already on record" over a
  // typed number offers none: that Undo would take back HIS entry.
  const canUndo = write !== null && write.via === 'shortcuts' && undone === null;

  const undo = () => {
    if (!write) return;
    try {
      const db = getDb();
      if (!undoScreenTime(db, write.id)) {
        setLanded({ ...landed, undone: 'gone' });
        return;
      }
      const now = screenTimeOn(db, write.date);
      setLanded({ ...landed, undone: { said: undoneSentence(write.date, now ? now.minutes : null) } });
    } catch (error) {
      console.warn('[screen-time] undo failed', error);
    }
  };

  const save = () => {
    if (outcome.kind !== 'confirm') return;
    try {
      const db = getDb();
      const holds = screenTimeOn(db, outcome.date);
      if ((holds?.id ?? null) !== (outcome.held?.id ?? null)) {
        // The day moved while the card was up: redraw for what it holds now.
        setLanded(land(params));
        return;
      }
      const saved = recordScreenTime(db, outcome.date, outcome.minutes, 'shortcuts');
      setLanded({ ...landed, outcome: { kind: 'filed', write: saved } });
    } catch (error) {
      console.warn('[screen-time] confirmed write failed', error);
    }
  };

  const keep = () => {
    if (outcome.kind !== 'confirm') return;
    setLanded({ ...landed, outcome: { kind: 'declined', date: outcome.date, held: outcome.held } });
  };

  // The sentence the plate carries — each a plain statement of what the record
  // now holds, or of the one choice waiting.
  const confirm =
    outcome.kind === 'confirm'
      ? linkConfirmWords(outcome.date, outcome.minutes, outcome.held)
      : null;
  let said: string;
  if (outcome.kind === 'refused') {
    said = `Nothing saved. ${outcome.reason}`;
  } else if (outcome.kind === 'declined') {
    said = outcome.held
      ? `Nothing saved. ${weekdayDate(outcome.date)} keeps ${formatHm(outcome.held.minutes)}.`
      : `Nothing saved for ${weekdayDate(outcome.date)}.`;
  } else if (confirm) {
    said = confirm.said;
  } else if (undone === 'gone') {
    said = 'This number is no longer on record, so there was nothing to undo.';
  } else if (undone) {
    said = undone.said;
  } else if (write && !write.wrote) {
    said =
      write.via === 'shortcuts'
        ? `Already on record for ${filedDayWords(write.date, today)}. The link carried the same number.`
        : `Already on record for ${filedDayWords(write.date, today)}, typed on Log. The link carried the same number.`;
  } else if (write) {
    const was = replacedWords(write);
    said = was
      ? `Saved for ${filedDayWords(write.date, today)}. It replaced ${was}.`
      : `Saved for ${filedDayWords(write.date, today)}.`;
  } else {
    said = 'Nothing saved.';
  }

  // The field's figure: the number on record, the number waiting on the
  // card, or an em-dash when nothing was saved — no data, no number.
  const figure = write
    ? formatHm(write.minutes)
    : outcome.kind === 'confirm'
      ? formatHm(outcome.minutes)
      : '—';
  const figureOn = write !== null && !undone;
  const caption = write
    ? `${weekdayDate(write.date)} · ${write.via === 'shortcuts' ? 'from Shortcuts' : 'typed on Log'}`
    : outcome.kind === 'confirm'
      ? `${weekdayDate(outcome.date)} · from Shortcuts, not saved yet`
      : 'Nothing saved';

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Screen time" />
      </View>

      <View className="mt-6">
        <Block device="field">
          <Text
            className={
              figureOn
                ? 'text-center font-mono text-5xl font-semibold text-ink'
                : 'text-center font-mono text-5xl font-semibold text-ink-muted'
            }>
            {figure}
          </Text>
          <Text className="mt-2 text-center font-mono text-[11px] text-ink-muted">{caption}</Text>
        </Block>
      </View>

      <View className="mt-6">
        <Block device="plate">
          <SectionLabel label="From a Shortcut" />
          <Text className="mt-2 font-serif text-[15px] leading-6 text-ink">{said}</Text>
          {canUndo && write ? (
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
          {confirm ? (
            <View className="mt-4">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={confirm.save}
                onPress={save}
                className="min-h-[48px] items-center justify-center rounded-btn bg-pine active:opacity-70">
                <Text className="font-label text-[15px] font-semibold text-pine-on">
                  {confirm.save}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={confirm.keep}
                onPress={keep}
                className="mt-2 min-h-[44px] items-center justify-center active:opacity-60">
                <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
                  {confirm.keep}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </Block>
      </View>

      {/* Where the number went, or where the link is explained. Nothing after
          an Undo or around a choice: the plate already says it. */}
      {undone === null && (outcome.kind === 'filed' || outcome.kind === 'refused') ? (
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
