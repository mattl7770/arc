import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { KEYPAD_DONE } from '@/components/ui/keyboard';
import { SectionLabel } from '@/components/ui/section-label';
import { selectAllOnFocus } from '@/components/ui/select-on-focus';
import { palette } from '@/constants/theme';
import type { Database } from '@/lib/db/database';
import { getFood } from '@/lib/db/repositories/foods';
import type { MealEstimate } from '@/lib/nutrition/estimate';
import { fmtInt } from '@/lib/nutrition/format';
import { parseMicros, scaleMicros, serializeMicros } from '@/lib/nutrition/micros';
import { itemForPortion, rescaleLoggedItem } from '@/lib/nutrition/servings';
import type {
  AmountUnit,
  EstimateConfidence,
  FoodRow,
  NewMealItem,
  NewMealItemComponent,
} from '@/lib/nutrition/types';

/**
 * The estimator's editable review table — the one copy, used by
 * `app/meal-estimate.tsx` and `app/meal-revise.tsx`.
 *
 * ## Why this is shared and not duplicated
 *
 * The two screens have always drawn the same table, and until C4 they did it
 * with two copies of the same forty lines. Composite foods (0049) turn that
 * table into a **tree** with a disclosure, proportional scaling and a
 * last-component rule — which is exactly the kind of logic that must not drift
 * between two screens that are supposed to guarantee the same thing. The
 * estimator already states the principle for the pipeline (*"one schema, one
 * parser, one review"*); this is the review half of it.
 *
 * ## The ledger rule, mechanically
 *
 * The Items label carries the total of the rows visible beneath it, recomputed
 * from each row's live amount. A **composite header carries no numbers of its
 * own** — its amount and kcal are derived from its parts every render — so the
 * headline cannot come to disagree with the parts, by construction rather than
 * by maintenance.
 *
 * ## One surface device (00-design-spec.md §1)
 *
 * The Items block stays the single `Block device="plate"` it has always been. A
 * composite is **not** a nested plate: a block gets exactly one device, and the
 * drawing set's answer to subordination inside a ruled table is INDENTATION.
 * So the parts are ruled rows inside the same plate at `pl-6`, with no fill, no
 * left rule and no new mark.
 *
 * ## "I ate half" (owner decision, C4)
 *
 * Fraction chips `½ · ⅓ · ¼` plus the whole-dish amount field. Both scale every
 * part proportionally — halving the crust and not the cheese would be a claim
 * about *which* half, which nothing knows — and both act on the parts' CURRENT
 * values, so a hand-correction made first is what gets halved. Nothing is
 * written until the screen's own Save; what the chips move is the proposal.
 *
 * The amount field is live and non-compounding because it scales from a
 * SNAPSHOT taken when the field is focused, not from whatever it last produced.
 * Typing `3`, `36`, `360` into a 720 g pizza therefore lands on ×0.5, not on
 * ×0.5 ×0.5 ×0.5.
 */

/** The portion snapshot an amount edit re-scales from. */
export type ReviewBase = {
  amount: number | null;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  micros: string | null;
};

/** One priced row: a plain item, or one part of a composite. */
export type ReviewRow = {
  key: string;
  name: string;
  foodId: string | null;
  food: FoodRow | undefined;
  confidence: EstimateConfidence;
  base: ReviewBase;
  amountText: string;
  /** What the amount counts — the model's own call (0047). Shown beside the
   *  field and written onto the item; never converted for the oz preference. */
  unit: AmountUnit;
};

/** A top-level review row. `components` is empty for a plain item and holds the
 *  parts for a composite (0049); one level only. */
export type ReviewItem = ReviewRow & {
  components: ReviewRow[];
  expanded: boolean;
  /** The parts as they stood when the whole-dish field was focused — the
   *  baseline that keeps live scaling from compounding. Null when not editing. */
  scaleFrom: ReviewRow[] | null;
};

export function isComposite(row: ReviewItem): boolean {
  return row.components.length > 0;
}

export function parseAmount(text: string): number | null {
  const n = Number(text.trim());
  return Number.isFinite(n) && n > 0 && n <= 5000 ? n : null;
}

/**
 * Current macros/micros for a row at its edited amount — via the same tested
 * rescale used everywhere; falls back to the base when it cannot scale.
 */
