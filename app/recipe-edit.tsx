import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
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
 *
 * ## Conformed Set treatment (00-design-spec.md §1)
 *
 * This screen is a **form**, so it carries no device at all: the shared
 * `SectionLabel` names each group and whitespace separates them. That absence is
 * a decision, not an oversight — it is form (b) of the capture-surface rule
 * written down in src/components/ui/block.tsx, the same shape app/capture.tsx
 * and app/symptom.tsx ship. Every field wears the well's own surface
 * (`border-paper-deep bg-paper-dim`) directly; wrapping the group in a
 * `<Block device="well">` would stack a recess on a recess and force these
 * inputs up onto plate stock to stay legible. **An input is never
 * `bg-paper-hi`.**
 *
 * Voices: the title, the ingredient lines, the steps and the notes are prose, so
 * serif; servings, weight and the two durations are measured, so mono; every
 * label and every button is the label voice.
 *
 * **Accent budget: one.** Save is it. Removing an ingredient line is drawn in
 * neutral ink — this app has no red chrome, and signal colours mark biology
 * only (§2).
 */

/**
 * A field drawn as recessed stock — the well device's surface applied to the
 * control itself. Square, like everything else in this design: the 2px `btn`
 * radius belongs to buttons.
 */
const INPUT = 'border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';
/** The same well, as a tall multi-line field (steps) and as a shorter one
 *  (notes). Written out in full rather than composed: Tailwind's scanner only
 *  sees class names that appear literally in source. */
const INPUT_STEPS =
  'min-h-[112px] leading-6 border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';
const INPUT_NOTES =
  'min-h-[64px] leading-5 border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';

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

      <View className="mt-5">
        <SectionLabel label="Recipe" />
        <View className="mt-2">
          <TextInput
            accessibilityLabel="Title"
            value={title}
            onChangeText={setTitle}
            placeholder="Title"
            placeholderTextColor={palette.inkMuted}
            className={INPUT}
          />
        </View>
        <View className="mt-2 flex-row gap-2">
          <LabeledNumber label="Servings" value={servings} onChange={setServings} />
          <LabeledNumber label="Cooked g" value={weight} onChange={setWeight} />
          <LabeledNumber label="Prep min" value={prep} onChange={setPrep} />
          <LabeledNumber label="Cook min" value={cook} onChange={setCook} />
        </View>
      </View>

      <View className="mt-7">
        <SectionLabel label="Ingredients" />
        <View className="mt-2">
          {/* Every line removed is a real state, and it is authored rather than
              left blank: a recipe with no lines still saves. */}
          {lines.length === 0 ? (
            <Text className="mb-2 font-serif text-[13px] leading-5 text-ink-secondary">
              No ingredient lines yet — a recipe saves without them.
            </Text>
          ) : null}
          {lines.map((line, index) => (
            <View key={line.id ?? `new-${index}`} className="mb-2 flex-row items-center gap-2">
              <TextInput
                accessibilityLabel={`Ingredient ${index + 1}`}
                value={line.raw}
                onChangeText={(text) => setLine(index, text)}
                placeholder="2 cups rolled oats"
                placeholderTextColor={palette.inkMuted}
                autoCapitalize="none"
                className={INPUT}
                style={{ flex: 1 }}
              />
              {/* Neutral ink, never red — the accent belongs to Save and signal
                  colours mark biology only (§2). 44pt square target. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ingredient ${index + 1}`}
                onPress={() => dropLine(index)}
                hitSlop={8}
                className="h-11 w-11 items-center justify-center active:opacity-60">
                <Ionicons name="close-circle-outline" size={20} color={palette.inkMuted} />
              </Pressable>
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add an ingredient line"
            onPress={() => setLines((prev) => [...prev, { id: null, raw: '' }])}
            className="min-h-[46px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
            <Ionicons name="add" size={17} color={palette.inkSecondary} />
            <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
              Add ingredient
            </Text>
          </Pressable>
        </View>
      </View>

      <View className="mt-7">
        <SectionLabel label="Steps — one per line" />
        <TextInput
          accessibilityLabel="Steps"
          value={stepsText}
          onChangeText={setStepsText}
          placeholder={'Brown the chicken.\nSimmer 45 minutes.'}
          placeholderTextColor={palette.inkMuted}
          multiline
          className={INPUT_STEPS}
          style={{ marginTop: 8 }}
        />
      </View>

      <View className="mt-7">
        <SectionLabel label="Notes" />
        <TextInput
          accessibilityLabel="Notes"
          value={notes}
          onChangeText={setNotes}
          placeholder="Optional"
          placeholderTextColor={palette.inkMuted}
          multiline
          className={INPUT_NOTES}
          style={{ marginTop: 8 }}
        />
      </View>

      {/* The one pine element on this screen. Disabled is a bordered recess:
          ink-muted clears 4.5:1 on paper-dim, which it does not on hairline. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save recipe"
        accessibilityState={{ disabled: !canSave }}
        disabled={!canSave}
        onPress={save}
        className={
          canSave
            ? 'mt-7 min-h-[48px] items-center justify-center rounded-btn bg-pine active:opacity-70'
            : 'mt-7 min-h-[48px] items-center justify-center rounded-btn border border-hairline bg-paper-dim'
        }>
        <Text
          className={
            canSave
              ? 'font-label text-[15px] font-semibold text-pine-on'
              : 'font-label text-[15px] font-semibold text-ink-muted'
          }>
          {editing ? 'Save changes' : 'Save recipe'}
        </Text>
      </Pressable>
    </Screen>
  );
}

/**
 * One measured meta field. The label is the label voice; the value is a
 * measurement, so mono — and its placeholder is an em-dash, because no data
 * gets no number (§5).
 */
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
      <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        placeholder="—"
        placeholderTextColor={palette.inkMuted}
        className="mt-1 min-h-[44px] border border-paper-deep bg-paper-dim px-2 py-2 text-center font-mono text-[15px] text-ink"
      />
    </View>
  );
}
