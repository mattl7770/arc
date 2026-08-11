import { Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import { FIGURE_GRID, regionsFor, type FigureSide } from '@/lib/exercise/figure';
import type { Muscle, MuscleFreshness } from '@/lib/exercise/types';

/**
 * The body schematic — ARC's answer to the FitBod muscle heatmap, drawn as a
 * **print schematic** rather than an anatomy rendering: each muscle group is a
 * placed rectangular cell on a 100×220 grid (src/lib/exercise/figure.ts), front
 * and back figures side by side. Pure Views — no SVG dependency, no gradients,
 * no glow.
 *
 * Two modes:
 *
 *   freshness — cells are QUIET (paper-deep) while a muscle is fresh and take a
 *               signal-ink fill only as it depletes: caution while recovering,
 *               poor while fatigued. Marking only the depleted muscles is both
 *               the design's restraint (a mark must mean something) and the
 *               honest reading — a rested body is an unremarkable one. Signal
 *               colour is sanctioned here: freshness is a biological state, and
 *               the ink cut is the legible cut on pale fills (the
 *               freshnessColor note in app/muscle-freshness.tsx).
 *
 *   muscles   — a static "what this exercise works" diagram: primary movers in
 *               ink, synergists in hairline, everything else paper-deep. No
 *               signal colour — worked-by-a-movement is not a biological state,
 *               it's a fact about the exercise.
 *
 * The head is neutral chrome (a hairline ring), there to make the figure read
 * as a person at a glance. Nothing else is decorated.
 */

export type MuscleFigureProps =
  | { mode: 'freshness'; ledger: MuscleFreshness[]; figureWidth?: number }
  | { mode: 'muscles'; primary: Muscle[]; secondary: Muscle[]; figureWidth?: number };

/** freshness state → cell fill. Fresh stays quiet; only depletion marks. */
function freshnessFill(state: MuscleFreshness['state']): string {
  switch (state) {
    case 'fresh':
      return palette.paperDeep;
    case 'recovering':
      return palette.signalInk.caution;
    default:
      return palette.signalInk.poor;
  }
}

function fillFor(props: MuscleFigureProps, muscle: Muscle): string {
  if (props.mode === 'freshness') {
    const entry = props.ledger.find((m) => m.muscle === muscle);
    return entry ? freshnessFill(entry.state) : palette.paperDeep;
  }
  if (props.primary.includes(muscle)) return palette.ink;
  if (props.secondary.includes(muscle)) return palette.hairline;
  return palette.paperDeep;
}

function Figure({ side, props }: { side: FigureSide; props: MuscleFigureProps }) {
  const width = props.figureWidth ?? 128;
  const scale = width / FIGURE_GRID.w;
  const height = FIGURE_GRID.h * scale;
  const head = { size: 17 * scale, x: (50 - 8.5) * scale, y: 8 * scale };

  return (
    <View>
      <View style={{ width, height }}>
        {/* Head — neutral chrome; a ring, not a region. */}
        <View
          style={{
            position: 'absolute',
            left: head.x,
            top: head.y,
            width: head.size,
            height: head.size,
            borderRadius: head.size / 2,
            borderWidth: 1,
            borderColor: palette.hairline,
          }}
        />
        {regionsFor(side).map((r, i) => (
          <View
            key={`${r.muscle}-${i}`}
            style={{
              position: 'absolute',
              left: r.x * scale,
              top: r.y * scale,
              width: r.w * scale,
              height: r.h * scale,
              borderRadius: 2,
              backgroundColor: fillFor(props, r.muscle),
            }}
          />
        ))}
      </View>
      <Text className="mt-1.5 text-center font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {side}
      </Text>
    </View>
  );
}

export function MuscleFigure(props: MuscleFigureProps) {
  return (
    <View className="flex-row justify-evenly">
      <Figure side="front" props={props} />
      <Figure side="back" props={props} />
    </View>
  );
}

/**
 * The figure's legend, matching the active mode. Small label-voice swatch rows —
 * a printed chart's key, not a UI control.
 */
export function MuscleFigureLegend({ mode }: { mode: MuscleFigureProps['mode'] }) {
  const entries =
    mode === 'freshness'
      ? [
          { label: 'Fresh', color: palette.paperDeep },
          { label: 'Recovering', color: palette.signalInk.caution },
          { label: 'Fatigued', color: palette.signalInk.poor },
        ]
      : [
          { label: 'Primary', color: palette.ink },
          { label: 'Assists', color: palette.hairline },
        ];
  return (
    <View className="flex-row justify-center gap-4">
      {entries.map((e) => (
        <View key={e.label} className="flex-row items-center gap-1.5">
          <View style={{ width: 8, height: 8, borderRadius: 1, backgroundColor: e.color }} />
          <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            {e.label}
          </Text>
        </View>
      ))}
    </View>
  );
}
