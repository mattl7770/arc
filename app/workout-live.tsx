import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, ZoomIn } from 'react-native-reanimated';

import { ExercisePicker } from '@/components/exercise/exercise-picker';
import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { getExercise } from '@/lib/db/repositories/exercise-catalog';
import { logWorkout } from '@/lib/db/repositories/exercise';
import { getRoutine, touchRoutineStarted } from '@/lib/db/repositories/routines';
import {
  lastSessionSets,
  personalRecords,
  type PrevSet,
} from '@/lib/db/repositories/training-stats';
import { restSecFor } from '@/lib/exercise/constants';
import { e1rmForSet } from '@/lib/exercise/e1rm';
import {
  displayWeight,
  formatClock,
  setTypeTag,
  toCanonicalKg,
  weightSpec,
} from '@/lib/exercise/format';
import type { LoggingType, Mechanic, SetType } from '@/lib/exercise/types';
import { cancelRestAlert, scheduleRestAlert } from '@/lib/notifications/rest-timer';
import { useUnitPreferences } from '@/hooks/use-unit-preferences';
import type { UnitPreferences } from '@/lib/user/types';

/**
 * The structured live workout logger (docs/exercise-subapp.md §2), pushed from
 * the Exercise hub — the FitBod/Hevy-style set grid. Exercise blocks; each set
 * row shows the previous session's numbers as placeholders, a mono
 * weight/reps/RPE entry, and a completion stamp that starts the rest timer and
 * marks a PR when the set beats the best e1RM to date. Weight is entered in the
 * user's unit and stored canonical kg. The free-form quick logger
 * (app/workout-log.tsx) stays for cardio / mobility / past sessions.
 *
 * ## The surface system (00-design-spec.md §1)
 *
 *   Session name    —      recessed stock, styled inline (an input is not a block)
 *   Deload notice   margin advisory prose, annotated in the margin
 *   Each exercise   plate  **the set table** — the most literal "a record is a
 *                          table" surface in the app, so it is ruled: a title
 *                          line, a header rule, then one ruled line per set.
 *
 * Every set/rep/weight/RPE value is mono without exception — "serif speaks,
 * mono measures". Column headers and tags are the label voice; the exercise
 * name is the serif voice.
 *
 * **Accent budget: one primary action (Finish workout) plus the completion
 * stamps.** A completed set is chrome, not biology, so the stamp is the accent
 * and never a signal green — signal colours mark biological state only, and
 * that firewall was a finding in all six hostile reviews.
 *
 * FLAG (native, deferred): the rest timer is foreground-only. Background
 * delivery (a notification at zero) needs expo-notifications and a dev rebuild.
 * It counts from a target instant, so it stays correct across backgrounding —
 * it just can't alert while the app is closed.
 */

const SET_TYPES: SetType[] = ['normal', 'warmup', 'failure', 'drop'];

/** Recessed stock for an inline entry field: an input well, without the device. */
const INPUT_WELL = 'justify-center border border-paper-deep bg-paper-dim px-1';

/**
 * The bind's spring — one settle, no wobble past the joint. Shared by every
 * block wrapper so linking, unlinking, and remove/reorder all move on the same
 * physics.
 */
const BIND_SPRING = LinearTransition.springify().damping(19).stiffness(210).mass(0.6);

/**
 * The seam chip — the stamp that lands where two plates fuse into one. It sits
 * astride the shared rule (absolutely positioned, centred), interrupting it the
 * way a section mark interrupts a ledger seam; the ZoomIn spring gives it the
 * one small overshoot of a press stamp. Tapping it splits the superset.
 */
