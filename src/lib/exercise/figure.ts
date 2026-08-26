/**
 * The body figure's geometry — pure data plus the maths that turns it into SVG
 * path strings and gradient stops. No React.
 *
 * ## The technique changed on 2026-08-25, and this is why
 *
 * Five rounds of this drawing were rejected. Every one of them was drawn out of
 * filled React Native `View`s: rounded rects for the rounded masses, and
 * polygons rasterised by hand into stacks of horizontal one-`View` scanline
 * bars for anything that tapered. That was a deliberate constraint —
 * `react-native-svg` is a native module, and a native module costs the owner an
 * EAS build, so the figure would have been invisible on the binary he had.
 *
 * **The owner has rebuilt and called the build cost low, so the constraint is
 * gone**, and `react-native-svg` 15.15.4 is the one new dependency.
 *
 * The specific ceiling the `View` version hit is worth naming, because it is
 * what the new primitive has to buy: **internal shading**. Every muscle was one
 * FLAT colour bounded by one ink line, so the drawing read as a coloured MAP —
 * a set of regions, each labelled by tint — rather than as a rendering of a
 * body. Anatomy plates do not get their depth from their outlines; they get it
 * from the gradient WITHIN each belly, which is what says "this is a mass that
 * bulges toward you" instead of "this is an area". A `View` cannot hold a
 * gradient, and there is no arrangement of flat `View`s that fakes one at this
 * size.
 *
 * So every mark is now a `<Path>`:
 *
 *   - **Real bezier outlines.** {@link Contour} is a closed centripetal
 *     Catmull–Rom spline through a list of anchors, emitted as cubic beziers by
 *     {@link pathD}. The anchors are largely the SAME coordinates the polygon
 *     version used — that layout is four rounds of anatomical iteration and
 *     throwing it away would have been vandalism — but where the polygon form
 *     could only turn a corner, the spline now turns a curve. No scanline
 *     rasterising, no stair-stepping, no `View` budget, one node per shape.
 *   - **A gradient per muscle** ({@link Shade}), which is the whole point of the
 *     change. See "What each muscle's shading is doing" below.
 *   - **Variable stroke weight** ({@link BODY_STROKE_PT},
 *     {@link MUSCLE_STROKE_PT}), specified in RENDERED POINTS and converted to
 *     grid units per size by {@link strokeUnits} — so the silhouette is a heavy
 *     drawn contour, a muscle border is a hairline, and both hold their weight
 *     at 72pt as well as at 128pt instead of vanishing or bloating.
 *
 * ## The shading is budgeted, not free
 *
 * A muscle's gradient runs from a highlight to a shadow either side of the ramp
 * colour, and the highlight is what the accessibility argument has to survive:
 * every reading already has to clear WCAG 1.4.11's 3:1 against the plate, and
 * the spent end sits at exactly 3.14:1 with no headroom at all.
 *
 * Two fixes were tried. The first darkened {@link MUSCLE_SPENT} to make room,
 * and it worked — until the suite showed the cost: the ramp's ends had been
 * 2.36:1 apart in LUMINANCE, which is what carries the reading for a hue-blind
 * reader or a greyscale render, and darkening the spent end collapsed that to
 * 1.69:1. The second, which is what ships, leaves the ramp alone and makes the
 * HIGHLIGHT yield instead: {@link liftBudget} lightens each reading only as far
 * as {@link CONTRAST_FLOOR} allows. A dark reading has a large budget and takes
 * the full {@link SHADE_LIFT}; the spent end has none and is modelled by its
 * shadow alone, which is exactly what a light mass wants anyway.
 *
 * So every published number survives the round unchanged — 3.14:1 spent against
 * the plate, 2.36:1 across the ends — and the floor is now enforced at every
 * PIXEL rather than at a nominal fill, which is strictly stronger than the flat
 * version could claim.
 *
 * ## What each muscle's shading is doing
 *
 * Three primitives, chosen by what the muscle IS:
 *
 *   {@link belly}   a cylinder. Dark border → lit crest → dark border, across
 *                   the SHORT axis. Anything with parallel fibres: the pec, the
 *                   deltoid straps, the obliques, the two quad masses, the two
 *                   hamstring masses, the lats, the erector columns.
 *   {@link dome}    a rounded mass. A lit core falling to a dark rim, in
 *                   object-bounding-box units so the highlight stretches with
 *                   the shape. The glute, the deltoid cap, each ab segment, the
 *                   bicep and tricep spindles, the forearm, the calf bellies.
 *   {@link furrow}  two crests either side of a dark valley. One shape, one
 *                   gradient, and it draws the spinal groove down the trapezius
 *                   yoke — which is the single most recognisable cue on a back.
 *
 * The erectors get the same effect from a mirrored PAIR of bellies whose dark
 * ends meet at the midline, so the lumbar furrow continues below the yoke.
 *
 * ## The invariants survived the port
 *
 * `db/exercise-ai.test.mjs` §1 asserted containment, non-overlap and — added
 * last round, because containment passed all four rejected versions — per-band
 * COVERAGE floors, since sixteen pills floating in the middle of a body satisfy
 * containment perfectly. None of that is lost: {@link flatten} turns a bezier
 * contour back into a dense polygon (eight samples per segment, far finer than
 * anything the eye resolves), and every geometric predicate below runs on that.
 * The floors went UP with the port, because curves fill more of a band than the
 * chords they replaced.
 *
 * ## Look at the drawing
 *
 * `db/figure-preview.mjs` renders this geometry to a PNG offline, gradients and
 * strokes included, with no simulator and no device. It has caught something
 * real in every round it has been run, including this one. Five rounds of this
 * file are five pieces of evidence that "these coordinates describe a deltoid"
 * and "this reads as a person" are different claims.
 *
 * ## Coordinates
 *
 * A 100 × 240 design grid, origin top-left, emitted as the SVG `viewBox`; the
 * component scales it to the available width. Left/right pairs are two shapes
 * sharing one muscle — a freshness score fills both.
 */
import { palette } from '@/constants/theme';

import type { Muscle } from './types';

export type FigureSide = 'front' | 'back';

/** A point in grid units. */
export type Pt = readonly [number, number];

/** A rect in grid units, origin top-left of the figure box. */
export type FigureRect = { x: number; y: number; w: number; h: number };

/**
 * One stop of a shading gradient: `[at, depth]`, where `at` is 0–1 along the
 * gradient and `depth` is SIGNED — positive mixes the muscle's own colour toward
 * {@link SHADE_INK}, negative toward {@link SHADE_LIT}. Depth 0 is the ramp
 * colour itself, which is what the muscle reads as and what the scale bar shows.
 */
export type ShadeStop = readonly [at: number, depth: number];

/**
 * A muscle's internal shading, in OBJECT-BOUNDING-BOX units: every coordinate
 * is 0–1 across the shape's own bounds, so one description works at any size
 * and mirrors cleanly. A radial gradient in these units stretches with the box,
 * which is what makes one {@link dome} fit both a glute and a calf belly.
 */
export type Shade =
  | { kind: 'linear'; a: Pt; b: Pt; stops: readonly ShadeStop[] }
  | { kind: 'radial'; c: Pt; r: number; stops: readonly ShadeStop[] };

/**
 * A closed outline: the anchors of a centripetal Catmull–Rom spline, emitted as
 * cubic beziers by {@link pathD}.
 *
 * Centripetal (α = ½) rather than uniform or chordal because it is the
 * parametrisation that provably cannot cusp or self-intersect between anchors —
 * which matters when the anchors are anatomical landmarks placed by hand at
 * uneven spacing, as every one of these is. `tension` pulls the control points
 * back toward their anchors: 0 is fully round, 1 is the original polygon.
 */
export type Contour = { kind: 'contour'; pts: readonly Pt[]; tension: number };

export type Shape = Contour;

/**
 * One block of the body ground. `neutral` marks the parts that carry NO reading
 * — head, hands, feet — which the component fills in the PLATE colour instead
 * of the muscle ground, so the eye learns which regions are data before reading
 * any. Neutral parts also take no {@link Shade}: they are flat where every
 * other surface is modelled, which is a second, non-colour way of saying "not
 * data".
 */
