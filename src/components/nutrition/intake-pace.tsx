import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  ChartBand,
  ChartDot,
  ChartFrame,
  ChartLegend,
  ChartLine,
  ChartRule,
  type ChartTick,
} from '@/components/ui/chart';
import { Divider } from '@/components/ui/block';
import { palette } from '@/constants/theme';
import { linePath, stepPath } from '@/lib/charts/geometry';
import { fmtInt } from '@/lib/nutrition/format';
import {
  bandStatus,
  chartWindow,
  clockAt,
  CURVE_MIN_DAYS,
  DAY_BAND,
  expectedCurvePoints,
  expectedShareAt,
  intakePace,
  landingRange,
  minuteOfNow,
  paceClockStart,
  paceWords,
  todayIntake,
  type CurveMeal,
  type ExpectedCurve,
  type IntakePace as PaceReading,
  type TodayIntake,
} from '@/lib/nutrition/pace-curve';
import type { SignalLevel } from '@/types/home';

/**
 * **By the hour** — today's calories (and protein) against the shape of a usual
 * day, folded to one line under the macro bars until tapped (items 95 and 84,
 * owner, 2026-10-21; the model is src/lib/nutrition/pace-curve.ts).
 *
 * ## Folded: one line
 *
 * `BY THE HOUR ··· 180 kcal ahead ▾`. The Today corner directly above already
 * states the ledger (`1,240 of 2,400 kcal`), so the fold does not repeat it — it
 * adds the one thing the corner cannot say: where today stands against a usual
 * day AT THIS HOUR. Once the curve says the eating day is over the words switch
 * from pace to the ±10% band ("in range", "300 kcal under range").
 *
 * ## Unfolded: two small charts on one clock, never one chart with two scales
 *
 *   - **Calories.** The running total as a STEP line (it holds between meals and
 *     jumps at each), the expected curve dashed, the ±10% band around the goal as
 *     a ground with the goal ruled through it, a hairline at NOW, and a dot where
 *     today stands.
 *   - **Protein**, beneath, shorter, on the same hour axis: the same marks minus
 *     the band — protein is a floor, not a budget (the Home pillar grades it
 *     one-sided for the same reason), so a range around it would be a claim the
 *     rest of the app does not make.
 *
 * Calories and protein are different units, so they are two charts sharing an
 * x-axis — a dual-axis chart would invent a relationship between two scales.
 *
 * ## The one colour, and where it comes from
 *
 * The NOW dot on each chart is filled with the grade the macro bar above it
 * already wears (`macroGrade`, FB2) — passed in, never recomputed, so the dot and
 * the bar cannot disagree. Same verdict, not the same paint: the dot takes the
 * standard `signal.*` swatch cut, because the bars' `bar` cut is theirs alone
 * (docs/project-status.md §3). Everything else is ink. The pace WORDS are measured
 * against the learned curve while the bar's colour is graded on Home's fixed
 * pace anchors; the two answer different questions (where today is against a
 * usual day of HIS, and where the day is projected to land), and the colour
 * stays the pillar's.
 *
 * ## What adjusts
 *
 * The goal does not move — nothing in ARC models a goal that drifts within a
 * day. What moves with every meal is printed under the chart: what is left, how
 * much MORE would still land the day inside ±10%, and how far today is from the
 * curve at this minute.
 */

const KCAL_HEIGHT = 132;
const PROTEIN_HEIGHT = 64;

export type IntakeByHourProps = {
  meals: CurveMeal[];
  curves: { kcal: ExpectedCurve; protein_g: ExpectedCurve };
  goals: { kcal: number; protein_g: number | null };
  levels: { kcal: SignalLevel; protein_g: SignalLevel };
  now: Date;
  dayStartsAt: string;
  /** D4: a 23- or 31-hour day has no honest hour-of-day curve. Pace withheld. */
  timezoneChanged: boolean;
  /** Render unfolded — for the headless suite, where a tap cannot happen. */
  initiallyOpen?: boolean;
};

/** Hour ticks across `[start, end]` minutes, on clock hours divisible by the step. */
function hourTicks(start: number, end: number, dayStartsAt: string): ChartTick[] {
  const step = end - start > 12 * 60 ? 4 : 3;
  const ticks: ChartTick[] = [];
  for (let m = start; m <= end; m += 60) {
    const clock = clockAt(m, dayStartsAt);
    if (Number(clock.slice(0, 2)) % step === 0) ticks.push({ at: m, label: clock });
  }
  return ticks;
}

/** The running total as step points from the axis start to now. Untimed meals
 *  are eaten but have no hour: they step up at now, the one instant they are
 *  certainly before. A meal timed AFTER now was still eaten by now, so it steps
 *  up at now too — the line never runs on past the NOW dot. */
function runningPoints(
  intake: TodayIntake,
  metric: 'kcal' | 'protein_g',
  start: number,
  nowMinute: number
): { x: number; y: number }[] {
  const points = [{ x: start, y: 0 }];
  let last = start;
  let total = 0;
  for (const step of intake.steps) {
    const x = Math.max(start, Math.min(step.minute, nowMinute));
    points.push({ x, y: step[metric] });
    last = x;
    total = step[metric];
  }
  const end = Math.max(last, nowMinute);
  points.push({ x: end, y: total });
  if (intake.untimed[metric] > 0) points.push({ x: end, y: total + intake.untimed[metric] });
  return points;
}

