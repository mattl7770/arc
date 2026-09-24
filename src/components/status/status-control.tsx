import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import { StatusRail } from '@/components/status/status-rail';
import { ModalScreen } from '@/components/ui/screen';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import type { DayStatusRow } from '@/lib/db/repositories/statuses';
import { deriveReadiness } from '@/lib/home/readiness';
import { displayStatus, type RailChip } from '@/lib/status/chips';
import { statusLine } from '@/lib/status/line';

/**
 * The status control — one small target that opens the five chips in a sheet.
 *
 * **One component, two surfaces.** It began on Home (the owner took **Q5(c)**:
 * the line above the hero *and* a control beside the date) and moved here from
 * `src/components/home/status-control.tsx` on **2026-09-21**, when the owner
 * used the new build and said of the Coach tab: *"buttons for the status thing
 * on the coach tab need to be moved and put behind another button."* The Coach
 * screen had a rail of five chips docked above its composer; it now has this
 * door instead.
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
 * ## The door names the status (2026-09-23)
 *
 * Until then it read "Status" whatever was on, and each surface said *on*
 * somewhere else: Home with the door's fill plus a mono line above the hero,
 * the Coach tab by drawing the open chip beside the door. The owner, on the
 * device, of Home: *"the message is there, but i think it would be better if
 * the status button just changed to say 'Sick' or whatever the currently
 * active status is."*
 *
 * So the door reads the status itself — `SICK`, `TRAVELING` — in the label
 * voice it always spoke in, and `STATUS` when nothing is on. Filled when
 * something is on, outlined when nothing is, as before: the word says WHICH,
 * the fill says THAT, and they are one object rather than two. That retires
 * both of the other places, on one argument — a door naming the status beside a
 * line or a chip naming it again is the same fact twice. **One face now, on
 * both surfaces**; `docked` changes where it sits and nothing else.
 *
 * The rule that a running status is visible without opening anything
 * (information-architecture.md, *"never silently on"*) is kept by the door,
 * which is on both screens whenever either is open. What only Home's line
 * said — each status's age, whether its skips are excused, and what it is doing
 * to the readiness baselines — is the sheet's header now ({@link StatusFacts}),
 * in mono, one tap away on either screen.
 *
 * **Several at once** name the newest (they arrive newest-first) and count the
 * rest in mono — `SICK +1` — because a door that grows by a word per status is
 * the rail again, and the header names every one. A long typed label
 * truncates rather than pushing the date off Home's folio row.
 *
 * **The re-ask and the × stay in the sheet**, on the rail's own chips, where
 * they already were. Not on the door: with two statuses on, a × on a door
 * reading `SICK +1` could not say which one it ends; and the door is the same
 * component on Home, where a permanent end target beside the date would put a
 * gesture that writes a row and carries a message to the Coach one mis-tap from
 * the top of the screen. The price, on the Coach tab, is one tap — the door, then
 * the chip or ×.
 *
 * The door's anchored edge never moves with state — trailing on Home's folio
 * row, leading on the Coach's band — and only its width follows the word,
 * because a control that moves between taps is not a control (the same rule
 * that fixes the order of the five chips).
 *
 * The chevron points DOWN on both, which is a disclosure affordance rather than
 * a direction of travel — the reading Home established, kept rather than forked
 * for the surface where the sheet happens to rise from below.
 *
 * Neutral, never pine: both screens' accent budgets are spent elsewhere (Home's
 * hero, the Coach's send), and a status is a state, not an action. Never
 * `signal-*` either — that palette marks biology, and "I am traveling" is a
 * circumstance the user declared. The firewall holds even for Sick, which is
 * the tempting case and the wrong one — and it holds harder now that the door
 * prints the word.
 */
