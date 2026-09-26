import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Divider } from '@/components/ui/block';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { shiftISODate, todayISODate } from '@/lib/db/date';
import {
  getScreenTime,
  markReceiptSeen,
  receiptSeenThrough,
  recentShortcutsWrite,
  screenTimeOn,
  undoScreenTime,
  type ScreenTimeEntry,
} from '@/lib/db/repositories/screen-time';
import { pickReceipt, receiptWords, undoneSentence } from '@/lib/screen-time/entry';
import {
  forgetTypedScreenTime,
  lastTypedScreenTime,
  subscribeTypedScreenTime,
} from '@/lib/screen-time/receipt-store';

/**
 * The write the row reports, from the record: the number typed this session
 * or the newest Shortcuts write not yet shown (`pickReceipt`). Read from the
 * rows, so an undone or replaced write stops drawing on its own.
 */
function readReceipt(): ScreenTimeEntry | null {
  const db = getDb();
  const today = todayISODate();
  const typedId = lastTypedScreenTime();
  return pickReceipt(
    typedId ? getScreenTime(db, typedId) : null,
    recentShortcutsWrite(db, shiftISODate(today, -1)),
    today,
    receiptSeenThrough(db)
  );
}

/** What the row shows: a write with its Undo, or what an Undo left behind. */
type Shown = { kind: 'live'; entry: ScreenTimeEntry } | { kind: 'undone'; said: string } | null;

function live(entry: ScreenTimeEntry | null): Shown {
  return entry ? { kind: 'live', entry } : null;
}

/**
 * **The screen-time receipt** — what the Log tab says back after a screen-time
 * number is filed, and the one place it can be taken back.
 *
 * It is needed because the number usually goes to a day the Log feed does not
 * show. Typed in the morning it is filed to YESTERDAY (the noon rule,
 * src/lib/screen-time/entry.ts), and a day's total is not a capture in
 * "Logged today" at all. Without this row the entry would vanish on send, and
 * a replace — one number per day — would overwrite yesterday's figure with
 * nothing on screen to say so. So the row names the day, the figure, and what
 * the day held before.
 *
 * **A Shortcuts write lands here too, once.** An automation can file the
 * number while the owner is asleep and iOS can reclaim the app before he opens
 * it, so the write is found from the record (`via: 'shortcuts'`, for yesterday
 * or today), not from memory. It is shown until he leaves the Log tab, and
 * then retired: on blur the newest write this focus drew is stamped as seen
 * (`markReceiptSeen`), and `pickReceipt` does not draw a Shortcuts write that
 * old again. A nightly automation therefore produces one receipt a night, not
 * a standing Undo on the capture surface.
 *
 * **After an Undo the row says what happened and offers nothing.** It does not
 * re-read the record into a fresh Undo: that would arm the next write it found
 * — another day's Shortcuts number, or the row the Undo just restored — under
 * a thumb still on the button, and a double tap would take back two numbers.
 * The "Undone" line stays until the next write or the next focus.
 *
 * Drawn the way the water receipt in quick-add-grid.tsx is drawn: a ruled row
 * of the block it sits in — the command field's well — never a second device;
 * a 15 pt glyph, the sentence in serif with its figure in mono (00-design-spec
 * §3: serif speaks, mono measures), and Undo in the label voice. No accent, no
 * timer, no motion: it waits, and the next write replaces it.
 *
 * Memoised, so a keystroke in the field above does not re-render it; its reads
 * run only on mount, focus and a noted write.
 */
export const ScreenTimeReceipt = memo(function ScreenTimeReceipt({
  onChanged,
}: {
  /** Called after an Undo, so the Log feed below re-reads. */
  onChanged?: () => void;
}) {
  // op-sqlite is synchronous, so the first read runs in the initializer.
  const [shown, setShown] = useState<Shown>(() => live(readReceipt()));
  // The newest write drawn during this focus — stamped as seen on blur.
  const drawnThrough = useRef<string | null>(null);

  const refresh = useCallback(() => {
    const entry = readReceipt();
    if (entry && (drawnThrough.current === null || entry.createdAt > drawnThrough.current)) {
      drawnThrough.current = entry.createdAt;
    }
    setShown(live(entry));
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
      return () => {
        const seen = drawnThrough.current;
        drawnThrough.current = null;
        if (!seen) return;
        try {
          markReceiptSeen(getDb(), seen);
        } catch (error) {
          console.warn('[log] screen time receipt stamp failed', error);
        }
      };
    }, [refresh])
  );
  // A typed write (here or on the keypad) re-reads; forgetting one does not.
  useEffect(() => subscribeTypedScreenTime(refresh), [refresh]);

  if (!shown) return null;

  if (shown.kind === 'undone') {
    return (
      <View className="mt-2.5">
        <Divider />
        <View className="mt-2 min-h-[44px] flex-row items-center gap-3">
          <Ionicons name="phone-portrait-outline" size={15} color={palette.inkSecondary} />
          <Text className="flex-1 font-serif text-[13px] leading-5 text-ink-secondary">
            {shown.said}
          </Text>
        </View>
      </View>
    );
  }

  const receipt = shown.entry;
  const words = receiptWords(receipt, todayISODate());

  const undo = () => {
    try {
      const db = getDb();
      const done = undoScreenTime(db, receipt.id);
      forgetTypedScreenTime(receipt.id);
      const now = done ? screenTimeOn(db, receipt.date) : null;
      setShown({
        kind: 'undone',
        said: done
          ? undoneSentence(receipt.date, now ? now.minutes : null)
          : 'That number is no longer on record, so there was nothing to undo.',
      });
      onChanged?.();
    } catch (error) {
      console.warn('[log] screen time undo failed', error);
    }
  };

  return (
    <View className="mt-2.5">
      <Divider />
      <View className="mt-2 min-h-[44px] flex-row items-center gap-3">
        <Ionicons name="phone-portrait-outline" size={15} color={palette.inkSecondary} />
        <Text className="flex-1 font-serif text-[13px] leading-5 text-ink-secondary">
          {words.said}
          <Text className="font-mono text-[11px] text-ink-secondary">{` · ${words.figure}`}</Text>
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={words.spoken}
          onPress={undo}
          className="min-h-[44px] items-center justify-center px-2 active:opacity-60">
          <Text className="font-label text-[12px] font-semibold text-ink">Undo</Text>
        </Pressable>
      </View>
    </View>
  );
});
