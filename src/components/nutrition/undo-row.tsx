import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { Divider } from '@/components/ui/block';
import { palette } from '@/constants/theme';
import type { UndoOffer } from '@/lib/nutrition/undo-store';

/**
 * The Undo row — what food logging says back after a removal or a combine
 * (owner, device, 2026-09-23: *"undo for removing a food"*).
 *
 * **It is the Log tab's water receipt, drawn again** (src/components/log/
 * quick-add-grid.tsx): a ruled row of the plate it sits in — a `Divider`, never
 * a second device — at the 44 pt floor, a 15 pt glyph for the thing acted on,
 * the sentence, and **Undo** in the label voice at the right. No toast, no
 * motion and no timer, for that row's reasons: the design system has neither
 * vocabulary, and an affordance you have to race is worse than one that waits.
 * No accent: the screen's pine stays where it is.
 *
 * **One voice change from the precedent, and why.** The water row is all mono
 * because `Logged 16 oz` is a measurement. `Removed Greek yogurt` is speech with
 * a food's name in it, so the sentence is serif and only its figure — `150
 * kcal` — is mono (00-design-spec.md §3: serif speaks, mono measures).
 *
 * **A refused Undo keeps the row and loses the button.** When the record moved
 * before the tap (src/lib/nutrition/undo-store.ts), the same row reads the
 * offer's `refusal` — *Could not put Greek yogurt back — the meal has changed
 * since.* — so the tap visibly did something: it was answered. No signal
 * colour: nothing biological went wrong.
 *
 * `first` drops the rule when the row opens a list of its own — the Eat tab's
 * empty day, where the meal just deleted was the only one.
 */
export function UndoRow({
  offer,
  onUndo,
  first = false,
}: {
  offer: UndoOffer;
  onUndo: () => void;
  first?: boolean;
}) {
  return (
    <View className={first ? 'mt-2' : 'mt-3'}>
      <Divider first={first} />
      <View className="mt-2 min-h-[44px] flex-row items-center gap-3">
        <Ionicons name={offer.icon} size={15} color={palette.inkSecondary} />
        {offer.refused ? (
          <Text className="flex-1 py-2 font-serif text-[13px] leading-5 text-ink-secondary">
            {offer.refusal}
          </Text>
        ) : (
          <>
            <Text className="flex-1 font-serif text-[13px] leading-5 text-ink-secondary">
              {offer.said}
              {offer.figure ? (
                <Text className="font-mono text-[11px] text-ink-secondary">{` · ${offer.figure}`}</Text>
              ) : null}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={offer.spoken}
              onPress={onUndo}
              className="min-h-[44px] items-center justify-center px-2 active:opacity-60">
              <Text className="font-label text-[12px] font-semibold text-ink">Undo</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}
