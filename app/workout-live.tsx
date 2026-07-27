import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { ExercisePicker } from '@/components/exercise/exercise-picker';
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
import { useUnitPreferences } from '@/hooks/use-unit-preferences';
import type { UnitPreferences } from '@/lib/user/types';

/**
 * The structured live workout logger (docs/exercise-subapp.md §2), pushed from
 * the Exercise hub — the FitBod/Hevy-style set grid restated in Porcelain
 * Ledger. Exercise blocks; each set row shows the previous session's numbers as
 * placeholders, a mono weight/reps/RPE entry, and a pine completion check that
 * starts the rest timer and stamps a PR when the set beats the best e1RM to
 * date. Weight is entered in the user's unit and stored canonical kg. The one
 * pine action is Finish. The free-form quick logger (app/workout-log.tsx) stays
 * for cardio / mobility / past sessions.
 *
 * FLAG (native, deferred): the rest timer is foreground-only. Background
 * delivery (a notification at zero) needs expo-notifications and a dev rebuild.
 * It counts from a target instant, so it stays correct across backgrounding —
 * it just can't alert while the app is closed.
 */

const SET_TYPES: SetType[] = ['normal', 'warmup', 'failure', 'drop'];

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
  sets: LiveSet[];
};

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
    sets: Array.from({ length: count }, () => blankSet()),
  };
}

