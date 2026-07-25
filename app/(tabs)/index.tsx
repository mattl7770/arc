import { View } from 'react-native';

import { CoachBrief } from '@/components/home/coach-brief';
import { DateEyebrow } from '@/components/home/date-eyebrow';
import { HeroCard } from '@/components/home/hero-card';
import { MetricsStrip } from '@/components/home/metrics-strip';
import { Mission } from '@/components/home/mission';
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
 * supporting evidence. Section 6 (the quick actions dock) was cut entirely —
 * it duplicated the tab bar.
 *
 * Sections are separated by whitespace alone. Horizontal rules were tried and
 * removed (owner call, 2026-07-24): two of them around one short block reads
 * as a box, and boxes are what this design is trying not to be. Hairlines are
 * for card edges and rows inside a list, not for slicing up the page.
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

      <View className="mt-5">
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

      <View className="mt-8">
        <MetricsStrip metrics={mockDay.metrics} />
      </View>
    </Screen>
  );
}
