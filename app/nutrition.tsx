import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, type TextInputProps, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import { logMeal } from '@/lib/db/repositories/nutrition';
import { useNutrition } from '@/hooks/use-nutrition';
import { fmtInt, macroLine } from '@/lib/nutrition/format';
import type { MealRow, NutritionTargetsRow } from '@/lib/nutrition/types';

/**
 * Nutrition sub-app home, pushed from the Log tab's Nutrition tile.
 *
 * The hub of the food-logging family (docs/nutrition-subapp.md): the Today
 * card reads real intake against the real (versioned) daily targets — or shows
 * no denominators at all until targets are set, never a placeholder; "Add
 * food" pushes the catalog search; manual entry stays as the free-form path;
 * "Eaten today" rows push meal detail. The pine "describe or snap" action
 * remains a labelled stub until the Coach's model client lands (Phase 3) —
 * the estimation seam is src/lib/nutrition/estimate.ts.
 */

/** 42 → "42", null target → value alone. Tracks fill ink-secondary and stamp
 * pine only when the target is met — completion is what pine means. */
function MacroColumn({
  label,
  grams,
  target,
}: {
  label: string;
  grams: number;
  target: number | null;
}) {
  const met = target !== null && target > 0 && grams >= target;
  return (
    <View className="flex-1">
      <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">{label}</Text>
      <View className="mt-1 flex-row items-baseline gap-1">
        <Text className="font-mono text-lg text-ink">{Math.round(grams)}</Text>
        <Text className="font-mono text-[11px] text-ink-muted">
          {target !== null ? `/ ${Math.round(target)}g` : 'g'}
        </Text>
      </View>
      {target !== null && target > 0 ? (
        <View className="mt-1.5 h-1 overflow-hidden rounded-full bg-hairline">
          <View
            className={`h-1 rounded-full ${met ? 'bg-pine' : 'bg-ink-secondary'}`}
            style={{ width: `${Math.min(100, (grams / target) * 100)}%` }}
          />
        </View>
      ) : null}
    </View>
  );
}

/** The Today-card corner: the kcal denominator when one exists (a measured
 * value → mono voice), otherwise the invitation to set targets (prose → sans).
 * Either way it opens the targets editor. */
function targetsCorner(targets: NutritionTargetsRow | null): { label: string; mono: boolean } {
  if (targets === null) return { label: 'Set daily targets', mono: false };
  if (targets.kcal !== null) return { label: `of ${fmtInt(targets.kcal)} target`, mono: true };
  return { label: 'Edit targets', mono: false };
}

/** "" is fine (stored as NULL); anything typed must be a non-negative number. */
function validNumber(text: string): boolean {
  const t = text.trim();
  if (t === '') return true;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0;
}

function toNumber(text: string): number | null {
  const t = text.trim();
  return t === '' ? null : Number(t);
}

