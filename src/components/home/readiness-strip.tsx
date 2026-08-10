import { Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import type { Pillar, Readiness } from '@/types/home';

import {
  SignalTick,
  signalConditionLabel,
  signalConditionSpoken,
  signalMarkClass,
  signalTextClass,
} from './signal';

type Props = {
  readiness: Readiness;
  pillars: Pillar[];
};

/**
 * Readiness verdict + pillar swatches, below the hero (owner call,
 * 2026-07-24): the screen answers "what do I do" before "how am I doing".
 *
 * Conformed Set treatment — the **field** device: no box at all. It used to
 * carry 11px L-shaped corner ticks at opposite corners, which were meant to say
 * "this region was measured". On hardware they said nothing of the kind — two
 * disconnected brackets with no enclosure are the most abstract mark in the set
 * and the least self-explanatory, and they were the prime suspect behind the
 * owner's "weird boxes" on first sight. They are gone (2026-08-09); the full
 * reasoning is in src/components/ui/block.tsx.
 *
 * What still says "verdict" is the content, which is stronger than a bracket
 * was: a section label, a signal tick beside a serif verdict line, four pillar
 * swatches, and a detail line — separated from its neighbours by air, like
 * every other section on this screen.
 *
 * ## The pillar cells lost their boxes too (2026-08-10)
 *
 * They were four `border-hairline bg-paper-dim` cells in a row. The argument for
 * them was that a swatch reads as a *sample* of a state — but four equal boxes
 * abreast is a grid, and **a grid draws no rules** (block.tsx): the row is held
 * by `flex-1` columns and a 6px gutter whether or not anything is drawn around
 * them. The owner raised the stray-mark point a second time on 2026-08-10 ("more
 * lines on things that shouldn't have them"), and four hairline boxes directly
 * under the one unboxed verdict line on the sheet is the loudest remaining
 * instance on Home.
 *
 * Dropping the `paper-dim` fill with them *improves* the numbers this block was
 * tuned against: the signal ink cut measures 5.12–5.60:1 on paper-dim and
 * 5.91–6.46:1 on the sheet (the same figures metrics-strip.tsx cites for the
 * same words on the same stock). Nothing here got harder to read.
 *
 * Every colour that remains is a signal colour and every signal colour here is
 * biology — the accent is not permitted anywhere in this block.
 *
 * ## A cell is a reading: name, mark, condition
 *
 * The cell used to draw a swatch and the pillar's NAME and stop there, which
 * means the state was encoded in hue alone — the identical defect the mission
 * tick ladder was rewritten to solve three files away. The four swatches are
 * mutually 1.06–1.59:1, so to anyone not perceiving hue they are one grey and
 * the cell said nothing about the pillar's condition.
 *
 * So the cell now states the condition in words, in the signal INK cut (5.12–
 * 5.60:1 on this cell's paper-dim) at font-label 10px, and the mark carries one
 * hue-free split in ink weight. The full reasoning and every ratio it rests on
 * are in ./signal.tsx above `MARK`.
 *
 * An `unknown` pillar draws a page-coloured mark and an em-dash for its
 * condition, so a pillar with no data behind it is visibly and audibly absent
 * rather than quietly grey. The cell is grouped for assistive tech and speaks
 * as one phrase — "Sleep, caution" — because a name and a condition read apart
 * are two facts that have to be reassembled by the listener.
 */
export function ReadinessStrip({ readiness, pillars }: Props) {
  return (
    <Block device="field">
      <SectionLabel label="Readiness" />

      <View className="mt-2.5 flex-row items-center gap-2.5">
        <SignalTick level={readiness.level} />
        <Text className="flex-1 font-serif text-lg font-semibold text-ink">{readiness.label}</Text>
      </View>

      <View className="mt-3 flex-row gap-1.5">
        {pillars.map((pillar) => (
          <View
            key={pillar.label}
            accessible
            accessibilityRole="text"
            accessibilityLabel={`${pillar.label}, ${signalConditionSpoken(pillar.level)}`}
            className="flex-1 items-center gap-1 px-0.5 py-2">
            <View className={signalMarkClass(pillar.level)} />
            <Text className="font-label text-[10px] uppercase tracking-[0.5px] text-ink-secondary">
              {pillar.label}
            </Text>
            <Text
              className={`font-label text-[10px] font-semibold uppercase tracking-[0.5px] ${signalTextClass(
                pillar.level
              )}`}>
              {signalConditionLabel(pillar.level)}
            </Text>
          </View>
        ))}
      </View>

      <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
        {readiness.detail}
      </Text>
    </Block>
  );
}
