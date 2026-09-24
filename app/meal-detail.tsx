import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { type Dispatch, type SetStateAction, useCallback, useState } from 'react';
import { Alert, Image, Pressable, Text, TextInput, View } from 'react-native';

import { KeyMicroTail } from '@/components/nutrition/key-micro-tail';
import { UndoRow } from '@/components/nutrition/undo-row';
import { Block, Divider, GridCell } from '@/components/ui/block';
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
import { getFood } from '@/lib/db/repositories/foods';
import { saveMealAsTemplate } from '@/lib/db/repositories/meal-templates';
import { saveMealAsRecipe } from '@/lib/db/repositories/recipes';
import {
  clearCompositeCount,
  getMeal,
  listMealItems,
  relogMeal,
  scaleCompositeItem,
  setCompositeCount,
  updateMealItemPortion,
  updateMealName,
  updateMealTime,
} from '@/lib/db/repositories/nutrition';
import { assembleMealItems, type MealItemNode } from '@/lib/nutrition/composite';
import {
  type LoggedCountDraft,
  type LoggedCountPlan,
  parseCount,
  planLoggedCount,
} from '@/lib/nutrition/review-rows';
import { mealPhotoViews, type MealPhotoView } from '@/lib/media/meal-photo-store';
import { deleteMealWithUndo, removeItemWithUndo } from '@/lib/nutrition/undo-offers';
import { closeUndo, onMeal, runUndo } from '@/lib/nutrition/undo-store';
import {
  fmtInt,
  fmtQty,
  macroLine,
  pieceNounFor,
  piecesLabel,
  pluralNoun,
  portionLabel,
} from '@/lib/nutrition/format';
import { keyMicroLabel, partsAsItem } from '@/lib/nutrition/key-micro';
import { mealDayLabel, parseClockParts, partsFromClock, shiftDay } from '@/lib/nutrition/meal-time';
import { amountForQty, rescaleLoggedItem } from '@/lib/nutrition/servings';
import type { AmountUnit, FoodRow, MealItemWithServing, MealRow } from '@/lib/nutrition/types';

/** The fractions a person actually says, for "I ate half the pizza" (C4). */
const PART_FRACTIONS: { label: string; factor: number; spoken: string }[] = [
  { label: '½', factor: 0.5, spoken: 'half' },
  { label: '⅓', factor: 1 / 3, spoken: 'a third' },
  { label: '¼', factor: 0.25, spoken: 'a quarter' },
];

/**
 * One meal's record (docs/nutrition-subapp.md §2): its items with portions and
 * snapshots, add-food into it, "Log again" (the copy-from-yesterday loop), and
 * delete. Free-form meals (no items) show their directly-recorded totals; once
 * items exist, the repository owns the totals.
 *
 * ## Correcting it in words (owner, 2026-08-12)
 *
 * *"I should be able to use plain-text input to have AI edit a meal. I.e.
 * 'Actually, that was cooked in olive oil not butter'."* The **Adjust with AI**
 * row is the first action on this screen, because correcting a meal is the
 * thing you come back to it for; Log again and the two Save-as rows are about
 * reusing it, which is a later act.
 *
 * It PUSHES rather than expanding inline, and that is the point: a revision
 * replaces a record already counted into the day, the week and the Coach's
 * snapshot, so it is a pending write in the strict sense (00-design-spec.md §5)
 * and gets a proposal, a stated consequence and a confirm. Inline it would have
 * had to draw the old numbers and the new ones at once — the one thing §5
 * forbids. Nothing here changes until Save on that screen
 * (app/meal-revise.tsx → `replaceMealItems`, which touches the items and
 * nothing else).
 *
 * ## Two additions from the owner's device pass, 2026-08-12
 *
 * **The time is editable.** A meal's clock time — and its DAY — could not be
 * corrected once logged, which made a meal eaten at 00:40 and belonging to the
 * evening before permanently wrong. The control sits on the value it changes:
 * the date/time line at the top of this screen carries a "Change" beside it and
 * opens {@link MealTimeEditor} directly beneath. It is deliberately NOT also on
 * the Eaten-today row (app/nutrition.tsx) — that row is a single tap target
 * whose whole job is to open this screen, and a second control inside it would
 * both fight that target and put an editor on a list where the edit's
 * consequence (the day's totals, right above it) cannot be shown.
 *
 * The day boundary is a supported crossing, not a guarded one: moving a meal to
 * another date moves its energy off one day's totals and onto another's with
 * nothing to recompute, because every nutrition read groups `meals` by the
 * `date` column at read time. The reasoning and the test are on `updateMealTime`
 * (src/lib/db/repositories/nutrition.ts).
 *
 * ## The name is editable too (owner, 2026-08-15)
 *
 * *"Add functionality to be able to change the name of a meal."*
 *
 * **A meal's name was already a real, free-text column** — `meals.name`,
 * `NOT NULL` since 0002 — written once by whichever path logged the row and
 * never editable afterwards. It is not a slot (`breakfast`/`lunch`/…) and it is
 * not derived from the items, so this needed **no migration**: it is one UPDATE
 * of one column, `updateMealName`, single-purpose for the same reason
 * `updateMealTime` is.
 *
 * **The control sits on the value it changes**, which is the rule the time
 * control established — and a meal's name is not on a line of its own, it IS
 * the header title. So `StackHeader` grew an optional trailing `action` slot
 * and the `Rename` affordance lives there, with {@link MealNameEditor} opening
 * directly beneath it. Putting it on the date/time line beside `Change` was the
 * alternative and it is worse: two trailing label-voice controls on one line
 * leave the reader guessing which changes what.
 *
 * **An empty name is refused, not cleared.** There is nothing to clear back
 * TO — no slot, no derivation, and a name invented from the items would be a
 * fabricated record (00-design-spec.md §5). So a blank field disables Save,
 * says so in words, and the meal keeps the name it has; `updateMealName` throws
 * as the backstop. **A rename touches nothing else** — items, macros, photo,
 * time and provenance are all outside the one column it writes, which
 * db/nutrition.test.mjs §13 asserts field by field.
 *
 * **The photo is shown.** A meal logged through the estimator now keeps the
 * image it was estimated from (0033), and it is drawn here at its own aspect
 * with the retention stated under it. A meal with no photo draws NOTHING —
 * no frame, no placeholder, no "add a photo" control that this binary could not
 * honour (00-design-spec.md §5). A meal combined from photographed meals draws
 * each photo it holds (2026-09-23). Deleting the meal deletes the files — once
 * the Undo below has had its chance, which is why `deleteMealWithUndo` stands
 * in for `deleteMeal` here.
 *
 * ## Undo (owner, device, 2026-09-23)
 *
 * *"undo for removing a food."* Both removals on this screen offer one, drawn
 * as the Log tab's water receipt is (src/components/nutrition/undo-row.tsx),
 * and both go through src/lib/nutrition/undo-offers.ts, which pairs each
 * removal with its put-back:
 *
 * - **An item's ×** runs `removeItemWithUndo` — `removeMealItem`, having read
 *   every row it deletes — and the receipt appears at the foot of the Items
 *   plate, above Add food. Undo puts those rows back verbatim
 *   (`restoreMealItems`): same ids, same snapshot, same place in the list, and
 *   the meal's totals back to the exact figures they read before.
 * - **Delete this meal** runs `deleteMealWithUndo` and closes the screen as it
 *   always has; the receipt is on the list of the day the meal was logged on,
 *   because that is where it was and where it comes back. Its photo files stay
 *   on disk, held, until that offer closes (src/lib/media/held-files.ts).
 *
 * The window (src/lib/nutrition/undo-store.ts): no timer; the next removal
 * replaces it; any other write on this screen, or leaving it, closes it — an
 * item put back beside an edit made since would be a meal nobody logged. A
 * write this screen did not make (a queued revision drained on return to the
 * foreground) does not close it, so the repository refuses that put-back
 * itself, and the row then says it could not.
 *
 * ## Conformed Set surface system
 *
 *   Photo    → **no device**: an image is content, and a drafting container
 *              round a photograph says nothing about it. A 1px hairline frames
 *              the bleed and that is all — a whole border, never a one-sided
 *              width with a colour class.
 *   Totals   → **grid**: energy and macros are a metric grid, so the grid is the
 *              object — no outer box, drawn by the rules that run between its
 *              cells (src/components/ui/block.tsx).
 *   Notes    → **margin annotation**: prose belongs in the margin, not a card.
 *   Items    → **ruled plate**: a record is a table, drawn in both the itemized
 *              and the free-form state. "Add food" is its closing row, so the
 *              way to extend the record sits with the record.
 *   Actions  → **ruled plate**: another list of things you can do.
 *   When     → **no device**: a form is controls, not content — form (b) of the
 *              capture-surface rule, each field wearing `border-paper-deep
 *              bg-paper-dim` directly with no well around it.
 *
 * **The ledger rule.** Once a meal is itemized, `recomputeMealTotals` writes the
 * meal's own kcal/macro columns as the item sums inside the same transaction as
 * every item change — so the Totals grid IS the sum of the item rows below it,
 * and the Items label repeats that figure to make the arithmetic checkable.
 * (Adding the first item to a free-form meal preserves its typed totals as an
 * "(as logged)" item, so the two never silently diverge.) A free-form meal
 * carries no such note, because there is nothing to reconcile against.
 *
 * **Accent budget: one.** An open editor's Save — and this screen now has three
 * editors (portion, time, name), so they are MUTUALLY EXCLUSIVE: opening any
 * one closes the other two. That is what keeps the budget a ceiling rather than
 * a quota, and it is enforced in the open handlers, not by convention.
 */

