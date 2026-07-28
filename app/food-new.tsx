import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, type TextInputProps, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { createFood } from '@/lib/db/repositories/foods';

/**
 * Create a custom catalog food (source='user'), reached from food search with
 * the failed query prefilled. Macros can be typed per serving (the label way)
 * or per 100 g (the database way); storage is always canonical per-100 g
 * (docs/nutrition-subapp.md §3), so the per-serving path converts on save.
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
  placeholder?: string;
  keyboardType?: TextInputProps['keyboardType'];
  mono?: boolean;
};

function FormField({ label, value, onChange, placeholder, keyboardType, mono }: FieldProps) {
  return (
    <View className="flex-1">
      <Text className="mb-1 text-xs text-ink-secondary">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={palette.inkMuted}
        keyboardType={keyboardType}
        accessibilityLabel={label}
        className={`rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[15px] text-ink ${
          mono ? 'font-mono' : ''
        }`}
      />
    </View>
  );
}

/** Per-100 g schema bounds, checked here so a save never throws a CHECK. */
function per100Problem(kcal: number | null, macros: (number | null)[]): string | null {
  if (kcal !== null && kcal > 950) return 'kcal per 100 g can’t exceed 950 (pure fat is ~884).';
  if (macros.some((m) => m !== null && m > 100)) {
    return 'A macro can’t exceed 100 g per 100 g of food.';
  }
  return null;
}

export default function FoodNewScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ name?: string; barcode?: string }>();
  // A barcode arrives when this screen is reached from a scan that missed both
  // the local cache and Open Food Facts — storing it means the next scan hits.
  // The schema requires ≥6 digits (a short Code128 payload isn't a product
  // barcode); a shorter one is dropped so the save never trips the CHECK.
  const digits = (params.barcode ?? '').replace(/\D/g, '');
  const barcode = digits.length >= 6 ? digits : '';

  const [name, setName] = useState(params.name ?? '');
  const [brand, setBrand] = useState('');
  const [servingName, setServingName] = useState('');
  const [servingGrams, setServingGrams] = useState('');
  const [basis, setBasis] = useState<'serving' | 'per100'>('per100');
  const [kcal, setKcal] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [fiber, setFiber] = useState('');

  const numbersValid = [servingGrams, kcal, protein, carbs, fat, fiber].every(validNumber);
  const servingGramsNum = toNumber(servingGrams);
  const servingUsable = servingGramsNum !== null && servingGramsNum > 0;
  // The schema's pair-or-none rule, tightened to USABLE: a named serving needs
  // grams ABOVE ZERO and vice versa — "1 cup" of 0 g would pass a null-based
  // pairing check and then trip the DB CHECK into a silent dead end.
  const servingPaired = (servingName.trim() === '') === !servingUsable;
  const basisOk = basis === 'per100' || servingUsable;

  // Per-serving entries convert to canonical per-100 g on save.
  const factor = basis === 'serving' && servingUsable ? 100 / servingGramsNum : 1;
  const per100 = (text: string): number | null => {
    const n = toNumber(text);
    return n === null ? null : n * factor;
  };
  const kcal100 = per100(kcal);
  const macros100 = [per100(protein), per100(carbs), per100(fat), per100(fiber)];
  const boundsProblem = numbersValid && basisOk ? per100Problem(kcal100, macros100) : null;

  const canSave =
    name.trim() !== '' && numbersValid && servingPaired && basisOk && boundsProblem === null;

  const problem = !numbersValid
    ? 'Numbers only — leave a field blank if you don’t know it.'
    : !servingPaired
      ? 'A serving needs both a name and its grams above zero (or leave both blank).'
      : !basisOk
        ? 'Per-serving entry needs the serving grams filled in first.'
        : boundsProblem;

  const save = () => {
    if (!canSave) return;
    try {
      createFood(getDb(), {
        name: name.trim(),
        brand: brand.trim() === '' ? null : brand.trim(),
        barcode: barcode === '' ? null : barcode,
        serving_name: servingName.trim() === '' ? null : servingName.trim(),
        serving_grams: servingUsable ? servingGramsNum : null,
        kcal_100g: kcal100,
        protein_g_100g: macros100[0] ?? null,
        carbs_g_100g: macros100[1] ?? null,
        fat_g_100g: macros100[2] ?? null,
        fiber_g_100g: macros100[3] ?? null,
      });
      router.back();
    } catch (error) {
      // canSave gates the known cases; backstop so a write failure never
      // crashes the tap handler or loses the typed food.
      console.warn('[food-new] create failed', error);
    }
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Create a food" />
      </View>

      <View className="mt-2 rounded-card border border-hairline bg-porcelain p-4">
        <FormField label="Name" value={name} onChange={setName} placeholder="e.g. Overnight oats" />
        <View className="mt-3">
          <FormField label="Brand (optional)" value={brand} onChange={setBrand} placeholder="—" />
        </View>
        <View className="mt-3 flex-row gap-3">
          <FormField
            label="Serving name"
            value={servingName}
            onChange={setServingName}
            placeholder="e.g. 1 jar"
          />
          <FormField
            label="Serving grams"
            value={servingGrams}
            onChange={setServingGrams}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
          />
        </View>

        {/* Entry basis — stored per-100 g either way. */}
        <View className="mt-4 flex-row gap-2">
          {(
            [
              ['per100', 'Per 100 g'],
              ['serving', 'Per serving'],
            ] as const
          ).map(([key, label]) => (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={`Enter macros ${label}`}
              accessibilityState={{ selected: basis === key }}
              onPress={() => setBasis(key)}
              className={`rounded-btn border px-3 py-2 ${
                basis === key
                  ? 'border-hairline-strong bg-paper-deep'
                  : 'border-hairline bg-porcelain active:bg-paper-deep'
              }`}>
              <Text
                className={`text-xs ${basis === key ? 'font-semibold text-ink' : 'text-ink-secondary'}`}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>

        <View className="mt-3 flex-row gap-3">
          <FormField
            label="kcal"
            value={kcal}
            onChange={setKcal}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
          />
          <FormField
            label="Protein g"
            value={protein}
            onChange={setProtein}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
          />
        </View>
        <View className="mt-3 flex-row gap-3">
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
          <FormField
            label="Fiber g"
            value={fiber}
            onChange={setFiber}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
          />
        </View>

        {problem ? <Text className="mt-2 text-xs leading-5 text-ink-muted">{problem}</Text> : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save food"
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          onPress={save}
          className={`mt-4 h-12 items-center justify-center rounded-btn border ${
            canSave ? 'border-hairline-strong active:bg-paper-deep' : 'border-hairline'
          }`}>
          <Text className={`text-[15px] font-semibold ${canSave ? 'text-ink' : 'text-ink-muted'}`}>
            Save food
          </Text>
        </Pressable>
      </View>

      <Text className="mt-3 text-xs leading-5 text-ink-muted">
        Saved to your on-device catalog — it shows up in search and recents like any staple.
      </Text>
    </Screen>
  );
}