/** "1,160 kcal left · 920–1,400 more lands the day in range" and its siblings.
 *  Past the top only when {@link bandStatus} says over — exactly the top edge
 *  is in range, as the fold says. */
function landingLine(eaten: number, goal: number): string {
  const { min, max } = landingRange(eaten, goal);
  const left = goal - eaten;
  if (bandStatus(eaten, goal) === 'over')
    return `${fmtInt(eaten - goal * (1 + DAY_BAND))} kcal past the top of the range`;
  if (min === 0) return `In range now · up to ${fmtInt(max)} more stays in it`;
  return `${fmtInt(left)} kcal left · ${fmtInt(min)}–${fmtInt(max)} more lands the day in range`;
}

function paceLine(pace: PaceReading, clock: string, source: ExpectedCurve['source']): string {
  const curve = source === 'learned' ? 'your usual day' : 'the default day';
  if (pace.closed) {
    return `${source === 'learned' ? 'Your usual day is' : 'A default day is'} done eating by ${clock} — this one reads ${paceWords(pace, 'kcal')}`;
  }
  return `~${fmtInt(pace.expectedNow)} expected by ${clock} on ${curve} · ${paceWords(pace, 'kcal')}`;
}

function sourceNote(curve: ExpectedCurve): string {
  if (curve.source === 'learned') {
    return `Usual pace is the median of your last 4 weeks — ${curve.days} days with timed meals.`;
  }
  return `Default pace: a three-meal day. ${curve.days} of the ${CURVE_MIN_DAYS} days with timed meals needed to learn your own are logged.`;
}

export function IntakeByHour(props: IntakeByHourProps) {
  const [open, setOpen] = useState(props.initiallyOpen ?? false);
  const { meals, curves, goals, now, dayStartsAt, timezoneChanged } = props;

  const intake = todayIntake(meals, dayStartsAt);
  const nowMinute = minuteOfNow(now, dayStartsAt);
  const clock = clockAt(nowMinute, dayStartsAt);
  const share = expectedShareAt(curves.kcal, nowMinute);
  // Before the default curve's first anchor nothing is expected, and Home
  // withholds its verdict there — so this says when the clock starts instead.
  const opens = timezoneChanged ? null : paceClockStart(curves.kcal);
  const waitsUntil = opens !== null && nowMinute < opens ? clockAt(opens, dayStartsAt) : null;
  const pace =
    timezoneChanged || waitsUntil !== null
      ? null
      : intakePace(intake.total.kcal, goals.kcal, share);
  const folded = pace
    ? paceWords(pace, 'kcal')
    : waitsUntil !== null
      ? `pace starts at ${waitsUntil}`
      : 'not paced — timezone changed today';

  return (
    <View className="mt-4">
      <Divider />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`By the hour: ${fmtInt(intake.total.kcal)} of ${fmtInt(goals.kcal)} kcal, ${folded}. ${open ? 'Hide' : 'Show'} the chart.`}
        onPress={() => setOpen((v) => !v)}
        testID={open ? 'intake-pace-open' : 'intake-pace-folded'}
        className="min-h-[44px] flex-row items-center gap-2 active:opacity-60">
        <Text className="flex-1 font-label text-[11px] uppercase tracking-[1.2px] text-ink-secondary">
          By the hour
        </Text>
        <Text className="font-mono text-[12px] text-ink">{folded}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={palette.inkMuted} />
      </Pressable>
      {open ? (
        <IntakeCharts
          {...props}
          intake={intake}
          nowMinute={nowMinute}
          clock={clock}
          pace={pace}
          waitsUntil={waitsUntil}
        />
      ) : null}
    </View>
  );
}

