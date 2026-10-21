import { createContext, useContext, useState, type ReactNode } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { palette } from '@/constants/theme';
import { linearScale, type Domain } from '@/lib/charts/geometry';
import type { SignalLevel } from '@/types/home';

/**
 * **The chart primitives** — one frame, one band, one line, one rule, one dot and
 * a legend, and every chart in ARC is drawn out of these (items 84 and 95,
 * 2026-10-21). The Eat tab's intake by hour, the weight record and the HRV /
 * resting-HR trends are three arrangements of this file, not three charts.
 *
 * `react-native-svg` 15.15.4 has been in the binary since the owner's 2026-08-25
 * EAS build (the body figure, src/lib/exercise/figure.ts, is drawn with it), so a
 * line is a `<Path>` and not a stack of `View`s. The arithmetic is pure and lives
 * in src/lib/charts/geometry.ts; this file only inks it.
 *
 * ## The marks (the dataviz method, in this design's tokens)
 *
 *   - **Lines are 2pt ink** for what was measured — the running total, the
 *     trailing average. One weight, one ink, so the eye trusts them equally.
 *   - **An expectation is DASHED, 1.5pt `ink-secondary`.** Dashes are the
 *     convention for a projection, and the expected-by-hour curve is exactly
 *     that: a statement about what a usual day does, never a reading. It is the
 *     only dashed stroke in the set; grid and axes stay solid.
 *   - **The band is a wash of `paper-deep`** — a ground, not a mark, like the
 *     macro bars' rail. The ±10% range is a place a value can sit inside.
 *   - **Grid rules are `paper-deep` hairlines**, one step off the sheet and solid.
 *   - **Dots carry a 2pt ring in the surface colour**, so a dot sitting on a line
 *     stays a dot.
 *   - **Text never wears a data colour.** Tick labels are 10pt mono
 *     `ink-muted` — measurements, so mono — drawn as React Native `Text` beside
 *     the SVG rather than inside it, so they take the app's own type voices.
 *
 * ## The firewall (00-design-spec.md §2)
 *
 * Nothing here is coloured by default. A trend of HRV or weight is a
 * measurement, not a graded state, so it is ink. The ONE coloured mark in the
 * set is a {@link ChartDot} handed a `SignalLevel`, which fills with the macro
 * bars' own `bar` cut — the Eat tab's "now" dot carries the same verdict the
 * kcal bar above it already wears (FB2), and cannot invent another. There is no
 * colour prop, so no caller can hand a chart the accent.
 *
 * ## Sizing
 *
 * The frame measures its own width on layout and starts from a phone-sized
 * default, so the first paint (and a server render in the headless suite) draws
 * a real chart rather than nothing. The y-tick labels sit in a gutter to the
 * right of the plot, where the newest data is — they label what you are
 * reading, at the end you read last.
 */

const DEFAULT_WIDTH = 320;
/** Room inside the plot for a dot's radius + ring at the edge. */
const INSET = 6;
/** The right-hand gutter the y-tick labels sit in. */
const Y_GUTTER = 40;

