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
import { expectedDayFraction } from '@/lib/home/readiness';
import { barFigure, macroGrade } from '@/lib/nutrition/bar';
import { fmtInt, macroCells } from '@/lib/nutrition/format';
import {
  dayFigure,
  unguardedNote,
  type DayFigure,
  type DayMetric,
} from '@/lib/nutrition/remaining';
import type { MealRow, NutritionTargetsRow } from '@/lib/nutrition/types';
import type { SignalLevel } from '@/types/home';

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
 * 2. *"Five ways to log, presented as a menu."* → the menu moved behind one
 *    control opening src/components/nutrition/log-sheet.tsx. Nothing was
 *    deleted; the paths moved one tap in, and gained "Cook a recipe", which
 *    previously required opening the recipe first. Two **capture methods** —
 *    Photo and Describe — joined it on 2026-08-14, outlined beneath the accent.
 *    **Inverted 2026-08-15** after the owner used it: the two capture methods
 *    take the accent and the menu is demoted to an outlined **Other ways to
 *    log** beneath them. See the reasoning at the buttons themselves — in
 *    particular why two pine buttons do not spend the accent budget twice.
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
 * **Accent budget: one — one ACTION, drawn as the two ways of taking it.**
 * `Photo` and `Describe` are the screen's only accent in every state; `Set
 * daily targets` and `Other ways to log` are outlined and stay outlined. The
 * full argument for why two pine buttons is one claim and not two is at the
 * buttons. Since FB2 the macro bars spend **no accent at all** — a met bar's
 * pine fill was C6's one state mark here, and the bars now carry the signal
 * palette instead (see {@link MacroBar}), which gives the budget its headroom
 * back.
 *
 * ## Readability (C6, 2026-09-14 — docs/spikes/nutrition-readability.md)
 *
 * *"Macro stats more visible (bars / colours against targets) and more macro
 * information per individual meal on the overview."* Two requests, answered
 * separately:
 *
 * 1. **A bar under the kcal figure and under every macro cell, in BOTH modes.**
 *    The shipped rule was drawn once, under the hero, and only in `eaten` mode —
 *    which is the FALLBACK mode, so a well-logged day had no bar anywhere on the
 *    screen. The withheld-in-`remaining` reasoning (a countdown over a filling
 *    bar is "two opposite encodings of one quantity") is answered rather than
 *    overruled: they are two halves of one sentence, not two encodings. The bar
 *    draws `eaten` against `target`, the number states `left`, the denominator
 *    names `target`, and `eaten + left = target` reconciles on the cell — the
 *    ledger rule stated positively (00-design-spec.md §5). See {@link MacroBar}.
 * 2. **Per-meal macros, always, as aligned mono cells.** They used to lose to
 *    the meal's note outright (`meal.notes ?? macros`), so an AI-estimated meal —
 *    which always carries the model's note — showed no macros at all. Both are
 *    drawn now, and the macros are three fixed columns rather than a joined
 *    string, because a table's value is its columns. See {@link MealRowItem}.
 *
 * **The boundary, written down:** per-meal gets NUMBERS, the day gets BARS. Four
 * gauges a row, twenty rows deep, is the data dump CLAUDE.md §5 exists to
 * prevent — and the bars here replace bare numbers rather than adding a second
 * dashboard.
 */

/** The Today grid's three counted-down macros. Fiber is deliberately absent —
 *  it is summed from meal items, so a manually-entered meal contributes none by
 *  construction and it can never be honestly counted down. It lives on the
 *  micronutrients screen, read against its daily target. */
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
function MacroCell({
  label,
  figure,
  level,
}: {
  label: string;
  figure: DayFigure;
  level: SignalLevel;
}) {
  const remaining = figure.mode === 'remaining';
  // OVER is a different reading from LEFT, so the label says which. Carrying the
  // sign only in an 11px word under the figure meant "PROTEIN LEFT / 12" over a
  // day 12g past target — the label read as the opposite of the truth, and the
  // hero above it was already saying "12 kcal over" in the same situation.
  const over = remaining && figure.remaining < 0;
  const value = remaining ? Math.abs(figure.remaining) : figure.eaten;
  const mode = over ? `${label} over` : remaining ? `${label} left` : label;
  // Bound once: `DayFigure` is a union whose `eaten` branch may carry a null
  // target, and the same narrowing serves the denominator and the bar.
  const target = figure.target;
  const denominator = target !== null ? `of ${Math.round(target)} g` : 'g';
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
      {/* The picture of the term that has no picture. `eaten` against `target`,
          whichever mode the NUMBER above is in — a cell showing "86 left" is
          showing 94 of 180 eaten, and the two reconcile. Drawn in every state
          now (FB2): with no target it is a bare neutral rail, which keeps the
          three cells the same height whether or not a target governs them. */}
      <MacroBar eaten={figure.eaten} target={target} level={level} />
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

/**
 * One progress bar: what has been eaten against what the target is, coloured by
 * where that metric is heading. Drawn under the kcal hero and under each macro
 * cell, in BOTH modes, in every state — a metric with no target keeps its rail
 * and draws no fill, because there are no denominators until targets exist
 * (00-design-spec.md §5) but there is no reason for the grid to change height
 * when one is set.
 *
 * ## Colour — the signal palette, by owner override (FB2, 2026-09-21)
 *
 * The owner, from the device: *"colors for nutrition bars are hard to see,
 * should be more colourful."*
 *
 * C6 drew this bar in the ACCENT, deliberately: progress against a target is
 * behaviour, and the firewall (00-design-spec.md §2, docs/project-status.md §3)
 * says *"signal colours mark biological state only… conversely the accent never
 * marks biology."* That restraint is overruled — and the override is narrow and
 * written down where the rule lives (docs/project-status.md §3): **a macro bar
 * graded against a target is a verdict about the day, which is the same class of
 * thing the Home pillar shows.** It is not decoration and it is not a fifth
 * accent; it is the pillar's own reading, drawn where the numbers are.
 *
 * What keeps that from becoming "any chrome may be coloured": the fill takes the
 * level from {@link macroGrade}, which computes no band of its own — the kcal
 * bar is `kcalLevel`, the protein bar is `proteinLevel`, and both are the exact
 * halves the Home pillar combines. A bar cannot disagree with the pillar because
 * it is a component of it.
 *
 * The rejected reading this does NOT become: "red numbers over target"
 * (docs/nutrition-subapp.md §8). Over target is graded by DIRECTION, so a
 * gaining day at +18% is `optimal` green, not a warning — the thing the old
 * adherence-neutral rule was protecting is protected by the bands instead of by
 * refusing to colour at all.
 *
 * ## Which cut, and the measurements that chose it
 *
 * The palette specifies two values per state: the SWATCH for fills, the INK cut
 * for text. A bar fill is a fill, so the swatch is the obvious reach — and on
 * this rail it fails. Measured against `paper-deep` `#C6C1B0`, 2026-09-21:
 *
 * | state | swatch | on the rail | ink cut | on the rail |
 * | --- | --- | --- | --- | --- |
 * | optimal | `#2E8B57` | 2.36:1 ✗ | `#185A36` | **4.56:1** ✓ |
 * | good | `#2C6C95` | 3.16:1 ✓ | `#24567A` | **4.34:1** ✓ |
 * | caution | `#A97B22` | 2.10:1 ✗ | `#6E4F15` | **4.17:1** ✓ |
 * | poor | `#AA402C` | 3.35:1 ✓ | `#8F3524` | **4.31:1** ✓ |
 * | unknown | — | — | `#5C5340` | **4.21:1** ✓ |
 *
 * Two of the four swatches are under WCAG 1.4.11's 3:1 non-text floor on this
 * stock, and a palette where half the states are invisible is not "more
 * colourful", it is the same defect in new hues. **So the fill takes the ink
 * cut**, which clears 3:1 on every state with margin. That is not a
 * contradiction of §2's "the swatch is for fills": the swatch was measured for
 * fills on the light paper steps, and `paper-deep` is the darkest stock in the
 * set — the rule the palette actually states is *reaching for the swatch to
 * colour a value is the most likely way to fail contrast*, and this is that case.
 *
 * The rail stays `paper-deep` (1.42:1 on `paper`) — deliberately under threshold
 * and deliberately not a mark. A rail is the GROUND a reading sits in.
 *
 * ## What colour does NOT carry
 *
 * The four ink cuts are near-isoluminant by construction (4.17–4.56 against one
 * ground), so to anyone not perceiving hue they are one dark mark — the same
 * fact that rewrote the pillar cells (src/components/home/readiness-strip.tsx).
 * **Colour here is reinforcement, never the sole carrier**, and nothing was
 * taken away to make room for it:
 *
 *   - the cell's LABEL still flips `PROTEIN LEFT` → `PROTEIN OVER`, and the hero
 *     still says `kcal over`;
 *   - the figure and its denominator are unchanged, in mono, above the bar;
 *   - the FILL LENGTH is still literal progress, and a met bar still reaches
 *     the terminator;
 *   - Home still states the pillar's level in a word (`signalConditionLabel`).
 *
 * ## Geometry — 6px, and a 3px terminator
 *
 * 4px was the C6 compromise between rule and gauge; the owner has now judged it
 * on hardware and it lost. **6px** (18 device pixels at @3x) reads as a measured
 * bar rather than a hairline, and the terminator goes **3px** wide and full
 * height — 18×9 device pixels, 2.25× the area of C6's 2×4pt nick.
 *
 * The terminator measures **2.13–2.33:1** against the graded fills (`ink`
 * `#1C1911` on the four ink cuts). That is under 3:1 and it is accepted, for the
 * reason the rail is: it is not what carries the state. `met` is carried by the
 * fill reaching the rail's end (geometry, at full width) and by the label's own
 * word; the terminator marks WHERE THE TARGET IS, and it is at its most legible
 * exactly when it matters most for that — 9.74:1 on the bare rail, where the
 * fill has not arrived. It is strictly better than what shipped, besides: C6's
 * terminator sat on `ink-secondary` at 1.66:1.
 *
 * Filled views on a filled track, never a border: a one-sided border width
 * beside a border colour is the shape that drops RN off its CoreAnimation border
 * path (src/components/ui/block.tsx).
 *
 * **It says nothing to VoiceOver.** The cell above already speaks the same fact
 * in words; a bar that read as "seventy-two percent" beside a number that says
 * "86 left" would be two readings of one quantity — which is, for once, exactly
 * what the old withheld-in-`remaining` rule was right to worry about.
 */
