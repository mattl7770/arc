import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import { getFood } from '@/lib/db/repositories/foods';
import { saveMealAsTemplate } from '@/lib/db/repositories/meal-templates';
import {
  deleteMeal,
  getMeal,
  listMealItems,
  relogMeal,
  removeMealItem,
  updateMealItemPortion,
} from '@/lib/db/repositories/nutrition';
import { fmtInt, fmtQty, macroLine, portionLabel } from '@/lib/nutrition/format';
import { gramsForQty, rescaleLoggedItem } from '@/lib/nutrition/servings';
import type { FoodRow, MealItemWithServing, MealRow } from '@/lib/nutrition/types';

/**
 * One meal's record (docs/nutrition-subapp.md §2): its items with portions and
 * snapshots, add-food into it, "Log again" (the copy-from-yesterday loop), and
 * delete. Free-form meals (no items) show their directly-recorded totals; once
 * items exist, the repository owns the totals.
 *
 * ## Conformed Set surface system
 *
 *   Totals   → **ruled grid**: energy and macros are a metric grid, so the grid
 *              is the object — no outer box, rules between cells only.
 *   Notes    → **margin annotation**: prose belongs in the margin, not a card.
 *   Items    → **ruled plate**: a record is a table. "Add food" is its closing
 *              row, so the way to extend the record sits with the record.
 *   Actions  → **ruled plate**: another list of things you can do.
 *
 * **The ledger rule.** Once a meal is itemized, `recomputeMealTotals` writes the
 * meal's own kcal/macro columns as the item sums inside the same transaction as
 * every item change — so the Totals grid IS the sum of the item rows below it,
 * and the Items label repeats that figure to make the arithmetic checkable.
 * (Adding the first item to a free-form meal preserves its typed totals as an
 * "(as logged)" item, so the two never silently diverge.) A free-form meal
 * carries no such note, because there is nothing to reconcile against.
 *
 * **Accent budget: one.** The portion editor's Save, and only when an editor is
 * open — at most one is, ever. Every other control here is neutral ink.
 */

type MealState = { meal: MealRow | undefined; items: MealItemWithServing[] };

/** The inline portion-editor's state for one item. `food` is the catalog food
 * if still present (enables the serving stepper + accurate re-derive). */
type ItemEdit = {
  itemId: string;
  food: FoodRow | undefined;
  mode: 'serving' | 'grams';
  qty: number;
  gramsText: string;
};

function readMeal(id: string): MealState {
  const db = getDb();
  return { meal: getMeal(db, id), items: listMealItems(db, id) };
}

/** A typed grams value safe to log: finite, positive, under a sanity ceiling
 * (paste / hardware keyboards get past the numeric soft keyboard). */
function parseGrams(text: string): number | null {
  const g = Number(text.trim());
  return Number.isFinite(g) && g > 0 && g <= 5000 ? g : null;
}

/** Ruled-grid cells: the right-hand rule needs a cell to actually follow it,
 * so an odd count never draws a dangling outer edge (01-rn-port-guide.md §1.3). */
const CELL_LEFT = 'w-1/2 border-r border-t border-hairline py-2.5 pr-2.5';
const CELL_LEFT_LAST = 'w-1/2 border-t border-hairline py-2.5 pr-2.5';
const CELL_RIGHT = 'w-1/2 border-t border-hairline py-2.5 pl-2.5';

function cellClass(index: number, count: number): string {
  if (index % 2 !== 0) return CELL_RIGHT;
  return index + 1 < count ? CELL_LEFT : CELL_LEFT_LAST;
}

/** One macro cell. An unrecorded macro is an em-dash — no data, no number. */
function MacroCell({
  label,
  grams,
  className,
}: {
  label: string;
  grams: number | null;
  className: string;
}) {
  return (
    <View className={className}>
      <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {label}
      </Text>
      <View className="mt-1 flex-row items-baseline gap-1">
        <Text className="font-mono text-lg font-semibold text-ink">
          {grams != null ? Math.round(grams) : '—'}
        </Text>
        {grams != null ? <Text className="font-mono text-[10px] text-ink-muted">g</Text> : null}
      </View>
    </View>
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
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      onPress={onPress}
      className={
        first
          ? 'min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60'
          : 'min-h-[44px] flex-row items-center gap-3 border-t border-hairline py-3 active:opacity-60'
      }>
      <Ionicons name={icon} size={17} color={palette.inkSecondary} />
      <View className="flex-1">
        <Text className="font-serif text-[15px] text-ink">{label}</Text>
        {detail ? (
          <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-muted">{detail}</Text>
        ) : null}
      </View>
      <Ionicons name={trailing ?? 'chevron-forward'} size={16} color={palette.inkMuted} />
    </Pressable>
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
  // The item whose portion is being edited inline, prefilled from its snapshot.
  const [editing, setEditing] = useState<ItemEdit | null>(null);

  const reload = useCallback(() => {
    setState(readMeal(mealId));
    // Regaining focus disarms a pending delete — a confirm must be two taps in
    // a row, not one tap now and a fatal one after a detour through Add food.
    setDeleteArmed(false);
    // And clears a stale "Saved" — the meal may have changed since, so the old
    // confirmation would misrepresent the current state (and a fresh save is a
    // deliberate new template, not this one re-tapped).
    setSavedTemplate(false);
    setEditing(null);
  }, [mealId]);
  useFocusEffect(reload);

  const { meal, items } = state;

  /** Open the inline portion editor for a logged item, prefilled from its
   * snapshot. Re-derives from the catalog food when present; falls back to
   * grams-only proportional editing otherwise. */
  const beginEdit = (item: MealItemWithServing) => {
    const food = item.food_id ? getFood(getDb(), item.food_id) : undefined;
    // A food-less item with no grams has no portion to re-scale — leave it be.
    if (!food && item.grams == null) return;
    const canServing = food?.serving_grams != null;
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
    deleteMeal(getDb(), meal.id);
    router.back();
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

      <View className="mt-1 flex-row items-baseline gap-2">
        <Text className="font-mono text-[11px] text-ink-muted">
          {meal.date}
          {meal.time ? ` · ${meal.time}` : ''}
        </Text>
        {meal.source === 'ai_suggested' ? (
          <Text className="font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
            est · AI
          </Text>
        ) : null}
      </View>

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

          <View className="mt-3 flex-row flex-wrap">
            {macroCells.map((cell, index) => (
              <MacroCell
                key={cell.label}
                label={cell.label}
                grams={cell.grams}
                className={cellClass(index, macroCells.length)}
              />
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

      {/* Items — the record, with the way to extend it as its closing row. */}
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
                  <View key={item.id} className={index === 0 ? '' : 'border-t border-hairline'}>
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
 * The inline portion editor under a tapped item. Serving stepper when the
 * catalog food names a serving; a grams field always. The live "≈ kcal"
 * preview and the Save both go through rescaleLoggedItem, so what you see is
 * exactly what gets written.
 *
 * It draws **no device of its own** — it lives inside the items plate, and
 * devices never nest (src/components/ui/block.tsx). Only the grams input takes
 * the recessed treatment, because an input is a well at control scale.
 *
 * Save is this screen's one accent (only one editor is ever open at a time).
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
