import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

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
  BODY_STROKE_PT,
  FIGURE_BODY,
  FIGURE_GRID,
  MUSCLE_STROKE_PT,
  MUSCLE_SPENT,
  MUSCLE_FRESH,
  NEUTRAL_STROKE_PT,
  NON_DATA_FILL,
  freshnessFill,
  musclesFor,
  pathD,
  shadeStops,
  strokeUnits,
  type Shade,
  type FigureSide,
} from '@/lib/exercise/figure';
import type { Muscle, MuscleFreshness } from '@/lib/exercise/types';

/**
 * THE BODY FIGURE — anterior and posterior anatomy with a freshness scale down
 * the left.
 *
 * ## The technique changed on 2026-08-25: this is SVG now
 *
 * Five rounds of this drawing were rejected on hardware, and every one of them
 * was built out of filled `View`s — rounded rects for masses, hand-rasterised
 * stacks of one-`View` scanline bars for tapers — because `react-native-svg` is
 * a native module and a native module cost the owner an EAS build. **The owner
 * has rebuilt and called the build cost low**, so the figure is `<Path>`s now.
 *
 * What that buys, and what it had to buy, is **internal shading**. A `View` is
 * one flat colour, so every muscle was one flat colour inside one ink line, and
 * the drawing read as a coloured MAP rather than as a rendering of a body — an
 * anatomy plate gets its depth from the gradient inside each belly, not from its
 * outlines. The geometry, the gradients and the reasoning for both live in
 * src/lib/exercise/figure.ts; this file is the paint.
 *
 * Three consequences reach this file:
 *
 *   - `Mark` is gone. A shape is one `<Path>` with a `d` from `pathD`, a
 *     gradient fill from `<Defs>`, and a stroke. No bar stacks, no inflated ink
 *     copies, no opacity wrapper, no view budget.
 *   - **Stroke weight is specified in POINTS** and divided by the scale
 *     (`strokeUnits`), so the silhouette holds a 1.15pt contour and a muscle a
 *     0.62pt hairline at 72, 118 and 128pt alike. A width fixed in grid units
 *     renders 1.8× heavier at the big size than at the small one.
 *   - **Gradient ids must be unique per document**, and a server render puts
 *     both figures in one DOM, so every id is namespaced by mode and side. They
 *     are deterministic rather than generated, because `useId` values are not
 *     stable across a server render and a hydration and a broken `url(#…)` is an
 *     unfilled muscle.
 *
 * ## The ramp cannot be the only carrier, and it is not
 *
 * A continuous ramp on one hue is a *fast* path, never the only one. Everything
 * below is unchanged from the round that fixed it:
 *
 *   - {@link MuscleFigureLegend} still names, in words, every muscle that is
 *     recovering or fatigued, grouped by state. That is the answer to "which one
 *     is that" and it needs no colour at all.
 *   - The figure collapses into ONE `accessible` element carrying
 *     `freshnessSummary` — otherwise a few hundred unlabelled nodes and two
 *     stray captions reading "front" and "back" are all VoiceOver can find.
 *   - iOS never descends into an `accessible` ancestor, which is why the hub's
 *     `Pressable` carries that same summary string itself (app/exercise.tsx).
 *   - Every reading clears WCAG 1.4.11's 3:1 against the plate at its LIGHTEST
 *     pixel — which is a stronger claim than the flat version could make, and is
 *     asserted over all 101 readings in db/exercise-ai.test.mjs §1.
 *   - {@link FreshnessScale} prints the ramp's ends in words — FRESH at the top,
 *     SPENT at the bottom — so the direction is never inferred.
 *
 * ## ⚠️ `mode: 'muscles'` takes no signal colour, and no gradient either
 *
 * app/exercise-detail.tsx uses this component to show which muscles a MOVEMENT
 * works. That is a fact about an exercise, not a biological state, so it must
 * never wear the green (00-design-spec.md §2). It draws in plain ink at two
 * alphas — full for a primary mover, {@link MUSCLES_SECONDARY_ALPHA} for an
 * assist — which measure **4.10:1 against each other**, a light/dark split that
 * survives hue-blindness outright. A muscle the movement does not work is drawn
 * as an empty contour, so the map still shows where everything is.
 *
 * The shading is deliberately NOT applied there. Those two alphas are a measured
 * pair; a gradient over either of them would make the measurement a range and
 * the distinction a judgement call, for a mode whose whole job is to say "this
 * one, not that one". The body ground keeps its modelling, so the figure still
 * reads as a person.
 *
 * ## The one hard rule this file obeys
 *
 * Never a one-sided border width beside a border colour — React Native paints
 * that pair as a complete rectangle (the docblock under `Divider` in
 * src/components/ui/block.tsx, four owner reports of "weird boxes"). It does not
 * arise inside the `<Svg>`, where a stroke is a stroke; it still governs the RN
 * chrome around it, and nothing here takes a border but the scale track, which
 * is uniform on all four edges.
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
 * enough to survive hue-blindness outright, and 1.68:1 against the neutral the
 * head, hands and feet wear. The obvious 0.30 was measured first and rejected:
 * it composites to #938F80, which is **1.30:1** against that neutral, so a
 * worked calf and a foot read as the same tone in a 72pt figure. The tone a mark
 * shares must never be the tone of the thing that means "not a mark".
 */
