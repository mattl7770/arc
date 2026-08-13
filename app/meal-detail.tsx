import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Image, Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider, GridCell } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import { getFood } from '@/lib/db/repositories/foods';
import { saveMealAsTemplate } from '@/lib/db/repositories/meal-templates';
import { saveMealAsRecipe } from '@/lib/db/repositories/recipes';
import {
  getMeal,
  listMealItems,
  relogMeal,
  removeMealItem,
  updateMealItemPortion,
  updateMealTime,
} from '@/lib/db/repositories/nutrition';
import {
  deleteMealWithPhotos,
  mealPhotoView,
  type MealPhotoView,
} from '@/lib/media/meal-photo-store';
import { fmtInt, fmtQty, macroLine, portionLabel } from '@/lib/nutrition/format';
import { mealDayLabel, parseClockParts, partsFromClock, shiftDay } from '@/lib/nutrition/meal-time';
import { gramsForQty, rescaleLoggedItem } from '@/lib/nutrition/servings';
import type { FoodRow, MealItemWithServing, MealRow } from '@/lib/nutrition/types';

/**
 * One meal's record (docs/nutrition-subapp.md §2): its items with portions and
 * snapshots, add-food into it, "Log again" (the copy-from-yesterday loop), and
 * delete. Free-form meals (no items) show their directly-recorded totals; once
 * items exist, the repository owns the totals.
 *
 * ## Two additions from the owner's device pass, 2026-08-12
 *
 * **The time is editable.** A meal's clock time — and its DAY — could not be
 * corrected once logged, which made a meal eaten at 00:40 and belonging to the
 * evening before permanently wrong. The control sits on the value it changes:
 * the date/time line at the top of this screen carries a "Change" beside it and
 * opens {@link MealTimeEditor} directly beneath. It is deliberately NOT also on
 * the Eaten-today row (app/nutrition.tsx) — that row is a single tap target
 * whose whole job is to open this screen, and a second control inside it would
 * both fight that target and put an editor on a list where the edit's
 * consequence (the day's totals, right above it) cannot be shown.
 *
 * The day boundary is a supported crossing, not a guarded one: moving a meal to
 * another date moves its energy off one day's totals and onto another's with
 * nothing to recompute, because every nutrition read groups `meals` by the
 * `date` column at read time. The reasoning and the test are on `updateMealTime`
 * (src/lib/db/repositories/nutrition.ts).
 *
 * **The photo is shown.** A meal logged through the estimator now keeps the
 * image it was estimated from (0033), and it is drawn here at its own aspect
 * with the retention stated under it. A meal with no photo draws NOTHING —
 * no frame, no placeholder, no "add a photo" control that this binary could not
 * honour (00-design-spec.md §5). Deleting the meal deletes the file, which is
 * why {@link deleteMealWithPhotos} stands in for `deleteMeal` here.
 *
 * ## Conformed Set surface system
 *
 *   Photo    → **no device**: an image is content, and a drafting container
 *              round a photograph says nothing about it. A 1px hairline frames
 *              the bleed and that is all — a whole border, never a one-sided
 *              width with a colour class.
 *   Totals   → **grid**: energy and macros are a metric grid, so the grid is the
 *              object — no outer box, drawn by the rules that run between its
 *              cells (src/components/ui/block.tsx).
 *   Notes    → **margin annotation**: prose belongs in the margin, not a card.
 *   Items    → **ruled plate**: a record is a table, drawn in both the itemized
 *              and the free-form state. "Add food" is its closing row, so the
 *              way to extend the record sits with the record.
 *   Actions  → **ruled plate**: another list of things you can do.
 *   When     → **no device**: a form is controls, not content — form (b) of the
 *              capture-surface rule, each field wearing `border-paper-deep
 *              bg-paper-dim` directly with no well around it.
 *
 * **The ledger rule.** Once a meal is itemized, `recomputeMealTotals` writes the
 * meal's own kcal/macro columns as the item sums inside the same transaction as
 * every item change — so the Totals grid IS the sum of the item rows below it,
 * and the Items label repeats that figure to make the arithmetic checkable.
 * (Adding the first item to a free-form meal preserves its typed totals as an
 * "(as logged)" item, so the two never silently diverge.) A free-form meal
 * carries no such note, because there is nothing to reconcile against.
 *
 * **Accent budget: one.** An open editor's Save — and this screen now has two
 * editors (portion, time), so they are MUTUALLY EXCLUSIVE: opening either
 * closes the other. That is what keeps the budget a ceiling rather than a
 * quota, and it is enforced in the open handlers, not by convention.
 */

