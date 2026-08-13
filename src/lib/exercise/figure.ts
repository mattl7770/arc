/**
 * The body figure's geometry — pure data plus a scanline rasteriser. No React,
 * no SVG.
 *
 * ## Three rounds, and what each one got wrong
 *
 * **2026-08-11** drew sixteen floating rounded boxes and a ring for a head.
 * Verdict off hardware: *"pretty rough and hard to tell what's what"*. There was
 * no BODY — a cell means "quads" only because of where it sits on a person.
 *
 * **2026-08-12 (a)** added a nineteen-rect silhouette under the same sixteen
 * cells and drew it twice (inflated in ink, then true-size) so the rects fused
 * into one contoured outline. Better, still rejected: *"Muscle recovery graphic
 * still looks terrible."* Thirty-four AXIS-ALIGNED RECTANGLES do not read as
 * muscles no matter what you put behind them, and two discrete marks in two
 * brown-ish signal colours are not a recovery reading.
 *
 * **2026-08-12 (b), this file.** Owner brief, with a reference image: contoured
 * organic shapes — *"pectorals as fans, the rectus abdominis as a segmented
 * six-pack grid, deltoids as rounded caps, biceps as spindles, quadriceps as
 * long tapered masses with the vastus lateralis/medialis split visible, calves
 * as twin bellies, lats as tapering wings, traps as a diamond yoke"* — filled
 * with ONE hue at varying opacity, with head, hands and feet in a neutral grey
 * so they read as "not data".
 *
 * ## Still no SVG. Two primitives instead.
 *
 * `react-native-svg` is not installed and is not going in — a native module
 * costs the owner a fresh EAS cloud build (01-rn-port-guide.md §5), and the
 * entire value of this change is that it ships over-the-air onto the binary he
 * already has. So every mark is a filled `View`, and contour comes from two
 * primitives chosen per shape by which one draws it better, not by which one is
 * more elegant:
 *
 *   {@link Blob}  one `View`: a rect with FOUR INDEPENDENT corner radii. Free
 *                 antialiased curves, one node. This is the right primitive
 *                 wherever the shape is a rounded mass rather than a taper — a
 *                 bicep spindle (a capsule *is* a spindle), a glute, an ab
 *                 segment, a calf belly, a hand, the skull.
 *
 *   {@link Poly}  a polygon in grid units, RASTERISED at render time into
 *                 horizontal scanline bars ({@link polyBars}) — one thin
 *                 absolutely-positioned `View` per row, its left edge and width
 *                 following the outline at that y. This is what draws a taper:
 *                 a lat narrowing toward the waist, a pec fanning off the
 *                 sternum, a quad sweeping outward then back in. The end bars
 *                 take a `borderRadius` cap so the shape closes with a dome
 *                 rather than a chopped edge.
 *
 * A blob costs 1 view and a poly costs one view per bar, twice over (the ink
 * outline is an inflated copy — see below), so the split is also the cost
 * control. {@link figureViewCount} reports the real number and
 * db/exercise-ai.test.mjs asserts a budget against it, because this drawing
 * renders inside two scrolling screens.
 *
 * ## Bar count is adaptive, and that is not a nicety
 *
 * The same geometry renders at 72pt (exercise-detail, beside a photo), 118pt
 * (the Exercise hub) and 128pt (the pushed screen). A fixed bar count would be
 * either jagged at the big size or wasteful at the small one, so
 * {@link barsFor} targets a CONSTANT RENDERED BAR HEIGHT of
 * {@link BAR_POINTS}pt and clamps to [{@link MIN_BARS}, {@link MAX_BARS}].
 *
 * ## Coordinates
 *
 * A 100 × 240 design grid, origin top-left; the component scales it to the
 * available width. Left/right pairs are two shapes sharing one muscle — a
 * freshness score fills both.
 */
import type { Muscle } from './types';

export type FigureSide = 'front' | 'back';

/** A point in grid units. */
export type Pt = readonly [number, number];

/** A rect in grid units, origin top-left of the figure box. */
export type FigureRect = { x: number; y: number; w: number; h: number };

/** Corner radii in grid units, CSS order: top-left, top-right, bottom-right, bottom-left. */
export type Radii = readonly [number, number, number, number];

/** A rounded mass: one `View`, four independent corner radii, no rasterising. */
export type Blob = FigureRect & { kind: 'blob'; r: Radii };

