/**
 * Pure formatting for the progress-photo surfaces — every string a screen
 * prints about a photo that is not the photo itself.
 *
 * Pure and separate because two very different consumers must produce the SAME
 * words: the compare screen's captions, and the AI prompt, which ships those
 * captions to the model as ARC's numeric truth. If the screen said "weighed 2
 * days later" and the prompt said "84.2 kg" with no distance, the model would be
 * reading a claim the user never saw.
 *
 * **Everything is hand-rolled — no `Intl`.** Hermes ships without it, so
 * `toLocaleDateString` silently ignores its options object on device (the trap
 * src/components/home/date-eyebrow.tsx documents in full).
 */
import type { NearestWeighIn, PhotoPose } from './types';

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** `2026-01-12` → `12 Jan 2026`. An unparseable date comes back verbatim rather
 *  than as a plausible wrong one. */
export function formatPhotoDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const [, year, month, day] = match;
  const name = MONTHS_SHORT[Number(month) - 1];
  if (!name) return isoDate;
  return `${Number(day)} ${name} ${year}`;
}

/** The day-of-month a gallery cell carries, unpadded. */
export function photoDayNumber(isoDate: string): string {
  const match = /^\d{4}-\d{2}-(\d{2})$/.exec(isoDate);
  return match ? String(Number(match[1])) : '—';
}

const POSE_LABELS: Record<PhotoPose, string> = {
  front: 'Front',
  side: 'Side',
  back: 'Back',
  other: 'Other',
};

export function poseLabel(pose: PhotoPose): string {
  return POSE_LABELS[pose];
}

/** The single mono letter a grid cell carries beside its day number. */
export function poseLetter(pose: PhotoPose): string {
  return POSE_LABELS[pose].charAt(0);
}

/**
 * How far the weigh-in was from the photo, in words.
 *
 * **This clause is not optional anywhere it appears.** Printing a weight beside
 * a photo implies the two were measured together; only the distance makes the
 * caption true. Stating it also sidesteps the open UTC-vs-local bucketing
 * caveat entirely — no bucketing claim is made, because the distance is measured
 * between the two dates themselves.
 */
export function weighInDistanceLabel(deltaDays: number): string {
  if (deltaDays === 0) return 'weighed same day';
  const magnitude = Math.abs(deltaDays);
  const unit = magnitude === 1 ? 'day' : 'days';
  return deltaDays > 0 ? `weighed ${magnitude} ${unit} later` : `weighed ${magnitude} ${unit} earlier`;
}

/** The authored empty. A photo with no weigh-in near it says so; it never
 *  prints a stand-in number or leaves the slot blank. */
export const NO_WEIGH_IN = 'no weigh-in near this date';

/**
 * The full caption under a photo: the weight as the user's units render it,
 * then its distance — or the authored empty.
 *
 * `formatWeight` is injected rather than resolved here so this stays pure and
 * the screens keep their single source of unit truth
 * (`resolveDisplay` + `formatMeasured`, src/lib/log/metrics.ts).
 */
export function weighInCaption(
  weighIn: NearestWeighIn | null,
  formatWeight: (kg: number) => string
): string {
  if (!weighIn) return NO_WEIGH_IN;
  return `${formatWeight(weighIn.weight_kg)} · ${weighInDistanceLabel(weighIn.delta_days)}`;
}
