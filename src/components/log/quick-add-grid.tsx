import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, type Href, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { getPreferences } from '@/lib/db/repositories/user';
import { deleteWaterEntry, logWater, usualWaterAmount } from '@/lib/db/repositories/water';
import { metricByKey, resolveDisplay, roundToSpec, type DisplaySpec } from '@/lib/log/metrics';
import { defaultWaterAmount, WATER_QUICK_AMOUNTS } from '@/lib/log/water-amounts';

/**
 * The four quick-add tiles: Supplement, **Water**, Weight, Therapy. Three of
 * them open a focused sheet or the metric keypad and come straight back — Weight
 * is a number so it goes to the keypad, Supplement and Therapy open the capture
 * sheet (app/capture.tsx). **Water no longer opens anything: it logs.**
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
 * Four tiles in a 2 × 2 — see the layout note on TILE for why not three across.
 *
 * ## The Water tile is the vessel (D2, 2026-09-14)
 *
 * This block no longer holds "one kind of tile with one behaviour". It held that
 * claim from 2026-08-12 until now, and the claim is retired deliberately rather
 * than quietly — the docblock said it, so the docblock has to unsay it.
 *
 * The measurement that forced it: logging a glass of water through this tile
 * cost **four taps and three screen transitions** (tab bar → tile → an amount on
 * the keypad → Log), because the keypad's water amounts are additive onto the
 * readout rather than commits. Every other tile here lands somewhere the FIRST
 * tap finishes the job; this one needed two. Water is also the one metric logged
 * many times a day at unpredictable moments, which is precisely the pattern that
 * punishes a path beginning with "open a screen" (docs/spikes/water-fast-logging.md).
 *
 * So the tile stops being a door and becomes the thing itself:
 *
 *   - **Tap** — logs the remembered amount to today, in place. No push, no pop.
 *     Two taps from anywhere in the app, one transition.
 *   - **Long-press** — reveals the amounts inline, inside this same plate, under
 *     the grid: Glass / Bottle / Large / **Other…**, where *Other…* is the
 *     existing `/metric-entry?metric=water` route, unchanged. No modal, no sheet,
 *     no navigation. `Pressable` carries `onLongPress` natively, so no gesture
 *     dependency was added.
 *
 * **The block's real contract survives, in its strongest form.** The rule was
 * never "four is the maximum" or "every tile behaves alike" — it was *every tile
 * lands somewhere that writes* (00-design-spec.md §5: this block is the answer
 * the empty feed below points at, and a tile that opens a screen which cannot
 * finish the job would make that answer a lie). The Water tile now stops landing
 * somewhere that writes and simply **writes**. No fifth tile, so the 2 × 2 is
 * untouched.
 *
 * **A tile that behaves differently has to LOOK different, and it does.** It
 * prints the amount it will log on its own face — `+16 oz`, mono, under the
 * label — exactly as the water screen's and the keypad's quick amounts already
 * do. A tile that says what it will do is allowed to do something its neighbours
 * don't; a tile that looks identical and behaves differently is not. That
 * printed number is also what makes a DERIVED default safe (see
 * `usualWaterAmount`): the button cannot mislead about an amount it is showing.
 *
 * **What it says back, and why it is not a toast.** Nothing modal, nothing
 * animated — the design system has no motion language and inventing one here is
 * the slop the anti-slop gate exists to catch. Two receipts instead, at two
 * timescales:
 *
 *   1. *The ledger.* `onLogged` reloads the "Logged today" plate directly below
 *      on the same screen, where the row appears under Water. The record IS the
 *      receipt (§5: ledgers must sum to their own totals), and `/water` corrects
 *      it.
 *   2. *The undo row.* A committing tap can be made by accident, and the Log tab
 *      has no other undo. So the strip under the grid reports the write just
 *      made and offers **Undo**, which deletes by the id `logWater` handed back
 *      — it can only ever remove the glass it just wrote, never a neighbouring
 *      one. It carries no timer: the design system has no timing vocabulary, and
 *      an affordance you have to race is worse than one that waits. It is
 *      replaced by the next write and dismissed by opening the amounts.
 *
 * Conformed Set treatment — a **plate** holding boxed tiles, which is what the
 * sheet draws and, as of 2026-08-11, what the app draws again. The inline
 * amounts and the undo row are ruled rows of that same plate (`Divider`), not a
 * second device: a plate rules its own rows, and a nested enclosure here would be
 * two surfaces in one block. **No accent** — the Log tab's single pine is the
 * command field's send action and that budget does not move.
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
 * A `gap` and a border, not a rule between cells: closed boxes separated by air
 * cannot produce a half-drawn anything, and each box is uniform on all four
 * sides so it takes React Native's fast border path the way a plate does.
 *
 * Class strings are whole literals, never built from a prefix: Tailwind's
 * scanner only sees names that appear literally in source.
 */
