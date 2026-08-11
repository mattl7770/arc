import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';

/**
 * The Coach's daily brief.
 *
 * Conformed Set treatment — the **margin** device, which as of 2026-08-09 draws
 * nothing. Prose does not belong in a card, so this block stays unboxed; but it
 * no longer carries the 2px left rule and indent it used to, either.
 *
 * That rule was one of the two things the owner named on first seeing the
 * design on hardware ("weird boxes and lines... notably the metrics and coach
 * brief"). The diagnosis: a margin rule marks an *aside* — a note running
 * alongside the thing it comments on. Here the prose is not an aside, it is the
 * section, the only content in its slot, with a section label above it and
 * seven units of air on either side. A single vertical stroke beside a
 * paragraph that annotates nothing reads as a rendering glitch, not as an
 * annotation mark. The full reasoning is in src/components/ui/block.tsx.
 *
 * Set in the serif voice, because serif speaks and mono measures. The label,
 * the dot and the air around it are what say "this is the Coach" — none of
 * which anyone has to learn a drafting metaphor to read.
 *
 * The whole block opens the full conversation, so the brief is an entry point
 * rather than a dead end.
 *
 * **The presence dot is on the accent budget; nothing else here is.**
 * 00-design-spec.md §2 names "the Coach presence dot" explicitly in the app-wide
 * list of things the accent is allowed to mark, alongside the Home hero, one
 * primary action per screen, completion stamps, the user's own chat bubbles and
 * the active tab. It is sanctioned — please do not strip it again (it was
 * removed once as an over-correction and restored by owner decision). It marks
 * the Coach's presence, which is chrome, so it never borrows a signal colour.
 *
 * The pine "Open chat" link, by contrast, stays gone: Home's one primary action
 * is the hero's Done, and the whole card is already pressable, so the link reads
 * in neutral ink as the quiet affordance it is.
 */
export function CoachBrief({ brief }: { brief: string }) {
  const router = useRouter();

  return (
    <Block device="margin">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open the full Coach conversation"
        onPress={() => router.push('/coach')}
        className="active:opacity-70">
        <View className="flex-row items-center gap-2">
          {/* Spec-sanctioned accent (§2). Decorative — the label carries the meaning. */}
          <View className="h-1.5 w-1.5 rounded-full bg-pine" />
          <View className="flex-1">
            <SectionLabel label="Coach Brief" />
          </View>
        </View>

        <Text className="mt-2 font-serif text-[15px] leading-6 text-ink-secondary">{brief}</Text>

        <View className="mt-3 min-h-[24px] flex-row items-center gap-1">
          {/* A bare text button is still a button — Label voice (§3). */}
          <Text className="font-label text-[13px] font-medium text-ink-secondary">Open chat</Text>
          <Ionicons name="chevron-forward" size={13} color={palette.inkSecondary} />
        </View>
      </Pressable>
    </Block>
  );
}
