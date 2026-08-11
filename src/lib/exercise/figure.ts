/**
 * The body schematic's region map — pure data, no React, no SVG.
 *
 * ARC draws its muscle figure the way it draws everything: as a **print
 * schematic**, not an anatomy rendering. Each muscle group is a small
 * rectangular cell placed on a 100×220 design grid, composed into a stylised
 * front figure and back figure. The component (muscle-figure.tsx) scales the
 * grid to the available width and colours each cell; keeping the geometry here
 * as plain data lets a headless test assert the map is COMPLETE — every one of
 * the 16 muscle groups appears on at least one side — so a new muscle can never
 * silently vanish from the diagram.
 *
 * Coordinates are {x, y, w, h} in grid units, origin top-left. The silhouette
 * (head, hands, feet) is drawn by the component as neutral chrome; only the
 * REGIONS carry data. Left/right pairs are two cells sharing one muscle — a
 * freshness score colours both.
 */
import type { Muscle } from './types';

export type FigureSide = 'front' | 'back';

export type FigureRegion = {
  muscle: Muscle;
  side: FigureSide;
  /** Grid-unit rect, origin top-left of the 100×220 figure box. */
  x: number;
  y: number;
  w: number;
  h: number;
};

/** The design grid the regions are placed on (see muscle-figure.tsx). */
export const FIGURE_GRID = { w: 100, h: 220 } as const;

/**
 * Both figures' regions. The layout is deliberately schematic — segments
 * arranged as a person the way a printed strength chart would draw one:
 *
 *          front                    back
 *        ┌─ head ─┐              ┌─ head ─┐
 *   delts chest delts        delts traps delts
 *   arms   abs   arms        arms  upper  arms
 *                                  lats
 *   quads      quads         lower-back
 *   calves    calves         glutes · hams · calves
 */
export const FIGURE_REGIONS: FigureRegion[] = [
  // --- FRONT --------------------------------------------------------------
  // Shoulder caps (front delts) flank the chest.
  { muscle: 'front_delts', side: 'front', x: 16, y: 36, w: 14, h: 12 },
  { muscle: 'front_delts', side: 'front', x: 70, y: 36, w: 14, h: 12 },
  // Side delts sit just below the caps, on the outer edge.
  { muscle: 'side_delts', side: 'front', x: 12, y: 50, w: 12, h: 14 },
  { muscle: 'side_delts', side: 'front', x: 76, y: 50, w: 12, h: 14 },
  // Chest: two plates under the collar line.
  { muscle: 'chest', side: 'front', x: 32, y: 38, w: 17, h: 18 },
  { muscle: 'chest', side: 'front', x: 51, y: 38, w: 17, h: 18 },
  // Biceps on the upper arms.
  { muscle: 'biceps', side: 'front', x: 12, y: 66, w: 12, h: 20 },
  { muscle: 'biceps', side: 'front', x: 76, y: 66, w: 12, h: 20 },
  // Forearms below them.
  { muscle: 'forearms', side: 'front', x: 10, y: 88, w: 12, h: 24 },
  { muscle: 'forearms', side: 'front', x: 78, y: 88, w: 12, h: 24 },
  // Abs: a tall two-cell stack down the middle.
  { muscle: 'abs', side: 'front', x: 38, y: 58, w: 24, h: 16 },
  { muscle: 'abs', side: 'front', x: 38, y: 76, w: 24, h: 18 },
  // Quads: the front of the thighs.
  { muscle: 'quads', side: 'front', x: 30, y: 112, w: 18, h: 38 },
  { muscle: 'quads', side: 'front', x: 52, y: 112, w: 18, h: 38 },
  // Calves (front view shows them slimmer).
  { muscle: 'calves', side: 'front', x: 32, y: 162, w: 14, h: 30 },
  { muscle: 'calves', side: 'front', x: 54, y: 162, w: 14, h: 30 },

  // --- BACK ---------------------------------------------------------------
  // Traps: the yoke across the top.
  { muscle: 'traps', side: 'back', x: 34, y: 32, w: 32, h: 12 },
  // Rear delts flank the traps.
  { muscle: 'rear_delts', side: 'back', x: 16, y: 38, w: 14, h: 12 },
  { muscle: 'rear_delts', side: 'back', x: 70, y: 38, w: 14, h: 12 },
  // Upper back between the shoulder blades.
  { muscle: 'upper_back', side: 'back', x: 34, y: 46, w: 32, h: 14 },
  // Lats: two wings tapering toward the waist.
  { muscle: 'lats', side: 'back', x: 30, y: 62, w: 18, h: 22 },
  { muscle: 'lats', side: 'back', x: 52, y: 62, w: 18, h: 22 },
  // Triceps on the backs of the upper arms.
  { muscle: 'triceps', side: 'back', x: 12, y: 62, w: 12, h: 22 },
  { muscle: 'triceps', side: 'back', x: 76, y: 62, w: 12, h: 22 },
  // Forearms (visible from behind too).
  { muscle: 'forearms', side: 'back', x: 10, y: 88, w: 12, h: 24 },
  { muscle: 'forearms', side: 'back', x: 78, y: 88, w: 12, h: 24 },
  // Lower back: the column above the pelvis.
  { muscle: 'lower_back', side: 'back', x: 38, y: 86, w: 24, h: 14 },
  // Glutes.
  { muscle: 'glutes', side: 'back', x: 32, y: 102, w: 17, h: 14 },
  { muscle: 'glutes', side: 'back', x: 51, y: 102, w: 17, h: 14 },
  // Hamstrings: the backs of the thighs.
  { muscle: 'hamstrings', side: 'back', x: 30, y: 118, w: 18, h: 32 },
  { muscle: 'hamstrings', side: 'back', x: 52, y: 118, w: 18, h: 32 },
  // Calves read larger from behind.
  { muscle: 'calves', side: 'back', x: 31, y: 162, w: 16, h: 30 },
  { muscle: 'calves', side: 'back', x: 53, y: 162, w: 16, h: 30 },
];

/** The regions of one side, in declaration (paint) order. */
export function regionsFor(side: FigureSide): FigureRegion[] {
  return FIGURE_REGIONS.filter((r) => r.side === side);
}

/** Every muscle that appears on at least one side — the completeness contract. */
export function mappedMuscles(): Set<Muscle> {
  return new Set(FIGURE_REGIONS.map((r) => r.muscle));
}