type Tile =
  | { key: string; label: string; icon: keyof typeof Ionicons.glyphMap; kind: 'door'; href: Href }
  /** The one tile that writes in place rather than opening a screen. */
  | { key: 'water'; label: 'Water'; icon: keyof typeof Ionicons.glyphMap; kind: 'commit' };

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
 * against its icon. The Water tile's label and amount live in a `grow` COLUMN
 * for the same reason — and that column is `items-start`, never `flex-1`, which
 * in a column axis collapses.
 */
const TILE =
  'w-[48.5%] min-h-[52px] flex-row items-center gap-1.5 border border-hairline bg-paper-hi px-2.5 py-3 active:bg-paper-dim';

/**
 * One inline amount revealed by the long-press. The same 2 × 2 geometry and the
 * same `w-[48.5%]` arithmetic as {@link TILE}, for the same reason: four cells
 * in a row would leave each about 80pt at phone width, and the four amounts read
 * as a grid that ended rather than one that ran out of room. 44pt minimum, which
 * is the tap-target floor.
 */
const AMOUNT =
  'w-[48.5%] min-h-[44px] items-center justify-center rounded-btn border border-hairline bg-paper-hi px-1 py-2 active:bg-paper-dim';

const TILES: Tile[] = [
  {
    key: 'supplement',
    label: 'Supplement',
    icon: 'medkit-outline',
    kind: 'door',
    href: { pathname: '/capture', params: { type: 'supplement' } },
  },
  {
    key: 'water',
    label: 'Water',
    icon: 'water-outline',
    kind: 'commit',
  },
  {
    key: 'weight',
    label: 'Weight',
    icon: 'scale-outline',
    kind: 'door',
    href: { pathname: '/metric-entry', params: { metric: 'weight' } },
  },
  {
    key: 'therapy',
    label: 'Therapy',
    icon: 'thermometer-outline',
    kind: 'door',
    href: { pathname: '/capture', params: { type: 'therapy' } },
  },
];

/** The route the long-press's *Other…* opens — unchanged, and still the only
 *  way to log an amount that is not one of the three. */
const OTHER_HREF: Href = { pathname: '/metric-entry', params: { metric: 'water' } };

type WaterView = {
  spec: DisplaySpec;
  volumeUnit: 'oz' | 'ml';
  /** The DISPLAY amount printed on the tile's face and handed to `logWater`. */
  amount: number;
};

/**
 * What the tile will do, resolved from the record and the unit preference.
 *
 * **The amount is resolved in DISPLAY units and converted back at write time**,
 * which is what makes the tile's one invariant true by construction: the number
 * on the face is the number `logWater` receives. Resolving the other way round —
 * printing a rounded view of a stored canonical value while logging the
 * unrounded one — is how a tile starts lying about itself, and it is the only
 * thing that could make a derived default unsafe.
 *
 * A stored 500 ml read under an oz preference therefore prints `+17 oz` and logs
 * 17 oz, not 500 ml. That is the honest rendering: the tile is offering an
 * amount in the unit the user reads in, and it says exactly which.
 */
function readWater(): WaterView {
  const db = getDb();
  const units = getPreferences(db).units;
  const spec = resolveDisplay(metricByKey('water')!, units);
  const volumeUnit = units.volume === 'ml' ? 'ml' : 'oz';
  const usual = usualWaterAmount(db, todayISODate());
  const amount =
    usual === null ? defaultWaterAmount(volumeUnit) : roundToSpec(spec, spec.fromCanonical(usual));
  // A record of tiny amounts could round to zero in oz (1 ml is 0.03 oz, and
  // water renders at 0 decimals). `logWater` refuses a non-positive amount, so
  // falling back to the Glass literal is the difference between a tile that
  // works and a tile that throws under the thumb.
  return { spec, volumeUnit, amount: amount > 0 ? amount : defaultWaterAmount(volumeUnit) };
}

/** "+16 oz" — the tile's own face, and the caption on each inline amount. */
function plus(amount: number, unit: string): string {
  return `+${amount} ${unit}`;
}

