import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import {
  addGroceryItems,
  checkGroceryItem,
  clearCheckedItems,
  consolidatedOpenList,
  listCheckedGroceryItems,
  listStaples,
  removeGroceryItem,
  searchGroceryHistory,
  uncheckGroceryItem,
  updateGroceryItem,
} from '@/lib/db/repositories/grocery';
import { getRecipe } from '@/lib/db/repositories/recipes';
import { CATEGORY_LABELS, GROCERY_CATEGORIES } from '@/lib/grocery/categories';
import type {
  ConsolidatedGroceryLine,
  GroceryItemRow,
  GroceryNamePrefRow,
} from '@/lib/grocery/types';

/**
 * The grocery list (docs/recipes-grocery.md §2b): one standing list, category
 * sections in store-walking order, autocomplete + staples from the user's own
 * history, soft check-off into a collapsed "in cart" section. Adherence-calm:
 * NO pine action on this screen — check-off circles use the standard
 * completion-stamp semantics (pine fill = done), which is what pine means.
 * Consolidation is a view: duplicate names render as one line with member
 * entries preserved underneath.
 */

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

type Loaded = {
  lines: ConsolidatedGroceryLine[];
  staples: GroceryNamePrefRow[];
  checked: GroceryItemRow[];
  recipeTitles: Record<string, string>;
};

function load(): Loaded {
  const db = getDb();
  const lines = consolidatedOpenList(db);
  const recipeTitles: Record<string, string> = {};
  for (const line of lines) {
    for (const item of line.items) {
      if (item.recipe_id && !(item.recipe_id in recipeTitles)) {
        recipeTitles[item.recipe_id] = getRecipe(db, item.recipe_id)?.title ?? '';
      }
    }
  }
  return {
    lines,
    staples: listStaples(db),
    // Effectively unbounded for one household — the "In cart · N" count and
    // Clear's scope must match what the section actually shows.
    checked: listCheckedGroceryItems(db, 500),
    recipeTitles,
  };
}

