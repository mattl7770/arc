import { Text, View } from 'react-native';

import type { Pillar, Readiness } from '@/types/home';

import { SignalDot, signalBgClass } from './signal';

type Props = {
  readiness: Readiness;
  pillars: Pillar[];
};

/**
 * Readiness verdict + pillar segment bar — Option D from the 2026-07-24
 * mock-up round, placed BELOW the hero (owner call): the screen answers
 * "what do I do" before "how am I doing".
 *
 * The four pillars compress into one slim segment bar, each segment lit in
 * its signal colour with the label beneath. The verdict is text-xl, not the
 * old 2xl — below the hero it is evidence, not the headline, and it must not
 * out-shout the hero title above it.
 */
export function ReadinessStrip({ readiness, pillars }: Props) {
  return (
    <View>
      <View className="flex-row items-center gap-2.5">
        <SignalDot level={readiness.level} />
        <Text className="text-xl font-semibold tracking-tight text-ink-900 dark:text-ink-50">
          {readiness.label}
        </Text>
      </View>

      <Text className="mt-1.5 text-sm leading-5 text-ink-500 dark:text-ink-400">
        {readiness.detail}
      </Text>

      <View className="mt-4 flex-row gap-1.5">
        {pillars.map((pillar) => (
          <View key={pillar.label} className="flex-1">
            <View className={`h-[5px] rounded-full ${signalBgClass(pillar.level)}`} />
            <Text className="mt-1.5 text-[11px] text-ink-500 dark:text-ink-600">
              {pillar.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
