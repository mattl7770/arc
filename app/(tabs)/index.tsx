import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';

import { CoachBrief } from '@/components/home/coach-brief';
import { CoachNote } from '@/components/home/coach-note';
import { DateEyebrow } from '@/components/home/date-eyebrow';
import { HeroCard } from '@/components/home/hero-card';
import { MetricsStrip } from '@/components/home/metrics-strip';
import { Mission } from '@/components/home/mission';
import { MissionEmpty } from '@/components/home/mission-empty';
import { ReadinessStrip } from '@/components/home/readiness-strip';
import { StatusControl } from '@/components/status/status-control';
import { Screen } from '@/components/ui/screen';
import { palette } from '@/constants/theme';
import { useCoachPassMessage } from '@/hooks/use-coach-pass';
import { useDailyBrief } from '@/hooks/use-daily-brief';
import { useReadiness } from '@/hooks/use-readiness';
import { useStatuses } from '@/hooks/use-statuses';
import { useTimezoneNote } from '@/hooks/use-timezone-note';
import { useTodayMission } from '@/hooks/use-today-mission';
import type { RailChip } from '@/lib/status/chips';
import { endOpenStatus, toggleStatus } from '@/lib/status/store';

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
 * ## The day's status (2026-09-19, replacing the mode banner; revised 2026-09-23)
 *
 * The control beside the date is the status door
 * (src/components/status/status-control.tsx): `STATUS` on an ordinary day, and
 * the status itself — `SICK`, `TRAVELING` — while one is running. Nothing else
 * on Home mentions a status.
 *
 * From 2026-09-19 a mono line also sat between the folio row and the hero:
 * what was on, since when, and what it was doing to the numbers (the owner's
 * Q5(c): the line and a control, not one or the other). It went on 2026-09-23,
 * the owner on the device: *"the message is there, but i think it would be
 * better if the status button just changed to say 'Sick' or whatever the
 * currently active status is."* The door now carries the name, which is what
 * keeps a running status visible without opening anything; the age, the
 * excusal and the baseline count moved into the header of the sheet the door
 * opens.
 *
 * Neither ever printed a DIRECTIVE. The mode banner they replaced was a `field`
 * printing one a registry had written ("Recover: sleep, fluids, rest. No
 * training today.") — the hardcoded clinical layer migration 0061 exists to
 * remove. A status carries no directive, because what a sick day should contain
 * is the Coach's call on the day.
 *
 * Home never sends a turn — a tap in the sheet writes the row and carries the
 * canned prompt to the Coach tab, seeded. A status Home wrote that no prompt
 * followed would be the old Modes failure with a new name.
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
/**
 * The two ways out of the day: to the thing that BUILT it, and to the same
 * question asked of another day.
 *
 * Home's mission comes from the active protocols and from nothing else, and
 * until 2026-08-25 the only route to them was three taps inside the Data tab's
 * foldable "full file" section. `PROTOCOLS ›` is the affordance the owner asked
 * for when Protocols graduated to its own hub: a quiet line under the
 * checklist, in the label voice. `PLAN ›` joined it on 2026-09-19 and goes to
 * `app/mission-day.tsx` — the mission on a day ahead or behind.
 *
 * Deliberately NOT accents and not buttons. Home's accent budget is the hero's
 * primary action and the mission's completion stamps; a filled control under
 * the list would compete with the one thing the screen exists to make you do.
 * They are the same weight as the mission block's own fold control.
 *
 * **The row renders under an EMPTY day too**, which is why it sits outside the
 * `planned` branch below: an every-3-days stack has empty days by design, and
 * a day with nothing on it is precisely the day worth checking tomorrow on.
 */
function LabelLink({
  icon,
  label,
  hint,
  href,
}: {
  icon: 'git-branch-outline' | 'calendar-outline';
  label: string;
  /**
   * Optional, and Protocols has none: "what builds the day" was the line the
   * 2026-09-15 slop pass cut from this link's accessibilityLabel, back through
   * the hint slot (docs/ai-slop-candidates-2026-09.md §10).
   */
  hint?: string;
  href: '/protocols' | '/mission-day';
}) {
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={() => router.push(href)}
      className="min-h-[44px] flex-row items-center gap-2 px-1 active:opacity-60">
      <Ionicons name={icon} size={14} color={palette.inkMuted} />
      <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
        {label}
      </Text>
      <Ionicons name="chevron-forward" size={12} color={palette.inkMuted} />
    </Pressable>
  );
}

