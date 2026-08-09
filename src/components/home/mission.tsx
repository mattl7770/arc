import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import type { MissionItem, MissionStatus } from '@/types/home';

import { MissionItemRow } from './mission-item';

type Props = {
  leadingSettled: MissionItem[];
  rest: MissionItem[];
  completed: number;
  total: number;
  onToggle: (id: string) => void;
};

/**
 * Today's Mission.
 *
 * Conformed Set treatment — the **ruled plate** device: a record is a table, so
 * the checklist sits on paper-hi inside a hairline, with its rows ruled. The
 * plate edge closes the last row, which is why no row draws a bottom rule.
 *
 * **One chronological list, not category groups** (owner call, 2026-07-24).
 * The order you read is the order you act, so the hero and the list can never
 * disagree about what is next. Category rides along as a label on each row.
 *
 * The only concession to length is that the run of already-settled items at
 * the top folds into a single line, so the list opens at *now*. Nothing still
 * pending is ever hidden — including things you are late for. That is the
 * whole distinction from the collapsible sections this screen used to refuse:
 * disclosure is allowed to hide history, never work.
 *
 * The fold is a **toggle in both directions.** It used to set `showSettled` to
 * `true` and never back, so one accidental tap expanded the morning for the
 * rest of the session with no way to put it away. A control that only works
 * once is not a disclosure control. The chevron and the label both state the
 * direction the next tap goes.
 *
 * ## The tally has to reconcile
 *
 * Two numbers on this block are load-bearing honesty (00-design-spec.md §5):
 *
 *   - "3 of 11" counts **completed only**. Skipped is not done, and
 *     `deriveMissionView` computes `completed` and `settled` separately for
 *     exactly that reason — this block reads `completed`.
 *   - When rows are folded, folded + visible must equal the total, and the
 *     fold has to say what it is holding. So it carries its own breakdown
 *     ("3 done · 2 skipped") which sums to the fold count, which in turn sums
 *     with the visible rows to `total`. A fold that hid two skips behind a
 *     count of five would be the lie the rule exists to catch. The breakdown
 *     stays on the control when the fold is open, where it now describes the
 *     rows directly beneath it — still reconciling, and it means expanding
 *     never makes a number disappear.
 *
 * The progress strip is per-item rather than a percentage fill: one tick per
 * item, in list order, each showing that item's real status. A single bar
 * filled to `completed / total` implies the finished items are the first ones,
 * which is usually false.
 */

/**
 * One tick per item, in list order. Whole class strings — see ./signal.
 *
 * **The ladder is ink, not hue.** The first cut of this strip drew four 3px
 * bars in four fills, and three of them were invisible: on the plate
 * (`paper-hi` #F5F3EC) `pine-tint` measured 1.78:1, `hairline` 2.29:1 and
 * `paper-deep` 1.62:1, all under the 3:1 non-text floor. A strip that cannot
 * show three of its four states is not showing progress.
 *
 * A light plate compresses everything that clears 3:1 into "dark" — `pine` and
 * `ink-muted` are 9.52:1 and 6.84:1 against the plate but only 1.39:1 against
 * *each other* — so colour alone cannot separate four states here. FORM carries
 * the distinction and colour carries only the done/not-done split:
 *
 *   completed  solid 8px accent block          pine       9.52:1
 *   partial    3px accent bar on the baseline  pine       9.52:1
 *   skipped    hollow: 2px neutral rules t+b   ink-muted  6.84:1
 *   pending    1px neutral baseline rule       ink-muted  6.84:1
 *
 * Every mark now clears 3:1, and the four differ by amount of ink AND by hue
 * family, so **skipped can never read as done**: settled-but-not-done is a
 * hollow neutral outline, done is a solid accent block. They share neither
 * fill nor colour. The lane grew from 3px to 8px because that is the room the
 * distinction needs — a border cannot read inside a 3px box.
 *
 * The accent appears here twice (completed, partial) and both are completion
 * stamps, which is exactly what Home's accent budget covers
 * (00-design-spec.md §2). Partial is the same hue at less ink, not a second
 * colour.
 */
const TICK: Record<MissionStatus, string> = {
  completed: 'bg-pine',
  partial: 'border-b-[3px] border-pine',
  skipped: 'border-y-2 border-ink-muted',
  pending: 'border-b border-ink-muted',
};

