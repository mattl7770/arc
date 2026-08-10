import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter, useSegments } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, type TextInputProps, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import { logMeal } from '@/lib/db/repositories/nutrition';
import { useNutrition } from '@/hooks/use-nutrition';
import { fmtInt, macroLine } from '@/lib/nutrition/format';
import type { MealRow, NutritionTargetsRow } from '@/lib/nutrition/types';

/**
 * Nutrition sub-app home. It renders at two routes: as the **Eat tab** root
 * (app/(tabs)/eat.tsx re-exports this file) and as a stack-pushed screen from
 * the Log tab's Nutrition tile and Data's Nutrition trend row.
 *
 * ## Two routes, two headers (owner call on hardware, 2026-08-09)
 *
 * This file used to open with `<StackHeader title="Nutrition" />` at both, so
 * the Eat tab drew a back chevron. It *worked* — the tab navigator runs
 * `backBehavior="history"` — but a tab root has nothing to go back to, and every
 * other tab owns a plain serif title instead (app/(tabs)/log.tsx, data.tsx). A
 * back control that returns you to a *different tab* is the wrong grammar for
 * the bottom bar.
 *
 * The two cases are told apart by `useSegments()`, not by `router.canGoBack()`:
 * with `backBehavior="history"` the tab root can very often go back, so that
 * test would keep drawing the chevron exactly where it is wrong. Route shape is
 * the honest signal — `(tabs)` is the first segment only when this screen IS the
 * tab.
 *
 * The title stays "Nutrition" in both places. The tab bar says EAT because five
 * characters is the width budget (app/(tabs)/_layout.tsx); the screen has no
 * such constraint, and one name for one screen beats a label that changes with
 * the door you came through.
 *
 * The hub of the food-logging family (docs/nutrition-subapp.md): the Today
 * card reads real intake against the real (versioned) daily targets — or shows
 * no denominators at all until targets are set, never a placeholder; "Add
 * food" pushes the catalog search; manual entry stays as the free-form path;
 * "Eaten today" rows push meal detail. The pine "describe or snap" action
 * remains a labelled stub until the Coach's model client lands (Phase 3) —
 * the estimation seam is src/lib/nutrition/estimate.ts.
 *
 * ## Conformed Set surface system (00-design-spec.md §1)
 *
 *   Today          → **grid**. Energy and the macro cells are a metric grid, so
 *                    the grid IS the object: no outer box AND no rules, held by
 *                    alignment and whitespace alone (src/components/ui/block.tsx,
 *                    metrics-strip.tsx).
 *   Log a meal     → a **stamped plate** for the one next action, then a
 *                    **ruled plate** holding the remaining entry paths as a
 *                    record list. Manual entry opens a **deviceless field
 *                    group** below the plate: each input is already recessed
 *                    stock, so a well around them would stack two recesses
 *                    (src/components/ui/block.tsx).
 *   Eaten today    → **ruled plate**: the day's record is a table.
 *   Review         → **ruled plate**: two more record rows.
 *
 * **The ledger rule.** "Eaten today" carries the day's kcal on its own section
 * label, and every meal it holds shows its own kcal, because a ledger has to
 * sum to its own total (00-design-spec.md §5). Both numbers come from the same
 * `meals` rows for the same date — `listTodayMeals` — and, critically, from the
 * same rounding: the header is the sum of the rounded rows, not a second
 * independent rounding of the raw sum. See `sumRounded` for why those two are
 * not the same number.
 *
 * **Accent budget: one.** The "Describe or snap a meal" stamp is this screen's
 * single primary action. Target-progress fills are deliberately neutral ink:
 * hitting a macro target is worth showing, but spending the accent on four or
 * five of them at once would make the one directive action stop reading as
 * directive. And a met macro is not a biological state, so it never borrows a
 * signal colour either.
 */

/**
 * The two columns of the Today grid. React Native has no CSS grid and no
 * `:nth-child`, so the modulo is computed in JS (01-rn-port-guide.md §1.3) —
 * but what it selects now is only PADDING. **No rules.** The gutter keeps the
 * right column's text off the left column's and `pt-4` gives the row rhythm the
 * old top rule used to; src/components/home/metrics-strip.tsx is the reference
 * form and this matches it byte for byte.
 *
 * The `count` argument is gone with them. It existed so the right-hand rule
 * could be conditioned on a cell actually FOLLOWING — with an odd cell count
 * (three macros and no fiber target) the naive test drew a rule into empty
 * space. Nothing is drawn now, so nothing can dangle.
 */
const CELL_LEFT = 'w-1/2 pr-3 pt-4';
const CELL_RIGHT = 'w-1/2 pl-3 pt-4';

function cellClass(index: number): string {
  return index % 2 === 0 ? CELL_LEFT : CELL_RIGHT;
}

