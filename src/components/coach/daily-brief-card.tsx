import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import { isCoachKeyConfigured } from '@/lib/ai/coach-service';

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
    <View className="mb-4 rounded-card border border-hairline bg-porcelain p-4">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <View className="h-1.5 w-1.5 rounded-full bg-pine" />
          <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
            Today’s Brief
          </Text>
        </View>
        {!isCoachKeyConfigured ? (
          <View className="rounded-btn bg-paper-deep px-2 py-0.5">
            <Text className="font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
              Preview
            </Text>
          </View>
        ) : null}
      </View>

      <Text className="mt-3 text-[15px] leading-6 text-ink-secondary">{brief}</Text>

      {!isCoachKeyConfigured ? (
        <View className="mt-4 flex-row items-center gap-1.5 border-t border-hairline-soft pt-3">
          <Ionicons
            name="information-circle-outline"
            size={14}
            color={palette.inkMuted}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
          <Text className="flex-1 text-xs leading-4 text-ink-muted">
            Sample brief. The Coach isn’t connected to the model or your data yet.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