export function currentPortion(row: ReviewRow) {
  const amount = parseAmount(row.amountText);
  if (amount != null) {
    const scaled = rescaleLoggedItem(row.base, row.food, { amount });
    if (scaled) return scaled;
  }
  return {
    // A validly-typed portion is kept even when macros can't be re-scaled (an
    // ungrounded, amountless item): the number the user entered is recorded
    // rather than silently dropped, and — since parseAmount only yields > 0 —
    // this is always null or positive, so it can never violate the schema's
    // CHECK(amount > 0).
    amount: amount ?? row.base.amount,
    serving_qty: null,
    kcal: row.base.kcal,
    protein_g: row.base.protein_g,
    carbs_g: row.base.carbs_g,
    fat_g: row.base.fat_g,
    fiber_g: row.base.fiber_g,
    micros: row.base.micros,
  };
}

/** NULL-skipping sum — "not recorded" never becomes 0. */
function sumOrNull(values: (number | null | undefined)[]): number | null {
  let sum: number | null = null;
  for (const v of values) {
    if (v != null) sum = (sum ?? 0) + v;
  }
  return sum;
}

/**
 * What a composite reads as, derived from its parts every render.
 *
 * An amount sums only when EVERY part has one and they share a unit — nothing
 * converts (B2/0047), and a partial sum would be a fabricated total.
 */
export function rolled(row: ReviewItem) {
  const portions = row.components.map(currentPortion);
  const units = new Set(row.components.map((c) => c.unit));
  const allPriced = portions.length > 0 && portions.every((p) => p.amount != null);
  return {
    amount:
      allPriced && units.size === 1 ? portions.reduce((s, p) => s + (p.amount ?? 0), 0) : null,
    unit: units.size === 1 ? (row.components[0]?.unit ?? row.unit) : row.unit,
    kcal: sumOrNull(portions.map((p) => p.kcal)),
    protein_g: sumOrNull(portions.map((p) => p.protein_g)),
    carbs_g: sumOrNull(portions.map((p) => p.carbs_g)),
    fat_g: sumOrNull(portions.map((p) => p.fat_g)),
    fiber_g: sumOrNull(portions.map((p) => p.fiber_g)),
  };
}

/** The visible total: a plain row's own kcal, a composite's parts' sum. */
export function reviewKcal(rows: ReviewItem[]): number | null {
  return rows.reduce<number | null>((sum, row) => {
    const kcal = isComposite(row) ? rolled(row).kcal : currentPortion(row).kcal;
    return kcal == null ? sum : (sum ?? 0) + kcal;
  }, null);
}

/** An amount as a field shows it: whole where it is whole, one decimal where a
 *  fraction chip produced one. Rounding to an integer here is what would make
 *  ×½ then ×2 lose a gram. */
function amountLabel(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : String(Math.round(amount * 10) / 10);
}

/** Build one review row from an estimate item or component. */
function toRow(
  db: Database,
  item: {
    name: string;
    amount: number | null;
    unit: AmountUnit;
    kcal: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
    confidence: EstimateConfidence;
    foodId: string | null;
    micros: string | null;
  },
  key: string
): ReviewRow {
  const food = item.foodId ? getFood(db, item.foodId) : undefined;
  // A grounded item's base is derived from the food so macros AND micros are
  // consistent — including when the user clears the amount field. An ungrounded
  // item keeps the model's numbers, including the sodium/caffeine it returns
  // (A8); those scale with an amount edit like every other figure on the row.
  // groundMealEstimate only sets foodId when the food's basis MATCHES the
  // item's unit, so re-pricing here can never cross the two.
  const grounded =
    food && item.amount != null && item.amount > 0
      ? itemForPortion(food, { amount: item.amount })
      : null;
  return {
    key,
    name: item.name,
    foodId: item.foodId,
    food,
    confidence: item.confidence,
    unit: item.unit,
    base: {
      // A non-positive amount from the model would violate meal_items
      // CHECK(amount > 0) and roll back the whole save; store it as "not
      // recorded" (null) instead.
      amount: item.amount != null && item.amount > 0 ? item.amount : null,
      kcal: grounded?.kcal ?? item.kcal,
      protein_g: grounded?.protein_g ?? item.protein_g,
      carbs_g: grounded?.carbs_g ?? item.carbs_g,
      fat_g: grounded?.fat_g ?? item.fat_g,
      fiber_g: grounded?.fiber_g ?? item.fiber_g,
      micros: grounded?.micros ?? item.micros,
    },
    amountText: item.amount != null && item.amount > 0 ? amountLabel(item.amount) : '',
  };
}

