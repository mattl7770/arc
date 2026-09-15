import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Image, Text, View } from 'react-native';

import { MuscleFigure, MuscleFigureLegend } from '@/components/exercise/muscle-figure';
import { Block, Divider, GridCell } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { Sparkline } from '@/components/ui/sparkline';
import { StackHeader } from '@/components/ui/stack-header';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { getExercise } from '@/lib/db/repositories/exercise-catalog';
import {
  e1rmSeriesFrom,
  exerciseSessionTopsFrom,
  personalRecordsFrom,
  workingSets,
} from '@/lib/db/repositories/training-stats';
import { MUSCLE_LABEL } from '@/lib/exercise/constants';
import {
  dayLabel,
  formatClock,
  formatDistance,
  formatPace,
  formatWeight,
  measuredSetLine,
} from '@/lib/exercise/format';
import { resolveExerciseImage } from '@/lib/exercise/images.generated';
import { isLoadedRepsMeasures, measuresLabel, type Measures } from '@/lib/exercise/measures';
import type { CatalogExercise, E1rmPoint, PersonalRecords } from '@/lib/exercise/types';
import type { SessionTopSet } from '@/lib/exercise/progression';
import { useUnitPreferences } from '@/hooks/use-unit-preferences';
import type { UnitPreferences } from '@/lib/user/types';

/**
 * Exercise detail — how the movement looks, what it works, the estimated-1RM
 * trend, personal records, and history for one movement
 * (docs/exercise-subapp.md). Read-only.
 *
 * **Entry points:** the records button on each catalog row in
 * src/components/exercise/exercise-picker.tsx, and — since 2026-08-11 — the
 * exercise title on each block of the live logger (app/workout-live.tsx), so a
 * mid-session "how does this one go again?" is one tap.
 *
 * ## The surface system (00-design-spec.md §1)
 *
 *   Photo + muscles  field  a reference about the movement; unmarked
 *   Records          grid   three measured cells, ruled between — no outer box
 *   Estimated 1RM    field  a readout about the lift; unmarked, set apart by air
 *   History          plate  a record of sessions, ruled — in both states
 *
 * **No accent anywhere on this screen.** Nothing here is an action, and the
 * budget is a ceiling, not a quota. Every measured value is mono — "serif
 * speaks, mono measures" — and every absent record is an em-dash rather than a
 * plausible-looking estimate.
 *
 * The demonstration photo is bundled (assets/exercises, public-domain
 * free-exercise-db frames — src/lib/exercise/images.generated.ts), so it works
 * offline like everything else. Custom exercises have no photo and show the
 * muscles schematic alone.
 */

type Detail = {
  exercise: CatalogExercise | undefined;
  prs: PersonalRecords;
  series: E1rmPoint[];
  sessions: SessionTopSet[];
};

const EMPTY_PRS: PersonalRecords = {
  maxWeightKg: null,
  bestE1rmKg: null,
  bestSetVolumeKg: null,
  bestDurationSec: null,
  bestDistanceM: null,
  bestPaceSecPerKm: null,
};

function read(id: string | undefined): Detail {
  const db = getDb();
  if (!id) return { exercise: undefined, prs: EMPTY_PRS, series: [], sessions: [] };
  // One scan of workout_sets feeds all three stats, instead of a re-query each.
  const rows = workingSets(db, id);
  return {
    exercise: getExercise(db, id),
    prs: personalRecordsFrom(rows),
    series: e1rmSeriesFrom(rows),
    // newest-first for the history list
    sessions: exerciseSessionTopsFrom(rows, 12).slice().reverse(),
  };
}

/**
 * The three records this movement actually has (0046).
 *
 * A grid of exactly three cells is the surface (`GridCell … columns={3}`), so
 * the question is which three — and the answer comes from what the exercise
 * MEASURES, not from which of the six happen to be non-null. That distinction
 * is the whole point: an exercise with no history yet must still show the right
 * three em-dashes, or the screen teaches the wrong thing about the movement
 * before the first set is logged.
 *
 *   load + reps      Best e1RM · Top set · Best volume   (unchanged)
 *   time + distance  Longest · Farthest · Best pace
 *   time only        Longest · Top set · Best volume
 *
 * Three is a width budget, not a truth. A plank has exactly one record worth
 * the name, so the other two cells go to the load records — permanently
 * em-dashed on a bodyweight plank, and real on a weighted one, which is the
 * case they are there for.
 */
