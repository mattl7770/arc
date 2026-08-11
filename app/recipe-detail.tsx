import Ionicons from '@expo/vector-icons/Ionicons';
import { useKeepAwake } from 'expo-keep-awake';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider, GridCell } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import { searchFoods } from '@/lib/db/repositories/foods';
import { addRecipeToGroceryList } from '@/lib/db/repositories/grocery';
import {
  deleteRecipe,
  getRecipe,
  isResolved,
  listIngredients,
  logRecipe,
  parseSteps,
  recipeCookStats,
  recipeNutrition,
  resolveIngredient,
  setIngredientNegligible,
  setRecipeFavorite,
  unresolveIngredient,
} from '@/lib/db/repositories/recipes';
import { fmtInt, fmtQty } from '@/lib/nutrition/format';
import { formatQty } from '@/lib/recipes/ingredients';
import type { FoodRow } from '@/lib/nutrition/types';
import type { RecipeIngredientRow, RecipeNutrition, RecipeRow } from '@/lib/recipes/types';

/**
 * One recipe (docs/recipes-grocery.md §5): ingredients with their resolution
 * state, steps (tap to mark while cooking — the screen stays awake), the
 * honesty-gated nutrition block, and the three actions — Log it (the one pine
 * action, with the undercount DISCLOSED before stamping when lines are
 * unresolved), Add to grocery list (pre-checked picker), Edit.
 *
 * Resolution is the user's explicit act: "Link" opens an inline food search;
 * suggestions are never auto-applied. A linked line snapshots per-batch macros
 * at that moment and survives later catalog churn.
 *
 * ## Conformed Set surface system (00-design-spec.md §1)
 *
 *   Ingredients   → **ruled plate**: a list of lines with their state is a
 *                   record, and a record is a table. Rows are separated by
 *                   `Divider`, never `border-t` (which draws a full rectangle in
 *                   React Native — see src/components/ui/block.tsx). Dropped
 *                   through empty: a plate closes a record, and a recipe with no
 *                   lines has none to close.
 *   Per serving   → **grid**, which draws nothing. The figures are legible from
 *                   alignment alone, and they appear ONLY through the honesty
 *                   gate; otherwise the sentence names the unresolved count.
 *   Steps         → **ruled plate** of numbered rows. The number is a measured
 *                   position, so it is mono; the instruction is prose, so serif.
 *   Notes         → **margin annotation**, which draws nothing.
 *
 * **Accent budget: one, in every state.** The default state spends it on
 * `Log it`; while the log sheet is open it is that sheet's `Log`, and while the
 * grocery picker is open it is `Add N items` — the three are mutually exclusive
 * branches, so exactly one pine element is ever on screen. Everything else is
 * outlined or bare ink, including the inline `Link` confirm (which CAN coexist
 * with `Log it` and so must not be pine) and the picker's check marks, which are
 * neutral ink: a selection is not a biological state and not the next action.
 */

type Loaded = {
  recipe: RecipeRow;
  lines: RecipeIngredientRow[];
  nutrition: RecipeNutrition;
  timesCooked: number;
  lastCooked: string | null;
};

function load(id: string): Loaded | null {
  const db = getDb();
  const recipe = getRecipe(db, id);
  if (!recipe) return null;
  return {
    recipe,
    lines: listIngredients(db, id),
    nutrition: recipeNutrition(db, id),
    ...recipeCookStats(db, id),
  };
}

