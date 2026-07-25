import { View } from 'react-native';

import { CoachBrief } from '@/components/home/coach-brief';
import { DateEyebrow } from '@/components/home/date-eyebrow';
import { HeroCard } from '@/components/home/hero-card';
import { MetricsStrip } from '@/components/home/metrics-strip';
import { Mission } from '@/components/home/mission';
import { QuickActions } from '@/components/home/quick-actions';
import { ReadinessStrip } from '@/components/home/readiness-strip';
import { Screen } from '@/components/ui/screen';
import { useMission } from '@/hooks/use-mission';
import { mockDay } from '@/lib/home/mock-day';

/**
 * Home — "What should I do right now, and what are the non-negotiables today?"
 *
 * Section order (revised 2026-07-24, owner call — supersedes the top-to-bottom
 * order in docs/home-screen.md): only the date sits above the hero, so the
 * first real thing on screen is the action. Readiness moved below the hero as
 * supporting evidence.
 *
 * Two things hold the design to its principles:
 *   - The hero is *derived* from the mission, not authored separately, so
 *     "do this next" can never drift out of step with the checklist, and
 *     finishing something advances the screen on its own.
 *   - Pine is reserved for the hero, primary actions, and completion stamps
 *     (checkmarks, the mission progress fill). Everything else is neutral ink,
 *     which is what stops this becoming a dashboard.
 *
 * Still on mock data — see src/lib/home/mock-day.ts.
 */
export default function HomeScreen() {
  const mission = useMission(mockDay.mission);

  return (
    <Screen scroll>
      <View className="pt-2">
        <DateEyebrow />
      </View>

      <View className="mt-4">
        <HeroCard
          item={mission.next}
          onDone={(id) => mission.setStatus(id, 'completed')}
          onSnooze={mission.snooze}
          onSkip={(id) => mission.setStatus(id, 'skipped')}
        />
      </View>

      <View className="mt-8">
        <ReadinessStrip readiness={mockDay.readiness} pillars={mockDay.pillars} />
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

      <View className="mt-7 border-t border-hairline pt-2">
        <MetricsStrip metrics={mockDay.metrics} />
      </View>

      <View className="mt-4 border-t border-hairline pt-2">
        <QuickActions />
      </View>
    </Screen>
  );
}
