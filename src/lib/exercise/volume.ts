/**
 * Weekly volume vs landmarks — the "add / hold / cut a set" verdict, pure and
 * offline (docs/exercise-subapp.md §1). Turns the already-computed weekly
 * fractional set counts (training-stats.weeklyMuscleSets) into a per-muscle
 * status against its MEV / MAV / MRV landmarks, so the hub and recommender can
 * say where each muscle sits in its productive range without a model.
 */
import { MUSCLE_LABEL, MUSCLE_ORDER, VOLUME_LANDMARKS, type VolumeLandmark } from './constants';
import type { Muscle, MuscleVolume, VolumeStatus } from './types';

/** Where `sets` sits against a muscle's landmarks. */
export function volumeStatus(sets: number, landmark: VolumeLandmark): VolumeStatus {
  if (sets < landmark.mev) return 'under';
  if (sets >= landmark.mrv) return 'over';
  if (sets >= landmark.mav) return 'approaching';
  return 'optimal';
}

function guidanceFor(status: VolumeStatus): string {
  switch (status) {
    case 'under':
      return 'Add sets';
    case 'optimal':
      return 'On track';
    case 'approaching':
      return 'Hold';
    case 'over':
      return 'Cut back';
  }
}

/** One muscle's verdict from its weekly set count. */
export function muscleVolume(muscle: Muscle, sets: number): MuscleVolume {
  const landmark = VOLUME_LANDMARKS[muscle];
  const status = volumeStatus(sets, landmark);
  return {
    muscle,
    sets: Math.round(sets * 10) / 10,
    mev: landmark.mev,
    mav: landmark.mav,
    mrv: landmark.mrv,
    status,
    guidance: guidanceFor(status),
  };
}

/**
 * The full volume ledger: every muscle in display order with its weekly set
 * count and landmark verdict. `weekly` is the sparse per-muscle set totals
 * (muscles with no sets this week default to 0).
 */
export function volumeLedger(weekly: { muscle: Muscle; sets: number }[]): MuscleVolume[] {
  const bySet = new Map(weekly.map((w) => [w.muscle, w.sets]));
  return MUSCLE_ORDER.map((muscle) => muscleVolume(muscle, bySet.get(muscle) ?? 0));
}

/**
 * The actionable summary the hub surfaces: muscles below MEV ("add") and at/over
 * MRV ("cut"), each as "Chest (4)". Muscles with MEV 0 that are simply untrained
 * are NOT flagged as under — they need no direct work, so nagging about them
 * would be noise. Returns empty arrays when everything trained is in range.
 */
export function volumeAttention(ledger: MuscleVolume[]): {
  under: string[];
  over: string[];
} {
  const under = ledger
    .filter((v) => v.status === 'under' && v.mev > 0)
    .map((v) => `${MUSCLE_LABEL[v.muscle]} (${v.sets})`);
  const over = ledger
    .filter((v) => v.status === 'over')
    .map((v) => `${MUSCLE_LABEL[v.muscle]} (${v.sets})`);
  return { under, over };
}
