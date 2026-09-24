import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import {
  beginCompositeScale,
  beginCountEdit,
  endCompositeScale,
  endCountEdit,
  removeRow,
  reviewKcal,
  type ReviewHandlers,
  type ReviewItem,
  QuestionsPlate,
  ReviewItemsPlate,
  rowsFromEstimate,
  rowsToMealItems,
  scaleComposite,
  scaleCompositeTo,
  setCompositeCount,
  setCompositeWhole,
  setPiecesName,
  setRowAmount,
  toggleExpanded,
} from '@/components/nutrition/estimate-review';
import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useUnitPreferences } from '@/hooks/use-unit-preferences';
import { getDb } from '@/lib/db/client';
import { getMeal, listMealItems, replaceMealItems } from '@/lib/db/repositories/nutrition';
import { assembleMealItems, type MealItemNode } from '@/lib/nutrition/composite';
import { queueMealRevision } from '@/lib/db/repositories/pending-estimates';
import {
  groundMealEstimate,
  isMealEstimationAvailable,
  type MealEstimate,
  loggedToRevisionItems,
  MealEstimationUnavailableError,
  reviseMeal,
} from '@/lib/nutrition/estimate';
import { isQueueableFailure } from '@/lib/nutrition/estimate-queue';
import { useEstimateQuestions } from '@/hooks/use-estimate-questions';
import { fmtAmount, fmtInt, piecesLabel } from '@/lib/nutrition/format';
import type { MealItemWithServing, NewMealItem } from '@/lib/nutrition/types';
import type { VolumeUnit } from '@/lib/user/types';

/**
 * Correcting a logged meal in plain English (owner, 2026-08-12): *"I should be
 * able to use plain-text input to have AI edit a meal. I.e. 'Actually, that was
 * cooked in olive oil not butter' and it then makes those changes."*
 *
 * ## Why a screen and not an inline field
 *
 * A revision REPLACES a record that already exists — the meal is in the day's
 * totals, in the Coach's snapshot, in the week's history. That makes it a
 * pending write in the strict sense of 00-design-spec.md §5, and a pending write
 * gets a proposal, a stated consequence, and a confirm. Inline on the meal
 * screen it would have had to draw the old numbers and the new ones at once,
 * which is the one thing §5 forbids: never draw a decision and its outcome
 * simultaneously.
 *
 * ## The pipeline is the estimator's, deliberately
 *
 * `reviseMeal` hands the model the meal as it stands plus the correction and
 * asks for THE WHOLE revised item list in the estimator's own JSON shape — so
 * `parseMealEstimate` validates it, `groundMealEstimate` re-prices it against
 * the catalog, and the review below is the same editable table with the same
 * guarantees as app/meal-estimate.tsx. One schema, one parser, one review.
 *
 * A full list rather than a patch is also what makes the model's restraint
 * CHECKABLE: the rows that should not have moved are on screen next to the ones
 * that did, and the user reads them before anything is written.
 *
 * ## Three honesty rules this screen holds
 *
 * - **Nothing is written until Save**, and Save replaces items only —
 *   `replaceMealItems` never touches the meal's date, time, name, notes or
 *   source (src/lib/db/repositories/nutrition.ts).
 * - **The ledger sums to its own total.** The Items label carries the total of
 *   the rows visible beneath it, recomputed from each row's live amount.
 * - **No data, no number.** A row the model could not price shows an em-dash,
 *   never a stand-in zero.
 *
 * ## Conformed Set surface system
 *
 *   Correction   → **recessed well**: a capture surface is stock you write on,
 *                  so the well IS the field and the `TextInput` inside it is
 *                  bare (form (a), src/components/ui/block.tsx).
 *   Current/new  → **ruled plate**: both are records, and a record is a table.
 *   Prose        → **margin annotation** (the model's note, the error reason).
 *
 * **Accent budget: one per phase.** Apply (input), Save changes (review). The
 * phases are exclusive.
 */


