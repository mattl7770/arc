import { View } from 'react-native';

import { CoachBrief } from '@/components/home/coach-brief';
import { DateEyebrow } from '@/components/home/date-eyebrow';
import { HeroCard } from '@/components/home/hero-card';
import { MetricsStrip } from '@/components/home/metrics-strip';
import { Mission } from '@/components/home/mission';
import { MissionEmpty } from '@/components/home/mission-empty';
import { ModeBanner, ModeControl } from '@/components/home/mode-control';
import { ReadinessStrip } from '@/components/home/readiness-strip';
import { Screen } from '@/components/ui/screen';
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
 *   mode-banner     field   what today's mode is — unmarked, only when set
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
 * ## The day's mode (2026-08-09)
 *
 * When a mode is set, a banner sits between the folio line and the hero stating
 * what today IS ("Recover: sleep, fluids, rest. No training today.") and, under
 * a mode that excuses skips, how the day is being judged. Under Normal it
 * renders nothing at all, so the default Home is byte-for-byte the screen
 * above.
 *
 * It exists because the mode was previously invisible: `heroFocus` reached only
 * the Coach's tool snapshot, and the injected mission items carried no
 * scheduled time, so they sorted to the BOTTOM of the day and the hero kept
 * leading with a protocol item. Setting Sick removed a workout and changed
 * nothing else you could see — which is exactly what the owner reported. The
 * fix is in two halves: the banner here says what the mode means, and
 * src/lib/modes/registry.ts times each mode's lead item at 07:00 so the mode
 * wins the hero slot on the clock, with no special-casing in HeroCard.
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
  const modeView = useMode();
  const planned = mission.total > 0;

  return (
    <Screen scroll>
      {/* The folio line: today on the left, the mode control on the right — a
          mode is a fact about today, so it belongs beside the date (§Modes).
          Still unruled; the row is alignment only, not a box. */}
      <View className="flex-row items-center justify-between pt-2">
        <DateEyebrow />
        <ModeControl mode={modeView.mode} onSelect={modeView.setMode} />
      </View>

      {/*
          What the mode DID, stated above the hero — see ModeBanner. It renders
          nothing under Normal, so the default day is unchanged and the section
          costs no vertical space. `skipped` is derived here rather than in the
          banner because `settled` (completed + skipped) and `completed` are
          both already computed by deriveMissionView; recomputing it downstream
          would be a second definition of the same number.
      */}
      {modeView.isActive ? (
        <View className="mt-4">
          <ModeBanner mode={modeView.mode} skipped={mission.settled - mission.completed} />
        </View>
      ) : null}

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
