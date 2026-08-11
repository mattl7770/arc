import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Block, Divider } from '@/components/ui/block';
import { PaperGrid } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { listRoutines } from '@/lib/db/repositories/routines';
import type { RoutineListItem } from '@/lib/exercise/types';

/**
 * A small modal that picks one routine (or "Rest") for a program weekday. Reads
 * the routines once; no filtering — a user's routine list is short.
 * `onSelect(null)` clears the day to a rest day.
 *
 * ## The surface system (00-design-spec.md §1)
 *
 *   Choices   plate   one ruled record of everything this day could be
 *
 * Rest is the first line of that same plate rather than a card floating above
 * it: it is one of the options, not a different kind of thing, and two stacked
 * enclosures for one list of choices is exactly the flatness the surface system
 * exists to avoid.
 *
 * **No accent.** Picking a row *is* the action here, and it is a plain tap;
 * the budget is a ceiling, not a quota.
 */
type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (routine: { id: string; name: string } | null) => void;
};

export function RoutinePicker({ visible, onClose, onSelect }: Props) {
  const [routines] = useState<RoutineListItem[]>(() => listRoutines(getDb()));

  const choose = (routine: { id: string; name: string } | null) => {
    onClose();
    onSelect(routine);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      {/* A native Modal never passes through `<Screen>`, so it prints the sheet
          itself — outside the SafeAreaView and outside the ScrollView. */}
      <View className="flex-1 bg-paper">
        <PaperGrid />
        <SafeAreaView edges={['top', 'bottom']} className="flex-1">
          <View className="flex-1 px-5">
            <View className="flex-row items-center gap-1 pb-1 pt-2">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={onClose}
                className="-ml-2 h-11 w-11 items-center justify-center active:opacity-60">
                <Ionicons name="close" size={22} color={palette.ink} />
              </Pressable>
              <Text className="font-serif text-lg font-semibold text-ink">Assign routine</Text>
            </View>

            <ScrollView
              className="mt-2 flex-1"
              keyboardShouldPersistTaps="handled"
              contentContainerClassName="pb-8">
              <Block device="plate">
                <SectionLabel label="This day runs" />

                <View className="mt-1">
                  {/* Rest is an option on the same list, not a separate card. */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Set as a rest day"
                    onPress={() => choose(null)}
                    className="min-h-[44px] flex-row items-center gap-3 py-2 active:opacity-60">
                    <Ionicons name="bed-outline" size={17} color={palette.inkSecondary} />
                    <Text className="flex-1 font-serif text-[15px] text-ink">Rest day</Text>
                  </Pressable>

                  {routines.length === 0 ? (
                    <>
                      {/* Ruled off the Rest-day row above it. A `border-t` on a
                          Text draws a box around the sentence — see Divider. */}
                      <Divider />
                      <Text className="pt-2.5 font-serif text-[13px] leading-5 text-ink-secondary">
                        No routines yet. Build a routine first, then a program can schedule it.
                      </Text>
                    </>
                  ) : (
                    routines.map((r) => (
                      <View key={r.id}>
                        {/* Unconditional: the Rest-day row above is what the
                            first rule separates this list from. */}
                        <Divider />
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Assign ${r.name}`}
                          onPress={() => choose({ id: r.id, name: r.name })}
                          className="min-h-[44px] flex-row items-center gap-3 py-2 active:opacity-60">
                          <Text className="flex-1 font-serif text-[15px] text-ink">{r.name}</Text>
                          <Text className="font-mono text-[10px] text-ink-muted">
                            {r.exerciseCount} ex · {r.totalSets} sets
                          </Text>
                        </Pressable>
                      </View>
                    ))
                  )}
                </View>
              </Block>
            </ScrollView>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