/** A contoured shape: a closed polygon, rasterised into scanline bars. */
export type Poly = { kind: 'poly'; pts: readonly Pt[] };

export type Shape = Blob | Poly;

/**
 * One block of the body ground. `neutral` marks the parts that carry NO reading
 * — head, hands, feet — which the component fills in a flat grey instead of the
 * muscle ground, so the eye learns which regions are data before reading any.
 */
export type FigureBodyPart = { part: string; neutral?: boolean; shape: Blob };

/** One muscle's shape on one side. A muscle may have several. */
export type FigureMuscleShape = { muscle: Muscle; side: FigureSide; shape: Shape };

/** The design grid the figure is placed on. */
export const FIGURE_GRID = { w: 100, h: 240 } as const;

/**
 * How far the body's ink contour is inflated past its fill, in grid units. The
 * body is drawn TWICE — every block inflated by this in ink, then every block
 * at true size in the ground colour — so wherever a block has no neighbour one
 * unit of ink survives as the silhouette's outline, and wherever two blocks
 * abut (they overlap at every joint on purpose) the neighbour's fill covers the
 * inflation and no internal seam is drawn. One list of blocks, two `map`s.
 */
export const BODY_OUTLINE = 1;

/**
 * The ink line around each MUSCLE, in grid units — a `borderWidth` on a blob
 * (uniform on all four edges, the only legal border shape in this codebase) and
 * an inflated bar copy under a poly.
 *
 * It is load-bearing rather than decorative. The fill carries freshness as
 * OPACITY, so a spent muscle is pale by construction and cannot be relied on to
 * show its own edge; the ink line is what keeps the contour readable at every
 * point of the ramp (9.74:1 on the ground it encloses). Without it the floor
 * would have to be raised so far that fresh and spent stopped separating.
 */
export const MUSCLE_OUTLINE = 0.55;

/**
 * The alpha a fully-SPENT muscle still draws at — the floor of the freshness
 * ramp, and the number that stops the encoding from punching holes in the body.
 *
 * ## Which way the ramp runs (owner, 2026-08-12)
 *
 * *"the color opacity showing how fresh"* — so **full green is fresh and faded
 * is spent**, and the scale beside the figure prints both ends in words because
 * a ramp with no stated direction is a ramp anyone can read backwards.
 *
 * ## Why 0.45 and not 0
 *
 * The fill is `signal-optimal-ink` #185A36 composited over the `paper-deep`
 * #C6C1B0 body ground. Measured on the `paper-hi` plate the figure sits on:
 *
 *   freshness   alpha   composite   vs plate   vs body ground
 *      0        0.45     #78936F     3.03:1        1.87:1
 *     50        0.725    #487658     4.72:1        2.90:1
 *    100        1.00     #185A36     7.41:1        4.56:1
 *
 * 0.45 is the lowest floor at which a spent muscle still clears WCAG 1.4.11's
 * 3:1 for a graphical object against the sheet it is drawn on. Below it the
 * spent end fades toward the ground and the body starts reading as if pieces
 * were missing rather than depleted. The two ENDS of the ramp measure 2.45:1
 * against each other — a plainly visible difference, and forty times the 1.03:1
 * that separated the two marks this figure replaced.
 *
 * The floor is not what makes a spent muscle legible on its own, though: the
 * ink line around every shape ({@link MUSCLE_OUTLINE}) is, at 9.74:1. The floor
 * is what stops the FILL from disappearing inside it.
 */
export const MUSCLE_ALPHA_FLOOR = 0.45;

/** Freshness 0-100 → the fill alpha it draws at. Monotone, floored, never 0. */
export function freshnessAlpha(freshness: number): number {
  const f = Math.max(0, Math.min(100, Number.isFinite(freshness) ? freshness : 0));
  return MUSCLE_ALPHA_FLOOR + (1 - MUSCLE_ALPHA_FLOOR) * (f / 100);
}

/** The rendered height one scanline bar aims for, in points. */
export const BAR_POINTS = 4.4;
export const MIN_BARS = 3;
export const MAX_BARS = 12;

