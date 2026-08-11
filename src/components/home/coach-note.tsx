import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';

/**
 * The Coach speaking first.
 *
 * This is the only thing on Home the user did not ask for: the output of an
 * automatic pass (src/lib/ai/coach-pass.ts), shown when the Coach judged that
 * the day warranted a word. It appears at most once a day, and only when there
 * is something to say — the model replies SKIP otherwise — so it must never be
 * dressed as an alert. Same porcelain slip as the brief, one line of eyebrow
 * to mark that the Coach initiated it, and a dismiss that costs one tap.
 *
 * Tapping opens the thread, where the same message is already the latest turn
 * and the confirmation gate exists for anything it proposed.
 */
export function CoachNote({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const router = useRouter();

  return (
    <View className="rounded-card border border-hairline bg-porcelain p-4">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <View className="h-1.5 w-1.5 rounded-full bg-pine" />
          <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
            Coach noticed
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={10}
          onPress={onDismiss}
          className="active:opacity-60">
          <Ionicons name="close" size={16} color={palette.inkMuted} />
        </Pressable>
      </View>

      <Text className="mt-3 text-[15px] leading-6 text-ink">{message}</Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open the Coach conversation"
        onPress={() => router.push('/coach')}
        className="mt-4 flex-row items-center gap-1 self-start active:opacity-70">
        <Text className="text-sm font-medium text-pine">Reply</Text>
        <Ionicons name="chevron-forward" size={14} color={palette.pine} />
      </Pressable>
    </View>
  );
}
