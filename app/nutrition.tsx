import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, Text, TextInput, type TextInputProps, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import { logMeal } from '@/lib/db/repositories/nutrition';
import { useNutrition } from '@/hooks/use-nutrition';
import type { MealRow } from '@/lib/nutrition/types';

/**
 * Nutrition sub-app, pushed from the Log tab's Nutrition tile.
 *
 * Wired to the on-device DB (db/migrations/0002_nutrition.sql): the Today card
 * sums today's meals live, "Eaten today" lists them, and Manual entry saves
 * through src/lib/db/repositories/nutrition.ts, reloading in place. The pine
 * "describe or snap" path stays a labelled stub until the Coach model lands
 * (Phase 3), and meal templates arrive with protocols — both say so when
 * tapped. Full spec (templates, micros, grocery, pantry, recipes, photo
 * analysis) in docs/information-architecture.md.
 */

/**
 * Daily targets, kept from the mockup as placeholder constants: targets belong
 * to protocols / settings once those exist (docs/project-status.md §1). The
 * summed intake is real; these denominators are not yet personal.
 */
const KCAL_TARGET = 2200;
type MacroKey = 'protein_g' | 'carbs_g' | 'fat_g';
const MACRO_TARGETS: { key: MacroKey; label: string; target: number }[] = [
  { key: 'protein_g', label: 'Protein', target: 180 },
  { key: 'carbs_g', label: 'Carbs', target: 160 },
  { key: 'fat_g', label: 'Fat', target: 70 },
];

/** 1840 → "1,840" — hand-rolled so the one comma doesn't lean on Hermes Intl. */
function fmtInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "P 42g · C 30g · F 18g" from whatever macros a meal actually recorded. */
function macroLine(meal: MealRow): string | null {
  const parts: string[] = [];
  if (meal.protein_g != null) parts.push(`P ${Math.round(meal.protein_g)}g`);
  if (meal.carbs_g != null) parts.push(`C ${Math.round(meal.carbs_g)}g`);
  if (meal.fat_g != null) parts.push(`F ${Math.round(meal.fat_g)}g`);
  return parts.length > 0 ? parts.join(' · ') : null;
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

export default function NutritionScreen() {
  const { meals, totals, reload } = useNutrition();
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

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Nutrition" />
      </View>

      {/* Today's intake — real sums over today's meals. */}
      <View className="mt-2">
        <SectionLabel>Today</SectionLabel>
        <View className="mt-2 rounded-card border border-hairline bg-porcelain p-4">
          <View className="flex-row items-baseline justify-between">
            <View className="flex-row items-baseline gap-1.5">
              <Text className="font-mono text-4xl text-ink">{fmtInt(totals.kcal)}</Text>
              <Text className="font-mono text-sm text-ink-muted">kcal</Text>
            </View>
            <Text className="text-xs text-ink-muted">of {fmtInt(KCAL_TARGET)} target</Text>
          </View>

          <View className="mt-4 border-t border-hairline-soft pt-4">
            <View className="flex-row gap-4">
              {MACRO_TARGETS.map((m) => {
                const grams = totals[m.key];
                return (
                  <View key={m.label} className="flex-1">
                    <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">
                      {m.label}
                    </Text>
                    <View className="mt-1 flex-row items-baseline gap-1">
                      <Text className="font-mono text-lg text-ink">{Math.round(grams)}</Text>
                      <Text className="font-mono text-[11px] text-ink-muted">/ {m.target}g</Text>
                    </View>
                    <View className="mt-1.5 h-1 overflow-hidden rounded-full bg-hairline">
                      <View
                        className="h-1 rounded-full bg-ink-secondary"
                        style={{ width: `${Math.min(100, (grams / m.target) * 100)}%` }}
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        </View>
      </View>

      {/* Log a meal */}
      <View className="mt-8">
        <SectionLabel>Log a meal</SectionLabel>
        {/* The one pine action on this screen — a labelled stub until the Coach
            model lands (Phase 3); manual entry below is the working path. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Describe or snap a meal"
          onPress={() =>
            setHint('Photo and described meals arrive with the Coach — manual entry works now.')
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
            accessibilityLabel="Manual entry"
            accessibilityState={{ expanded: formOpen }}
            onPress={openForm}
            className={`flex-1 flex-row items-center gap-2 rounded-card border px-3.5 py-3 ${
              formOpen ? 'border-hairline-strong bg-paper-deep' : 'border-hairline bg-porcelain'
            }`}>
            <Ionicons name="create-outline" size={17} color={palette.inkSecondary} />
            <Text className="text-[13px] text-ink">Manual entry</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="From a template"
            onPress={() =>
              setHint('Meal templates arrive with protocols — manual entry works now.')
            }
            className="flex-1 flex-row items-center gap-2 rounded-card border border-hairline bg-porcelain px-3.5 py-3">
            <Ionicons name="albums-outline" size={17} color={palette.inkSecondary} />
            <Text className="text-[13px] text-ink">From a template</Text>
          </Pressable>
        </View>

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
            {meals.map((meal, index) => {
              const macros = macroLine(meal);
              return (
                <View
                  key={meal.id}
                  className={`flex-row gap-3 py-3 ${index === 0 ? '' : 'border-t border-hairline-soft'}`}>
                  <Text className="w-11 pt-0.5 font-mono text-[11px] text-ink-muted">
                    {meal.time ?? '—'}
                  </Text>
                  <View className="flex-1">
                    <Text className="text-[15px] leading-5 text-ink">{meal.name}</Text>
                    {meal.notes ? (
                      <Text className="mt-0.5 text-xs leading-5 text-ink-muted">{meal.notes}</Text>
                    ) : macros ? (
                      <Text className="mt-0.5 font-mono text-[11px] leading-5 text-ink-muted">
                        {macros}
                      </Text>
                    ) : null}
                  </View>
                  <Text className="pt-0.5 font-mono text-[13px] text-ink-secondary">
                    {meal.kcal != null ? fmtInt(meal.kcal) : '—'}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
      </View>
    </Screen>
  );
}
