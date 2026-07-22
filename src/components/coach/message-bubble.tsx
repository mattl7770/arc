import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import type { ChatMessage } from '@/types/coach';

import { TypingIndicator } from './typing-indicator';

type Props = {
  message: ChatMessage;
  onRetry: () => void;
};

/**
 * One turn in the thread.
 *
 * The user speaks in an accent bubble on the right; the Coach answers in
 * neutral ink on the left, reading more like considered prose than a chat
 * bubble. That asymmetry is deliberate — the Coach is a voice, not a buddy.
 */
export function MessageBubble({ message, onRetry }: Props) {
  if (message.role === 'user') {
    return (
      <View className="mb-3 max-w-[85%] self-end rounded-3xl rounded-br-lg bg-accent px-4 py-2.5">
        <Text className="text-[15px] leading-6 text-white">{message.content}</Text>
      </View>
    );
  }

  // Assistant, mid-stream, nothing yet → the thinking indicator.
  if (message.streaming && message.content.length === 0) {
    return (
      <View className="mb-3 self-start rounded-3xl rounded-bl-lg bg-ink-100 px-4 py-3 dark:bg-ink-800">
        <TypingIndicator />
      </View>
    );
  }

  return (
    <View className="mb-3 max-w-[88%] self-start">
      {/*
        Announce the reply to screen readers as it streams in — it is the most
        important event on the screen. The caret is decorative and hidden from
        assistive tech so it isn't read out as a character.
      */}
      <View
        accessibilityLiveRegion="polite"
        className="rounded-3xl rounded-bl-lg bg-ink-100 px-4 py-3 dark:bg-ink-800">
        <Text className="text-[15px] leading-6 text-ink-900 dark:text-ink-100">
          {/* An error before the first token leaves content empty; show a line
              rather than an empty bubble. The retry pill sits below. */}
          {message.content.length === 0 && message.error
            ? 'Couldn’t reach the Coach.'
            : message.content}
          {message.streaming ? (
            <Text
              className="text-accent"
              accessibilityElementsHidden
              importantForAccessibility="no">
              {' ▍'}
            </Text>
          ) : null}
        </Text>
      </View>

      {message.error ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          className="mt-1.5 flex-row items-center gap-1 self-start active:opacity-60">
          <Ionicons name="refresh" size={13} color="#C4614C" />
          <Text className="text-xs text-signal-poor">Couldn’t send · Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
