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
import { logWater, usualWaterAmount } from '@/lib/db/repositories/water';
import { removeWaterCapture } from '@/lib/health/publish';
import {
  formatFigure,
  metricByKey,
  resolveDisplay,
  roundForDisplay,
  type DisplaySpec,
} from '@/lib/log/metrics';
import { WATER_QUICK_AMOUNTS } from '@/lib/log/water-amounts';

/**
 * Quick add — three door tiles (Supplement, Weight, Therapy) and, on its own
 * ruled row, **the water vessels**. Weight is a number so it goes to the metric
 * keypad; Supplement and Therapy open the capture sheet (app/capture.tsx). The
 * vessels open nothing at all: each one logs.
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
 * ## The amounts are on the sheet (owner, device, 2026-09-21)
 *
 * > *"the water no longer really works, because the button just adds 8? need to
 * > do something different here, idk what tbh."*
 *
 * D2 (2026-09-14) made the Water tile commit **the remembered amount** in one
 * tap — the most frequent manual capture of the last 14 days, `usualWaterAmount`
 * — and put the other vessels behind a **long-press**. On device that came out
 * as a button that only ever adds 8 oz, because he had logged glasses most often
 * and never found the gesture.
 *
 * The remembered amount was not the mistake. **Hiding the choice was.** A
 * long-press is an invisible affordance: nothing on the sheet says it is there,
 * so a user who does not already know is left with whichever single amount the
 * derivation happened to pick — and the faster that one tap is, the more firmly
 * the derivation trains itself on it. D2 measured taps and did not measure
 * discoverability, and the gesture is the whole of the difference.
 *
 * So the vessels come out of hiding and become the block's own row:
 *
 *   - **Glass / Bottle / Large / Other…** are on the sheet at all times, one tap
 *     each, in the unit preference (`WATER_QUICK_AMOUNTS`, the one shared
 *     table). A tap writes that exact amount to today, in place — no push, no
 *     pop, no gesture — and the same `Logged 16 oz` row with the same **Undo**
 *     reports it. *Other…* is still `/metric-entry?metric=water`, unchanged.
 *   - **Nothing sits behind a long-press**, because there is nothing left to
 *     reveal. The handler is deleted rather than kept as an alias: a gesture
 *     that duplicates a visible control is a second thing to keep working and a
 *     second thing to get wrong.
 *   - **The remembered amount is a note now, not a button.** It is printed as
 *     `usually 8 oz` beside the Water label — his pattern, stated — and nothing
 *     taps it. `usualWaterAmount` and its 14-day rule are untouched.
 *
 * **Marked, not reordered.** The obvious alternative was to float the most-used
 * vessel to the front of the row. It is refused: the vessels read small → large
 * and sit in that order on the water screen too, and a row that rearranges
 * itself the week his habit shifts moves a target out from under his thumb — a
 * quieter version of exactly the bug being fixed here. The positions are fixed;
 * the note says which one he usually takes.
 *
 * ## Why the vessels are a full-width row and not four chips inside a tile
 *
 * They do not fit inside one. At 375 pt the plate's content is about 305 pt, a
 * half-width tile is about 148 pt, and four targets inside it would be 35 pt
 * each — under the 44 pt floor. Two rows of two inside the tile would make one
 * cell of the 2 × 2 twice the height of its neighbours.
 *
 * So Water leaves the tile grid and takes a ruled row of this same plate, where
 * four cells at `w-[23.5%]` are about 72 pt each: comfortably over the floor,
 * and wide enough for `+750 ml` in mono without truncating.
 *
 * **What that costs, and why the cost is the cheaper one.** It leaves three
 * doors, and three does not divide into two columns. Both failures are named on
 * {@link TILE}: a three-wide row truncates "Supplement" (it is why the six-tile
 * layout was abandoned), and a 2 + 1 leaves a half-empty row that reads as a
 * tile which failed to load. A trailing door that **spans** has neither fault —
 * every row is complete and no label is squeezed. See {@link TILE_WIDE}.
 *
 * A side effect worth naming: the tile grid holds **one kind of thing again**.
 * Every tile is a door; water — which was never a door, and spent a week as the
 * one tile that behaved unlike its neighbours — is its own object under its own
 * label. The block's contract (00-design-spec.md §5: this block is the answer
 * the empty feed below points at, so every control here must land somewhere that
 * writes) holds in both halves.
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
 *      has no other undo. So the strip under the vessels reports the write just
 *      made and offers **Undo**, which deletes by the id `logWater` handed back
 *      — it can only ever remove the glass it just wrote, never a neighbouring
 *      one. It carries no timer: the design system has no timing vocabulary, and
 *      an affordance you have to race is worse than one that waits. It is
 *      replaced by the next write.
 *
 * Conformed Set treatment — a **plate** holding boxed tiles, which is what the
 * sheet draws and, as of 2026-08-11, what the app draws again. The vessel row
 * and the undo row are ruled rows of that same plate (`Divider`), not a second
 * device: a plate rules its own rows, and a nested enclosure here would be two
 * surfaces in one block. Label voice on every caption, mono on every amount.
 * **No accent** — the Log tab's single pine is the command field's send action
 * and that budget does not move.
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
 * pressable. Nothing else on the Log tab is a field of unbordered words.
 *
 * A `gap` and a border, not a rule between cells: closed boxes separated by air
 * cannot produce a half-drawn anything, and each box is uniform on all four
 * sides so it takes React Native's fast border path the way a plate does.
 *
 * Class strings are whole literals, never built from a prefix: Tailwind's
 * scanner only sees names that appear literally in source.
 */