export default function GroceryScreen() {
  const [data, setData] = useState<Loaded>(load);
  const [entry, setEntry] = useState('');
  const [suggestions, setSuggestions] = useState<GroceryNamePrefRow[]>([]);
  const [expandedLine, setExpandedLine] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);

  const reload = useCallback(() => {
    setData(load());
    setClearArmed(false);
  }, []);
  useFocusEffect(reload);

  const type = (text: string) => {
    setEntry(text);
    setSuggestions(text.trim() === '' ? [] : searchGroceryHistory(getDb(), text));
  };

  const add = (name: string, qty?: string | null) => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    addGroceryItems(getDb(), [{ name: trimmed, qty_text: qty ?? null }]);
    setEntry('');
    setSuggestions([]);
    reload();
  };

  const checkLine = (line: ConsolidatedGroceryLine) => {
    const db = getDb();
    for (const item of line.items) checkGroceryItem(db, item.id);
    setExpandedLine(null);
    reload();
  };

  const clearCart = () => {
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    clearCheckedItems(getDb());
    setCartOpen(false);
    reload();
  };

  // Category walking order for the section render.
  const sections = GROCERY_CATEGORIES.map((c) => ({
    ...c,
    lines: data.lines.filter((l) => l.category === c.key),
  })).filter((s) => s.lines.length > 0);
  const unknown = data.lines.filter((l) => !(l.category in CATEGORY_LABELS));

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Grocery list" />
      </View>

      {/* Add field + autocomplete from the user's own history. */}
      <View className="mt-2">
        <View className="flex-row gap-2">
          <TextInput
            accessibilityLabel="Add a grocery item"
            value={entry}
            onChangeText={type}
            onSubmitEditing={() => add(entry)}
            placeholder="Add an item"
            placeholderTextColor={palette.inkMuted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            className="flex-1 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[15px] text-ink"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add to list"
            disabled={entry.trim() === ''}
            onPress={() => add(entry)}
            className={`items-center justify-center rounded-btn border px-4 ${
              entry.trim() === ''
                ? 'border-hairline'
                : 'border-hairline-strong active:bg-paper-deep'
            }`}>
            <Text
              className={`text-[13px] font-semibold ${entry.trim() === '' ? 'text-ink-muted' : 'text-ink'}`}>
              Add
            </Text>
          </Pressable>
        </View>

        {suggestions.length > 0 ? (
          <View className="mt-1 rounded-card border border-hairline bg-porcelain">
            {suggestions.map((s, index) => (
              <Pressable
                key={s.id}
                accessibilityRole="button"
                accessibilityLabel={`Add ${s.display_name}`}
                onPress={() => add(s.display_name, s.last_qty_text)}
                className={`flex-row items-center justify-between px-3.5 py-2.5 active:bg-paper-deep ${
                  index === 0 ? '' : 'border-t border-hairline-soft'
                }`}>
                <Text className="text-[14px] text-ink">{s.display_name}</Text>
                {s.last_qty_text ? (
                  <Text className="font-mono text-[11px] text-ink-muted">{s.last_qty_text}</Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      {/* Staples — the master list of always-buys, one tap to re-add. */}
      {data.staples.length > 0 ? (
        <View className="mt-5">
          <SectionLabel>Staples</SectionLabel>
          <View className="mt-2 flex-row flex-wrap gap-2">
            {data.staples.map((s) => (
              <Pressable
                key={s.id}
                accessibilityRole="button"
                accessibilityLabel={`Add staple ${s.display_name}`}
                onPress={() => add(s.display_name, s.last_qty_text)}
                className="rounded-btn border border-hairline-strong px-3 py-1.5 active:bg-paper-deep">
                <Text className="text-[12px] text-ink">{s.display_name}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {/* The list, in store-walking order. */}
      {data.lines.length === 0 ? (
        <View className="mt-8">
          <Text className="text-[13px] leading-5 text-ink-secondary">The list is clear.</Text>
          <Text className="mt-2 text-[13px] leading-5 text-ink-muted">
            Add items above, ask the Coach (“we’re out of milk”), or open a recipe and add its
            ingredients in one go.
          </Text>
        </View>
      ) : (
        [
          ...sections,
          ...(unknown.length > 0 ? [{ key: 'zz', label: 'Other', lines: unknown }] : []),
        ].map((section) => (
          <View key={section.key} className="mt-6">
            <SectionLabel>{section.label}</SectionLabel>
            <View className="mt-2 rounded-card border border-hairline bg-porcelain">
              {section.lines.map((line, index) => (
                <GroceryLine
                  key={line.name_norm}
                  line={line}
                  first={index === 0}
                  expanded={expandedLine === line.name_norm}
                  recipeTitles={data.recipeTitles}
                  onCheck={() => checkLine(line)}
                  onToggle={() =>
                    setExpandedLine(expandedLine === line.name_norm ? null : line.name_norm)
                  }
                  onChanged={reload}
                />
              ))}
            </View>
          </View>
        ))
      )}

      {/* In cart — checked items, collapsed; soft state until cleared. */}
      {data.checked.length > 0 ? (
        <View className="mt-8">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${data.checked.length} in cart`}
            accessibilityState={{ expanded: cartOpen }}
            onPress={() => setCartOpen(!cartOpen)}
            className="flex-row items-center gap-2 active:opacity-60">
            <SectionLabel>{`In cart · ${data.checked.length}`}</SectionLabel>
            <Ionicons
              name={cartOpen ? 'chevron-up' : 'chevron-down'}
              size={14}
              color={palette.inkMuted}
            />
          </Pressable>
          {cartOpen ? (
            <View className="mt-2 rounded-card border border-hairline bg-porcelain">
              {data.checked.map((item, index) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Return ${item.name} to the list`}
                  onPress={() => {
                    uncheckGroceryItem(getDb(), item.id);
                    reload();
                  }}
                  className={`flex-row items-center gap-3 px-4 py-2.5 active:bg-paper-deep ${
                    index === 0 ? '' : 'border-t border-hairline-soft'
                  }`}>
                  <View className="h-5 w-5 items-center justify-center rounded-full bg-pine">
                    <Ionicons name="checkmark" size={12} color={palette.pineOn} />
                  </View>
                  <Text className="flex-1 text-[14px] text-ink-muted line-through">
                    {item.name}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={clearArmed ? 'Tap again to clear the cart' : 'Clear the cart'}
                onPress={clearCart}
                className="border-t border-hairline-soft px-4 py-3 active:bg-paper-deep">
                <Text
                  className={`text-center text-[13px] ${clearArmed ? 'font-semibold text-ink' : 'text-ink-muted'}`}>
                  {clearArmed ? 'Confirm clear' : 'Clear'}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}
    </Screen>
  );
}

/** One consolidated line: check circle · name · merged qty; expands to its
 * member entries (qty edit, category re-file, remove). */
function GroceryLine({
  line,
  first,
  expanded,
  recipeTitles,
  onCheck,
  onToggle,
  onChanged,
}: {
  line: ConsolidatedGroceryLine;
  first: boolean;
  expanded: boolean;
  recipeTitles: Record<string, string>;
  onCheck: () => void;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const forRecipes = [
    ...new Set(
      line.items
        .map((i) => (i.recipe_id ? recipeTitles[i.recipe_id] : null))
        .filter((t): t is string => !!t)
    ),
  ];
  return (
    <View className={first ? '' : 'border-t border-hairline-soft'}>
      <View className="flex-row items-center gap-3 px-4 py-2.5">
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={`Check off ${line.name}`}
          accessibilityState={{ checked: false }}
          onPress={onCheck}
          hitSlop={8}
          className="h-5 w-5 rounded-full border border-hairline-strong active:bg-paper-deep"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Edit ${line.name}`}
          accessibilityState={{ expanded }}
          onPress={onToggle}
          className="flex-1 flex-row items-baseline gap-2 active:opacity-60">
          <Text className="flex-1 text-[14px] text-ink">{line.name}</Text>
          {line.qtyDisplay ? (
            <Text className="font-mono text-[12px] text-ink-secondary">{line.qtyDisplay}</Text>
          ) : null}
        </Pressable>
      </View>
      {forRecipes.length > 0 && !expanded ? (
        <Text className="-mt-1 px-4 pb-2 pl-12 text-[11px] text-ink-muted">
          for {forRecipes.join(', ')}
        </Text>
      ) : null}
      {expanded ? (
        <View className="border-t border-hairline-soft bg-paper-deep/40 px-4 pb-3 pt-2">
          {line.items.map((item) => (
            <GroceryItemEditor key={item.id} item={item} onChanged={onChanged} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** One member entry's inline editor: qty text, category re-file (learns), remove. */
function GroceryItemEditor({ item, onChanged }: { item: GroceryItemRow; onChanged: () => void }) {
  const [qty, setQty] = useState(item.qty_text ?? '');

  const saveQty = () => {
    const trimmed = qty.trim();
    if ((trimmed || null) !== item.qty_text) {
      updateGroceryItem(getDb(), item.id, { qty_text: trimmed === '' ? null : trimmed });
      onChanged();
    }
  };

  return (
    <View className="py-2">
      <View className="flex-row items-center gap-2">
        <TextInput
          accessibilityLabel={`Quantity for ${item.name}`}
          value={qty}
          onChangeText={setQty}
          onBlur={saveQty}
          onSubmitEditing={saveQty}
          placeholder="qty"
          placeholderTextColor={palette.inkMuted}
          className="w-24 rounded-btn border border-hairline-soft bg-paper-deep px-2.5 py-1.5 text-right font-mono text-[13px] text-ink"
        />
        <Text className="flex-1 text-[12px] text-ink-muted">
          {item.source === 'coach'
            ? 'added by Coach'
            : item.source === 'recipe'
              ? 'from a recipe'
              : ''}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${item.name}`}
          onPress={() => {
            removeGroceryItem(getDb(), item.id);
            onChanged();
          }}
          hitSlop={8}
          className="active:opacity-60">
          <Ionicons name="close-circle-outline" size={18} color={palette.inkMuted} />
        </Pressable>
      </View>
      {/* Re-filing teaches the list — the learned category wins forever after. */}
      <View className="mt-2 flex-row flex-wrap gap-1.5">
        {GROCERY_CATEGORIES.map((c) => (
          <Pressable
            key={c.key}
            accessibilityRole="button"
            accessibilityLabel={`File ${item.name} under ${c.label}`}
            onPress={() => {
              if (c.key !== item.category) {
                updateGroceryItem(getDb(), item.id, { category: c.key });
                onChanged();
              }
            }}
            className={`rounded-btn border px-2 py-1 ${
              item.category === c.key
                ? 'border-hairline-strong bg-paper-deep'
                : 'border-hairline active:bg-paper-deep'
            }`}>
            <Text
              className={`text-[10px] ${item.category === c.key ? 'font-semibold text-ink' : 'text-ink-muted'}`}>
              {c.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
