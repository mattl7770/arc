/**
 * Move one mission row to another time today.
 *
 * ## Why this is not {@link TimeControl} (a departure, recorded)
 *
 * The plan drew this slot as the shared `TimeControl`. It cannot be: that
 * control's second half is the **reminder** toggle, and a reminder is a fact
 * about the protocol ITEM — it lives in the versioned content and applies on
 * every day the item lands. Moving today's row changes `log_entries
 * .scheduled_time` on one row of one day and touches no version at all. Drawing
 * "Remind me" here would offer a control that either does nothing or silently
 * edits the protocol from a screen about today, and both are worse than not
 * offering it.
 *
 * So this reuses `Chip` and `FormField` — the same typed field, the same
 * keyboard — and ends in *Move* instead. The reminder stays where it is set, in
 * the protocol editor one tap away (*Edit this item*). Since 2026-09-25 the
 * sheet's row reads *Move today …*, so its scope is in its name.
 *
 * Since 2026-09-21 the six anchor chips are this control's own: `TimeControl`
 * became an iOS wheel on the owner's note (*"needs a real wheel like a calendar
 * app"*) and `TIME_PRESETS` moved down here with them. Whether the wheel should
 * follow into this slot is open, and is argued at the constant below.
 *
 * A form, so **no block** (form (b) of the capture-surface rule): it opens
 * BELOW the verbs plate rather than inside it, because a recessed field on a
 * plate's raised stock is the surface inversion src/components/ui/block.tsx
 * exists to stop.
 */
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Chip } from '@/components/ui/chip';
import { normalizeTime } from '@/lib/protocols/clock-time';
import { FormField } from './form-controls';

/**
 * Anchor times offered as one tap each.
 *
 * Six, three hours apart across the waking day. They are deliberately round and
 * evenly spaced rather than tuned to any routine: a preset that guessed at the
 * user's morning would be wrong for most items and would read as advice. They
 * are a coarse jump to the right part of the day; the field beside them is how
 * you say 07:45.
 *
 * They were `TimeControl`'s until 2026-09-21, when that control became an iOS
 * wheel and stopped having presets at all. They moved here rather than being
 * deleted because a MOVE is a different act from an edit: it is one tap from a
 * mission row, on today only, and a wheel is three gestures where 'push it to
 * 18:00' is one. Whether this control should take the wheel too is a question
 * for hardware, not for symmetry.
 */
const TIME_PRESETS = ['07:00', '09:00', '12:00', '15:00', '18:00', '21:00'] as const;

export function MoveControl({
  initial,
  onMove,
}: {
  /** The row's current time, or '' when it is untimed. */
  initial: string;
  /** null clears the time — an untimed row sorts to the end of the day. */
  onMove: (time: string | null) => void;
}) {
  const [time, setTime] = useState(initial);
  const normalized = normalizeTime(time);
  const blank = time.trim() === '';
  const usable = blank || normalized !== null;

  return (
    <View className="mt-2">
      <View className="flex-row flex-wrap gap-1.5">
        {TIME_PRESETS.map((preset) => (
          <Chip
            key={preset}
            label={preset}
            compact
            on={normalized === preset}
            onPress={() => setTime(preset)}
          />
        ))}
        <Chip
          label="Any time"
          compact
          on={blank}
          accessibilityLabel="Clear the time"
          onPress={() => setTime('')}
        />
      </View>

      <View className="mt-2 flex-row items-center gap-2">
        <View className="w-24">
          <FormField
            value={time}
            onChange={setTime}
            placeholder="07:30"
            keyboardType="numbers-and-punctuation"
            maxLength={5}
            mono
            accessibilityLabel="New time"
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={blank ? 'Move to any time' : `Move to ${time}`}
          accessibilityState={{ disabled: !usable }}
          disabled={!usable}
          onPress={() => onMove(blank ? null : normalized)}
          className={`min-h-[44px] justify-center rounded-btn border px-4 py-2 ${
            usable ? 'border-ink active:bg-paper-dim' : 'border-hairline'
          }`}>
          <Text
            className={`font-label text-[13px] font-semibold ${
              usable ? 'text-ink' : 'text-ink-muted'
            }`}>
            Move
          </Text>
        </Pressable>
      </View>

      {usable ? null : (
        /* Authored, never blank: the refusal says what would fix it. */
        <Text className="mt-1.5 font-serif text-[12px] leading-4 text-ink-muted">
          A time reads as HH:MM, on the 24-hour clock.
        </Text>
      )}
    </View>
  );
}
