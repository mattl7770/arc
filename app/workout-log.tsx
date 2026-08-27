import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { KEYPAD_DONE } from '@/components/ui/keyboard';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { logWorkout } from '@/lib/db/repositories/exercise';
import { lbToKg, setLine } from '@/lib/exercise/format';
import type { WorkoutKind } from '@/lib/exercise/types';

/**
 * The workout logger, pushed from the Exercise screen in two modes:
 *
 *   - `live` ("Start a workout") — the clock starts on mount; sets are added as
 *     they happen and Finish stamps the elapsed duration.
 *   - `past` ("Log a past session") — duration is typed instead; the session
 *     still lands on today (backdating arrives with the workout builder), and
 *     the screen says so.
 *
 * Either way one save writes the session and its sets in a single transaction
 * (src/lib/db/repositories/exercise.ts). Set weight is entered in lb — the
 * app's display unit today — and stored canonical kg.
 *
 * ## The surface system (00-design-spec.md §1)
 *
 *   Drafted sets   plate   a record is a table, so the set list is ruled
 *   Entry caveats  margin  the "what saves and what doesn't" annotation
 *
 * Everything else here is form chrome: entry fields are recessed stock styled
 * inline, exactly as in app/workout-live.tsx, because an input is not a content
 * block and does not take a device of its own. Every reps/weight/duration value
 * is mono — serif speaks, mono measures.
 *
 * **Accent budget: one.** The Finish/Save button, and nothing else.
 */
const KINDS: { key: WorkoutKind; label: string }[] = [
  { key: 'strength', label: 'Strength' },
  { key: 'cardio', label: 'Cardio' },
  { key: 'mobility', label: 'Mobility' },
  { key: 'other', label: 'Other' },
];

/** One set as drafted on this screen — display units, not yet persisted. */
type DraftSet = { exercise: string; reps: number | null; weightLb: number | null };

