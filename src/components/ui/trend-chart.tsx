import { Text, View } from 'react-native';

import {
  ChartDot,
  ChartFrame,
  ChartLegend,
  ChartLine,
  type ChartSurface,
} from '@/components/ui/chart';
import { linePath, paddedDomain } from '@/lib/charts/geometry';
import {
  TREND_MIN_READINGS,
  TREND_WINDOW_DAYS,
  type TrendPoint,
} from '@/lib/charts/moving-average';
import { shortDate } from '@/lib/experiments/format';

/**
 * **Daily readings with a 7-day trendline** — the one idiom the weight record and
 * the HRV / resting-HR trends share (items 84 and 95, 2026-10-21). Dots for the
 * days that have a reading, a 2pt ink line for the trailing average
 * (src/lib/charts/moving-average.ts), breaking where the window is too thin to
 * average honestly. Built entirely from src/components/ui/chart.tsx.
 *
 * The y-axis is the series' own range, not zero-based: these are interval
 * readings that cluster far from zero (82.4 kg, 48 ms), and a zero baseline would
 * flatten exactly the change the chart exists to show. The gutter labels state
 * the range's two ends in the reading's own unit, so the scale is never implicit.
 *
 * No signal colour, anywhere: a trend of HRV is a measurement, not a graded
 * state (the firewall, 00-design-spec.md §2). The newest reading is inked full;
 * the rest sit back in `ink-muted`, the sparkline's own "which end is now" cue.
 */
export function DailyTrendChart({
  points,
  format,
  unit,
  name,
  height = 110,
  surface = 'paperHi',
  testID,
}: {
  /** Oldest → newest, one per calendar day of the axis. */
  points: TrendPoint[];
  /** A value in the reading's display unit → its figure, without the unit. */
  format: (value: number) => string;
  unit: string;
  /** What is plotted, for the spoken label — "Weight", "HRV". */
  name: string;
  height?: number;
  surface?: ChartSurface;
  testID?: string;
}) {
  const readings = points.filter((p) => p.value !== null).length;
  if (readings < 2) {
    return (
      <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
        {readings === 0
          ? 'No readings in this window yet.'
          : 'One reading so far — a trend needs at least two.'}
      </Text>
    );
  }

  const values = points.map((p) => p.value);
  const averages = points.map((p) => p.average);
  const domain = paddedDomain([...values, ...averages]) ?? ([0, 1] as const);
  const present = values.filter((v): v is number => v !== null);
  const lo = Math.min(...present);
  const hi = Math.max(...present);
  const yTicks =
    lo === hi
      ? [{ at: lo, label: format(lo) }]
      : [
          { at: hi, label: format(hi) },
          { at: lo, label: format(lo) },
        ];
  const last = points.length - 1;
  const mid = Math.floor(last / 2);
  const xTicks = [0, mid, last].map((i) => ({ at: i, label: shortDate(points[i]!.date) }));

  let newest = -1;
  for (let i = last; i >= 0; i--) {
    if (points[i]!.value !== null) {
      newest = i;
      break;
    }
  }
  let latestAvg: number | null = null;
  for (let i = last; i >= 0; i--) {
    if (points[i]!.average !== null) {
      latestAvg = points[i]!.average;
      break;
    }
  }
  const spoken =
    `${name}, ${readings} readings over ${points.length} days, from ${format(lo)} to ${format(hi)} ${unit}` +
    (latestAvg !== null
      ? `. Seven-day average ${format(latestAvg)} ${unit}.`
      : `. Not enough readings for a seven-day average yet.`);

  return (
    <View className="mt-2">
      <ChartFrame
        height={height}
        xDomain={[0, Math.max(1, last)]}
        yDomain={domain}
        xTicks={xTicks}
        yTicks={yTicks}
        surface={surface}
        accessibilityLabel={spoken}
        testID={testID}>
        {(scale) => (
          <>
            <ChartLine
              d={linePath(
                points.map((p, i) => ({ x: i, y: p.average })),
                scale.x,
                scale.y
              )}
            />
            {points.map((p, i) =>
              p.value === null ? null : (
                <ChartDot
                  key={p.date}
                  scale={scale}
                  x={i}
                  y={p.value}
                  tone={i === newest ? 'ink' : 'muted'}
                  r={i === newest ? 4 : 3}
                />
              )
            )}
          </>
        )}
      </ChartFrame>
      <ChartLegend
        items={[
          { key: 'dot', label: 'Daily' },
          { key: 'measured', label: `${TREND_WINDOW_DAYS}-day average` },
        ]}
      />
      {latestAvg === null ? (
        <Text className="mt-1 font-serif text-[12px] leading-5 text-ink-muted">
          The average draws once a week holds {TREND_MIN_READINGS} readings.
        </Text>
      ) : null}
    </View>
  );
}
