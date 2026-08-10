import { Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import type { Metric, SignalLevel } from '@/types/home';

import { signalConditionLabel, signalConditionSpoken, signalTextClass } from './signal';

/**
 * Minimal live metrics, set like lab values: mono numerals, muted small-caps
 * labels, no charts, no history. Anything that invites interpretation belongs
 * in the Data tab; this is only here so the readiness verdict above has visible
 * evidence behind it.
 *
 * Conformed Set treatment — the **grid** device: no outer box, because the grid
 * *is* the object.
 *
 * ## The rules are gone (2026-08-09, owner call on hardware)
 *
 * This block used to draw hairlines BETWEEN its cells: a top rule on every
 * cell, plus a vertical rule down the middle of the first column. On paper that
 * is a table. On a phone the owner read it as a defect — it was one of the two
 * surfaces they named unprompted ("weird boxes and lines... notably the metrics
 * and coach brief"). The reason is structural, not a matter of taste: a rule
 * above the first row and a rule down the middle, with no outer edge to close
 * them, is a *half-drawn box*. A viewer has to work out that the missing edges
 * are deliberate before the lines help them, and 00-design-spec.md §5 says
 * drafting chrome that has to be interpreted before it pays is decoration.
 *
 * So the cells are held by alignment and whitespace alone. Two equal columns,
 * consistent row rhythm, and the three type voices doing the separating —
 * muted tracked-caps label, mono value, mono detail. Nothing is lost: the
 * columns were already aligned, and the rules were tracing an order the layout
 * establishes by itself.
 *
 * A side benefit worth recording, because it was a real bug this file carried
 * a long comment about: with no rules there is no "does a cell follow this
 * one" question, so an odd number of metrics can no longer draw a vertical
 * rule into empty space off the final cell. The whole class of defect is
 * deleted rather than guarded.
 *
 * Values come from src/lib/home/readiness.ts, which renders every missing
 * signal as an em-dash — no data, no number, and never a plausible-looking
 * estimate.
 *
 * ## A cell states its condition in words, not only in the hue of its number
 *
 * This cell used to carry a metric's four-state level ONLY as the colour of its
 * mono value: no word, no form, no weight. That is the exact encoding the pillar
 * strip was rewritten to eliminate (./readiness-strip.tsx, and the full
 * reasoning above `MARK` in ./signal.tsx) — the four signal cuts are mutually
 * 1.06–1.59:1, so to anyone not perceiving hue they are one grey and the cell
 * stated the metric's condition nowhere at all.
 *
 * The argument for leaving it here was that the detail line beneath usually
 * restates the measurement, so the state is recoverable. It does not hold. Two
 * of the four cells this screen always renders are counterexamples: Sleep's
 * detail is `Deep 42m` or a bare device name, neither of which says whether 7h
 * 12m was good, and Steps is deliberately ungraded so its detail is only
 * "today". "Usually recoverable" is not an encoding.
 *
 * So the condition is now stated in words, in the signal INK cut, on the label
 * row — the same move and the same cut as the pillar cell. The grid draws no
 * fill of its own, so these words sit on `paper`, where the ink cut measures
 * 5.91–6.46:1, comfortably past 4.5:1. With the word carrying the state the
 * value's hue drops to redundant reinforcement rather than the sole cue.
 *
 * **An ungraded metric gets no word and no hue.** `level` absent or `unknown`
 * means ARC is not grading this reading — Steps always, and anything with no
 * data behind it — so the value stays `ink` and the row states no condition.
 * Printing the pillars' em-dash here would claim a verdict slot that Steps does
 * not have. No grade, no mark.
 *
 * The cell is grouped for assistive tech and speaks as one phrase — "Sleep,
 * 7h 12m, good. Deep 42m." — because a label, a number and a condition read as
 * three separate items are three facts the listener has to reassemble.
 *
 * This is also why dropping the rules costs the block nothing: the cell already
 * states its own condition in words. The hairlines were never carrying meaning,
 * only enclosure.
 */

/** What readiness.ts prints for a missing reading. Spoken, not read aloud. */
const NO_READING = '—';

/** Absent or `unknown` means ungraded: no word, no hue. */
function gradedLevel(metric: Metric): SignalLevel | null {
  return metric.level && metric.level !== 'unknown' ? metric.level : null;
}

/**
 * The whole cell as one phrase. The em-dash is a typographic convention for
 * absence that is spoken inconsistently or not at all, so it is said in words —
 * the same divergence ./signal.tsx's SPOKEN map makes for `unknown`. When the
 * reading is missing the detail is dropped: every missing metric's detail is
 * "No data yet", and "no data. No data yet." is not worth a listener's time.
 */
function metricSpoken(metric: Metric): string {
  const level = gradedLevel(metric);
  const condition = level ? `, ${signalConditionSpoken(level)}` : '';

  if (metric.value === NO_READING) return `${metric.label}, no data.`;

  const detail = metric.detail ? `. ${metric.detail}` : '';
  return `${metric.label}, ${metric.value}${condition}${detail}.`;
}

/**
 * The two columns. No rules — only the gutter that keeps the right column's
 * text off the left column's, and the row rhythm that replaces the old top
 * rule. Whole class strings, never a built prefix.
 */
const CELL_LEFT = 'w-1/2 pr-3 pt-4';
const CELL_RIGHT = 'w-1/2 pl-3 pt-4';

function cellClass(index: number): string {
  return index % 2 === 0 ? CELL_LEFT : CELL_RIGHT;
}

export function MetricsStrip({ metrics }: { metrics: Metric[] }) {
  return (
    <Block device="grid">
      <SectionLabel label="Metrics" note="Today" />

      {/*
        Defensive, not a state Home currently reaches: `deriveReadiness` always
        builds the same four literal entries (sleep / HRV / resting HR / steps),
        each of which renders "—" when its signal is missing, so today's caller
        can never pass an empty array. It is kept for a future caller that
        derives its metrics — an empty grid must be authored, never blank — and
        should be deleted rather than left to rot if no such caller appears.
      */}
      {metrics.length === 0 ? (
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
          No readings yet today. Connect Apple Health in Settings to populate this.
        </Text>
      ) : (
        <View className="flex-row flex-wrap">
          {metrics.map((metric, index) => {
            const level = gradedLevel(metric);

            return (
              <View
                key={metric.id}
                accessible
                accessibilityRole="text"
                accessibilityLabel={metricSpoken(metric)}
                className={cellClass(index)}>
                <View className="flex-row items-center justify-between gap-1.5">
                  <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                    {metric.label}
                  </Text>
                  {level ? (
                    <Text
                      className={`font-label text-[10px] font-semibold uppercase tracking-[0.5px] ${signalTextClass(
                        level
                      )}`}>
                      {signalConditionLabel(level)}
                    </Text>
                  ) : null}
                </View>

                <Text
                  className={`mt-1 font-mono text-lg font-semibold ${
                    level ? signalTextClass(level) : 'text-ink'
                  }`}>
                  {metric.value}
                </Text>

                {metric.detail ? (
                  <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                    {metric.detail}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      )}
    </Block>
  );
}
