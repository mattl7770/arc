import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';

/**
 * Single-number entry — the "calibrated instrument" drill-in (direction F,
 * living as a secondary screen). Reached by tapping a numeric tile (Weight,
 * Water) or switched via the metric chips. Big mono readout, a full keypad,
 * recent values with a trend.
 *
 * Interactive skeleton: the keypad drives a local readout so the feel is real,
 * but "Log" doesn't persist yet (it just returns). Wiring it to `wearable_data`
 * / `body_metrics` is the next step (docs/information-architecture.md).
 */
type Metric = {
  key: string;
  label: string;
  unit: string;
  /** Mock recent readings + a one-line trend, shown under the readout. */
  recent: string;
};

const METRICS: Metric[] = [
  { key: 'weight', label: 'Weight', unit: 'lb', recent: '178.9 · 179.1 · 7-day ↓ 0.9' },
  { key: 'water', label: 'Water', unit: 'oz', recent: '64 so far today · goal 100' },
  { key: 'body_fat', label: 'Body-fat', unit: '%', recent: '14.8 · 15.1 · trending down' },
  { key: 'waist', label: 'Waist', unit: 'in', recent: '32.5 · 32.6 · steady' },
  {
    key: 'hrv',
    label: 'HRV',
    unit: 'ms',
    recent: '42 · 49 baseline · usually auto from Apple Health',
  },
  { key: 'rhr', label: 'Resting HR', unit: 'bpm', recent: '58 · 54 baseline · usually auto' },
  { key: 'dose', label: 'Dose', unit: 'mg', recent: 'last: 500 mg' },
];

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'] as const;

export default function MetricEntryScreen() {
  const router = useRouter();
  const { metric } = useLocalSearchParams<{ metric?: string }>();
  const [activeKey, setActiveKey] = useState(
    () => METRICS.find((m) => m.key === metric)?.key ?? 'weight'
  );
  const [value, setValue] = useState('');

  const active = useMemo(
    () => METRICS.find((m) => m.key === activeKey) ?? METRICS[0]!,
    [activeKey]
  );

  const press = (key: (typeof KEYS)[number]) => {
    if (key === 'del') {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (key === '.') {
      setValue((v) => (v.includes('.') ? v : v === '' ? '0.' : v + '.'));
      return;
    }
    setValue((v) => {
      // Cap significant digits so the big readout can't overflow its row.
      if (v.replace('.', '').length >= 6) return v;
      return v === '0' ? key : v + key;
    });
  };

  const switchMetric = (key: string) => {
    setActiveKey(key);
    setValue('');
  };

  // A logged value must be a real positive number — 0, "0.", "0.0" are not
  // loggable for any of these metrics.
  const canLog = Number(value) > 0;

  return (
    <Screen edges={['top', 'bottom']}>
      <View className="pt-2">
        <StackHeader title={active.label} />
      </View>

      {/* Metric switch chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="-mx-5 mt-1 grow-0"
        contentContainerClassName="gap-2 px-5">
        {METRICS.map((m) => {
          const on = m.key === activeKey;
          return (
            <Pressable
              key={m.key}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => switchMetric(m.key)}
              className={`rounded-btn border px-3 py-1.5 ${
                on ? 'border-hairline-strong bg-paper-deep' : 'border-hairline'
              }`}>
              <Text className={`text-[13px] ${on ? 'font-medium text-ink' : 'text-ink-muted'}`}>
                {m.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Readout */}
      <View className="mt-8 flex-row items-baseline justify-center gap-2">
        <Text
          numberOfLines={1}
          className={`font-mono text-6xl ${value ? 'text-ink' : 'text-ink-muted'}`}>
          {value || '0'}
        </Text>
        <Text className="font-mono text-lg text-ink-muted">{active.unit}</Text>
      </View>
      <Text className="mt-2 text-center text-xs text-ink-muted">{active.recent}</Text>

      {/* Keypad */}
      <View className="mt-8 flex-1 justify-end">
        <View className="-mx-1.5 flex-row flex-wrap">
          {KEYS.map((key) => (
            <View key={key} className="w-1/3 p-1.5">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={key === 'del' ? 'Delete' : key}
                onPress={() => press(key)}
                className="h-16 items-center justify-center rounded-card active:bg-paper-deep">
                {key === 'del' ? (
                  <Ionicons name="backspace-outline" size={24} color={palette.inkSecondary} />
                ) : (
                  <Text className="font-mono text-2xl text-ink">{key}</Text>
                )}
              </Pressable>
            </View>
          ))}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Log ${active.label}`}
          accessibilityState={{ disabled: !canLog }}
          disabled={!canLog}
          onPress={() => router.back()}
          className={`mt-4 h-12 items-center justify-center rounded-btn ${
            canLog ? 'bg-pine active:opacity-70' : 'bg-hairline'
          }`}>
          <Text
            className={`text-[15px] font-semibold ${canLog ? 'text-pine-on' : 'text-ink-muted'}`}>
            Log {active.label}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}
