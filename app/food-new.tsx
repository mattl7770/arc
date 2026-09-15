import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';

import { keypadDoneKey } from '@/components/ui/keyboard';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { createFood } from '@/lib/db/repositories/foods';
import type { JsonText } from '@/lib/db/types';
import {
  estimateFoodEntry,
  isMealEstimationAvailable,
  MealEstimationUnavailableError,
  type FoodEntryEstimate,
} from '@/lib/nutrition/estimate';
import type { AmountUnit } from '@/lib/nutrition/types';

/**
 * Create a custom catalog food (source='user'), reached from food search with
 * the failed query prefilled. Macros can be typed per serving (the label way)
 * or per 100 (the database way); storage is always canonical per-100
 * (docs/nutrition-subapp.md §3), so the per-serving path converts on save.
 *
 * Per 100 of WHAT is the Solid/Drink toggle (0047): a food is measured in grams
 * or in millilitres, one or the other for life, and nothing in ARC converts
 * between them. Solid is the default and every food created before the toggle
 * existed is one.
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
 * not the day's directive action — and that survives C2, because *Describe it*
 * fills a form rather than committing a record. It wears the same outlined
 * treatment as Save.
 *
 * ## Describe it (C2, 2026-09-14)
 *
 * Owner: *"Describe a food in words and AI fills the catalog entry's macros —
 * yes."* Type "Costco rotisserie chicken thigh, skin on" and the model returns
 * one catalog entry — name, brand, basis, a household serving, per-100 macros,
 * and sodium/caffeine where they are plausible — which is **rendered into the
 * fields below for review**. It has its own small prompt, not the meal
 * estimator's (src/lib/nutrition/estimate.ts).
 *
 * **Nothing is written until Save.** The model's reply lands in the same
 * `useState` the keyboard writes to, so every number is editable before it
 * becomes a row, and the row it becomes is stamped `source: 'ai'` — an inferred
 * number must never wear the face of one the user typed (the 0034 rule), and
 * `app/food-search.tsx` prints `est` beside such an entry wherever it appears in
 * the catalog.
 *
 * **Offline is a sentence, never a broken form.** With no model key the field is
 * replaced by a line saying so and what still works; a call that cannot reach
 * the model says that and leaves every field below it exactly as it was —
 * typing the food in by hand is the path this screen already was.
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

/** A model-proposed figure as the form's own text. Rounded to 2 dp — the same
 *  precision the per-serving conversion below rounds to, and more than anyone
 *  needs from an estimate. Null renders as the empty field it is. */
