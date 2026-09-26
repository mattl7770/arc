import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { UndoRow } from '@/components/nutrition/undo-row';
import { Block, Divider } from '@/components/ui/block';
import { KEYPAD_DONE } from '@/components/ui/keyboard';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { selectAllOnFocus } from '@/components/ui/select-on-focus';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useUndoOffer } from '@/hooks/use-undo-offer';
import { useUnitPreferences } from '@/hooks/use-unit-preferences';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import {
  foodUsage,
  listFavoriteFoods,
  listRecentFoods,
  searchFoods,
  setFoodFavorite,
} from '@/lib/db/repositories/foods';
import { addMealItem, logMealWithItems } from '@/lib/db/repositories/nutrition';
import { foodDeleteConsequence } from '@/lib/nutrition/food-delete';
import { fmtAmount, fmtInt, fmtQty } from '@/lib/nutrition/format';
import { amountForQty, itemForPortion } from '@/lib/nutrition/servings';
import type { FoodRow, NewMealItem, RecentFood } from '@/lib/nutrition/types';
import { deleteFoodWithUndo } from '@/lib/nutrition/undo-offers';
import { runUndo } from '@/lib/nutrition/undo-store';
import type { VolumeUnit } from '@/lib/user/types';

/**
 * Food search — the catalog quick-add path (docs/nutrition-subapp.md §2).
 *
 * Speed is the whole design (benchmark: MacroFactor's action counts). Before
 * any query: RECENTS, each re-addable at its last portion in ONE tap, then
 * favorites. Results rank whole-query prefix matches first. Tapping a row
 * expands an inline portion editor (serving stepper when the food names one, an
 * amount field always — in the food's own unit, g or ml per its `basis`, 0047);
 * Add either appends to the meal this screen was pushed for
 * (`mealId` param, from meal detail) or creates a day-part-named meal on the
 * first add and keeps appending to it — multi-add without leaving the screen.
 *
 * ## Conformed Set surface system
 *
 *   Search field         → **recessed well**: a capture surface is stock you
 *                          write on, so the command field is the well itself.
 *   Recents / Favorites
 *   / Results            → **ruled plates**: a list of records is a table.
 *   Portion editor       → no device. It opens inside a plate row, and devices
 *                          never nest — only the amount input keeps a recessed
 *                          treatment, because an input is a well at control
 *                          scale.
 *   Catalog actions      → a closing **ruled plate**, holding one row before a
 *                          meal exists and two after (the scan row only appears
 *                          once there is a meal to scan into).
 *
 * **Accent budget: one.** The expanded row's Add, and only one row is ever
 * expanded. "Done · N" is neutral: it leaves, it does not commit.
 *
 * ## A catalog food is deleted here (owner, 2026-09-25)
 *
 * *"Add a delete to the food's own screen, so you and the Coach can both do
 * it."* The expanded row is the only place a catalog food has actions of its
 * own (the star is the other), so its Delete sits beside the star. It ARMS
 * first — the meal-templates idiom — and the armed row states the consequence
 * before anything is written: the food leaves the catalog, and the meals,
 * templates and recipes that used it keep their own numbers (every reference
 * is `ON DELETE SET NULL` and every one carries its snapshot;
 * src/lib/nutrition/food-delete.ts). Delete is ink, never the accent.
 *
 * What it offers back is exact: the Undo row, the first row of the closing
 * catalog plate, puts the food back with its id, its star and every link
 * (`restoreFood`). It closes when this screen is left. The Coach's
 * `food_catalog` removal runs the same `deleteFood`, behind its card.
 */

/** What a from-scratch add names the meal: the day-part, CalAI-slot style. */
function daypartName(now: Date): string {
  const h = now.getHours();
  if (h < 11) return 'Breakfast';
  if (h < 16) return 'Lunch';
  if (h < 21) return 'Dinner';
  return 'Snack';
}

/** Right-edge kcal summary for a list row: per serving when named, per 100 of
 * the food's basis otherwise; em-dash when the food has no energy recorded. */
function rowKcal(food: FoodRow): { value: string; unit: string } {
  if (food.kcal_100g === null) return { value: '—', unit: '' };
  if (food.serving_amount !== null) {
    return {
      value: fmtInt((food.kcal_100g * food.serving_amount) / 100),
      unit: food.serving_name ?? 'serving',
    };
  }
  return { value: fmtInt(food.kcal_100g), unit: `100 ${food.basis}` };
}

