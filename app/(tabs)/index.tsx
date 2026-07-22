import { View } from 'react-native';

import { CoachBrief } from '@/components/home/coach-brief';
import { DayHeader } from '@/components/home/day-header';
import { HeroCard } from '@/components/home/hero-card';
import { MetricsStrip } from '@/components/home/metrics-strip';
import { Mission } from '@/components/home/mission';
import { QuickActions } from '@/components/home/quick-actions';
import { Screen } from '@/components/ui/screen';
import { useMission } from '@/hooks/use-mission';
import { mockDay } from '@/lib/home/mock-day';

/**
 * Home — "What should I do right now, and what are the non-negotiables today?"
 *
 * The six sections below are the information architecture in
 * docs/home-screen.md, in order. Two things hold the design to its principles:
 *
 *   - The hero is *derived* from the mission, not authored separately, so
 *     "do this next" can never drift out of step with the checklist, and
 *     finishing something advances the screen on its own.
 *   - Only the hero uses the accent colour. Everything below it is neutral,
 *     which is what stops this becoming a dashboard.
 *
 * Still on mock data — see src/lib/home/mock-day.ts.
 */
export default function HomeScreen() {
  const mission = useMission(mockDay.mission);

  return (
    <Screen scroll>
      <View className="pt-2">
        <DayHeader readiness={mockDay.readiness} pillars={mockDay.pillars} />
      </View>

      <View className="mt-7">
        <HeroCard
          item={mission.next}
          onDone={(id) => mission.setStatus(id, 'completed')}
          onSnooze={mission.snooze}
          onSkip={(id) => mission.setStatus(id, 'skipped')}
        />
      </View>

      <View className="mt-9">
        <Mission
          sections={mission.sections}
          completed={mission.completed}
          total={mission.total}
          onToggle={mission.toggle}
        />
      </View>

      <View className="mt-9">
        <CoachBrief brief={mockDay.brief} />
      </View>

      <View className="mt-7 border-t border-ink-100 pt-2 dark:border-ink-800">
        <MetricsStrip metrics={mockDay.metrics} />
      </View>

      <View className="mt-4 border-t border-ink-100 pt-2 dark:border-ink-800">
        <QuickActions />
      </View>
    </Screen>
  );
}
