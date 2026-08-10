import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter, useSegments } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
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
 * Exercise sub-app hub (docs/exercise-subapp.md). It renders at two routes: as
 * the **Train tab** root (app/(tabs)/train.tsx re-exports this file) and as a
 * stack-pushed screen from the Log tab's Workout tile and Data's Training row.
 *
 * ## Two routes, two headers (owner call on hardware, 2026-08-09)
 *
 * This file used to open with `<StackHeader title="Exercise" />` at both, so the
 * Train tab drew a back chevron. It *worked* — the tab navigator runs
 * `backBehavior="history"` — but a tab root has nothing to go back to, and every
 * other tab owns a plain serif title instead (app/(tabs)/log.tsx, data.tsx). A
 * back control that returns you to a *different tab* is the wrong grammar for
 * the bottom bar.
 *
 * The two cases are told apart by `useSegments()`, not by `router.canGoBack()`:
 * with `backBehavior="history"` the tab root can very often go back, so that
 * test would keep the chevron exactly where it is wrong. Route shape is the
 * honest signal — `(tabs)` leads the segments only when this screen IS the tab.
 *
 * The title stays "Exercise" in both places. The tab bar says TRAIN because five
 * characters is the width budget (app/(tabs)/_layout.tsx); the screen has no
 * such constraint, and one name for one screen beats a label that changes with
 * the door you came through.
 *
 * "Train today" is the rule-based recommendation — an active program's
 * scheduled session when one is running, else the freshness pick (all offline).
 * Below it: the muscle-freshness ledger, weekly volume vs landmarks, this
 * week's totals, programs, routines, and recent sessions.
 *
 * ## The surface system (00-design-spec.md §1)
 *
 * The container encodes the content type, so this screen reads as a set of
 * drawing devices rather than a stack of identical cards:
 *
 *   Train today (a session)  stamp   the one next action, in the accent
 *   Train today (rest/empty) field   a verdict — unmarked, set apart by air
 *   Weekly volume            margin  advisory prose — unmarked, same reason
 *   Muscle freshness         plate   a record, ruled
 *   This week                grid    aligned columns, no outer box, no rules
 *   Programs / Routines      plate   records, ruled
 *   Quick log                plate   a row that navigates, like its neighbours
 *   Recent sessions          plate   a record, ruled
 *
 * Each block carries exactly one device and none of them nest; every other
 * `View` here is layout and spacing only. Sections are separated by whitespace,
 * never by a rule — rules enclose objects, not the page.
 *
 * **Accent budget: one.** The Train-today stamp and its Start button are this
 * screen's single primary action. Everything else is neutral ink. The mirror
 * rule holds too: muscle freshness is a *biological* state, so it is the one
 * thing here allowed to carry a signal colour, and the accent never touches it.
 */

/**
 * state → signal colour for the freshness BAR FILL. Freshness is a biological
 * state, so a signal colour is the sanctioned mark here — the firewall is about
 * *which cut*, not whether.
 *
 * **Returns the INK cut even though its output is a fill**, which is the one
 * place that inverts the usual reading of the two cuts. The swatch cut is sized
 * for the 3:1 graphical-object floor on the pale surfaces (paper, paper-hi);
 * this fill sits on a `bg-paper-deep` track, and against that mid-tone stock the
 * swatches measure optimal 2.36 · recovering 2.10 · fatigued 3.35 — two of three
 * under the floor, with `recovering` all but dissolving into its own track.
 * Moving the track to paper-dim does not rescue them (2.89 / 2.58 / 4.11). The
 * ink cuts clear it on the track as drawn: **4.56 / 4.17 / 4.31**, so the fix is
 * the cut, not the track.
 *
 * Nothing about that softens the text rule in the other direction: any
 * imperative TEXT colour for a biological state takes `palette.signalInk`, never
 * `palette.signal` (00-design-spec.md §2). The ink cut is the floor for words
 * and the safe choice for fills; the swatch is neither.
 *
 * Colour is not the sole carrier here regardless — the fill's WIDTH and the mono
 * percentage beside it both state the same number — so this was a legibility
 * debt rather than a correctness failure. It is still paid.
 */
function freshnessColor(state: MuscleFreshness['state']): string {
  switch (state) {
    case 'fresh':
      return palette.signalInk.optimal;
    case 'recovering':
      return palette.signalInk.caution;
    default:
      return palette.signalInk.poor;
  }
}

/**
 * The "This week" grid: three columns, **no rules**. Only the gutters that keep
 * one column's text off the next, and the `pt-4` row rhythm that replaced the
 * top rule — the treatment src/components/home/metrics-strip.tsx carries, and
 * the one this device is defined as (src/components/ui/block.tsx: a grid draws
 * no rules). Whole class strings, never a built prefix: Tailwind's scanner only
 * sees class names that appear literally in source.
 *
 * The old machinery made every cell ask "is there a cell after me?" so a
 * trailing cell could not draw a vertical rule into empty space. That question
 * was created entirely by the rules, so it died with them: `count` is gone, the
 * `*_LAST` classes are gone, and column position is the only input left.
 */
