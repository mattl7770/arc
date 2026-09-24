import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';

import { MuscleFigure, MuscleFigureLegend } from '@/components/exercise/muscle-figure';
import { Block, Divider, GridCell } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { Sparkline } from '@/components/ui/sparkline';
import { StackHeader } from '@/components/ui/stack-header';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { getExercise, setExerciseLoadBasis } from '@/lib/db/repositories/exercise-catalog';
import {
  exerciseSessionTopsFrom,
  personalRecordsFrom,
  workingSets,
  type SetRow,
} from '@/lib/db/repositories/training-stats';
import { MUSCLE_LABEL } from '@/lib/exercise/constants';
import {
  dayLabel,
  formatClock,
  formatDistance,
  formatPace,
  formatWeight,
  measuredSetLine,
  weightSpec,
} from '@/lib/exercise/format';
import { resolveExerciseImage } from '@/lib/exercise/images.generated';
import {
  LOAD_BASES,
  LOAD_BASIS_INLINE,
  LOAD_BASIS_LABEL,
  LOAD_BASIS_MEANING,
  loadRecordsApply,
  type LoadBasis,
} from '@/lib/exercise/load-basis';
import { isLoadedRepsMeasures, measuresLabel } from '@/lib/exercise/measures';
import {
  formatTrendValue,
  recordSessionIds,
  repMaxesFrom,
  sessionSeriesFrom,
  TREND_METRIC_LABEL,
  trendMetricsFor,
  trendOf,
  trendPhrase,
  type RepMax,
  type TrendMetric,
} from '@/lib/exercise/records';
import type { CatalogExercise, PersonalRecords } from '@/lib/exercise/types';
import type { SessionTopSet } from '@/lib/exercise/progression';
import { useUnitPreferences } from '@/hooks/use-unit-preferences';
import type { UnitPreferences } from '@/lib/user/types';

/**
 * Exercise detail — how the movement looks, what it works, what its weight
 * figure counts, its records, how it is trending, its best at each rep count,
 * and its history (docs/exercise-subapp.md §14).
 *
 * **Entry points:** the Train hub's Exercises list (every movement trained,
 * most recent first — 2026-09-23), the records button on each catalog row in
 * src/components/exercise/exercise-picker.tsx, and the exercise title on each
 * block of the live logger (app/workout-live.tsx), so a mid-session "how does
 * this one go again?" is one tap.
 *
 * ## The surface system (00-design-spec.md §1)
 *
 *   Photo + muscles        field  a reference about the movement; unmarked
 *   Weight                 —      a statement and its control; no device
 *   Records                grid   measured cells, ruled between — no outer box
 *   Trend                  field  a readout about the lift; unmarked
 *   Best at each rep count plate  a record, ruled — in both states
 *   History                plate  a record of sessions, ruled — in both states
 *
 * **No accent anywhere on this screen.** The two controls on it — the weight
 * basis and the trend's metric — are selections, drawn in the protocol
 * editor's chip vocabulary (hairline off, ink border on the recessed fill).
 * Every measured value is mono; every absent record is an em-dash rather than a
 * plausible-looking estimate; and every figure is computed in
 * src/lib/exercise/records.ts — this file only draws.
 *
 * **Figures are in the logged basis.** A per-hand movement's records, trend and
 * history are per hand, and each section says so once in its note rather than
 * on every number (src/lib/exercise/load-basis.ts has the doubling decision).
 *
 * The demonstration photo is bundled (assets/exercises, public-domain
 * free-exercise-db frames — src/lib/exercise/images.generated.ts), so it works
 * offline like everything else. Custom exercises have no photo and show the
 * muscles schematic alone.
 */

/** Sessions the history list shows, newest first. */
const HISTORY_LIMIT = 20;

type Detail = {
  exercise: CatalogExercise | undefined;
  /** Every working set, newest workout first — one scan feeds every section. */
  rows: SetRow[];
  prs: PersonalRecords;
  repMaxes: RepMax[];
  sessions: SessionTopSet[];
  /** Workout ids of the sessions that set a record at the time. */
  recordSessions: Set<string>;
  sessionCount: number;
};

const EMPTY_PRS: PersonalRecords = {
  maxWeightKg: null,
  bestE1rmKg: null,
  bestSetVolumeKg: null,
  bestSessionVolumeKg: null,
  bestReps: null,
  bestSessionReps: null,
  bestDurationSec: null,
  bestDistanceM: null,
  bestPaceSecPerKm: null,
};

