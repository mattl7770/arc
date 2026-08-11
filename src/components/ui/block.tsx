import { createContext, useContext, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { palette } from '@/constants/theme';

/**
 * The surface system — the load-bearing idea of the Conformed Set
 * (docs/design-research/implementation/00-design-spec.md §1).
 *
 * **The container encodes the content type.** A plate on every block reads
 * flat: if everything is boxed identically the container carries no
 * information. So each kind of content gets its correct drafting device, and
 * hierarchy comes from the drawing vocabulary rather than from arbitrary
 * styling.
 *
 *   plate  — records, schedules, ledgers (a record is a table): paper-hi fill,
 *            1px hairline border, ruled rows inside.
 *   field  — a verdict: no enclosure at all, just 11px L-shaped corner ticks at
 *            top-left and bottom-right. A measured field, not a box.
 *   margin — prose (the Coach brief, a rationale): a 2px left rule and an
 *            indent. An annotation in the margin of the sheet.
 *   grid   — metric grids: no outer box, rules BETWEEN cells only. The grid
 *            *is* the object. The rules live on the cells, and {@link GridCell}
 *            is the one place that decides which cell gets which.
 *   well   — capture surfaces (the command field, the Coach composer):
 *            paper-dim fill on a paper-deep edge. Stock that recesses, the way
 *            an input does.
 *
 *            ⚠️ **The chat THREAD is not a well.** The spec used to name it as
 *            one ("command field, chat thread") and the Coach tab drew it that
 *            way. On hardware that read as a conversation put in a box for no
 *            reason (owner, 2026-08-09), and the reading was wrong to begin
 *            with: a well is for a surface you capture INTO, and the thing you
 *            capture into on that screen is the composer, which wears it
 *            already. The thread is not a record filed on the page — it IS the
 *            page, so it sits directly on the sheet and only the turns are
 *            drawn (app/(tabs)/coach.tsx, coach/message-bubble.tsx).
 *
 *            ⚠️ **The well is a surface, not a container. Either the block IS
 *            the field, or the field IS the well — never both.** A capture
 *            surface therefore ships in exactly one of two forms:
 *
 *            (a) *The block is the field.* `<Block device="well">` wraps a
 *                BARE input — a `TextInput` carrying no border and no fill of
 *                its own, only its type styling. The well's own paper-dim on
 *                paper-deep is the input's surface. This is the form the spec
 *                names (00-design-spec.md §1, "capture surfaces"), and it is
 *                what log/command-field.tsx and app/food-search.tsx already do.
 *
 *            (b) *The field is the well.* A GROUP of labelled fields carries
 *                no block at all. Each `TextInput` wears the well's tokens
 *                directly — `border border-paper-deep bg-paper-dim` — and the
 *                group is named by a `SectionLabel` and separated from its
 *                neighbours by whitespace, like every other section. This is
 *                app/capture.tsx, app/symptom.tsx, app/lab-import.tsx,
 *                app/workout-log.tsx and the manual meal form in
 *                app/nutrition.tsx. A form is controls, not content, so the
 *                absence of a device there is a decision, not an oversight.
 *
 *            What is forbidden is the third thing: a well **containing** an
 *            input that has a surface of its own. That stacks two recesses,
 *            and the only way to keep the inner one legible is to raise it
 *            onto plate stock — which is how a census found 9 inputs drawn
 *            `border-paper-deep bg-paper-hi`, the RAISED fill, every one of
 *            them inside a `device="well"`. A recessed container holding
 *            raised inputs inverts the whole surface system.
 *
 *            The rule that falls out, and the one to check a diff against:
 *            **an input is never `bg-paper-hi`.** A `TextInput` is either bare
 *            inside a well, or `border-paper-deep bg-paper-dim` outside one.
 *            `border-paper-deep bg-paper-hi` on a text field is always a bug.
 *
 *            **This reaches every control, not only text fields.** A stepper or
 *            a button raised onto plate stock inside a well is the same
 *            inversion for the same reason, so a control in a well carries its
 *            border alone (`border-hairline`), or the accent fill — which is a
 *            stamp, not a raise, and is how log/command-field.tsx draws its
 *            send action. What is NOT covered is *content*: a Coach turn is a
 *            raised `paper-hi` slip wherever it lies, and it stayed raised when
 *            the thread came off the well (coach/message-bubble.tsx). The
 *            distinction is that a control's surface states how it behaves, so
 *            inverting it misstates the surface system; a card's surface only
 *            says where it sits.
 *   stamp  — the ONE next action: paper-hi fill inside a 1.5px accent border.
 *
 * ## The three cut devices are back, and why they were never the problem
 *
 * On 2026-08-09 `field`, `margin` and `grid` were stripped to render nothing.
 * The evidence was the owner's first note off hardware — "there are some weird
 * boxes and lines in some places, notably the metrics and coach brief on the
 * home screen" — read as the surface system failing, as chrome that had to be
 * interpreted before it paid. Three devices were deleted on that reading.
 *
 * It was a misdiagnosis, and the sentence quoted above is what proves it. Look
 * at what those two named surfaces actually were. The **metrics** are
 * `device="grid"`, whose cells drew `border-t border-hairline` and (on the left
 * column) `border-r`. The **coach brief** is `device="margin"`, which drew
 * `border-l-2 border-hairline`. The third device, `field`, drew its corner
 * ticks as `border-l border-t` on an 11×11 view. Every one of the three is a
 * ONE-SIDED BORDER WIDTH PLUS A WHOLE-ELEMENT BORDER COLOUR — the exact pair
 * documented below {@link Divider} as the shape that drops React Native off its
 * CoreAnimation border path and paints a complete rectangle instead.
 *
 * So the owner was not describing three devices that failed to communicate.
 * They were describing three devices that RENDERED WRONG, and naming the two
 * worst offenders by name. The marks were never the noise; the marks were never
 * drawn. A 2px left rule beside the brief came out as a box around the brief. A
 * 1px rule between two metric cells came out as a box around each cell. Two
 * 11px corner brackets came out as two small boxes floating at opposite corners
 * of the readiness block — which is precisely what "weird boxes and lines"
 * describes, and precisely what no amount of design reasoning was ever going to
 * explain away.
 *
 * All three are restored, drawn the only way this codebase draws a rule:
 * **filled views, never borders**. A background colour has no edge struct, no
 * uniformity test, and no bitmap path to fall off. {@link CornerTicks} draws
 * each L as two bars, `margin` draws its rule as a 2px column beside the
 * content, and {@link GridCell} draws the rules between cells. Same design,
 * same tokens, same 1px weights as the mockup specifies — the only thing that
 * changed is the mechanism.
 *
 * The lesson is the same one recorded in `paperGrid` (src/constants/theme.ts)
 * after the grid opacity was tripled to compensate for a layer that was not
 * rendering: **establish that a thing draws before concluding anything about
 * how it looks.** Four rounds of this bug produced three rounds of design
 * changes, every one of them wrong, because nobody checked whether the pixels
 * on screen were the pixels the stylesheet asked for.
 *
 * **Rule: a block gets exactly one device, and devices NEVER nest.** No plate
 * inside a plate, no field inside a stamp. If a section seems to need two, it
 * is two sections. (A plain `<View>` used for layout or spacing is not a
 * device and may sit anywhere.)
 *
 * That rule is enforced at runtime in development by {@link BlockDeviceContext}
 * — a nested block logs a `console.error` naming both devices. Prose alone was
 * the only guard, and this primitive gets copied across ~40 screens, so the
 * cheapest place to catch the mistake is the moment it renders.
 *
 * The mockup picks its device with CSS `:has()`, which React Native has no
 * equivalent for, so the device ships as an explicit prop — better practice
 * anyway, since the choice is now visible at the call site
 * (01-rn-port-guide.md §1.1).
 *
 * Class strings are whole literals in a lookup map, never built from a prefix:
 * Tailwind's scanner only sees class names that appear literally in source
 * (the documented ARC pattern, src/components/home/signal.tsx).
 */
export type BlockDevice = 'plate' | 'field' | 'margin' | 'grid' | 'well' | 'stamp';

const DEVICE: Record<BlockDevice, string> = {
  plate: 'border border-hairline bg-paper-hi px-3.5 py-3',
  // `relative` is what the corner ticks position against, and the padding is
  // what they bracket — a tick flush against the text would read as a clipped
  // glyph rather than as a measured corner.
  field: 'relative px-3 py-3',
  // The rule and the indent are drawn structurally in `Block` below, because a
  // 2px left BORDER is the bug this whole file exists to avoid.
  margin: '',
  // Deliberately empty: the rules live between the cells, not on a container.
  // See {@link GridCell}.
  grid: '',
  well: 'border border-paper-deep bg-paper-dim px-3.5 py-3',
  stamp: 'border-[1.5px] border-pine bg-paper-hi px-4 py-4',
};

/**
 * Carries the enclosing device down the tree so a nested Block can name its own
 * ancestor. Dev-only in effect — in production the value is read and ignored,
 * which costs one context read and no bytes of UI.
 */
const BlockDeviceContext = createContext<BlockDevice | null>(null);

export function Block({
  device,
  cap = false,
  children,
}: {
  device: BlockDevice;
  /**
   * Draw the hatched cap along a `stamp`'s top edge. Opt-in, because the sheet
   * is opt-in about it: `.cf-card--accent` carries the cap, `.cf-hero` is a
   * separate class with the same 1.5px accent border and no cap at all. So the
   * three accent cards (the Labs screen's bloodwork prompt, Nutrition's capture
   * card, Exercise's session card) and the Coach's revision card take `cap`, and
   * Home's hero does not. Ignored on every other device.
   */
  cap?: boolean;
  children: ReactNode;
}) {
  const enclosing = useContext(BlockDeviceContext);

  if (__DEV__ && enclosing) {
    console.error(
      `[Block] Devices must never nest: <Block device="${device}"> is rendered inside ` +
        `<Block device="${enclosing}">. A block gets exactly one device — if a section ` +
        `seems to need two, it is two sections (00-design-spec.md §1).`
    );
  }

  return (
    <BlockDeviceContext.Provider value={device}>
      {device === 'margin' ? (
        // The annotation rule. A row, not a border: the 2px column IS the rule,
        // and `self-stretch` runs it the full height of whatever prose sits
        // beside it without either one needing to know that height.
        <View className="flex-row">
          <View className="w-0.5 self-stretch bg-hairline" />
          <View className="flex-1 py-px pl-3">{children}</View>
        </View>
      ) : (
        <View className={DEVICE[device]}>
          {device === 'field' ? <CornerTicks /> : null}
          {device === 'stamp' && cap ? <HatchCap /> : null}
          {children}
        </View>
      )}
    </BlockDeviceContext.Provider>
  );
}

/**
 * The measured field's corner marks: two L-shaped brackets, at top-left and
 * bottom-right, saying "this region was measured" without enclosing it.
 *
 * **Four bars, not two bordered squares.** The original port drew each L as one
 * 11×11 view carrying `border-l border-t` — a one-sided width plus a
 * whole-element colour, which is the precise shape documented under
 * {@link Divider} as the one React Native paints as a full rectangle. It did
 * exactly that: two small boxes floating at opposite corners of the readiness
 * block, unattached to anything, which is the first thing the owner reported
 * seeing on hardware. Each L is now two filled bars — a horizontal 11×1 and a
 * vertical 1×11 sharing a corner — which cannot draw a fourth side because
 * there are no sides to draw.
 *
 * 11px and 1px come straight off the sheet (`.cf-block:has(> .cf-verdict)`'s
 * `::before`/`::after`); the ink is `--ink-faint`, which is `ink-muted` here.
 */
function CornerTicks() {
  return (
    <>
      <View pointerEvents="none" className="absolute left-0 top-0 h-px w-[11px] bg-ink-muted" />
      <View pointerEvents="none" className="absolute left-0 top-0 h-[11px] w-px bg-ink-muted" />
      <View pointerEvents="none" className="absolute bottom-0 right-0 h-px w-[11px] bg-ink-muted" />
      <View pointerEvents="none" className="absolute bottom-0 right-0 h-[11px] w-px bg-ink-muted" />
    </>
  );
}

/**
 * The hatched cap: a 3pt band of accent/ink barber hatching laid over a stamp's
 * top edge, bleeding 1.5pt past it on three sides so it sits ON the border
 * rather than inside it.
 *
 * This is the loudest drafting mark in the whole set and the app had no
 * equivalent — it is most of what separates "a card with a coloured border"
 * from "a drawing that has been stamped". The sheet writes it as
 * `repeating-linear-gradient(-45deg, var(--accent) 0 5px, var(--ink) 5px 10px)`
 * on `.cf-card--accent::before`.
 *
 * **No gradient library, and none needed.** `expo-linear-gradient` is not
 * installed and adding it would force the owner into a fresh EAS cloud build
 * (01-rn-port-guide.md §5) for a mark that is, geometrically, a row of tilted
 * bars on a dark ground. So: an ink band, `overflow: 'hidden'`, and accent bars
 * rotated 45° inside it.
 *
 * The pitch is not the CSS number. A gradient's stripe width is measured
 * PERPENDICULAR to the stripe; these bars are positioned along the horizontal.
 * At 45° the 10pt perpendicular period projects to 10/cos45° ≈ 14pt of
 * horizontal pitch, and the 5pt accent stripe to ≈ 7pt of horizontal width, so
 * the bars are 5pt wide at 14pt centres. Copying 5-and-10 straight across would
 * have drawn the hatch at 1.4× the specified density.
 *
 * The bar count is fixed rather than measured: 32 bars at 14pt reaches 448pt,
 * wider than any iPhone in portrait, and the band clips whatever overhangs.
 * That trades a handful of clipped views for not making this component
 * width-aware — the same trade `PaperGrid` makes one file over.
 */
function HatchCap() {
  return (
    <View pointerEvents="none" style={styles.cap}>
      {HATCH_BARS.map((left) => (
        <View key={left} style={[styles.hatchBar, { left }]} />
      ))}
    </View>
  );
}

const HATCH_BARS = Array.from({ length: 32 }, (_, index) => index * 14);

const styles = StyleSheet.create({
  cap: {
    position: 'absolute',
    top: -1.5,
    left: -1.5,
    right: -1.5,
    height: 3,
    overflow: 'hidden',
    backgroundColor: palette.ink,
  },
  // Tall enough to cross the band at 45° from either side, and offset upward so
  // the rotation's centre lands on the band rather than below it.
  //
  // `+45deg`, not `-45deg`: for a `repeating-linear-gradient(θ, …)` the STRIPES
  // run at θ+90°, because the gradient line is perpendicular to the bands it
  // produces. The sheet's `-45deg` therefore draws stripes at 45°, and copying
  // the CSS angle onto the transform shipped the cap mirrored. `-45deg` and
  // `135deg` are the same gradient line reversed, which is why the swatch hatch
  // in home/signal.tsx — specified at `135deg` — slants the SAME way as this
  // one, not the opposite way an earlier comment there claimed.
  hatchBar: {
    position: 'absolute',
    top: -4.5,
    width: 5,
    height: 12,
    backgroundColor: palette.pine,
    transform: [{ rotate: '45deg' }],
  },
});

/**
 * The rule that runs BETWEEN the rows of a plate — drawn as a filled 1px view,
 * **never as a border**.
 *
 * ## Why this exists (do not "simplify" it back to `border-t`)
 *
 * `border-t border-hairline` is the obvious way to write a row separator and it
 * is the trap. The owner reported "weird boxes" from hardware four separate
 * times; three rounds of agents read it as a design problem and deleted plates,
 * which made it worse. It was never the design. It is this:
 *
 *   - `.border-t` compiles to `border-top-width: 1px` and nothing else.
 *   - `.border-hairline` compiles to `border-color: …` and nothing else — the
 *     CSS **shorthand**, which is a whole-element property. It colours all four
 *     edges, because that is what `border-color` means.
 *
 * NativeWind's translation of that pair is honest and minimal — verified by
 * compiling the project's real `tailwind.config.js` and running the output
 * through `react-native-css-interop`'s `cssToReactNativeRuntime`, which yields
 * exactly `{ borderTopWidth: 1, borderColor: '#a9a28e' }`. No stray
 * `borderWidth`. So NativeWind is not the culprit, and patching it is not the
 * fix.
 *
 * The damage happens one layer down, and it is a direct consequence of that
 * style pair. React Native resolves borders into `borderWidths` and
 * `borderColors` rectangle-edge structs, then (RCTViewComponentView.mm) takes
 * the cheap CoreAnimation path **only** when
 * `borderColors.isUniform() && borderWidths.isUniform()`. A row divider is
 * uniform in colour and NOT uniform in width, so every one of these rows falls
 * off that path into `RCTGetSolidBorderImage` — a generated 9-patch bitmap,
 * stretched with `kCAFilterNearest` onto a separate `CALayer` sublayer, sized
 * from the rounded border insets. A plate (`border border-hairline`, uniform on
 * all four sides) never goes near it. That asymmetry is exactly what the
 * screenshot shows: plates fine, first row of each list clean, and every row
 * carrying `border-t` drawn as a complete rectangle.
 *
 * A background colour cannot draw on four sides. There is no border, no edge
 * struct, no bitmap layer, no fast/slow path to fall off. That is the whole
 * point of this component, and it is why the weight is expressed as `h-px`
 * (1pt, identical to the hairline it replaces) rather than as a border width.
 *
 * ## The boundary rule, and why it cannot be got wrong
 *
 * A rule runs BETWEEN rows: never above the first, never below the last.
 * `Divider` is always rendered as the row's **leading** sibling, so "below the
 * last row" is structurally impossible — there is no trailing slot to fill.
 * The remaining boundary is the first row, and `first` handles it by rendering
 * nothing:
 *
 * ```tsx
 * {rows.map((row, index) => (
 *   <View key={row.id}>
 *     <Divider first={index === 0} />
 *     <RowBody row={row} />
 *   </View>
 * ))}
 * ```
 *
 * Omit `first` when the rule is unconditional — a trailing action row beneath a
 * list, or the first row of a list that already has a header above it inside
 * the same plate. In those cases the row above genuinely exists.
 *
 * `self-stretch` is deliberate: it keeps the rule full-width even if a parent
 * ever sets `items-center` / `items-start`, where a `h-px` view would otherwise
 * collapse to zero width and vanish silently.
 */
export function Divider({ first = false }: { first?: boolean }) {
  if (first) return null;
  return <View className="h-px self-stretch bg-hairline" />;
}

/**
 * The vertical companion to {@link Divider} — a 1px column rule separating two
 * controls that share a row (a list row and its trailing affordance).
 *
 * Same reasoning, same trap: `border-l border-hairline` is a one-sided width
 * plus a whole-element colour, which is the exact shape that pushes React
 * Native onto the border-bitmap path and draws a box. A filled 1px-wide view
 * cannot. `self-stretch` makes it span the row's height without needing to know
 * that height.
 */
export function VerticalDivider() {
  return <View className="w-px self-stretch bg-hairline" />;
}

/**
 * The DASHED companion to {@link Divider} — the rule that separates a card's
 * head from its foot on the sheet (`.cf-protocard-foot`, `.cf-vhist-cap`),
 * where a solid rule would read as a second, equal division rather than as an
 * aside beneath the main content.
 *
 * ## Why this is a row of bars and not `border-dashed`
 *
 * Tailwind's `border-dashed` sets `border-style` and nothing else, so drawing a
 * dashed rule with it means pairing it with a one-sided width — `border-t
 * border-dashed border-hairline` — which is the exact shape documented above
 * {@link Divider} as the one React Native paints as a complete rectangle — the
 * dash would be drawn round all four sides of the thing it is meant to divide,
 * which is strictly worse than the solid rule it replaces. There is no
 * filled-view equivalent of a dashed line, so the dashes are drawn: **3pt bars
 * at 6pt centres**, clipped by `overflow-hidden` at whatever width the parent
 * gives them.
 *
 * That pitch is the reason this lives here rather than at its call sites. It
 * shipped as a local copy in `app/protocols.tsx`, `app/protocol-versions.tsx`
 * and `app/exercise.tsx` inside the same hour, and the three had **already
 * drifted** — two at 4pt/8pt, one at 3pt/6pt, for a mark the sheet specifies
 * once. Three copies of a drawing primitive is how three drawings diverge. The
 * finer pattern won: at 4-on/4-off a hairline reads as a row of chunky bars,
 * where 3-and-3 reads as a dash.
 *
 * 76 bars reaches 456pt, wider than any iPhone in portrait, so the count is
 * fixed rather than measured — the same trade {@link HatchCap} and `PaperGrid`
 * make. In RN `flexShrink` defaults to 0, so the bars keep their width and
 * overflow rather than squeezing to fit; `self-stretch` keeps the rule full
 * width under any parent alignment.
 *
 * `border-dashed` IS still safe as a **uniform four-sided** border, which is how
 * `app/screenings.tsx` marks a proposed item. The rule is about one-sided
 * widths, not about the dash.
 */
export function DashedDivider() {
  return (
    <View className="h-px flex-row gap-[3px] self-stretch overflow-hidden">
      {DASHES.map((index) => (
        <View key={index} className="h-px w-[3px] bg-hairline" />
      ))}
    </View>
  );
}

const DASHES = Array.from({ length: 76 }, (_, index) => index);

/**
 * One cell of a `device="grid"` block, carrying the rules that run BETWEEN
 * cells — and nothing else, because the grid has no outer box. The rules ARE
 * the object; a ruled grid with no enclosure is what a dimension table looks
 * like on a drawing.
 *
 * ## Every rule here is a filled view
 *
 * The sheet writes these as `border-top` on every `.cf-dim` plus `border-right`
 * on the odd-indexed ones, and the first RN port copied that literally. Both
 * are one-sided widths against a whole-element colour, so both drew a complete
 * box round every metric cell on device — the "weird boxes... notably the
 * metrics" the owner reported off hardware, and the reason the whole device was
 * deleted for two days. See the header of this file and {@link Divider}.
 *
 * ## The trailing-rule bug is gone by construction
 *
 * `nth-child(odd)` gives the left column a right-hand rule. With an ODD number
 * of cells the last one is in the left column with nothing beside it, so that
 * CSS draws a rule into empty space — an outer edge on the one device whose
 * whole point is having none. Both the sheet and 01-rn-port-guide.md §1.3 carry
 * the flaw. Here the rule is conditioned on a cell actually FOLLOWING, not on
 * the column, so an odd count cannot produce it and no call site has to
 * remember.
 *
 * The first column takes no left padding: with no outer box, the grid's left
 * column has to line up with every unboxed section above and below it, and an
 * inset would knock it out of alignment with the whole sheet.
 */
export function GridCell({
  index,
  count,
  columns = 2,
  children,
}: {
  index: number;
  count: number;
  columns?: 2 | 3 | 4;
  children: ReactNode;
}) {
  const column = index % columns;
  const followedInRow = column < columns - 1 && index + 1 < count;

  return (
    <View className={COLUMN_WIDTH[columns]}>
      <Divider />
      {/* `flex-1` on the inner row is load-bearing and is NOT a spacing tweak.
          The outer cell is a flex line item, so it stretches to the height of
          the TALLEST cell in its row (RN's default `alignItems: stretch`). This
          row does not: it sits on the column's main axis, so without `flex-1` it
          sizes to its own content, and `VerticalDivider`'s `self-stretch` then
          matches THIS cell rather than the row — drawing a short vertical that
          stops above the bottom of a taller neighbour.

          That is not hypothetical. Exercise's "This week" grid gives the VO₂max
          cell a second line ("no wearable yet") that Zone 2 and Strength do not
          have, and those two are exactly the cells that draw a vertical. Both
          rules would have stopped ~14pt short under a full-width top rule —
          which is the half-drawn look this whole restoration exists to undo. It
          would have shipped as a *new* instance of the owner's original report.
          With `flex-1` the row fills the stretched cell and the rule runs the
          full height. */}
      <View className="flex-1 flex-row">
        <View className={column === 0 ? CELL_FLUSH : CELL_INSET}>{children}</View>
        {followedInRow ? <VerticalDivider /> : null}
      </View>
    </View>
  );
}

/** Whole literals — Tailwind's scanner never sees a built fragment. */
const COLUMN_WIDTH = { 2: 'w-1/2', 3: 'w-1/3', 4: 'w-1/4' } as const;
const CELL_FLUSH = 'flex-1 py-2.5 pr-2.5';
const CELL_INSET = 'flex-1 px-2.5 py-2.5';
