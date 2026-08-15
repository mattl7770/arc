import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { LogSheet } from '@/components/nutrition/log-sheet';
import { Block, Divider, GridCell } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { Sparkline } from '@/components/ui/sparkline';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import {
  OVER_TIME_DAYS,
  useNutrition,
  type KitchenCounts,
  type OverTime,
} from '@/hooks/use-nutrition';
import { fmtInt, macroLine } from '@/lib/nutrition/format';
import {
  dayFigure,
  unguardedNote,
  type DayFigure,
  type DayMetric,
} from '@/lib/nutrition/remaining';
import type { MealRow, NutritionTargetsRow } from '@/lib/nutrition/types';

/**
 * The **Eat tab** — the nutrition sub-app's root. It renders at two routes: as
 * the tab (app/(tabs)/eat.tsx re-exports this file) and as a stack-pushed
 * screen from the Log tab's Nutrition tile and Data's Nutrition trend row.
 *
 * ## Two routes, two headers (owner call on hardware, 2026-08-09)
 *
 * The tab root gets a plain serif title; the pushed route keeps StackHeader and
 * its back chevron. Which one is rendering arrives as the `asTab` PROP, set by
 * app/(tabs)/eat.tsx — the only caller that knows.
 *
 * It used to be inferred with `useSegments()[0] === '(tabs)'`, and that was
 * wrong in a way nothing on screen explained: `useSegments()` is GLOBAL
 * navigation state, so pushing /food-search off this very tab changed the
 * segments under the still-mounted tab root, which then re-rendered itself as
 * the pushed variant — a back chevron flashing into the header behind the
 * screen you just opened, and again on the way back. A prop cannot drift,
 * because it is a fact about the render, not about the app.
 *
 * `router.canGoBack()` remains the wrong test for the older reason: with
 * `backBehavior="history"` a tab root very often CAN go back. The title stays
 * "Nutrition" at both routes; the bar says EAT only because five characters is
 * its width budget (app/(tabs)/_layout.tsx).
 *
 * ## Redrawn as a tab root (2026-08-11)
 *
 * Promotion to a tab changed the route and nothing else, and the owner's read
 * from the device named four faults (docs/project-status.md §1). Each has an
 * answer here, and the approval mockup is
 * `docs/design-research/eat-tab-redesign.html`:
 *
 * 1. *"It leads with a retrospective total."* → the hero is **what is left**,
 *    with the eaten ledger as the corner note it was subtracted from. The two
 *    plus the target reconcile on one line, and the note still opens the targets
 *    editor. **Guarded** — see the honesty note below; this is the change that
 *    could most easily have shipped a lie.
 * 2. *"Five ways to log, presented as a menu."* → one accent button reading
 *    **Log**, opening src/components/nutrition/log-sheet.tsx. Nothing was
 *    deleted; the paths moved one tap in, and gained "Cook a recipe", which
 *    previously required opening the recipe first. Two **capture methods** —
 *    Photo and Describe — sit outlined beneath it (owner, 2026-08-14); they are
 *    shortcuts into a mode of app/meal-estimate.tsx, not doors to a screen the
 *    sheet already reaches, and they take no accent.
 * 3. *"The most consequential setup action is the quietest thing on the
 *    screen."* → while `targets` is null, **Set daily targets** is a full-width
 *    control under the grid. It is outlined rather than pine (the accent stays
 *    on Log in every state, so the one action never moves under your thumb) and
 *    it **retires completely** once targets exist: a setup affordance that
 *    survives its own success is noise.
 * 4. *"Nothing on the tab spans more than today."* → **Over time**: 14-day
 *    energy and protein, sparklined, both opening the History screen. Not a
 *    second dashboard — the same drill-downs, moved where they can be seen.
 *
 * Plus the two standing objects this sub-app grew: **Kitchen** carries the
 * recipe book and the grocery list with their live state. Import is NOT here —
 * it is the recipe book's own primary action (owner, 2026-08-11), and the iOS
 * share sheet reaches it without passing through this screen at all.
 *
 * ## The honesty rule under the hero
 *
 * A day's totals skip NULL by design, so `target − eaten` overstates the
 * remainder by exactly the meals nobody measured. The remainder is therefore
 * computed per metric and only when every meal carries that value; otherwise
 * the metric falls back to the shipped eaten-with-denominator reading and
 * `unguardedNote` says why in words. All of it is pure and tested:
 * src/lib/nutrition/remaining.ts, db/nutrition-remaining.test.mjs.
 *
 * ## Conformed Set surface system (00-design-spec.md §1)
 *
 *   Today        → **grid**, drawn by {@link GridCell}: the rules run BETWEEN
 *                  the macro cells and there is no outer box, because the grid
 *                  IS the object. The owner asked for boxes here on 2026-08-11,
 *                  while the device still drew nothing; main then established
 *                  that it had never been drawing at all and restored its marks
 *                  (docs/decisions.md — the withdrawal ADR). The hand-rolled
 *                  border and fill came off with that merge: the separation the
 *                  request was after is now the device's job, drawn once, the
 *                  same way every other metric grid in the app draws it.
 *   Eaten today  → **ruled plate**: the day's record is a table. Dropped
 *                  through empty — a plate closes a record, and before the first
 *                  meal there is only a sentence.
 *   Kitchen      → **ruled plate**: two destinations with live state.
 *   Over time    → **ruled plate**: two readings and a drill-down.
 *
 * **Accent budget: one.** The Log button is it, in every state.
 */

