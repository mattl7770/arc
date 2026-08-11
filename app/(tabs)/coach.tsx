import { useCallback, useRef } from 'react';
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
import { MessageBubble } from '@/components/coach/message-bubble';
import { PendingWriteCard } from '@/components/coach/pending-write-card';
import { RemindersCard } from '@/components/coach/reminders-card';
import { SessionKeyPanel } from '@/components/coach/session-key-panel';
import { SuggestedPrompts } from '@/components/coach/suggested-prompts';
import { Divider } from '@/components/ui/block';
import { PaperGrid } from '@/components/ui/screen';
import { useCoachChat } from '@/hooks/use-coach-chat';
import { useReminders } from '@/hooks/use-reminders';
import { useSessionKeySet } from '@/hooks/use-session-key';
import { getDb } from '@/lib/db/client';
import { syncReminderNotifications } from '@/lib/notifications/reminders';

/**
 * Coach — the conversational surface (docs/ai-coach.md).
 *
 * The screen is the conversation and nothing else: the active reminders, the
 * thread, and the composer. The model call lives behind
 * src/lib/ai/coach-service.ts — with a session key pasted it runs the real
 * agentic tool loop (reads + confirmed writes against the local database);
 * without one it stays an honest preview. Write tool calls surface in the
 * PendingWriteCard and run only on Approve.
 *
 * **The daily brief is not here** (owner, 2026-08-10: "Today's brief in the
 * coach tab can be removed. It is already on the home screen."). It opened the
 * thread as a `margin` block, restating verbatim what Home's coach-brief.tsx
 * already prints one tab away — the same `generateDailyBrief(getDb())` string,
 * read twice a day by the same person. Home is where the day is decided, so
 * Home keeps it; this screen is where the day is discussed. The component and
 * its focus-reload went with it, and `onTurnComplete` no longer has a brief to
 * refresh.
 *
 * ## The surface system
 *
 * Three devices appear here, and the container is what tells you what kind of
 * thing you are reading (src/components/ui/block.tsx):
 *
 *   reminders-card      plate   a schedule is a record, and a record is a table
 *   suggested-prompts   plate   the authored empty state, as a list of things
 *   pending-write-card  stamp   the one next action, in the accent
 *
 * **The thread itself takes no device, and carries no section label.** It was
 * drawn on the `well` — the reading being "a capture surface, the turns are
 * marks made on it" — under a `Thread` label. On hardware that read as a chat
 * put inside a box for no reason (owner, 2026-08-09), and the owner is right:
 * the well is for a surface you *capture into*, and the thing you capture into
 * on this screen is the composer, which already wears it. The conversation is
 * not a record filed on the page — it IS the page, so it sits directly on the
 * sheet and only the turns are drawn (coach/message-bubble.tsx). Labelling it
 * was the same mistake twice: a section label names one object among several,
 * and the thread is the screen's subject, not one of its sections.
 *
 * Each component owns its own device, so nothing nests; the Views here are
 * layout and spacing only, and SECTIONS are separated by whitespace rather than
 * by rules — in this design rules enclose objects, never the page.
 *
 * Three rules are drawn, and none of them separates a section. Two close bands:
 * the header, and the composer. The third runs BETWEEN THE TURNS of the thread
 * (`.cf-turn`'s hairline), which is a rule between rows of one list — the case
 * §4 explicitly sanctions, and the same rule any plate in the app draws inside
 * itself. The thread has no plate around it, but it is still one list.
 *
 * ## The sheet, and why the composer is bare stock
 *
 * This screen is the one tab that cannot use `<Screen>`: it needs a
 * `KeyboardAvoidingView` wrapping a docked composer, which `Screen`'s
 * scroll-and-gutter contract has no way to express. That is why it builds its
 * own root — and why, until the grid layer was lifted out of `Screen` into
 * `PaperGrid`, Coach was the only tab printed on blank paper.
 *
 * The two docked bands — the pending-write card and the composer — paint an
 * opaque `bg-paper` bar, so the grid does **not** run through them. That is
 * deliberate and it is the right call: the grid is *the sheet*, and those bars
 * are not on the sheet, they are chrome pinned over it. They have to be opaque
 * (they occlude a thread scrolling underneath), they slide with the keyboard
 * while the paper stays put, and an untextured band closed by a hairline is
 * exactly how the tab bar below them already reads on all six tabs
 * (app/(tabs)/_layout.tsx: `palette.paper`, 1px `borderTopColor`, no texture).
 * Texturing the composer would make Coach the only tab in the app whose bottom
 * band is printed, which is the inconsistency this change exists to remove.
 *
 * The header band is the other way round on purpose: it carries a rule but no
 * fill, so the grid runs straight through it. It occludes nothing, so it is page
 * rather than chrome. **The test is occlusion, not position** — a band that
 * covers scrolling content is chrome and stays bare; a band that only draws a
 * rule under type is still the sheet.
 *
 * ## Accent budget
 *
 * Exactly the sanctioned set (00-design-spec.md §2): the user's own bubbles, the
 * streaming caret and the thinking dots, and **one** primary action — the composer's send,
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

  const onTurnComplete = useCallback(() => {
    reloadReminders();
    // A turn may have set/completed/dismissed a reminder — re-mirror the OS
    // notification schedule so a while-closed nudge tracks the change.
    void syncReminderNotifications(getDb());
  }, [reloadReminders]);

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
  const hasReminders = reminders.length > 0;
  const decisionOpen = chat.pendingWrite !== null;

  return (
    <View className="flex-1 bg-paper">
      {/* This screen cannot use `Screen` (see the note above), so it prints the
          sheet itself. Outside the SafeAreaView, so the tile runs under the
          status-bar inset with no seam. */}
      <PaperGrid />
      <SafeAreaView edges={['top']} className="flex-1">
        {/* Title only. The line under it — "Calm, precise, and grounded in your
            data" — described the app's manner back at the owner and told them
            nothing they could act on; it is gone by their call (2026-08-10). */}
        <View className="px-5 pb-2.5 pt-1">
          <Text className="font-serif text-[22px] font-semibold text-ink">ARC Coach</Text>
        </View>
        {/* The rule closing the header band. Drawn, not bordered: a `border-b`
            is the same four-sided trap as `border-t` (see Divider), and this
            one would have boxed the whole title band. Outside the padding so it
            spans the full width, exactly as the border did. */}
        <Divider />

        {/* Renders nothing once a key is set — see session-key-panel.tsx. Its
          collapsed form draws no rule of its own, so the header's hairline above
          is the only one closing this band whether or not the panel is up. */}
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
            {/* With the brief gone, reminders are the first thing in the scroll
              view — so the section gap has to move onto whatever follows them
              rather than sit on top of the first block. `hasReminders` is what
              every section below keys its top margin off; the container's own
              `pt-4` is the only air above the first one. RemindersCard renders
              nothing when the list is empty, hence the same test guards both. */}
            {hasReminders ? (
              <RemindersCard
                reminders={reminders}
                onComplete={onCompleteReminder}
                onDismiss={onDismissReminder}
              />
            ) : null}

            {hasConversation ? (
              // No enclosure and no label: the conversation sits straight on the
              // sheet (see the surface note above). The gap is one step wider than
              // a section gap because the turns no longer have a container holding
              // them apart from the card above.
              <View className={hasReminders ? 'mt-7' : ''}>
                {chat.messages.map((message, index) => (
                  // Spacing and rules live on the thread, not on the turn, so
                  // the last bubble cannot push a gap against the composer.
                  //
                  // The sheet's `.cf-turn` is a ruled row — `padding: 9px 0`
                  // with a hairline between turns — where the app had only air.
                  // The rule is what makes a long thread scan as a record of
                  // exchanges rather than a drift of boxes, and it is the one
                  // place on this screen a rule belongs: it separates rows of
                  // ONE list, which is exactly what §4 sanctions ("rules enclose
                  // objects, never pages"). `Divider` draws it as a filled view;
                  // `border-b` here would box every turn on the screen, which is
                  // the bug documented at length in ui/block.tsx. `first` keeps
                  // it strictly BETWEEN turns — the sheet spells the same
                  // boundary from the other end with `:last-child`.
                  <View key={message.id}>
                    <Divider first={index === 0} />
                    <View className="py-2.5">
                      <MessageBubble message={message} onRetry={chat.retry} />
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <View className={hasReminders ? 'mt-6' : ''}>
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
    </View>
  );
}
