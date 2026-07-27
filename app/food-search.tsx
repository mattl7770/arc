import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import {
  listFavoriteFoods,
  listRecentFoods,
  searchFoods,
  setFoodFavorite,
} from '@/lib/db/repositories/foods';
import { addMealItem, logMealWithItems } from '@/lib/db/repositories/nutrition';
import { fmtInt, fmtQty } from '@/lib/nutrition/format';
import { gramsForQty, itemForPortion } from '@/lib/nutrition/servings';
import type { FoodRow, NewMealItem, RecentFood } from '@/lib/nutrition/types';

/**
 * Food search — the catalog quick-add path (docs/nutrition-subapp.md §2).
 *
 * Speed is the whole design (benchmark: MacroFactor's action counts). Before
 * any query: RECENTS, each re-addable at its last portion in ONE tap, then
 * favorites. Results rank whole-query prefix matches first. Tapping a row
 * expands an inline portion editor (serving stepper when the food names one,
 * grams always); Add either appends to the meal this screen was pushed for
 * (`mealId` param, from meal detail) or creates a day-part-named meal on the
 * first add and keeps appending to it — multi-add without leaving the screen.
 */

/** What a from-scratch add names the meal: the day-part, CalAI-slot style. */
function daypartName(now: Date): string {
  const h = now.getHours();
  if (h < 11) return 'Breakfast';
  if (h < 16) return 'Lunch';
  if (h < 21) return 'Dinner';
  return 'Snack';
}

/** Right-edge kcal summary for a list row: per serving when named, per 100 g
 * otherwise; em-dash when the food has no energy recorded. */
function rowKcal(food: FoodRow): { value: string; unit: string } {
  if (food.kcal_100g === null) return { value: '—', unit: '' };
  if (food.serving_grams !== null) {
    return {
      value: fmtInt((food.kcal_100g * food.serving_grams) / 100),
      unit: food.serving_name ?? 'serving',
    };
  }
  return { value: fmtInt(food.kcal_100g), unit: '100 g' };
}

type Base = { recents: RecentFood[]; favorites: FoodRow[] };

function readBase(): Base {
  const db = getDb();
  return { recents: listRecentFoods(db), favorites: listFavoriteFoods(db) };
}

/** The expanded row's portion state. Serving mode tracks the stepper; editing
 * grams by hand drops to grams mode (serving_qty no longer claimed). */
type Portion = { mode: 'serving' | 'grams'; qty: number; gramsText: string };

/** Which list the editor is open under — a food can appear in Recents AND
 * Favorites, and matching on food.id alone would open twin editors. */
type ListSection = 'recents' | 'favorites' | 'results';

type Expanded = { food: FoodRow; portion: Portion; section: ListSection };

function initialPortion(food: FoodRow): Portion {
  if (food.serving_grams !== null) {
    return { mode: 'serving', qty: 1, gramsText: fmtQty(food.serving_grams) };
  }
  return { mode: 'grams', qty: 1, gramsText: '100' };
}

/** A typed grams value that is actually loggable: finite, positive, and under
 * a sanity ceiling (paste and hardware keyboards get past decimal-pad — a
 * '1e99' item must never reach the DB). */
function parseGrams(text: string): number | null {
  const g = Number(text.trim());
  return Number.isFinite(g) && g > 0 && g <= 5000 ? g : null;
}

