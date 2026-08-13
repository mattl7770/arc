import Ionicons from '@expo/vector-icons/Ionicons';

import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, Text, TextInput, View } from 'react-native';

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
  portionFactorOrNull,
  recipeCookStats,
  recipeNutrition,
  resolveIngredient,
  scaledTotals,
  scaleRecipeLines,
  setIngredientNegligible,
  setRecipeFavorite,
  unresolveIngredient,
} from '@/lib/db/repositories/recipes';
import { fmtInt, fmtQty } from '@/lib/nutrition/format';
import { useKeepScreenAwake } from '@/lib/media/keep-awake';
import { pickPhotoBase64 } from '@/lib/media/photo-library';
import { clearRecipePhoto, recipePhotoUri, setRecipePhoto } from '@/lib/media/recipe-photo-store';
import {
  catalogResolveRecipe,
  isRecipePricingAvailable,
  RecipePricingUnavailableError,
  resolveRecipeWithModel,
  unpricedLines,
} from '@/lib/recipes/estimate';
import { formatQty } from '@/lib/recipes/ingredients';
import type { FoodRow } from '@/lib/nutrition/types';
import type {
  RecipeIngredientRow,
  RecipeNutrition,
  RecipePortion,
  RecipeRow,
} from '@/lib/recipes/types';

/**
 * One recipe (docs/recipes-grocery.md §5): ingredients with how each was
 * priced, steps (tap to mark while cooking — the screen stays awake), the
 * honesty-gated nutrition block, and the three actions — Log it (the one pine
 * action, with the undercount DISCLOSED before stamping when a line could not
 * be priced), Add to grocery list (pre-checked picker), Edit.
 *
 * A priced line snapshots its per-batch macros at that moment and survives
 * later catalog churn (the 0018 stamp discipline).
 *
 * ## The owner's device pass, 2026-08-12 — LINKING IS GONE
 *
 * It came off this exact screen: a Coach-written stir-fry showing five "Not
 * counted yet" rows, five buttons reading LINK, and no nutrition. *"What is the
 * link functionality there?"*, then: *"…removing this whole 'linking' behavior
 * in exchange for it being done automatically behind the scenes."*
 *
 * **The chore is gone; the provenance is not.** Explicit resolution was never
 * about the tapping — it was about a number of unknown origin entering the
 * rollup, the logged meal and the day's totals wearing the same face as one the
 * user asserted. So the screen prices every line itself, on open, and each line
 * says WHO priced it: `matched` (an exact catalog food), `estimated` (a model),
 * or `counts as 0`. The per-serving figures carry the same fact as a tally, so
 * "computed" can never quietly mean two different things
 * (src/lib/recipes/estimate.ts, and the 0034 header for the schema half).
 *
 * Two passes, on focus: the **catalog** pass is deterministic, offline, free
 * and idempotent, so it runs every time; the **model** pass runs once per
 * screen visit and only if something is still unpriced and a key is set. With
 * no key the lines stay honestly unresolved and the screen says why.
 *
 * **The food search survives as the CORRECTION path**, not as a chore: it opens
 * from a line's own row, phrased as changing what the line counts as, and is
 * what a wrong automatic match is fixed with. A hand pick still records itself
 * as `user` and is never overwritten by a later automatic pass.
 *
 * **A photo.** *"Have the option to add a photo to the recipe."* One image per
 * recipe (`recipes.photo_file_name`), stored under Documents by base name and
 * kept for good — unlike a meal photo, which expires in a week, because a
 * cookbook that deletes its own pictures is broken
 * (src/lib/media/recipe-photo-store.ts).
 *
 * ## Conformed Set surface system (00-design-spec.md §1)
 *
 *   Ingredients   → **ruled plate**: a list of lines with their state is a
 *                   record, and a record is a table. Rows are separated by
 *                   `Divider`, never `border-t` (which draws a full rectangle in
 *                   React Native — see src/components/ui/block.tsx). Dropped
 *                   through empty: a plate closes a record, and a recipe with no
 *                   lines has none to close.
 *   Photo         → **no device**: an image is content, and a drafting
 *                   container round a photograph says nothing about it.
 *   Per serving   → **grid**, which draws nothing. The figures are legible from
 *                   alignment alone, and they appear ONLY through the honesty
 *                   gate; otherwise the sentence names what could not be priced.
 *   Steps         → **ruled plate** of numbered rows. The number is a measured
 *                   position, so it is mono; the instruction is prose, so serif.
 *   Notes         → **margin annotation**, which draws nothing.
 *
 * **Accent budget: one, in every state.** The default state spends it on
 * `Log it`; while the log sheet is open it is that sheet's `Log`, and while the
 * grocery picker is open it is `Add N items` — the three are mutually exclusive
 * branches, so exactly one pine element is ever on screen. Everything else is
 * outlined or bare ink, including the line editor's `Use it` (which CAN coexist
 * with `Log it` and so must not be pine) and the picker's check marks, which are
 * neutral ink: a selection is not a biological state and not the next action.
 */

