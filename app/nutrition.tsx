import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter, useSegments } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, type TextInputProps, View } from 'react-native';

import { Block, Divider, GridCell } from '@/components/ui/block';
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
 *                    the grid IS the object: no outer box, drawn by the rules
 *                    that run between its cells (src/components/ui/block.tsx,
 *                    metrics-strip.tsx).
 *   Log a meal     → a **stamped plate** for the one next action, wearing the
 *                    hatched cap (`.cf-card--accent::before`), then a **ruled
 *                    plate** holding the remaining entry paths as a record
 *                    list. Manual entry opens a **deviceless ruled register**
 *                    below the plate: six underlined rows carrying no surface
 *                    of their own, so nothing is boxed and nothing is raised
 *                    (src/components/ui/block.tsx, `FormField` below).
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
 * A square progress rule against a target — the sheet's `.cf-bartrack` and
 * `.cf-barfill`, used for the day's kcal and for every macro that has a target.
 *
 * **A bordered track, not an underline.** The sheet draws 6px of `paper-dim`
 * inside a 1px `paper-line` border, and the border is most of the message: a
 * bordered track reads as a drawn instrument with a known full length, where a
 * bare 3px bar reads as an underline under the figure above it and tells you
 * nothing about where "done" is. The port had it at 3px of `paper-deep` with no
 * border — half the height and none of the frame. Restored 2026-08-11.
 *
 * **The border is uniform, and that is the only reason it is allowed.** React
 * Native keeps its cheap CoreAnimation border path only while border width AND
 * colour are uniform; a one-sided width against a whole-element colour drops off
 * it and paints a complete rectangle, which is the bug behind four rounds of
 * "weird boxes" (src/components/ui/block.tsx, `Divider`). `border
 * border-hairline` on all four sides never goes near that path, which is exactly
 * why a bordered TRACK is drawable and a `border-t` rule is not.
 *
 * The fill claims no height of its own: 6pt of track minus two 1pt borders is
 * 4pt of content box, RN's box model already subtracts the border, and a child
 * with no height stretches to fill it. One fewer number to keep in sync with the
 * track's.
 *
 * Neutral ink, never the accent and never a signal colour: progress toward a
 * macro target is chrome, and a met target is a fact about the log rather than
 * about the body. `ink-secondary` is the sheet's `--ink-soft` fill; met darkens
 * to full ink, which is this app's own addition on top of the sheet's single
 * fill class and the one reading the numbers above don't already give.
 */
function TargetRule({ value, target }: { value: number; target: number }) {
  const met = value >= target;
  // A target of ZERO is a real, storable target — 0015_nutrition_targets.sql
  // bounds protein/carbs/fat/fiber at `>= 0` and gates only kcal at `> 0`, and
  // the editor accepts it (a carnivore fibre target is the obvious case). It is
  // also a divide-by-zero: `value / 0` is Infinity, and `0 / 0` is NaN, which
  // reaches `width` as the string "NaN%" and silently lays out as nothing. So
  // the ratio is computed only where there is a denominator. At a target of 0
  // the track is empty until something is logged and full the moment anything
  // is — which is what "at, or past, a target of none" looks like.
  const filled = target > 0 ? Math.min(100, (value / target) * 100) : value > 0 ? 100 : 0;
  return (
    <View className="mt-1.5 h-1.5 flex-row border border-hairline bg-paper-dim">
      <View className={met ? 'bg-ink' : 'bg-ink-secondary'} style={{ width: `${filled}%` }} />
    </View>
  );
}

