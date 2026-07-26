import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';

import { MockupNote } from '@/components/ui/mockup-note';
import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';

/**
 * Exercise sub-app, pushed from the Log tab's Workout tile.
 *
 * DESIGN MOCKUP — real layout, mock content, nothing persists yet. Sketches the
 * direction: the week's training at a glance, starting or logging a session,
 * templates, and recent sessions. Full spec (workout builder, set/rep logging,
 * Zone 2 / VO2max / mobility, progressive overload) in
 * docs/information-architecture.md.
 */
type Stat = { label: string; value: string; unit: string };
const WEEK: Stat[] = [
  { label: 'Zone 2', value: '135', unit: 'min' },
  { label: 'Strength', value: '3', unit: 'of 4' },
  { label: 'VO₂max', value: '52', unit: 'est' },
];

type Template = { name: string; detail: string };
const TEMPLATES: Template[] = [
  { name: 'Upper A', detail: '6 lifts · push/pull · ~50 min' },
  { name: 'Lower B', detail: '5 lifts · squat focus · ~55 min' },
  { name: 'Zone 2', detail: 'Easy cardio · 45 min · nasal only' },
];

type Session = { day: string; name: string; detail: string };
const SESSIONS: Session[] = [
  { day: 'Yesterday', name: 'Upper A', detail: '18 sets · 52 min · +2.5 kg bench' },
  { day: 'Tue', name: 'Zone 2', detail: '45 min · avg HR 132 · 6.4 km' },
];

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

export default function ExerciseScreen() {
  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Exercise" />
      </View>

      {/* This week */}
      <View className="mt-2">
        <SectionLabel>This week</SectionLabel>
        <View className="mt-2 flex-row gap-4 rounded-card border border-hairline bg-porcelain p-4">
          {WEEK.map((s, index) => (
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
        <View className="mt-2 flex-row items-center gap-3 rounded-card bg-pine px-4 py-3.5">
          <Ionicons name="play-outline" size={20} color={palette.pineOn} />
          <View className="flex-1">
            <Text className="text-[15px] font-semibold text-pine-on">Start a workout</Text>
            <Text className="mt-0.5 text-xs text-pine-tint">Build live, or run a template</Text>
          </View>
        </View>
        <View className="mt-2 flex-row items-center gap-2 rounded-card border border-hairline bg-porcelain px-3.5 py-3">
          <Ionicons name="time-outline" size={17} color={palette.inkSecondary} />
          <Text className="text-[13px] text-ink">Log a past session</Text>
        </View>
      </View>

      {/* Templates */}
      <View className="mt-8">
        <SectionLabel>Templates</SectionLabel>
        <View className="mt-2 gap-2">
          {TEMPLATES.map((t) => (
            <View
              key={t.name}
              className="flex-row items-center justify-between rounded-card border border-hairline bg-porcelain px-4 py-3">
              <View className="flex-1">
                <Text className="font-serif text-base text-ink">{t.name}</Text>
                <Text className="mt-0.5 text-xs text-ink-muted">{t.detail}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={palette.inkMuted} />
            </View>
          ))}
        </View>
      </View>

      {/* Recent sessions */}
      <View className="mt-8">
        <SectionLabel>Recent sessions</SectionLabel>
        <View className="mt-1">
          {SESSIONS.map((s, index) => (
            <View
              key={s.day}
              className={`flex-row gap-3 py-3 ${index === 0 ? '' : 'border-t border-hairline-soft'}`}>
              <Text className="w-16 pt-0.5 text-[11px] uppercase tracking-[1px] text-ink-muted">
                {s.day}
              </Text>
              <View className="flex-1">
                <Text className="text-[15px] leading-5 text-ink">{s.name}</Text>
                <Text className="mt-0.5 text-xs leading-5 text-ink-muted">{s.detail}</Text>
              </View>
            </View>
          ))}
        </View>
      </View>

      <MockupNote>
        Design mockup — the workout builder, set/rep logging, and Zone 2 / VO₂max / mobility /
        progressive-overload tracking wire up next. Nothing here saves yet. Spec ·
        docs/information-architecture.md
      </MockupNote>
    </Screen>
  );
}
