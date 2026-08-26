import { useState } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';

/**
 * THE GAUGE — the sheet's `.cf-freshmeter`, drawn in full.
 *
 * The mockup's freshness meter is a five-part measuring instrument
 * (arc-conformed-set.html:688-695): a **pin** carrying the value in bold mono,
 * positioned over its own place on the scale with a **drop line** falling to the
 * track; the **track** itself, bordered recessed stock; the **fill**; three
 * **ticks** at the quarter points, overhanging the track top and bottom; and a
 * **numbered scale** beneath. The app rendered one right-aligned string,
 * `82% fresh`, in 12px mono — a caption where the set specifies an instrument,
 * and the largest single thing missing from the port.
 *
 * ## Plain Views, no new dependency
 *
 * `react-native-svg` is declared in package.json (added 2026-08-25, after the
 * owner's EAS rebuild) but is NOT in the owner's current binary — using it
 * would need a further EAS build — and there is no `expo-linear-gradient` in
 * this project at all. Every mark here is a filled `View` or a `Text`, which
 * is also what makes them safe to ship over the air — see the rule below.
 *
 * ## The one hard rule: no one-sided border width beside a border colour
 *
 * `border-t border-hairline` and its siblings drop React Native off its
 * CoreAnimation border path and paint a COMPLETE RECTANGLE — the bug behind four
 * rounds of "weird boxes" off the owner's hardware, documented at length under
 * `Divider` in ./block.tsx. So the drop line, the ticks and the fill are all
 * **filled views**: a background colour has no edge struct and cannot draw a
 * fourth side. The track's border is the legal shape — `border border-hairline`,
 * uniform on all four edges, which is how every plate in this app is drawn and
 * has never been the problem.
 *
 * ## ⚠️ The firewall: this fill is BIOLOGY, so it can never be the accent
 *
 * The mockup writes the reason into the CSS itself
 * (arc-conformed-set.html:690): *"82% fresh is a biological state —
 * bio-optimal, never chrome accent; accent inside the card belongs to Start
 * alone"*. On Exercise this gauge sits inside a pine-bordered `stamp` a few
 * points above a pine `Start` button, which makes it the single most likely
 * place in the app to paint chrome onto biology. {@link GaugeTone} is therefore
 * a closed union of three BIOLOGICAL states and the palette lookup is internal:
 * there is no colour prop, so no call site can hand this component the accent.
 *
 * ## Contrast — the INK cuts, not the swatches
 *
 * Measured against the `paper-dim` track this component draws (all figures
 * recomputed 2026-08-11 with the same method that reproduces the numbers already
 * recorded in app/exercise.tsx and tailwind.config.js to the second decimal):
 *
 *   fill cut   optimal   caution   poor
 *   swatch      2.89      2.58     4.11   ← two of three under the 3:1 floor
 *   ink         5.60      5.12     5.29   ← shipped
 *
 * WCAG 1.4.11 asks 3:1 of a graphical object, and the SWATCH cut — sized for
 * that floor on the pale stocks, `paper` and `paper-hi` — does not clear it on
 * recessed stock. The INK cut does, comfortably. This inverts the usual reading
 * of the two cuts (ink is nominally the *text* cut) and it is deliberate: the
 * ink cut is the floor for words and the safe choice for fills, the swatch is
 * neither. The same call, with the same measurements, is recorded on
 * `freshnessTone` in app/exercise.tsx.
 *
 * **Not hue alone.** Relative luminance: the track sits at 0.665, the three
 * fills at 0.078 / 0.090 / 0.085. That is a light/dark split an order of
 * magnitude wide, so the fill still reads as a fill with hue perception removed
 * entirely — and the pin states the same number in words besides.
 *
 * `hairline` on the track border (2.29:1 on the `paper-hi` card) and on the
 * ticks does NOT clear 3:1 — the standing, documented exception for the rule
 * weight (src/constants/theme.ts). It is accepted here for the same reason it is
 * accepted on every plate: nothing needed to read the value depends on seeing
 * them. The number is printed on the pin at 15.81:1 and the scale is printed
 * beneath at 6.84:1, so the ticks are redundant refinement rather than the
 * carrier of anything. A darker tick was measured and rejected: `ink-muted`
 * scores 6.84 on the card but **1.08 over the optimal fill**, i.e. it would
 * vanish over exactly the half of the track it has to cross. The mockup's
 * mid-tone is the only cut that survives both grounds (1.73 on the bare track,
 * 2.95-3.23 over the fills, 2.29 on the card).
 *
 * Class strings are whole literals in lookup maps, never built from a prefix:
 * Tailwind's scanner only sees class names that appear literally in source (the
 * documented ARC pattern, src/components/home/signal.tsx).
 */
