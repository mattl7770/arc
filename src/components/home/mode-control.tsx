import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { palette } from '@/constants/theme';
import { MODE_KEYS, getModeDefinition, type ModeKey } from '@/lib/modes/registry';

/**
 * The Home mode control (docs/information-architecture.md §Modes): "a quiet
 * control near the date/status, because a mode is a fact about *today* set in
 * the moment... A small persistent indicator shows the active mode so it's
 * never silently on."
 *
 * Deliberately NEUTRAL, never pine: Home's one sanctioned accent is already
 * spent on the hero card, and a mode is a state, not an action. So the
 * indicator is the app's standard status chip (paper-deep + mono caps, the
 * settings.tsx `Chip` shape) and Normal reads as a bare muted "Set mode" —
 * quiet when nothing is on, unmistakable when something is.
 *
 * Whole class strings only (no `bg-${x}` templating) — Tailwind's scanner sees
 * literals, per src/components/home/signal.tsx.
 */

/** The picker rows, Normal first so "back to normal" is always the top choice. */
const PICKER_ORDER: readonly ModeKey[] = MODE_KEYS;

export function ModeControl({
  mode,
  onSelect,
}: {
  mode: ModeKey;
  onSelect: (mode: ModeKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = mode !== 'normal';
  const def = getModeDefinition(mode);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={active ? `Mode: ${def.label}. Change` : 'Set mode'}
        onPress={() => setOpen(true)}
        className="flex-row items-center gap-1.5 rounded-btn px-2 py-0.5 active:bg-paper-deep">
        {active ? (
          <View className="rounded-btn bg-paper-deep px-2 py-0.5">
            <Text className="font-mono text-[9.5px] uppercase tracking-[1px] text-ink-muted">
              {def.label}
            </Text>
          </View>
        ) : (
          <Text className="text-[11px] uppercase tracking-[2px] text-ink-muted">Set mode</Text>
        )}
        <Ionicons name="chevron-down" size={12} color={palette.inkMuted} />
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setOpen(false)}>
        <SafeAreaView edges={['top', 'bottom']} className="flex-1 bg-paper">
          <View className="flex-row items-center justify-between px-5 pt-2">
            <Text className="font-serif text-lg font-semibold text-ink">Today&rsquo;s mode</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={() => setOpen(false)}
              className="rounded-btn p-2 active:bg-paper-deep">
              <Ionicons name="close" size={20} color={palette.inkSecondary} />
            </Pressable>
          </View>
          <Text className="px-5 pt-1 text-[13px] leading-5 text-ink-secondary">
            A mode adapts today&rsquo;s plan, what the hero pushes, and how the Coach talks. A
            skipped item under Travel, Sick, or Social is excused, not a miss.
          </Text>

          <ScrollView contentContainerClassName="px-5 pb-10 pt-5">
            <View className="rounded-card border border-hairline bg-porcelain">
              {PICKER_ORDER.map((key, index) => {
                const option = getModeDefinition(key);
                const selected = key === mode;
                return (
                  <Pressable
                    key={key}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${option.label}. ${option.tagline}`}
                    onPress={() => {
                      setOpen(false);
                      onSelect(key);
                    }}
                    className={`flex-row items-center gap-3 px-4 py-3 active:bg-paper-deep ${
                      index === 0 ? '' : 'border-t border-hairline-soft'
                    }`}>
                    <View className="flex-1">
                      <Text className="text-[15px] text-ink">{option.label}</Text>
                      <Text className="mt-0.5 text-[12px] text-ink-muted">{option.tagline}</Text>
                    </View>
                    {selected ? (
                      <Ionicons name="checkmark" size={18} color={palette.inkSecondary} />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
            <Text className="mt-3 text-[11px] leading-4 text-ink-muted">
              Applies to today. Work you&rsquo;ve already logged is kept — only untouched items
              change.
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}
