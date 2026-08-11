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
 * Conformed Set treatment — a **plate** holding six boxed tiles, which is what
 * the sheet draws and, as of 2026-08-11, what the app draws again.
 *
 * ## This block was never the grid device (and that is why it lost its boxes)
 *
 * The sheet is explicit about it. The Quick Add block is a plain `.cf-block`,
 * i.e. a plate; inside it sits `.cf-tilegrid`, a `gap: 7px` grid of `.cf-tile`
 * elements, each one a CLOSED `1px solid var(--paper-line)` box on `paper-hi`.
 * `.cf-tilegrid` is not `.cf-dims`, so the `:has()` selector that strips the
 * plate off a metric grid never matched here — the sheet's own CSS keeps this
 * one plated and boxed.
 *
 * The RN port marked it `device="grid"` anyway, on the reasonable-sounding
 * ground that six equal cells in three columns is a grid. That reading cost it
 * twice over. First it inherited the metric grid's cell rules — a hairline on
 * top of each tile and a vertical between columns, drawn `border-t` /
 * `border-r`, which React Native paints as a complete rectangle
 * (src/components/ui/block.tsx). Then, when those boxes were reported off
 * hardware, the rules were deleted AND the alternative — restoring the sheet's
 * closed boxes — was rejected on the ground that "it puts a drawn enclosure
 * inside `device='grid'`". The premise was false: the enclosure is not inside a
 * grid, because this was never a grid.
 *
 * So the tiles are boxed again, and boxing them is also the right answer on the
 * merits, which is why the sheet does it. **These cells are tap targets, not
 * readouts**, and a border is one of the standard ways a control says it is
 * pressable. Nothing else on the Log tab is a 3×2 field of unbordered words.
 *
 * A `gap` and a border, not a rule between cells: six closed boxes separated by
 * air cannot produce a half-drawn anything, and each box is uniform on all four
 * sides so it takes React Native's fast border path the way a plate does.
 *
 * Gateway tiles carry a chevron, quick captures do not — the sheet marks
 * exactly Nutrition and Workout, and it is the one thing distinguishing "this
 * opens a whole sub-app" from "this opens a sheet you will be back from in ten
 * seconds".
 *
 * Class strings are whole literals, never built from a prefix: Tailwind's
 * scanner only sees names that appear literally in source.
 */
type Tile = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  href: Href;
  /** True for the two tiles that push a whole sub-app; they take the chevron. */
  gateway?: boolean;
};

/**
 * One tile: a closed hairline box on plate stock, uniform on all four sides.
 *
 * The width is `w-[31.5%]` rather than `w-1/3` because the gap is real geometry
 * now — three thirds plus two gutters overflows the row and wraps the third
 * tile. 31.5% × 3 = 94.5%, and the row's `justify-between` distributes the
 * remaining 5.5% as the two gutters, so the outer tiles stay flush with the
 * plate's padding at any width.
 *
 * **The tile itself must NOT be `justify-between`, and was for one commit.**
 * Only the two gateway tiles carry a chevron, so four of the six have just two
 * children — and `justify-between` hands all the slack to the single gap
 * between the icon and the label, pinning the caption against the right border.
 * With six tiles in a 3×2 field that put the captions at four different offsets
 * (Water has ~39pt of slack, Supplement ~13, Nutrition ~3) and four of them
 * touching the box edge. The layout wanted is "icon left, chevron right, label
 * beside the icon", which is `grow` on the label — it eats the slack itself and
 * pushes only the chevron away, so every caption starts at the same x whether
 * its tile has a chevron or not.
 */
const TILE =
  'w-[31.5%] min-h-[52px] flex-row items-center gap-1.5 border border-hairline bg-paper-hi px-2.5 py-3 active:bg-paper-dim';

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
  {
    key: 'nutrition',
    label: 'Nutrition',
    icon: 'restaurant-outline',
    href: '/nutrition',
    gateway: true,
  },
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
  { key: 'workout', label: 'Workout', icon: 'barbell-outline', href: '/exercise', gateway: true },
];

export function QuickAddGrid() {
  const router = useRouter();

  return (
    <Block device="plate">
      <SectionLabel label="Quick add" />

      {/* `gap-y-2` is the 7pt gutter between the two rows; `justify-between`
          supplies the horizontal one and keeps the outer tiles flush. */}
      <View className="mt-2 flex-row flex-wrap justify-between gap-y-2">
        {TILES.map((tile) => (
          <Pressable
            key={tile.key}
            accessibilityRole="button"
            accessibilityLabel={tile.label}
            onPress={() => router.push(tile.href)}
            className={TILE}>
            <Ionicons name={tile.icon} size={15} color={palette.inkSecondary} />
            {/* A tile label is a button label — the label voice. `grow` takes
                the tile's slack so every caption starts hard against the icon
                rather than floating (see TILE above); `shrink` lets the longest
                one — "Supplement" — ellipsise instead of shoving the chevron
                out of the box. */}
            <Text
              numberOfLines={1}
              className="shrink grow font-label text-[10px] font-bold text-ink">
              {tile.label}
            </Text>
            {tile.gateway ? (
              <Ionicons name="chevron-forward" size={11} color={palette.inkMuted} />
            ) : null}
          </Pressable>
        ))}
      </View>
    </Block>
  );
}
