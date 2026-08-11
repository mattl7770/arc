import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter, useSegments } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block, DashedDivider, Divider, GridCell } from '@/components/ui/block';
import { Gauge, GaugeTrack, gaugeTextClass, type GaugeTone } from '@/components/ui/gauge';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { todayISODate } from '@/lib/db/date';
import { FRESH_THRESHOLDS, MUSCLE_LABEL } from '@/lib/exercise/constants';
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
 *   Train today (a session)  stamp   the one next action, in the accent, capped
 *   Train today (rest/empty) field   a verdict — corner ticks, no enclosure
 *   Weekly volume            margin  advisory prose — a 2px rule and an indent
 *   Muscle freshness         plate   a record, ruled
 *   This week                grid    aligned columns, ruled between, no outer box
 *   Programs / Routines      plate   records, ruled
 *   Quick log                plate   a row that navigates, like its neighbours
 *   Recent sessions          plate   a record, ruled
 *
 * Each block carries exactly one device and none of them nest; every other
 * `View` here is layout and spacing only. Sections are separated by whitespace,
 * never by a rule — rules enclose objects, not the page.
 *
 * **A plate holds through the empty branch.** Programs, Routines and Recent
 * sessions each draw their plate whether or not they have rows: a record with
 * nothing in it still stands where the record stands, and drawing its place
 * before it has contents is what makes an empty tab root read as a form waiting
 * to be filled rather than as a page that failed to load. The sweep of
 * 2026-08-10 made all three conditional and stripped Quick log's plate outright;
 * the owner rejected that and they are restored.
 *
 * **Accent budget: one.** The Train-today stamp, its hatched cap and its Start
 * button are this screen's single primary action. Everything else is neutral
 * ink. The mirror rule holds too: FRESHNESS is a *biological* state, so it is
 * the one thing here allowed to carry a signal colour, and the accent never
 * touches it — not in the ledger's bars and not in the gauge on the Train-today
 * card, which is the hard case, because that gauge sits a few points above a
 * pine Start button inside a pine border. The mockup writes the ruling into its
 * own CSS (arc-conformed-set.html:690) and `Gauge` enforces it structurally: it
 * takes a biological `tone`, not a colour, so the accent has no way in.
 */

/**
 * state → signal cut for the freshness BAR FILL and for the figure beside it.
 * Freshness is a biological state, so a signal colour is the sanctioned mark
 * here — the firewall is about *which cut*, not whether.
 *
 * **Resolves to the INK cut even though one of its two outputs is a fill**,
 * which is the one place that inverts the usual reading of the two cuts. The
 * swatch cut is sized for the 3:1 graphical-object floor on the pale surfaces
 * (paper, paper-hi); this fill sits on recessed stock, and against that mid-tone
 * ground the swatches measure optimal 2.89 · recovering 2.58 · fatigued 4.11 —
 * two of three under the floor, with `recovering` all but dissolving into its
 * own track. The ink cuts clear it comfortably: **5.60 / 5.12 / 5.29**, so the
 * fix is the cut, not the track. The resolution itself lives in
 * src/components/ui/gauge.tsx, which owns both cuts so the bar and the number
 * cannot drift onto different states.
 *
 * **RE-MEASURED 2026-08-11, because the track moved.** The track was
 * `paper-deep` with no border and is now `paper-dim` inside a 1px `paper-line`
 * border — the sheet's `.cf-mrow2-bar`, restored. The old comment here warned
 * that the two must move together, and they did: on the old track the same ink
 * cuts measured 4.56 / 4.17 / 4.31 (swatches 2.36 / 2.10 / 3.35). Both grounds
 * clear the floor on the ink cut; the new one clears it by more, and the border
 * is what makes the track read as a drawn instrument rather than an underline.
 *
 * Nothing about that softens the text rule in the other direction: any
 * imperative TEXT colour for a biological state takes the signal INK cut, never
 * the swatch (00-design-spec.md §2). The ink cut is the floor for words and the
 * safe choice for fills; the swatch is neither.
 *
 * Colour is not the sole carrier here regardless — the fill's WIDTH, the mono
 * percentage beside it and the row's spoken label all state the same thing — so
 * this was a legibility debt rather than a correctness failure. It is still paid.
 */
