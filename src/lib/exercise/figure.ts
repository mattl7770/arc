/**
 * The body figure's geometry — pure data plus a scanline rasteriser. No React,
 * no SVG.
 *
 * ## Four rounds, and what each one got wrong
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
 * **2026-08-12 (b)** built the scanline rasteriser and drew every MUSCLE as a
 * contoured shape — pecs as fans, a segmented six-pack, tapering lat wings, a
 * trap diamond, filled with one hue at varying opacity. Rejected as well:
 * *"Muscle freshness still looks a bit wack… a bunch of odd shaped boxes."*
 *
 * **2026-08-14, this file.** The rasteriser was never the problem — it draws
 * whatever shape it is handed, and what it was being handed for the BODY was
 * nineteen axis-aligned rounded rectangles: a rectangular torso over a narrower
 * rectangular waist over a wider rectangular pelvis, with rectangular limbs.
 * That reads as boxes however smooth the muscles drawn on it are, and three
 * rounds went into smoothing the wrong layer.
 *
 * So the SILHOUETTE was rebuilt as polygons — one continuous contour each for
 * the torso, the two arms and the two legs, with a {@link Blob} wherever the
 * outline turns shallow ({@link FIGURE_BODY}) — and the muscles re-fitted onto
 * it. The muscle bar height dropped from 4.4pt to {@link BAR_POINTS}, the
 * deltoid gained its third head, and the ramp changed from green-fading-to-pale
 * to green-turning-to-grey ({@link freshnessFill}), which is the owner's other
 * ask from the same round.
 *
 * **The check that caught what reasoning could not, in this round and the
 * last, is `db/figure-preview.mjs`** — it renders this geometry to a PNG
 * offline, with no simulator and no device. Look at the drawing before
 * defending it. Four rounds of this file are four pieces of evidence that
 * "these coordinates describe a deltoid" and "this reads as a person" are
 * different claims.
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
 * control, and it is what pays for the body being polygons at all: every dome
 * in the drawing — skull, the two shoulder caps, biceps and triceps, the
 * lateral deltoid heads, glutes, the inner calf bellies, hands, feet — is a
 * blob. {@link figureViewCount} reports the real number and
 * db/exercise-ai.test.mjs asserts a ceiling of 900 against it, because this
 * drawing renders inside two scrolling screens. It is 894 at 128pt today.
 *
 * ## Bar count is adaptive, and that is not a nicety
 *
 * The same geometry renders at 72pt (exercise-detail, beside a photo), 118pt
 * (the Exercise hub) and 128pt (the pushed screen). A fixed bar count would be
 * either jagged at the big size or wasteful at the small one, so
 * {@link barsFor} targets a CONSTANT RENDERED BAR HEIGHT and clamps to
 * [{@link MIN_BARS}, {@link MAX_BARS}]. The target differs by layer —
 * {@link BAR_POINTS} for muscles, the coarser {@link BODY_BAR_POINTS} for the
 * body — because stair-stepping is a function of EDGE SLOPE, and the body's
 * long edges are near-vertical while its shallow ones are blobs.
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
 * — head, hands, feet — which the component fills in the PLATE colour instead
 * of the muscle ground, so the eye learns which regions are data before reading
 * any.
 *
 * The shape is a full {@link Shape} since 2026-08-14: the body used to be
 * nineteen axis-aligned rounded rectangles, and a torso that is a rectangle
 * over a waist that is a narrower rectangle reads as boxes however smooth the
 * muscles drawn on top of it are. See {@link FIGURE_BODY}.
 */
export type FigureBodyPart = { part: string; neutral?: boolean; shape: Shape };

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
 * It is load-bearing rather than decorative, and for a reason that survived the
 * ramp changing: two ADJACENT muscles reading the same freshness are the same
 * colour, so nothing but this line separates them. It also keeps every contour
 * readable at 9.74:1 against the ground it encloses, whatever the fill has done.
 *
 * Raised from 0.55 to 0.7 on 2026-08-14 — at 0.55 the deltoid and the pec fused
 * into one mass in preview whenever both were fresh.
 */
export const MUSCLE_OUTLINE = 0.7;

