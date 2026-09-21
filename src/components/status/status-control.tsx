import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import { StatusChip, StatusRail } from '@/components/status/status-rail';
import { ModalScreen } from '@/components/ui/screen';
import { palette } from '@/constants/theme';
import type { DayStatusRow } from '@/lib/db/repositories/statuses';
import { displayStatus, railChips, type RailChip } from '@/lib/status/chips';

/**
 * The status control — one small target that opens the five chips in a sheet.
 *
 * **One component, two surfaces.** It began on Home (the owner took **Q5(c)**:
 * the line above the hero *and* a control beside the date) and moved here from
 * `src/components/home/status-control.tsx` on **2026-09-21**, when the owner
 * used the new build and said of the Coach tab: *"buttons for the status thing
 * on the coach tab need to be moved and put behind another button."* The Coach
 * screen had a rail of five chips docked above its composer; it now has this
 * door instead. Home is unchanged.
 *
 * It moved rather than being copied because the sheet is the ONE source of the
 * five words and the three gestures. A second door with its own sheet would be
 * two vocabularies of the same five words inside a fortnight, which is the
 * argument `src/lib/status/chips.ts` already makes about the table itself.
 *
 * ## Why a door and not a row of chips
 *
 * On Home, CLAUDE.md §5 is binding — it answers *"what should I do right
 * now"* and is never a data dump — so five chips inlined on the folio row
 * would be five controls competing with the one action the screen is built
 * around. On the Coach screen the same argument arrives from the other end:
 * the screen's one primary action is Send, and five permanent buttons sitting
 * on the composer's band were four more than the screen had asked for. A door
 * is one.
 *
 * ## The two faces, and why they differ by exactly one thing
 *
 * Both read "Status" and both carry the chevron and the 44pt target that say
 * *pressable*. What differs is what says **on**:
 *
 *   - **Home** (`showOpen` off) carries the state in the FILL — filled =
 *     something is on, outlined = nothing is. That vocabulary is not new; it
 *     is the one the retired mode chip established and the owner has already
 *     used on hardware. It does not NAME the status, because the line directly
 *     above the hero names every open status, its age and what it is doing to
 *     the baselines, and the same fact twice is what §5 forbids.
 *   - **The Coach screen** (`showOpen` on) has no such line, so an open status
 *     would be invisible behind a closed door. It draws the open chips beside
 *     the door — the rail's OWN chips, so the × and the re-ask behave exactly
 *     as they did when the rail was docked — and the door therefore stays
 *     OUTLINED even when something is on. The chip is what says on; a fill
 *     beside it would be the same fact twice in one row.
 *
 * The door leads and its position never changes with state, because a control
 * that moves between taps is not a control (the same rule that fixes the order
 * of the five chips).
 *
 * The chevron points DOWN on both, which is a disclosure affordance rather than
 * a direction of travel — the reading Home established, kept rather than forked
 * for the surface where the sheet happens to rise from below.
 *
 * Neutral, never pine: both screens' accent budgets are spent elsewhere (Home's
 * hero, the Coach's send), and a status is a state, not an action. Never
 * `signal-*` either — that palette marks biology, and "I am traveling" is a
 * circumstance the user declared. The firewall holds even for Sick, which is
 * the tempting case and the wrong one.
 */
