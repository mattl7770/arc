import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
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
 *
 * ## Conformed Set treatment
 *
 * The **margin annotation** device, which as of 2026-08-09 is UNMARKED — no rule,
 * no indent (the left rule read as a stray line on hardware; see "Devices that
 * stopped paying rent" in src/components/ui/block.tsx).
 * Prose does not belong in a card; it belongs in the margin of the sheet, and
 * this is the longest stretch of prose on the screen. Set in the serif voice
 * (serif speaks), the same treatment Home's coach-brief.tsx gives it, so the
 * Coach reads as one voice across both screens.
 *
 * The presence dot is the accent when a model is connected and neutral when it
 * is not — §2 sanctions the Coach presence dot by name, and a dot reporting
 * presence has to be honest about absence.
 *
 * The old "Preview" chip is gone. **The brief is never a preview**: it is
 * computed from the on-device record whether or not a key is set, so labelling
 * it as provisional was the one thing on this block that wasn't true. What is in
 * preview is the *chat*, which is exactly what the footnote below says — and it
 * only appears when that is the case.
 */
export function DailyBriefCard({ brief, keySet }: { brief: string; keySet: boolean }) {
  return (
    <View>
      <View className="flex-row items-center gap-2">
        <View
          className={
            keySet ? 'h-1.5 w-1.5 rounded-full bg-pine' : 'h-1.5 w-1.5 rounded-full bg-hairline'
          }
        />
        <View className="flex-1">
          <SectionLabel label="Today’s Brief" />
        </View>
      </View>

      <View className="mt-2">
        <Block device="margin">
          <Text className="font-serif text-[15px] leading-6 text-ink-secondary">{brief}</Text>
        </Block>
      </View>

      {!keySet ? (
        <View className="mt-2.5 flex-row items-start gap-1.5 pl-3">
          <Ionicons
            name="information-circle-outline"
            size={13}
            color={palette.inkMuted}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
          <Text className="flex-1 font-serif text-[12px] leading-5 text-ink-muted">
            Computed from your on-device data. Chat is in preview — no model connected this session.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
