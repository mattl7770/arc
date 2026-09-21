import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View } from 'react-native';

import { Chip } from '@/components/ui/chip';
import { palette } from '@/constants/theme';
import { displayStatus, railChips, type RailChip } from '@/lib/status/chips';

/**
 * One status chip, and the three gestures it carries.
 *
 * Extracted from the rail on 2026-09-21, when the Coach screen stopped drawing
 * the rail inline and started drawing **only the open chips** beside a door
 * (src/components/status/status-control.tsx). Two containers now hold chips —
 * the rail inside the sheet, and the door's row — and they have to be the SAME
 * chip, or the × and the re-ask start behaving differently depending on which
 * surface you tapped from. Nothing about the control changed in the move.
 *
 * ## Three gestures
 *
 *   1. **off → on.** Writes the row FIRST, then sends the prompt. The order is
 *      the whole point: on a plane the fact lands and the turn fails as every
 *      turn fails offline. (The caller does the writing; this is the tap.)
 *   2. **tap an on-chip.** The re-ask — day two of a five-day flu. Sends
 *      "Still sick…", writes nothing (the repository's re-tap guard).
 *   3. **the × on an on-chip.** Ends the status and SEEDS the composer rather
 *      than sending: ending is bookkeeping that may not warrant a turn. Its own
 *      44pt target, inside the chip's outline but not inside its press area.
 *
 * The × is drawn only on a status that HAS a tomorrow. Off day and Night out
 * end tonight by construction (the owner's Q4(a)), so there is nothing for an ×
 * to do to them and offering one would be a control that does nothing.
 */
export function StatusChip({
  chip,
  disabled,
  onToggle,
  onEnd,
}: {
  chip: RailChip;
  /** A turn is running — the chip reads as a chip but does nothing. */
  disabled?: boolean;
  /** Off → on, or a tap on an on-chip. The caller decides which it was. */
  onToggle: (chip: RailChip) => void;
  /** The × on an on-chip. Never called for a chip with no `openId`. */
  onEnd: (chip: RailChip & { openId: string }) => void;
}) {
  const on = chip.openId !== null;
  const canEnd = on && !chip.endsTonight;
  return (
    <Chip
      label={chip.display}
      on={on}
      compact
      disabled={disabled}
      onPress={() => onToggle(chip)}
      accessibilityLabel={displayStatus(chip.label)}
      accessibilityHint={
        on
          ? 'On. Asks the Coach to re-check today.'
          : 'Off. Records it and asks the Coach to adjust today.'
      }
      trailing={
        canEnd ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`End ${displayStatus(chip.label)}`}
            accessibilityHint="Ends it. Today stays excused."
            disabled={disabled}
            hitSlop={{ top: 12, bottom: 12, left: 6, right: 10 }}
            onPress={() => onEnd(chip as RailChip & { openId: string })}
            className="ml-1.5 h-[40px] w-5 items-center justify-center active:opacity-50">
            <Ionicons name="close" size={13} color={palette.inkSecondary} />
          </Pressable>
        ) : undefined
      }
    />
  );
}

/**
 * The status rail — the five quick-buttons that say what kind of day this is,
 * and then ask the Coach to do something about it.
 *
 * The owner's words: *"status quick-buttons on the Coach screen (Sick,
 * Traveling, …) that send a canned prompt — 'I am traveling right now. Check
 * what's up and adjust accordingly' — after which the Coach adjusts mission
 * items, the workout plan, etc. itself."*
 *
 * ## It is no longer docked on the Coach screen
 *
 * It was, from 2026-09-19 until 2026-09-21, when the owner used it on hardware:
 * *"buttons for the status thing on the coach tab need to be moved and put
 * behind another button."* All five now live **inside the sheet** — the one
 * Home was already opening beside the date — so this component has exactly one
 * caller (src/components/status/status-control.tsx) and both surfaces reach the
 * five words through the same door. The Coach screen draws only the OPEN chips
 * beside that door, with {@link StatusChip}.
 *
 * That is also why there is no `hidden` prop any more. It existed so a pending
 * write could suppress the docked rail; nothing is docked now, and the door
 * itself is what a pending write hides.
 *
 * ## Why no block, no accent, no signal colour
 *
 * A row of chips is CONTENT, not a device (00-design-spec.md §4), so there is
 * no `Block` around it. The Coach screen's one sanctioned accent is already
 * spent on the composer's send, and the status chrome hands off to it — the
 * chips never claim it. And no `signal-*`: that palette marks biology, and "I
 * am traveling" is a circumstance the user declared, not a measured state of
 * his body. The firewall holds even for Sick, which is the tempting case and
 * the wrong one.
 *
 * **Pure props.** No database, no hooks, no navigation — db/screens-render.mjs
 * renders it in isolation, which is the only way this vocabulary gets tested at
 * all: the Coach tab is not in that suite's screen list, and RN's `Modal`
 * returns null without a DOM, so the sheet's own body never appears there.
 */
export function StatusRail({
  open,
  disabled,
  onToggle,
  onEnd,
}: {
  /** Every status running today, newest started first. */
  open: readonly { id: string; label: string; end_date: string | null }[];
  /** A turn is running — the chips read as chips but do nothing. */
  disabled?: boolean;
  /** Off → on, or a tap on an on-chip. The caller decides which it was. */
  onToggle: (chip: RailChip) => void;
  /** The × on an on-chip. Never called for a chip with no `openId`. */
  onEnd: (chip: RailChip & { openId: string }) => void;
}) {
  return (
    // WRAPS, never scrolls, and never hides a chip: five compact chips measure
    // roughly 320–350px against ~350px usable at 390px, so two rows is the
    // expected shape rather than a failure state. A horizontal scroller would
    // put "Night out" off-screen behind a gesture nobody knows to make. Inside
    // the sheet there is room for both rows, which there was not above a
    // composer.
    <View className="flex-row flex-wrap gap-1.5 px-5 pb-2">
      {railChips(open).map((chip) => (
        <StatusChip
          key={chip.label}
          chip={chip}
          disabled={disabled}
          onToggle={onToggle}
          onEnd={onEnd}
        />
      ))}
    </View>
  );
}