export function StatusControl({
  open,
  showOpen,
  disabled,
  hidden,
  onToggle,
  onEnd,
}: {
  open: readonly DayStatusRow[];
  /**
   * Draw the open statuses as chips beside the door, and dock the pair on the
   * gutter as its own row. The Coach screen sets it; Home does not, because
   * Home's line already states what is on and its folio row supplies the
   * layout.
   */
  showOpen?: boolean;
  /** A turn is running — the door and the chips read as controls but do nothing. */
  disabled?: boolean;
  /**
   * A write is awaiting approval; the control is gone, as the activity line is.
   * The agentic loop is genuinely suspended on one decision, and a second set
   * of live controls beside it would invite a gesture that cannot happen.
   */
  hidden?: boolean;
  /** Off → on, or a tap on an on-chip. The sheet closes either way. */
  onToggle: (chip: RailChip) => void;
  onEnd: (chip: RailChip & { openId: string }) => void;
}) {
  const [sheet, setSheet] = useState(false);
  if (hidden) return null;

  const anyOpen = open.length > 0;
  const spoken = anyOpen
    ? `Status: ${open.map((row) => displayStatus(row.label)).join(', ')}. Change`
    : 'Status: none set. Set one';
  // Only the chips that are actually ON. `railChips` is what caps the typed
  // ones at MAX_EXTRA_CHIPS, so the row cannot grow without bound here either.
  const openChips = showOpen ? railChips(open).filter((chip) => chip.openId !== null) : [];

  const door = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={() => setSheet(true)}
      // min-h-[44px] is the tap-target floor stated rather than inferred: the
      // chip's own text is 10px, so the padding alone only reaches ~36pt. The
      // negative margin keeps the optical edge flush with the gutter, and it
      // swaps sides with the door: trailing on Home's folio row, leading on the
      // Coach's band, where the open chips follow it.
      className={`min-h-[44px] flex-row items-center gap-1.5 rounded-btn px-2 py-2.5 active:bg-paper-deep ${
        showOpen ? '-ml-2' : '-mr-2'
      } ${disabled ? 'opacity-40' : ''}`}>
      <View
        className={
          anyOpen && !showOpen
            ? 'rounded-btn bg-paper-deep px-2 py-0.5'
            : 'rounded-btn border border-hairline px-2 py-0.5'
        }>
        {/* ink-secondary, not ink-muted: muted ink is documented against
            `paper` and `paper-dim`, but on the `paper-deep` fill it lands at
            4.21:1 and misses AA. This puts it at 5.83:1 and keeps the fill,
            which is what makes "on" readable across the row. */}
        <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
          Status
        </Text>
      </View>
      <Ionicons name="chevron-down" size={12} color={palette.inkMuted} />
    </Pressable>
  );

  return (
    <>
      {showOpen ? (
        // Its own row on the composer's opaque band, on the same gutter as the
        // field below it. It CANNOT wrap the way the rail could: one door, plus
        // the statuses the user has actually declared, which is nothing at all
        // on most days.
        <View className="flex-row flex-wrap items-center gap-1.5 px-5 pb-2">
          {door}
          {openChips.map((chip) => (
            <StatusChip
              key={chip.label}
              chip={chip}
              disabled={disabled}
              onToggle={onToggle}
              onEnd={onEnd}
            />
          ))}
        </View>
      ) : (
        door
      )}

      <Modal
        visible={sheet}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setSheet(false)}>
        {/* A native Modal builds its own root, so it never passes through
            `<Screen>` — ModalScreen prints the sheet, the grid and its OWN
            safe-area provider, without which the close control lands under the
            status bar. */}
        <ModalScreen>
          {/* Close LEADS, per ModalScreen's docblock (owner, 2026-08-25:
              "make them match on the leading edge"). */}
          <View className="flex-row items-center gap-1 px-5 pt-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={() => setSheet(false)}
              hitSlop={8}
              className="-ml-3 h-11 w-11 items-center justify-center active:opacity-60">
              <Ionicons name="close" size={22} color={palette.ink} />
            </Pressable>
            <Text className="flex-1 font-serif text-lg font-semibold text-ink">Today</Text>
          </View>
          {/* ONE operative sentence — what picking a word actually does. Not a
              description of the feature read back at the owner, which is the
              class of line he asked to be swept out (2026-08-10). */}
          <Text className="px-5 pt-1 font-serif text-[13px] leading-5 text-ink-secondary">
            Says what kind of day this is, then asks the Coach to adjust it.
          </Text>

          <ScrollView contentContainerClassName="pb-10 pt-5">
            {/* The RAIL's own chips. One vocabulary, two surfaces. */}
            <StatusRail
              open={open}
              disabled={disabled}
              onToggle={(chip) => {
                setSheet(false);
                onToggle(chip);
              }}
              onEnd={(chip) => {
                setSheet(false);
                onEnd(chip);
              }}
            />
            <Text className="px-5 pt-3 font-serif text-[11px] leading-4 text-ink-muted">
              Anything else, just tell the Coach. Skips on these days stop counting against you;
              their readings sit out of your 30-day baselines.
            </Text>
          </ScrollView>
        </ModalScreen>
      </Modal>
    </>
  );
}
