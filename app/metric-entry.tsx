import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { logMetric, recentSummary } from '@/lib/db/repositories/logs';
import {
  isLoggableCanonical,
  METRICS,
  metricByKey,
  type MetricDescriptor,
  type MetricKey,
} from '@/lib/log/metrics';

/**
 * Single-number entry — the "calibrated instrument" drill-in (direction F,
 * living as a secondary screen). Reached by tapping a numeric tile (Weight,
 * Water) or switched via the metric chips. Big mono readout, a full keypad,
 * a live "recent" line, and — for Water — additive quick-estimates.
 *
 * Fully wired: "Log" converts the typed display value to the metric's canonical
 * unit and writes it (src/lib/db/repositories/logs.ts → body_metrics /
 * wearable_data / log_entries), then returns; the Log tab re-reads on focus.
 */
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'] as const;

/** Additive water shortcuts, sitting just above the keypad (Water only). */
const WATER_QUICK = [
  { label: 'Glass', oz: 8 },
  { label: 'Bottle', oz: 16 },
  { label: 'Large', oz: 24 },
] as const;

/** Cap significant digits so the big readout can't overflow its row. */
function withinCap(next: string): boolean {
  return next.replace('.', '').length <= 6;
}

export default function MetricEntryScreen() {
  const router = useRouter();
  const { metric } = useLocalSearchParams<{ metric?: string }>();
  const today = todayISODate();
  const initialKey = metricByKey(metric ?? '')?.key ?? 'weight';

  const [activeKey, setActiveKey] = useState<MetricKey>(initialKey);
  const [value, setValue] = useState('');
  const [recent, setRecent] = useState(() => recentSummary(getDb(), initialKey, today));

  const active = useMemo<MetricDescriptor>(
    () => metricByKey(activeKey) ?? METRICS[0]!,
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
      const next = v === '0' ? key : v + key;
      return withinCap(next) ? next : v;
    });
  };

  const addWater = (oz: number) => {
    setValue((v) => {
      const next = String((Number(v) || 0) + oz);
      return withinCap(next) ? next : v;
    });
  };

  const switchMetric = (key: MetricKey) => {
    setActiveKey(key);
    setValue('');
    setRecent(recentSummary(getDb(), key, today));
  };

  // A logged value must be a real positive number within the metric's domain:
  // 0/"0."/blank, and out-of-range body values (e.g. body-fat > 100, weight
  // ≥ 1000 kg) are not loggable — they'd otherwise trip a schema CHECK and throw
  // out of this handler.
  const canonical = active.toCanonical(Number(value));
  const canLog = isLoggableCanonical(active, canonical);
  const outOfRange = value !== '' && Number(value) > 0 && !canLog;

  const log = () => {
    if (!canLog) return;
    try {
      logMetric(getDb(), today, active.key, canonical);
      router.back();
    } catch (error) {
      // canLog already gates the known cases; this is a backstop so a write
      // failure never crashes the tap handler.
      console.warn('[log] metric write failed', error);
    }
  };

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
          maxFontSizeMultiplier={1.3}
          className={`font-mono text-6xl ${value ? 'text-ink' : 'text-ink-muted'}`}>
          {value || '0'}
        </Text>
        <Text className="font-mono text-lg text-ink-muted">{active.displayUnit}</Text>
      </View>
      <Text className="mt-2 text-center text-xs text-ink-muted">
        {outOfRange ? `That looks out of range for ${active.label.toLowerCase()}` : recent}
      </Text>

      {/* Keypad */}
      <View className="mt-8 flex-1 justify-end">
        {active.key === 'water' ? (
          <View className="mb-3 flex-row gap-2">
            {WATER_QUICK.map((q) => (
              <Pressable
                key={q.label}
                accessibilityRole="button"
                accessibilityLabel={`Add ${q.oz} ounces (${q.label})`}
                onPress={() => addWater(q.oz)}
                className="flex-1 items-center rounded-btn border border-hairline bg-porcelain py-2 active:bg-paper-deep">
                <Text className="text-[13px] font-medium text-ink">{q.label}</Text>
                <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">+{q.oz} oz</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

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
                  <Text maxFontSizeMultiplier={1.3} className="font-mono text-2xl text-ink">
                    {key}
                  </Text>
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
          onPress={log}
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