const WEEK_CELL_LEFT = 'w-1/3 pr-3 pt-4';
const WEEK_CELL_MID = 'w-1/3 px-3 pt-4';
const WEEK_CELL_RIGHT = 'w-1/3 pl-3 pt-4';

function weekCellClass(index: number): string {
  const column = index % 3;
  if (column === 0) return WEEK_CELL_LEFT;
  return column === 1 ? WEEK_CELL_MID : WEEK_CELL_RIGHT;
}

export default function ExerciseScreen() {
  const router = useRouter();
  // `(tabs)` leads the segments only when this file is rendering AS the Train
  // tab root; the pushed route is plain `/exercise`. See the header note above.
  const isTabRoot = useSegments()[0] === '(tabs)';
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
        {isTabRoot ? (
          <Text className="font-serif text-[26px] font-semibold text-ink">Exercise</Text>
        ) : (
          <StackHeader title="Exercise" />
        )}
      </View>

      {/* Train today — the one accent on this screen. */}
      <View className="mt-5">
        <TrainTodayCard recommendation={recommendation} onStart={startRecommended} />
      </View>

      {/* Weekly volume vs landmarks — advisory prose, so: margin annotation. */}
      <View className="mt-7">
        <WeeklyVolume volume={volume} />
      </View>

      {/* Muscle freshness ledger — a record, so: ruled plate. */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel label="Muscle freshness" />
          <View className="mt-2">
            {ledger.map((m, i) => (
              <View
                key={m.muscle}
                className={`flex-row items-center gap-3 py-2 ${
                  i === 0 ? '' : 'border-t border-hairline'
                }`}>
                <Text className="w-24 font-serif text-[13px] text-ink">
                  {MUSCLE_LABEL[m.muscle]}
                </Text>
                {/*
                  Biology, so a signal colour is the sanctioned use here. The
                  track is paper-deep, which is what forces the ink cut on the
                  fill — see freshnessColor. Changing this track changes that
                  measurement, so move the two together.
                */}
                <View className="h-1.5 flex-1 bg-paper-deep">
                  <View
                    style={{ width: `${m.freshness}%`, backgroundColor: freshnessColor(m.state) }}
                    className="h-full"
                  />
                </View>
                <Text className="w-9 text-right font-mono text-[12px] text-ink-secondary">
                  {m.freshness}
                </Text>
              </View>
            ))}
          </View>
        </Block>
      </View>

      {/* This week — a metric grid: aligned columns, no outer box, no rules. */}
      <View className="mt-7">
        <Block device="grid">
          <SectionLabel label="This week" />
          {/* No margin: the cells' own `pt-4` is the row rhythm. */}
          <View className="flex-row">
            {stats.map((s, index) => (
              <View key={s.label} className={weekCellClass(index)}>
                <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                  {s.label}
                </Text>
                <View className="mt-1 flex-row items-baseline gap-1">
                  <Text className="font-mono text-2xl text-ink">{s.value}</Text>
                  {/* No data, no unit either: "— est" dresses an absence up as a reading. */}
                  {s.value === '—' ? null : (
                    <Text className="font-mono text-[10px] text-ink-muted">{s.unit}</Text>
                  )}
                </View>
              </View>
            ))}
          </View>
        </Block>
      </View>

      {/* Programs */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel
            label="Programs"
            note={programs.length > 0 ? String(programs.length) : undefined}
          />
          {programs.length === 0 ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              No programs yet. A program schedules your routines across a multi-week block with
              planned deload weeks; start one and Train today follows the plan.
            </Text>
          ) : (
            <View className="mt-1">
              {programs.map((p, i) => (
                <View key={p.id} className={i === 0 ? '' : 'border-t border-hairline'}>
                  <ProgramRow
                    program={p}
                    onPress={() => router.push({ pathname: '/program-edit', params: { id: p.id } })}
                  />
                </View>
              ))}
            </View>
          )}
        </Block>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New program"
          onPress={() => router.push('/program-edit')}
          className="mt-2 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
          <Ionicons name="add" size={17} color={palette.inkSecondary} />
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
            New program
          </Text>
        </Pressable>
      </View>

      {/* Routines */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel
            label="Routines"
            note={routines.length > 0 ? String(routines.length) : undefined}
          />
          {routines.length === 0 ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              No routines yet. Build one — an ordered exercise list with targets — and starting it
              pre-fills last session&rsquo;s numbers.
            </Text>
          ) : (
            <View className="mt-1">
              {routines.map((r, i) => (
                <View key={r.id} className={i === 0 ? '' : 'border-t border-hairline'}>
                  <RoutineRow
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
                </View>
              ))}
            </View>
          )}
        </Block>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New routine"
          onPress={() => router.push('/routine-edit')}
          className="mt-2 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
          <Ionicons name="add" size={17} color={palette.inkSecondary} />
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
            New routine
          </Text>
        </Pressable>
      </View>

      {/*
        Quick log — free-form / cardio / past session (the older logger).

        A **ruled plate**, not a well. Recessed stock is reserved for surfaces
        you actually write on (src/components/ui/block.tsx), and no keystroke is
        ever taken here: the row's only job is to push /workout-log, exactly
        like the Programs, Routines and Recent-sessions rows around it. Drawing
        it as a capture surface promised an input that isn't there.
      */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel label="Quick log" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Log a session free-form"
            onPress={() => router.push({ pathname: '/workout-log', params: { mode: 'past' } })}
            className="mt-1 min-h-[44px] flex-row items-center gap-2 active:opacity-60">
            <Ionicons name="time-outline" size={17} color={palette.inkSecondary} />
            <Text className="flex-1 font-serif text-[14px] text-ink">
              Cardio, mobility, or a past session
            </Text>
            <Ionicons name="chevron-forward" size={15} color={palette.inkMuted} />
          </Pressable>
        </Block>
      </View>

      {/*
        Recent sessions. No tally on the label: the hook reads only the latest
        six, so a count here would claim to be the whole history (00-design-spec
        §5 — a number on screen has to be the number it looks like).
      */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel label="Recent sessions" />
          {sessions.length === 0 ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              Nothing logged yet — start a workout above.
            </Text>
          ) : (
            <View className="mt-1">
              {sessions.map((s, index) => (
                <View
                  key={s.id}
                  className={`flex-row gap-3 py-2.5 ${
                    index === 0 ? '' : 'border-t border-hairline'
                  }`}>
                  <Text className="w-16 pt-0.5 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                    {dayLabel(s.date, today)}
                  </Text>
                  <View className="flex-1">
                    <Text className="font-serif text-[15px] leading-5 text-ink">{s.name}</Text>
                    <Text className="mt-0.5 font-mono text-[11px] leading-4 text-ink-muted">
                      {sessionDetail(s)}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </Block>
      </View>
    </Screen>
  );
}

/**
 * Train today. Three shapes, and the device says which one you are looking at
 * before you read a word:
 *
 *   a session   → **stamped plate**, the screen's one accent. It is the single
 *                 directive thing on the page, so it is the only thing drawn in
 *                 the accent.
 *   a rest day  → **measured field**. A rest day is a verdict about today, not
 *                 an action, so it draws no enclosure at all — and no accent,
 *                 because there is nothing to start.
 *   nothing yet → **measured field** as well, saying plainly why. Empty is
 *                 authored, never blank.
 *
 * The field device is unmarked: it once carried corner ticks, and those were cut
 * with the rest of the drafting chrome that had to be interpreted before it paid
 * (src/components/ui/block.tsx). What still separates the three is the stamp's
 * accent border, the air around the block, and the type.
 */
function TrainTodayCard({
  recommendation,
  onStart,
}: {
  recommendation: Recommendation;
  onStart: () => void;
}) {
  if (recommendation.kind === 'empty') {
    return (
      <Block device="field">
        <SectionLabel label="Train today" />
        <Text className="mt-2 font-serif text-[15px] leading-6 text-ink-secondary">
          {recommendation.why}
        </Text>
      </Block>
    );
  }

  if (recommendation.kind === 'rest') {
    const program = recommendation.program;
    return (
      <Block device="field">
        <SectionLabel
          label={program ? `Train today · ${program.programName}` : 'Train today'}
          note={program ? `Week ${program.week} of ${program.weeks}` : undefined}
        />
        <Text className="mt-2 font-serif text-[19px] font-semibold text-ink">Rest day</Text>
        <Text className="mt-1.5 font-serif text-[14px] leading-6 text-ink-secondary">
          {recommendation.why}
        </Text>
      </Block>
    );
  }

  const title =
    recommendation.kind === 'routine'
      ? recommendation.routineName
      : recommendation.muscles.map((m) => MUSCLE_LABEL[m]).join(' · ') || 'Fresh muscles';
  const freshness = recommendation.kind === 'routine' ? recommendation.freshness : null;
  const program = recommendation.kind === 'routine' ? recommendation.program : undefined;
  // The programme name and the deload marker are words, so they ride in the
  // label voice; the week count is a measurement, so it rides in mono.
  const label = program
    ? `Train today · ${program.programName}${program.weekKind === 'deload' ? ' · deload' : ''}`
    : 'Train today';

  return (
    <Block device="stamp">
      <SectionLabel
        label={label}
        note={program ? `Week ${program.week} of ${program.weeks}` : undefined}
      />

      <View className="mt-2 flex-row items-baseline justify-between gap-3">
        <Text className="flex-1 font-serif text-[20px] font-semibold leading-7 text-ink">
          {title}
        </Text>
        {/* Freshness is biological state, so mono measures and signal marks. */}
        {freshness != null ? (
          <Text className="font-mono text-[12px] text-ink-secondary">{freshness}% fresh</Text>
        ) : null}
      </View>

      <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
        {recommendation.why}
      </Text>

      {recommendation.exercises.length > 0 ? (
        <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-muted" numberOfLines={2}>
          {recommendation.exercises.map((e) => e.name).join(' · ')}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Start this workout"
        onPress={onStart}
        className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3 active:opacity-70">
        <Ionicons name="play" size={17} color={palette.pineOn} />
        <Text className="font-label text-[15px] font-semibold text-pine-on">Start</Text>
      </Pressable>
    </Block>
  );
}

/**
 * Weekly volume vs landmarks — the **margin annotation** device. This is a
 * short piece of advice about the week, not a record of it, so it belongs in
 * the margin rather than on a plate. The muscle names ride in the serif voice
 * with their set counts inline, the way a number inside a sentence does.
 */
function WeeklyVolume({ volume }: { volume: MuscleVolume[] }) {
  const total = volume.reduce((acc, v) => acc + v.sets, 0);
  const { under, over } = volumeAttention(volume);

  if (total === 0) {
    return (
      <Block device="margin">
        <SectionLabel label="Weekly volume" />
        <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
          No sets logged this week yet. Once you train, ARC tracks each muscle&rsquo;s weekly sets
          against its productive range (MEV–MRV).
        </Text>
      </Block>
    );
  }

  return (
    <Block device="margin">
      <SectionLabel label="Weekly volume" />
      {under.length > 0 ? (
        <View className="mt-1.5">
          <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            Add volume
          </Text>
          <Text className="mt-0.5 font-serif text-[14px] leading-5 text-ink">
            {under.join(' · ')}
          </Text>
        </View>
      ) : null}
      {over.length > 0 ? (
        <View className="mt-1.5">
          <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            Ease off
          </Text>
          <Text className="mt-0.5 font-serif text-[14px] leading-5 text-ink">
            {over.join(' · ')}
          </Text>
        </View>
      ) : null}
      {under.length === 0 && over.length === 0 ? (
        <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
          On track — every trained muscle is inside its productive range this week.
        </Text>
      ) : null}
    </Block>
  );
}

/**
 * One ruled line of the Programs plate. Carries no device of its own — it lives
 * inside the plate, and devices never nest (src/components/ui/block.tsx).
 */
function ProgramRow({ program, onPress }: { program: ProgramListItem; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${program.name}. ${program.weeks} weeks, ${program.trainingDays} training days${
        program.active ? `, active, week ${program.currentWeek ?? ''}` : ''
      }. Edit.`}
      onPress={onPress}
      className="min-h-[44px] justify-center py-2.5 active:opacity-60">
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 font-serif text-[16px] font-semibold text-ink">{program.name}</Text>
        {program.active && program.currentWeek != null ? (
          <Text className="font-mono text-[10px] text-ink-muted">Week {program.currentWeek}</Text>
        ) : null}
        <Ionicons name="chevron-forward" size={15} color={palette.inkMuted} />
      </View>
      <View className="mt-0.5 flex-row items-center justify-between gap-3">
        <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
          {program.active ? 'Running' : 'Not started'}
        </Text>
        <Text className="font-mono text-[10px] text-ink-muted">
          {program.weeks} wk · {program.trainingDays} days
        </Text>
      </View>
    </Pressable>
  );
}

/** One ruled line of the Routines plate. Tapping the row starts the routine. */
function RoutineRow({
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
      ? 'Never run'
      : `Last ${dayLabel(routine.lastStartedAt.slice(0, 10), today).toLowerCase()}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Start ${routine.name}. ${routine.exerciseCount} exercises, ${routine.totalSets} sets.`}
      onPress={onStart}
      className="min-h-[44px] justify-center py-2.5 active:opacity-60">
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 font-serif text-[16px] font-semibold text-ink">{routine.name}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Edit ${routine.name}`}
          onPress={onEdit}
          hitSlop={12}
          className="h-8 w-8 items-center justify-center active:opacity-60">
          <Ionicons name="create-outline" size={17} color={palette.inkMuted} />
        </Pressable>
      </View>
      <View className="mt-0.5 flex-row items-center justify-between gap-3">
        <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
          {last}
        </Text>
        <Text className="font-mono text-[10px] text-ink-muted">
          {routine.exerciseCount} ex · {routine.totalSets} sets
        </Text>
      </View>
    </Pressable>
  );
}