/** The Today grid's three counted-down macros. Fiber is deliberately absent —
 *  it is summed from meal items, so a manually-entered meal contributes none by
 *  construction and it can never be honestly counted down. It lives on the
 *  micronutrients screen, read against a reference. */
const MACROS: { metric: DayMetric; label: string }[] = [
  { metric: 'protein_g', label: 'Protein' },
  { metric: 'carbs_g', label: 'Carbs' },
  { metric: 'fat_g', label: 'Fat' },
];

/**
 * One boxed macro cell. The LABEL carries the mode — "PROTEIN LEFT" over a
 * remainder, plain "PROTEIN" over what has been eaten — so the number below it
 * never needs a word to explain itself and the two readings can sit side by
 * side without ambiguity.
 */
function MacroCell({ label, figure }: { label: string; figure: DayFigure }) {
  const remaining = figure.mode === 'remaining';
  // OVER is a different reading from LEFT, so the label says which. Carrying the
  // sign only in an 11px word under the figure meant "PROTEIN LEFT / 12" over a
  // day 12g past target — the label read as the opposite of the truth, and the
  // hero above it was already saying "12 kcal over" in the same situation.
  const over = remaining && figure.remaining < 0;
  const value = remaining ? Math.abs(figure.remaining) : figure.eaten;
  const mode = over ? `${label} over` : remaining ? `${label} left` : label;
  const denominator = figure.target !== null ? `of ${Math.round(figure.target)} g` : 'g';
  return (
    <View>
      <Text
        numberOfLines={1}
        className="font-label text-[11px] uppercase tracking-[1.2px] text-ink-secondary">
        {mode}
      </Text>
      <Text className="mt-1 font-mono text-[20px] font-semibold text-ink">{value}</Text>
      {/* The target survives the over case: "12 / of 180 g" keeps the frame of
          reference the cell exists to provide. */}
      <Text className="mt-0.5 font-mono text-[11px] text-ink-secondary">{denominator}</Text>
    </View>
  );
}

/**
 * The Today-grid corner. With targets it is the ledger the hero was subtracted
 * from — "1,620 of 2,400 kcal", a measured value, so mono — and it opens the
 * editor. With no targets it renders nothing at all: the full-width control
 * below the grid is the invitation then, and two invitations to the same screen
 * is one too many.
 */
function targetsCorner(
  targets: NutritionTargetsRow | null,
  eatenKcal: number
): { label: string; mono: boolean } | null {
  if (targets === null) return null;
  // A measured value takes mono; "Edit targets" is a CONTROL, so it takes the
  // label voice. Same split the shipped corner made — a control set in the
  // measuring face reads as a number that will not add up to anything.
  if (targets.kcal !== null) {
    return { label: `${fmtInt(eatenKcal)} of ${fmtInt(targets.kcal)} kcal`, mono: true };
  }
  return { label: 'Edit targets', mono: false };
}