export type FigureBodyPart = { part: string; neutral?: boolean; shape: Shape; shade?: Shade };

/** One muscle's shape on one side, with the gradient that models it. */
export type FigureMuscleShape = {
  muscle: Muscle;
  side: FigureSide;
  shape: Shape;
  shade: Shade;
};

/** The design grid the figure is placed on, and the SVG `viewBox`. */
export const FIGURE_GRID = { w: 100, h: 240 } as const;

/**
 * The silhouette's contour, in RENDERED POINTS.
 *
 * Stroke weight is specified in points and converted to grid units per size by
 * {@link strokeUnits}, which is the opposite of what a naive port would do. A
 * width fixed in grid units renders 1.8× heavier at 128pt than at 72pt: the
 * hub's figure would be a woodcut and the exercise-detail one would have no
 * contour at all. Fixing the RENDERED weight is what lets one geometry serve
 * three sizes.
 *
 * Drawn as a stroke centred on the path, so half of it lands outside the fill —
 * the pass that draws it uses double this width and is then over-painted by the
 * fills (see the two-pass note on {@link FIGURE_BODY}).
 */
export const BODY_STROKE_PT = 1.15;

/**
 * The ink line around each MUSCLE, in rendered points.
 *
 * It is load-bearing rather than decorative: two ADJACENT muscles reading the
 * same freshness are the same colour, so nothing but this line separates them.
 * At 9.74:1 against the ground it encloses it also keeps every contour readable
 * whatever the fill has done.
 *
 * Thinner than the `View` version's line (0.7 GRID units — 0.9pt at the hub
 * size, and unavoidably ragged, since a `View` border cannot antialias a
 * curve). A crisp 0.62pt bezier stroke reads as a drawn line where a 0.9pt
 * stair-stepped one read as a border, and a heavy border round every region is
 * exactly what made the old drawing look like a map.
 */
export const MUSCLE_STROKE_PT = 0.62;

/**
 * The line round the non-data parts, in rendered points — drawn in the FILL
 * pass as well as the contour pass, unlike everything else.
 *
 * That is what puts a wrist line where the hand meets the forearm, an ankle
 * line above the foot and a jaw line where the chin crosses the neck. Without
 * it the neutral fill simply erases the limb's contour at the join and the hand
 * fuses into the arm.
 */
export const NEUTRAL_STROKE_PT = 0.55;

/** A stroke weight given in rendered points, expressed in grid units. */
export function strokeUnits(pt: number, scale: number): number {
  return pt / scale;
}

/**
 * The two ends of the freshness ramp. A muscle's CREST interpolates between
 * them in colour, at full opacity — it does not fade.
 *
 * ## The change (owner, 2026-08-14): *"have spent muscles fade to grey instead
 * of dark green"*
 *
 * The retired ramp was one hue, `signal-optimal-ink`, at alpha 0.45 → 1.0 over
 * the body ground, so a spent muscle was a PALE GREEN. Two things were wrong
 * with that beyond the owner not liking it. A translucent fill has to be
 * composited against whatever is under it to know what colour it actually is.
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
 *   freshness   fill       vs plate   brightest pixel   its floor
 *      0        #8F8978     3.14:1        #8F8978        3.14:1
 *     50        #547257     4.82:1        #6E8467        3.37:1
 *    100        #185A36     7.41:1        #3E7454        4.71:1
 *
 * The "brightest pixel" column is what 2026-08-25 added and what the suite now
 * measures the floor at: a muscle is a gradient, so the reading is a range, and
 * the number that has to clear 3:1 is the lightest end of it. The spent end gets
 * no lift at all — {@link liftBudget} has nothing to spend there — which is why
 * its two columns are the same colour and the published 3.14 is untouched.
 *
 * The midpoint is a **sage green** (84, 114, 87), not mud. That is worth stating
 * because green→warm-grey is exactly the interpolation that goes olive if the
 * green channel dips: here G stays the largest channel until t = 0.92, and past
 * that R leads it by at most 6/255, which is nothing. Checked in the suite, not
 * hoped for.
 *
 * The roll call is unchanged and is still the carrier that owes nothing to
 * colour: `MuscleFigureLegend` names every recovering and fatigued muscle in
 * words.
 */
export const MUSCLE_FRESH = '#185A36';
export const MUSCLE_SPENT = '#8F8978';

/**
 * What the shading mixes TOWARD at each end, and how far it is allowed to go.
 *
 * ## The first version of this shaded DOWNWARDS only, and it was invisible
 *
 * The obvious way to keep WCAG safe is to make the ramp colour the muscle's
 * lightest pixel and let the gradient only darken. That was the first attempt
 * this round, and the preview killed it: `signalInk.optimal` is #185A36, a
 * colour picked to clear 4.5:1 as *text*, so it is already nearly black. Shading
 * it downward moves it from very dark green to slightly darker green, and an
 * all-fresh figure — which is the DEFAULT state, what a new user sees — rendered
 * as a flat green cut-out. The whole point of the round was lost to a
 * conservatism that bought nothing.
 *
 * So a muscle now has a real highlight as well as a real shadow: the ramp colour
 * is its MID tone, {@link SHADE_LIFT} lifts the crest toward the paper family's
 * light, and {@link SHADE_MAX} drops the borders toward the app's ink.
 *
 * ## What that costs, and how it is paid
 *
 * The lightest pixel of a muscle is now lighter than the ramp colour, so the
 * WCAG 1.4.11 floor has to be measured THERE and not at the nominal fill —
 * db/exercise-ai.test.mjs does exactly that, over all 101 readings, which is a
 * strictly stronger check than the one it replaces.
 *
 * The lift is therefore not a constant but a BUDGET ({@link liftBudget}): each
 * reading is lightened only as far as {@link CONTRAST_FLOOR} allows. The dark
 * end of the ramp has plenty and takes the whole {@link SHADE_LIFT}; the spent
 * end has none and is modelled by its shadow instead. Moving {@link MUSCLE_SPENT}
 * darker to buy headroom was tried first and is recorded above as the thing that
 * quietly cost a colourblind reader most of the ramp.
 *
 * Both ends stay inside the app's own families — `ink` for the shadow (a warm
 * black; a cold black turns the warm grey blue and the signal green bottle) and
 * a `paper` light for the highlight, so a lit muscle looks like paper light
 * falling on it rather than like a fourth colour.
 */
export const SHADE_INK = '#1C1911';
export const SHADE_LIT = '#EFEBDD';
export const SHADE_MAX = 0.34;
export const SHADE_LIFT = 0.2;

/**
 * The floor every pixel of every muscle has to clear against the plate.
 *
 * WCAG 1.4.11 asks 3:1 for a graphical object. This is 3.14, which is the number
 * the FLAT version published for the spent end against the plate — and the plate
 * is also what the head, hands and feet are drawn in, so that same 3.14 is the
 * separation between "a spent muscle" and "a part that carries no reading". It
 * is therefore not a floor to be spent: a highlight that took a spent muscle
 * from 3.14 to 3.02 would be quietly trading an accessibility guarantee for a
 * nicer render. The budget stops at the published number.
 */
export const CONTRAST_FLOOR = 3.14;

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
 * Freshness 0-100 → the CREST colour it draws at: spent grey at 0, signal green
 * at 100, opaque throughout. Every other pixel of that muscle is this colour
 * darkened by its gradient.
 *
 * The alpha in the return type is not vestigial — `muscles` mode (which shows
 * the muscles a MOVEMENT works, a fact about an exercise and never a
 * biological state) draws translucent ink instead, and the component's one fill
 * path serves both.
 */
export function freshnessFill(freshness: number): { color: string; alpha: number } {
  const f = Math.max(0, Math.min(100, Number.isFinite(freshness) ? freshness : 0));
  return { color: mixHex(MUSCLE_SPENT, MUSCLE_FRESH, f / 100), alpha: 1 };
}

