import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import type { CoachItemView } from '@/lib/home/day-plan';

type Props = {
  item: CoachItemView;
  /** True on the one row the hero is also showing. */
  active?: boolean;
  onOpen: (key: string) => void;
  onDismiss: (key: string) => void;
};

/**
 * A Coach item in Today's Mission (smart day, 0067) — an UNCOUNTED row.
 *
 * The owner's answer to the spike's Q1: Coach items appear in the checklist as
 * well as the hero, because a hero the list does not contain breaks the rule
 * that the two can never disagree (docs/home-screen.md). But a Coach item is
 * not a mission row, and the row says so three ways, each where the eye already
 * looks on a mission row:
 *
 *   - **No checkbox.** The 22pt slot a mission row spends on its tick box holds
 *     a plain forward arrow instead: this row is a door, not a thing to tick.
 *     Tapping it opens its destination; it clears when that action's data
 *     arrives, never because it was tapped "done".
 *   - **"Coach · not counted"** in the category slot, label voice, muted. The
 *     tally above ("3 of 8") and the tick strip are computed from mission rows
 *     only (src/components/home/mission.tsx), so this row adds nothing to
 *     either — the words make that visible rather than leaving the reader to
 *     notice the count did not move.
 *   - **Its own Dismiss**, a quiet × beside it, because a Coach item cannot be
 *     skipped: skipping is a statement about adherence, and this row has none.
 *
 * No accent, no signal colour: the accent budget on Home is the hero, the
 * completion stamps and the active tab, and this row is none of them. Mono for
 * the `until` time (a measured value), serif for the title, label for the rest.
 */
export function CoachItemRow({ item, active = false, onOpen, onDismiss }: Props) {
  const spoken = [
    item.until ? `until ${item.until}` : null,
    item.title,
    'Coach item, not counted',
    item.button,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View className="flex-row items-center">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={spoken}
        onPress={() => onOpen(item.key)}
        className="min-h-[44px] flex-1 flex-row gap-3 py-3 active:opacity-60">
        <View className="h-[22px] w-[22px] items-center justify-center pt-0.5">
          <Ionicons name="arrow-forward" size={14} color={palette.inkMuted} />
        </View>
        <View className="flex-1 flex-row items-baseline gap-2">
          {item.until ? (
            <Text className="font-mono text-[11px] text-ink-secondary">{`until ${item.until}`}</Text>
          ) : null}
          <Text numberOfLines={1} className={active ? TITLE.active : TITLE.plain}>
            {item.title}
          </Text>
          <Text
            numberOfLines={1}
            className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            Coach · not counted
          </Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Dismiss ${item.title}`}
        onPress={() => onDismiss(item.key)}
        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
        className="min-h-[44px] justify-center pl-2 active:opacity-50">
        <Ionicons name="close" size={16} color={palette.inkMuted} />
      </Pressable>
    </View>
  );
}

/** Whole class strings — Tailwind's scanner only sees literals. */
const TITLE = {
  active: 'flex-1 font-serif text-[14px] font-semibold leading-5 text-ink',
  plain: 'flex-1 font-serif text-[14px] leading-5 text-ink',
} as const;
