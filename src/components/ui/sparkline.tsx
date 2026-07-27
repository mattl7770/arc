import { View } from 'react-native';

type SparklineProps = {
  data: number[];
  width?: number;
  height?: number;
  /**
   * How bar heights scale. 'zero' (default) anchors at zero — right for counts
   * and durations (kcal, Zone-2 minutes, symptom counts), where a bar's height
   * is proportional to the value. 'auto' scales to the series' own min..max —
   * needed for interval metrics like weight that cluster far from zero and would
   * otherwise render as a flat block of near-full-height bars.
   */
  baseline?: 'zero' | 'auto';
};

/**
 * Dependency-free mini bar chart (react-native-svg is not installed, and this
 * intentionally stays that way). A flex row of thin bars — a glance-able trend,
 * not a chart meant to be read closely.
 *
 * Two robustness rules the naive version got wrong:
 *  - It caps the bar count to what fits legibly in `width` (downsampling by
 *    bucket-average), so a 30-point daily series doesn't collapse into sub-pixel
 *    slivers or overflow the container.
 *  - `baseline='auto'` scales to the series range so an interval metric (weight)
 *    shows its shape instead of a flat block.
 *
 * Degenerates to a single faint baseline when there's nothing to compare (fewer
 * than two points, or no spread) rather than drawing a misleading flat set of
 * full-height bars.
 */
export function Sparkline({ data, width = 58, height = 24, baseline = 'zero' }: SparklineProps) {
  // ~4px per bar (body + gap) is the legibility floor; downsample past that.
  const maxBars = Math.max(1, Math.floor(width / 4));
  const bars = downsample(data, maxBars);

  const max = bars.length > 0 ? Math.max(...bars) : 0;
  const min = bars.length > 0 ? Math.min(...bars) : 0;
  const floor = baseline === 'auto' ? min : 0;
  const span = max - floor;

  if (bars.length < 2 || span <= 0) {
    return (
      <View style={{ width, height }} className="justify-center">
        <View className="h-px rounded-[1px] bg-hairline" />
      </View>
    );
  }

  return (
    <View style={{ width, height }} className="flex-row items-end gap-px">
      {bars.map((value, index) => (
        <View
          key={index}
          style={{ height: Math.max(1, Math.round(((value - floor) / span) * height)) }}
          className="flex-1 rounded-[1px] bg-ink-secondary"
        />
      ))}
    </View>
  );
}

/**
 * Reduce `data` to at most `maxBars` points by averaging contiguous buckets,
 * preserving the series' overall shape and order. A no-op when it already fits.
 */
function downsample(data: number[], maxBars: number): number[] {
  if (data.length <= maxBars) return data;
  const out: number[] = [];
  const bucket = data.length / maxBars;
  for (let i = 0; i < maxBars; i++) {
    const start = Math.floor(i * bucket);
    const end = Math.floor((i + 1) * bucket);
    let sum = 0;
    let n = 0;
    for (let j = start; j < end && j < data.length; j++) {
      sum += data[j]!;
      n++;
    }
    out.push(n > 0 ? sum / n : 0);
  }
  return out;
}