/** "12:34", growing to "1:02:34" past the hour. */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = String(totalSec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * The recessed field every input on this screen sits in — an input well, drawn
 * inline rather than as a `<Block device="well">`: a single text field is not a
 * content block, and wrapping each one would nest devices inside the plate.
 */
function Field({ children }: { children: React.ReactNode }) {
  return (
    <View className="min-h-[44px] justify-center border border-paper-deep bg-paper-dim px-3.5">
      {children}
    </View>
  );
}

export default function WorkoutLogScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{ mode?: string }>();
  const mode: 'live' | 'past' = params.mode === 'live' ? 'live' : 'past';

  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  const [kind, setKind] = useState<WorkoutKind>('strength');
  const [durationText, setDurationText] = useState('');
  const [sets, setSets] = useState<DraftSet[]>([]);
  const [exercise, setExercise] = useState('');
  const [repsText, setRepsText] = useState('');
  const [weightText, setWeightText] = useState('');
  // True while the entry row holds something not yet in `sets` — the flag that
  // lets "leave the fields filled after Add" coexist with "a typed-but-never-
  // Added set still saves" without double-counting the last Add on save.
  const [entryDirty, setEntryDirty] = useState(false);
  const savedRef = useRef(false);

  useEffect(() => {
    if (mode !== 'live') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [mode]);

  // Draft-set validation: blank reps/weight are fine (a bodyweight movement, a
  // timed carry); a non-blank value must be a sane number. The weight cap keeps
  // the canonical kg under the schema's < 1000 kg fat-finger CHECK.
  const reps = repsText === '' ? null : Number(repsText);
  const weightLb = weightText === '' ? null : Number(weightText);
  const repsValid = reps === null || (Number.isInteger(reps) && reps >= 0 && reps < 10000);
  const weightValid =
    weightLb === null || (Number.isFinite(weightLb) && weightLb > 0 && weightLb < 2000);
  const canAddSet = exercise.trim().length > 0 && repsValid && weightValid;

  const entryBlank = exercise.trim() === '' && repsText === '' && weightText === '';
  // Typed something new that can't be saved as a set? Block Save rather than
  // silently dropping it — losing a typed set is worse than a disabled button.
  const entryBlocking = entryDirty && !entryBlank && !canAddSet;

  const duration = durationText === '' ? null : Number(durationText);
  const durationValid =
    duration === null || (Number.isFinite(duration) && duration > 0 && duration < 1000);
  // No name is required any more (owner, 2026-08-14) — a session is savable
  // once it has either a set or a duration. An empty form still can't save,
  // which is the only thing the name requirement was really doing.
  const hasSubstance = sets.length > 0 || (entryDirty && canAddSet) || duration != null;
  const canSave = hasSubstance && (mode === 'live' || durationValid) && !entryBlocking;

  const changeExercise = (t: string) => {
    setExercise(t);
    setEntryDirty(true);
  };
  const changeReps = (t: string) => {
    setRepsText(t);
    setEntryDirty(true);
  };
  const changeWeight = (t: string) => {
    setWeightText(t);
    setEntryDirty(true);
  };

  // Straight sets are the common case, so Add keeps every field as-is — tap
  // Add again for the next identical set, or retype what changed. The dirty
  // flag drops so the leftover values aren't re-saved as a phantom set.
  const addDraftSet = () => {
    if (!canAddSet) return;
    setSets((prev) => [...prev, { exercise: exercise.trim(), reps, weightLb }]);
    setEntryDirty(false);
  };

  const removeDraftSet = (index: number) => {
    setSets((prev) => prev.filter((_, i) => i !== index));
  };

  // An accidental back tap must not vaporise a logged workout: if anything is
  // drafted and unsaved, confirm before leaving. savedRef lets the post-save
  // router.back() through without re-prompting.
  const hasDraft = sets.length > 0 || !entryBlank || durationText !== '';
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      if (savedRef.current || !hasDraft) return;
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
    return unsubscribe;
  }, [navigation, hasDraft]);

  const save = () => {
    if (!canSave) return;
    // A valid entry row the user never tapped "Add set" on still counts — the
    // one-set session shouldn't require both buttons. Only a DIRTY row though:
    // after an Add the fields keep their values, and re-saving those would
    // double-count the last set.
    const pending = entryDirty && canAddSet ? [{ exercise: exercise.trim(), reps, weightLb }] : [];
    const allSets = [...sets, ...pending];
    // A sub-30-second "session" rounds to 0 — store no duration rather than a
    // lying "0 min".
    const elapsedMin = Math.round((Date.now() - startedAt) / 60_000);
    const durationMin = mode === 'live' ? (elapsedMin > 0 ? elapsedMin : null) : duration;
    try {
      logWorkout(
        getDb(),
        // No name — workouts don't have them (owner, 2026-08-14). The
        // repository writes '' into the dormant NOT NULL column.
        { date: todayISODate(), kind, durationMin },
        allSets.map((s) => ({
          exercise: s.exercise,
          reps: s.reps,
          weightKg: s.weightLb == null ? null : lbToKg(s.weightLb),
        }))
      );
      savedRef.current = true;
      router.back();
    } catch (error) {
      // A failed write must not crash the tap handler; the draft stays on
      // screen so nothing is lost.
      console.warn('[exercise] session save failed', error);
    }
  };

  return (
    <Screen>
      {/* Own ScrollView (mirroring Screen's scroll variant) so the keyboard
          insets adjust — five system-keyboard inputs live here, and the save
          button must stay reachable while typing. */}
      <ScrollView
        className="-mx-5 flex-1"
        contentContainerClassName="grow px-5 pb-10"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets>
        <View className="pt-2">
          <StackHeader title={mode === 'live' ? 'Workout' : 'Log a session'} />
        </View>

        {/* Session */}
        <View className="mt-3">
          <SectionLabel label="Session" />
          {mode === 'live' ? (
            <View className="mt-2 flex-row items-baseline gap-2">
              <Text className="font-mono text-2xl text-ink">{formatElapsed(now - startedAt)}</Text>
              <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                elapsed
              </Text>
            </View>
          ) : null}
          {/* The session-name field stood here until 2026-08-14. Owner:
              *"Workouts dont need names, remove this."* Kind is the first thing
              asked now, which is also the only thing about a session that has to
              be declared rather than derived. */}
          <View className="mt-2 flex-row flex-wrap gap-2">
            {KINDS.map((k) => {
              const on = k.key === kind;
              return (
                <Pressable
                  key={k.key}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => setKind(k.key)}
                  // 44pt floor (§4), matching FilterChip in
                  // src/components/exercise/exercise-picker.tsx.
                  className={`min-h-[44px] justify-center rounded-btn border px-3 ${
                    on ? 'border-hairline bg-paper-dim' : 'border-hairline'
                  }`}>
                  <Text
                    className={`font-label text-[11px] uppercase tracking-[1px] ${
                      on ? 'font-semibold text-ink' : 'text-ink-muted'
                    }`}>
                    {k.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {mode === 'past' ? (
            <>
              <View className="mt-2 flex-row items-center gap-2">
                <View className="w-28">
                  <Field>
                    <TextInput
                      value={durationText}
                      onChangeText={setDurationText}
                      placeholder="45"
                      placeholderTextColor={palette.inkMuted}
                      keyboardType="decimal-pad"
                      returnKeyType={KEYPAD_DONE}
                      className="py-2.5 font-mono text-[15px] text-ink"
                      accessibilityLabel="Duration in minutes"
                    />
                  </Field>
                </View>
                <Text className="font-label text-[11px] uppercase tracking-[1px] text-ink-muted">
                  {durationValid ? 'min' : 'min — that looks off'}
                </Text>
              </View>
              <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                Saved to today — backdating lands with the workout builder.
              </Text>
            </>
          ) : null}
        </View>

        {/* Sets — a record is a table, so the drafted list is a ruled plate,
            drawn whether or not a set has been added yet. This screen always
            opens empty, and the plate is what says the draft record goes here.
            (The sweep of 2026-08-10 made it conditional; reverted at the
            owner's instruction.) */}
        <View className="mt-7">
          <Block device="plate">
            <SectionLabel
              label="Sets"
              note={sets.length > 0 ? `${sets.length} drafted` : undefined}
            />

            {sets.length === 0 ? (
              <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                Nothing drafted yet. Add sets below — or save a session with none, for cardio and
                mobility work.
              </Text>
            ) : (
              <View className="mt-1">
                {sets.map((s, index) => (
                  <View key={`${index}-${s.exercise}`}>
                    <Divider first={index === 0} />
                    <View className="min-h-[44px] flex-row items-center gap-3 py-2">
                      <Text className="w-5 font-mono text-[11px] text-ink-muted">{index + 1}</Text>
                      <Text className="flex-1 font-serif text-[14px] text-ink" numberOfLines={1}>
                        {s.exercise}
                      </Text>
                      <Text className="font-mono text-[13px] text-ink-secondary">
                        {setLine(s.reps, s.weightLb)}
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove set ${index + 1}, ${s.exercise}`}
                        onPress={() => removeDraftSet(index)}
                        hitSlop={10}
                        className="-mr-1 h-8 w-8 items-center justify-center active:opacity-60">
                        <Ionicons name="close" size={16} color={palette.inkMuted} />
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </Block>

          {/* Entry row — recessed stock on the sheet, not a device. */}
          <View className="mt-2">
            <Field>
              <TextInput
                value={exercise}
                onChangeText={changeExercise}
                placeholder="Exercise — Bench press…"
                placeholderTextColor={palette.inkMuted}
                className="py-2.5 font-serif text-[15px] text-ink"
                accessibilityLabel="Exercise name"
              />
            </Field>
          </View>
          <View className="mt-2 flex-row gap-2">
            <View className="flex-1">
              <Field>
                <TextInput
                  value={repsText}
                  onChangeText={changeReps}
                  placeholder="Reps"
                  placeholderTextColor={palette.inkMuted}
                  keyboardType="number-pad"
                  returnKeyType={KEYPAD_DONE}
                  className="py-2.5 font-mono text-[15px] text-ink"
                  accessibilityLabel="Reps"
                />
              </Field>
            </View>
            <View className="flex-1">
              <Field>
                <TextInput
                  value={weightText}
                  onChangeText={changeWeight}
                  placeholder="Weight (lb)"
                  placeholderTextColor={palette.inkMuted}
                  keyboardType="decimal-pad"
                  returnKeyType={KEYPAD_DONE}
                  className="py-2.5 font-mono text-[15px] text-ink"
                  accessibilityLabel="Weight in pounds"
                />
              </Field>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add set"
              accessibilityState={{ disabled: !canAddSet }}
              disabled={!canAddSet}
              onPress={addDraftSet}
              className={`min-h-[44px] items-center justify-center rounded-btn border border-hairline px-3.5 ${
                canAddSet ? 'active:bg-paper-dim' : ''
              }`}>
              <Text
                className={`font-label text-[11px] font-semibold uppercase tracking-[1px] ${
                  canAddSet ? 'text-ink' : 'text-ink-muted'
                }`}>
                Add set
              </Text>
            </Pressable>
          </View>

          {/* What saves and what doesn't — an annotation, so: margin. */}
          <View className="mt-3">
            <Block device="margin">
              <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
                {entryBlocking
                  ? 'That set won’t save as typed — fix or clear it.'
                  : 'Reps and weight are optional — leave weight blank for bodyweight work. Stored in kg.'}
              </Text>
            </Block>
          </View>
        </View>

        {/*
          The one primary action on this screen. Disabled reads as an unfilled
          outline rather than a filled grey: muted ink on the sheet clears
          4.5:1, where muted ink on a hairline fill does not.
        */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={mode === 'live' ? 'Finish workout' : 'Save session'}
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          onPress={save}
          className={`mt-8 h-12 items-center justify-center rounded-btn ${
            canSave ? 'bg-pine active:opacity-70' : 'border border-hairline'
          }`}>
          <Text
            className={`font-label text-[15px] font-semibold ${
              canSave ? 'text-pine-on' : 'text-ink-muted'
            }`}>
            {mode === 'live' ? 'Finish workout' : 'Save session'}
          </Text>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}
