import Ionicons from '@expo/vector-icons/Ionicons';
import { type Href, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';

type Action = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  href?: Href;
};

const ACTIONS: Action[] = [
  { key: 'log', label: 'Log', icon: 'add-circle-outline', href: '/log' },
  { key: 'coach', label: 'Coach', icon: 'sparkles-outline', href: '/coach' },
  // Travel / Sick / Social / Manual day. Needs the override model before it
  // can do anything, so it is inert rather than fake.
  { key: 'mode', label: 'Mode', icon: 'swap-horizontal-outline' },
  { key: 'data', label: 'Data', icon: 'stats-chart-outline', href: '/data' },
];

/**
 * Section 6 — quick actions dock.
 *
 * Four escape hatches, evenly weighted, in incidental ink. Nothing here
 * competes with the hero for attention; these are for when you already know
 * what you want.
 */
export function QuickActions() {
  const router = useRouter();

  return (
    <View className="flex-row">
      {ACTIONS.map((action) => (
        <Pressable
          key={action.key}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          disabled={!action.href}
          onPress={() => action.href && router.push(action.href)}
          className={`flex-1 items-center gap-1.5 rounded-card py-3 ${
            action.href ? 'active:opacity-60' : 'opacity-40'
          }`}>
          <Ionicons name={action.icon} size={20} color={palette.inkMuted} />
          <Text className="text-[11px] text-ink-secondary">{action.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