/** A square progress rule — drawn only under an EATEN reading, where a bar that
 *  fills as you eat agrees with the number above it. A remainder counts down, so
 *  it carries no rule: two opposite encodings of one quantity, adjacent, is the
 *  kind of mark §5 rules out. Neutral ink, never the accent, never a signal. */
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
  const unrecorded = meal.kcal == null;
  return (
    <View>
      <Divider first={first} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${meal.name}, details`}
        onPress={onPress}
        className="min-h-[46px] flex-row gap-3 py-3 active:opacity-60">
        <Text className="w-12 pt-0.5 font-mono text-[12px] text-ink-secondary">
          {meal.time ?? '—'}
        </Text>
        <View className="flex-1">
          <Text className="font-serif text-[16px] leading-5 text-ink">{meal.name}</Text>
          {/* A meal with no numbers says so, and says what to do about it — it
              is the reason the grid above may be showing eaten rather than
              left, and the two must not be discoverable only by inference. */}
          {unrecorded ? (
            <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary">
              Nothing recorded — tap to fill it in
            </Text>
          ) : detail !== '' ? (
            <Text
              className={
                meal.notes
                  ? 'mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary'
                  : 'mt-0.5 font-mono text-[12px] leading-4 text-ink-secondary'
              }>
              {detail}
            </Text>
          ) : null}
        </View>
        {/* The rounding site of record: `fmtInt` rounds here, and the Today
            corner totals these rounded rows rather than rounding again from the
            raw sum. No kcal recorded reads as an em-dash and contributes
            nothing — never a fabricated 0. */}
        <Text className="pt-0.5 font-mono text-[15px] text-ink">
          {meal.kcal != null ? fmtInt(meal.kcal) : '—'}
        </Text>
      </Pressable>
    </View>
  );
}

/** A Kitchen row: a destination that carries its own live state in the row
 *  body, the way a meal row carries its macros. Never in the trailing slot —
 *  nothing on a tab root in this app puts a live count beside the chevron. */
function KitchenRow({
  icon,
  label,
  detail,
  mono,
  first,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  detail: string;
  /** Measured detail (counts) is mono; an authored empty is prose. */
  mono: boolean;
  first: boolean;
  onPress: () => void;
}) {
  return (
    <View>
      <Divider first={first} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}. ${detail}.`}
        onPress={onPress}
        className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
        <Ionicons name={icon} size={19} color={palette.inkSecondary} />
        <View className="flex-1">
          <Text className="font-serif text-[16px] text-ink">{label}</Text>
          <Text
            className={
              mono
                ? 'mt-0.5 font-mono text-[12px] text-ink-secondary'
                : 'mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary'
            }>
            {detail}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={palette.inkSecondary} />
      </Pressable>
    </View>
  );
}

/** An "Over time" reading — Data's Trends row anatomy: name, descriptor,
 *  sparkline, right-aligned mono value + unit, chevron. */
function TrendRow({
  label,
  series,
  average,
  unit,
  first,
  onPress,
}: {
  label: string;
  series: number[];
  average: number | null;
  unit: string;
  first: boolean;
  onPress: () => void;
}) {
  const empty = average === null;
  return (
    <View>
      <Divider first={first} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          empty
            ? `${label}. Nothing recorded yet. Open history.`
            : `${label}. ${fmtInt(average)} ${unit} a day. Open history.`
        }
        onPress={onPress}
        className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
        <View className="flex-1">
          <Text className="font-serif text-[16px] text-ink">{label}</Text>
          <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary">
            {empty ? 'Nothing recorded yet' : 'Daily average'}
          </Text>
        </View>
        {empty ? null : <Sparkline data={series} />}
        <View className="items-end">
          <View className="flex-row items-baseline gap-1">
            {/* No data, no number: an em-dash, never a stand-in zero. */}
            <Text
              className={
                empty ? 'font-mono text-[17px] text-ink-muted' : 'font-mono text-[17px] text-ink'
              }>
              {empty ? '—' : fmtInt(average)}
            </Text>
            {empty ? null : (
              <Text className="font-mono text-[12px] text-ink-secondary">{unit}</Text>
            )}
          </View>
        </View>
        <Ionicons name="chevron-forward" size={16} color={palette.inkSecondary} />
      </Pressable>
    </View>
  );
}

/** "24 recipes · 3 cooked this month", or the authored empty. */
function recipeDetail(kitchen: KitchenCounts): { text: string; mono: boolean } {
  if (kitchen.recipes === 0) return { text: 'Empty — import your first recipe', mono: false };
  const book = `${kitchen.recipes} recipe${kitchen.recipes === 1 ? '' : 's'}`;
  if (kitchen.cookedRecently === 0) return { text: book, mono: true };
  return { text: `${book} · ${kitchen.cookedRecently} cooked this month`, mono: true };
}

/**
 * "12 to buy · 3 in the cart" — and the state nobody designs: a list whose every
 * item is checked off reads "Nothing left to buy · 40 in the cart", never a bare
 * "Nothing on the list" over a screen holding forty rows. Check-off is soft and
 * cleared by hand, so the cart survives until it is emptied.
 */