/**
 * The body ground — head to feet, shared by both views.
 *
 * Blocks OVERLAP AT EVERY JOINT on purpose (the neck into the skull and the
 * torso, the waist into both, the calf into the thigh) so the inflated ink pass
 * fuses into ONE outline instead of drawing a seam at every join. Where a gap is
 * wanted it is explicit: 3 units of armpit between each arm and the torso, 2
 * units of crotch between the thighs.
 *
 * Proportions are a standing figure of about eight heads, arms at the sides —
 * shoulders at y 34, navel at 96, hips at 116, knee at 176, ankle at 226.
 *
 * `neutral` marks the parts that carry NO reading. In the owner's reference the
 * head, hands and feet are grey while every muscle is on the colour ramp, and
 * that split is most of why the reference is legible: it tells the eye which
 * regions are data before it has read any of them.
 */
export const FIGURE_BODY: FigureBodyPart[] = [
  {
    part: 'head',
    neutral: true,
    shape: { kind: 'blob', x: 38, y: 2, w: 24, h: 28, r: [12, 12, 11, 11] },
  },
  // The neck starts high enough that the skull's ROUND fill still spans its
  // outline where the two meet — a straight-sided neck butted against a curved
  // skull leaves a nub of contour at each side otherwise.
  { part: 'neck', shape: { kind: 'blob', x: 44, y: 26, w: 12, h: 11, r: [0, 0, 2, 2] } },
  // Top radius 7, not more: the front deltoids ride the shoulder's outer corner,
  // and a rounder shoulder would leave them hanging off the torso's fill.
  { part: 'torso', shape: { kind: 'blob', x: 27, y: 34, w: 46, h: 50, r: [7, 7, 3, 3] } },
  { part: 'waist', shape: { kind: 'blob', x: 32, y: 81, w: 36, h: 27, r: [3, 3, 5, 5] } },
  { part: 'pelvis', shape: { kind: 'blob', x: 29, y: 104, w: 42, h: 22, r: [5, 5, 9, 9] } },
  { part: 'upper-arm-l', shape: { kind: 'blob', x: 12, y: 37, w: 14, h: 46, r: [7, 7, 5, 5] } },
  { part: 'upper-arm-r', shape: { kind: 'blob', x: 74, y: 37, w: 14, h: 46, r: [7, 7, 5, 5] } },
  { part: 'forearm-l', shape: { kind: 'blob', x: 11, y: 79, w: 12, h: 43, r: [5, 5, 4, 4] } },
  { part: 'forearm-r', shape: { kind: 'blob', x: 77, y: 79, w: 12, h: 43, r: [5, 5, 4, 4] } },
  {
    part: 'hand-l',
    neutral: true,
    shape: { kind: 'blob', x: 10, y: 118, w: 12, h: 17, r: [4, 4, 6, 6] },
  },
  {
    part: 'hand-r',
    neutral: true,
    shape: { kind: 'blob', x: 78, y: 118, w: 12, h: 17, r: [4, 4, 6, 6] },
  },
  { part: 'thigh-l', shape: { kind: 'blob', x: 30, y: 118, w: 19, h: 60, r: [9, 9, 6, 6] } },
  { part: 'thigh-r', shape: { kind: 'blob', x: 51, y: 118, w: 19, h: 60, r: [9, 9, 6, 6] } },
  { part: 'calf-l', shape: { kind: 'blob', x: 32, y: 174, w: 16, h: 54, r: [7, 7, 5, 5] } },
  { part: 'calf-r', shape: { kind: 'blob', x: 52, y: 174, w: 16, h: 54, r: [7, 7, 5, 5] } },
  {
    part: 'foot-l',
    neutral: true,
    shape: { kind: 'blob', x: 32, y: 224, w: 16, h: 13, r: [3, 3, 6, 6] },
  },
  {
    part: 'foot-r',
    neutral: true,
    shape: { kind: 'blob', x: 52, y: 224, w: 16, h: 13, r: [3, 3, 6, 6] },
  },
];

const blob = (x: number, y: number, w: number, h: number, r: Radii): Blob => ({
  kind: 'blob',
  x,
  y,
  w,
  h,
  r,
});
const poly = (...pts: Pt[]): Poly => ({ kind: 'poly', pts });

/**
 * A shape reflected about the figure's midline.
 *
 * Every paired muscle is authored ONCE, on the left, and mirrored. The first
 * draft hand-wrote both sides and two of the pairs had drifted by a tenth of a
 * unit before anything was rendered — invisible in the numbers, visible as a
 * lopsided body. A reflection cannot drift.
 */
