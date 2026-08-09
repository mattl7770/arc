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
import { Block } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
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
 *
 * ## The surface system
 *
 * Four of the six devices appear here, and the container is what tells you what
 * kind of thing you are reading (src/components/ui/block.tsx):
 *
 *   daily-brief-card    margin  prose — the brief is annotation, not a card
 *   reminders-card      plate   a schedule is a record, and a record is a table
 *   the thread          well    recessed stock: a capture surface, the turns are
 *                               marks made on it rather than cards floating over it
 *   suggested-prompts   plate   the authored empty state, as a list of things
 *   pending-write-card  stamp   the one next action, in the accent
 *
 * Each component owns its own device, so nothing nests; the Views here are
 * layout and spacing only, and sections are separated by whitespace rather than
 * by rules — in this design rules enclose objects, never the page. The two rules
 * that *are* drawn belong to bands: the header, and the composer.
 *
 * ## Accent budget
 *
 * Exactly the sanctioned set (00-design-spec.md §2): the Coach presence dot (in
 * the session line and on the brief), the user's own bubbles, the streaming
 * caret and the thinking dots, and **one** primary action — the composer's send,
 * which hands the accent over to the pending-write stamp while a decision is
 * open, so the two never appear together. No signal colour appears anywhere on
 * this screen: everything here is chrome or workflow state, and the signal
 * palette is biology only.
 *
 * ## The pending write is a live decision
 *
 * It renders between the thread and the composer, so nothing in the conversation
 * can appear beneath it; the live activity line is suppressed while it is open,
 * because the agentic loop is genuinely suspended and a "reading your data…"
 * ticker under a gate would be a lie; and the composer is closed with a stated
 * reason rather than silently inert. See pending-write-card.tsx for the rest.
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
  const decisionOpen = chat.pendingWrite !== null;

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-paper">
      <View className="border-b border-hairline px-5 pb-2.5 pt-1">
        <Text className="font-serif text-[22px] font-semibold text-ink">ARC Coach</Text>
        <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary">
          {COACH_TAGLINE}
        </Text>
      </View>

      <SessionKeyPanel keySet={keySet} />

      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scrollRef}
          className="flex-1"
          contentContainerClassName="px-5 pb-5 pt-4"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          scrollEventThrottle={16}
          onScroll={onScroll}
          onContentSizeChange={followIfAtBottom}>
          <DailyBriefCard brief={brief} keySet={keySet} />

          {/* RemindersCard renders nothing when the list is empty, so the gap
              above it is conditioned on the same emptiness — otherwise a user
              with no reminders gets a 24px hole in the sheet. */}
          {reminders.length > 0 ? (
            <View className="mt-6">
              <RemindersCard
                reminders={reminders}
                onComplete={onCompleteReminder}
                onDismiss={onDismissReminder}
              />
            </View>
          ) : null}

          {hasConversation ? (
            <View className="mt-6">
              <SectionLabel label="Thread" />
              <View className="mt-2">
                <Block device="well">
                  {chat.messages.map((message, index) => (
                    // Spacing lives on the thread, not on the turn, so the last
                    // bubble cannot leave a gap inside the well.
                    <View key={message.id} className={index === 0 ? '' : 'mt-3.5'}>
                      <MessageBubble message={message} onRetry={chat.retry} />
                    </View>
                  ))}
                </Block>
              </View>
            </View>
          ) : (
            <View className="mt-6">
              <SuggestedPrompts onPick={chat.send} />
            </View>
          )}
        </ScrollView>

        {/* Suppressed while a decision is open: the loop is suspended waiting on
            the owner, so a live activity ticker under the gate would be false. */}
        {chat.activity && chat.isResponding && !decisionOpen ? (
          <View className="px-5 pb-1.5">
            <Text className="font-mono text-[11px] text-ink-muted">· {chat.activity}…</Text>
          </View>
        ) : null}

        {chat.pendingWrite ? (
          <PendingWriteCard pending={chat.pendingWrite} onResolve={chat.resolveWrite} />
        ) : null}

        <ChatInput
          onSend={chat.send}
          disabled={chat.isResponding}
          blockedReason={decisionOpen ? 'Answer the proposed change to continue' : undefined}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
