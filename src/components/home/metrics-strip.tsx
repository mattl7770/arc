import { Text, View } from 'react-native';

import type { Metric } from '@/types/home';

import { signalTextClass } from './signal';

/**
 * Section 5 — minimal live metrics.
 *
 * Four numbers, no charts, no history. Anything that invites interpretation
 * belongs in the Data tab; this is only here so the readiness verdict above
 * has visible evidence behind it.
 */
export function MetricsStrip({ metrics }: { metrics: Metric[] }) {
  return (
    <View className="flex-row flex-wrap">
      {metrics.map((metric) => (
        <View key={metric.id} className="w-1/2 py-3 pr-4">
          <Text className="text-[11px] uppercase tracking-widest text-ink-400 dark:text-ink-600">
            {metric.label}
          </Text>
          <Text
            className={`mt-1 text-xl font-semibold tabular-nums tracking-tight ${
              metric.level && metric.level !== 'unknown'
                ? signalTextClass(metric.level)
                : 'text-ink-900 dark:text-ink-50'
            }`}>
            {metric.value}
          </Text>
          {metric.detail ? (
            <Text className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">{metric.detail}</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}