function MacroBar({
  eaten,
  target,
  level,
}: {
  eaten: number;
  target: number | null;
  level: SignalLevel;
}) {
  const { fillPct, met } = barFigure(eaten, target ?? 0);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      testID={`macro-bar-${level}`}
      className="relative mt-1.5 h-[6px] bg-paper-deep">
      <View className={MACRO_BAR_FILL[level]} style={{ width: `${fillPct}%` }} />
      {/* The terminator. Absolutely positioned at the rail's right end rather
          than appended after the fill, so it marks where the TARGET is and not
          where the fill happens to stop — they are the same point only because
          the fill caps at 100%, and the mark must not move if that ever changes. */}
      {met ? <View className="absolute right-0 top-0 h-[6px] w-[3px] bg-ink" /> : null}
    </View>
  );
}

/**
 * Grade → fill class, as WHOLE literals: Tailwind's scanner only sees class
 * names that appear verbatim in source, so a built `bg-signal-${level}-ink`
 * fragment would compile to nothing at all. Same shape as the pillar's maps
 * (src/components/home/signal.tsx).
 *
 * Exported for db/screens-render.test.mjs: NativeWind's babel transform does not
 * run in a server render, so a rendered bar carries no class attribute and the
 * suite reads the grade off `data-testid` instead. Asserting this table there,
 * beside those renders, is what closes the gap between "the right level reached
 * the bar" and "the right class is on it".
 *
 * `unknown` is the metadata ink, not a fifth hue — an absent verdict is absent.
 * Its rail is usually empty besides (no target, no denominator, no fill), but
 * not always: a day before 10:00 or one that changed timezone draws its real
 * length in this neutral cut, which is the timezone ADR's rule made visible —
 * show the quantity, withhold the judgment.
 */
