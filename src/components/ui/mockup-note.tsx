import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';

import { palette } from '@/constants/theme';

/**
 * A quiet footer that marks a screen as a design mockup — real layout and mock
 * content, but nothing here persists yet. Keeps a built-out sub-screen honest
 * while its direction is being judged on-device, without shouting "MOCKUP" over
 * the design. Remove it from a screen when that screen is wired.
 */
export function MockupNote({ children }: { children: string }) {
  return (
    <View className="mt-8 flex-row items-start gap-2 rounded-card border border-hairline-soft bg-paper-deep px-3.5 py-3">
      <Ionicons
        name="construct-outline"
        size={14}
        color={palette.inkMuted}
        style={{ marginTop: 1 }}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <Text className="flex-1 text-xs leading-5 text-ink-muted">{children}</Text>
    </View>
  );
}