type Base = { recents: RecentFood[]; favorites: FoodRow[] };

function readBase(): Base {
  const db = getDb();
  return { recents: listRecentFoods(db), favorites: listFavoriteFoods(db) };
}

/** The expanded row's portion state. Serving mode tracks the stepper; editing
 * the amount by hand drops to amount mode (serving_qty no longer claimed).
 *
 * The typed amount is always in the FOOD'S OWN unit (g or ml) — the Settings
 * oz/ml preference governs read-only figures, never this field. Converting an
 * entry box would mean a 330 ml can reads "11.2 oz" and writes back 331.2 ml on
 * a Save the user never edited, which is the rounding drift meal-detail already
 * guards against in the other direction. */
type Portion = { mode: 'serving' | 'amount'; qty: number; amountText: string };

/** Which list the editor is open under — a food can appear in Recents AND
 * Favorites, and matching on food.id alone would open twin editors. */
type ListSection = 'recents' | 'favorites' | 'results';

type Expanded = { food: FoodRow; portion: Portion; section: ListSection };

function initialPortion(food: FoodRow): Portion {
  if (food.serving_amount !== null) {
    return { mode: 'serving', qty: 1, amountText: fmtQty(food.serving_amount) };
  }
  return { mode: 'amount', qty: 1, amountText: '100' };
}

/** A typed amount that is actually loggable: finite, positive, and under a
 * sanity ceiling (paste and hardware keyboards get past decimal-pad — a '1e99'
 * item must never reach the DB). The ceiling is unit-blind: 5000 ml is five
 * litres, which is as implausible a single portion as 5000 g. */
function parseAmount(text: string): number | null {
  const n = Number(text.trim());
  return Number.isFinite(n) && n > 0 && n <= 5000 ? n : null;
}

