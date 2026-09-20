import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View } from 'react-native';

import { Chip } from '@/components/ui/chip';
import { palette } from '@/constants/theme';
import { displayStatus, railChips, type RailChip } from '@/lib/status/chips';

/**
 * The status rail — five quick-buttons above the composer that say what kind of
 * day this is, and then ask the Coach to do something about it.
 *
 * The owner's words: *"status quick-buttons on the Coach screen (Sick,
 * Traveling, …) that send a canned prompt — 'I am traveling right now. Check
 * what's up and adjust accordingly' — after which the Coach adjusts mission
 * items, the workout plan, etc. itself."*
 *
 * ## Why it is docked and not scrolled
 *
 * It sits on the composer's own opaque `bg-paper` band, above the input, and it
 * occludes the thread scrolling underneath. That is the screen's OWN test for
 * chrome (coach.tsx's surface note: *"the test is occlusion, not position"*),
 * and it is the right answer here for a plainer reason: a control that scrolls
 * away on a long thread is not a quick-button.
 *
 * ## Why no block, no accent, no signal colour
 *
 * A row of chips is CONTENT, not a device (00-design-spec.md §4), so there is
 * no `Block` around it. The screen's one sanctioned accent is already spent on
 * the composer's send, and this rail hands off to it — the chips never claim
 * it. And no `signal-*`: that palette marks biology, and "I am traveling" is a
 * circumstance the user declared, not a measured state of his body. The
 * firewall holds even for Sick, which is the tempting case and the wrong one.
 *
 * ## Three gestures
 *
 *   1. **off → on.** Writes the row FIRST, then sends the prompt. The order is
 *      the whole point: on a plane the fact lands and the turn fails as every
 *      turn fails offline.
 *   2. **tap an on-chip.** The re-ask — day two of a five-day flu. Sends
 *      "Still sick…", writes nothing (the repository's re-tap guard).
 *   3. **the × on an on-chip.** Ends the status and SEEDS the composer rather
 *      than sending: ending is bookkeeping that may not warrant a turn. Its own
 *      44pt target, inside the chip's outline but not inside its press area.
 *
 * The × is drawn only on a status that HAS a tomorrow. Off day and Night out
 * end tonight by construction (the owner's Q4(a)), so there is nothing for an ×
 * to do to them and offering one would be a control that does nothing.
 *
 * **It lives outside both surfaces that draw it.** Home opens the same row in
 * a sheet beside the date (the owner asked for both, his Q5(c)), and a chip row
 * that existed twice would start offering two vocabularies of the same five
 * words.
 *
 * **Pure props.** No database, no hooks, no navigation — db/screens-render.mjs
 * renders it in isolation, which is the only way this screen's chrome gets
 * tested at all (the Coach tab is not in that suite's screen list).
 */
export function StatusRail({
  open,
  disabled,
  hidden,
  onToggle,
  onEnd,
}: {
  /** Every status running today, newest started first. */
  open: readonly { id: string; label: string; end_date: string | null }[];
  /** A turn is running — the chips read as chips but do nothing. */
  disabled?: boolean;
  /** A write is awaiting approval; the rail is gone, as the activity line is. */
  hidden?: boolean;
  /** Off → on, or a tap on an on-chip. The caller decides which it was. */
  onToggle: (chip: RailChip) => void;
  /** The × on an on-chip. Never called for a chip with no `openId`. */
  onEnd: (chip: RailChip & { openId: string }) => void;
}) {
  if (hidden) return null;
  const chips = railChips(open);

  return (
    // WRAPS, never scrolls, and never hides a chip: five compact chips measure
    // roughly 320–350px against ~350px usable at 390px, so two rows is the
    // expected shape rather than a failure state. A horizontal scroller would
    // put "Night out" off-screen behind a gesture nobody knows to make.
    <View className="flex-row flex-wrap gap-1.5 px-5 pb-2">
      {chips.map((chip) => {
        const on = chip.openId !== null;
        const canEnd = on && !chip.endsTonight;
        return (
          <Chip
            key={chip.label}
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
      })}
    </View>
  );
}
