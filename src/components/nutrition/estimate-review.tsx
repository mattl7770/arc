import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { KeyMicroTail } from '@/components/nutrition/key-micro-tail';
import { UndoRow } from '@/components/nutrition/undo-row';
import { Block, Divider } from '@/components/ui/block';
import { KEYPAD_DONE } from '@/components/ui/keyboard';
import { SectionLabel } from '@/components/ui/section-label';
import { selectAllOnFocus } from '@/components/ui/select-on-focus';
import { palette } from '@/constants/theme';
import type { EstimateQuestion } from '@/lib/nutrition/estimate';
import { fmtAmount, fmtInt, pieceNounFor, piecesLabel, pluralNoun } from '@/lib/nutrition/format';
import { keyMicroLabel, partsAsItem } from '@/lib/nutrition/key-micro';
import {
  amountLabel,
  currentPortion,
  isComposite,
  type ReviewItem,
  type ReviewRow,
  reviewKcal,
  rolled,
} from '@/lib/nutrition/review-rows';
import type { UndoWords } from '@/lib/nutrition/undo-store';

/**
 * The estimator's editable review table — the DRAWING half. Its rows, its tree
 * and every edit it can make are pure and live in
 * src/lib/nutrition/review-rows.ts, which this file re-exports so a screen has
 * one import.
 *
 * ## One surface device (00-design-spec.md §1)
 *
 * The Items block stays the single `Block device="plate"` it has always been. A
 * composite is **not** a nested plate: a block gets exactly one device, and the
 * drawing set's answer to subordination inside a ruled table is INDENTATION.
 * So the parts are ruled rows inside the same plate at `pl-6`, with no fill, no
 * left rule and no new mark.
 *
 * ## Accent
 *
 * Nothing here takes the accent. In the review phase it belongs to Save and
 * stays there — the fraction chips are outlined, and an answered question chip
 * fills with ink, which is a state mark rather than a claim to being the next
 * action.
 */

export * from '@/lib/nutrition/review-rows';

// --- The plate ---------------------------------------------------------------

const MACRO_LINE = (p: {
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
}): string =>
  [
    p.protein_g != null ? `P ${Math.round(p.protein_g)}g` : '',
    p.carbs_g != null ? ` · C ${Math.round(p.carbs_g)}g` : '',
    p.fat_g != null ? ` · F ${Math.round(p.fat_g)}g` : '',
  ].join('');

/** The fractions a person actually says. Outlined, never accent: in the review
 *  phase the accent belongs to Save and stays there. */
const FRACTIONS: { label: string; factor: number; spoken: string }[] = [
  { label: '½', factor: 0.5, spoken: 'half' },
  { label: '⅓', factor: 1 / 3, spoken: 'a third' },
  { label: '¼', factor: 0.25, spoken: 'a quarter' },
];

function AmountField({
  row,
  onChange,
  onFocus,
  onBlur,
  value,
  label,
}: {
  row: ReviewRow;
  onChange: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  value: string;
  label: string;
}) {
  return (
    <View className="flex-row items-center gap-1">
      <TextInput
        value={value}
        onChangeText={onChange}
        onBlur={onBlur}
        keyboardType="decimal-pad"
        returnKeyType={KEYPAD_DONE}
        // The caller's focus handler goes THROUGH selectAllOnFocus, which owns
        // `onFocus`: writing both would drop one of them, and the one that
        // freezes the scaling baseline is the one that matters here.
        {...selectAllOnFocus(value, onFocus)}
        accessibilityLabel={`${label} ${row.unit === 'ml' ? 'millilitres' : 'grams'}`}
        className="w-14 border border-paper-deep bg-paper-dim px-2 py-1.5 text-right font-mono text-[13px] text-ink"
      />
      <Text className="font-mono text-[11px] text-ink-secondary">{row.unit}</Text>
    </View>
  );
}

