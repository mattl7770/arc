import { View } from 'react-native';

import type { SignalLevel } from '@/types/home';

/*
 * Biological state, and nothing else. Signal colours mark biology only —
 * pillars, freshness, biomarker states — never interface chrome, and the
 * accent never marks biology. That firewall was a finding in all six hostile
 * reviews (00-design-spec.md §2).
 *
 * Tailwind's scanner only sees class names that appear literally in source, so
 * these maps hold whole class strings rather than building them from a prefix.
 */

/**
 * Fill for a measured swatch — the SWATCH cut, correct as it is: a fill is not
 * text, so it answers to the 3:1 non-text threshold, and each of these is
 * bordered in `ink` besides. `unknown` is deliberately the *page* colour, not a
 * grey chip: an absent reading must read as absent. No data, no mark.
 */
const SWATCH: Record<SignalLevel, string> = {
  optimal: 'bg-signal-optimal',
  good: 'bg-signal-good',
  caution: 'bg-signal-caution',
  poor: 'bg-signal-poor',
  unknown: 'bg-paper',
};

/**
 * The INK cut — the same four hues darkened for text (00-design-spec.md §2
 * specifies both values per state). The swatch cut is not a text colour: set as
 * text on paper-hi it measures optimal 3.82:1 and caution 3.41:1, both under
 * 4.5:1, and every signal-coloured word in the app inherited that. The ink cut
 * clears 4.5:1 on the surfaces signal text actually sits on — paper (6.46 /
 * 6.14 / 5.91 / 6.11) and paper-hi (7.40 / 7.04 / 6.77 / 7.00), plus paper-dim
 * (5.60 / 5.32 / 5.12 / 5.29).
 *
 * It does NOT clear on paper-deep (4.34 / 4.17 / 4.31 for good / caution /
 * poor), so do not put signal text on that surface; nothing does today.
 */
const TEXT: Record<SignalLevel, string> = {
  optimal: 'text-signal-optimal-ink',
  good: 'text-signal-good-ink',
  caution: 'text-signal-caution-ink',
  poor: 'text-signal-poor-ink',
  unknown: 'text-ink-muted',
};

export function signalTextClass(level: SignalLevel): string {
  return TEXT[level];
}

/**
 * The pillar mark — the swatch, plus a second dimension that is not hue.
 *
 * ## Why a swatch alone could not carry a pillar's state
 *
 * The four swatch cuts are near-identical in luminance, which is all that
 * survives when hue does not. Measured mutually: optimal/caution 1.12:1,
 * good/poor 1.06:1, optimal/good 1.34:1, optimal/poor 1.42:1, good/caution
 * 1.50:1, caution/poor 1.59:1. To anyone not perceiving hue those are the same
 * grey, so a cell drawing only a swatch and the pillar's NAME stated the
 * pillar's condition nowhere at all.
 *
 * That is the same defect the mission tick ladder was rewritten to solve
 * (./mission.tsx): on a light surface colour cannot separate four states, so
 * something other than colour has to. There the answer was FORM, because a
 * progress lane has no room for words. Here there is room, so the primary
 * carrier is a WORD — `signalConditionLabel`, set in the signal INK cut, which
 * clears 4.5:1 on every stock the cell has worn: 5.12–5.60:1 on the paper-dim
 * it used to sit on, 5.91–6.46:1 on the bare sheet it sits on since the cell's
 * box and fill came off (./readiness-strip.tsx). A word is exact, it is what the
 * mockup specifies for this cell, and it is the only encoding a screen reader
 * can also read.
 *
 * ## What the mark itself now does
 *
 * With the word carrying the state, the fill's hue drops to redundant
 * reinforcement rather than the sole cue — which matters, because against the
 * cell's stock the fills measure roughly optimal 2.89, good 3.88, caution 2.58,
 * poor 4.11, and two of those are under the 3:1 non-text floor. What makes the
 * mark perceivable as a graphic is its `ink` border at ~12:1, not the fill;
 * that was already true and is now no longer load-bearing for meaning.
 *
 * The mark still takes one hue-free dimension so the flagged pillars can be
 * found in a scan without reading four words: **ink weight carries the single
 * binary split** — 1px for in-range (optimal, good, unknown), 2px for
 * needs-attention (caution, poor). Both weights are `ink` at 11.95:1. This is
 * mission.tsx's move with the axes swapped: there form carried four states and
 * colour carried one split; here the word carries four and form carries the
 * split. The mark grew 10px → 12px because a doubled border cannot read at
 * 10px — the same reason that strip's lane grew from 3px to 8px.
 *
 * `unknown` keeps the *page* colour behind a 1px border: no data, no mark.
 * Whole class strings, never a built prefix — see the note at the top of this
 * file.
 */
const MARK: Record<SignalLevel, string> = {
  optimal: 'h-3 w-3 border border-ink bg-signal-optimal',
  good: 'h-3 w-3 border border-ink bg-signal-good',
  caution: 'h-3 w-3 border-2 border-ink bg-signal-caution',
  poor: 'h-3 w-3 border-2 border-ink bg-signal-poor',
  unknown: 'h-3 w-3 border border-ink bg-paper',
};

export function signalMarkClass(level: SignalLevel): string {
  return MARK[level];
}

/**
 * The condition, in words. Product nouns for a state, nothing rhetorical
 * (00-design-spec.md §5). `unknown` takes the em-dash the rest of the app uses
 * for a missing reading — no data means an em-dash, never a plausible word.
 */
const CONDITION: Record<SignalLevel, string> = {
  optimal: 'Optimal',
  good: 'Good',
  caution: 'Caution',
  poor: 'Poor',
  unknown: '—',
};

export function signalConditionLabel(level: SignalLevel): string {
  return CONDITION[level];
}

/**
 * The same condition for assistive tech. Diverges from the printed form in one
 * place only: an em-dash is a typographic convention for absence and is spoken
 * inconsistently (or not at all), so `unknown` says what it means.
 */
const SPOKEN: Record<SignalLevel, string> = {
  optimal: 'optimal',
  good: 'good',
  caution: 'caution',
  poor: 'poor',
  unknown: 'no data',
};

export function signalConditionSpoken(level: SignalLevel): string {
  return SPOKEN[level];
}

/**
 * The readiness colour, carried consistently everywhere it appears — a square
 * tick, not a dot. Corners are square across this design: this is a drawing,
 * not a bubble (00-design-spec.md §4).
 */
export function SignalTick({ level, small = false }: { level: SignalLevel; small?: boolean }) {
  return (
    <View
      className={`${small ? 'h-1.5 w-1.5' : 'h-2.5 w-2.5'} border border-ink ${SWATCH[level]}`}
    />
  );
}