type MealState = {
  meal: MealRow | undefined;
  items: MealItemWithServing[];
  /** The meal's photo, or null — which is both "no photo" and "the file is
   *  gone", because a broken frame is worse than no frame (0033). */
  photo: MealPhotoView | null;
};

/** The inline portion-editor's state for one item. `food` is the catalog food
 * if still present (enables the serving stepper + accurate re-derive). */
type ItemEdit = {
  itemId: string;
  food: FoodRow | undefined;
  mode: 'serving' | 'grams';
  qty: number;
  gramsText: string;
};

/** The when-editor's draft. Held apart from the row so backing out writes
 *  nothing — nothing is saved until Save. */
type TimeEdit = { date: string; hour: string; minute: string };

function readMeal(id: string): MealState {
  const db = getDb();
  return {
    meal: getMeal(db, id),
    items: listMealItems(db, id),
    // Native-guarded and total: on a runtime with no file system module (the
    // web logic-check preview, the headless render suite) this is null and the
    // screen simply has no photo section.
    photo: mealPhotoView(db, id),
  };
}

/** A typed grams value safe to log: finite, positive, under a sanity ceiling
 * (paste / hardware keyboards get past the numeric soft keyboard). */
function parseGrams(text: string): number | null {
  const g = Number(text.trim());
  return Number.isFinite(g) && g > 0 && g <= 5000 ? g : null;
}

/**
 * One macro cell. An unrecorded macro is an em-dash — no data, no number.
 *
 * It carries no wrapper of its own: the `GridCell` around it owns the column
 * width, the padding and the rules between cells (src/components/ui/block.tsx),
 * so this is only the contents of a cell.
 */
function MacroCell({ label, grams }: { label: string; grams: number | null }) {
  return (
    <>
      <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {label}
      </Text>
      <View className="mt-1 flex-row items-baseline gap-1">
        <Text className="font-mono text-lg font-semibold text-ink">
          {grams != null ? Math.round(grams) : '—'}
        </Text>
        {grams != null ? <Text className="font-mono text-[10px] text-ink-muted">g</Text> : null}
      </View>
    </>
  );
}

/** One ruled row of an action plate. */
function ActionRow({
  icon,
  label,
  detail,
  first,
  disabled,
  trailing,
  accessibilityLabel,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  detail?: string;
  first: boolean;
  disabled?: boolean;
  trailing?: keyof typeof Ionicons.glyphMap;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <View>
      <Divider first={first} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: disabled === true }}
        disabled={disabled}
        onPress={onPress}
        className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
        <Ionicons name={icon} size={17} color={palette.inkSecondary} />
        <View className="flex-1">
          <Text className="font-serif text-[15px] text-ink">{label}</Text>
          {detail ? (
            <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-muted">{detail}</Text>
          ) : null}
        </View>
        <Ionicons name={trailing ?? 'chevron-forward'} size={16} color={palette.inkMuted} />
      </Pressable>
    </View>
  );
}

