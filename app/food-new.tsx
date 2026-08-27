import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, type TextInputProps, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { keypadDoneKey } from '@/components/ui/keyboard';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { createFood } from '@/lib/db/repositories/foods';

/**
 * Create a custom catalog food (source='user'), reached from food search with
 * the failed query prefilled. Macros can be typed per serving (the label way)
 * or per 100 g (the database way); storage is always canonical per-100 g
 * (docs/nutrition-subapp.md §3), so the per-serving path converts on save.
 *
 * Conformed Set treatment — **form (b) of the capture-surface rule** in
 * src/components/ui/block.tsx: this is a group of eleven labelled fields, so it
 * carries no block at all. Each `TextInput` wears the well's own tokens
 * (`border-paper-deep bg-paper-dim`) directly, `SectionLabel` names each group
 * and whitespace separates them — the same shape as app/capture.tsx and
 * app/symptom.tsx. Boxing the group in a `<Block device="well">` would put a
 * recess inside a recess and force every field up onto plate stock to stay
 * legible; an input is never `bg-paper-hi`. The closing note is a **margin
 * annotation**, because prose does not belong in a box.
 *
 * Field labels are the label voice, every numeric field is mono ("mono
 * measures"), and the entry-basis chips are controls, so they are label voice
 * too. **No accent on this screen**: creating a catalog entry is bookkeeping,
 * not the day's directive action.
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
  /**
   * Set ONLY when this field shares a `flex-row` with siblings and should take
   * an equal share of the width. See the note on {@link FormField} — passing it
   * in a column is what made Name, Brand and the serving row draw on top of
   * each other.
   */
  fill?: boolean;
};

/**
 * One labelled, recessed field.
 *
 * ## `flex-1` in a column is what made this screen paint over itself
 *
 * The wrapper used to be `<View className="flex-1">` unconditionally, and seven
 * of the nine fields here genuinely do share a row — so the flex looked like the
 * house style rather than a per-call-site decision. The two that do not share a
 * row are the first two the user meets: Name inside `<View className="mt-2">`
 * and Brand inside `<View className="mt-3">`, each the only child of its wrapper.
 *
 * In a column the main axis is vertical, so `flex-1` resolves to
 * `flexBasis: 0%` **on the height**. Those `mt-*` parents have no height of
 * their own — they size to their content, inside a `<Screen scroll>` — so there
 * is no free space for `flexGrow` to claim and the field lays out at **zero
 * height**. Yoga has no `min-height: auto` floor to rescue it, and views do not
 * clip, so the label and the ~46pt bordered `TextInput` still drew at their
 * natural size: on top of whatever came next. Name landed over Brand, Brand over
 * the Serving name / Serving grams row.
 *
 * That is the owner's report — boxes covering other boxes — and this screen is
 * where a barcode that missed both the local cache and Open Food Facts sends
 * you, so it is the first thing seen after a failed scan.
 *
 * So the flex is opt-in and named for what it is: `fill` belongs to a field
 * sharing a **row**, and nowhere else. The wrapper stays (a label stacked over
 * an input needs something to stack in) but it is plain by default; `fill` is
 * what the row distributes, so `fill` lands on the wrapper, not the input.
 * Same fix, same reasoning as app/protocol-edit.tsx.
 */
function FormField({ label, value, onChange, placeholder, keyboardType, mono, fill }: FieldProps) {
  return (
    <View className={fill ? 'flex-1' : undefined}>
      <Text className="mb-1 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={palette.inkMuted}
        keyboardType={keyboardType}
        returnKeyType={keypadDoneKey(keyboardType)}
        accessibilityLabel={label}
        className={
          mono
            ? 'border border-paper-deep bg-paper-dim px-3 py-3 font-mono text-[15px] text-ink'
            : 'border border-paper-deep bg-paper-dim px-3 py-3 font-serif text-[15px] text-ink'
        }
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

      <View className="mt-2">
        <SectionLabel label="Identity" note={barcode !== '' ? barcode : undefined} />

        {/* No `fill` on these two: they are alone in a column, and a flexed
            child of a content-height column collapses to nothing — see
            {@link FormField}. They already span the full width without it. */}
        <View className="mt-2">
          <FormField
            label="Name"
            value={name}
            onChange={setName}
            placeholder="e.g. Overnight oats"
          />
        </View>
        <View className="mt-3">
          <FormField label="Brand (optional)" value={brand} onChange={setBrand} placeholder="—" />
        </View>
        {/* `fill` on both: this row splits its width between them. */}
        <View className="mt-3 flex-row gap-3">
          <FormField
            label="Serving name"
            value={servingName}
            onChange={setServingName}
            placeholder="e.g. 1 jar"
            fill
          />
          <FormField
            label="Serving grams"
            value={servingGrams}
            onChange={setServingGrams}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
            fill
          />
        </View>

        <View className="mt-5">
          <SectionLabel label="Macros" note="Stored per 100 g" />
        </View>

        {/* Entry basis — stored per-100 g either way. */}
        <View className="mt-2 flex-row gap-2">
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
              className={
                basis === key
                  ? 'min-h-[44px] items-center justify-center rounded-btn border border-ink bg-paper-hi px-4'
                  : 'min-h-[44px] items-center justify-center rounded-btn border border-paper-deep px-4 active:opacity-60'
              }>
              <Text
                className={
                  basis === key
                    ? 'font-label text-[11px] font-semibold uppercase tracking-[1.2px] text-ink'
                    : 'font-label text-[11px] uppercase tracking-[1.2px] text-ink-secondary'
                }>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* `fill` throughout: the macro fields sit two and three to a row. */}
        <View className="mt-3 flex-row gap-3">
          <FormField
            label="kcal"
            value={kcal}
            onChange={setKcal}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
            fill
          />
          <FormField
            label="Protein g"
            value={protein}
            onChange={setProtein}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
            fill
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
            fill
          />
          <FormField
            label="Fat g"
            value={fat}
            onChange={setFat}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
            fill
          />
          <FormField
            label="Fiber g"
            value={fiber}
            onChange={setFiber}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
            fill
          />
        </View>

        {problem ? (
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
            {problem}
          </Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save food"
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          onPress={save}
          className={
            canSave
              ? 'mt-4 min-h-[44px] items-center justify-center rounded-btn border border-ink bg-paper-hi py-3 active:opacity-70'
              : 'mt-4 min-h-[44px] items-center justify-center rounded-btn border border-paper-deep py-3'
          }>
          <Text
            className={
              canSave
                ? 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink'
                : 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
            }>
            Save food
          </Text>
        </Pressable>
      </View>

      <View className="mt-3">
        <Block device="margin">
          <Text className="font-serif text-[13px] leading-5 text-ink-muted">
            Saved to your on-device catalog — it shows up in search and recents like any staple.
          </Text>
        </Block>
      </View>
    </Screen>
  );
}