/** One macro cell of the Today grid. Every number is a measurement, so every
 * number is mono; the label is the label voice. No target, no denominator —
 * the value stands alone rather than inventing an "x / —".
 *
 * **The untargeted case is authored, not blank.** Where a targeted macro gets a
 * `TargetRule`, an untargeted one gets the sheet's `.cf-macro-note` — the words
 * "not targeted" IN THE BAR'S SLOT. The port rendered nothing there, which made
 * an untargeted macro a silently short cell: the reader has to work out whether
 * the bar is missing because no target governs this macro or because something
 * failed to draw. §5 of the spec settles it — *empty is authored, never blank* —
 * and this is the same obligation "Nothing logged yet today." meets further down
 * the screen.
 *
 * The note sits at 10px where the sheet says 9. That is the standing conversion
 * for this sheet's metadata layer, not a drift: §4 puts the render floor at 9px
 * and asks the metadata layer to sit at 9.5–10 so the floor is never
 * load-bearing, which is why `SectionLabel` renders the sheet's 9px `.cf-sec-t`
 * at 10 and why the `.cf-macro-k` label two lines up is already at 10 here. In
 * the sheet the label and the note are the SAME size; keeping them equal is what
 * preserves the relationship the sheet actually draws.
 *
 * The cell's contents only: the `GridCell` around it owns the column width, the
 * padding and the rules between cells (src/components/ui/block.tsx). */
function MacroCell({
  label,
  grams,
  target,
}: {
  label: string;
  grams: number;
  target: number | null;
}) {
  return (
    <>
      <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {label}
      </Text>
      <View className="mt-1 flex-row items-baseline gap-1">
        <Text className="font-mono text-lg font-semibold text-ink">{Math.round(grams)}</Text>
        <Text className="font-mono text-[10px] text-ink-muted">
          {target !== null ? `/ ${Math.round(target)}g` : 'g'}
        </Text>
      </View>
      {target !== null && target > 0 ? (
        <TargetRule value={grams} target={target} />
      ) : (
        <Text className="mt-1.5 font-mono text-[10px] text-ink-muted">not targeted</Text>
      )}
    </>
  );
}

/**
 * The Today-grid corner — the invitation to set or edit targets, and nothing
 * else. A control, so it speaks in the label voice.
 *
 * **It used to carry the kcal denominator, and that is what broke the readout.**
 * The sheet sets ONE baseline-aligned sentence (`.cf-kcal`): `2,180` at 32px
 * mono bold, then "of 2,400 kcal target" at 11px in the metadata ink, read left
 * to right in the order the words go. The port split that sentence in two —
 * "2,180 kcal" on the readout, "of 2,400 target" banished to the far corner of
 * the section label above it — so the denominator sat on a different line, in a
 * different place in the reading order, from the figure it is the denominator
 * OF. The measurement has to be one line to be one sentence; the denominator
 * moved back onto it (see `NutritionScreen`), and this corner kept the job it
 * always had.
 *
 * Which leaves it nothing to say once a kcal target exists: the denominator
 * beside the figure is itself the tap target for the editor, so a second control
 * saying the same thing is noise. It returns `null` there. Targets that exist
 * but set no kcal still need the corner, because there is no denominator on the
 * readout for the affordance to ride.
 */
