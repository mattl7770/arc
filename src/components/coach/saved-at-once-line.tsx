import { Pressable, Text, View } from 'react-native';

import type { SavedAtOnceView } from '@/hooks/use-coach-chat';

/**
 * A receipt for a write that SAVED AT ONCE (owner, 2026-10-21, write-gate.ts
 * "Saving at once"): the same mono line an approved card leaves, with what he
 * can still do about it beside it. No card was shown, so this line is the
 * consent's stand-in: the Undo sits on it, not somewhere he has to look for.
 *
 *   open     → the line, and an Undo button
 *   undone   → the line struck through, "Undone"
 *   refused  → the line, and why it was not removed
 *   closed   → the line alone: the session that saved it has ended, and the
 *              row is undone on its own screen like any other
 *
 * Workflow state, so neutral ink throughout — the Undo is not an accent.
 */
export function SavedAtOnceLine({
  line,
  saved,
  onUndo,
}: {
  line: string;
  saved: SavedAtOnceView;
  onUndo?: (key: string) => void;
}) {
  const undone = saved.state === 'undone';
  return (
    <View className="mt-0.5">
      <View className="flex-row items-center gap-2">
        <Text
          className={`flex-1 font-mono text-[11px] leading-4 ${undone ? 'text-ink-muted' : 'text-ink'}`}
          style={undone ? { textDecorationLine: 'line-through' } : undefined}>
          {line}
        </Text>
        {saved.state === 'open' && saved.key && onUndo ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Undo: ${line}`}
            hitSlop={8}
            onPress={() => onUndo(saved.key!)}
            className="min-h-[28px] items-center justify-center rounded-btn border border-hairline px-2.5 active:bg-paper-dim">
            <Text className="font-label text-[11px] font-semibold text-ink">Undo</Text>
          </Pressable>
        ) : null}
        {undone ? (
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
            Undone
          </Text>
        ) : null}
      </View>
      {saved.state === 'refused' ? (
        <Text className="mt-0.5 font-serif text-[12px] leading-5 text-ink-secondary">
          {`Not undone. ${saved.note ?? ''}`.trim()}
        </Text>
      ) : null}
    </View>
  );
}
