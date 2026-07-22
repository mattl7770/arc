import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import type { MissionItem, MissionStatus } from '@/types/home';

type Props = {
  item: MissionItem;
  onToggle: (id: string) => void;
};

/**
 * One line of Today's Mission. The whole row is the tap target, so completing
 * anything is a single tap from opening the app.
 */
export function MissionItemRow({ item, onToggle }: Props) {
  const done = item.status === 'completed';
  const skipped = item.status === 'skipped';
  const muted = done || skipped;

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done }}
      accessibilityLabel={item.title}
      onPress={() => onToggle(item.id)}
      className="flex-row gap-3.5 py-3 active:opacity-60">
      <View className="pt-0.5">
        <StatusBox status={item.status} />
      </View>

      <View className="flex-1">
        <View className="flex-row items-start justify-between gap-3">
          <Text
            className={
              muted
                ? 'flex-1 text-[15px] leading-5 text-ink-400 dark:text-ink-600'
                : 'flex-1 text-[15px] leading-5 text-ink-900 dark:text-ink-100'
            }
            style={skipped ? { textDecorationLine: 'line-through' } : undefined}>
            {item.title}
          </Text>

          {item.window ? (
            <Text className="text-xs tabular-nums text-ink-400 dark:text-ink-600">
              {item.window}
            </Text>
          ) : null}
        </View>

        {item.why && !muted ? (
          <Text className="mt-1 text-[13px] leading-5 text-ink-500 dark:text-ink-400">
            {item.why}
          </Text>
        ) : null}

        <View className="mt-1.5 flex-row items-center gap-2">
          {item.protocol ? (
            <Text className="text-[11px] uppercase tracking-wider text-ink-400 dark:text-ink-600">
              {item.protocol}
            </Text>
          ) : null}
          {item.snoozed && item.status === 'pending' ? (
            <Text className="text-[11px] uppercase tracking-wider text-ink-400 dark:text-ink-600">
              · Snoozed
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/** Completion state as a single 22pt control. */
function StatusBox({ status }: { status: MissionStatus }) {
  if (status === 'completed') {
    return (
      <View className="h-[22px] w-[22px] items-center justify-center rounded-full bg-accent">
        <Ionicons name="checkmark" size={14} color="#FFFFFF" />
      </View>
    );
  }

  if (status === 'skipped') {
    return (
      <View className="h-[22px] w-[22px] items-center justify-center rounded-full border border-ink-300 dark:border-ink-700">
        <View className="h-[9px] w-[1.5px] rotate-90 bg-ink-400 dark:bg-ink-600" />
      </View>
    );
  }

  if (status === 'partial') {
    return (
      <View className="h-[22px] w-[22px] items-center justify-center rounded-full border-[1.5px] border-accent">
        <View className="h-2 w-2 rounded-full bg-accent" />
      </View>
    );
  }

  return (
    <View className="h-[22px] w-[22px] rounded-full border-[1.5px] border-ink-300 dark:border-ink-700" />
  );
}