/** "8:05" / "08:05" → "08:05"; null if it isn't a real clock time. */
function normalizeTime(text: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${m[2]}`;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

type FieldProps = {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  keyboardType?: TextInputProps['keyboardType'];
  mono?: boolean;
  maxLength?: number;
};

function FormField({
  label,
  value,
  onChange,
  placeholder,
  keyboardType,
  mono,
  maxLength,
}: FieldProps) {
  return (
    <View className="flex-1">
      <Text className="mb-1 text-xs text-ink-secondary">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={palette.inkMuted}
        keyboardType={keyboardType}
        maxLength={maxLength}
        accessibilityLabel={label}
        className={`rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[15px] text-ink ${
          mono ? 'font-mono' : ''
        }`}
      />
    </View>
  );
}

/**
 * The manual "Add a meal" form. Mounted fresh each time it opens, so the time
 * defaults to now and a saved form comes back empty. Numbers are optional —
 * blank stores NULL ("not recorded"), never 0.
 */
function AddMealForm({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('');
  const [time, setTime] = useState(() => clockFromISO(new Date().toISOString()));
  const [kcal, setKcal] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');

  const numbersValid = [kcal, protein, carbs, fat].every(validNumber);
  const timeValid = normalizeTime(time) !== null;
  const canSave = name.trim() !== '' && timeValid && numbersValid;

  const problem = !timeValid
    ? 'Time reads as HH:MM, e.g. 12:30.'
    : !numbersValid
      ? 'Numbers only — leave a field blank if you didn’t track it.'
      : null;

  const save = () => {
    const normalized = normalizeTime(time);
    if (!canSave || normalized === null) return;
    try {
      logMeal(getDb(), {
        date: todayISODate(),
        time: normalized,
        name: name.trim(),
        kcal: toNumber(kcal),
        protein_g: toNumber(protein),
        carbs_g: toNumber(carbs),
        fat_g: toNumber(fat),
      });
      onSaved();
    } catch (error) {
      // canSave gates the known cases; this is a backstop so a write failure
      // never crashes the tap handler or loses the typed meal.
      console.warn('[nutrition] meal save failed', error);
    }
  };

  return (
    <View className="mt-3 rounded-card border border-hairline bg-porcelain p-4">
      <FormField label="Meal" value={name} onChange={setName} placeholder="e.g. Salmon + lentils" />
      <View className="mt-3 flex-row gap-3">
        <FormField
          label="Time"
          value={time}
          onChange={setTime}
          placeholder="12:30"
          keyboardType="numbers-and-punctuation"
          maxLength={5}
          mono
        />
        <FormField
          label="kcal"
          value={kcal}
          onChange={setKcal}
          placeholder="—"
          keyboardType="decimal-pad"
          mono
        />
      </View>
      <View className="mt-3 flex-row gap-3">
        <FormField
          label="Protein g"
          value={protein}
          onChange={setProtein}
          placeholder="—"
          keyboardType="decimal-pad"
          mono
        />
        <FormField
          label="Carbs g"
          value={carbs}
          onChange={setCarbs}
          placeholder="—"
          keyboardType="decimal-pad"
          mono
        />
        <FormField
          label="Fat g"
          value={fat}
          onChange={setFat}
          placeholder="—"
          keyboardType="decimal-pad"
          mono
        />
      </View>

      {problem ? <Text className="mt-2 text-xs leading-5 text-ink-muted">{problem}</Text> : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save meal"
        accessibilityState={{ disabled: !canSave }}
        disabled={!canSave}
        onPress={save}
        className={`mt-4 h-12 items-center justify-center rounded-btn border ${
          canSave ? 'border-hairline-strong active:bg-paper-deep' : 'border-hairline'
        }`}>
        <Text className={`text-[15px] font-semibold ${canSave ? 'text-ink' : 'text-ink-muted'}`}>
          Save meal
        </Text>
      </Pressable>
    </View>
  );
}

/** One "Eaten today" row — the whole row pushes the meal's detail screen. */
function MealRowItem({
  meal,
  itemCount,
  first,
  onPress,
}: {
  meal: MealRow;
  itemCount: number;
  first: boolean;
  onPress: () => void;
}) {
  const macros = macroLine(meal);
  const detail =
    meal.notes ??
    [macros, itemCount > 0 ? `${itemCount} item${itemCount === 1 ? '' : 's'}` : null]
      .filter(Boolean)
      .join(' · ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${meal.name}, details`}
      onPress={onPress}
      className={`flex-row gap-3 py-3 active:opacity-60 ${first ? '' : 'border-t border-hairline-soft'}`}>
      <Text className="w-11 pt-0.5 font-mono text-[11px] text-ink-muted">{meal.time ?? '—'}</Text>
      <View className="flex-1">
        <Text className="text-[15px] leading-5 text-ink">{meal.name}</Text>
        {detail !== '' ? (
          <Text
            className={`mt-0.5 text-xs leading-5 text-ink-muted ${meal.notes ? '' : 'font-mono text-[11px]'}`}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Text className="pt-0.5 font-mono text-[13px] text-ink-secondary">
        {meal.kcal != null ? fmtInt(meal.kcal) : '—'}
      </Text>
    </Pressable>
  );
}

