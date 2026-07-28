import { useCallback, useRef, useState } from 'react';
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
import { useFocusEffect } from 'expo-router';

import { ChatInput } from '@/components/coach/chat-input';
import { DailyBriefCard } from '@/components/coach/daily-brief-card';
import { MessageBubble } from '@/components/coach/message-bubble';
import { PendingWriteCard } from '@/components/coach/pending-write-card';
import { RemindersCard } from '@/components/coach/reminders-card';
import { SessionKeyPanel } from '@/components/coach/session-key-panel';
import { SuggestedPrompts } from '@/components/coach/suggested-prompts';
import { useCoachChat } from '@/hooks/use-coach-chat';
import { useReminders } from '@/hooks/use-reminders';
import { useSessionKeySet } from '@/hooks/use-session-key';
import { generateDailyBrief } from '@/lib/ai/insights';
import { COACH_TAGLINE } from '@/lib/ai/system-prompt';
import { getDb } from '@/lib/db/client';
import { syncReminderNotifications } from '@/lib/notifications/reminders';

/**
 * Coach — the conversational surface (docs/ai-coach.md).
 *
 * The thread opens with today's brief — computed deterministically from the
 * on-device data (src/lib/ai/insights.ts), no model call — and the active
 * reminders. The model call lives behind src/lib/ai/coach-service.ts: with a
 * session key pasted it runs the real agentic tool loop (reads + confirmed
 * writes against the local database); without one it stays an honest preview.
 * Write tool calls surface in the PendingWriteCard and run only on Approve.
 */
export default function CoachScreen() {
  const keySet = useSessionKeySet();
  const { reminders, reload: reloadReminders, complete, dismiss } = useReminders();

  // Deterministic brief — re-read on focus and after any Coach turn (a tool
  // may have logged data that moves an insight).
  const [brief, setBrief] = useState(() => generateDailyBrief(getDb()));
  const reloadBrief = useCallback(() => setBrief(generateDailyBrief(getDb())), []);
  useFocusEffect(reloadBrief);

  const onTurnComplete = useCallback(() => {
    reloadReminders();
    reloadBrief();
    // A turn may have set/completed/dismissed a reminder — re-mirror the OS
    // notification schedule so a while-closed nudge tracks the change.
    void syncReminderNotifications(getDb());
  }, [reloadReminders, reloadBrief]);

  // Completing/dismissing from the card also changes what should fire.
  const onCompleteReminder = useCallback(
    (id: string) => {
      complete(id);
      void syncReminderNotifications(getDb());
    },
    [complete]
  );
  const onDismissReminder = useCallback(
    (id: string) => {
      dismiss(id);
      void syncReminderNotifications(getDb());
    },
    [dismiss]
  );

  const chat = useCoachChat({ onTurnComplete });
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

      <SessionKeyPanel keySet={keySet} />

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
          <DailyBriefCard brief={brief} keySet={keySet} />

          <RemindersCard
            reminders={reminders}
            onComplete={onCompleteReminder}
            onDismiss={onDismissReminder}
          />

          {chat.messages.map((message) => (
            <MessageBubble key={message.id} message={message} onRetry={chat.retry} />
          ))}

          {!hasConversation ? <SuggestedPrompts onPick={chat.send} /> : null}
        </ScrollView>

        {chat.activity && chat.isResponding ? (
          <View className="px-5 pb-1.5">
            <Text className="font-mono text-[11px] text-ink-muted">· {chat.activity}…</Text>
          </View>
        ) : null}

        {chat.pendingWrite ? (
          <PendingWriteCard pending={chat.pendingWrite} onResolve={chat.resolveWrite} />
        ) : null}

        <ChatInput onSend={chat.send} disabled={chat.isResponding} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