export type GaugeTone = 'optimal' | 'caution' | 'poor';

/** The three biological cuts, INK not swatch. See the contrast note above. */
const FILL: Record<GaugeTone, string> = {
  optimal: 'bg-signal-optimal-ink',
  caution: 'bg-signal-caution-ink',
  poor: 'bg-signal-poor-ink',
};

/**
 * The TEXT cut of the same three states, for the number printed beside a track.
 *
 * It lives here rather than at the call site so a bar and the figure next to it
 * can never drift onto different states: one `tone` drives both. Same hues as
 * {@link FILL} — the ink cut is already the text cut, which is why it was the
 * right choice for the fill in the first place — and as words on the `paper-hi`
 * plate the ledger draws on they measure 7.40 / 6.77 / 7.00, comfortably past
 * 4.5:1.
 *
 * (The equivalent map for the five Home signal levels is
 * `signalTextClass` in src/components/home/signal.tsx. Not imported: that one is
 * keyed by `SignalLevel` from the Home types, and a measured bar has no business
 * depending on Home's vocabulary to colour its own number.)
 */
const TEXT: Record<GaugeTone, string> = {
  optimal: 'text-signal-optimal-ink',
  caution: 'text-signal-caution-ink',
  poor: 'text-signal-poor-ink',
};

export function gaugeTextClass(tone: GaugeTone): string {
  return TEXT[tone];
}

export type GaugeSize = 'meter' | 'row';

/**
 * Two weights, straight off the sheet: 8px for the instrument
 * (`.cf-freshtrack`) and 7px for a list row's bar (`.cf-mrow2-bar`). Both are
 * `paper-dim` inside a 1px `paper-line` border, and the border is what makes
 * either read as a drawn track rather than as an underline — recessed stock
 * departs from the plate it sits on by only 1.32:1, where the border departs by
 * 2.29:1, so the border does roughly four times the work of the fill in
 * establishing that there is a track there at all.
 *
 * React Native's border box is inside-out from the sheet's: 1px of border eats
 * into the declared height, so the fill runs 6px and 5px respectively. That is
 * the correct trade — the instrument's outer dimension is what has to match the
 * rhythm of the card around it.
 */
const TRACK: Record<GaugeSize, string> = {
  meter: 'h-[8px] border border-hairline bg-paper-dim',
  row: 'h-[7px] border border-hairline bg-paper-dim',
};

/** Quarter points. The scale beneath prints the same five stops as numerals. */
const TICKS = [25, 50, 75];

/** The printed scale — the same five stops, as numerals. */
const SCALE = ['0', '25', '50', '75', '100'];

/**
 * The air held between a qualifier and the pin that has been pushed off it.
 * 8pt, the set's smallest inline gap: enough that two mono strings on one line
 * read as two statements rather than one run-on measurement.
 */
const QUALIFIER_GAP = 8;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * The bare track and its fill — the part every measured bar in the app wants,
 * with no pin and no scale. A list row uses this directly (the muscle-freshness
 * ledger in app/exercise.tsx); {@link Gauge} builds the full instrument on top
 * of it, so the two can never drift apart in weight, stock or cut.
 *
 * `value` is a percentage and is clamped: a freshness score is 0-100 by
 * construction, but a bar that silently overhangs its own track on bad input is
 * a worse failure than one that pins at full.
 */
export function GaugeTrack({
  value,
  tone,
  size = 'row',
}: {
  value: number;
  tone: GaugeTone;
  size?: GaugeSize;
}) {
  return (
    <View className={TRACK[size]}>
      <View className={`h-full ${FILL[tone]}`} style={{ width: `${clampPercent(value)}%` }} />
    </View>
  );
}

