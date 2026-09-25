import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { memo, useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Divider } from '@/components/ui/block';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { shiftISODate, todayISODate } from '@/lib/db/date';
import {
  getScreenTime,
  recentShortcutsWrite,
  undoScreenTime,
  type ScreenTimeEntry,
} from '@/lib/db/repositories/screen-time';
import { receiptWords } from '@/lib/screen-time/entry';
import {
  lastTypedScreenTime,
  noteTypedScreenTime,
  subscribeTypedScreenTime,
} from '@/lib/screen-time/receipt-store';

/**
 * The newest of the two writes the Log tab reports: the number typed this
 * session (the command field or the keypad), and the latest number a Shortcut
 * filed for yesterday or today. Read from the rows, so an undone or replaced
 * write stops drawing on its own.
 */
function readReceipt(typedId: string | null, today: string): ScreenTimeEntry | null {
  const db = getDb();
  // Both bounded the same way: a number for a day older than yesterday is not
  // news any more, whichever door it came through.
  const since = shiftISODate(today, -1);
  const found = typedId ? getScreenTime(db, typedId) : null;
  const typed = found && found.date >= since ? found : null;
  const linked = recentShortcutsWrite(db, since);
  if (typed && linked) return typed.createdAt >= linked.createdAt ? typed : linked;
  return typed ?? linked;
}

/**
 * **The screen-time receipt** — what the Log tab says back after a screen-time
 * number is filed, and the one place it can be taken back.
 *
 * It is needed because the number usually goes to a day the Log feed does not
 * show. Typed in the morning it is filed to YESTERDAY (the noon rule,
 * src/lib/screen-time/entry.ts), and "Logged today" lists today. Without this
 * row the entry would vanish on send, and a replace — one number per day —
 * would overwrite yesterday's figure with nothing on screen to say so. So the
 * row names the day, the figure, and what the day held before.
 *
 * **A Shortcuts write lands here too.** An automation can file the number
 * while the owner is asleep and iOS can reclaim the app before he opens it, so
 * the row is found from the record (`via: 'shortcuts'`, for yesterday or
 * today), not from memory. Undo is the same for both: it takes the number off
 * and puts back whatever it replaced (`undoScreenTime`).
 *
 * Drawn the way the water receipt in quick-add-grid.tsx is drawn: a ruled row
 * of the block it sits in — the command field's well — never a second device;
 * a 15 pt glyph, the sentence in serif with its figure in mono (00-design-spec
 * §3: serif speaks, mono measures), and Undo in the label voice. No accent, no
 * timer, no motion: it waits, and the next write replaces it.
 *
 * Memoised, so a keystroke in the field above does not re-render it; its two
 * reads run only on mount, focus, a noted write and an Undo.
 */
export const ScreenTimeReceipt = memo(function ScreenTimeReceipt({
  onChanged,
}: {
  /** Called after an Undo, so the Log feed below re-reads. */
  onChanged?: () => void;
}) {
  // op-sqlite is synchronous, so the first read runs in the initializer. It
  // re-reads on focus (a keypad entry, or a Shortcuts link that landed while
  // the tab was elsewhere), when a typed write is noted, and after an Undo.
  const [receipt, setReceipt] = useState(() => readReceipt(lastTypedScreenTime(), todayISODate()));
  const refresh = useCallback(
    () => setReceipt(readReceipt(lastTypedScreenTime(), todayISODate())),
    []
  );
  useFocusEffect(refresh);
  useEffect(() => subscribeTypedScreenTime(refresh), [refresh]);

  if (!receipt) return null;
  const words = receiptWords(receipt, todayISODate());

  const undo = () => {
    try {
      undoScreenTime(getDb(), receipt.id);
      if (receipt.id === lastTypedScreenTime()) noteTypedScreenTime(null);
      refresh();
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
