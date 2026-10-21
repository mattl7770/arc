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

import { SearchedLines } from '@/components/coach/searched-lines';
import { keypadDoneKey } from '@/components/ui/keyboard';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { createFood, foodUsage, getFood, updateFood } from '@/lib/db/repositories/foods';
import {
  estimateFoodEntry,
  isMealEstimationAvailable,
  MealEstimationUnavailableError,
  type FoodEntryEstimate,
} from '@/lib/nutrition/estimate';
import {
  emptyFoodForm,
  type FoodForm,
  foodEditConsequence,
  foodFormFromRow,
  microsText,
  numText,
  readFoodForm,
} from '@/lib/nutrition/food-form';
import { MICROS } from '@/lib/nutrition/micros';
import type { FoodRow } from '@/lib/nutrition/types';
import type { WebSearchSummary } from '@/lib/ai/web-search';

/**
 * Create a custom catalog food (source='user'), reached from food search with
 * the failed query prefilled — or, with `id`, EDIT one (owner, 2026-10-21:
 * *"edit saved foods"*). Macros can be typed per serving (the label way) or per
 * 100 (the database way); storage is always canonical per-100
 * (docs/nutrition-subapp.md §3), so the per-serving path converts on save. The
 * rules for what a Save writes are src/lib/nutrition/food-form.ts.
 *
 * Per 100 of WHAT is the Solid/Drink toggle (0047): a food is measured in grams
 * or in millilitres, one or the other for life, and nothing in ARC converts
 * between them. Solid is the default and every food created before the toggle
 * existed is one.
 *
 * ## Editing a food (2026-10-21)
 *
 * Reached from the pencil on Add food's open row and from the barcode
 * scanner's "Edit this food". The same form, opened on the row's own figures
 * per 100, and it saves through **`updateFood` — the function the Coach's
 * `food_catalog` edit calls** (docs/coach-domains.md: parity with the screens,
 * through the repositories). Three things differ from creating:
 *
 * - **No Describe it.** An edit corrects a food the user is looking at; a model
 *   rewriting every field of it is a different act, and creating is where it
 *   lives.
 * - **The consequence is stated above Save**, from `foodUsage`: the catalog
 *   entry changes, and every meal, template and recipe that used it keeps its
 *   own numbers — only what is added from now on reads the new figures.
 * - **Untouched figures are written back exactly**, not as the 2 dp the field
 *   printed (food-form.ts), and Save is inert until something changes. An
 *   edited Open Food Facts entry becomes the user's (`updateFood`), so a later
 *   re-fetch never overwrites the correction.
 *
 * ## Micros are typed now
 *
 * The whole shortlist is a field each, in its own unit, per 100 like the
 * macros (or per serving, under the same chip). Before this round micros had
 * no fields and a described food's were only read out; the owner asked to edit
 * them, and an edit screen that cannot correct a figure it shows is not one.
 *
 * Conformed Set treatment — **form (b) of the capture-surface rule** in
 * src/components/ui/block.tsx: this is a group of labelled fields, so it
 * carries no block at all. Each `TextInput` wears the well's own tokens
 * (`border-paper-deep bg-paper-dim`) directly, `SectionLabel` names each group
 * and whitespace separates them — the same shape as app/capture.tsx and
 * app/symptom.tsx. Boxing the group in a `<Block device="well">` would put a
 * recess inside a recess and force every field up onto plate stock to stay
 * legible; an input is never `bg-paper-hi`.
 *
 * Field labels are the label voice, every numeric field is mono ("mono
 * measures"), and the entry-basis chips are controls, so they are label voice
 * too. **No accent on this screen**: creating or correcting a catalog entry is
 * bookkeeping, not the day's directive action — and that survives C2, because
 * *Describe it* fills a form rather than committing a record. It wears the same
 * outlined treatment as Save.
 *
 * ## Describe it (C2, 2026-09-14)
 *
 * Owner: *"Describe a food in words and AI fills the catalog entry's macros —
 * yes."* Type "Costco rotisserie chicken thigh, skin on" and the model returns
 * one catalog entry — name, brand, basis, a household serving, per-100 macros,
 * and the micro shortlist where a serving is a notable source — which is
 * **rendered into the fields below for review**. It has its own small prompt,
 * not the meal estimator's, though the shortlist and its bar are the
 * estimator's own constants (src/lib/nutrition/estimate.ts).
 *
 * **Nothing is written until Save.** The model's reply lands in the same
 * state the keyboard writes to, so every number is editable before it becomes
 * a row, and the row it becomes is stamped `source: 'ai'` — an inferred number
 * must never wear the face of one the user typed (the 0034 rule), and
 * `app/food-search.tsx` prints `est` beside such an entry wherever it appears in
 * the catalog.
 *
 * **Offline is a sentence, never a broken form.** With no model key the field is
 * replaced by a line saying so and what still works; a call that cannot reach
 * the model says that and leaves every field below it exactly as it was —
 * typing the food in by hand is the path this screen already was.
 */

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
 * The wrapper used to be `<View className="flex-1">` unconditionally, and most
 * of the fields here genuinely do share a row — so the flex looked like the
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