/**
 * The two ends of the freshness ramp. A muscle's fill interpolates between them
 * in COLOUR, at full opacity — it does not fade.
 *
 * ## The change (owner, 2026-08-14): *"have spent muscles fade to grey instead
 * of dark green"*
 *
 * The retired ramp was one hue, `signal-optimal-ink`, at alpha 0.45 → 1.0 over
 * the body ground, so a spent muscle was a PALE GREEN. Two things were wrong
 * with that beyond the owner not liking it. A translucent fill has to be
 * composited against whatever is under it to know what colour it actually is,
 * which is why the old floor was pinned to a single measured stack and why the
 * overlapping scanline bars had to be wrapped in one opacity or they striped.
 * And "faded" is the wrong metaphor for spent: a spent muscle is not *less
 * there*, it is in a different state.
 *
 * So: **fresh is the signal green, spent is a neutral grey, both fully opaque**,
 * and the reading is the hue and the lightness together.
 *
 * ## Which grey, and why it is not a colour someone liked
 *
 * {@link MUSCLE_SPENT} is `hairline` #A9A28E — the app's neutral rule colour,
 * the warm grey the whole ink family is built from — scaled to 84.5% per
 * channel. That is the same discipline the `signalInk` cuts use (a swatch
 * darkened until it clears its contrast floor), applied to the neutral: it is
 * the lightest warm grey that still clears WCAG 1.4.11's 3:1 against the
 * `paper-hi` plate the figure sits on.
 *
 *   freshness   fill      vs plate   vs body ground   vs the FRESH end
 *      0        #8F8978    3.14:1        1.94:1            2.36:1
 *     50        #547257    4.82:1        2.98:1               —
 *    100        #185A36    7.41:1        4.56:1            2.36:1
 *
 * The midpoint is a **sage green** (84, 114, 87), not mud. That is worth
 * stating because green→warm-grey is exactly the interpolation that goes olive
 * if the green channel dips: here G stays the largest channel until t = 0.92,
 * and past that R leads it by at most 6/255, which is nothing. Checked, not
 * hoped for.
 *
 * The two ENDS measure 2.36:1 apart in luminance, near the 2.45:1 the old
 * alpha ramp managed — but they are now also a full hue apart (saturated green
 * against neutral) where the old ramp was one hue at two strengths. A reader
 * who sees no hue is no worse off; a reader who does is better off. And the
 * ink line around every shape ({@link MUSCLE_OUTLINE}) still carries the
 * contour at 9.74:1 regardless of the fill, which is what makes any of this
 * safe.
 *
 * The roll call is unchanged and is still the carrier that owes nothing to
 * colour: {@link MuscleFigureLegend} names every recovering and fatigued muscle
 * in words.
 */
export const MUSCLE_FRESH = '#185A36';
export const MUSCLE_SPENT = '#8F8978';

/** Linear interpolation between two `#RRGGBB` values, in sRGB. */
function mixHex(a: string, b: string, t: number): string {
  const ch = (s: string, i: number) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2]
    .map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  return `#${out}`;
}

/**
 * Freshness 0-100 → the fill it draws at: spent grey at 0, signal green at 100,
 * opaque throughout.
 *
 * The alpha in the return type is not vestigial — `muscles` mode (which shows
 * the muscles a MOVEMENT works, a fact about an exercise and never a
 * biological state) still draws translucent ink, and the component's one
 * fill path serves both.
 */
export function freshnessFill(freshness: number): { color: string; alpha: number } {
  const f = Math.max(0, Math.min(100, Number.isFinite(freshness) ? freshness : 0));
  return { color: mixHex(MUSCLE_SPENT, MUSCLE_FRESH, f / 100), alpha: 1 };
}

/**
 * The rendered height one scanline bar aims for, in points — the muscles.
 *
 * **2.6, down from 4.4 (2026-08-14).** The previous round measured ~1.5pt
 * stair-steps on the shallow edges (the top of a pec, the sweep of a quad) and
 * flagged them; this is that flag answered. It costs roughly 1.7× the bars on
 * every muscle poly, which the budget in db/exercise-ai.test.mjs absorbs
 * because the body no longer spends its own bars on detail it does not need
 * ({@link BODY_BAR_POINTS}).
 */
export const BAR_POINTS = 3.8;

