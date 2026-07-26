import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import type { MissionItem, MissionStatus } from '@/types/home';

type Props = {
  item: MissionItem;
  onToggle: (id: string) => void;
};

/**
 * One line of Today's Mission. The whole row is the tap target, so completing
 * anything is a single tap from opening the app. Times are set in mono, like
 * every measured value in the app.
 *
 * Since the list went chronological (2026-07-24), the row carries its own
 * category — it is what tells you a 21:45 entry is a supplement and not a
 * meal, work the section heading used to do.
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
                ? 'flex-1 text-[15px] leading-5 text-ink-muted'
                : 'flex-1 text-[15px] leading-5 text-ink'
            }
            style={skipped ? { textDecorationLine: 'line-through' } : undefined}>
            {item.title}
          </Text>

          {item.scheduledTime ? (
            <Text className="font-mono text-[11px] text-ink-muted">{item.scheduledTime}</Text>
          ) : null}
        </View>

        {item.why && !muted ? (
          <Text className="mt-1 text-[13px] leading-5 text-ink-secondary">{item.why}</Text>
        ) : null}

        <View className="mt-1.5 flex-row items-center gap-2">
          <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">
            {item.category}
          </Text>
          {item.protocol ? (
            <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">
              · {item.protocol}
            </Text>
          ) : null}
          {item.snoozed && item.status === 'pending' ? (
            <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">· Snoozed</Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/** Completion state as a single 22pt control, stamped in pine when done. */
function StatusBox({ status }: { status: MissionStatus }) {
  if (status === 'completed') {
    return (
      <View className="h-[22px] w-[22px] items-center justify-center rounded-full bg-pine">
        <Ionicons name="checkmark" size={14} color={palette.pineOn} />
      </View>
    );
  }

  if (status === 'skipped') {
    return (
      <View className="h-[22px] w-[22px] items-center justify-center rounded-full border border-hairline-strong">
        <View className="h-[9px] w-[1.5px] rotate-90 bg-ink-muted" />
      </View>
    );
  }

  if (status === 'partial') {
    return (
      <View className="h-[22px] w-[22px] items-center justify-center rounded-full border-[1.5px] border-pine">
        <View className="h-2 w-2 rounded-full bg-pine" />
      </View>
    );
  }

  return <View className="h-[22px] w-[22px] rounded-full border-[1.5px] border-hairline-strong" />;
}
