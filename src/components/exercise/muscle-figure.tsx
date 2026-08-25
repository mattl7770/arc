import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';

import {
  FRESHNESS_LABEL,
  freshnessSummary,
  freshnessTally,
  freshnessTone,
  muscleNames,
} from '@/components/exercise/freshness-display';
import { gaugeTextClass } from '@/components/ui/gauge';
import { palette } from '@/constants/theme';
import { MUSCLE_LABEL } from '@/lib/exercise/constants';
import {
  BAR_POINTS,
  BODY_BAR_POINTS,
  BODY_OUTLINE,
  FIGURE_BODY,
  FIGURE_GRID,
  MUSCLE_OUTLINE,
  barsFor,
  freshnessFill,
  musclesFor,
  polyBars,
  type Bar,
  type Blob,
  type FigureSide,
  type Shape,
} from '@/lib/exercise/figure';
import type { Muscle, MuscleFreshness } from '@/lib/exercise/types';

/**
 * THE BODY FIGURE — anterior and posterior anatomy with a freshness scale down
 * the left.
 *
 * ## The reversal this file records (owner, 2026-08-12, third round)
 *
 * The version this replaces marked only DEPLETION: fresh drew nothing, on the
 * reasoning that *"a mark that appears on every muscle marks nothing"*. **The
 * owner has overruled that**, with a reference image: every muscle is drawn,
 * filled with ONE hue whose OPACITY is the reading, deep where the muscle is
 * fresh and pale where it is spent. The figure IS the data now, not a set of
 * exceptions printed on a blank body. The old reasoning is not wrong in general
 * — it is simply not what this drawing is for, and the owner's call settles it.
 *
 * Three other things changed with it, all from the same brief:
 *
 *   1. **Real muscle shapes.** Thirty-four axis-aligned rectangles were rejected
 *      twice. Every muscle is now a contoured shape — see the technique note in
 *      src/lib/exercise/figure.ts. Rectangles were never going to read as
 *      anatomy, and no amount of ground under them changed that.
 *   2. **One hue, not two.** `signalInk.caution` and `signalInk.poor` measured
 *      **1.03:1 against each other** — to anyone not perceiving hue, and to
 *      anyone glancing at a 15pt cell, one shade of dark brown. The ramp is a
 *      single green, `signalInk.optimal`, the same one `GaugeTrack` already
 *      fills a fresh muscle's bar with, so the figure and the ledger beneath it
 *      speak one language.
 *   3. **Head, hands and feet carry no reading**, and the drawing says so.
 *
 * ## The fourth round (owner, 2026-08-14)
 *
 * *"Muscle freshness still looks a bit wack. Let's try again to make that look
 * like an actual person with muscles instead of a bunch of odd shaped boxes.
 * Lets also have spent muscles fade to grey instead of dark green."*
 *
 * Both halves are answered in src/lib/exercise/figure.ts and the reasoning
 * lives there, because both are geometry-and-colour rather than composition:
 * the **body silhouette is polygons now** (it was the rectangles nobody had
 * looked at), and the ramp runs **green → grey in colour at full opacity**
 * rather than one green fading toward the ground. Three consequences reach this
 * file:
 *
 *   - `Mark` draws the body as well as the muscles, since both are polygons.
 *   - An opaque fill needs no group-opacity wrapper, which is what paid for the
 *     body's scanline bars inside the view budget. The wrapper still exists and
 *     is still mandatory below alpha 1 — see the note on `Mark`.
 *   - Head, hands and feet moved from `hairline` grey to the PLATE colour. They
 *     had to move: a spent muscle is grey now, and the previous author measured
 *     the two at 1.32:1. Against the plate it is 3.14:1, and "the page showing
 *     through" is a stronger way to say "not data" than another grey.
 *
 * ## The ramp cannot be the only carrier, and it is not
 *
 * A continuous opacity ramp on one hue is a *fast* path, never the only one.
 * Everything below is unchanged from the round that fixed it:
 *
 *   - {@link MuscleFigureLegend} still names, in words, every muscle that is
 *     recovering or fatigued, grouped by state. That is the answer to "which
 *     one is that" and it needs no colour at all.
 *   - The figure collapses into ONE `accessible` element carrying
 *     `freshnessSummary` — otherwise ~1,060 unlabelled views and two stray
 *     captions reading "front" and "back" are all VoiceOver can find.
 *   - iOS never descends into an `accessible` ancestor, which is why the hub's
 *     `Pressable` carries that same summary string itself (app/exercise.tsx).
 *   - Every reading on the ramp clears WCAG 1.4.11's 3:1 against the plate
 *     (3.14 spent · 4.82 mid · 7.40 fresh — measured in figure.ts and asserted
 *     over all 101 values in db/exercise-ai.test.mjs §1), and an ink line rings
 *     every shape so its contour reads at 9.74:1 whatever the fill is doing.
 *   - {@link FreshnessScale} prints the ramp's ends in words — FRESH at the top,
 *     SPENT at the bottom — so the direction is never inferred.
 *
 * ## ⚠️ `mode: 'muscles'` takes no signal colour, and that firewall runs both ways
 *
 * app/exercise-detail.tsx uses this component to show which muscles a MOVEMENT
 * works. That is a fact about an exercise, not a biological state, so it must
 * never wear the green (00-design-spec.md §2). It draws in plain ink at two
 * alphas — full for a primary mover, {@link MUSCLES_SECONDARY_ALPHA} for an
 * assist — which measure **4.10:1 against each other**, a light/dark split that
 * survives hue-blindness outright. A muscle the movement does not work is drawn
 * as an empty contour, so the map still shows where everything is.
 *
 * ## The one hard rule this file obeys
 *
 * Never a one-sided border width beside a border colour — React Native paints
 * that pair as a complete rectangle (the docblock under `Divider` in
 * src/components/ui/block.tsx, four owner reports of "weird boxes"). Every mark
 * here is a background colour or a **uniform four-sided** `borderWidth`.
 */