export function StatusControl({
  open,
  docked,
  disabled,
  hidden,
  onToggle,
  onEnd,
}: {
  open: readonly DayStatusRow[];
  /**
   * Dock the door on the gutter as its own row, leading edge flush — the Coach
   * screen's composer band. Home omits it: its folio row supplies the layout,
   * and the door sits trailing, beside the date.
   */
  docked?: boolean;
  /** A turn is running — the door reads as a control but does nothing. */
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
  // Bumped on every opening and used as the header's key, so the header is
  // read fresh each time the sheet rises — even one that rises again before
  // iOS has finished dismissing it, when the Modal's children stay mounted.
  const [opening, setOpening] = useState(0);
  if (hidden) return null;

  // Newest started first, so a status just set with a tap is the one named.
  const lead = open[0];
  const more = open.length - 1;
  const spoken = lead
    ? `Status: ${open.map((row) => displayStatus(row.label)).join(', ')}. Re-check or change`
    : 'Status: none set. Set one';

  const door = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={() => {
        setOpening((n) => n + 1);
        setSheet(true);
      }}
      // min-h-[44px] is the tap-target floor stated rather than inferred: the
      // word's own text is 10px, so the padding alone only reaches ~36pt. The
      // negative margin keeps the optical edge flush with the gutter, and it
      // swaps sides with the placement: trailing on Home's folio row, leading
      // on the Coach's band. `shrink`, with the word's `numberOfLines`, is what
      // lets a long typed status truncate instead of shoving the date aside.
      className={`min-h-[44px] shrink flex-row items-center gap-1.5 rounded-btn px-2 py-2.5 active:bg-paper-deep ${
        docked ? '-ml-2' : '-mr-2'
      } ${disabled ? 'opacity-40' : ''}`}>
      <View
        className={
          lead
            ? 'shrink flex-row items-baseline gap-1 rounded-btn bg-paper-deep px-2 py-0.5'
            : 'shrink flex-row items-baseline gap-1 rounded-btn border border-hairline px-2 py-0.5'
        }>
        {/* ink-secondary, not ink-muted: muted ink is documented against
            `paper` and `paper-dim`, but on the `paper-deep` fill it lands at
            4.21:1 and misses AA. This puts it at 5.83:1 and keeps the fill,
            which is what makes "on" readable across the row. */}
        <Text
          numberOfLines={1}
          className="shrink font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
          {lead ? displayStatus(lead.label) : 'Status'}
        </Text>
        {/* A count is a measurement, so mono — the label + tally pairing
            SectionLabel already sets. It never truncates; the word does. */}
        {more > 0 ? (
          <Text className="font-mono text-[10px] text-ink-secondary">{`+${more}`}</Text>
        ) : null}
      </View>
      <Ionicons name="chevron-down" size={12} color={palette.inkMuted} />
    </Pressable>
  );

  return (
    <>
      {docked ? (
        // Its own row on the composer's opaque band, on the same gutter as the
        // field below it: one 44pt line holding the door and nothing else.
        <View className="flex-row px-5 pb-2">{door}</View>
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
          {/* What is on, since when, and what it is doing to the numbers —
              directly under the title, as it sat under Home's date. */}
          <StatusFacts key={opening} open={open} />
          {/* ONE operative sentence — what picking a word actually does. Not a
              description of the feature read back at the owner, which is the
              class of line he asked to be swept out (2026-08-10). */}
          <Text className="px-5 pt-1 font-serif text-[13px] leading-5 text-ink-secondary">
            Says what kind of day this is, then asks the Coach to adjust it.
          </Text>

          <ScrollView contentContainerClassName="pb-10 pt-5">
            {/* The RAIL's own chips — and with them the re-ask and the ×, which
                since 2026-09-23 are nowhere else. One vocabulary, two
                surfaces. */}
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
              For anything else, tell the Coach. Skips on these days stop counting against you;
              their readings sit out of your 30-day baselines.
            </Text>
          </ScrollView>
        </ModalScreen>
      </Modal>
    </>
  );
}

/**
 * The sheet's header: every open status, since when, whether its skips are
 * excused, and what it is doing to the readiness baselines — the sentence
 * src/lib/status/line.ts builds, in mono because it is dates and counts.
 * Nothing at all on a day with no status.
 *
 * It sat above Home's hero until 2026-09-23, when the door started naming the
 * status (see {@link StatusControl}). Here it reaches the Coach tab too, which
 * the line never did.
 *
 * **It derives the two baseline numbers itself** rather than taking them as
 * props. RN's `Modal` renders nothing while it is hidden, so this mounts only
 * when the door is tapped: the derivation is paid on that tap and never on
 * either screen's render, and the Coach tab — which draws no readiness at all —
 * does not start computing it just to feed a header. It is read ONCE, when the
 * sheet opens — after whatever a Coach turn recorded — and not again: every
 * gesture on the sheet closes it, and on iOS the Modal keeps this mounted
 * through its slide-out, which is exactly when the store's broadcast lands.
 * Re-deriving then would redraw the header of a sheet that is leaving.
 *
 * Exported because the sheet's body cannot be server-rendered (the Modal
 * again), so db/screens-render.test.mjs renders this directly against the real
 * database, as it does the rail.
 */
export function StatusFacts({ open }: { open: readonly DayStatusRow[] }) {
  const [sentence] = useState(() => {
    if (open.length === 0) return null;
    const today = todayISODate();
    // Guarded, as `currentStatuses()` is: this line informs and the chips under
    // it act, and a failed derivation must not take the controls down with it.
    // It then states the statuses and their ages without the baseline clause —
    // less than the whole truth, but nothing in it false.
    let baselines = { excludedStatusDays: 0, recoveryPausedByStatus: false };
    try {
      const view = deriveReadiness(getDb(), today);
      baselines = {
        excludedStatusDays: view.excludedStatusDays,
        recoveryPausedByStatus: view.recoveryPausedByStatus,
      };
    } catch (error) {
      console.warn('[status] could not derive the baselines for the sheet header', error);
    }
    return statusLine({ open, today, ...baselines });
  });

  if (sentence === null) return null;
  return (
    <Text className="px-5 pt-1 font-mono text-[11px] leading-4 text-ink-muted">{sentence}</Text>
  );
}
