import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import type { MissionItem, MissionStatus } from '@/types/home';

type Props = {
  item: MissionItem;
  onToggle: (id: string) => void;
};

/**
 * One ruled line of Today's Mission. The whole row is the tap target, so
 * completing anything is a single tap from opening the app, and the row keeps
 * an explicit min-height so a single-line entry still clears 44pt.
 *
 * Conformed Set treatment: the title is set in the serif voice, times and
 * measurements in mono, the category strip in the label voice. This row carries no
 * device of its own — it lives inside the mission plate, and devices never
 * nest (src/components/ui/block.tsx).
 *
 * Since the list went chronological (2026-07-24), the row carries its own
 * category — it is what tells you a 21:45 entry is a supplement and not a
 * meal, work the section heading used to do. That has to hold audibly too:
 * an explicit accessibilityLabel REPLACES the children's text in RN rather
 * than adding to it, so time and category are folded into the label below.
 * Without that they are simply never announced, and the sentence above would
 * be true of the screen and false of the reader.
 */
export function MissionItemRow({ item, onToggle }: Props) {
  const done = item.status === 'completed';
  const skipped = item.status === 'skipped';
  const muted = done || skipped;

  // Time first because the list is chronological, then what it is, then what
  // kind of thing it is, then its state. Longer than the title alone, and
  // deliberately so: every part carries information the row shows visually.
  const spokenRow = [item.scheduledTime, item.title, item.category, STATUS_SPOKEN[item.status]]
    .filter(Boolean)
    .join(', ');

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done }}
      accessibilityLabel={spokenRow}
      onPress={() => onToggle(item.id)}
      className="min-h-[44px] flex-row gap-3 py-3 active:opacity-60">
      <View className="pt-0.5">
        <StatusBox status={item.status} />
      </View>

      <View className="flex-1">
        <View className="flex-row items-start justify-between gap-3">
          <Text
            className={
              muted
                ? 'flex-1 font-serif text-[15px] leading-5 text-ink-muted'
                : 'flex-1 font-serif text-[15px] leading-5 text-ink'
            }
            style={skipped ? { textDecorationLine: 'line-through' } : undefined}>
            {item.title}
          </Text>

          {item.scheduledTime ? (
            <Text className="font-mono text-[11px] text-ink-muted">{item.scheduledTime}</Text>
          ) : null}
        </View>

        {item.why && !muted ? (
          <Text className="mt-1 font-serif text-[13px] leading-5 text-ink-secondary">
            {item.why}
          </Text>
        ) : null}

        <View className="mt-1.5 flex-row items-center gap-2">
          <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            {item.category}
          </Text>
          {item.protocol ? (
            <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
              · {item.protocol}
            </Text>
          ) : null}
          {item.snoozed && item.status === 'pending' ? (
            <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
              · Snoozed
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/**
 * Completion state as a single 22pt square control, stamped in the accent when
 * done — a completion stamp is one of the three things Home spends accent on.
 * Square, because corners are square across this design; a skipped item takes
 * a struck bar rather than a colour, since skipped is not done and must never
 * borrow the done treatment.
 */
function StatusBox({ status }: { status: MissionStatus }) {
  if (status === 'completed') {
    return (
      <View className="h-[22px] w-[22px] items-center justify-center bg-pine">
        <Ionicons name="checkmark" size={14} color={palette.pineOn} />
      </View>
    );
  }

  if (status === 'skipped') {
    return (
      <View className="h-[22px] w-[22px] items-center justify-center border border-hairline">
        <View className="h-[1.5px] w-2.5 bg-ink-muted" />
      </View>
    );
  }

  if (status === 'partial') {
    return (
      <View className="h-[22px] w-[22px] items-center justify-center border-[1.5px] border-pine">
        <View className="h-2 w-2 bg-pine" />
      </View>
    );
  }

  return <View className="h-[22px] w-[22px] border-[1.5px] border-hairline" />;
}

/**
 * The same four states in words, for assistive tech — the spoken twin of
 * {@link StatusBox}, mirroring the SPOKEN map in ./signal.tsx.
 *
 * **Four visual states cannot collapse into two spoken ones.** The row is a
 * `checkbox` with `checked: status === 'completed'`, and that single boolean is
 * all a listener used to get, so `skipped` and `partial` both announced
 * identically to `pending` — "unchecked". Every carrier that separates them is
 * purely visual: skipped is a struck bar plus a line-through title, partial is a
 * half-filled box. Neither has any accessible equivalent.
 *
 * That is the same defect the strip two files up (./mission.tsx) and the pillar
 * cells one file over (./readiness-strip.tsx) were just rewritten to close, and
 * it fails 00-design-spec.md §5 in both directions at once: an item you already
 * dismissed is announced as still outstanding, and a half-done item is announced
 * as untouched.
 *
 * The role and the checked state stay exactly as they were — they are what makes
 * the row read as a toggle at all, and the accent-stamped tick still means done.
 * The word is appended to the label, so `completed` reads "…, completed,
 * checked" and `skipped` reads "…, skipped, unchecked": the state is now exact
 * and the affordance still announces. `pending`'s word is redundant with
 * "unchecked" by design — the map is total, because a partial map is how three
 * of these went unspoken in the first place.
 *
 * Product nouns for a state, nothing rhetorical (00-design-spec.md §5). Whole
 * literals in a lookup, never built from a fragment.
 */
const STATUS_SPOKEN: Record<MissionStatus, string> = {
  completed: 'completed',
  partial: 'partly done',
  skipped: 'skipped',
  pending: 'not done',
};
