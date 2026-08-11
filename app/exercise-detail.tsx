import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

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
import type { CatalogExercise, E1rmPoint, PersonalRecords } from '@/lib/exercise/types';
import type { SessionTopSet } from '@/lib/exercise/progression';
import { useUnitPreferences } from '@/hooks/use-unit-preferences';

/**
 * Exercise detail — history, estimated-1RM trend, and personal records for one
 * movement (docs/exercise-subapp.md §2). Read-only.
 *
 * **Entry point:** the records button on each catalog row in
 * src/components/exercise/exercise-picker.tsx — reachable from the routine
 * builder and the live logger, which are the two places that open the picker.
 * That button is this screen's only door, so it is load-bearing: removing it
 * strands this file and the `e1rmSeries` / `personalRecords` queries behind it.
 *
 * ## The surface system (00-design-spec.md §1)
 *
 *   Records          grid   three measured cells, ruled between — no outer box
 *   Estimated 1RM    field  a readout about the lift; unmarked, set apart by air
 *   History          plate  a record of sessions, ruled — in both states
 *
 * **No accent anywhere on this screen.** Nothing here is an action, and the
 * budget is a ceiling, not a quota. Every measured value is mono — "serif
 * speaks, mono measures" — and every absent record is an em-dash rather than a
 * plausible-looking estimate.
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

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={exercise.name} />
      </View>
      {/* Muscles and equipment are names, not measurements — label voice, not mono. */}
      <Text className="mt-1 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {meta}
      </Text>

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
