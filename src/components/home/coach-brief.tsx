import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';

/**
 * Section 4 — the Coach's daily brief: a porcelain slip with a hairline
 * border. Reads as typeset prose, not a widget. The whole card opens the full
 * conversation, so the brief is an entry point rather than a dead end.
 */
export function CoachBrief({ brief }: { brief: string }) {
  const router = useRouter();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open the full Coach conversation"
      onPress={() => router.push('/coach')}
      className="rounded-card border border-hairline bg-porcelain p-4 active:opacity-70">
      <View className="flex-row items-center gap-2">
        <View className="h-1.5 w-1.5 rounded-full bg-pine" />
        <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
          ARC Coach
        </Text>
      </View>

      <Text className="mt-3 text-[15px] leading-6 text-ink-secondary">{brief}</Text>

      <View className="mt-4 flex-row items-center gap-1">
        <Text className="text-sm font-medium text-pine">Open chat</Text>
        <Ionicons name="chevron-forward" size={14} color={palette.pine} />
      </View>
    </Pressable>
  );
}