export default function FoodSearchScreen() {
  const router = useRouter();
  const { mealId } = useLocalSearchParams<{ mealId?: string }>();

  // Display-only (src/lib/user/types.ts): it decides whether a logged
  // millilitre portion READS as ml or oz, and nothing that is stored.
  const { units } = useUnitPreferences();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FoodRow[]>([]);
  const [base, setBase] = useState(readBase);
  const [expanded, setExpanded] = useState<Expanded | null>(null);
  const [added, setAdded] = useState(0);
  // The meal every add lands in: the pushed-for meal, or the one the first
  // from-scratch add creates. State because it's born mid-session.
  const [targetMealId, setTargetMealId] = useState<string | null>(mealId ?? null);
  // Which open row's Delete is armed, as `section:id` — cleared whenever a row
  // opens or closes, so an arm never survives into another visit to the row.
  const [armed, setArmed] = useState<string | null>(null);
  // A catalog food deleted here, while it can still be put back. Closed when
  // this screen is left (src/hooks/use-undo-offer.ts).
  const undo = useUndoOffer('catalog', 'catalog');

  // Re-read recents/favorites — and the live query's results — when the screen
  // regains focus (returning from Create-food, most importantly, so the new
  // food appears under the query that failed to find it). Same sanctioned
  // useFocusEffect shape as use-log-feed; the [query] dep keeps it honest.
  const reload = useCallback(() => {
    setBase(readBase());
    setResults(query.trim() === '' ? [] : searchFoods(getDb(), query));
  }, [query]);
  useFocusEffect(reload);

  /** Open a row's editor, or close it — disarming any Delete either way. */
  const expand = (next: Expanded | null) => {
    setArmed(null);
    setExpanded(next);
  };

  const runSearch = (text: string) => {
    setQuery(text);
    expand(null);
    setResults(text.trim() === '' ? [] : searchFoods(getDb(), text));
  };

  /** The armed Delete, confirmed: the food goes, with its Undo. */
  const deleteFood = (food: FoodRow) => {
    try {
      deleteFoodWithUndo(getDb(), food.id);
    } catch (error) {
      console.warn('[food-search] delete failed', error);
    }
    expand(null);
    reload();
  };

  /** Put the deleted food back; a refused Undo stays on its row, saying so. */
  const undoDelete = () => {
    runUndo();
    reload();
  };

  const saveItem = (item: NewMealItem) => {
    const db = getDb();
    try {
      if (targetMealId !== null) {
        addMealItem(db, targetMealId, item);
      } else {
        const now = new Date();
        const { mealId: created } = logMealWithItems(db, {
          date: todayISODate(),
          time: clockFromISO(now.toISOString()),
          name: daypartName(now),
          items: [item],
        });
        setTargetMealId(created);
      }
      setAdded((n) => n + 1);
      setExpanded(null);
      runSearch('');
      setBase(readBase());
    } catch (error) {
      // A CHECK violation or missing meal must never crash the tap handler.
      console.warn('[food-search] add failed', error);
    }
  };

  /** One-tap re-add from the recents rail, at the food's last-logged portion. */
  const addRecent = (recent: RecentFood) => {
    const { food, lastServingQty, lastAmount } = recent;
    if (lastServingQty !== null && food.serving_amount !== null) {
      saveItem(itemForPortion(food, { servingQty: lastServingQty }));
    } else if (lastAmount !== null) {
      saveItem(itemForPortion(food, { amount: lastAmount }));
    } else {
      expand({ food, portion: initialPortion(food), section: 'recents' });
    }
  };

  const addExpanded = () => {
    if (!expanded) return;
    const { food, portion } = expanded;
    if (portion.mode === 'serving') {
      if (portion.qty <= 0) return;
      saveItem(itemForPortion(food, { servingQty: portion.qty }));
    } else {
      const amount = parseAmount(portion.amountText);
      if (amount === null) return;
      saveItem(itemForPortion(food, { amount }));
    }
  };

  const stepQty = (delta: number) => {
    setExpanded((prev) => {
      if (!prev) return prev;
      const qty = Math.min(50, Math.max(0.5, prev.portion.qty + delta));
      const amount = amountForQty(prev.food, qty);
      return {
        ...prev,
        portion: {
          mode: 'serving',
          qty,
          amountText: amount !== null ? fmtQty(amount) : prev.portion.amountText,
        },
      };
    });
  };

  const editAmount = (text: string) => {
    setExpanded((prev) =>
      prev ? { ...prev, portion: { ...prev.portion, mode: 'amount', amountText: text } } : prev
    );
  };

  const toggleFavorite = (food: FoodRow) => {
    setFoodFavorite(getDb(), food.id, food.is_favorite === 0);
    setBase(readBase());
    setResults(query.trim() === '' ? [] : searchFoods(getDb(), query));
    setExpanded((prev) =>
      prev && prev.food.id === food.id
        ? { ...prev, food: { ...prev.food, is_favorite: prev.food.is_favorite === 0 ? 1 : 0 } }
        : prev
    );
  };

  const amountPreview =
    expanded === null
      ? null
      : expanded.portion.mode === 'serving'
        ? amountForQty(expanded.food, expanded.portion.qty)
        : parseAmount(expanded.portion.amountText);
  const kcalPreview =
    expanded !== null && amountPreview !== null && expanded.food.kcal_100g !== null
      ? (expanded.food.kcal_100g * amountPreview) / 100
      : null;

  /** The one catalog action that is always offered. `ruled` is true only when a
   * row precedes it inside the plate (the Undo row, the scan row); as the
   * plate's first row it draws no hairline, because a rule between rows needs a
   * row above it. */
  const createFoodRow = (ruled: boolean) => (
    <CatalogRow
      icon="add-circle-outline"
      label={`Create a food${query.trim() !== '' ? ` — “${query.trim()}”` : ''}`}
      ruled={ruled}
      accessibilityLabel="Create a food"
      onPress={() =>
        router.push({
          pathname: '/food-new',
          params: query.trim() ? { name: query.trim() } : {},
        })
      }
    />
  );

  const editorFor = (section: ListSection, food: FoodRow) => {
    if (expanded?.section !== section || expanded.food.id !== food.id) return null;
    const key = `${section}:${food.id}`;
    const isArmed = armed === key;
    return (
      <PortionEditor
        expanded={expanded}
        amountPreview={amountPreview}
        kcalPreview={kcalPreview}
        onStep={stepQty}
        onEditAmount={editAmount}
        onToggleFavorite={toggleFavorite}
        onAdd={addExpanded}
        // Counted only once armed: the consequence names what uses the food.
        deleteConsequence={
          isArmed ? foodDeleteConsequence(food.name, foodUsage(getDb(), food.id)) : null
        }
        onArmDelete={() => setArmed(isArmed ? null : key)}
        onDelete={() => deleteFood(food)}
      />
    );
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Add food" />
      </View>

      <View className="mt-2 flex-row items-stretch gap-2">
        <View className="flex-1">
          <Block device="well">
            {/* min-h keeps the well itself ≥44pt: its own py-3 plus a bare
                single-line TextInput would land just under. */}
            <View className="min-h-[24px] flex-row items-center gap-2">
              <Ionicons name="search-outline" size={16} color={palette.inkMuted} />
              <TextInput
                value={query}
                onChangeText={runSearch}
                placeholder="Search foods"
                placeholderTextColor={palette.inkMuted}
                autoFocus
                autoCorrect={false}
                accessibilityLabel="Search foods"
                className="h-6 flex-1 font-serif text-[15px] text-ink"
              />
            </View>
          </Block>
        </View>
        {added > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Done, ${added} added`}
            onPress={() => router.back()}
            className="min-h-[44px] items-center justify-center rounded-btn border border-ink px-4 active:opacity-60">
            <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
              Done
            </Text>
            <Text className="font-mono text-[10px] text-ink-muted">{added} added</Text>
          </Pressable>
        ) : null}
      </View>

      {query.trim() === '' ? (
        <>
          {/* Recents — the single biggest daily-speed lever: one tap re-adds
              the food at the portion it was last logged at. */}
          {base.recents.length > 0 ? (
            <View className="mt-6">
              <Block device="plate">
                <SectionLabel label="Recent" />
                <View className="mt-1">
                  {base.recents.map((recent, index) => (
                    <View key={recent.food.id}>
                      <Divider first={index === 0} />
                      <FoodListRow
                        food={recent.food}
                        subtitle={lastPortionLabel(recent, units.volume)}
                        onPress={() =>
                          expand({
                            food: recent.food,
                            portion: initialPortion(recent.food),
                            section: 'recents',
                          })
                        }
                        trailing={
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Add ${recent.food.name} again`}
                            hitSlop={10}
                            onPress={() => addRecent(recent)}
                            className="h-9 w-9 items-center justify-center rounded-btn border border-hairline active:opacity-60">
                            <Ionicons name="add" size={18} color={palette.ink} />
                          </Pressable>
                        }
                      />
                      {editorFor('recents', recent.food)}
                    </View>
                  ))}
                </View>
              </Block>
            </View>
          ) : null}

          {base.favorites.length > 0 ? (
            <View className="mt-6">
              <Block device="plate">
                <SectionLabel label="Favorites" />
                <View className="mt-1">
                  {base.favorites.map((food, index) => (
                    <View key={food.id}>
                      <Divider first={index === 0} />
                      <FoodListRow
                        food={food}
                        subtitle={null}
                        onPress={() =>
                          expand({ food, portion: initialPortion(food), section: 'favorites' })
                        }
                      />
                      {editorFor('favorites', food)}
                    </View>
                  ))}
                </View>
              </Block>
            </View>
          ) : null}

          {base.recents.length === 0 && base.favorites.length === 0 ? (
            <Text className="mt-6 font-serif text-[14px] leading-6 text-ink-secondary">
              Nothing logged yet. Search the catalog.
            </Text>
          ) : null}
        </>
      ) : (
        <View className="mt-4">
          {results.length === 0 ? (
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
              Nothing matches “{query.trim()}”.
            </Text>
          ) : (
            <Block device="plate">
              <SectionLabel
                label="Results"
                note={`${results.length} match${results.length === 1 ? '' : 'es'}`}
              />
              <View className="mt-1">
                {results.map((food, index) => (
                  <View key={food.id}>
                    <Divider first={index === 0} />
                    <FoodListRow
                      food={food}
                      subtitle={null}
                      onPress={() =>
                        expand(
                          expanded?.section === 'results' && expanded.food.id === food.id
                            ? null
                            : { food, portion: initialPortion(food), section: 'results' }
                        )
                      }
                    />
                    {editorFor('results', food)}
                  </View>
                ))}
              </View>
            </Block>
          )}
        </View>
      )}

      {/* Catalog actions — the closing plate. Scanning only appears once a meal
          is in progress here, so the scan continues THIS meal (scanning fresh
          would fork a separate day-part meal; the fresh-scan entry point is the
          Nutrition screen), which means the plate holds one row on arrival and
          two once a meal exists. It is drawn either way: the sweep of
          2026-08-10 made it conditional and the owner rejected that. `ruled`
          still keys off whether a row precedes it, which is a fact about the
          rows, not about the enclosure. A food deleted here is offered back as
          this plate's FIRST row: a deletion is a catalog act, and this is the
          catalog's plate. */}
      <View className="mt-6">
        <Block device="plate">
          {undo ? <UndoRow offer={undo} onUndo={undoDelete} first /> : null}
          {targetMealId !== null ? (
            <CatalogRow
              icon="barcode-outline"
              label="Scan a barcode"
              ruled={undo !== null}
              accessibilityLabel="Scan a barcode into this meal"
              onPress={() =>
                router.push({ pathname: '/barcode-scan', params: { mealId: targetMealId } })
              }
            />
          ) : null}
          {createFoodRow(targetMealId !== null || undo !== null)}
        </Block>
      </View>
    </Screen>
  );
}