export default function NutritionScreen() {
  const router = useRouter();
  const { meals, totals, fiberTotal, itemCounts, targets, reload } = useNutrition();
  const [formOpen, setFormOpen] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const openForm = () => {
    setHint(null);
    setFormOpen((open) => !open);
  };

  const saved = () => {
    setFormOpen(false);
    reload();
  };

  const corner = targetsCorner(targets);
  const kcalTarget = targets?.kcal ?? null;
  const fiberTarget = targets?.fiber_g ?? null;
  const fiberMet = fiberTarget !== null && fiberTarget > 0 && fiberTotal >= fiberTarget;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Nutrition" />
      </View>

      {/* Today's intake — real sums against the real (versioned) targets. */}
      <View className="mt-2">
        <SectionLabel>Today</SectionLabel>
        <View className="mt-2 rounded-card border border-hairline bg-porcelain p-4">
          <View className="flex-row items-baseline justify-between">
            <View className="flex-row items-baseline gap-1.5">
              <Text className="font-mono text-4xl text-ink">{fmtInt(totals.kcal)}</Text>
              <Text className="font-mono text-sm text-ink-muted">kcal</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Daily targets"
              hitSlop={8}
              onPress={() => router.push('/nutrition-targets')}
              className="active:opacity-60">
              <Text
                className={
                  corner.mono ? 'font-mono text-[11px] text-ink-muted' : 'text-xs text-ink-muted'
                }>
                {corner.label}
              </Text>
            </Pressable>
          </View>

          {kcalTarget !== null && kcalTarget > 0 ? (
            <View className="mt-3 h-1 overflow-hidden rounded-full bg-hairline">
              <View
                className={`h-1 rounded-full ${totals.kcal >= kcalTarget ? 'bg-pine' : 'bg-ink-secondary'}`}
                style={{ width: `${Math.min(100, (totals.kcal / kcalTarget) * 100)}%` }}
              />
            </View>
          ) : null}

          <View className="mt-4 border-t border-hairline-soft pt-4">
            <View className="flex-row gap-4">
              <MacroColumn
                label="Protein"
                grams={totals.protein_g}
                target={targets?.protein_g ?? null}
              />
              <MacroColumn label="Carbs" grams={totals.carbs_g} target={targets?.carbs_g ?? null} />
              <MacroColumn label="Fat" grams={totals.fat_g} target={targets?.fat_g ?? null} />
            </View>
            {fiberTarget !== null ? (
              <View className="mt-3">
                <View className="flex-row items-baseline justify-between">
                  <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">Fiber</Text>
                  <View className="flex-row items-baseline gap-1">
                    <Text className="font-mono text-[13px] text-ink">{Math.round(fiberTotal)}</Text>
                    <Text className="font-mono text-[11px] text-ink-muted">
                      / {Math.round(fiberTarget)}g
                    </Text>
                  </View>
                </View>
                {fiberTarget > 0 ? (
                  <View className="mt-1.5 h-1 overflow-hidden rounded-full bg-hairline">
                    <View
                      className={`h-1 rounded-full ${fiberMet ? 'bg-pine' : 'bg-ink-secondary'}`}
                      style={{ width: `${Math.min(100, (fiberTotal / fiberTarget) * 100)}%` }}
                    />
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
      </View>

      {/* Log a meal */}
      <View className="mt-8">
        <SectionLabel>Log a meal</SectionLabel>
        {/* The one pine action on this screen — a labelled stub until the Coach
            model client lands (Phase 3); src/lib/nutrition/estimate.ts is the
            seam. Catalog search + manual entry below are the working paths. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Describe or snap a meal"
          onPress={() =>
            setHint('Photo and described meals arrive with the Coach — Add food works now.')
          }
          className="mt-2 flex-row items-center gap-3 rounded-card bg-pine px-4 py-3.5 active:opacity-70">
          <Ionicons name="camera-outline" size={20} color={palette.pineOn} />
          <View className="flex-1">
            <Text className="text-[15px] font-semibold text-pine-on">Describe or snap a meal</Text>
            <Text className="mt-0.5 text-xs text-pine-tint">
              Type it, speak it, or photograph the plate
            </Text>
          </View>
        </Pressable>

        <View className="mt-2 flex-row gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add food from the catalog"
            onPress={() => router.push('/food-search')}
            className="flex-1 flex-row items-center gap-2 rounded-card border border-hairline bg-porcelain px-3.5 py-3 active:bg-paper-deep">
            <Ionicons name="search-outline" size={17} color={palette.inkSecondary} />
            <Text className="text-[13px] text-ink">Add food</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Manual entry"
            accessibilityState={{ expanded: formOpen }}
            onPress={openForm}
            className={`flex-1 flex-row items-center gap-2 rounded-card border px-3.5 py-3 ${
              formOpen ? 'border-hairline-strong bg-paper-deep' : 'border-hairline bg-porcelain'
            }`}>
            <Ionicons name="create-outline" size={17} color={palette.inkSecondary} />
            <Text className="text-[13px] text-ink">Manual entry</Text>
          </Pressable>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log from a template"
          onPress={() => router.push('/meal-templates')}
          className="mt-2 flex-row items-center gap-2 rounded-card border border-hairline bg-porcelain px-3.5 py-3 active:bg-paper-deep">
          <Ionicons name="albums-outline" size={17} color={palette.inkSecondary} />
          <Text className="text-[13px] text-ink">From a template</Text>
        </Pressable>

        {hint ? <Text className="mt-2 text-xs leading-5 text-ink-muted">{hint}</Text> : null}

        {formOpen ? <AddMealForm onSaved={saved} /> : null}
      </View>

      {/* Eaten today — the day's real record, in eating order. */}
      <View className="mt-8">
        <SectionLabel>Eaten today</SectionLabel>
        {meals.length === 0 ? (
          <Text className="mt-2 text-[13px] leading-5 text-ink-muted">
            No meals logged yet today.
          </Text>
        ) : (
          <View className="mt-1">
            {meals.map((meal, index) => (
              <MealRowItem
                key={meal.id}
                meal={meal}
                itemCount={itemCounts[meal.id] ?? 0}
                first={index === 0}
                onPress={() => router.push({ pathname: '/meal-detail', params: { id: meal.id } })}
              />
            ))}
          </View>
        )}
      </View>

      {/* Review — micronutrients and cross-day trends (read-only, no pine). */}
      <View className="mt-8">
        <SectionLabel>Review</SectionLabel>
        <View className="mt-2">
          <ReviewRow
            icon="nutrition-outline"
            title="Micronutrients"
            detail="Today's totals vs reference"
            onPress={() => router.push('/nutrition-micros')}
          />
          <ReviewRow
            icon="trending-up-outline"
            title="History"
            detail="Energy & macros over time"
            onPress={() => router.push('/nutrition-history')}
          />
        </View>
      </View>
    </Screen>
  );
}

/** One review row (Micronutrients / History) — card + chevron, no pine. */
function ReviewRow({
  icon,
  title,
  detail,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  detail: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      className="mb-2 flex-row items-center gap-3 rounded-card border border-hairline bg-porcelain px-4 py-3 active:bg-paper-deep">
      <Ionicons name={icon} size={18} color={palette.inkSecondary} />
      <View className="flex-1">
        <Text className="text-[15px] text-ink">{title}</Text>
        <Text className="mt-0.5 text-xs text-ink-muted">{detail}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={palette.inkMuted} />
    </Pressable>
  );
}
