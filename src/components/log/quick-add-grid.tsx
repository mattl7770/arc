import Ionicons from '@expo/vector-icons/Ionicons';
import { type Href, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';

/**
 * The four quick-add tiles: Supplement, Water, Weight, Therapy. Every one opens
 * a focused sheet or the metric keypad and comes straight back — Water and
 * Weight are numbers so they go to the keypad, Supplement and Therapy open the
 * capture sheet (app/capture.tsx).
 *
 * ## The two gateway tiles are gone (owner, 2026-08-12)
 *
 * *"We don't need the nutrition and workout buttons in the quick log anymore."*
 * They were a different kind of thing wearing the same tile: not a capture, a
 * DOOR — each pushed a whole sub-app and left you there. That distinction had to
 * be drawn with a chevron precisely because nothing else about the tile said it.
 *
 * The reason they can go is that the doors moved. Eat and Train are tab roots on
 * the bottom bar as of 2026-08-09, one tap from anywhere, so this block was
 * offering a second, worse route to two screens the tab bar already reaches —
 * and spending a third of the busiest block on the Log tab to do it.
 *
 * What is left is one kind of tile with one behaviour, which is why the chevron
 * went with them: nothing here pushes a sub-app any more, so there is no longer
 * a distinction for a mark to carry. Four tiles in a 2 × 2 — see the layout note
 * on TILE for why not three across.
 *
 * **Every tile lands somewhere that writes.** All four destinations are built
 * and persist to the on-device database. That matters more here than anywhere
 * else on the screen: this block is the answer the empty feed below points at,
 * and a tile that opens a screen which cannot finish the job would make that
 * answer a lie (00-design-spec.md §5).
 *
 * Conformed Set treatment — a **plate** holding boxed tiles, which is what the
 * sheet draws and, as of 2026-08-11, what the app draws again.
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
 * Class strings are whole literals, never built from a prefix: Tailwind's
 * scanner only sees names that appear literally in source.
 */
type Tile = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  href: Href;
};

/**
 * One tile: a closed hairline box on plate stock, uniform on all four sides.
 *
 * **2 × 2, not 3 + 1.** With six tiles this was three columns; at four, a
 * three-wide row leaves a single orphan on the second row with two tile-widths
 * of empty plate beside it, which reads as a tile that failed to load rather
 * than as a grid that ended. Two columns of two is the only arrangement of four
 * that is regular in both directions.
 *
 * `w-[48.5%]` rather than `w-1/2` because the gutter is real geometry: two
 * halves plus a gap overflows the row and wraps the second tile. 48.5 × 2 = 97%,
 * and the row's `justify-between` spends the remaining 3% as the single gutter,
 * so the outer edges stay flush with the plate's padding at any width. The
 * wider tile also ends the truncation risk the three-wide layout carried —
 * "Supplement" had about 41pt to render in and now has roughly twice that.
 *
 * **The tile itself must NOT be `justify-between`.** It was for one commit, and
 * with the label as the only flexible child that hands all the slack to the gap
 * after the icon, pinning the caption against the right border. `grow` on the
 * label is the fix: it absorbs the slack itself so every caption starts hard
 * against its icon.
 */
const TILE =
  'w-[48.5%] min-h-[52px] flex-row items-center gap-1.5 border border-hairline bg-paper-hi px-2.5 py-3 active:bg-paper-dim';

const TILES: Tile[] = [
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
                the tile's slack so every caption starts hard against its icon
                rather than floating (see TILE above); `shrink` + `numberOfLines`
                stay as the backstop, though at half-width no label is close to
                needing them. */}
            <Text
              numberOfLines={1}
              className="shrink grow font-label text-[10px] font-bold text-ink">
              {tile.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </Block>
  );
}