function targetsCorner(targets: NutritionTargetsRow | null): string | null {
  if (targets === null) return 'Set daily targets';
  if (targets.kcal !== null) return null;
  return 'Edit targets';
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
 * One row of the manual meal register — the sheet's `.cf-frow`: a 60pt uppercase
 * label, the value beside it, and a hairline under the pair. Six of them stacked
 * make an underline-ruled register, which is what a form looks like on a
 * drawing.
 *
 * ## Where the well went, and why this is still legal
 *
 * These fields used to be boxed: `border-paper-deep bg-paper-dim` on every
 * input, laid 1 / 2 / 3 across. That is form (b) of the capture-surface rule in
 * src/components/ui/block.tsx — *the field IS the well* — and it was correct.
 * The sheet draws the same form with the box and the fill dropped, leaving only
 * the rule: still no enclosure of its own, still no `<Block device="well">`
 * around it, still nothing raised onto plate stock. The rule that governs the
 * whole family — **an input is never `bg-paper-hi`** — is satisfied by an input
 * that carries no surface at all, and the forbidden third form (a well
 * *containing* inputs that have surfaces of their own) is not in reach from
 * here, because there is no well.
 *
 * What the boxes were actually buying was separability under the 1 / 2 / 3
 * layout: three fields sharing a line need an edge each to stay distinct. Rows
 * separate themselves, so stacking them is what makes dropping the box possible
 * rather than the two changes being independent.
 *
 * ## The rule is a filled view, never `border-b`
 *
 * `border-b border-hairline` is a one-sided width against a whole-element
 * colour, the pair React Native paints as a COMPLETE RECTANGLE — six of them
 * here would be six boxes, i.e. the precise bug this codebase has fought four
 * times (src/components/ui/block.tsx, `Divider`). It is written out inline
 * rather than reusing `Divider` because `Divider` means "between the rows of a
 * record" and refuses to draw above the first one; this is a field's underline,
 * it belongs to the row above it, and every row has one including the last —
 * where a record separator would be wrong.
 *
 * ## Two departures from the sheet, both deliberate
 *
 * The row keeps a 44pt floor (00-design-spec.md §4). The sheet's ~30px row is a
 * mouse target, and a text field is the one control on this screen that has to
 * be hit precisely.
 *
 * The value stays at 15px where `.cf-frow-v` says 12. The sheet's value is
 * static mockup type; this one is a field you type into, and 15px is the app's
 * body size everywhere a caret goes. The label, the 60pt column and the rule are
 * what carry the register's form — the input's point size is not part of it.
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
    <View>
      <View className="flex-row items-center gap-2.5">
        <Text className="w-[60px] font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
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
              ? 'min-h-[44px] flex-1 py-2 font-mono text-[15px] text-ink'
              : 'min-h-[44px] flex-1 py-2 font-serif text-[15px] text-ink'
          }
        />
      </View>
      <View className="h-px self-stretch bg-hairline" />
    </View>
  );
}

