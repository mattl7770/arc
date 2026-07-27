import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';

import { palette } from '@/constants/theme';

/**
 * Section: the daily brief that opens the thread.
 *
 * docs/ai-coach.md has the brief "run on app open." Here it is the Coach's
 * first turn. The text comes from the deterministic insights engine
 * (src/lib/ai/insights.ts → generateDailyBrief) via the screen — real numbers,
 * no model call. `keySet` arrives as a PROP (from useSessionKeySet on the
 * screen), not read from the store here: under the React Compiler a render
 * that reads mutable external state directly can be memoized stale.
 */
export function DailyBriefCard({ brief, keySet }: { brief: string; keySet: boolean }) {
  return (
    <View className="mb-4 rounded-card border border-hairline bg-porcelain p-4">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <View className="h-1.5 w-1.5 rounded-full bg-pine" />
          <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
            Today’s Brief
          </Text>
        </View>
        {!keySet ? (
          <View className="rounded-btn bg-paper-deep px-2 py-0.5">
            <Text className="font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
              Preview
            </Text>
          </View>
        ) : null}
      </View>

      <Text className="mt-3 text-[15px] leading-6 text-ink-secondary">{brief}</Text>

      {!keySet ? (
        <View className="mt-4 flex-row items-center gap-1.5 border-t border-hairline-soft pt-3">
          <Ionicons
            name="information-circle-outline"
            size={14}
            color={palette.inkMuted}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
          <Text className="flex-1 text-xs leading-4 text-ink-muted">
            Computed from your on-device data. Chat is in preview — no model connected this session.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
