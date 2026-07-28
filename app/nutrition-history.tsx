import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
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
 * Read-only, so no pine action; Cal-AI's dashboard richness rendered as the
 * Porcelain Ledger asks — mono numbers, a dependency-free bar sparkline, thin
 * neutral tracks. Each average is over the days that actually RECORDED that
 * metric (see meanPositive), so a name-only or kcal-only meal doesn't drag the
 * mean toward zero — the number reads as intake, not as "you didn't track it".
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

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

/** One average cell in the summary card. */
function AvgCell({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <View className="flex-1">
      <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">{label}</Text>
      <View className="mt-1 flex-row items-baseline gap-1">
        <Text className="font-mono text-lg text-ink">{fmtInt(value)}</Text>
        <Text className="font-mono text-[11px] text-ink-muted">{unit}</Text>
      </View>
    </View>
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
  const avgProtein = meanPositive(days.map((d) => d.protein_g));
  const avgCarbs = meanPositive(days.map((d) => d.carbs_g));
  const avgFat = meanPositive(days.map((d) => d.fat_g));
  const kcalSeries = days.map((d) => d.kcal);
  const recent = [...days].reverse();

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="History" />
      </View>

      {/* Window chips — rounded-btn, never pills. */}
      <View className="mt-2 flex-row gap-2">
        {WINDOWS.map((w) => (
          <Pressable
            key={w}
            accessibilityRole="button"
            accessibilityLabel={`Last ${w} days`}
            accessibilityState={{ selected: window === w }}
            onPress={() => pickWindow(w)}
            className={`rounded-btn border px-3.5 py-2 ${
              window === w
                ? 'border-hairline-strong bg-paper-deep'
                : 'border-hairline bg-porcelain active:bg-paper-deep'
            }`}>
            <Text
              className={`font-mono text-[12px] ${window === w ? 'font-semibold text-ink' : 'text-ink-secondary'}`}>
              {w}d
            </Text>
          </Pressable>
        ))}
      </View>

      {daysWithEnergy === 0 ? (
        <Text className="mt-6 text-[13px] leading-5 text-ink-muted">
          No energy logged in the last {window} days. Log meals with calories and the trend fills in
          here.
        </Text>
      ) : (
        <>
          {/* Averages over days that recorded each metric + the kcal sparkline. */}
          <View className="mt-6">
            <SectionLabel>Daily average</SectionLabel>
            <View className="mt-2 rounded-card border border-hairline bg-porcelain p-4">
              <View className="flex-row items-end justify-between">
                <View className="flex-row items-baseline gap-1.5">
                  <Text className="font-mono text-4xl text-ink">{fmtInt(avgKcal)}</Text>
                  <Text className="font-mono text-sm text-ink-muted">kcal/day</Text>
                </View>
                <Sparkline data={kcalSeries} width={96} height={32} baseline="zero" />
              </View>
              <View className="mt-4 flex-row gap-4 border-t border-hairline-soft pt-4">
                <AvgCell label="Protein" value={avgProtein} unit="g" />
                <AvgCell label="Carbs" value={avgCarbs} unit="g" />
                <AvgCell label="Fat" value={avgFat} unit="g" />
              </View>
              <Text className="mt-3 font-mono text-[11px] text-ink-muted">
                {daysWithEnergy} of {days.length} days with energy logged
              </Text>
            </View>
          </View>

          {/* Per-day list, newest first, with each day's own kcal target. */}
          <View className="mt-8">
            <SectionLabel>By day</SectionLabel>
            <View className="mt-1">
              {recent.map((d, index) => {
                const kcalTarget = d.target?.kcal ?? null;
                const pct =
                  kcalTarget && kcalTarget > 0 ? Math.min(100, (d.kcal / kcalTarget) * 100) : null;
                return (
                  <View
                    key={d.date}
                    className={`flex-row items-center gap-3 py-3 ${
                      index === 0 ? '' : 'border-t border-hairline-soft'
                    }`}>
                    <Text className="w-14 font-mono text-[12px] text-ink-muted">
                      {shortDate(d.date)}
                    </Text>
                    <View className="flex-1">
                      {d.mealCount === 0 ? (
                        <Text className="font-mono text-[12px] text-ink-muted">no meals</Text>
                      ) : (
                        <>
                          <View className="flex-row items-baseline gap-1">
                            <Text className="font-mono text-[14px] text-ink">{fmtInt(d.kcal)}</Text>
                            <Text className="font-mono text-[11px] text-ink-muted">
                              {kcalTarget ? `/ ${fmtInt(kcalTarget)}` : 'kcal'}
                            </Text>
                          </View>
                          {pct !== null ? (
                            <View className="mt-1.5 h-1 overflow-hidden rounded-full bg-hairline">
                              <View
                                className="h-1 rounded-full bg-ink-secondary"
                                style={{ width: `${pct}%` }}
                              />
                            </View>
                          ) : null}
                        </>
                      )}
                    </View>
                    <Text className="font-mono text-[11px] text-ink-muted">
                      {d.mealCount > 0
                        ? `P${Math.round(d.protein_g)} C${Math.round(d.carbs_g)} F${Math.round(d.fat_g)}`
                        : ''}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>
        </>
      )}
    </Screen>
  );
}
