import { Text, View } from 'react-native';

import type { Metric } from '@/types/home';

import { signalTextClass } from './signal';

/**
 * Section 5, and now the last thing on the screen — minimal live metrics, set
 * like lab values: mono numerals, muted small-caps labels, no charts, no
 * history. Anything that invites interpretation belongs in the Data tab; this
 * is only here so the readiness verdict above has visible evidence behind it.
 *
 * Unruled and unheaded on purpose: each cell already carries a caps label, so
 * a section heading would stack caps on caps, and a rule above would box it in.
 * The 2×2 grid and the space above it are enough to read as its own block.
 */
export function MetricsStrip({ metrics }: { metrics: Metric[] }) {
  return (
    <View className="flex-row flex-wrap">
      {metrics.map((metric) => (
        <View key={metric.id} className="w-1/2 py-3 pr-4">
          <Text className="text-[11px] uppercase tracking-[2px] text-ink-muted">
            {metric.label}
          </Text>
          <Text
            className={`mt-1 font-mono text-lg font-semibold ${
              metric.level && metric.level !== 'unknown'
                ? signalTextClass(metric.level)
                : 'text-ink'
            }`}>
            {metric.value}
          </Text>
          {metric.detail ? (
            <Text className="mt-0.5 text-xs text-ink-secondary">{metric.detail}</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}
