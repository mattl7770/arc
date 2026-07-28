import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { todayISODate } from '@/lib/db/date';
import { MUSCLE_LABEL } from '@/lib/exercise/constants';
import { dayLabel, sessionDetail } from '@/lib/exercise/format';
import { volumeAttention } from '@/lib/exercise/volume';
import type {
  MuscleFreshness,
  MuscleVolume,
  ProgramListItem,
  Recommendation,
  RoutineListItem,
} from '@/lib/exercise/types';
import { useTrainingHub } from '@/hooks/use-training';

/**
 * Exercise sub-app hub, pushed from the Log tab's Workout tile
 * (docs/exercise-subapp.md).
 *
 * "Train today" is the rule-based recommendation — an active program's
 * scheduled session when one is running, else the freshness pick (all offline).
 * It holds the one pine action on this screen (Start). Below it: the
 * muscle-freshness ledger, weekly volume vs landmarks, this week's totals,
 * programs, routines, and recent sessions.
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
  const { week, sessions, routines, programs, ledger, volume, recommendation } = useTrainingHub();
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
        params: {
          routineId: recommendation.routineId,
          name: recommendation.routineName,
          // A program deload week pre-fills fewer sets in the logger.
          ...(recommendation.program?.weekKind === 'deload' ? { deload: '1' } : {}),
        },
      });
    } else if (recommendation.kind === 'muscles') {
      router.push({
        pathname: '/workout-live',
        params: { exerciseIds: recommendation.exercises.map((e) => e.exerciseId).join(',') },
      });
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

      {/* Weekly volume vs landmarks */}
      <View className="mt-8">
        <SectionLabel>Weekly volume</SectionLabel>
        <WeeklyVolume volume={volume} />
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

      {/* Programs */}
      <View className="mt-8">
        <View className="flex-row items-baseline justify-between">
          <SectionLabel>Programs</SectionLabel>
          {programs.length > 0 ? (
            <Text className="font-mono text-[11px] text-ink-muted">{programs.length}</Text>
          ) : null}
        </View>
        {programs.length === 0 ? (
          <Text className="mt-2 text-xs leading-5 text-ink-muted">
            No programs yet. A program schedules your routines across a multi-week block with
            planned deload weeks; start one and Train today follows the plan.
          </Text>
        ) : (
          <View className="mt-2 gap-2">
            {programs.map((p) => (
              <ProgramCard
                key={p.id}
                program={p}
                onPress={() => router.push({ pathname: '/program-edit', params: { id: p.id } })}
              />
            ))}
          </View>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New program"
          onPress={() => router.push('/program-edit')}
          className="mt-2 h-11 flex-row items-center justify-center gap-2 rounded-btn border border-hairline-strong active:bg-paper-deep">
          <Ionicons name="add" size={17} color={palette.inkSecondary} />
          <Text className="text-[13px] font-medium text-ink">New program</Text>
        </Pressable>
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

  if (recommendation.kind === 'rest') {
    const eyebrow =
      recommendation.program &&
      `${recommendation.program.programName} · week ${recommendation.program.week} of ${recommendation.program.weeks}`;
    return (
      <View className="mt-2 rounded-card border border-hairline bg-porcelain p-4">
        {eyebrow ? (
          <Text className="text-[10.5px] uppercase tracking-[1px] text-ink-muted">{eyebrow}</Text>
        ) : null}
        <Text className="mt-1 font-serif text-[17px] font-semibold text-ink">Rest day</Text>
        <Text className="mt-1 text-[12.5px] leading-5 text-ink-secondary">
          {recommendation.why}
        </Text>
      </View>
    );
  }

  const title =
    recommendation.kind === 'routine'
      ? recommendation.routineName
      : recommendation.muscles.map((m) => MUSCLE_LABEL[m]).join(' · ') || 'Fresh muscles';
  const freshness = recommendation.kind === 'routine' ? recommendation.freshness : null;
  const program = recommendation.kind === 'routine' ? recommendation.program : undefined;
  const eyebrow = program
    ? program.weekKind === 'deload'
      ? `${program.programName} · deload week ${program.week} of ${program.weeks}`
      : `${program.programName} · week ${program.week} of ${program.weeks}`
    : null;

  return (
    <View className="mt-2 rounded-card border border-t-[3px] border-pine-tint border-t-pine bg-pine-soft p-4">
      {eyebrow ? (
        <Text className="text-[10.5px] uppercase tracking-[1px] text-ink-muted">{eyebrow}</Text>
      ) : null}
      <View className="mt-0.5 flex-row items-baseline justify-between">
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

function WeeklyVolume({ volume }: { volume: MuscleVolume[] }) {
  const total = volume.reduce((acc, v) => acc + v.sets, 0);
  const { under, over } = volumeAttention(volume);

  if (total === 0) {
    return (
      <View className="mt-2 rounded-card border border-hairline-soft bg-paper-deep px-3.5 py-3">
        <Text className="text-xs leading-5 text-ink-muted">
          No sets logged this week yet. Once you train, ARC tracks each muscle&rsquo;s weekly sets
          against its productive range (MEV–MRV).
        </Text>
      </View>
    );
  }

  return (
    <View className="mt-2 rounded-card border border-hairline bg-porcelain p-4">
      {under.length > 0 ? (
        <Text className="text-[13px] leading-5 text-ink">
          <Text className="text-ink-secondary">Add volume: </Text>
          <Text className="font-mono">{under.join(' · ')}</Text>
        </Text>
      ) : null}
      {over.length > 0 ? (
        <Text className={`text-[13px] leading-5 text-ink ${under.length > 0 ? 'mt-1.5' : ''}`}>
          <Text className="text-ink-secondary">Ease off: </Text>
          <Text className="font-mono">{over.join(' · ')}</Text>
        </Text>
      ) : null}
      {under.length === 0 && over.length === 0 ? (
        <Text className="text-[13px] leading-5 text-ink-secondary">
          On track — every trained muscle is inside its productive range this week.
        </Text>
      ) : null}
    </View>
  );
}

function ProgramCard({ program, onPress }: { program: ProgramListItem; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${program.name}. ${program.weeks} weeks, ${program.trainingDays} training days${
        program.active ? `, active, week ${program.currentWeek ?? ''}` : ''
      }. Edit.`}
      onPress={onPress}
      className="rounded-card border border-hairline bg-porcelain p-4 active:bg-paper-deep">
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 font-serif text-[16px] font-semibold text-ink">{program.name}</Text>
        {program.active ? (
          <View className="rounded-btn bg-paper-deep px-2 py-0.5">
            <Text className="font-mono text-[9.5px] uppercase tracking-[1px] text-ink-muted">
              {program.currentWeek != null ? `Week ${program.currentWeek}` : 'Active'}
            </Text>
          </View>
        ) : null}
        <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
      </View>
      <View className="mt-1 flex-row items-center justify-between">
        <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">
          {program.active ? 'Running' : 'Not started'}
        </Text>
        <Text className="font-mono text-[11px] text-ink-muted">
          {program.weeks} wk · {program.trainingDays} days
        </Text>
      </View>
    </Pressable>
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
