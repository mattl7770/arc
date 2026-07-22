import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';

import { isCoachBackendLive } from '@/lib/ai/coach-service';

/**
 * Section: the daily brief placeholder that opens the thread.
 *
 * docs/ai-coach.md has the brief "run on app open." Here it is the Coach's
 * first turn — the conversation opens with today's brief, which is also what
 * the Home screen's brief card taps through to. Same text, one source
 * (src/lib/home/mock-day.ts), so the two screens never disagree.
 */
export function DailyBriefCard({ brief }: { brief: string }) {
  return (
    <View className="mb-4 rounded-3xl border border-ink-200 bg-ink-50 p-5 dark:border-ink-800 dark:bg-ink-900">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <View className="h-1.5 w-1.5 rounded-full bg-accent" />
          <Text className="text-xs font-medium uppercase tracking-widest text-ink-500 dark:text-ink-400">
            Today’s Brief
          </Text>
        </View>
        {!isCoachBackendLive ? (
          <View className="rounded-full bg-ink-100 px-2 py-0.5 dark:bg-ink-800">
            <Text className="text-[10px] font-medium uppercase tracking-wider text-ink-400 dark:text-ink-500">
              Preview
            </Text>
          </View>
        ) : null}
      </View>

      <Text className="mt-3 text-[15px] leading-6 text-ink-800 dark:text-ink-200">{brief}</Text>

      {!isCoachBackendLive ? (
        <View className="mt-4 flex-row items-center gap-1.5 border-t border-ink-100 pt-3 dark:border-ink-800">
          <Ionicons name="information-circle-outline" size={14} color="#8C96A7" />
          <Text className="flex-1 text-xs leading-4 text-ink-400 dark:text-ink-500">
            Sample brief. The Coach isn’t connected to the model or your data yet.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