/**
 * A composite's count, as ONE sentence: `ATE [3] OF [8] SLICES` (0059, re-cut
 * on the owner's device note of 2026-09-23 — the arithmetic is in
 * src/lib/nutrition/review-rows.ts, above `setCompositeCount`).
 *
 * **Two fields, and neither ever moves.** OF is how many pieces the dish as
 * priced is: while all of it is eaten, typing it declares and scales nothing.
 * ATE is how many of them were eaten: typing it scales every part by ate / of.
 * Each field answers ONE question, so no label has to switch to say which
 * question is being asked — the field this replaced was labelled `THIS IS`
 * until its first keystroke and `I ATE` after it, and moved up a row as it
 * switched, which remounted it and dropped the keyboard mid-number.
 *
 * Three shapes, one row:
 *
 * - **uncounted** — `ATE — OF [ ] PIECES`. ATE is an em-dash, not a field:
 *   there is nothing yet to take a share of. The dash holds the field's slot, so
 *   OF is in the same place in every shape — and keyed, so React keeps the field
 *   being typed into mounted while the dish becomes counted.
 * - **counted** — `ATE [3] OF [8] SLICES`.
 * - **a record's count** — `ATE [3] SLICES`: rows built from a logged meal
 *   carry what was eaten and no whole, and an `of [3]` there would invite
 *   typing the pizza's eight over three logged slices. Emptied and left, ATE
 *   un-counts such a dish, since it is the only field saying what the dish is.
 *   A counted PLAIN item always reads this shape — `ATE [2] EGGS`, beneath its
 *   own row (2026-09-25): its pieces are the portion, not a cut of a whole, so
 *   there is no OF to re-declare (src/lib/nutrition/review-rows.ts).
 *
 * Both fields are the parts' `AmountField` anatomy — a `w-14` mono field with the
 * same live, snapshot-from-focus, non-compounding semantics — because they are
 * the whole-dish grams field's siblings. The labels are the label voice. The
 * noun is a label-voice control that becomes a one-line field on tap (its word
 * selected, so typing replaces it) and commits as it is typed; it agrees in
 * number with the figure it follows — `of 1 slice`, `of 8 slices`, `ate 3
 * slices` — and with no count it is a muted readout, because a noun with no
 * count names nothing.
 */
