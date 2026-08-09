import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import type { ReminderRow } from '@/lib/reminders/types';

/**
 * Section: active reminders — the in-app surfacing of rows the user or the
 * Coach created (0009_reminders.sql). Renders nothing when empty.
 *
 * A reminder with a time is ALSO handed to the OS as a local notification, so it
 * can fire while the app is closed (src/lib/notifications/reminders.ts, resynced
 * at boot and after every Coach turn) — when the running build has the
 * notifications native module, permission is granted, and the moment is still
 * ahead. None of that is guaranteed, so this list is the floor, not a fallback:
 * an untimed reminder, or a timed one the OS never accepted, lives here and
 * nowhere else. Nothing in this UI should claim a phone alert will arrive.
 *
 * ## Conformed Set treatment
 *
 * The **ruled plate** device — a schedule is a record, and a record is a table.
 * Titles are serif ("serif speaks"), the time/repeat/origin line is mono ("mono
 * measures"), and the section note carries the tally so the block states its own
 * length instead of making you count rows.
 *
 * Both row controls are 44×44 and square. They were 32×32, which is under the
 * tap floor this design treats as non-negotiable (§4) — and they are the two
 * controls most likely to be hit one-handed in the dark.
 */
export function RemindersCard({
  reminders,
  onComplete,
  onDismiss,
}: {
  reminders: ReminderRow[];
  onComplete: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (reminders.length === 0) return null;

  return (
    <Block device="plate">
      <SectionLabel
        label="Reminders"
        note={reminders.length === 1 ? '1 active' : `${reminders.length} active`}
      />

      <View className="mt-1">
        {reminders.map((reminder) => (
          <View
            key={reminder.id}
            className="min-h-[44px] flex-row items-center gap-3 border-t border-hairline py-2">
            <View className="flex-1">
              <Text className="font-serif text-[15px] leading-5 text-ink">{reminder.title}</Text>
              <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                {reminder.time ?? 'anytime'}
                {reminder.repeat !== 'once' ? ` · ${reminder.repeat}` : ''}
                {reminder.created_by === 'ai' ? ' · via Coach' : ''}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Mark "${reminder.title}" done`}
              onPress={() => onComplete(reminder.id)}
              className="h-11 w-11 items-center justify-center border border-hairline active:opacity-60">
              <Ionicons name="checkmark" size={17} color={palette.inkSecondary} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Dismiss "${reminder.title}"`}
              onPress={() => onDismiss(reminder.id)}
              className="h-11 w-11 items-center justify-center border border-hairline active:opacity-60">
              <Ionicons name="close" size={17} color={palette.inkMuted} />
            </Pressable>
          </View>
        ))}
      </View>
    </Block>
  );
}
