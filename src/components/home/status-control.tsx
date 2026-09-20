import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import { StatusRail } from '@/components/status/status-rail';
import { ModalScreen } from '@/components/ui/screen';
import { palette } from '@/constants/theme';
import type { DayStatusRow } from '@/lib/db/repositories/statuses';
import { displayStatus, type RailChip } from '@/lib/status/chips';

/**
 * The status control on Home — one small target beside the date.
 *
 * The owner took **Q5(c)**: the line above the hero *and* a control here. The
 * line states the fact; this is the door.
 *
 * ## Why it is a door and not a row of chips
 *
 * CLAUDE.md §5 is binding — Home answers *"what should I do right now"* and is
 * never a data dump — so five chips inlined on the folio row would be five
 * controls competing with the one action the screen is built around. This is
 * one target in the label voice that opens a sheet, and the sheet draws the
 * **rail's own chips** (src/components/status/status-rail.tsx), so Home and the
 * Coach screen cannot drift about what the five words are or what tapping one
 * does.
 *
 * ## Why it does not name the status
 *
 * Its predecessor, `ModeControl`, printed the mode's name ("Travel") because
 * nothing else on the page did. Something else does now: the line directly
 * above the hero names every open status, its age, and what it is doing to the
 * baselines. A chip restating it three lines higher would be the same fact
 * twice on the screen that is supposed to hold the fewest.
 *
 * So both faces read "Status", and the drawing carries the state: **filled =
 * something is on, outlined = nothing is**. That vocabulary is not new — it is
 * the one the mode chip established and the owner has already used on hardware,
 * after the first session ended with him having to be told the control was
 * there. The outline, the chevron and the 44pt target are what say "pressable";
 * the fill is what says "on". The spoken label carries the detail a sighted
 * reader gets from the line.
 *
 * Neutral, never pine: Home's one accent is the hero, and a status is a state,
 * not an action. Never `signal-*` either — that palette marks biology, and "I
 * am traveling" is a circumstance the user declared. The firewall holds even
 * for Sick, which is the tempting case and the wrong one.
 */
export function StatusControl({
  open,
  onToggle,
  onEnd,
}: {
  open: readonly DayStatusRow[];
  /** Off → on, or a tap on an on-chip. The sheet closes either way. */
  onToggle: (chip: RailChip) => void;
  onEnd: (chip: RailChip & { openId: string }) => void;
}) {
  const [sheet, setSheet] = useState(false);
  const on = open.length > 0;
  const spoken = on
    ? `Status: ${open.map((row) => displayStatus(row.label)).join(', ')}. Change`
    : 'Status: none set. Set one';

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={spoken}
        onPress={() => setSheet(true)}
        // min-h-[44px] is the tap-target floor stated rather than inferred: the
        // chip's own text is 10px, so the padding alone only reaches ~36pt. The
        // negative right margin keeps the optical edge flush with the gutter.
        className="-mr-2 min-h-[44px] flex-row items-center gap-1.5 rounded-btn px-2 py-2.5 active:bg-paper-deep">
        <View
          className={
            on
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
