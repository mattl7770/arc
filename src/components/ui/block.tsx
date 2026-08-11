import { createContext, useContext, type ReactNode } from 'react';
import { View } from 'react-native';

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
 *   field  — a verdict. **Unmarked** (see "Devices that stopped paying rent"
 *            below): set apart by air and type, not by a drawn bracket.
 *   margin — prose (the Coach brief, a rationale). **Unmarked**, same reason.
 *   grid   — metric grids: no outer box. The grid *is* the object, and it is
 *            built from alignment and whitespace, not from rules.
 *
 *            ⚠️ **A grid draws no rules.** An earlier cut ruled BETWEEN cells
 *            (hairline on top of every cell, plus a vertical between the two
 *            columns) on the theory that the rules were the object. On a phone
 *            that reads as a half-drawn box — an L of lines floating with no
 *            outer edge looks like a rendering artifact, which is exactly what
 *            the owner reported on first sight of Home. Columns line up on
 *            their own; a two-column block of label / value / detail is legible
 *            as a table without a single stroke. metrics-strip.tsx is the
 *            reference form. (The port guide's §1.3 snippet and the mockup's
 *            `nth-child` CSS still show the ruled version — they are stale.)
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
 * ## Devices that stopped paying rent (2026-08-09, owner call on hardware)
 *
 * Seeing the Conformed Set on a real phone for the first time, the owner's
 * first note was: "there are some weird boxes and lines in some places, notably
 * the metrics and coach brief on the home screen, but there are more." That is
 * the surface system reading as NOISE rather than as structure, which is the
 * one failure mode it cannot survive — so three of the six devices lost their
 * marks. §5's own rule decides it: **drafting chrome pays rent or goes**, and a
 * mark a viewer has to interpret before it helps them is decoration.
 *
 *   field  — was two 11px L-shaped corner ticks at opposite corners, no
 *            enclosure. The most abstract device in the set and the least
 *            self-explanatory: nothing on screen teaches you that a bracket
 *            means "this region was measured", so it reads as a stray glyph or
 *            a clipped border. Cut.
 *   margin — was a 2px left rule and a 12px indent. Beside a paragraph that is
 *            the SECTION rather than an aside to one, the rule annotates
 *            nothing and reads as a rendering glitch. Cut.
 *   grid   — was hairlines between cells. Cut, for the reason above.
 *
 * All three now render nothing. They are kept as named devices rather than
 * deleted because the call site still declares what kind of content it holds —
 * that is the documentation the surface system exists for — and because the
 * decision is one line to revisit if the owner wants a mark back.
 *
 * What is left drawn is the set where enclosure does real work: `plate` closes
 * a record, `well` recesses a capture surface, `stamp` marks the one next
 * action. Everything else is separated by air and distinguished by type, which
 * is what the design already says sections do (app/(tabs)/index.tsx).
 *
 * **Rule: a block gets exactly one device, and devices NEVER nest.** No plate
 * inside a plate, no field inside a stamp. If a section seems to need two, it
 * is two sections. (A plain `<View>` used for layout or spacing is not a
 * device and may sit anywhere.) The rule still holds for the unmarked devices:
 * they draw nothing today, but the call site is still a claim about content.
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
  // Unmarked — see "Devices that stopped paying rent". The padding went with
  // the ticks and the rule: with nothing enclosing the content, an inset only
  // knocks these sections out of alignment with every unboxed section above
  // and below them.
  field: '',
  margin: '',
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

export function Block({ device, children }: { device: BlockDevice; children: ReactNode }) {
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
      <View className={DEVICE[device]}>{children}</View>
    </BlockDeviceContext.Provider>
  );
}

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