type Phase =
  | { kind: 'input' }
  | { kind: 'working' }
  | { kind: 'review'; notes: string | null }
  /** The correction never reached the model, so it was kept (0057, backlog C3).
   *  The meal keeps the items it has until the drain lands. */
  | { kind: 'queued' }
  | { kind: 'error'; message: string };

export default function MealReviseScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const mealId = typeof id === 'string' ? id : '';

  // Read once in the initializer (op-sqlite is synchronous). The meal cannot
  // change underneath this screen in a single-user app, and re-reading on focus
  // would silently swap the "before" out from under an open proposal.
  const [meal] = useState(() => getMeal(getDb(), mealId));
  const [before] = useState<MealItemWithServing[]>(() => listMealItems(getDb(), mealId));
  // The same rows as the one-level tree (0058) — what "As logged" draws and
  // what the model is shown.
  const beforeTree = assembleMealItems(before);
  // Display-only: whether a millilitre portion READS as ml or oz.
  const { units } = useUnitPreferences();

  const available = isMealEstimationAvailable();
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  const [instruction, setInstruction] = useState('');
  const [rows, setRows] = useState<ReviewItem[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  // A revision may ask too (owner decision, C5): a correction can be as
  // ambiguous as a first description, and it is the same one-call shape.
  const asking = useEstimateQuestions({
    rows,
    setRows,
    mealName: () => meal?.name ?? 'Meal',
    onError: (message) => setPhase({ kind: 'error', message }),
    countIsEaten: true,
  });

  /** Turn a grounded revision into editable review rows — the estimator's own
   *  builder, so the two screens cannot drift apart in how they price or nest
   *  (src/components/nutrition/estimate-review.tsx). */
  const toReview = (estimate: MealEstimate) => {
    // The count on a logged meal is what was EATEN, and the model was told to
    // keep it — so the rows carry no whole, and read `ATE [3] SLICES` exactly
    // as the meal screen does. An `of [3]` here would invite typing the
    // pizza's eight over three logged slices.
    setRows(rowsFromEstimate(getDb(), estimate, { countIsEaten: true }));
    asking.begin(estimate.questions);
    setPhase({ kind: 'review', notes: estimate.notes });
  };

  const run = async () => {
    if (!meal) return;
    const text = instruction.trim();
    if (text === '') return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: 'working' });
    try {
      const revised = await reviseMeal(
        // The meal AS A TREE (0058): a composite goes to the model as one dish
        // with its parts indented beneath it, so "that pizza had no pepperoni"
        // is a correction to a part it can see, and "leave everything else
        // byte-identical" can mean something for the other two. The same
        // builder as the offline drain's, fiber included (2026-09-23).
        { name: meal.name, items: loggedToRevisionItems(beforeTree) },
        text,
        controller.signal
      );
      toReview(groundMealEstimate(getDb(), revised));
    } catch (error) {
      // A cancel is not a failure and gets no message — the screen is gone.
      if (controller.signal.aborted) return;
      // OFFLINE: keep the correction rather than making the user remember it
      // (0057, backlog C3). The meal is untouched meanwhile — its current items
      // are still correct and still countable — and the drain sends this
      // sentence against the items AS THEY STAND THEN, so a hand-edit made in
      // between is what the correction applies to.
      if (isQueueableFailure(error)) {
        try {
          queueMealRevision(getDb(), mealId, text);
          return setPhase({ kind: 'queued' });
        } catch (queueError) {
          console.warn('[meal-revise] could not queue the correction', queueError);
        }
      }
      setPhase({
        kind: 'error',
        message:
          error instanceof MealEstimationUnavailableError
            ? error.message
            : 'Couldn’t revise that meal. Check your connection and try again, or edit the items by hand.',
      });
    }
  };

  /** Every edit the review table can make — the shared plate's whole contract. */
  const handlers: ReviewHandlers = {
    onAmountChange: (key, text) => setRows((prev) => setRowAmount(prev, key, text)),
    onRemove: (key) => setRows((prev) => removeRow(prev, key)),
    onToggle: (key) => setRows((prev) => toggleExpanded(prev, key)),
    onScale: (key, factor) => setRows((prev) => scaleComposite(prev, key, factor)),
    onScaleTo: (key, text) => setRows((prev) => scaleCompositeTo(prev, key, text)),
    onScaleBegin: (key) => setRows((prev) => beginCompositeScale(prev, key)),
    onScaleEnd: (key) => setRows((prev) => endCompositeScale(prev, key)),
    onCountChange: (key, text) => setRows((prev) => setCompositeCount(prev, key, text)),
    onWholeChange: (key, text) => setRows((prev) => setCompositeWhole(prev, key, text)),
    onCountBegin: (key) => setRows((prev) => beginCountEdit(prev, key)),
    onCountEnd: (key) => setRows((prev) => endCountEdit(prev, key)),
    onPiecesName: (key, name) => setRows((prev) => setPiecesName(prev, key, name)),
  };

  const save = () => {
    if (rows.length === 0) return;
    const items: NewMealItem[] = rowsToMealItems(rows);
    try {
      replaceMealItems(getDb(), mealId, items);
      router.back();
    } catch (error) {
      console.warn('[meal-revise] save failed', error);
      setPhase({ kind: 'error', message: 'Couldn’t save the revision. Try again.' });
    }
  };

  if (!meal) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Adjust" />
        </View>
        <Text className="mt-6 font-serif text-[14px] leading-6 text-ink-secondary">
          This meal is gone — it may have been deleted.
        </Text>
      </Screen>
    );
  }

  if (!available) {
    return (
      <Screen scroll>
        <View className="pt-2">
          <StackHeader title="Adjust" />
        </View>
        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[15px] leading-6 text-ink-secondary">
              Adjusting a meal in words needs a model key — the same one the Coach uses.
            </Text>
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-muted">
              Add one in Settings › Coach, then come back. Editing items by hand works offline.
            </Text>
          </Block>
        </View>
      </Screen>
    );
  }

  // The total of the rows actually on screen, at their live amount — a ledger
  // sums to its own total, so this moves with every edit and removal, and a
  // composite contributes its parts rather than a stored headline.
  const reviewTotal = reviewKcal(rows);
  const beforeKcal = meal.kcal;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Adjust" parent="Meal" />
      </View>

      <Text className="mt-2 font-serif text-[15px] leading-6 text-ink">{meal.name}</Text>
      <Text className="font-mono text-[11px] text-ink-muted">
        {meal.date} · {meal.time ?? '—'}
        {beforeKcal !== null ? ` · ${fmtInt(beforeKcal)} kcal` : ''}
      </Text>

      {phase.kind === 'input' || phase.kind === 'working' ? (
        <>
          {/* AS LOGGED — the "before" the correction is about. Drawn first, so
              the user is describing a change to something they can see. */}
          <View className="mt-6">
            {/* The tally counts what the plate DRAWS — one row per pizza, not
                one per part (the same question `mealItemCounts` answers). */}
            <SectionLabel label="As logged" note={String(beforeTree.length)} />
            {before.length === 0 ? (
              <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
                This meal has no items — its totals were typed in directly. A correction here can
                still itemize it.
              </Text>
            ) : (
              <View className="mt-2">
                <AsLoggedPlate tree={beforeTree} volume={units.volume} />
              </View>
            )}
          </View>

          {/* THE CORRECTION — a capture surface, so a well with a bare input. */}
          <View className="mt-6">
            <Block device="well">
              <SectionLabel label="What was different" />
              <TextInput
                value={instruction}
                onChangeText={setInstruction}
                placeholder="e.g. that was cooked in olive oil, not butter"
                placeholderTextColor={palette.inkMuted}
                multiline
                editable={phase.kind === 'input'}
                accessibilityLabel="Describe what was different"
                className="mt-2 min-h-[72px] font-serif text-[15px] leading-6 text-ink"
              />
            </Block>
          </View>

          {phase.kind === 'working' ? (
            <View className="mt-8 items-center">
              <ActivityIndicator color={palette.ink} />
              <Text className="mt-3 font-serif text-[14px] text-ink-secondary">
                Working out the change…
              </Text>
            </View>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Apply this correction"
                accessibilityState={{ disabled: instruction.trim() === '' }}
                disabled={instruction.trim() === ''}
                onPress={() => void run()}
                className={
                  instruction.trim() === ''
                    ? 'mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-paper-deep py-3'
                    : 'mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3 active:opacity-70'
                }>
                <Ionicons
                  name="sparkles-outline"
                  size={18}
                  color={instruction.trim() === '' ? palette.inkMuted : palette.pineOn}
                />
                <Text
                  className={
                    instruction.trim() === ''
                      ? 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
                      : 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on'
                  }>
                  Apply
                </Text>
              </Pressable>

              <View className="mt-4">
                <Block device="margin">
                  <Text className="font-serif text-[13px] leading-5 text-ink-muted">
                    The meal’s time, name and notes are never changed here.
                  </Text>
                </Block>
              </View>
            </>
          )}
        </>
      ) : null}

      {/* QUEUED — what happened, then what will happen. Not an error: the
          sentence was recorded, the meal is intact, and the numbers are owed. */}
      {phase.kind === 'queued' ? (
        <View className="mt-6">
          <Block device="margin">
            <Text className="font-serif text-[15px] leading-6 text-ink">
              No connection, so the correction is waiting.
            </Text>
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
              The meal still holds the {before.length} item{before.length === 1 ? '' : 's'} it had.
              ARC applies your correction the next time you open the app with a connection — against
              the items as they stand then, so anything you change in the meantime is kept.
            </Text>
          </Block>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done"
            onPress={() => router.back()}
            className="mt-4 min-h-[44px] items-center justify-center rounded-btn border border-ink py-3 active:opacity-60">
            <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
              Done
            </Text>
          </Pressable>
        </View>
      ) : null}

      {phase.kind === 'error' ? (
        <View className="mt-6">
          <Block device="margin">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              {phase.message}
            </Text>
          </Block>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            onPress={() => setPhase({ kind: 'input' })}
            className="mt-4 min-h-[44px] items-center justify-center rounded-btn border border-ink py-3 active:opacity-60">
            <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
              Try again
            </Text>
          </Pressable>
        </View>
      ) : null}

      {phase.kind === 'review' ? (
        <View className="mt-6">
          {phase.notes ? (
            <View className="mb-4">
              <Block device="margin">
                <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
                  {phase.notes}
                </Text>
              </Block>
            </View>
          ) : null}

          {/* Above the table, for the reason it is above the table on the
              estimator: the rows are the answer. */}
          {asking.questions.length > 0 ? (
            <View className="mb-4">
              <QuestionsPlate
                questions={asking.questions}
                answers={asking.answers}
                otherFor={asking.otherFor}
                otherText={asking.otherText}
                otherBusy={asking.otherBusy}
                handlers={asking.handlers}
              />
            </View>
          ) : null}

          <ReviewItemsPlate
            rows={rows}
            label="Revised"
            emptyNote="No items left. Go back and try a different correction — a meal cannot be saved empty."
            handlers={handlers}
          />

          {/* The decision, in future tense, immediately above the control that
              makes it — and nothing after it but its other branch. */}
          <Text className="mt-5 font-serif text-[13px] leading-5 text-ink-muted">
            On save: these {rows.length} item{rows.length === 1 ? '' : 's'} replace what the meal
            holds now
            {beforeKcal !== null && reviewTotal !== null
              ? `, moving it from ${fmtInt(beforeKcal)} to ${fmtInt(reviewTotal)} kcal`
              : ''}
            . Its date, time and name are untouched. Going back writes nothing.
          </Text>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save these changes"
            accessibilityState={{ disabled: rows.length === 0 }}
            disabled={rows.length === 0}
            onPress={save}
            className={
              rows.length === 0
                ? 'mt-3 min-h-[44px] items-center justify-center rounded-btn border border-paper-deep py-3'
                : 'mt-3 min-h-[44px] items-center justify-center rounded-btn bg-pine py-3 active:opacity-70'
            }>
            <Text
              className={
                rows.length === 0
                  ? 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
                  : 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on'
              }>
              Save changes
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Discard this revision"
            onPress={() => setPhase({ kind: 'input' })}
            className="mt-2 min-h-[44px] items-center justify-center active:opacity-60">
            <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink-muted">
              Discard
            </Text>
          </Pressable>
        </View>
      ) : null}
    </Screen>
  );
}