/**
 * The manual "Add a meal" form — the sheet's `.cf-form`: six ruled rows in one
 * column, 12px apart. It carries **no device**, the way it always did: a group
 * of labelled fields is controls rather than content, and a `<Block
 * device="well">` around rows that are themselves the capture surface would put
 * a recess inside a recess (the capture-surface rule,
 * src/components/ui/block.tsx). The disclosure row above — "Manual entry",
 * chevron up — is what ties this group to the plate it opened from; whitespace
 * does the rest, the way it does on app/capture.tsx and app/symptom.tsx.
 *
 * ## The disclosure stays; only the rows changed
 *
 * The sheet has these six rows always visible, and the port could have followed
 * it — but the sheet's "Log a meal" block holds ONE other entry path ("From a
 * template") where the app holds four, because catalog search, the barcode
 * scanner and templates all shipped. That plate is a menu of routes into the
 * log, and "Manual entry" is one item on it. Making the form permanent would
 * leave three rows that push a screen sitting beside a fourth that pushes
 * nothing and expands something already on screen — a menu whose items no longer
 * mean the same kind of thing — and it would add ~330pt of always-open form to a
 * screen the sheet keeps short precisely because it has three fewer paths to
 * offer. The disclosure is load-bearing for both reasons, so it stays, and what
 * was ported is the row treatment inside it: `FormField` is now the sheet's
 * ruled register instead of a boxed input, stacked one per line instead of laid
 * 1 / 2 / 3 across.
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
      {/* One field per line, in the sheet's order: what, when, then the
          numbers. `gap-3` is `.cf-form`'s 12px between rows — measured from
          each row's own rule to the next row's label, so the rhythm is the
          register's, not the inputs'. */}
      <View className="gap-3">
        <FormField
          label="Meal"
          value={name}
          onChange={setName}
          placeholder="e.g. Salmon + lentils"
        />
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
    <View>
      <Divider first={first} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={expanded === undefined ? undefined : { expanded }}
        onPress={onPress}
        className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
        <Ionicons name={icon} size={17} color={palette.inkSecondary} />
        <View className="flex-1">
          <Text className="font-serif text-[15px] text-ink">{label}</Text>
          {detail ? (
            <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-muted">{detail}</Text>
          ) : null}
        </View>
        <Ionicons name={chevron} size={16} color={palette.inkMuted} />
      </Pressable>
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
  return (
    <View>
      <Divider first={first} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${meal.name}, details`}
        onPress={onPress}
        className="min-h-[44px] flex-row gap-3 py-3 active:opacity-60">
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
        {/* The sheet's `.cf-lrow-meta`: a bold mono figure with its unit stacked
            under it in the metadata ink. The port printed a bare `740`, which
            leaves the reader to infer from context what the column counts —
            fine on a nutrition screen right up until the same row shape carries
            minutes or sets, which it does one sub-app over. The unit rides the
            figure. It prints on the em-dash too: it names what is missing, and a
            column that loses its heading when a value is absent is the "empty is
            authored" failure in miniature (00-design-spec.md §5).

            10px rather than the sheet's 9 — the standing conversion for this
            sheet's metadata layer, §4's floor kept off load-bearing duty. Same
            reasoning as the `not targeted` note above.

            The rounding site of record: `fmtInt` rounds here, and the Today
            header totals these rounded rows rather than rounding again from the
            raw sum (see sumRounded). No kcal recorded reads as an em-dash and
            contributes nothing — never a fabricated 0. */}
        <View className="items-end pt-0.5">
          <Text className="font-mono text-[11px] font-bold text-ink">
            {meal.kcal != null ? fmtInt(meal.kcal) : '—'}
          </Text>
          <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">kcal</Text>
        </View>
      </Pressable>
    </View>
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

  // The second half of the sheet's `.cf-kcal` sentence. Built once so the
  // spoken label and the visible text cannot drift apart — they are the same
  // string, not two renderings of the same idea.
  const kcalDenominator = kcalTarget !== null ? `of ${fmtInt(kcalTarget)} kcal target` : null;

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

  // `.cf-macros` is `grid-template-columns: 1fr 1fr 1fr` — Protein, Carbs and
  // Fat on ONE line. Wrapping half-width cells put Carbs on a second row and
  // Fat alone on a third, which is three lines of grid for a set the sheet
  // reads as one.
  //
  // The fourth cell is ARC's, not the sheet's: fiber joins only when a target
  // governs it, and the mockup has no fiber row to copy. Neither obvious answer
  // is 3-up. Keeping three columns leaves Fiber alone in the left third of a
  // second row under a rule that stops a third of the way across — the
  // half-drawn-box reading the `grid` device is most vulnerable to, and the
  // exact failure that got the device deleted once (00-design-spec.md §1).
  // Going to four columns keeps one line but not a legible one: at the `px-5`
  // gutter a quarter cell is ~88pt on an iPhone 16 and ~84 on a 375pt SE, less
  // ~20 of cell inset, against a value line ("132" at 18px mono beside
  // "/ 180g") that wants a little over 70 — so the denominator wraps or clips
  // on the smaller sheet, and a target you cannot read is worse than a target
  // on a second row.
  //
  // So: three across when there are three, 2 × 2 when there are four. Every
  // cell equal, every rule full width, and the sheet's form kept for the case
  // the sheet actually specifies.
  const macroColumns = cells.length === 4 ? 2 : 3;

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
            {/* Only when the readout below carries no denominator to hang the
                affordance on — see `targetsCorner`. The spoken label is the
                visible string itself. */}
            {corner !== null ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={corner}
                hitSlop={16}
                onPress={() => router.push('/nutrition-targets')}
                className="active:opacity-60">
                <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                  {corner}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {/* `.cf-kcal` — ONE baseline-aligned sentence: the figure at 32px mono
              bold, then its denominator at 11px in the metadata ink, read left
              to right in the order the words go. The denominator carries the
              unit ("of 2,400 kcal target"), so the figure stands bare; with no
              target there is no denominator and the unit falls back to naming
              itself.

              The denominator is ALSO the tap target for the targets editor.
              That is what lets the sentence come back whole without losing the
              affordance the section corner used to hold: the phrase the reader
              already reads as "the target" is the thing they touch to change
              it, which is a shorter path than a control in the corner of a
              different line. `accessibilityHint` — the app's first — carries the
              destination the old `accessibilityLabel="Daily targets"` was
              spending itself on, so the label can be the visible text verbatim.
              A hint is the RN slot for "what happens if you activate this"; a
              label that describes the destination instead of the content makes
              the spoken screen and the drawn screen two different screens. */}
          <View className="mt-2 flex-row items-baseline gap-2">
            <Text className="font-mono text-[32px] font-bold tracking-[-0.32px] text-ink">
              {fmtInt(shown.kcal)}
            </Text>
            {kcalDenominator !== null ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={kcalDenominator}
                accessibilityHint="Opens daily targets"
                hitSlop={16}
                onPress={() => router.push('/nutrition-targets')}
                className="active:opacity-60">
                <Text className="font-mono text-[11px] text-ink-muted">{kcalDenominator}</Text>
              </Pressable>
            ) : (
              <Text className="font-mono text-[11px] text-ink-muted">kcal</Text>
            )}
          </View>

          {kcalTarget !== null && kcalTarget > 0 ? (
            <TargetRule value={shown.kcal} target={kcalTarget} />
          ) : null}

          {/* `mt-2` keeps the first cells' top rule off the kcal figure and its
              target rule above. `columns` is the sheet's three, or two when a
              fiber target makes a fourth cell — see `macroColumns` for why the
              fourth case is not 3-up. `count` is what stops the last cell of an
              odd row ruling off into the empty space beside it. */}
          <View className="mt-2 flex-row flex-wrap">
            {cells.map((cell, index) => (
              <GridCell key={cell.label} index={index} count={cells.length} columns={macroColumns}>
                <MacroCell label={cell.label} grams={cell.grams} target={cell.target} />
              </GridCell>
            ))}
          </View>
        </Block>
      </View>

      {/* Log a meal — the capped stamp for the next action, then the other
          entry paths as a record list, then the manual register (ruled rows, no
          device of its own). */}
      <View className="mt-8">
        <SectionLabel label="Log a meal" />

        {/* The one accent on this screen: AI estimation (photo / describe)
            landing in an editable review (app/meal-estimate.tsx).

            `cap` draws `.cf-card--accent::before` — the 3pt accent/ink barber
            hatch laid over the top edge, the loudest drafting mark in the set
            and the thing that separates a stamped card from a card that merely
            has a coloured border (src/components/ui/block.tsx, `HatchCap`). The
            sheet gives it to exactly the accent CARDS, which this is. */}
        <View className="mt-2">
          <Block device="stamp" cap>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Describe or snap a meal"
              onPress={() => router.push('/meal-estimate')}
              className="min-h-[44px] flex-row items-center gap-3 active:opacity-60">
              <Ionicons name="camera-outline" size={20} color={palette.pine} />
              <View className="flex-1">
                {/* `.cf-card-eyebrow`: 9px label voice, uppercase, tracked,
                    `accent-deep`. The port had it as serif 16px semibold
                    `text-ink` — a title, not an eyebrow: casing, voice, colour
                    and rank all moved, and the accent left the type entirely on
                    the one card whose job is to be the accent. Restored to the
                    literal `src/components/home/hero-card.tsx` already uses for
                    its tag, which is the same mark in the same slot. On the
                    accent card `text-pine-deep` is on-budget (00-design-spec.md
                    §2) — the budget is spent on this card either way, and the
                    eyebrow is part of the stamp rather than a second use of it.
                    10px is the standing lift off the sheet's 9 (§4). */}
                <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-pine-deep">
                  Describe or snap a meal
                </Text>
                {/* The opening half — "Type it or photograph the plate —" —
                    restated the eyebrow above it and was cut by the owner as
                    explanatory copy on 2026-08-11. */}
                <Text className="mt-1 font-serif text-[13px] leading-5 text-ink-secondary">
                  You review before it logs
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
        {/* The plate is drawn in both states — the day's ledger stands where
            the ledger stands, empty or not. (The sweep of 2026-08-10 made it
            conditional; reverted at the owner's instruction.) */}
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