/** Relative luminance of an `#RRGGBB`, per WCAG. */
function relLum(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

const PLATE_LUM = relLum(palette.paperHi);

/** WCAG contrast of a colour against the plate the figure sits on. */
function onPlate(hex: string): number {
  const l = relLum(hex);
  return (Math.max(l, PLATE_LUM) + 0.05) / (Math.min(l, PLATE_LUM) + 0.05);
}

const liftCache = new Map<string, number>();

/**
 * How far a colour may be lightened before it stops clearing WCAG 1.4.11's 3:1
 * against the plate — the highlight's budget, per reading.
 *
 * ## This is the answer to the round's one real conflict
 *
 * A highlight needs headroom above the fill, and the spent end of the ramp has
 * none: #8F8978 is 3.14:1, chosen years ago as the lightest warm grey that
 * clears the floor. The first fix was to darken {@link MUSCLE_SPENT} to make
 * room, and it worked — until the suite pointed out what it cost. The ends of
 * the ramp had been **2.36:1 apart in luminance**, which is what makes the
 * reading survive a greyscale render or a hue-blind reader; darkening the spent
 * end collapsed that to 1.69:1. A brighter drawing that a colourblind reader can
 * no longer read is not an improvement.
 *
 * So the ramp's ends are untouched and the HIGHLIGHT yields instead. A dark
 * reading has a large budget and gets the full {@link SHADE_LIFT}; a light one
 * has none and is modelled by its shadow alone. That is not a compromise
 * dressed up — it is how a painter works: a dark mass reads through its
 * highlight, a light mass through its shadow, and neither needs both. The spent
 * end has plenty of shadow range precisely because it is light.
 *
 * Cached by colour, since the ramp only produces 101 of them.
 */
function liftBudget(base: string): number {
  const hit = liftCache.get(base);
  if (hit != null) return hit;
  let lo = 0;
  let hi = SHADE_LIFT;
  if (onPlate(mixHex(base, SHADE_LIT, hi)) >= CONTRAST_FLOOR) {
    liftCache.set(base, hi);
    return hi;
  }
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (onPlate(mixHex(base, SHADE_LIT, mid)) >= CONTRAST_FLOOR) lo = mid;
    else hi = mid;
  }
  liftCache.set(base, lo);
  return lo;
}

/**
 * A base colour pushed `depth` of the way toward the shadow ink, or — for a
 * negative depth — toward the highlight, as far as {@link liftBudget} allows.
 *
 * Clamped at both ends, so neither a bad stop in the data nor a re-tuned ramp
 * can walk a muscle out of its contrast budget.
 */
export function shadeColor(base: string, depth: number): string {
  if (depth < 0) return mixHex(base, SHADE_LIT, Math.min(liftBudget(base), -depth));
  return mixHex(base, SHADE_INK, Math.min(SHADE_MAX, depth));
}

/** The lightest colour a muscle at this reading can print — the WCAG worst case. */
export function brightestFill(freshness: number): string {
  return shadeColor(freshnessFill(freshness).color, -SHADE_LIFT);
}

/** A shade's stops resolved against one base colour, ready for `<Stop>`. */
export function shadeStops(shade: Shade, base: string): { offset: number; color: string }[] {
  return shade.stops.map(([at, depth]) => ({ offset: at, color: shadeColor(base, depth) }));
}

// --- the shading vocabulary --------------------------------------------------

const lin = (a: Pt, b: Pt, stops: ShadeStop[]): Shade => ({ kind: 'linear', a, b, stops });
const rad = (c: Pt, r: number, stops: ShadeStop[]): Shade => ({ kind: 'radial', c, r, stops });

/**
 * A CYLINDER — dark border, lit crest, dark border — across the axis `a`→`b`.
 *
 * The axis for a muscle with parallel fibres runs perpendicular to them, because
 * that is the direction the belly actually rounds in: a rectus femoris is flat
 * along its length and curved across it. `crest` biases the lit line off centre,
 * which is what stops two neighbouring masses reading as one symmetrical tube.
 */
function belly(a: Pt, b: Pt, crest = 0.44, near = 0.3, far = 0.28): Shade {
  return lin(a, b, [
    [0, near],
    [crest * 0.42, 0],
    [crest, -SHADE_LIFT],
    [crest + (1 - crest) * 0.45, 0],
    [1, far],
  ]);
}

/**
 * A ROUNDED MASS — a lit core at (`cx`, `cy`) falling to a dark rim.
 *
 * In object-bounding-box units, so the highlight stretches with the shape: the
 * same call models a glute (nearly square) and a calf belly (six times as tall
 * as it is wide), and in both cases the bright patch runs the length of the
 * muscle rather than sitting on it as a circle.
 */
function dome(cx: number, cy: number, r = 0.82, rim = 0.32): Shade {
  return rad([cx, cy], r, [
    [0, -SHADE_LIFT],
    [0.38, -SHADE_LIFT * 0.45],
    [0.66, rim * 0.3],
    [1, rim],
  ]);
}

/**
 * TWO CRESTS EITHER SIDE OF A DARK VALLEY, across the shape's width.
 *
 * One shape, one gradient, and it draws the spinal groove down the middle of the
 * trapezius yoke. A trap drawn as a flat diamond is the most obviously wrong
 * thing on a back view; the furrow is what makes it read as two slabs of muscle
 * meeting at the spine.
 */
function furrow(deep = 0.3, edge = 0.28): Shade {
  return lin(
    [0, 0.5],
    [1, 0.5],
    [
      [0, edge],
      [0.28, -SHADE_LIFT],
      [0.5, deep],
      [0.72, -SHADE_LIFT],
      [1, edge],
    ]
  );
}

/** The body ground's own rounding — every limb is a cylinder too, gently. */
const GROUND_SHADE: Shade = lin(
  [0, 0.5],
  [1, 0.5],
  [
    [0, 0.16],
    [0.46, -0.07],
    [1, 0.16],
  ]
);

/**
 * How hard the spline is pulled back toward its anchors, per layer.
 *
 * These two numbers are the second thing the preview caught this round, and the
 * reason they differ is anatomical rather than aesthetic. At tension 0 — a
 * fully-round Catmull–Rom — every shape balloons into an OVAL: the pectoral fan
 * loses its straight sternal border, the trapezius diamond loses its four
 * points, the rectus segments turn into circles. The anchors were authored as
 * landmarks, and a landmark is a place the outline should PASS THROUGH and
 * often turn at, not a place to bulge past.
 *
 * So the MUSCLES run tight enough to keep their corners, and the BODY runs loose
 * because a silhouette genuinely has no corners in it — a shoulder rounding into
 * an arm, a calf into an ankle. One tension for both gave either boxes or
 * balloons, which is the same trap the previous five rounds kept falling into
 * one layer at a time.
 */
const MUSCLE_TENSION = 0.34;
const BODY_TENSION = 0.12;

/** How finely a bezier segment is sampled when a contour is flattened. */
const FLATTEN_STEPS = 8;

const flatCache = new WeakMap<Shape, Pt[]>();
const pathCache = new WeakMap<Shape, string>();
const boundsCache = new WeakMap<Shape, FigureRect>();

const c = (pts: Pt[], tension = MUSCLE_TENSION): Contour => ({ kind: 'contour', pts, tension });

/** A body-ground contour: the same thing, run loose. */
const bc = (pts: Pt[]): Contour => c(pts, BODY_TENSION);

/**
 * One segment of the rectus sheet: a rounded rectangle, but authored as eight
 * spline anchors with the long edges bowed outward by a third of a unit, so the
 * segment reads as a swollen block rather than a chip of tile.
 */
function absSegment(x: number, y: number, w: number, h: number): Contour {
  const r = 1.2;
  const bow = 0.34;
  return c([
    [x + r, y],
    [x + w - r, y],
    [x + w + bow, y + r],
    [x + w + bow, y + h - r],
    [x + w - r, y + h],
    [x + r, y + h],
    [x - bow, y + h - r],
    [x - bow, y + r],
  ]);
}

// --- the body ----------------------------------------------------------------

