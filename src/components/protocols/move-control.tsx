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
 * So this reuses `TIME_PRESETS`, `Chip` and `FormField` — the same six anchors,
 * the same typed field, the same keyboard — and ends in *Move* instead. The
 * reminder stays where it is set, in the per-item editor one tap away.
 *
 * A form, so **no block** (form (b) of the capture-surface rule): it opens
 * BELOW the verbs plate rather than inside it, because a recessed field on a
 * plate's raised stock is the surface inversion src/components/ui/block.tsx
 * exists to stop.
 */
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Chip, FormField, normalizeTime } from './form-controls';
import { TIME_PRESETS } from './time-control';

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
