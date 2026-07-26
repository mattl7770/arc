import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import type { MissionItem } from '@/types/home';

import { MissionItemRow } from './mission-item';

type Props = {
  leadingSettled: MissionItem[];
  rest: MissionItem[];
  completed: number;
  total: number;
  onToggle: (id: string) => void;
};

/**
 * Section 3 — Today's Mission.
 *
 * Serif heading, mono counter, hairline-ruled rows: the checklist reads like
 * entries in a ledger.
 *
 * **One chronological list, not category groups** (owner call, 2026-07-24).
 * The order you read is the order you act, so the hero and the list can never
 * disagree about what is next. Category rides along as a label on each row.
 *
 * The only concession to length is that the run of already-settled items at
 * the top folds into a single line, so the list opens at *now*. Nothing still
 * pending is ever hidden — including things you are late for. That is the
 * whole distinction from the collapsible sections this screen used to refuse:
 * disclosure is allowed to hide history, never work.
 */
export function Mission({ leadingSettled, rest, completed, total, onToggle }: Props) {
  const [showSettled, setShowSettled] = useState(false);
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  // Folding one row saves nothing and costs a tap.
  const collapsible = leadingSettled.length > 1 && !showSettled;
  const visible = collapsible ? rest : [...leadingSettled, ...rest];

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
        {collapsible ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Show ${leadingSettled.length} earlier items`}
            onPress={() => setShowSettled(true)}
            className="flex-row items-center gap-1.5 py-3 active:opacity-60">
            <Ionicons name="chevron-down" size={14} color={palette.inkMuted} />
            <Text className="text-[13px] text-ink-muted">
              {leadingSettled.length} earlier today
            </Text>
          </Pressable>
        ) : null}

        {/*
          Explicit hairlines rather than `divide-y`: that utility relies on
          a CSS sibling selector, which has no React Native equivalent.
        */}
        {visible.map((item, index) => (
          <View
            key={item.id}
            className={index === 0 && !collapsible ? '' : 'border-t border-hairline-soft'}>
            <MissionItemRow item={item} onToggle={onToggle} />
          </View>
        ))}
      </View>
    </View>
  );
}
