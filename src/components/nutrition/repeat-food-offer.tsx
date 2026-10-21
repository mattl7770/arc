import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Divider } from '@/components/ui/block';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { saveRepeatAsFood, takeRepeatFoodOffer } from '@/lib/db/repositories/food-history';
import type { RepeatFood } from '@/lib/nutrition/repeats';

/** What the Eat tab holds of the offer for this visit. */
export type RepeatOfferState = { repeat: RepeatFood; saved: boolean } | null;

/**
 * The repeat-food offer for one visit to a day list (owner, device round 3,
 * items 73/74). Taken on focus — read AND recorded as offered in one act
 * (`takeRepeatFoodOffer`), because the offer is made once — and held for the
 * rest of the visit, so a re-read of the day does not make it vanish under the
 * thumb. Leaving the tab ends it; it is never offered again.
 */
export function useRepeatFoodOffer(date: string): {
  offer: RepeatOfferState;
  save: () => void;
  dismiss: () => void;
} {
  const [offer, setOffer] = useState<RepeatOfferState>(null);
  useFocusEffect(
    useCallback(() => {
      try {
        const repeat = takeRepeatFoodOffer(getDb(), date);
        if (repeat) setOffer({ repeat, saved: false });
      } catch (error) {
        console.warn('[repeat-food] offer unavailable', error);
      }
      return () => setOffer(null);
    }, [date])
  );
  const save = () => {
    if (!offer || offer.saved) return;
    try {
      saveRepeatAsFood(getDb(), offer.repeat);
      setOffer({ ...offer, saved: true });
    } catch (error) {
      console.warn('[repeat-food] save failed', error);
    }
  };
  return { offer, save, dismiss: () => setOffer(null) };
}

/**
 * The row: *Oat latte — logged 3 times the same way.* with **Save as a food**,
 * and once saved, *Saved Oat latte as a food. Find it in Add food.* with no
 * button. A ruled row of the plate it sits in — the Undo row's anatomy
 * (src/components/nutrition/undo-row.tsx): the 44 pt floor, a 15 pt glyph,
 * the sentence in serif with its count in mono, the action in the label voice,
 * no accent. **Not now** closes it for this visit; it is not offered again
 * either way.
 */
export function RepeatFoodRow({
  offer,
  onSave,
  onDismiss,
}: {
  offer: NonNullable<RepeatOfferState>;
  onSave: () => void;
  onDismiss: () => void;
}) {
  const { repeat, saved } = offer;
  const name = repeat.latest.name;
  return (
    <View className="mt-3">
      <Divider />
      <View className="mt-2 min-h-[44px] flex-row items-center gap-3">
        <Ionicons
          name={saved ? 'checkmark' : 'bookmark-outline'}
          size={15}
          color={palette.inkSecondary}
        />
        {saved ? (
          <Text className="flex-1 py-2 font-serif text-[13px] leading-5 text-ink-secondary">
            {`Saved ${name} as a food. Find it in Add food.`}
          </Text>
        ) : (
          <>
            <Text className="flex-1 py-2 font-serif text-[13px] leading-5 text-ink-secondary">
              {name}
              <Text className="font-mono text-[11px] text-ink-secondary">{` · logged ${repeat.times}×`}</Text>
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Save ${name} as a food`}
              onPress={onSave}
              className="min-h-[44px] items-center justify-center px-2 active:opacity-60">
              <Text className="font-label text-[12px] font-semibold text-ink">Save as a food</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Not now — do not save ${name}`}
              onPress={onDismiss}
              className="min-h-[44px] items-center justify-center px-2 active:opacity-60">
              <Text className="font-label text-[12px] text-ink-muted">Not now</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}
