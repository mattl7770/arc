/**
 * The one place muscle-freshness STATE is translated for display — shared by
 * the Train-today gauge (app/exercise.tsx), the per-muscle ledger
 * (app/muscle-freshness.tsx) and anything else that prints a freshness reading,
 * so the 82 on the card and the 82 in the ledger can never read as two
 * different conditions.
 *
 * Freshness is a BIOLOGICAL state, so its marks ride the gauge's closed
 * biological tones — never the accent (the firewall, 00-design-spec.md §2; the
 * full contrast measurements live on src/components/ui/gauge.tsx).
 */
import type { GaugeTone } from '@/components/ui/gauge';
import { FRESH_THRESHOLDS, MUSCLE_LABEL } from '@/lib/exercise/constants';
import type { Muscle, MuscleFreshness } from '@/lib/exercise/types';

/** state → the gauge's biological tone. */
export function freshnessTone(state: MuscleFreshness['state']): GaugeTone {
  switch (state) {
    case 'fresh':
      return 'optimal';
    case 'recovering':
      return 'caution';
    default:
      return 'poor';
  }
}

/**
 * The same three buckets, for a freshness score that arrives without one (the
 * Recommendation carries a set-weighted number but no state). Re-derived from
 * the published thresholds the ledger itself uses.
 */
export function freshnessState(score: number): MuscleFreshness['state'] {
  if (score >= FRESH_THRESHOLDS.fresh) return 'fresh';
  if (score >= FRESH_THRESHOLDS.recovering) return 'recovering';
  return 'fatigued';
}

/**
 * The condition in words, for assistive tech — a bar and a colour say nothing
 * to a screen reader (same shape and purpose as src/components/home/signal.tsx's
 * SPOKEN map). The printed pin says "82% FRESH" in every state because "fresh"
 * there names the measurement; spoken, the verdict would go unsaid, so it is
 * said here.
 */
export const FRESHNESS_SPOKEN: Record<MuscleFreshness['state'], string> = {
  fresh: 'fresh',
  recovering: 'still recovering',
  fatigued: 'fatigued',
};

/**
 * The condition in PRINTED words — the label-voice heading over each row of the
 * body figure's key. Distinct from {@link FRESHNESS_SPOKEN}, which is written
 * for speech: "still recovering" reads as prose and "RECOVERING" reads as a
 * heading, and the key is a heading.
 *
 * The word is the PRIMARY carrier of the state and always has been the house
 * answer (src/components/home/signal.tsx). It matters more here than anywhere
 * else in the app, because the two states the figure actually marks —
 * `signal-caution-ink` #6E4F15 and `signal-poor-ink` #8F3524 — measure **1.03:1
 * against each other**. To anyone not perceiving hue they are one colour. Set on
 * a `paper-hi` plate these words measure 6.77 and 7.00; on the bare page, 5.91
 * and 6.11.
 */
export const FRESHNESS_LABEL: Record<MuscleFreshness['state'], string> = {
  fresh: 'Fresh',
  recovering: 'Recovering',
  fatigued: 'Fatigued',
};

/** The ledger split by state, in the ledger's own head-to-toe order. */
export type FreshnessTally = {
  fresh: Muscle[];
  recovering: Muscle[];
  fatigued: Muscle[];
  /** How many muscles the ledger covers — the denominator, never a literal 16. */
  total: number;
  /**
   * True when NOTHING has ever been logged against any muscle.
   * `muscleFreshness` scores a never-trained muscle 100 / fresh by
   * construction, so a fresh install draws a full body and a full bar. The
   * number is right under the model; what is wrong is that it renders
   * identically to a genuinely recovered body. Same defect the Train-today
   * gauge states with its `qualifier` (app/exercise.tsx), same fix: say so.
   */
  neverTrained: boolean;
};

export function freshnessTally(ledger: MuscleFreshness[]): FreshnessTally {
  const of = (state: MuscleFreshness['state']) =>
    ledger.filter((m) => m.state === state).map((m) => m.muscle);
  return {
    fresh: of('fresh'),
    recovering: of('recovering'),
    fatigued: of('fatigued'),
    total: ledger.length,
    neverTrained: ledger.length > 0 && ledger.every((m) => m.hoursSinceLast == null),
  };
}

/** Muscle names joined the way the sheet joins a list of names. */
export function muscleNames(muscles: Muscle[]): string {
  return muscles.map((m) => MUSCLE_LABEL[m]).join(' · ');
}

/**
 * The whole body figure, in one sentence, for assistive tech.
 *
 * A drawn body map states everything in geometry and colour, neither of which
 * VoiceOver can see — the same problem `Gauge` solves by collapsing itself into
 * one announcement (src/components/ui/gauge.tsx). This is that announcement.
 *
 * It lives here rather than inside the figure because it has TWO call sites that
 * cannot share a DOM element: the figure itself on app/muscle-freshness.tsx, and
 * the Pressable that wraps the entire block on app/exercise.tsx. iOS does not
 * descend into an `accessible` ancestor, so a label set on the figure inside
 * that Pressable would never be spoken — the hub has to put this string on the
 * button. One function, two call sites, and the states can never disagree.
 */
export function freshnessSummary(ledger: MuscleFreshness[]): string {
  const t = freshnessTally(ledger);
  if (t.total === 0) return 'No muscle readings yet.';
  const spoken = (muscles: Muscle[]) =>
    muscles.map((m) => MUSCLE_LABEL[m].toLowerCase()).join(', ');
  if (t.neverTrained) return `No sessions logged yet, so all ${t.total} muscles read fresh.`;
  const parts: string[] = [`${t.fresh.length} of ${t.total} muscles fresh.`];
  if (t.fatigued.length > 0) parts.push(`Fatigued: ${spoken(t.fatigued)}.`);
  if (t.recovering.length > 0) parts.push(`Recovering: ${spoken(t.recovering)}.`);
  return parts.join(' ');
}
