import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { KEYPAD_DONE } from '@/components/ui/keyboard';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { getFood } from '@/lib/db/repositories/foods';
import { getMeal, listMealItems, replaceMealItems } from '@/lib/db/repositories/nutrition';
import {
  groundMealEstimate,
  isMealEstimationAvailable,
  type MealEstimate,
  MealEstimationUnavailableError,
  reviseMeal,
} from '@/lib/nutrition/estimate';
import { fmtInt } from '@/lib/nutrition/format';
import { itemForPortion, rescaleLoggedItem } from '@/lib/nutrition/servings';
import type { FoodRow, MealItemWithServing, NewMealItem } from '@/lib/nutrition/types';

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
 *   the rows visible beneath it, recomputed from each row's live grams.
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
  | { kind: 'error'; message: string };

/** One editable review row — the estimator's shape, so the two screens agree. */
type ReviewItem = {
  key: string;
  name: string;
  foodId: string | null;
  food: FoodRow | undefined;
  confidence: 'high' | 'medium' | 'low';
  base: {
    grams: number | null;
    kcal: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
    micros: string | null;
  };
  gramsText: string;
};

function parseGrams(text: string): number | null {
  const g = Number(text.trim());
  return Number.isFinite(g) && g > 0 && g <= 5000 ? g : null;
}

/** Current macros/micros for a review row at its edited grams — via the same
 *  tested rescale used everywhere; falls back to the base when it can't scale. */
function currentPortion(row: ReviewItem) {
  const grams = parseGrams(row.gramsText);
  if (grams != null) {
    const scaled = rescaleLoggedItem(row.base, row.food, { grams });
    if (scaled) return scaled;
  }
  return {
    grams: row.base.grams,
    serving_qty: null,
    kcal: row.base.kcal,
    protein_g: row.base.protein_g,
    carbs_g: row.base.carbs_g,
    fat_g: row.base.fat_g,
    fiber_g: row.base.fiber_g,
    micros: row.base.micros,
  };
}