/** Three to a row — the micro fields' grid. */
function rowsOf<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export default function FoodNewScreen() {
  const params = useLocalSearchParams<{
    name?: string;
    barcode?: string;
    brand?: string;
    /** A catalog food to EDIT (2026-10-21). */
    id?: string;
  }>();
  // Read once: the form is a draft of THIS row as it was opened, and a row
  // that moved under it is re-read the next time the screen opens.
  const [editing] = useState<FoodRow | undefined>(() =>
    params.id ? getFood(getDb(), params.id) : undefined
  );
  if (params.id && !editing) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Edit food" />
        </View>
        <Text className="mt-6 font-serif text-[14px] leading-6 text-ink-secondary">
          This food is gone — it may have been deleted.
        </Text>
      </Screen>
    );
  }
  return <FoodEntryForm editing={editing} params={params} />;
}

function FoodEntryForm({
  editing,
  params,
}: {
  editing: FoodRow | undefined;
  params: { name?: string; barcode?: string; brand?: string };
}) {
  const router = useRouter();
  // A barcode arrives when this screen is reached from a scan that missed both
  // the local cache and Open Food Facts — storing it means the next scan hits.
  // The schema requires ≥6 digits (a short Code128 payload isn't a product
  // barcode); a shorter one is dropped so the save never trips the CHECK. An
  // edit keeps the row's own.
  const digits = (params.barcode ?? '').replace(/\D/g, '');
  const barcode = editing ? editing.barcode : digits.length >= 6 ? digits : null;

  // The form as it opened — what an edit compares against to write untouched
  // figures back exactly, and to know whether anything changed at all.
  const [opened] = useState<FoodForm>(() =>
    editing
      ? foodFormFromRow(editing)
      : { ...emptyFoodForm(params.name ?? ''), brand: params.brand ?? '' }
  );
  const [form, setForm] = useState<FoodForm>(opened);
  const set = (patch: Partial<FoodForm>) => setForm((prev) => ({ ...prev, ...patch }));
  const setMicro = (key: (typeof MICROS)[number]['key'], text: string) =>
    setForm((prev) => ({ ...prev, micros: { ...prev.micros, [key]: text } }));
  const { unit, entryBasis } = form;

  // --- Describe it (C2) ----------------------------------------------------
  const [description, setDescription] = useState('');
  const [describing, setDescribing] = useState(false);
  const [describeProblem, setDescribeProblem] = useState<string | null>(null);
  /** True once a reply has filled the fields — it is what stamps `source: 'ai'`
   *  on save, and what puts the estimate note above the fields. It survives the
   *  user editing them: most of the numbers are still the model's, and a
   *  half-corrected estimate is still an estimate. */
  const [described, setDescribed] = useState(false);
  /** What the model looked up for the last description, for the Searched line. */
  const [searches, setSearches] = useState<WebSearchSummary[]>([]);
  const keySet = isMealEstimationAvailable();
  // The model call is a live stream. Leaving mid-describe must stop it, or it
  // runs to completion and is billed in full while its result lands on an
  // unmounted screen — the same guard app/meal-estimate.tsx keeps.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  /** Render one proposed entry into the form. Every field, including the ones
   *  the model left null — a second description must not leave the first one's
   *  numbers standing under a name they no longer belong to. The reply is per
   *  100 of the basis, which is what the form stores canonically — so the basis
   *  chip goes to per-100 and nothing is converted. */
  const applyEntry = (entry: FoodEntryEstimate) => {
    setForm({
      name: entry.name,
      brand: entry.brand ?? '',
      unit: entry.basis,
      servingName: entry.serving_name ?? '',
      servingAmount: numText(entry.serving_amount),
      entryBasis: 'per100',
      kcal: numText(entry.kcal_100g),
      protein: numText(entry.protein_g_100g),
      carbs: numText(entry.carbs_g_100g),
      fat: numText(entry.fat_g_100g),
      fiber: numText(entry.fiber_g_100g),
      micros: microsText(entry.micros),
    });
    setSearches(entry.searches ?? []);
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

  const result = readFoodForm(form, {
    barcode,
    // THE STAMP. A described entry is provenance-marked for life: the catalog
    // prints `est` beside it. An edit keeps the row's own provenance (updateFood
    // owns the one change it makes to it).
    source: editing ? editing.source : described ? 'ai' : 'user',
    original: editing ? { food: editing, form: opened } : undefined,
  });
  // A micro typed and cleared again is no change: compare without the blanks.
  const comparable = (f: FoodForm) =>
    JSON.stringify({
      ...f,
      micros: MICROS.map((m) => (f.micros[m.key] ?? '').trim()),
    });
  const changed = comparable(form) !== comparable(opened);
  const canSave = result.ok && (editing === undefined || changed);
  const problem = result.ok ? null : result.problem;

  const save = () => {
    if (!result.ok || !canSave) return;
    try {
      if (editing) updateFood(getDb(), editing.id, result.food);
      else createFood(getDb(), result.food);
      router.back();
    } catch (error) {
      // canSave gates the known cases; backstop so a write failure never
      // crashes the tap handler or loses the typed food.
      console.warn(editing ? '[food-new] update failed' : '[food-new] create failed', error);
    }
  };

  // What an edit does, before it does it — counted once, as it opens.
  const [usage] = useState(() => (editing ? foodUsage(getDb(), editing.id) : null));
  const consequence =
    editing && usage && changed
      ? foodEditConsequence(usage, form.servingName.trim() !== (editing.serving_name ?? ''))
      : null;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={editing ? 'Edit food' : 'Create a food'} />
      </View>

      {/* DESCRIBE IT — the C2 path, above the form it fills. It is first
          because it is the shortcut PAST everything below; putting it under the
          fields would be offering the shortcut after the walk. Creating only.

          No block: this screen carries none (form (b) of the capture-surface
          rule), so the field wears the well's own tokens like every other input
          here, and the labelled group is separated by whitespace. */}
      {editing ? null : (
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
              Describing a food needs a model key — the same one the Coach uses. Add one in the
              Coach tab; everything below works without it.
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
          {described ? <SearchedLines searches={searches} /> : null}
        </View>
      )}

      <View className={editing ? 'mt-2' : 'mt-5'}>
        <SectionLabel label="Identity" note={barcode ?? undefined} />

        {/* No `fill` on these two: they are alone in a column, and a flexed
            child of a content-height column collapses to nothing — see
            {@link FormField}. They already span the full width without it. */}
        <View className="mt-2">
          <FormField
            label="Name"
            value={form.name}
            onChange={(name) => set({ name })}
            placeholder="e.g. Overnight oats"
          />
        </View>
        <View className="mt-3">
          <FormField
            label="Brand (optional)"
            value={form.brand}
            onChange={(brand) => set({ brand })}
            placeholder="—"
          />
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
              onPress={() => set({ unit: key })}
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
            value={form.servingName}
            onChange={(servingName) => set({ servingName })}
            placeholder={unit === 'ml' ? 'e.g. 1 can' : 'e.g. 1 jar'}
            fill
          />
          <FormField
            label={unit === 'ml' ? 'Serving ml' : 'Serving grams'}
            value={form.servingAmount}
            onChange={(servingAmount) => set({ servingAmount })}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
            fill
          />
        </View>

        <View className="mt-5">
          <SectionLabel label="Macros" note={`Stored per 100 ${unit}`} />
        </View>

        {/* Entry basis — stored per-100 of the food's unit either way. It
            governs the micro fields below too. */}
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
              accessibilityLabel={`Enter figures ${label}`}
              accessibilityState={{ selected: entryBasis === key }}
              onPress={() => set({ entryBasis: key })}
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
            value={form.kcal}
            onChange={(kcal) => set({ kcal })}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
            fill
          />
          <FormField
            label="Protein g"
            value={form.protein}
            onChange={(protein) => set({ protein })}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
            fill
          />
        </View>
        <View className="mt-3 flex-row gap-3">
          <FormField
            label="Carbs g"
            value={form.carbs}
            onChange={(carbs) => set({ carbs })}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
            fill
          />
          <FormField
            label="Fat g"
            value={form.fat}
            onChange={(fat) => set({ fat })}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
            fill
          />
          <FormField
            label="Fiber g"
            value={form.fiber}
            onChange={(fiber) => set({ fiber })}
            placeholder="—"
            keyboardType="decimal-pad"
            mono
            fill
          />
        </View>

        {/* Micros — the shortlist, a field each in its own unit, under the
            same per-100 / per-serving chip as the macros. Blank is not
            recorded, never 0. */}
        <View className="mt-5">
          <SectionLabel
            label="Micros"
            note={entryBasis === 'serving' ? 'Per serving' : `Per 100 ${unit}`}
          />
        </View>
        {rowsOf(MICROS, 3).map((row) => (
          <View key={row[0]!.key} className="mt-3 flex-row gap-3">
            {row.map((m) => (
              <FormField
                key={m.key}
                label={`${m.label} ${m.unit}`}
                value={form.micros[m.key] ?? ''}
                onChange={(text) => setMicro(m.key, text)}
                placeholder="—"
                keyboardType="decimal-pad"
                mono
                fill
              />
            ))}
          </View>
        ))}

        {problem ? (
          <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
            {problem}
          </Text>
        ) : null}
        {consequence && result.ok ? (
          <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
            {consequence}
          </Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={editing ? 'Save changes to this food' : 'Save food'}
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
            {editing ? 'Save changes' : 'Save food'}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