/**
 * The same, for the BODY polygons — deliberately coarser, and the reason the
 * budget survives the muscles getting finer.
 *
 * Stair-stepping is a function of the EDGE SLOPE, not of the bar height: a bar
 * `h` tall on an edge of slope dx/dy steps sideways by `h × dx/dy`. The body's
 * long edges are near-vertical (a torso's flank runs about 0.18 sideways per
 * unit down, a thigh's about 0.1), so a 5.2pt bar steps under a point — below
 * anything the eye resolves. Every place the silhouette actually turns shallow
 * is a BLOB instead: the skull, the deltoid caps, the hands and the feet are
 * all domes, and a blob's corner radius is a real antialiased curve for one
 * view. Choosing the primitive by the slope is what buys the finer muscles.
 */
export const BODY_BAR_POINTS = 6.5;

export const MIN_BARS = 3;
/**
 * The ceiling on bars for one shape. High enough that a full-length torso or
 * leg polygon is never clamped into visible steps (a 106-unit torso at 128pt
 * asks for 26), and the budget assertion is what actually holds the cost down.
 */
export const MAX_BARS = 40;

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
 * The body ground — head to feet, shared by both views.
 *
 * ## The fourth attempt starts here, not with the muscles
 *
 * Rounds one to three all lost on the same ground: the muscles got smoother
 * every time and the owner kept saying *"a bunch of odd shaped boxes"*, because
 * the BODY was nineteen axis-aligned rounded rectangles. A rectangular torso
 * over a narrower rectangular waist over a wider rectangular pelvis reads as
 * boxes no matter what is drawn on top of it, and the scanline rasteriser that
 * was built to fix the muscles was never pointed at the thing that was actually
 * wrong.
 *
 * So the silhouette is polygons now. A human outline is CONTINUOUS: the
 * shoulders round over into the arms, the ribcage narrows to a waist and flares
 * again at the hips, the thigh tapers to a knee, the calf has a belly and a
 * thin ankle under it. Five polygons carry all of that — one torso, two arms,
 * two legs — and every one of them is a single closed contour with no straight
 * vertical run longer than about eight units.
 *
 * ## Blobs where the outline turns shallow, and that is a cost decision
 *
 * A scanline shape steps sideways by `barHeight × dx/dy`, so it is the SHALLOW
 * edges that stair-step, and a dome is the worst case there. Every dome in this
 * figure is therefore a {@link Blob}, whose corner radius is a real antialiased
 * curve for exactly one view: the skull, the two deltoid caps, the hands, the
 * feet. The polygons keep the steep runs, which is why they can afford
 * {@link BODY_BAR_POINTS} of 5.2 while the muscles run at 2.6.
 *
 * ## Proportions
 *
 * A standing figure of about eight heads with the arms slightly abducted, which
 * is what separates them from the hips instead of fusing the silhouette into a
 * slab. Crown 3 · chin 31 · shoulder line 42 · nipple 60 · navel 92 · waist
 * (narrowest) 99 · iliac crest 117 · crotch 133 · knee 180 · ankle 226 · sole
 * 238. Head 22 wide, shoulders 52, waist 30, hips 39.
 *
 * ## `neutral`
 *
 * Head, hands and feet carry no reading, and now say so by being drawn in the
 * PLATE colour — the page showing through an ink outline. They used to be
 * `hairline` grey, which was fine while spent muscles were pale green and is a
 * collision now that spent muscles are grey (the previous author measured the
 * two at 1.32:1 and flagged exactly this). Plate against the spent grey is
 * 3.14:1, and "empty" is a stronger statement than "a different grey" anyway.
 */