export type ChartScale = {
  x: (value: number) => number;
  y: (value: number) => number;
  /** The plot's own pixel bounds (inside the inset, left of the gutter). */
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type ChartTick = { at: number; label: string };

/** The surface a chart sits on — what a dot's ring is cut from. The grid
 *  device draws no ground (the sheet shows through); a plate is `paper-hi`. */
export type ChartSurface = 'paper' | 'paperHi';

const SurfaceContext = createContext<ChartSurface>('paperHi');

export function ChartFrame({
  height,
  xDomain,
  yDomain,
  xTicks,
  yTicks,
  surface = 'paperHi',
  accessibilityLabel,
  testID,
  children,
}: {
  height: number;
  xDomain: Domain;
  yDomain: Domain;
  /** Labels under the plot. Omit on a chart stacked above another that has them. */
  xTicks?: ChartTick[];
  /** Labels in the right gutter, each with a solid hairline across the plot. */
  yTicks?: ChartTick[];
  surface?: ChartSurface;
  /** The chart's reading in words — VoiceOver gets the sentence, not the picture. */
  accessibilityLabel: string;
  testID?: string;
  children: (scale: ChartScale) => ReactNode;
}) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next > 0 && next !== width) setWidth(next);
  };
  const left = INSET;
  const right = Math.max(left + 1, width - Y_GUTTER - INSET);
  const top = INSET;
  const bottom = Math.max(top + 1, height - INSET);
  const scale: ChartScale = {
    x: linearScale(xDomain, [left, right]),
    y: linearScale(yDomain, [bottom, top]),
    left,
    right,
    top,
    bottom,
  };

  return (
    <View
      onLayout={onLayout}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      testID={testID}>
      <View style={{ height }}>
        <Svg width={width} height={height}>
          {(yTicks ?? []).map((tick) => (
            <Line
              key={`grid-${tick.at}`}
              x1={left}
              x2={right}
              y1={scale.y(tick.at)}
              y2={scale.y(tick.at)}
              stroke={palette.paperDeep}
              strokeWidth={1}
            />
          ))}
          <SurfaceContext.Provider value={surface}>{children(scale)}</SurfaceContext.Provider>
        </Svg>
        {(yTicks ?? []).map((tick) => (
          <Text
            key={`y-${tick.at}`}
            numberOfLines={1}
            style={{ position: 'absolute', left: right + 6, top: scale.y(tick.at) - 7, width: 38 }}
            className="font-mono text-[10px] text-ink-muted">
            {tick.label}
          </Text>
        ))}
      </View>
      {xTicks && xTicks.length > 0 ? (
        <View style={{ height: 14 }} className="mt-1">
          {xTicks.map((tick) => (
            <Text
              key={`x-${tick.at}`}
              numberOfLines={1}
              style={{
                position: 'absolute',
                left: Math.min(Math.max(0, scale.x(tick.at) - 20), width - 40),
                width: 40,
                textAlign: 'center',
              }}
              className="font-mono text-[10px] text-ink-muted">
              {tick.label}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A horizontal band between two values, across the whole plot — the ±10% range. */
export function ChartBand({ scale, y0, y1 }: { scale: ChartScale; y0: number; y1: number }) {
  const top = Math.min(scale.y(y0), scale.y(y1));
  const bottom = Math.max(scale.y(y0), scale.y(y1));
  return (
    <Rect
      x={scale.left}
      y={top}
      width={Math.max(0, scale.right - scale.left)}
      height={Math.max(0, bottom - top)}
      fill={palette.paperDeep}
      fillOpacity={0.55}
    />
  );
}

export type LineVariant = 'measured' | 'expected';

/** A path from src/lib/charts/geometry.ts. `measured` is solid 2pt ink;
 *  `expected` is the dashed projection. An empty path draws nothing. */
export function ChartLine({ d, variant = 'measured' }: { d: string; variant?: LineVariant }) {
  if (d === '') return null;
  return variant === 'expected' ? (
    <Path
      d={d}
      fill="none"
      stroke={palette.inkSecondary}
      strokeWidth={1.5}
      strokeDasharray="4 3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ) : (
    <Path
      d={d}
      fill="none"
      stroke={palette.ink}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

/** A full-height or full-width rule at one value. `now` is the vertical
 *  marker for this instant; `goal` is the target across the plot. */
export function ChartRule({
  scale,
  x,
  y,
  tone,
}: {
  scale: ChartScale;
  x?: number;
  y?: number;
  tone: 'now' | 'goal';
}) {
  const stroke = tone === 'goal' ? palette.inkSecondary : palette.inkMuted;
  if (x !== undefined) {
    const px = scale.x(x);
    return (
      <Line x1={px} x2={px} y1={scale.top} y2={scale.bottom} stroke={stroke} strokeWidth={1} />
    );
  }
  if (y !== undefined) {
    const py = scale.y(y);
    return (
      <Line x1={scale.left} x2={scale.right} y1={py} y2={py} stroke={stroke} strokeWidth={1} />
    );
  }
  return null;
}

/** The fill a dot takes. A `SignalLevel` takes the macro bars' `bar` cut — the
 *  one coloured mark in this file, and only a verdict computed elsewhere. */
function dotFill(tone: SignalLevel | 'ink' | 'muted'): string {
  switch (tone) {
    case 'ink':
      return palette.ink;
    case 'muted':
      return palette.inkMuted;
    case 'unknown':
      return palette.signalInk.unknown;
    default:
      return palette.signalBar[tone];
  }
}

export function ChartDot({
  scale,
  x,
  y,
  tone = 'ink',
  r = 4,
}: {
  scale: ChartScale;
  x: number;
  y: number;
  tone?: SignalLevel | 'ink' | 'muted';
  r?: number;
}) {
  const surface = useContext(SurfaceContext);
  return (
    <Circle
      cx={scale.x(x)}
      cy={scale.y(y)}
      r={r}
      fill={dotFill(tone)}
      stroke={surface === 'paper' ? palette.paper : palette.paperHi}
      strokeWidth={2}
    />
  );
}

export type LegendKey = 'measured' | 'expected' | 'band' | 'dot';

/**
 * The legend — always present where a chart carries two or more series, so no
 * series is identified by stroke alone. Keys are filled views, never a
 * one-sided border (src/components/ui/block.tsx explains why). Label voice for
 * the names: they say what a mark IS, not how much.
 */
export function ChartLegend({ items }: { items: { key: LegendKey; label: string }[] }) {
  return (
    <View className="mt-2 flex-row flex-wrap gap-x-4 gap-y-1">
      {items.map((item) => (
        <View key={item.label} className="flex-row items-center gap-1.5">
          <LegendSwatch kind={item.key} />
          <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            {item.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function LegendSwatch({ kind }: { kind: LegendKey }) {
  switch (kind) {
    case 'measured':
      return <View className="h-[2px] w-[14px] bg-ink" />;
    case 'expected':
      return (
        <View className="w-[14px] flex-row gap-[2px]">
          <View className="h-[1.5px] w-[4px] bg-ink-secondary" />
          <View className="h-[1.5px] w-[4px] bg-ink-secondary" />
          <View className="h-[1.5px] w-[2px] bg-ink-secondary" />
        </View>
      );
    case 'band':
      return <View className="h-[8px] w-[14px] bg-paper-deep" />;
    case 'dot':
      return <View className="h-[6px] w-[6px] rounded-full bg-ink-muted" />;
  }
}