function groceryDetail(kitchen: KitchenCounts): { text: string; mono: boolean } {
  const cart = kitchen.groceryInCart > 0 ? ` · ${kitchen.groceryInCart} in the cart` : '';
  if (kitchen.groceryOpen === 0) {
    if (kitchen.groceryInCart === 0) return { text: 'Nothing on the list', mono: false };
    return { text: `Nothing left to buy${cart}`, mono: true };
  }
  return { text: `${kitchen.groceryOpen} to buy${cart}`, mono: true };
}

/** The Over-time section note: the cohort, stated out loud, in the house's
 *  tally form. True whether the readings are drawn or empty. */
function overTimeNote(overTime: OverTime): string {
  return `${overTime.daysRecorded} of ${OVER_TIME_DAYS} days recorded`;
}

export default function NutritionScreen({ asTab = false }: { asTab?: boolean }) {
  const router = useRouter();
  // Which of this file's two routes is rendering — passed in by the one that
  // knows (app/(tabs)/eat.tsx), never inferred. See the header note above.
  const isTabRoot = asTab;
  const { meals, itemCounts, targets, partialMeals, kitchen, overTime, reload } = useNutrition();
  const [logOpen, setLogOpen] = useState(false);

  const targetFor = (metric: DayMetric): number | null => {
    if (targets === null) return null;
    return targets[metric];
  };

  const kcal = dayFigure(meals, 'kcal', targetFor('kcal'), partialMeals);
  const macroFigures = MACROS.map((m) => ({
    ...m,
    figure: dayFigure(meals, m.metric, targetFor(m.metric), partialMeals),
  }));
  const note = unguardedNote(
    meals,
    {
      kcal: targetFor('kcal'),
      protein_g: targetFor('protein_g'),
      carbs_g: targetFor('carbs_g'),
      fat_g: targetFor('fat_g'),
    },
    partialMeals
  );
  const corner = targetsCorner(targets, kcal.eaten);
  const recipes = recipeDetail(kitchen);
  const grocery = groceryDetail(kitchen);
  const openHistory = () => router.push('/nutrition-history');

  return (
    <Screen scroll>
      <View className="pt-2">
        {isTabRoot ? (
          <Text className="font-serif text-[26px] font-semibold text-ink">Nutrition</Text>
        ) : (
          <StackHeader title="Nutrition" />
        )}
      </View>

      {/* TODAY — what is left, when the day's data can support that claim. */}
      <View className="mt-5">
        <Block device="grid">
          <View className="flex-row items-baseline gap-2">
            <View className="flex-1">
              <SectionLabel label="Today" />
            </View>
            {corner ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Daily targets"
                hitSlop={16}
                onPress={() => router.push('/nutrition-targets')}
                className="active:opacity-60">
                <Text
                  className={
                    corner.mono
                      ? 'font-mono text-[11px] text-ink-secondary'
                      : 'font-label text-[11px] uppercase tracking-[1.2px] text-ink-secondary'
                  }>
                  {corner.label}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {targets === null && meals.length === 0 ? (
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
              Nothing logged yet today, and no targets set — so there is nothing here to measure the
              day against.
            </Text>
          ) : (
            <>
              <View className="mt-2 flex-row items-baseline gap-1.5">
                <Text className="font-mono text-4xl text-ink">
                  {kcal.mode === 'remaining'
                    ? fmtInt(Math.abs(kcal.remaining))
                    : fmtInt(kcal.eaten)}
                </Text>
                <Text className="font-mono text-[15px] text-ink-secondary">
                  {kcal.mode === 'remaining'
                    ? kcal.remaining < 0
                      ? 'kcal over'
                      : 'kcal left'
                    : 'kcal'}
                </Text>
              </View>

              {kcal.mode === 'eaten' && kcal.target !== null ? (
                <TargetRule value={kcal.eaten} target={kcal.target} />
              ) : null}

              {/* THE BOXES ARE THE DEVICE'S NOW. The owner asked for boxes on
                  2026-08-11 while the grid device drew nothing; the same week
                  main established that the device had never been DRAWING and
                  restored its marks (docs/decisions.md, the withdrawal ADR). So
                  the hand-rolled border/fill comes off and GridCell owns the
                  rules — same visual separation, drawn once, by the primitive
                  every other metric grid in the app uses. */}
              <View className="mt-2 flex-row flex-wrap">
                {macroFigures.map((m, index) => (
                  <GridCell key={m.metric} index={index} count={macroFigures.length} columns={3}>
                    <MacroCell label={m.label} figure={m.figure} />
                  </GridCell>
                ))}
              </View>
            </>
          )}

          {note ? (
            <Text className="mt-4 font-serif text-[13px] leading-5 text-ink-secondary">{note}</Text>
          ) : null}

          {/* The setup affordance, promoted while it is needed and retired the
              moment it is satisfied. Outlined, not pine — the accent belongs to
              Log in every state. */}
          {targets === null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Set daily targets"
              onPress={() => router.push('/nutrition-targets')}
              className="mt-4 min-h-[46px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
              <Ionicons name="options-outline" size={17} color={palette.inkSecondary} />
              <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
                Set daily targets
              </Text>
            </Pressable>
          ) : null}
        </Block>
      </View>

      {/* The one action, the whole word. */}
      <View className="mt-7">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log a meal"
          onPress={() => setLogOpen(true)}
          className="min-h-[52px] items-center justify-center rounded-btn bg-pine active:opacity-80">
          <Text className="font-label text-[16px] font-semibold text-pine-on">Log</Text>
        </Pressable>

        {/* The two fastest capture methods, straight through (owner,
            2026-08-14). Not navigation — that is the distinction that earns
            them their place. The Log-tab grid lost two tiles for being doors
            into sub-apps the tab bar already reached; these two land you INSIDE
            a capture, in a specific mode, which the sheet cannot do: its
            "Describe or photograph" row opens the same screen on its field, and
            getting a viewfinder from there is three taps.
            Outlined, never pine. The accent above is the screen's one accent in
            every state, and it must stay the only thing on this page that
            claims to be the next action. Same treatment as the Take-a-photo /
            Choose-a-photo pair inside app/meal-estimate.tsx, because these are
            the same two capture methods one level up. */}
        <View className="mt-2 flex-row gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Photograph a meal"
            onPress={() => router.push({ pathname: '/meal-estimate', params: { start: 'camera' } })}
            className="min-h-[44px] flex-1 flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
            <Ionicons name="camera-outline" size={17} color={palette.inkSecondary} />
            <Text className="font-label text-[13px] uppercase tracking-[1.2px] text-ink">
              Photo
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Describe a meal in words"
            onPress={() => router.push('/meal-estimate')}
            className="min-h-[44px] flex-1 flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
            <Ionicons name="sparkles-outline" size={17} color={palette.inkSecondary} />
            <Text className="font-label text-[13px] uppercase tracking-[1.2px] text-ink">
              Describe
            </Text>
          </Pressable>
        </View>
      </View>

      {/* EATEN TODAY — the day's real record, in eating order. The plate goes
          round the rows, never round the empty sentence: a plate closes a
          record, and before the first meal of the day there is no record to
          close. This is the state the tab re-enters every morning. */}
      <View className="mt-7">
        {meals.length === 0 ? (
          <View>
            <SectionLabel label="Eaten today" />
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
              Nothing logged yet today.
            </Text>
          </View>
        ) : (
          <Block device="plate">
            <SectionLabel label="Eaten today" note={`${fmtInt(kcal.eaten)} kcal`} />
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
          </Block>
        )}
      </View>

      {/* KITCHEN — the standing objects. They do not reset at midnight. */}
      <View className="mt-7">
        <SectionLabel label="Kitchen" />
        <View className="mt-2">
          <Block device="plate">
            <KitchenRow
              icon="book-outline"
              label="Recipe book"
              detail={recipes.text}
              mono={recipes.mono}
              first
              onPress={() => router.push('/recipes')}
            />
            <KitchenRow
              icon="cart-outline"
              label="Grocery list"
              detail={grocery.text}
              mono={grocery.mono}
              first={false}
              onPress={() => router.push('/grocery')}
            />
          </Block>
        </View>
      </View>

      {/* OVER TIME — the tab's answer to "how has my protein been this month".
          Two readings and one drill-down, not a second dashboard. */}
      <View className="mt-7">
        <SectionLabel label="Over time" note={overTimeNote(overTime)} />
        <View className="mt-2">
          <Block device="plate">
            <TrendRow
              label="Energy"
              series={overTime.kcal}
              average={overTime.avgKcal}
              unit="kcal"
              first
              onPress={openHistory}
            />
            <TrendRow
              label="Protein"
              series={overTime.protein}
              average={overTime.avgProtein}
              unit="g"
              first={false}
              onPress={openHistory}
            />
            <KitchenRow
              icon="nutrition-outline"
              label="Micronutrients"
              detail="Today’s totals vs reference"
              mono={false}
              first={false}
              onPress={() => router.push('/nutrition-micros')}
            />
          </Block>
        </View>
      </View>

      <LogSheet visible={logOpen} onClose={() => setLogOpen(false)} onSaved={reload} />
    </Screen>
  );
}