type Loaded = {
  recipe: RecipeRow;
  lines: RecipeIngredientRow[];
  nutrition: RecipeNutrition;
  /** Non-negligible lines still carrying no numbers, after the catalog pass. */
  unpriced: number;
  /** A `file://` URI, or null — which is both "no photo" and "the file is
   *  gone", because a broken frame is worse than no frame. */
  photoUri: string | null;
  timesCooked: number;
  lastCooked: string | null;
};

/**
 * Read the recipe, running the DETERMINISTIC pricing pass first.
 *
 * The catalog pass is offline, free and idempotent — it touches only lines
 * nothing has priced — so it belongs on every read rather than behind a button.
 * That also means recipes saved before 0034, and lines added to a recipe since,
 * are priced the first time the screen is opened, with no migration and no
 * backfill job.
 */
function load(id: string): Loaded | null {
  const db = getDb();
  if (!getRecipe(db, id)) return null;
  catalogResolveRecipe(db, id);
  const recipe = getRecipe(db, id)!;
  return {
    recipe,
    lines: listIngredients(db, id),
    nutrition: recipeNutrition(db, id),
    unpriced: unpricedLines(db, id).length,
    // Native-guarded and total: on a runtime with no file-system module (the
    // web logic-check preview, the headless render suite) this is null and the
    // screen simply has no photo.
    photoUri: recipePhotoUri(db, id),
    ...recipeCookStats(db, id),
  };
}

