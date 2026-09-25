import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { palette } from '@/constants/theme';
import { MINUTE_STEP, dateToTime, normalizeTime, timeToDate } from '@/lib/protocols/clock-time';
import { ArcTimePicker } from '@/lib/ui/date-time-picker';

/**
 * One clock time in Settings › Coach (0064): a row reading its label and the
 * time, which opens the iOS wheel beneath it when tapped.
 *
 * The wheel is the protocol editor's own (`ArcTimePicker`, the seam in
 * src/lib/ui/date-time-picker.ts, and the `HH:MM` <-> `Date` pair in
 * src/lib/protocols/clock-time.ts), so a time set here is the same five
 * characters a protocol item stores. Where the native wheel is absent — the
 * web preview, the headless render suite, a build before the dependency — it
 * falls back to a typed field, and a value that is not a clock time is never
 * written: the field keeps it, the setting does not change.
 *
 * Not `TimeWheel` itself: that component names its section "At" and speaks of
 * an item, and three of them stacked here would each wear its field device's
 * corner ticks inside the Notifications plate — a device nested in a device.
 * This row is a plate row like the model picker's, and the wheel is part of it.
 *
 * Conformed Set: the label is serif (words), the time is mono (a measure), and
 * nothing takes the accent — Settings spends none.
 */
export function ClockSetting({
  label,
  value,
  onChange,
}: {
  label: string;
  /** `HH:MM`. */
  value: string;
  /** Called with a valid `HH:MM` only. */
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  const commitDraft = () => {
    const next = normalizeTime(draft);
    if (next !== null && next !== value) onChange(next);
  };

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${label}, ${value}. ${open ? 'Close' : 'Change'}`}
        onPress={() => {
          setDraft(value);
          setOpen((was) => !was);
        }}
        className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
        <Text className="flex-1 font-serif text-[15px] text-ink">{label}</Text>
        <Text className="font-mono text-[13px] text-ink">{value}</Text>
      </Pressable>

      {open ? (
        ArcTimePicker ? (
          <ArcTimePicker
            value={timeToDate(value)}
            mode="time"
            display="spinner"
            minuteInterval={MINUTE_STEP}
            themeVariant="light"
            accessibilityLabel={label}
            onValueChange={(_event, date) => {
              const next = dateToTime(date);
              if (next !== null && next !== value) onChange(next);
            }}
          />
        ) : (
          <View className="pb-3">
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={commitDraft}
              onBlur={commitDraft}
              placeholder="07:30"
              placeholderTextColor={palette.inkMuted}
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              accessibilityLabel={label}
              className="w-24 border border-paper-deep bg-paper-dim px-3 py-2 font-mono text-[13px] text-ink"
            />
            <Text className="mt-1.5 font-serif text-[12px] leading-4 text-ink-muted">
              The wheel arrives with the next app build.
            </Text>
          </View>
        )
      ) : null}
    </View>
  );
}
