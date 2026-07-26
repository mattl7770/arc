import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useExercise } from '@/hooks/use-exercise';
import { todayISODate } from '@/lib/db/date';
import { dayLabel, sessionDetail } from '@/lib/exercise/format';

/**
 * Exercise sub-app, pushed from the Log tab's Workout tile.
 *
 * Wired (2026-07-25): "This week" and "Recent sessions" read the on-device DB
 * (workouts + workout_sets, via src/hooks/use-exercise.ts), and both Train
 * actions push the workout logger, which persists. VO₂max stays a placeholder
 * — there is no real source until wearables land. Templates are deferred to
 * the workout builder (docs/information-architecture.md has the full spec:
 * Zone 2 / VO2max / mobility metrics, progressive overload).
 */
function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

type Stat = { label: string; value: string; unit: string };

export default function ExerciseScreen() {
  const router = useRouter();
  const { week, sessions } = useExercise();
  const today = todayISODate();

  const stats: Stat[] = [
    { label: 'Zone 2', value: String(Math.round(week.zone2Min)), unit: 'min' },
    {
      label: 'Strength',
      value: String(week.strengthSessions),
      unit: week.strengthSessions === 1 ? 'session' : 'sessions',
    },
    // No wearable / test source yet — an honest em dash beats a fake 52.
    { label: 'VO₂max', value: '—', unit: 'est' },
  ];

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Exercise" />
      </View>

      {/* This week */}
      <View className="mt-2">
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

      {/* Start */}
      <View className="mt-8">
        <SectionLabel>Train</SectionLabel>
        {/* The one pine action on this screen. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start a workout"
          onPress={() => router.push('/workout-log?mode=live')}
          className="mt-2 flex-row items-center gap-3 rounded-card bg-pine px-4 py-3.5 active:opacity-70">
          <Ionicons name="play-outline" size={20} color={palette.pineOn} />
          <View className="flex-1">
            <Text className="text-[15px] font-semibold text-pine-on">Start a workout</Text>
            <Text className="mt-0.5 text-xs text-pine-tint">Log sets as you go</Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log a past session"
          onPress={() => router.push('/workout-log?mode=past')}
          className="mt-2 flex-row items-center gap-2 rounded-card border border-hairline bg-porcelain px-3.5 py-3 active:bg-paper-deep">
          <Ionicons name="time-outline" size={17} color={palette.inkSecondary} />
          <Text className="text-[13px] text-ink">Log a past session</Text>
        </Pressable>
      </View>

      {/* Templates — deferred to the workout builder; a quiet stub keeps the
          section's place without pretending saved templates exist. */}
      <View className="mt-8">
        <SectionLabel>Templates</SectionLabel>
        <View className="mt-2 rounded-card border border-hairline-soft bg-paper-deep px-3.5 py-3">
          <Text className="text-xs leading-5 text-ink-muted">
            Templates land with the workout builder — log sessions free-form for now.
          </Text>
        </View>
      </View>

      {/* Recent sessions */}
      <View className="mt-8">
        <SectionLabel>Recent sessions</SectionLabel>
        {sessions.length === 0 ? (
          <Text className="mt-2 text-xs leading-5 text-ink-muted">
            Nothing logged yet — start a workout or log a past session above.
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
