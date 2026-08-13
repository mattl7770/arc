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
  e1rmSeries,
  exerciseSessionTops,
  personalRecords,
} from '@/lib/db/repositories/training-stats';
import { MUSCLE_LABEL } from '@/lib/exercise/constants';
import { dayLabel, formatWeight, setLineKg } from '@/lib/exercise/format';
import { resolveExerciseImage } from '@/lib/exercise/images.generated';
import type { CatalogExercise, E1rmPoint, PersonalRecords } from '@/lib/exercise/types';
import type { SessionTopSet } from '@/lib/exercise/progression';
import { useUnitPreferences } from '@/hooks/use-unit-preferences';

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

const EMPTY_PRS: PersonalRecords = { maxWeightKg: null, bestE1rmKg: null, bestSetVolumeKg: null };

function read(id: string | undefined): Detail {
  const db = getDb();
  if (!id) return { exercise: undefined, prs: EMPTY_PRS, series: [], sessions: [] };
  return {
    exercise: getExercise(db, id),
    prs: personalRecords(db, id),
    series: e1rmSeries(db, id),
    // newest-first for the history list
    sessions: exerciseSessionTops(db, id, 12).slice().reverse(),
  };
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

  const meta = [
    exercise.primaryMuscles.map((m) => MUSCLE_LABEL[m]).join(', '),
    exercise.equipment.replace(/_/g, ' '),
  ]
    .filter(Boolean)
    .join(' · ');

  const records = [
    {
      label: 'Best e1RM',
      value: prs.bestE1rmKg == null ? null : formatWeight(prs.bestE1rmKg, units),
    },
    {
      label: 'Top set',
      value: prs.maxWeightKg == null ? null : formatWeight(prs.maxWeightKg, units),
    },
    {
      label: 'Best volume',
      value: prs.bestSetVolumeKg == null ? null : formatWeight(prs.bestSetVolumeKg, units),
    },
  ];

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
            {/* The width budget, and MuscleFigure's OWN 10pt inner gap is part
                of it: 136 photo + 12 row gap + (72 + 10 + 72) pair = 302,
                inside the 311pt a 375pt iPhone SE leaves this device after the
                Screen's 20pt gutters and the field's 12pt padding. Nothing
                shrinks — `flexShrink` is 0 in React Native — so this is a hard
                edge. Alone, the figure takes the component's 118pt default.

                The photo gave up 12pt for it: at 62 the schematic's smallest
                cell was 7.4pt, too tight to hold a hollow ring open, and hollow
                versus solid is the whole thing that separates a primary mover
                from an assist (src/components/exercise/muscle-figure.tsx). */}
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

      {/* Estimated 1RM — a readout about the lift, so: measured field. */}
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
              <Sparkline data={series.map((p) => p.e1rm)} baseline="auto" width={120} height={36} />
            </View>
          ) : (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              Log a couple of weighted sessions and the estimated-1RM trend appears here.
            </Text>
          )}
        </Block>
      </View>

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
                      {setLineKg(s.reps, s.weightKg, units)}
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
