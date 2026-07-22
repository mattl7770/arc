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

/** One dot that pulses opacity on a loop, offset by `delay`. */
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

  return (
    <Animated.View style={style} className="h-1.5 w-1.5 rounded-full bg-ink-400 dark:bg-ink-500" />
  );
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