function IntakeCharts({
  curves,
  goals,
  levels,
  dayStartsAt,
  timezoneChanged,
  intake,
  nowMinute,
  clock,
  pace,
  waitsUntil,
}: IntakeByHourProps & {
  intake: TodayIntake;
  nowMinute: number;
  clock: string;
  pace: PaceReading | null;
  /** The default curve's first anchor, while now is still before it. */
  waitsUntil: string | null;
}) {
  const [start, end] = chartWindow(curves.kcal, intake.steps, nowMinute);
  const ticks = hourTicks(start, end, dayStartsAt);
  const kcalGoal = goals.kcal;
  const kcalTop = Math.max(kcalGoal * (1 + DAY_BAND), intake.total.kcal) * 1.08;
  const proteinGoal = goals.protein_g;
  const showExpected = !timezoneChanged;
  const kcalSpoken =
    `Calories by hour: ${fmtInt(intake.total.kcal)} eaten by ${clock}` +
    (pace ? `, about ${fmtInt(pace.expectedNow)} expected by now` : '') +
    `. Goal ${fmtInt(kcalGoal)}, on target between ${fmtInt(kcalGoal * (1 - DAY_BAND))} and ${fmtInt(kcalGoal * (1 + DAY_BAND))}.`;

  return (
    <View className="pb-1">
      <ChartFrame
        height={KCAL_HEIGHT}
        xDomain={[start, end]}
        yDomain={[0, kcalTop]}
        yTicks={[{ at: kcalGoal, label: fmtInt(kcalGoal) }]}
        xTicks={proteinGoal === null ? ticks : undefined}
        surface="paper"
        accessibilityLabel={kcalSpoken}
        testID="intake-chart-kcal">
        {(scale) => (
          <>
            <ChartBand
              scale={scale}
              y0={kcalGoal * (1 - DAY_BAND)}
              y1={kcalGoal * (1 + DAY_BAND)}
            />
            <ChartRule scale={scale} y={kcalGoal} tone="goal" />
            {showExpected ? (
              <ChartLine
                variant="expected"
                d={linePath(
                  expectedCurvePoints(curves.kcal, kcalGoal, start, end),
                  scale.x,
                  scale.y
                )}
              />
            ) : null}
            <ChartRule scale={scale} x={nowMinute} tone="now" />
            <ChartLine
              d={stepPath(runningPoints(intake, 'kcal', start, nowMinute), scale.x, scale.y)}
            />
            <ChartDot
              scale={scale}
              x={Math.max(nowMinute, start)}
              y={intake.total.kcal}
              tone={levels.kcal}
            />
          </>
        )}
      </ChartFrame>

      <Text className="mt-2 font-mono text-[11px] leading-4 text-ink-secondary">
        {landingLine(intake.total.kcal, kcalGoal)}
      </Text>
      {pace ? (
        <Text className="mt-0.5 font-mono text-[11px] leading-4 text-ink-secondary">
          {paceLine(pace, clock, curves.kcal.source)}
        </Text>
      ) : waitsUntil !== null ? (
        <Text className="mt-0.5 font-mono text-[11px] leading-4 text-ink-secondary">
          {`Nothing is expected before ${waitsUntil} on the default day — no pace until then`}
        </Text>
      ) : null}

      {proteinGoal !== null ? (
        <View className="mt-4">
          <View className="flex-row items-baseline gap-2">
            <Text className="flex-1 font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
              Protein
            </Text>
            <Text className="font-mono text-[11px] text-ink-secondary">
              {intake.total.protein_g >= proteinGoal
                ? `${fmtInt(intake.total.protein_g)} of ${fmtInt(proteinGoal)} g · met`
                : `${fmtInt(proteinGoal - intake.total.protein_g)} g left` +
                  (showExpected
                    ? ` · ~${fmtInt(proteinGoal * expectedShareAt(curves.protein_g, nowMinute))} expected by now`
                    : '')}
            </Text>
          </View>
          <View className="mt-1">
            <ChartFrame
              height={PROTEIN_HEIGHT}
              xDomain={[start, end]}
              yDomain={[0, Math.max(proteinGoal, intake.total.protein_g) * 1.1]}
              yTicks={[{ at: proteinGoal, label: `${fmtInt(proteinGoal)} g` }]}
              xTicks={ticks}
              surface="paper"
              accessibilityLabel={`Protein by hour: ${fmtInt(intake.total.protein_g)} of ${fmtInt(proteinGoal)} grams by ${clock}.`}
              testID="intake-chart-protein">
              {(scale) => (
                <>
                  <ChartRule scale={scale} y={proteinGoal} tone="goal" />
                  {showExpected ? (
                    <ChartLine
                      variant="expected"
                      d={linePath(
                        expectedCurvePoints(curves.protein_g, proteinGoal, start, end),
                        scale.x,
                        scale.y
                      )}
                    />
                  ) : null}
                  <ChartRule scale={scale} x={nowMinute} tone="now" />
                  <ChartLine
                    d={stepPath(
                      runningPoints(intake, 'protein_g', start, nowMinute),
                      scale.x,
                      scale.y
                    )}
                  />
                  <ChartDot
                    scale={scale}
                    x={Math.max(nowMinute, start)}
                    y={intake.total.protein_g}
                    tone={levels.protein_g}
                  />
                </>
              )}
            </ChartFrame>
          </View>
        </View>
      ) : null}

      <ChartLegend
        items={[
          { key: 'measured', label: 'Eaten' },
          ...(showExpected
            ? [
                {
                  key: 'expected' as const,
                  label: curves.kcal.source === 'learned' ? 'Usual pace' : 'Default pace',
                },
              ]
            : []),
          { key: 'band', label: `±${Math.round(DAY_BAND * 100)}% of goal` },
        ]}
      />
      <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
        {timezoneChanged
          ? 'Timezone changed today, so the hours do not line up with a usual day — no pace is drawn.'
          : sourceNote(curves.kcal)}{' '}
        The goal stays fixed for the day; what is left and the pace move as you eat.
        {intake.untimed.count > 0
          ? ` ${intake.untimed.count} meal${intake.untimed.count === 1 ? '' : 's'} with no time ${intake.untimed.count === 1 ? 'is' : 'are'} drawn at now.`
          : ''}
      </Text>
    </View>
  );
}
