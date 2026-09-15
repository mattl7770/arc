import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import {
  canStepBack,
  canStepForward,
  dayLabel,
  stepDay,
  type DayBounds,
} from '@/lib/utils/day-cursor';

/**
 * **The day in view, and the two arrows that move it.** A shared control,
 * because the second screen that needed one was going to copy the first.
 *
 * Built for the nutrition history's day view (backlog C1 — *"see past days food
 * logs"*), and deliberately shaped so Today's Mission can reuse it unchanged
 * when that screen learns to look backwards: nothing here knows what is being
 * paged, only which day is selected and which days are reachable.
 *
 * ## It cannot step onto a day that has not happened
 *
 * `bounds.latest` is the LOGICAL today — the owner's configurable day boundary
 * (B3, src/lib/db/date.ts), not the calendar's. With a 04:00 boundary, 01:00 on
 * Wednesday is still Tuesday everywhere else in the app, and a picker that
 * offered "Wednesday" then would let the user open a day the rest of ARC says
 * has not started, and log into it. So the forward arrow is disabled at the
 * bound, and {@link stepDay} clamps as well: a live-looking arrow that does
 * nothing is one failure, and a caller that can write past the bound from some
 * other path is the other.
 *
 * `bounds.earliest` is optional and is the caller's floor — the nutrition
 * history passes the first day it ever logged, so the cursor cannot wander back
 * through years of days that never existed.
 *
 * All of the arithmetic is in src/lib/utils/day-cursor.ts, which does all of ITS
 * arithmetic through src/lib/db/date.ts. Nothing in this file computes a day.
 *
 * ## The shape, and the one thing that is not in the row
 *
 * `‹  Tue 9 Sep  ›` — two 44pt targets flanking a centred mono chin, because a
 * date is a measured value. The **return to today** is NOT in that row: putting
 * it beside the forward arrow either shifts the chin off centre when it appears
 * or reserves an empty slot for it when it does not. It sits under the row
 * instead, and only while the cursor is behind today — which is exactly when it
 * is wanted, and it retires the moment it is satisfied (the same rule the Eat
 * tab's "Set daily targets" follows).
 *
 * ## Surface
 *
 * No device (src/components/ui/block.tsx): this is a control row, not a record,
 * a field or a reading. Bare on the sheet, like the history screen's window
 * chips it sits above. Outlined ink throughout — **no accent**: moving the day
 * in view is navigation, not the screen's next action, and a pine arrow would
 * claim it was.
 *
 * A disabled arrow keeps its outline and drops to `ink-muted` rather than
 * disappearing, so the bound reads as a bound rather than as a missing control.
 * Whole class strings on both branches — Tailwind's scanner only sees names that
 * appear literally in source, so a built fragment would ship unstyled.
 */

/** A 44pt arrow. Disabled keeps its outline and loses its ink. */
function Arrow({
  direction,
  enabled,
  label,
  onPress,
}: {
  direction: 'back' | 'forward';
  enabled: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      className={
        enabled
          ? 'h-11 w-11 items-center justify-center rounded-btn border border-hairline active:bg-paper-dim'
          : 'h-11 w-11 items-center justify-center rounded-btn border border-hairline-soft'
      }>
      <Ionicons
        name={direction === 'back' ? 'chevron-back' : 'chevron-forward'}
        size={18}
        color={enabled ? palette.inkSecondary : palette.inkMuted}
      />
    </Pressable>
  );
}

export type DayPickerProps = {
  /** The day in view, `YYYY-MM-DD`. */
  date: string;
  /** Which days are reachable. `latest` must be the logical today. */
  bounds: DayBounds;
  /** The chosen day — always inside `bounds`, so a caller can write it as-is. */
  onChange: (date: string) => void;
  /**
   * What is being paged, for the screen reader: "food log", "mission". Read as
   * *"Previous day's food log"*. Defaults to the bare day.
   */
  subject?: string;
};

export function DayPicker({ date, bounds, onChange, subject }: DayPickerProps) {
  const back = canStepBack(date, bounds);
  const forward = canStepForward(date, bounds);
  const of = subject ?? 'day';
  const onToday = date === bounds.latest;

  return (
    <View>
      <View className="flex-row items-center gap-2">
        <Arrow
          direction="back"
          enabled={back}
          label={`Previous ${of}`}
          onPress={() => onChange(stepDay(date, -1, bounds))}
        />
        {/* A date is a measured value, so mono — and it is the row's subject,
            so it takes the ink the arrows do not. */}
        <Text className="flex-1 text-center font-mono text-[15px] text-ink">
          {dayLabel(date, bounds.latest)}
        </Text>
        <Arrow
          direction="forward"
          enabled={forward}
          label={`Next ${of}`}
          onPress={() => onChange(stepDay(date, 1, bounds))}
        />
      </View>

      {/* The way home. Outlined, never pine, and gone the moment it is
          satisfied — an affordance that survives its own success is noise. */}
      {onToday ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Back to today's ${of}`}
          onPress={() => onChange(bounds.latest)}
          className="mt-2 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-2 active:bg-paper-dim">
          <Ionicons name="today-outline" size={15} color={palette.inkSecondary} />
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
            Back to today
          </Text>
        </Pressable>
      )}
    </View>
  );
}
