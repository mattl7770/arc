import { useRef } from 'react';
import {
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ChatInput } from '@/components/coach/chat-input';
import { DailyBriefCard } from '@/components/coach/daily-brief-card';
import { MessageBubble } from '@/components/coach/message-bubble';
import { SuggestedPrompts } from '@/components/coach/suggested-prompts';
import { useCoachChat } from '@/hooks/use-coach-chat';
import { COACH_TAGLINE } from '@/lib/ai/system-prompt';
import { mockDay } from '@/lib/home/mock-day';

/**
 * Coach — the conversational surface (docs/ai-coach.md).
 *
 * The thread opens with today's brief (the same text the Home card taps
 * through to), then invites a first message. The model call lives behind
 * src/lib/ai/coach-service.ts, which returns an honest preview today and
 * becomes an Edge Function call later — this screen doesn't change when it does.
 */
export default function CoachScreen() {
  const chat = useCoachChat();
  const scrollRef = useRef<ScrollView>(null);

  // Only follow the stream to the bottom if the user is already there. If they
  // scrolled up to re-read an earlier turn, don't yank them back on every token.
  const atBottomRef = useRef(true);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    atBottomRef.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 80;
  };
  const followIfAtBottom = () => {
    if (atBottomRef.current) scrollRef.current?.scrollToEnd({ animated: true });
  };

  const hasConversation = chat.messages.length > 0;

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-paper">
      <View className="border-b border-hairline px-5 pb-3 pt-1">
        <Text className="font-serif text-2xl font-semibold text-ink">ARC Coach</Text>
        <Text className="mt-0.5 text-sm text-ink-secondary">{COACH_TAGLINE}</Text>
      </View>

      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scrollRef}
          className="flex-1"
          contentContainerClassName="px-5 pb-4 pt-4"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          scrollEventThrottle={16}
          onScroll={onScroll}
          onContentSizeChange={followIfAtBottom}>
          <DailyBriefCard brief={mockDay.brief} />

          {chat.messages.map((message) => (
            <MessageBubble key={message.id} message={message} onRetry={chat.retry} />
          ))}

          {!hasConversation ? <SuggestedPrompts onPick={chat.send} /> : null}
        </ScrollView>

        <ChatInput onSend={chat.send} disabled={chat.isResponding} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