type MealState = {
  meal: MealRow | undefined;
  items: MealItemWithServing[];
  /** The meal's photos, newest first, or none — which is both "no photo" and
   *  "the file is gone", because a broken frame is worse than no frame (0033).
   *  One, except on a meal combined from photographed meals (2026-09-23). */
  photos: MealPhotoView[];
};

/** The inline portion-editor's state for one item. `food` is the catalog food
 * if still present (enables the serving stepper + accurate re-derive). */
type ItemEdit = {
  itemId: string;
  food: FoodRow | undefined;
  mode: 'serving' | 'amount';
  qty: number;
  /** In the ITEM'S OWN unit (g or ml, 0047) — never converted for the oz/ml
   * display preference, which governs read-only figures only. An entry box that
   * converted would write 331.2 ml back over a 330 ml portion nobody edited. */
  amountText: string;
  /** What the field is counting — the item's logged unit, which re-portioning
   * never changes. */
  unit: AmountUnit;
};

/** The when-editor's draft. Held apart from the row so backing out writes
 *  nothing — nothing is saved until Save. */
type TimeEdit = { date: string; hour: string; minute: string };

/** The rename editor's draft, or null when it is closed. A plain string rather
 *  than a record: a meal has exactly one name and nothing else moves with it. */
type NameEdit = string | null;

/**
 * The count-of-pieces editor's draft for ONE composite (0059, re-cut
 * 2026-09-23), or null when closed. What Save does with it is
 * `planLoggedCount`'s call (src/lib/nutrition/review-rows.ts), so the sentence
 * above Save and the write read the same plan.
 *
 * A null text is an UNTOUCHED field, never an empty one — which is what lets an
 * untouched count Save as no change at all, instead of re-writing a 2.6667 as
 * the 2.7 its field displays.
 *
 * It replaced a draft with a `cleared` flag, under which backspacing an 8 and
 * typing a 6 declared afresh while typing straight over the 8 scaled — two
 * gestures for "change 8 to 6" with opposite effects, the trap the spike's own
 * device list named. Now typing means one thing per field.
 */
type CountEdit = LoggedCountDraft & {
  parentId: string;
  /** The noun's own field is open. */
  naming: boolean;
};

function readMeal(id: string): MealState {
  const db = getDb();
  return {
    meal: getMeal(db, id),
    items: listMealItems(db, id),
    // Native-guarded and total: on a runtime with no file system module (the
    // web logic-check preview, the headless render suite) this is empty and the
    // screen simply has no photo section.
    photos: mealPhotoViews(db, id),
  };
}

/** A typed amount safe to log: finite, positive, under a sanity ceiling
 * (paste / hardware keyboards get past the numeric soft keyboard). Unit-blind:
 * 5000 ml is five litres, as implausible a single portion as 5000 g. */
function parseAmount(text: string): number | null {
  const n = Number(text.trim());
  return Number.isFinite(n) && n > 0 && n <= 5000 ? n : null;
}

/**
 * One macro cell. An unrecorded macro is an em-dash — no data, no number.
 *
 * It carries no wrapper of its own: the `GridCell` around it owns the column
 * width, the padding and the rules between cells (src/components/ui/block.tsx),
 * so this is only the contents of a cell.
 */
function MacroCell({ label, grams }: { label: string; grams: number | null }) {
  return (
    <>
      <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {label}
      </Text>
      <View className="mt-1 flex-row items-baseline gap-1">
        <Text className="font-mono text-lg font-semibold text-ink">
          {grams != null ? Math.round(grams) : '—'}
        </Text>
        {grams != null ? <Text className="font-mono text-[10px] text-ink-muted">g</Text> : null}
      </View>
    </>
  );
}

/** One ruled row of an action plate. */
function ActionRow({
  icon,
  label,
  detail,
  first,
  disabled,
  trailing,
  accessibilityLabel,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  detail?: string;
  first: boolean;
  disabled?: boolean;
  trailing?: keyof typeof Ionicons.glyphMap;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <View>
      <Divider first={first} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: disabled === true }}
        disabled={disabled}
        onPress={onPress}
        className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
        <Ionicons name={icon} size={17} color={palette.inkSecondary} />
        <View className="flex-1">
          <Text className="font-serif text-[15px] text-ink">{label}</Text>
          {detail ? (
            <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-muted">{detail}</Text>
          ) : null}
        </View>
        <Ionicons name={trailing ?? 'chevron-forward'} size={16} color={palette.inkMuted} />
      </Pressable>
    </View>
  );
}

