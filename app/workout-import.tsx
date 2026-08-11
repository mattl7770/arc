import Ionicons from '@expo/vector-icons/Ionicons';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { logWorkout } from '@/lib/db/repositories/exercise';
import { lbToKg } from '@/lib/exercise/format';
import {
  groundWorkoutImport,
  importWorkoutFromPhoto,
  isWorkoutImportAvailable,
  WorkoutImportUnavailableError,
  type ImportedWorkout,
} from '@/lib/exercise/import-workout';
import type { SetInput, WorkoutKind } from '@/lib/exercise/types';
import { useUnitPreferences } from '@/hooks/use-unit-preferences';

/**
 * Import a workout from a photo — a screenshot of another app's log, a
 * whiteboard, a card (docs/exercise-subapp.md). Pick the image, the Coach's
 * model client transcribes it (src/lib/exercise/import-workout.ts), the result
 * lands HERE as an editable review — nothing saves until the user confirms.
 * Saved through the same `logWorkout` as every other session, on the parsed
 * (editable, backdatable) date, so history/freshness/e1RM treat it as native.
 *
 * ## The surface system (00-design-spec.md §1)
 *
 *   Pick + note      well-tokened inputs, no device (a form is controls)
 *   Parsing          field   a status readout
 *   Review session   well-tokened inputs (date/name), kind chips
 *   Review exercises plate   one ruled set-table per exercise — the record
 *
 * The one accent is the phase's primary action (Parse, then Save).
 *
 * FLAG (native, pending rebuild): expo-image-picker joins the already-pending
 * EAS batch. Until that build ships the picker module is present in JS but its
 * native call fails — caught, with an honest message. The AI parse itself also
 * needs a configured model key (offline-except-AI).
 */

type Phase =
  { kind: 'pick' } | { kind: 'parsing' } | { kind: 'review' } | { kind: 'error'; message: string };

const KINDS: { key: WorkoutKind; label: string }[] = [
  { key: 'strength', label: 'Strength' },
  { key: 'cardio', label: 'Cardio' },
  { key: 'mobility', label: 'Mobility' },
  { key: 'other', label: 'Other' },
];

/** One set under review — display strings, unit carried from the parse. */
type ReviewSet = {
  key: number;
  reps: string;
  weight: string;
  unit: 'lb' | 'kg' | null;
  rpe: string;
};

type ReviewExercise = {
  key: number;
  name: string;
  exerciseId: string | null;
  sets: ReviewSet[];
};

let keySeq = 1;
const nextKey = () => keySeq++;

const INPUT_WELL = 'justify-center border border-paper-deep bg-paper-dim';