const MACRO_BAR_FILL: Record<SignalLevel, string> = {
  optimal: 'h-[6px] bg-signal-optimal-ink',
  good: 'h-[6px] bg-signal-good-ink',
  caution: 'h-[6px] bg-signal-caution-ink',
  poor: 'h-[6px] bg-signal-poor-ink',
  unknown: 'h-[6px] bg-signal-unknown',
};

export { MACRO_BAR_FILL };

/** Whole class literals — Tailwind's scanner never sees a built fragment. The
 *  first two cells are fixed so the macros form COLUMNS down the day (a record
 *  is a table, and a table's value is its columns); the last one takes what is
 *  left, which is what keeps a narrow phone truncating instead of overflowing
 *  into the kcal figure. 52pt fits a three-digit carb figure at 11px mono. */
const MACRO_CELL = 'w-[52px]';
const MACRO_CELL_LAST = 'flex-1';

/**
 * One "Eaten today" row — the whole row pushes the meal's detail screen.
 *
 * ## The note no longer eats the macros (C6)
 *
 * The body used to be `meal.notes ?? [macros, itemCount].join(' · ')`, and that
 * `??` was a silent loss: an AI-estimated meal ALWAYS carries the model's note
 * (app/meal-estimate.tsx writes it onto the meal), so the meals most worth
 * inspecting were exactly the ones whose macros were never drawn. Both are drawn
 * now, on their own lines — the note in the reading face, the macros in the
 * measuring one.
 *
 * ## Three cells, not a joined string
 *
 * `P 31g  C 28g  F 19g` at **11px mono**, each in its own fixed cell, so protein
 * is scannable straight down the day. 11px is deliberate: the metadata band is
 * 9.5–10px and it is for labels, captions and timestamps, while a macro the
 * owner has just asked to see MORE of is the row's second measurement, not
 * metadata. It keeps this tab's existing 11px floor and still drops one step
 * below the 12px line it replaces, which is what buys the column widths.
 *
 * **Absence stays absent.** A meal that recorded only protein draws `P 31g` and
 * an empty carbs cell — never a fabricated `0` — and a meal with no macros at
 * all draws no strip. Macro grams are macro grams whatever the portion was
 * measured in, so nothing here is touched by the `ml` unit (0047); this row
 * prints no portion at all, which is the reason it cannot be.
 *
 * **The item count is gone from this row**, per the spike's recommended answer:
 * it told you how the meal was ENTERED, not what was in it, and the two do not
 * both fit on a narrow phone. It is still on the meal's own screen, under Items.
 *
 * No bar here, deliberately — see the boundary in this file's header.
 */