export type MuscleFigureProps =
  | { mode: 'freshness'; ledger: MuscleFreshness[]; figureWidth?: number }
  | { mode: 'muscles'; primary: Muscle[]; secondary: Muscle[]; figureWidth?: number };

/**
 * The default per-figure width, in points. Two figures plus the freshness scale
 * and its two 8pt gaps come to 282pt, inside the 307pt of content a 375pt
 * iPhone SE leaves on a `plate` (20pt Screen gutters, 14pt plate padding).
 * Nothing here shrinks — `flexShrink` is 0 in React Native — so that is a hard
 * edge, not a hint.
 */
const FIGURE_WIDTH = 118;

/** The scale column's width, sized to hold the word SPENT on one line. */
const SCALE_WIDTH = 30;

/**
 * An assist in `muscles` mode — plain ink at this alpha over the body ground.
 *
 * **4.10:1 against a primary's full ink**, which is a light/dark split wide
 * enough to survive hue-blindness outright, and 1.68:1 against the neutral grey
 * the head, hands and feet wear. The obvious 0.30 was measured first and
 * rejected: it composites to #938F80, which is **1.30:1** against that neutral,
 * so a worked calf and a foot read as the same tone in a 72pt figure. The tone
 * a mark shares must never be the tone of the thing that means "not a mark".
 */
const MUSCLES_SECONDARY_ALPHA = 0.42;

/** How many bands the freshness scale is drawn in. */
const SCALE_BANDS = 14;

/** `#RRGGBB` + alpha → an rgba() string. RN has no colour-with-alpha helper. */
function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** A muscle's treatment: which ink, and how opaque. Alpha 0 = outline only. */
type Fill = { color: string; alpha: number };

function fillFor(props: MuscleFigureProps, muscle: Muscle): Fill {
  if (props.mode === 'freshness') {
    const entry = props.ledger.find((m) => m.muscle === muscle);
    // A muscle the ledger does not cover is not a fresh one — it is an unknown,
    // and an unknown draws as an empty contour rather than as a reading.
    if (entry == null) return { color: palette.signalInk.optimal, alpha: 0 };
    return freshnessFill(entry.freshness);
  }
  if (props.primary.includes(muscle)) return { color: palette.ink, alpha: 1 };
  if (props.secondary.includes(muscle))
    return { color: palette.ink, alpha: MUSCLES_SECONDARY_ALPHA };
  return { color: palette.ink, alpha: 0 };
}

function blobStyle(b: Blob, scale: number, inflate = 0): ViewStyle {
  return {
    position: 'absolute',
    left: (b.x - inflate) * scale,
    top: (b.y - inflate) * scale,
    width: (b.w + inflate * 2) * scale,
    height: (b.h + inflate * 2) * scale,
    borderTopLeftRadius: (b.r[0] + inflate) * scale,
    borderTopRightRadius: (b.r[1] + inflate) * scale,
    borderBottomRightRadius: (b.r[2] + inflate) * scale,
    borderBottomLeftRadius: (b.r[3] + inflate) * scale,
  };
}