export default function MealReviseScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const mealId = typeof id === 'string' ? id : '';

  // Read once in the initializer (op-sqlite is synchronous). The meal cannot
  // change underneath this screen in a single-user app, and re-reading on focus
  // would silently swap the "before" out from under an open proposal.
  const [meal] = useState(() => getMeal(getDb(), mealId));
  const [before] = useState<MealItemWithServing[]>(() => listMealItems(getDb(), mealId));

  const available = isMealEstimationAvailable();
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  const [instruction, setInstruction] = useState('');
  const [rows, setRows] = useState<ReviewItem[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  /** Turn a grounded revision into editable review rows (the estimator's own
   *  toReview, so the two screens cannot drift apart in how they price). */
  const toReview = (estimate: MealEstimate) => {
    const db = getDb();
    setRows(
      estimate.items.map((item, i) => {
        const food = item.foodId ? getFood(db, item.foodId) : undefined;
        const grounded =
          food && item.grams != null && item.grams > 0
            ? itemForPortion(food, { grams: item.grams })
            : null;
        return {
          key: `${i}-${item.name}`,
          name: item.name,
          foodId: item.foodId,
          food,
          confidence: item.confidence,
          base: {
            grams: item.grams,
            kcal: grounded?.kcal ?? item.kcal,
            protein_g: grounded?.protein_g ?? item.protein_g,
            carbs_g: grounded?.carbs_g ?? item.carbs_g,
            fat_g: grounded?.fat_g ?? item.fat_g,
            fiber_g: grounded?.fiber_g ?? item.fiber_g,
            micros: grounded?.micros ?? null,
          },
          gramsText: item.grams != null ? String(Math.round(item.grams)) : '',
        };
      })
    );
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
        {
          name: meal.name,
          items: before.map((i) => ({
            name: i.name,
            grams: i.grams,
            kcal: i.kcal,
            protein_g: i.protein_g,
            carbs_g: i.carbs_g,
            fat_g: i.fat_g,
          })),
        },
        text,
        controller.signal
      );
      toReview(groundMealEstimate(getDb(), revised));
    } catch (error) {
      // A cancel is not a failure and gets no message — the screen is gone.
      if (controller.signal.aborted) return;
      setPhase({
        kind: 'error',
        message:
          error instanceof MealEstimationUnavailableError
            ? error.message
            : 'Couldn’t revise that meal. Check your connection and try again, or edit the items by hand.',
      });
    }
  };

  const setGrams = (key: string, text: string) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, gramsText: text } : r)));
  };
  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
  };

  const save = () => {
    if (rows.length === 0) return;
    const items: NewMealItem[] = rows.map((row) => {
      const p = currentPortion(row);
      return {
        food_id: row.foodId,
        name: row.name,
        grams: p.grams,
        serving_qty: null,
        kcal: p.kcal,
        protein_g: p.protein_g,
        carbs_g: p.carbs_g,
        fat_g: p.fat_g,
        fiber_g: p.fiber_g,
        confidence: row.confidence,
        micros: p.micros,
      };
    });
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

  // The total of the rows actually on screen, at their live grams — a ledger
  // sums to its own total, so this moves with every edit and removal.
  const reviewKcal = rows.reduce<number | null>((sum, row) => {
    const kcal = currentPortion(row).kcal;
    return kcal == null ? sum : (sum ?? 0) + kcal;
  }, null);
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
            <SectionLabel label="As logged" note={String(before.length)} />
            {before.length === 0 ? (
              <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
                This meal has no items — its totals were typed in directly. A correction here can
                still itemize it.
              </Text>
            ) : (
              <View className="mt-2">
                <Block device="plate">
                  {before.map((item, index) => (
                    <View key={item.id}>
                      <Divider first={index === 0} />
                      <View className="min-h-[44px] flex-row items-center gap-3 py-2.5">
                        <Text className="flex-1 font-serif text-[15px] leading-5 text-ink">
                          {item.name}
                        </Text>
                        {item.grams !== null ? (
                          <Text className="font-mono text-[11px] text-ink-muted">
                            {Math.round(item.grams)} g
                          </Text>
                        ) : null}
                        <Text className="w-12 text-right font-mono text-[13px] text-ink-secondary">
                          {item.kcal !== null ? fmtInt(item.kcal) : '—'}
                        </Text>
                      </View>
                    </View>
                  ))}
                </Block>
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
                    You’ll see the revised items and can adjust them before anything is saved. The
                    meal’s time, name and notes are never changed here.
                  </Text>
                </Block>
              </View>
            </>
          )}
        </>
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

          <Block device="plate">
            <SectionLabel
              label="Revised"
              note={reviewKcal !== null ? `${fmtInt(reviewKcal)} kcal` : undefined}
            />
            {rows.length === 0 ? (
              <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                No items left. Go back and try a different correction — a meal cannot be saved
                empty.
              </Text>
            ) : (
              <View className="mt-1">
                {rows.map((row, index) => {
                  const p = currentPortion(row);
                  return (
                    <View key={row.key}>
                      <Divider first={index === 0} />
                      <View className="py-3">
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
                          <View className="flex-row items-center gap-1">
                            <TextInput
                              value={row.gramsText}
                              onChangeText={(t) => setGrams(row.key, t)}
                              keyboardType="decimal-pad"
                              returnKeyType={KEYPAD_DONE}
                              accessibilityLabel={`${row.name} grams`}
                              className="w-14 border border-paper-deep bg-paper-dim px-2 py-1.5 text-right font-mono text-[13px] text-ink"
                            />
                            <Text className="font-mono text-[11px] text-ink-secondary">g</Text>
                          </View>
                          <Text className="w-12 text-right font-mono text-[13px] text-ink-secondary">
                            {p.kcal != null ? fmtInt(p.kcal) : '—'}
                          </Text>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Remove ${row.name}`}
                            hitSlop={12}
                            onPress={() => removeRow(row.key)}
                            className="h-8 w-8 items-center justify-center rounded-btn active:opacity-60">
                            <Ionicons name="close" size={16} color={palette.inkMuted} />
                          </Pressable>
                        </View>
                        <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                          {p.protein_g != null ? `P ${Math.round(p.protein_g)}g` : ''}
                          {p.carbs_g != null ? ` · C ${Math.round(p.carbs_g)}g` : ''}
                          {p.fat_g != null ? ` · F ${Math.round(p.fat_g)}g` : ''}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </Block>

          {/* The decision, in future tense, immediately above the control that
              makes it — and nothing after it but its other branch. */}
          <Text className="mt-5 font-serif text-[13px] leading-5 text-ink-muted">
            On save: these {rows.length} item{rows.length === 1 ? '' : 's'} replace what the meal
            holds now
            {beforeKcal !== null && reviewKcal !== null
              ? `, moving it from ${fmtInt(beforeKcal)} to ${fmtInt(reviewKcal)} kcal`
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
