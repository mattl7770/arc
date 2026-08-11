import { useCallback, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { getDb } from '@/lib/db/client';
import {
  deleteMemory,
  listAllMemories,
  restoreMemory,
  type CoachMemoryRow,
} from '@/lib/db/repositories/coach-memory';

/**
 * Settings › Coach memory — everything the Coach durably knows about you.
 *
 * The point of this screen is inspectability: memory the user cannot read is
 * memory the user cannot trust (docs/ai-coach.md §4's ⚑ MATT question, settled
 * here). Every fact the Coach stored is listed with when it learned it and
 * whether it is still active, and any of it can be forgotten or deleted
 * outright. Reading is all this screen does besides removing — the Coach
 * writes memories through its confirmation-gated `remember` tool, so a fact
 * can never appear here without the user having approved it.
 */

const CATEGORY_LABEL: Record<CoachMemoryRow['category'], string> = {
  preference: 'Preference',
  constraint: 'Constraint',
  context: 'Context',
  goal: 'Goal',
};

export default function CoachMemoryScreen() {
  const [memories, setMemories] = useState<CoachMemoryRow[]>(() => listAllMemories(getDb()));
  const reload = useCallback(() => setMemories(listAllMemories(getDb())), []);
  useFocusEffect(reload);

  const active = memories.filter((m) => m.archived_at === null);
  const forgotten = memories.filter((m) => m.archived_at !== null);

  const confirmDelete = (memory: CoachMemoryRow) => {
    Alert.alert('Delete this memory?', memory.content, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteMemory(getDb(), memory.id);
          reload();
        },
      },
    ]);
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Coach memory" />
      </View>

      <Text className="mt-2 text-[13px] leading-6 text-ink-secondary">
        What the Coach knows about you between conversations. It only remembers what you approved,
        and everything here is yours to remove.
      </Text>

      {active.length === 0 ? (
        <View className="mt-5 rounded-card border border-hairline bg-porcelain px-4 py-4">
          <Text className="text-[15px] text-ink">Nothing remembered yet.</Text>
          <Text className="mt-1.5 text-[12px] leading-5 text-ink-secondary">
            When you tell the Coach something that stays true — how you like to train, a supplement
            that disagrees with you, what you’re working toward — it will ask to remember it.
          </Text>
        </View>
      ) : (
        <View className="mt-5 overflow-hidden rounded-card border border-hairline bg-porcelain">
          {active.map((memory, index) => (
            <View
              key={memory.id}
              className={`px-4 py-3 ${index > 0 ? 'border-t border-hairline-soft' : ''}`}>
              <Text className="text-[11px] uppercase tracking-[2px] text-ink-muted">
                {CATEGORY_LABEL[memory.category]}
              </Text>
              <Text className="mt-1 text-[15px] leading-6 text-ink">{memory.content}</Text>
              <View className="mt-2 flex-row items-center justify-between">
                <Text className="font-mono text-[11px] text-ink-muted">
                  since {memory.created_at.slice(0, 10)}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => confirmDelete(memory)}
                  className="active:opacity-60">
                  <Text className="text-[13px] text-ink-muted">Delete</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}

      {forgotten.length > 0 ? (
        <View className="mt-7">
          <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
            Forgotten
          </Text>
          <View className="mt-2 overflow-hidden rounded-card border border-hairline bg-paper-deep">
            {forgotten.map((memory, index) => (
              <View
                key={memory.id}
                className={`px-4 py-3 ${index > 0 ? 'border-t border-hairline-soft' : ''}`}>
                <Text className="text-[14px] leading-6 text-ink-muted">{memory.content}</Text>
                <View className="mt-2 flex-row items-center justify-between">
                  <Text className="font-mono text-[11px] text-ink-muted">
                    forgotten {(memory.archived_at ?? '').slice(0, 10)}
                  </Text>
                  <View className="flex-row gap-4">
                    <Pressable
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => {
                        restoreMemory(getDb(), memory.id);
                        reload();
                      }}
                      className="active:opacity-60">
                      <Text className="text-[13px] text-pine">Restore</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => confirmDelete(memory)}
                      className="active:opacity-60">
                      <Text className="text-[13px] text-ink-muted">Delete</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </Screen>
  );
}