/**
 * One scanline bar as a positioned style. The first and last bar of a polygon
 * take a `borderRadius` cap on their outer edge, which is what turns a stack of
 * rectangles into a shape that CLOSES — an un-capped taper ends in a chopped
 * edge and reads as a box again, which is the whole failure this rewrite is
 * answering.
 */
function barStyle(bar: Bar, i: number, n: number, scale: number, inflate: number): ViewStyle {
  const w = (bar.w + inflate * 2) * scale;
  const h = (bar.h + inflate * 2) * scale;
  const cap = Math.min(w, h) / 2;
  return {
    position: 'absolute',
    left: (bar.x - inflate) * scale,
    top: (bar.y - inflate) * scale,
    width: w,
    height: h,
    ...(i === 0 ? { borderTopLeftRadius: cap, borderTopRightRadius: cap } : null),
    ...(i === n - 1 ? { borderBottomLeftRadius: cap, borderBottomRightRadius: cap } : null),
  };
}

/**
 * One shape: its ink contour, then its fill. Used for the muscles and, since
 * 2026-08-14, for the body silhouette too — the body is polygons now.
 *
 * A blob is one node — its contour is a UNIFORM four-sided `borderWidth`, the
 * legal border shape, and its fill a background colour.
 *
 * A polygon is rasterised once and drawn twice: an inflated copy in ink, then
 * the true-size bars in the fill colour.
 *
 * **Where the alpha lives.** Consecutive bars deliberately overlap (see
 * `polyBars`'s bleed) so no hairline of ground prints between them, and a
 * TRANSLUCENT fill would composite those overlaps twice and stripe the muscle
 * darker every few points — a bug caught in preview on 2026-08-12. It cannot
 * happen on the freshness ramp any more, because that ramp is opaque now
 * (overlapping opaque bars of one colour composite to that colour), but
 * `muscles` mode still draws translucent ink, so the rule stands and is
 * enforced structurally: **a fill of alpha < 1 goes on a wrapper `View`, never
 * on the bars.** At alpha 1 the wrapper is skipped, which is also what pays for
 * the body's bars.
 *
 * Returns a Fragment, so the component itself costs no native view.
 */
function Mark({
  shape,
  fill,
  scale,
  outline,
  barTarget,
}: {
  shape: Shape;
  fill: Fill;
  scale: number;
  outline: number;
  barTarget: number;
}) {
  if (shape.kind === 'blob') {
    return (
      <View
        style={[
          blobStyle(shape, scale),
          {
            backgroundColor: fill.alpha > 0 ? withAlpha(fill.color, fill.alpha) : 'transparent',
            borderWidth: outline * scale,
            borderColor: palette.ink,
          },
        ]}
      />
    );
  }
  const bars = polyBars(shape.pts, barsFor(shape, scale, barTarget));
  const fillBars =
    fill.alpha > 0
      ? bars.map((bar, i) => (
          <View
            key={`fill-${i}`}
            style={[barStyle(bar, i, bars.length, scale, 0), { backgroundColor: fill.color }]}
          />
        ))
      : null;
  return (
    <>
      {bars.map((bar, i) => (
        <View key={`ink-${i}`} style={[barStyle(bar, i, bars.length, scale, outline), INK]} />
      ))}
      {fillBars == null ? null : fill.alpha < 1 ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: fill.alpha }]}>
          {fillBars}
        </View>
      ) : (
        fillBars
      )}
    </>
  );
}

const INK: ViewStyle = { backgroundColor: palette.ink };
const INK_FILL: Fill = { color: palette.ink, alpha: 1 };

