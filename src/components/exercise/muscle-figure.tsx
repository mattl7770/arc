import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

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
  BODY_OUTLINE,
  FIGURE_BODY,
  FIGURE_GRID,
  regionsFor,
  type FigureSide,
} from '@/lib/exercise/figure';
import type { Muscle, MuscleFreshness } from '@/lib/exercise/types';

/**
 * THE BODY FIGURE — front and back schematics with a recovery bar down the left.
 *
 * ## What was wrong with the first one (owner, on device, 2026-08-12)
 *
 * *"The muscle recovery graphic we have now is pretty rough and hard to tell
 * what's what."* Four separate defects, and only the last is a matter of taste:
 *
 * 1. **There was no body.** The 2026-08-11 figure drew sixteen muscle cells
 *    floating on the page with a hairline ring for a head. A rectangle means
 *    "quads" only because of where it sits on a person, and there was no person
 *    — so the drawing was sixteen rounded boxes and a circle. Fixed in
 *    src/lib/exercise/figure.ts: a nineteen-block silhouette now carries the
 *    regions, drawn by {@link Figure} in two passes (below).
 *
 * 2. **The two marked states were the same colour.** `recovering` took
 *    `signalInk.caution` #6E4F15 and `fatigued` took `signalInk.poor` #8F3524.
 *    Measured against each other those are **1.03:1** — to anyone not
 *    perceiving hue, and to anyone glancing at a 15pt cell, one shade of dark
 *    brown. Colour was the only carrier and it carried nothing, which is
 *    precisely the defect src/components/home/signal.tsx was rewritten to fix
 *    on Home. Fixed by FORM (below).
 *
 * 3. **Nothing was named.** Sixteen unlabelled cells, and a legend of three
 *    8pt swatches — one of which (`fresh` = `paper-deep`) measures 1.62:1 on
 *    the plate and is effectively invisible. There was no path from a mark on
 *    the drawing to the name of a muscle. Fixed by {@link MuscleFigureLegend},
 *    which is now the KEY AND THE ROLL CALL in one: the real mark, the state in
 *    words, the count, and the muscle names.
 *
 * 4. **It said nothing to assistive tech.** No labels anywhere; the only
 *    focusable things in it were two stray captions reading "front" and "back".
 *    Fixed by collapsing each figure pair into one `accessible` element
 *    carrying `freshnessSummary` — and, on the hub, by putting that same string
 *    on the Pressable, since iOS never descends into an accessible ancestor.
 *
 * ## Why it is still a silhouette
 *
 * The honest option was to abandon the body and ship a labelled two-column
 * board (anterior / posterior, head-to-toe, one named row per muscle). It was
 * rejected for one reason: **that board already exists** — it is the ledger on
 * app/muscle-freshness.tsx, one tap away. What only a figure buys is the
 * spatial read: *where on me*. A list cannot answer that, and answering it is
 * the entire reason a body map is worth drawing.
 *
 * What made the first attempt fail was not that boxes cannot read as anatomy —
 * it is that DISCONNECTED boxes cannot. Give the boxes a contoured body to sit
 * on and the same rectangles read as muscle groups immediately.
 *
 * ## The two-pass silhouette — the whole trick
 *
 * There is no `react-native-svg` in this project and none is going in (a native
 * module costs the owner a fresh EAS cloud build, 01-rn-port-guide.md §5), so
 * there is no path and no stroke. A contoured silhouette out of rectangles is
 * still one line of code, and it is this: **draw the body twice.**
 *
 *   pass 1  every block INFLATED by `BODY_OUTLINE`, filled `ink`
 *   pass 2  every block at TRUE SIZE, filled `paper-deep`
 *
 * Wherever a block has no neighbour, one unit of ink survives pass 2 as a
 * contour. Wherever two blocks abut — and the geometry makes them overlap at
 * every joint on purpose — the neighbour's pass-2 fill covers the inflation, so
 * no internal seam is drawn. One list of rects, two `map`s, and a figure with a
 * continuous outline. It cannot get out of sync with itself the way a
 * hand-authored second "interior" list would.
 *
 * The ink contour measures **9.74:1** on the paper-deep it encloses and 15.81:1
 * on the plate around it, so the body's shape is unmistakable even though the
 * paper-deep ground is deliberately quiet at 1.62:1. That split is the point:
 * a loud outline and a quiet interior is how a printed anatomy chart is drawn,
 * and it leaves the interior free for the marks to be the loudest thing on it.
 *
 * ## The marks: FORM first, hue second
 *
 *   fresh        no mark — the body ground itself. A rested body is an
 *                unremarkable one, and a mark that appears on every muscle
 *                marks nothing.
 *   recovering   a HOLLOW ring in `signalInk.caution`.
 *   fatigued     a SOLID block in `signalInk.poor`.
 *
 * Solid-versus-hollow is the carrier, and it is not a subtlety: it is a
 * difference in the AREA of ink inside the cell, on the order of 4×, which
 * survives hue-blindness, a glance, and a 15pt cell. Each mark clears WCAG
 * 1.4.11's 3:1 for a graphical object against the paper-deep ground it sits on
 * — **4.17:1** for the caution ring and **4.31:1** for the poor block — and
 * against the plate behind the figure they measure 6.77 and 7.00.
 *
 * The INK cuts, not the swatches, for the reason src/components/ui/gauge.tsx
 * records: on recessed stock the swatch cut fails the 3:1 floor (2.58 / 4.11 on
 * paper-dim, worse on paper-deep), and the ink cut clears it comfortably. The
 * ink cut is the floor for words and the safe choice for fills; the swatch is
 * neither, here.
 *
 * **The hatch was measured and rejected.** signal.tsx's `PoorHatch` is the
 * house third cue for the worst biological state, and it does not transfer:
 * over `signal.poor` #AA402C (the swatch it was designed for) ink at .34
 * composites to 1.50:1, but over `signalInk.poor` #8F3524 — already a dark fill
 * — it composites to **1.38:1**, i.e. less than the texture it is on Home,
 * inside a cell a twentieth the area of the one it was tuned on. Solid-versus-
 * hollow already separates the two states at roughly ten times that strength,
 * so a third cue at 1.38:1 would buy visual mud and nothing else. Recorded
 * rather than silently omitted: the hatch is right on Home and wrong here, and
 * the difference is which cut the fill uses.
 *
 * **And colour is never alone anyway.** Every marked muscle is also named in
 * words under the figure ({@link MuscleFigureLegend}) and spoken in the
 * accessible summary. The drawing is the fast path, not the only path.
 *
 * ## The one hard rule this file obeys
 *
 * Never a one-sided border width beside a border colour — React Native paints
 * that pair as a complete rectangle (the docblock under `Divider` in
 * src/components/ui/block.tsx, four owner reports of "weird boxes"). Every mark
 * here is either a background colour or a **uniform four-sided** `borderWidth`,
 * which is the legal shape and the one every plate in the app already draws.
 */