function read(id: string | undefined): Detail {
  const empty: Detail = {
    exercise: undefined,
    rows: [],
    prs: EMPTY_PRS,
    repMaxes: [],
    sessions: [],
    recordSessions: new Set(),
    sessionCount: 0,
  };
  if (!id) return empty;
  const db = getDb();
  const exercise = getExercise(db, id);
  // One scan of workout_sets feeds every stat, instead of a re-query each.
  const rows = workingSets(db, id);
  return {
    exercise,
    rows,
    prs: personalRecordsFrom(rows),
    repMaxes: repMaxesFrom(rows),
    // newest-first for the history list
    sessions: exerciseSessionTopsFrom(rows, HISTORY_LIMIT).slice().reverse(),
    recordSessions: exercise
      ? recordSessionIds(rows, { measures: exercise.measures, basis: exercise.loadBasis })
      : new Set(),
    sessionCount: new Set(rows.map((r) => r.workout_id)).size,
  };
}

type RecordCell = { label: string; value: string | null };

/**
 * The records this movement actually has, from what it MEASURES — not from
 * which happen to be non-null. That distinction is the whole point: a movement
 * with no history yet must still show the right em-dashes, or the screen
 * teaches the wrong thing about it before the first set is logged.
 *
 *   reps + load      Best e1RM · Top set · Set volume
 *                    Session volume · Most reps · Sessions      (2026-09-23)
 *   reps, no load    Most reps · Session reps · Sessions        (and assisted)
 *   time + distance  Longest · Farthest · Best pace
 *   time only        Longest · Top set · Set volume
 *
 * A push-up's grid was three em-dashes for ever until 2026-09-23, because
 * `reps` alone fell to the generic branch — its records are reps, and now it
 * says so. An ASSISTED movement shows the rep records only: a higher assistance
 * figure is an easier set, so "Top set" would crown the easiest one.
 */
function recordsFor(
  exercise: CatalogExercise,
  prs: PersonalRecords,
  sessionCount: number,
  units: UnitPreferences
): RecordCell[] {
  const w = (kg: number | null) => (kg == null ? null : formatWeight(kg, units));
  const n = (v: number | null) => (v == null ? null : String(Math.round(v)));
  const e1rm = { label: 'Best e1RM', value: w(prs.bestE1rmKg) };
  const topSet = { label: 'Top set', value: w(prs.maxWeightKg) };
  const setVolume = { label: 'Set volume', value: w(prs.bestSetVolumeKg) };
  const sessionVolume = { label: 'Session volume', value: w(prs.bestSessionVolumeKg) };
  const mostReps = { label: 'Most reps', value: n(prs.bestReps) };
  const sessionReps = { label: 'Session reps', value: n(prs.bestSessionReps) };
  const sessions = { label: 'Sessions', value: sessionCount > 0 ? String(sessionCount) : null };
  const longest = {
    label: 'Longest',
    value: prs.bestDurationSec == null ? null : formatClock(prs.bestDurationSec),
  };
  const farthest = {
    label: 'Farthest',
    value: prs.bestDistanceM == null ? null : formatDistance(prs.bestDistanceM, units),
  };
  const pace = {
    label: 'Best pace',
    value: prs.bestPaceSecPerKm == null ? null : formatPace(prs.bestPaceSecPerKm, units),
  };
  const { measures } = exercise;
  if (isLoadedRepsMeasures(measures)) {
    return loadRecordsApply(exercise.loadBasis)
      ? [e1rm, topSet, setVolume, sessionVolume, mostReps, sessions]
      : [mostReps, sessionReps, sessions];
  }
  switch (measures) {
    case 'reps':
      return [mostReps, sessionReps, sessions];
    case 'time,distance':
      return [longest, farthest, pace];
    case 'time':
      return [longest, topSet, setVolume];
    case 'load,time':
      return [longest, topSet, setVolume];
    case 'load,distance':
      return [farthest, topSet, setVolume];
    case 'distance':
      return [farthest, longest, pace];
    default:
      return [longest, farthest, topSet];
  }
}

/** A trend metric is a weight when its figures are in the logged load basis. */
const WEIGHT_METRICS: ReadonlySet<TrendMetric> = new Set(['e1rm', 'top_weight', 'volume']);