function Figure({
  side,
  props,
  width,
}: {
  side: FigureSide;
  props: MuscleFigureProps;
  width: number;
}) {
  const scale = width / FIGURE_GRID.w;
  const height = FIGURE_GRID.h * scale;

  return (
    <View>
      <View style={{ width, height }}>
        {/* Pass 1 — the silhouette's contour. Every part inflated, in ink;
            whatever a neighbour does not cover in pass 2 survives as the
            outline, so the joints fuse and only the outside is drawn. */}
        {FIGURE_BODY.map((b) => (
          <Mark
            key={`o-${b.part}`}
            shape={b.shape}
            fill={INK_FILL}
            scale={scale}
            outline={BODY_OUTLINE}
            barTarget={BODY_BAR_POINTS}
          />
        ))}
        {/* Pass 2 — the body. Muscle ground in `paper-deep`; head, hands and
            feet in the PLATE colour, because they are not data — see the
            `neutral` note on FIGURE_BODY for why they are no longer grey. */}
        {FIGURE_BODY.map((b) => (
          <Mark
            key={`b-${b.part}`}
            shape={b.shape}
            fill={{ color: b.neutral ? palette.paperHi : palette.paperDeep, alpha: 1 }}
            scale={scale}
            outline={0}
            barTarget={BODY_BAR_POINTS}
          />
        ))}
        {/* Pass 3 — the muscles, every one of them, in declaration order. */}
        {musclesFor(side).map((m, i) => (
          <Mark
            key={`${m.muscle}-${i}`}
            shape={m.shape}
            fill={fillFor(props, m.muscle)}
            scale={scale}
            outline={MUSCLE_OUTLINE}
            barTarget={BAR_POINTS}
          />
        ))}
      </View>
      <Text className="mt-1.5 text-center font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {side}
      </Text>
    </View>
  );
}

/**
 * The freshness scale — the key to the ramp, down the left of the figures.
 *
 * Deep green at the top fading to the floor at the bottom, with both ends named
 * in words. It is a KEY, not a reading: it says nothing about today, it says
 * what the fills mean. (The count it replaced — "N of M fresh" — did not go
 * away; it is printed in the section's own tally on both screens, where a number
 * belongs.)
 *
 * The bands are the SAME colours the muscles are — {@link freshnessFill} at
 * fourteen sampled readings. Not an approximation of the ramp: the ramp. A key
 * drawn any other way is a key to something else, which is what condemned the
 * three flat swatches this component used to ship. (Since 2026-08-14 the ramp
 * runs green → grey rather than green → pale green, so the bar now shows a hue
 * turning as well as a value dropping.)
 *
 * The track's border is `border border-hairline` — uniform on all four edges,
 * the legal shape. At 2.29:1 on the plate it is under the 3:1 floor; that is the
 * app's standing documented exception for the rule weight
 * (src/constants/theme.ts), and nothing needed to read the scale depends on
 * seeing it, because both ends are printed as words.
 */
function FreshnessScale({ height }: { height: number }) {
  return (
    <View className="items-center" style={{ width: SCALE_WIDTH, height }}>
      <Text className="font-label text-[9px] font-semibold uppercase tracking-[0.4px] text-ink-secondary">
        Fresh
      </Text>
      <View className="my-1 w-[11px] flex-1 border border-hairline bg-paper-deep">
        {BANDS.map((band) => (
          <View
            key={band}
            className="w-full flex-1"
            style={{
              backgroundColor: freshnessFill(100 - (band * 100) / (SCALE_BANDS - 1)).color,
            }}
          />
        ))}
      </View>
      <Text className="font-label text-[9px] font-semibold uppercase tracking-[0.4px] text-ink-secondary">
        Spent
      </Text>
    </View>
  );
}

const BANDS = Array.from({ length: SCALE_BANDS }, (_, i) => i);

/** The muscles-mode announcement — the drawing said in words. */
function musclesSpoken(primary: Muscle[], secondary: Muscle[]): string {
  const names = (muscles: Muscle[]) => muscles.map((m) => MUSCLE_LABEL[m].toLowerCase()).join(', ');
  const parts: string[] = [];
  if (primary.length > 0) parts.push(`Primary: ${names(primary)}.`);
  if (secondary.length > 0) parts.push(`Assists: ${names(secondary)}.`);
  return parts.length > 0 ? `Muscles worked. ${parts.join(' ')}` : 'Muscles worked: not recorded.';
}

export function MuscleFigure(props: MuscleFigureProps) {
  const width = props.figureWidth ?? FIGURE_WIDTH;
  const height = FIGURE_GRID.h * (width / FIGURE_GRID.w);

  // One `accessible` root per drawing: it collapses every unlabelled view AND
  // the two "front"/"back" captions, which were otherwise the only things in
  // this component VoiceOver could focus — two stray words with no subject.
  return (
    <View
      accessible
      accessibilityLabel={
        props.mode === 'freshness'
          ? freshnessSummary(props.ledger)
          : musclesSpoken(props.primary, props.secondary)
      }
      className="flex-row items-start justify-center gap-2">
      {props.mode === 'freshness' ? <FreshnessScale height={height} /> : null}
      <Figure side="front" props={props} width={width} />
      <Figure side="back" props={props} width={width} />
    </View>
  );
}