export default function RecipeDetailScreen() {
  // Cook mode: the screen stays on while a recipe is open. Guarded — the module
  // is not in this binary, and a static import here was a startup error for the
  // WHOLE app, not just this screen (src/lib/media/keep-awake.ts).
  useKeepScreenAwake('recipe-detail');
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
  const [photoBusy, setPhotoBusy] = useState(false);
  const [pricing, setPricing] = useState(false);
  /** The model's own assumptions from the pricing pass ("2 tbsp butter assumed
   *  at 28 g"). Shown with the figures — an estimate that cannot state its
   *  assumptions is worse than none. */
  const [pricingNotes, setPricingNotes] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  // The pricing pass is a live model stream. Leaving mid-call must stop it, or
  // it runs to completion, is billed in full, and lands on an unmounted screen
  // — the app/recipe-import.tsx precedent.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const reload = useCallback(() => {
    setData(load(recipeId));
    setDeleteArmed(false);
  }, [recipeId]);

  /**
   * Pass 2 — the model prices whatever the catalog could not.
   *
   * **In the focus callback, not a render effect.** It is a navigation event
   * ("this screen just opened"), and the two facts it needs — is anything
   * unpriced, and what is this recipe called — are read from the database
   * rather than from render state, so it depends on nothing that changes while
   * it runs. Its cleanup aborts the call on blur.
   *
   * **Once per recipe, and only when there is something to price.**
   * `askedRef` holds the recipe id it already asked about, which is what stops
   * a paid round trip on every single focus for a recipe holding a line nothing
   * can price ("a handful of parsley"). Opening a different recipe, or coming
   * back after the screen unmounts, asks again.
   */
  const askedRef = useRef('');
  const priceRemaining = useCallback(() => {
    const title = getRecipe(getDb(), recipeId)?.title;
    if (!title) return undefined;
    if (askedRef.current === recipeId) return undefined;
    if (unpricedLines(getDb(), recipeId).length === 0) return undefined;
    if (!isRecipePricingAvailable()) return undefined;
    askedRef.current = recipeId;
    const controller = new AbortController();
    abortRef.current = controller;
    setPricing(true);
    void resolveRecipeWithModel(getDb(), recipeId, title, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setPricingNotes(result.notes);
        reload();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setMessage(
          error instanceof RecipePricingUnavailableError
            ? error.message
            : 'Couldn’t work out the remaining ingredients. Tap a line to set it by hand.'
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setPricing(false);
      });
    // Leaving mid-call stops it: it would otherwise run to completion, be
    // billed in full, and land on a screen nobody is looking at.
    return () => controller.abort();
  }, [recipeId, reload]);

  useFocusEffect(
    useCallback(() => {
      reload();
      return priceRemaining();
    }, [reload, priceRemaining])
  );

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

  const { recipe, lines, nutrition, photoUri } = data;
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

  /**
   * Attach or replace the recipe's photo. `expo-image-picker` is not in this
   * binary yet, so `unavailable` is a SENTENCE, never a dead button — the same
   * contract app/meal-estimate.tsx uses.
   */
  const choosePhoto = async () => {
    setMessage(null);
    setPhotoBusy(true);
    try {
      const picked = await pickPhotoBase64();
      if (picked.kind === 'canceled') return;
      if (picked.kind === 'unavailable') {
        setMessage(
          'Adding a photo needs the next app build (the photo-library module isn’t in this one yet).'
        );
        return;
      }
      if (picked.kind === 'failed') {
        setMessage('Couldn’t read that photo. Try another one.');
        return;
      }
      if (setRecipePhoto(getDb(), recipe.id, picked.base64Jpeg) === null) {
        setMessage('Couldn’t save that photo.');
        return;
      }
      reload();
    } finally {
      setPhotoBusy(false);
    }
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

      {/* THE PHOTO (0034). Drawn at a 4:3 frame — the stored JPEG is 1024px
          wide and its height is whatever the plate was, and unlike a meal photo
          this one is not read for evidence, so a consistent frame beats a
          per-recipe aspect here. A recipe with no photo draws NO frame: the
          control that adds one lives with the other actions below the fold of
          this block, so an empty placeholder never sits at the top of the sheet.

          **No device.** A photograph is content, and none of the six drafting
          containers says anything true about one. It gets a whole 1px hairline
          so it does not bleed into the sheet — never a one-sided width with a
          colour class, which React Native paints as a full rectangle. */}
      {photoUri ? (
        <View className="mt-4">
          <View className="w-full overflow-hidden border border-hairline bg-paper-dim">
            <Image
              source={{ uri: photoUri }}
              resizeMode="cover"
              accessibilityLabel={`Photo of ${recipe.title}`}
              style={{ width: '100%', aspectRatio: 4 / 3 }}
            />
          </View>
        </View>
      ) : null}

      {/* INGREDIENTS — raw lines with resolution state. The plate goes round the
          rows, never round the empty: before the first line there is no record
          to close, only a sentence. */}
      <View className="mt-5">
        {/* The tally rides the label: how many of these lines carry numbers,
            true whether or not the rows are read. */}
        <SectionLabel
          label="Ingredients"
          note={
            lines.length > 0 ? `${nutrition.countedCount} of ${lines.length} priced` : undefined
          }
        />
        {/* The model pass, while it runs. It is the screen doing work the user
            used to be handed, so it says so — quietly, and only while true. */}
        {pricing ? (
          <View className="mt-2 flex-row items-center gap-2">
            <ActivityIndicator color={palette.inkSecondary} size="small" />
            <Text className="flex-1 font-serif text-[13px] leading-5 text-ink-secondary">
              Working out the lines that aren’t in your food catalog…
            </Text>
          </View>
        ) : null}
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
                  editing={linkingId === line.id}
                  onToggleEdit={() => setLinkingId(linkingId === line.id ? null : line.id)}
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
            /* The gate is shut — which since 0034 means something nothing could
               price, not something nobody has got round to. So the sentence
               names the state and the remedy honestly, and differs by WHY:
               with no model key the remaining lines are waiting on one, not on
               the user's patience. */
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
              {pricing
                ? 'Working the numbers out now.'
                : isRecipePricingAvailable()
                  ? `${nutrition.unresolvedCount} ingredient${
                      nutrition.unresolvedCount === 1 ? '' : 's'
                    } couldn’t be priced — the quantity is too vague to convert. Tap the line to set what it counts as, or mark it “counts as 0”.`
                  : `${nutrition.unresolvedCount} ingredient${
                      nutrition.unresolvedCount === 1 ? '' : 's'
                    } aren’t in your food catalog. Add a model key in Settings › Coach and they’ll be worked out automatically — or tap a line to set it yourself.`}
            </Text>
          ) : (
            /* The gate has two halves, and this is the other one: every line is
               resolved or negligible, but NOTHING is counted — a recipe of
               water, salt and pepper. Saying "0 ingredients unresolved" there
               told the user to fix a list with nothing wrong in it. */
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
              Nothing here counts toward nutrition — every line is marked “counts as 0”.
            </Text>
          )}

          {/* WHAT THE FIGURES ARE MADE OF. `complete` says they add up; this
              says how they were reached, and it is drawn whenever ANY counted
              line came from a model. Without it "computed" would quietly mean
              two different things — the exact confusion 0034 exists to
              prevent. */}
          {nutrition.complete && nutrition.estimatedCount > 0 ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-muted">
              {nutrition.estimatedCount} of {nutrition.countedCount} priced lines are
              <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink-muted">
                {' '}
                estimated{' '}
              </Text>
              rather than matched to a food in your catalog.
            </Text>
          ) : null}
          {pricingNotes.length > 0 ? (
            <View className="mt-2">
              {pricingNotes.map((note) => (
                <Text key={note} className="font-serif text-[13px] leading-5 text-ink-secondary">
                  {note}
                </Text>
              ))}
            </View>
          ) : null}
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
          lines={lines}
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

          {/* The photo controls. Outlined, never the accent — `Log it` above is
              this screen's one. Replace and Remove appear only once there IS a
              photo: a control that does nothing is worse than no control. */}
          <View className="mt-2 flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={photoUri ? 'Replace the recipe photo' : 'Add a photo'}
              accessibilityState={{ disabled: photoBusy }}
              disabled={photoBusy}
              onPress={() => void choosePhoto()}
              className="min-h-[46px] flex-1 flex-row items-center justify-center gap-2 rounded-btn border border-hairline px-3 active:bg-paper-dim">
              <Ionicons name="image-outline" size={16} color={palette.inkSecondary} />
              <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
                {photoBusy ? 'Working…' : photoUri ? 'Replace photo' : 'Add a photo'}
              </Text>
            </Pressable>
            {photoUri ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove the recipe photo"
                onPress={() => {
                  clearRecipePhoto(getDb(), recipe.id);
                  reload();
                }}
                className="min-h-[46px] items-center justify-center rounded-btn border border-hairline px-4 active:bg-paper-dim">
                <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
                  Remove
                </Text>
              </Pressable>
            ) : null}
          </View>

          {/* One message slot for both async actions — an error is a sentence
              on the sheet, never an alert the user has to dismiss. */}
          {message ? (
            <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
              {message}
            </Text>
          ) : null}
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
 * One ingredient line — a row of the Ingredients plate, so it opens with its
 * own leading `Divider`.
 *
 * ## What the sub-line says, and why it says it in words
 *
 * Every line states HOW IT WAS PRICED, because since 0034 that is the one thing
 * the figures above cannot tell you:
 *
 *   matched      an exact catalog food. The same data a hand pick produces.
 *   estimated    a model priced it. A real estimate, and it says so.
 *   your pick    the user chose the food themselves — the strongest provenance
 *                on the screen, and the only one an automatic pass will never
 *                overwrite.
 *   counts as 0  zero by declaration (water, salt to taste).
 *   not priced   nothing could reach it. An honest gap, not a chore.
 *
 * A blank sub-line on any of these would read as agreement with the per-serving
 * figures above rather than as a statement about this line, which is why all
 * five are written out.
 *
 * ## There is no LINK button any more
 *
 * The whole row is the control: tapping it opens {@link LineEditor} to change
 * what the line counts as. That is a CORRECTION, offered on every line rather
 * than a chore demanded of the unresolved ones — which is the difference the
 * owner asked for (2026-08-12). The "counts as 0" toggle moved inside the
 * editor for the same reason: it is a decision about a line, not a permanent
 * button beside it.
 */
