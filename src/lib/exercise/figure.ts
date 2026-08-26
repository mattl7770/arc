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
 * **2026-08-14 (a).** The rasteriser was never the problem — it draws whatever
 * shape it is handed, and what it was being handed for the BODY was nineteen
 * axis-aligned rounded rectangles: a rectangular torso over a narrower
 * rectangular waist over a wider rectangular pelvis, with rectangular limbs.
 * That reads as boxes however smooth the muscles drawn on it are, and three
 * rounds went into smoothing the wrong layer.
 *
 * So the SILHOUETTE was rebuilt as polygons — one continuous contour each for
 * the torso, the two arms and the two legs, with a {@link Blob} wherever the
 * outline turns shallow ({@link FIGURE_BODY}). That part worked and is
 * untouched below. The ramp changed with it, from green-fading-to-pale to
 * green-turning-to-grey ({@link freshnessFill}).
 *
 * **2026-08-14 (b), this round.** The body read as a person and the muscles
 * still read as ARMOUR PLATES STUCK TO IT. Every muscle was an isolated rounded
 * blob with a wide halo of grey ground around it: the torso mostly bare with a
 * few ovals on it, the glutes two circles, the abs a stack of tic-tacs, the
 * calves lozenges in an empty shin.
 *
 * The fix is a different relationship between the two layers, not better
 * shapes. **On an anatomy plate the muscles TILE the body** — they fill it,
 * share edges with their neighbours, and are separated by a hairline; the
 * ground shows only at joints, at the midline, and as that hairline. So every
 * region here was grown to meet its neighbours at ~1.2–1.4 units, and to meet
 * the SILHOUETTE at ~0.5–1.0 — which is inside {@link MUSCLE_OUTLINE}, so the
 * muscle's own ink merges with the body's contour and no rim of ground survives
 * at the edge. That single change is most of what stops the sticker look.
 *
 * Shapes followed: the pec became a fan with a clavicular slope and a lateral
 * border down the deltopectoral groove; the deltoid reaches over the CROWN of
 * the shoulder (a bare band arced across both shoulders before, and it was the
 * loudest sticker cue in the first preview of this round); the lat is a wing
 * from the armpit to the lower spine; the glutes and the erectors stopped being
 * a circle and a capsule; the quads and hamstrings became two masses of
 * different lengths whose groove OPENS toward the knee, because two equal
 * masses either side of a dead-straight parallel groove read as sticks.
 *
 * db/exercise-ai.test.mjs now asserts the tiling directly — per-band coverage
 * floors over the rasterised body ground — because `coveredByBody` alone is
 * satisfied by pills and passed all three rejected rounds.
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
 * forearms, the ab segments, the medial calf bellies, hands, feet — is a blob.
 * {@link figureViewCount} reports the real number and db/exercise-ai.test.mjs
 * asserts the ceiling against it, because this drawing renders inside two
 * scrolling screens. **680 views at 72pt, 1,062 at 118pt, 1,168 at 128pt,
 * against a ceiling of 1,200** — raised from 900 to pay for the tiling, since
 * growing a region is bars.
 *
 * Two shapes were DEMOTED to blobs to afford it, and both are honest trades
 * rather than concessions: the forearm (a gentle taper the arm's own silhouette
 * carries) and the medial calf belly (a rounded mass, which is what a capsule
 * draws). The erector columns went the other way, capsule → poly, because a
 * 4×32 capsule is a stick and the erector's whole shape is its lumbar
 * thickening.
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
 * **3.8, down from 4.4 (2026-08-14).** The previous round measured ~1.5pt
 * stair-steps on the shallow edges (the top of a pec, the sweep of a quad) and
 * flagged them; this is that flag answered. It costs roughly 1.15× the bars on
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
 * unit down, a thigh's about 0.1), so a 6.5pt bar steps about a point — around
 * the limit of what the eye resolves. Every place the silhouette actually turns
 * shallow is a BLOB instead: the skull, the deltoid caps, the hands and the feet are
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
 * {@link BODY_BAR_POINTS} of 6.5 while the muscles run at 3.8.
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
 *   deltoid cap: front + side head     traps (yoke, neck to mid-back)
 *   pectoral fans                      deltoid cap: rear + side head
 *   rectus grid + oblique flanks       scapular plates · lat wings
 *   bicep spindles · forearms          erector columns · triceps · forearms
 *   quads (lateralis | rectus+VM)      glutes · hamstrings (outer | inner)
 *   gastrocnemius bellies              gastrocnemius bellies
 *
 * ## The deltoid is split down the cap, and the two views differ
 *
 * The three heads are split by PLACE rather than by stacking slivers on one
 * 16pt shoulder. The LATERAL head is the outer lobe of the cap and the one head
 * visible from both views, so it is the same shape on each. The anterior and
 * posterior heads share its divide — a straight line from (31.8, 39.6) to
 * (28.0, 63.5), the deltoid's own longitudinal groove, with each head offset
 * 0.6 off it — but they are NOT mirrors of each other: the anterior head
 * reaches medially onto the clavicle, while the posterior head starts at the
 * spine of the scapula, much further out, because on the back view the upper
 * TRAPEZIUS owns the top of the shoulder all the way to the acromion. Giving
 * the two heads one shape put the trap inside the delt, and the overlap
 * assertion caught it.
 *
 * ## What the suite holds
 *
 * No two DIFFERENT muscles overlap on a side; every shape is fully inside the
 * body ground; and the muscles COVER that ground to a floor per band. The first
 * two stop a muscle floating beside the figure when a body block moves. The
 * third is the one this round added, and it is the one that would have caught
 * three of the four rejections: sixteen pills in the middle of a body satisfy
 * containment perfectly.
 */