function CountRow({ row, handlers }: { row: ReviewItem; handlers: ReviewHandlers }) {
  // The noun's field: what is typed, and the noun it opened on — restored if the
  // field is left empty, so a noun backspaced away letter by letter (each letter
  // committing as it goes) is not saved as the one letter left.
  const [nounDraft, setNounDraft] = useState<{ text: string; was: string } | null>(null);
  const counted = row.pieces != null;
  // A record's count has no whole: one number, what was eaten.
  const record = counted && row.wholeCount == null;
  const noun = row.pieces?.name ?? 'piece';
  const eaten = row.countText ?? (row.pieces ? amountLabel(row.pieces.count) : '');
  const whole = row.wholeText ?? (row.wholeCount != null ? amountLabel(row.wholeCount) : '');
  return (
    <View className="flex-row flex-wrap items-center gap-2 pb-3 pl-6">
      <Text
        key="ate"
        className="w-8 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        Ate
      </Text>
      {counted ? (
        <TextInput
          key="eaten"
          value={eaten}
          onChangeText={(text) => handlers.onCountChange(row.key, text)}
          onBlur={() => handlers.onCountEnd(row.key)}
          keyboardType="decimal-pad"
          returnKeyType={KEYPAD_DONE}
          // The focus handler goes THROUGH selectAllOnFocus, which owns
          // `onFocus` — the snapshot it takes is what keeps typing from compounding.
          {...selectAllOnFocus(eaten, () => handlers.onCountBegin(row.key))}
          accessibilityLabel={`${row.name}, pieces eaten`}
          className="w-14 border border-paper-deep bg-paper-dim px-2 py-1.5 text-right font-mono text-[13px] text-ink"
        />
      ) : (
        <View
          key="eaten-none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="w-14 items-end px-2">
          <Text className="font-mono text-[13px] text-ink-muted">—</Text>
        </View>
      )}
      {record ? null : (
        <Text key="of" className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
          of
        </Text>
      )}
      {record ? null : (
        <TextInput
          key="whole"
          value={whole}
          onChangeText={(text) => handlers.onWholeChange(row.key, text)}
          onBlur={() => handlers.onCountEnd(row.key)}
          keyboardType="decimal-pad"
          returnKeyType={KEYPAD_DONE}
          {...selectAllOnFocus(whole, () => handlers.onCountBegin(row.key))}
          accessibilityLabel={`Pieces in ${row.name}`}
          className="w-14 border border-paper-deep bg-paper-dim px-2 py-1.5 text-right font-mono text-[13px] text-ink"
        />
      )}
      {nounDraft !== null ? (
        <TextInput
          key="noun"
          value={nounDraft.text}
          // Live, like every other field on this sheet — so a Save tapped with
          // the keyboard still up keeps the name (an empty one is refused).
          onChangeText={(text) => {
            setNounDraft({ ...nounDraft, text });
            handlers.onPiecesName(row.key, text);
          }}
          autoFocus
          // A one-word name replaced wholesale, so its word arrives selected.
          // `autoFocus` goes through the imperative focus path, which is the one
          // place iOS honours this prop (src/components/ui/select-on-focus.ts).
          selectTextOnFocus
          returnKeyType={KEYPAD_DONE}
          autoCapitalize="none"
          accessibilityLabel={`Name one piece of ${row.name}`}
          onBlur={() => {
            handlers.onPiecesName(
              row.key,
              nounDraft.text.trim() === '' ? nounDraft.was : nounDraft.text
            );
            setNounDraft(null);
          }}
          className="w-24 border border-paper-deep bg-paper-dim px-2 py-1.5 font-mono text-[13px] text-ink"
        />
      ) : counted ? (
        <Pressable
          key="noun"
          accessibilityRole="button"
          accessibilityLabel={`Name one piece of ${row.name}`}
          onPress={() => setNounDraft({ text: noun, was: noun })}
          className="min-h-[44px] justify-center px-1 active:opacity-60">
          <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink">
            {pieceNounFor(record ? (row.pieces?.count ?? null) : row.wholeCount, noun)}
          </Text>
        </Pressable>
      ) : (
        <Text
          key="noun"
          className="font-label text-[12px] uppercase tracking-[1.2px] text-ink-muted">
          {pluralNoun(noun)}
        </Text>
      )}
    </View>
  );
}

