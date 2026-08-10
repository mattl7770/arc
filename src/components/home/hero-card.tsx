import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { palette } from '@/constants/theme';
import type { MissionItem } from '@/types/home';

type Props = {
  item: MissionItem | null;
  onDone: (id: string) => void;
  onSnooze: (id: string) => void;
  onSkip: (id: string) => void;
};

/**
 * The "Do this next" hero.
 *
 * Conformed Set treatment — the **stamped plate** device: paper-hi inside a
 * 1.5px accent border, square corners. It is the only block on the sheet drawn
 * in the accent, because it is the only block claiming to be the single most
 * important thing right now. If everything is emphasised, nothing is directive.
 *
 * All three voices in one block: the tag in `font-label` (tracked caps), the
 * headline and why-line in `font-serif` (serif speaks), the metadata line in
 * `font-mono` (mono measures). The primary action is solid in the accent and
 * the escapes are neutral ink, so the hierarchy of the three buttons is
 * unmistakable at a glance.
 *
 * All three controls — Done, Snooze, Skip — are set in `font-label`, per
 * 00-design-spec.md §3: "buttons" means every button at every weight, filled,
 * outlined or bare. Weight is carried by fill and ink, never by face; the three
 * share one size and casing because they are one control group, and a bare
 * escape that fell back to the reading face stopped looking pressable.
 */
export function HeroCard({ item, onDone, onSnooze, onSkip }: Props) {
  if (!item) return <MissionComplete />;

  const metadata = [
    item.scheduledTime,
    item.estimatedMinutes && `${item.estimatedMinutes} min`,
    item.protocol,
  ]
    .filter(Boolean)
    .join(' · ');

  const tag = item.category ? `${item.category} · Do this next` : 'Do this next';

  return (
    <Block device="stamp">
      <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-pine-deep">
        {tag}
      </Text>

      <Text className="mt-2 font-serif text-[22px] font-semibold leading-7 text-ink">
        {item.title}
      </Text>

      {metadata ? (
        <Text className="mt-2 font-mono text-[11px] text-ink-secondary">{metadata}</Text>
      ) : null}

      {item.why ? (
        <Text className="mt-3 font-serif text-[15px] leading-6 text-ink-secondary">{item.why}</Text>
      ) : null}

      <View className="mt-4 flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Mark ${item.title} done`}
          onPress={() => onDone(item.id)}
          className="min-h-[44px] flex-1 flex-row items-center justify-center gap-1.5 rounded-btn bg-pine px-4 py-3 active:opacity-70">
          <Ionicons name="checkmark" size={16} color={palette.pineOn} />
          <Text className="font-label text-sm font-semibold text-pine-on">Done</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Snooze ${item.title}`}
          onPress={() => onSnooze(item.id)}
          className="min-h-[44px] items-center justify-center rounded-btn border border-hairline px-5 py-3 active:opacity-60">
          <Text className="font-label text-sm font-medium text-ink-secondary">Snooze</Text>
        </Pressable>
      </View>

      <View className="mt-1 items-center">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Skip ${item.title}`}
          onPress={() => onSkip(item.id)}
          className="min-h-[44px] items-center justify-center rounded-btn px-6 py-3 active:opacity-60">
          <Text className="font-label text-sm font-medium text-ink-muted">Skip</Text>
        </Pressable>
      </View>
    </Block>
  );
}

/**
 * Shown once nothing is left. The reward for a clean day is a quiet page, so
 * this is the **measured field** device. It is a verdict about the day, not a
 * record of it — and since 2026-08-09 that device draws **nothing at all**: no
 * box, and no corner ticks either. The ticks were cut on the owner's first look
 * at hardware, where an 11px L floating with no outer edge read as a rendering
 * artefact rather than as "this region was measured" (block.tsx, "Devices that
 * stopped paying rent"). So the verdict is set apart here by air and by type —
 * the accent check disc, the serif headline — which is what was doing the work
 * anyway.
 *
 * The check is stamped in the accent rather than in a signal green: completion
 * is chrome, not biology, and the signal palette is reserved for biological
 * state (00-design-spec.md §2). The old green disc was on the wrong side of
 * that firewall.
 */
function MissionComplete() {
  return (
    <Block device="field">
      <View className="flex-row items-center gap-3">
        <View className="h-7 w-7 items-center justify-center bg-pine">
          <Ionicons name="checkmark" size={18} color={palette.pineOn} />
        </View>
        <Text className="flex-1 font-serif text-lg font-semibold text-ink">Today is handled</Text>
      </View>
      <Text className="mt-2.5 font-serif text-[14px] leading-6 text-ink-secondary">
        Nothing left on the list. Protect the evening wind-down and let recovery do its work.
      </Text>
    </Block>
  );
}
