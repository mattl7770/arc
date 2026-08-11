import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter, useSegments } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import {
  FRESHNESS_SPOKEN,
  freshnessState,
  freshnessTone,
} from '@/components/exercise/freshness-display';
import { MuscleFigure, MuscleFigureLegend } from '@/components/exercise/muscle-figure';
import { Block, DashedDivider, Divider, GridCell } from '@/components/ui/block';
import { Gauge } from '@/components/ui/gauge';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { todayISODate } from '@/lib/db/date';
import { MUSCLE_LABEL } from '@/lib/exercise/constants';
import { dayLabel, sessionDetail } from '@/lib/exercise/format';
import { volumeAttention } from '@/lib/exercise/volume';
import type { MuscleVolume, Recommendation, RoutineListItem } from '@/lib/exercise/types';
import { useTrainingHub } from '@/hooks/use-training';

/**
 * Exercise sub-app hub (docs/exercise-subapp.md). It renders at two routes: as
 * the **Train tab** root (app/(tabs)/train.tsx re-exports this file) and as a
 * stack-pushed screen from the Log tab's Workout tile and Data's Training row.
 *
 * ## Two routes, two headers (owner call on hardware, 2026-08-09)
 *
 * The two cases are told apart by `useSegments()`, not by `router.canGoBack()`:
 * with `backBehavior="history"` the tab root can very often go back, so that
 * test would keep the chevron exactly where it is wrong. Route shape is the
 * honest signal — `(tabs)` leads the segments only when this screen IS the tab.
 * The title stays "Exercise" in both places; the tab bar says TRAIN because
 * five characters is the width budget (app/(tabs)/_layout.tsx).
 *
 * "Train today" is the rule-based recommendation — the freshness pick over the
 * saved workouts (all offline) — with two doors in: start the recommended
 * session, or start empty. Below it: weekly volume vs landmarks, the muscle
 * body-figure (tap → the full per-muscle ledger), this week's totals, saved
 * workouts, manual log (free-form + photo import), and recent sessions.
 * (Programs were retired 2026-08-11 — owner call: one flat list of saved
 * workouts beats the routines/programs pair. The 0020 tables stay in the
 * schema, dormant.)
 *
 * ## The surface system (00-design-spec.md §1)
 *
 * The container encodes the content type, so this screen reads as a set of
 * drawing devices rather than a stack of identical cards:
 *
 *   Train today (a session)  stamp   the one next action, in the accent, capped
 *   Train today (rest/empty) field   a verdict — corner ticks, no enclosure
 *   Weekly volume            margin  advisory prose — a 2px rule and an indent
 *   Muscle freshness         plate   the body schematic; navigates to the ledger
 *   This week                grid    aligned columns, ruled between, no outer box
 *   Saved workouts           plate   a record, ruled
 *   Manual log               plate   rows that navigate, like their neighbours
 *   Recent sessions          plate   a record, ruled
 *
 * Each block carries exactly one device and none of them nest; every other
 * `View` here is layout and spacing only. Sections are separated by whitespace,
 * never by a rule — rules enclose objects, not the page.
 *
 * **A plate holds through the empty branch.** Saved workouts and Recent
 * sessions each draw their plate whether or not they have rows: a record with
 * nothing in it still stands where the record stands. (The sweep of 2026-08-10
 * made these conditional; the owner rejected that and they are restored.)
 *
 * **Accent budget: one.** The Train-today stamp, its hatched cap and its Start
 * button are this screen's single primary action. Everything else is neutral
 * ink. The mirror rule holds too: FRESHNESS is a *biological* state, so it is
 * the one thing here allowed to carry a signal colour, and the accent never
 * touches it — not in the body figure's cells and not in the gauge on the
 * Train-today card, which is the hard case, because that gauge sits a few
 * points above a pine Start button inside a pine border. `Gauge` enforces it
 * structurally: it takes a biological `tone`, not a colour, so the accent has
 * no way in (src/components/ui/gauge.tsx; the shared state→tone maps live in
 * src/components/exercise/freshness-display.ts).
 */
