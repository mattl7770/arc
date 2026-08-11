import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import type { MissionItem, MissionStatus } from '@/types/home';

import { MissionItemRow } from './mission-item';

type Props = {
  leadingSettled: MissionItem[];
  rest: MissionItem[];
  completed: number;
  total: number;
  /**
   * The item the hero is currently showing, so the list can mark the same row
   * as "you are here". Passed down from Home rather than re-derived here: the
   * hero is `deriveMissionView().next`, which is the first non-snoozed *pending*
   * item — not simply the first row of `rest`, which may be snoozed or partial.
   * Two definitions of "next" is exactly the drift the single chronological list
   * exists to prevent.
   */
  activeId?: string | null;
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
 * **It is a scale, and every graduation on a scale is the same size.** The
 * sheet draws `.cf-progress` as a row of uniform 3×8 lanes — `paper-line` when
 * the item is outstanding, `accent` when it is done — so an eleven-item day is
 * eleven equal lanes with three of them inked, and the silhouette is a measure
 * filling up. That silhouette is the information: you read the day's shape
 * before you read any single mark.
 *
 * It was lost between 2026-08-09 and 2026-08-11. `pending` had been collapsed
 * to a 3×1 rule on the lane's baseline, so an eleven-item day drew three bars
 * and eight specks — a strip with nothing to fill.
 *
 * ## Why it was collapsed, and why that reason survives the restoration
 *
 * The sheet's unfilled lane is `paper-line`, which is `hairline` #A9A28E here,
 * and on the plate it sits on (`paper-hi` #F5F3EC) that measures **2.29:1** —
 * under the 3:1 WCAG 1.4.11 asks of a non-text visual. The sheet's own
 * arithmetic works optically (accent-to-paper-line is 4.15:1, a wide lightness
 * step that survives losing hue) and fails against the plate: eight lanes you
 * cannot reliably see are not a scale either. Shrinking the outstanding mark
 * was the wrong fix for a real problem.
 *
 * ## The obvious repair does not exist in this palette
 *
 * A full solid lane in a darker unfilled cut has to clear two thresholds at
 * once: 3:1 against the plate, and 3:1 against the inked lane, or done and
 * outstanding are separated by nothing but hue. Solving both pins the unfilled
 * cut's relative luminance to **L ∈ [0.248, 0.265]** — about a 7% window. The
 * palette has no value in it. `hairline` sits at L 0.362 (2.29:1 on the plate,
 * fails the first) and `ink-muted` at L 0.088 (6.84:1 on the plate, but
 * **1.39:1 against `pine`** — fails the second, and 1.39:1 is the same "one
 * grey" defect the signal swatches have, see ./signal.tsx). Nothing lies
 * between them. So the lane is uniform in SIZE and the split is carried by
 * INK, which is a channel the palette does have:
 *
 *   completed  lane fully inked        solid 3×8 accent            pine       9.52:1
 *   partial    lane half inked         4pt accent on the baseline  pine       9.52:1
 *                                      + 1pt neutral cap above     ink-muted  6.84:1
 *   skipped    lane struck out         1pt caps + 2pt centre bar   ink-muted  6.84:1
 *   pending    lane open               1pt caps, top and bottom    ink-muted  6.84:1
 *
 * Every mark occupies the full 3×8 lane, so the row is eleven equal graduations
 * and the sheet's silhouette is back. Every mark clears 3:1 on the plate. And
 * done-vs-outstanding is a **4:1 difference in ink** (24pt² against 6pt²)
 * before hue is considered at all, which is the test the collapsed version was
 * passing and a plain `ink-muted` lane would not.
 *
 * The two invariants the previous cut existed to protect both hold:
 * **skipped can never read as done** — half-inked, neutral, and visibly holed
 * against solid accent — and **partial can never read as done**, at half the
 * accent and still showing its open cap.
 *
 * The accent appears here twice (completed, partial) and both are completion
 * stamps, which is exactly what Home's accent budget covers
 * (00-design-spec.md §2). Partial is the same hue at less ink, not a second
 * colour.
 *
 * **Fixed 3px lanes, inline with the section label** (2026-08-10). The strip
 * used to be a full-width row of its own under the label, each lane `flex-1`,
 * which made an eleven-item day draw an edge-to-edge bar chart across the plate
 * and cost the block a whole row of height. The sheet puts the cluster inside
 * `.cf-sec-note` — 3px lanes at a 1.6px gutter, right-aligned on the label's own
 * baseline, immediately before the `3 of 11` it belongs to. That is what makes
 * it read as a *tally mark* beside its own number rather than as a progress bar,
 * and it is the largest silhouette difference between the shipped block and the
 * drawing. Restoring the full-height lane changes none of it: the cluster is
 * still 11 × 3pt at a 1.6pt gutter and still 8pt tall.
 */
/**
 * One lane of the progress strip: an 8px-tall cell whose MARK states the item's
 * status, drawn as filled bars rather than as borders.
 *
 * Each mark is a stack of filled bars inside the lane, spaced by
 * `justify-between`, so the outermost bars land on the lane's own edges and the
 * mark's footprint is the lane whatever is inside it. The bars stretch to the
 * lane's 3pt width by RN's default `align-items: stretch`, which is why none of
 * them names a width.
 *
 * They are drawn rather than bordered for the same reason every rule in the app
 * now is (see `Divider` in src/components/ui/block.tsx): a one-sided width plus
 * a whole-element `border-color` is the shape that makes React Native abandon
 * its CoreAnimation border path and render the mark as a full rectangle. Here
 * that failure would have been worse than cosmetic — every one of these four
 * marks boxed is a nearly-solid cell, i.e. `completed`, and the whole point of
 * the set is that **skipped and partial can never read as done**.
 */
function Tick({ status }: { status: MissionStatus }) {
  // Fully inked: the lane is the mark.
  if (status === 'completed') return <View className="h-2 w-[3px] bg-pine" />;
  // Half inked, from the baseline up, with the open cap still showing above it.
  if (status === 'partial') {
    return (
      <View className="h-2 w-[3px] justify-between">
        <View className="h-px bg-ink-muted" />
        <View className="h-1 bg-pine" />
      </View>
    );
  }
  // Struck out: the open lane with a bar drawn through it.
  if (status === 'skipped') {
    return (
      <View className="h-2 w-[3px] justify-between">
        <View className="h-px bg-ink-muted" />
        <View className="h-0.5 bg-ink-muted" />
        <View className="h-px bg-ink-muted" />
      </View>
    );
  }
  // Open: the graduation, waiting to be inked.
  return (
    <View className="h-2 w-[3px] justify-between">
      <View className="h-px bg-ink-muted" />
      <View className="h-px bg-ink-muted" />
    </View>
  );
}

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

export function Mission({ leadingSettled, rest, completed, total, activeId, onToggle }: Props) {
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
      <SectionLabel
        label="Today’s Mission"
        note={`${completed} of ${total}`}
        accessory={
          ordered.length > 0 ? (
            <View
              accessible
              accessibilityRole="text"
              accessibilityLabel={progressLabel(ordered)}
              className="flex-row gap-[1.6px] self-center">
              {ordered.map((item) => (
                <Tick key={item.id} status={item.status} />
              ))}
            </View>
          ) : null
        }
      />

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
          <View key={item.id}>
            <Divider first={index === 0 && !foldable} />
            <MissionItemRow item={item} active={item.id === activeId} onToggle={onToggle} />
          </View>
        ))}
      </View>
    </Block>
  );
}
