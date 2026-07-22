import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

/**
 * Section 4 — the Coach's daily brief.
 *
 * Reads as prose, not as a widget. The whole card opens the full conversation,
 * so the brief is an entry point rather than a dead end.
 */
export function CoachBrief({ brief }: { brief: string }) {
  const router = useRouter();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open the full Coach conversation"
      onPress={() => router.push('/coach')}
      className="rounded-3xl border border-ink-200 bg-ink-50 p-5 active:opacity-70 dark:border-ink-800 dark:bg-ink-900">
      <View className="flex-row items-center gap-2">
        <View className="h-1.5 w-1.5 rounded-full bg-accent" />
        <Text className="text-xs font-medium uppercase tracking-widest text-ink-500 dark:text-ink-400">
          ARC Coach
        </Text>
      </View>

      <Text className="mt-3 text-[15px] leading-6 text-ink-800 dark:text-ink-200">{brief}</Text>

      <View className="mt-4 flex-row items-center gap-1">
        <Text className="text-sm font-medium text-accent-muted dark:text-accent">Open chat</Text>
        <Ionicons name="chevron-forward" size={14} color="#3FA7A0" />
      </View>
    </Pressable>
  );
}
