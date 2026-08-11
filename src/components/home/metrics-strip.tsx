import { Text, View } from 'react-native';

import { Block, GridCell } from '@/components/ui/block';
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
 * *is* the object. It is drawn by the rules that run BETWEEN its cells — a top
 * rule on each, a vertical down the middle — which is what makes four readings
 * read as a dimension table rather than as four floating numbers.
 *
 * ## The rules went away for two days, and it was a rendering bug (2026-08-11)
 *
 * They were cut on 2026-08-09 because the owner named this block, unprompted,
 * as one of two carrying "weird boxes and lines" on hardware. The reading at
 * the time was that a rule with no outer edge to close it is a half-drawn box a
 * viewer has to interpret, and 00-design-spec.md §5 says chrome that has to be
 * interpreted is decoration. That reasoning was sound and the premise was
 * false: the cells were not drawing rules. They drew `border-t border-hairline`
 * and `border-r border-hairline`, a one-sided width against a whole-element
 * colour, which React Native paints as a COMPLETE RECTANGLE (the full trace is
 * under `Divider` in src/components/ui/block.tsx). The owner was not describing
 * an under-drawn table. They were describing a box around every metric, because
 * that is what was on the glass.
 *
 * The rules are back, drawn as filled views by {@link GridCell}, which also
 * retires the long-standing trailing-rule bug this file used to carry a comment
 * about: the vertical is conditioned on a cell actually following, so an odd
 * number of metrics can no longer rule off into empty space.
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
        <View className="mt-2 flex-row flex-wrap">
          {metrics.map((metric, index) => {
            const level = gradedLevel(metric);

            return (
              <GridCell key={metric.id} index={index} count={metrics.length}>
                <View accessible accessibilityRole="text" accessibilityLabel={metricSpoken(metric)}>
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
              </GridCell>
            );
          })}
        </View>
      )}
    </Block>
  );
}
