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
import { FRESH_THRESHOLDS } from '@/lib/exercise/constants';
import type { MuscleFreshness } from '@/lib/exercise/types';

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
