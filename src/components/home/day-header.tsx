import { Text, View } from 'react-native';

import type { Pillar, Readiness } from '@/types/home';

import { SignalDot } from './signal';

type Props = {
  readiness: Readiness;
  pillars: Pillar[];
};

/**
 * Section 1 — Top status bar.
 *
 * The first thing read on opening the app, so it is one short verdict plus the
 * number behind it. The pillar row is deliberately small: it is orientation,
 * not analysis.
 */
export function DayHeader({ readiness, pillars }: Props) {
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <View>
      <Text className="text-xs uppercase tracking-widest text-ink-400 dark:text-ink-600">
        {today}
      </Text>

      <View className="mt-3 flex-row items-center gap-2.5">
        <SignalDot level={readiness.level} />
        <Text className="text-2xl font-semibold tracking-tight text-ink-900 dark:text-ink-50">
          {readiness.label}
        </Text>
      </View>

      <Text className="mt-1.5 text-sm leading-5 text-ink-500 dark:text-ink-400">
        {readiness.detail}
      </Text>

      <View className="mt-5 flex-row flex-wrap items-center gap-x-5 gap-y-2">
        {pillars.map((pillar) => (
          <View key={pillar.label} className="flex-row items-center gap-1.5">
            <SignalDot level={pillar.level} small />
            <Text className="text-xs text-ink-500 dark:text-ink-400">{pillar.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