const MUSCLES_SECONDARY_ALPHA = 0.42;

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

/**
 * One gradient in `<Defs>`, resolved against the colour it shades.
 *
 * Both kinds are in `objectBoundingBox` units — SVG's default — which is what
 * lets one `dome` model a glute and a calf belly: the gradient stretches with
 * the shape instead of sitting on it as a circle.
 */
function Gradient({ id, shade, base }: { id: string; shade: Shade; base: string }) {
  const stops = shadeStops(shade, base).map((s, i) => (
    <Stop key={i} offset={s.offset} stopColor={s.color} />
  ));
  if (shade.kind === 'linear') {
    return (
      <LinearGradient id={id} x1={shade.a[0]} y1={shade.a[1]} x2={shade.b[0]} y2={shade.b[1]}>
        {stops}
      </LinearGradient>
    );
  }
  return (
    <RadialGradient
      id={id}
      cx={shade.c[0]}
      cy={shade.c[1]}
      fx={shade.c[0]}
      fy={shade.c[1]}
      r={shade.r}>
      {stops}
    </RadialGradient>
  );
}

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
  const muscles = musclesFor(side);
  const ns = `${props.mode === 'freshness' ? 'f' : 'm'}${side}`;
  const fills = muscles.map((m) => fillFor(props, m.muscle));
  const shaded = props.mode === 'freshness';

  return (
    <View>
      <Svg width={width} height={height} viewBox={`0 0 ${FIGURE_GRID.w} ${FIGURE_GRID.h}`}>
        <Defs>
          {FIGURE_BODY.map((b, i) =>
            b.shade == null ? null : (
              <Gradient
                key={`bg-${i}`}
                id={`${ns}-b${i}`}
                shade={b.shade}
                base={palette.paperDeep}
              />
            )
          )}
          {shaded
            ? muscles.map((m, i) =>
                fills[i]!.alpha === 0 ? null : (
                  <Gradient
                    key={`mg-${i}`}
                    id={`${ns}-m${i}`}
                    shade={m.shade}
                    base={fills[i]!.color}
                  />
                )
              )
            : null}
        </Defs>

        {/* Pass 1 — the silhouette's contour. Every part stroked at DOUBLE
            weight with no fill; pass 2 then over-paints the inner half of every
            stroke, so what survives is one BODY_STROKE_PT line around the OUTSIDE
            of the union and not a single internal seam. */}
        {FIGURE_BODY.map((b) => (
          <Path
            key={`o-${b.part}`}
            d={pathD(b.shape)}
            fill="none"
            stroke={palette.ink}
            strokeWidth={strokeUnits(BODY_STROKE_PT, scale) * 2}
            strokeLinejoin="round"
          />
        ))}

        {/* Pass 2 — the body. Muscle ground modelled as a soft cylinder; head,
            hands and feet FLAT in the plate colour, because they are not data —
            and stroked in this pass too, which is what puts a wrist line, an
            ankle line and a jaw line in. The head is last in FIGURE_BODY so its
            chin is drawn over the neck rather than the neck over the chin. */}
        {FIGURE_BODY.map((b, i) => (
          <Path
            key={`b-${b.part}`}
            d={pathD(b.shape)}
            fill={b.neutral ? NON_DATA_FILL : `url(#${ns}-b${i})`}
            stroke={b.neutral ? palette.ink : 'none'}
            strokeWidth={b.neutral ? strokeUnits(NEUTRAL_STROKE_PT, scale) : 0}
            strokeLinejoin="round"
          />
        ))}

        {/* Pass 3 — the muscles, every one of them, in declaration order. */}
        {muscles.map((m, i) => {
          const fill = fills[i]!;
          return (
            <Path
              key={`${m.muscle}-${i}`}
              d={pathD(m.shape)}
              fill={fill.alpha === 0 ? 'none' : shaded ? `url(#${ns}-m${i})` : fill.color}
              fillOpacity={shaded ? 1 : fill.alpha}
              stroke={palette.ink}
              strokeWidth={strokeUnits(MUSCLE_STROKE_PT, scale)}
              strokeLinejoin="round"
            />
          );
        })}
      </Svg>
      <Text className="mt-1.5 text-center font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {side}
      </Text>
    </View>
  );
}

