import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, type TextInputProps, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
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
      <Text className="mb-1 text-xs text-ink-secondary">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="—"
        placeholderTextColor={palette.inkMuted}
        keyboardType={keyboardType ?? 'decimal-pad'}
        accessibilityLabel={label}
        className="rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 font-mono text-[15px] text-ink"
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

      {active ? (
        <Text className="mt-1 font-mono text-[11px] text-ink-muted">
          Since {active.effective_date} · set by {active.created_by === 'ai' ? 'Coach' : 'you'}
        </Text>
      ) : (
        <Text className="mt-1 text-xs leading-5 text-ink-muted">
          No targets yet — the Today card shows plain totals until you set some.
        </Text>
      )}

      <View className="mt-5 rounded-card border border-hairline bg-porcelain p-4">
        <View className="flex-row gap-3">
          <FormField label="kcal" value={kcal} onChange={setKcal} />
          <FormField label="Protein g" value={protein} onChange={setProtein} />
        </View>
        <View className="mt-3 flex-row gap-3">
          <FormField label="Carbs g" value={carbs} onChange={setCarbs} />
          <FormField label="Fat g" value={fat} onChange={setFat} />
          <FormField label="Fiber g" value={fiber} onChange={setFiber} />
        </View>

        {problem ? <Text className="mt-2 text-xs leading-5 text-ink-muted">{problem}</Text> : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save targets"
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          onPress={save}
          className={`mt-4 h-12 items-center justify-center rounded-btn border ${
            canSave ? 'border-hairline-strong active:bg-paper-deep' : 'border-hairline'
          }`}>
          <Text className={`text-[15px] font-semibold ${canSave ? 'text-ink' : 'text-ink-muted'}`}>
            Save targets
          </Text>
        </Pressable>
      </View>

      <Text className="mt-3 text-xs leading-5 text-ink-muted">
        Saving starts a new version from today — past days keep the targets they were lived under.
      </Text>
    </Screen>
  );
}