export type MuscleFigureProps =
  | { mode: 'freshness'; ledger: MuscleFreshness[]; figureWidth?: number }
  | { mode: 'muscles'; primary: Muscle[]; secondary: Muscle[]; figureWidth?: number };

/**
 * The default per-figure width, in points. Two figures plus the recovery bar
 * and its gaps come to 280pt, which fits inside a `plate` on the narrowest
 * phone this app targets (325pt of content on a 393pt sheet, 20pt Screen
 * gutters and 14pt plate padding). At this width the grid scales 1.18× and the
 * smallest muscle cell lands at 14.2pt square — wide enough to carry a 2pt ring
 * and still read as hollow.
 */
const FIGURE_WIDTH = 118;

/** A cell's treatment, or nothing at all. Hollow and solid are the two forms. */
type Mark = { kind: 'solid' | 'ring'; color: string } | null;

function markFor(props: MuscleFigureProps, muscle: Muscle): Mark {
  if (props.mode === 'freshness') {
    const entry = props.ledger.find((m) => m.muscle === muscle);
    if (entry == null || entry.state === 'fresh') return null;
    return entry.state === 'recovering'
      ? { kind: 'ring', color: palette.signalInk.caution }
      : { kind: 'solid', color: palette.signalInk.poor };
  }
  // "Worked by this movement" is a fact about an exercise, not a biological
  // state, so it takes no signal colour — the firewall runs both ways
  // (00-design-spec.md §2). Same two forms, drawn in plain ink.
  if (props.primary.includes(muscle)) return { kind: 'solid', color: palette.ink };
  if (props.secondary.includes(muscle)) return { kind: 'ring', color: palette.ink };
  return null;
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
  // The ring scales with the drawing — a 2pt ring on a 9pt cell (the packed
  // exercise-detail size) would close up and read as solid, which is the one
  // thing the two forms must never do.
  const ring = Math.max(1, Math.round(scale * 1.6));

  return (
    <View>
      <View style={{ width, height }}>
        {/* Pass 1 — the contour. Inflated blocks in ink; whatever a neighbour
            does not cover in pass 2 survives as the silhouette's outline. */}
        {FIGURE_BODY.map((b) => {
          const w = (b.w + BODY_OUTLINE * 2) * scale;
          return (
            <View
              key={`outline-${b.part}`}
              style={{
                position: 'absolute',
                left: (b.x - BODY_OUTLINE) * scale,
                top: (b.y - BODY_OUTLINE) * scale,
                width: w,
                height: (b.h + BODY_OUTLINE * 2) * scale,
                borderRadius: b.round ? w / 2 : 0,
                backgroundColor: palette.ink,
              }}
            />
          );
        })}
        {/* Pass 2 — the body. True-size blocks in paper-deep, which is also
            what "fresh" looks like: an unmarked muscle IS the body. */}
        {FIGURE_BODY.map((b) => (
          <View
            key={`body-${b.part}`}
            style={{
              position: 'absolute',
              left: b.x * scale,
              top: b.y * scale,
              width: b.w * scale,
              height: b.h * scale,
              borderRadius: b.round ? (b.w * scale) / 2 : 0,
              backgroundColor: palette.paperDeep,
            }}
          />
        ))}
        {/* Pass 3 — the marks. Only depletion draws. */}
        {regionsFor(side).map((r, i) => {
          const mark = markFor(props, r.muscle);
          if (mark == null) return null;
          return (
            <View
              key={`${r.muscle}-${i}`}
              style={{
                position: 'absolute',
                left: r.x * scale,
                top: r.y * scale,
                width: r.w * scale,
                height: r.h * scale,
                ...(mark.kind === 'solid'
                  ? { backgroundColor: mark.color }
                  : // Uniform on all four edges — the legal border shape. A
                    // one-sided width beside a colour is the bug this whole
                    // codebase routes around (ui/block.tsx).
                    { borderWidth: ring, borderColor: mark.color }),
              }}
            />
          );
        })}
      </View>
      <Text className="mt-1.5 text-center font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {side}
      </Text>
    </View>
  );
}

