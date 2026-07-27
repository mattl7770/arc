import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import { saveMealAsTemplate } from '@/lib/db/repositories/meal-templates';
import {
  deleteMeal,
  getMeal,
  listMealItems,
  relogMeal,
  removeMealItem,
} from '@/lib/db/repositories/nutrition';
import { fmtInt, macroLine, portionLabel } from '@/lib/nutrition/format';
import type { MealItemWithServing, MealRow } from '@/lib/nutrition/types';

/**
 * One meal's record (docs/nutrition-subapp.md §2): its items with portions and
 * snapshots, add-food into it, "Log again" (the copy-from-yesterday loop), and
 * delete. Free-form meals (no items) show their directly-recorded totals; once
 * items exist, the repository owns the totals.
 */

type MealState = { meal: MealRow | undefined; items: MealItemWithServing[] };

function readMeal(id: string): MealState {
  const db = getDb();
  return { meal: getMeal(db, id), items: listMealItems(db, id) };
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
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

  const reload = useCallback(() => {
    setState(readMeal(mealId));
    // Regaining focus disarms a pending delete — a confirm must be two taps in
    // a row, not one tap now and a fatal one after a detour through Add food.
    setDeleteArmed(false);
    // And clears a stale "Saved" — the meal may have changed since, so the old
    // confirmation would misrepresent the current state (and a fresh save is a
    // deliberate new template, not this one re-tapped).
    setSavedTemplate(false);
  }, [mealId]);
  useFocusEffect(reload);

  const { meal, items } = state;

  if (!meal) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Meal" />
        </View>
        <Text className="mt-6 text-[13px] leading-5 text-ink-muted">
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

  const macros = macroLine(meal);

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
      <View className="mt-5 rounded-card border border-hairline bg-porcelain p-4">
        <View className="flex-row items-baseline justify-between">
          <View className="flex-row items-baseline gap-1.5">
            <Text className="font-mono text-3xl text-ink">
              {meal.kcal != null ? fmtInt(meal.kcal) : '—'}
            </Text>
            <Text className="font-mono text-sm text-ink-muted">kcal</Text>
          </View>
          {macros ? <Text className="font-mono text-[11px] text-ink-muted">{macros}</Text> : null}
        </View>
        {meal.notes ? (
          <Text className="mt-2 text-xs leading-5 text-ink-secondary">{meal.notes}</Text>
        ) : null}
      </View>

      {/* Items */}
      <View className="mt-8">
        <SectionLabel>Items</SectionLabel>
        {items.length === 0 ? (
          <Text className="mt-2 text-[13px] leading-5 text-ink-muted">
            Free-form entry — totals were recorded directly. Add a food to itemize it.
          </Text>
        ) : (
          <View className="mt-1">
            {items.map((item, index) => {
              const portion = portionLabel(item);
              const line = macroLine(item);
              return (
                <View
                  key={item.id}
                  className={`flex-row items-center gap-3 py-3 ${
                    index === 0 ? '' : 'border-t border-hairline-soft'
                  }`}>
                  <View className="flex-1">
                    <Text className="text-[15px] leading-5 text-ink">
                      {item.name}
                      {item.confidence !== null ? (
                        <Text className="font-mono text-[10px] text-ink-muted">
                          {'  '}≈ {item.confidence}
                        </Text>
                      ) : null}
                    </Text>
                    <Text className="mt-0.5 font-mono text-[11px] leading-4 text-ink-muted">
                      {[portion, line].filter(Boolean).join(' · ') || '—'}
                    </Text>
                  </View>
                  <Text className="font-mono text-[13px] text-ink-secondary">
                    {item.kcal != null ? fmtInt(item.kcal) : '—'}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${item.name}`}
                    hitSlop={8}
                    onPress={() => removeItem(item.id)}
                    className="h-8 w-8 items-center justify-center rounded-btn active:bg-paper-deep">
                    <Ionicons name="close" size={16} color={palette.inkMuted} />
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add food to this meal"
          onPress={() => router.push({ pathname: '/food-search', params: { mealId: meal.id } })}
          className="mt-3 flex-row items-center gap-2 rounded-card border border-hairline bg-porcelain px-3.5 py-3 active:bg-paper-deep">
          <Ionicons name="add" size={17} color={palette.inkSecondary} />
          <Text className="text-[13px] text-ink">Add food</Text>
        </Pressable>
      </View>

      {/* Actions */}
      <View className="mt-8">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log this meal again now"
          onPress={logAgain}
          className="flex-row items-center gap-3 rounded-card border border-hairline bg-porcelain px-4 py-3 active:bg-paper-deep">
          <Ionicons name="repeat-outline" size={18} color={palette.inkSecondary} />
          <View className="flex-1">
            <Text className="text-[15px] text-ink">Log again</Text>
            <Text className="mt-0.5 text-xs text-ink-muted">
              Duplicates this meal onto today, timed now
            </Text>
          </View>
        </Pressable>

        {/* Save as template — only meaningful for an itemized meal (a template
            needs items to re-stamp). */}
        {items.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save this meal as a template"
            accessibilityState={{ disabled: savedTemplate }}
            // Inert once saved: a second tap would silently create a duplicate,
            // and the checkmark reads as "done". Re-enabled on the next visit
            // (reload clears savedTemplate), where a save is a deliberate new one.
            disabled={savedTemplate}
            onPress={saveAsTemplate}
            className={`mt-2 flex-row items-center gap-3 rounded-card border border-hairline bg-porcelain px-4 py-3 ${
              savedTemplate ? '' : 'active:bg-paper-deep'
            }`}>
            <Ionicons name="albums-outline" size={18} color={palette.inkSecondary} />
            <View className="flex-1">
              <Text className="text-[15px] text-ink">Save as template</Text>
              <Text className="mt-0.5 text-xs text-ink-muted">
                {savedTemplate
                  ? 'Saved — find it under “From a template”'
                  : 'Reuse this meal later'}
              </Text>
            </View>
            {savedTemplate ? (
              <Ionicons name="checkmark" size={18} color={palette.inkSecondary} />
            ) : null}
          </Pressable>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={deleteArmed ? 'Tap again to delete this meal' : 'Delete this meal'}
          onPress={onDelete}
          className="mt-6 items-center py-2 active:opacity-60">
          <Text
            className={`text-[13px] ${deleteArmed ? 'font-semibold text-ink' : 'text-ink-muted'}`}>
            {deleteArmed ? 'Tap again to delete' : 'Delete this meal'}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}
