import { Text, View } from 'react-native';

import type { Pillar, Readiness } from '@/types/home';

import { SignalDot, signalBgClass } from './signal';

type Props = {
  readiness: Readiness;
  pillars: Pillar[];
};

/**
 * Readiness verdict + pillar segment bar, below the hero (owner call,
 * 2026-07-24): the screen answers "what do I do" before "how am I doing".
 *
 * Porcelain Ledger treatment: serif verdict, flat 6px segments with 2px gaps
 * (a typeset gauge, not a chart — no glow, near-square ends), mono-caps
 * labels beneath like column headings.
 */
export function ReadinessStrip({ readiness, pillars }: Props) {
  return (
    <View>
      <View className="flex-row items-center gap-2.5">
        <SignalDot level={readiness.level} />
        <Text className="font-serif text-lg font-semibold text-ink">{readiness.label}</Text>
      </View>

      <Text className="mt-1.5 text-sm leading-5 text-ink-secondary">{readiness.detail}</Text>

      <View className="mt-4 flex-row gap-0.5">
        {pillars.map((pillar) => (
          <View key={pillar.label} className="flex-1">
            <View className={`h-[6px] rounded-[1px] ${signalBgClass(pillar.level)}`} />
            <Text className="mt-1.5 font-mono text-[11px] uppercase tracking-[1px] text-ink-muted">
              {pillar.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
