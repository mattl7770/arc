import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';

/**
 * Header for a stack-pushed screen (Nutrition, Exercise, the metric keypad…):
 * a back chevron and a serif title. The tab screens don't use this — they own
 * their own headers — but pushed screens have no native header (headerShown is
 * off globally), so this is how you get back.
 *
 * Conformed Set treatment — **square and ruled.** The back control loses its
 * radius (square is the point: this is a drawing, not a bubble) and the row
 * closes on a hairline, so a pushed sheet opens with its title line drawn rather
 * than floating. The rule belongs to the header band, which is an object; it is
 * not a rule across the page.
 *
 * The title is serif — "serif speaks", and a screen title is speech, not a
 * measurement (00-design-spec.md §3). It takes `flex-1` so a long title wraps
 * inside the gutter instead of running under the edge.
 *
 * The tap target is 44×44, not the 36×36 it used to be: every tappable control
 * in this design clears 44pt, and the back chevron is the most-used control in
 * the app. The negative margin is retuned to −12 so the glyph stays at the same
 * optical x as before while the target grows around it.
 */
export function StackHeader({ title }: { title: string }) {
  const router = useRouter();
  return (
    <View className="flex-row items-center gap-1 border-b border-hairline pb-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={() => router.back()}
        className="-ml-3 h-11 w-11 items-center justify-center active:opacity-60">
        <Ionicons name="chevron-back" size={22} color={palette.ink} />
      </Pressable>
      <Text className="flex-1 font-serif text-lg font-semibold text-ink">{title}</Text>
    </View>
  );
}
