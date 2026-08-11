import { StyleSheet, View } from 'react-native';

import { palette } from '@/constants/theme';
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
 * clears 4.5:1 on every stock the cell has worn: 5.12–5.60:1 on the `paper-dim`
 * cell the sheet specifies and the app draws again since 2026-08-10, and
 * 5.91–6.46:1 on the bare page it sat on in between (./readiness-strip.tsx). A
 * word is exact, it is what the mockup specifies for this cell, and it is the
 * only encoding a screen reader can also read.
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
 * ## And a second hue-free dimension, because one binary split is not four states
 *
 * Ink weight splits in-range from needs-attention and stops there: `caution` and
 * `poor` are the SAME mark — `h-3 w-3 border-2 border-ink` over two fills that
 * measure 1.59:1 against each other. Without hue they are one square. The word
 * still names them apart, but the *scan* — the thing the weight split exists for
 * — cannot tell the flagged pillar from the worst one.
 *
 * The sheet already solved this and the port dropped it. `.cf-swatch--poor`
 * (and `.cf-barfill--poor`, and `.cf-mrow2-fill--poor` — every `poor` fill in
 * the set) lays
 * `repeating-linear-gradient(135deg, rgba(0,0,0,.34) 0 2px, transparent 2px 5px)`
 * over the flat colour, so the worst biological state is the only one wearing a
 * texture. That is a FORM cue, and it is the one that separates `poor` from
 * `caution` when hue is gone. Restored 2026-08-11 — see {@link PoorHatch} for
 * the mechanism and the measured strength.
 *
 * ⚠️ **The hatch cannot ride on this map, and that is why there is no accessor
 * for it.** A class string lands on a *childless* view, and the hatch is drawn
 * as rotated child views. So the map stays exactly what it is — the fill, the
 * size and the border weight — and {@link SignalMark} is the only public form,
 * rendering the map AND the hatch together.
 *
 * A `signalMarkClass(level)` accessor existed alongside it for one commit and is
 * deliberately **not** kept. It compiled, it drew four of the five states
 * correctly, and it silently dropped the hatch on the fifth — which is the one
 * state the hatch exists for. A helper whose only failure mode is losing an
 * accessibility cue on the worst reading in the set is a trap, not a
 * convenience. Render the component.
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

/**
 * The pillar mark, drawn whole: the {@link MARK} class plus the diagonal hatch
 * that `poor` — and only `poor` — wears. The one form to render; see the note
 * on {@link MARK} for why no class-string accessor is offered beside it.
 */
export function SignalMark({ level }: { level: SignalLevel }) {
  return <View className={MARK[level]}>{level === 'poor' ? <PoorHatch /> : null}</View>;
}