function SupersetSeam({ onPress }: { onPress: () => void }) {
  return (
    <Animated.View
      entering={ZoomIn.springify().damping(14).stiffness(260).mass(0.5)}
      exiting={FadeOut.duration(110)}
      style={{ position: 'absolute', top: -11, alignSelf: 'center', zIndex: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Supersetted with the exercise above. Tap to split."
        onPress={onPress}
        hitSlop={10}
        className="flex-row items-center gap-1 border border-hairline bg-paper-hi px-2.5 py-0.5 active:opacity-60">
        <Ionicons name="link" size={11} color={palette.inkSecondary} />
        <Text className="font-label text-[9px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
          Superset
        </Text>
      </Pressable>
    </Animated.View>
  );
}

type LiveSet = {
  key: number;
  weight: string;
  reps: string;
  rpe: string;
  setType: SetType;
  done: boolean;
  pr: boolean;
};

type LiveBlock = {
  key: number;
  exerciseId: string;
  name: string;
  loggingType: LoggingType;
  mechanic: Mechanic | null;
  restSec: number | null;
  prev: PrevSet[];
  /** Best e1RM before this session — the bar a set must beat to tag a PR. */
  bestE1rm: number | null;
  /** Grouped into a superset with the block below it (shared superset_group). */
  linkedToNext: boolean;
  sets: LiveSet[];
};

/**
 * Superset group numbers derived from the linked-to-next flags: a maximal run of
 * blocks chained by `linkedToNext` shares one 1-based group id; ungrouped blocks
 * map to null. Pure function of block order + flags (recomputed on save/render),
 * so unlinking is just toggling one boolean.
 */
function supersetGroups(blocks: LiveBlock[]): (number | null)[] {
  const groups: (number | null)[] = blocks.map(() => null);
  let next = 1;
  let i = 0;
  while (i < blocks.length) {
    if (blocks[i]!.linkedToNext && i + 1 < blocks.length) {
      const start = i;
      while (i + 1 < blocks.length && blocks[i]!.linkedToNext) i++;
      for (let j = start; j <= i; j++) groups[j] = next;
      next++;
    }
    i++;
  }
  return groups;
}

const WEIGHT_LOGGING = new Set<LoggingType>([
  'weight_reps',
  'weighted_bodyweight',
  'weight_duration',
  'assisted_bodyweight',
]);

let keySeq = 1;
const nextKey = () => keySeq++;

function blankSet(from?: LiveSet): LiveSet {
  return {
    key: nextKey(),
    weight: from?.weight ?? '',
    reps: from?.reps ?? '',
    rpe: '',
    setType: 'normal',
    done: false,
    pr: false,
  };
}

/** Build a block for one exercise, reading its prev-session sets + PRs once. */
function buildBlock(
  exerciseId: string,
  targetSets: number,
  restSec: number | null
): LiveBlock | null {
  const db = getDb();
  const ex = getExercise(db, exerciseId);
  if (!ex) return null;
  const prev = lastSessionSets(db, exerciseId);
  const bestE1rm = personalRecords(db, exerciseId).bestE1rmKg;
  const count = Math.max(1, targetSets);
  return {
    key: nextKey(),
    exerciseId,
    name: ex.name,
    loggingType: ex.loggingType,
    mechanic: ex.mechanic,
    restSec: restSec ?? restSecFor(ex.mechanic, null),
    prev,
    bestE1rm,
    linkedToNext: false,
    sets: Array.from({ length: count }, () => blankSet()),
  };
}

/**
 * Initial blocks: from a saved workout (targets + rest per line), else from an
 * explicit exercise-id list (the hub's freshest-muscle recommendation), else
 * empty (a blank sheet — add exercises as you go).
 */
function initialBlocks(routineId: string | undefined, exerciseIds: string[]): LiveBlock[] {
  if (routineId) {
    const routine = getRoutine(getDb(), routineId);
    if (routine) {
      return routine.exercises
        .map((line) => buildBlock(line.exerciseId, line.targetSets, line.restSec))
        .filter((b): b is LiveBlock => b !== null);
    }
  }
  return exerciseIds.map((id) => buildBlock(id, 3, null)).filter((b): b is LiveBlock => b !== null);
}

export default function WorkoutLiveScreen() {
  const params = useLocalSearchParams<{
    routineId?: string | string[];
    name?: string;
    exerciseIds?: string | string[];
  }>();
  const routineId = Array.isArray(params.routineId) ? params.routineId[0] : params.routineId;
  const seedName = Array.isArray(params.name) ? params.name[0] : params.name;
  const idsParam = Array.isArray(params.exerciseIds) ? params.exerciseIds[0] : params.exerciseIds;
  const exerciseIds = idsParam ? idsParam.split(',').filter(Boolean) : [];
  return <WorkoutLive routineId={routineId} seedName={seedName} exerciseIds={exerciseIds} />;
}

function WorkoutLive({
  routineId,
  seedName,
  exerciseIds,
}: {
  routineId?: string;
  seedName?: string;
  exerciseIds: string[];
}) {
  const router = useRouter();
  const navigation = useNavigation();
  const { units } = useUnitPreferences();
  const spec = useMemo(() => weightSpec(units), [units]);

  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  const [name, setName] = useState(seedName ?? '');
  const [blocks, setBlocks] = useState<LiveBlock[]>(() => initialBlocks(routineId, exerciseIds));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [restEndsAt, setRestEndsAt] = useState<number | null>(null);
  // The id of the pending OS rest-alert (to cancel/replace it). null when none.
  const restNotifId = useRef<string | null>(null);
  const savedRef = useRef(false);

  /** Arm a fresh OS rest alert `seconds` out, cancelling any pending one. */
  const armRestAlert = (seconds: number) => {
    void cancelRestAlert(restNotifId.current);
    restNotifId.current = null;
    void scheduleRestAlert(seconds).then((id) => {
      restNotifId.current = id;
    });
  };
  const disarmRestAlert = () => {
    void cancelRestAlert(restNotifId.current);
    restNotifId.current = null;
  };

  // One-second tick drives the elapsed clock + rest countdown (same pattern as
  // app/workout-log.tsx). Foreground only; both are computed from timestamps, so
  // they stay correct across a background/foreground cycle.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const restRemaining =
    restEndsAt == null ? null : Math.max(0, Math.round((restEndsAt - now) / 1000));

  const hasData = blocks.some((b) =>
    b.sets.some((s) => s.done || s.reps !== '' || s.weight !== '')
  );
  const canFinish = name.trim() !== '' && hasData;

  // Guard an accidental back from vaporising an unsaved workout.
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (savedRef.current || (!hasData && name.trim() === '')) return;
      e.preventDefault();
      Alert.alert('Discard this workout?', 'Nothing has been saved yet.', [
        { text: 'Keep logging', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => navigation.dispatch(e.data.action),
        },
      ]);
    });
    return unsub;
  }, [navigation, hasData, name]);

  const patchSet = (blockKey: number, setKey: number, patch: Partial<Omit<LiveSet, 'key'>>) => {
    setBlocks((prev) =>
      prev.map((b) =>
        b.key !== blockKey
          ? b
          : { ...b, sets: b.sets.map((s) => (s.key === setKey ? { ...s, ...patch } : s)) }
      )
    );
  };

  const addSet = (blockKey: number) => {
    setBlocks((prev) =>
      prev.map((b) =>
        b.key !== blockKey ? b : { ...b, sets: [...b.sets, blankSet(b.sets[b.sets.length - 1])] }
      )
    );
  };

  const removeSet = (blockKey: number, setKey: number) => {
    setBlocks((prev) =>
      prev.map((b) =>
        b.key !== blockKey ? b : { ...b, sets: b.sets.filter((s) => s.key !== setKey) }
      )
    );
  };

  const cycleSetType = (blockKey: number, setKey: number, current: SetType) => {
    const next = SET_TYPES[(SET_TYPES.indexOf(current) + 1) % SET_TYPES.length]!;
    patchSet(blockKey, setKey, { setType: next });
  };

  const addExercise = (exerciseId: string) => {
    const block = buildBlock(exerciseId, 1, null);
    if (block) setBlocks((prev) => [...prev, block]);
  };

  const removeBlock = (blockKey: number) =>
    setBlocks((prev) => prev.filter((b) => b.key !== blockKey));

  /** Group / ungroup a block with the one below it into a superset. */
  const toggleLink = (blockKey: number) => {
    setBlocks((prev) =>
      prev.map((b) => (b.key === blockKey ? { ...b, linkedToNext: !b.linkedToNext } : b))
    );
  };

  /** Toggle a set done; on completion start rest + tag a PR if it beats best e1RM. */
  const toggleDone = (block: LiveBlock, set: LiveSet) => {
    const done = !set.done;
    let pr = set.pr;
    if (done && WEIGHT_LOGGING.has(block.loggingType)) {
      const weightKg = set.weight.trim() === '' ? null : toCanonicalKg(Number(set.weight), units);
      const reps = set.reps.trim() === '' ? null : Number(set.reps);
      const rpe = set.rpe.trim() === '' ? null : Number(set.rpe);
      const e = e1rmForSet(weightKg, reps, rpe, set.setType);
      if (e != null && (block.bestE1rm == null || e > block.bestE1rm + 1e-6)) {
        pr = true;
        // Raise the bar so only the first record-crossing set this session tags.
        setBlocks((prev) => prev.map((b) => (b.key === block.key ? { ...b, bestE1rm: e } : b)));
      }
    }
    patchSet(block.key, set.key, { done, pr: done ? pr : false });
    if (done && block.restSec && block.restSec > 0) {
      setRestEndsAt(Date.now() + block.restSec * 1000);
      armRestAlert(block.restSec);
    }
  };

  const bumpRest = (delta: number) => {
    if (restEndsAt == null) return;
    const next = restEndsAt + delta * 1000;
    setRestEndsAt(next);
    armRestAlert(Math.max(1, Math.round((next - Date.now()) / 1000)));
  };

  const dismissRest = () => {
    setRestEndsAt(null);
    disarmRestAlert();
  };

  const finish = () => {
    if (savedRef.current || !canFinish) return;
    const groups = supersetGroups(blocks);
    const sets = blocks.flatMap((b, bi) =>
      b.sets
        .filter((s) => s.done || s.reps.trim() !== '' || s.weight.trim() !== '')
        .map((s) => {
          const reps = s.reps.trim() === '' ? null : Number(s.reps);
          const weightKg = s.weight.trim() === '' ? null : toCanonicalKg(Number(s.weight), units);
          const rpe = s.rpe.trim() === '' ? null : Number(s.rpe);
          return {
            exercise: b.name,
            exerciseId: b.exerciseId,
            reps: reps != null && Number.isFinite(reps) ? Math.round(reps) : null,
            weightKg: weightKg != null && Number.isFinite(weightKg) ? weightKg : null,
            rpe: rpe != null && Number.isFinite(rpe) ? rpe : null,
            setType: s.setType,
            supersetGroup: groups[bi],
          };
        })
    );
    const durationMin = Math.round((Date.now() - startedAt) / 60_000);
    try {
      const db = getDb();
      logWorkout(
        db,
        {
          date: todayISODate(),
          name: name.trim(),
          kind: 'strength',
          durationMin: durationMin > 0 ? durationMin : null,
          routineId: routineId ?? null,
        },
        sets
      );
      if (routineId) touchRoutineStarted(db, routineId, new Date().toISOString());
      disarmRestAlert();
      savedRef.current = true;
      router.back();
    } catch (error) {
      console.warn('[exercise] live workout save failed', error);
      Alert.alert('Save failed', 'Nothing was changed. Please try again.');
    }
  };

  // Cancel any pending OS rest alert if the screen is left without finishing.
  useEffect(() => () => void cancelRestAlert(restNotifId.current), []);

  // Superset group per block, derived from the linked-to-next flags.
  const groups = supersetGroups(blocks);

  return (
    <Screen>
      <ScrollView
        className="-mx-5 flex-1"
        contentContainerClassName="grow px-5 pb-10"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets>
        <View className="pt-2">
          <StackHeader title="Workout" />
        </View>

        {/* Elapsed — a measurement, so mono; its caption is the label voice. */}
        <View className="mt-2 flex-row items-baseline gap-2">
          <Text className="font-mono text-2xl text-ink">
            {formatClock((now - startedAt) / 1000)}
          </Text>
          <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
            elapsed
          </Text>
        </View>

        {/* Session name — recessed stock: you write into it. */}
        <View className="mt-2 min-h-[44px] justify-center border border-paper-deep bg-paper-dim px-3.5">
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Session name — Upper A…"
            placeholderTextColor={palette.inkMuted}
            className="py-2.5 font-serif text-[15px] text-ink"
            accessibilityLabel="Session name"
          />
        </View>

        {/*
          Exercise blocks — one ruled plate per exercise, and THE BIND for
          supersets (owner ask, 2026-08-11: "really join the two together").

          Linking two exercises doesn't decorate them — it makes them ONE
          object. The lower plate springs upward until the two plates' facing
          borders overlap into a single shared rule (marginTop 20 → −1, a
          Reanimated layout spring — the plates visibly snap together), and a
          small SUPERSET seam chip stamps into the fused joint with a spring
          overshoot, the way a press stamp lands on a ledger seam. Tapping the
          seam splits the plates apart again (the same spring, reversed; the
          chip fades). This is the joining drawn with the system's own
          vocabulary — plates, one rule, the label voice — no new chrome, no
          lone strokes (the left rule the 2026-08-10 sweep cut stays cut).

          When a block is NOT linked to the one below, the quiet link affordance
          sits in the gap, as before.
        */}
        {blocks.length === 0 ? (
          <Text className="mt-8 font-serif text-[14px] leading-6 text-ink-secondary">
            Nothing logged yet. Add the first exercise to start recording sets.
          </Text>
        ) : (
          <View className="mt-6">
            {blocks.map((block, bi) => {
              const linkedAbove = bi > 0 && groups[bi] != null && groups[bi] === groups[bi - 1];
              return (
                <Animated.View
                  key={block.key}
                  layout={BIND_SPRING}
                  style={bi === 0 ? undefined : { marginTop: linkedAbove ? -1 : 20 }}>
                  {linkedAbove ? (
                    <SupersetSeam onPress={() => toggleLink(blocks[bi - 1]!.key)} />
                  ) : null}
                  <ExerciseBlock
                    block={block}
                    units={units}
                    spec={spec}
                    onPatch={patchSet}
                    onAddSet={addSet}
                    onRemoveSet={removeSet}
                    onCycleType={cycleSetType}
                    onToggleDone={toggleDone}
                    onRemove={removeBlock}
                    onOpenDetail={() =>
                      router.push({
                        pathname: '/exercise-detail',
                        params: { id: block.exerciseId },
                      })
                    }
                  />
                  {bi < blocks.length - 1 && !block.linkedToNext ? (
                    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Superset ${block.name} with the next exercise`}
                        onPress={() => toggleLink(block.key)}
                        className="mt-1 min-h-[40px] flex-row items-center justify-center gap-1.5 active:opacity-60">
                        <Ionicons name="link-outline" size={14} color={palette.inkMuted} />
                        <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                          Superset with next
                        </Text>
                      </Pressable>
                    </Animated.View>
                  ) : null}
                </Animated.View>
              );
            })}
          </View>
        )}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add exercise"
          onPress={() => setPickerOpen(true)}
          className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
          <Ionicons name="add" size={17} color={palette.inkSecondary} />
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
            Add exercise
          </Text>
        </Pressable>

        {/*
          The one primary action on this screen. Disabled reads as an unfilled
          outline rather than a filled grey: muted ink on the sheet clears 4.5:1,
          where muted ink on a hairline fill does not.
        */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Finish workout"
          accessibilityState={{ disabled: !canFinish }}
          disabled={!canFinish}
          onPress={finish}
          className={`mt-8 h-12 items-center justify-center rounded-btn ${
            canFinish ? 'bg-pine active:opacity-70' : 'border border-hairline'
          }`}>
          <Text
            className={`font-label text-[15px] font-semibold ${
              canFinish ? 'text-pine-on' : 'text-ink-muted'
            }`}>
            Finish workout
          </Text>
        </Pressable>
      </ScrollView>

      {/* Rest timer — a quiet docked line, no modal, no glow. Foreground only. */}
      {restRemaining != null ? (
        <View className="absolute inset-x-0 bottom-0 bg-paper-hi">
          {/* The bar's top edge. A `border-t` here would draw all four sides —
              see Divider's docblock — so the edge is a filled 1px view, and it
              sits outside the bar's padding so it spans the full width. */}
          <Divider />
          <View className="flex-row items-center gap-3 px-5 py-3">
            <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
              Rest
            </Text>
            <Text className="font-mono text-lg text-ink">{formatClock(restRemaining)}</Text>
            <View className="flex-1" />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Subtract 15 seconds"
              onPress={() => bumpRest(-15)}
              hitSlop={8}
              className="min-h-[32px] justify-center rounded-btn border border-hairline px-2.5 active:bg-paper-dim">
              <Text className="font-mono text-[12px] text-ink-secondary">−15</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add 15 seconds"
              onPress={() => bumpRest(15)}
              hitSlop={8}
              className="min-h-[32px] justify-center rounded-btn border border-hairline px-2.5 active:bg-paper-dim">
              <Text className="font-mono text-[12px] text-ink-secondary">+15</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss rest timer"
              onPress={dismissRest}
              hitSlop={8}
              className="h-8 w-8 items-center justify-center active:opacity-60">
              <Ionicons name="close" size={16} color={palette.inkMuted} />
            </Pressable>
          </View>
        </View>
      ) : null}

      <ExercisePicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(ex) => addExercise(ex.id)}
      />
    </Screen>
  );
}

/**
 * One exercise = one **ruled plate**. The title line, the column header rule and
 * the set rows all live on the same plate, because they are one record: a set
 * table is the most literal "a record is a table" surface in ARC.
 *
 * The block carries no device of its own beyond that plate, and nothing is drawn
 * around it: the superset left rule was cut on 2026-08-10 (see the call site).
 */
function ExerciseBlock({
  block,
  units,
  spec,
  onPatch,
  onAddSet,
  onRemoveSet,
  onCycleType,
  onToggleDone,
  onRemove,
  onOpenDetail,
}: {
  block: LiveBlock;
  units: UnitPreferences;
  spec: ReturnType<typeof weightSpec>;
  onPatch: (bk: number, sk: number, patch: Partial<Omit<LiveSet, 'key'>>) => void;
  onAddSet: (bk: number) => void;
  onRemoveSet: (bk: number, sk: number) => void;
  onCycleType: (bk: number, sk: number, cur: SetType) => void;
  onToggleDone: (block: LiveBlock, set: LiveSet) => void;
  onRemove: (bk: number) => void;
  onOpenDetail: () => void;
}) {
  const showWeight = WEIGHT_LOGGING.has(block.loggingType);
  return (
    // Superset grouping is drawn by THE BIND at the call site (fused plates +
    // the seam chip), not by anything on the block itself. The old left rule
    // was cut 2026-08-10 (a lone vertical stroke — the same mark the `margin`
    // device lost); the old "Superset" eyebrow above the first block moved into
    // the seam chip, which names the group at the joint it actually joins.
    <View>
      <Block device="plate">
        <View className="flex-row items-center gap-2">
          {/* The title is the door to the movement's detail — history, trend,
              records, and how it looks — for the mid-session "how does this
              one go again?" (2026-08-11). */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${block.name}. Open history, records and form.`}
            onPress={onOpenDetail}
            hitSlop={6}
            className="flex-1 flex-row items-center gap-1.5 active:opacity-60">
            <Text className="shrink font-serif text-[16px] font-semibold text-ink">
              {block.name}
            </Text>
            <Ionicons name="chevron-forward" size={13} color={palette.inkMuted} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${block.name}`}
            onPress={() => onRemove(block.key)}
            hitSlop={10}
            className="h-8 w-8 items-center justify-center active:opacity-60">
            <Ionicons name="close" size={16} color={palette.inkMuted} />
          </Pressable>
        </View>

        {/* Column header — the label voice, closed by the rule beneath it. */}
        <View className="mt-1.5 flex-row items-center gap-1.5 pb-1.5">
          <Text className="w-7 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            Set
          </Text>
          <Text className="w-16 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            Prev
          </Text>
          {showWeight ? (
            <Text className="flex-1 text-center font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
              {spec.unit}
            </Text>
          ) : null}
          <Text className="flex-1 text-center font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            Reps
          </Text>
          <Text className="w-12 text-center font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            RPE
          </Text>
          <View className="w-8" />
        </View>
        {/* The rule that closes the column header. Drawn, not bordered — a
            `border-b` here is the same four-sided trap as `border-t`. */}
        <Divider />

        {block.sets.map((set, i) => {
          const prev = block.prev[i];
          const prevText = prev
            ? `${prev.reps ?? '—'}${prev.weightKg != null ? `×${displayWeight(prev.weightKg, units)}` : ''}`
            : '—';
          const tag = setTypeTag(set.setType);
          return (
            <View key={set.key}>
              <Divider first={i === 0} />
              <View className="flex-row items-center gap-1.5 py-1.5">
                {/* Set number / type tag */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Set ${i + 1} type: ${set.setType}. Tap to change.`}
                  onPress={() => onCycleType(block.key, set.key, set.setType)}
                  hitSlop={10}
                  className="h-8 w-7 items-center justify-center active:opacity-60">
                  <Text className="font-mono text-[12px] text-ink-secondary">{tag || i + 1}</Text>
                </Pressable>

                <Text className="w-16 font-mono text-[11px] text-ink-muted" numberOfLines={1}>
                  {prevText}
                </Text>

                {showWeight ? (
                  <View className={`min-h-[36px] flex-1 ${INPUT_WELL}`}>
                    <TextInput
                      value={set.weight}
                      onChangeText={(weight) => onPatch(block.key, set.key, { weight })}
                      placeholder={
                        prev?.weightKg != null ? String(displayWeight(prev.weightKg, units)) : '—'
                      }
                      placeholderTextColor={palette.inkMuted}
                      keyboardType="decimal-pad"
                      className="py-1.5 text-center font-mono text-[15px] text-ink"
                      accessibilityLabel={`Weight for set ${i + 1}`}
                    />
                  </View>
                ) : null}

                <View className={`min-h-[36px] flex-1 ${INPUT_WELL}`}>
                  <TextInput
                    value={set.reps}
                    onChangeText={(reps) => onPatch(block.key, set.key, { reps })}
                    placeholder={prev?.reps != null ? String(prev.reps) : '—'}
                    placeholderTextColor={palette.inkMuted}
                    keyboardType="number-pad"
                    className="py-1.5 text-center font-mono text-[15px] text-ink"
                    accessibilityLabel={`Reps for set ${i + 1}`}
                  />
                </View>

                <View className={`min-h-[36px] w-12 ${INPUT_WELL}`}>
                  <TextInput
                    value={set.rpe}
                    onChangeText={(rpe) => onPatch(block.key, set.key, { rpe })}
                    placeholder="—"
                    placeholderTextColor={palette.inkMuted}
                    keyboardType="decimal-pad"
                    className="py-1.5 text-center font-mono text-[13px] text-ink"
                    accessibilityLabel={`RPE for set ${i + 1}`}
                  />
                </View>

                {/*
                The completion stamp. Chrome, not biology — so it is the accent
                and never a signal green (the firewall, 00-design-spec.md §2).
              */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ checked: set.done }}
                  accessibilityLabel={`Mark set ${i + 1} ${set.done ? 'incomplete' : 'complete'}`}
                  onPress={() => onToggleDone(block, set)}
                  onLongPress={() => onRemoveSet(block.key, set.key)}
                  hitSlop={8}
                  className={`h-8 w-8 items-center justify-center border ${
                    set.done ? 'border-pine bg-pine' : 'border-hairline'
                  } active:opacity-70`}>
                  <Ionicons
                    name="checkmark"
                    size={16}
                    color={set.done ? palette.pineOn : palette.hairline}
                  />
                </Pressable>
              </View>
            </View>
          );
        })}

        {/* PR marker + add set */}
        <Divider />
        <View className="flex-row items-center gap-2 pt-1.5">
          {block.sets.some((s) => s.pr) ? (
            <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
              PR
            </Text>
          ) : null}
          <View className="flex-1" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Add a set to ${block.name}`}
            onPress={() => onAddSet(block.key)}
            hitSlop={8}
            className="min-h-[32px] flex-row items-center gap-1 active:opacity-60">
            <Ionicons name="add" size={15} color={palette.inkSecondary} />
            <Text className="font-label text-[11px] font-semibold uppercase tracking-[1px] text-ink-secondary">
              Add set
            </Text>
          </Pressable>
        </View>
      </Block>
    </View>
  );
}