/** The bar's quarter ticks — the same three stops, at the same weight, as `Gauge`. */
const TICKS = [25, 50, 75];

/**
 * The recovery bar — the vertical instrument down the left of the figures.
 *
 * Full at the top, empty at the bottom, and what it counts is stated in words
 * beside it: **how many muscles are fresh, out of how many the ledger covers.**
 * A COUNT, deliberately, and not a mean freshness score — `muscleFreshness`
 * reads a never-trained muscle 100, so an average over sixteen muscles would
 * sit near 95 forever and mean nothing, which is exactly the sort of number
 * 00-design-spec.md §5 forbids. A count of muscles is a count of muscles.
 *
 * **Not `Gauge` rotated, and the choice was live.** `Gauge` is a five-part
 * instrument built around a single 0-100 reading with a pin measured by two
 * `onLayout` passes and a drop line at the true value; none of that survives a
 * 90° turn, and the pin's whole apparatus exists for a value this bar does not
 * have. What it does take from `Gauge` is the VOCABULARY, so the two read as
 * one instrument family: the same recessed bordered track
 * (`border-hairline` on `bg-paper-dim`), the same quarter ticks overhanging
 * 3pt at the same weight, the same mono-10 `ink-muted` numerals for the scale.
 *
 * Contrast: the fill is `signal-optimal-ink` on `paper-dim` at **5.60:1** —
 * the figure `Gauge` already records for this exact pair. The track border is
 * `hairline` at 2.29:1 on the plate, the app's standing documented exception
 * (src/constants/theme.ts): nothing needed to read the value depends on seeing
 * it, because the value is printed as words in the section's own tally.
 *
 * Announced as a `progressbar` with the count as its value, in the style of
 * `Gauge` — but note the bar sits inside the figure's collapsed accessible
 * root on both screens, so in practice the summary sentence speaks for it. The
 * role is here so that a future call site which drops it in on its own is not
 * silent.
 */