function freshnessTone(state: MuscleFreshness['state']): GaugeTone {
  switch (state) {
    case 'fresh':
      return 'optimal';
    case 'recovering':
      return 'caution';
    default:
      return 'poor';
  }
}

/**
 * The same three buckets, for a freshness score that arrives without one.
 * `Recommendation` carries a set-weighted `freshness` number but no state — the
 * bucketing lives in src/lib/exercise/freshness.ts and is not exported — so the
 * card re-derives it from the same published thresholds the ledger uses. That
 * shared constant is the point: the 82 on the Train-today gauge and the 82 in
 * the ledger below it must not be able to read as two different conditions.
 */
function freshnessState(score: number): MuscleFreshness['state'] {
  if (score >= FRESH_THRESHOLDS.fresh) return 'fresh';
  if (score >= FRESH_THRESHOLDS.recovering) return 'recovering';
  return 'fatigued';
}

/**
 * The condition in words, for assistive tech — a bar and a colour say nothing
 * to a screen reader. Same shape and same purpose as the SPOKEN map in
 * src/components/home/signal.tsx, and it diverges from the printed form for the
 * same kind of reason: nothing on screen prints these words at all. The gauge's
 * pin reads `82% FRESH` in every state, because "fresh" there is the NAME of the
 * measurement, not the verdict on it — 45% fresh is still a percentage of
 * freshness. Spoken, that leaves the verdict unsaid, so it is said here.
 */
const FRESHNESS_SPOKEN: Record<MuscleFreshness['state'], string> = {
  fresh: 'fresh',
  recovering: 'still recovering',
  fatigued: 'fatigued',
};

