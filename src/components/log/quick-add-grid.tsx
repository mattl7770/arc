import Ionicons from '@expo/vector-icons/Ionicons';
import { type Href, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';

/**
 * The six quick-add tiles (direction A). Two kinds, per
 * docs/information-architecture.md:
 *   - Gateway tiles push a full sub-app screen: Nutrition, Workout → Exercise.
 *   - Quick-capture tiles open a focused sheet or the metric keypad: Supplement,
 *     Water, Weight, Therapy. (Water/Weight are numbers, so they go to the
 *     keypad; Supplement/Therapy open the capture sheet, app/capture.tsx.)
 *
 * Layout (3 cols × 2 rows): the two gateway tiles sit together in the right
 * column; the quick captures fill the left and middle.
 *
 * **Every tile lands somewhere that writes.** All six destinations are built and
 * persist to the on-device database — the capture sheet was a stub when this
 * grid was drawn and no longer is. That matters more here than anywhere else on
 * the screen: this block is the answer the empty feed below points at, and a
 * tile that opens a screen which cannot finish the job would make that answer a
 * lie (00-design-spec.md §5).
 *
 * Conformed Set treatment — the **ruled grid** device (00-design-spec.md §1):
 * no outer box, hairlines *between* cells only, because the grid is the object.
 * That is also the honest reading of these six: they are equal peers, none of
 * them is "the one next action", so none of them carries the accent. The
 * screen's single pine lives on the command field's send button.
 *
 * React Native has neither CSS grid nor `:nth-child()`, so the modulo is done in
 * JS and the rules live on the cells (01-rn-port-guide.md §1.3). As in
 * home/metrics-strip.tsx, **the vertical rule is conditioned on a cell actually
 * following in the same row**, not on the column alone — otherwise a short final
 * row draws a rule into empty space, which is the outer edge this device exists
 * to avoid. Class strings are whole literals in a map, never built from a
 * prefix: Tailwind's scanner only sees names that appear literally in source.
 */
type Tile = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  href: Href;
};

const COLUMNS = 3;

/** A cell with another cell beside it: closes with a vertical rule. */
const CELL_RULED =
  'w-1/3 min-h-[68px] gap-2 border-r border-t border-hairline px-2.5 py-3 active:bg-paper-dim';
/** Last cell in its row (or in the grid): same box, no dangling rule. */
const CELL = 'w-1/3 min-h-[68px] gap-2 border-t border-hairline px-2.5 py-3 active:bg-paper-dim';

function cellClass(index: number, count: number): string {
  const lastInRow = index % COLUMNS === COLUMNS - 1;
  return lastInRow || index + 1 >= count ? CELL : CELL_RULED;
}

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
    <Block device="grid">
      <SectionLabel label="Quick add" />

      <View className="mt-2 flex-row flex-wrap">
        {TILES.map((tile, index) => (
          <Pressable
            key={tile.key}
            accessibilityRole="button"
            accessibilityLabel={tile.label}
            onPress={() => router.push(tile.href)}
            className={cellClass(index, TILES.length)}>
            <Ionicons name={tile.icon} size={20} color={palette.inkSecondary} />
            {/* A tile label is a button label — the label voice. */}
            <Text className="font-label text-[12px] font-semibold text-ink">{tile.label}</Text>
          </Pressable>
        ))}
      </View>
    </Block>
  );
}