type Door = { key: string; label: string; icon: keyof typeof Ionicons.glyphMap; href: Href };

/**
 * One door tile: a closed hairline box on plate stock, uniform on all four
 * sides.
 *
 * **Two columns, never three.** With six tiles this was three columns and
 * "Supplement" had about 41 pt to render in, which truncated; at half width it
 * has roughly twice that. That constraint survives every change to this block,
 * and it is why an odd door spans (see {@link TILE_WIDE}) rather than three of
 * them squeezing into one row.
 *
 * `w-[48.5%]` rather than `w-1/2` because the gutter is real geometry: two
 * halves plus a gap overflows the row and wraps the second tile. 48.5 × 2 = 97%,
 * and the row's `justify-between` spends the remaining 3% as the single gutter,
 * so the outer edges stay flush with the plate's padding at any width.
 *
 * **The tile itself must NOT be `justify-between`.** It was for one commit, and
 * with the label as the only flexible child that hands all the slack to the gap
 * after the icon, pinning the caption against the right border. `grow` on the
 * label is the fix: it absorbs the slack itself so every caption starts hard
 * against its icon.
 */
const TILE =
  'w-[48.5%] min-h-[52px] flex-row items-center gap-1.5 border border-hairline bg-paper-hi px-2.5 py-3 active:bg-paper-dim';

/**
 * The same tile, spanning the plate — what the LAST door takes when the doors
 * are an odd number, which since 2026-09-21 they are.
 *
 * An odd tile has two obvious endings and both are faults named on {@link TILE}:
 * a three-wide row, which truncates "Supplement", or a half-width tile with two
 * tile-widths of empty plate beside it, which reads as a tile that failed to
 * load rather than as a grid that ended. Spanning is the third ending and the
 * only one with neither fault — every row is complete, every label has half the
 * plate or more.
 *
 * A whole literal, and a separate constant rather than a width appended to
 * {@link TILE} at runtime: Tailwind's scanner only sees names that appear
 * literally in source.
 */
const TILE_WIDE =
  'w-full min-h-[52px] flex-row items-center gap-1.5 border border-hairline bg-paper-hi px-2.5 py-3 active:bg-paper-dim';

/**
 * One water vessel: four across, always on the sheet.
 *
 * `w-[23.5%]` × 4 = 94%, and `justify-between` spends the remaining 6% as the
 * three gutters. At 375 pt that is about 72 pt per cell against a 44 pt tap
 * floor, and about 62 pt of text room — enough for `+750 ml` at 10px mono and
 * for "Bottle" in the condensed label face, which is why four of these fit on
 * one line where four inside a half-width {@link TILE} could not.
 *
 * `numberOfLines={1}` on both captions is the backstop: the widths are
 * percentages and do not reflow when the system text size grows, so a caption
 * that outgrows its cell has to clip rather than push the row apart.
 */
const VESSEL =
  'w-[23.5%] min-h-[44px] items-center justify-center rounded-btn border border-hairline bg-paper-hi px-1 py-2 active:bg-paper-dim';

