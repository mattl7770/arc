import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
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

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

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
        <SectionLabel>Common</SectionLabel>
        <View className="mt-2 flex-row flex-wrap gap-2">
          {COMMON.map((s) => {
            const on = name.trim() === s;
            return (
              <Pressable
                key={s}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setName(s)}
                className={`rounded-btn border px-3 py-2 active:bg-paper-deep ${
                  on ? 'border-hairline-strong bg-paper-deep' : 'border-hairline bg-porcelain'
                }`}>
                <Text
                  className={`text-[13px] ${on ? 'font-medium text-ink' : 'text-ink-secondary'}`}>
                  {s}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Name */}
      <View className="mt-8">
        <SectionLabel>Symptom</SectionLabel>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Lower-back pain"
          placeholderTextColor={palette.inkMuted}
          className="mt-2 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[15px] text-ink"
          accessibilityLabel="Symptom name"
        />
      </View>

      {/* Severity */}
      <View className="mt-8">
        <SectionLabel>Severity (optional)</SectionLabel>
        <View className="mt-2 flex-row flex-wrap gap-1.5">
          {SEVERITY.map((n) => {
            const on = severity === n;
            return (
              <Pressable
                key={n}
                accessibilityRole="button"
                accessibilityLabel={`Severity ${n} of 10`}
                accessibilityState={{ selected: on }}
                onPress={() => setSeverity((cur) => (cur === n ? null : n))}
                className={`h-9 w-9 items-center justify-center rounded-btn border active:bg-paper-deep ${
                  on ? 'border-hairline-strong bg-paper-deep' : 'border-hairline'
                }`}>
                <Text className={`font-mono text-[13px] ${on ? 'text-ink' : 'text-ink-muted'}`}>
                  {n}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text className="mt-1.5 text-[11px] text-ink-muted">
          1 = barely there · 10 = worst imaginable
        </Text>
      </View>

      {/* Note */}
      <View className="mt-8">
        <SectionLabel>Note (optional)</SectionLabel>
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="Context for the Coach — triggers, timing, what helped…"
          placeholderTextColor={palette.inkMuted}
          multiline
          className="mt-2 max-h-28 min-h-[64px] rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[15px] leading-5 text-ink"
          accessibilityLabel="Note"
        />
      </View>

      {/* The one pine action on this screen. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Log symptom"
        accessibilityState={{ disabled: !canLog }}
        disabled={!canLog}
        onPress={log}
        className={`mt-8 flex-row items-center justify-center gap-2 rounded-btn py-3.5 ${
          canLog ? 'bg-pine active:opacity-70' : 'bg-hairline'
        }`}>
        <Ionicons
          name="pulse-outline"
          size={18}
          color={canLog ? palette.pineOn : palette.inkMuted}
        />
        <Text className={`text-[15px] font-semibold ${canLog ? 'text-pine-on' : 'text-ink-muted'}`}>
          Log symptom
        </Text>
      </Pressable>
    </Screen>
  );
}