/**
 * The body ground — head to feet, shared by both views.
 *
 * ## Two passes, and the order matters
 *
 * The component draws this list TWICE: once with a heavy ink stroke and no
 * fill, then again with fills and no stroke. Every stroke that lands inside the
 * union of the fills is painted over, so what survives is exactly the OUTER
 * silhouette — one contour round a whole person, out of eleven overlapping
 * shapes, with no internal seams. One list, two `map`s.
 *
 * The paint order below is therefore load-bearing, and is authored in it: hands
 * come after arms and feet after legs so a wrist and an ankle sit in front of
 * the limb they end, and **the head comes LAST** so the chin is drawn over the
 * neck rather than the neck over the chin. Getting that backwards leaves the
 * torso's neck-top stroke stranded across the jaw.
 *
 * ## Proportions
 *
 * A standing figure of about eight heads with the arms slightly abducted, which
 * is what separates them from the hips instead of fusing the silhouette into a
 * slab. Crown 3 · chin 32 · shoulder line 42 · nipple 60 · navel 92 · waist
 * (narrowest) 99 · iliac crest 117 · crotch 135 · knee 180 · ankle 226 · sole
 * 238. Head 22 wide, shoulders 55, waist 30, hips 39.
 *
 * ## `neutral`
 *
 * Head, hands and feet carry no reading, and say so twice over: they are drawn
 * in the PLATE colour — the page showing through an ink outline — and they are
 * the only surfaces in the drawing with no gradient on them. Plate against the
 * spent grey is 3.14:1, and "empty" is a stronger statement than "a different
 * grey" anyway.
 */
export const FIGURE_BODY: FigureBodyPart[] = [
  // The torso — neck, clavicle, ribcage, waist, hip flare, crotch — as one
  // continuous contour. Anchors from the polygon version; the spline is what
  // turns the clavicle run and the waist pinch into curves.
  {
    part: 'torso',
    shade: GROUND_SHADE,
    shape: bc([
      [47.0, 24.4],
      [45.0, 25.4],
      [44.5, 30.6],
      [43.4, 35.2],
      [40.0, 37.6],
      [35.4, 40.6],
      [32.2, 44.2],
      [30.9, 51.0],
      [31.8, 60.0],
      [33.2, 71.0],
      [34.9, 84.0],
      [35.6, 95.0],
      [35.2, 101.0],
      [33.4, 109.0],
      [31.0, 117.0],
      [30.6, 126.0],
      [33.0, 131.0],
      [41.0, 134.0],
      [46.2, 136.0],
      [50.0, 139.6],
      [53.8, 136.0],
      [59.0, 134.0],
      [67.0, 131.0],
      [69.4, 126.0],
      [69.0, 117.0],
      [66.6, 109.0],
      [64.8, 101.0],
      [64.4, 95.0],
      [65.1, 84.0],
      [66.8, 71.0],
      [68.2, 60.0],
      [69.1, 51.0],
      [67.8, 44.2],
      [64.6, 40.6],
      [60.0, 37.6],
      [56.6, 35.2],
      [55.5, 30.6],
      [55.0, 25.4],
      [53.0, 24.4],
    ]),
  },

  // The deltoid caps — what give the figure a shoulder rather than a corner.
  // Each overlaps the torso inward and the arm downward, so the contour pass
  // fuses all three into one silhouette.
  {
    part: 'shoulder-l',
    shade: GROUND_SHADE,
    shape: bc([
      [36.0, 37.6],
      [31.0, 36.9],
      [26.2, 38.4],
      [23.0, 42.6],
      [21.9, 48.2],
      [22.1, 54.6],
      [23.4, 59.0],
      [32.0, 59.4],
      [38.4, 56.0],
      [42.4, 49.0],
      [43.4, 42.4],
      [40.4, 38.6],
    ]),
  },
  {
    part: 'shoulder-r',
    shade: GROUND_SHADE,
    shape: bc([
      [64.0, 37.6],
      [69.0, 36.9],
      [73.8, 38.4],
      [77.0, 42.6],
      [78.1, 48.2],
      [77.9, 54.6],
      [76.6, 59.0],
      [68.0, 59.4],
      [61.6, 56.0],
      [57.6, 49.0],
      [56.6, 42.4],
      [59.6, 38.6],
    ]),
  },

  // Arms, slightly abducted: upper arm → elbow pinch → forearm belly → wrist.
  // The abduction is what keeps the forearm off the hip; arms hanging dead
  // vertical fuse into the torso and the figure becomes a slab.
  {
    part: 'arm-l',
    shade: GROUND_SHADE,
    shape: bc([
      [24.0, 45.0],
      [30.0, 45.2],
      [36.2, 47.6],
      [34.6, 56.0],
      [33.2, 66.0],
      [31.8, 76.0],
      [30.8, 84.0],
      [30.2, 90.5],
      [30.0, 96.0],
      [29.4, 104.0],
      [28.4, 112.0],
      [27.4, 118.0],
      [26.4, 121.4],
      [23.6, 121.6],
      [22.2, 118.6],
      [21.4, 112.0],
      [20.8, 104.0],
      [20.4, 97.0],
      [21.6, 90.5],
      [21.2, 82.0],
      [20.9, 72.0],
      [21.2, 62.0],
      [22.0, 52.0],
    ]),
  },
  {
    part: 'arm-r',
    shade: GROUND_SHADE,
    shape: bc([
      [76.0, 45.0],
      [70.0, 45.2],
      [63.8, 47.6],
      [65.4, 56.0],
      [66.8, 66.0],
      [68.2, 76.0],
      [69.2, 84.0],
      [69.8, 90.5],
      [70.0, 96.0],
      [70.6, 104.0],
      [71.6, 112.0],
      [72.6, 118.0],
      [73.6, 121.4],
      [76.4, 121.6],
      [77.8, 118.6],
      [78.6, 112.0],
      [79.2, 104.0],
      [79.6, 97.0],
      [78.4, 90.5],
      [78.8, 82.0],
      [79.1, 72.0],
      [78.8, 62.0],
      [78.0, 52.0],
    ]),
  },

  // Legs: thigh → knee pinch → calf belly → ankle. The pinch and the belly are
  // the whole reason these are contours and not capsules.
  {
    part: 'leg-l',
    shade: GROUND_SHADE,
    shape: bc([
      [32.6, 126.0],
      [40.0, 126.4],
      [48.2, 127.4],
      [48.4, 141.0],
      [47.8, 156.0],
      [46.6, 170.0],
      [45.6, 180.0],
      [46.6, 192.0],
      [45.4, 205.0],
      [44.3, 216.0],
      [44.0, 226.0],
      [37.6, 226.0],
      [36.9, 216.0],
      [35.4, 205.0],
      [33.4, 192.0],
      [34.8, 180.0],
      [33.0, 170.0],
      [30.6, 156.0],
      [29.8, 141.0],
    ]),
  },
  {
    part: 'leg-r',
    shade: GROUND_SHADE,
    shape: bc([
      [67.4, 126.0],
      [60.0, 126.4],
      [51.8, 127.4],
      [51.6, 141.0],
      [52.2, 156.0],
      [53.4, 170.0],
      [54.4, 180.0],
      [53.4, 192.0],
      [54.6, 205.0],
      [55.7, 216.0],
      [56.0, 226.0],
      [62.4, 226.0],
      [63.1, 216.0],
      [64.6, 205.0],
      [66.6, 192.0],
      [65.2, 180.0],
      [67.0, 170.0],
      [69.4, 156.0],
      [70.2, 141.0],
    ]),
  },

  // Hands: a paddle with a knuckle edge, drawn AFTER the arm so the wrist line
  // (NEUTRAL_STROKE_PT, drawn in the fill pass) lands on top of it.
  {
    part: 'hand-l',
    neutral: true,
    shape: bc([
      [24.8, 116.0],
      [27.2, 117.4],
      [28.3, 121.0],
      [28.0, 125.0],
      [26.4, 127.6],
      [24.2, 128.2],
      [22.4, 127.0],
      [21.4, 123.4],
      [21.4, 119.6],
      [22.6, 116.8],
    ]),
  },
  {
    part: 'hand-r',
    neutral: true,
    shape: bc([
      [75.2, 116.0],
      [72.8, 117.4],
      [71.7, 121.0],
      [72.0, 125.0],
      [73.6, 127.6],
      [75.8, 128.2],
      [77.6, 127.0],
      [78.6, 123.4],
      [78.6, 119.6],
      [77.4, 116.8],
    ]),
  },

  // Feet, likewise after the legs, so the ankle line reads.
  {
    part: 'foot-l',
    neutral: true,
    shape: bc([
      [41.2, 222.0],
      [44.2, 223.8],
      [45.2, 228.6],
      [44.8, 233.4],
      [43.0, 236.2],
      [39.6, 236.6],
      [37.0, 234.8],
      [36.3, 230.4],
      [37.0, 225.6],
      [38.6, 222.6],
    ]),
  },
  {
    part: 'foot-r',
    neutral: true,
    shape: bc([
      [58.8, 222.0],
      [55.8, 223.8],
      [54.8, 228.6],
      [55.2, 233.4],
      [57.0, 236.2],
      [60.4, 236.6],
      [63.0, 234.8],
      [63.7, 230.4],
      [63.0, 225.6],
      [61.4, 222.6],
    ]),
  },

  // The skull LAST: a cranium, a temple, a cheekbone, a jaw and a chin rather
  // than the 22 × 28 rounded rectangle it was, because a pill on a neck is the
  // first thing that stops a drawing being a person. Drawn over the neck.
  {
    part: 'head',
    neutral: true,
    shape: bc([
      [50.0, 2.8],
      [54.4, 3.6],
      [57.8, 6.4],
      [59.4, 11.0],
      [59.6, 16.2],
      [58.4, 20.8],
      [56.4, 24.8],
      [53.6, 28.4],
      [50.0, 29.9],
      [46.4, 28.4],
      [43.6, 24.8],
      [41.6, 20.8],
      [40.4, 16.2],
      [40.6, 11.0],
      [42.2, 6.4],
      [45.6, 3.6],
    ]),
  },
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
  return { ...shape, pts: shape.pts.map(([x, y]) => [FIGURE_GRID.w - x, y] as Pt) };
}

