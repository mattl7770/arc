/**
 * The arithmetic under every chart in ARC — scales and path strings, and
 * nothing that knows what is being drawn (items 84 and 95, 2026-10-21).
 *
 * Pure and native-free so the headless suite can pin it (db/charts.test.mjs);
 * the drawing itself is src/components/ui/chart.tsx, which feeds these strings to
 * `react-native-svg`. Three charts use it today — the Eat tab's intake by hour,
 * the weight record and the HRV / resting-HR trends — and none of them owns any
 * geometry of its own, which is the point of having one primitive set rather
 * than three bespoke charts.
 *
 * Coordinates are rounded to one decimal in the path strings: a point is a
 * third of a device pixel at @3x, so more digits are bytes and nothing else.
 */

export type Domain = readonly [number, number];

/** One point of a series. A `null` y is a GAP — the line breaks there rather
 *  than bridging two readings across a stretch with none. */
export type ChartPoint = { x: number; y: number | null };

/**
 * `domain` → `range`, linearly. A degenerate domain (every value the same)
 * maps to the middle of the range rather than dividing by zero — a flat series
 * is drawn as a flat line through the middle, which is what it is.
 */
export function linearScale(domain: Domain, range: Domain): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (!Number.isFinite(span) || span === 0) {
    const mid = (r0 + r1) / 2;
    return () => mid;
  }
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

function fmt(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/**
 * A polyline through `points`, broken at every gap: each run of consecutive
 * non-null points opens with its own `M`. A run of ONE point draws nothing — a
 * line needs two ends, and a lone reading is the dots' job, not the line's.
 */
export function linePath(
  points: ChartPoint[],
  sx: (x: number) => number,
  sy: (y: number) => number
): string {
  const parts: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 2) parts.push(run.join(' '));
    run = [];
  };
  for (const point of points) {
    if (point.y === null || !Number.isFinite(point.y)) {
      flush();
      continue;
    }
    run.push(`${run.length === 0 ? 'M' : 'L'}${fmt(sx(point.x))} ${fmt(sy(point.y))}`);
  }
  flush();
  return parts.join(' ');
}

/**
 * A STEP line: flat until the next point, then straight up (or down) to it — the
 * shape of a running total, which holds its value between meals and jumps when
 * one is eaten. A diagonal between two meals would claim food was being eaten
 * continuously across the afternoon. A running total has no gaps, so none are
 * supported; a non-finite point is skipped.
 */
export function stepPath(
  points: { x: number; y: number }[],
  sx: (x: number) => number,
  sy: (y: number) => number
): string {
  const finite = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (finite.length < 2) return '';
  const [first, ...rest] = finite;
  let d = `M${fmt(sx(first!.x))} ${fmt(sy(first!.y))}`;
  for (const point of rest) {
    d += ` H${fmt(sx(point.x))} V${fmt(sy(point.y))}`;
  }
  return d;
}

/**
 * A y-domain for a series that clusters away from zero (weight, HRV, resting
 * HR): its own min..max, padded by `pad` of the span on each side so no mark
 * sits on the frame. A flat series gets a band of ±1 around its value; an empty
 * one gets null — no data, no axis.
 */
export function paddedDomain(values: (number | null)[], pad = 0.15): Domain | null {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return null;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min;
  if (span === 0) return [min - 1, max + 1];
  return [min - span * pad, max + span * pad];
}
