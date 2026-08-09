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
 * Conformed Set treatment — the **ruled grid** device: no outer box, because
 * the grid *is* the object. React Native has neither CSS grid nor
 * `:nth-child()`, so the modulo is computed in JS and the rules live on the
 * cells: every cell takes a top rule, and a left-column cell takes a right rule
 * (01-rn-port-guide.md §1.3). Whole class strings, never a built prefix.
 *
 * **The vertical rule is conditioned on a cell following it, not on the column.**
 * "Hairline between cells only" means a rule needs a cell on both sides. With an
 * odd number of metrics the final cell sits in the left column with nothing
 * beside it, and the naive `index % 2 === 0` test draws its right rule into
 * empty space — which is exactly the outer edge this device exists to avoid.
 * The port guide's §1.3 snippet and the mockup's `nth-child` CSS both have that
 * flaw; this is the corrected form. (The current derivation always yields four
 * metrics, so the odd case is latent rather than visible — which is precisely
 * why it needs to be closed here before ~40 screens copy the pattern.)
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

/** Left column with a cell beside it: closes with a vertical rule. */
const CELL_LEFT = 'w-1/2 border-r border-t border-hairline py-2.5 pr-2.5';
/** Left column, nothing beside it (odd count): same box, no dangling rule. */
const CELL_LEFT_LAST = 'w-1/2 border-t border-hairline py-2.5 pr-2.5';
/** Right column: top rule only; the grid never draws an outer edge. */
const CELL_RIGHT = 'w-1/2 border-t border-hairline py-2.5 pl-2.5';

function cellClass(index: number, count: number): string {
  if (index % 2 !== 0) return CELL_RIGHT;
  return index + 1 < count ? CELL_LEFT : CELL_LEFT_LAST;
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
              <View
                key={metric.id}
                accessible
                accessibilityRole="text"
                accessibilityLabel={metricSpoken(metric)}
                className={cellClass(index, metrics.length)}>
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