/** The two links, as one control row. */
function MissionLinks() {
  return (
    <View className="flex-row gap-4">
      <LabelLink icon="git-branch-outline" label="Protocols" href="/protocols" />
      <LabelLink
        icon="calendar-outline"
        label="Plan"
        hint="The mission on other days"
        href="/mission-day"
      />
    </View>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const mission = useTodayMission();
  const brief = useDailyBrief();
  const readiness = useReadiness();
  // What the user has SAID about today (0061). The control on the folio row
  // names it and opens the five chips in a sheet — the same control, and the
  // same sheet, the Coach screen opens (2026-09-21, when its own docked rail
  // went behind a door).
  const statuses = useStatuses();
  // Home never sends. Setting a status from here does exactly what the rail
  // does — writes the row FIRST — and then carries the canned prompt to the
  // Coach tab, seeded (app/protocols.tsx's seam). A status Home wrote that no
  // prompt followed would be the old Modes failure with a new name: a fact
  // recorded, and nothing asked to act on it.
  const carryToCoach = useCallback(
    (next: { prompt: string } | null) => {
      if (next) router.push({ pathname: '/(tabs)/coach', params: { prompt: next.prompt } });
    },
    [router]
  );
  const onStatusChip = useCallback(
    (chip: RailChip) => carryToCoach(toggleStatus(chip)),
    [carryToCoach]
  );
  const onStatusEnd = useCallback(
    (chip: RailChip & { openId: string }) => carryToCoach(endOpenStatus(chip)),
    [carryToCoach]
  );
  // D4: one line, on the day the device's timezone changed, and never again.
  const timezoneNote = useTimezoneNote();
  const planned = mission.total > 0;
  // The one thing here the user did not ask for: the Coach's own daily pass,
  // shown only when it judged the day worth a word (it usually says nothing).
  const pass = useCoachPassMessage();

  return (
    <Screen scroll>
      {/* The folio line: today on the left, the status control on the right — a
          status is a fact about today, so it belongs beside the date. Still
          unruled; the row is alignment only, not a box. */}
      <View className="flex-row items-center justify-between pt-2">
        <DateEyebrow />
        <StatusControl open={statuses.open} onToggle={onStatusChip} onEnd={onStatusEnd} />
      </View>

      {/*
          D4 — the device's timezone changed today, and the day is not 24 hours
          long. Directly under the folio line because that is where the day's
          own facts live (the date, the mode), and this is one of them.

          Unmarked, uncoloured, mono: a zone change is a fact about the
          CALENDAR, so it takes neither the accent (Home's budget is the hero,
          the completion stamps and the active tab) nor a `signal-*` — that
          palette marks biology, and the firewall is stated in exactly this
          context at src/components/status/status-rail.tsx. It appears on one day
          and then disappears; on every other day the hook returns null and this
          costs no vertical space at all.
      */}
      {timezoneNote ? (
        <Text className="mt-3 font-mono text-[11px] leading-4 text-ink-muted">{timezoneNote}</Text>
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
          <>
            <MissionEmpty hasActiveProtocols={mission.hasActiveProtocols} />
            {/* Under the empty state, because an empty day is a day worth
                planning FROM — an every-3-days stack has empty days by design,
                and those are exactly the days worth checking tomorrow on. The
                links used to live inside the `planned` branch, so the one day
                that most needed them was the one day that had neither. */}
            <View className="mt-2">
              <MissionLinks />
            </View>
          </>
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
            // The row's tap stays the toggle; its chevron is the door. Home
            // holds the router, so the row component stays free of navigation.
            onOpen={(id) => router.push({ pathname: '/mission-item', params: { id } })}
          />
          {/* Under the list, not above it: the day comes first, and the two
              doors out of it are where you go when the day is wrong or when the
              question is about another day. */}
          <View className="mt-2">
            <MissionLinks />
          </View>
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
