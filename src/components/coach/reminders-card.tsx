import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import type { ReminderRow } from '@/lib/reminders/types';

/**
 * Section: active reminders — the in-app surfacing seam for rows the user or
 * the Coach created (0006_reminders.sql). Renders nothing when empty. OS
 * notification delivery is a flagged native dependency; until it lands, this
 * list IS the reminder.
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
    <View className="mb-4 rounded-card border border-hairline bg-porcelain px-4 py-3">
      <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
        Reminders
      </Text>
      {reminders.map((reminder) => (
        <View
          key={reminder.id}
          className="mt-2.5 flex-row items-center gap-3 border-t border-hairline-soft pt-2.5">
          <View className="flex-1">
            <Text className="text-[14px] leading-5 text-ink">{reminder.title}</Text>
            <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">
              {reminder.time ?? 'anytime'}
              {reminder.repeat !== 'once' ? ` · ${reminder.repeat}` : ''}
              {reminder.created_by === 'ai' ? ' · via Coach' : ''}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Mark "${reminder.title}" done`}
            onPress={() => onComplete(reminder.id)}
            className="h-8 w-8 items-center justify-center rounded-btn border border-hairline-strong active:opacity-60">
            <Ionicons name="checkmark" size={16} color={palette.inkSecondary} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Dismiss "${reminder.title}"`}
            onPress={() => onDismiss(reminder.id)}
            className="h-8 w-8 items-center justify-center rounded-btn border border-hairline-strong active:opacity-60">
            <Ionicons name="close" size={16} color={palette.inkMuted} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}
