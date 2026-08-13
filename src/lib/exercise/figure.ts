/**
 * The body schematic's geometry — pure data, no React, no SVG.
 *
 * ARC draws its muscle figure the way it draws everything: as a **print
 * schematic**, not an anatomy rendering. There is no `react-native-svg` in this
 * project and none is going in (a native module costs the owner a fresh EAS
 * cloud build, 01-rn-port-guide.md §5), so every mark is a filled `View`. That
 * constraint shapes the drawing, and the shape it forced is recorded here
 * because the FIRST version of this file got it wrong.
 *
 * ## Why there are now two lists, not one
 *
 * The 2026-08-11 map was regions only: sixteen muscle cells floating on nothing,
 * with a ring for a head. The owner's verdict off hardware was "pretty rough and
 * hard to tell what's what", and the reason is legible in the data — there was
 * no BODY. A muscle cell means "quads" only because of where it sits on a
 * person, and there was no person for it to sit on. Scattered rounded boxes read
 * as scattered rounded boxes.
 *
 * So the drawing is now two layers:
 *
 *   {@link FIGURE_BODY}     the silhouette — head, neck, torso, waist, pelvis,
 *                           arms, hands, thighs, knees, calves, feet. Nineteen
 *                           rects that OVERLAP AT THE JOINTS on purpose, so the
 *                           figure reads as one continuous body rather than as
 *                           a stack of parts. Carries no data; it is the ground.
 *
 *   {@link FIGURE_REGIONS}  the muscle groups, placed ON that ground. Every
 *                           region is fully covered by the body (asserted in
 *                           db/exercise-ai.test.mjs by rasterising both lists),
 *                           so a muscle can never float off the figure, and no
 *                           two regions on the same side overlap.
 *
 * The component draws the body TWICE — once inflated by {@link BODY_OUTLINE}
 * in ink, once at true size in paper-deep — which turns one list of rects into a
 * contoured silhouette with no internal seams. See muscle-figure.tsx for why
 * that trick is the whole answer to "make boxes read as anatomy".
 *
 * Coordinates are {x, y, w, h} in grid units, origin top-left, on a 100×240
 * design grid (was 100×220 — the figure was squat). The component scales the
 * grid to the available width.
 *
 * Left/right pairs are two cells sharing one muscle: a freshness score colours
 * both. The gaps between paired cells (3 units at the chest, 4 between the
 * thighs, 3 at the armpit) are not decoration — they are what stops two adjacent
 * marked cells from merging into one blob, which is the second reason the old
 * map was hard to read.
 */
import type { Muscle } from './types';

export type FigureSide = 'front' | 'back';

/** A rect in grid units, origin top-left of the figure box. */
export type FigureRect = { x: number; y: number; w: number; h: number };

export type FigureRegion = FigureRect & {
  muscle: Muscle;
  side: FigureSide;
};

/**
 * A block of the silhouette. `round` is the ONE curve in this drawing: a
 * rectangular head reads as a robot, and 00-design-spec.md §4's square-corner
 * rule governs CONTAINERS (a card is a drawing, not a bubble), not depiction —
 * a skull is round because skulls are round.
 */
export type FigureBody = FigureRect & { part: string; round?: boolean };

/** The design grid the figure is placed on (see muscle-figure.tsx). */
export const FIGURE_GRID = { w: 100, h: 240 } as const;

/**
 * How far the ink contour is inflated past the body fill, in grid units. One
 * unit lands at 1.18pt on the hub's figure and 1.38pt on the full-screen one —
 * a drawn contour at both sizes, and it never falls below a device pixel.
 */
export const BODY_OUTLINE = 1;

/**
 * The silhouette. Blocks overlap at every joint (the neck into the head and the
 * torso, the waist into the torso and the pelvis, the hand into the forearm) so
 * the inflated ink pass fuses into ONE outline instead of drawing a seam at
 * every join. Where a gap is wanted the gap is explicit: 3 units between each
 * arm and the torso (the armpit), 4 between the thighs, and a knee break in the
 * leg that reads as a joint.
 *
 * Proportions are a standing figure of about eight heads, arms at the sides —
 * shoulders at y 34, navel at 96, hips at 116, knee at 178, ankle at 228.
 */