export default function ExerciseScreen() {
  const router = useRouter();
  // `(tabs)` leads the segments only when this file is rendering AS the Train
  // tab root; the pushed route is plain `/exercise`. See the header note above.
  const isTabRoot = useSegments()[0] === '(tabs)';
  const { week, sessions, routines, programs, ledger, volume, recommendation } = useTrainingHub();
  const today = todayISODate();

  const stats: { label: string; value: string; unit: string; sub?: string }[] = [
    { label: 'Zone 2', value: String(Math.round(week.zone2Min)), unit: 'min' },
    {
      label: 'Strength',
      value: String(week.strengthSessions),
      unit: week.strengthSessions === 1 ? 'session' : 'sessions',
    },
    // No wearable / test source yet — an honest em dash beats a fake number.
    //
    // The dash says the value is absent; `sub` says WHY, which is the half the
    // port dropped. The sheet gives this cell a `.cf-col3-sub` reading "no
    // wearable yet", and 00-design-spec.md §5 asks for exactly that: empty is
    // AUTHORED, never blank. A naked em-dash under a label the user chose to
    // look at reads as a number that failed to load; "no wearable yet" reads as
    // a fact about the setup, and points at what would fix it.
    { label: 'VO₂max', value: '—', unit: 'est', sub: 'no wearable yet' },
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

      {/* Train today — the one accent on this screen.

          `hasHistory` is what lets the freshness gauge state its own basis. See
          the note on {@link TrainTodayCard}; `sessions` is the honest test
          because `listRecentSessions` takes a LIMIT and no date window, so an
          empty array means the `workouts` table is empty — zero sessions ever,
          not merely none lately. */}
      <View className="mt-5">
        <TrainTodayCard
          recommendation={recommendation}
          hasHistory={sessions.length > 0}
          onStart={startRecommended}
        />
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
              <View key={m.muscle}>
                <Divider first={i === 0} />
                {/*
                  Announced as one row. The bar is geometry and the figure's
                  colour is colour, and a screen reader sees neither — so the
                  condition is spoken in words, the way signal.tsx does it. The
                  row is `accessible`, which collapses the three children into a
                  single element rather than reading "Quads", nothing, "82%".
                */}
                <View
                  accessible
                  accessibilityLabel={`${MUSCLE_LABEL[m.muscle]} ${m.freshness} percent, ${FRESHNESS_SPOKEN[m.state]}`}
                  className="flex-row items-center gap-3 py-2">
                  <Text className="w-24 font-serif text-[13px] text-ink">
                    {MUSCLE_LABEL[m.muscle]}
                  </Text>
                  {/*
                    Biology, so a signal colour is the sanctioned use here. The
                    track is the sheet's `.cf-mrow2-bar` — 7px of paper-dim
                    inside a 1px rule — which is what forces the ink cut on the
                    fill (see freshnessTone; the measurement moved with the
                    track and is recorded there). It was a 6px unbordered
                    paper-deep bar, which reads as an underline; a bordered
                    track reads as a drawn instrument.
                  */}
                  <View className="flex-1">
                    <GaugeTrack value={m.freshness} tone={freshnessTone(m.state)} />
                  </View>
                  {/*
                    The row states its condition twice — once in the fill, once
                    in the figure — which is what the sheet's `.cf-mrow2-v` does
                    with its matching `bio-*-ink` cut. It had lost both the cut
                    and the `%` glyph, leaving a bare neutral number that no
                    longer said what it was a number OF. 7.40 / 6.77 / 7.00 on
                    this plate.
                  */}
                  <Text
                    className={`w-9 text-right font-mono text-[12px] font-semibold ${gaugeTextClass(freshnessTone(m.state))}`}>
                    {m.freshness}%
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </Block>
      </View>

      {/* This week — a metric grid: no outer box, drawn by the rules that run
          BETWEEN its cells. `GridCell` owns the width, the padding and both
          rules, and conditions the vertical on a cell actually following, so
          three stats in a three-column row cannot rule off into empty space
          (src/components/ui/block.tsx). */}
      <View className="mt-7">
        <Block device="grid">
          <SectionLabel label="This week" />
          {/* `mt-2` is what keeps the first cell's top rule off the label above
              it — the same gap src/components/home/metrics-strip.tsx leaves. */}
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
                {/* …and where the unit is dropped, the REASON takes its place —
                    the sheet's `.cf-col3-sub`. Mono at 10px rather than the
                    sheet's 9px: the metadata layer sits at 9.5-10px so the 9px
                    render floor is never load-bearing (00-design-spec.md §4). */}
                {s.sub ? (
                  <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">{s.sub}</Text>
                ) : null}
              </GridCell>
            ))}
          </View>
        </Block>
      </View>

      {/* Programs — a plate in both states. The record's place is drawn before
          it has contents; an empty record still stands where a record stands.
          (Made conditional by the de-plating sweep of 2026-08-10, restored the
          same day at the owner's instruction.) */}
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
                <View key={p.id}>
                  <Divider first={i === 0} />
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

      {/* Routines — a plate in both states, same call as Programs above. */}
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
                <View key={r.id}>
                  <Divider first={i === 0} />
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
 *   a rest day  → **measured field**, its corner ticks and nothing else. A rest
 *                 day is a verdict about today, not an action, so it takes no
 *                 enclosure — and no accent, because there is nothing to start.
 *   nothing yet → **measured field** as well, saying plainly why. Empty is
 *                 authored, never blank.
 *
 * What separates the three is the stamp's accent border and hatch, the field's
 * corner ticks, the air around the block, and the type. (This note used to say
 * the field "draws nothing"; that was true for two days in August 2026, when
 * three devices were stripped on a misreading of the owner's "weird boxes" —
 * they were not noise, they were rendering as boxes. All three are back, drawn
 * as filled views. The full history is in src/components/ui/block.tsx.)
 *
 * ## The gauge has to say what its number rests on
 *
 * `muscleFreshness` scores a never-trained muscle 100 / fresh by construction
 * (src/lib/exercise/freshness.ts), so on a fresh install with one routine and no
 * sessions the meter draws a full-width optimal bar pinned **100% FRESH**. The
 * number is right under the model; what is wrong is that "100 because nothing
 * has ever been logged" and "100 because you are fully recovered" render
 * identically, and the gauge is a far louder claim than the 12px caption it
 * replaced (00-design-spec.md §5).
 *
 * The instrument stays and states its basis instead — `hasHistory` false prints
 * `no sessions logged` in the pin row and appends it to the spoken label. It is
 * a coarse test on purpose: sessions older than `FRESHNESS_LOOKBACK_DAYS` (14)
 * also leave the ledger with no load to decay, but a 100 there is a real reading
 * — two weeks untrained IS fully recovered — so only the never-logged case is
 * qualified. `sessions` is the signal available at the call site and it is the
 * exact one: `listRecentSessions` is a LIMIT with no date window, so empty means
 * the table is empty.
 *
 * **An empty routine is a different case and gets no gauge at all.**
 * `routineFreshness([])` returns 100 for a routine with no exercises
 * (src/lib/exercise/recommend.ts), and `topMuscles([])` returns `''`, which left
 * a 100% meter standing over a blank line. That is not a thin reading, it is not
 * a reading — §5's "no data, no number" — so the meter and the exercise names
 * both drop out and an authored line takes the blank's place. The week count is
 * unaffected either way: it rides in the section label's note, not the "why".
 */
