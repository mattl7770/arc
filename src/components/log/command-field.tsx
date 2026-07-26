import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { palette } from '@/constants/theme';

/**
 * The Log tab hero (direction A, "Open Line"): a recessed "Log anything…" field
 * with the screen's one pine action — the mic — docked to its right, over a
 * helper line that makes free notes first-class.
 *
 * Skeleton: owns its draft text, but doesn't parse or persist yet — that's the
 * next step (see docs/information-architecture.md). The field is where free
 * text / voice notes and natural-language entries will be captured.
 */
export function CommandField() {
  const [text, setText] = useState('');

  return (
    <View className="rounded-card border border-hairline bg-porcelain p-3">
      <View className="flex-row items-stretch gap-2.5">
        <View className="max-h-28 flex-1 justify-center rounded-btn border border-hairline-soft bg-paper-deep px-3.5">
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Log anything…"
            placeholderTextColor={palette.inkMuted}
            multiline
            className="py-2.5 text-[15px] leading-5 text-ink"
            accessibilityLabel="Log anything"
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Voice log"
          className="w-[52px] items-center justify-center rounded-btn bg-pine active:opacity-70">
          <Ionicons name="mic-outline" size={22} color={palette.pineOn} />
        </Pressable>
      </View>

      <View className="mt-2.5 flex-row items-start gap-2 px-0.5">
        <Ionicons
          name="reader-outline"
          size={13}
          color={palette.inkMuted}
          style={{ marginTop: 2 }}
        />
        <Text className="flex-1 text-xs leading-5 text-ink-muted">
          Type or speak. Hold the mic for a voice note — anything with no metric is saved as a{' '}
          <Text className="text-ink-secondary">note for Coach</Text>.
        </Text>
      </View>
    </View>
  );
}