export default function FoodSearchScreen() {
  const router = useRouter();
  const { mealId } = useLocalSearchParams<{ mealId?: string }>();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FoodRow[]>([]);
  const [base, setBase] = useState(readBase);
  const [expanded, setExpanded] = useState<Expanded | null>(null);
  const [added, setAdded] = useState(0);
  // The meal every add lands in: the pushed-for meal, or the one the first
  // from-scratch add creates. State because it's born mid-session.
  const [targetMealId, setTargetMealId] = useState<string | null>(mealId ?? null);

  // Re-read recents/favorites — and the live query's results — when the screen
  // regains focus (returning from Create-food, most importantly, so the new
  // food appears under the query that failed to find it). Same sanctioned
  // useFocusEffect shape as use-log-feed; the [query] dep keeps it honest.
  const reload = useCallback(() => {
    setBase(readBase());
    setResults(query.trim() === '' ? [] : searchFoods(getDb(), query));
  }, [query]);
  useFocusEffect(reload);

  const runSearch = (text: string) => {
    setQuery(text);
    setExpanded(null);
    setResults(text.trim() === '' ? [] : searchFoods(getDb(), text));
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
    const { food, lastServingQty, lastGrams } = recent;
    if (lastServingQty !== null && food.serving_grams !== null) {
      saveItem(itemForPortion(food, { servingQty: lastServingQty }));
    } else if (lastGrams !== null) {
      saveItem(itemForPortion(food, { grams: lastGrams }));
    } else {
      setExpanded({ food, portion: initialPortion(food), section: 'recents' });
    }
  };

  const addExpanded = () => {
    if (!expanded) return;
    const { food, portion } = expanded;
    if (portion.mode === 'serving') {
      if (portion.qty <= 0) return;
      saveItem(itemForPortion(food, { servingQty: portion.qty }));
    } else {
      const grams = parseGrams(portion.gramsText);
      if (grams === null) return;
      saveItem(itemForPortion(food, { grams }));
    }
  };

  const stepQty = (delta: number) => {
    setExpanded((prev) => {
      if (!prev) return prev;
      const qty = Math.min(50, Math.max(0.5, prev.portion.qty + delta));
      const grams = gramsForQty(prev.food, qty);
      return {
        ...prev,
        portion: {
          mode: 'serving',
          qty,
          gramsText: grams !== null ? fmtQty(grams) : prev.portion.gramsText,
        },
      };
    });
  };

  const editGrams = (text: string) => {
    setExpanded((prev) =>
      prev ? { ...prev, portion: { ...prev.portion, mode: 'grams', gramsText: text } } : prev
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

  const gramsPreview =
    expanded === null
      ? null
      : expanded.portion.mode === 'serving'
        ? gramsForQty(expanded.food, expanded.portion.qty)
        : parseGrams(expanded.portion.gramsText);
  const kcalPreview =
    expanded !== null && gramsPreview !== null && expanded.food.kcal_100g !== null
      ? (expanded.food.kcal_100g * gramsPreview) / 100
      : null;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Add food" />
      </View>

      <View className="mt-2 flex-row items-center gap-2">
        <View className="flex-1 flex-row items-center gap-2 rounded-btn border border-hairline-soft bg-paper-deep px-3.5">
          <Ionicons name="search-outline" size={16} color={palette.inkMuted} />
          <TextInput
            value={query}
            onChangeText={runSearch}
            placeholder="Search foods"
            placeholderTextColor={palette.inkMuted}
            autoFocus
            autoCorrect={false}
            accessibilityLabel="Search foods"
            className="flex-1 py-3 text-[15px] text-ink"
          />
        </View>
        {added > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Done, ${added} added`}
            onPress={() => router.back()}
            className="rounded-btn border border-hairline-strong px-3.5 py-3 active:bg-paper-deep">
            <Text className="text-[13px] font-semibold text-ink">
              Done <Text className="font-mono text-[12px]">· {added}</Text>
            </Text>
          </Pressable>
        ) : null}
      </View>

      {query.trim() === '' ? (
        <>
          {/* Recents — the single biggest daily-speed lever: one tap re-adds
              the food at the portion it was last logged at. */}
          {base.recents.length > 0 ? (
            <View className="mt-6">
              <SectionLabel>Recent</SectionLabel>
              <View className="mt-1">
                {base.recents.map((recent, index) => (
                  <View
                    key={recent.food.id}
                    className={index === 0 ? '' : 'border-t border-hairline-soft'}>
                    <FoodListRow
                      food={recent.food}
                      subtitle={lastPortionLabel(recent)}
                      onPress={() =>
                        setExpanded({
                          food: recent.food,
                          portion: initialPortion(recent.food),
                          section: 'recents',
                        })
                      }
                      trailing={
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Add ${recent.food.name} again`}
                          hitSlop={8}
                          onPress={() => addRecent(recent)}
                          className="h-8 w-8 items-center justify-center rounded-btn border border-hairline-strong active:bg-paper-deep">
                          <Ionicons name="add" size={18} color={palette.ink} />
                        </Pressable>
                      }
                    />
                    {expanded?.section === 'recents' && expanded.food.id === recent.food.id ? (
                      <PortionEditor
                        expanded={expanded}
                        gramsPreview={gramsPreview}
                        kcalPreview={kcalPreview}
                        onStep={stepQty}
                        onEditGrams={editGrams}
                        onToggleFavorite={toggleFavorite}
                        onAdd={addExpanded}
                      />
                    ) : null}
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {base.favorites.length > 0 ? (
            <View className="mt-6">
              <SectionLabel>Favorites</SectionLabel>
              <View className="mt-1">
                {base.favorites.map((food, index) => (
                  <View
                    key={food.id}
                    className={index === 0 ? '' : 'border-t border-hairline-soft'}>
                    <FoodListRow
                      food={food}
                      subtitle={null}
                      onPress={() =>
                        setExpanded({ food, portion: initialPortion(food), section: 'favorites' })
                      }
                    />
                    {expanded?.section === 'favorites' && expanded.food.id === food.id ? (
                      <PortionEditor
                        expanded={expanded}
                        gramsPreview={gramsPreview}
                        kcalPreview={kcalPreview}
                        onStep={stepQty}
                        onEditGrams={editGrams}
                        onToggleFavorite={toggleFavorite}
                        onAdd={addExpanded}
                      />
                    ) : null}
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {base.recents.length === 0 && base.favorites.length === 0 ? (
            <Text className="mt-6 text-[13px] leading-5 text-ink-muted">
              Search the catalog — foods you log appear here for one-tap re-adds.
            </Text>
          ) : null}
        </>
      ) : (
        <View className="mt-4">
          {results.length === 0 ? (
            <Text className="mt-2 text-[13px] leading-5 text-ink-muted">
              Nothing matches “{query.trim()}”.
            </Text>
          ) : (
            <View>
              {results.map((food, index) => (
                <View key={food.id} className={index === 0 ? '' : 'border-t border-hairline-soft'}>
                  <FoodListRow
                    food={food}
                    subtitle={null}
                    onPress={() =>
                      setExpanded((prev) =>
                        prev?.food.id === food.id
                          ? null
                          : { food, portion: initialPortion(food), section: 'results' }
                      )
                    }
                  />
                  {expanded?.section === 'results' && expanded.food.id === food.id ? (
                    <PortionEditor
                      expanded={expanded}
                      gramsPreview={gramsPreview}
                      kcalPreview={kcalPreview}
                      onStep={stepQty}
                      onEditGrams={editGrams}
                      onToggleFavorite={toggleFavorite}
                      onAdd={addExpanded}
                    />
                  ) : null}
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      {/* Not in the catalog → create it, query prefilled. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Create a food"
        onPress={() =>
          router.push({ pathname: '/food-new', params: query.trim() ? { name: query.trim() } : {} })
        }
        className="mt-6 flex-row items-center gap-2 rounded-card border border-hairline bg-porcelain px-3.5 py-3 active:bg-paper-deep">
        <Ionicons name="add-circle-outline" size={17} color={palette.inkSecondary} />
        <Text className="text-[13px] text-ink">
          Create a food{query.trim() !== '' ? ` — “${query.trim()}”` : ''}
        </Text>
      </Pressable>
    </Screen>
  );
}

/** "2 × 1 egg" / "150 g" — how a recent food was last logged. */
function lastPortionLabel(recent: RecentFood): string | null {
  const { food, lastServingQty, lastGrams } = recent;
  if (lastServingQty !== null && food.serving_name !== null) {
    return `Last: ${fmtQty(lastServingQty)} × ${food.serving_name}`;
  }
  if (lastGrams !== null) return `Last: ${fmtQty(lastGrams)} g`;
  return null;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
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
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={food.name}
      onPress={onPress}
      className="flex-row items-center gap-3 py-3 active:opacity-60">
      <View className="flex-1">
        <Text className="text-[15px] leading-5 text-ink">
          {food.name}
          {food.brand ? <Text className="text-ink-muted"> · {food.brand}</Text> : null}
        </Text>
        {subtitle ? (
          <Text className="mt-0.5 font-mono text-[11px] leading-4 text-ink-muted">{subtitle}</Text>
        ) : null}
      </View>
      <View className="items-end">
        <Text className="font-mono text-[13px] text-ink-secondary">{kcal.value}</Text>
        {kcal.unit !== '' ? (
          <Text className="font-mono text-[10px] text-ink-muted">{kcal.unit}</Text>
        ) : null}
      </View>
      {trailing}
    </Pressable>
  );
}

/** The inline portion editor under a tapped row. The Add button is this
 * screen's one pine action (only one editor is ever open at a time). */
function PortionEditor({
  expanded,
  gramsPreview,
  kcalPreview,
  onStep,
  onEditGrams,
  onToggleFavorite,
  onAdd,
}: {
  expanded: Expanded;
  gramsPreview: number | null;
  kcalPreview: number | null;
  onStep: (delta: number) => void;
  onEditGrams: (text: string) => void;
  onToggleFavorite: (food: FoodRow) => void;
  onAdd: () => void;
}) {
  const { food, portion } = expanded;
  return (
    <View className="mb-3 rounded-card border border-hairline bg-porcelain p-3">
      <View className="flex-row items-center gap-2">
        {food.serving_grams !== null ? (
          <View className="flex-row items-center gap-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Less"
              onPress={() => onStep(-0.5)}
              className="h-9 w-9 items-center justify-center rounded-btn border border-hairline-strong active:bg-paper-deep">
              <Ionicons name="remove" size={16} color={palette.ink} />
            </Pressable>
            <Text className="w-14 text-center font-mono text-[15px] text-ink">
              {fmtQty(portion.qty)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="More"
              onPress={() => onStep(0.5)}
              className="h-9 w-9 items-center justify-center rounded-btn border border-hairline-strong active:bg-paper-deep">
              <Ionicons name="add" size={16} color={palette.ink} />
            </Pressable>
            <Text className="ml-1 text-xs text-ink-secondary">× {food.serving_name}</Text>
          </View>
        ) : null}
        <View className="ml-auto flex-row items-center gap-2">
          <TextInput
            value={portion.gramsText}
            onChangeText={onEditGrams}
            keyboardType="decimal-pad"
            accessibilityLabel="Grams"
            className="w-16 rounded-btn border border-hairline-soft bg-paper-deep px-2 py-2 text-right font-mono text-[13px] text-ink"
          />
          <Text className="text-xs text-ink-secondary">g</Text>
        </View>
      </View>

      <View className="mt-3 flex-row items-center justify-between">
        <Text className="font-mono text-[11px] text-ink-muted">
          {kcalPreview !== null ? `≈ ${fmtInt(kcalPreview)} kcal` : 'no energy recorded'}
        </Text>
        <View className="flex-row items-center gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={food.is_favorite === 1 ? 'Remove favorite' : 'Mark favorite'}
            hitSlop={6}
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
            disabled={gramsPreview === null || gramsPreview <= 0}
            onPress={onAdd}
            className={`rounded-btn px-4 py-2 ${
              gramsPreview !== null && gramsPreview > 0
                ? 'bg-pine active:opacity-70'
                : 'bg-hairline'
            }`}>
            <Text
              className={`text-[13px] font-semibold ${
                gramsPreview !== null && gramsPreview > 0 ? 'text-pine-on' : 'text-ink-muted'
              }`}>
              Add
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
