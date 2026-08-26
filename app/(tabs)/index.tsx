import { View } from 'react-native';

import { CoachBrief } from '@/components/home/coach-brief';
import { CoachNote } from '@/components/home/coach-note';
import { DateEyebrow } from '@/components/home/date-eyebrow';
import { HeroCard } from '@/components/home/hero-card';
import { MetricsStrip } from '@/components/home/metrics-strip';
import { Mission } from '@/components/home/mission';
import { MissionEmpty } from '@/components/home/mission-empty';
import { ReadinessStrip } from '@/components/home/readiness-strip';
import { Screen } from '@/components/ui/screen';
import { useCoachPassMessage } from '@/hooks/use-coach-pass';
import { useDailyBrief } from '@/hooks/use-daily-brief';
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
 * as a box, and boxes are what this design is trying not to be. Rules enclose
 * objects — a plate edge, the rows inside one list — never the page.
 *
 * ## The surface system
 *
 * Home is where the Conformed Set's devices earn their keep: five of the six
 * appear here (src/components/ui/block.tsx).
 *
 *   hero-card       stamp   the one next action, in the accent — drawn
 *   mission         plate   a record, ruled — drawn
 *   readiness-strip field   a verdict — unmarked
 *   coach-brief     margin  prose — unmarked
 *   metrics-strip   grid    metrics — unmarked
 *
 * **Three of those five stopped drawing anything on 2026-08-09** (owner call,
 * first look at the design on real hardware: "there are some weird boxes and
 * lines in some places, notably the metrics and coach brief"). The field's
 * corner ticks, the margin's left rule and the grid's between-cell hairlines
 * were all marks a viewer had to interpret before they helped — decoration
 * under 00-design-spec.md §5, however good the drafting metaphor behind them.
 *
 * What survives is enclosure that does work: the stamp around the one action
 * and the plate around the record. Everything else is what the top of this
 * comment already said the page does — sections separated by whitespace alone,
 * distinguished by the three type voices. The two boxes on Home now mean
 * something precisely because they are the only two.
 *
 * Each component still declares its own device, so nothing here nests one
 * inside another; the Views below are layout and spacing only.
 *
 * *(The mode chip and banner that sat on the folio line 2026-08-01 → 2026-08-25
 * are gone with the Modes feature — owner call; ADR in docs/decisions.md and
 * the frozen remnant's header, src/lib/modes/registry.ts.)*
 *
 * Two things hold the design to its principles:
 *   - The hero is *derived* from the mission, not authored separately, so
 *     "do this next" can never drift out of step with the checklist, and
 *     finishing something advances the screen on its own.
 *   - The accent budget on this screen is exactly three things: the hero,
 *     completion stamps, and the active tab. Everything else is neutral ink,
 *     which is what stops this becoming a dashboard. Signal colours are the
 *     mirror rule — they mark biology (the readiness verdict, the pillars) and
 *     never chrome, and the accent never marks biology.
 *
 * Everything on this screen is now real. The mission reads from and writes to
 * the on-device SQLite database (useTodayMission), generated from the user's own
 * active protocols — completing an item persists across launches. The Coach
 * brief is the deterministic insights engine (useDailyBrief). Readiness, the
 * pillar bar, and the metrics strip derive from wearable_data (useReadiness →
 * src/lib/home/readiness.ts, fed by the Apple Health pipeline); with no wearable
 * data they render an honest "no signal yet" state pointing at Settings › Apple
 * Health, never fake numbers.
 *
 * **Nothing is mocked and nothing is planted.** With no active protocols the day
 * is genuinely empty, and the hero + checklist are replaced by MissionEmpty,
 * which says so and offers the one action that changes it. Rendering the hero
 * there would be a lie (HeroCard reads a null item as "today is handled") and a
 * "0 of 0" progress bar would be noise. See src/lib/db/seed.ts for the demo
 * mission that used to be written into the user's database instead.
 */
export default function HomeScreen() {
  const mission = useTodayMission();
  const brief = useDailyBrief();
  const readiness = useReadiness();
  const planned = mission.total > 0;
  // The one thing here the user did not ask for: the Coach's own daily pass,
  // shown only when it judged the day worth a word (it usually says nothing).
  const pass = useCoachPassMessage();

  return (
    <Screen scroll>
      {/* The folio line. Still unruled — alignment only, not a box. */}
      <View className="pt-2">
        <DateEyebrow />
      </View>

      <View className="mt-5">
        {planned ? (
          <HeroCard
            item={mission.next}
            onDone={(id) => mission.setStatus(id, 'completed')}
            onSnooze={mission.snooze}
            onSkip={(id) => mission.setStatus(id, 'skipped')}
          />
        ) : (
          <MissionEmpty hasActiveProtocols={mission.hasActiveProtocols} />
        )}
      </View>

      {/* Above readiness, below the hero: what the Coach came to say outranks
          supporting evidence, but never the one action the day is built on. */}
      {pass.message ? (
        <View className="mt-6">
          <CoachNote message={pass.message} onDismiss={pass.dismiss} />
        </View>
      ) : null}

      <View className="mt-7">
        <ReadinessStrip readiness={readiness.readiness} pillars={readiness.pillars} />
      </View>

      {planned ? (
        <View className="mt-7">
          <Mission
            leadingSettled={mission.leadingSettled}
            rest={mission.rest}
            completed={mission.completed}
            total={mission.total}
            // The hero and the list must never imply different next actions, so
            // the list is told which row the hero is showing rather than
            // guessing at it. One definition of "next", passed down.
            activeId={mission.next?.id ?? null}
            onToggle={mission.toggle}
          />
        </View>
      ) : null}

      <View className="mt-7">
        <CoachBrief brief={brief} />
      </View>

      <View className="mt-7">
        <MetricsStrip metrics={readiness.metrics} />
      </View>
    </Screen>
  );
}