export default function MealDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const mealId = id ?? '';

  const [state, setState] = useState<MealState>(() => readMeal(mealId));
  // Two-tap delete: first tap arms, second deletes. No native alert drama.
  const [deleteArmed, setDeleteArmed] = useState(false);
  // Transient confirmation after saving a template.
  const [savedTemplate, setSavedTemplate] = useState(false);
  // Transient confirmation after saving into the recipe book.
  const [savedRecipe, setSavedRecipe] = useState(false);
  // The item whose portion is being edited inline, prefilled from its snapshot.
  const [editing, setEditing] = useState<ItemEdit | null>(null);
  // The when-editor's draft, or null when it is closed.
  const [timeEdit, setTimeEdit] = useState<TimeEdit | null>(null);

  const reload = useCallback(() => {
    setState(readMeal(mealId));
    // Regaining focus disarms a pending delete — a confirm must be two taps in
    // a row, not one tap now and a fatal one after a detour through Add food.
    setDeleteArmed(false);
    // And clears a stale "Saved" — the meal may have changed since, so the old
    // confirmation would misrepresent the current state (and a fresh save is a
    // deliberate new template, not this one re-tapped).
    setSavedTemplate(false);
    setSavedRecipe(false);
    setEditing(null);
    // A draft that survived a detour would be editing a meal that may since
    // have moved — and its Save would silently overwrite the newer value.
    setTimeEdit(null);
  }, [mealId]);
  useFocusEffect(reload);

  const { meal, items, photo } = state;
  const today = todayISODate();

  /** Open the inline portion editor for a logged item, prefilled from its
   * snapshot. Re-derives from the catalog food when present; falls back to
   * grams-only proportional editing otherwise. */
  const beginEdit = (item: MealItemWithServing) => {
    const food = item.food_id ? getFood(getDb(), item.food_id) : undefined;
    // A food-less item with no grams has no portion to re-scale — leave it be.
    if (!food && item.grams == null) return;
    const canServing = food?.serving_grams != null;
    // One editor at a time — that is what keeps the accent budget a ceiling.
    setTimeEdit(null);
    setEditing({
      itemId: item.id,
      food,
      mode: canServing && item.serving_qty != null ? 'serving' : 'grams',
      qty: item.serving_qty ?? 1,
      gramsText: fmtQty(item.grams ?? food?.serving_grams ?? 100),
    });
  };

  const stepQty = (delta: number) => {
    setEditing((prev) => {
      if (!prev || !prev.food) return prev;
      const qty = Math.min(50, Math.max(0.5, prev.qty + delta));
      const grams = gramsForQty(prev.food, qty);
      return {
        ...prev,
        mode: 'serving',
        qty,
        gramsText: grams != null ? fmtQty(grams) : prev.gramsText,
      };
    });
  };

  const saveEdit = () => {
    if (!editing) return;
    const item = items.find((i) => i.id === editing.itemId);
    if (!item) return setEditing(null);
    let update: ReturnType<typeof rescaleLoggedItem>;
    if (editing.mode === 'serving' && editing.food) {
      if (editing.qty <= 0) return;
      update = rescaleLoggedItem(item, editing.food, { servingQty: editing.qty });
    } else {
      const grams = parseGrams(editing.gramsText);
      if (grams === null) return;
      update = rescaleLoggedItem(item, editing.food, { grams });
    }
    if (!update) return setEditing(null);
    updateMealItemPortion(getDb(), editing.itemId, update);
    setEditing(null);
    reload();
  };

  if (!meal) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Meal" />
        </View>
        <Text className="mt-6 font-serif text-[14px] leading-6 text-ink-secondary">
          This meal is gone — it may have been deleted.
        </Text>
      </Screen>
    );
  }

  const removeItem = (itemId: string) => {
    removeMealItem(getDb(), itemId);
    reload();
  };

  const logAgain = () => {
    const now = new Date();
    relogMeal(getDb(), meal.id, todayISODate(), clockFromISO(now.toISOString()));
    router.back();
  };

  const onDelete = () => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    // NOT `deleteMeal`: the 0033 CASCADE takes the photo ROWS and leaves the
    // bytes on disk forever. This is the one call that clears both.
    deleteMealWithPhotos(getDb(), meal.id);
    router.back();
  };

  /** Open the when-editor on the meal's current values, or close it. Closing
   *  discards the draft — backing out of an edit writes nothing. */
  const toggleTimeEdit = () => {
    if (timeEdit) return setTimeEdit(null);
    // One editor at a time (see the accent-budget note in the header).
    setEditing(null);
    const parts = partsFromClock(meal.time);
    setTimeEdit({ date: meal.date, hour: parts.hour, minute: parts.minute });
  };

  /** Write the re-timed meal. The day boundary needs no special handling —
   *  every nutrition read groups `meals` by `date` at read time, so both days'
   *  totals follow from this single UPDATE (see `updateMealTime`). */
  const saveTime = () => {
    if (!timeEdit) return;
    const parsed = parseClockParts(timeEdit.hour, timeEdit.minute);
    if (parsed.kind === 'invalid') return;
    updateMealTime(getDb(), meal.id, {
      date: timeEdit.date,
      time: parsed.kind === 'time' ? parsed.value : null,
    });
    setTimeEdit(null);
    reload();
  };

  // Save this meal into the recipe book (one batch = this meal's amounts).
  // Alert.prompt is iOS-only — fine, ARC is iOS-only.
  const saveAsRecipe = () => {
    Alert.prompt(
      'Save as recipe',
      'Name it; servings default to 1 (this meal = one batch).',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          onPress: (name?: string) => {
            const trimmed = (name ?? '').trim() || meal.name;
            const id = saveMealAsRecipe(getDb(), meal.id, trimmed, 1);
            if (id) setSavedRecipe(true);
          },
        },
      ],
      'plain-text',
      meal.name
    );
  };

  // Save this itemized meal as a reusable template. Alert.prompt is iOS-only —
  // fine, ARC is iOS-only — and defaults to the meal's name.
  const saveAsTemplate = () => {
    Alert.prompt(
      'Save as template',
      'Name it so you can log it again in one tap.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          onPress: (name?: string) => {
            const trimmed = (name ?? '').trim() || meal.name;
            const id = saveMealAsTemplate(getDb(), meal.id, trimmed);
            if (id) setSavedTemplate(true);
          },
        },
      ],
      'plain-text',
      meal.name
    );
  };

  const macroCells: { label: string; grams: number | null }[] = [
    { label: 'Protein', grams: meal.protein_g },
    { label: 'Carbs', grams: meal.carbs_g },
    { label: 'Fat', grams: meal.fat_g },
  ];

  // The items are the arithmetic behind the meal's own kcal column — say so,
  // but only when there are items to reconcile against.
  const itemsNote = items.length > 0 && meal.kcal != null ? `${fmtInt(meal.kcal)} kcal` : undefined;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={meal.name} />
      </View>

      {/* When it was eaten, and the control that changes it — on the value
          itself rather than buried in the Actions plate below, so the editor
          opens under the line it edits. The affordance is set in the label
          voice because it is a control (00-design-spec.md §3); the date and
          time beside it stay mono because they are measurements. Same split,
          same anatomy as the Today corner in app/nutrition.tsx. */}
      <View className="mt-1 flex-row items-baseline gap-2">
        <Text className="font-mono text-[11px] text-ink-muted">
          {/* An untimed meal reads as an em-dash rather than as a bare date.
              With a control here now, "no time recorded" has to be visible —
              it is the state the control exists to change, and §5's answer for
              an absent value is a dash, not a gap. The Eaten-today row already
              draws it this way. */}
          {meal.date} · {meal.time ?? '—'}
        </Text>
        {meal.source === 'ai_suggested' ? (
          <Text className="font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
            est · AI
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            timeEdit
              ? 'Stop changing when this meal was eaten'
              : 'Change the date and time of this meal'
          }
          accessibilityState={{ expanded: timeEdit !== null }}
          hitSlop={16}
          onPress={toggleTimeEdit}
          className="ml-auto active:opacity-60">
          <Text className="font-label text-[11px] uppercase tracking-[1.2px] text-ink-secondary">
            {timeEdit ? 'Cancel' : 'Change'}
          </Text>
        </Pressable>
      </View>

      {timeEdit ? (
        <MealTimeEditor
          edit={timeEdit}
          originalDate={meal.date}
          today={today}
          onChange={setTimeEdit}
          onSave={saveTime}
        />
      ) : null}

      {/* The photo the estimate was made from (0033). Drawn at its own aspect —
          no crop, no guessed square — and only when there is one: a meal
          without a photo draws nothing at all rather than an empty frame. */}
      {photo ? <MealPhoto photo={photo} name={meal.name} /> : null}

      {/* Totals — the meal's own columns: item sums when itemized, the typed
          numbers when free-form. */}
      <View className="mt-5">
        <Block device="grid">
          <SectionLabel label="Totals" />

          <View className="mt-2 flex-row items-baseline gap-1.5">
            <Text className="font-mono text-3xl text-ink">
              {meal.kcal != null ? fmtInt(meal.kcal) : '—'}
            </Text>
            <Text className="font-mono text-sm text-ink-muted">kcal</Text>
          </View>

          {/* `mt-2` keeps the first cells' top rule off the kcal figure above.
              Three macros in a two-column grid leaves Fat alone on the last
              row: `count` is what tells `GridCell` there is nothing beside it,
              so no vertical rule is drawn into that empty half. */}
          <View className="mt-2 flex-row flex-wrap">
            {macroCells.map((cell, index) => (
              <GridCell key={cell.label} index={index} count={macroCells.length}>
                <MacroCell label={cell.label} grams={cell.grams} />
              </GridCell>
            ))}
          </View>
        </Block>
      </View>

      {meal.notes ? (
        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              {meal.notes}
            </Text>
          </Block>
        </View>
      ) : null}

      {/* Items — the record, with the way to extend it as its closing row. The
          plate is drawn in both states: a free-form meal's Items block still
          stands where the itemized one stands, and the Add-food row that starts
          the record belongs on the same plate as the record. (The sweep of
          2026-08-10 made it conditional; reverted at the owner's instruction.) */}
      <View className="mt-8">
        <Block device="plate">
          <SectionLabel label="Items" note={itemsNote} />

          {items.length === 0 ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              Free-form entry — totals were recorded directly. Add a food to itemize it.
            </Text>
          ) : (
            <View className="mt-1">
              {items.map((item, index) => {
                const portion = portionLabel(item);
                const line = macroLine(item);
                // Editable when there's something to re-scale from: a catalog
                // food (re-derive) or an existing grams (proportional).
                const canEdit = item.food_id != null || item.grams != null;
                const isEditing = editing?.itemId === item.id;
                return (
                  <View key={item.id}>
                    <Divider first={index === 0} />
                    <View className="flex-row items-center gap-3">
                      {/* The 44pt floor and the row's padding both sit on the
                          control, not on this wrapper — the wrapper is
                          items-center, so a floor set here would not reach the
                          Pressable, and padding set here would be dead space
                          outside the tap area. Same shape as the rows in
                          data.tsx and screenings.tsx. */}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={canEdit ? `Edit ${item.name} portion` : item.name}
                        disabled={!canEdit}
                        onPress={() => (isEditing ? setEditing(null) : beginEdit(item))}
                        className="min-h-[44px] flex-1 flex-row items-center gap-3 py-3 active:opacity-60">
                        <View className="flex-1">
                          <Text className="font-serif text-[15px] leading-5 text-ink">
                            {item.name}
                            {item.confidence !== null ? (
                              <Text className="font-mono text-[10px] text-ink-muted">
                                {'  '}≈ {item.confidence}
                              </Text>
                            ) : null}
                          </Text>
                          <Text className="mt-0.5 font-mono text-[10px] leading-4 text-ink-muted">
                            {[portion, line].filter(Boolean).join(' · ') || '—'}
                          </Text>
                        </View>
                        <Text className="font-mono text-[13px] text-ink-secondary">
                          {item.kcal != null ? fmtInt(item.kcal) : '—'}
                        </Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${item.name}`}
                        hitSlop={12}
                        onPress={() => removeItem(item.id)}
                        className="h-8 w-8 items-center justify-center rounded-btn active:opacity-60">
                        <Ionicons name="close" size={16} color={palette.inkMuted} />
                      </Pressable>
                    </View>
                    {isEditing && editing ? (
                      <PortionEditRow
                        edit={editing}
                        item={item}
                        onStep={stepQty}
                        onEditGrams={(t) =>
                          setEditing((prev) =>
                            prev ? { ...prev, mode: 'grams', gramsText: t } : prev
                          )
                        }
                        onSave={saveEdit}
                      />
                    ) : null}
                  </View>
                );
              })}
            </View>
          )}

          <View className="mt-1">
            <ActionRow
              icon="add"
              label="Add food"
              first={false}
              accessibilityLabel="Add food to this meal"
              onPress={() => router.push({ pathname: '/food-search', params: { mealId: meal.id } })}
            />
          </View>
        </Block>
      </View>

      {/* Actions */}
      <View className="mt-8">
        <Block device="plate">
          <ActionRow
            icon="repeat-outline"
            label="Log again"
            detail="Duplicates this meal onto today, timed now"
            first
            accessibilityLabel="Log this meal again now"
            onPress={logAgain}
          />

          {/* Save as template — only meaningful for an itemized meal (a template
              needs items to re-stamp). */}
          {items.length > 0 ? (
            <ActionRow
              icon="albums-outline"
              label="Save as template"
              detail={
                savedTemplate ? 'Saved — find it under “From a template”' : 'Reuse this meal later'
              }
              first={false}
              // Inert once saved: a second tap would silently create a duplicate,
              // and the checkmark reads as "done". Re-enabled on the next visit
              // (reload clears savedTemplate), where a save is a deliberate new one.
              disabled={savedTemplate}
              trailing={savedTemplate ? 'checkmark' : 'chevron-forward'}
              accessibilityLabel="Save this meal as a template"
              onPress={saveAsTemplate}
            />
          ) : null}
        </Block>

        {/* Save as recipe — the MacroFactor assemble-from-timeline pattern
            (docs/recipes-grocery.md §2a): items with usable snapshots arrive
            already food-resolved. Only meaningful for an itemized meal. */}
        {items.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save this meal as a recipe"
            accessibilityState={{ disabled: savedRecipe }}
            disabled={savedRecipe}
            onPress={saveAsRecipe}
            className={`mt-2 flex-row items-center gap-3 rounded-card border border-hairline bg-porcelain px-4 py-3 ${
              savedRecipe ? '' : 'active:bg-paper-deep'
            }`}>
            <Ionicons name="book-outline" size={18} color={palette.inkSecondary} />
            <View className="flex-1">
              <Text className="text-[15px] text-ink">Save as recipe</Text>
              <Text className="mt-0.5 text-xs text-ink-muted">
                {savedRecipe
                  ? 'Saved — find it in the recipe book'
                  : 'Into the book, with these foods as its ingredients'}
              </Text>
            </View>
            {savedRecipe ? (
              <Ionicons name="checkmark" size={18} color={palette.inkSecondary} />
            ) : null}
          </Pressable>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={deleteArmed ? 'Tap again to delete this meal' : 'Delete this meal'}
          onPress={onDelete}
          className="mt-6 min-h-[44px] items-center justify-center active:opacity-60">
          <Text
            className={
              deleteArmed
                ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink'
                : 'font-label text-[12px] uppercase tracking-[1.2px] text-ink-muted'
            }>
            {deleteArmed ? 'Tap again to delete' : 'Delete this meal'}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

/**
 * The photo the meal was estimated from (0033).
 *
 * **Drawn at the photo's own aspect.** The stored JPEG is 1024px wide with its
 * height whatever the plate was, so a fixed square would crop food out of the
 * frame — and a photo you have to remember the rest of is not evidence. The
 * 4:3 fallback is only reached when the source could not report its dimensions
 * (the picker's own base64, when the manipulator is absent); it is a frame, not
 * an invented measurement of this image.
 *
 * **No device.** A photograph is content, and none of the six drafting
 * containers says anything true about one — a plate would claim it is a record,
 * a field would claim it is a verdict. It gets a hairline so it does not bleed
 * into the sheet, drawn as a WHOLE border, which is the form React Native
 * renders correctly (src/components/ui/block.tsx, above `Divider`).
 *
 * The caption states the retention out loud. An image that silently disappears
 * in a week is a surprise; one that says when it goes is a policy the user can
 * plan around — and it is a measured value, so it is mono.
 */
function MealPhoto({ photo, name }: { photo: MealPhotoView; name: string }) {
  const ratio = photo.width != null && photo.height != null ? photo.width / photo.height : 4 / 3;
  const clears =
    photo.clearsInDays <= 0
      ? 'Clears on the next app open'
      : photo.clearsInDays === 1
        ? 'Clears tomorrow'
        : `Clears in ${photo.clearsInDays} days`;
  return (
    <View className="mt-5">
      <View className="w-full overflow-hidden border border-hairline bg-paper-dim">
        <Image
          source={{ uri: photo.uri }}
          resizeMode="cover"
          // VoiceOver gets what the picture IS, not "image". The meal's own name
          // is the only thing on this screen that describes it.
          accessibilityLabel={`Photo of ${name}`}
          style={{ width: '100%', aspectRatio: ratio }}
        />
      </View>
      <Text className="mt-1.5 font-mono text-[10px] text-ink-muted">{clears}</Text>
    </View>
  );
}

/**
 * The when-editor: which day the meal belongs to, and the clock time on it.
 *
 * **No picker, and none wanted.** There is no date/time picker dependency in
 * this project, and adding one is a native module — which costs the owner a
 * full EAS cloud rebuild before the control could be tapped once
 * (01-rn-port-guide.md §5). app/metric-entry.tsx is the house answer to exactly
 * this: typed digits in the mono voice, no wheel. The day is a STEPPER rather
 * than a third and fourth text field because the case that motivated the
 * feature is "this belongs to yesterday" — one tap — and because a stepper
 * cannot produce 2026-02-31.
 *
 * **Forward is clamped at today.** A meal eaten tomorrow is not a fact anyone
 * has, and a control that can write one is a control that will. Backwards is
 * unbounded: re-dating an old meal is rarer, and a repeated tap is the honest
 * cost of it.
 *
 * **No device.** A form is controls, not content — form (b) of the
 * capture-surface rule in src/components/ui/block.tsx: each field wears the
 * well's own `border-paper-deep bg-paper-dim` directly, and the group is named
 * by a `SectionLabel` and set apart by whitespace. An input is never
 * `bg-paper-hi`.
 *
 * Save is this screen's one accent while it is open — the portion editor closes
 * when this one opens, so there is never a second.
 */
function MealTimeEditor({
  edit,
  originalDate,
  today,
  onChange,
  onSave,
}: {
  edit: TimeEdit;
  /** Where the meal is now, so the move can be stated in future tense. */
  originalDate: string;
  today: string;
  onChange: (next: TimeEdit) => void;
  onSave: () => void;
}) {
  const parsed = parseClockParts(edit.hour, edit.minute);
  const invalid = parsed.kind === 'invalid';
  const canGoForward = edit.date < today;
  const hasTyped = edit.hour !== '' || edit.minute !== '';

  // The consequence, in future tense, immediately above the control that
  // performs it (00-design-spec.md §5). Both notes can apply at once — a meal
  // moved to yesterday AND stripped of its time — so they are lines, not a
  // single message that would have to drop one of the two truths.
  const notes: string[] = [];
  if (invalid) {
    notes.push('That isn’t a time — hours run 0–23, minutes 0–59.');
  } else {
    if (edit.date !== originalDate) {
      notes.push(
        `On save: this meal moves off ${originalDate} onto ${edit.date}. Both days’ totals change.`
      );
    }
    if (parsed.kind === 'none') {
      notes.push('On save: this meal loses its time and sorts last in the day.');
    }
  }

  return (
    <View className="mt-5">
      <SectionLabel label="When it was eaten" />

      {/* Day. The readout is the measured value and takes mono; the steppers
          carry their border alone, the way every stepper in this file does. */}
      <View className="mt-2 flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous day"
          hitSlop={6}
          onPress={() => onChange({ ...edit, date: shiftDay(edit.date, -1) })}
          className="h-11 w-11 items-center justify-center rounded-btn border border-hairline active:opacity-60">
          <Ionicons name="chevron-back" size={16} color={palette.ink} />
        </Pressable>
        <View className="flex-1">
          <Text className="text-center font-mono text-[15px] text-ink">
            {mealDayLabel(edit.date, today)}
          </Text>
          <Text className="mt-0.5 text-center font-mono text-[10px] text-ink-muted">
            {edit.date}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next day"
          accessibilityState={{ disabled: !canGoForward }}
          disabled={!canGoForward}
          hitSlop={6}
          onPress={() => onChange({ ...edit, date: shiftDay(edit.date, 1) })}
          className={
            canGoForward
              ? 'h-11 w-11 items-center justify-center rounded-btn border border-hairline active:opacity-60'
              : 'h-11 w-11 items-center justify-center rounded-btn border border-paper-deep'
          }>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={canGoForward ? palette.ink : palette.inkMuted}
          />
        </Pressable>
      </View>

      {/* Time. Two fields and a colon — the shape a clock already has. */}
      <View className="mt-3 flex-row items-center gap-2">
        <TextInput
          value={edit.hour}
          onChangeText={(t) => onChange({ ...edit, hour: t })}
          keyboardType="number-pad"
          maxLength={2}
          placeholder="––"
          placeholderTextColor={palette.inkMuted}
          accessibilityLabel="Hour"
          className="w-14 border border-paper-deep bg-paper-dim px-2 py-2.5 text-center font-mono text-[15px] text-ink"
        />
        <Text className="font-mono text-[15px] text-ink-secondary">:</Text>
        <TextInput
          value={edit.minute}
          onChangeText={(t) => onChange({ ...edit, minute: t })}
          keyboardType="number-pad"
          maxLength={2}
          placeholder="––"
          placeholderTextColor={palette.inkMuted}
          accessibilityLabel="Minute"
          className="w-14 border border-paper-deep bg-paper-dim px-2 py-2.5 text-center font-mono text-[15px] text-ink"
        />
        {/* Only offered when there is something to clear — a control that does
            nothing is worse than no control (§5). An untimed meal is a
            supported state, not a broken one. */}
        {hasTyped ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Record no time for this meal"
            hitSlop={12}
            onPress={() => onChange({ ...edit, hour: '', minute: '' })}
            className="ml-auto min-h-[44px] justify-center active:opacity-60">
            <Text className="font-label text-[11px] uppercase tracking-[1.2px] text-ink-muted">
              No time
            </Text>
          </Pressable>
        ) : null}
      </View>

      {notes.map((note) => (
        <Text key={note} className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
          {note}
        </Text>
      ))}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save when this meal was eaten"
        accessibilityState={{ disabled: invalid }}
        disabled={invalid}
        onPress={onSave}
        className={
          invalid
            ? 'mt-4 min-h-[44px] items-center justify-center rounded-btn border border-paper-deep'
            : 'mt-4 min-h-[44px] items-center justify-center rounded-btn bg-pine active:opacity-70'
        }>
        <Text
          className={
            invalid
              ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
              : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-pine-on'
          }>
          Save
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * The inline portion editor under a tapped item. Serving stepper when the
 * catalog food names a serving; a grams field always. The live "≈ kcal"
 * preview and the Save both go through rescaleLoggedItem, so what you see is
 * exactly what gets written.
 *
 * It draws **no device of its own** — it lives inside the items plate, and
 * devices never nest (src/components/ui/block.tsx). Only the grams input takes
 * the recessed treatment, because an input is a well at control scale.
 *
 * Save is this screen's one accent (only one editor is ever open at a time —
 * opening the when-editor above closes this one, and vice versa).
 */
function PortionEditRow({
  edit,
  item,
  onStep,
  onEditGrams,
  onSave,
}: {
  edit: ItemEdit;
  item: MealItemWithServing;
  onStep: (delta: number) => void;
  onEditGrams: (text: string) => void;
  onSave: () => void;
}) {
  const portion =
    edit.mode === 'serving' && edit.food
      ? { servingQty: edit.qty }
      : { grams: parseGrams(edit.gramsText) ?? 0 };
  const valid = 'servingQty' in portion ? edit.qty > 0 : portion.grams > 0;
  const preview = valid ? rescaleLoggedItem(item, edit.food, portion) : null;

  return (
    <View className="pb-3">
      <View className="flex-row items-center gap-2">
        {edit.food?.serving_grams != null ? (
          <View className="flex-row items-center gap-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Less"
              hitSlop={6}
              onPress={() => onStep(-0.5)}
              className="h-9 w-9 items-center justify-center rounded-btn border border-hairline active:opacity-60">
              <Ionicons name="remove" size={16} color={palette.ink} />
            </Pressable>
            <Text className="w-14 text-center font-mono text-[15px] text-ink">
              {fmtQty(edit.qty)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="More"
              hitSlop={6}
              onPress={() => onStep(0.5)}
              className="h-9 w-9 items-center justify-center rounded-btn border border-hairline active:opacity-60">
              <Ionicons name="add" size={16} color={palette.ink} />
            </Pressable>
            <Text className="ml-1 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
              × {edit.food.serving_name}
            </Text>
          </View>
        ) : null}
        <View className="ml-auto flex-row items-center gap-2">
          <TextInput
            value={edit.gramsText}
            onChangeText={onEditGrams}
            keyboardType="decimal-pad"
            accessibilityLabel="Grams"
            className="w-16 border border-paper-deep bg-paper-dim px-2 py-2 text-right font-mono text-[13px] text-ink"
          />
          <Text className="font-mono text-[11px] text-ink-secondary">g</Text>
        </View>
      </View>

      <View className="mt-3 flex-row items-center justify-between">
        <Text className="font-mono text-[10px] text-ink-muted">
          {preview?.kcal != null ? `≈ ${fmtInt(preview.kcal)} kcal` : 'no energy recorded'}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save portion"
          accessibilityState={{ disabled: !valid }}
          disabled={!valid}
          onPress={onSave}
          className={
            valid
              ? 'min-h-[44px] justify-center rounded-btn bg-pine px-5 active:opacity-70'
              : 'min-h-[44px] justify-center rounded-btn border border-paper-deep px-5'
          }>
          <Text
            className={
              valid
                ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-pine-on'
                : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
            }>
            Save
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
