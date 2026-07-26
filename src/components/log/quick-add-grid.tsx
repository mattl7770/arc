import Ionicons from '@expo/vector-icons/Ionicons';
import { type Href, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';

/**
 * The six quick-add tiles (direction A). Two kinds, per
 * docs/information-architecture.md:
 *   - Gateway tiles push a full sub-app screen: Nutrition, Workout → Exercise.
 *   - Quick-capture tiles open a focused sheet or the metric keypad: Supplement,
 *     Water, Weight, Therapy. (Water/Weight are numbers, so they go to the
 *     keypad; Supplement/Therapy open a capture sheet — a stub for now.)
 *
 * Layout (3 cols × 2 rows): the two gateway tiles sit together in the right
 * column; the quick captures fill the left and middle. No pine here — the tiles
 * are neutral porcelain; the screen's one accent is the command field's action.
 */
type Tile = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  href: Href;
};

const TILES: Tile[] = [
  // Row 1: Supplement · Water · Nutrition
  {
    key: 'supplement',
    label: 'Supplement',
    icon: 'medkit-outline',
    href: { pathname: '/capture', params: { type: 'supplement' } },
  },
  {
    key: 'water',
    label: 'Water',
    icon: 'water-outline',
    href: { pathname: '/metric-entry', params: { metric: 'water' } },
  },
  { key: 'nutrition', label: 'Nutrition', icon: 'restaurant-outline', href: '/nutrition' },
  // Row 2: Weight · Therapy · Workout
  {
    key: 'weight',
    label: 'Weight',
    icon: 'scale-outline',
    href: { pathname: '/metric-entry', params: { metric: 'weight' } },
  },
  {
    key: 'therapy',
    label: 'Therapy',
    icon: 'thermometer-outline',
    href: { pathname: '/capture', params: { type: 'therapy' } },
  },
  { key: 'workout', label: 'Workout', icon: 'barbell-outline', href: '/exercise' },
];

export function QuickAddGrid() {
  const router = useRouter();

  return (
    <View className="-mx-1 flex-row flex-wrap">
      {TILES.map((tile) => (
        <View key={tile.key} className="w-1/3 p-1">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={tile.label}
            onPress={() => router.push(tile.href)}
            className="items-start gap-2.5 rounded-card border border-hairline bg-porcelain px-3 pb-3 pt-3.5 active:opacity-60">
            <Ionicons name={tile.icon} size={22} color={palette.inkSecondary} />
            <Text className="font-serif text-[13px] text-ink">{tile.label}</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
