import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { logSymptom } from '@/lib/db/repositories/symptoms';

/**
 * Symptom capture — note what's off, as it happens (owner priority, 2026-07-25).
 * Reached from the Log tab's "Log a symptom" row. A common-symptom strip fills
 * the name, an optional 1–10 severity, an optional note; "Log" persists to the
 * `symptoms` table (0004) and returns to the Log tab, where it appears in
 * "Logged today". The Coach correlates these against protocols/labs/wearables.
 *
 * Conformed Set treatment (00-design-spec.md §1): a form is controls, not
 * content blocks, so the shared `SectionLabel` names each group and whitespace
 * separates them — no plate wrapped round a text field. The deviceless screen
 * is a **decision, not an oversight**: it is form (b) of the capture-surface
 * rule recorded in src/components/ui/block.tsx. Inputs are drawn as
 * **recessed stock** (the well's own surface). The severity scale is an
 * instrument: a fixed five-across rank of square keys with every digit in mono.
 *
 * The severity scale carries **no signal colour**. A reported symptom is
 * biology, but the number is a control the user is setting, and painting 8–10
 * red would have the interface pre-judging a reading it has not interpreted —
 * the firewall runs both ways (00-design-spec.md §2).
 */
const COMMON = [
  'Headache',
  'Fatigue',
  'Nausea',
  'Joint pain',
  'Brain fog',
  'Poor sleep',
  'Low energy',
  'Congestion',
];

const SEVERITY = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * A text field drawn as recessed stock — the well device's surface applied to
 * the control itself, rather than a `<Block device="well">` boxed around one.
 * A well around a surfaced input stacks two recesses, and the only way to keep
 * the inner one legible is to raise it onto plate stock; an input is never
 * `bg-paper-hi` (src/components/ui/block.tsx).
 */
const INPUT = 'border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';

/** Whole class strings, never a built prefix. Both states clear 44pt. */
const CHIP = 'min-h-[44px] justify-center rounded-btn border border-hairline bg-paper-hi px-3';
const CHIP_ON = 'min-h-[44px] justify-center rounded-btn border border-ink bg-ink px-3';
const RANK = 'h-11 items-center justify-center rounded-btn border border-hairline';
const RANK_ON = 'h-11 items-center justify-center rounded-btn border border-ink bg-ink';

export default function SymptomScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [severity, setSeverity] = useState<number | null>(null);
  const [note, setNote] = useState('');

  const canLog = name.trim().length > 0;

  const log = () => {
    if (!canLog) return;
    try {
      logSymptom(getDb(), {
        date: todayISODate(),
        name: name.trim(),
        severity,
        notes: note.trim() || null,
      });
      router.back();
    } catch (error) {
      // A failed write must not crash the tap handler.
      console.warn('[log] symptom capture failed', error);
    }
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Log Symptom" />
      </View>

      {/* Common symptoms — fill the name */}
      <View className="mt-2">
        <SectionLabel label="Common" />
        <View className="mt-2 flex-row flex-wrap gap-2">
          {COMMON.map((s) => {
            const on = name.trim() === s;
            return (
              <Pressable
                key={s}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setName(s)}
                className={on ? CHIP_ON : CHIP}>
                <Text
                  className={
                    on
                      ? 'font-label text-[13px] font-semibold text-paper-hi'
                      : 'font-label text-[13px] font-semibold text-ink-secondary'
                  }>
                  {s}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Name */}
      <View className="mt-8">
        <SectionLabel label="Symptom" />
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Lower-back pain"
          placeholderTextColor={palette.inkMuted}
          className={`mt-2 ${INPUT}`}
          accessibilityLabel="Symptom name"
        />
      </View>

      {/* Severity — five across, two rows: a rank, not a scatter of pills. */}
      <View className="mt-8">
        <SectionLabel label="Severity (optional)" />
        <View className="-mx-0.5 mt-2 flex-row flex-wrap">
          {SEVERITY.map((n) => {
            const on = severity === n;
            return (
              <View key={n} className="w-1/5 p-0.5">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Severity ${n} of 10`}
                  accessibilityState={{ selected: on }}
                  onPress={() => setSeverity((cur) => (cur === n ? null : n))}
                  className={on ? RANK_ON : RANK}>
                  <Text
                    className={
                      on
                        ? 'font-mono text-[15px] font-semibold text-paper-hi'
                        : 'font-mono text-[15px] text-ink-secondary'
                    }>
                    {n}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </View>
        <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
          1 = barely there · 10 = worst imaginable
        </Text>
      </View>

      {/* Note */}
      <View className="mt-8">
        <SectionLabel label="Note (optional)" />
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="Context for the Coach — triggers, timing, what helped…"
          placeholderTextColor={palette.inkMuted}
          multiline
          className={`mt-2 max-h-28 min-h-[64px] leading-5 ${INPUT}`}
          accessibilityLabel="Note"
        />
      </View>

      {/* The one pine action on this screen. Disabled is a bordered recess:
          ink-muted clears 4.5:1 on paper-dim, which it does not on hairline. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Log symptom"
        accessibilityState={{ disabled: !canLog }}
        disabled={!canLog}
        onPress={log}
        className={
          canLog
            ? 'mt-8 min-h-[48px] flex-row items-center justify-center gap-2 rounded-btn bg-pine active:opacity-70'
            : 'mt-8 min-h-[48px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline bg-paper-dim'
        }>
        <Ionicons
          name="pulse-outline"
          size={18}
          color={canLog ? palette.pineOn : palette.inkMuted}
        />
        <Text
          className={
            canLog
              ? 'font-label text-[12px] font-semibold uppercase tracking-[1px] text-pine-on'
              : 'font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink-muted'
          }>
          Log symptom
        </Text>
      </Pressable>
    </Screen>
  );
}
