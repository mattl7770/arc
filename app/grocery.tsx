import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import {
  addGroceryItems,
  cartSections,
  checkGroceryItem,
  clearCartSection,
  consolidatedOpenList,
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
 * ## Two changes from the owner's device pass, 2026-08-12
 *
 * **Check-off waits.** *"When you click 'Log it' on the grocery list, it should
 * first wait a few seconds to allow the user time to uncheck if it was an
 * accident before moving into the cart tab."* A mis-tap used to be instant and
 * silent: the line vanished from the aisle you were standing in and reappeared
 * inside a folded section further down the sheet, so recovering from it meant
 * finding the fold, opening it, and finding the row. Now the row stays exactly
 * where it is, struck through, with an **Undo** beside it, and the write lands
 * {@link CHECK_OFF_UNDO_MS} later.
 *
 * The window is a UI grace period, not a queue. Three rules make it safe:
 *   - **Leaving the screen commits immediately** (the focus effect's cleanup),
 *     so nothing is lost by walking away mid-countdown and nothing is left
 *     half-checked for the Coach or the Eat tab's line count to disagree about.
 *   - **The pending row is still an OPEN row in the database.** Nothing is
 *     written until the timer fires, so a crash mid-window loses a tap, never a
 *     list — and the "In cart" tally never counts something that is still on
 *     screen above it.
 *   - **One timer per line, keyed by name_norm**, and a line already counting
 *     down ignores a second tap. Re-tapping is how you undo, and the Undo
 *     control is what says so.
 *
 * **Two carts, not one.** *"Add a new tab below cart that is old carts, and move
 * anything checked off in a cart that is over 1 day old into the old carts tab.
 * Also give these two subtabs bigger titles with a line under."* A single "In
 * cart" section mixed this morning's shop with everything checked off since the
 * list was created, so the one thing it is for — is that in the trolley? — got
 * harder to read every week. The boundary is 24 hours from the check-off itself
 * (`cartCutoff`, src/lib/db/repositories/grocery.ts), and each section clears
 * independently: emptying today's cart can never take last month's history with
 * it.
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
 *   Cart / Old   → **plate**, each folded behind its own tally, under a
 *                  {@link CartHeading}.
 *
 * **The cart headings are the one departure from "sections are separated by
 * whitespace only", and it is an owner call.** §4 bans a rule laid across the
 * page to divide two sections — but it sanctions a rule that *closes a band*,
 * which is exactly what `StackHeader` draws under every pushed screen's title.
 * These two headings are built the same way and for the same reason: they are
 * titles of a band, drawn with `Divider` (never `border-b`, which React Native
 * paints as a full rectangle — see src/components/ui/block.tsx).
 *
 * **Accent budget: one — the add action docked in the well.** It follows the
 * `log/command-field.tsx` precedent exactly: a control inside a well carries the
 * accent fill (a stamp, never a raise onto plate stock), and it stays pine in
 * both states so the one action never moves under your thumb. Undo is bare ink:
 * it can be on screen at the same time as the add button, and a correction is
 * not the screen's primary action.
 *
 * **Check-off is neutral ink, never pine and never a signal.** An item in the
 * cart is a shopping state, not a completion stamp and certainly not a
 * biological one — the firewall in §2 runs both ways. The mark is the square
 * ink box the rest of the set uses for a selection (app/lab-import.tsx).
 */

/**
 * How long a checked line sits on screen, struck through and undoable, before
 * the write lands.
 *
 * **Four seconds.** The owner asked for "a few". Long enough to notice a
 * mis-tap while still looking at the shelf you tapped it from, and short enough
 * that a deliberate check-off does not feel like it failed — the whole point of
 * the section below is that the item goes somewhere, and a countdown you have
 * to wait out is its own annoyance. Two seconds is under the time it takes to
 * look up from the phone; ten would leave half a shop pending.
 */
const CHECK_OFF_UNDO_MS = 4000;

type Loaded = {
  lines: ConsolidatedGroceryLine[];
  staples: GroceryNamePrefRow[];
  /** Checked within the last day — this shop. */
  cart: GroceryItemRow[];
  /** Checked before that — previous shops. */
  oldCart: GroceryItemRow[];
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
  // Effectively unbounded for one household — the two tallies and each Clear's
  // scope must match what its section actually shows.
  const { cart, old } = cartSections(db, new Date(), 500);
  return { lines, staples: listStaples(db), cart, oldCart: old, recipeTitles };
}

/** Which cart section is folded open. */
type CartKey = 'cart' | 'old';

export default function GroceryScreen() {
  const [data, setData] = useState<Loaded>(load);
  const [entry, setEntry] = useState('');
  const [suggestions, setSuggestions] = useState<GroceryNamePrefRow[]>([]);
  const [expandedLine, setExpandedLine] = useState<string | null>(null);
  const [openCart, setOpenCart] = useState<Record<CartKey, boolean>>({ cart: false, old: false });
  const [clearArmed, setClearArmed] = useState<CartKey | null>(null);

  /**
   * Lines checked off but not yet written: `name_norm` → the member item ids the
   * commit will stamp.
   *
   * **Pure state, and the two row handlers below touch nothing else.** That is a
   * constraint, not a style: a function that dereferences a ref and is then
   * passed as a prop is evaluated in render scope, which `react-hooks/refs`
   * rejects outright ("Cannot access refs during render"). So `checkLine` and
   * `undoCheck` are state setters and nothing more; every ref lives in the
   * effect and the commit below, where refs belong.
   */
  const [pending, setPending] = useState<Record<string, string[]>>({});
  /** One live timer per pending line. A ref because it is machinery, not
   *  something the screen draws — touched only inside effects. */
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** `pending` as of the last commit, for the blur flush — which runs in an
   *  effect cleanup and so cannot read state directly. */
  const pendingRef = useRef<Record<string, string[]>>({});
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const reload = useCallback(() => {
    setData(load());
    setClearArmed(null);
  }, []);

  /** Write one pending line's check-offs and drop it from the pending set. The
   *  ids are passed IN rather than looked up, so this needs no view of the
   *  pending map and is safe to call twice — the second call finds the key
   *  already gone and the setter returns the same object. */
  const commit = useCallback((key: string, ids: string[]) => {
    const timer = timers.current.get(key);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(key);
    }
    const db = getDb();
    for (const id of ids) checkGroceryItem(db, id);
    setPending((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setData(load());
  }, []);

  /**
   * The countdown, owned by an effect rather than by the tap handler.
   *
   * It starts a timer for any newly pending line and cancels the timer of any
   * line that has left the set (an Undo). Started per KEY, never wholesale —
   * re-creating every timer on each change would restart the first line's
   * countdown each time another was checked, so a fast shop would leave
   * everything pending until the tapping stopped.
   */
  useEffect(() => {
    for (const [key, ids] of Object.entries(pending)) {
      if (timers.current.has(key)) continue;
      timers.current.set(
        key,
        setTimeout(() => commit(key, ids), CHECK_OFF_UNDO_MS)
      );
    }
    for (const [key, timer] of timers.current) {
      if (key in pending) continue;
      clearTimeout(timer);
      timers.current.delete(key);
    }
  }, [pending, commit]);

  /** Commit every outstanding line — the cleanup path. */
  const flushPending = useCallback(() => {
    for (const [key, ids] of Object.entries(pendingRef.current)) commit(key, ids);
  }, [commit]);

  // Read on focus; flush on blur. The cleanup is what makes the undo window a
  // grace period rather than a way to lose a tap by walking away from it.
  useFocusEffect(
    useCallback(() => {
      reload();
      return flushPending;
    }, [reload, flushPending])
  );

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

  /** Start the undo window on a line. A line already counting down is left
   *  alone — the second tap you would make is Undo, not a re-check. */
  const checkLine = (line: ConsolidatedGroceryLine) => {
    setExpandedLine(null);
    setPending((prev) =>
      line.name_norm in prev ? prev : { ...prev, [line.name_norm]: line.items.map((i) => i.id) }
    );
  };

  /** Cancel a pending check-off. Nothing was written, so nothing is undone in
   *  the database — dropping the key is what stops the timer (the effect
   *  above cancels it). */
  const undoCheck = (key: string) => {
    setPending((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const clearSection = (scope: CartKey) => {
    if (clearArmed !== scope) {
      setClearArmed(scope);
      return;
    }
    clearCartSection(getDb(), scope);
    setOpenCart((prev) => ({ ...prev, [scope]: false }));
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
                    pending={line.name_norm in pending}
                    recipeTitles={data.recipeTitles}
                    onCheck={() => checkLine(line)}
                    onUndo={() => undoCheck(line.name_norm)}
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

      {/* IN CART — this shop, folded; soft state until cleared. The tally rides
          the heading, so it is true folded or open (§5). */}
      {data.cart.length > 0 ? (
        <CartSection
          heading="In cart"
          scope="cart"
          items={data.cart}
          open={openCart.cart}
          armed={clearArmed === 'cart'}
          onToggle={() => setOpenCart((prev) => ({ ...prev, cart: !prev.cart }))}
          onClear={() => clearSection('cart')}
          onReturn={(id) => {
            uncheckGroceryItem(getDb(), id);
            reload();
          }}
        />
      ) : null}

      {/* OLD CARTS — everything checked off more than a day ago. Kept rather
          than swept: it is the purchase history the Recent/staple memory reads
          from, and it is the only record of what a past shop actually held. */}
      {data.oldCart.length > 0 ? (
        <CartSection
          heading="Old carts"
          scope="old"
          items={data.oldCart}
          open={openCart.old}
          armed={clearArmed === 'old'}
          onToggle={() => setOpenCart((prev) => ({ ...prev, old: !prev.old }))}
          onClear={() => clearSection('old')}
          onReturn={(id) => {
            uncheckGroceryItem(getDb(), id);
            reload();
          }}
        />
      ) : null}
    </Screen>
  );
}

/**
 * A cart section's heading: a **bigger serif title, ruled underneath** (owner,
 * 2026-08-12) — the `StackHeader` band idiom, not a page divider. The tally is a
 * measured value so it stays mono, and the whole band is the fold toggle with
 * `accessibilityState.expanded` on it, so the fold goes both ways.
 */
function CartHeading({
  title,
  count,
  open,
  onToggle,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${count} item${count === 1 ? '' : 's'}`}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        className="min-h-[44px] flex-row items-baseline gap-2 pb-2 active:opacity-60">
        <Text className="font-serif text-[19px] font-semibold text-ink">{title}</Text>
        <Text className="font-mono text-[12px] text-ink-muted">{count}</Text>
        <View className="flex-1" />
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={palette.inkMuted} />
      </Pressable>
      {/* Drawn, never a `border-b` — React Native paints a one-sided width
          against a border colour as a full rectangle (block.tsx). */}
      <Divider />
    </View>
  );
}

/**
 * One cart section — the heading band, then a ruled plate of its rows with its
 * own Clear beneath them. Two of these are on the sheet and each clears only
 * its own scope, so emptying today's trolley can never take the older carts.
 */
function CartSection({
  heading,
  scope,
  items,
  open,
  armed,
  onToggle,
  onClear,
  onReturn,
}: {
  heading: string;
  scope: 'cart' | 'old';
  items: GroceryItemRow[];
  open: boolean;
  armed: boolean;
  onToggle: () => void;
  onClear: () => void;
  onReturn: (id: string) => void;
}) {
  return (
    <View className="mt-8">
      <CartHeading title={heading} count={items.length} open={open} onToggle={onToggle} />
      {open ? (
        <View className="mt-3">
          <Block device="plate">
            {items.map((item, index) => (
              <View key={item.id}>
                <Divider first={index === 0} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Return ${item.name} to the list`}
                  onPress={() => onReturn(item.id)}
                  className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
                  {/* In the cart, not "done" — neutral ink, square like every
                      other mark in this set. */}
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
              accessibilityLabel={armed ? `Tap again to clear ${heading}` : `Clear ${heading}`}
              onPress={onClear}
              className="min-h-[46px] items-center justify-center py-3 active:opacity-60">
              <Text
                className={
                  armed
                    ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink'
                    : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
                }>
                {armed ? 'Confirm clear' : 'Clear'}
              </Text>
            </Pressable>
          </Block>
          {armed ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              {scope === 'cart'
                ? 'Removes these rows. The older carts and your item history are kept.'
                : 'Removes these rows. Today’s cart and your item history are kept.'}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** One consolidated line: check box · name · merged qty; expands to its
 * member entries (qty edit, category re-file, remove).
 *
 * While `pending`, the row is struck through and its trailing slot is an
 * **Undo** — the row does not move, because the whole point of the window is
 * that a mis-tap is recovered where it was made. */
function GroceryLine({
  line,
  first,
  expanded,
  pending,
  recipeTitles,
  onCheck,
  onUndo,
  onToggle,
  onChanged,
}: {
  line: ConsolidatedGroceryLine;
  first: boolean;
  expanded: boolean;
  pending: boolean;
  recipeTitles: Record<string, string>;
  onCheck: () => void;
  onUndo: () => void;
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
        {/* Shopping state, not completion: ink, and square. The filled state is
            the pending one — the row is telling you what is about to happen,
            which is why Undo sits beside it rather than in a toast. */}
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={pending ? `Undo checking off ${line.name}` : `Check off ${line.name}`}
          accessibilityState={{ checked: pending }}
          onPress={pending ? onUndo : onCheck}
          hitSlop={12}
          className={
            pending
              ? 'h-[22px] w-[22px] items-center justify-center border-[1.5px] border-ink bg-ink active:opacity-60'
              : 'h-[22px] w-[22px] items-center justify-center border-[1.5px] border-hairline active:bg-paper-dim'
          }>
          {pending ? <Ionicons name="checkmark" size={14} color={palette.paperHi} /> : null}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Edit ${line.name}`}
          accessibilityState={{ expanded }}
          disabled={pending}
          onPress={onToggle}
          className="flex-1 active:opacity-60">
          <View className="flex-row items-baseline gap-2">
            <Text
              className={
                pending
                  ? 'flex-1 font-serif text-[16px] text-ink-muted line-through'
                  : 'flex-1 font-serif text-[16px] text-ink'
              }>
              {line.name}
            </Text>
            {line.qtyDisplay ? (
              <Text className="font-mono text-[12px] text-ink-secondary">{line.qtyDisplay}</Text>
            ) : null}
          </View>
          {/* The descriptor rides under the title, the way every other row in
              the set carries its detail — no indent hack, no negative margin. */}
          {forRecipes.length > 0 && !expanded && !pending ? (
            <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary">
              for {forRecipes.join(', ')}
            </Text>
          ) : null}
        </Pressable>
        {/* Bare ink, not the accent: this control coexists with the add stamp
            in the well, and a correction is never the screen's one action. */}
        {pending ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Undo checking off ${line.name}`}
            onPress={onUndo}
            hitSlop={8}
            className="min-h-[44px] justify-center px-1 active:opacity-60">
            <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
              Undo
            </Text>
          </Pressable>
        ) : null}
      </View>
      {expanded && !pending ? (
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