/**
 * The whole instrument: pin, drop line, bordered track, fill, quarter ticks and
 * the numbered scale.
 *
 * ## Why the pin is measured rather than positioned in percent
 *
 * The sheet writes the pin as `left: 82%; transform: translateX(-50%)`, which
 * centres a box of unknown width over a point. React Native has percentage
 * `left` (the drop line and the ticks use it) but percentage `translate` is a
 * recent and version-dependent addition, and this app ships to one phone whose
 * rebuild costs the owner twenty minutes — so the width is measured instead of
 * gambled on. Two `onLayout` reads (the meter's width, the pin's own width) are
 * enough to place the pin exactly, and the same arithmetic buys the CLAMP the
 * sheet does not have: at 96% a centred pin hangs off the card, and the mockup
 * simply never drew that case. Here the label slides to stay on the sheet.
 *
 * **The drop line does not slide with it.** It is positioned at the true value
 * in percent, independent of the label, because the drop line is what makes this
 * a pin rather than a caption — it is the mark that says *this number belongs to
 * that place on the scale*, and a clamped pointer would be a lie about the
 * reading. Clamping moves the words; the pointer stays honest.
 *
 * The pin is hidden for the one frame before both measurements land, rather than
 * flashing at the left edge and jumping.
 *
 * ## The qualifier: an instrument this loud has to say what it rests on
 *
 * A drawn gauge is a much louder claim than the 12px caption it replaced, and a
 * reading of 100 taken off NO observations looks identical to a reading of 100
 * taken after full recovery. That is 00-design-spec.md §5 territory — a number
 * presented with more confidence than its basis supports — and the fix is to
 * state the basis, never to suppress the instrument: a card whose one
 * measurement disappears on a fresh install is the worse failure.
 *
 * So `qualifier` is an optional few words naming what the reading stands on,
 * printed in the pin row in the metadata voice the scale numerals already use
 * (mono, 10px, `ink-muted`). It is left-anchored and the PIN's clamp floor moves
 * to clear it, so the two can never collide — the drop line is untouched, since
 * it is the mark that has to stay honest about the value (see above).
 *
 * ## Announced, because none of it is text to a screen reader
 *
 * A drawn instrument states its value in geometry, which VoiceOver cannot see,
 * and the five scale numerals would otherwise be read out as five stray digits.
 * The root is therefore `accessible` — which collapses the descendants into one
 * element — and carries the value and its condition **in words**, in the style
 * of the SPOKEN maps in src/components/home/signal.tsx. `progressbar` is the
 * honest role for a 0-100 reading, and `accessibilityValue` gives assistive tech
 * the number as a number.
 *
 * The qualifier is APPENDED TO THE LABEL HERE rather than left to the call site,
 * for the same structural reason the colour lookup is internal: printing a
 * caveat that VoiceOver never says would put the spoken and the visible reading
 * into disagreement, and a caller cannot forget a step it does not perform. It
 * goes on the label and not on `accessibilityValue.text`, because `text` REPLACES
 * the numeric `now` in the announcement — the caveat must be additive to the
 * reading, not a substitute for it.
 */
