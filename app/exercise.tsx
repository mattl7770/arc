import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { todayISODate } from '@/lib/db/date';
import { MUSCLE_LABEL } from '@/lib/exercise/constants';
import { dayLabel, sessionDetail } from '@/lib/exercise/format';
import type { MuscleFreshness, Recommendation, RoutineListItem } from '@/lib/exercise/types';
import { useTrainingHub } from '@/hooks/use-training';

/**
 * Exercise sub-app hub, pushed from the Log tab's Workout tile
 * (docs/exercise-subapp.md §2).
 *
 * "Train today" is the rule-based recommendation (freshness + progression, all
 * offline) and holds the one pine action on this screen — Start. Below it: the
 * muscle-freshness ledger (FitBod's recovery heatmap restated as a typeset
 * ledger; freshness is a biological state, so signal colours are sanctioned
 * here), this week's totals, your routines, and recent sessions. VO₂max stays a
 * placeholder until wearables land.
 */
function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

/** state → signal colour. Freshness is a biological state (sanctioned use). */
function freshnessColor(state: MuscleFreshness['state']): string {
  switch (state) {
    case 'fresh':
      return palette.signal.optimal;
    case 'recovering':
      return palette.signal.caution;
    default:
      return palette.signal.poor;
  }
}

export default function ExerciseScreen() {
  const router = useRouter();
  const { week, sessions, routines, ledger, recommendation } = useTrainingHub();
  const today = todayISODate();

  const stats = [
    { label: 'Zone 2', value: String(Math.round(week.zone2Min)), unit: 'min' },
    {
      label: 'Strength',
      value: String(week.strengthSessions),
      unit: week.strengthSessions === 1 ? 'session' : 'sessions',
    },
    // No wearable / test source yet — an honest em dash beats a fake number.
    { label: 'VO₂max', value: '—', unit: 'est' },
  ];

  const startRecommended = () => {
    if (recommendation.kind === 'routine') {
      router.push({
        pathname: '/workout-live',
        params: { routineId: recommendation.routineId, name: recommendation.routineName },
      });
    } else if (recommendation.kind === 'muscles') {
      // Prefill the suggested movements so Start opens a ready session, not a blank one.
      router.push({
        pathname: '/workout-live',
        params: { exerciseIds: recommendation.exercises.map((e) => e.exerciseId).join(',') },
      });
    } else {
      router.push('/workout-live');
    }
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Exercise" />
      </View>

      {/* Train today — the one pine action on this screen. */}
      <View className="mt-2">
        <SectionLabel>Train today</SectionLabel>
        <TrainTodayCard recommendation={recommendation} onStart={startRecommended} />
      </View>

      {/* Muscle freshness ledger */}
      <View className="mt-8">
        <SectionLabel>Muscle freshness</SectionLabel>
        <View className="mt-2 rounded-card border border-hairline bg-porcelain px-4 py-1">
          {ledger.map((m, i) => (
            <View
              key={m.muscle}
              className={`flex-row items-center gap-3 py-1.5 ${
                i === 0 ? '' : 'border-t border-hairline-soft'
              }`}>
              <Text className="w-24 text-[13px] text-ink">{MUSCLE_LABEL[m.muscle]}</Text>
              <View className="h-1.5 flex-1 overflow-hidden rounded-[1px] bg-paper-deep">
                <View
                  style={{ width: `${m.freshness}%`, backgroundColor: freshnessColor(m.state) }}
                  className="h-full rounded-[1px]"
                />
              </View>
              <Text className="w-9 text-right font-mono text-[12px] text-ink-secondary">
                {m.freshness}
              </Text>
            </View>
          ))}
        </View>
      </View>

      {/* This week */}
      <View className="mt-8">
        <SectionLabel>This week</SectionLabel>
        <View className="mt-2 flex-row gap-4 rounded-card border border-hairline bg-porcelain p-4">
          {stats.map((s, index) => (
            <View
              key={s.label}
              className={`flex-1 ${index === 0 ? '' : 'border-l border-hairline-soft pl-4'}`}>
              <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">{s.label}</Text>
              <View className="mt-1 flex-row items-baseline gap-1">
                <Text className="font-mono text-2xl text-ink">{s.value}</Text>
                <Text className="font-mono text-[11px] text-ink-muted">{s.unit}</Text>
              </View>
            </View>
          ))}
        </View>
      </View>

      {/* Routines */}
      <View className="mt-8">
        <View className="flex-row items-baseline justify-between">
          <SectionLabel>Routines</SectionLabel>
          {routines.length > 0 ? (
            <Text className="font-mono text-[11px] text-ink-muted">{routines.length}</Text>
          ) : null}
        </View>
        {routines.length === 0 ? (
          <Text className="mt-2 text-xs leading-5 text-ink-muted">
            No routines yet. Build one — an ordered exercise list with targets — and starting it
            pre-fills last session&rsquo;s numbers.
          </Text>
        ) : (
          <View className="mt-2 gap-2">
            {routines.map((r) => (
              <RoutineCard
                key={r.id}
                routine={r}
                today={today}
                onStart={() =>
                  router.push({
                    pathname: '/workout-live',
                    params: { routineId: r.id, name: r.name },
                  })
                }
                onEdit={() => router.push({ pathname: '/routine-edit', params: { id: r.id } })}
              />
            ))}
          </View>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New routine"
          onPress={() => router.push('/routine-edit')}
          className="mt-2 h-11 flex-row items-center justify-center gap-2 rounded-btn border border-hairline-strong active:bg-paper-deep">
          <Ionicons name="add" size={17} color={palette.inkSecondary} />
          <Text className="text-[13px] font-medium text-ink">New routine</Text>
        </Pressable>
      </View>

      {/* Quick log — free-form / cardio / past session (the older logger). */}
      <View className="mt-8">
        <SectionLabel>Quick log</SectionLabel>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log a session free-form"
          onPress={() => router.push({ pathname: '/workout-log', params: { mode: 'past' } })}
          className="mt-2 flex-row items-center gap-2 rounded-card border border-hairline bg-porcelain px-3.5 py-3 active:bg-paper-deep">
          <Ionicons name="time-outline" size={17} color={palette.inkSecondary} />
          <Text className="text-[13px] text-ink">Cardio, mobility, or a past session</Text>
        </Pressable>
      </View>

      {/* Recent sessions */}
      <View className="mt-8">
        <SectionLabel>Recent sessions</SectionLabel>
        {sessions.length === 0 ? (
          <Text className="mt-2 text-xs leading-5 text-ink-muted">
            Nothing logged yet — start a workout above.
          </Text>
        ) : (
          <View className="mt-1">
            {sessions.map((s, index) => (
              <View
                key={s.id}
                className={`flex-row gap-3 py-3 ${index === 0 ? '' : 'border-t border-hairline-soft'}`}>
                <Text className="w-16 pt-0.5 text-[11px] uppercase tracking-[1px] text-ink-muted">
                  {dayLabel(s.date, today)}
                </Text>
                <View className="flex-1">
                  <Text className="text-[15px] leading-5 text-ink">{s.name}</Text>
                  <Text className="mt-0.5 text-xs leading-5 text-ink-muted">
                    {sessionDetail(s)}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </View>
    </Screen>
  );
}

function TrainTodayCard({
  recommendation,
  onStart,
}: {
  recommendation: Recommendation;
  onStart: () => void;
}) {
  if (recommendation.kind === 'empty') {
    return (
      <View className="mt-2 rounded-card border border-hairline-soft bg-paper-deep px-3.5 py-3">
        <Text className="text-xs leading-5 text-ink-muted">{recommendation.why}</Text>
      </View>
    );
  }

  const title =
    recommendation.kind === 'routine'
      ? recommendation.routineName
      : recommendation.muscles.map((m) => MUSCLE_LABEL[m]).join(' · ') || 'Fresh muscles';
  const freshness = recommendation.kind === 'routine' ? recommendation.freshness : null;

  return (
    <View className="mt-2 rounded-card border border-t-[3px] border-pine-tint border-t-pine bg-pine-soft p-4">
      <View className="flex-row items-baseline justify-between">
        <Text className="font-serif text-[17px] font-semibold text-ink">{title}</Text>
        {freshness != null ? (
          <Text className="font-mono text-[12px] text-ink-secondary">{freshness}% fresh</Text>
        ) : null}
      </View>
      <Text className="mt-1 text-[12.5px] leading-5 text-ink-secondary">{recommendation.why}</Text>

      {recommendation.exercises.length > 0 ? (
        <Text className="mt-2 text-[12px] leading-5 text-ink-muted" numberOfLines={2}>
          {recommendation.exercises.map((e) => e.name).join(' · ')}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Start this workout"
        onPress={onStart}
        className="mt-3 h-11 flex-row items-center justify-center gap-2 rounded-btn bg-pine active:opacity-70">
        <Ionicons name="play" size={17} color={palette.pineOn} />
        <Text className="text-[15px] font-semibold text-pine-on">Start</Text>
      </Pressable>
    </View>
  );
}

function RoutineCard({
  routine,
  today,
  onStart,
  onEdit,
}: {
  routine: RoutineListItem;
  today: string;
  onStart: () => void;
  onEdit: () => void;
}) {
  const last =
    routine.lastStartedAt == null
      ? 'never run'
      : `last ${dayLabel(routine.lastStartedAt.slice(0, 10), today).toLowerCase()}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Start ${routine.name}. ${routine.exerciseCount} exercises, ${routine.totalSets} sets.`}
      onPress={onStart}
      className="rounded-card border border-hairline bg-porcelain p-4 active:bg-paper-deep">
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 font-serif text-[16px] font-semibold text-ink">{routine.name}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Edit ${routine.name}`}
          onPress={onEdit}
          hitSlop={8}
          className="h-8 w-8 items-center justify-center rounded-btn active:bg-paper-deep">
          <Ionicons name="create-outline" size={17} color={palette.inkMuted} />
        </Pressable>
      </View>
      <View className="mt-1 flex-row items-center justify-between">
        <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">{last}</Text>
        <Text className="font-mono text-[11px] text-ink-muted">
          {routine.exerciseCount} ex · {routine.totalSets} sets
        </Text>
      </View>
    </Pressable>
  );
}
