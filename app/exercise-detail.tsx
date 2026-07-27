import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
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
 * movement (docs/exercise-subapp.md §2). Read-only; pushed from the picker or a
 * workout block. Every measured value is mono; the e1RM trend uses the shared
 * dependency-free Sparkline. No pine — nothing here is an action.
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

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
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
        <Text className="mt-2 text-[13px] leading-5 text-ink-muted">
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

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={exercise.name} />
      </View>
      <Text className="mt-1 font-mono text-[11px] uppercase tracking-[1px] text-ink-muted">
        {meta}
      </Text>

      {/* Personal records */}
      <View className="mt-6">
        <SectionLabel>Records</SectionLabel>
        <View className="mt-2 flex-row gap-4 rounded-card border border-hairline bg-porcelain p-4">
          <Stat
            label="Best e1RM"
            value={prs.bestE1rmKg == null ? null : formatWeight(prs.bestE1rmKg, units)}
          />
          <Stat
            label="Top set"
            value={prs.maxWeightKg == null ? null : formatWeight(prs.maxWeightKg, units)}
            bordered
          />
          <Stat
            label="Best volume"
            value={prs.bestSetVolumeKg == null ? null : formatWeight(prs.bestSetVolumeKg, units)}
            bordered
          />
        </View>
      </View>

      {/* e1RM trend */}
      <View className="mt-8">
        <SectionLabel>Estimated 1RM</SectionLabel>
        {series.length >= 2 ? (
          <View className="mt-2 flex-row items-center justify-between rounded-card border border-hairline bg-porcelain p-4">
            <View>
              <Text className="font-mono text-2xl text-ink">
                {formatWeight(series[series.length - 1]!.e1rm, units)}
              </Text>
              <Text className="mt-0.5 text-[11px] uppercase tracking-[1px] text-ink-muted">
                latest
              </Text>
            </View>
            <Sparkline data={series.map((p) => p.e1rm)} baseline="auto" width={120} height={36} />
          </View>
        ) : (
          <Text className="mt-2 text-[13px] leading-5 text-ink-muted">
            Log a couple of weighted sessions and the estimated-1RM trend appears here.
          </Text>
        )}
      </View>

      {/* History */}
      <View className="mt-8">
        <SectionLabel>History</SectionLabel>
        {sessions.length === 0 ? (
          <Text className="mt-2 text-[13px] leading-5 text-ink-muted">Nothing logged yet.</Text>
        ) : (
          <View className="mt-1">
            {sessions.map((s, i) => (
              <View
                key={`${s.date}-${i}`}
                className={`flex-row items-center gap-3 py-3 ${
                  i === 0 ? '' : 'border-t border-hairline-soft'
                }`}>
                <Text className="w-16 text-[11px] uppercase tracking-[1px] text-ink-muted">
                  {dayLabel(s.date, today)}
                </Text>
                <Text className="flex-1 font-mono text-[14px] text-ink">
                  {setLineKg(s.reps, s.weightKg, units)}
                  {s.rpe != null ? `  @${s.rpe}` : ''}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>
    </Screen>
  );
}

function Stat({
  label,
  value,
  bordered,
}: {
  label: string;
  value: string | null;
  bordered?: boolean;
}) {
  return (
    <View className={`flex-1 ${bordered ? 'border-l border-hairline-soft pl-4' : ''}`}>
      <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">{label}</Text>
      <Text className="mt-1 font-mono text-[15px] text-ink">{value ?? '—'}</Text>
    </View>
  );
}