/**
 * The strip's accessible form. It is **summarised, not hidden** — the strip is
 * the only place on Home that reports skips.
 *
 * Marking it decorative would be the honest call if the same information were
 * reachable another way, and it is not:
 *
 *   - The block's own note is "3 of 11", `completed` of `total`. It omits
 *     skips by design, so a listener hears a number that is *smaller* than the
 *     day's real progress with nothing saying why.
 *   - The fold control's "3 done · 2 skipped" covers only the leading settled
 *     run. An item skipped later in the day is in neither number.
 *   - The rows themselves are `accessibilityRole="checkbox"` with
 *     `checked: status === 'completed'`, so a skipped row and a pending row
 *     both announce as unchecked. Walking all eleven rows would not recover
 *     the skip count either.
 *
 * The strip was rewritten precisely so that skipped can never read as done. To
 * then hide it from assistive tech would reinstate exactly that defect for
 * anyone not looking at the pixels — the fix would have stopped at the pixels.
 *
 * What it announces is the tally, not the per-item order: order is already
 * carried by the rows, which are traversed in the same sequence, and reading
 * eleven statuses aloud would bury the one thing the strip adds. The four
 * counts are derived from the rendered items, so they sum to the list length
 * by construction and cannot drift from the note above them (00-design-spec.md
 * §5 — a tally has to reconcile). Zero counts are dropped rather than spoken.
 */
function progressLabel(items: MissionItem[]): string {
  const tally: Record<MissionStatus, number> = { completed: 0, partial: 0, skipped: 0, pending: 0 };
  for (const item of items) tally[item.status] += 1;

  const parts = (['completed', 'partial', 'skipped', 'pending'] as const)
    .filter((status) => tally[status] > 0)
    .map((status) => `${tally[status]} ${status}`);

  return `Progress by item: ${parts.join(', ')}. ${items.length} in total.`;
}

export function Mission({ leadingSettled, rest, completed, total, onToggle }: Props) {
  const [showSettled, setShowSettled] = useState(false);
  // Folding one row saves nothing and costs a tap, so the control only exists
  // for a run of two or more. `foldable` is whether the control is drawn at
  // all; `folded` is which way it currently points.
  const foldable = leadingSettled.length > 1;
  const folded = foldable && !showSettled;
  const ordered = [...leadingSettled, ...rest];
  const visible = folded ? rest : ordered;

  // `leadingSettled` holds only settled items, so these two sum to its length.
  const foldedDone = leadingSettled.filter((item) => item.status === 'completed').length;
  const foldedSkipped = leadingSettled.length - foldedDone;

  return (
    <Block device="plate">
      <SectionLabel label="Today’s Mission" note={`${completed} of ${total}`} />

      {ordered.length > 0 ? (
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel={progressLabel(ordered)}
          className="mt-2.5 flex-row gap-0.5">
          {ordered.map((item) => (
            <View key={item.id} className={`h-2 flex-1 ${TICK[item.status]}`} />
          ))}
        </View>
      ) : null}

      <View className="mt-1">
        {foldable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: !folded }}
            accessibilityLabel={
              folded
                ? `Show ${leadingSettled.length} earlier items: ${foldedDone} done, ${foldedSkipped} skipped`
                : `Hide ${leadingSettled.length} earlier items: ${foldedDone} done, ${foldedSkipped} skipped`
            }
            onPress={() => setShowSettled((shown) => !shown)}
            className="min-h-[44px] flex-row items-center gap-2 py-3 active:opacity-60">
            <Ionicons
              name={folded ? 'chevron-down' : 'chevron-up'}
              size={13}
              color={palette.inkMuted}
            />
            <Text className="flex-1 font-label text-[10px] font-semibold uppercase tracking-[0.5px] text-ink-secondary">
              {folded
                ? `${leadingSettled.length} earlier today`
                : `Hide ${leadingSettled.length} earlier today`}
            </Text>
            {/* Sums to the fold count, so the fold cannot pass a skip off as a done. */}
            <Text className="font-mono text-[10px] text-ink-muted">
              {foldedSkipped > 0
                ? `${foldedDone} done · ${foldedSkipped} skipped`
                : `${foldedDone} done`}
            </Text>
          </Pressable>
        ) : null}

        {/*
          Explicit hairlines rather than `divide-y`: that utility relies on
          a CSS sibling selector, which has no React Native equivalent.

          The first row skips its top rule only when nothing sits above it
          inside the plate — i.e. when there is no fold control at all. The
          control is drawn in both fold states now, so the test is `foldable`,
          not "currently folded".
        */}
        {visible.map((item, index) => (
          <View
            key={item.id}
            className={index === 0 && !foldable ? '' : 'border-t border-hairline'}>
            <MissionItemRow item={item} onToggle={onToggle} />
          </View>
        ))}
      </View>
    </Block>
  );
}
