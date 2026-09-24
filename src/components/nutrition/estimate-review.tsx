import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { KEYPAD_DONE } from '@/components/ui/keyboard';
import { SectionLabel } from '@/components/ui/section-label';
import { selectAllOnFocus } from '@/components/ui/select-on-focus';
import { palette } from '@/constants/theme';
import type { EstimateQuestion } from '@/lib/nutrition/estimate';
import { countLabel, fmtInt } from '@/lib/nutrition/format';
import {
  amountLabel,
  currentPortion,
  isComposite,
  type ReviewItem,
  type ReviewRow,
  reviewKcal,
  rolled,
} from '@/lib/nutrition/review-rows';

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
 * The count of pieces, and the noun for one of them (0059).
 *
 * The same anatomy as {@link AmountField} — a `w-14` mono field with the same
 * live, snapshot-from-focus semantics — because it IS the whole-dish grams
 * field's sibling: one scaling mechanism, two ways to say the same size. A
 * field rather than the catalog stepper because 8 → 3 is one keypad entry and
 * ten taps at the stepper's 0.5 step.
 *
 * **What the empty field asks depends on whether there is a count**, and the
 * label beside it says which: `THIS IS` declares what the parts already are and
 * moves nothing; `I ATE` scales them. The noun is a label-voice control that
 * swaps to a one-line field on tap and commits on blur; with no count it is a
 * muted readout, because a noun with no count names nothing.
 */
function CountField({ row, handlers }: { row: ReviewItem; handlers: ReviewHandlers }) {
  const [nounDraft, setNounDraft] = useState<string | null>(null);
  const counted = row.pieces != null;
  const noun = row.pieces?.name ?? 'piece';
  const value =
    row.countText === '' ? (row.pieces ? amountLabel(row.pieces.count) : '') : row.countText;
  return (
    <View className="flex-row items-center gap-1">
      <TextInput
        value={value}
        onChangeText={(text) => handlers.onCountChange(row.key, text)}
        onBlur={() => handlers.onCountEnd(row.key)}
        keyboardType="decimal-pad"
        returnKeyType={KEYPAD_DONE}
        {...selectAllOnFocus(value, () => handlers.onCountBegin(row.key))}
        accessibilityLabel={counted ? `${row.name}, pieces eaten` : `Pieces in ${row.name}`}
        className="w-14 border border-paper-deep bg-paper-dim px-2 py-1.5 text-right font-mono text-[13px] text-ink"
      />
      <Text className="font-mono text-[11px] text-ink-secondary">×</Text>
      {nounDraft !== null ? (
        <TextInput
          value={nounDraft}
          onChangeText={setNounDraft}
          autoFocus
          returnKeyType={KEYPAD_DONE}
          autoCapitalize="none"
          accessibilityLabel={`Name one piece of ${row.name}`}
          onBlur={() => {
            handlers.onPiecesName(row.key, nounDraft);
            setNounDraft(null);
          }}
          className="w-20 border border-paper-deep bg-paper-dim px-2 py-1.5 font-mono text-[13px] text-ink"
        />
      ) : counted ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Name one piece of ${row.name}`}
          onPress={() => setNounDraft(noun)}
          className="min-h-[44px] justify-center px-1 active:opacity-60">
          <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink">{noun}</Text>
        </Pressable>
      ) : (
        <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink-muted">
          {noun}
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
  /** The count of pieces (0059) — the same three-handler shape as the
   *  whole-dish field, because it is the same mechanism. */
  onCountChange: (key: string, text: string) => void;
  onCountBegin: (key: string) => void;
  onCountEnd: (key: string) => void;
  onPiecesName: (key: string, name: string) => void;
};

/** One priced row — a plain item, or a part indented inside its composite. */
function PricedRow({
  row,
  first,
  indented,
  handlers,
}: {
  row: ReviewRow;
  first: boolean;
  indented: boolean;
  handlers: ReviewHandlers;
}) {
  const p = currentPortion(row);
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
        <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">{MACRO_LINE(p)}</Text>
      </View>
    </View>
  );
}

/** A composite: a disclosure row, and — when open — its parts and the two ways
 *  to say "I ate half". All inside the SAME plate; a nested device is forbidden. */
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
  return (
    <View>
      <Divider first={first} />
      <View className="py-3">
        <View className="min-h-[44px] flex-row items-center gap-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${row.name}, ${parts}${
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
          </Pressable>
          {/* The whole-dish handle. Absent when the parts do not all carry an
              amount (or do not share a unit) — there is no honest total to
              type into, and the fractions below still work. */}
          {total.amount != null ? (
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
        {/* The count leads the sub-line when there is one (0059) — it is the
            coarsest true thing about the dish, and after a ⅓ chip it reads the
            honest `2.7 × slice` rather than a 3 the parts do not add up to. */}
        <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
          {[row.pieces ? countLabel(row.pieces.count, row.pieces.name) : '', MACRO_LINE(total)]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>

      {row.expanded ? (
        <View>
          {row.components.map((part) => (
            <PricedRow key={part.key} row={part} first={false} indented handlers={handlers} />
          ))}
          {/* "I ate half", as the sentence people actually say. Outlined chips,
              ≥44pt, in the label voice — the accent in this phase belongs to
              Save and stays there. The count sits BESIDE them (owner decision):
              a chip is the fast handle, a count the precise one, the same
              pairing the whole-dish field already has. */}
          <View
            className={
              row.pieces
                ? 'flex-row items-center gap-2 pb-3 pl-6'
                : 'flex-row items-center gap-2 pl-6'
            }>
            <Text className="font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
              I ate
            </Text>
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
            {row.pieces ? <CountField row={row} handlers={handlers} /> : null}
          </View>
          {/* Uncounted: the field asks what the dish IS, on its own row, and
              typing into it scales nothing. */}
          {row.pieces ? null : (
            <View className="flex-row items-center gap-2 pb-3 pl-6">
              <Text className="font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
                This is
              </Text>
              <CountField row={row} handlers={handlers} />
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
 */
export function ReviewItemsPlate({
  rows,
  label,
  emptyNote,
  handlers,
}: {
  rows: ReviewItem[];
  label: string;
  emptyNote: string;
  handlers: ReviewHandlers;
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
              <PricedRow
                key={row.key}
                row={row}
                first={index === 0}
                indented={false}
                handlers={handlers}
              />
            )
          )}
        </View>
      )}
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
