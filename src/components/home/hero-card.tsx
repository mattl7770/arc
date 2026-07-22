import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import type { MissionItem } from '@/types/home';

type Props = {
  item: MissionItem | null;
  onDone: (id: string) => void;
  onSnooze: (id: string) => void;
  onSkip: (id: string) => void;
};

/**
 * Section 2 — the "Do this next" hero.
 *
 * The only element on the screen allowed to use the accent colour, because it
 * is the only element that claims to be the single most important thing right
 * now. If everything is emphasised, nothing is directive.
 */
export function HeroCard({ item, onDone, onSnooze, onSkip }: Props) {
  if (!item) return <MissionComplete />;

  return (
    <View className="rounded-3xl border border-accent/20 bg-accent-soft p-5 dark:border-ink-800 dark:bg-ink-900">
      <Text className="text-xs font-medium uppercase tracking-widest text-accent-muted dark:text-accent">
        Do this next
      </Text>

      <Text className="mt-3 text-2xl font-semibold leading-8 tracking-tight text-ink-900 dark:text-ink-50">
        {item.title}
      </Text>

      <View className="mt-2 flex-row flex-wrap items-center gap-x-2">
        {item.window ? <Meta>{item.window}</Meta> : null}
        {item.estimatedMinutes ? (
          <>
            {item.window ? <Dot /> : null}
            <Meta>{item.estimatedMinutes} min</Meta>
          </>
        ) : null}
        {item.protocol ? (
          <>
            <Dot />
            <Meta>{item.protocol}</Meta>
          </>
        ) : null}
      </View>

      {item.why ? (
        <Text className="mt-4 text-[15px] leading-6 text-ink-700 dark:text-ink-300">
          {item.why}
        </Text>
      ) : null}

      <View className="mt-5 flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Mark ${item.title} done`}
          onPress={() => onDone(item.id)}
          className="flex-row items-center gap-1.5 rounded-full bg-accent px-5 py-2.5 active:opacity-70">
          <Ionicons name="checkmark" size={16} color="#FFFFFF" />
          <Text className="text-sm font-semibold text-white">Done</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Snooze ${item.title}`}
          onPress={() => onSnooze(item.id)}
          className="rounded-full border border-ink-300 px-4 py-2.5 active:opacity-60 dark:border-ink-700">
          <Text className="text-sm font-medium text-ink-700 dark:text-ink-300">Snooze</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Skip ${item.title}`}
          onPress={() => onSkip(item.id)}
          className="rounded-full px-3 py-2.5 active:opacity-60">
          <Text className="text-sm font-medium text-ink-500 dark:text-ink-400">Skip</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Shown once nothing is left. The reward for a clean day is a quiet screen. */
function MissionComplete() {
  return (
    <View className="items-center rounded-3xl border border-ink-200 bg-ink-50 px-5 py-8 dark:border-ink-800 dark:bg-ink-900">
      <View className="h-11 w-11 items-center justify-center rounded-full bg-signal-optimal">
        <Ionicons name="checkmark" size={22} color="#FFFFFF" />
      </View>
      <Text className="mt-4 text-lg font-semibold tracking-tight text-ink-900 dark:text-ink-50">
        Today is handled
      </Text>
      <Text className="mt-1 text-center text-sm leading-5 text-ink-500 dark:text-ink-400">
        Nothing left on the list. Protect the evening wind-down and let recovery do its work.
      </Text>
    </View>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  return <Text className="text-sm text-ink-500 dark:text-ink-400">{children}</Text>;
}

function Dot() {
  return <Text className="text-sm text-ink-300 dark:text-ink-700">·</Text>;
}