function numText(value: number | null): string {
  return value === null ? '' : String(Math.round(value * 100) / 100);
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
  const [entryBasis, setEntryBasis] = useState<'serving' | 'per100'>('per100');
  /** What this food is measured in (0047). Solid by default — most foods are,
   * and every food that existed before this toggle was. Choosing Drink changes
   * the unit of EVERY amount the food carries: its serving size, its per-100
   * macros, and every portion logged from it. Nothing converts between the two,
   * so this is a property of the food, not a display choice. */
  const [unit, setUnit] = useState<AmountUnit>('g');
  const [kcal, setKcal] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [fiber, setFiber] = useState('');
  /** The model's per-100 sodium/caffeine, carried straight to the row. There is
   *  no field for these — the shortlist is read-only on the micros screen — so
   *  they ride in state rather than through the form. Null for a typed food, and
   *  for a described one the model had nothing plausible to say about. */
  const [micros, setMicros] = useState<JsonText | null>(null);

  // --- Describe it (C2) ----------------------------------------------------
  const [description, setDescription] = useState('');
  const [describing, setDescribing] = useState(false);
  const [describeProblem, setDescribeProblem] = useState<string | null>(null);
  /** True once a reply has filled the fields — it is what stamps `source: 'ai'`
   *  on save, and what puts the estimate note above the fields. It survives the
   *  user editing them: most of the numbers are still the model's, and a
   *  half-corrected estimate is still an estimate. */
  const [described, setDescribed] = useState(false);
  const keySet = isMealEstimationAvailable();
  // The model call is a live stream. Leaving mid-describe must stop it, or it
  // runs to completion and is billed in full while its result lands on an
  // unmounted screen — the same guard app/meal-estimate.tsx keeps.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  /** Render one proposed entry into the form. Every field, including the ones
   *  the model left null — a second description must not leave the first one's
   *  numbers standing under a name they no longer belong to. */
  const applyEntry = (entry: FoodEntryEstimate) => {
    setName(entry.name);
    setBrand(entry.brand ?? '');
    setUnit(entry.basis);
    setServingName(entry.serving_name ?? '');
    setServingGrams(numText(entry.serving_amount));
    // The reply is per 100 of the basis, which is what the form stores
    // canonically — so the basis chip goes to per-100 and nothing is converted.
    setEntryBasis('per100');
    setKcal(numText(entry.kcal_100g));
    setProtein(numText(entry.protein_g_100g));
    setCarbs(numText(entry.carbs_g_100g));
    setFat(numText(entry.fat_g_100g));
    setFiber(numText(entry.fiber_g_100g));
    setMicros(entry.micros);
    setDescribed(true);
  };

  const describe = async () => {
    const text = description.trim();
    if (text === '' || describing) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setDescribing(true);
    setDescribeProblem(null);
    try {
      applyEntry(await estimateFoodEntry(text, controller.signal));
    } catch (error) {
      if (controller.signal.aborted) return;
      setDescribeProblem(
        error instanceof MealEstimationUnavailableError
          ? 'Describing a food needs a model key — the same one the Coach uses.'
          : 'Couldn’t reach the model. Check your connection, or fill the fields in below by hand.'
      );
    } finally {
      setDescribing(false);
    }
  };

  const numbersValid = [servingGrams, kcal, protein, carbs, fat, fiber].every(validNumber);
  const servingGramsNum = toNumber(servingGrams);
  const servingUsable = servingGramsNum !== null && servingGramsNum > 0;
  // The schema's pair-or-none rule, tightened to USABLE: a named serving needs
  // grams ABOVE ZERO and vice versa — "1 cup" of 0 g would pass a null-based
  // pairing check and then trip the DB CHECK into a silent dead end.
  const servingPaired = (servingName.trim() === '') === !servingUsable;
  const entryBasisOk = entryBasis === 'per100' || servingUsable;

  // Per-serving entries convert to canonical per-100 g on save. Only that path
  // multiplies by a non-integer factor, and IEEE-754 overshoots on it: 14 g of
  // fat in a 14 g serving yields 100.00000000000001, which reads as >100 and
  // trips both the macro-cap guard below and the DB CHECK — so a 100%-macro
  // staple (olive oil, sugar, an isolate) could not be saved. Round the
  // converted value to 2 dp; a per-100 g entry is factor 1 and stored verbatim.
  const round2 = (v: number): number => Math.round(v * 100) / 100;
  const factor = entryBasis === 'serving' && servingUsable ? 100 / servingGramsNum : 1;
  const per100 = (text: string): number | null => {
    const n = toNumber(text);
    if (n === null) return null;
    return entryBasis === 'serving' ? round2(n * factor) : n;
  };
  const kcal100 = per100(kcal);
  const macros100 = [per100(protein), per100(carbs), per100(fat), per100(fiber)];
  const boundsProblem = numbersValid && entryBasisOk ? per100Problem(kcal100, macros100) : null;

  const canSave =
    name.trim() !== '' && numbersValid && servingPaired && entryBasisOk && boundsProblem === null;

  const problem = !numbersValid
    ? 'Numbers only — leave a field blank if you don’t know it.'
    : !servingPaired
      ? `A serving needs both a name and its ${unit} above zero (or leave both blank).`
      : !entryBasisOk
        ? `Per-serving entry needs the serving ${unit} filled in first.`
        : boundsProblem;

  const save = () => {
    if (!canSave) return;
    try {
      createFood(getDb(), {
        name: name.trim(),
        brand: brand.trim() === '' ? null : brand.trim(),
        barcode: barcode === '' ? null : barcode,
        serving_name: servingName.trim() === '' ? null : servingName.trim(),
        serving_amount: servingUsable ? servingGramsNum : null,
        basis: unit,
        kcal_100g: kcal100,
        protein_g_100g: macros100[0] ?? null,
        carbs_g_100g: macros100[1] ?? null,
        fat_g_100g: macros100[2] ?? null,
        fiber_g_100g: macros100[3] ?? null,
        micros,
        // THE STAMP. A described entry is provenance-marked for life: the
        // catalog prints `est` beside it, and nothing downstream has to infer
        // from the numbers whether a human typed them. A typed food keeps the
        // repository's own default ('user').
        source: described ? 'ai' : 'user',
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

      {/* DESCRIBE IT — the C2 path, above the form it fills. It is first
          because it is the shortcut PAST everything below; putting it under the
          fields would be offering the shortcut after the walk.

          No block: this screen carries none (form (b) of the capture-surface
          rule), so the field wears the well's own tokens like every other input
          here, and the labelled group is separated by whitespace. */}
      <View className="mt-2">
        <SectionLabel label="Describe it" note={described ? 'Estimated' : undefined} />
        {keySet ? (
          <>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="e.g. Costco rotisserie chicken thigh, skin on"
              placeholderTextColor={palette.inkMuted}
              multiline
              accessibilityLabel="Describe the food"
              className="mt-2 min-h-[64px] border border-paper-deep bg-paper-dim px-3 py-3 font-serif text-[15px] leading-6 text-ink"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Fill the fields from this description"
              accessibilityState={{ disabled: description.trim() === '' || describing }}
              disabled={description.trim() === '' || describing}
              onPress={() => void describe()}
              className={
                description.trim() === '' || describing
                  ? 'mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-paper-deep py-3'
                  : 'mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-ink bg-paper-hi py-3 active:opacity-70'
              }>
              {describing ? (
                <ActivityIndicator color={palette.inkSecondary} />
              ) : (
                <Ionicons
                  name="sparkles-outline"
                  size={17}
                  color={description.trim() === '' ? palette.inkMuted : palette.inkSecondary}
                />
              )}
              <Text
                className={
                  description.trim() === '' || describing
                    ? 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
                    : 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink'
                }>
                {describing ? 'Describing…' : 'Fill from description'}
              </Text>
            </Pressable>
          </>
        ) : (
          /* The honest offline/unconfigured state: a sentence, and what still
             works. Never a field that looks live and answers nothing. */
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
            Describing a food needs a model key — the same one the Coach uses. Add one in the Coach
            tab; everything below works without it.
          </Text>
        )}
        {describeProblem ? (
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
            {describeProblem}
          </Text>
        ) : null}
        {described ? (
          /* The 0034 rule, said out loud at the moment it applies: these are
             inferred numbers, they are editable, and the row will carry the
             mark. The future tense is deliberate — nothing has been written. */
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-muted">
            Estimated by the model — check the numbers below. Nothing is saved until you tap Save
            food, and the entry will be marked as an estimate in your catalog.
          </Text>
        ) : null}
      </View>

      <View className="mt-5">
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
        {/* Solid or drink — the food's unit (0047). It sits ABOVE the serving
            row because it names what that row's number counts, and above the
            macros because they are per 100 of it. Two whole class strings, never
            a built fragment: Tailwind's scanner only sees literal names. */}
        <View className="mt-3 flex-row gap-2">
          {(
            [
              ['g', 'Solid · g'],
              ['ml', 'Drink · ml'],
            ] as const
          ).map(([key, label]) => (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={key === 'ml' ? 'Measured in millilitres' : 'Measured in grams'}
              accessibilityState={{ selected: unit === key }}
              onPress={() => setUnit(key)}
              className={
                unit === key
                  ? 'min-h-[44px] items-center justify-center rounded-btn border border-ink bg-paper-hi px-4'
                  : 'min-h-[44px] items-center justify-center rounded-btn border border-paper-deep px-4 active:opacity-60'
              }>
              <Text
                className={
                  unit === key
                    ? 'font-label text-[11px] font-semibold uppercase tracking-[1.2px] text-ink'
                    : 'font-label text-[11px] uppercase tracking-[1.2px] text-ink-secondary'
                }>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* `fill` on both: this row splits its width between them. */}
        <View className="mt-3 flex-row gap-3">
          <FormField
            label="Serving name"
            value={servingName}
            onChange={setServingName}
            placeholder={unit === 'ml' ? 'e.g. 1 can' : 'e.g. 1 jar'}
            fill
          />
          <FormField
            label={unit === 'ml' ? 'Serving ml' : 'Serving grams'}
            value={servingGrams}
            onChange={setServingGrams}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
            fill
          />
        </View>

        <View className="mt-5">
          <SectionLabel label="Macros" note={`Stored per 100 ${unit}`} />
        </View>

        {/* Entry basis — stored per-100 of the food's unit either way. */}
        <View className="mt-2 flex-row gap-2">
          {(
            [
              ['per100', unit === 'ml' ? 'Per 100 ml' : 'Per 100 g'],
              ['serving', 'Per serving'],
            ] as const
          ).map(([key, label]) => (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={`Enter macros ${label}`}
              accessibilityState={{ selected: entryBasis === key }}
              onPress={() => setEntryBasis(key)}
              className={
                entryBasis === key
                  ? 'min-h-[44px] items-center justify-center rounded-btn border border-ink bg-paper-hi px-4'
                  : 'min-h-[44px] items-center justify-center rounded-btn border border-paper-deep px-4 active:opacity-60'
              }>
              <Text
                className={
                  entryBasis === key
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
    </Screen>
  );
}