export function Gauge({
  value,
  tone,
  pin,
  qualifier,
  accessibilityLabel,
}: {
  /** 0-100. Clamped. */
  value: number;
  tone: GaugeTone;
  /** The pin's printed text, e.g. `82% FRESH`. Kept short — it must fit the card. */
  pin: string;
  /**
   * A few words naming what the reading rests on, when that is not the usual
   * basis — e.g. `no sessions logged`. A measured statement in product nouns:
   * no reassurance, no personality, and never an explanation of the model.
   * Omit it whenever the reading is ordinary; a caveat on every gauge is a
   * caveat on none.
   */
  qualifier?: string;
  /** The value and its condition in words, for assistive tech. */
  accessibilityLabel: string;
}) {
  const pct = clampPercent(value);
  const [width, setWidth] = useState(0);
  const [pinWidth, setPinWidth] = useState(0);
  const [qualifierWidth, setQualifierWidth] = useState(0);

  // A qualifier joins the measurement gate: the pin's floor depends on its
  // width, so revealing the pin before that lands would draw it once in the
  // wrong place and then jump it clear.
  const measured = width > 0 && pinWidth > 0 && (!qualifier || qualifierWidth > 0);
  // The pin is centred over its own value, then held inside the meter's bounds —
  // and, when a qualifier is printed, off the qualifier's tail as well. Order
  // matters: the floor is applied BEFORE the right-edge clamp, so a qualifier
  // wide enough to fill the row pushes the pin to the edge rather than past it.
  const floor = qualifier ? qualifierWidth + QUALIFIER_GAP : 0;
  const pinLeft = measured
    ? Math.max(0, Math.min(width - pinWidth, Math.max(floor, (pct / 100) * width - pinWidth / 2)))
    : 0;

  // All three guards compare before setting: `left` re-lays-out the pin, which
  // fires its onLayout again, and an unguarded setState there would loop.
  const measureSelf = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
  };
  const measurePin = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setPinWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
  };
  const measureQualifier = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setQualifierWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
  };

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={qualifier ? `${accessibilityLabel}, ${qualifier}` : accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}
      onLayout={measureSelf}>
      {/*
        The pin band: 24pt of headroom held open IN FLOW — a 13pt line of type,
        1pt of air, and the 10pt drop line, which lands exactly on the top edge
        of the track below it.

        It is an empty sized View rather than `pt-6` on the root, deliberately.
        Web CSS resolves an absolute child against its ancestor's PADDING BOX,
        whose top edge sits above the padding; Yoga has historically added the
        ancestor's leading padding to that offset instead, and which behaviour
        you get has moved between Yoga releases. On a padded root, `top: 0` would
        therefore mean either "at the top" or "24pt down, on the track", and the
        difference is invisible until it is on the owner's phone. A band with no
        padding and no border reads identically under both.
      */}
      <View className="h-6">
        {/* The basis, when the reading needs one stated. Anchored hard left and
            set in the SCALE's own voice — mono 10px, metadata ink — because that
            is already this instrument's register for "printed measurement, not
            prose". It shares the pin's 13pt leading so the two sit on one line
            rather than on two that happen to overlap. */}
        {qualifier ? (
          <Text
            numberOfLines={1}
            onLayout={measureQualifier}
            className="absolute left-0 top-0 font-mono text-[10px] leading-[13px] text-ink-muted">
            {qualifier}
          </Text>
        ) : null}
        <Text
          numberOfLines={1}
          onLayout={measurePin}
          style={{ left: pinLeft, opacity: measured ? 1 : 0 }}
          className="absolute top-0 font-mono text-[11px] font-bold leading-[13px] text-ink">
          {pin}
        </Text>
        {/* The drop line — 1×10, at the true value. A filled view, never a
            border.

            `marginLeft: -(pct / 100)` pulls the line back inside by its own
            width, proportionally. `left: '100%'` puts the START of a 1pt view
            AT the right edge, so every point of its ink lands outside the
            gauge — and the parent does not clip, so a full reading drew a stray
            tick floating in the stamp's padding rather than the end of the
            scale. The correction is 0 at the left end and one whole point at
            the right, so the line still sits on its value everywhere between. */}
        <View
          pointerEvents="none"
          style={{ left: `${pct}%`, marginLeft: -(pct / 100), top: 14 }}
          className="absolute h-[10px] w-px bg-ink-muted"
        />
      </View>

      <View className="relative">
        <GaugeTrack value={pct} tone={tone} size="meter" />
        {/* Quarter ticks, overhanging 3pt top and bottom. Rendered after the
            track so they cross the fill rather than hide under it, which is the
            order the sheet's markup uses too. */}
        {TICKS.map((t) => (
          <View
            key={t}
            pointerEvents="none"
            style={{ left: `${t}%`, top: -3, bottom: -3 }}
            className="absolute w-px bg-hairline"
          />
        ))}
      </View>

      {/* The numbered scale. The sheet sets it at 9px; the spec's text floor
          asks the metadata layer to sit at 9.5-10px so the 9px floor is never
          load-bearing (00-design-spec.md §4), so it ships at 10. */}
      <View className="mt-1 flex-row justify-between">
        {SCALE.map((s) => (
          <Text key={s} className="font-mono text-[10px] text-ink-muted">
            {s}
          </Text>
        ))}
      </View>
    </View>
  );
}
