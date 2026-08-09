import Ionicons from '@expo/vector-icons/Ionicons';
import { useKeepAwake } from 'expo-keep-awake';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
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
 */

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

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
        <Text className="mt-2 text-[13px] text-ink-secondary">This recipe is gone.</Text>
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

      <View className="mt-1 flex-row items-center gap-2">
        <Text className="flex-1 font-mono text-[11px] text-ink-muted">{metaParts.join(' · ')}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={recipe.is_favorite === 1 ? 'Unfavorite' : 'Favorite'}
          onPress={() => {
            setRecipeFavorite(getDb(), recipe.id, recipe.is_favorite !== 1);
            reload();
          }}
          hitSlop={8}
          className="active:opacity-60">
          <Ionicons
            name={recipe.is_favorite === 1 ? 'star' : 'star-outline'}
            size={18}
            color={recipe.is_favorite === 1 ? palette.inkSecondary : palette.inkMuted}
          />
        </Pressable>
      </View>
      {recipe.source_author || recipe.source_platform ? (
        <Text className="mt-1 text-[12px] text-ink-muted">
          {[recipe.source_author, recipe.source_platform].filter(Boolean).join(' · ')}
        </Text>
      ) : null}

      {/* Ingredients — raw lines with resolution state. */}
      <View className="mt-6">
        <SectionLabel>Ingredients</SectionLabel>
        <View className="mt-2 rounded-card border border-hairline bg-porcelain px-4">
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
          {lines.length === 0 ? (
            <Text className="py-3 text-[13px] text-ink-muted">No ingredient lines yet.</Text>
          ) : null}
        </View>
      </View>

      {/* Nutrition — through the gate or honestly absent. */}
      <View className="mt-6">
        <SectionLabel>Per serving</SectionLabel>
        {nutrition.complete ? (
          <View className="mt-2 flex-row gap-4">
            {(
              [
                ['kcal', per.kcal === null ? null : fmtInt(per.kcal)],
                ['protein', per.protein_g === null ? '—' : `${fmtQty(per.protein_g)} g`],
                ['carbs', per.carbs_g === null ? '—' : `${fmtQty(per.carbs_g)} g`],
                ['fat', per.fat_g === null ? '—' : `${fmtQty(per.fat_g)} g`],
              ] as [string, string | null][]
            ).map(([label, value]) => (
              <View key={label}>
                <Text className="text-[10px] uppercase tracking-[1px] text-ink-muted">{label}</Text>
                <Text className="mt-0.5 font-mono text-lg font-semibold text-ink">{value}</Text>
              </View>
            ))}
          </View>
        ) : (
          <Text className="mt-2 text-[13px] leading-5 text-ink-muted">
            Nutrition not computed — {nutrition.unresolvedCount} ingredient
            {nutrition.unresolvedCount === 1 ? '' : 's'} unresolved. Link each line to a food (or
            mark it “counts as 0”) and the numbers appear.
          </Text>
        )}
      </View>

      {/* Steps — tap to mark while cooking. */}
      {steps.length > 0 ? (
        <View className="mt-6">
          <SectionLabel>Steps</SectionLabel>
          <View className="mt-2">
            {steps.map((step, index) => {
              const done = doneSteps.has(index);
              return (
                <Pressable
                  key={index}
                  accessibilityRole="button"
                  accessibilityLabel={`Step ${index + 1}`}
                  accessibilityState={{ selected: done }}
                  onPress={() => toggleStep(index)}
                  className={`flex-row gap-3 py-2.5 active:opacity-60 ${
                    index === 0 ? '' : 'border-t border-hairline-soft'
                  }`}>
                  <Text className="w-6 font-mono text-[13px] text-ink-muted">{index + 1}.</Text>
                  <Text
                    className={`flex-1 text-[14px] leading-6 ${
                      done ? 'text-ink-muted line-through' : 'text-ink'
                    }`}>
                    {step}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {recipe.notes ? (
        <Text className="mt-5 text-[13px] leading-5 text-ink-secondary">{recipe.notes}</Text>
      ) : null}

      {/* Actions. Log it is the screen's one pine action. */}
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
        <View className="mt-8">
          {addedNote !== null ? (
            <Text className="mb-2 text-center font-mono text-[12px] text-ink-secondary">
              {addedNote} item{addedNote === 1 ? '' : 's'} added to the grocery list
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Log it"
            onPress={() => setLogOpen(true)}
            className="items-center justify-center rounded-btn bg-pine py-3 active:opacity-70">
            <Text className="text-[14px] font-semibold text-pine-on">Log it</Text>
          </Pressable>
          <View className="mt-2 flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add to grocery list"
              onPress={() => setPickerOpen(true)}
              className="flex-1 items-center justify-center rounded-btn border border-hairline-strong py-2.5 active:bg-paper-deep">
              <Text className="text-[13px] text-ink">Add to grocery list</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit recipe"
              onPress={() => router.push({ pathname: '/recipe-edit', params: { id: recipe.id } })}
              className="items-center justify-center rounded-btn border border-hairline-strong px-4 py-2.5 active:bg-paper-deep">
              <Text className="text-[13px] text-ink">Edit</Text>
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={deleteArmed ? 'Tap again to delete recipe' : 'Delete recipe'}
            onPress={remove}
            className="mt-6 items-center py-2 active:opacity-60">
            <Text
              className={`text-[13px] ${deleteArmed ? 'font-semibold text-ink' : 'text-ink-muted'}`}>
              {deleteArmed ? 'Confirm delete — cooked meals keep their record' : 'Delete recipe'}
            </Text>
          </Pressable>
        </View>
      )}
    </Screen>
  );
}

/** One ingredient line + its resolution affordances. */
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
    <View className={first ? '' : 'border-t border-hairline-soft'}>
      <View className="flex-row items-center gap-3 py-2.5">
        <View className="flex-1">
          <Text
            className={`text-[14px] leading-5 ${negligible ? 'text-ink-muted line-through' : 'text-ink'}`}>
            {line.raw_text}
          </Text>
          {resolved ? (
            <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">
              {fmtQty(line.grams!)} g · {fmtInt(line.kcal!)} kcal
              {line.food_id === null ? ' · food since deleted (snapshot kept)' : ''}
            </Text>
          ) : negligible ? (
            <Text className="mt-0.5 text-[11px] text-ink-muted">counts as 0, on purpose</Text>
          ) : null}
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
              hitSlop={8}
              className="active:opacity-60">
              <Text className="text-[12px] text-ink-muted">Unlink</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Link ${line.raw_text} to a food`}
              accessibilityState={{ expanded: linking }}
              onPress={onToggleLink}
              className="rounded-btn border border-hairline-strong px-2.5 py-1 active:bg-paper-deep">
              <Text className="text-[12px] text-ink">Link</Text>
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
            hitSlop={8}
            className="active:opacity-60">
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

/** Inline food search + grams → resolveIngredient. Explicit, never fuzzy. */
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
    <View className="border-t border-hairline-soft bg-paper-deep/40 px-1 pb-3 pt-2">
      <TextInput
        accessibilityLabel="Search the food catalog"
        value={query}
        onChangeText={search}
        placeholder="Search the catalog"
        placeholderTextColor={palette.inkMuted}
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded-btn border border-hairline-soft bg-paper-deep px-3 py-2 text-[13px] text-ink"
      />
      {results.map((food) => (
        <Pressable
          key={food.id}
          accessibilityRole="button"
          accessibilityLabel={food.name}
          accessibilityState={{ selected: picked?.id === food.id }}
          onPress={() => setPicked(food)}
          className={`mt-1 flex-row items-baseline justify-between rounded-btn px-3 py-2 ${
            picked?.id === food.id ? 'bg-paper-deep' : 'active:bg-paper-deep'
          }`}>
          <Text
            className={`flex-1 text-[13px] ${picked?.id === food.id ? 'font-semibold text-ink' : 'text-ink'}`}>
            {food.name}
          </Text>
          <Text className="font-mono text-[11px] text-ink-muted">
            {food.kcal_100g !== null ? `${fmtInt(food.kcal_100g)} kcal/100g` : 'no energy data'}
          </Text>
        </Pressable>
      ))}
      {picked ? (
        <View className="mt-2 flex-row items-center gap-2">
          <TextInput
            accessibilityLabel="Grams in this recipe"
            value={grams}
            onChangeText={setGrams}
            keyboardType="decimal-pad"
            placeholder="grams"
            placeholderTextColor={palette.inkMuted}
            className="w-24 rounded-btn border border-hairline-soft bg-paper-deep px-2.5 py-2 text-right font-mono text-[13px] text-ink"
          />
          <Text className="text-[12px] text-ink-muted">g per batch</Text>
          <View className="flex-1" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Link food"
            accessibilityState={{ disabled: !canLink }}
            disabled={!canLink}
            onPress={link}
            className={`rounded-btn px-3.5 py-2 ${canLink ? 'bg-pine active:opacity-70' : 'bg-hairline'}`}>
            <Text
              className={`text-[12px] font-semibold ${canLink ? 'text-pine-on' : 'text-ink-muted'}`}>
              Link
            </Text>
          </Pressable>
        </View>
      ) : null}
      {error ? <Text className="mt-2 text-[12px] text-ink-secondary">{error}</Text> : null}
    </View>
  );
}

/** The Log-it sheet: servings stepper (or grams when a cooked weight exists),
 * with the undercount disclosed BEFORE stamping. */
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
    <View className="mt-8 rounded-card border border-hairline bg-porcelain p-4">
      <SectionLabel>Log it</SectionLabel>

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
              className={`rounded-btn border px-3 py-1.5 ${
                gramsMode === mode
                  ? 'border-hairline-strong bg-paper-deep'
                  : 'border-hairline active:bg-paper-deep'
              }`}>
              <Text
                className={`text-[12px] ${gramsMode === mode ? 'font-semibold text-ink' : 'text-ink-secondary'}`}>
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
            className="w-24 rounded-btn border border-hairline-soft bg-paper-deep px-2.5 py-2 text-right font-mono text-[15px] text-ink"
          />
          <Text className="text-[13px] text-ink-secondary">
            g of the {fmtInt(recipe.total_weight_g!)} g batch
          </Text>
        </View>
      ) : (
        <View className="mt-3 flex-row items-center gap-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fewer servings"
            onPress={() => setServings(Math.max(0.25, servings - 0.25))}
            className="h-9 w-9 items-center justify-center rounded-btn border border-hairline-strong active:bg-paper-deep">
            <Ionicons name="remove" size={16} color={palette.ink} />
          </Pressable>
          <Text className="w-20 text-center font-mono text-lg font-semibold text-ink">
            {formatQty(servings)}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="More servings"
            onPress={() => setServings(servings + 0.25)}
            className="h-9 w-9 items-center justify-center rounded-btn border border-hairline-strong active:bg-paper-deep">
            <Ionicons name="add" size={16} color={palette.ink} />
          </Pressable>
          <Text className="text-[13px] text-ink-secondary">
            serving{servings === 1 ? '' : 's'}
            {kcal !== null ? ` · ≈ ${fmtInt(kcal)} kcal` : ''}
          </Text>
        </View>
      )}

      {nutrition.unresolvedCount > 0 ? (
        <Text className="mt-3 text-[12px] leading-5 text-ink-secondary">
          {nutrition.unresolvedCount} ingredient
          {nutrition.unresolvedCount === 1 ? ' isn’t' : 's aren’t'} counted — this logs below the
          real intake.
        </Text>
      ) : null}

      {logError ? (
        <Text className="mt-3 text-[12px] leading-5 text-ink-secondary">{logError}</Text>
      ) : null}

      <View className="mt-4 flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log this meal"
          accessibilityState={{ disabled: !canLog }}
          disabled={!canLog}
          onPress={log}
          className={`flex-1 items-center justify-center rounded-btn py-2.5 ${
            canLog ? 'bg-pine active:opacity-70' : 'bg-hairline'
          }`}>
          <Text
            className={`text-[13px] font-semibold ${canLog ? 'text-pine-on' : 'text-ink-muted'}`}>
            Log
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onCancel}
          className="rounded-btn border border-hairline-strong px-4 py-2.5 active:bg-paper-deep">
          <Text className="text-[13px] text-ink-muted">Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Pre-checked ingredient picker → the grocery list (uncheck what you have). */
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
    <View className="mt-8 rounded-card border border-hairline bg-porcelain p-4">
      <SectionLabel>Add to grocery list</SectionLabel>
      <Text className="mt-1 text-[12px] text-ink-muted">Uncheck what you already have.</Text>
      <View className="mt-2">
        {lines.map((line, index) => {
          const on = checked.has(line.id);
          return (
            <Pressable
              key={line.id}
              accessibilityRole="checkbox"
              accessibilityLabel={line.raw_text}
              accessibilityState={{ checked: on }}
              onPress={() => toggle(line.id)}
              className={`flex-row items-center gap-3 py-2 active:opacity-60 ${
                index === 0 ? '' : 'border-t border-hairline-soft'
              }`}>
              <View
                className={`h-5 w-5 items-center justify-center rounded-full ${
                  on ? 'bg-pine' : 'border border-hairline-strong'
                }`}>
                {on ? <Ionicons name="checkmark" size={12} color={palette.pineOn} /> : null}
              </View>
              <Text className={`flex-1 text-[13px] ${on ? 'text-ink' : 'text-ink-muted'}`}>
                {line.raw_text}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View className="mt-3 flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add checked ingredients"
          accessibilityState={{ disabled: checked.size === 0 }}
          disabled={checked.size === 0}
          onPress={add}
          className={`flex-1 items-center justify-center rounded-btn py-2.5 ${
            checked.size > 0 ? 'bg-pine active:opacity-70' : 'bg-hairline'
          }`}>
          <Text
            className={`text-[13px] font-semibold ${checked.size > 0 ? 'text-pine-on' : 'text-ink-muted'}`}>
            Add {checked.size} item{checked.size === 1 ? '' : 's'}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onCancel}
          className="rounded-btn border border-hairline-strong px-4 py-2.5 active:bg-paper-deep">
          <Text className="text-[13px] text-ink-muted">Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}