export default function ExerciseDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const [detail, setDetail] = useState<Detail>(() => read(id));
  const reload = useCallback(() => setDetail(read(id)), [id]);
  useFocusEffect(reload);

  const { units } = useUnitPreferences();
  const today = todayISODate();
  const { exercise, rows, prs, repMaxes, sessions, recordSessions, sessionCount } = detail;

  const [choosingBasis, setChoosingBasis] = useState(false);
  const [metricChoice, setMetricChoice] = useState<TrendMetric | null>(null);

  const metrics = useMemo(
    () => (exercise ? trendMetricsFor(exercise.measures, exercise.loadBasis) : []),
    [exercise]
  );
  const metric: TrendMetric | null =
    metricChoice != null && metrics.includes(metricChoice) ? metricChoice : (metrics[0] ?? null);
  const series = useMemo(
    () => (metric == null ? [] : sessionSeriesFrom(rows, metric)),
    [rows, metric]
  );
  const trend = useMemo(() => trendOf(series), [series]);

  if (!exercise) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Exercise" />
        </View>
        <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
          This exercise no longer exists.
        </Text>
      </Screen>
    );
  }

  // The measure joins the meta line so the owner knows what he will be asked to
  // type BEFORE he picks the movement mid-session (0046) — "Machine · Time ·
  // Distance" is the difference between reaching for a rep count and reaching
  // for a clock.
  const meta = [
    exercise.primaryMuscles.map((m) => MUSCLE_LABEL[m]).join(', '),
    exercise.equipment.replace(/_/g, ' '),
    measuresLabel(exercise.measures),
  ]
    .filter(Boolean)
    .join(' · ');

  const basis = exercise.loadBasis;
  // "kg · per hand" — the one place each section says what its weights count.
  const basisNote =
    basis == null ? undefined : `${weightSpec(units).unit} · ${LOAD_BASIS_INLINE[basis]}`;
  const records = recordsFor(exercise, prs, sessionCount, units);
  const showRepMaxes = isLoadedRepsMeasures(exercise.measures) && loadRecordsApply(basis);
  const photo = resolveExerciseImage(exercise.id);

  /**
   * Correct the basis (0062). Saved on the tap, like the away-gym chip: there is
   * nothing to confirm, because nothing is lost — it relabels and never
   * rescales, and the same chooser puts it back.
   */
  const chooseBasis = (next: LoadBasis) => {
    try {
      setExerciseLoadBasis(getDb(), exercise.id, next);
    } catch (error) {
      console.warn('[exercise] load basis save failed', error);
      return;
    }
    setChoosingBasis(false);
    reload();
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={exercise.name} />
      </View>
      {/* Muscles and equipment are names, not measurements — label voice, not mono. */}
      <Text className="mt-1 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {meta}
      </Text>

      {/*
        What the weight figure counts (owner, 2026-09-23: "indicate whether
        weight is per arm, total, etc."). A statement about the movement and the
        control that corrects it, so no device — the away-gym chip's treatment.
        Only for a movement that records a load: a plank has no figure to
        describe. "Set by you" is provenance (0034): an asserted basis and a
        derived one must not wear the same face.
      */}
      {basis != null ? (
        <View className="mt-4">
          <View className="flex-row items-center gap-2">
            <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
              Weight
            </Text>
            <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
              {LOAD_BASIS_LABEL[basis]}
            </Text>
            {exercise.loadBasisSetByOwner ? (
              <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                Set by you
              </Text>
            ) : null}
            <View className="flex-1" />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                choosingBasis
                  ? 'Close the weight choices'
                  : `Weight is ${LOAD_BASIS_INLINE[basis]}. Change what the weight counts.`
              }
              onPress={() => setChoosingBasis((v) => !v)}
              className="min-h-[44px] justify-center px-1 active:opacity-60">
              <Text className="font-label text-[11px] font-semibold uppercase tracking-[1px] text-ink">
                {choosingBasis ? 'Close' : 'Change'}
              </Text>
            </Pressable>
          </View>
          <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
            {LOAD_BASIS_MEANING[basis]}
          </Text>
          {choosingBasis ? (
            <View className="mt-2">
              <View className="flex-row flex-wrap gap-2">
                {LOAD_BASES.map((b) => {
                  const selected = b === basis;
                  return (
                    <Pressable
                      key={b}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`${LOAD_BASIS_LABEL[b]}. ${LOAD_BASIS_MEANING[b]}`}
                      onPress={() => chooseBasis(b)}
                      className={`min-h-[36px] justify-center rounded-btn border px-3 active:bg-paper-dim ${
                        selected ? 'border-ink bg-paper-dim' : 'border-hairline bg-paper-hi'
                      }`}>
                      <Text
                        className={`font-label text-[11px] uppercase tracking-[1px] ${
                          selected ? 'font-semibold text-ink' : 'text-ink-secondary'
                        }`}>
                        {LOAD_BASIS_LABEL[b]}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
                Changing it relabels every set already logged. No number changes.
                {exercise.loadBasisDerived != null
                  ? ` ARC’s reading of this movement is ${LOAD_BASIS_INLINE[exercise.loadBasisDerived]}.`
                  : ''}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* How it looks + what it works — reference, so: measured field. The
          photo and the schematic answer different questions (form vs target),
          so they sit side by side rather than competing for one slot. */}
      <View className="mt-5">
        <Block device="field">
          <View className="flex-row items-center justify-evenly gap-3">
            {photo != null ? (
              <Image
                source={photo}
                resizeMode="contain"
                accessibilityLabel={`How ${exercise.name} is performed`}
                style={{ width: 136, height: 136 }}
              />
            ) : null}
            {/* The width budget, and MuscleFigure's OWN 8pt inner gap is part
                of it: 136 photo + 12 row gap + (72 + 8 + 72) pair = 300,
                inside the 311pt a 375pt iPhone SE leaves this device after the
                Screen's 20pt gutters and the field's 12pt padding. Nothing
                shrinks — `flexShrink` is 0 in React Native — so this is a hard
                edge. Alone, the figure takes the component's 118pt default.
                No freshness scale here: `muscles` mode draws no ramp, so the
                pair is the whole width.

                The photo gave up 12pt for it. At 72 the figure's bar count
                still lands near 3 bars on the smallest muscle, which is what
                keeps a deltoid a cap and a lat a wing rather than two boxes
                (src/lib/exercise/figure.ts). */}
            <MuscleFigure
              mode="muscles"
              primary={exercise.primaryMuscles}
              secondary={exercise.secondaryMuscles}
              figureWidth={photo != null ? 72 : undefined}
            />
          </View>
          <View className="mt-2">
            <MuscleFigureLegend mode="muscles" />
          </View>
        </Block>
      </View>

      {/* Personal records — a metric grid: no outer box, drawn by the rules
          between its cells. `GridCell` carries the width, the padding and both
          rules (src/components/ui/block.tsx); the reference form is
          src/components/home/metrics-strip.tsx. Six cells wrap into two ruled
          rows of three. */}
      <View className="mt-6">
        <Block device="grid">
          <SectionLabel label="Records" note={basisNote} />
          {/* `mt-2` keeps the first cell's top rule off the label above it. */}
          <View className="mt-2 flex-row flex-wrap">
            {records.map((r, index) => (
              <GridCell key={r.label} index={index} count={records.length} columns={3}>
                <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                  {r.label}
                </Text>
                {/* No data, no number: an absent record is an em-dash. */}
                <Text className="mt-1 font-mono text-[15px] text-ink">{r.value ?? '—'}</Text>
              </GridCell>
            ))}
          </View>
        </Block>
      </View>

      {/* Trend — a readout about the lift, so: measured field. One value per
          session (src/lib/exercise/records.ts), switchable between the metrics
          this movement has — Fitbod's e1RM, max weight, volume and reps
          charts, as one field. The direction line compares the latest HOME
          session with the three before it; away sessions are plotted hollow
          and never compared (0055). */}
      {metric != null ? (
        <View className="mt-7">
          <Block device="field">
            <SectionLabel label="Trend" note={WEIGHT_METRICS.has(metric) ? basisNote : undefined} />
            {metrics.length > 1 ? (
              <View className="mt-2 flex-row flex-wrap gap-2">
                {metrics.map((m) => {
                  const selected = m === metric;
                  return (
                    <Pressable
                      key={m}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Show ${TREND_METRIC_LABEL[m]} by session`}
                      onPress={() => setMetricChoice(m)}
                      className={`min-h-[32px] justify-center rounded-btn border px-2.5 active:bg-paper-dim ${
                        selected ? 'border-ink bg-paper-dim' : 'border-hairline'
                      }`}>
                      <Text
                        className={`font-label text-[10px] uppercase tracking-[1px] ${
                          selected ? 'font-semibold text-ink' : 'text-ink-secondary'
                        }`}>
                        {TREND_METRIC_LABEL[m]}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
            {series.length >= 2 ? (
              <>
                <View className="mt-3 flex-row items-center justify-between">
                  <View>
                    <Text className="font-mono text-2xl text-ink">
                      {formatTrendValue(metric, series[series.length - 1]!.value, units)}
                    </Text>
                    <Text className="mt-0.5 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                      Latest
                    </Text>
                  </View>
                  {/* Away sessions are PLOTTED and MARKED, never hidden (0055):
                      the session happened and the owner will look for it, but
                      its loads are not part of the baseline. Hollow, not
                      coloured — behaviour, not biology. */}
                  <Sparkline
                    data={series.map((p) => p.value)}
                    marked={series.map((p) => p.away === true)}
                    baseline="auto"
                    width={140}
                    height={36}
                  />
                </View>
                {trend ? (
                  <Text
                    accessibilityLabel={trendPhrase(trend, { spoken: true })}
                    className="mt-2 font-mono text-[11px] text-ink-secondary">
                    {trendPhrase(trend)}
                  </Text>
                ) : null}
                <Text className="mt-1 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                  {`${dayLabel(series[0]!.date, today)} – ${dayLabel(
                    series[series.length - 1]!.date,
                    today
                  )} · ${series.length} sessions`}
                </Text>
              </>
            ) : (
              <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                {metric === 'e1rm'
                  ? 'An estimated-1RM trend needs two weighted sessions.'
                  : 'A trend needs two sessions.'}
              </Text>
            )}
            {/* The key for the mark above — drawn only when there is something
                marked, so a chart with no away sessions carries no legend. */}
            {series.length >= 2 && series.some((p) => p.away) ? (
              <Text className="mt-2 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                Hollow · away gym — plotted, not counted toward records
              </Text>
            ) : null}
          </Block>
        </View>
      ) : null}

      {/* Best at each rep count — Fitbod's and Hevy's rep-max table. A record,
          so: ruled plate, in both states. Exact rep counts only: a movement
          done for eights has no "1RM" row, because nobody lifted that single;
          the e1RM above is where an estimated single lives. Home sessions only. */}
      {showRepMaxes ? (
        <View className="mt-7">
          <Block device="plate">
            <SectionLabel label="Best at each rep count" note={basisNote} />
            {repMaxes.length === 0 ? (
              <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                Nothing logged yet.
              </Text>
            ) : (
              <View className="mt-1">
                {repMaxes.map((m, i) => (
                  <View key={m.reps}>
                    <Divider first={i === 0} />
                    <View className="flex-row items-center gap-3 py-2.5">
                      <Text className="w-20 font-mono text-[14px] text-ink-secondary">
                        {`${m.reps} ${m.reps === 1 ? 'rep' : 'reps'}`}
                      </Text>
                      <Text className="flex-1 font-mono text-[14px] text-ink">
                        {formatWeight(m.weightKg, units)}
                      </Text>
                      <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                        {dayLabel(m.date, today)}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </Block>
        </View>
      ) : null}

      {/* History — a record of sessions, so: ruled plate, in both states. The
          empty branch keeps the plate: a record with nothing in it still stands
          where the record stands. (The sweep of 2026-08-10 made the plate
          conditional; reverted the same day at the owner's instruction.)

          A session that set a record AT THE TIME says PR — the live logger's
          own rule, `recordSessionIds`, so the mark here is the stamp the owner
          saw in the gym. */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel label="History" note={basisNote} />
          {sessions.length === 0 ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              Nothing logged yet.
            </Text>
          ) : (
            <View className="mt-1">
              {sessions.map((s, i) => {
                const isRecord = s.workoutId != null && recordSessions.has(s.workoutId);
                return (
                  <View key={s.workoutId ?? `${s.date}-${i}`}>
                    <Divider first={i === 0} />
                    <View className="flex-row items-center gap-3 py-2.5">
                      <Text className="w-16 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                        {dayLabel(s.date, today)}
                      </Text>
                      <Text className="flex-1 font-mono text-[14px] text-ink">
                        {measuredSetLine(
                          {
                            reps: s.reps,
                            weightKg: s.weightKg,
                            durationSec: s.durationSec ?? null,
                            distanceM: s.distanceM ?? null,
                          },
                          units
                        )}
                        {s.rpe != null ? `  @${s.rpe}` : ''}
                      </Text>
                      {isRecord ? (
                        <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
                          PR
                        </Text>
                      ) : null}
                      {/* A session logged elsewhere says so, in the label voice —
                          the same reason the chart marks its point (0055): these
                          numbers are real and are not comparable to the rest of
                          the column. */}
                      {s.away ? (
                        <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                          Away
                        </Text>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </Block>
      </View>
    </Screen>
  );
}