function TrainTodayCard({
  recommendation,
  hasHistory,
  onStart,
}: {
  recommendation: Recommendation;
  /** Has the owner ever logged a session? Drives the gauge's qualifier. */
  hasHistory: boolean;
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
  // A routine that has never had an exercise added to it. One flag drives all
  // three of the things the engine cannot fill in for it — the names, the gauge
  // and the "why" — so they cannot get out of step with each other.
  const emptyRoutine = recommendation.kind === 'routine' && recommendation.exercises.length === 0;
  const freshness =
    recommendation.kind === 'routine' && !emptyRoutine ? recommendation.freshness : null;
  const program = recommendation.kind === 'routine' ? recommendation.program : undefined;
  // The programme name and the deload marker are words, so they ride in the
  // label voice; the week count is a measurement, so it rides in mono.
  const label = program
    ? `Train today · ${program.programName}${program.weekKind === 'deload' ? ' · deload' : ''}`
    : 'Train today';

  const freshState = freshness == null ? null : freshnessState(freshness);

  return (
    // `cap` draws the sheet's `.cf-card--accent::before` — a 3pt accent/ink
    // barber hatch laid over the stamp's top edge. It is the loudest drafting
    // mark in the set and the thing that separates "a card with a coloured
    // border" from "a drawing that has been stamped"; `Block` gained the prop
    // and this card is one of the four the sheet gives it to.
    <Block device="stamp" cap>
      <SectionLabel
        label={label}
        note={program ? `Week ${program.week} of ${program.weeks}` : undefined}
      />

      <Text className="mt-2 font-serif text-[20px] font-semibold leading-7 text-ink">{title}</Text>

      {/*
        Title → names → gauge → why → Start, which is the sheet's order and was
        not the app's. The names are the card's EVIDENCE: they are what makes
        "Lower A — Squat focus" a concrete session rather than a label, so they
        belong directly under the title where the eye lands next. The app had
        them last, below the rationale, where they read as a footnote to an
        argument that had already been made without them.
      */}
      {recommendation.exercises.length > 0 ? (
        <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-muted" numberOfLines={2}>
          {recommendation.exercises.map((e) => e.name).join(' · ')}
        </Text>
      ) : null}

      {/*
        The freshness gauge — the sheet's `.cf-freshmeter`, in full: pin, drop
        line, bordered track, fill, quarter ticks, numbered scale. This was one
        right-aligned string of 12px mono up on the title's baseline, which
        stated the number and drew none of the instrument.

        ⚠️ The fill is BIOLOGY and takes a signal cut, never the accent — this
        card is bordered in pine and its Start button is filled pine, which makes
        this the most likely spot in the app to paint chrome onto a biological
        state. The mockup writes the rule into its own CSS at
        arc-conformed-set.html:690. `Gauge` enforces it structurally: it takes a
        `tone` from a closed union of biological states and looks the colour up
        itself, so there is no colour prop for the accent to arrive through.

        `qualifier` is the other half of that honesty: with nothing ever logged
        the engine's 100 is a default rather than an observation, so the meter
        names its own basis instead of pretending to one. Product nouns, and only
        when it applies — see the note on this component.
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
          empty routine has none of — it arrived blank. Empty is AUTHORED, never
          blank (§5), and the authored version also says what would fix it. */}
      <Text className="mt-3.5 font-serif text-[14px] leading-6 text-ink-secondary">
        {emptyRoutine
          ? 'No exercises in this routine yet — add some from Routines below.'
          : recommendation.why}
      </Text>

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
        {/* The absence, then the reference the numbers get read against. The
            "Once you train, ARC tracks…" framing was the app narrating its own
            features; the MEV–MRV range is the part still needed to read this
            block once it fills (slop sweep, 2026-08-10). */}
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

/*
 * The dashed rule dividing a program/routine entry's head from its foot — the
 * sheet's `.cf-progcard-foot` — is `DashedDivider` in
 * src/components/ui/block.tsx. It lived here as a local copy for one commit,
 * alongside two more in app/protocols.tsx and app/protocol-versions.tsx, and the
 * three had already drifted apart on dash pitch. The primitive kept this file's
 * finer 3pt/6pt pattern; the reasoning is in its docblock.
 */

/**
 * The week marker on a running program — the sheet's `.cf-progchip`, which is a
 * bordered BOX. The app printed the bare string, and an unenclosed count next to
 * a title reads as part of the title rather than as a marker on it.
 *
 * Two deliberate departures from the sheet, both to the spec:
 *
 *   **Radius.** `.cf-progchip` carries `border-radius: 8px`; 00-design-spec.md
 *   §4 caps every corner in this design at 2px ("corners: square… buttons take a
 *   2px radius at most"). The spec wins over the sheet — `rounded-btn` is 2px.
 *
 *   **Voice.** §3 puts chips in the label voice, with a carve-out for "a
 *   measured value inside a label — `v3`, `280 g`, `12 sets` — which stays
 *   mono". This chip is nothing BUT that: "Week 3" is an index into an
 *   eight-week block, the same kind of measurement as `v3`. Setting four
 *   characters in two type stacks to satisfy the letter of the rule would cost
 *   more than it buys at 10px, so the whole chip stays mono.
 */
function WeekChip({ week }: { week: number }) {
  return (
    <View className="rounded-btn border border-hairline px-[7px] py-0.5">
      <Text className="font-mono text-[10px] text-ink-muted">Week {week}</Text>
    </View>
  );
}

/**
 * One ruled line of the Programs plate. Carries no device of its own — it lives
 * inside the plate, and devices never nest (src/components/ui/block.tsx).
 *
 * **The sheet draws each entry as its own bordered `paper-hi` card
 * (`.cf-progcard`); this is a ruled row in one shared plate.** That divergence
 * is kept on purpose. A plate per entry would nest a device inside a device,
 * which this design forbids outright, and the shared plate is what makes
 * Programs, Routines and Recent sessions read as three records of the same kind.
 * The owner has separately asked for Exercise to be reworked, so the question is
 * open — but the two MARKS the sheet's card carries and this row had lost, the
 * dashed foot rule and the boxed week chip, are restored here regardless: they
 * are the drawing, and the container is the argument.
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
          <WeekChip week={program.currentWeek} />
        ) : null}
        <Ionicons name="chevron-forward" size={15} color={palette.inkMuted} />
      </View>
      {/* Head, dashed rule, foot — the sheet's 10pt / 8pt rhythm around it. */}
      <View className="mt-2.5">
        <DashedDivider />
      </View>
      <View className="mt-2 flex-row items-center justify-between gap-3">
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

/**
 * One ruled line of the Routines plate. Tapping the row starts the routine —
 * which is exactly what the row had stopped saying. See `last` below, and the
 * note on {@link ProgramRow} for the card-versus-row question and the two marks
 * restored from the sheet's `.cf-progcard`.
 */
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
  /*
    The sheet's `.cf-progcard-sub` reads "Tap to start · last Tuesday"; the app
    printed only "Last tuesday". The hint is not decoration here: a pencil sits
    in this same row and owns its own tap target, so a row that states nothing
    about itself but a date leaves the reader guessing whether tapping it edits
    the routine or runs it. Naming the action is what disambiguates the two.

    It stays in the foot's left slot, in the label voice, rather than becoming a
    separate sub line — the sheet can afford both because its foot-left carries
    the parent program's name, which `RoutineListItem` does not track.
  */
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
      {/* Head, dashed rule, foot — the same rhythm as ProgramRow above. */}
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