/**
 * AS LOGGED — the meal as it stands, the "before" a correction is about.
 *
 * Read-only, and a composite is drawn OPEN: this plate is context for a
 * sentence the user is about to write, and hiding the pepperoni would hide the
 * very row he means to correct.
 *
 * **A counted dish reads in its pieces** (0059; the owner, on the device,
 * 2026-09-23: *"grams are still being used as the unit of measurement, when it
 * should've changed to slices"*). This plate printed a composite's summed grams
 * straight off `fmtAmount` and never asked whether the dish had a count, so a
 * three-slice pizza read `270 g` here while the meal screen said `3 slices`. It
 * now prints the count, through the one formatter every surface uses; the
 * grams are still on the plate, on the parts drawn beneath it.
 *
 * Exported for db/screens-render.test.mjs, and only for that: the screen draws
 * it only once a model key is set, and rendering it on its own lets the suite
 * pin it without one. Expo Router reads a route module's DEFAULT export; a named
 * one beside it is inert.
 */
export function AsLoggedPlate({ tree, volume }: { tree: MealItemNode[]; volume: VolumeUnit }) {
  return (
    <Block device="plate">
      {tree.map((node, index) => {
        // A composite's numbers are its parts'.
        const shown =
          node.kind === 'composite'
            ? {
                amount: node.rolled.amount,
                unit: node.rolled.unit,
                kcal: node.rolled.kcal,
              }
            : { amount: node.item.amount, unit: node.item.unit, kcal: node.item.kcal };
        const parts = node.kind === 'composite' ? node.components : [];
        const amount =
          node.kind === 'composite' && node.item.serving_qty != null && node.item.piece_name != null
            ? piecesLabel(node.item.serving_qty, node.item.piece_name)
            : shown.amount !== null
              ? fmtAmount(Math.round(shown.amount), shown.unit, volume)
              : null;
        return (
          <View key={node.item.id}>
            <Divider first={index === 0} />
            <View className="min-h-[44px] flex-row items-center gap-3 py-2.5">
              <Text className="flex-1 font-serif text-[15px] leading-5 text-ink">
                {node.item.name}
                {parts.length > 0 ? (
                  <Text className="font-mono text-[10px] text-ink-muted">
                    {'  '}
                    {parts.length} parts
                  </Text>
                ) : null}
              </Text>
              {amount !== null ? (
                <Text className="font-mono text-[11px] text-ink-muted">{amount}</Text>
              ) : null}
              <Text className="w-12 text-right font-mono text-[13px] text-ink-secondary">
                {shown.kcal !== null ? fmtInt(shown.kcal) : '—'}
              </Text>
            </View>
            {parts.map((part) => (
              <View key={part.id} className="min-h-[36px] flex-row items-center gap-3 pb-2.5 pl-6">
                <Text className="flex-1 font-serif text-[14px] leading-5 text-ink-secondary">
                  {part.name}
                </Text>
                {part.amount !== null ? (
                  <Text className="font-mono text-[11px] text-ink-muted">
                    {fmtAmount(Math.round(part.amount), part.unit, volume)}
                  </Text>
                ) : null}
                <Text className="w-12 text-right font-mono text-[12px] text-ink-muted">
                  {part.kcal !== null ? fmtInt(part.kcal) : '—'}
                </Text>
              </View>
            ))}
          </View>
        );
      })}
    </Block>
  );
}
