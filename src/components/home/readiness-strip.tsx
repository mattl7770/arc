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
 * ## The pillar cells got their boxes back (2026-08-10, later the same day)
 *
 * They are four `border-hairline bg-paper-dim` cells again — `.cf-pillar` on the
 * sheet, and what this file drew until earlier that day. The argument for taking
 * them off was that four equal boxes abreast is a grid, and **a grid draws no
 * rules**. That argument does not survive contact with the spec it cites:
 * 00-design-spec.md §1 cuts the marks from the *field, margin and grid DEVICES*,
 * and a pillar cell is none of the three — it is content sitting inside a field,
 * the same way a mission row is content sitting inside a plate. The rule was
 * invented for the occasion.
 *
 * It was also removed in the same sweep whose governing rule the owner rejected
 * outright that day — *"All the wrong boxes were removed, bring them back!"*
 * (decisions.md 2026-08-10 §1a, WITHDRAWN). The pillar cells are not named in
 * that ADR's restore list, which is why they stayed off; they were a missed
 * restoration, not a decision.
 *
 * The contrast argument was never a reason either way: the signal ink cut
 * measures 5.12–5.60:1 on paper-dim and 5.91–6.46:1 on the bare sheet — the ink
 * clears 4.5:1 comfortably on both, so nothing here got harder to read when the
 * fill came off, and nothing gets harder now it is back.
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

      {/* Tick, then the caption, then the word — the sheet's order: `.cf-verdict`
          draws its swatch in a `::before`, so the mark leads and the caption
          names what the word after it IS. Without the caption the verdict reads
          as a heading for the block rather than as its finding, which is what
          "Guarded" sitting alone on a line looked like. */}
      <View className="mt-2.5 flex-row items-center gap-2">
        <SignalTick level={readiness.level} />
        <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
          Verdict
        </Text>
        <Text className="flex-1 font-serif text-lg font-semibold italic text-ink">
          {readiness.label}
        </Text>
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