function IngredientRow({
  line,
  first,
  editing,
  onToggleEdit,
  onChanged,
}: {
  line: RecipeIngredientRow;
  first: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onChanged: () => void;
}) {
  const resolved = isResolved(line);
  const negligible = line.negligible === 1;

  let provenance: string;
  if (negligible) provenance = 'counts as 0, on purpose';
  else if (!resolved) provenance = 'not priced yet';
  else if (line.resolved_by === 'ai') provenance = 'estimated';
  else if (line.resolved_by === 'user') provenance = 'your pick';
  else provenance = 'matched';

  return (
    <View>
      <Divider first={first} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${line.raw_text}. ${provenance}. Change what this counts as.`}
        accessibilityState={{ expanded: editing }}
        onPress={onToggleEdit}
        className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
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
            <View className="mt-0.5 flex-row items-baseline gap-1.5">
              {/* Measured values in mono, the provenance in the label voice —
                  one is a number, the other is a state. */}
              <Text className="font-mono text-[12px] text-ink-secondary">
                {fmtQty(line.grams!)} g · {fmtInt(line.kcal!)} kcal
              </Text>
              <Text
                className={
                  line.resolved_by === 'ai'
                    ? 'font-label text-[10px] uppercase tracking-[1px] text-ink-muted'
                    : 'font-label text-[10px] uppercase tracking-[1px] text-ink-secondary'
                }>
                {provenance}
              </Text>
              {/* A food deleted from the catalog since: the snapshot is still
                  good, and saying so is what keeps it trustworthy. */}
              {line.food_id === null && line.resolved_by !== 'ai' ? (
                <Text className="font-serif text-[11px] text-ink-muted">food since deleted</Text>
              ) : null}
            </View>
          ) : (
            <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary">
              {provenance}
            </Text>
          )}
        </View>
        <Ionicons
          name={editing ? 'chevron-up' : 'chevron-forward'}
          size={16}
          color={palette.inkMuted}
        />
      </Pressable>
      {editing ? <LineEditor line={line} onChanged={onChanged} /> : null}
    </View>
  );
}

/**
 * Change what a line counts as: pick a catalog food at a weight, hand it back
 * to the automatic passes, or declare it zero.
 *
 * This is the old LinkEditor with its job changed. It is no longer the way a
 * recipe GETS nutrition — the two automatic passes are — it is the way a wrong
 * answer is corrected, so it is reachable from every line rather than only from
 * the unpriced ones, and it leads with what the line currently says.
 *
 * A pick here records `resolved_by = 'user'`, which is what stops a later
 * automatic pass from silently replacing it: `catalogResolveRecipe` skips any
 * line that has a provenance at all.
 *
 * It expands INSIDE the Ingredients plate, so it opens on a `Divider` rather
 * than a `border-t` and carries no device of its own (devices never nest). The
 * two inputs wear the well's own tokens — `border-paper-deep bg-paper-dim`,
 * form (b) of the capture-surface rule — because each field IS the well.
 */
function LineEditor({ line, onChanged }: { line: RecipeIngredientRow; onChanged: () => void }) {
  const [query, setQuery] = useState(line.name ?? '');
  const [results, setResults] = useState<FoodRow[]>(() =>
    line.name ? searchFoods(getDb(), line.name, 5) : []
  );
  const [picked, setPicked] = useState<FoodRow | null>(null);
  const [grams, setGrams] = useState(line.grams !== null ? fmtQty(line.grams) : '');
  const [error, setError] = useState<string | null>(null);
  const negligible = line.negligible === 1;

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
      // 'user' by construction — a hand pick is the strongest provenance there
      // is, and it is what makes this line immune to the automatic passes.
      resolveIngredient(getDb(), line.id, picked!.id, parsedGrams, 'user');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not use this food.');
    }
  };

  return (
    <View>
      <Divider />
      <View className="pb-4 pt-3">
        {/* The two ways out that are not a food pick, offered first because
            they are one tap each. "Counts as 0" is the honest answer for salt;
            "price it again" hands a wrong automatic answer back to the passes
            rather than making the user do their job for them. */}
        <View className="flex-row flex-wrap gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              negligible ? `Count ${line.raw_text} again` : `Mark ${line.raw_text} as counting zero`
            }
            onPress={() => {
              setIngredientNegligible(getDb(), line.id, !negligible);
              onChanged();
            }}
            className="min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline px-3 active:bg-paper-dim">
            <Ionicons
              name={negligible ? 'refresh-outline' : 'remove-circle-outline'}
              size={15}
              color={palette.inkSecondary}
            />
            <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
              {negligible ? 'Count it again' : 'Counts as 0'}
            </Text>
          </Pressable>
          {isResolved(line) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Price ${line.raw_text} again`}
              onPress={() => {
                unresolveIngredient(getDb(), line.id);
                onChanged();
              }}
              className="min-h-[44px] items-center justify-center rounded-btn border border-hairline px-3 active:bg-paper-dim">
              <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
                Price it again
              </Text>
            </Pressable>
          ) : null}
        </View>

        {negligible ? null : (
          <>
            <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
              Or set it to a food from your catalog:
            </Text>
            <TextInput
              accessibilityLabel="Search the food catalog"
              value={query}
              onChangeText={search}
              placeholder="Search the catalog"
              placeholderTextColor={palette.inkMuted}
              autoCapitalize="none"
              autoCorrect={false}
              className="mt-2 border border-paper-deep bg-paper-dim px-3 py-3 font-serif text-[16px] text-ink"
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
                  {food.kcal_100g !== null
                    ? `${fmtInt(food.kcal_100g)} kcal/100g`
                    : 'no energy data'}
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
                  accessibilityLabel="Use this food"
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
                    Use it
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </>
        )}
        {error ? (
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">{error}</Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The Log-it sheet: a portion control, **the ingredients and macros that
 * portion actually amounts to**, and the undercount disclosed BEFORE stamping.
 *
 * ## What the portion comes to, live (owner, 2026-08-12)
 *
 * *"When you click 'Log it' on a recipe, it should bring up a new box that
 * shows all the ingredients and the macros; then changing the amount of
 * servings should edit those displayed numbers in real time."* The sheet used
 * to be a stepper and a single `≈ kcal` line, so "log 1.5 servings" was an act
 * of faith: you could not see what was about to enter the day's ledger, and the
 * one number shown was reconstructed from the per-serving figure rather than
 * from the lines.
 *
 * Now every keystroke runs `scaleRecipeLines` — **the same function
 * `logRecipe` writes through** (src/lib/db/repositories/recipes.ts) — so the
 * rows on this sheet are the meal items that will land, not a parallel
 * estimate of them. The totals are `scaledTotals` over those rows, which is
 * why the ledger reconciles: the figure at the top is the sum of the lines
 * beneath it, both derived from one call.
 *
 * Rounding follows the house precedent (app/meal-estimate.tsx): sum the
 * unrounded values, round for display. A total can therefore sit a kcal off the
 * sum of the rounded lines beside it; the alternative — summing rounded lines —
 * would print a total the write does not produce, which is the worse of the two.
 *
 * **Three line states, three treatments**, because they mean three different
 * things: a counted line shows its scaled grams and energy; an uncounted one
 * says so in words and is what the undercount warning is counting; a negligible
 * one is struck through and reads "counts as 0". A blank sub-line on any of
 * them would read as agreement with the total above.
 *
 * ## Devices
 *
 * The sheet itself carries **no device**: this is a group of controls, not a
 * record (the reasoning is in src/components/nutrition/log-sheet.tsx). Inside
 * it, two siblings — never nested, since devices never nest:
 *
 *   For this portion → **grid**, which draws no box; the figures line up on
 *                      their own, exactly as the Per-serving block above does.
 *   Ingredients      → **ruled plate**: the lines about to be logged are a
 *                      record, and a record is a table.
 *
 * It replaces the `Log it` button rather than joining it, so its `Log` is the
 * screen's one accent while it is open.
 */
function LogSheet({
  recipe,
  lines,
  onDone,
  onCancel,
}: {
  recipe: RecipeRow;
  lines: RecipeIngredientRow[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [servings, setServings] = useState(1);
  const [gramsMode, setGramsMode] = useState(false);
  const [grams, setGrams] = useState('');
  const [logError, setLogError] = useState<string | null>(null);

  const parsedGrams = Number(grams);
  // One definition of what a portion means, shared with the write: the sheet
  // asks the repository rather than re-deriving the ratio (a half-typed number
  // is a null factor here, not a thrown error).
  const portion: RecipePortion = gramsMode ? { grams: parsedGrams } : { servings };
  const factor = portionFactorOrNull(recipe, portion);
  const canLog = factor !== null;
  const scaled = factor === null ? [] : scaleRecipeLines(lines, factor);
  const totals = scaledTotals(scaled);
  const uncountedCount = scaled.filter((l) => l.state === 'uncounted').length;
  const countedCount = scaled.filter((l) => l.state === 'counted').length;

  const log = () => {
    if (!canLog) return;
    const now = new Date();
    const result = logRecipe(getDb(), recipe.id, portion, {
      date: todayISODate(),
      time: clockFromISO(now.toISOString()),
    });
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
            <Text className="mt-0.5 font-mono text-[12px] text-ink-muted">
              of {fmtQty(recipe.servings)}
            </Text>
          </View>
        </View>
      )}

      {/* FOR THIS PORTION — what the day's ledger is about to receive. A grid
          draws no box; the columns line up on their own. Every figure moves
          with the control above it, because both come from the same scale. */}
      <View className="mt-6">
        <Block device="grid">
          <SectionLabel
            label="For this portion"
            note={
              countedCount > 0
                ? `${countedCount} of ${scaled.length} counted`
                : `0 of ${scaled.length} counted`
            }
          />
          <View className="mt-2 flex-row items-baseline gap-1.5">
            {/* No data, no number: an em-dash, never a stand-in zero. */}
            <Text className="font-mono text-[26px] font-semibold text-ink">
              {totals.kcal === null ? '—' : fmtInt(totals.kcal)}
            </Text>
            <Text className="font-mono text-[13px] text-ink-muted">kcal</Text>
          </View>
          <View className="mt-2 flex-row flex-wrap">
            {(
              [
                ['protein', totals.protein_g],
                ['carbs', totals.carbs_g],
                ['fat', totals.fat_g],
              ] as [string, number | null][]
            ).map(([label, value], index, all) => (
              <GridCell key={label} index={index} count={all.length} columns={3}>
                <View>
                  <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
                    {label}
                  </Text>
                  <View className="mt-1 flex-row items-baseline gap-1">
                    <Text className="font-mono text-[17px] font-semibold text-ink">
                      {value === null ? '—' : fmtQty(value)}
                    </Text>
                    {value === null ? null : (
                      <Text className="font-mono text-[10px] text-ink-muted">g</Text>
                    )}
                  </View>
                </View>
              </GridCell>
            ))}
          </View>
        </Block>
      </View>

      {/* INGREDIENTS at this portion — the rows that make up the figures above,
          and literally the meal items about to be written. */}
      {scaled.length > 0 ? (
        <View className="mt-6">
          <SectionLabel label="Ingredients" />
          <View className="mt-2">
            <Block device="plate">
              {scaled.map((line, index) => (
                <View key={line.id}>
                  <Divider first={index === 0} />
                  <View className="min-h-[44px] flex-row items-center gap-3 py-2.5">
                    <View className="flex-1">
                      <Text
                        className={
                          line.state === 'negligible'
                            ? 'font-serif text-[15px] leading-5 text-ink-muted line-through'
                            : 'font-serif text-[15px] leading-5 text-ink'
                        }>
                        {line.raw_text}
                      </Text>
                      {/* Every state says what it is in words. A blank sub-line
                          under an uncounted row would read as agreement with
                          the total above it. */}
                      {line.state === 'counted' ? (
                        <Text className="mt-0.5 font-mono text-[11px] text-ink-secondary">
                          {line.grams === null ? '' : `${fmtQty(line.grams)} g`}
                        </Text>
                      ) : line.state === 'negligible' ? (
                        <Text className="mt-0.5 font-serif text-[12px] leading-4 text-ink-secondary">
                          counts as 0, on purpose
                        </Text>
                      ) : (
                        <Text className="mt-0.5 font-serif text-[12px] leading-4 text-ink-secondary">
                          not counted — logs by name only
                        </Text>
                      )}
                    </View>
                    <Text
                      className={
                        line.kcal === null
                          ? 'font-mono text-[13px] text-ink-muted'
                          : 'font-mono text-[13px] text-ink-secondary'
                      }>
                      {line.kcal === null ? '—' : fmtInt(line.kcal)}
                    </Text>
                  </View>
                </View>
              ))}
            </Block>
          </View>
        </View>
      ) : null}

      {uncountedCount > 0 ? (
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
          {uncountedCount} ingredient
          {uncountedCount === 1 ? ' isn’t' : 's aren’t'} counted — this logs below the real intake.
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
