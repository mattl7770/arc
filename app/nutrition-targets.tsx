import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, type TextInputProps, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { activeNutritionTargets, setNutritionTargets } from '@/lib/db/repositories/nutrition';

/**
 * Daily targets editor. Saving APPENDS a new immutable version effective today
 * (0009_nutrition_targets.sql — the protocol_versions pattern), so history is
 * judged against the targets of its own era. Any subset of the five values is
 * a valid target set; blank means "no target", never 0. The Coach's future
 * proposals land in the same table with created_by='ai'.
 *
 * Conformed Set treatment: the form is **form (b) of the capture-surface rule**
 * in src/components/ui/block.tsx — a group of labelled fields carries no block,
 * and each field wears the well's own tokens (`border-paper-deep bg-paper-dim`)
 * directly, named by a `SectionLabel` and separated by whitespace, as in
 * app/capture.tsx. A `<Block device="well">` around the group would nest a
 * recess in a recess and force the fields up onto plate stock; an input is never
 * `bg-paper-hi`. The provenance line is a **margin annotation**. Saving is a
 * live decision, so the consequence is stated in future tense and sits directly
 * under the control that performs it, with nothing after it (00-design-spec.md
 * §5).
 *
 * Every value on this screen is a measurement, so every field and every
 * provenance figure is mono. No accent: this is a settings surface, and the
 * save is the only action on it either way.
 */

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

type FieldProps = {
  label: string;
  value: string;
  onChange: (next: string) => void;
  keyboardType?: TextInputProps['keyboardType'];
};

function FormField({ label, value, onChange, keyboardType }: FieldProps) {
  return (
    <View className="flex-1">
      <Text className="mb-1 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="—"
        placeholderTextColor={palette.inkMuted}
        keyboardType={keyboardType ?? 'decimal-pad'}
        accessibilityLabel={label}
        className="border border-paper-deep bg-paper-dim px-3 py-3 font-mono text-[15px] text-ink"
      />
    </View>
  );
}

export default function NutritionTargetsScreen() {
  const router = useRouter();
  const [active] = useState(() => activeNutritionTargets(getDb(), todayISODate()) ?? null);

  const prefill = (v: number | null | undefined): string => (v == null ? '' : String(v));
  const [kcal, setKcal] = useState(() => prefill(active?.kcal));
  const [protein, setProtein] = useState(() => prefill(active?.protein_g));
  const [carbs, setCarbs] = useState(() => prefill(active?.carbs_g));
  const [fat, setFat] = useState(() => prefill(active?.fat_g));
  const [fiber, setFiber] = useState(() => prefill(active?.fiber_g));

  const numbersValid = [kcal, protein, carbs, fat, fiber].every(validNumber);
  const kcalNum = toNumber(kcal);
  const kcalValid = kcalNum === null || kcalNum > 0;
  const values = [kcalNum, toNumber(protein), toNumber(carbs), toNumber(fat), toNumber(fiber)];
  const anySet = values.some((v) => v !== null);
  const canSave = numbersValid && kcalValid && anySet;

  const problem = !numbersValid
    ? 'Numbers only — blank a field to drop that target.'
    : !kcalValid
      ? 'A kcal target has to be above zero — blank it to drop it.'
      : !anySet
        ? 'Set at least one target (any subset works).'
        : null;

  const save = () => {
    if (!canSave) return;
    try {
      setNutritionTargets(getDb(), {
        effective_date: todayISODate(),
        kcal: kcalNum,
        protein_g: values[1] ?? null,
        carbs_g: values[2] ?? null,
        fat_g: values[3] ?? null,
        fiber_g: values[4] ?? null,
      });
      router.back();
    } catch (error) {
      // canSave gates the known cases; backstop so a write failure never
      // crashes the tap handler.
      console.warn('[nutrition-targets] save failed', error);
    }
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Daily targets" />
      </View>

      <View className="mt-2">
        <Block device="margin">
          {active ? (
            <Text className="font-mono text-[11px] text-ink-muted">
              Since {active.effective_date} · set by {active.created_by === 'ai' ? 'Coach' : 'you'}
            </Text>
          ) : (
            <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
              No targets yet — the Today card shows plain totals until you set some.
            </Text>
          )}
        </Block>
      </View>

      <View className="mt-5">
        <SectionLabel label="Targets" note="Any subset" />

        <View className="mt-2 flex-row gap-3">
          <FormField label="kcal" value={kcal} onChange={setKcal} />
          <FormField label="Protein g" value={protein} onChange={setProtein} />
        </View>
        <View className="mt-3 flex-row gap-3">
          <FormField label="Carbs g" value={carbs} onChange={setCarbs} />
          <FormField label="Fat g" value={fat} onChange={setFat} />
          <FormField label="Fiber g" value={fiber} onChange={setFiber} />
        </View>

        {problem ? (
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
            {problem}
          </Text>
        ) : null}

        {/* The consequence of the tap, in future tense, immediately above the
            control that performs it — a pending write is a live decision. */}
        <Text className="mt-4 font-serif text-[13px] leading-5 text-ink-muted">
          On save: a new version starts today. Past days keep the targets they were lived under.
        </Text>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save targets"
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          onPress={save}
          className={
            canSave
              ? 'mt-3 min-h-[44px] items-center justify-center rounded-btn border border-ink bg-paper-hi py-3 active:opacity-70'
              : 'mt-3 min-h-[44px] items-center justify-center rounded-btn border border-paper-deep py-3'
          }>
          <Text
            className={
              canSave
                ? 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink'
                : 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
            }>
            Save targets
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}