export default function MealDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const mealId = id ?? '';

  // Display-only: it decides whether a millilitre portion READS as ml or oz.
  const { units } = useUnitPreferences();
  const [state, setState] = useState<MealState>(() => readMeal(mealId));
  // Two-tap delete: first tap arms, second deletes. No native alert drama.
  const [deleteArmed, setDeleteArmed] = useState(false);
  // Transient confirmation after saving a template.
  const [savedTemplate, setSavedTemplate] = useState(false);
  // Transient confirmation after saving into the recipe book.
  const [savedRecipe, setSavedRecipe] = useState(false);
  // The item whose portion is being edited inline, prefilled from its snapshot.
  const [editing, setEditing] = useState<ItemEdit | null>(null);
  // Which composites are open. Collapsed by default: the table stays a table,
  // and a pizza reads as one thing you ate until you ask about its parts.
  const [openParts, setOpenParts] = useState<Set<string>>(() => new Set());
  // The when-editor's draft, or null when it is closed.
  const [timeEdit, setTimeEdit] = useState<TimeEdit | null>(null);
  // The rename editor's draft, or null when it is closed.
  const [nameEdit, setNameEdit] = useState<NameEdit>(null);
  // The count-of-pieces editor's draft for one composite, or null (0059).
  const [countEdit, setCountEdit] = useState<CountEdit | null>(null);

  // Re-read the meal and reset every draft — everything a reload does except
  // closing the item Undo. The Undo's own two moments (an item just removed,
  // an Undo just tried) re-read through this, so the offer they just made, or
  // the refusal they just drew, survives the re-read.
  const reread = useCallback(() => {
    setState(readMeal(mealId));
    // Regaining focus disarms a pending delete — a confirm must be two taps in
    // a row, not one tap now and a fatal one after a detour through Add food.
    setDeleteArmed(false);
    // And clears a stale "Saved" — the meal may have changed since, so the old
    // confirmation would misrepresent the current state (and a fresh save is a
    // deliberate new template, not this one re-tapped).
    setSavedTemplate(false);
    setSavedRecipe(false);
    setEditing(null);
    // A draft that survived a detour would be editing a meal that may since
    // have moved — and its Save would silently overwrite the newer value.
    setTimeEdit(null);
    setNameEdit(null);
    setCountEdit(null);
  }, [mealId]);
  const reload = useCallback(() => {
    reread();
    // Every other write on this screen reloads, and each one is "the next
    // write" that closes an open item Undo — putting a row back beside a scale
    // or a count made since would rebuild a meal nobody logged (and the
    // repository would refuse it: `restoreMealItems`).
    closeUndo(onMeal);
  }, [reread]);
  useFocusEffect(reload);
  // An item removed here, while it can still be put back. Closed when this
  // screen is left (src/hooks/use-undo-offer.ts).
  const undo = useUndoOffer('meal', mealId);

  const { meal, items, photos } = state;
  const today = todayISODate();

  /** Open the inline portion editor for a logged item, prefilled from its
   * snapshot. Re-derives from the catalog food when present; falls back to
   * grams-only proportional editing otherwise. */
  const beginEdit = (item: MealItemWithServing) => {
    const food = item.food_id ? getFood(getDb(), item.food_id) : undefined;
    // A food-less item with no amount has no portion to re-scale — leave it be.
    if (!food && item.amount == null) return;
    const canServing = food?.serving_amount != null;
    const mode: 'serving' | 'amount' =
      canServing && item.serving_qty != null ? 'serving' : 'amount';
    const qty = item.serving_qty ?? 1;
    // One editor at a time — that is what keeps the accent budget a ceiling.
    setTimeEdit(null);
    setNameEdit(null);
    setCountEdit(null);
    // Seed the amount readout from what Save will actually persist, so the field
    // never shows one number while Save writes another. In serving mode Save
    // re-derives the amount from the food's CURRENT serving_amount, so seed from
    // that same live computation — not the stored snapshot, which drifts once
    // the catalog serving_amount changes under an already-logged item. In amount
    // mode seed the EXACT stored amount (not fmtQty's 1-dp rendering): tapping
    // Save unedited then re-scales by a factor of exactly 1, instead of nudging
    // a fractional amount and every macro by the rounding delta.
    const servingAmount = mode === 'serving' && food ? amountForQty(food, qty) : null;
    setEditing({
      itemId: item.id,
      food,
      mode,
      qty,
      amountText:
        mode === 'serving'
          ? fmtQty(servingAmount ?? item.amount ?? food?.serving_amount ?? 100)
          : String(item.amount ?? food?.serving_amount ?? 100),
      // The ITEM's unit, not the food's: a food re-declared as a drink after
      // this portion was logged does not restate what was eaten.
      unit: item.unit,
    });
  };

  const stepQty = (delta: number) => {
    setEditing((prev) => {
      if (!prev || !prev.food) return prev;
      const qty = Math.min(50, Math.max(0.5, prev.qty + delta));
      const amount = amountForQty(prev.food, qty);
      return {
        ...prev,
        mode: 'serving',
        qty,
        amountText: amount != null ? fmtQty(amount) : prev.amountText,
      };
    });
  };

  const saveEdit = () => {
    if (!editing) return;
    const item = items.find((i) => i.id === editing.itemId);
    if (!item) return setEditing(null);
    let update: ReturnType<typeof rescaleLoggedItem>;
    if (editing.mode === 'serving' && editing.food) {
      if (editing.qty <= 0) return;
      update = rescaleLoggedItem(item, editing.food, { servingQty: editing.qty });
      // The serving-derived amount (qty × serving_amount) bypasses the amount
      // field's ceiling: qty is clamped to 50 but serving_amount is unbounded,
      // so a 500 g serving stepped to 50 would write 25 000 g. Enforce the same
      // finite/positive/≤5000 guard parseAmount applies below, so one ceiling
      // governs both entry modes.
      if (update && !(update.amount != null && update.amount > 0 && update.amount <= 5000)) return;
    } else {
      const amount = parseAmount(editing.amountText);
      if (amount === null) return;
      update = rescaleLoggedItem(item, editing.food, { amount });
    }
    if (!update) return setEditing(null);
    updateMealItemPortion(getDb(), editing.itemId, update);
    setEditing(null);
    reload();
  };

  if (!meal) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Meal" />
        </View>
        <Text className="mt-6 font-serif text-[14px] leading-6 text-ink-secondary">
          This meal is gone — it may have been deleted.
        </Text>
      </Screen>
    );
  }

  const removeItem = (itemId: string) => {
    // Removing a composite takes its parts (the 0058 cascade); removing the
    // LAST part takes the composite (invariant 4). Both live in the repository;
    // `removeItemWithUndo` removes through it and offers the Undo — replacing,
    // and so closing, any older one — then this screen re-reads WITHOUT the
    // close `reload` makes, which would shut the offer just made.
    removeItemWithUndo(getDb(), itemId);
    reread();
  };

  /** Put back the last removal; the repository did the work, so re-read. A
   *  refused Undo stays on the row, saying so, until the next write. */
  const undoRemoval = () => {
    runUndo();
    reread();
  };

  /** The one-level tree the plate draws (0058). */
  const nodes = assembleMealItems(items);

  const toggleParts = (id: string) => {
    setOpenParts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** "I ate half": every part of one composite, scaled proportionally from what
   *  it reads now — and its count of pieces with them (0059). The arithmetic
   *  and the transaction are the repository's. */
  const scaleParts = (parentId: string, factor: number) => {
    scaleCompositeItem(getDb(), parentId, factor);
    setEditing(null);
    // A chip moves the count, so a draft of the old one would Save a stale
    // number over it.
    setCountEdit(null);
    reload();
  };

  /** Open the count editor on one composite — or, when it is already open,
   *  open its noun field too. */
  const openCountEdit = (item: MealItemWithServing, naming: boolean) => {
    // One editor at a time (see the accent-budget note in the header).
    setEditing(null);
    setTimeEdit(null);
    setNameEdit(null);
    setCountEdit((prev) =>
      prev?.parentId === item.id
        ? { ...prev, naming: prev.naming || naming }
        : {
            parentId: item.id,
            eatenText: null,
            wholeText: null,
            nounText: item.piece_name ?? '',
            naming,
          }
    );
  };

  /**
   * Write the count, through the repository's own two writers and nothing else
   * (0059). `planLoggedCount` decides, and the sentence above Save read it first:
   *
   * - **clear** — a counted record's ATE saved empty: the count goes, the parts
   *   stand. Forgetting how many pieces a dish was is not eating any of it.
   * - **declare** — an uncounted record's OF: the parts, as logged, are now said
   *   to be N pieces, and not one gram moves.
   * - **eaten** — "I ate N of them": every part scales by N / the count the
   *   record holds (just declared, or already there), so the two keep
   *   describing one food.
   */
  const saveCount = () => {
    if (!countEdit) return;
    const item = items.find((i) => i.id === countEdit.parentId);
    if (!item) return setCountEdit(null);
    const plan = planLoggedCount(countEdit, item);
    if (plan.kind === 'invalid') return;
    // Opened and closed again, or nothing typed that changes the record.
    if (plan.kind === 'none') return setCountEdit(null);
    const db = getDb();
    if (plan.kind === 'clear') {
      clearCompositeCount(db, item.id);
    } else {
      if (plan.declare != null) setCompositeCount(db, item.id, plan.declare, plan.noun);
      if (plan.eaten != null) setCompositeCount(db, item.id, plan.eaten, plan.noun);
    }
    setCountEdit(null);
    reload();
  };

  /** The count draft on one composite, when it is the one being edited. */
  const countDraftFor = (id: string): CountEdit | null =>
    countEdit?.parentId === id ? countEdit : null;

  /** One priced row — a plain item, or a part indented inside its composite.
   *  A function rather than a nested component, so React does not remount the
   *  inline editor on every render of this screen. */
  const renderItemRow = (item: MealItemWithServing, first: boolean) => {
    const portion = portionLabel(item, units.volume);
    const line = macroLine(item);
    const subLine = [portion, line].filter(Boolean).join(' · ');
    // The one notable micro (2026-09-23) — caffeine on a latte.
    const micro = keyMicroLabel(item);
    // Editable when there's something to re-scale from: a catalog food
    // (re-derive) or an existing amount (proportional).
    const canEdit = item.food_id != null || item.amount != null;
    const isEditing = editing?.itemId === item.id;
    return (
      <View key={item.id}>
        <Divider first={first} />
        <View className="flex-row items-center gap-3">
          {/* The 44pt floor and the row's padding both sit on the control, not
              on this wrapper — the wrapper is items-center, so a floor set here
              would not reach the Pressable, and padding set here would be dead
              space outside the tap area. Same shape as the rows in data.tsx and
              screenings.tsx. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={canEdit ? `Edit ${item.name} portion` : item.name}
            disabled={!canEdit}
            onPress={() => (isEditing ? setEditing(null) : beginEdit(item))}
            className="min-h-[44px] flex-1 flex-row items-center gap-3 py-3 active:opacity-60">
            <View className="flex-1">
              <Text className="font-serif text-[15px] leading-5 text-ink">
                {item.name}
                {item.confidence !== null ? (
                  <Text className="font-mono text-[10px] text-ink-muted">
                    {'  '}≈ {item.confidence}
                  </Text>
                ) : null}
              </Text>
              <Text className="mt-0.5 font-mono text-[10px] leading-4 text-ink-muted">
                {subLine !== '' ? subLine : micro === null ? '—' : ''}
                <KeyMicroTail label={micro} lead={subLine !== ''} />
              </Text>
            </View>
            <Text className="font-mono text-[13px] text-ink-secondary">
              {item.kcal != null ? fmtInt(item.kcal) : '—'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${item.name}`}
            hitSlop={12}
            onPress={() => removeItem(item.id)}
            className="h-8 w-8 items-center justify-center rounded-btn active:opacity-60">
            <Ionicons name="close" size={16} color={palette.inkMuted} />
          </Pressable>
        </View>
        {isEditing && editing ? (
          <PortionEditRow
            edit={editing}
            item={item}
            onStep={stepQty}
            onEditAmount={(t) =>
              setEditing((prev) => (prev ? { ...prev, mode: 'amount', amountText: t } : prev))
            }
            onSave={saveEdit}
          />
        ) : null}
      </View>
    );
  };

  const logAgain = () => {
    const now = new Date();
    relogMeal(getDb(), meal.id, todayISODate(), clockFromISO(now.toISOString()));
    router.back();
  };

  const onDelete = () => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    // NOT `deleteMeal`: the 0033 CASCADE takes the photo ROWS and leaves the
    // bytes on disk. The rows go now; the bytes go when the Undo offered on the
    // list of the meal's own day closes without being taken — a removed file
    // is the one thing an Undo could not bring back.
    deleteMealWithUndo(getDb(), meal.id);
    router.back();
  };

  /** Open the when-editor on the meal's current values, or close it. Closing
   *  discards the draft — backing out of an edit writes nothing. */
  const toggleTimeEdit = () => {
    if (timeEdit) return setTimeEdit(null);
    // One editor at a time (see the accent-budget note in the header).
    setEditing(null);
    setNameEdit(null);
    setCountEdit(null);
    const parts = partsFromClock(meal.time);
    setTimeEdit({ date: meal.date, hour: parts.hour, minute: parts.minute });
  };

  /** Open the rename editor prefilled with the name the meal has, or close it.
   *  Closing discards the draft, the way backing out of every other editor on
   *  this screen does. */
  const toggleNameEdit = () => {
    if (nameEdit !== null) return setNameEdit(null);
    // One editor at a time (see the accent-budget note in the header).
    setEditing(null);
    setTimeEdit(null);
    setCountEdit(null);
    setNameEdit(meal.name);
  };

  /** Write the renamed meal. A blank name never gets here — Save is disabled on
   *  it — and `updateMealName` throws if a future caller lets one through. */
  const saveName = () => {
    if (nameEdit === null) return;
    const trimmed = nameEdit.trim();
    if (trimmed === '') return;
    updateMealName(getDb(), meal.id, trimmed);
    setNameEdit(null);
    reload();
  };

  /** Write the re-timed meal. The day boundary needs no special handling —
   *  every nutrition read groups `meals` by `date` at read time, so both days'
   *  totals follow from this single UPDATE (see `updateMealTime`). */
  const saveTime = () => {
    if (!timeEdit) return;
    const parsed = parseClockParts(timeEdit.hour, timeEdit.minute);
    if (parsed.kind === 'invalid') return;
    updateMealTime(getDb(), meal.id, {
      date: timeEdit.date,
      time: parsed.kind === 'time' ? parsed.value : null,
    });
    setTimeEdit(null);
    reload();
  };

  // Save this meal into the recipe book (one batch = this meal's amounts).
  // Alert.prompt is iOS-only — fine, ARC is iOS-only.
  const saveAsRecipe = () => {
    Alert.prompt(
      'Save as recipe',
      'Name it; servings default to 1 (this meal = one batch).',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          onPress: (name?: string) => {
            const trimmed = (name ?? '').trim() || meal.name;
            const id = saveMealAsRecipe(getDb(), meal.id, trimmed, 1);
            if (id) setSavedRecipe(true);
          },
        },
      ],
      'plain-text',
      meal.name
    );
  };

  // Save this itemized meal as a reusable template. Alert.prompt is iOS-only —
  // fine, ARC is iOS-only — and defaults to the meal's name.
  const saveAsTemplate = () => {
    Alert.prompt(
      'Save as template',
      'Name it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          onPress: (name?: string) => {
            const trimmed = (name ?? '').trim() || meal.name;
            const id = saveMealAsTemplate(getDb(), meal.id, trimmed);
            if (id) setSavedTemplate(true);
          },
        },
      ],
      'plain-text',
      meal.name
    );
  };

  const macroCells: { label: string; grams: number | null }[] = [
    { label: 'Protein', grams: meal.protein_g },
    { label: 'Carbs', grams: meal.carbs_g },
    { label: 'Fat', grams: meal.fat_g },
  ];

  // The items are the arithmetic behind the meal's own kcal column — say so,
  // but only when there are items to reconcile against.
  const itemsNote = items.length > 0 && meal.kcal != null ? `${fmtInt(meal.kcal)} kcal` : undefined;

  return (
    <Screen scroll>
      {/* The title IS the meal's name, so the control that changes it sits on
          the title — the same rule that put `Change` on the date/time line
          below rather than in the Actions plate. `StackHeader`'s `action` slot
          exists for exactly this. */}
      <View className="pt-2">
        <StackHeader
          title={meal.name}
          action={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                nameEdit !== null ? 'Stop renaming this meal' : 'Rename this meal'
              }
              accessibilityState={{ expanded: nameEdit !== null }}
              hitSlop={12}
              onPress={toggleNameEdit}
              className="min-h-[44px] justify-center pl-3 active:opacity-60">
              <Text className="font-label text-[11px] uppercase tracking-[1.2px] text-ink-secondary">
                {nameEdit !== null ? 'Cancel' : 'Rename'}
              </Text>
            </Pressable>
          }
        />
      </View>

      {nameEdit !== null ? (
        <MealNameEditor
          value={nameEdit}
          original={meal.name}
          onChange={setNameEdit}
          onSave={saveName}
        />
      ) : null}

      {/* When it was eaten, and the control that changes it — on the value
          itself rather than buried in the Actions plate below, so the editor
          opens under the line it edits. The affordance is set in the label
          voice because it is a control (00-design-spec.md §3); the date and
          time beside it stay mono because they are measurements. Same split,
          same anatomy as the Today corner in app/nutrition.tsx. */}
      <View className="mt-1 flex-row items-baseline gap-2">
        <Text className="font-mono text-[11px] text-ink-muted">
          {/* An untimed meal reads as an em-dash rather than as a bare date.
              With a control here now, "no time recorded" has to be visible —
              it is the state the control exists to change, and §5's answer for
              an absent value is a dash, not a gap. The Eaten-today row already
              draws it this way. */}
          {meal.date} · {meal.time ?? '—'}
        </Text>
        {meal.source === 'ai_suggested' ? (
          <Text className="font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
            est · AI
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            timeEdit
              ? 'Stop changing when this meal was eaten'
              : 'Change the date and time of this meal'
          }
          accessibilityState={{ expanded: timeEdit !== null }}
          hitSlop={16}
          onPress={toggleTimeEdit}
          className="ml-auto active:opacity-60">
          <Text className="font-label text-[11px] uppercase tracking-[1.2px] text-ink-secondary">
            {timeEdit ? 'Cancel' : 'Change'}
          </Text>
        </Pressable>
      </View>

      {timeEdit ? (
        <MealTimeEditor
          edit={timeEdit}
          originalDate={meal.date}
          today={today}
          onChange={setTimeEdit}
          onSave={saveTime}
        />
      ) : null}

      {/* The photo the estimate was made from (0033). Drawn at its own aspect —
          no crop, no guessed square — and only when there is one: a meal
          without a photo draws nothing at all rather than an empty frame. */}
      {photos.map((photo, index) => (
        <MealPhoto
          key={photo.id}
          photo={photo}
          name={meal.name}
          place={photos.length > 1 ? { index, of: photos.length } : null}
        />
      ))}

      {/* Totals — the meal's own columns: item sums when itemized, the typed
          numbers when free-form. */}
      <View className="mt-5">
        <Block device="grid">
          <SectionLabel label="Totals" />

          <View className="mt-2 flex-row items-baseline gap-1.5">
            <Text className="font-mono text-3xl text-ink">
              {meal.kcal != null ? fmtInt(meal.kcal) : '—'}
            </Text>
            <Text className="font-mono text-sm text-ink-muted">kcal</Text>
          </View>

          {/* `mt-2` keeps the first cells' top rule off the kcal figure above.
              Three macros in a two-column grid leaves Fat alone on the last
              row: `count` is what tells `GridCell` there is nothing beside it,
              so no vertical rule is drawn into that empty half. */}
          <View className="mt-2 flex-row flex-wrap">
            {macroCells.map((cell, index) => (
              <GridCell key={cell.label} index={index} count={macroCells.length}>
                <MacroCell label={cell.label} grams={cell.grams} />
              </GridCell>
            ))}
          </View>
        </Block>
      </View>

      {meal.notes ? (
        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              {meal.notes}
            </Text>
          </Block>
        </View>
      ) : null}

      {/* Items — the record, with the way to extend it as its closing row. The
          plate is drawn in both states: a free-form meal's Items block still
          stands where the itemized one stands, and the Add-food row that starts
          the record belongs on the same plate as the record. (The sweep of
          2026-08-10 made it conditional; reverted at the owner's instruction.) */}
      <View className="mt-8">
        <Block device="plate">
          <SectionLabel label="Items" note={itemsNote} />

          {items.length === 0 ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              Free-form entry — totals were recorded directly. Add a food to itemize it.
            </Text>
          ) : (
            <View className="mt-1">
              {/* The one-level tree (0058): a composite is a disclosure row with
                  its parts indented INSIDE this same plate. Not a nested plate —
                  a block gets exactly one device, and indentation on a ruled
                  table is this drawing set's answer to subordination. */}
              {nodes.map((node, index) =>
                node.kind === 'composite' ? (
                  <View key={node.item.id}>
                    <Divider first={index === 0} />
                    <View className="flex-row items-center gap-3">
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${node.item.name}, ${node.components.length} parts${
                          node.rolled.kcal != null ? `, ${fmtInt(node.rolled.kcal)} kcal` : ''
                        }`}
                        accessibilityState={{ expanded: openParts.has(node.item.id) }}
                        onPress={() => toggleParts(node.item.id)}
                        className="min-h-[44px] flex-1 flex-row items-center gap-2 py-3 active:opacity-60">
                        <Ionicons
                          name={openParts.has(node.item.id) ? 'chevron-down' : 'chevron-forward'}
                          size={16}
                          color={palette.inkSecondary}
                        />
                        <View className="flex-1">
                          <Text className="font-serif text-[15px] leading-5 text-ink">
                            {node.item.name}
                            <Text className="font-mono text-[10px] text-ink-muted">
                              {'  '}
                              {node.components.length} parts
                            </Text>
                          </Text>
                          {/* The headline IS the parts' sum, derived every
                              render — it cannot come to disagree with them. */}
                          <Text className="mt-0.5 font-mono text-[10px] leading-4 text-ink-muted">
                            {[
                              portionLabel(
                                {
                                  // The guard sits INSIDE the argument now: a
                                  // counted composite whose parts are in mixed
                                  // units has no honest amount, and the count is
                                  // then the only whole-dish figure the row has
                                  // — portionLabel already prints the bare
                                  // `3 slices` for exactly that case.
                                  amount: node.rolled.amount,
                                  unit: node.rolled.unit,
                                  // A composite has no catalog SERVING of its
                                  // own — its parts do, and they keep theirs —
                                  // but it may have a count of its own PIECES
                                  // (0059), which is its own column.
                                  serving_qty: node.item.serving_qty,
                                  food_serving_name: null,
                                  piece_name: node.item.piece_name,
                                },
                                units.volume
                              ),
                              macroLine(node.rolled),
                            ]
                              .filter(Boolean)
                              .join(' · ') || '—'}
                            {/* The dish's notable micro is its parts' sum. */}
                            <KeyMicroTail
                              label={keyMicroLabel(partsAsItem(node.components))}
                              lead
                            />
                          </Text>
                        </View>
                        <Text className="font-mono text-[13px] text-ink-secondary">
                          {node.rolled.kcal != null ? fmtInt(node.rolled.kcal) : '—'}
                        </Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${node.item.name}`}
                        hitSlop={12}
                        onPress={() => removeItem(node.item.id)}
                        className="h-8 w-8 items-center justify-center rounded-btn active:opacity-60">
                        <Ionicons name="close" size={16} color={palette.inkMuted} />
                      </Pressable>
                    </View>
                    {openParts.has(node.item.id) ? (
                      <View>
                        {node.components.map((part) => (
                          <View key={part.id} className="pl-6">
                            {renderItemRow(part, false)}
                          </View>
                        ))}
                        {/* How much of it was eaten, as one sentence — FIRST,
                            and in the same place whether or not the dish is
                            counted, so nothing above the field being typed into
                            ever moves (0059, re-cut 2026-09-23). */}
                        <LoggedCountRow
                          node={node}
                          edit={countDraftFor(node.item.id)}
                          onOpen={(naming) => openCountEdit(node.item, naming)}
                          onEdit={setCountEdit}
                        />
                        {/* "I ate half", for a dish with no count — the fast
                            handle the owner chose (C4). Every part scales from
                            what it reads NOW, so a part corrected by hand first
                            is halved from the corrected number, and a chip
                            writes at once, as it always has. Drawn UNDER the
                            dash it stands in for, and gone once the dish is
                            counted or a count is being typed: a count says any
                            share exactly, where a chip could only print
                            `2.7 slices`. */}
                        {node.item.serving_qty == null &&
                        parseCount(countDraftFor(node.item.id)?.wholeText ?? '') == null ? (
                          <View className="flex-row items-center gap-2 pb-3 pl-16">
                            {PART_FRACTIONS.map((fraction) => (
                              <Pressable
                                key={fraction.label}
                                accessibilityRole="button"
                                accessibilityLabel={`I ate ${fraction.spoken} of the ${node.item.name}`}
                                onPress={() => scaleParts(node.item.id, fraction.factor)}
                                className="min-h-[44px] min-w-[44px] items-center justify-center rounded-btn border border-hairline px-3 active:bg-paper-dim">
                                <Text className="font-label text-[13px] uppercase tracking-[1.2px] text-ink">
                                  {fraction.label}
                                </Text>
                              </Pressable>
                            ))}
                          </View>
                        ) : null}
                        {countEdit?.parentId === node.item.id ? (
                          <CountSaveRow node={node} edit={countEdit} onSave={saveCount} />
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                ) : (
                  renderItemRow(node.item, index === 0)
                )
              )}
            </View>
          )}

          {/* The receipt for the item just removed — a ruled row of this same
              plate, where the item was, above the way to add one. */}
          {undo ? <UndoRow offer={undo} onUndo={undoRemoval} /> : null}

          <View className="mt-1">
            <ActionRow
              icon="add"
              label="Add food"
              first={false}
              accessibilityLabel="Add food to this meal"
              onPress={() => router.push({ pathname: '/food-search', params: { mealId: meal.id } })}
            />
          </View>
        </Block>
      </View>

      {/* Actions */}
      <View className="mt-8">
        <Block device="plate">
          {/* Correct it in words (owner, 2026-08-12). First row because it is
              the thing you come back to a logged meal to do — the other two
              actions are about reusing it, which is a later act. The screen it
              opens is a pending write: nothing changes until it is confirmed
              there (app/meal-revise.tsx). */}
          <ActionRow
            icon="sparkles-outline"
            label="Adjust with AI"
            detail="“Actually, that was cooked in olive oil not butter”"
            first
            accessibilityLabel="Adjust this meal by describing what was different"
            onPress={() => router.push({ pathname: '/meal-revise', params: { id: meal.id } })}
          />

          <ActionRow
            icon="repeat-outline"
            label="Log again"
            detail="Duplicates this meal onto today, timed now"
            first={false}
            accessibilityLabel="Log this meal again now"
            onPress={logAgain}
          />

          {/* Save as template — only meaningful for an itemized meal (a template
              needs items to re-stamp). */}
          {items.length > 0 ? (
            <ActionRow
              icon="albums-outline"
              label="Save as template"
              detail={
                savedTemplate ? 'Saved — find it under “From a template”' : 'Reuse this meal later'
              }
              first={false}
              // Inert once saved: a second tap would silently create a duplicate,
              // and the checkmark reads as "done". Re-enabled on the next visit
              // (reload clears savedTemplate), where a save is a deliberate new one.
              disabled={savedTemplate}
              trailing={savedTemplate ? 'checkmark' : 'chevron-forward'}
              accessibilityLabel="Save this meal as a template"
              onPress={saveAsTemplate}
            />
          ) : null}
        </Block>

        {/* Save as recipe — the MacroFactor assemble-from-timeline pattern
            (docs/recipes-grocery.md §2a): items with usable snapshots arrive
            already food-resolved. Only meaningful for an itemized meal. */}
        {items.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save this meal as a recipe"
            accessibilityState={{ disabled: savedRecipe }}
            disabled={savedRecipe}
            onPress={saveAsRecipe}
            className={`mt-2 flex-row items-center gap-3 rounded-card border border-hairline bg-porcelain px-4 py-3 ${
              savedRecipe ? '' : 'active:bg-paper-deep'
            }`}>
            <Ionicons name="book-outline" size={18} color={palette.inkSecondary} />
            <View className="flex-1">
              <Text className="text-[15px] text-ink">Save as recipe</Text>
              <Text className="mt-0.5 text-xs text-ink-muted">
                {savedRecipe
                  ? 'Saved — find it in the recipe book'
                  : 'Into the book, with these foods as its ingredients'}
              </Text>
            </View>
            {savedRecipe ? (
              <Ionicons name="checkmark" size={18} color={palette.inkSecondary} />
            ) : null}
          </Pressable>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={deleteArmed ? 'Tap again to delete this meal' : 'Delete this meal'}
          onPress={onDelete}
          className="mt-6 min-h-[44px] items-center justify-center active:opacity-60">
          <Text
            className={
              deleteArmed
                ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink'
                : 'font-label text-[12px] uppercase tracking-[1.2px] text-ink-muted'
            }>
            {deleteArmed ? 'Tap again to delete' : 'Delete this meal'}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

/**
 * The photo the meal was estimated from (0033).
 *
 * **Drawn at the photo's own aspect.** The stored JPEG is 1024px wide with its
 * height whatever the plate was, so a fixed square would crop food out of the
 * frame — and a photo you have to remember the rest of is not evidence. The
 * 4:3 fallback is only reached when the source could not report its dimensions
 * (the picker's own base64, when the manipulator is absent); it is a frame, not
 * an invented measurement of this image.
 *
 * **No device.** A photograph is content, and none of the six drafting
 * containers says anything true about one — a plate would claim it is a record,
 * a field would claim it is a verdict. It gets a hairline so it does not bleed
 * into the sheet, drawn as a WHOLE border, which is the form React Native
 * renders correctly (src/components/ui/block.tsx, above `Divider`).
 *
 * The caption states the retention out loud. An image that silently disappears
 * in a week is a surprise; one that says when it goes is a policy the user can
 * plan around — and it is a measured value, so it is mono.
 *
 * **A combined meal draws each photo it holds** (2026-09-23), newest first, one
 * under the other: each is the evidence for its own part of the meal, and the
 * combine's consequence line promised they move into it. `place` numbers them
 * for VoiceOver only; each keeps its own retention caption, because each keeps
 * its own clock.
 */
function MealPhoto({
  photo,
  name,
  place,
}: {
  photo: MealPhotoView;
  name: string;
  /** Its position when the meal holds several; null when it is the only one. */
  place: { index: number; of: number } | null;
}) {
  const ratio = photo.width != null && photo.height != null ? photo.width / photo.height : 4 / 3;
  const clears =
    photo.clearsInDays <= 0
      ? 'Clears on the next app open'
      : photo.clearsInDays === 1
        ? 'Clears tomorrow'
        : `Clears in ${photo.clearsInDays} days`;
  return (
    <View className="mt-5">
      <View className="w-full overflow-hidden border border-hairline bg-paper-dim">
        <Image
          source={{ uri: photo.uri }}
          resizeMode="cover"
          // VoiceOver gets what the picture IS, not "image". The meal's own name
          // is the only thing on this screen that describes it.
          accessibilityLabel={
            place ? `Photo ${place.index + 1} of ${place.of}, ${name}` : `Photo of ${name}`
          }
          style={{ width: '100%', aspectRatio: ratio }}
        />
      </View>
      <Text className="mt-1.5 font-mono text-[10px] text-ink-muted">{clears}</Text>
    </View>
  );
}

/**
 * The rename editor: one field, holding the one column a rename writes.
 *
 * **Serif, not mono.** A meal's name is speech, not a measurement — the same
 * voice the Items rows and the Eaten-today list already set it in
 * (00-design-spec.md §3). The date/time editor above is mono for the opposite
 * reason.
 *
 * **No device.** A form is controls, not content — form (b) of the
 * capture-surface rule (src/components/ui/block.tsx): the field wears the
 * well's own `border-paper-deep bg-paper-dim` directly, named by a
 * `SectionLabel` and set apart by whitespace. Identical to
 * {@link MealTimeEditor} one section down, because it is the same form.
 *
 * **An empty field is a refusal, and it says so.** `meals.name` is `NOT NULL`
 * and nothing in this schema derives a title, so there is no state for a
 * cleared name to fall back to — the meal simply keeps the one it has, and the
 * note says which one rather than leaving the disabled Save to be interpreted.
 * The placeholder is the current name for the same reason: an emptied field
 * still shows what standing pat means.
 *
 * The consequence is stated in future tense above the control that performs it
 * (§5), and it names what a rename does NOT touch — because everything else on
 * this screen is what the user is really protecting when they hesitate over it.
 *
 * Save is this screen's one accent while it is open; the portion and when
 * editors both close when this one opens, so there is never a second.
 */
function MealNameEditor({
  value,
  original,
  onChange,
  onSave,
}: {
  value: string;
  /** The name the meal has now, so the change can be stated in future tense
   *  and the no-op can be named. */
  original: string;
  onChange: (next: string) => void;
  onSave: () => void;
}) {
  const trimmed = value.trim();
  const empty = trimmed === '';

  const note = empty
    ? `A meal keeps its name — there is nothing to fall back to. Leave this empty and it stays “${original}”.`
    : trimmed === original
      ? null
      : `On save: this meal is called “${trimmed}”. Its items, macros, photo, time and where it came from are untouched.`;

  return (
    <View className="mt-5">
      <SectionLabel label="Meal name" />

      <TextInput
        value={value}
        onChangeText={onChange}
        autoFocus
        placeholder={original}
        placeholderTextColor={palette.inkMuted}
        autoCapitalize="sentences"
        accessibilityLabel="Meal name"
        returnKeyType="done"
        onSubmitEditing={onSave}
        className="mt-2 border border-paper-deep bg-paper-dim px-3 py-2.5 font-serif text-[15px] text-ink"
      />

      {note ? (
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">{note}</Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save the meal’s name"
        accessibilityState={{ disabled: empty }}
        disabled={empty}
        onPress={onSave}
        className={
          empty
            ? 'mt-4 min-h-[44px] items-center justify-center rounded-btn border border-paper-deep'
            : 'mt-4 min-h-[44px] items-center justify-center rounded-btn bg-pine active:opacity-70'
        }>
        <Text
          className={
            empty
              ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
              : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-pine-on'
          }>
          Save
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * The when-editor: which day the meal belongs to, and the clock time on it.
 *
 * **No picker, and none wanted.** There is no date/time picker dependency in
 * this project, and adding one is a native module — which costs the owner a
 * full EAS cloud rebuild before the control could be tapped once
 * (01-rn-port-guide.md §5). app/metric-entry.tsx is the house answer to exactly
 * this: typed digits in the mono voice, no wheel. The day is a STEPPER rather
 * than a third and fourth text field because the case that motivated the
 * feature is "this belongs to yesterday" — one tap — and because a stepper
 * cannot produce 2026-02-31.
 *
 * **Forward is clamped at today.** A meal eaten tomorrow is not a fact anyone
 * has, and a control that can write one is a control that will. Backwards is
 * unbounded: re-dating an old meal is rarer, and a repeated tap is the honest
 * cost of it.
 *
 * **No device.** A form is controls, not content — form (b) of the
 * capture-surface rule in src/components/ui/block.tsx: each field wears the
 * well's own `border-paper-deep bg-paper-dim` directly, and the group is named
 * by a `SectionLabel` and set apart by whitespace. An input is never
 * `bg-paper-hi`.
 *
 * Save is this screen's one accent while it is open — the portion editor closes
 * when this one opens, so there is never a second.
 */
function MealTimeEditor({
  edit,
  originalDate,
  today,
  onChange,
  onSave,
}: {
  edit: TimeEdit;
  /** Where the meal is now, so the move can be stated in future tense. */
  originalDate: string;
  today: string;
  onChange: (next: TimeEdit) => void;
  onSave: () => void;
}) {
  const parsed = parseClockParts(edit.hour, edit.minute);
  const invalid = parsed.kind === 'invalid';
  const canGoForward = edit.date < today;
  const hasTyped = edit.hour !== '' || edit.minute !== '';

  // The consequence, in future tense, immediately above the control that
  // performs it (00-design-spec.md §5). Both notes can apply at once — a meal
  // moved to yesterday AND stripped of its time — so they are lines, not a
  // single message that would have to drop one of the two truths.
  const notes: string[] = [];
  if (invalid) {
    notes.push('That isn’t a time — hours run 0–23, minutes 0–59.');
  } else {
    if (edit.date !== originalDate) {
      notes.push(
        `On save: this meal moves off ${originalDate} onto ${edit.date}. Both days’ totals change.`
      );
    }
    if (parsed.kind === 'none') {
      notes.push('On save: this meal loses its time and sorts last in the day.');
    }
  }

  return (
    <View className="mt-5">
      <SectionLabel label="When it was eaten" />

      {/* Day. The readout is the measured value and takes mono; the steppers
          carry their border alone, the way every stepper in this file does. */}
      <View className="mt-2 flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous day"
          hitSlop={6}
          onPress={() => onChange({ ...edit, date: shiftDay(edit.date, -1) })}
          className="h-11 w-11 items-center justify-center rounded-btn border border-hairline active:opacity-60">
          <Ionicons name="chevron-back" size={16} color={palette.ink} />
        </Pressable>
        <View className="flex-1">
          <Text className="text-center font-mono text-[15px] text-ink">
            {mealDayLabel(edit.date, today)}
          </Text>
          <Text className="mt-0.5 text-center font-mono text-[10px] text-ink-muted">
            {edit.date}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next day"
          accessibilityState={{ disabled: !canGoForward }}
          disabled={!canGoForward}
          hitSlop={6}
          onPress={() => onChange({ ...edit, date: shiftDay(edit.date, 1) })}
          className={
            canGoForward
              ? 'h-11 w-11 items-center justify-center rounded-btn border border-hairline active:opacity-60'
              : 'h-11 w-11 items-center justify-center rounded-btn border border-paper-deep'
          }>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={canGoForward ? palette.ink : palette.inkMuted}
          />
        </Pressable>
      </View>

      {/* Time. Two fields and a colon — the shape a clock already has. */}
      <View className="mt-3 flex-row items-center gap-2">
        <TextInput
          value={edit.hour}
          onChangeText={(t) => onChange({ ...edit, hour: t })}
          keyboardType="number-pad"
          returnKeyType={KEYPAD_DONE}
          maxLength={2}
          placeholder="––"
          placeholderTextColor={palette.inkMuted}
          accessibilityLabel="Hour"
          className="w-14 border border-paper-deep bg-paper-dim px-2 py-2.5 text-center font-mono text-[15px] text-ink"
        />
        <Text className="font-mono text-[15px] text-ink-secondary">:</Text>
        <TextInput
          value={edit.minute}
          onChangeText={(t) => onChange({ ...edit, minute: t })}
          keyboardType="number-pad"
          returnKeyType={KEYPAD_DONE}
          maxLength={2}
          placeholder="––"
          placeholderTextColor={palette.inkMuted}
          accessibilityLabel="Minute"
          className="w-14 border border-paper-deep bg-paper-dim px-2 py-2.5 text-center font-mono text-[15px] text-ink"
        />
        {/* Only offered when there is something to clear — a control that does
            nothing is worse than no control (§5). An untimed meal is a
            supported state, not a broken one. */}
        {hasTyped ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Record no time for this meal"
            hitSlop={12}
            onPress={() => onChange({ ...edit, hour: '', minute: '' })}
            className="ml-auto min-h-[44px] justify-center active:opacity-60">
            <Text className="font-label text-[11px] uppercase tracking-[1.2px] text-ink-muted">
              No time
            </Text>
          </Pressable>
        ) : null}
      </View>

      {notes.map((note) => (
        <Text key={note} className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
          {note}
        </Text>
      ))}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save when this meal was eaten"
        accessibilityState={{ disabled: invalid }}
        disabled={invalid}
        onPress={onSave}
        className={
          invalid
            ? 'mt-4 min-h-[44px] items-center justify-center rounded-btn border border-paper-deep'
            : 'mt-4 min-h-[44px] items-center justify-center rounded-btn bg-pine active:opacity-70'
        }>
        <Text
          className={
            invalid
              ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
              : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-pine-on'
          }>
          Save
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * A LOGGED composite's count (0059, re-cut on the owner's device note of
 * 2026-09-23) — the review sheet's sentence, less the half a record cannot hold.
 *
 * The review counts a dish AS PRICED, so it reads `ate [3] of [8] slices`. A
 * record's parts are what was eaten, and the "of 8" was history of the estimate
 * that 0059 deliberately never stored — so a COUNTED record reads `ate [3]
 * slices`, and a new number scales every part by new / current. An UNCOUNTED
 * record's parts are the whole dish as logged, so it reads the review's own
 * sentence: OF declares what they are, and ATE — an em-dash until there is an
 * OF — then takes a share. The rules are `planLoggedCount`'s
 * (src/lib/nutrition/review-rows.ts); this only draws them.
 *
 * Everything here stages a draft and writes on Save — this screen's rule for
 * anything already in the day's totals — and touching a field or the noun opens
 * the editor, which closes the others. Nothing moves under the thumb: ATE's slot
 * holds its place as a dash until it becomes a field, and OF is keyed so React
 * keeps it mounted while the dish turns countable beside it.
 */
function LoggedCountRow({
  node,
  edit,
  onOpen,
  onEdit,
}: {
  node: Extract<MealItemNode, { kind: 'composite' }>;
  edit: CountEdit | null;
  /** Open the editor; `naming` opens the noun's own field too. */
  onOpen: (naming: boolean) => void;
  /** The screen's own state setter, so every write is a functional update. */
  onEdit: Dispatch<SetStateAction<CountEdit | null>>;
}) {
  const stored = node.item.serving_qty;
  const draft: CountEdit = edit ?? {
    parentId: node.item.id,
    eatenText: null,
    wholeText: null,
    nounText: node.item.piece_name ?? '',
    naming: false,
  };
  const noun = draft.nounText.trim() || node.item.piece_name || 'piece';
  const open = () => {
    if (!edit) onOpen(false);
  };
  // Functional, and addressed to THIS dish's draft: a keystroke lands on the
  // draft as it now is, and a blur that arrives after Save (or after another
  // editor took over) finds no draft of this dish and changes nothing — it never
  // writes back a copy captured a render ago.
  // A keystroke into a field whose draft another editor closed (the field kept
  // focus: a "handled" tap does not blur it) re-opens the count editor the one
  // way that closes the others, so two editors are never open at once.
  const patch = (next: Partial<CountEdit>) => {
    if (!edit) onOpen(false);
    onEdit((prev) => ({ ...(prev?.parentId === draft.parentId ? prev : draft), ...next }));
  };
  // An uncounted record's whole, once the draft holds one — ATE opens with it.
  const whole = stored == null ? parseCount(draft.wholeText ?? '') : null;
  const counting = stored != null || whole != null;
  const eaten =
    draft.eatenText ?? (stored != null ? fmtQty(stored) : whole != null ? fmtQty(whole) : '');
  // The noun agrees with the number it follows: OF when there is one, else ATE.
  const agreesWith = stored != null ? (parseCount(eaten) ?? stored) : whole;
  return (
    <View className="flex-row flex-wrap items-center gap-2 pb-3 pl-6">
      <Text
        key="ate"
        className="w-8 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        Ate
      </Text>
      {counting ? (
        <TextInput
          key="eaten"
          value={eaten}
          onChangeText={(text) => patch({ eatenText: text })}
          keyboardType="decimal-pad"
          returnKeyType={KEYPAD_DONE}
          // Opening the editor goes THROUGH selectAllOnFocus, which owns
          // `onFocus`: writing both would silently drop one of them.
          {...selectAllOnFocus(eaten, open)}
          accessibilityLabel={`${node.item.name}, pieces eaten`}
          className="w-14 border border-paper-deep bg-paper-dim px-2 py-1.5 text-right font-mono text-[13px] text-ink"
        />
      ) : (
        <View
          key="eaten-none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="w-14 items-end px-2">
          <Text className="font-mono text-[13px] text-ink-muted">—</Text>
        </View>
      )}
      {stored == null ? (
        <Text key="of" className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
          of
        </Text>
      ) : null}
      {stored == null ? (
        <TextInput
          key="whole"
          value={draft.wholeText ?? ''}
          onChangeText={(text) => patch({ wholeText: text })}
          keyboardType="decimal-pad"
          returnKeyType={KEYPAD_DONE}
          {...selectAllOnFocus(draft.wholeText ?? '', open)}
          accessibilityLabel={`Pieces in ${node.item.name}`}
          className="w-14 border border-paper-deep bg-paper-dim px-2 py-1.5 text-right font-mono text-[13px] text-ink"
        />
      ) : null}
      {draft.naming ? (
        <TextInput
          key="noun"
          value={draft.nounText}
          onChangeText={(text) => patch({ nounText: text })}
          autoFocus
          // A one-word name replaced wholesale, so its word arrives selected —
          // `autoFocus` is the imperative focus path, the one place iOS honours
          // this prop (src/components/ui/select-on-focus.ts).
          selectTextOnFocus
          autoCapitalize="none"
          returnKeyType={KEYPAD_DONE}
          placeholder="piece"
          placeholderTextColor={palette.inkMuted}
          accessibilityLabel={`Name one piece of ${node.item.name}`}
          onBlur={() =>
            onEdit((prev) =>
              prev?.parentId === draft.parentId ? { ...prev, naming: false } : prev
            )
          }
          className="w-24 border border-paper-deep bg-paper-dim px-2 py-1.5 font-mono text-[13px] text-ink"
        />
      ) : counting ? (
        <Pressable
          key="noun"
          accessibilityRole="button"
          accessibilityLabel={`Name one piece of ${node.item.name}`}
          onPress={() => onOpen(true)}
          className="min-h-[44px] justify-center px-1 active:opacity-60">
          <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink">
            {pieceNounFor(agreesWith, noun)}
          </Text>
        </Pressable>
      ) : (
        // A noun with no count names nothing, so it is a readout until there is one.
        <Text
          key="noun"
          className="font-label text-[12px] uppercase tracking-[1.2px] text-ink-muted">
          {pluralNoun(noun)}
        </Text>
      )}
    </View>
  );
}

/** "3/8" — or, when the two print alike (a 2.6667 retyped as 2.7), the factor
 *  itself, so the note never claims "2.7/2.7" of a scale that is not 1. */
function scaleWords(to: number, from: number): string {
  const a = fmtQty(to);
  const b = fmtQty(from);
  return a === b ? `× ${(to / from).toFixed(2)}` : `${a}/${b}`;
}

/** What Save will do to the count, in words, from the SAME plan the write runs. */
function countNote(plan: LoggedCountPlan, noun: string, current: number | null): string {
  if (plan.kind === 'invalid') return 'A count is more than 0 and at most 100.';
  if (plan.kind === 'clear') return 'On save: the count goes, and the parts stay as they are.';
  if (plan.kind === 'none') {
    return current != null ? 'Type how many were eaten.' : 'Type how many pieces this dish is.';
  }
  if (plan.declare != null) {
    return plan.eaten != null
      ? `On save: this dish is ${piecesLabel(plan.declare, noun)}, and you ate ${fmtQty(plan.eaten)} — every part scales by ${scaleWords(plan.eaten, plan.declare)}.`
      : `On save: this dish is ${piecesLabel(plan.declare, noun)}, all eaten. Nothing scales.`;
  }
  return plan.eaten != null && current != null && plan.eaten !== current
    ? `On save: ${piecesLabel(plan.eaten, noun)} — every part scales by ${scaleWords(plan.eaten, current)}.`
    : `On save: the pieces are ${pluralNoun(noun)}. Nothing scales.`;
}

/** The consequence, stated BEFORE the write the way every other pending write
 *  on this screen states it (00-design-spec.md §5), and the button that does it.
 *  With nothing typed that would change the record the button CLOSES the editor
 *  instead — outlined, never the accent — so an editor opened by a stray tap is
 *  never stuck open beside a Save that cannot be pressed. */
function CountSaveRow({
  node,
  edit,
  onSave,
}: {
  node: Extract<MealItemNode, { kind: 'composite' }>;
  edit: CountEdit;
  onSave: () => void;
}) {
  const plan = planLoggedCount(edit, node.item);
  const noun = edit.nounText.trim() || node.item.piece_name || 'piece';
  const writes = plan.kind === 'set' || plan.kind === 'clear';
  const closes = plan.kind === 'none';
  return (
    <View className="flex-row items-center justify-between gap-3 pb-3 pl-6">
      <Text className="flex-1 font-serif text-[13px] leading-5 text-ink-secondary">
        {countNote(plan, noun, node.item.serving_qty)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          closes ? `Close the count for ${node.item.name}` : `Save the count for ${node.item.name}`
        }
        accessibilityState={{ disabled: !writes && !closes }}
        disabled={!writes && !closes}
        onPress={onSave}
        className={
          writes
            ? 'min-h-[44px] justify-center rounded-btn bg-pine px-5 active:opacity-70'
            : closes
              ? 'min-h-[44px] justify-center rounded-btn border border-hairline px-5 active:bg-paper-dim'
              : 'min-h-[44px] justify-center rounded-btn border border-paper-deep px-5'
        }>
        <Text
          className={
            writes
              ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-pine-on'
              : closes
                ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink'
                : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
          }>
          {closes ? 'Close' : 'Save'}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * The inline portion editor under a tapped item. Serving stepper when the
 * catalog food names a serving; an amount field always, suffixed with the
 * item's own unit (0047). The live "≈ kcal" preview and the Save both go
 * through rescaleLoggedItem, so what you see is exactly what gets written.
 *
 * It draws **no device of its own** — it lives inside the items plate, and
 * devices never nest (src/components/ui/block.tsx). Only the amount input takes
 * the recessed treatment, because an input is a well at control scale.
 *
 * Save is this screen's one accent (only one editor is ever open at a time —
 * opening the when-editor above closes this one, and vice versa).
 */
function PortionEditRow({
  edit,
  item,
  onStep,
  onEditAmount,
  onSave,
}: {
  edit: ItemEdit;
  item: MealItemWithServing;
  onStep: (delta: number) => void;
  onEditAmount: (text: string) => void;
  onSave: () => void;
}) {
  const portion: { servingQty: number } | { amount: number } =
    edit.mode === 'serving' && edit.food
      ? { servingQty: edit.qty }
      : { amount: parseAmount(edit.amountText) ?? 0 };
  const valid = 'servingQty' in portion ? edit.qty > 0 : portion.amount > 0;
  const preview = valid ? rescaleLoggedItem(item, edit.food, portion) : null;

  return (
    <View className="pb-3">
      <View className="flex-row items-center gap-2">
        {edit.food?.serving_amount != null ? (
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
              {fmtQty(edit.qty)}
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
              × {edit.food.serving_name}
            </Text>
          </View>
        ) : null}
        <View className="ml-auto flex-row items-center gap-2">
          <TextInput
            value={edit.amountText}
            onChangeText={onEditAmount}
            keyboardType="decimal-pad"
            returnKeyType={KEYPAD_DONE}
            {...selectAllOnFocus(edit.amountText)}
            accessibilityLabel={edit.unit === 'ml' ? 'Millilitres' : 'Grams'}
            className="w-16 border border-paper-deep bg-paper-dim px-2 py-2 text-right font-mono text-[13px] text-ink"
          />
          <Text className="font-mono text-[11px] text-ink-secondary">{edit.unit}</Text>
        </View>
      </View>

      <View className="mt-3 flex-row items-center justify-between">
        <Text className="font-mono text-[10px] text-ink-muted">
          {preview?.kcal != null ? `≈ ${fmtInt(preview.kcal)} kcal` : 'no energy recorded'}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save portion"
          accessibilityState={{ disabled: !valid }}
          disabled={!valid}
          onPress={onSave}
          className={
            valid
              ? 'min-h-[44px] justify-center rounded-btn bg-pine px-5 active:opacity-70'
              : 'min-h-[44px] justify-center rounded-btn border border-paper-deep px-5'
          }>
          <Text
            className={
              valid
                ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-pine-on'
                : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
            }>
            Save
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