const DOORS: Door[] = [
  {
    key: 'supplement',
    label: 'Supplement',
    icon: 'medkit-outline',
    href: { pathname: '/capture', params: { type: 'supplement' } },
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

/** The route *Other…* opens — unchanged, and still the only way to log an
 *  amount that is not one of the three vessels. */
const OTHER_HREF: Href = { pathname: '/metric-entry', params: { metric: 'water' } };

type WaterView = {
  spec: DisplaySpec;
  volumeUnit: 'oz' | 'ml';
  /**
   * The most-used amount as PRINTED (`formatFigure`), or null when there is
   * nothing to learn from. It is a NOTE beside the label, never a control — no
   * tap in this block depends on it.
   */
  usual: string | null;
};

/**
 * The unit preference and the remembered amount, read fresh from the record.
 *
 * **The vessels are per-unit literals, not conversions** — a metric bottle is
 * 500 ml, not the 473 that 16 oz rounds to — and each is handed to `logWater`
 * through `spec.toCanonical` at write time, so the number printed on a cell is
 * the number the tap stores. That invariant used to be the thing that made a
 * DERIVED default safe; it is now simply true of four fixed amounts, which is
 * the stronger version of the same property.
 *
 * The remembered amount is resolved the same way, so the note reads in the unit
 * he reads in: a stored 500 ml under an oz preference says `usually 16.9 oz`
 * (`usually 17 oz` until 2026-09-21, when every water figure moved to the one
 * shared formatter, so this note and the water screen's row for the same
 * capture now print the same number). It is rounded as printed, and a record of
 * tiny amounts that rounds to zero yields no note rather than `usually 0 oz`; an
 * absent note is the honest rendering of "nothing here is worth calling a habit".
 */
function readWater(): WaterView {
  const db = getDb();
  const units = getPreferences(db).units;
  const spec = resolveDisplay(metricByKey('water')!, units);
  const volumeUnit = units.volume === 'ml' ? 'ml' : 'oz';
  const learned = usualWaterAmount(db, todayISODate());
  const usual =
    learned !== null && roundForDisplay(spec, learned) > 0 ? formatFigure(spec, learned) : null;
  return { spec, volumeUnit, usual };
}

/** "+16 oz" — the caption under every vessel. */
function plus(amount: number, unit: string): string {
  return `+${amount} ${unit}`;
}

export function QuickAddGrid({ onLogged }: { onLogged?: () => void }) {
  const router = useRouter();
  const [view, setView] = useState(readWater);
  /** The write just made, so it can be undone by id. Null once undone. */
  const [undo, setUndo] = useState<{ id: string; label: string } | null>(null);

  // op-sqlite is synchronous, so the first read already ran in the initializer
  // above; this re-reads on return from /water, the keypad or Settings — any of
  // which can change what "his usual" is, or which unit the vessels are in.
  useFocusEffect(
    useCallback(() => {
      setView(readWater());
    }, [])
  );

  const { spec, volumeUnit, usual } = view;

  const log = (displayAmount: number) => {
    // The log day is resolved fresh rather than captured at mount: the Log tab
    // can sit open across midnight with no focus event to roll it over, and a
    // stale day would backdate the new day's first glass (the same rule
    // app/water.tsx's `add` follows).
    try {
      const id = logWater(getDb(), todayISODate(), spec.toCanonical(displayAmount));
      setUndo({ id, label: `${displayAmount} ${spec.unit}` });
      setView(readWater());
      onLogged?.();
    } catch (error) {
      console.warn('[quick-add] water log failed', error);
    }
  };

  const undoLast = () => {
    if (!undo) return;
    try {
      // Removes the glass from Apple Health too, when it had already gone out
      // (water is two-way since 2026-09-21; the Undo is the case that matters).
      removeWaterCapture(getDb(), undo.id);
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

      {/* `gap-y-2` is the 7pt gutter between the rows; `justify-between`
          supplies the horizontal one and keeps the outer tiles flush. */}
      <View className="mt-2 flex-row flex-wrap justify-between gap-y-2">
        {DOORS.map((door, i) => (
          <Pressable
            key={door.key}
            accessibilityRole="button"
            accessibilityLabel={door.label}
            onPress={() => router.push(door.href)}
            // The odd door out spans rather than sitting beside a hole. Derived
            // from the count, not flagged on the tile, so a fourth door squares
            // the grid again without anyone remembering to unset a bit.
            className={i === DOORS.length - 1 && DOORS.length % 2 === 1 ? TILE_WIDE : TILE}>
            <Ionicons name={door.icon} size={15} color={palette.inkSecondary} />
            {/* A tile label is a button label — the label voice. `grow` takes
                the tile's slack so every caption starts hard against its icon
                rather than floating (see TILE above); `shrink` + `numberOfLines`
                stay as the backstop, though at half-width no label is close to
                needing them. */}
            <Text
              numberOfLines={1}
              className="shrink grow font-label text-[10px] font-bold text-ink">
              {door.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Water — a ruled row of this plate, not a new device. Four amounts on
          the sheet at all times; every one of them writes. */}
      <View className="mt-3">
        <Divider />
        <View className="mt-3">
          {/* The note states his pattern and nothing taps it. Absent when the
              record has nothing to say, because an invented "usually" would be
              a claim about a habit that does not exist yet. */}
          <SectionLabel
            label="Water"
            note={usual === null ? undefined : `usually ${usual} ${spec.unit}`}
          />
          <View className="mt-2 flex-row justify-between">
            {WATER_QUICK_AMOUNTS[volumeUnit].map((q) => (
              <Pressable
                key={q.label}
                accessibilityRole="button"
                accessibilityLabel={`Log ${q.amount} ${spec.unit} of water, ${q.label}`}
                onPress={() => log(q.amount)}
                className={VESSEL}>
                <Text numberOfLines={1} className="font-label text-[12px] font-semibold text-ink">
                  {q.label}
                </Text>
                {/* A measured value inside a label stays mono (00-design-spec §3). */}
                <Text numberOfLines={1} className="mt-0.5 font-mono text-[10px] text-ink-muted">
                  {plus(q.amount, spec.unit)}
                </Text>
              </Pressable>
            ))}
            {/* The only amount this block cannot offer is an arbitrary one, and
                the keypad already does that. Unchanged route, unchanged screen. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Log another amount of water on the keypad"
              onPress={() => router.push(OTHER_HREF)}
              className={VESSEL}>
              <Text numberOfLines={1} className="font-label text-[12px] font-semibold text-ink">
                Other…
              </Text>
              <Text numberOfLines={1} className="mt-0.5 font-serif text-[10px] text-ink-muted">
                Keypad
              </Text>
            </Pressable>
          </View>
        </View>
      </View>

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
