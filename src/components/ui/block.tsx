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
 *   field  — a verdict: no enclosure at all, just 11px L-shaped corner ticks
 *            at top-left and bottom-right. A measured field, not a box.
 *   margin — prose (the Coach brief, a rationale): a 2px left rule and an
 *            indent. An annotation in the margin of the sheet.
 *   grid   — metric grids: no outer box, hairlines BETWEEN cells only. The
 *            grid *is* the object. Cells carry their own rules — see
 *            01-rn-port-guide.md §1.3 and metrics-strip.tsx.
 *
 *            ⚠️ **The last cell takes no trailing rule.** "Between cells" means
 *            a rule needs a cell on *both* sides of it. The obvious two-column
 *            implementation gives every even-indexed cell a `border-r`, which
 *            with an ODD number of cells draws a rule into empty space off the
 *            final cell — the outer edge this device exists to avoid. So the
 *            right rule is conditioned on a cell actually following, not on the
 *            column alone. Both the port guide's §1.3 snippet and the mockup's
 *            `nth-child` CSS carry this flaw; metrics-strip.tsx has the correct
 *            form, so copy from there.
 *   well   — capture surfaces (command field, chat thread): paper-dim fill on
 *            a paper-deep edge. Stock that recesses, the way an input does.
 *
 *            ⚠️ **The well is a surface, not a container. Either the block IS
 *            the field, or the field IS the well — never both.** A capture
 *            surface therefore ships in exactly one of two forms:
 *
 *            (a) *The block is the field.* `<Block device="well">` wraps a
 *                BARE input — a `TextInput` carrying no border and no fill of
 *                its own, only its type styling. The well's own paper-dim on
 *                paper-deep is the input's surface. This is the form the spec
 *                names (00-design-spec.md §1: "command field, chat thread"),
 *                and it is what log/command-field.tsx and app/food-search.tsx
 *                already do.
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
 *            send action. What is NOT covered is *content*: a chat turn inside
 *            the thread well is a card lying ON the recess, and it stays raised
 *            (coach/message-bubble.tsx). The distinction is that a control's
 *            surface states how it behaves, so inverting it misstates the
 *            surface system; a card's surface only says where it sits.
 *   stamp  — the ONE next action: paper-hi fill inside a 1.5px accent border.
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
  // Ticks are drawn as absolutely-positioned children, so the box must be
  // `relative`; the padding is what the ticks bracket.
  field: 'relative px-3 py-3',
  margin: 'border-l-2 border-hairline py-px pl-3',
  // Deliberately empty: the rules live on the cells, not on a container.
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
      <View className={DEVICE[device]}>
        {device === 'field' ? <CornerTicks /> : null}
        {children}
      </View>
    </BlockDeviceContext.Provider>
  );
}

/**
 * The measured field's corner marks: two L-shaped brackets, top-left and
 * bottom-right. React Native has no `::before`/`::after`, but it does have
 * absolute positioning and per-side borders, so these are two bordered Views
 * and cost no dependency — there is no react-native-svg in this app, and that
 * is deliberate (01-rn-port-guide.md §1.2, §5).
 */
function CornerTicks() {
  return (
    <>
      <View
        pointerEvents="none"
        className="absolute left-0 top-0 h-[11px] w-[11px] border-l border-t border-ink-muted"
      />
      <View
        pointerEvents="none"
        className="absolute bottom-0 right-0 h-[11px] w-[11px] border-b border-r border-ink-muted"
      />
    </>
  );
}
