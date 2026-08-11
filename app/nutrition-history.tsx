import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider, GridCell } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { Sparkline } from '@/components/ui/sparkline';
import { StackHeader } from '@/components/ui/stack-header';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { nutritionHistory } from '@/lib/db/repositories/nutrition';
import { fmtInt } from '@/lib/nutrition/format';
import type { NutritionHistoryDay } from '@/lib/nutrition/types';

/**
 * Cross-day nutrition trends (offline) — energy and macros over a window, with
 * per-day adherence judged against that day's own targets (nutritionHistory).
 *
 * Conformed Set treatment: the averages are a **grid** (the grid is the object —
 * no outer box, drawn by the rules that run between its cells; see
 * src/components/ui/block.tsx), the per-day record is a **ruled plate** (a record
 * is a table), and the window chips are controls in the label voice. Every number
 * on the screen is mono, because mono measures.
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

export default function NutritionHistoryScreen() {
  const [window, setWindow] = useState<Window>(14);
  const [days, setDays] = useState<NutritionHistoryDay[]>(() =>
    nutritionHistory(getDb(), 14, todayISODate())
  );

  const reload = useCallback(() => {
    setDays(nutritionHistory(getDb(), window, todayISODate()));
  }, [window]);
  useFocusEffect(reload);

  // Just set the window — reload's identity depends on it, so useFocusEffect
  // re-reads for the new window (no second, redundant read here).
  const pickWindow = (w: Window) => setWindow(w);

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

      {daysWithEnergy === 0 ? (
        <Text className="mt-6 font-serif text-[14px] leading-6 text-ink-secondary">
          No energy logged in the last {window} days. Log meals with calories and the trend fills in
          here.
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

          {/* Per-day record, newest first, each judged against its own targets. */}
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
                  return (
                    <View key={d.date}>
                      <Divider first={index === 0} />
                      <View className="min-h-[44px] flex-row items-center gap-3 py-3">
                        <Text className="w-14 font-mono text-[11px] text-ink-muted">
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
                        </View>
                        <Text className="font-mono text-[10px] text-ink-muted">
                          {d.mealCount > 0
                            ? `P${Math.round(d.protein_g)} C${Math.round(d.carbs_g)} F${Math.round(d.fat_g)}`
                            : ''}
                        </Text>
                      </View>
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
