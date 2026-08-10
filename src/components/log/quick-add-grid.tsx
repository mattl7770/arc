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
 * Conformed Set treatment — the **grid** device (00-design-spec.md §1): no outer
 * box, because the grid is the object. That is also the honest reading of these
 * six: they are equal peers, none of them is "the one next action", so none of
 * them carries the accent. The screen's single pine lives on the command field's
 * send button.
 *
 * ## The rules are gone here too, and a tap target is the interesting case
 *
 * These cells used to carry a hairline on top and a vertical between columns.
 * With six tiles filling two full rows that draws a full-width rule above each
 * row and two verticals inside each — a 3×2 lattice with no left, right or
 * bottom edge, which is precisely the *half-drawn box* the owner reported on
 * hardware ("weird boxes and lines"). Same defect as the Home metrics strip,
 * same fix: alignment and whitespace hold the columns (see
 * src/components/home/metrics-strip.tsx, and block.tsx — **a grid draws no
 * rules**).
 *
 * This block was worth arguing about separately, because unlike every other grid
 * in the app **these cells are tap targets, not readouts**, and a border is one
 * of the standard ways a control says it is pressable. Three things say it here
 * without one:
 *
 *   - the 20px Ionicon, which no readout in this app carries;
 *   - the **label voice** on the caption — this design reserves that face for
 *     labels and buttons, so it reads as a control, not as a value (mono would
 *     have been the readout voice, and these deliberately are not mono);
 *   - `active:bg-paper-dim`, which fills the whole third on press and draws its
 *     own edge at the moment the edge is actually wanted.
 *
 * Boxing each tile instead — six *closed* hairline boxes, which would not be
 * half-drawn — was the real alternative and was rejected: it puts a drawn
 * enclosure inside `device="grid"`, re-opening the exact convention split this
 * sweep exists to close, and it trades one unexplained mark for eighteen more
 * strokes on the Log tab's busiest block.
 *
 * With no rules there is no "does a cell follow this one in the same row"
 * question, so the `COLUMNS` modulo and the two-class `cellClass` are gone —
 * every tile takes the same class. Class strings are whole literals, never built
 * from a prefix: Tailwind's scanner only sees names that appear literally in
 * source.
 */
type Tile = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  href: Href;
};

/**
 * One tile. Uniform on every cell — no rules, so no column special-casing.
 *
 * The padding is symmetric (`px-2.5`) rather than the left/right gutter split
 * the readout grids use, because here the padded box IS the tap target and the
 * press fill draws it: an asymmetric fill under the thumb would look like a
 * misaligned control. 20pt of gutter still separates adjacent captions, and
 * `py-3.5` gives the two rows the rhythm the top rules used to.
 */
const TILE = 'w-1/3 min-h-[68px] gap-2 px-2.5 py-3.5 active:bg-paper-dim';

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

      {/* No margin: the tiles' own `py-3.5` is the row rhythm. */}
      <View className="flex-row flex-wrap">
        {TILES.map((tile) => (
          <Pressable
            key={tile.key}
            accessibilityRole="button"
            accessibilityLabel={tile.label}
            onPress={() => router.push(tile.href)}
            className={TILE}>
            <Ionicons name={tile.icon} size={20} color={palette.inkSecondary} />
            {/* A tile label is a button label — the label voice. */}
            <Text className="font-label text-[12px] font-semibold text-ink">{tile.label}</Text>
          </Pressable>
        ))}
      </View>
    </Block>
  );
}
