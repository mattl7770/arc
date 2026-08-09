import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import {
  addIngredient,
  createRecipe,
  getRecipe,
  listIngredients,
  parseSteps,
  removeIngredient,
  updateIngredientLine,
  updateRecipe,
} from '@/lib/db/repositories/recipes';

/**
 * Manual recipe create/edit (docs/recipes-grocery.md §5). Ingredients are one
 * raw line per row (the qty/unit/name overlay re-parses on save — raw text is
 * the source of truth); steps are edited as one block, one step per line.
 * Editing never touches a line's food resolution (that lives on the detail
 * screen) and never rewrites meals already cooked from the recipe.
 */

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

type LineDraft = { id: string | null; raw: string };

export default function RecipeEditScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const editing = typeof id === 'string' ? getRecipe(getDb(), id) : undefined;

  const [title, setTitle] = useState(editing?.title ?? '');
  const [servings, setServings] = useState(editing ? String(editing.servings) : '');
  const [weight, setWeight] = useState(
    editing?.total_weight_g ? String(editing.total_weight_g) : ''
  );
  const [prep, setPrep] = useState(editing?.prep_min != null ? String(editing.prep_min) : '');
  const [cook, setCook] = useState(editing?.cook_min != null ? String(editing.cook_min) : '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [stepsText, setStepsText] = useState(editing ? parseSteps(editing.steps).join('\n') : '');
  const [lines, setLines] = useState<LineDraft[]>(() =>
    editing
      ? listIngredients(getDb(), editing.id).map((l) => ({ id: l.id, raw: l.raw_text }))
      : [{ id: null, raw: '' }]
  );
  const [removed, setRemoved] = useState<string[]>([]);

  const parsedServings = Number(servings);
  const canSave = title.trim() !== '' && Number.isFinite(parsedServings) && parsedServings > 0;

  const setLine = (index: number, raw: string) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, raw } : l)));
  };

  const dropLine = (index: number) => {
    const line = lines[index]!;
    if (line.id) setRemoved((prev) => [...prev, line.id!]);
    setLines((prev) => prev.filter((_, i) => i !== index));
  };

  const optNum = (text: string): number | null => {
    const n = Number(text);
    return text.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
  };

  const save = () => {
    if (!canSave) return;
    const db = getDb();
    const steps = stepsText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const kept = lines.filter((l) => l.raw.trim() !== '');

    if (!editing) {
      const newId = createRecipe(db, {
        title: title.trim(),
        servings: parsedServings,
        total_weight_g: optNum(weight),
        prep_min: optNum(prep),
        cook_min: optNum(cook),
        steps,
        notes: notes.trim() === '' ? null : notes.trim(),
        ingredients: kept.map((l) => ({ raw_text: l.raw.trim() })),
      });
      router.replace({ pathname: '/recipe-detail', params: { id: newId } });
      return;
    }

    updateRecipe(db, editing.id, {
      title: title.trim(),
      servings: parsedServings,
      total_weight_g: optNum(weight),
      prep_min: optNum(prep),
      cook_min: optNum(cook),
      steps,
      notes: notes.trim() === '' ? null : notes.trim(),
    });
    // A line the user CLEARED (without tapping remove) is a removal too —
    // leaving its row untouched would silently resurrect the old text on save.
    const emptied = lines.filter((l) => l.id !== null && l.raw.trim() === '').map((l) => l.id!);
    for (const lineId of [...removed, ...emptied]) removeIngredient(db, lineId);
    const existing = new Map(
      listIngredients(db, editing.id).map((l) => [l.id, l.raw_text] as const)
    );
    for (const line of kept) {
      const raw = line.raw.trim();
      if (line.id === null) addIngredient(db, editing.id, { raw_text: raw });
      else if (existing.get(line.id) !== raw) updateIngredientLine(db, line.id, { raw_text: raw });
    }
    router.back();
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={editing ? 'Edit recipe' : 'New recipe'} />
      </View>

      <View className="mt-2">
        <SectionLabel>Recipe</SectionLabel>
        <TextInput
          accessibilityLabel="Title"
          value={title}
          onChangeText={setTitle}
          placeholder="Title"
          placeholderTextColor={palette.inkMuted}
          className="mt-2 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[15px] text-ink"
        />
        <View className="mt-2 flex-row gap-2">
          <LabeledNumber label="Servings" value={servings} onChange={setServings} />
          <LabeledNumber label="Cooked g" value={weight} onChange={setWeight} />
          <LabeledNumber label="Prep min" value={prep} onChange={setPrep} />
          <LabeledNumber label="Cook min" value={cook} onChange={setCook} />
        </View>
      </View>

      <View className="mt-6">
        <SectionLabel>Ingredients</SectionLabel>
        <View className="mt-2">
          {lines.map((line, index) => (
            <View key={line.id ?? `new-${index}`} className="mb-2 flex-row items-center gap-2">
              <TextInput
                accessibilityLabel={`Ingredient ${index + 1}`}
                value={line.raw}
                onChangeText={(text) => setLine(index, text)}
                placeholder="2 cups rolled oats"
                placeholderTextColor={palette.inkMuted}
                autoCapitalize="none"
                className="flex-1 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-2.5 text-[14px] text-ink"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ingredient ${index + 1}`}
                onPress={() => dropLine(index)}
                hitSlop={8}
                className="active:opacity-60">
                <Ionicons name="close-circle-outline" size={20} color={palette.inkMuted} />
              </Pressable>
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add an ingredient line"
            onPress={() => setLines((prev) => [...prev, { id: null, raw: '' }])}
            className="flex-row items-center gap-2 rounded-card border border-hairline bg-porcelain px-3.5 py-2.5 active:bg-paper-deep">
            <Ionicons name="add" size={16} color={palette.inkSecondary} />
            <Text className="text-[13px] text-ink">Add ingredient</Text>
          </Pressable>
        </View>
      </View>

      <View className="mt-6">
        <SectionLabel>Steps — one per line</SectionLabel>
        <TextInput
          accessibilityLabel="Steps"
          value={stepsText}
          onChangeText={setStepsText}
          placeholder={'Brown the chicken.\nSimmer 45 minutes.'}
          placeholderTextColor={palette.inkMuted}
          multiline
          className="mt-2 min-h-28 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[14px] leading-6 text-ink"
        />
      </View>

      <View className="mt-6">
        <SectionLabel>Notes</SectionLabel>
        <TextInput
          accessibilityLabel="Notes"
          value={notes}
          onChangeText={setNotes}
          placeholder="Optional"
          placeholderTextColor={palette.inkMuted}
          multiline
          className="mt-2 min-h-16 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[14px] text-ink"
        />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save recipe"
        accessibilityState={{ disabled: !canSave }}
        disabled={!canSave}
        onPress={save}
        className={`mt-8 items-center justify-center rounded-btn py-3 ${
          canSave ? 'bg-pine active:opacity-70' : 'bg-hairline'
        }`}>
        <Text
          className={`text-[14px] font-semibold ${canSave ? 'text-pine-on' : 'text-ink-muted'}`}>
          {editing ? 'Save changes' : 'Save recipe'}
        </Text>
      </Pressable>
    </Screen>
  );
}

function LabeledNumber({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
}) {
  return (
    <View className="flex-1">
      <Text className="text-[10px] uppercase tracking-[1px] text-ink-muted">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        placeholder="—"
        placeholderTextColor={palette.inkMuted}
        className="mt-1 rounded-btn border border-hairline-soft bg-paper-deep px-2.5 py-2 text-center font-mono text-[14px] text-ink"
      />
    </View>
  );
}