export const FIGURE_BODY: FigureBodyPart[] = [
  // The skull: a dome, so a blob. Overlaps the torso polygon's neck.
  { part: 'head', neutral: true, shape: blob(39, 3, 22, 28, [11, 11, 10.5, 10.5]) },

  // The torso — neck, clavicle, ribcage, waist, hip flare, crotch — as one
  // continuous contour. The clavicle run (y 38→44) is the only shallow stretch
  // and it is covered by the deltoid caps below.
  {
    part: 'torso',
    shape: poly(
      [44.8, 24],
      [43.6, 36.5],
      [37.4, 39.4],
      [32.6, 43.5],
      [31.2, 51],
      [32.0, 60],
      [33.4, 71],
      [35.0, 84],
      [35.6, 95],
      [35.2, 101],
      [33.4, 109],
      [31.0, 117],
      [30.6, 126],
      [33.0, 131],
      [41.0, 134],
      [50.0, 135],
      [59.0, 134],
      [67.0, 131],
      [69.4, 126],
      [69.0, 117],
      [66.6, 109],
      [64.8, 101],
      [64.4, 95],
      [65.0, 84],
      [66.6, 71],
      [68.0, 60],
      [68.8, 51],
      [67.4, 43.5],
      [62.6, 39.4],
      [56.4, 36.5],
      [55.2, 24]
    ),
  },

  // The deltoid caps. Domes, so blobs — and they are what give the figure a
  // shoulder rather than a corner. Each overlaps the torso inward and the arm
  // downward, so the ink pass fuses all three into one silhouette.
  { part: 'shoulder-l', shape: blob(22.5, 37.5, 21, 21, [8.5, 8.5, 6, 6]) },
  { part: 'shoulder-r', shape: blob(56.5, 37.5, 21, 21, [8.5, 8.5, 6, 6]) },

  // Arms, slightly abducted: upper arm → elbow → forearm belly → wrist, one
  // polygon each. The abduction is what keeps the forearm off the hip; arms
  // hanging dead vertical fuse into the torso and the figure becomes a slab.
  {
    part: 'arm-l',
    shape: poly(
      [23.4, 44],
      [36.4, 46],
      [35.0, 58],
      [33.4, 70],
      [31.6, 82],
      [30.6, 92],
      [29.4, 104],
      [28.0, 116],
      [22.0, 118],
      [21.0, 106],
      [20.4, 94],
      [21.2, 84],
      [21.0, 72],
      [21.4, 60],
      [22.2, 50]
    ),
  },
  {
    part: 'arm-r',
    shape: poly(
      [76.6, 44],
      [63.6, 46],
      [65.0, 58],
      [66.6, 70],
      [68.4, 82],
      [69.4, 92],
      [70.6, 104],
      [72.0, 116],
      [78.0, 118],
      [79.0, 106],
      [79.6, 94],
      [78.8, 84],
      [79.0, 72],
      [78.6, 60],
      [77.8, 50]
    ),
  },
  { part: 'hand-l', neutral: true, shape: blob(21.2, 113.5, 7.2, 12.5, [3, 3, 3.6, 3.6]) },
  { part: 'hand-r', neutral: true, shape: blob(71.6, 113.5, 7.2, 12.5, [3, 3, 3.6, 3.6]) },

  // Legs: thigh → knee → calf belly → ankle, one polygon each. The knee pinch
  // and the calf belly below it are the whole reason these are not blobs.
  {
    part: 'leg-l',
    shape: poly(
      [31.4, 126],
      [47.4, 127],
      [48.0, 141],
      [47.8, 156],
      [46.6, 170],
      [45.8, 180],
      [46.4, 190],
      [45.8, 202],
      [44.6, 213],
      [44.2, 226],
      [37.8, 226],
      [37.2, 213],
      [35.4, 202],
      [33.6, 190],
      [34.6, 180],
      [33.0, 170],
      [30.6, 156],
      [29.8, 141]
    ),
  },
  {
    part: 'leg-r',
    shape: poly(
      [68.6, 126],
      [52.6, 127],
      [52.0, 141],
      [52.2, 156],
      [53.4, 170],
      [54.2, 180],
      [53.6, 190],
      [54.2, 202],
      [55.4, 213],
      [55.8, 226],
      [62.2, 226],
      [62.8, 213],
      [64.6, 202],
      [66.4, 190],
      [65.4, 180],
      [67.0, 170],
      [69.4, 156],
      [70.2, 141]
    ),
  },
  { part: 'foot-l', neutral: true, shape: blob(37.0, 222, 8.2, 13, [2.6, 2.6, 4, 4]) },
  { part: 'foot-r', neutral: true, shape: blob(54.8, 222, 8.2, 13, [2.6, 2.6, 4, 4]) },
];

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
  // Pectoral fans: broad at the sternum, sweeping out and down to the armpit.
  // The upper-outer corner runs UNDER the deltoid rather than butting against
  // it, so the shoulder laps over the chest the way it does on a body.
  ...pair(
    'chest',
    'front',
    poly([48.4, 51.6], [41.5, 52.8], [36.4, 55.6], [33.6, 61], [34.6, 68], [40.4, 72.4], [48.4, 71])
  ),
  // Side delts: the lateral head — the outer crown of the same cap, and the one
  // head you see from BOTH views. A capsule is the shape, so the third deltoid
  // costs four views instead of the fifty-six a polygon pair would have.
  ...pair('side_delts', 'front', blob(23.6, 42.5, 6.2, 15, [3.1, 3.1, 3.1, 3.1])),
  // Front delts: the front face of the shoulder cap, a rounded wedge that runs
  // from the clavicle out over the joint and down. Declared BEFORE the pec and
  // drawn after it, which is the fix for the junction the previous round
  // flagged — see the overlap note in the header.
  ...pair(
    'front_delts',
    'front',
    poly([38.4, 45.5], [36.2, 41.2], [32.6, 38.9], [30.6, 41.2], [30.4, 50], [31.2, 57.2], [34.8, 54.4], [37.6, 49.5])
  ),
  // The rectus sheet as a segmented grid — four rows either side of a 1.6-unit
  // linea alba, the lowest pair longer. Blobs: an ab segment IS a rounded rect,
  // and eight of them cost eight nodes where eight polys would cost eighty.
  ...pair('abs', 'front', blob(41.2, 74, 8, 7.4, [2, 2, 2, 2])),
  ...pair('abs', 'front', blob(41.2, 82.4, 8, 7.4, [2, 2, 2, 2])),
  ...pair('abs', 'front', blob(41.2, 90.8, 8, 7.4, [2, 2, 2, 2])),
  ...pair('abs', 'front', blob(41.2, 99.2, 8, 9.4, [2, 2, 4, 4])),
  // ...and the obliques down the flanks, which are the same muscle in this
  // taxonomy. Without them the waist reads as bare ground on a body whose every
  // other panel is filled, which is most of what made the first draft look like
  // an action figure rather than an anatomy plate.
  ...pair(
    'abs',
    'front',
    poly([40.2, 74.6], [40.0, 88], [40.4, 100], [38.4, 103.5], [36.2, 96], [35.8, 84], [36.4, 75.4])
  ),
  // Bicep spindles — tapered, because the arm they sit on tapers.
  ...pair('biceps', 'front', blob(22.2, 59.5, 10.8, 21, [5.4, 5.4, 5.2, 5.2])),
  // Forearms: the brachioradialis belly swelling below the elbow, then the wrist.
  ...pair(
    'forearms',
    'front',
    poly([30.2, 86], [29.4, 94], [28.6, 104], [27.4, 114], [22.6, 114], [21.8, 104], [21.2, 94], [22.0, 86])
  ),
  // Quads, each leg in two masses so the vastus lateralis/medialis split shows:
  // the long outer sweep, and the teardrop that sits above the inner knee.
  ...pair(
    'quads',
    'front',
    poly([41.4, 130], [43.4, 142], [43.4, 158], [41.2, 172], [35.2, 172], [32.4, 156], [31.4, 141], [33.2, 129.5])
  ),
  ...pair(
    'quads',
    'front',
    poly([46.2, 146], [47.0, 156], [46.2, 168], [44.0, 176], [42.4, 168], [43.4, 156], [44.6, 147])
  ),
  // Calves: twin bellies, the outer one longer and lower — which is what a
  // gastrocnemius looks like, and what a single box never could.
  ...pair(
    'calves',
    'front',
    poly([40.2, 181.5], [41.2, 190], [40.6, 200], [38.4, 208], [35.7, 200], [34.0, 190], [35.4, 182.5])
  ),
  ...pair('calves', 'front', blob(41.2, 182.5, 4.4, 20, [2.2, 2.2, 2.2, 2.2])),

  // --- BACK ----------------------------------------------------------------
  // Traps: the diamond yoke across the top of the back. Symmetric about the
  // spine, so it is one shape rather than a pair.
  ...single(
    'traps',
    'back',
    poly([50, 37.2], [56.8, 39], [60.4, 44], [61, 52], [56.4, 60], [50, 62.8], [43.6, 60], [39, 52], [39.6, 44], [43.2, 39])
  ),
  // Upper back: the rhomboid plates between the shoulder blades.
  ...pair(
    'upper_back',
    'back',
    poly([49, 64.5], [41.5, 65.5], [36.4, 69], [35.4, 75.5], [38.6, 80.5], [45, 81], [49, 79])
  ),
  ...pair('side_delts', 'back', blob(23.6, 42.5, 6.2, 15, [3.1, 3.1, 3.1, 3.1])),
  // Rear delts: the back face of the same shoulder cap the front delts sit on.
  ...pair(
    'rear_delts',
    'back',
    poly([38.4, 45.5], [36.2, 41.2], [32.6, 38.9], [30.6, 41.2], [30.4, 50], [31.2, 57.2], [34.8, 54.4], [37.6, 49.5])
  ),
  // Lats: wings that taper toward the waist — the shape a rectangle is most
  // obviously wrong for, and the reason this file rasterises polygons at all.
  ...pair(
    'lats',
    'back',
    poly([48, 82.5], [45, 89], [41, 97], [37.2, 100.6], [36.2, 92], [35.4, 84.5], [37.8, 81.4])
  ),
  // Lower back: the erector columns flanking the spine.
  ...pair('lower_back', 'back', blob(45.7, 88, 3.6, 17, [1.8, 1.8, 2.4, 2.4])),
  // Tricep spindles, on the same arm the biceps ride on the other view.
  ...pair('triceps', 'back', blob(22.2, 59.5, 10.8, 21, [5.4, 5.4, 5.2, 5.2])),
  // Forearms read the same from behind.
  ...pair(
    'forearms',
    'back',
    poly([30.2, 86], [29.4, 94], [28.6, 104], [27.4, 114], [22.6, 114], [21.8, 104], [21.2, 94], [22.0, 86])
  ),
  // Glutes: rounded masses filling the pelvis.
  ...pair('glutes', 'back', blob(34.2, 109.5, 15, 21, [7, 7.5, 7.5, 7])),
  // Hamstrings: long tapering masses down the back of the thigh.
  ...pair(
    'hamstrings',
    'back',
    poly([46.0, 134], [47.2, 146], [46.8, 160], [44.4, 172], [37.0, 172], [33.6, 158], [32.4, 145], [34.8, 134.5])
  ),
  // Calves read fuller from behind — same bellies, same places.
  ...pair(
    'calves',
    'back',
    poly([40.2, 181.5], [41.2, 190], [40.6, 200], [38.4, 208], [35.7, 200], [34.0, 190], [35.4, 182.5])
  ),
  ...pair('calves', 'back', blob(41.2, 182.5, 4.4, 20, [2.2, 2.2, 2.2, 2.2])),
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
export function barsFor(shape: Shape, scale: number, target: number = BAR_POINTS): number {
  const { h } = shapeBounds(shape);
  return Math.max(MIN_BARS, Math.min(MAX_BARS, Math.round((h * scale) / target)));
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
    if (!FIGURE_BODY.some((b) => insideShape(b.shape, x, y))) return false;
  }
  return true;
}