function mirror(shape: Shape): Shape {
  if (shape.kind === 'blob') {
    return {
      ...shape,
      x: FIGURE_GRID.w - shape.x - shape.w,
      // Corner radii are positional, so they swap left for right.
      r: [shape.r[1], shape.r[0], shape.r[3], shape.r[2]],
    };
  }
  return { kind: 'poly', pts: shape.pts.map(([x, y]) => [FIGURE_GRID.w - x, y] as Pt) };
}

/** One muscle on one side, drawn on both halves of the body. */
const pair = (muscle: Muscle, side: FigureSide, shape: Shape): FigureMuscleShape[] => [
  { muscle, side, shape },
  { muscle, side, shape: mirror(shape) },
];

/** One muscle on one side, drawn once (the midline shapes: traps). */
const single = (muscle: Muscle, side: FigureSide, shape: Shape): FigureMuscleShape[] => [
  { muscle, side, shape },
];

/**
 * Every muscle's shape, on the view it is visible from.
 *
 *          FRONT                              BACK
 *   front delts (shoulder caps)        traps (diamond yoke)
 *   side delts (arm caps)              rear delts (arm caps)
 *   pectoral fans                      upper back (rhomboid plates)
 *   six-pack grid                      lat wings + erector columns
 *   bicep spindles · forearm cones     tricep spindles · forearm cones
 *   quads (lateralis + medialis)       glutes · hamstring strips
 *   calf bellies                       calf bellies
 *
 * The deltoid heads are split by PLACE rather than by stacking three slivers on
 * one 16pt shoulder: front delts cap the torso's shoulder corners, side and rear
 * delts cap the upper arms on their respective views. Anatomically defensible,
 * and the armpit gap keeps the two apart on the page.
 *
 * No two shapes on a side overlap, and every shape is fully inside the body
 * ground — both asserted in db/exercise-ai.test.mjs, so nudging a body block
 * without nudging the muscles that ride on it fails the suite instead of
 * shipping a muscle floating beside the figure.
 */