/** A grounded estimate as editable review rows — the tree included. */
export function rowsFromEstimate(db: Database, estimate: MealEstimate): ReviewItem[] {
  return estimate.items.map((item, i) => ({
    ...toRow(db, { ...item, micros: item.micros ?? null }, `${i}-${item.name}`),
    components: (item.components ?? []).map((part, j) =>
      toRow(db, { ...part, micros: part.micros ?? null }, `${i}-${j}-${part.name}`)
    ),
    expanded: false,
    scaleFrom: null,
  }));
}

/** The rows as `meal_items` input — a composite becomes a header with parts. */
export function rowsToMealItems(rows: ReviewItem[]): NewMealItem[] {
  const priced = (row: ReviewRow): NewMealItemComponent => {
    const p = currentPortion(row);
    return {
      food_id: row.foodId,
      name: row.name,
      amount: p.amount,
      unit: row.unit,
      serving_qty: null,
      kcal: p.kcal,
      protein_g: p.protein_g,
      carbs_g: p.carbs_g,
      fat_g: p.fat_g,
      fiber_g: p.fiber_g,
      confidence: row.confidence,
      micros: p.micros,
    };
  };
  return rows.map((row) =>
    isComposite(row)
      ? // The header's own numbers are never sent — the repository would drop
        // them anyway (invariant 2), and sending them would suggest they mean
        // something.
        { name: row.name, unit: row.unit, components: row.components.map(priced) }
      : priced(row)
  );
}

// --- Edits ------------------------------------------------------------------

/** Set one row's amount text. `key` may name a top-level row or a part. */
export function setRowAmount(rows: ReviewItem[], key: string, text: string): ReviewItem[] {
  return rows.map((row) => {
    if (row.key === key) return { ...row, amountText: text };
    if (!row.components.some((c) => c.key === key)) return row;
    return {
      ...row,
      components: row.components.map((c) => (c.key === key ? { ...c, amountText: text } : c)),
      // A hand-correction rebases what the chips will halve (owner decision):
      // the whole-dish snapshot is stale the moment a part moves.
      scaleFrom: null,
    };
  });
}

/**
 * Remove one row. **Removing the last part removes the composite** (invariant
 * 4): a header over nothing is a name with no numbers, which is
 * indistinguishable from an unpriced item.
 */
export function removeRow(rows: ReviewItem[], key: string): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const row of rows) {
    // A top-level row, or a whole composite with its parts.
    if (row.key === key) continue;
    if (!row.components.some((c) => c.key === key)) {
      out.push(row);
      continue;
    }
    const components = row.components.filter((c) => c.key !== key);
    // Invariant 4: the header goes with its last part.
    if (components.length === 0) continue;
    out.push({ ...row, components, scaleFrom: null });
  }
  return out;
}

export function toggleExpanded(rows: ReviewItem[], key: string): ReviewItem[] {
  return rows.map((row) => (row.key === key ? { ...row, expanded: !row.expanded } : row));
}

/** One part, scaled by `factor` from its CURRENT values. */
function scaleRow(row: ReviewRow, factor: number): ReviewRow {
  const cur = currentPortion(row);
  const mul = (v: number | null | undefined): number | null => (v == null ? null : v * factor);
  const amount = cur.amount == null ? null : cur.amount * factor;
  return {
    ...row,
    base: {
      amount,
      kcal: mul(cur.kcal),
      protein_g: mul(cur.protein_g),
      carbs_g: mul(cur.carbs_g),
      fat_g: mul(cur.fat_g),
      fiber_g: mul(cur.fiber_g),
      micros: serializeMicros(scaleMicros(parseMicros(cur.micros), factor)),
    },
    amountText: amount == null ? '' : amountLabel(amount),
  };
}

/** A fraction chip: every part of one composite, scaled proportionally from
 *  what it reads NOW. */
export function scaleComposite(rows: ReviewItem[], key: string, factor: number): ReviewItem[] {
  if (!(factor > 0)) return rows;
  return rows.map((row) =>
    row.key === key && isComposite(row)
      ? {
          ...row,
          components: row.components.map((c) => scaleRow(c, factor)),
          // The whole-dish field re-derives from the parts again, and the next
          // chip starts from what is now on screen.
          amountText: '',
          scaleFrom: null,
        }
      : row
  );
}

/** Focus of the whole-dish field: freeze the parts as the scaling baseline. */
export function beginCompositeScale(rows: ReviewItem[], key: string): ReviewItem[] {
  return rows.map((row) => (row.key === key ? { ...row, scaleFrom: row.components } : row));
}

/** Blur: drop the baseline, so the next edit takes a fresh one. */
export function endCompositeScale(rows: ReviewItem[], key: string): ReviewItem[] {
  return rows.map((row) => (row.key === key ? { ...row, scaleFrom: null } : row));
}

