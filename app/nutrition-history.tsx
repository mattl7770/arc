import { useCallback, useState } from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider, GridCell } from '@/components/ui/block';
import { DayPicker } from '@/components/ui/day-picker';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { Sparkline } from '@/components/ui/sparkline';
import { StackHeader } from '@/components/ui/stack-header';
import { readNutritionDay, type NutritionDayView } from '@/hooks/use-nutrition';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { timezoneNotesIn } from '@/lib/db/repositories/day-meta';
import { nutritionHistory } from '@/lib/db/repositories/nutrition';
import { fmtInt, macroLine } from '@/lib/nutrition/format';
import {
  dayFigure,
  recordFigure,
  unguardedNote,
  type DayFigure,
  type DayMetric,
} from '@/lib/nutrition/remaining';
import type { MealRow, NutritionHistoryDay, NutritionTargetsRow } from '@/lib/nutrition/types';
import { dayLabel, dayPhrase, type DayBounds } from '@/lib/utils/day-cursor';

/**
 * The timezone-change notes (D4) covering the history window AND the day in
 * view — the picker can carry `day` earlier than the window's first row, and a
 * day annotated in the by-day list must be annotated in its own view too.
 */
function timezoneNotesFor(
  days: NutritionHistoryDay[],
  day: string,
  today: string
): Map<string, string> {
  const first = days[0]?.date;
  const from = first && first < day ? first : day;
  return timezoneNotesIn(getDb(), from, today);
}

/**
 * Nutrition history — **one day at a time, then the shape of the fortnight.**
 *
 * ## The day view (2026-09-14 — backlog C1)
 *
 * Owner: *"see past days food logs."* The Eat tab is today-only by design, and
 * this screen showed series: a 30-day sparkline and a per-day ledger of totals.
 * Neither answers *what did I eat on Tuesday* — the meals themselves were
 * reachable from nowhere once the day rolled over.
 *
 * So the screen now leads with a **day**, selected by the shared
 * {@link DayPicker} (src/components/ui/day-picker.tsx — built here, shaped so
 * Today's Mission can reuse it unchanged when it learns to look back), and the
 * by-day ledger below doubles as a second way in: tapping a row moves the
 * picker, exactly as app/water.tsx's by-day list selects the day its editor
 * works on.
 *
 * Three rules the day view is built on, each of which is a way this could have
 * quietly lied:
 *
 * 1. **A closed day never counts down.** `recordFigure`
 *    (src/lib/nutrition/remaining.ts) reads a past day as eaten-against-target
 *    rather than as a remainder. The honesty gate that protects the Eat tab
 *    passes VACUOUSLY on an empty day — no meals, so no meal is missing a value
 *    — which means an empty Tuesday would otherwise print "2,400 kcal left" over
 *    a day that is over. Today keeps the countdown; yesterday gets a record.
 * 2. **The day is judged by its OWN targets.** `activeNutritionTargets` is
 *    resolved for the selected date (targets are versioned, 0015), so a day two
 *    weeks back is measured against what governed it, not against what has been
 *    set since. Re-judging a closed day is the same mistake the day boundary
 *    refuses to make when it re-attributes nothing.
 * 3. **An empty day is authored, and it is not a zero.** "Nothing logged on
 *    Tuesday" and "0 kcal" are different facts — one is an absent record, the
 *    other is a record of nothing eaten — and the difference is the whole of
 *    00-design-spec.md §5. `meals.length === 0`, never `kcal === 0`, is what
 *    selects it.
 *
 * Every day computed here goes through src/lib/db/date.ts (via
 * src/lib/utils/day-cursor.ts), so the owner's configurable day boundary reaches
 * the picker for free: its forward bound is the LOGICAL today, and with a 04:00
 * boundary a 01:00 snack is on the day the picker calls today.
 *
 * ## The route
 *
 * `/nutrition-history` — unchanged, with an optional `?date=YYYY-MM-DD` param so
 * a future caller (a Coach answer, a mission row) can open straight onto a day.
 * No new route file: a day is a parameter of the history, not a screen of its
 * own, and `.expo/` is gitignored so a new route would typecheck vacuously.
 *
 * ## Conformed Set treatment
 *
 * The picker is a bare control row (no device). The day's readings are a
 * **grid** (the grid is the object — no outer box, drawn by the rules that run
 * between its cells), the day's meals and the per-day record are **ruled
 * plates** (a record is a table), and the window chips are controls in the label
 * voice. Every number on the screen is mono, because mono measures.
 *
 * Read-only, so **no accent at all** — nothing here is a next action.
 *
 * Each average is over the days that actually RECORDED that metric (see
 * meanPositive), so a name-only or kcal-only meal doesn't drag the mean toward
 * zero — the number reads as intake, not as "you didn't track it". The section
 * note states that cohort out loud, so the average and its denominator can
 * never drift apart.
 */