/**
 * ...and its shading reflected with it, in bounding-box space.
 *
 * Not an afterthought: a gradient that lit the left quadriceps from the
 * intermuscular groove and the right one from the flank makes one leg look
 * twisted, which is exactly what happens when only the outline is reflected.
 */
function mirrorShade(shade: Shade): Shade {
  if (shade.kind === 'linear') {
    return { ...shade, a: [1 - shade.a[0], shade.a[1]], b: [1 - shade.b[0], shade.b[1]] };
  }
  return { ...shade, c: [1 - shade.c[0], shade.c[1]] };
}

/**
 * How far every muscle is grown along its own outward normals before it is
 * placed, in grid units — one lever, applied centrally, rather than thirty
 * hand-nudged coordinate lists.
 *
 * The preview's fifth pass showed the drawing still reading as PODS on a
 * mannequin: the outlines were right and the shading was right, but a 1.4-unit
 * channel of bare ground ran between every pair of neighbours, and at 118pt a
 * 1.4-unit channel is a visible grey stripe rather than the hairline an anatomy
 * plate has. Smoothing had made it worse — a spline cuts the corner on a concave
 * run, so every shape lost a little area to the port.
 *
 * Growing closes the gap from BOTH sides at once, so this takes a 1.4 channel
 * down to about the width of the ink line that is supposed to be the only
 * separation. It is capped by the silhouette rather than by taste: past ~0.5 the
 * obliques, the deltoid caps and the vastus lateralis start pushing through the
 * body's outline and  fails in the suite.
 */
const MUSCLE_GROW = 0.34;

/**
 * A contour offset outward along its own vertex normals.
 *
 * The winding is MEASURED rather than assumed (the shoelace sign), because these
 * anchor lists were authored by hand over five rounds and are not consistently
 * wound; a fixed sign would have quietly shrunk half the drawing instead of
 * growing it. The offset is mitred at each anchor — divided by the cosine
 * between the vertex normal and its edge normals — so a sharp corner like the
 * apex of a lat wing moves out as far as its edges do rather than rounding off,
 * with a floor on the divisor so a near-cusp cannot fire off to infinity.
 */
const inBody = (x: number, y: number) => FIGURE_BODY.some((b) => insideShape(b.shape, x, y));

function grow(shape: Shape, d: number): Shape {
  const p = shape.pts;
  const n = p.length;
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const q = p[i]!;
    const r = p[(i + 1) % n]!;
    area2 += q[0] * r[1] - r[0] * q[1];
  }
  const sgn = area2 > 0 ? 1 : -1;
  const edgeNormal = (a: Pt, b: Pt): Pt => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [(sgn * dy) / l, (-sgn * dx) / l];
  };
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const cur = p[i]!;
    const n1 = edgeNormal(p[(i - 1 + n) % n]!, cur);
    const n2 = edgeNormal(cur, p[(i + 1) % n]!);
    let nx = n1[0] + n2[0];
    let ny = n1[1] + n2[1];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    let k = d / Math.max(0.4, n1[0] * nx + n1[1] * ny);
    // ...but never past the silhouette. Growing uniformly was the first attempt
    // and it pushed eight shapes off the body at once — the bicep and the calf
    // bellies are already flush with the limb's outline and have nowhere to go,
    // while the pec and the lat had a unit of slack each. Bisecting for the
    // largest offset that stays inside gives every anchor the growth its own
    // neighbourhood can afford, which is the difference between one lever and
    // thirty hand-nudged coordinates.
    if (!inBody(cur[0] + nx * k, cur[1] + ny * k)) {
      let lo = 0;
      let hi = k;
      for (let step = 0; step < 14; step++) {
        const mid = (lo + hi) / 2;
        if (inBody(cur[0] + nx * mid, cur[1] + ny * mid)) lo = mid;
        else hi = mid;
      }
      // A margin, because the bezier bows OUTWARD between anchors: an anchor
      // exactly on the outline puts the curve beside it just outside.
      k = Math.max(0, lo - 0.5);
    }
    out.push([cur[0] + nx * k, cur[1] + ny * k]);
  }
  return { ...shape, pts: out };
}

/** One muscle on one side, drawn on both halves of the body. */
const pair = (muscle: Muscle, side: FigureSide, raw: Shape, shade: Shade): FigureMuscleShape[] => {
  const shape = grow(raw, MUSCLE_GROW);
  return [
    { muscle, side, shape, shade },
    { muscle, side, shape: mirror(shape), shade: mirrorShade(shade) },
  ];
};

/** One muscle on one side, drawn once (the midline shapes: traps). */
const single = (
  muscle: Muscle,
  side: FigureSide,
  raw: Shape,
  shade: Shade
): FigureMuscleShape[] => [{ muscle, side, shape: grow(raw, MUSCLE_GROW), shade }];

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
 * ## The muscles TILE the body — they do not sit on it
 *
 * On an anatomy plate the muscles fill the body, share edges with their
 * neighbours, and are separated by a hairline; the ground shows only at joints,
 * at the midline, and as that hairline. Every region here is grown to meet its
 * neighbours at ~1.2–1.4 units and the SILHOUETTE at ~0.5–1.0, so the muscle's
 * own ink merges with the body's contour and no rim of ground survives at the
 * edge. db/exercise-ai.test.mjs asserts it directly with per-band coverage
 * floors, because containment alone is satisfied by pills and passed four
 * rejected rounds.
 *
 * ## The deltoid is split down the cap, and the two views differ
 *
 * The three heads are split by PLACE rather than by stacking slivers on one
 * 16pt shoulder. The LATERAL head is the outer lobe of the cap and the one head
 * visible from both views, so it is the same shape on each. The anterior and
 * posterior heads share its divide — the deltoid's own longitudinal groove —
 * but they are NOT mirrors of each other: the anterior head reaches medially
 * onto the clavicle, while the posterior head starts at the spine of the
 * scapula, much further out, because on the back view the upper TRAPEZIUS owns
 * the top of the shoulder all the way to the acromion.
 */