/**
 * A square progress rule against a target. Neutral ink, never the accent and
 * never a signal colour: progress toward a macro target is chrome, and a met
 * target is a fact about the log rather than about the body. Met reads as full
 * ink, short reads as the softer secondary — the numbers above carry the rest.
 */
function TargetRule({ value, target }: { value: number; target: number }) {
  const met = value >= target;
  return (
    <View className="mt-1.5 h-[3px] bg-paper-deep">
      <View
        className={met ? 'h-[3px] bg-ink' : 'h-[3px] bg-ink-secondary'}
        style={{ width: `${Math.min(100, (value / target) * 100)}%` }}
      />
    </View>
  );
}

/** One macro cell of the Today grid. Every number is a measurement, so every
 * number is mono; the label is the label voice. No target, no denominator —
 * the value stands alone rather than inventing an "x / —". */
function MacroCell({
  label,
  grams,
  target,
  className,
}: {
  label: string;
  grams: number;
  target: number | null;
  className: string;
}) {
  return (
    <View className={className}>
      <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {label}
      </Text>
      <View className="mt-1 flex-row items-baseline gap-1">
        <Text className="font-mono text-lg font-semibold text-ink">{Math.round(grams)}</Text>
        <Text className="font-mono text-[10px] text-ink-muted">
          {target !== null ? `/ ${Math.round(target)}g` : 'g'}
        </Text>
      </View>
      {target !== null && target > 0 ? <TargetRule value={grams} target={target} /> : null}
    </View>
  );
}

/** The Today-grid corner: the kcal denominator when one exists (a measured
 * value → mono voice), otherwise the invitation to set targets (a control →
 * label voice). Either way it opens the targets editor. */
function targetsCorner(targets: NutritionTargetsRow | null): { label: string; mono: boolean } {
  if (targets === null) return { label: 'Set daily targets', mono: false };
  if (targets.kcal !== null) return { label: `of ${fmtInt(targets.kcal)} target`, mono: true };
  return { label: 'Edit targets', mono: false };
}

/**
 * The day's displayed totals, summed from the values the rows actually show.
 *
 * **The rounding policy (00-design-spec.md §5).** A meal's kcal and macros are
 * stored as reals — a catalog item scaled to 138 g rarely lands on a whole
 * number — and every row renders them rounded (`fmtInt`, `macroLine`). The day
 * total used to be rounded independently, from SQL's `sum()` over the raw
 * reals, so `round(Σx)` was compared against the visible `Σround(x)` and the
 * two need not agree: three meals of 100.4 kcal show as 100 + 100 + 100 = 300
 * while the header claims round(301.2) = 301. A ledger that does not add up is
 * the one thing §5 rules out.
 *
 * So: **round once, at the row, and total what is on screen.** Every displayed
 * figure on this card is the sum of the rounded rows beneath it, which makes
 * the "Eaten today" list the literal arithmetic behind the "Today" header
 * rather than an approximation of it. The cost is that the header can drift up
 * to half a kcal per meal from the stored truth — invisible at the precision
 * anyone eats at, and far cheaper than a total that visibly fails to sum. The
 * alternative §5 allows (carry one decimal everywhere) would put "100.4 kcal"
 * on every meal row to fix an error nobody can see.
 *
 * NULL is skipped, not zeroed: a meal with no recorded protein must not drag
 * the day's protein down, and the row shows nothing for it either.
 */
