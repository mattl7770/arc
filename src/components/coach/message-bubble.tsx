import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import type { ChatMessage } from '@/types/coach';

import { TypingIndicator } from './typing-indicator';

type Props = {
  message: ChatMessage;
  onRetry: () => void;
};

/**
 * One turn in the thread.
 *
 * The user speaks in solid pine on the right; the Coach answers on bordered
 * porcelain slips on the left — typeset prose, not chat froth. Each bubble
 * squares off one corner toward its speaker, like a ledger entry's tab.
 */
export function MessageBubble({ message, onRetry }: Props) {
  if (message.role === 'user') {
    return (
      <View className="mb-3 max-w-[85%] self-end rounded-card rounded-br-sm bg-pine px-4 py-2.5">
        <Text className="text-[15px] leading-6 text-pine-on">{message.content}</Text>
      </View>
    );
  }

  // Assistant, mid-stream, nothing yet → the thinking indicator.
  if (message.streaming && message.content.length === 0) {
    return (
      <View className="mb-3 self-start rounded-card rounded-bl-sm border border-hairline bg-porcelain px-4 py-3">
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
        className="rounded-card rounded-bl-sm border border-hairline bg-porcelain px-4 py-3">
        <Text className="text-[15px] leading-6 text-ink">
          {/* An error before the first token leaves content empty; show a line
              rather than an empty bubble. The retry pill sits below. */}
          {message.content.length === 0 && message.error
            ? 'Couldn’t reach the Coach.'
            : message.content}
          {message.streaming ? (
            <Text className="text-pine" accessibilityElementsHidden importantForAccessibility="no">
              {' ▍'}
            </Text>
          ) : null}
        </Text>
      </View>

      {/* Transparency chips: which data the turn actually read or wrote. */}
      {message.tools && message.tools.length > 0 ? (
        <Text className="mt-1 font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
          {message.tools.join(' · ')}
        </Text>
      ) : null}

      {message.error ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          className="mt-1.5 flex-row items-center gap-1 self-start active:opacity-60">
          <Ionicons name="refresh" size={13} color={palette.signal.poor} />
          <Text className="text-xs text-signal-poor">Couldn’t send · Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
