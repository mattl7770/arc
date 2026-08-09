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
 * Conformed Set treatment — this is the **measured field** device: no box at
 * all, only 11px corner ticks bracketing the block. A verdict is a reading
 * taken off the sheet, not a card, and the ticks are what say "this region was
 * measured". See src/components/ui/block.tsx.
 *
 * The pillars are boxed cells rather than a segment bar: a swatch reads as a
 * *sample* of a state, which is what a pillar is. Every colour here is a signal
 * colour and every signal colour here is biology — the accent is not permitted
 * anywhere in this block.
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
            className="flex-1 items-center gap-1 border border-hairline bg-paper-dim px-0.5 py-2">
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