/**
 * The freshness scale — the key to the ramp, down the left of the figures.
 *
 * Deep green at the top running to the spent neutral at the bottom, with both
 * ends named in words. It is a KEY, not a reading: it says nothing about today,
 * it says what the fills mean. (The count it replaced — "N of M fresh" — did not
 * go away; it is printed in the section's own tally on both screens, where a
 * number belongs.)
 *
 * **A true gradient since 2026-08-25**, where it used to be fourteen sampled
 * bands stacked in `View`s. The bands were an honest approximation of a ramp
 * that was itself drawn in flat steps; now that the muscles are continuous, a
 * stepped key would be a key to something the drawing no longer does. Its two
 * stops are {@link MUSCLE_SPENT} and {@link MUSCLE_FRESH} directly, and the
 * interpolation is the same sRGB lerp `freshnessFill` performs, so the bar is
 * the ramp rather than a picture of it.
 *
 * The track's border is `border border-hairline` — uniform on all four edges,
 * the legal shape. At 2.29:1 on the plate it is under the 3:1 floor; that is the
 * app's standing documented exception for the rule weight
 * (src/constants/theme.ts), and nothing needed to read the scale depends on
 * seeing it, because both ends are printed as words.
 */
function FreshnessScale({ height }: { height: number }) {
  const trackH = Math.max(24, height - 26);
  return (
    <View className="items-center" style={{ width: SCALE_WIDTH, height }}>
      <Text className="font-label text-[9px] font-semibold uppercase tracking-[0.4px] text-ink-secondary">
        Fresh
      </Text>
      <View className="my-1 border border-hairline">
        <Svg width={11} height={trackH}>
          <Defs>
            <LinearGradient id="freshness-scale" x1={0} y1={0} x2={0} y2={1}>
              <Stop offset={0} stopColor={MUSCLE_FRESH} />
              <Stop offset={1} stopColor={MUSCLE_SPENT} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={11} height={trackH} fill="url(#freshness-scale)" />
        </Svg>
      </View>
      <Text className="font-label text-[9px] font-semibold uppercase tracking-[0.4px] text-ink-secondary">
        Spent
      </Text>
    </View>
  );
}

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

  // One `accessible` root per drawing: it collapses every unlabelled node AND
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
 * that needs no colour at all. It is why a continuous ramp is safe as the
 * drawing's encoding: the ramp is the fast read, these words are the exact one,
 * and a reader who sees no hue loses nothing.
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
 * One key swatch for `muscles` mode, drawn as the figure draws it — plain ink at
 * the mark's own alpha, inside the same ink contour every muscle carries. Not a
 * generic chip: if the key and the drawing differ in treatment the key is worse
 * than none, which is what the retired three-swatch legend was.
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
        backgroundColor: `rgba(28, 25, 17, ${alpha})`,
      }}
    />
  );
}