export const FIGURE_MUSCLES: FigureMuscleShape[] = [
  // --- FRONT ---------------------------------------------------------------
  // Pectoral fan: the sternal border runs down the midline, the superior border
  // follows the clavicle out to the deltopectoral groove, the lateral border
  // runs DOWN that groove to the armpit, and the inferior border sweeps back in
  // to the costal margin — so the whole shape is a fan whose lowest point is at
  // the sternum, not at the armpit.
  //
  // Shaded across the fan: dark in the deltopectoral groove, lit over the belly,
  // dark again into the sternal valley. That pair of shadows is what gives a
  // chest a middle.
  ...pair(
    'chest',
    'front',
    c([
      [48.9, 44.6],
      [44.6, 43.0],
      [41.0, 42.6],
      [39.2, 47.6],
      [36.8, 53.0],
      [35.2, 58.4],
      [34.5, 63.2],
      [34.9, 67.8],
      [38.4, 71.6],
      [43.4, 73.8],
      [48.9, 74.8],
    ]),
    belly([0.02, 0.62], [0.98, 0.3], 0.46, 0.24, 0.21)
  ),
  // The deltoid's lateral head: the outer lobe of the cap, fanning from the
  // crown down to the deltoid tuberosity, taking the silhouette's outer edge as
  // its own border. A DOME, lit at the crown and darkening into the insertion —
  // which is what a shoulder does, and what a flat wedge never did.
  ...pair(
    'side_delts',
    'front',
    c([
      [31.8, 39.6],
      [28.6, 38.3],
      [25.8, 39.3],
      [24.0, 41.4],
      [23.0, 44.6],
      [22.6, 49.6],
      [22.7, 55.2],
      [23.7, 60.3],
      [25.5, 64.8],
      [28.5, 64.6],
      [28.9, 61.4],
      [29.7, 55.6],
      [30.75, 48.0],
    ]),
    dome(0.46, 0.16, 0.92, 0.29)
  ),
  // Front delts: the anterior head, from the lateral third of the clavicle over
  // the crown and down to the same tuberosity. Its medial border IS the
  // deltopectoral groove — the pec's lateral border runs 1.6 off it. A strap, so
  // a cylinder rather than a dome.
  ...pair(
    'front_delts',
    'front',
    c([
      [38.5, 45.4],
      [37.9, 42.2],
      [36.4, 39.4],
      [34.2, 38.6],
      [33.0, 40.4],
      [31.95, 48.0],
      [30.9, 56.0],
      [30.1, 62.2],
      [31.9, 64.8],
      [33.7, 58.0],
      [35.8, 51.0],
      [37.6, 47.6],
    ]),
    belly([0.0, 0.28], [1.0, 0.72], 0.46, 0.24, 0.22)
  ),
  // The rectus sheet: FOUR rows either side of a 1.7-unit linea alba, running
  // from the costal margin to the pubis rather than stopping at the navel and
  // leaving the lower belly bare. Each segment is a little PILLOW — a dome of
  // its own, lit at its centre and dark at the tendinous edges — and that,
  // rather than the outline, is what makes eight rounded blocks read as a
  // six-pack.
  ...pair('abs', 'front', absSegment(40.3, 76.6, 9.2, 9.2), dome(0.5, 0.42, 0.8, 0.25)),
  ...pair('abs', 'front', absSegment(40.3, 87.0, 9.2, 9.2), dome(0.5, 0.42, 0.8, 0.25)),
  ...pair('abs', 'front', absSegment(40.3, 97.4, 9.2, 9.2), dome(0.5, 0.42, 0.8, 0.25)),
  ...pair('abs', 'front', absSegment(40.3, 107.8, 9.2, 11.4), dome(0.5, 0.4, 0.82, 0.25)),
  // ...and the external obliques down the flanks, the same muscle in this
  // taxonomy. They run the full height of the abdomen and take the silhouette's
  // flank as their outer border — through the waist's pinch at y 94 and out
  // again over the iliac crest — so nothing of the trunk between the ribs and
  // the pelvis is bare ground. Shaded dark at the flank, because that is where
  // the body turns away from the viewer.
  ...pair(
    'abs',
    'front',
    c([
      [39.4, 74.6],
      [39.2, 88.0],
      [39.3, 100.0],
      [39.4, 110.0],
      [39.2, 123.4],
      [36.4, 118.6],
      [34.6, 108.0],
      [36.5, 98.0],
      [36.4, 86.0],
      [35.3, 78.0],
      [36.6, 72.0],
    ]),
    belly([0.0, 0.5], [1.0, 0.5], 0.66, 0.26, 0.14)
  ),
  // Bicep spindles, filling the upper arm from the deltoid insertion to the
  // elbow. A real spindle now — a tendon taper at each end and a belly in the
  // middle — where the `View` version could only afford a capsule.
  ...pair(
    'biceps',
    'front',
    c([
      [27.2, 66.0],
      [30.4, 69.4],
      [31.4, 75.0],
      [31.0, 81.5],
      [29.8, 87.0],
      [28.3, 90.4],
      [25.6, 90.6],
      [23.5, 87.0],
      [22.3, 80.5],
      [22.2, 73.5],
      [23.4, 68.2],
    ]),
    dome(0.52, 0.4, 0.86, 0.27)
  ),
  // Forearms: the brachioradialis belly below the elbow, tapering to the wrist —
  // also a real taper now, and it was a capsule for four rounds purely because a
  // contoured forearm cost 56 `View`s it could not have.
  ...pair(
    'forearms',
    'front',
    c([
      [26.6, 92.8],
      [29.0, 96.2],
      [29.4, 101.0],
      [28.6, 108.0],
      [27.4, 114.0],
      [26.2, 118.2],
      [23.9, 118.4],
      [22.5, 113.0],
      [21.5, 105.0],
      [21.3, 98.5],
      [22.7, 93.6],
    ]),
    dome(0.46, 0.26, 0.95, 0.26)
  ),
  // Quads as TWO longitudinal masses rather than one sweep and a sliver: the
  // vastus lateralis taking the outer half of the thigh from the hip to the
  // patella, and the rectus femoris + vastus medialis taking the inner half and
  // bulging low above the knee. Together they cover the thigh edge to edge with
  // the intermuscular groove down the middle — and the groove is DRAWN, by the
  // dark end of each mass's gradient meeting the other's.
  ...pair(
    'quads',
    'front',
    c([
      [38.6, 129.0],
      [39.0, 142.0],
      [39.2, 155.0],
      [38.6, 165.0],
      [36.8, 173.5],
      [33.5, 168.0],
      [31.7, 158.0],
      [31.0, 146.0],
      [31.1, 136.0],
      [32.8, 128.2],
      [35.8, 126.2],
    ]),
    belly([0.02, 0.3], [0.98, 0.62], 0.44, 0.25, 0.2)
  ),
  // The rectus/VM mass: lit LOW, because the vastus medialis teardrop above the
  // knee is the landmark that says "thigh", where a crest up the middle says
  // "cylinder".
  ...pair(
    'quads',
    'front',
    c([
      [46.4, 127.2],
      [46.9, 140.0],
      [46.6, 152.0],
      [46.2, 163.0],
      [45.0, 173.0],
      [42.8, 179.0],
      [41.0, 172.0],
      [40.4, 160.0],
      [40.2, 146.0],
      [40.8, 134.0],
      [43.4, 126.6],
    ]),
    rad([0.5, 0.64], 1.0, [
      [0, -SHADE_LIFT],
      [0.4, -SHADE_LIFT * 0.4],
      [0.7, 0.1],
      [1, 0.3],
    ])
  ),
  // Calves: the two gastrocnemius bellies, the lateral one tapering into the
  // achilles and the medial one lower and fuller. Both run the width of the
  // lower leg instead of sitting as lozenges in the middle of it, and both are
  // lit HIGH, at the belly, darkening into the tendon.
  ...pair(
    'calves',
    'front',
    c([
      [40.0, 183.0],
      [40.4, 191.0],
      [40.3, 200.0],
      [40.1, 209.0],
      [39.0, 217.0],
      [37.2, 209.0],
      [35.0, 196.0],
      [34.4, 190.0],
      [35.7, 184.8],
    ]),
    dome(0.5, 0.28, 0.95, 0.26)
  ),
  ...pair(
    'calves',
    'front',
    c([
      [42.6, 184.4],
      [45.2, 189.0],
      [45.6, 196.0],
      [44.9, 204.5],
      [43.6, 213.0],
      [41.9, 205.0],
      [41.2, 195.0],
      [41.4, 188.5],
    ]),
    dome(0.5, 0.3, 0.95, 0.26)
  ),

  // --- BACK ----------------------------------------------------------------
  // Traps: the diamond yoke across the top of the back. Symmetric about the
  // spine, so it is one shape rather than a pair — and one FURROW gradient,
  // which draws that spine down the middle of it.
  ...single(
    'traps',
    'back',
    c([
      [50.0, 34.4],
      [55.6, 36.6],
      [59.6, 39.8],
      [63.0, 43.6],
      [63.8, 48.4],
      [61.2, 53.0],
      [57.4, 57.4],
      [55.0, 64.0],
      [53.2, 70.0],
      [50.0, 76.0],
      [46.8, 70.0],
      [45.0, 64.0],
      [42.6, 57.4],
      [38.8, 53.0],
      [36.2, 48.4],
      [37.0, 43.6],
      [40.4, 39.8],
      [44.4, 36.6],
    ]),
    furrow(0.25, 0.23)
  ),
  // Upper back: the scapular plates, filling the whole span between the trap's
  // lateral border and the deltoid, from the spine of the scapula down to the
  // lat's upper border. Lit across the plate, dark into the trap and dark at the
  // lower border where the lat passes under it.
  ...pair(
    'upper_back',
    'back',
    c([
      [38.4, 56.2],
      [41.2, 58.2],
      [43.6, 64.0],
      [45.4, 71.0],
      [46.6, 76.0],
      [43.4, 80.0],
      [38.2, 74.0],
      [35.2, 68.0],
      [34.6, 62.0],
      [35.8, 58.0],
    ]),
    belly([0.05, 0.15], [0.95, 0.9], 0.42, 0.21, 0.25)
  ),
  ...pair(
    'side_delts',
    'back',
    c([
      [31.8, 39.6],
      [28.6, 38.3],
      [25.8, 39.3],
      [24.0, 41.4],
      [23.0, 44.6],
      [22.6, 49.6],
      [22.7, 55.2],
      [23.7, 60.3],
      [25.5, 64.8],
      [28.5, 64.6],
      [28.9, 61.4],
      [29.7, 55.6],
      [30.75, 48.0],
    ]),
    dome(0.46, 0.16, 0.92, 0.29)
  ),
  // Rear delts: the posterior head of the same cap, and NOT a mirror of the
  // anterior one. The anterior head reaches medially onto the clavicle; the
  // posterior head starts at the spine of the scapula, which is much further
  // out — and the difference is load-bearing, because on this view the upper
  // TRAPEZIUS owns the top of the shoulder all the way to the acromion.
  ...pair(
    'rear_delts',
    'back',
    c([
      [35.6, 44.0],
      [35.0, 41.2],
      [34.0, 40.0],
      [33.0, 40.4],
      [31.95, 48.0],
      [30.9, 56.0],
      [30.1, 62.2],
      [31.9, 64.8],
      [33.2, 58.0],
      [34.6, 51.0],
      [35.5, 46.4],
    ]),
    belly([0.0, 0.28], [1.0, 0.72], 0.46, 0.24, 0.22)
  ),
  // Lats: a wing whose APEX is at the armpit and whose base runs down the
  // thoracolumbar fascia to the iliac crest — broad under the arm, tapering to a
  // point at the lower spine, and taking the flank of the silhouette as its
  // outer border the whole way down. Lit over the thick lateral belly, darkest
  // at the midline, which is where the aponeurosis actually is.
  ...pair(
    'lats',
    'back',
    c([
      [35.2, 70.6],
      [39.2, 77.4],
      [43.0, 82.4],
      [43.6, 87.0],
      [43.6, 99.0],
      [42.4, 107.0],
      [38.6, 110.5],
      [36.0, 104.0],
      [36.4, 94.0],
      [36.2, 84.0],
      [35.2, 76.0],
    ]),
    belly([0.0, 0.5], [1.0, 0.5], 0.38, 0.2, 0.26)
  ),
  // Lower back: the erector columns flanking the spine, thickening through the
  // lumbar and converging on the sacrum. The pair's dark MEDIAL ends meet at the
  // midline, so the lumbar furrow continues below the trapezius yoke.
  ...pair(
    'lower_back',
    'back',
    c([
      [49.2, 86.0],
      [49.2, 102.0],
      [49.2, 110.0],
      [47.8, 117.5],
      [44.4, 111.0],
      [44.8, 98.0],
      [46.4, 87.5],
    ]),
    belly([0.0, 0.5], [1.0, 0.5], 0.4, 0.2, 0.27)
  ),
  // Tricep spindles, on the same arm the biceps ride on the other view — crest
  // biased the other way, since the long head sits medial.
  ...pair(
    'triceps',
    'back',
    c([
      [27.2, 66.0],
      [30.4, 69.4],
      [31.4, 75.0],
      [31.0, 81.5],
      [29.8, 87.0],
      [28.3, 90.4],
      [25.6, 90.6],
      [23.5, 87.0],
      [22.3, 80.5],
      [22.2, 73.5],
      [23.4, 68.2],
    ]),
    dome(0.44, 0.36, 0.86, 0.27)
  ),
  // Forearms read the same from behind.
  ...pair(
    'forearms',
    'back',
    c([
      [26.6, 92.8],
      [29.0, 96.2],
      [29.4, 101.0],
      [28.6, 108.0],
      [27.4, 114.0],
      [26.2, 118.2],
      [23.9, 118.4],
      [22.5, 113.0],
      [21.5, 105.0],
      [21.3, 98.5],
      [22.7, 93.6],
    ]),
    dome(0.5, 0.26, 0.95, 0.26)
  ),
  // Glutes: a rounded mass that meets the pelvis edge above and the gluteal fold
  // below. The biggest single dome in the drawing, and the one that most
  // obviously stops being a circle once it is shaded.
  ...pair(
    'glutes',
    'back',
    c([
      [45.8, 119.5],
      [47.2, 126.0],
      [46.8, 134.0],
      [44.6, 138.6],
      [37.4, 139.2],
      [35.5, 138.6],
      [32.8, 136.5],
      [31.6, 127.0],
      [32.0, 120.0],
      [34.0, 116.4],
      [40.0, 116.2],
    ]),
    dome(0.46, 0.4, 0.9, 0.29)
  ),
  // Hamstrings in two masses like the quads opposite them: biceps femoris
  // outside, semitendinosus/semimembranosus inside, splitting toward the knee.
  ...pair(
    'hamstrings',
    'back',
    c([
      [38.8, 143.2],
      [39.0, 154.0],
      [39.2, 165.0],
      [38.4, 174.0],
      [35.2, 176.0],
      [33.4, 166.0],
      [31.6, 154.0],
      [31.0, 142.4],
      [33.6, 141.4],
    ]),
    belly([0.02, 0.32], [0.98, 0.64], 0.44, 0.25, 0.2)
  ),
  ...pair(
    'hamstrings',
    'back',
    c([
      [46.6, 143.6],
      [46.6, 154.0],
      [46.2, 165.0],
      [45.0, 175.0],
      [42.8, 178.5],
      [41.0, 172.0],
      [40.4, 160.0],
      [40.4, 148.0],
      [41.2, 142.8],
      [43.4, 141.6],
    ]),
    belly([0.98, 0.36], [0.02, 0.62], 0.44, 0.24, 0.22)
  ),
  // Calves read the same from behind — same bellies, same places.
  ...pair(
    'calves',
    'back',
    c([
      [40.0, 183.0],
      [40.4, 191.0],
      [40.3, 200.0],
      [40.1, 209.0],
      [39.0, 217.0],
      [37.2, 209.0],
      [35.0, 196.0],
      [34.4, 190.0],
      [35.7, 184.8],
    ]),
    dome(0.5, 0.28, 0.95, 0.26)
  ),
  ...pair(
    'calves',
    'back',
    c([
      [42.6, 184.4],
      [45.2, 189.0],
      [45.6, 196.0],
      [44.9, 204.5],
      [43.6, 213.0],
      [41.9, 205.0],
      [41.2, 195.0],
      [41.4, 188.5],
    ]),
    dome(0.5, 0.3, 0.95, 0.26)
  ),
];