export default function RecipeDetailScreen() {
  useKeepAwake(); // cook mode: the screen stays on while a recipe is open
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const recipeId = typeof id === 'string' ? id : '';
  const [data, setData] = useState<Loaded | null>(() => load(recipeId));
  const [doneSteps, setDoneSteps] = useState<Set<number>>(new Set());
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addedNote, setAddedNote] = useState<number | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const reload = useCallback(() => {
    setData(load(recipeId));
    setDeleteArmed(false);
  }, [recipeId]);
  useFocusEffect(reload);

  if (!data) {
    return (
      <Screen scroll>
        <View className="pt-2">
          <StackHeader title="Recipe" />
        </View>
        <Text className="mt-5 font-serif text-[14px] leading-6 text-ink-secondary">
          This recipe is gone.
        </Text>
      </Screen>
    );
  }

  const { recipe, lines, nutrition } = data;
  const steps = parseSteps(recipe.steps);
  const per = nutrition.perServing;

  const toggleStep = (index: number) => {
    setDoneSteps((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const remove = () => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    deleteRecipe(getDb(), recipe.id);
    router.back();
  };

  const metaParts = [
    `${fmtQty(recipe.servings)} serving${recipe.servings === 1 ? '' : 's'}`,
    recipe.prep_min != null || recipe.cook_min != null
      ? `${(recipe.prep_min ?? 0) + (recipe.cook_min ?? 0)} min`
      : null,
    data.timesCooked > 0 ? `cooked ${data.timesCooked}×` : null,
  ].filter(Boolean);

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={recipe.title} />
      </View>

      {/* The header's measured facts — a batch yield, a duration, a count. All
          measurement, so all mono. */}
      <View className="mt-2 flex-row items-center gap-2">
        <Text className="flex-1 font-mono text-[12px] text-ink-secondary">
          {metaParts.join(' · ')}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={recipe.is_favorite === 1 ? 'Unfavorite' : 'Favorite'}
          onPress={() => {
            setRecipeFavorite(getDb(), recipe.id, recipe.is_favorite !== 1);
            reload();
          }}
          hitSlop={8}
          className="-mr-2 h-11 w-11 items-center justify-center active:opacity-60">
          <Ionicons
            name={recipe.is_favorite === 1 ? 'star' : 'star-outline'}
            size={18}
            color={recipe.is_favorite === 1 ? palette.inkSecondary : palette.inkMuted}
          />
        </Pressable>
      </View>
      {recipe.source_author || recipe.source_platform ? (
        <Text className="mt-1 font-serif text-[13px] text-ink-secondary">
          {[recipe.source_author, recipe.source_platform].filter(Boolean).join(' · ')}
        </Text>
      ) : null}

      {/* INGREDIENTS — raw lines with resolution state. The plate goes round the
          rows, never round the empty: before the first line there is no record
          to close, only a sentence. */}
      <View className="mt-5">
        <SectionLabel label="Ingredients" />
        {lines.length === 0 ? (
          <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
            No ingredient lines yet.
          </Text>
        ) : (
          <View className="mt-2">
            <Block device="plate">
              {lines.map((line, index) => (
                <IngredientRow
                  key={line.id}
                  line={line}
                  first={index === 0}
                  linking={linkingId === line.id}
                  onToggleLink={() => setLinkingId(linkingId === line.id ? null : line.id)}
                  onChanged={() => {
                    setLinkingId(null);
                    reload();
                  }}
                />
              ))}
            </Block>
          </View>
        )}
      </View>

      {/* PER SERVING — through the gate or honestly absent. A grid draws no box
          and no rules; the columns line up on their own. */}
      <View className="mt-7">
        <Block device="grid">
          <SectionLabel label="Per serving" />
          {nutrition.complete ? (
            /* The restored grid draws its rules through GridCell, not through
               cell styling — four metrics in one ruled row, no outer box. */
            <View className="mt-2 flex-row flex-wrap">
              {(
                [
                  // No data, no number: an em-dash, never a stand-in zero.
                  ['kcal', per.kcal === null ? '—' : fmtInt(per.kcal)],
                  ['protein', per.protein_g === null ? '—' : `${fmtQty(per.protein_g)} g`],
                  ['carbs', per.carbs_g === null ? '—' : `${fmtQty(per.carbs_g)} g`],
                  ['fat', per.fat_g === null ? '—' : `${fmtQty(per.fat_g)} g`],
                ] as [string, string][]
              ).map(([label, value], index, all) => (
                <GridCell key={label} index={index} count={all.length} columns={4}>
                  <View>
                    <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
                      {label}
                    </Text>
                    <Text className="mt-1 font-mono text-[20px] font-semibold text-ink">
                      {value}
                    </Text>
                  </View>
                </GridCell>
              ))}
            </View>
          ) : nutrition.unresolvedCount > 0 ? (
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
              Nutrition not computed — {nutrition.unresolvedCount} ingredient
              {nutrition.unresolvedCount === 1 ? '' : 's'} unresolved. Link each line to a food (or
              mark it “counts as 0”) and the numbers appear.
            </Text>
          ) : (
            /* The gate has two halves, and this is the other one: every line is
               resolved or negligible, but NOTHING is counted — a recipe of
               water, salt and pepper. Saying "0 ingredients unresolved" there
               told the user to fix a list with nothing wrong in it. */
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
              Nothing here counts toward nutrition — every line is marked “counts as 0”. Link a line
              to a food and the numbers appear.
            </Text>
          )}
        </Block>
      </View>

      {/* STEPS — tap to mark while cooking. */}
      {steps.length > 0 ? (
        <View className="mt-7">
          <SectionLabel label="Steps" />
          <View className="mt-2">
            <Block device="plate">
              {steps.map((step, index) => {
                const done = doneSteps.has(index);
                return (
                  <View key={index}>
                    <Divider first={index === 0} />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Step ${index + 1}`}
                      accessibilityState={{ selected: done }}
                      onPress={() => toggleStep(index)}
                      className="min-h-[46px] flex-row gap-3 py-3 active:opacity-60">
                      <Text className="w-6 pt-0.5 font-mono text-[12px] text-ink-secondary">
                        {index + 1}.
                      </Text>
                      <Text
                        className={
                          done
                            ? 'flex-1 font-serif text-[16px] leading-6 text-ink-muted line-through'
                            : 'flex-1 font-serif text-[16px] leading-6 text-ink'
                        }>
                        {step}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
            </Block>
          </View>
        </View>
      ) : null}

      {recipe.notes ? (
        <View className="mt-7">
          <Block device="margin">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              {recipe.notes}
            </Text>
          </Block>
        </View>
      ) : null}

      {/* Actions. Log it is the screen's one pine action — and the two sheets
          below replace it rather than joining it, so the budget holds. */}
      {logOpen ? (
        <LogSheet
          recipe={recipe}
          nutrition={nutrition}
          onDone={() => {
            setLogOpen(false);
            router.back();
          }}
          onCancel={() => setLogOpen(false)}
        />
      ) : pickerOpen ? (
        <GroceryPicker
          lines={lines}
          recipeId={recipe.id}
          onDone={(count) => {
            setPickerOpen(false);
            setAddedNote(count);
          }}
          onCancel={() => setPickerOpen(false)}
        />
      ) : (
        <View className="mt-7">
          {addedNote !== null ? (
            <Text className="mb-3 text-center font-serif text-[13px] leading-5 text-ink-secondary">
              {addedNote} item{addedNote === 1 ? '' : 's'} added to the grocery list
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Log it"
            onPress={() => setLogOpen(true)}
            className="min-h-[52px] items-center justify-center rounded-btn bg-pine active:opacity-80">
            <Text className="font-label text-[15px] font-semibold text-pine-on">Log it</Text>
          </Pressable>
          <View className="mt-3 flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add to grocery list"
              onPress={() => setPickerOpen(true)}
              className="min-h-[46px] flex-1 items-center justify-center rounded-btn border border-hairline px-3 active:bg-paper-dim">
              <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
                Add to grocery list
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit recipe"
              onPress={() => router.push({ pathname: '/recipe-edit', params: { id: recipe.id } })}
              className="min-h-[46px] items-center justify-center rounded-btn border border-hairline px-4 active:bg-paper-dim">
              <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
                Edit
              </Text>
            </Pressable>
          </View>
          {/* The armed state's consequence is a sentence, so it is set as one.
              A button label takes the label voice (§3, every button at every
              weight), and a tracked-caps line of that length is not a label. */}
          {deleteArmed ? (
            <Text className="mt-6 text-center font-serif text-[13px] leading-5 text-ink-secondary">
              Cooked meals keep their record.
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={deleteArmed ? 'Tap again to delete recipe' : 'Delete recipe'}
            onPress={remove}
            className={
              deleteArmed
                ? 'mt-2 min-h-[46px] items-center justify-center active:opacity-60'
                : 'mt-6 min-h-[46px] items-center justify-center active:opacity-60'
            }>
            <Text
              className={
                deleteArmed
                  ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink'
                  : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
              }>
              {deleteArmed ? 'Confirm delete' : 'Delete recipe'}
            </Text>
          </Pressable>
        </View>
      )}
    </Screen>
  );
}

/**
 * One ingredient line + its resolution affordances — a row of the Ingredients
 * plate, so it opens with its own leading `Divider`.
 *
 * A resolved line carries its measured snapshot in mono. An unresolved one
 * carries a SENTENCE saying it is not counted: the honest form of "no data, no
 * number" here is words, because a blank sub-line reads as agreement with the
 * per-serving figures above rather than as an omission from them.
 */
function IngredientRow({
  line,
  first,
  linking,
  onToggleLink,
  onChanged,
}: {
  line: RecipeIngredientRow;
  first: boolean;
  linking: boolean;
  onToggleLink: () => void;
  onChanged: () => void;
}) {
  const resolved = isResolved(line);
  const negligible = line.negligible === 1;
  return (
    <View>
      <Divider first={first} />
      <View className="min-h-[46px] flex-row items-center gap-3 py-3">
        <View className="flex-1">
          <Text
            className={
              negligible
                ? 'font-serif text-[16px] leading-5 text-ink-muted line-through'
                : 'font-serif text-[16px] leading-5 text-ink'
            }>
            {line.raw_text}
          </Text>
          {resolved ? (
            <Text className="mt-0.5 font-mono text-[12px] text-ink-secondary">
              {fmtQty(line.grams!)} g · {fmtInt(line.kcal!)} kcal
              {line.food_id === null ? ' · food since deleted (snapshot kept)' : ''}
            </Text>
          ) : negligible ? (
            <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary">
              counts as 0, on purpose
            </Text>
          ) : (
            <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary">
              Not counted yet
            </Text>
          )}
        </View>
        {!negligible ? (
          resolved ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Unlink ${line.raw_text}`}
              onPress={() => {
                unresolveIngredient(getDb(), line.id);
                onChanged();
              }}
              hitSlop={10}
              className="min-h-[44px] items-center justify-center px-2 active:opacity-60">
              <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
                Unlink
              </Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Link ${line.raw_text} to a food`}
              accessibilityState={{ expanded: linking }}
              onPress={onToggleLink}
              hitSlop={10}
              className="min-h-[44px] items-center justify-center rounded-btn border border-hairline px-3 active:bg-paper-dim">
              <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
                Link
              </Text>
            </Pressable>
          )
        ) : null}
        {!resolved ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              negligible ? `Count ${line.raw_text} again` : `Mark ${line.raw_text} as counting zero`
            }
            onPress={() => {
              setIngredientNegligible(getDb(), line.id, !negligible);
              onChanged();
            }}
            hitSlop={10}
            className="h-11 w-11 items-center justify-center active:opacity-60">
            <Ionicons
              name={negligible ? 'refresh-outline' : 'remove-circle-outline'}
              size={16}
              color={palette.inkMuted}
            />
          </Pressable>
        ) : null}
      </View>
      {linking && !resolved && !negligible ? (
        <LinkEditor line={line} onChanged={onChanged} />
      ) : null}
    </View>
  );
}

/**
 * Inline food search + grams → resolveIngredient. Explicit, never fuzzy.
 *
 * It expands INSIDE the Ingredients plate, so it opens on a `Divider` rather
 * than a `border-t` and carries no device of its own (devices never nest). The
 * two inputs wear the well's own tokens — `border-paper-deep bg-paper-dim`,
 * form (b) of the capture-surface rule — because each field IS the well.
 */
function LinkEditor({ line, onChanged }: { line: RecipeIngredientRow; onChanged: () => void }) {
  const [query, setQuery] = useState(line.name ?? '');
  const [results, setResults] = useState<FoodRow[]>(() =>
    line.name ? searchFoods(getDb(), line.name, 5) : []
  );
  const [picked, setPicked] = useState<FoodRow | null>(null);
  const [grams, setGrams] = useState(line.unit === 'g' && line.qty ? String(line.qty) : '');
  const [error, setError] = useState<string | null>(null);

  const search = (text: string) => {
    setQuery(text);
    setPicked(null);
    setResults(text.trim() === '' ? [] : searchFoods(getDb(), text, 5));
  };

  const parsedGrams = Number(grams);
  const canLink = picked !== null && Number.isFinite(parsedGrams) && parsedGrams > 0;

  const link = () => {
    if (!canLink) return;
    try {
      resolveIngredient(getDb(), line.id, picked!.id, parsedGrams);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not link this food.');
    }
  };

  return (
    <View>
      <Divider />
      <View className="pb-4 pt-3">
        <TextInput
          accessibilityLabel="Search the food catalog"
          value={query}
          onChangeText={search}
          placeholder="Search the catalog"
          placeholderTextColor={palette.inkMuted}
          autoCapitalize="none"
          autoCorrect={false}
          className="border border-paper-deep bg-paper-dim px-3 py-3 font-serif text-[16px] text-ink"
        />
        {results.map((food) => (
          <Pressable
            key={food.id}
            accessibilityRole="button"
            accessibilityLabel={food.name}
            accessibilityState={{ selected: picked?.id === food.id }}
            onPress={() => setPicked(food)}
            className={
              picked?.id === food.id
                ? 'mt-1 min-h-[44px] flex-row items-center justify-between gap-3 bg-paper-dim px-3 py-2'
                : 'mt-1 min-h-[44px] flex-row items-center justify-between gap-3 px-3 py-2 active:bg-paper-dim'
            }>
            <Text
              className={
                picked?.id === food.id
                  ? 'flex-1 font-serif text-[15px] font-semibold text-ink'
                  : 'flex-1 font-serif text-[15px] text-ink'
              }>
              {food.name}
            </Text>
            <Text className="font-mono text-[12px] text-ink-secondary">
              {food.kcal_100g !== null ? `${fmtInt(food.kcal_100g)} kcal/100g` : 'no energy data'}
            </Text>
          </Pressable>
        ))}
        {picked ? (
          <View className="mt-3 flex-row items-center gap-2">
            <TextInput
              accessibilityLabel="Grams in this recipe"
              value={grams}
              onChangeText={setGrams}
              keyboardType="decimal-pad"
              placeholder="grams"
              placeholderTextColor={palette.inkMuted}
              className="w-24 border border-paper-deep bg-paper-dim px-2.5 py-3 text-right font-mono text-[16px] text-ink"
            />
            <Text className="font-serif text-[13px] text-ink-secondary">g per batch</Text>
            <View className="flex-1" />
            {/* Outlined, not pine: this control can be on screen at the same
                time as "Log it", and the screen gets one accent. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Link food"
              accessibilityState={{ disabled: !canLink }}
              disabled={!canLink}
              onPress={link}
              className={
                canLink
                  ? 'min-h-[44px] items-center justify-center rounded-btn border border-ink px-4 active:opacity-70'
                  : 'min-h-[44px] items-center justify-center rounded-btn border border-paper-deep px-4'
              }>
              <Text
                className={
                  canLink
                    ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink'
                    : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
                }>
                Link
              </Text>
            </Pressable>
          </View>
        ) : null}
        {error ? (
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">{error}</Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The Log-it sheet: servings stepper (or grams when a cooked weight exists),
 * with the undercount disclosed BEFORE stamping.
 *
 * It carries **no device**: this is a group of controls, not a record, and a
 * form is named by its section label and set apart by air (the reasoning is in
 * src/components/nutrition/log-sheet.tsx). It replaces the `Log it` button
 * rather than joining it, so its `Log` is the screen's one accent while it is
 * open.
 */
function LogSheet({
  recipe,
  nutrition,
  onDone,
  onCancel,
}: {
  recipe: RecipeRow;
  nutrition: RecipeNutrition;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [servings, setServings] = useState(1);
  const [gramsMode, setGramsMode] = useState(false);
  const [grams, setGrams] = useState('');
  const [logError, setLogError] = useState<string | null>(null);

  const parsedGrams = Number(grams);
  const canLog = gramsMode ? Number.isFinite(parsedGrams) && parsedGrams > 0 : servings > 0;
  const factor = gramsMode
    ? recipe.total_weight_g && parsedGrams > 0
      ? parsedGrams / recipe.total_weight_g
      : 0
    : servings / recipe.servings;
  const kcal =
    nutrition.complete && nutrition.perServing.kcal !== null
      ? Math.round(nutrition.perServing.kcal * recipe.servings * factor)
      : null;

  const log = () => {
    if (!canLog) return;
    const now = new Date();
    const result = logRecipe(
      getDb(),
      recipe.id,
      gramsMode ? { grams: parsedGrams } : { servings },
      {
        date: todayISODate(),
        time: clockFromISO(now.toISOString()),
      }
    );
    // null = nothing loggable (no lines, or all negligible) — a silent
    // back-navigation here would fake a success the day's record never saw.
    if (result === null) {
      setLogError('Nothing to log — this recipe has no counted ingredient lines.');
      return;
    }
    onDone();
  };

  return (
    <View className="mt-7">
      <SectionLabel label="Log it" />

      {recipe.total_weight_g !== null ? (
        <View className="mt-2 flex-row gap-2">
          {(
            [
              [false, 'By servings'],
              [true, 'By cooked grams'],
            ] as [boolean, string][]
          ).map(([mode, label]) => (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: gramsMode === mode }}
              onPress={() => setGramsMode(mode)}
              className={
                gramsMode === mode
                  ? 'min-h-[44px] items-center justify-center rounded-btn border border-ink bg-paper-dim px-3'
                  : 'min-h-[44px] items-center justify-center rounded-btn border border-hairline px-3 active:bg-paper-dim'
              }>
              <Text
                className={
                  gramsMode === mode
                    ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink'
                    : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-secondary'
                }>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {gramsMode ? (
        <View className="mt-3 flex-row items-center gap-2">
          <TextInput
            accessibilityLabel="Grams eaten"
            value={grams}
            onChangeText={setGrams}
            keyboardType="decimal-pad"
            placeholder="250"
            placeholderTextColor={palette.inkMuted}
            className="w-24 border border-paper-deep bg-paper-dim px-2.5 py-3 text-right font-mono text-[16px] text-ink"
          />
          <Text className="flex-1 font-serif text-[13px] leading-5 text-ink-secondary">
            g of the {fmtInt(recipe.total_weight_g!)} g batch
          </Text>
        </View>
      ) : (
        <View className="mt-3 flex-row items-center gap-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fewer servings"
            onPress={() => setServings(Math.max(0.25, servings - 0.25))}
            className="h-11 w-11 items-center justify-center rounded-btn border border-hairline active:bg-paper-dim">
            <Ionicons name="remove" size={16} color={palette.ink} />
          </Pressable>
          <Text className="w-20 text-center font-mono text-[20px] font-semibold text-ink">
            {formatQty(servings)}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="More servings"
            onPress={() => setServings(servings + 0.25)}
            className="h-11 w-11 items-center justify-center rounded-btn border border-hairline active:bg-paper-dim">
            <Ionicons name="add" size={16} color={palette.ink} />
          </Pressable>
          <View className="flex-1">
            <Text className="font-serif text-[13px] text-ink-secondary">
              serving{servings === 1 ? '' : 's'}
            </Text>
            {/* The energy this portion would stamp — measured, so mono, and
                drawn only when the gate has passed. */}
            {kcal !== null ? (
              <Text className="mt-0.5 font-mono text-[12px] text-ink-secondary">
                ≈ {fmtInt(kcal)} kcal
              </Text>
            ) : null}
          </View>
        </View>
      )}

      {nutrition.unresolvedCount > 0 ? (
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
          {nutrition.unresolvedCount} ingredient
          {nutrition.unresolvedCount === 1 ? ' isn’t' : 's aren’t'} counted — this logs below the
          real intake.
        </Text>
      ) : null}

      {logError ? (
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">{logError}</Text>
      ) : null}

      <View className="mt-4 flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log this meal"
          accessibilityState={{ disabled: !canLog }}
          disabled={!canLog}
          onPress={log}
          className={
            canLog
              ? 'min-h-[46px] flex-1 items-center justify-center rounded-btn bg-pine active:opacity-80'
              : 'min-h-[46px] flex-1 items-center justify-center rounded-btn border border-paper-deep'
          }>
          <Text
            className={
              canLog
                ? 'font-label text-[15px] font-semibold text-pine-on'
                : 'font-label text-[15px] font-semibold text-ink-muted'
            }>
            Log
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onCancel}
          className="min-h-[46px] items-center justify-center rounded-btn border border-hairline px-4 active:bg-paper-dim">
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
            Cancel
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Pre-checked ingredient picker → the grocery list (uncheck what you have).
 *
 * The checklist IS a record of the lines, so it is a **ruled plate**; the label,
 * the instruction and the two actions sit outside it on the sheet. The check
 * mark is neutral ink — a selection is neither biology nor the next action, so
 * it never takes the accent (§2 firewall, §1 accent budget).
 */
function GroceryPicker({
  lines,
  recipeId,
  onDone,
  onCancel,
}: {
  lines: RecipeIngredientRow[];
  recipeId: string;
  onDone: (count: number) => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(lines.map((l) => l.id)));

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const add = () => {
    const ids = lines.filter((l) => checked.has(l.id)).map((l) => l.id);
    addRecipeToGroceryList(getDb(), recipeId, ids);
    onDone(ids.length);
  };

  return (
    <View className="mt-7">
      <SectionLabel label="Add to grocery list" />
      {lines.length === 0 ? (
        <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
          This recipe has no ingredient lines to add.
        </Text>
      ) : (
        <>
          <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
            Uncheck what you already have.
          </Text>
          <View className="mt-3">
            <Block device="plate">
              {lines.map((line, index) => {
                const on = checked.has(line.id);
                return (
                  <View key={line.id}>
                    <Divider first={index === 0} />
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityLabel={line.raw_text}
                      accessibilityState={{ checked: on }}
                      onPress={() => toggle(line.id)}
                      className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
                      <View
                        className={
                          on
                            ? 'h-5 w-5 items-center justify-center border border-ink bg-ink'
                            : 'h-5 w-5 items-center justify-center border border-hairline'
                        }>
                        {on ? (
                          <Ionicons name="checkmark" size={12} color={palette.paperHi} />
                        ) : null}
                      </View>
                      <Text
                        className={
                          on
                            ? 'flex-1 font-serif text-[16px] leading-5 text-ink'
                            : 'flex-1 font-serif text-[16px] leading-5 text-ink-muted'
                        }>
                        {line.raw_text}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
            </Block>
          </View>
        </>
      )}
      <View className="mt-4 flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add checked ingredients"
          accessibilityState={{ disabled: checked.size === 0 }}
          disabled={checked.size === 0}
          onPress={add}
          className={
            checked.size > 0
              ? 'min-h-[46px] flex-1 flex-row items-baseline justify-center gap-1.5 rounded-btn bg-pine active:opacity-80'
              : 'min-h-[46px] flex-1 flex-row items-baseline justify-center gap-1.5 rounded-btn border border-paper-deep'
          }>
          {/* "Add 3 items" — the count is a measured value, so it stays mono
              inside the label (§3's one exception). */}
          <Text
            className={
              checked.size > 0
                ? 'font-label text-[15px] font-semibold text-pine-on'
                : 'font-label text-[15px] font-semibold text-ink-muted'
            }>
            Add
          </Text>
          <Text
            className={
              checked.size > 0
                ? 'font-mono text-[15px] font-semibold text-pine-on'
                : 'font-mono text-[15px] font-semibold text-ink-muted'
            }>
            {checked.size}
          </Text>
          <Text
            className={
              checked.size > 0
                ? 'font-label text-[15px] font-semibold text-pine-on'
                : 'font-label text-[15px] font-semibold text-ink-muted'
            }>
            item{checked.size === 1 ? '' : 's'}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onCancel}
          className="min-h-[46px] items-center justify-center rounded-btn border border-hairline px-4 active:bg-paper-dim">
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
            Cancel
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