export function QuickAddGrid({ onLogged }: { onLogged?: () => void }) {
  const router = useRouter();
  const [view, setView] = useState(readWater);
  /** The inline amounts, revealed by a long-press on the Water tile. */
  const [expanded, setExpanded] = useState(false);
  /** The write just made, so it can be undone by id. Null once undone. */
  const [undo, setUndo] = useState<{ id: string; label: string } | null>(null);

  // op-sqlite is synchronous, so the first read already ran in the initializer
  // above; this re-reads on return from /water, the keypad or Settings — any of
  // which can change what "his usual" is, or which unit it should be said in.
  useFocusEffect(
    useCallback(() => {
      setView(readWater());
    }, [])
  );

  const { spec, volumeUnit, amount } = view;

  const log = (displayAmount: number) => {
    // The log day is resolved fresh rather than captured at mount: the Log tab
    // can sit open across midnight with no focus event to roll it over, and a
    // stale day would backdate the new day's first glass (the same rule
    // app/water.tsx's `add` follows).
    try {
      const id = logWater(getDb(), todayISODate(), spec.toCanonical(displayAmount));
      setUndo({ id, label: `${displayAmount} ${spec.unit}` });
      setExpanded(false);
      setView(readWater());
      onLogged?.();
    } catch (error) {
      console.warn('[quick-add] water log failed', error);
    }
  };

  const undoLast = () => {
    if (!undo) return;
    try {
      deleteWaterEntry(getDb(), undo.id);
      setUndo(null);
      setView(readWater());
      onLogged?.();
    } catch (error) {
      console.warn('[quick-add] water undo failed', error);
    }
  };

  return (
    <Block device="plate">
      <SectionLabel label="Quick add" />

      {/* `gap-y-2` is the 7pt gutter between the two rows; `justify-between`
          supplies the horizontal one and keeps the outer tiles flush. */}
      <View className="mt-2 flex-row flex-wrap justify-between gap-y-2">
        {TILES.map((tile) =>
          tile.kind === 'commit' ? (
            <Pressable
              key={tile.key}
              accessibilityRole="button"
              // The label states the amount AND that the tap commits — "Water"
              // alone would describe a door, which this no longer is.
              accessibilityLabel={`Log water, ${amount} ${spec.unit}`}
              // A long-press is invisible to VoiceOver, so the other amounts are
              // exposed as a real action rather than only as a gesture.
              accessibilityHint="Double tap and hold for other amounts"
              accessibilityActions={[{ name: 'longpress', label: 'Other amounts' }]}
              onAccessibilityAction={(event) => {
                if (event.nativeEvent.actionName === 'longpress') setExpanded((open) => !open);
              }}
              onPress={() => log(amount)}
              onLongPress={() => {
                setUndo(null);
                setExpanded((open) => !open);
              }}
              className={TILE}>
              <Ionicons name={tile.icon} size={15} color={palette.inkSecondary} />
              {/* Label over amount. `items-start` and never `flex-1`: this is a
                  COLUMN, where `flex-1` collapses the children. `grow` takes the
                  tile's slack so the stack starts hard against its icon. */}
              <View className="shrink grow items-start">
                <Text numberOfLines={1} className="font-label text-[10px] font-bold text-ink">
                  {tile.label}
                </Text>
                {/* A measured value inside a label stays mono (00-design-spec §3). */}
                <Text numberOfLines={1} className="mt-0.5 font-mono text-[10px] text-ink-muted">
                  {plus(amount, spec.unit)}
                </Text>
              </View>
            </Pressable>
          ) : (
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
          )
        )}
      </View>

      {/* The long-press expansion — a ruled row of this plate, not a new device.
          Four amounts in the same 2 × 2 the tiles use. */}
      {expanded ? (
        <View className="mt-3">
          <Divider />
          <View className="mt-3 flex-row flex-wrap justify-between gap-y-2">
            {WATER_QUICK_AMOUNTS[volumeUnit].map((q) => (
              <Pressable
                key={q.label}
                accessibilityRole="button"
                accessibilityLabel={`Log ${q.amount} ${spec.unit} of water, ${q.label}`}
                onPress={() => log(q.amount)}
                className={AMOUNT}>
                <Text className="font-label text-[12px] font-semibold text-ink">{q.label}</Text>
                <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                  {plus(q.amount, spec.unit)}
                </Text>
              </Pressable>
            ))}
            {/* The only amount this block cannot offer is an arbitrary one, and
                the keypad already does that. Unchanged route, unchanged screen. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Log another amount of water on the keypad"
              onPress={() => {
                setExpanded(false);
                router.push(OTHER_HREF);
              }}
              className={AMOUNT}>
              <Text className="font-label text-[12px] font-semibold text-ink">Other…</Text>
              <Text className="mt-0.5 font-serif text-[10px] text-ink-muted">Keypad</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* The receipt. It reports the write in mono because it is a measurement,
          and offers the one correction the Log tab cannot otherwise make. */}
      {undo ? (
        <View className="mt-3">
          <Divider />
          <View className="mt-2 min-h-[44px] flex-row items-center gap-3">
            <Ionicons name="water-outline" size={15} color={palette.inkSecondary} />
            <Text className="flex-1 font-mono text-[11px] text-ink-secondary">
              {`Logged ${undo.label}`}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Undo logging ${undo.label} of water`}
              onPress={undoLast}
              className="min-h-[44px] items-center justify-center px-2 active:opacity-60">
              <Text className="font-label text-[12px] font-semibold text-ink">Undo</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </Block>
  );
}