/** The muscle shapes of one side, in declaration (paint) order. */
export function musclesFor(side: FigureSide): FigureMuscleShape[] {
  return FIGURE_MUSCLES.filter((m) => m.side === side);
}

/** Every muscle that appears on at least one side — the completeness contract. */
export function mappedMuscles(): Set<Muscle> {
  return new Set(FIGURE_MUSCLES.map((m) => m.muscle));
}

// --- the spline --------------------------------------------------------------

/**
 * The control points of one cubic segment of a closed centripetal Catmull–Rom
 * spline through `p0…p3`, for the stretch between `p1` and `p2`.
 *
 * The α = ½ (centripetal) weighting is the whole reason this is not three lines
 * of uniform Catmull–Rom: with anchors at uneven spacing — which every
 * anatomical landmark list has, a jaw needing four points where a flank needs
 * one — the uniform form loops and cusps between close anchors. Centripetal
 * provably cannot.
 */
function segment(p0: Pt, p1: Pt, p2: Pt, p3: Pt, tension: number): [Pt, Pt] {
  const d = (a: Pt, b: Pt) => Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5;
  const d1 = d(p0, p1);
  const d2 = d(p1, p2);
  const d3 = d(p2, p3);
  let b1: Pt = p1;
  let b2: Pt = p2;
  if (d1 > 1e-9 && d2 > 1e-9) {
    const n = 3 * d1 * (d1 + d2);
    b1 = [
      (d1 * d1 * p2[0] - d2 * d2 * p0[0] + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1[0]) / n,
      (d1 * d1 * p2[1] - d2 * d2 * p0[1] + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1[1]) / n,
    ];
  }
  if (d3 > 1e-9 && d2 > 1e-9) {
    const n = 3 * d3 * (d3 + d2);
    b2 = [
      (d3 * d3 * p1[0] - d2 * d2 * p3[0] + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2[0]) / n,
      (d3 * d3 * p1[1] - d2 * d2 * p3[1] + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2[1]) / n,
    ];
  }
  const t = Math.max(0, Math.min(1, tension));
  if (t === 0) return [b1, b2];
  const pull = (b: Pt, anchor: Pt): Pt => [
    anchor[0] + (b[0] - anchor[0]) * (1 - t),
    anchor[1] + (b[1] - anchor[1]) * (1 - t),
  ];
  return [pull(b1, p1), pull(b2, p2)];
}