const WINDOWS = [7, 14, 30] as const;
type Window = (typeof WINDOWS)[number];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-07-24" → "Jul 24", parsed as local Y/M/D (no Intl, no UTC shift). */
function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1] ?? ''} ${d}`;
}

/** The day grid's three counted macros — the Eat tab's set, and for the same
 *  reason fiber is absent: it is summed from meal items, so a manually entered
 *  meal contributes none by construction. */
const MACROS: { metric: DayMetric; label: string }[] = [
  { metric: 'protein_g', label: 'Protein' },
  { metric: 'carbs_g', label: 'Carbs' },
  { metric: 'fat_g', label: 'Fat' },
];

/**
 * Mean over the POSITIVE values only. A day that logged a meal but left a
 * metric unrecorded stores 0/NULL→0 for it; counting those as real zeros would
 * make "average protein" read low when protein was simply never tracked. So
 * each metric averages over the days it was actually recorded.
 */
function meanPositive(values: number[]): number {
  const present = values.filter((v) => v > 0);
  return present.length === 0 ? 0 : present.reduce((a, b) => a + b, 0) / present.length;
}

/**
 * One average cell of the grid — its contents only. The `GridCell` around it
 * owns the column width, the padding and the rules between cells
 * (src/components/ui/block.tsx), so this carries no wrapper of its own.
 */
function AvgCell({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <>
      <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {label}
      </Text>
      <View className="mt-1 flex-row items-baseline gap-1">
        <Text className="font-mono text-lg font-semibold text-ink">{fmtInt(value)}</Text>
        <Text className="font-mono text-[10px] text-ink-muted">{unit}</Text>
      </View>
    </>
  );
}

/**
 * One macro cell of the DAY grid. The label carries the mode, exactly as the Eat
 * tab's does, so the number below it never needs a word to explain itself: a
 * closed day always reads plain ("PROTEIN"), because `recordFigure` has already
 * taken the countdown away from it.
 */
function DayMacroCell({ label, figure }: { label: string; figure: DayFigure }) {
  const remaining = figure.mode === 'remaining';
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
      <Text className="mt-0.5 font-mono text-[11px] text-ink-secondary">{denominator}</Text>
    </View>
  );
}

/** One meal row of the day's ledger — the whole row opens the meal's detail,
 *  the same screen the Eat tab opens, so a past meal is corrected where every
 *  other meal is corrected. */
function DayMealRow({
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
        className="min-h-[46px] flex-row gap-3 py-3 active:opacity-60">
        <Text className="w-12 pt-0.5 font-mono text-[12px] text-ink-secondary">
          {meal.time ?? '—'}
        </Text>
        <View className="flex-1">
          <Text className="font-serif text-[16px] leading-5 text-ink">{meal.name}</Text>
          {meal.kcal == null ? (
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
        {/* No kcal recorded reads as an em-dash and contributes nothing — never
            a fabricated 0. */}
        <Text className="pt-0.5 font-mono text-[15px] text-ink">
          {meal.kcal != null ? fmtInt(meal.kcal) : '—'}
        </Text>
      </Pressable>
    </View>
  );
}

/** The day grid's corner: the ledger the readings were taken from, or nothing.
 *  A measured value, so mono. */
function dayCorner(targets: NutritionTargetsRow | null, eatenKcal: number): string | null {
  if (targets === null || targets.kcal === null) return null;
  return `${fmtInt(eatenKcal)} of ${fmtInt(targets.kcal)} kcal`;
}

export default function NutritionHistoryScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ date?: string }>();
  // The clock is read ONCE per render pass and carried, so the picker's bound,
  // the labels and the series all agree about which day is today even if the
  // render straddles the boundary.
  const [today, setToday] = useState(() => todayISODate());
  const [window, setWindow] = useState<Window>(14);
  const [days, setDays] = useState<NutritionHistoryDay[]>(() =>
    nutritionHistory(getDb(), 14, todayISODate())
  );
  // The day in view. A `?date=` param opens straight onto a day (nothing in the
  // app passes one yet — the Coach and the mission are the intended callers);
  // anything outside the record is corrected by the picker's own clamp below,
  // so a stale or hand-typed param can never select a day that has not happened.
  const [day, setDay] = useState<string>(() => {
    const requested = typeof params.date === 'string' ? params.date : null;
    const now = todayISODate();
    return requested && requested <= now ? requested : now;
  });
  const [view, setView] = useState<NutritionDayView>(() => readNutritionDay(day));
  // The calendar register (D4): the days in the window — and the day in view,
  // which the picker can carry earlier than the window — that the device's
  // timezone changed on. Read beside the figures so a re-read can never leave
  // the annotation a window behind what it annotates.
  const [timezoneNotes, setTimezoneNotes] = useState<Map<string, string>>(() =>
    timezoneNotesFor(days, day, today)
  );

  const reload = useCallback(() => {
    // Roll the screen forward if the calendar moved while it was away, but only
    // when the user was looking at today — a deliberately selected past day is
    // where they meant to be, and yanking them off it is the bug app/water.tsx
    // documents at the same seam.
    const fresh = todayISODate();
    const next = day === today ? fresh : day;
    setToday(fresh);
    if (next !== day) setDay(next);
    setView(readNutritionDay(next));
    const nextDays = nutritionHistory(getDb(), window, fresh);
    setDays(nextDays);
    setTimezoneNotes(timezoneNotesFor(nextDays, next, fresh));
  }, [window, day, today]);
  useFocusEffect(reload);

  const selectDay = (next: string) => {
    setDay(next);
    setView(readNutritionDay(next));
  };

  // Just set the window — reload's identity depends on it, so useFocusEffect
  // re-reads for the new window (no second, redundant read here).
  const pickWindow = (w: Window) => setWindow(w);

  // --- The day in view ------------------------------------------------------
  // The back bound is the record's own start, so the arrow stops at the first
  // meal ever logged rather than stepping for ever through days that never
  // existed. No record at all pins both bounds to today.
  const bounds: DayBounds = { latest: today, earliest: view.recordStart ?? today };
  const closed = day !== today;
  const targetFor = (metric: DayMetric): number | null =>
    view.targets === null ? null : view.targets[metric];
  // A closed day is a record, not a plan (recordFigure). Today keeps the
  // countdown the Eat tab leads with.
  const read = (metric: DayMetric): DayFigure => {
    const figure = dayFigure(view.meals, metric, targetFor(metric), view.partialMeals);
    return closed ? recordFigure(figure) : figure;
  };
  const kcal = read('kcal');
  const macroFigures = MACROS.map((m) => ({ ...m, figure: read(m.metric) }));
  // The note explains why a REMAINDER is absent, so it only has something to say
  // on a day that was trying to show one.
  const note = closed
    ? null
    : unguardedNote(
        view.meals,
        {
          kcal: targetFor('kcal'),
          protein_g: targetFor('protein_g'),
          carbs_g: targetFor('carbs_g'),
          fat_g: targetFor('fat_g'),
        },
        view.partialMeals
      );
  const corner = dayCorner(view.targets, kcal.eaten);
  const logged = view.meals.length > 0;

  // --- The window's reading -------------------------------------------------
  // "Days with energy recorded" is the honest cohort for the summary: a
  // name-only meal (kcal 0) isn't a day of intake data. Each metric then
  // averages over its own recorded days (meanPositive).
  const daysWithEnergy = days.filter((d) => d.kcal > 0).length;
  const avgKcal = meanPositive(days.map((d) => d.kcal));
  const kcalSeries = days.map((d) => d.kcal);
  const recent = [...days].reverse();

  const avgCells = [
    { label: 'Protein', value: meanPositive(days.map((d) => d.protein_g)) },
    { label: 'Carbs', value: meanPositive(days.map((d) => d.carbs_g)) },
    { label: 'Fat', value: meanPositive(days.map((d) => d.fat_g)) },
  ];

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="History" />
      </View>

      {/* THE DAY IN VIEW — the picker, then what was eaten. */}
      <View className="mt-4">
        <DayPicker date={day} bounds={bounds} onChange={selectDay} subject="food log" />
      </View>

      <View className="mt-5">
        <Block device="grid">
          <View className="flex-row items-baseline gap-2">
            <View className="flex-1">
              <SectionLabel label={dayLabel(day, today)} />
              {/* The calendar register (D4). The figures below are left exactly
                  as logged — this day was 24 + Δ hours long, which is why Home's
                  verdict declines to grade it. */}
              {timezoneNotes.get(day) ? (
                <Text className="mt-1 font-mono text-[10px] leading-4 text-ink-muted">
                  {timezoneNotes.get(day)}
                </Text>
              ) : null}
            </View>
            {corner ? (
              <Text className="font-mono text-[11px] text-ink-secondary">{corner}</Text>
            ) : null}
          </View>

          {/* An absent record is not a zero: a day with nothing logged says so
              in words and draws no figures at all. Drawing a grid of zeros
              would claim the day was measured and empty. */}
          {!logged ? (
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
              {`Nothing logged ${dayPhrase(day, today)}.`}
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

              <View className="mt-2 flex-row flex-wrap">
                {macroFigures.map((m, index) => (
                  <GridCell key={m.metric} index={index} count={macroFigures.length} columns={3}>
                    <DayMacroCell label={m.label} figure={m.figure} />
                  </GridCell>
                ))}
              </View>
            </>
          )}

          {note ? (
            <Text className="mt-4 font-serif text-[13px] leading-5 text-ink-secondary">{note}</Text>
          ) : null}
        </Block>
      </View>

      {/* The day's meals. A plate closes a record, so there is none when there
          is no record to close — the sentence above has already said so. */}
      {logged ? (
        <View className="mt-7">
          <Block device="plate">
            <SectionLabel label="Meals" note={`${fmtInt(kcal.eaten)} kcal`} />
            <View className="mt-1">
              {view.meals.map((meal, index) => (
                <DayMealRow
                  key={meal.id}
                  meal={meal}
                  itemCount={view.itemCounts[meal.id] ?? 0}
                  first={index === 0}
                  onPress={() => router.push({ pathname: '/meal-detail', params: { id: meal.id } })}
                />
              ))}
            </View>
          </Block>
        </View>
      ) : null}

      {/* OVER TIME — the shape of the window, under the day it belongs to. */}
      <View className="mt-9">
        <SectionLabel label="Over time" />
        {/* Window chips — controls, so the label voice; 2px is the button radius. */}
        <View className="mt-2 flex-row gap-2">
          {WINDOWS.map((w) => (
            <Pressable
              key={w}
              accessibilityRole="button"
              accessibilityLabel={`Last ${w} days`}
              accessibilityState={{ selected: window === w }}
              onPress={() => pickWindow(w)}
              className={
                window === w
                  ? 'min-h-[44px] items-center justify-center rounded-btn border border-ink bg-paper-hi px-4'
                  : 'min-h-[44px] items-center justify-center rounded-btn border border-hairline px-4 active:opacity-60'
              }>
              <Text
                className={
                  window === w
                    ? 'font-mono text-[12px] font-semibold text-ink'
                    : 'font-mono text-[12px] text-ink-secondary'
                }>
                {w}d
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {daysWithEnergy === 0 ? (
        <Text className="mt-6 font-serif text-[14px] leading-6 text-ink-secondary">
          No energy logged in the last {window} days. Only meals with calories count toward this.
        </Text>
      ) : (
        <>
          {/* Averages over the days that recorded each metric, plus the kcal
              sparkline. The note names the cohort the average is over. */}
          <View className="mt-6">
            <Block device="grid">
              <SectionLabel
                label="Daily average"
                note={`${daysWithEnergy} of ${days.length} days logged`}
              />

              <View className="mt-2 flex-row items-end justify-between">
                <View className="flex-row items-baseline gap-1.5">
                  <Text className="font-mono text-4xl text-ink">{fmtInt(avgKcal)}</Text>
                  <Text className="font-mono text-sm text-ink-muted">kcal/day</Text>
                </View>
                <Sparkline data={kcalSeries} width={96} height={32} baseline="zero" />
              </View>

              {/* `mt-2` keeps the first cells' top rule off the kcal figure
                  above. Three macros in a two-column grid leaves Fat alone on
                  the last row, and `count` is what tells `GridCell` there is
                  nothing beside it to rule against. */}
              <View className="mt-2 flex-row flex-wrap">
                {avgCells.map((cell, index) => (
                  <GridCell key={cell.label} index={index} count={avgCells.length}>
                    <AvgCell label={cell.label} value={cell.value} unit="g" />
                  </GridCell>
                ))}
              </View>
            </Block>
          </View>

          {/* Per-day record, newest first, each judged against its own targets —
              and each row is the way INTO that day, which is how the picker is
              reached without tapping the back arrow eleven times. */}
          <View className="mt-8">
            <Block device="plate">
              <SectionLabel label="By day" note={`Last ${window} days`} />
              <View className="mt-1">
                {recent.map((d, index) => {
                  const kcalTarget = d.target?.kcal ?? null;
                  const pct =
                    kcalTarget && kcalTarget > 0
                      ? Math.min(100, (d.kcal / kcalTarget) * 100)
                      : null;
                  const isSelected = d.date === day;
                  return (
                    <View key={d.date}>
                      <Divider first={index === 0} />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: isSelected }}
                        accessibilityLabel={
                          d.mealCount === 0
                            ? `${shortDate(d.date)}. Nothing logged. Open this day.`
                            : `${shortDate(d.date)}. ${fmtInt(d.kcal)} kcal. Open this day.`
                        }
                        onPress={() => selectDay(d.date)}
                        className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
                        <Text
                          className={
                            isSelected
                              ? 'w-14 font-mono text-[11px] text-ink'
                              : 'w-14 font-mono text-[11px] text-ink-muted'
                          }>
                          {shortDate(d.date)}
                        </Text>
                        <View className="flex-1">
                          {d.mealCount === 0 ? (
                            <Text className="font-serif text-[13px] text-ink-muted">
                              Nothing logged
                            </Text>
                          ) : (
                            <>
                              <View className="flex-row items-baseline gap-1">
                                <Text className="font-mono text-[14px] text-ink">
                                  {fmtInt(d.kcal)}
                                </Text>
                                <Text className="font-mono text-[10px] text-ink-muted">
                                  {kcalTarget ? `/ ${fmtInt(kcalTarget)}` : 'kcal'}
                                </Text>
                              </View>
                              {pct !== null ? (
                                <View className="mt-1.5 h-[3px] bg-paper-deep">
                                  <View
                                    className="h-[3px] bg-ink-secondary"
                                    style={{ width: `${pct}%` }}
                                  />
                                </View>
                              ) : null}
                            </>
                          )}
                          {timezoneNotes.get(d.date) ? (
                            <Text className="mt-1.5 font-mono text-[10px] leading-4 text-ink-muted">
                              {timezoneNotes.get(d.date)}
                            </Text>
                          ) : null}
                        </View>
                        <Text className="font-mono text-[10px] text-ink-muted">
                          {d.mealCount > 0
                            ? `P${Math.round(d.protein_g)} C${Math.round(d.carbs_g)} F${Math.round(d.fat_g)}`
                            : ''}
                        </Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            </Block>
          </View>
        </>
      )}
    </Screen>
  );
}