/**
 * The whole-dish field changed: scale the parts to that total, from the
 * snapshot taken on focus. Non-compounding, so typing `3` `6` `0` into a 720 g
 * pizza lands on ×0.5 rather than on ×0.5 three times.
 */
export function scaleCompositeTo(rows: ReviewItem[], key: string, text: string): ReviewItem[] {
  return rows.map((row) => {
    if (row.key !== key || !isComposite(row)) return row;
    const from = row.scaleFrom ?? row.components;
    const target = parseAmount(text);
    const total = from.reduce<number | null>((sum, c) => {
      const amount = currentPortion(c).amount;
      return sum == null || amount == null ? null : sum + amount;
    }, 0);
    if (target == null || total == null || total <= 0) {
      // Mid-typing ("3", "", "abc") the parts must not jump. The field holds
      // what was typed; the parts follow only once it is a number.
      return { ...row, scaleFrom: from, amountText: text };
    }
    const factor = target / total;
    return {
      ...row,
      scaleFrom: from,
      amountText: text,
      components: from.map((c) => scaleRow(c, factor)),
    };
  });
}

// --- The plate ---------------------------------------------------------------

const MACRO_LINE = (p: {
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
}): string =>
  [
    p.protein_g != null ? `P ${Math.round(p.protein_g)}g` : '',
    p.carbs_g != null ? ` · C ${Math.round(p.carbs_g)}g` : '',
    p.fat_g != null ? ` · F ${Math.round(p.fat_g)}g` : '',
  ].join('');

/** The fractions a person actually says. Outlined, never accent: in the review
 *  phase the accent belongs to Save and stays there. */
const FRACTIONS: { label: string; factor: number; spoken: string }[] = [
  { label: '½', factor: 0.5, spoken: 'half' },
  { label: '⅓', factor: 1 / 3, spoken: 'a third' },
  { label: '¼', factor: 0.25, spoken: 'a quarter' },
];