function sumRounded(values: (number | null)[]): number {
  return values.reduce<number>(
    (total, value) => total + (value == null ? 0 : Math.round(value)),
    0
  );
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

type FieldProps = {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  keyboardType?: TextInputProps['keyboardType'];
  mono?: boolean;
  maxLength?: number;
};

/**
 * One labelled field of the manual meal form. The input wears the well's own
 * tokens — `border-paper-deep bg-paper-dim` — because it *is* the well: this is
 * form (b) of the capture-surface rule in src/components/ui/block.tsx. It used
 * to sit on `bg-paper-hi` inside a `<Block device="well">`, which is the
 * inversion that rule now forbids: a recessed container holding raised inputs,
 * with the raise there only to keep the field visible against the recess it was
 * stacked on. An input is never `bg-paper-hi`.
 */
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
      <Text className="mb-1 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={palette.inkMuted}
        keyboardType={keyboardType}
        maxLength={maxLength}
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

/**
 * The manual "Add a meal" form. A group of labelled fields, so it carries **no
 * device**: each field is already recessed stock, and boxing them in a
 * `<Block device="well">` would put a recess inside a recess (form (b) of the
 * capture-surface rule, src/components/ui/block.tsx). The disclosure row above
 * — "Manual entry", chevron up — is what ties this group to the plate it opened
 * from; whitespace does the rest, the way it does on app/capture.tsx and
 * app/symptom.tsx.
 *
 * Mounted fresh each time it opens, so the time defaults to now and a saved
 * form comes back empty. Numbers are optional — blank stores NULL ("not
 * recorded"), never 0.
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
    <View>
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

      {problem ? (
        <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">{problem}</Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save meal"
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
          Save meal
        </Text>
      </Pressable>
    </View>
  );
}

/** One ruled row of an action plate: icon, label, and the affordance chevron. */
function ActionRow({
  icon,
  label,
  detail,
  chevron,
  first,
  expanded,
  accessibilityLabel,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  detail?: string;
  chevron: keyof typeof Ionicons.glyphMap;
  first: boolean;
  expanded?: boolean;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      className={
        first
          ? 'min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60'
          : 'min-h-[44px] flex-row items-center gap-3 border-t border-hairline py-3 active:opacity-60'
      }>
      <Ionicons name={icon} size={17} color={palette.inkSecondary} />
      <View className="flex-1">
        <Text className="font-serif text-[15px] text-ink">{label}</Text>
        {detail ? (
          <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-muted">{detail}</Text>
        ) : null}
      </View>
      <Ionicons name={chevron} size={16} color={palette.inkMuted} />
    </Pressable>
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
      className={
        first
          ? 'min-h-[44px] flex-row gap-3 py-3 active:opacity-60'
          : 'min-h-[44px] flex-row gap-3 border-t border-hairline py-3 active:opacity-60'
      }>
      <Text className="w-11 pt-0.5 font-mono text-[11px] text-ink-muted">{meal.time ?? '—'}</Text>
      <View className="flex-1">
        <Text className="font-serif text-[15px] leading-5 text-ink">{meal.name}</Text>
        {detail !== '' ? (
          <Text
            className={
              meal.notes
                ? 'mt-0.5 font-serif text-[13px] leading-5 text-ink-muted'
                : 'mt-0.5 font-mono text-[11px] leading-4 text-ink-muted'
            }>
            {detail}
          </Text>
        ) : null}
      </View>
      {/* The rounding site of record: `fmtInt` rounds here, and the Today
          header totals these rounded rows rather than rounding again from the
          raw sum (see sumRounded). No kcal recorded reads as an em-dash and
          contributes nothing — never a fabricated 0. */}
      <Text className="pt-0.5 font-mono text-[13px] text-ink-secondary">
        {meal.kcal != null ? fmtInt(meal.kcal) : '—'}
      </Text>
    </Pressable>
  );
}

export default function NutritionScreen() {
  const router = useRouter();
  // `(tabs)` leads the segments only when this file is rendering AS the Eat tab
  // root; the pushed route is plain `/nutrition`. See the header note above.
  const isTabRoot = useSegments()[0] === '(tabs)';
  // `totals` (SQL's sum over the raw reals) is deliberately not destructured:
  // what this card shows is `shown`, the sum of the rounded rows. See
  // sumRounded — displaying both would be displaying two different days.
  const { meals, fiberTotal, itemCounts, targets, reload } = useNutrition();
  const [formOpen, setFormOpen] = useState(false);

  const openForm = () => {
    setFormOpen((open) => !open);
  };

  const saved = () => {
    setFormOpen(false);
    reload();
  };

  const corner = targetsCorner(targets);
  const kcalTarget = targets?.kcal ?? null;
  const fiberTarget = targets?.fiber_g ?? null;

  // Every figure on the Today card, totalled from the rows "Eaten today" shows.
  const shown = {
    kcal: sumRounded(meals.map((m) => m.kcal)),
    protein_g: sumRounded(meals.map((m) => m.protein_g)),
    carbs_g: sumRounded(meals.map((m) => m.carbs_g)),
    fat_g: sumRounded(meals.map((m) => m.fat_g)),
  };

  // Fiber joins the grid only when a target governs it — the day's fiber is
  // summed from item snapshots, so without a target it has no frame of
  // reference on this card and belongs on the micronutrients screen instead.
  // It is the one cell rounded once rather than per row, and correctly so: no
  // meal row displays fiber, so there is no visible addition for it to fail.
  const cells: { label: string; grams: number; target: number | null }[] = [
    { label: 'Protein', grams: shown.protein_g, target: targets?.protein_g ?? null },
    { label: 'Carbs', grams: shown.carbs_g, target: targets?.carbs_g ?? null },
    { label: 'Fat', grams: shown.fat_g, target: targets?.fat_g ?? null },
    ...(fiberTarget !== null ? [{ label: 'Fiber', grams: fiberTotal, target: fiberTarget }] : []),
  ];

  return (
    <Screen scroll>
      <View className="pt-2">
        {isTabRoot ? (
          <Text className="font-serif text-[26px] font-semibold text-ink">Nutrition</Text>
        ) : (
          <StackHeader title="Nutrition" />
        )}
      </View>

      {/* Today's intake — real sums against the real (versioned) targets. */}
      <View className="mt-5">
        <Block device="grid">
          <View className="flex-row items-baseline gap-2">
            <View className="flex-1">
              <SectionLabel label="Today" />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Daily targets"
              hitSlop={16}
              onPress={() => router.push('/nutrition-targets')}
              className="active:opacity-60">
              <Text
                className={
                  corner.mono
                    ? 'font-mono text-[10px] text-ink-muted'
                    : 'font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted'
                }>
                {corner.label}
              </Text>
            </Pressable>
          </View>

          <View className="mt-2 flex-row items-baseline gap-1.5">
            <Text className="font-mono text-4xl text-ink">{fmtInt(shown.kcal)}</Text>
            <Text className="font-mono text-sm text-ink-muted">kcal</Text>
          </View>

          {kcalTarget !== null && kcalTarget > 0 ? (
            <TargetRule value={shown.kcal} target={kcalTarget} />
          ) : null}

          {/* No margin: the cells' own `pt-4` is the row rhythm that replaced
              the top rule. */}
          <View className="flex-row flex-wrap">
            {cells.map((cell, index) => (
              <MacroCell
                key={cell.label}
                label={cell.label}
                grams={cell.grams}
                target={cell.target}
                className={cellClass(index)}
              />
            ))}
          </View>
        </Block>
      </View>

      {/* Log a meal — the stamped next action, then the other entry paths as a
          record list, then the manual field group (no device of its own). */}
      <View className="mt-8">
        <SectionLabel label="Log a meal" />

        {/* The one accent on this screen: AI estimation (photo / describe)
            landing in an editable review (app/meal-estimate.tsx). */}
        <View className="mt-2">
          <Block device="stamp">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Describe or snap a meal"
              onPress={() => router.push('/meal-estimate')}
              className="min-h-[44px] flex-row items-center gap-3 active:opacity-60">
              <Ionicons name="camera-outline" size={20} color={palette.pine} />
              <View className="flex-1">
                <Text className="font-serif text-[16px] font-semibold text-ink">
                  Describe or snap a meal
                </Text>
                <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary">
                  Type it or photograph the plate — you review before it logs
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={palette.pine} />
            </Pressable>
          </Block>
        </View>

        <View className="mt-2">
          <Block device="plate">
            <ActionRow
              icon="search-outline"
              label="Add food"
              chevron="chevron-forward"
              first
              accessibilityLabel="Add food from the catalog"
              onPress={() => router.push('/food-search')}
            />
            <ActionRow
              icon="barcode-outline"
              label="Scan a barcode"
              chevron="chevron-forward"
              first={false}
              accessibilityLabel="Scan a barcode"
              onPress={() => router.push('/barcode-scan')}
            />
            <ActionRow
              icon="albums-outline"
              label="From a template"
              chevron="chevron-forward"
              first={false}
              accessibilityLabel="Log from a template"
              onPress={() => router.push('/meal-templates')}
            />
            <ActionRow
              icon="create-outline"
              label="Manual entry"
              chevron={formOpen ? 'chevron-up' : 'chevron-down'}
              first={false}
              expanded={formOpen}
              accessibilityLabel="Manual entry"
              onPress={openForm}
            />
          </Block>
        </View>

        {formOpen ? (
          <View className="mt-2">
            <AddMealForm onSaved={saved} />
          </View>
        ) : null}
      </View>

      {/* Eaten today — the day's real record, in eating order. The section
          note is the same kcal the Today grid shows, and these rows are the
          arithmetic behind it: a ledger sums to its own total. */}
      <View className="mt-8">
        <Block device="plate">
          <SectionLabel
            label="Eaten today"
            note={meals.length > 0 ? `${fmtInt(shown.kcal)} kcal` : undefined}
          />
          {meals.length === 0 ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              Nothing logged yet today.
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
        </Block>
      </View>

      {/* Review — micronutrients and cross-day trends (read-only, no accent). */}
      <View className="mt-8">
        <Block device="plate">
          <SectionLabel label="Review" />
          <View className="mt-1">
            <ActionRow
              icon="nutrition-outline"
              label="Micronutrients"
              detail="Today’s totals vs reference"
              chevron="chevron-forward"
              first
              accessibilityLabel="Micronutrients"
              onPress={() => router.push('/nutrition-micros')}
            />
            <ActionRow
              icon="trending-up-outline"
              label="History"
              detail="Energy & macros over time"
              chevron="chevron-forward"
              first={false}
              accessibilityLabel="History"
              onPress={() => router.push('/nutrition-history')}
            />
          </View>
        </Block>
      </View>
    </Screen>
  );
}
