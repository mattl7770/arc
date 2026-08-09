import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

/**
 * One dot that pulses opacity on a loop, offset by `delay`.
 *
 * Drawn in the accent, which is sanctioned: 00-design-spec.md §2 names the
 * Coach presence dot in the app-wide list of things the accent may mark. This
 * is that dot, animated — it says the Coach is present and working. It is
 * chrome, so it never borrows a signal colour; the signal palette is biology
 * only, and a model still composing its first token is not a health reading.
 *
 * Round, deliberately, in an otherwise square set: the corner rule governs
 * plates, rows and buttons — containers. A presence mark is a dot, not a box.
 */
function Dot({ delay }: { delay: number }) {
  const opacity = useSharedValue(0.3);

  useEffect(() => {
    opacity.value = withDelay(
      delay,
      withRepeat(
        withSequence(withTiming(1, { duration: 400 }), withTiming(0.3, { duration: 400 })),
        -1
      )
    );
  }, [delay, opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return <Animated.View style={style} className="h-1.5 w-1.5 rounded-full bg-pine" />;
}

/** The three-dot "Coach is thinking" indicator, shown before the first token. */
export function TypingIndicator() {
  return (
    <View className="flex-row items-center gap-1 py-1" accessibilityLabel="Coach is typing">
      <Dot delay={0} />
      <Dot delay={160} />
      <Dot delay={320} />
    </View>
  );
}
