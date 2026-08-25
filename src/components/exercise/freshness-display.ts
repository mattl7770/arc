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
   * True when no muscle carries a load inside the freshness window
   * (FRESHNESS_LOOKBACK_DAYS = 14) — `hoursSinceLast` is null for every muscle.
   * Despite the name this is "no RECENT training", NOT "never trained": older
   * history ages out of the 14-day window, and a cardio/mobility-only user logs
   * no `exercise_muscles` rows at all, so both read true here even with a long
   * history. `muscleFreshness` scores an unloaded muscle 100 / fresh by
   * construction, so the body draws full and the bar reads full; the flag exists
   * so a caller can say WHY rather than render that identically to a genuinely
   * recovered body. It cannot see a hand-set freshness anchor (a 'Spent' muscle,
   * migration 0037) that has no windowed load, so a caller must never turn this
   * flag alone into an "all fresh" claim — see {@link freshnessSummary}. The
   * name is kept because other consumers read it (muscle-figure.tsx).
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
  // Compose the non-fresh parts BEFORE letting `neverTrained` speak. A muscle
  // can read fatigued/recovering through a hand-set freshness anchor ('Spent',
  // migration 0037) with no logged sets in the 14-day window, so `neverTrained`
  // — which only sees windowed loads — can be true while a muscle is plainly not
  // fresh. Emitting the all-fresh sentence there would have VoiceOver announce
  // every muscle fresh while the visible legend and figure show one fatigued.
  const parts: string[] = [`${t.fresh.length} of ${t.total} muscles fresh.`];
  if (t.fatigued.length > 0) parts.push(`Fatigued: ${spoken(t.fatigued)}.`);
  if (t.recovering.length > 0) parts.push(`Recovering: ${spoken(t.recovering)}.`);
  // Only when nothing is fatigued or recovering may the unloaded state stand in,
  // and then it says what the ledger actually knows: no training IN THE WINDOW,
  // not "never" — a fortnight layoff or a cardio-only user has simply logged
  // nothing the freshness window can see (see the `neverTrained` docblock).
  if (t.neverTrained && t.fatigued.length === 0 && t.recovering.length === 0) {
    return `No training in the last 14 days, so all ${t.total} muscles read fresh.`;
  }
  return parts.join(' ');
}
