import { View } from 'react-native';

import { CoachBrief } from '@/components/home/coach-brief';
import { CoachNote } from '@/components/home/coach-note';
import { DateEyebrow } from '@/components/home/date-eyebrow';
import { HeroCard } from '@/components/home/hero-card';
import { MetricsStrip } from '@/components/home/metrics-strip';
import { Mission } from '@/components/home/mission';
import { ModeControl } from '@/components/home/mode-control';
import { ReadinessStrip } from '@/components/home/readiness-strip';
import { Screen } from '@/components/ui/screen';
import { useCoachPassMessage } from '@/hooks/use-coach-pass';
import { useDailyBrief } from '@/hooks/use-daily-brief';
import { useMode } from '@/hooks/use-mode';
import { useReadiness } from '@/hooks/use-readiness';
import { useTodayMission } from '@/hooks/use-today-mission';

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
 * The mission now reads from and writes to the on-device SQLite database
 * (useTodayMission): completing an item persists across launches, and the day
 * is seeded from mock-day on first open. The Coach brief is real (useDailyBrief,
 * deterministic insights). Readiness, the pillar bar, and the metrics strip are
 * now real too — derived from wearable_data (useReadiness → src/lib/home/
 * readiness.ts, fed by the Apple Health pipeline). With no wearable data they
 * render an honest "no signal yet" state pointing at Settings › Apple Health,
 * never fake numbers.
 */
export default function HomeScreen() {
  const mission = useTodayMission();
  const brief = useDailyBrief();
  const readiness = useReadiness();
  const modeView = useMode();
  // The one thing here the user did not ask for: the Coach's own daily pass,
  // shown only when it judged the day worth a word (it usually says nothing).
  const pass = useCoachPassMessage();

  return (
    <Screen scroll>
      {/* The folio line: today on the left, the mode control on the right — a
          mode is a fact about today, so it belongs beside the date (§Modes).
          Still unruled; the row is alignment only, not a box. */}
      <View className="flex-row items-center justify-between pt-2">
        <DateEyebrow />
        <ModeControl mode={modeView.mode} onSelect={modeView.setMode} />
      </View>

      <View className="mt-5">
        <HeroCard
          item={mission.next}
          onDone={(id) => mission.setStatus(id, 'completed')}
          onSnooze={mission.snooze}
          onSkip={(id) => mission.setStatus(id, 'skipped')}
        />
      </View>

      {/* Above readiness, below the hero: what the Coach came to say outranks
          supporting evidence, but never the one action the day is built on. */}
      {pass.message ? (
        <View className="mt-6">
          <CoachNote message={pass.message} onDismiss={pass.dismiss} />
        </View>
      ) : null}

      <View className="mt-8">
        <ReadinessStrip readiness={readiness.readiness} pillars={readiness.pillars} />
      </View>

      <View className="mt-9">
        <Mission
          leadingSettled={mission.leadingSettled}
          rest={mission.rest}
          completed={mission.completed}
          total={mission.total}
          onToggle={mission.toggle}
        />
      </View>

      <View className="mt-9">
        <CoachBrief brief={brief} />
      </View>

      <View className="mt-8">
        <MetricsStrip metrics={readiness.metrics} />
      </View>
    </Screen>
  );
}