export const FIGURE_MUSCLES: FigureMuscleShape[] = [
  // --- FRONT ---------------------------------------------------------------
  // Front delts: caps over the shoulder corners, cut to follow the torso's own
  // curve rather than sitting square on it and hanging off the shoulder.
  ...pair(
    'front_delts',
    'front',
    poly([41.5, 34.9], [41.5, 48], [35.5, 50.5], [28.3, 46], [28.3, 39.5], [31.6, 35.4])
  ),
  // Side delts: the outer caps of the shoulders, on the arms.
  ...pair(
    'side_delts',
    'front',
    poly([14, 39.5], [24, 39.5], [25.6, 44], [25.6, 57], [12.4, 57], [12.4, 44])
  ),
  // Pectoral fans: broad at the sternum, sweeping out and down to the armpit.
  ...pair(
    'chest',
    'front',
    poly([48.5, 50], [37, 51.5], [30.5, 56], [29.5, 64.5], [34, 71.5], [48.5, 70])
  ),
  // The rectus sheet as a segmented grid — four rows of two, the lowest pair
  // longer, split by a 1.6-unit linea alba. Blobs: an ab segment IS a rounded
  // rect, and eight of them cost eight nodes.
  ...pair('abs', 'front', blob(39.8, 72.8, 9.4, 8, [2, 2, 2, 2])),
  ...pair('abs', 'front', blob(39.8, 81.6, 9.4, 8, [2, 2, 2, 2])),
  ...pair('abs', 'front', blob(39.8, 90.4, 9.4, 8, [2, 2, 2, 2])),
  ...pair('abs', 'front', blob(39.8, 99.2, 9.4, 10, [2, 2, 4, 4])),
  // ...and the obliques down the flanks, which are the same muscle in this
  // taxonomy. Without them the waist reads as bare ground on a body whose every
  // other panel is filled, which is most of what made the first draft look like
  // an action figure rather than an anatomy plate.
  ...pair(
    'abs',
    'front',
    poly([38.8, 73.5], [38.6, 85], [39, 99], [36.5, 101], [33, 90], [33.5, 76.5])
  ),
  // Bicep spindles — a capsule is a spindle, and it is one node.
  ...pair('biceps', 'front', blob(12.8, 57.8, 12.4, 23, [6.2, 6.2, 6.2, 6.2])),
  // Forearms: tapering cones past the elbow.
  ...pair(
    'forearms',
    'front',
    poly([11.6, 84.5], [22.6, 84.5], [21.2, 102], [19, 119.5], [13.6, 119.5], [11.8, 102])
  ),
  // Quads, each leg in two masses so the vastus lateralis/medialis split shows:
  // the long outer sweep, and the teardrop that sits above the inner knee.
  ...pair(
    'quads',
    'front',
    poly(
      [31.7, 122.5],
      [41.5, 120.9],
      [44, 133],
      [43.5, 152],
      [39.5, 173.5],
      [33.5, 173.5],
      [30.7, 152],
      [30.4, 133]
    )
  ),
  ...pair(
    'quads',
    'front',
    poly([45.5, 138], [48.4, 146], [48.6, 160], [46, 173.5], [41.5, 173.5], [44, 158], [44.6, 147])
  ),
  // Calves: twin bellies, the outer one longer — which is what a gastrocnemius
  // looks like, and what a single box never could.
  ...pair('calves', 'front', blob(32.6, 181, 7.6, 32, [3.8, 3.8, 3.8, 3.8])),
  ...pair('calves', 'front', blob(40.9, 181, 7, 27, [3.5, 3.5, 3.5, 3.5])),

  // --- BACK ----------------------------------------------------------------
  // Traps: the diamond yoke across the top of the back. Symmetric about the
  // spine, so it is one shape rather than a pair.
  ...single(
    'traps',
    'back',
    poly([50, 34.4], [63, 37], [69.5, 45], [59, 53.5], [50, 55.5], [41, 53.5], [30.5, 45], [37, 37])
  ),
  // Rear delts: the caps of the upper arms, seen from behind.
  ...pair(
    'rear_delts',
    'back',
    poly([14, 39.5], [24, 39.5], [25.6, 44], [25.6, 57], [12.4, 57], [12.4, 44])
  ),
  // Upper back: the rhomboid plates between the shoulder blades.
  ...pair(
    'upper_back',
    'back',
    poly([48.5, 57], [36, 58], [31, 63], [32, 71], [41, 73.5], [48.5, 71.5])
  ),
  // Lats: wings that taper toward the waist — the shape a rectangle is most
  // obviously wrong for, and the reason this file rasterises polygons at all.
  ...pair(
    'lats',
    'back',
    poly([48.5, 75.5], [45, 83], [41, 92], [36, 95], [33.2, 86.5], [30.4, 79], [34.5, 74])
  ),
  // Lower back: the erector columns flanking the spine.
  ...pair('lower_back', 'back', blob(43.6, 88, 5.6, 17, [2.5, 2.5, 3, 3])),
  // Tricep spindles.
  ...pair('triceps', 'back', blob(12.8, 57.8, 12.4, 23, [6.2, 6.2, 6.2, 6.2])),
  // Forearms read the same from behind.
  ...pair(
    'forearms',
    'back',
    poly([11.6, 84.5], [22.6, 84.5], [21.2, 102], [19, 119.5], [13.6, 119.5], [11.8, 102])
  ),
  // Glutes: rounded masses.
  ...pair('glutes', 'back', blob(31.5, 105.5, 18, 18, [7, 7, 8, 8])),
  // Hamstrings: long strips down the back of the thigh.
  ...pair(
    'hamstrings',
    'back',
    poly(
      [46.5, 127],
      [47.5, 146],
      [45.5, 167],
      [41, 175],
      [34.5, 175],
      [31.5, 158],
      [31.8, 139],
      [34.5, 127]
    )
  ),
  // Calves read fuller from behind — same bellies, same places.
  ...pair('calves', 'back', blob(32.6, 181, 7.6, 32, [3.8, 3.8, 3.8, 3.8])),
  ...pair('calves', 'back', blob(40.9, 181, 7, 27, [3.5, 3.5, 3.5, 3.5])),
];

/** The muscle shapes of one side, in declaration (paint) order. */
export function musclesFor(side: FigureSide): FigureMuscleShape[] {
  return FIGURE_MUSCLES.filter((m) => m.side === side);
}

/** Every muscle that appears on at least one side — the completeness contract. */
export function mappedMuscles(): Set<Muscle> {
  return new Set(FIGURE_MUSCLES.map((m) => m.muscle));
}

