import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import { nudgeDayLabel } from '@/lib/notifications/nudge-plan';

/** One nudge as this card draws it — the row's own fields, nothing derived. */
export type NudgeListItem = { id: string; day: string; time: string; body: string };

/**
 * Section: the notifications the Coach planned for itself (0064,
 * docs/spikes/coach-notifications.md). Renders nothing when there are none.
 *
 * Owner's Q1: the Coach may schedule a nudge without asking first, "each
 * listed and cancellable on the Coach tab and recorded in the thread". This is
 * the list, and Cancel is the one control on it. What it lists is exactly what
 * the OS resync schedules (`upcomingNudges`), so the card and the phone cannot
 * disagree about what is coming.
 *
 * ## What it does not claim
 *
 * Like the reminders card beside it, nothing here says the phone WILL buzz:
 * that needs permission, and Focus decides the rest. When the last sync found
 * permission refused, `blocked` says so in one line, because a list of
 * scheduled notifications that cannot arrive is the one misleading version of
 * this card.
 *
 * ## Conformed Set
 *
 * The **ruled plate**, the reminders card's device and for its reason: a
 * schedule is a record. The Coach's line is serif (it is words), the day and
 * time are mono (measures), and Cancel is the label-voice mini action the
 * reminders card uses for Done and Dismiss — ink-secondary, bordered, 44pt by
 * padding. No accent: the tab's budget is the composer's.
 */
export function NudgesCard({
  nudges,
  today,
  onCancel,
  blocked,
}: {
  nudges: NudgeListItem[];
  /** The logical day, so a row can say "today" or "tomorrow". */
  today: string;
  onCancel: (id: string) => void;
  /** The last sync found notification permission refused. */
  blocked?: boolean;
}) {
  if (nudges.length === 0) return null;

  return (
    <Block device="plate">
      <SectionLabel
        label="Scheduled by the Coach"
        note={nudges.length === 1 ? '1 notification' : `${nudges.length} notifications`}
      />

      <View className="mt-1">
        {nudges.map((nudge) => {
          const when = `${nudgeDayLabel(nudge.day, today)} · ${nudge.time}`;
          return (
            <View key={nudge.id}>
              <Divider />
              <View className="min-h-[44px] flex-row items-center gap-3 py-2">
                <View className="flex-1">
                  <Text className="font-serif text-[15px] leading-5 text-ink">{nudge.body}</Text>
                  <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">{when}</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Cancel the notification for ${when}: ${nudge.body}`}
                  onPress={() => onCancel(nudge.id)}
                  hitSlop={{ left: 4, right: 4 }}
                  className="min-h-[44px] items-center justify-center border border-hairline px-2.5 active:opacity-60">
                  <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
                    Cancel
                  </Text>
                </Pressable>
              </View>
            </View>
          );
        })}
      </View>

      {blocked ? (
        <>
          <Divider />
          <Text className="py-2 font-serif text-[12px] leading-5 text-ink-secondary">
            Notifications are off for ARC in iOS Settings, so these will not reach your lock screen.
          </Text>
        </>
      ) : null}
    </Block>
  );
}