function RemoveButton({ name, onPress }: { name: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Remove ${name}`}
      hitSlop={12}
      onPress={onPress}
      className="h-8 w-8 items-center justify-center rounded-btn active:opacity-60">
      <Ionicons name="close" size={16} color={palette.inkMuted} />
    </Pressable>
  );
}

export type ReviewHandlers = {
  onAmountChange: (key: string, text: string) => void;
  onRemove: (key: string) => void;
  onToggle: (key: string) => void;
  onScale: (key: string, factor: number) => void;
  onScaleTo: (key: string, text: string) => void;
  onScaleBegin: (key: string) => void;
  onScaleEnd: (key: string) => void;
  /** The count of pieces (0059) — the same begin/change/end shape as the
   *  whole-dish field, because it is the same mechanism. `onCountChange` is
   *  the ATE field (scales), `onWholeChange` the OF field (declares); both
   *  share one focus snapshot, so they share begin and end. */
  onCountChange: (key: string, text: string) => void;
  onWholeChange: (key: string, text: string) => void;
  onCountBegin: (key: string) => void;
  onCountEnd: (key: string) => void;
  onPiecesName: (key: string, name: string) => void;
};

/**
 * One priced row — a plain item, or a part indented inside its composite.
 *
 * `count` is a counted PLAIN item's count, `2 eggs` (2026-09-25). It leads the
 * sub-line, and the grams field KEEPS the amount column: a counted plain row has
 * no parts, so that field is the only handle left on its grams, and "the eggs
 * were bigger" is a correction as ordinary as "it was three eggs". The two
 * never fight: a grams edit keeps the count (`setRowAmount` moves the grams and
 * leaves `pieces` alone — bigger eggs, not more of them), and the count is
 * edited in ONE place, the `ATE [2] EGGS` sentence drawn beneath the row, which
 * scales the grams with it (more eggs).
 */
function PricedRow({
  row,
  first,
  indented,
  handlers,
  count = null,
}: {
  row: ReviewRow;
  first: boolean;
  indented: boolean;
  handlers: ReviewHandlers;
  count?: string | null;
}) {
  const p = currentPortion(row);
  const macros = MACRO_LINE(p);
  const subLine = [count ?? '', macros].filter(Boolean).join(' · ');
  return (
    <View>
      <Divider first={first} />
      <View className={indented ? 'py-3 pl-6' : 'py-3'}>
        <View className="min-h-[44px] flex-row items-center gap-3">
          <View className="flex-1">
            <Text className="font-serif text-[15px] leading-5 text-ink">
              {row.name}
              <Text className="font-mono text-[10px] text-ink-muted">
                {'  '}≈ {row.confidence}
                {row.foodId ? ' · matched' : ''}
              </Text>
            </Text>
          </View>
          <AmountField
            row={row}
            value={row.amountText}
            label={row.name}
            onChange={(t) => handlers.onAmountChange(row.key, t)}
          />
          <Text className="w-12 text-right font-mono text-[13px] text-ink-secondary">
            {p.kcal != null ? fmtInt(p.kcal) : '—'}
          </Text>
          <RemoveButton name={row.name} onPress={() => handlers.onRemove(row.key)} />
        </View>
        <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
          {subLine}
          {/* The one notable micro, at the live portion (2026-09-23). */}
          <KeyMicroTail label={keyMicroLabel(p)} lead={subLine !== ''} />
        </Text>
      </View>
    </View>
  );
}

/** A composite: a disclosure row, and — when open — its parts and the ways to
 *  say how much of it was eaten. All inside the SAME plate; a nested device is
 *  forbidden. */
function CompositeRow({
  row,
  first,
  handlers,
}: {
  row: ReviewItem;
  first: boolean;
  handlers: ReviewHandlers;
}) {
  const total = rolled(row);
  const parts = `${row.components.length} parts`;
  // Once a dish is counted its amount IS the count (owner, on the device,
  // 2026-09-23: "grams are still being used as the unit of measurement, when it
  // should've changed to slices"). The grams it replaces are not lost — they
  // lead the sub-line below instead, as the secondary figure they now are.
  const count = row.pieces ? piecesLabel(row.pieces.count, row.pieces.name) : null;
  // The dish's notable micro is its parts' sum, at their live portions — a
  // pizza's sodium, a composite latte's caffeine.
  const dishMicro = keyMicroLabel(partsAsItem(row.components.map((part) => currentPortion(part))));
  const subLine = [
    count && total.amount != null ? fmtAmount(total.amount, total.unit) : '',
    MACRO_LINE(total),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View>
      <Divider first={first} />
      <View className="py-3">
        <View className="min-h-[44px] flex-row items-center gap-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${row.name}, ${parts}${count ? `, ${count}` : ''}${
              total.kcal != null ? `, ${fmtInt(total.kcal)} kcal` : ''
            }`}
            accessibilityState={{ expanded: row.expanded }}
            hitSlop={8}
            onPress={() => handlers.onToggle(row.key)}
            className="min-h-[44px] flex-1 flex-row items-center gap-2 active:opacity-60">
            <Ionicons
              name={row.expanded ? 'chevron-down' : 'chevron-forward'}
              size={16}
              color={palette.inkSecondary}
            />
            <View className="flex-1">
              <Text className="font-serif text-[15px] leading-5 text-ink">
                {row.name}
                <Text className="font-mono text-[10px] text-ink-muted">
                  {'  '}
                  {parts}
                </Text>
              </Text>
            </View>
            {/* The counted dish's amount, in the column every other row's amount
                field stands in. A readout, not a second field: the count is
                edited in ONE place, the sentence below, and tapping here opens
                and closes it, as the rest of the header does. */}
            {count ? <Text className="font-mono text-[13px] text-ink">{count}</Text> : null}
          </Pressable>
          {/* The whole-dish handle of an UNCOUNTED dish, whose amount is still
              its grams. Absent when the parts do not all carry an amount (or do
              not share a unit) — there is no honest total to type into, and the
              fractions below still work. */}
          {count == null && total.amount != null ? (
            <AmountField
              row={{ ...row, unit: total.unit }}
              value={row.amountText === '' ? amountLabel(total.amount) : row.amountText}
              label={row.name}
              onChange={(t) => handlers.onScaleTo(row.key, t)}
              onFocus={() => handlers.onScaleBegin(row.key)}
              onBlur={() => handlers.onScaleEnd(row.key)}
            />
          ) : null}
          <Text className="w-12 text-right font-mono text-[13px] text-ink-secondary">
            {total.kcal != null ? fmtInt(total.kcal) : '—'}
          </Text>
          <RemoveButton name={row.name} onPress={() => handlers.onRemove(row.key)} />
        </View>
        {/* A counted dish's grams lead its sub-line — the secondary figure, and
            still the one that makes "is 90 g a slice?" checkable. Never
            converted for the oz preference, like every figure on this plate. */}
        <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
          {subLine}
          <KeyMicroTail label={dishMicro} lead={subLine !== ''} />
        </Text>
      </View>

      {row.expanded ? (
        <View>
          {row.components.map((part) => (
            <PricedRow key={part.key} row={part} first={false} indented handlers={handlers} />
          ))}
          {/* How much of it was eaten, as one sentence. FIRST, and in the same
              place whether or not the dish is counted, so nothing above the
              field being typed into ever moves. */}
          <CountRow row={row} handlers={handlers} />
          {/* "I ate half", for a dish with no count — the fast handle on a
              burrito, as the owner chose (C4). Outlined, ≥44pt, in the label
              voice: the accent in this phase belongs to Save and stays there.
              Drawn UNDER the dash they stand in for, and gone once the dish is
              counted: a count says any share exactly (½ of eight is `ate 4`),
              where a chip on a counted dish could only print `2.7 slices`. */}
          {row.pieces ? null : (
            <View className="flex-row items-center gap-2 pb-3 pl-16">
              {FRACTIONS.map((fraction) => (
                <Pressable
                  key={fraction.label}
                  accessibilityRole="button"
                  accessibilityLabel={`I ate ${fraction.spoken} of the ${row.name}`}
                  onPress={() => handlers.onScale(row.key, fraction.factor)}
                  className="min-h-[44px] min-w-[44px] items-center justify-center rounded-btn border border-hairline px-3 active:bg-paper-dim">
                  <Text className="font-label text-[13px] uppercase tracking-[1.2px] text-ink">
                    {fraction.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The review table. `emptyNote` is the screen's own sentence for a table the
 * user has emptied — the two screens say different things there, because
 * discarding an estimate and abandoning a revision are different acts.
 *
 * `undo` is the receipt for the row just removed with its × (2026-09-23,
 * src/lib/nutrition/review-undo.ts): the meal screen's Undo row, drawn again as
 * a ruled row at the foot of this same plate — where the removed row was, and
 * under the empty note when it was the last one. Nothing is saved yet, so
 * there is nothing it can fail to put back; it is simply not drawn once
 * putting the row back would no longer be exact.
 */
export function ReviewItemsPlate({
  rows,
  label,
  emptyNote,
  handlers,
  undo = null,
}: {
  rows: ReviewItem[];
  label: string;
  emptyNote: string;
  handlers: ReviewHandlers;
  undo?: { offer: UndoWords; onUndo: () => void } | null;
}) {
  const kcal = reviewKcal(rows);
  return (
    <Block device="plate">
      <SectionLabel label={label} note={kcal !== null ? `${fmtInt(kcal)} kcal` : undefined} />
      {rows.length === 0 ? (
        <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
          {emptyNote}
        </Text>
      ) : (
        <View className="mt-1">
          {rows.map((row, index) =>
            isComposite(row) ? (
              <CompositeRow key={row.key} row={row} first={index === 0} handlers={handlers} />
            ) : (
              // A counted plain item (2026-09-25) reads `2 eggs` at the head of
              // its sub-line, keeps its grams field, and takes the dish's own
              // sentence beneath it — `ATE [2] EGGS`, a record-shaped count with
              // no OF.
              <View key={row.key}>
                <PricedRow
                  row={row}
                  first={index === 0}
                  indented={false}
                  handlers={handlers}
                  count={row.pieces ? piecesLabel(row.pieces.count, row.pieces.name) : null}
                />
                {row.pieces ? <CountRow row={row} handlers={handlers} /> : null}
              </View>
            )
          )}
        </View>
      )}
      {undo ? <UndoRow offer={undo.offer} onUndo={undo.onUndo} /> : null}
    </Block>
  );
}

// --- The questions plate (backlog C5) ----------------------------------------

/**
 * What the screen holds per question: which option is chosen, or null for
 * unanswered / skipped.
 */
export type QuestionAnswers = Record<string, number | null>;

export type QuestionHandlers = {
  /** Choose option `index`, or `null` to un-answer (Skip / Undo). */
  onAnswer: (id: string, index: number | null) => void;
  /** Open the typed answer for this question — the ONE path that costs a
   *  second model call. */
  onOpenOther: (id: string) => void;
  onOtherText: (text: string) => void;
  onApplyOther: (id: string) => void;
  onCancelOther: () => void;
};

/**
 * The questions, above the item table.
 *
 * **Above, deliberately.** The rows ARE the answer — tapping a chip re-prices
 * them — and on a phone a control below the thing it changes makes the change
 * happen off-screen.
 *
 * **What it says back: nothing, in words.** Tapping a chip re-prices the plate
 * below, and the Items total moves with it because that total is already
 * derived from the live rows. The screen shows the consequence rather than
 * announcing it.
 *
 * **Skip is always available and Save is always live.** The estimate already
 * assumes the most likely answer, so an unanswered question costs accuracy, not
 * coherence.
 */
export function QuestionsPlate({
  questions,
  answers,
  otherFor,
  otherText,
  otherBusy,
  handlers,
}: {
  questions: EstimateQuestion[];
  answers: QuestionAnswers;
  /** The question whose typed answer is open, or null. */
  otherFor: string | null;
  otherText: string;
  /** True while the second, text-only call is in flight. */
  otherBusy: boolean;
  handlers: QuestionHandlers;
}) {
  if (questions.length === 0) return null;
  const answered = questions.filter((q) => answers[q.id] != null).length;
  return (
    <Block device="plate">
      {/* "Questions": a section label names what is filed under it (the slop
          list, §0 and §10). The tally is its note, in the house's own form. */}
      <SectionLabel label="Questions" note={`${answered} of ${questions.length}`} />
      <View className="mt-1">
        {questions.map((question, index) => {
          const chosen = answers[question.id] ?? null;
          const isOther = otherFor === question.id;
          return (
            <View key={question.id}>
              <Divider first={index === 0} />
              <View className="py-3">
                <View className="flex-row items-start gap-3">
                  {/* A question is a sentence, and serif speaks. */}
                  <Text className="flex-1 font-serif text-[15px] leading-6 text-ink">
                    {question.ask}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      chosen !== null
                        ? `Undo the answer to: ${question.ask}`
                        : `Skip: ${question.ask}`
                    }
                    hitSlop={12}
                    onPress={() => handlers.onAnswer(question.id, null)}
                    className="min-h-[28px] justify-center active:opacity-60">
                    <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink-muted">
                      {chosen !== null ? 'Undo' : 'Skip'}
                    </Text>
                  </Pressable>
                </View>
                <View className="mt-2 flex-row flex-wrap gap-2">
                  {question.options.map((option, optionIndex) => {
                    const on = chosen === optionIndex;
                    return (
                      <Pressable
                        key={option.label}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={`${question.ask} ${option.label}`}
                        onPress={() => handlers.onAnswer(question.id, on ? null : optionIndex)}
                        className={
                          on
                            ? 'min-h-[44px] items-center justify-center rounded-btn bg-ink px-4'
                            : 'min-h-[44px] items-center justify-center rounded-btn border border-hairline px-4 active:bg-paper-dim'
                        }>
                        <Text
                          className={
                            on
                              ? 'font-label text-[13px] uppercase tracking-[1.2px] text-paper-hi'
                              : 'font-label text-[13px] uppercase tracking-[1.2px] text-ink'
                          }>
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                  {question.allowOther ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Type another answer to: ${question.ask}`}
                      onPress={() => handlers.onOpenOther(question.id)}
                      className="min-h-[44px] items-center justify-center rounded-btn border border-hairline px-4 active:bg-paper-dim">
                      <Text className="font-label text-[13px] uppercase tracking-[1.2px] text-ink">
                        Other
                      </Text>
                    </Pressable>
                  ) : null}
                </View>

                {/* A capture surface is a well, and the input inside it is bare.
                    Reached by a CLICK, which is the owner's constraint: typing
                    is opt-in behind the Other chip and never the default. */}
                {isOther ? (
                  <View className="mt-3">
                    <Block device="well">
                      <TextInput
                        value={otherText}
                        onChangeText={handlers.onOtherText}
                        placeholder="e.g. it was a triple"
                        placeholderTextColor={palette.inkMuted}
                        editable={!otherBusy}
                        accessibilityLabel={`Your answer to: ${question.ask}`}
                        className="min-h-[36px] font-serif text-[15px] leading-6 text-ink"
                      />
                    </Block>
                    <View className="mt-2 flex-row gap-2">
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Apply this answer"
                        accessibilityState={{ disabled: otherBusy || otherText.trim() === '' }}
                        disabled={otherBusy || otherText.trim() === ''}
                        onPress={() => handlers.onApplyOther(question.id)}
                        className={
                          otherBusy || otherText.trim() === ''
                            ? 'min-h-[44px] flex-1 items-center justify-center rounded-btn border border-paper-deep'
                            : 'min-h-[44px] flex-1 items-center justify-center rounded-btn border border-ink active:opacity-60'
                        }>
                        <Text
                          className={
                            otherBusy || otherText.trim() === ''
                              ? 'font-label text-[13px] uppercase tracking-[1.2px] text-ink-muted'
                              : 'font-label text-[13px] uppercase tracking-[1.2px] text-ink'
                          }>
                          {otherBusy ? 'Working…' : 'Apply'}
                        </Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Cancel this typed answer"
                        onPress={handlers.onCancelOther}
                        className="min-h-[44px] items-center justify-center px-3 active:opacity-60">
                        <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink-muted">
                          Cancel
                        </Text>
                      </Pressable>
                    </View>
                    {/* The one place a second model call happens, said out loud
                        — and what it does NOT do, because a resent photo would
                        be billed in full every time. */}
                    <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
                      Applying asks the model again, in words only — the photo is not sent a second
                      time.
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    </Block>
  );
}
