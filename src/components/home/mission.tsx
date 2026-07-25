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
 * Serif heading, mono counter, hairline-ruled rows: the checklist reads like
 * entries in a ledger. Grouped but not collapsible: docs/home-screen.md allows
 * collapsing "if needed", and if the list is short enough to be achievable it
 * should not need hiding. If it ever does, the list is too long.
 */
export function Mission({ sections, completed, total, onToggle }: Props) {
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

  return (
    <View>
      <View className="flex-row items-baseline justify-between">
        <Text className="font-serif text-lg font-semibold text-ink">Today’s Mission</Text>
        <Text className="font-mono text-xs text-ink-secondary">
          {completed} of {total}
        </Text>
      </View>

      <View className="mt-3 h-[3px] overflow-hidden rounded-full bg-hairline">
        <View className="h-full rounded-full bg-pine" style={{ width: `${percent}%` }} />
      </View>

      <View className="mt-2">
        {sections.map((section) => (
          <View key={section.id} className="mt-4">
            <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
              {section.title}
            </Text>
            {/*
              Explicit hairlines rather than `divide-y`: that utility relies on
              a CSS sibling selector, which has no React Native equivalent.
            */}
            <View className="mt-0.5">
              {section.items.map((item, index) => (
                <View key={item.id} className={index === 0 ? '' : 'border-t border-hairline-soft'}>
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