/** "2 × 1 egg" / "150 g" / "250 ml" — how a recent food was last logged, under
 * the user's volume preference. */
function lastPortionLabel(recent: RecentFood, volume: VolumeUnit): string | null {
  const { food, lastServingQty, lastAmount } = recent;
  if (lastServingQty !== null && food.serving_name !== null) {
    return `Last: ${fmtQty(lastServingQty)} × ${food.serving_name}`;
  }
  if (lastAmount !== null) return `Last: ${fmtAmount(lastAmount, food.basis, volume)}`;
  return null;
}

/**
 * One ruled row of the closing catalog plate.
 *
 * `ruled` draws the hairline that separates it from the row above. It is stated
 * by the caller rather than derived from an index because whether a row precedes
 * this one depends on whether a meal is in progress, which the caller is the
 * only one that knows.
 */
function CatalogRow({
  icon,
  label,
  ruled,
  accessibilityLabel,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  ruled: boolean;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <View>
      <Divider first={!ruled} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
        <Ionicons name={icon} size={17} color={palette.inkSecondary} />
        <Text className="flex-1 font-serif text-[15px] text-ink">{label}</Text>
        <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
      </Pressable>
    </View>
  );
}

function FoodListRow({
  food,
  subtitle,
  onPress,
  trailing,
}: {
  food: FoodRow;
  subtitle: string | null;
  onPress: () => void;
  trailing?: ReactNode;
}) {
  const kcal = rowKcal(food);
  return (
    <View className="min-h-[44px] flex-row items-center gap-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={food.name}
        onPress={onPress}
        className="min-h-[44px] flex-1 flex-row items-center gap-3 py-3 active:opacity-60">
        <View className="flex-1">
          <Text className="font-serif text-[15px] leading-5 text-ink">
            {food.name}
            {/* Part of the row's name, not a control label: serif, stated
                rather than inherited from the parent Text. */}
            {food.brand ? <Text className="font-serif text-ink-muted"> · {food.brand}</Text> : null}
            {/* THE AI MARK (C2). A food whose macros were described to the model
                rather than read off a label says so wherever it appears — an
                inferred number must not wear the face of one the user typed
                (the 0034 rule). Confidence is TYPOGRAPHY here, not colour
                (docs/nutrition-subapp.md §2): the label voice at the metadata
                size, in the metadata ink, never a badge and never a hue. It
                rides inside the name's Text so it wraps with the name, and it
                states its own size because a nested Text inherits otherwise. */}
            {food.source === 'ai' ? (
              <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                {'  est'}
              </Text>
            ) : null}
          </Text>
          {subtitle ? (
            <Text className="mt-0.5 font-mono text-[10px] leading-4 text-ink-muted">
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View className="items-end">
          <Text className="font-mono text-[13px] text-ink-secondary">{kcal.value}</Text>
          {kcal.unit !== '' ? (
            <Text className="font-mono text-[10px] text-ink-muted">{kcal.unit}</Text>
          ) : null}
        </View>
      </Pressable>
      {trailing}
    </View>
  );
}

/**
 * The inline portion editor under a tapped row. It draws **no device of its
 * own** — it lives inside a plate, and devices never nest. Only the amount input
 * takes the recessed treatment, because an input is a well at control scale.
 *
 * The Add button is this screen's one accent (only one editor is ever open).
 *
 * The bin beside the star ARMS the food's Delete; armed, the editor closes on
 * the consequence line and the confirming Delete (ink, bordered — the
 * meal-templates Confirm, never the accent). `deleteConsequence` is non-null
 * exactly when armed. Exported so the render suite can draw the armed state,
 * which only a tap reaches in the app.
 */
export function PortionEditor({
  expanded,
  amountPreview,
  kcalPreview,
  onStep,
  onEditAmount,
  onToggleFavorite,
  onAdd,
  deleteConsequence,
  onArmDelete,
  onDelete,
}: {
  expanded: Expanded;
  amountPreview: number | null;
  kcalPreview: number | null;
  onStep: (delta: number) => void;
  onEditAmount: (text: string) => void;
  onToggleFavorite: (food: FoodRow) => void;
  onAdd: () => void;
  deleteConsequence: string | null;
  onArmDelete: () => void;
  onDelete: () => void;
}) {
  const { food, portion } = expanded;
  const canAdd = amountPreview !== null && amountPreview > 0;
  const armed = deleteConsequence !== null;
  return (
    <View className="pb-3">
      <View className="flex-row items-center gap-2">
        {food.serving_amount !== null ? (
          <View className="flex-row items-center gap-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Less"
              hitSlop={6}
              onPress={() => onStep(-0.5)}
              className="h-9 w-9 items-center justify-center rounded-btn border border-hairline active:opacity-60">
              <Ionicons name="remove" size={16} color={palette.ink} />
            </Pressable>
            <Text className="w-14 text-center font-mono text-[15px] text-ink">
              {fmtQty(portion.qty)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="More"
              hitSlop={6}
              onPress={() => onStep(0.5)}
              className="h-9 w-9 items-center justify-center rounded-btn border border-hairline active:opacity-60">
              <Ionicons name="add" size={16} color={palette.ink} />
            </Pressable>
            <Text className="ml-1 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
              × {food.serving_name}
            </Text>
          </View>
        ) : null}
        <View className="ml-auto flex-row items-center gap-2">
          <TextInput
            value={portion.amountText}
            onChangeText={onEditAmount}
            keyboardType="decimal-pad"
            returnKeyType={KEYPAD_DONE}
            {...selectAllOnFocus(portion.amountText)}
            accessibilityLabel={food.basis === 'ml' ? 'Millilitres' : 'Grams'}
            className="w-16 border border-paper-deep bg-paper-dim px-2 py-2 text-right font-mono text-[13px] text-ink"
          />
          <Text className="font-mono text-[11px] text-ink-secondary">{food.basis}</Text>
        </View>
      </View>

      <View className="mt-3 flex-row items-center justify-between">
        <Text className="font-mono text-[10px] text-ink-muted">
          {kcalPreview !== null ? `≈ ${fmtInt(kcalPreview)} kcal` : 'no energy recorded'}
        </Text>
        <View className="flex-row items-center gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              armed ? `Keep ${food.name} in the catalog` : `Delete ${food.name} from the catalog`
            }
            hitSlop={10}
            onPress={onArmDelete}
            className="h-9 w-9 items-center justify-center rounded-btn active:opacity-60">
            <Ionicons
              name={armed ? 'trash' : 'trash-outline'}
              size={17}
              color={palette.inkSecondary}
            />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={food.is_favorite === 1 ? 'Remove favorite' : 'Mark favorite'}
            hitSlop={10}
            onPress={() => onToggleFavorite(food)}
            className="h-9 w-9 items-center justify-center rounded-btn active:opacity-60">
            <Ionicons
              name={food.is_favorite === 1 ? 'star' : 'star-outline'}
              size={17}
              color={palette.inkSecondary}
            />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Add ${food.name}`}
            accessibilityState={{ disabled: !canAdd }}
            disabled={!canAdd}
            onPress={onAdd}
            className={
              canAdd
                ? 'min-h-[44px] justify-center rounded-btn bg-pine px-5 active:opacity-70'
                : 'min-h-[44px] justify-center rounded-btn border border-paper-deep px-5'
            }>
            <Text
              className={
                canAdd
                  ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-pine-on'
                  : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
              }>
              Add
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Armed: what the delete does, before it does it — then the one control
          that does it. The consequence is serif (it speaks). */}
      {armed ? (
        <View className="mt-3 flex-row items-center gap-3">
          <Text className="flex-1 font-serif text-[13px] leading-5 text-ink-secondary">
            {deleteConsequence}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Delete ${food.name}`}
            onPress={onDelete}
            className="min-h-[44px] items-center justify-center rounded-btn border border-ink px-4 active:opacity-60">
            <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
              Delete
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