/** How many `View`s one shape costs: a blob is 1, a poly is one per bar. */
function shapeViews(shape: Shape, scale: number, target: number): number {
  if (shape.kind === 'blob') return 1;
  return polyBars(shape.pts, barsFor(shape, scale, target)).length;
}

/**
 * How many native `View`s one figure PAIR costs at a given per-figure width.
 *
 * The drawing sits inside two scrolling screens, so its node count is a budget
 * and not an afterthought. Counted here rather than guessed: every body part
 * costs two (the inflated contour pass and the fill pass) — one view each if it
 * is a blob, one per scanline bar each if it is a polygon — a muscle blob costs
 * one (its ink line is a uniform `borderWidth`, not a second node), and a
 * muscle poly costs one node per bar twice over, the inflated ink copy and the
 * fill.
 *
 * No opacity wrapper appears in this count and that is not an oversight: the
 * freshness ramp is opaque since 2026-08-14, so the fill bars carry their own
 * colour and the wrapper that used to hold one alpha for the group is gone.
 * `muscles` mode still needs it and still gets it, but that mode draws a
 * different, smaller figure.
 */
export function figureViewCount(width: number): number {
  const scale = width / FIGURE_GRID.w;
  let n = 0;
  for (const b of FIGURE_BODY) n += shapeViews(b.shape, scale, BODY_BAR_POINTS) * 2 * 2;
  for (const m of FIGURE_MUSCLES) {
    n += m.shape.kind === 'blob' ? 1 : shapeViews(m.shape, scale, BAR_POINTS) * 2;
  }
  return n;
}