function recordsFor(
  measures: Measures,
  prs: PersonalRecords,
  units: UnitPreferences
): { label: string; value: string | null }[] {
  const e1rm = {
    label: 'Best e1RM',
    value: prs.bestE1rmKg == null ? null : formatWeight(prs.bestE1rmKg, units),
  };
  const topSet = {
    label: 'Top set',
    value: prs.maxWeightKg == null ? null : formatWeight(prs.maxWeightKg, units),
  };
  const volume = {
    label: 'Best volume',
    value: prs.bestSetVolumeKg == null ? null : formatWeight(prs.bestSetVolumeKg, units),
  };
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
  if (isLoadedRepsMeasures(measures)) return [e1rm, topSet, volume];
  switch (measures) {
    case 'time,distance':
      return [longest, farthest, pace];
    case 'time':
      return [longest, topSet, volume];
    case 'load,time':
      return [longest, topSet, volume];
    case 'load,distance':
      return [farthest, topSet, volume];
    case 'distance':
      return [farthest, longest, pace];
    default:
      // Every remaining subset carries reps or load without both, or an unusual
      // pairing. Show the two measured records it can fill plus the top set.
      return [longest, farthest, topSet];
  }
}

export default function ExerciseDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const [detail, setDetail] = useState<Detail>(() => read(id));
  const reload = useCallback(() => setDetail(read(id)), [id]);
  useFocusEffect(reload);

  const { units } = useUnitPreferences();
  const today = todayISODate();
  const { exercise, prs, series, sessions } = detail;

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

  const records = recordsFor(exercise.measures, prs, units);
  // e1RM is a claim about a maximum lift. A movement that records no load, or
  // no reps under it, can never produce one (0046), so the panel does not draw
  // an empty promise — the records grid above already says what this movement's
  // bests are.
  const showE1rm = isLoadedRepsMeasures(exercise.measures);

  const photo = resolveExerciseImage(exercise.id);

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={exercise.name} />
      </View>
      {/* Muscles and equipment are names, not measurements — label voice, not mono. */}
      <Text className="mt-1 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {meta}
      </Text>

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
          src/components/home/metrics-strip.tsx. */}
      <View className="mt-6">
        <Block device="grid">
          <SectionLabel label="Records" />
          {/* `mt-2` keeps the first cell's top rule off the label above it. */}
          <View className="mt-2 flex-row">
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

      {/* Estimated 1RM — a readout about the lift, so: measured field. Absent
          entirely for a movement that cannot produce one (0046): a plank's
          e1RM panel could only ever say "log a couple of weighted sessions"
          about sessions that will never be weighted. */}
      {showE1rm ? (
        <View className="mt-7">
          <Block device="field">
            <SectionLabel label="Estimated 1RM" />
            {series.length >= 2 ? (
              <View className="mt-2 flex-row items-center justify-between">
                <View>
                  <Text className="font-mono text-2xl text-ink">
                    {formatWeight(series[series.length - 1]!.e1rm, units)}
                  </Text>
                  <Text className="mt-0.5 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                    Latest
                  </Text>
                </View>
                <Sparkline
                  data={series.map((p) => p.e1rm)}
                  baseline="auto"
                  width={120}
                  height={36}
                />
              </View>
            ) : (
              <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                Log a couple of weighted sessions and the estimated-1RM trend appears here.
              </Text>
            )}
          </Block>
        </View>
      ) : null}

      {/* History — a record of sessions, so: ruled plate, in both states. The
          empty branch keeps the plate: a record with nothing in it still stands
          where the record stands. (The sweep of 2026-08-10 made the plate
          conditional; reverted the same day at the owner's instruction.) */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel label="History" />
          {sessions.length === 0 ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              Nothing logged yet.
            </Text>
          ) : (
            <View className="mt-1">
              {sessions.map((s, i) => (
                <View key={`${s.date}-${i}`}>
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
                  </View>
                </View>
              ))}
            </View>
          )}
        </Block>
      </View>
    </Screen>
  );
}