function RecoveryBar({ fresh, total, height }: { fresh: number; total: number; height: number }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (fresh / total) * 100)) : 0;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${fresh} of ${total} muscles fresh`}
      accessibilityValue={{ min: 0, max: total, now: fresh }}
      className="w-6 items-center"
      style={{ height }}>
      <Text className="font-mono text-[10px] leading-[13px] text-ink-muted">{total}</Text>
      <View className="my-1 w-[10px] flex-1">
        <View className="h-full w-full border border-hairline bg-paper-dim">
          <View className="w-full bg-signal-optimal-ink" style={{ height: `${pct}%` }} />
        </View>
        {/* Filled views, never borders — and drawn after the track so they
            cross the fill rather than hide under it, the order `Gauge` uses. */}
        {TICKS.map((t) => (
          <View
            key={t}
            pointerEvents="none"
            style={{ top: `${t}%`, left: -3 }}
            className="absolute h-px w-4 bg-hairline"
          />
        ))}
      </View>
      <Text className="font-mono text-[10px] leading-[13px] text-ink-muted">0</Text>
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

  // One `accessible` root per drawing: it collapses ~90 unlabelled views AND
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
      className="flex-row items-start justify-center gap-2.5">
      {props.mode === 'freshness' ? (
        <RecoveryBar
          fresh={freshnessTally(props.ledger).fresh.length}
          total={props.ledger.length}
          height={height}
        />
      ) : null}
      <Figure side="front" props={props} width={width} />
      <Figure side="back" props={props} width={width} />
    </View>
  );
}

export type MuscleFigureLegendProps =
  { mode: 'freshness'; ledger: MuscleFreshness[] } | { mode: 'muscles' };

/**
 * The figure's key — and, in freshness mode, its roll call.
 *
 * The old legend was three 8pt swatches in a row, which failed twice over: the
 * `fresh` swatch was `paper-deep` at 1.62:1 (invisible), and none of the three
 * looked like what the figure actually draws. This one renders the REAL MARK at
 * real size beside the state in words, so the path from a shape on the body to
 * a name is one glance long.
 *
 * In freshness mode it also names every muscle in each marked state. That is
 * the direct answer to "hard to tell what's what": the figure says *where*, the
 * row says *which*, and the two are read together. Only states that are
 * actually present get a row — a key listing a state nothing is in is a key to
 * nothing — and the worst state leads, the way `WeeklyVolume` leads with the
 * muscles that need attention (app/exercise.tsx).
 *
 * `fresh` gets no row on purpose: it is the unmarked body, and printing
 * thirteen names for the muscles that need nothing is the data dump the whole
 * screen is written against. The count lives in the section tally and in the
 * bar.
 */
export function MuscleFigureLegend(props: MuscleFigureLegendProps) {
  if (props.mode === 'muscles') {
    return (
      <View className="flex-row justify-center gap-5">
        <KeyRow>
          <KeyMark kind="solid" color={palette.ink} />
          <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            Primary
          </Text>
        </KeyRow>
        <KeyRow>
          <KeyMark kind="ring" color={palette.ink} />
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
      { state: 'fatigued', muscles: tally.fatigued, kind: 'solid', color: palette.signalInk.poor },
      {
        state: 'recovering',
        muscles: tally.recovering,
        kind: 'ring',
        color: palette.signalInk.caution,
      },
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
          ? 'No sessions logged yet, so every muscle reads fresh. Log one and the figure starts marking.'
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
          <KeyMark kind={row.kind} color={row.color} />
          {/* The WORD is the primary carrier, in the state's own text cut — the
              two fills measure 1.03:1 against each other, so nothing else on
              this row could separate them for a reader who is not seeing hue. */}
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
 * One key swatch, drawn as the figure draws it — solid or hollow, square, at
 * 12pt. Not a generic chip: if the key and the drawing ever differ in form the
 * key is worse than none, which is what the retired three-swatch legend was.
 */
function KeyMark({ kind, color }: { kind: 'solid' | 'ring'; color: string }) {
  return (
    <View
      style={{
        width: 12,
        height: 12,
        ...(kind === 'solid' ? { backgroundColor: color } : { borderWidth: 2, borderColor: color }),
      }}
    />
  );
}