function MealRowItem({
  meal,
  estimatePending,
  first,
  onPress,
}: {
  meal: MealRow;
  /** A queued AI estimate owes this meal its numbers (0057). */
  estimatePending: boolean;
  first: boolean;
  onPress: () => void;
}) {
  const cells = macroCells(meal);
  const hasMacros = cells.some((cell) => cell.text !== null);
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
          {/* A meal waiting on a queued estimate says what it is waiting FOR.
              It has no numbers, but "tap to fill it in" would be advice the
              user cannot act on offline — and the em-dash on the right must
              never be mistaken for a 0 kcal meal. */}
          {estimatePending ? (
            <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary">
              Estimate pending — offline
            </Text>
          ) : unrecorded ? (
            <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary">
              Nothing recorded — tap to fill it in
            </Text>
          ) : (
            <>
              {meal.notes ? (
                <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary">
                  {meal.notes}
                </Text>
              ) : null}
              {hasMacros ? (
                <View className="mt-0.5 flex-row">
                  {cells.map((cell, index) => (
                    <View
                      key={cell.key}
                      className={index === cells.length - 1 ? MACRO_CELL_LAST : MACRO_CELL}>
                      {cell.text !== null ? (
                        <Text
                          numberOfLines={1}
                          className="font-mono text-[11px] leading-4 text-ink-secondary">
                          {cell.text}
                        </Text>
                      ) : null}
                    </View>
                  ))}
                </View>
              ) : null}
            </>
          )}
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
  const {
    meals,
    targets,
    partialMeals,
    pendingEstimates,
    kitchen,
    overTime,
    direction,
    timezoneChanged,
    reload,
  } = useNutrition();
  const [logOpen, setLogOpen] = useState(false);

  const targetFor = (metric: DayMetric): number | null => {
    if (targets === null) return null;
    return targets[metric];
  };

  // The grade every bar on this screen is coloured by (FB2). Read ONCE per
  // render, from the same clock and the same pace curve the Home pillar uses —
  // four bars grading against four slightly different instants would be the
  // cheapest possible way to make them disagree with each other.
  const expected = expectedDayFraction(new Date());
  const gradeFor = (metric: DayMetric, eaten: number, target: number | null): SignalLevel =>
    macroGrade({
      metric,
      eaten,
      target,
      direction,
      expected,
      mealCount: meals.length,
      timezoneChanged,
    });

  const kcal = dayFigure(meals, 'kcal', targetFor('kcal'), partialMeals);
  const macroFigures = MACROS.map((m) => {
    const figure = dayFigure(meals, m.metric, targetFor(m.metric), partialMeals);
    return { ...m, figure, level: gradeFor(m.metric, figure.eaten, figure.target) };
  });
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
  // Narrowed once, for the hero's bar: `DayFigure`'s `eaten` branch may carry a
  // null target, its `remaining` branch never does.
  const kcalTarget = kcal.target;
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

              {/* In BOTH modes now (C6). The hero says what is LEFT and the bar
                  says how much of the target is EATEN; the corner above states
                  the same ledger in words. Three statements of one day, none of
                  them the same encoding. */}
              <MacroBar
                eaten={kcal.eaten}
                target={kcalTarget}
                level={gradeFor('kcal', kcal.eaten, kcalTarget)}
              />

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
                    <MacroCell label={m.label} figure={m.figure} level={m.level} />
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

      {/* THE CAPTURE PAIR — the accent, and the menu beneath it.
          Inverted at the owner's request, 2026-08-15: *"lets swap the log
          button and the photo and describe log buttons, swapping the
          colors/style too, and then rename the log button to 'Other ways to
          log'"*. Photo and Describe were added outlined under `Log` on
          2026-08-14; one day of real use put the hierarchy the other way up,
          which is the right answer — a menu of six methods is not the next
          action, it is the fallback for the four you rarely reach for. */}
      <View className="mt-7">
        {/* Two pine buttons, deliberately — not one accent band split in two,
            and not one of them promoted over the other.

            The rule this had to be checked against is the accent budget
            (00-design-spec.md §2): the accent marks *one primary action per
            screen*, and the docblock above has claimed "Accent budget: one"
            since the tab was re-cut. Two pine slabs look, at a glance, like
            spending it twice.

            They do not, and the reason is what the budget is a ceiling ON. It
            counts CLAIMS to being the next action, not accent-coloured
            rectangles — the same section spends the accent on every one of the
            user's chat bubbles, because they are one voice, not N actions.
            Photo and Describe are one act, `capture what I just ate`, offered
            in the two modalities it has; you take one or the other and never
            both, and neither is a step towards the other. A reader landing on
            this screen is never asked *which of these two is the thing to do* —
            only *which way do I want to say it*. That is not the confusion the
            rule exists to prevent.

            A single accent band ruled into two halves was the other candidate,
            and it is the more literal reading of "one". It was rejected on
            craft: a filled track divided by a hairline is what iOS draws for a
            SEGMENTED CONTROL, so the one shape that most cleanly satisfies the
            letter of the rule is also the one most likely to be read as "pick a
            mode" rather than "tap to start". Two objects with sheet between
            them cannot be misread that way. The budget survives either way; the
            misreading only survives one.

            What DOES keep the budget honest is that nothing else on this screen
            takes pine in any state — `Set daily targets` above and `Other ways
            to log` below are both outlined, and both stay outlined.

            15px sentence case, not 13px uppercase: these are full-weight
            primary actions now, and §3 sets that weight by size and casing
            rather than by face. Still the label voice, as every button is. */}
        <View className="flex-row gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Photograph a meal"
            onPress={() => router.push({ pathname: '/meal-estimate', params: { start: 'camera' } })}
            className="min-h-[52px] flex-1 flex-row items-center justify-center gap-2 rounded-btn bg-pine px-3 active:opacity-80">
            <Ionicons name="camera-outline" size={18} color={palette.pineOn} />
            <Text className="font-label text-[15px] font-semibold text-pine-on">Photo</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Describe a meal in words"
            onPress={() => router.push('/meal-estimate')}
            className="min-h-[52px] flex-1 flex-row items-center justify-center gap-2 rounded-btn bg-pine px-3 active:opacity-80">
            <Ionicons name="sparkles-outline" size={18} color={palette.pineOn} />
            <Text className="font-label text-[15px] font-semibold text-pine-on">Describe</Text>
          </Pressable>
        </View>

        {/* The chooser, demoted and renamed. It still opens
            src/components/nutrition/log-sheet.tsx unchanged and still reaches
            all six methods — nothing was deleted, the two fastest were promoted
            past it. Outlined, in the same treatment `Set daily targets` wears
            one section up, so the two secondary controls on this screen agree.
            The ellipsis is the mark for "there are more of these", which is
            exactly what the sheet is. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Other ways to log a meal"
          onPress={() => setLogOpen(true)}
          className="mt-2 min-h-[46px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
          <Ionicons name="ellipsis-horizontal" size={17} color={palette.inkSecondary} />
          <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
            Other ways to log
          </Text>
        </Pressable>
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
                  estimatePending={pendingEstimates.has(meal.id)}
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
