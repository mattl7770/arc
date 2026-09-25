import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { CheckinLine } from '@/components/coach/checkin-line';
import { MessageBubble } from '@/components/coach/message-bubble';
import { NudgesCard } from '@/components/coach/nudges-card';
import { PendingWriteCard } from '@/components/coach/pending-write-card';
import { RemindersCard } from '@/components/coach/reminders-card';
import { SessionKeyPanel } from '@/components/coach/session-key-panel';
import { StatusControl } from '@/components/status/status-control';
import { SuggestedPrompts } from '@/components/coach/suggested-prompts';
import { Divider } from '@/components/ui/block';
import { PaperGrid } from '@/components/ui/screen';
import { useCoachChat } from '@/hooks/use-coach-chat';
import { useCoachNudges } from '@/hooks/use-coach-nudges';
import { useCoachPassThread } from '@/hooks/use-coach-pass';
import { useReminders } from '@/hooks/use-reminders';
import { useSessionKeySet } from '@/hooks/use-session-key';
import { useStatuses } from '@/hooks/use-statuses';
import { getDb } from '@/lib/db/client';
import { syncReminderNotifications } from '@/lib/notifications/reminders';
import type { RailChip } from '@/lib/status/chips';
import type { ReminderRow } from '@/lib/reminders/types';
import {
  composerKey,
  NO_SEED,
  seedFromParam,
  seedFromRail,
  seedFromTap,
  talkAboutReminder,
} from '@/lib/status/composer-seed';
import { endOpenStatus, toggleStatus } from '@/lib/status/store';

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
 * Four blocks appear here, and the container is what tells you what kind of
 * thing you are reading (src/components/ui/block.tsx):
 *
 *   reminders-card      plate   a schedule is a record, and a record is a table
 *   nudges-card         plate   the Coach's own planned notifications (0064)
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
  // A screen may route here holding a question it wants asked — Home's status
  // door, and the Protocols hub's empty state ("Ask the Coach to draft one").
  // It SEEDS the composer and never sends: a turn the user did not press send
  // on would spend a model call on wording they never saw. A repeated param
  // arrives as string[] despite the generic, so it is coerced like every other
  // deep-linked param.
  const params = useLocalSearchParams<{ prompt?: string | string[] }>();
  const seededPrompt = Array.isArray(params.prompt) ? params.prompt[0] : params.prompt;
  // THIS route's handle, typed to the one call made on it (dropping the param
  // once taken — see the composer's seed below). The untyped default is keyed
  // to a root param list that declares no `prompt`.
  const navigation = useNavigation<{
    setParams: (params: { prompt?: string; reminderId?: string }) => void;
  }>();

  // The Coach's own planned notifications (0064) and the pass store's view of
  // the thread: a note, a plan record or a tapped nudge written while this tab
  // was mounted, and what became of a tapped check-in.
  const planned = useCoachNudges();
  const reloadPlanned = planned.reload;
  const passThread = useCoachPassThread();

  // Read above the turn callback, because a turn can change it.
  const statuses = useStatuses();
  const reloadStatuses = statuses.reload;

  const onTurnComplete = useCallback(() => {
    reloadReminders();
    reloadPlanned();
    // A turn may have set/completed/dismissed a reminder — re-mirror the OS
    // notification schedule so a while-closed nudge tracks the change.
    void syncReminderNotifications(getDb());
    // …or recorded or ended a status (`set_status`). Since 2026-09-23 the door
    // is the one thing on this screen that says a status is running, and it
    // NAMES it, so it re-reads here — a status the owner just approved on a
    // card must not read `STATUS` until the tab next regains focus. (The
    // store's broadcast covers the door's own gestures; a tool write never
    // passes through the store.)
    reloadStatuses();
  }, [reloadReminders, reloadPlanned, reloadStatuses]);

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

  // The pass store wrote to the thread (a pass's note, a plan record, a tapped
  // nudge): this tab loaded its turns once, at mount, so it re-reads — and so
  // does the Scheduled list, which the same pass may have changed.
  const reloadChat = chat.reload;
  const seenThreadVersion = useRef(passThread.threadVersion);
  useEffect(() => {
    if (passThread.threadVersion === seenThreadVersion.current) return;
    seenThreadVersion.current = passThread.threadVersion;
    reloadChat();
    reloadPlanned();
  }, [passThread.threadVersion, reloadChat, reloadPlanned]);

  // Sending anything retires the check-in line below the thread: it described
  // the moment of the tap, and he has moved on from it.
  const clearCheckin = passThread.clearCheckin;
  const send = chat.send;
  const onSend = useCallback(
    (text: string) => {
      clearCheckin();
      send(text);
    },
    [clearCheckin, send]
  );

  // A reminder notification tap routes here carrying its id (app/_layout.tsx →
  // registerNotificationRouting). The reminder lives in RemindersCard at the top
  // of the scroll view, so when the tapped id matches an active reminder we bring
  // that region into view — which matters when the Coach tab is already mounted
  // and scrolled down a long thread (the Stack stays mounted across taps). A
  // per-row scroll or highlight would need RemindersCard to expose a ref/target
  // for the matched row; that is a broader change than this fix, so surfacing the
  // card is the low-risk step taken here.
  //
  // Since 0064 the card DOES mark the row: `highlightId` puts a mark on it and
  // offers **Talk about this** beneath it, which seeds the composer and drops
  // the param, so the mark goes with it.
  const { reminderId } = useLocalSearchParams<{ reminderId?: string }>();
  useEffect(() => {
    if (!reminderId) return;
    if (!reminders.some((r) => r.id === reminderId)) return;
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, [reminderId, reminders]);

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
  const hasPlanned = planned.nudges.length > 0;
  // Every section below the cards keys its top margin off this.
  const hasCards = hasReminders || hasPlanned;
  const decisionOpen = chat.pendingWrite !== null;

  // --- The composer's seed ----------------------------------------------------
  //
  // Two sources: the `prompt` param above, and the × in this tab's own status
  // sheet (ending a status is bookkeeping that may not warrant a turn, so it
  // seeds rather than sends). ONE counter keys both, and the latest wins
  // (src/lib/status/composer-seed.ts). Until 2026-09-23 the × seed shadowed the
  // param for as long as the tab stayed mounted, so a status set on Home after
  // any × here wrote its row with no prompt following it.
  //
  // The param is read during render — React's pattern for state derived from a
  // changing input — so the composer is keyed right on the render that sees it,
  // not one render late. Then it is dropped from the route, because Home sends
  // the same sentence every time a given chip goes on, and only a param that
  // went away can arrive a second time.
  const [seedState, setSeedState] = useState(() => seedFromParam(NO_SEED, seededPrompt));
  const seed = seedFromParam(seedState, seededPrompt);
  if (seed !== seedState) setSeedState(seed);
  useEffect(() => {
    if (seededPrompt) navigation.setParams({ prompt: undefined });
  }, [navigation, seededPrompt]);

  const onStatusChip = useCallback(
    (chip: RailChip) => {
      // The row is written inside `toggleStatus`, BEFORE this line — so on a
      // plane the fact lands and only the turn fails. A null means the write
      // threw and nothing happened, which is better than a half-done gesture.
      const next = toggleStatus(chip);
      if (next) chat.send(next.prompt);
    },
    [chat]
  );
  const onStatusEnd = useCallback((chip: RailChip & { openId: string }) => {
    const next = endOpenStatus(chip);
    if (next) setSeedState((prev) => seedFromRail(prev, next.prompt));
  }, []);

  // "Talk about this" on the tapped reminder (0064): seeds, never sends, and
  // drops the param so the row's mark goes with it.
  const onTalk = useCallback(
    (reminder: ReminderRow) => {
      setSeedState((prev) => seedFromTap(prev, talkAboutReminder(reminder.title)));
      navigation.setParams({ reminderId: undefined });
    },
    [navigation]
  );

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
                highlightId={reminderId ?? null}
                onTalk={onTalk}
              />
            ) : null}

            {/* The Coach's own planned notifications, each with Cancel (owner's
                Q1). Directly under his reminders: both are "what will buzz",
                and the two are kept apart because only his are his. */}
            {hasPlanned ? (
              <View className={hasReminders ? 'mt-6' : ''}>
                <NudgesCard
                  nudges={planned.nudges}
                  today={planned.today}
                  onCancel={planned.cancel}
                  blocked={planned.blocked}
                />
              </View>
            ) : null}

            {hasConversation ? (
              // No enclosure and no label: the conversation sits straight on the
              // sheet (see the surface note above). The gap is one step wider than
              // a section gap because the turns no longer have a container holding
              // them apart from the card above.
              <View className={hasCards ? 'mt-7' : ''}>
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
              <View className={hasCards ? 'mt-6' : ''}>
                <SuggestedPrompts onPick={onSend} />
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

          {/* A tapped check-in (0064): the Coach is answering it, or it did
              not — and when it did not, the line says why rather than leaving
              a tap that opened onto nothing (the plan's open question on a
              skipped check-in). Same quiet voice as the activity line. */}
          {chat.isResponding ? null : (
            <CheckinLine answering={passThread.answering} outcome={passThread.checkin} />
          )}

          {chat.pendingWrite ? (
            <PendingWriteCard pending={chat.pendingWrite} onResolve={chat.resolveWrite} />
          ) : null}

          {/* ONE door, docked on the composer's own opaque band directly above
              the input — not the five chips, which stood here from 2026-09-19
              until the owner used the build on 2026-09-21: *"buttons for the
              status thing on the coach tab need to be moved and put behind
              another button."* The five now live in the sheet Home was already
              opening.

              What keeps a RUNNING status visible without opening anything is
              the door itself: it reads `STATUS` on most days and the status's
              own name — `SICK` — while one is on (2026-09-23, the owner's note
              on Home, applied to the same component here). Until then the open
              chip was drawn beside it; the re-ask and the × it carried are in
              the sheet, one tap further in.

              Hidden under a pending write for the same reason the activity
              line is: the loop is suspended waiting on one decision, and a
              second set of live controls beside it would invite a gesture that
              cannot happen. Disabled — not hidden — while a turn runs, so the
              door does not appear and vanish on every question. */}
          <StatusControl
            open={statuses.open}
            docked
            disabled={chat.isResponding}
            hidden={decisionOpen}
            onToggle={onStatusChip}
            onEnd={onStatusEnd}
          />

          {/* The React key is the seed's counter: ChatInput owns its draft, so
              reseeding it means remounting it. Arriving with no prompt is the
              ordinary case and mounts exactly as before. */}
          <ChatInput
            key={composerKey(seed)}
            initialText={seed.text}
            onSend={onSend}
            disabled={chat.isResponding}
            blockedReason={decisionOpen ? 'Answer the proposed change to continue' : undefined}
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}