export default function ExerciseScreen() {
  const router = useRouter();
  // `(tabs)` leads the segments only when this file is rendering AS the Train
  // tab root; the pushed route is plain `/exercise`. See the header note above.
  const isTabRoot = useSegments()[0] === '(tabs)';
  const { week, sessions, routines, ledger, volume, recommendation } = useTrainingHub();
  const today = todayISODate();

  const stats: { label: string; value: string; unit: string; sub?: string }[] = [
    { label: 'Zone 2', value: String(Math.round(week.zone2Min)), unit: 'min' },
    {
      label: 'Strength',
      value: String(week.strengthSessions),
      unit: week.strengthSessions === 1 ? 'session' : 'sessions',
    },
    // No wearable / test source yet — an honest em dash beats a fake number.
    // The dash says the value is absent; `sub` says WHY (00-design-spec.md §5:
    // empty is AUTHORED, never blank — a naked em-dash reads as a number that
    // failed to load; "no wearable yet" reads as a fact about the setup).
    { label: 'VO₂max', value: '—', unit: 'est', sub: 'no wearable yet' },
  ];

  const startRecommended = () => {
    if (recommendation.kind === 'routine') {
      router.push({
        pathname: '/workout-live',
        params: { routineId: recommendation.routineId, name: recommendation.routineName },
      });
    } else if (recommendation.kind === 'muscles') {
      router.push({
        pathname: '/workout-live',
        params: { exerciseIds: recommendation.exercises.map((e) => e.exerciseId).join(',') },
      });
    }
  };

  /** A blank session — name it and add exercises as you go. */
  const startEmpty = () => router.push('/workout-live');

  return (
    <Screen scroll>
      <View className="pt-2">
        {isTabRoot ? (
          <Text className="font-serif text-[26px] font-semibold text-ink">Exercise</Text>
        ) : (
          <StackHeader title="Exercise" />
        )}
      </View>

      {/* Train today — the one accent on this screen.

          `hasHistory` is what lets the freshness gauge state its own basis:
          `listRecentSessions` takes a LIMIT and no date window, so an empty
          array means the `workouts` table is empty — zero sessions ever, not
          merely none lately. See the note on {@link TrainTodayCard}. */}
      <View className="mt-5">
        <TrainTodayCard
          recommendation={recommendation}
          hasHistory={sessions.length > 0}
          onStart={startRecommended}
          onStartEmpty={startEmpty}
        />
      </View>

      {/* Weekly volume vs landmarks — advisory prose, so: margin annotation. */}
      <View className="mt-7">
        <WeeklyVolume volume={volume} />
      </View>

      {/* Muscle freshness — the body schematic. A record of the body's state,
          so: ruled plate; the whole plate navigates to the full per-muscle
          ledger (app/muscle-freshness.tsx), where the numbers and their gauge
          tracks live. Cells mark only DEPLETION — a rested body is an
          unremarkable one (muscle-figure.tsx). */}
      <View className="mt-7">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Muscle freshness. Open the full per-muscle ledger."
          onPress={() => router.push('/muscle-freshness')}
          className="active:opacity-60">
          <Block device="plate">
            <SectionLabel
              label="Muscle freshness"
              accessory={
                <Ionicons
                  name="chevron-forward"
                  size={13}
                  color={palette.inkMuted}
                  style={{ alignSelf: 'center' }}
                />
              }
            />
            <View className="mt-3">
              <MuscleFigure mode="freshness" ledger={ledger} />
            </View>
            <View className="mt-3">
              <MuscleFigureLegend mode="freshness" />
            </View>
          </Block>
        </Pressable>
      </View>

      {/* This week — a metric grid: no outer box, drawn by the rules that run
          BETWEEN its cells. `GridCell` owns the width, the padding and both
          rules, and conditions the vertical on a cell actually following
          (src/components/ui/block.tsx). */}
      <View className="mt-7">
        <Block device="grid">
          <SectionLabel label="This week" />
          {/* `mt-2` keeps the first cell's top rule off the label above it —
              the same gap src/components/home/metrics-strip.tsx leaves. */}
          <View className="mt-2 flex-row">
            {stats.map((s, index) => (
              <GridCell key={s.label} index={index} count={stats.length} columns={3}>
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
                {/* …and where the unit is dropped, the REASON takes its place. */}
                {s.sub ? (
                  <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">{s.sub}</Text>
                ) : null}
              </GridCell>
            ))}
          </View>
        </Block>
      </View>

      {/* Saved workouts — a plate in both states. The record's place is drawn
          before it has contents; an empty record still stands where a record
          stands. (Replaces the Routines + Programs pair, owner call 2026-08-11:
          one flat list of reusable sessions you load pre-filled.) */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel
            label="Saved workouts"
            note={routines.length > 0 ? String(routines.length) : undefined}
          />
          {routines.length === 0 ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              Nothing saved yet. A saved workout is a session you reuse — its exercises and targets
              load pre-filled, with last time&rsquo;s numbers as the placeholders.
            </Text>
          ) : (
            <View className="mt-1">
              {routines.map((r, i) => (
                <View key={r.id}>
                  <Divider first={i === 0} />
                  <SavedWorkoutRow
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
          accessibilityLabel="New saved workout"
          onPress={() => router.push('/routine-edit')}
          className="mt-2 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
          <Ionicons name="add" size={17} color={palette.inkSecondary} />
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
            New saved workout
          </Text>
        </Pressable>
      </View>

      {/*
        Manual log — the ways a session gets in WITHOUT the live logger: typed
        free-form (cardio / mobility / a past day) or imported from a photo of
        another app's log (AI-parsed, reviewed before anything saves).

        A **ruled plate**, not a well. Recessed stock is reserved for surfaces
        you actually write on (src/components/ui/block.tsx), and no keystroke is
        ever taken here: these rows only navigate, exactly like the rows in the
        plates around them. (Renamed from "Quick log", owner call 2026-08-11.)
      */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel label="Manual log" />
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
          <Divider />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Import a workout from a photo"
            onPress={() => router.push('/workout-import')}
            className="min-h-[44px] flex-row items-center gap-2 active:opacity-60">
            <Ionicons name="image-outline" size={17} color={palette.inkSecondary} />
            <Text className="flex-1 font-serif text-[14px] text-ink">
              Import from a photo of another app
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
                <View key={s.id}>
                  <Divider first={index === 0} />
                  <View className="flex-row gap-3 py-2.5">
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
 *   a session   → **stamped plate**, the screen's one accent, and the one that
 *                 wears the hatched cap. It is the single directive thing on the
 *                 page, so it is the only thing drawn in the accent.
 *   a rest day  → **measured field**, its corner ticks and nothing else — a
 *                 verdict, not an action. (Dormant since programs were retired
 *                 2026-08-11; the arm stays for the Coach's read tool.)
 *   nothing yet → **measured field** as well, saying plainly why. Empty is
 *                 authored, never blank.
 *
 * Every shape also carries the second door — **Start empty** — because "log
 * something the engine didn't plan" must never be gated on the engine having a
 * plan (owner ask, 2026-08-11).
 *
 * ## The gauge has to say what its number rests on
 *
 * `muscleFreshness` scores a never-trained muscle 100 / fresh by construction,
 * so on a fresh install the meter would draw a full optimal bar pinned
 * **100% FRESH**. The number is right under the model; what is wrong is that
 * "100 because nothing has ever been logged" and "100 because you are fully
 * recovered" render identically. The instrument states its basis instead —
 * `hasHistory` false prints `no sessions logged` in the pin row and appends it
 * to the spoken label. Only the never-logged case is qualified: a 100 after two
 * untrained weeks is a real reading.
 *
 * **An empty saved workout gets no gauge at all.** `routineFreshness([])`
 * returns 100 for a session with no exercises, which would leave a 100% meter
 * standing over a blank line — not a thin reading, not a reading (§5). The
 * meter and the names drop out and an authored line takes the blank's place.
 */
function TrainTodayCard({
  recommendation,
  hasHistory,
  onStart,
  onStartEmpty,
}: {
  recommendation: Recommendation;
  /** Has the owner ever logged a session? Drives the gauge's qualifier. */
  hasHistory: boolean;
  onStart: () => void;
  onStartEmpty: () => void;
}) {
  if (recommendation.kind === 'empty') {
    return (
      <Block device="field">
        <SectionLabel label="Train today" />
        <Text className="mt-2 font-serif text-[15px] leading-6 text-ink-secondary">
          {recommendation.why}
        </Text>
        <StartEmptyButton onPress={onStartEmpty} />
      </Block>
    );
  }

  if (recommendation.kind === 'rest') {
    return (
      <Block device="field">
        <SectionLabel label="Train today" />
        <Text className="mt-2 font-serif text-[19px] font-semibold text-ink">Rest day</Text>
        <Text className="mt-1.5 font-serif text-[14px] leading-6 text-ink-secondary">
          {recommendation.why}
        </Text>
        <StartEmptyButton onPress={onStartEmpty} />
      </Block>
    );
  }

  const title =
    recommendation.kind === 'routine'
      ? recommendation.routineName
      : recommendation.muscles.map((m) => MUSCLE_LABEL[m]).join(' · ') || 'Fresh muscles';
  // A saved workout that has never had an exercise added to it. One flag drives
  // all three of the things the engine cannot fill in for it — the names, the
  // gauge and the "why" — so they cannot get out of step with each other.
  const emptyRoutine = recommendation.kind === 'routine' && recommendation.exercises.length === 0;
  const freshness =
    recommendation.kind === 'routine' && !emptyRoutine ? recommendation.freshness : null;
  const freshState = freshness == null ? null : freshnessState(freshness);

  return (
    // `cap` draws the sheet's accent/ink barber hatch over the stamp's top edge
    // — the mark that separates "a card with a coloured border" from "a drawing
    // that has been stamped" (src/components/ui/block.tsx).
    <Block device="stamp" cap>
      <SectionLabel label="Train today" note="Recommended" />

      <Text className="mt-2 font-serif text-[20px] font-semibold leading-7 text-ink">{title}</Text>

      {/* Title → names → gauge → why → Start. The names are the card's
          EVIDENCE — what makes the title a concrete session rather than a
          label — so they sit directly under it, not as a footnote. */}
      {recommendation.exercises.length > 0 ? (
        <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-muted" numberOfLines={2}>
          {recommendation.exercises.map((e) => e.name).join(' · ')}
        </Text>
      ) : null}

      {/*
        The freshness gauge — pin, drop line, bordered track, fill, quarter
        ticks, numbered scale (src/components/ui/gauge.tsx).

        ⚠️ The fill is BIOLOGY and takes a signal cut, never the accent — this
        card is bordered in pine and its Start button is filled pine, which
        makes this the most likely spot in the app to paint chrome onto a
        biological state. `Gauge` takes a `tone` from a closed union of
        biological states, so there is no colour prop for the accent to arrive
        through. `qualifier` is the other half of the honesty — see the
        component note above.
      */}
      {freshness != null && freshState != null ? (
        <View className="mt-1">
          <Gauge
            value={freshness}
            tone={freshnessTone(freshState)}
            pin={`${freshness}% FRESH`}
            qualifier={hasHistory ? undefined : 'no sessions logged'}
            accessibilityLabel={`Freshness ${freshness} percent, ${FRESHNESS_SPOKEN[freshState]}`}
          />
        </View>
      ) : null}

      {/* The engine builds the "why" out of the session's muscles, which an
          empty saved workout has none of. Empty is AUTHORED, never blank (§5),
          and the authored version says what would fix it. */}
      <Text className="mt-3.5 font-serif text-[14px] leading-6 text-ink-secondary">
        {emptyRoutine
          ? 'No exercises in this saved workout yet — add some from Saved workouts below.'
          : recommendation.why}
      </Text>

      {/* Two doors into a session: the engine's pick, or a blank sheet. The
          recommended start is the screen's one accent; the empty start is a
          ghost — a real alternative, not a second claim on the budget. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Start the recommended workout"
        onPress={onStart}
        className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3 active:opacity-70">
        <Ionicons name="play" size={17} color={palette.pineOn} />
        <Text className="font-label text-[15px] font-semibold text-pine-on">
          Start recommended
        </Text>
      </Pressable>
      <StartEmptyButton onPress={onStartEmpty} />
    </Block>
  );
}

/** The blank-sheet door — a ghost action under the recommended start. */
function StartEmptyButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Start an empty workout"
      onPress={onPress}
      className="mt-2 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
      <Ionicons name="add" size={16} color={palette.inkSecondary} />
      <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
        Start empty
      </Text>
    </Pressable>
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
        {/* The absence, then the reference the numbers get read against. */}
        <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
          No sets logged this week yet. Weekly sets per muscle are measured against its productive
          range (MEV–MRV).
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
 * One ruled line of the Saved-workouts plate. Tapping the row STARTS it — which
 * the row says out loud ("Tap to start · …"), because a pencil sits in the same
 * row with its own tap target, and a row that states nothing about itself but a
 * date leaves the reader guessing which of the two taps runs it.
 *
 * Head, dashed rule, foot — the sheet's `.cf-progcard` rhythm, kept as a ruled
 * row in one shared plate rather than a card per entry (a plate per entry would
 * nest a device inside a device, which this design forbids).
 */
function SavedWorkoutRow({
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
      ? 'Tap to start · never run'
      : `Tap to start · last ${dayLabel(routine.lastStartedAt.slice(0, 10), today).toLowerCase()}`;
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
      {/* Head, dashed rule, foot — the sheet's 10pt / 8pt rhythm around it. */}
      <View className="mt-2.5">
        <DashedDivider />
      </View>
      <View className="mt-2 flex-row items-center justify-between gap-3">
        <Text className="flex-1 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
          {last}
        </Text>
        <Text className="font-mono text-[10px] text-ink-muted">
          {routine.exerciseCount} ex · {routine.totalSets} sets
        </Text>
      </View>
    </Pressable>
  );
}