export const FIGURE_BODY: FigureBody[] = [
  { part: 'head', x: 39, y: 2, w: 22, h: 27, round: true },
  // The neck starts high enough that the head's ROUND fill still spans its
  // outline where the two meet — a straight-sided neck butted against a curved
  // skull leaves a nub of contour at each side otherwise, and at y 24 the
  // skull's half-width is 9.2 units against the neck's 7.
  { part: 'neck', x: 44, y: 24, w: 12, h: 12 },
  { part: 'torso', x: 28, y: 34, w: 44, h: 52 },
  { part: 'waist', x: 32, y: 84, w: 36, h: 24 },
  { part: 'pelvis', x: 29, y: 106, w: 42, h: 18 },
  { part: 'upper-arm-l', x: 12, y: 38, w: 13, h: 44 },
  { part: 'upper-arm-r', x: 75, y: 38, w: 13, h: 44 },
  { part: 'forearm-l', x: 11, y: 80, w: 12, h: 42 },
  { part: 'forearm-r', x: 77, y: 80, w: 12, h: 42 },
  { part: 'hand-l', x: 11, y: 120, w: 11, h: 15 },
  { part: 'hand-r', x: 78, y: 120, w: 11, h: 15 },
  { part: 'thigh-l', x: 30, y: 120, w: 18, h: 56 },
  { part: 'thigh-r', x: 52, y: 120, w: 18, h: 56 },
  { part: 'knee-l', x: 32, y: 172, w: 14, h: 12 },
  { part: 'knee-r', x: 54, y: 172, w: 14, h: 12 },
  { part: 'calf-l', x: 32, y: 180, w: 15, h: 48 },
  { part: 'calf-r', x: 53, y: 180, w: 15, h: 48 },
  { part: 'foot-l', x: 31, y: 226, w: 15, h: 12 },
  { part: 'foot-r', x: 54, y: 226, w: 15, h: 12 },
];

/**
 * Both figures' muscle regions.
 *
 *          front                         back
 *        ┌─ head ─┐                   ┌─ head ─┐
 *   side · front-delt · front-delt · side   rear · traps · rear
 *   bi  ·   chest    chest   ·  bi    tri · upper-back · tri
 *   fore ·    abs (2 stacks)  · fore   fore ·   lats    · fore
 *                                          lower-back
 *          quads · quads              glutes · glutes
 *                                     hams   · hams
 *         calves · calves             calves · calves
 *
 * The deltoid heads are split by PLACE rather than by stacking three cells on
 * one shoulder: front delts are the torso's top corners flanking the chest,
 * side and rear delts are the caps of the upper arms (front and back views
 * respectively). Anatomically defensible, and — the reason it is drawn this way
 * — the armpit gap separates them, where three stacked cells on a 16pt shoulder
 * would have been three indistinguishable slivers.
 */