/** The axis-aligned bounds of any shape. */
export function shapeBounds(shape: Shape): FigureRect {
  if (shape.kind === 'blob') return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  const xs = shape.pts.map((p) => p[0]);
  const ys = shape.pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** One rasterised scanline of a polygon, in grid units. */
export type Bar = FigureRect;

/**
 * How many scanline bars a polygon gets at a given scale — enough that each bar
 * lands near {@link BAR_POINTS} of rendered height, clamped so a tiny shape
 * still shows a taper and a tall one never runs away with the view budget.
 */
export function barsFor(shape: Shape, scale: number): number {
  const { h } = shapeBounds(shape);
  return Math.max(MIN_BARS, Math.min(MAX_BARS, Math.round((h * scale) / BAR_POINTS)));
}

/**
 * Rasterise a closed polygon into horizontal bars — the whole trick that makes a
 * contoured muscle out of nothing but filled `View`s.
 *
 * Standard even-odd scanline fill: sample the polygon at the vertical centre of
 * each row, intersect every non-horizontal edge with that line, sort the
 * crossings and pair them. A convex-ish muscle yields one span per row; a shape
 * that genuinely has two lobes at some height yields two, and both draw.
 *
 * `bleed` extends every bar but the last downward by a fraction of a grid unit,
 * so consecutive bars OVERLAP rather than abut. Abutting bars are the classic
 * failure here: each `View`'s frame is rounded to device pixels independently,
 * and a third of a point of rounding error prints a hairline of the ground
 * between two bars — a muscle striped like a barcode. The overlap must be
 * composited under ONE opacity (see the fill wrapper in muscle-figure.tsx),
 * never per-bar alpha, or the overlaps double-darken and stripe the other way.
 */
export function polyBars(pts: readonly Pt[], bars: number, bleed = 0.4): Bar[] {
  const ys = pts.map((p) => p[1]);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const rowH = (yMax - yMin) / bars;
  const out: Bar[] = [];
  for (let i = 0; i < bars; i++) {
    const yc = yMin + (i + 0.5) * rowH;
    const xs: number[] = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k]!;
      const b = pts[(k + 1) % pts.length]!;
      if (a[1] === b[1]) continue;
      const lo = Math.min(a[1], b[1]);
      const hi = Math.max(a[1], b[1]);
      // Half-open in y so a vertex shared by two edges is counted once.
      if (yc < lo || yc >= hi) continue;
      xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const w = xs[s + 1]! - xs[s]!;
      if (w <= 0) continue;
      out.push({
        x: xs[s]!,
        y: yMin + i * rowH,
        w,
        h: rowH + (i === bars - 1 ? 0 : bleed),
      });
    }
  }
  return out;
}

