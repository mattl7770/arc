import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import type { MissionItem } from '@/types/home';

type Props = {
  item: MissionItem | null;
  /**
   * Whether today has a mission at all (mission total > 0). Passed in rather
   * than looked up, because a component must not reach for the database — and
   * without it a null `item` is ambiguous: it means both "you finished
   * everything" and "there was never anything". Congratulating someone for
   * completing a plan that never existed (pause your last protocol, open Home
   * the next morning) is the same fabrication as the mock day this replaced.
   */
  hasPlan: boolean;
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
export function HeroCard({ item, hasPlan, onDone, onSnooze, onSkip }: Props) {
  if (!item) return hasPlan ? <MissionComplete /> : <NoPlanToday />;

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

/**
 * Shown once nothing is left *of something that existed*. The reward for a
 * clean day is a quiet page. Only reachable when the day had items to begin
 * with — see `NoPlanToday` for the empty day.
 */
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

/**
 * No mission was generated for today — every protocol is paused, deleted, or
 * empty. States the fact and points at the single thing that fixes it.
 *
 * Deliberately not a completion state: no checkmark, no pine card, no
 * congratulation. An empty day is a gap to close, not an achievement, and the
 * home screen is only worth trusting if it refuses to flatter.
 */
function NoPlanToday() {
  const router = useRouter();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open Protocols to set up today’s plan"
      onPress={() => router.push('/protocols')}
      className="rounded-card border border-hairline bg-porcelain p-4 pb-5 active:opacity-70">
      <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
        No plan today
      </Text>

      <Text className="mt-2.5 font-serif text-[22px] font-semibold leading-7 text-ink">
        Nothing scheduled
      </Text>

      <Text className="mt-3 text-[15px] leading-6 text-ink-secondary">
        No active protocol is producing a mission for today. Build or activate one and the day fills
        itself in.
      </Text>

      <View className="mt-4 flex-row items-center gap-1">
        <Text className="text-sm font-medium text-pine">Data › Protocols</Text>
        <Ionicons name="chevron-forward" size={14} color={palette.pine} />
      </View>
    </Pressable>
  );
}