/** "2026-08-11" and a real calendar day (the schema GLOB alone allows 2026-99-99). */
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export default function WorkoutImportScreen() {
  const router = useRouter();
  const { units } = useUnitPreferences();
  const available = isWorkoutImportAvailable();

  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [note, setNote] = useState('');
  const [date, setDate] = useState(todayISODate());
  const [name, setName] = useState('');
  const [kind, setKind] = useState<WorkoutKind>('strength');
  const [durationText, setDurationText] = useState('');
  const [exercises, setExercises] = useState<ReviewExercise[]>([]);
  const [parseNotes, setParseNotes] = useState<string | null>(null);
  const inFlight = useRef(false);

  const toReview = (imported: ImportedWorkout) => {
    setDate(imported.date ?? todayISODate());
    setName(imported.name);
    setKind(imported.kind);
    setDurationText(imported.durationMin == null ? '' : String(Math.round(imported.durationMin)));
    setParseNotes(imported.notes);
    setExercises(
      imported.exercises.map((e) => ({
        key: nextKey(),
        name: e.name,
        exerciseId: e.exerciseId,
        sets: e.sets.map((s) => ({
          key: nextKey(),
          reps: s.reps == null ? '' : String(s.reps),
          weight: s.weight == null ? '' : String(s.weight),
          unit: s.weightUnit,
          rpe: s.rpe == null ? '' : String(s.rpe),
        })),
      }))
    );
    setPhase({ kind: 'review' });
  };

  const pickAndParse = async () => {
    try {
      // Native call — fails before the pending EAS rebuild lands; caught below.
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setPhase({
          kind: 'error',
          message: 'ARC needs photo access to read the screenshot. Allow it in iOS Settings.',
        });
        return;
      }
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
        allowsMultipleSelection: false,
      });
      if (picked.canceled || !picked.assets[0]?.uri) return;

      setPhase({ kind: 'parsing' });
      // Downscale + recompress so only a small JPEG leaves the device. 1280 wide
      // (vs the meal flow's 1024) — screenshots carry small text.
      const shrunk = await manipulateAsync(picked.assets[0].uri, [{ resize: { width: 1280 } }], {
        compress: 0.7,
        format: SaveFormat.JPEG,
        base64: true,
      });
      if (!shrunk.base64) {
        setPhase({ kind: 'error', message: 'Couldn’t process that image.' });
        return;
      }
      const imported = await importWorkoutFromPhoto(shrunk.base64, note.trim() || undefined);
      toReview(groundWorkoutImport(getDb(), imported));
    } catch (error) {
      const message =
        error instanceof WorkoutImportUnavailableError
          ? error.message
          : 'Couldn’t read that photo. It may need the next dev build (photo access is native), ' +
            'or try a clearer screenshot.';
      setPhase({ kind: 'error', message });
    }
  };

  const patchSet = (exKey: number, setKey: number, patch: Partial<Omit<ReviewSet, 'key'>>) => {
    setExercises((prev) =>
      prev.map((e) =>
        e.key !== exKey
          ? e
          : { ...e, sets: e.sets.map((s) => (s.key === setKey ? { ...s, ...patch } : s)) }
      )
    );
  };
  const removeSet = (exKey: number, setKey: number) => {
    setExercises((prev) =>
      prev
        .map((e) => (e.key !== exKey ? e : { ...e, sets: e.sets.filter((s) => s.key !== setKey) }))
        .filter((e) => e.sets.length > 0)
    );
  };
  const removeExercise = (exKey: number) =>
    setExercises((prev) => prev.filter((e) => e.key !== exKey));
  const renameExercise = (exKey: number, newName: string) =>
    setExercises((prev) =>
      // A renamed exercise drops its catalog match — the match was for the OLD
      // name, and a stale id would file history under the wrong movement.
      prev.map((e) => (e.key !== exKey ? e : { ...e, name: newName, exerciseId: null }))
    );

  const dateValid = isValidDate(date);
  const duration = durationText.trim() === '' ? null : Number(durationText);
  const durationValid =
    duration === null || (Number.isFinite(duration) && duration > 0 && duration < 1000);
  const canSave =
    phase.kind === 'review' &&
    name.trim() !== '' &&
    dateValid &&
    durationValid &&
    exercises.length > 0;

  const save = () => {
    if (inFlight.current || !canSave) return;
    inFlight.current = true;
    const sets: SetInput[] = exercises.flatMap((e) =>
      e.sets
        .map((s) => {
          const reps = s.reps.trim() === '' ? null : Math.round(Number(s.reps));
          const weight = s.weight.trim() === '' ? null : Number(s.weight);
          const rpe = s.rpe.trim() === '' ? null : Number(s.rpe);
          if (reps != null && !Number.isFinite(reps)) return null;
          if (weight != null && !Number.isFinite(weight)) return null;
          // A parse-less unit means the number came from a source that didn't
          // say — read it in the user's own display unit.
          const unit = s.unit ?? units.weight;
          const weightKg = weight == null ? null : unit === 'kg' ? weight : lbToKg(weight);
          if (reps == null && weightKg == null) return null;
          return {
            exercise: e.name.trim(),
            exerciseId: e.exerciseId,
            reps,
            weightKg,
            rpe: rpe != null && Number.isFinite(rpe) ? rpe : null,
          } satisfies SetInput;
        })
        .filter((s): s is NonNullable<typeof s> => s !== null)
    );
    try {
      logWorkout(
        getDb(),
        {
          date,
          name: name.trim(),
          kind,
          durationMin: duration,
          notes: parseNotes ? `Imported from a photo. ${parseNotes}` : 'Imported from a photo.',
        },
        sets
      );
      router.back();
    } catch (error) {
      inFlight.current = false;
      console.warn('[exercise] photo import save failed', error);
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
          <StackHeader title="Import workout" />
        </View>

        {phase.kind === 'pick' || phase.kind === 'error' ? (
          <>
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
              Choose a photo of a workout logged somewhere else — a screenshot from another app, a
              whiteboard, a card. ARC transcribes it, you review every number, then it saves like
              any other session.
            </Text>

            {!available ? (
              <View className="mt-4">
                <Block device="margin">
                  <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
                    Reading a photo needs a model key — set one in Settings › Coach. Everything else
                    about ARC works offline; this is one of the few online features.
                  </Text>
                </Block>
              </View>
            ) : null}

            <View className="mt-5">
              <SectionLabel label="Context (optional)" />
              <View className={`mt-2 min-h-[44px] ${INPUT_WELL} px-3.5`}>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Anything the photo doesn’t say — date, units…"
                  placeholderTextColor={palette.inkMuted}
                  className="py-2.5 font-serif text-[14px] text-ink"
                  accessibilityLabel="Context for the import"
                />
              </View>
            </View>

            {phase.kind === 'error' ? (
              <Text className="mt-4 font-serif text-[13px] leading-5 text-ink-secondary">
                {phase.message}
              </Text>
            ) : null}

            {/* The one accent: pick + parse. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose a photo and read it"
              accessibilityState={{ disabled: !available }}
              disabled={!available}
              onPress={pickAndParse}
              className={`mt-6 min-h-[48px] flex-row items-center justify-center gap-2 rounded-btn ${
                available ? 'bg-pine active:opacity-70' : 'border border-hairline'
              }`}>
              <Ionicons
                name="image-outline"
                size={17}
                color={available ? palette.pineOn : palette.inkMuted}
              />
              <Text
                className={`font-label text-[15px] font-semibold ${
                  available ? 'text-pine-on' : 'text-ink-muted'
                }`}>
                Choose photo
              </Text>
            </Pressable>
          </>
        ) : null}

        {phase.kind === 'parsing' ? (
          <View className="mt-10 items-center">
            <ActivityIndicator color={palette.ink} />
            <Text className="mt-3 font-serif text-[14px] leading-6 text-ink-secondary">
              Reading the photo…
            </Text>
          </View>
        ) : null}

        {phase.kind === 'review' ? (
          <>
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              Check every number against the photo — fix anything the transcription got wrong, then
              save.
            </Text>
            {parseNotes ? (
              <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
                Transcriber notes: {parseNotes}
              </Text>
            ) : null}

            {/* Session identity — a form: well-tokened controls, no device. */}
            <View className="mt-5">
              <SectionLabel label="Session" />
              <View className="mt-2 flex-row gap-2">
                <View className={`min-h-[44px] w-32 ${INPUT_WELL} px-3`}>
                  <TextInput
                    value={date}
                    onChangeText={setDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={palette.inkMuted}
                    keyboardType="numbers-and-punctuation"
                    maxLength={10}
                    className="py-2.5 text-center font-mono text-[14px] text-ink"
                    accessibilityLabel="Session date"
                  />
                </View>
                <View className={`min-h-[44px] flex-1 ${INPUT_WELL} px-3.5`}>
                  <TextInput
                    value={name}
                    onChangeText={setName}
                    placeholder="Session name"
                    placeholderTextColor={palette.inkMuted}
                    className="py-2.5 font-serif text-[15px] text-ink"
                    accessibilityLabel="Session name"
                  />
                </View>
              </View>
              {!dateValid ? (
                <Text className="mt-1.5 font-serif text-[12px] leading-4 text-ink-secondary">
                  The date reads as YYYY-MM-DD, e.g. {todayISODate()}.
                </Text>
              ) : null}
              <View className="mt-2 flex-row gap-2">
                {KINDS.map((k) => {
                  const on = k.key === kind;
                  return (
                    <Pressable
                      key={k.key}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      onPress={() => setKind(k.key)}
                      className={`rounded-btn border px-3 py-1.5 active:bg-paper-dim ${
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
                <View className={`min-h-[36px] w-20 ${INPUT_WELL} px-2`}>
                  <TextInput
                    value={durationText}
                    onChangeText={setDurationText}
                    placeholder="min"
                    placeholderTextColor={palette.inkMuted}
                    keyboardType="number-pad"
                    className="py-1.5 text-center font-mono text-[13px] text-ink"
                    accessibilityLabel="Duration in minutes"
                  />
                </View>
              </View>
            </View>

            {/* One ruled plate per exercise — the transcribed record. */}
            <View className="mt-6">
              {exercises.map((e, ei) => (
                <View key={e.key} className={ei === 0 ? '' : 'mt-5'}>
                  <Block device="plate">
                    <View className="flex-row items-center gap-2">
                      <View className={`min-h-[36px] flex-1 ${INPUT_WELL} px-2.5`}>
                        <TextInput
                          value={e.name}
                          onChangeText={(t) => renameExercise(e.key, t)}
                          className="py-1.5 font-serif text-[15px] text-ink"
                          accessibilityLabel="Exercise name"
                        />
                      </View>
                      {e.exerciseId ? (
                        <Text className="font-label text-[9px] uppercase tracking-[1px] text-ink-muted">
                          Matched
                        </Text>
                      ) : null}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${e.name}`}
                        onPress={() => removeExercise(e.key)}
                        hitSlop={10}
                        className="h-8 w-8 items-center justify-center active:opacity-60">
                        <Ionicons name="close" size={16} color={palette.inkMuted} />
                      </Pressable>
                    </View>

                    <View className="mt-2">
                      {e.sets.map((s, si) => (
                        <View key={s.key}>
                          <Divider first={si === 0} />
                          <View className="flex-row items-center gap-1.5 py-1.5">
                            <Text className="w-7 font-mono text-[12px] text-ink-secondary">
                              {si + 1}
                            </Text>
                            <View className={`min-h-[36px] flex-1 ${INPUT_WELL} px-1`}>
                              <TextInput
                                value={s.reps}
                                onChangeText={(reps) => patchSet(e.key, s.key, { reps })}
                                placeholder="reps"
                                placeholderTextColor={palette.inkMuted}
                                keyboardType="number-pad"
                                className="py-1.5 text-center font-mono text-[14px] text-ink"
                                accessibilityLabel={`Reps for set ${si + 1}`}
                              />
                            </View>
                            <Text className="font-mono text-[12px] text-ink-muted">×</Text>
                            <View className={`min-h-[36px] flex-1 ${INPUT_WELL} px-1`}>
                              <TextInput
                                value={s.weight}
                                onChangeText={(weight) => patchSet(e.key, s.key, { weight })}
                                placeholder="—"
                                placeholderTextColor={palette.inkMuted}
                                keyboardType="decimal-pad"
                                className="py-1.5 text-center font-mono text-[14px] text-ink"
                                accessibilityLabel={`Weight for set ${si + 1}`}
                              />
                            </View>
                            {/* The unit came off the photo; tap cycles if it read wrong. */}
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Weight unit ${s.unit ?? units.weight}. Tap to change.`}
                              onPress={() =>
                                patchSet(e.key, s.key, {
                                  unit: (s.unit ?? units.weight) === 'lb' ? 'kg' : 'lb',
                                })
                              }
                              hitSlop={8}
                              className="w-8 items-center active:opacity-60">
                              <Text className="font-mono text-[11px] text-ink-secondary">
                                {s.unit ?? units.weight}
                              </Text>
                            </Pressable>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Remove set ${si + 1}`}
                              onPress={() => removeSet(e.key, s.key)}
                              hitSlop={8}
                              className="h-8 w-8 items-center justify-center active:opacity-60">
                              <Ionicons name="close" size={14} color={palette.inkMuted} />
                            </Pressable>
                          </View>
                        </View>
                      ))}
                    </View>
                  </Block>
                </View>
              ))}
            </View>

            {/* The one accent in review: Save. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save imported workout"
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
                Save workout
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start over with a different photo"
              onPress={() => setPhase({ kind: 'pick' })}
              className="mt-3 min-h-[44px] items-center justify-center active:opacity-60">
              <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink-secondary">
                Different photo
              </Text>
            </Pressable>
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