/**
 * Initial blocks: from a routine (targets + rest per line), else from an
 * explicit exercise-id list (the hub's freshest-muscle recommendation), else
 * empty (free-form — add exercises as you go).
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
  const savedRef = useRef(false);

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
    if (done && block.restSec && block.restSec > 0)
      setRestEndsAt(Date.now() + block.restSec * 1000);
  };

  const bumpRest = (delta: number) => {
    setRestEndsAt((end) => (end == null ? null : end + delta * 1000));
  };

  const finish = () => {
    if (savedRef.current || !canFinish) return;
    const sets = blocks.flatMap((b) =>
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
      savedRef.current = true;
      router.back();
    } catch (error) {
      console.warn('[exercise] live workout save failed', error);
      Alert.alert('Save failed', 'Nothing was changed. Please try again.');
    }
  };

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

        {/* Session name + elapsed */}
        <View className="mt-2 flex-row items-baseline gap-2">
          <Text className="font-mono text-2xl text-ink">
            {formatClock((now - startedAt) / 1000)}
          </Text>
          <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">elapsed</Text>
        </View>
        <View className="mt-2 min-h-[44px] justify-center rounded-btn border border-hairline-soft bg-paper-deep px-3.5">
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Session name — Upper A…"
            placeholderTextColor={palette.inkMuted}
            className="py-2.5 text-[15px] text-ink"
            accessibilityLabel="Session name"
          />
        </View>

        {/* Exercise blocks */}
        {blocks.length === 0 ? (
          <Text className="mt-8 text-[13px] leading-5 text-ink-muted">
            Add the first exercise to start logging sets.
          </Text>
        ) : (
          <View className="mt-6 gap-6">
            {blocks.map((block) => (
              <ExerciseBlock
                key={block.key}
                block={block}
                units={units}
                spec={spec}
                onPatch={patchSet}
                onAddSet={addSet}
                onRemoveSet={removeSet}
                onCycleType={cycleSetType}
                onToggleDone={toggleDone}
                onRemove={removeBlock}
              />
            ))}
          </View>
        )}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add exercise"
          onPress={() => setPickerOpen(true)}
          className="mt-4 h-11 flex-row items-center justify-center gap-2 rounded-btn border border-hairline-strong active:bg-paper-deep">
          <Ionicons name="add" size={17} color={palette.inkSecondary} />
          <Text className="text-[13px] font-medium text-ink">Add exercise</Text>
        </Pressable>

        {/* The one pine action on this screen. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Finish workout"
          accessibilityState={{ disabled: !canFinish }}
          disabled={!canFinish}
          onPress={finish}
          className={`mt-8 h-12 items-center justify-center rounded-btn ${
            canFinish ? 'bg-pine active:opacity-70' : 'bg-hairline'
          }`}>
          <Text
            className={`text-[15px] font-semibold ${canFinish ? 'text-pine-on' : 'text-ink-muted'}`}>
            Finish workout
          </Text>
        </Pressable>
      </ScrollView>

      {/* Rest timer — a quiet docked line, no modal, no glow. Foreground only. */}
      {restRemaining != null ? (
        <View className="absolute inset-x-0 bottom-0 flex-row items-center gap-3 border-t border-hairline bg-porcelain px-5 py-3">
          <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">Rest</Text>
          <Text className="font-mono text-lg text-ink">{formatClock(restRemaining)}</Text>
          <View className="flex-1" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Subtract 15 seconds"
            onPress={() => bumpRest(-15)}
            className="rounded-btn border border-hairline-strong px-2.5 py-1 active:bg-paper-deep">
            <Text className="font-mono text-[12px] text-ink-secondary">−15</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add 15 seconds"
            onPress={() => bumpRest(15)}
            className="rounded-btn border border-hairline-strong px-2.5 py-1 active:bg-paper-deep">
            <Text className="font-mono text-[12px] text-ink-secondary">+15</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss rest timer"
            onPress={() => setRestEndsAt(null)}
            className="h-8 w-8 items-center justify-center rounded-btn active:bg-paper-deep">
            <Ionicons name="close" size={16} color={palette.inkMuted} />
          </Pressable>
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
}) {
  const showWeight = WEIGHT_LOGGING.has(block.loggingType);
  return (
    <View>
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 font-serif text-[16px] font-semibold text-ink">{block.name}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${block.name}`}
          onPress={() => onRemove(block.key)}
          className="h-8 w-8 items-center justify-center rounded-btn active:bg-paper-deep">
          <Ionicons name="close" size={16} color={palette.inkMuted} />
        </Pressable>
      </View>

      {/* Column header */}
      <View className="mt-2 flex-row items-center gap-2 px-1">
        <Text className="w-7 text-[9.5px] uppercase tracking-[1px] text-ink-muted">Set</Text>
        <Text className="w-16 text-[9.5px] uppercase tracking-[1px] text-ink-muted">Prev</Text>
        {showWeight ? (
          <Text className="flex-1 text-center text-[9.5px] uppercase tracking-[1px] text-ink-muted">
            {spec.unit}
          </Text>
        ) : null}
        <Text className="flex-1 text-center text-[9.5px] uppercase tracking-[1px] text-ink-muted">
          Reps
        </Text>
        <Text className="w-12 text-center text-[9.5px] uppercase tracking-[1px] text-ink-muted">
          RPE
        </Text>
        <View className="w-8" />
      </View>

      <View className="mt-1 rounded-card border border-hairline bg-porcelain">
        {block.sets.map((set, i) => {
          const prev = block.prev[i];
          const prevText = prev
            ? `${prev.reps ?? '—'}${prev.weightKg != null ? `×${displayWeight(prev.weightKg, units)}` : ''}`
            : '—';
          const tag = setTypeTag(set.setType);
          return (
            <View
              key={set.key}
              className={`flex-row items-center gap-2 px-2.5 py-2 ${
                i === 0 ? '' : 'border-t border-hairline-soft'
              }`}>
              {/* Set number / type tag */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Set ${i + 1} type: ${set.setType}. Tap to change.`}
                onPress={() => onCycleType(block.key, set.key, set.setType)}
                className="h-7 w-7 items-center justify-center rounded-btn active:bg-paper-deep">
                <Text className="font-mono text-[12px] text-ink-secondary">{tag || i + 1}</Text>
              </Pressable>

              <Text className="w-16 font-mono text-[11px] text-ink-muted" numberOfLines={1}>
                {prevText}
              </Text>

              {showWeight ? (
                <View className="min-h-[36px] flex-1 justify-center rounded-btn border border-hairline-soft bg-paper-deep px-1">
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

              <View className="min-h-[36px] flex-1 justify-center rounded-btn border border-hairline-soft bg-paper-deep px-1">
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

              <View className="min-h-[36px] w-12 justify-center rounded-btn border border-hairline-soft bg-paper-deep px-1">
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

              {/* Complete (pine when done) */}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ checked: set.done }}
                accessibilityLabel={`Mark set ${i + 1} ${set.done ? 'incomplete' : 'complete'}`}
                onPress={() => onToggleDone(block, set)}
                onLongPress={() => onRemoveSet(block.key, set.key)}
                className={`h-8 w-8 items-center justify-center rounded-btn border ${
                  set.done ? 'border-pine bg-pine' : 'border-hairline-strong'
                } active:opacity-70`}>
                <Ionicons
                  name="checkmark"
                  size={16}
                  color={set.done ? palette.pineOn : palette.hairlineStrong}
                />
              </Pressable>
            </View>
          );
        })}

        {/* PR line + add set */}
        <View className="flex-row items-center gap-2 border-t border-hairline-soft px-2.5 py-2">
          {block.sets.some((s) => s.pr) ? (
            <Text className="font-mono text-[10px] uppercase tracking-[1px] text-ink-secondary">
              PR
            </Text>
          ) : null}
          <View className="flex-1" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Add a set to ${block.name}`}
            onPress={() => onAddSet(block.key)}
            className="flex-row items-center gap-1 rounded-btn px-2 py-1 active:bg-paper-deep">
            <Ionicons name="add" size={15} color={palette.inkSecondary} />
            <Text className="text-[12px] font-medium text-ink-secondary">Add set</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
