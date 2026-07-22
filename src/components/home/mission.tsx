import { Text, View } from 'react-native';

import type { MissionSection } from '@/types/home';

import { MissionItemRow } from './mission-item';

type Props = {
  sections: MissionSection[];
  completed: number;
  total: number;
  onToggle: (id: string) => void;
};

/**
 * Section 3 — Today's Mission.
 *
 * Grouped but not collapsible: docs/home-screen.md allows collapsing "if
 * needed", and if the list is short enough to be achievable it should not need
 * hiding. If it ever does, that is a signal the list is too long, not that it
 * needs a disclosure triangle.
 */
export function Mission({ sections, completed, total, onToggle }: Props) {
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

  return (
    <View>
      <View className="flex-row items-baseline justify-between">
        <Text className="text-lg font-semibold tracking-tight text-ink-900 dark:text-ink-50">
          Today’s Mission
        </Text>
        <Text className="text-xs tabular-nums text-ink-500 dark:text-ink-400">
          {completed} of {total}
        </Text>
      </View>

      <View className="mt-3 h-[3px] overflow-hidden rounded-full bg-ink-200 dark:bg-ink-800">
        <View className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </View>

      <View className="mt-2">
        {sections.map((section) => (
          <View key={section.id} className="mt-4">
            <Text className="text-[11px] font-medium uppercase tracking-widest text-ink-400 dark:text-ink-600">
              {section.title}
            </Text>
            {/*
              Explicit hairlines rather than `divide-y`: that utility relies on
              a CSS sibling selector, which has no React Native equivalent.
            */}
            <View className="mt-0.5">
              {section.items.map((item, index) => (
                <View
                  key={item.id}
                  className={index === 0 ? '' : 'border-t border-ink-100 dark:border-ink-800'}>
                  <MissionItemRow item={item} onToggle={onToggle} />
                </View>
              ))}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