export const FIGURE_MUSCLES: FigureMuscleShape[] = [
  // --- FRONT ---------------------------------------------------------------
  // Pectoral fan: the sternal border is a straight run down the midline, the
  // superior border follows the clavicle out to the deltopectoral groove, the
  // lateral border runs DOWN that groove to the armpit, and the inferior border
  // sweeps back in to the costal margin — so the whole shape is a fan whose
  // lowest point is at the sternum, not at the armpit.
  ...pair(
    'chest',
    'front',
    poly(
      [48.9, 47.6],
      [44.6, 45.4],
      [40.6, 44.2],
      [39.2, 48],
      [37.6, 53],
      [35.6, 58.5],
      [34.6, 63],
      [34.8, 67.6],
      [38.4, 71.4],
      [43.4, 73.6],
      [48.9, 74.6]
    )
  ),
  // The deltoid, split down the middle of the cap into its lateral head (here)
  // and its anterior/posterior head (below). The DIVIDE is a straight line from
  // (31.8, 39.6) to (28.0, 65) and both heads are offset 0.6 off it, which is
  // the deltoid's own longitudinal groove; each head then fans from the crown to
  // the deltoid tuberosity, and the lateral one takes the silhouette's outer
  // edge as its own outer border. Formerly a 6×15 capsule floating in the middle
  // of the shoulder with ground all round it.
  ...pair(
    'side_delts',
    'front',
    poly(
      [33.0, 39.6],
      [30.0, 38.8],
      [27.0, 39.6],
      [25.0, 41.2],
      [23.6, 44],
      [23.1, 49],
      [22.9, 55],
      [23.8, 60],
      [25.4, 64.8],
      [28.2, 64.6],
      [28.3, 62],
      [29.6, 56],
      [30.9, 50],
      [32.2, 44]
    )
  ),
  // Front delts: the anterior head, from the lateral third of the clavicle over
  // the crown and down to the same tuberosity. Its medial border IS the
  // deltopectoral groove — the pec's lateral border runs 1.6 off it.
  ...pair(
    'front_delts',
    'front',
    poly(
      [39.2, 45.2],
      [38.4, 42.0],
      [36.2, 39.6],
      [34.2, 39.2],
      [33.3, 44],
      [32.0, 50],
      [30.8, 56],
      [29.7, 62],
      [31.4, 64.6],
      [34.0, 58],
      [36.2, 51],
      [37.8, 47.5]
    )
  ),
  // The rectus sheet: FIVE rows either side of a 1.7-unit linea alba, running
  // from the costal margin to the pubis rather than stopping at the navel and
  // leaving the lower belly bare. Blobs — an ab segment IS a rounded rect, and
  // ten of them cost ten nodes where ten polys would cost a hundred and seventy.
  ...pair('abs', 'front', blob(40.6, 77.0, 8.7, 9.0, [1.7, 1.7, 1.7, 1.7])),
  ...pair('abs', 'front', blob(40.6, 87.2, 8.7, 9.0, [1.7, 1.7, 1.7, 1.7])),
  ...pair('abs', 'front', blob(40.6, 97.4, 8.7, 9.0, [1.7, 1.7, 1.7, 1.7])),
  ...pair('abs', 'front', blob(40.6, 107.6, 8.7, 11.4, [1.7, 1.7, 3.6, 3.6])),
  // ...and the external obliques down the flanks, the same muscle in this
  // taxonomy. They now run the full height of the abdomen and take the
  // silhouette's flank as their outer border — through the waist's pinch at
  // y 94 and out again over the iliac crest — so nothing of the trunk between
  // the ribs and the pelvis is bare ground.
  ...pair(
    'abs',
    'front',
    poly(
      [39.4, 74.6],
      [39.2, 88],
      [39.3, 100],
      [39.4, 110],
      [39.2, 121.5],
      [36.4, 117],
      [34.4, 108],
      [36.5, 98],
      [36.4, 86],
      [35.2, 78],
      [36.6, 72.0]
    )
  ),
  // Bicep spindles, filling the upper arm from the deltoid insertion to the
  // elbow crease. A capsule IS a spindle, so this is one view rather than seven.
  ...pair('biceps', 'front', blob(21.4, 68.0, 9.3, 22, [4.65, 4.65, 4.65, 4.65])),
  // Forearms: the brachioradialis belly below the elbow down to the wrist. A
  // capsule, and that is a BUDGET decision rather than a shape one — contoured
  // forearms are four polys across the two views and 56 of the 1,200 views,
  // which the erector columns and the deltoid crowns both wanted more. The
  // forearm's taper is gentle enough that the arm's own silhouette carries it.
  ...pair('forearms', 'front', blob(21.5, 92.4, 7.1, 18.0, [3.55, 3.55, 3.55, 3.55])),
  // Quads as TWO longitudinal masses rather than one sweep and a sliver: the
  // vastus lateralis taking the outer half of the thigh from the hip to the
  // patella, and the rectus femoris + vastus medialis taking the inner half and
  // bulging low above the knee. Together they cover the thigh edge to edge with
  // the intermuscular groove down the middle.
  ...pair(
    'quads',
    'front',
    poly(
      [38.6, 129.0],
      [39.0, 142],
      [39.2, 155],
      [38.6, 165],
      [36.8, 173.5],
      [33.5, 168],
      [31.6, 158],
      [30.9, 146],
      [31.0, 136],
      [32.8, 129.5],
      [35.6, 127.2]
    )
  ),
  ...pair(
    'quads',
    'front',
    poly(
      [46.4, 128.0],
      [46.9, 140],
      [46.6, 152],
      [46.2, 163],
      [45.0, 173],
      [42.8, 179],
      [41.0, 172],
      [40.4, 160],
      [40.2, 146],
      [40.8, 134],
      [43.2, 127.8]
    )
  ),
  // Calves: the two gastrocnemius bellies, the lateral one (a poly, because it
  // tapers into the achilles) and the medial one lower and fuller (a capsule).
  // Both now run the width of the lower leg instead of sitting as lozenges in
  // the middle of it.
  ...pair(
    'calves',
    'front',
    poly(
      [39.5, 183.5],
      [39.8, 192],
      [39.7, 201],
      [39.6, 209],
      [38.6, 214],
      [37.0, 208],
      [35.25, 197],
      [34.3, 190.5],
      [34.8, 184.5]
    )
  ),
  ...pair('calves', 'front', blob(40.9, 185, 4.0, 24, [2.0, 2.0, 2.0, 2.0])),

  // --- BACK ----------------------------------------------------------------
  // Traps: the diamond yoke across the top of the back. Symmetric about the
  // spine, so it is one shape rather than a pair.
  ...single(
    'traps',
    'back',
    poly(
      [50, 34.4],
      [55.6, 36.6],
      [59.6, 39.8],
      [63.0, 43.6],
      [63.8, 48.4],
      [61.2, 53.0],
      [57.4, 57.4],
      [55.0, 64],
      [53.2, 70],
      [50.0, 76],
      [46.8, 70],
      [45.0, 64],
      [42.6, 57.4],
      [38.8, 53.0],
      [36.2, 48.4],
      [37.0, 43.6],
      [40.4, 39.8],
      [44.4, 36.6]
    )
  ),
  // Upper back: the scapular plates, filling the whole span between the trap's
  // lateral border and the deltoid, from the spine of the scapula down to the
  // lat's upper border. Formerly two rounded plates with the flank bare on
  // either side of them.
  ...pair(
    'upper_back',
    'back',
    poly(
      [38.4, 56.2],
      [41.2, 58.2],
      [43.6, 64],
      [45.4, 71],
      [46.6, 76],
      [43.4, 80],
      [38.2, 74],
      [35.2, 68],
      [34.6, 62],
      [35.8, 58]
    )
  ),
  ...pair(
    'side_delts',
    'back',
    poly(
      [33.0, 39.6],
      [30.0, 38.8],
      [27.0, 39.6],
      [25.0, 41.2],
      [23.6, 44],
      [23.1, 49],
      [22.9, 55],
      [23.8, 60],
      [25.4, 64.8],
      [28.2, 64.6],
      [28.3, 62],
      [29.6, 56],
      [30.9, 50],
      [32.2, 44]
    )
  ),
  // Rear delts: the posterior head of the same cap, and NOT a mirror of the
  // anterior one. The anterior head reaches medially onto the clavicle; the
  // posterior head starts at the spine of the scapula, which is much further
  // out — and the difference is load-bearing, because on this view the upper
  // TRAPEZIUS owns the top of the shoulder all the way to the acromion. Giving
  // the two heads one shape put the trap inside the delt.
  ...pair(
    'rear_delts',
    'back',
    poly(
      [35.6, 44.2],
      [35.0, 41.4],
      [34.0, 40.4],
      [33.3, 44],
      [32.0, 50],
      [30.8, 56],
      [29.7, 62],
      [31.4, 64.6],
      [33.2, 58],
      [34.6, 51],
      [35.5, 46.6]
    )
  ),
  // Lats: a wing whose APEX is at the armpit and whose base runs down the
  // thoracolumbar fascia to the iliac crest — broad under the arm, tapering to a
  // point at the lower spine, and taking the flank of the silhouette as its
  // outer border the whole way down.
  ...pair(
    'lats',
    'back',
    poly(
      [35.2, 70.0],
      [39.2, 76.6],
      [43.0, 81.8],
      [43.6, 87],
      [43.6, 99],
      [42.4, 107],
      [38.6, 110.5],
      [36.0, 104],
      [36.4, 94],
      [36.2, 84],
      [35.2, 76]
    )
  ),
  // Lower back: the erector columns flanking the spine, thickening through the
  // lumbar and converging on the sacrum. A poly rather than the capsule it was,
  // because a capsule of this proportion is a stick and the erector's whole
  // shape is that thickening.
  ...pair(
    'lower_back',
    'back',
    poly([49.2, 86], [49.2, 110], [47.8, 117.5], [44.4, 111], [44.8, 98], [46.4, 87.5])
  ),
  // Tricep spindles, on the same arm the biceps ride on the other view.
  ...pair('triceps', 'back', blob(21.4, 68.0, 9.3, 22, [4.65, 4.65, 4.65, 4.65])),
  // Forearms read the same from behind.
  ...pair('forearms', 'back', blob(21.5, 92.4, 7.1, 18.0, [3.55, 3.55, 3.55, 3.55])),
  // Glutes: a rounded mass that meets the pelvis edge above and the gluteal fold
  // below — a poly, not the circle it used to be, because the fold is a straight
  // diagonal and a circle cannot draw one.
  ...pair(
    'glutes',
    'back',
    poly(
      [45.8, 119.5],
      [47.2, 126],
      [46.8, 134],
      [44.6, 140],
      [37.4, 141],
      [35.5, 140.2],
      [32.8, 136.5],
      [31.6, 127],
      [32.0, 120],
      [34.0, 116.4],
      [40.0, 116.2]
    )
  ),
  // Hamstrings in two masses like the quads opposite them: biceps femoris
  // outside, semitendinosus/semimembranosus inside, splitting toward the knee.
  ...pair(
    'hamstrings',
    'back',
    poly(
      [38.8, 142.5],
      [39.0, 154],
      [39.2, 165],
      [38.4, 174],
      [35.2, 176],
      [33.4, 166],
      [31.5, 154],
      [30.9, 141.5],
      [33.6, 140.5]
    )
  ),
  ...pair(
    'hamstrings',
    'back',
    poly(
      [46.6, 143],
      [46.6, 154],
      [46.2, 165],
      [45.0, 175],
      [42.8, 178.5],
      [41.0, 172],
      [40.4, 160],
      [40.4, 148],
      [41.2, 142],
      [43.4, 140.8]
    )
  ),
  // Calves read the same from behind — same bellies, same places.
  ...pair(
    'calves',
    'back',
    poly(
      [39.5, 183.5],
      [39.8, 192],
      [39.7, 201],
      [39.6, 209],
      [38.6, 214],
      [37.0, 208],
      [35.25, 197],
      [34.3, 190.5],
      [34.8, 184.5]
    )
  ),
  ...pair('calves', 'back', blob(40.9, 185, 4.0, 24, [2.0, 2.0, 2.0, 2.0])),
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