export type MuscleFigureLegendProps =
  { mode: 'freshness'; ledger: MuscleFreshness[] } | { mode: 'muscles' };

/**
 * The figure's roll call — the muscles that need attention, NAMED.
 *
 * The drawing answers *where on me*; this answers *which*, and it is the path
 * that needs no colour at all. It is why a continuous opacity ramp is safe as
 * the drawing's encoding: the ramp is the fast read, these words are the exact
 * one, and a reader who sees no hue loses nothing.
 *
 * Only states actually present get a row — a key listing a state nothing is in
 * is a key to nothing — and the worst state leads, the way `WeeklyVolume` leads
 * with the muscles that need attention (app/exercise.tsx). `fresh` gets no row
 * on purpose: printing thirteen names for the muscles that need nothing is the
 * data dump the whole screen is written against, and the count lives in the
 * section tally.
 *
 * **No swatch on these rows, deliberately.** The key to the drawing is the
 * gradient scale beside it; a second key in two arbitrary shades of the same
 * green would only invite the reader to match a row against a fill and get it
 * wrong. The WORD carries the state, in its own text cut, which is the house
 * answer (src/components/home/signal.tsx).
 */
export function MuscleFigureLegend(props: MuscleFigureLegendProps) {
  if (props.mode === 'muscles') {
    return (
      <View className="flex-row justify-center gap-5">
        <KeyRow>
          <KeyMark alpha={1} />
          <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            Primary
          </Text>
        </KeyRow>
        <KeyRow>
          <KeyMark alpha={MUSCLES_SECONDARY_ALPHA} />
          <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            Assists
          </Text>
        </KeyRow>
      </View>
    );
  }

  const tally = freshnessTally(props.ledger);
  const rows = (
    [
      { state: 'fatigued', muscles: tally.fatigued },
      { state: 'recovering', muscles: tally.recovering },
    ] as const
  ).filter((r) => r.muscles.length > 0);

  // Empty is AUTHORED, never blank (00-design-spec.md §5) — and the two empties
  // are not the same fact. "Nothing is depleted" is a reading; "nothing has ever
  // been logged" is the absence of one, and `muscleFreshness` renders them
  // identically by construction. Same caveat the Train-today gauge prints.
  if (rows.length === 0) {
    return (
      <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
        {tally.neverTrained
          ? 'No training in the last 14 days, so every muscle reads fresh. Log a session and the figure starts fading.'
          : 'Every muscle is fresh — nothing to train around today.'}
      </Text>
    );
  }

  return (
    <View>
      {rows.map((row) => (
        <View
          key={row.state}
          accessible
          accessibilityLabel={`${row.muscles.length} ${FRESHNESS_LABEL[row.state].toLowerCase()}: ${row.muscles
            .map((m) => MUSCLE_LABEL[m].toLowerCase())
            .join(', ')}`}
          className="flex-row items-center gap-2.5 py-1">
          <Text
            className={`w-[74px] font-label text-[10px] font-semibold uppercase tracking-[1.2px] ${gaugeTextClass(freshnessTone(row.state))}`}>
            {FRESHNESS_LABEL[row.state]}
          </Text>
          <Text className="w-4 text-right font-mono text-[11px] text-ink-muted">
            {row.muscles.length}
          </Text>
          <Text className="flex-1 font-serif text-[13px] leading-5 text-ink">
            {muscleNames(row.muscles)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function KeyRow({ children }: { children: ReactNode }) {
  return <View className="flex-row items-center gap-1.5">{children}</View>;
}

/**
 * One key swatch for `muscles` mode, drawn as the figure draws it — plain ink
 * at the mark's own alpha, inside the same ink contour every muscle carries. Not
 * a generic chip: if the key and the drawing differ in treatment the key is
 * worse than none, which is what the retired three-swatch legend was.
 */
function KeyMark({ alpha }: { alpha: number }) {
  return (
    <View
      style={{
        width: 12,
        height: 12,
        borderRadius: 3,
        borderWidth: 1,
        borderColor: palette.ink,
        backgroundColor: withAlpha(palette.ink, alpha),
      }}
    />
  );
}
