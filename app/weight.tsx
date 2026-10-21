import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { DailyTrendChart } from '@/components/ui/trend-chart';
import {
  dailyMeans,
  latestAverage,
  TREND_WINDOW_DAYS,
  trailingAverageSeries,
  type TrendPoint,
} from '@/lib/charts/moving-average';
import { getDb } from '@/lib/db/client';
import { localDaysList, logicalDate, todayISODate } from '@/lib/db/date';
import { bodySeries, latestBody } from '@/lib/db/repositories/body';
import { getPreferences } from '@/lib/db/repositories/user';
import { shortDate } from '@/lib/experiments/format';
import { metricByBodyColumn, resolveDisplay, roundToSpec } from '@/lib/log/metrics';

/**
 * **The weight record** — what sits behind the Data tab's Weight trend row
 * (item 84, owner's second chart, 2026-10-21: *weight with a 7-day trendline*).
 *
 * Until now that row opened the keypad (app/metric-entry.tsx), which is a
 * write-only instrument and deliberately cannot scroll — there was no screen
 * weight could be READ on beyond a 58pt sparkline. This is that screen, on
 * Water's precedent (app/water.tsx): the trend row opens the record, and the
 * record carries the way to add to it. The Log tab's Weight tile still opens
 * the keypad directly — capturing is the Log tab's job and stays one tap.
 *
 * ## What is drawn
 *
 * The daily weigh-ins of the last {@link WEIGHT_DAYS} days as dots, and the
 * trailing 7-day average as a line through them (src/lib/charts/moving-average.ts
 * — calendar window, three readings minimum, a gap rather than a guess). A day
 * with two weigh-ins is drawn as their mean, bucketed by the LOGICAL day. All of
 * it in the user's display unit; storage stays canonical kg.
 *
 * ## The surface system
 *
 * The latest reading is a **measured field** — a verdict about a number, like
 * the keypad's readout. The chart is a **ruled plate**: a record. One accent,
 * `Log weight`, the screen's one action. No signal colour: a weight is a
 * measurement, not a graded state (the firewall, 00-design-spec.md §2).
 */

/** The charted window — the same 30 days the Data row's sparkline covers. */
const WEIGHT_DAYS = 30;

type WeightRecord = {
  unit: string;
  decimals: number;
  points: TrendPoint[];
  latest: { value: number; date: string } | null;
};

function readWeight(): WeightRecord {
  const db = getDb();
  const units = getPreferences(db).units;
  const metric = metricByBodyColumn('weight_kg');
  const spec = metric ? resolveDisplay(metric, units) : null;
  const toDisplay = (kg: number) => (spec ? spec.fromCanonical(kg) : kg);
  // The window plus the six days before it, so the first average is whole.
  const raw = bodySeries(db, 'weight_kg', WEIGHT_DAYS + TREND_WINDOW_DAYS);
  const daily = dailyMeans(
    raw.map((p) => ({ measuredAt: p.measuredAt, value: toDisplay(p.value) }))
  );
  const latest = latestBody(db, 'weight_kg');
  return {
    unit: spec?.unit ?? 'kg',
    decimals: spec?.decimals ?? 1,
    points: trailingAverageSeries(daily, localDaysList(todayISODate(), WEIGHT_DAYS)),
    latest: latest
      ? {
          value: spec ? roundToSpec(spec, toDisplay(latest.value)) : latest.value,
          date: logicalDate(new Date(latest.measuredAt)),
        }
      : null,
  };
}

export default function WeightScreen() {
  const router = useRouter();
  const [record, setRecord] = useState(readWeight);
  // Re-read on focus: the keypad this screen opens writes, then comes back here.
  useFocusEffect(useCallback(() => setRecord(readWeight()), []));

  const fmt = (v: number) => v.toFixed(record.decimals);
  const avg = latestAverage(record.points);
  const weighIns = record.points.filter((p) => p.value !== null).length;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Weight" parent="Data" />
      </View>

      <View className="mt-5">
        <Block device="field">
          {record.latest ? (
            <View>
              <View className="flex-row items-baseline gap-2">
                <Text className="font-mono text-5xl font-semibold text-ink">
                  {fmt(record.latest.value)}
                </Text>
                <Text className="font-mono text-lg text-ink-muted">{record.unit}</Text>
              </View>
              <Text className="mt-1 font-mono text-[11px] text-ink-muted">
                {`Latest · ${shortDate(record.latest.date)}`}
                {avg !== null ? ` · ${TREND_WINDOW_DAYS}-day avg ${fmt(avg)} ${record.unit}` : ''}
              </Text>
            </View>
          ) : (
            <Text className="font-serif text-[15px] leading-6 text-ink-secondary">
              No weight logged yet.
            </Text>
          )}
        </Block>
      </View>

      <View className="mt-7">
        <Block device="plate">
          <SectionLabel
            label={`Last ${WEIGHT_DAYS} days`}
            note={`${weighIns} weigh-in${weighIns === 1 ? '' : 's'}`}
          />
          <DailyTrendChart
            points={record.points}
            format={fmt}
            unit={record.unit}
            name="Weight"
            height={140}
            testID="trend-chart-weight"
          />
        </Block>
      </View>

      {/* The screen's one accent: the way to add to the record. The keypad's
          back control names this screen, as it names Data from there. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Log weight"
        onPress={() =>
          router.push({ pathname: '/metric-entry', params: { metric: 'weight', from: 'Weight' } })
        }
        className="mt-7 min-h-[48px] items-center justify-center rounded-btn border-[1.4px] border-pine-deep bg-pine active:opacity-70">
        <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-pine-on">
          Log weight
        </Text>
      </Pressable>
    </Screen>
  );
}