function AmountField({
  row,
  onChange,
  onFocus,
  onBlur,
  value,
  label,
}: {
  row: ReviewRow;
  onChange: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  value: string;
  label: string;
}) {
  return (
    <View className="flex-row items-center gap-1">
      <TextInput
        value={value}
        onChangeText={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
        keyboardType="decimal-pad"
        returnKeyType={KEYPAD_DONE}
        {...selectAllOnFocus(value)}
        accessibilityLabel={`${label} ${row.unit === 'ml' ? 'millilitres' : 'grams'}`}
        className="w-14 border border-paper-deep bg-paper-dim px-2 py-1.5 text-right font-mono text-[13px] text-ink"
      />
      <Text className="font-mono text-[11px] text-ink-secondary">{row.unit}</Text>
    </View>
  );
}

function RemoveButton({ name, onPress }: { name: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Remove ${name}`}
      hitSlop={12}
      onPress={onPress}
      className="h-8 w-8 items-center justify-center rounded-btn active:opacity-60">
      <Ionicons name="close" size={16} color={palette.inkMuted} />
    </Pressable>
  );
}

export type ReviewHandlers = {
  onAmountChange: (key: string, text: string) => void;
  onRemove: (key: string) => void;
  onToggle: (key: string) => void;
  onScale: (key: string, factor: number) => void;
  onScaleTo: (key: string, text: string) => void;
  onScaleBegin: (key: string) => void;
  onScaleEnd: (key: string) => void;
};

/** One priced row — a plain item, or a part indented inside its composite. */
function PricedRow({
  row,
  first,
  indented,
  handlers,
}: {
  row: ReviewRow;
  first: boolean;
  indented: boolean;
  handlers: ReviewHandlers;
}) {
  const p = currentPortion(row);
  return (
    <View>
      <Divider first={first} />
      <View className={indented ? 'py-3 pl-6' : 'py-3'}>
        <View className="min-h-[44px] flex-row items-center gap-3">
          <View className="flex-1">
            <Text className="font-serif text-[15px] leading-5 text-ink">
              {row.name}
              <Text className="font-mono text-[10px] text-ink-muted">
                {'  '}≈ {row.confidence}
                {row.foodId ? ' · matched' : ''}
              </Text>
            </Text>
          </View>
          <AmountField
            row={row}
            value={row.amountText}
            label={row.name}
            onChange={(t) => handlers.onAmountChange(row.key, t)}
          />
          <Text className="w-12 text-right font-mono text-[13px] text-ink-secondary">
            {p.kcal != null ? fmtInt(p.kcal) : '—'}
          </Text>
          <RemoveButton name={row.name} onPress={() => handlers.onRemove(row.key)} />
        </View>
        <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">{MACRO_LINE(p)}</Text>
      </View>
    </View>
  );
}

/** A composite: a disclosure row, and — when open — its parts and the two ways
 *  to say "I ate half". All inside the SAME plate; a nested device is forbidden. */
function CompositeRow({
  row,
  first,
  handlers,
}: {
  row: ReviewItem;
  first: boolean;
  handlers: ReviewHandlers;
}) {
  const total = rolled(row);
  const parts = `${row.components.length} parts`;
  return (
    <View>
      <Divider first={first} />
      <View className="py-3">
        <View className="min-h-[44px] flex-row items-center gap-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${row.name}, ${parts}${
              total.kcal != null ? `, ${fmtInt(total.kcal)} kcal` : ''
            }`}
            accessibilityState={{ expanded: row.expanded }}
            hitSlop={8}
            onPress={() => handlers.onToggle(row.key)}
            className="min-h-[44px] flex-1 flex-row items-center gap-2 active:opacity-60">
            <Ionicons
              name={row.expanded ? 'chevron-down' : 'chevron-forward'}
              size={16}
              color={palette.inkSecondary}
            />
            <View className="flex-1">
              <Text className="font-serif text-[15px] leading-5 text-ink">
                {row.name}
                <Text className="font-mono text-[10px] text-ink-muted">
                  {'  '}
                  {parts}
                </Text>
              </Text>
            </View>
          </Pressable>
          {/* The whole-dish handle. Absent when the parts do not all carry an
              amount (or do not share a unit) — there is no honest total to
              type into, and the fractions below still work. */}
          {total.amount != null ? (
            <AmountField
              row={{ ...row, unit: total.unit }}
              value={row.amountText === '' ? amountLabel(total.amount) : row.amountText}
              label={row.name}
              onChange={(t) => handlers.onScaleTo(row.key, t)}
              onFocus={() => handlers.onScaleBegin(row.key)}
              onBlur={() => handlers.onScaleEnd(row.key)}
            />
          ) : null}
          <Text className="w-12 text-right font-mono text-[13px] text-ink-secondary">
            {total.kcal != null ? fmtInt(total.kcal) : '—'}
          </Text>
          <RemoveButton name={row.name} onPress={() => handlers.onRemove(row.key)} />
        </View>
        <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">{MACRO_LINE(total)}</Text>
      </View>

      {row.expanded ? (
        <View>
          {row.components.map((part) => (
            <PricedRow key={part.key} row={part} first={false} indented handlers={handlers} />
          ))}
          {/* "I ate half", as the sentence people actually say. Outlined chips,
              ≥44pt, in the label voice — the accent in this phase belongs to
              Save and stays there. */}
          <View className="flex-row items-center gap-2 pb-3 pl-6">
            <Text className="font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
              I ate
            </Text>
            {FRACTIONS.map((fraction) => (
              <Pressable
                key={fraction.label}
                accessibilityRole="button"
                accessibilityLabel={`I ate ${fraction.spoken} of the ${row.name}`}
                onPress={() => handlers.onScale(row.key, fraction.factor)}
                className="min-h-[44px] min-w-[44px] items-center justify-center rounded-btn border border-hairline px-3 active:bg-paper-dim">
                <Text className="font-label text-[13px] uppercase tracking-[1.2px] text-ink">
                  {fraction.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The review table. `emptyNote` is the screen's own sentence for a table the
 * user has emptied — the two screens say different things there, because
 * discarding an estimate and abandoning a revision are different acts.
 */
export function ReviewItemsPlate({
  rows,
  label,
  emptyNote,
  handlers,
}: {
  rows: ReviewItem[];
  label: string;
  emptyNote: string;
  handlers: ReviewHandlers;
}) {
  const kcal = reviewKcal(rows);
  return (
    <Block device="plate">
      <SectionLabel label={label} note={kcal !== null ? `${fmtInt(kcal)} kcal` : undefined} />
      {rows.length === 0 ? (
        <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
          {emptyNote}
        </Text>
      ) : (
        <View className="mt-1">
          {rows.map((row, index) =>
            isComposite(row) ? (
              <CompositeRow key={row.key} row={row} first={index === 0} handlers={handlers} />
            ) : (
              <PricedRow
                key={row.key}
                row={row}
                first={index === 0}
                indented={false}
                handlers={handlers}
              />
            )
          )}
        </View>
      )}
    </Block>
  );
}