const n2 = (v: number) => (Math.round(v * 100) / 100).toString();

/**
 * A contour as an SVG `d` string: one `M`, one `C` per anchor, one `Z`.
 *
 * This is the single line that separates this round from the five before it. A
 * `View` can be a rectangle with four corner radii and nothing else, so every
 * curved edge in the old figure was either a corner radius or a stack of
 * one-pixel-tall rectangles pretending to be a slope. Here the curve is the
 * primitive.
 */
export function pathD(shape: Shape): string {
  const hit = pathCache.get(shape);
  if (hit != null) return hit;
  const p = shape.pts;
  const n = p.length;
  const at = (i: number) => p[((i % n) + n) % n]!;
  let d = `M${n2(at(0)[0])} ${n2(at(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const [b1, b2] = segment(at(i - 1), at(i), at(i + 1), at(i + 2), shape.tension);
    const e = at(i + 1);
    d += `C${n2(b1[0])} ${n2(b1[1])} ${n2(b2[0])} ${n2(b2[1])} ${n2(e[0])} ${n2(e[1])}`;
  }
  const out = `${d}Z`;
  pathCache.set(shape, out);
  return out;
}

/**
 * A contour flattened back into a dense polygon — the bridge that keeps every
 * geometric invariant the polygon version had.
 *
 * Containment, non-overlap and the per-band coverage floors in
 * db/exercise-ai.test.mjs all run on this, so porting to beziers cost the suite
 * nothing. Eight samples per segment puts the chord error well under a hundredth
 * of a grid unit on the tightest curve in the drawing, which is two orders finer
 * than the lattice the coverage test samples on.
 */
export function flatten(shape: Shape): Pt[] {
  const hit = flatCache.get(shape);
  if (hit) return hit;
  const p = shape.pts;
  const n = p.length;
  const at = (i: number) => p[((i % n) + n) % n]!;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = at(i);
    const b = at(i + 1);
    const [c1, c2] = segment(at(i - 1), a, b, at(i + 2), shape.tension);
    for (let s = 0; s < FLATTEN_STEPS; s++) {
      const t = s / FLATTEN_STEPS;
      const u = 1 - t;
      out.push([
        u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0],
        u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1],
      ]);
    }
  }
  flatCache.set(shape, out);
  return out;
}

/** The axis-aligned bounds of a shape — of the CURVE, not of its anchors. */
export function shapeBounds(shape: Shape): FigureRect {
  const hit = boundsCache.get(shape);
  if (hit) return hit;
  const pts = flatten(shape);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  boundsCache.set(shape, box);
  return box;
}

/** Even-odd point-in-polygon over a flattened contour, bounds-rejected first. */
export function insideShape(shape: Shape, x: number, y: number): boolean {
  const b = shapeBounds(shape);
  if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return false;
  const pts = flatten(shape);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Do two shapes share any area? Sampled, because a BOUNDING-BOX test is useless
 * here: the vastus lateralis and medialis of one leg have overlapping boxes and
 * touch nowhere, and so do a lat wing and the erector column beside it. Two
 * shapes that genuinely overlap would paint one muscle's reading over another's
 * and silently lose it, which is the failure worth asserting on.
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
 * Is every point of `shape`'s outline covered by the body ground?
 *
 * The invariant that keeps a muscle from floating in space beside the figure —
 * asserted over every muscle shape in db/exercise-ai.test.mjs, so moving a body
 * block without moving the muscles that ride on it fails the suite instead of
 * shipping. Sampled over the FLATTENED outline rather than solved analytically,
 * because a shape may legitimately span two overlapping body blocks (the lower
 * abs cross the waist/pelvis join), which no single-block containment test
 * would accept.
 */
export function coveredByBody(shape: Shape): boolean {
  for (const [x, y] of flatten(shape)) {
    if (!FIGURE_BODY.some((b) => insideShape(b.shape, x, y))) return false;
  }
  return true;
}

/**
 * How many SVG nodes one figure PAIR costs — `<Path>`s plus gradient `<Defs>`.
 *
 * The drawing sits inside two scrolling screens, so its node count is still a
 * budget; it is simply a very different budget from the one the `View` version
 * lived under. Every body part costs two paths (the contour pass and the fill
 * pass) plus a gradient if it is shaded; every muscle costs one path and one
 * gradient.
 *
 * The number this replaces was **1,168 native views at 128pt**, against a
 * ceiling of 1,200, and it moved with the render size because a rasterised
 * polygon's bar count did. This one is a constant, and it is roughly a tenth of
 * it.
 */
export function figureNodeCount(): number {
  const perFigure = FIGURE_BODY.length * 2 + FIGURE_BODY.filter((b) => b.shade != null).length;
  return perFigure * 2 + (musclesFor('front').length + musclesFor('back').length) * 2;
}

/**
 * The fill for the parts of the body that carry no reading — skull, hands,
 * feet. **A tone, not the plate.**
 *
 * They were `paper-hi`, i.e. the plate the figure sits on, which made them
 * holes: an ink contour around nothing, so the drawing read as a mannequin
 * with a blank head rather than a person. The owner's reference image fills
 * its non-data parts with a distinct neutral for exactly this reason.
 *
 * **What it costs, stated plainly.** Non-data separation from a fully spent
 * muscle falls from 3.14:1 (which was reached *precisely* because the fill was
 * the plate) to **2.38:1**. That is below the 3:1 of WCAG 1.4.11 — and 1.4.11
 * does not apply here: it governs "graphical objects required to understand
 * the content", and these three are defined by NOT carrying content. Nothing
 * about the reading depends on telling a hand from a spent forearm, and two
 * things separate them anyway: the ink contour every shape already has, and
 * position, which is absolute (hands are at the ends of arms).
 *
 * `paper-dim` rather than `paper-deep`: deep sits 1.94:1 from spent, close
 * enough that a spent calf and a foot start to read as one mass, which is the
 * failure this change exists to avoid in the other direction.
 *
 * {@link CONTRAST_FLOOR} is untouched — that governs every MUSCLE pixel
 * against the plate and has nothing to do with this.
 */
export const NON_DATA_FILL = palette.paperDim;