/** Is a point inside a rounded rect? Exact at the corners, not just the bounds. */
function insideBlob(b: Blob, x: number, y: number): boolean {
  if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return false;
  const cap = Math.min(b.w, b.h) / 2;
  const [tl, tr, br, bl] = b.r.map((v) => Math.min(v, cap)) as unknown as Radii;
  const near = (cx: number, cy: number, r: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  if (x < b.x + tl && y < b.y + tl) return near(b.x + tl, b.y + tl, tl);
  if (x > b.x + b.w - tr && y < b.y + tr) return near(b.x + b.w - tr, b.y + tr, tr);
  if (x > b.x + b.w - br && y > b.y + b.h - br) return near(b.x + b.w - br, b.y + b.h - br, br);
  if (x < b.x + bl && y > b.y + b.h - bl) return near(b.x + bl, b.y + b.h - bl, bl);
  return true;
}

/** A handful of points guaranteed to be inside `shape`, for the coverage test. */
function samplePoints(shape: Shape): Pt[] {
  const out: Pt[] = [];
  if (shape.kind === 'blob') {
    const cap = Math.min(shape.w, shape.h) / 2;
    const [tl, tr, br, bl] = shape.r.map((v) => Math.min(v, cap));
    // The four corners pulled in by their own radius (the extreme points of the
    // rounded outline), plus the edge midpoints and the centre.
    const inset = 0.29; // 1 - cos45°, the corner arc's deepest excursion
    out.push([shape.x + tl! * inset, shape.y + tl! * inset]);
    out.push([shape.x + shape.w - tr! * inset, shape.y + tr! * inset]);
    out.push([shape.x + shape.w - br! * inset, shape.y + shape.h - br! * inset]);
    out.push([shape.x + bl! * inset, shape.y + shape.h - bl! * inset]);
    out.push([shape.x + shape.w / 2, shape.y]);
    out.push([shape.x + shape.w / 2, shape.y + shape.h]);
    out.push([shape.x, shape.y + shape.h / 2]);
    out.push([shape.x + shape.w, shape.y + shape.h / 2]);
    return out;
  }
  // Every vertex, plus both ends of every rasterised bar at a resolution finer
  // than anything the component will draw.
  for (const p of shape.pts) out.push(p);
  for (const bar of polyBars(shape.pts, 40, 0)) {
    out.push([bar.x, bar.y + bar.h / 2]);
    out.push([bar.x + bar.w, bar.y + bar.h / 2]);
  }
  return out;
}

/** Even-odd point-in-polygon. */
function insidePoly(pts: readonly Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is a point inside a shape, corner radii and concavities included? */
export function insideShape(shape: Shape, x: number, y: number): boolean {
  return shape.kind === 'blob' ? insideBlob(shape, x, y) : insidePoly(shape.pts, x, y);
}

/**
 * Do two shapes share any area? Rasterised, because a BOUNDING-BOX test is
 * useless here: the vastus lateralis and medialis of one leg have overlapping
 * boxes and touch nowhere, and so do a lat wing and the erector column beside
 * it. Two shapes that genuinely overlap would paint one muscle's reading over
 * another's and silently lose it, which is the failure worth asserting on.
 */
export function shapesOverlap(a: Shape, b: Shape): boolean {
  const ba = shapeBounds(a);
  const bb = shapeBounds(b);
  if (
    Math.min(ba.x + ba.w, bb.x + bb.w) - Math.max(ba.x, bb.x) <= 0 ||
    Math.min(ba.y + ba.h, bb.y + bb.h) - Math.max(ba.y, bb.y) <= 0
  ) {
    return false;
  }
  const x0 = Math.max(ba.x, bb.x);
  const x1 = Math.min(ba.x + ba.w, bb.x + bb.w);
  const y0 = Math.max(ba.y, bb.y);
  const y1 = Math.min(ba.y + ba.h, bb.y + bb.h);
  const steps = 60;
  for (let i = 0; i <= steps; i++) {
    const y = y0 + ((y1 - y0) * i) / steps;
    for (let k = 0; k <= steps; k++) {
      const x = x0 + ((x1 - x0) * k) / steps;
      if (insideShape(a, x, y) && insideShape(b, x, y)) return true;
    }
  }
  return false;
}

/**
 * Is every point of `shape` covered by the body ground?
 *
 * The invariant that keeps a muscle from floating in space beside the figure —
 * asserted over every muscle shape in db/exercise-ai.test.mjs, so moving a body
 * block without moving the muscles that ride on it fails the suite instead of
 * shipping. Sampled rather than solved analytically because a shape may
 * legitimately span TWO overlapping body blocks (the lower abs cross the
 * waist/pelvis join), which no single-block containment test would accept, and
 * because the blocks are ROUNDED — a rect test would pass a muscle that hangs
 * off a curved shoulder, which is exactly the failure worth catching.
 */
export function coveredByBody(shape: Shape): boolean {
  for (const [x, y] of samplePoints(shape)) {
    if (!FIGURE_BODY.some((b) => insideBlob(b.shape, x, y))) return false;
  }
  return true;
}

/**
 * How many native `View`s one figure PAIR costs at a given per-figure width.
 *
 * The drawing sits inside two scrolling screens, so its node count is a budget
 * and not an afterthought. Counted here rather than guessed: body ground blocks
 * cost two each (the contour pass and the fill pass), a muscle blob costs one
 * (its ink line is a uniform `borderWidth`, not a second node), and a muscle
 * poly costs one node per bar twice over — the inflated ink copy and the fill —
 * plus one wrapper that holds the fill's single opacity.
 */
export function figureViewCount(width: number): number {
  const scale = width / FIGURE_GRID.w;
  let n = FIGURE_BODY.length * 2 * 2; // both sides, contour + fill
  for (const m of FIGURE_MUSCLES) {
    if (m.shape.kind === 'blob') n += 1;
    else n += polyBars(m.shape.pts, barsFor(m.shape, scale)).length * 2 + 1;
  }
  return n;
}
