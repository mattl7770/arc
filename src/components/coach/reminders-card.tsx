import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import type { ReminderRow } from '@/lib/reminders/types';

/**
 * Section: active reminders — the in-app surfacing of rows the user or the
 * Coach created (0009_reminders.sql). Renders nothing when empty.
 *
 * A reminder with a time is ALSO handed to the OS as a local notification, so it
 * can fire while the app is closed (src/lib/notifications/reminders.ts, resynced
 * at boot and after every Coach turn) — when the running build has the
 * notifications native module, permission is granted, and the moment is still
 * ahead. None of that is guaranteed, so this list is the floor, not a fallback:
 * an untimed reminder, or a timed one the OS never accepted, lives here and
 * nowhere else. Nothing in this UI should claim a phone alert will arrive.
 *
 * ## Conformed Set treatment
 *
 * The **ruled plate** device — a schedule is a record, and a record is a table.
 * Titles are serif ("serif speaks"), the time/repeat/origin line is mono ("mono
 * measures"), and the section note carries the tally so the block states its own
 * length instead of making you count rows.
 *
 * ## The row actions are words, not icons
 *
 * The sheet's `.cf-miniact` is a small bordered button reading **"Done"** /
 * **"Dismiss"** in the label voice; this row drew two 44×44 icon squares — a
 * checkmark and a close glyph — instead. The words are the correct port and not
 * merely the faithful one. A bare ✓/✕ pair on a reminder is genuinely ambiguous
 * about the thing that matters here: dismissing is NOT completing, and a close
 * glyph is read as "hide this" about as often as "I didn't do it". The labels
 * say which is which without a tooltip, in the same label voice the section
 * heading above them uses, and they survive a screenshot and a colour-blind
 * reader — the same argument that put the speaker's name on a chat turn instead
 * of relying on a corner radius (coach/message-bubble.tsx).
 *
 * The 44pt floor (§4) is non-negotiable and is kept by PADDING, not by shrinking
 * to fit the text: `min-h-[44px]` plus horizontal padding, with a small
 * `hitSlop` because the width here is set by a condensed-caps label whose real
 * metrics this file cannot measure — "Done" is the narrow case, and the slop is
 * what guarantees the horizontal floor whatever Avenir Next Condensed does with
 * it. Both accessibility labels are unchanged: they already named the reminder
 * ("Mark "X" done"), which is what a screen reader needs and what a visible
 * two-word label still does not carry on its own.
 *
 * Both take `ink-secondary`, as `.cf-miniact` does. The old split — secondary
 * for the check, muted for the close — was ranking two icons that could not rank
 * themselves; verbs do it in words, so the ink no longer has to.
 *
 * ## The tapped row (0064)
 *
 * A reminder's notification opens this tab with that reminder's id. The row
 * it names is marked with a small filled ink square before its title — the
 * same "this one" mark Settings uses for the chosen model, a mark and not a
 * device, so nothing nests — and gains one more action beneath it, **Talk
 * about this**, which seeds the composer with the reminder and never sends
 * (the composer-seed rule, src/lib/status/composer-seed.ts). That is the whole
 * of a plain reminder's tap (owner's Q5); a CHECK-IN's tap also has the Coach
 * speak first, in the thread below. A check-in says so in its meta line.
 */
export function RemindersCard({
  reminders,
  onComplete,
  onDismiss,
  highlightId,
  onTalk,
}: {
  reminders: ReminderRow[];
  onComplete: (id: string) => void;
  onDismiss: (id: string) => void;
  /** The reminder whose notification was just tapped, if any. */
  highlightId?: string | null;
  /** "Talk about this" on the tapped row. */
  onTalk?: (reminder: ReminderRow) => void;
}) {
  if (reminders.length === 0) return null;

  return (
    <Block device="plate">
      <SectionLabel
        label="Reminders"
        note={reminders.length === 1 ? '1 active' : `${reminders.length} active`}
      />

      <View className="mt-1">
        {reminders.map((reminder) => {
          const tapped = highlightId === reminder.id;
          return (
            <View key={reminder.id}>
              {/* Unconditional: the section label above is the row this rule
                separates from, so even the first reminder has something above
                it. */}
              <Divider />
              <View className="min-h-[44px] flex-row items-center gap-3 py-2">
                <View className="flex-1">
                  <View className="flex-row items-center gap-2">
                    {tapped ? (
                      <View
                        className="h-1.5 w-1.5 bg-ink"
                        accessibilityElementsHidden
                        importantForAccessibility="no"
                      />
                    ) : null}
                    <Text className="flex-1 font-serif text-[15px] leading-5 text-ink">
                      {reminder.title}
                    </Text>
                  </View>
                  <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                    {reminder.time ?? 'anytime'}
                    {reminder.repeat !== 'once' ? ` · ${reminder.repeat}` : ''}
                    {reminder.checkin === 1 ? ' · check-in' : ''}
                    {reminder.created_by === 'ai' ? ' · via Coach' : ''}
                  </Text>
                </View>
                {/* `.cf-miniacts` — the pair travels together at its own 8pt
                  gap, so the title's `gap-3` separates the group from the text
                  rather than opening a hole between the two buttons. */}
                <View className="flex-row gap-2">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Mark "${reminder.title}" done`}
                    onPress={() => onComplete(reminder.id)}
                    hitSlop={{ left: 4, right: 4 }}
                    className="min-h-[44px] items-center justify-center border border-hairline px-2.5 active:opacity-60">
                    <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
                      Done
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Dismiss "${reminder.title}"`}
                    onPress={() => onDismiss(reminder.id)}
                    hitSlop={{ left: 4, right: 4 }}
                    className="min-h-[44px] items-center justify-center border border-hairline px-2.5 active:opacity-60">
                    <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
                      Dismiss
                    </Text>
                  </Pressable>
                </View>
              </View>
              {tapped && onTalk ? (
                <View className="pb-2">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Talk about "${reminder.title}" with the Coach`}
                    onPress={() => onTalk(reminder)}
                    className="min-h-[44px] items-center justify-center self-start border border-hairline px-2.5 active:opacity-60">
                    <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
                      Talk about this
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </Block>
  );
}
