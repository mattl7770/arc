import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
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
 * history, soft check-off into a collapsed "in cart" section. Consolidation is a
 * view: duplicate names render as one line with member entries preserved
 * underneath.
 *
 * ## Conformed Set surface system (00-design-spec.md §1)
 *
 *   Add an item  → **well**. A capture surface is exactly what the well device
 *                  is for: the block IS the field, so the `TextInput` is bare
 *                  and the well's own paper-dim stock is its surface.
 *   Matches      → **plate**: the history hits are a record list.
 *   Staples      → no device. Chips are controls, not content; they are named
 *                  by a SectionLabel and set apart by air.
 *   Each category→ **plate**: a category is a record and a record is a table.
 *                  A category holding no lines renders nothing at all — a plate
 *                  closes a record, and an empty category has none to close.
 *   In cart      → **plate**, folded behind its own tally.
 *
 * **Accent budget: one — the add action docked in the well.** It follows the
 * `log/command-field.tsx` precedent exactly: a control inside a well carries the
 * accent fill (a stamp, never a raise onto plate stock), and it stays pine in
 * both states so the one action never moves under your thumb.
 *
 * **Check-off is neutral ink, never pine and never a signal.** An item in the
 * cart is a shopping state, not a completion stamp and certainly not a
 * biological one — the firewall in §2 runs both ways. The mark is the square
 * ink box the rest of the set uses for a selection (app/lab-import.tsx).
 * *(This reverses the earlier note here that check-off used "completion-stamp
 * semantics, pine fill = done": the accent moved to the capture field, which is
 * the only thing on the screen that writes a new item.)*
 */

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
    // Effectively unbounded for one household — the "In cart" tally and Clear's
    // scope must match what the section actually shows.
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

  const canAdd = entry.trim() !== '';

  // Category walking order for the section render. A category with no lines is
  // dropped here, so it draws nothing at all downstream.
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

      {/* ADD AN ITEM — the capture surface, and the screen's one accent. The
          input is bare: the well is its stock, and stacking a second recessed
          box inside a recess is the inversion block.tsx rules out. */}
      <View className="mt-5">
        <Block device="well">
          {/* items-end keeps the accent a fixed stamp at the foot of the field
              rather than a control that stretches with it. */}
          <View className="flex-row items-end gap-2.5">
            <View className="min-h-[44px] flex-1 justify-center">
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
                className="py-2 font-serif text-[15px] leading-5 text-ink"
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add to list"
              disabled={!canAdd}
              onPress={() => add(entry)}
              className={
                canAdd
                  ? 'h-11 w-11 items-center justify-center rounded-btn bg-pine active:opacity-70'
                  : 'h-11 w-11 items-center justify-center rounded-btn border border-paper-deep'
              }>
              <Ionicons name="add" size={22} color={palette.pineOn} />
            </Pressable>
          </View>
        </Block>
      </View>

      {/* MATCHES — autocomplete over the user's own history. A record list, so
          a plate; its label sits on the sheet like every other label here. */}
      {suggestions.length > 0 ? (
        <View className="mt-4">
          <SectionLabel label="Matches" />
          <View className="mt-2">
            <Block device="plate">
              {suggestions.map((s, index) => (
                <View key={s.id}>
                  <Divider first={index === 0} />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Add ${s.display_name}`}
                    onPress={() => add(s.display_name, s.last_qty_text)}
                    className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
                    <Text className="flex-1 font-serif text-[16px] text-ink">{s.display_name}</Text>
                    {/* A quantity is a measurement — mono, always. */}
                    {s.last_qty_text ? (
                      <Text className="font-mono text-[12px] text-ink-secondary">
                        {s.last_qty_text}
                      </Text>
                    ) : null}
                  </Pressable>
                </View>
              ))}
            </Block>
          </View>
        </View>
      ) : null}

      {/* STAPLES — the master list of always-buys, one tap to re-add. Controls,
          not content: chips on the bare sheet, no device. */}
      {data.staples.length > 0 ? (
        <View className="mt-7">
          <SectionLabel label="Staples" />
          <View className="mt-2 flex-row flex-wrap gap-2">
            {data.staples.map((s) => (
              <Pressable
                key={s.id}
                accessibilityRole="button"
                accessibilityLabel={`Add staple ${s.display_name}`}
                onPress={() => add(s.display_name, s.last_qty_text)}
                className="min-h-[44px] flex-row items-center gap-2 rounded-btn border border-hairline bg-paper-hi px-3 py-2 active:bg-paper-dim">
                <Ionicons name="add" size={15} color={palette.inkSecondary} />
                <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
                  {s.display_name}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {/* THE LIST, in store-walking order. Empty is authored and unplated: with
          nothing on the list there is no record to close, only a sentence. */}
      {data.lines.length === 0 ? (
        <View className="mt-7">
          <SectionLabel label="To buy" />
          <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
            The list is clear.
          </Text>
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
            Add items above, ask the Coach (“we’re out of milk”), or open a recipe and add its
            ingredients in one go.
          </Text>
        </View>
      ) : (
        [
          ...sections,
          ...(unknown.length > 0 ? [{ key: 'zz', label: 'Other', lines: unknown }] : []),
        ].map((section) => (
          <View key={section.key} className="mt-7">
            <SectionLabel label={section.label} />
            <View className="mt-2">
              <Block device="plate">
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
              </Block>
            </View>
          </View>
        ))
      )}

      {/* IN CART — checked items, folded; soft state until cleared. The tally
          rides the label, so it is true folded or open (§5). */}
      {data.checked.length > 0 ? (
        <View className="mt-7">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${data.checked.length} in cart`}
            accessibilityState={{ expanded: cartOpen }}
            onPress={() => setCartOpen(!cartOpen)}
            className="min-h-[44px] flex-row items-center gap-2 active:opacity-60">
            <View className="flex-1">
              <SectionLabel label="In cart" note={String(data.checked.length)} />
            </View>
            <Ionicons
              name={cartOpen ? 'chevron-up' : 'chevron-down'}
              size={14}
              color={palette.inkMuted}
            />
          </Pressable>
          {cartOpen ? (
            <View className="mt-2">
              <Block device="plate">
                {data.checked.map((item, index) => (
                  <View key={item.id}>
                    <Divider first={index === 0} />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Return ${item.name} to the list`}
                      onPress={() => {
                        uncheckGroceryItem(getDb(), item.id);
                        reload();
                      }}
                      className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
                      {/* In the cart, not "done" — neutral ink, square like
                          every other mark in this set. */}
                      <View className="h-[22px] w-[22px] items-center justify-center bg-ink">
                        <Ionicons name="checkmark" size={14} color={palette.paperHi} />
                      </View>
                      <Text className="flex-1 font-serif text-[16px] text-ink-muted line-through">
                        {item.name}
                      </Text>
                    </Pressable>
                  </View>
                ))}
                {/* A trailing action beneath the rows: the rule above it is
                    unconditional, because the row above genuinely exists. */}
                <Divider />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={clearArmed ? 'Tap again to clear the cart' : 'Clear the cart'}
                  onPress={clearCart}
                  className="min-h-[46px] items-center justify-center py-3 active:opacity-60">
                  <Text
                    className={
                      clearArmed
                        ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink'
                        : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
                    }>
                    {clearArmed ? 'Confirm clear' : 'Clear'}
                  </Text>
                </Pressable>
              </Block>
            </View>
          ) : null}
        </View>
      ) : null}
    </Screen>
  );
}

/** One consolidated line: check box · name · merged qty; expands to its
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
    <View>
      <Divider first={first} />
      <View className="min-h-[46px] flex-row items-center gap-3 py-2.5">
        {/* Shopping state, not completion: ink, and square. */}
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={`Check off ${line.name}`}
          accessibilityState={{ checked: false }}
          onPress={onCheck}
          hitSlop={12}
          className="h-[22px] w-[22px] items-center justify-center border-[1.5px] border-hairline active:bg-paper-dim"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Edit ${line.name}`}
          accessibilityState={{ expanded }}
          onPress={onToggle}
          className="flex-1 active:opacity-60">
          <View className="flex-row items-baseline gap-2">
            <Text className="flex-1 font-serif text-[16px] text-ink">{line.name}</Text>
            {line.qtyDisplay ? (
              <Text className="font-mono text-[12px] text-ink-secondary">{line.qtyDisplay}</Text>
            ) : null}
          </View>
          {/* The descriptor rides under the title, the way every other row in
              the set carries its detail — no indent hack, no negative margin. */}
          {forRecipes.length > 0 && !expanded ? (
            <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary">
              for {forRecipes.join(', ')}
            </Text>
          ) : null}
        </Pressable>
      </View>
      {expanded ? (
        <View>
          <Divider />
          <View className="py-1">
            {line.items.map((item) => (
              <GroceryItemEditor key={item.id} item={item} onChanged={onChanged} />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** One member entry's inline editor: qty text, category re-file (learns), remove.
 *  A form is controls, not content, so it takes no device of its own — the
 *  fields wear the well's tokens directly (block.tsx, form (b)). */
function GroceryItemEditor({ item, onChanged }: { item: GroceryItemRow; onChanged: () => void }) {
  const [qty, setQty] = useState(item.qty_text ?? '');

  const saveQty = () => {
    const trimmed = qty.trim();
    if ((trimmed || null) !== item.qty_text) {
      updateGroceryItem(getDb(), item.id, { qty_text: trimmed === '' ? null : trimmed });
      onChanged();
    }
  };

  const source =
    item.source === 'coach' ? 'added by Coach' : item.source === 'recipe' ? 'from a recipe' : '';

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
          className="min-h-[44px] w-24 border border-paper-deep bg-paper-dim px-2.5 py-2 text-right font-mono text-[13px] text-ink"
        />
        <Text className="flex-1 font-serif text-[13px] text-ink-secondary">{source}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${item.name}`}
          onPress={() => {
            removeGroceryItem(getDb(), item.id);
            onChanged();
          }}
          hitSlop={8}
          className="h-11 w-11 items-center justify-center active:opacity-60">
          <Ionicons name="close-circle-outline" size={20} color={palette.inkSecondary} />
        </Pressable>
      </View>
      {/* Re-filing teaches the list — the learned category wins forever after.
          The chosen chip is marked in ink, never in the accent. */}
      <View className="mt-1 flex-row flex-wrap gap-1.5">
        {GROCERY_CATEGORIES.map((c) => (
          <Pressable
            key={c.key}
            accessibilityRole="button"
            accessibilityLabel={`File ${item.name} under ${c.label}`}
            accessibilityState={{ selected: item.category === c.key }}
            onPress={() => {
              if (c.key !== item.category) {
                updateGroceryItem(getDb(), item.id, { category: c.key });
                onChanged();
              }
            }}
            className={
              item.category === c.key
                ? 'min-h-[44px] justify-center rounded-btn border border-ink bg-paper-dim px-2.5 py-1.5'
                : 'min-h-[44px] justify-center rounded-btn border border-hairline px-2.5 py-1.5 active:bg-paper-dim'
            }>
            <Text
              className={
                item.category === c.key
                  ? 'font-label text-[11px] font-semibold uppercase tracking-[1.2px] text-ink'
                  : 'font-label text-[11px] uppercase tracking-[1.2px] text-ink-secondary'
              }>
              {c.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
