/**
 * GENERATED — exercise demonstration photos bundled into the binary.
 *
 * Source: free-exercise-db (github.com/yuhonas/free-exercise-db), public
 * domain (Unlicense) — embeddable with no attribution. First frame of each
 * matched movement, downloaded and committed 2026-08-11; the slug is ARC's
 * catalog id (0011_exercise_catalog.sql). Metro needs static require calls,
 * so this map is generated rather than computed. Regenerate by re-running
 * the matcher in docs/exercise-subapp.md §images (or by hand for one-offs).
 *
 * Custom exercises have no photo — resolveExerciseImage returns null and
 * the detail screen falls back to the muscle schematic alone.
 */

export const EXERCISE_IMAGES: Record<string, number> = {
  'ab-wheel-rollout': require('../../../assets/exercises/ab-wheel-rollout.jpg'),
  'back-extension': require('../../../assets/exercises/back-extension.jpg'),
  'barbell-back-squat': require('../../../assets/exercises/barbell-back-squat.jpg'),
  'barbell-bench-press': require('../../../assets/exercises/barbell-bench-press.jpg'),
  'barbell-curl': require('../../../assets/exercises/barbell-curl.jpg'),
  'barbell-row': require('../../../assets/exercises/barbell-row.jpg'),
  'barbell-shrug': require('../../../assets/exercises/barbell-shrug.jpg'),
  'bulgarian-split-squat': require('../../../assets/exercises/bulgarian-split-squat.jpg'),
  'cable-crunch': require('../../../assets/exercises/cable-crunch.jpg'),
  'cable-curl': require('../../../assets/exercises/cable-curl.jpg'),
  'cable-fly': require('../../../assets/exercises/cable-fly.jpg'),
  'cable-lateral-raise': require('../../../assets/exercises/cable-lateral-raise.jpg'),
  'cable-pull-through': require('../../../assets/exercises/cable-pull-through.jpg'),
  'chest-dip': require('../../../assets/exercises/chest-dip.jpg'),
  'chin-up': require('../../../assets/exercises/chin-up.jpg'),
  'close-grip-bench-press': require('../../../assets/exercises/close-grip-bench-press.jpg'),
  'conventional-deadlift': require('../../../assets/exercises/conventional-deadlift.jpg'),
  'dumbbell-bench-press': require('../../../assets/exercises/dumbbell-bench-press.jpg'),
  'dumbbell-curl': require('../../../assets/exercises/dumbbell-curl.jpg'),
  'dumbbell-fly': require('../../../assets/exercises/dumbbell-fly.jpg'),
  'dumbbell-row': require('../../../assets/exercises/dumbbell-row.jpg'),
  'dumbbell-shoulder-press': require('../../../assets/exercises/dumbbell-shoulder-press.jpg'),
  'dumbbell-shrug': require('../../../assets/exercises/dumbbell-shrug.jpg'),
  'face-pull': require('../../../assets/exercises/face-pull.jpg'),
  'farmers-carry': require('../../../assets/exercises/farmers-carry.jpg'),
  'front-raise': require('../../../assets/exercises/front-raise.jpg'),
  'front-squat': require('../../../assets/exercises/front-squat.jpg'),
  'goblet-squat': require('../../../assets/exercises/goblet-squat.jpg'),
  'hack-squat': require('../../../assets/exercises/hack-squat.jpg'),
  'hammer-curl': require('../../../assets/exercises/hammer-curl.jpg'),
  'hanging-leg-raise': require('../../../assets/exercises/hanging-leg-raise.jpg'),
  'hip-thrust': require('../../../assets/exercises/hip-thrust.jpg'),
  'incline-barbell-bench-press': require('../../../assets/exercises/incline-barbell-bench-press.jpg'),
  'incline-dumbbell-curl': require('../../../assets/exercises/incline-dumbbell-curl.jpg'),
  'incline-dumbbell-press': require('../../../assets/exercises/incline-dumbbell-press.jpg'),
  'incline-walk': require('../../../assets/exercises/incline-walk.jpg'),
  'kettlebell-swing': require('../../../assets/exercises/kettlebell-swing.jpg'),
  'lat-pulldown': require('../../../assets/exercises/lat-pulldown.jpg'),
  'lateral-raise': require('../../../assets/exercises/lateral-raise.jpg'),
  'leg-extension': require('../../../assets/exercises/leg-extension.jpg'),
  'leg-press': require('../../../assets/exercises/leg-press.jpg'),
  'lying-leg-curl': require('../../../assets/exercises/lying-leg-curl.jpg'),
  'machine-chest-press': require('../../../assets/exercises/machine-chest-press.jpg'),
  'machine-row': require('../../../assets/exercises/machine-row.jpg'),
  'machine-shoulder-press': require('../../../assets/exercises/machine-shoulder-press.jpg'),
  'overhead-press': require('../../../assets/exercises/overhead-press.jpg'),
  'overhead-triceps-extension': require('../../../assets/exercises/overhead-triceps-extension.jpg'),
  plank: require('../../../assets/exercises/plank.jpg'),
  'preacher-curl': require('../../../assets/exercises/preacher-curl.jpg'),
  'pull-up': require('../../../assets/exercises/pull-up.jpg'),
  'push-up': require('../../../assets/exercises/push-up.jpg'),
  'reverse-fly': require('../../../assets/exercises/reverse-fly.jpg'),
  'romanian-deadlift': require('../../../assets/exercises/romanian-deadlift.jpg'),
  'rowing-erg': require('../../../assets/exercises/rowing-erg.jpg'),
  'russian-twist': require('../../../assets/exercises/russian-twist.jpg'),
  'seated-cable-row': require('../../../assets/exercises/seated-cable-row.jpg'),
  'seated-calf-raise': require('../../../assets/exercises/seated-calf-raise.jpg'),
  'seated-leg-curl': require('../../../assets/exercises/seated-leg-curl.jpg'),
  'skull-crusher': require('../../../assets/exercises/skull-crusher.jpg'),
  'standing-calf-raise': require('../../../assets/exercises/standing-calf-raise.jpg'),
  'stationary-bike': require('../../../assets/exercises/stationary-bike.jpg'),
  'stiff-leg-deadlift': require('../../../assets/exercises/stiff-leg-deadlift.jpg'),
  'straight-arm-pulldown': require('../../../assets/exercises/straight-arm-pulldown.jpg'),
  'trap-bar-deadlift': require('../../../assets/exercises/trap-bar-deadlift.jpg'),
  'treadmill-run': require('../../../assets/exercises/treadmill-run.jpg'),
  'triceps-dip': require('../../../assets/exercises/triceps-dip.jpg'),
  'triceps-pushdown': require('../../../assets/exercises/triceps-pushdown.jpg'),
  'walking-lunge': require('../../../assets/exercises/walking-lunge.jpg'),
  'wrist-curl': require('../../../assets/exercises/wrist-curl.jpg'),
};

/** The bundled demo photo for a catalog exercise id, or null (custom rows). */
export function resolveExerciseImage(exerciseId: string): number | null {
  return EXERCISE_IMAGES[exerciseId] ?? null;
}