/**
 * The `bio-poor` hatch — the sheet's
 * `repeating-linear-gradient(135deg, rgba(0,0,0,.34) 0 2px, transparent 2px 5px)`,
 * drawn as filled views.
 *
 * ## Why it is back after 01-rn-port-guide.md §1.4 dropped it
 *
 * That section's argument is a dependency argument, not a design one: a
 * `repeating-linear-gradient` needs `expo-linear-gradient`, which is a native
 * module, which forces the owner into a fresh EAS cloud build (§5). The
 * constraint is real and still holds. What it never established is that the
 * hatch was unwanted — it is the set's only non-hue marker of the worst
 * biological state, and dropping it is why `caution` and `poor` ship today as
 * the same square in two indistinguishable greys.
 *
 * `HatchCap` (src/components/ui/block.tsx) settled the mechanism: an
 * `overflow: 'hidden'` box with rotated filled bars inside it. No library, no
 * rebuild, no gradient. This is the same technique at a twentieth of the area.
 *
 * ## The pitch is not the CSS number
 *
 * A gradient's stripe width is measured PERPENDICULAR to the stripe; these bars
 * are spaced along the horizontal. The 5pt perpendicular period projects to
 * 5/cos45° ≈ 7.07pt of horizontal pitch, so the bars sit at 7.08pt centres
 * (2pt wide + 2.54pt of margin on each side). The bar's own `width` IS the
 * perpendicular stripe width — rotation preserves a rectangle's thickness — so
 * that stays at the sheet's 2pt and is NOT divided. Copying 2-and-5 straight
 * across as horizontal numbers would have drawn the hatch at 1.41× density.
 *
 * **The slant matches the cap's, and the sheet's two angles are a trap.** It
 * writes the cap at `-45deg` and this swatch at `135deg`, which reads like two
 * opposite tilts and is not: a gradient's stripes run PERPENDICULAR to its
 * angle, and `-45deg` and `135deg` are the same gradient line traced in
 * opposite directions. Both therefore produce stripes at 45° — a `/` — and a
 * vertical bar rotated +45° draws exactly that. `HatchCap` shipped at `-45deg`
 * for one commit by copying the CSS angle straight onto the transform, which
 * mirrored it; both marks are `+45deg` now. An earlier version of this
 * paragraph asserted the opposite as fact, which is worth recording: it was
 * describing the code rather than checking the geometry.
 *
 * ## Sized by the box, not by numbers
 *
 * The bars are laid out by a centred flex row rather than by absolute offsets,
 * so the middle bar's centre always lands on the box's centre and the hatch
 * re-phases itself at whatever size it is dropped into — 8pt inside the
 * `border-2` pillar mark, 8pt inside a default {@link SignalTick}, 4pt inside a
 * `small` one. An absolute child inset to 0 on all four sides fills its
 * parent's PADDING box in Yoga, not its border box, so the hatch stops at the
 * ink border and never paints over it. Three bars is one more than the box can
 * ever show; the container clips the rest.
 *
 * ## What it measures, and what it does not
 *
 * Verified at the mark's real size, which is smaller than it looks: the sheet's
 * `.cf-swatch` is 10px with a 1px ink border, so its hatched fill is 8×8 — and
 * this mark is 12pt with a 2pt border, so its fill is 8pt too. The transfer is
 * 1:1 and **no deviation from the sheet's 2/5 was needed**. Across an 8pt
 * square the diagonal run is 8√2 ≈ 11.3pt, or 2.26 periods: one stripe corner
 * to corner and a clipped one in each of the opposite corners. Three marks, the
 * same three the mockup draws. It does not turn to mud.
 *
 * What it is NOT is a strong signal. `palette.ink` at the sheet's .34 over
 * `signal.poor` #AA402C composites to #7A3323, which is **1.50:1** against the
 * fill it sits on — texture weight, by the sheet's own choice of alpha, and
 * well under the 3:1 a load-bearing non-text cue would need. So it is ranked
 * accordingly: the primary carrier on this cell is still the WORD (5.12–5.60:1
 * on the pillar's paper-dim stock), the border weight still carries the
 * in-range/needs-attention split at 11.95:1, and the hatch is the third cue —
 * the one that splits the two flagged states from each other. Raising the alpha
 * would buy contrast at the cost of matching the drawing; that is an owner
 * call, not a silent one, so it ships at the sheet's value.
 *
 * `palette.ink` rather than the sheet's literal `rgba(0,0,0,.34)`: the set has
 * no pure black, and ink is what this drawing is drawn in. Alpha rides on the
 * container so the three bars composite as one layer.
 */
function PoorHatch() {
  return (
    <View pointerEvents="none" style={styles.hatch}>
      {HATCH_BARS.map((index) => (
        <View key={index} style={styles.hatchBar} />
      ))}
    </View>
  );
}

const HATCH_BARS = [0, 1, 2];

const styles = StyleSheet.create({
  hatch: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    opacity: 0.34,
  },
  // 18pt is longer than the 11.3pt diagonal of the largest box this lands in,
  // so the bar always crosses edge to edge and the container clips the excess.
  hatchBar: {
    width: 2,
    height: 18,
    marginHorizontal: 2.54,
    backgroundColor: palette.ink,
    transform: [{ rotate: '45deg' }],
  },
});

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
 *
 * At its default size this IS the sheet's `.cf-swatch` — 10px on a 1px ink
 * border — so `poor` takes the same {@link PoorHatch} the sheet puts on
 * `.cf-swatch--poor`, over the identical 8pt of fill. Drawing the worst state
 * hatched in one place and flat in another would make the texture read as
 * decoration rather than as a state, which is the whole reason it is here.
 *
 * `small` is 6pt, so its fill is 4pt and only the centre stripe survives the
 * clip. One diagonal on a 4pt square is a shading, not a hatch — recorded
 * rather than special-cased, because `small` has no call sites today and a
 * branch guarding a size nothing uses is a branch nobody will maintain.
 */
export function SignalTick({ level, small = false }: { level: SignalLevel; small?: boolean }) {
  return (
    <View className={`${small ? 'h-1.5 w-1.5' : 'h-2.5 w-2.5'} border border-ink ${SWATCH[level]}`}>
      {level === 'poor' ? <PoorHatch /> : null}
    </View>
  );
}
