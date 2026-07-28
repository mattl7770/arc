import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { listRoutines } from '@/lib/db/repositories/routines';
import type { RoutineListItem } from '@/lib/exercise/types';

/**
 * A small modal that picks one routine (or "Rest") for a program weekday. Reads
 * the routines once; no filtering — a user's routine list is short. Porcelain
 * Ledger: porcelain rows, mono set counts, no pine (selection is the action, and
 * it's a plain tap). `onSelect(null)` clears the day to a rest day.
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
      <SafeAreaView edges={['top', 'bottom']} className="flex-1 bg-paper">
        <View className="flex-1 px-5">
          <View className="flex-row items-center gap-1 pb-1 pt-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              className="-ml-2 h-9 w-9 items-center justify-center rounded-btn active:opacity-60">
              <Ionicons name="close" size={22} color={palette.ink} />
            </Pressable>
            <Text className="font-serif text-lg font-semibold text-ink">Assign routine</Text>
          </View>

          <ScrollView
            className="mt-2 flex-1"
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="pb-8">
            {/* Rest day */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Set as a rest day"
              onPress={() => choose(null)}
              className="mb-2 flex-row items-center gap-3 rounded-card border border-hairline bg-porcelain px-4 py-3 active:bg-paper-deep">
              <Ionicons name="bed-outline" size={18} color={palette.inkSecondary} />
              <Text className="flex-1 text-[15px] text-ink">Rest day</Text>
            </Pressable>

            {routines.length === 0 ? (
              <Text className="mt-2 text-[13px] leading-5 text-ink-muted">
                No routines yet. Build a routine first, then a program can schedule it.
              </Text>
            ) : (
              <View className="rounded-card border border-hairline bg-porcelain">
                {routines.map((r, i) => (
                  <Pressable
                    key={r.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Assign ${r.name}`}
                    onPress={() => choose({ id: r.id, name: r.name })}
                    className={`flex-row items-center gap-3 px-4 py-3 active:bg-paper-deep ${
                      i === 0 ? '' : 'border-t border-hairline-soft'
                    }`}>
                    <Text className="flex-1 text-[15px] text-ink">{r.name}</Text>
                    <Text className="font-mono text-[11px] text-ink-muted">
                      {r.exerciseCount} ex · {r.totalSets} sets
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </ScrollView>
        </View>
      </SafeAreaView>
    </Modal>
  );
}