export const FIGURE_REGIONS: FigureRegion[] = [
  // --- FRONT --------------------------------------------------------------
  // Front delts: the torso's top corners, flanking the chest.
  { muscle: 'front_delts', side: 'front', x: 29, y: 35, w: 12, h: 13 },
  { muscle: 'front_delts', side: 'front', x: 59, y: 35, w: 12, h: 13 },
  // Side delts: the outer caps of the shoulders, on the arms.
  { muscle: 'side_delts', side: 'front', x: 12, y: 38, w: 13, h: 12 },
  { muscle: 'side_delts', side: 'front', x: 75, y: 38, w: 13, h: 12 },
  // Chest: two plates under the collar line, split by a 4-unit sternum gap.
  { muscle: 'chest', side: 'front', x: 29, y: 51, w: 19, h: 20 },
  { muscle: 'chest', side: 'front', x: 52, y: 51, w: 19, h: 20 },
  // Abs: two stacked panels down the midline, crossing the torso/waist join.
  { muscle: 'abs', side: 'front', x: 39, y: 74, w: 22, h: 14 },
  { muscle: 'abs', side: 'front', x: 39, y: 90, w: 22, h: 14 },
  // Biceps: the fronts of the upper arms, below the delt caps.
  { muscle: 'biceps', side: 'front', x: 12, y: 54, w: 13, h: 26 },
  { muscle: 'biceps', side: 'front', x: 75, y: 54, w: 13, h: 26 },
  // Forearms, past the elbow break.
  { muscle: 'forearms', side: 'front', x: 11, y: 84, w: 12, h: 32 },
  { muscle: 'forearms', side: 'front', x: 77, y: 84, w: 12, h: 32 },
  // Quads: the fronts of the thighs.
  { muscle: 'quads', side: 'front', x: 31, y: 126, w: 16, h: 46 },
  { muscle: 'quads', side: 'front', x: 53, y: 126, w: 16, h: 46 },
  // Calves (slimmer from the front).
  { muscle: 'calves', side: 'front', x: 33, y: 186, w: 13, h: 38 },
  { muscle: 'calves', side: 'front', x: 54, y: 186, w: 13, h: 38 },

  // --- BACK ---------------------------------------------------------------
  // Traps: the yoke across the top of the back.
  { muscle: 'traps', side: 'back', x: 33, y: 35, w: 34, h: 13 },
  // Rear delts: the caps of the upper arms, seen from behind.
  { muscle: 'rear_delts', side: 'back', x: 12, y: 38, w: 13, h: 12 },
  { muscle: 'rear_delts', side: 'back', x: 75, y: 38, w: 13, h: 12 },
  // Upper back: between the shoulder blades.
  { muscle: 'upper_back', side: 'back', x: 29, y: 51, w: 19, h: 15 },
  { muscle: 'upper_back', side: 'back', x: 52, y: 51, w: 19, h: 15 },
  // Lats: two wings tapering toward the waist.
  { muscle: 'lats', side: 'back', x: 29, y: 69, w: 17, h: 16 },
  { muscle: 'lats', side: 'back', x: 54, y: 69, w: 17, h: 16 },
  // Triceps: the backs of the upper arms.
  { muscle: 'triceps', side: 'back', x: 12, y: 54, w: 13, h: 26 },
  { muscle: 'triceps', side: 'back', x: 75, y: 54, w: 13, h: 26 },
  // Forearms (visible from behind too).
  { muscle: 'forearms', side: 'back', x: 11, y: 84, w: 12, h: 32 },
  { muscle: 'forearms', side: 'back', x: 77, y: 84, w: 12, h: 32 },
  // Lower back: the column above the pelvis.
  { muscle: 'lower_back', side: 'back', x: 38, y: 88, w: 24, h: 15 },
  // Glutes.
  { muscle: 'glutes', side: 'back', x: 31, y: 107, w: 18, h: 15 },
  { muscle: 'glutes', side: 'back', x: 51, y: 107, w: 18, h: 15 },
  // Hamstrings: the backs of the thighs.
  { muscle: 'hamstrings', side: 'back', x: 31, y: 128, w: 16, h: 42 },
  { muscle: 'hamstrings', side: 'back', x: 53, y: 128, w: 16, h: 42 },
  // Calves read fuller from behind.
  { muscle: 'calves', side: 'back', x: 33, y: 184, w: 13, h: 41 },
  { muscle: 'calves', side: 'back', x: 54, y: 184, w: 13, h: 41 },
];

/** The regions of one side, in declaration (paint) order. */
export function regionsFor(side: FigureSide): FigureRegion[] {
  return FIGURE_REGIONS.filter((r) => r.side === side);
}

/** Every muscle that appears on at least one side — the completeness contract. */
export function mappedMuscles(): Set<Muscle> {
  return new Set(FIGURE_REGIONS.map((r) => r.muscle));
}

/**
 * Is every grid cell of `rect` covered by the silhouette? The invariant that
 * keeps a muscle from floating in space beside the body — asserted over all 34
 * regions in db/exercise-ai.test.mjs, so moving a body block without moving the
 * muscles that ride on it fails the suite instead of shipping.
 *
 * Rasterised rather than solved analytically because a region may legitimately
 * span TWO overlapping body blocks (the upper abs panel crosses the torso/waist
 * join), which no single-rect containment test would accept.
 */
export function coveredByBody(rect: FigureRect): boolean {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const inside = FIGURE_BODY.some(
        (b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h
      );
      if (!inside) return false;
    }
  }
  return true;
}
