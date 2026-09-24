import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text } from 'react-native';

import { palette } from '@/constants/theme';

/**
 * The water screen's one line about Apple Health: shown while a glass logged
 * there cannot go out, and gone once it can (docs/wearables-subapp.md §20.11).
 * Whether to show it, and what it says, is `waterPublishPointer` in
 * src/lib/health/publish.ts. This only draws it.
 *
 * A ruled row of the Add plate it sits in, not a device of its own, and quiet
 * on purpose: serif annotation size, muted ink, a chevron. It takes no accent,
 * because the Add plate's accent is its Add action, and no signal colour,
 * because a permission is chrome, not biology. Its own component so the
 * headless render suite can draw the shown state, which a server render of the
 * screen cannot reach: under node the HealthKit module is absent and the line
 * never shows.
 */
export function WaterPublishPointer({ line, onPress }: { line: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${line}. Opens Settings, Apple Health.`}
      onPress={onPress}
      className="min-h-[44px] flex-row items-center gap-2 active:opacity-60">
      <Text className="flex-1 font-serif text-[11px] leading-4 text-ink-muted">{line}</Text>
      <Ionicons name="chevron-forward" size={14} color={palette.inkMuted} />
    </Pressable>
  );
}
