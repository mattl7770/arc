import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import type { MissionItem } from '@/types/home';

type Props = {
  item: MissionItem | null;
  onDone: (id: string) => void;
  onSnooze: (id: string) => void;
  onSkip: (id: string) => void;
};

/**
 * Section 2 — the "Do this next" hero: a stamped ledger entry.
 *
 * Pine-soft card with a 3px solid pine rule across the top edge, serif
 * headline, mono metadata. The only element on the screen allowed to use the
 * accent, because it is the only element that claims to be the single most
 * important thing right now. If everything is emphasised, nothing is directive.
 */
export function HeroCard({ item, onDone, onSnooze, onSkip }: Props) {
  if (!item) return <MissionComplete />;

  const metadata = [
    item.scheduledTime,
    item.estimatedMinutes && `${item.estimatedMinutes} min`,
    item.protocol,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <View className="rounded-card border border-t-[3px] border-pine-tint border-t-pine bg-pine-soft p-4 pb-5">
      <Text className="text-[11px] font-medium uppercase tracking-[2px] text-pine">
        Do this next
      </Text>

      <Text className="mt-2.5 font-serif text-[22px] font-semibold leading-7 text-ink">
        {item.title}
      </Text>

      {metadata ? (
        <Text className="mt-1.5 font-mono text-xs text-ink-secondary">{metadata}</Text>
      ) : null}

      {item.why ? (
        <Text className="mt-3 text-[15px] leading-6 text-ink-secondary">{item.why}</Text>
      ) : null}

      <View className="mt-4 flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Mark ${item.title} done`}
          onPress={() => onDone(item.id)}
          className="flex-row items-center gap-1.5 rounded-btn bg-pine px-5 py-2.5 active:opacity-70">
          <Ionicons name="checkmark" size={16} color={palette.pineOn} />
          <Text className="text-sm font-semibold text-pine-on">Done</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Snooze ${item.title}`}
          onPress={() => onSnooze(item.id)}
          className="rounded-btn border border-hairline-strong px-4 py-2.5 active:opacity-60">
          <Text className="text-sm font-medium text-ink-secondary">Snooze</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Skip ${item.title}`}
          onPress={() => onSkip(item.id)}
          className="rounded-btn px-3 py-2.5 active:opacity-60">
          <Text className="text-sm font-medium text-ink-muted">Skip</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Shown once nothing is left. The reward for a clean day is a quiet page. */
function MissionComplete() {
  return (
    <View className="items-center rounded-card border border-hairline bg-porcelain px-5 py-8">
      <View className="h-11 w-11 items-center justify-center rounded-full bg-signal-optimal">
        <Ionicons name="checkmark" size={22} color={palette.pineOn} />
      </View>
      <Text className="mt-4 font-serif text-lg font-semibold text-ink">Today is handled</Text>
      <Text className="mt-1 text-center text-sm leading-5 text-ink-secondary">
        Nothing left on the list. Protect the evening wind-down and let recovery do its work.
      </Text>
    </View>
  );
}
