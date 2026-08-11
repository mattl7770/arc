import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';

import { ExercisePicker } from '@/components/exercise/exercise-picker';
import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { createRoutine, deleteRoutine, updateRoutine } from '@/lib/db/repositories/routines';
import { MUSCLE_LABEL } from '@/lib/exercise/constants';
import type { RoutineDetail, RoutineExerciseInput } from '@/lib/exercise/types';
import { useRoutine } from '@/hooks/use-training';

/**
 * Routine builder — create/edit, pushed from the Exercise hub. A routine is a
 * name + notes + an ordered exercise list, each line carrying its target sets,
 * rep range, and rest. Exercises are added through the shared picker. Mirrors
 * the Protocol editor's discipline: in-flight guard, deep-link id coercion,
 * atomic save with a keep-the-form retry.
 *
 * ## The surface system (00-design-spec.md §1)
 *
 *   Exercises      plate   a routine IS a record — an ordered, ruled list
 *   Save problems  margin  the "why Save is off" annotation
 *
 * The name/notes/target fields are recessed stock drawn inline: an input is not
 * a content block and takes no device of its own. Targets are measurements, so
 * every one of them is mono; their captions are the label voice.
 *
 * **Accent budget: one.** Save, and nothing else — Delete is a quiet text
 * button, because a destructive action should never be the brightest thing on
 * the page.
 */

/** One line under edit. `key` is a mount-local id for React lists only. */
type EditLine = {
  key: number;
  exerciseId: string;
  exerciseName: string;
  primaryMuscles: string;
  sets: string;
  repLow: string;
  repHigh: string;
  rest: string;
};

function initialLines(detail: RoutineDetail | null): EditLine[] {
  if (!detail) return [];
  return detail.exercises.map((e, i) => ({
    key: i,
    exerciseId: e.exerciseId,
    exerciseName: e.exerciseName,
    primaryMuscles: e.primaryMuscles.map((m) => MUSCLE_LABEL[m]).join(', '),
    sets: String(e.targetSets),
    repLow: e.repLow == null ? '' : String(e.repLow),
    repHigh: e.repHigh == null ? '' : String(e.repHigh),
    rest: e.restSec == null ? '' : String(e.restSec),
  }));
}

/** A compact mono numeric field for the per-line targets. */
function NumField({
  value,
  onChange,
  placeholder,
  label,
  accessibilityLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  accessibilityLabel: string;
}) {
  return (
    <View className="flex-1">
      <Text className="mb-1 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
        {label}
      </Text>
      <View className="min-h-[40px] justify-center border border-paper-deep bg-paper-dim px-2">
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={palette.inkMuted}
          keyboardType="number-pad"
          className="py-2 text-center font-mono text-[15px] text-ink"
          accessibilityLabel={accessibilityLabel}
        />
      </View>
    </View>
  );
}

export default function RoutineEditScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  return <RoutineEditor key={id ?? 'new'} id={id} />;
}

function RoutineEditor({ id }: { id: string | undefined }) {
  const router = useRouter();
  const detail = useRoutine(id);
  const editing = id != null;

  const [name, setName] = useState(detail?.name ?? '');
  const [notes, setNotes] = useState(detail?.notes ?? '');
  const [lines, setLines] = useState<EditLine[]>(() => initialLines(detail));
  const [pickerOpen, setPickerOpen] = useState(false);
  const nextKey = useRef(lines.length);
  const inFlight = useRef(false);

  // A line with both rep bounds set must read low ≤ high (the schema CHECK), so
  // block Save with a hint rather than throwing at the insert.
  const repsValid = lines.every((l) => {
    const lo = l.repLow.trim() === '' ? null : Number(l.repLow);
    const hi = l.repHigh.trim() === '' ? null : Number(l.repHigh);
    if (lo != null && hi != null) return Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi;
    return true;
  });
  const canSave = name.trim() !== '' && repsValid;
  const problem = repsValid ? null : 'A rep range needs its low ≤ its high — or leave both blank.';

  const addExercise = (exerciseId: string, exerciseName: string, primaryMuscles: string) => {
    const key = nextKey.current;
    nextKey.current += 1;
    setLines((prev) => [
      ...prev,
      {
        key,
        exerciseId,
        exerciseName,
        primaryMuscles,
        sets: '3',
        repLow: '',
        repHigh: '',
        rest: '',
      },
    ]);
  };

  const updateLine = (key: number, patch: Partial<Omit<EditLine, 'key'>>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };
  const removeLine = (key: number) => setLines((prev) => prev.filter((l) => l.key !== key));

  const num = (s: string): number | null => {
    if (s.trim() === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const save = () => {
    if (inFlight.current || !canSave) return;
    inFlight.current = true;
    const exercises: RoutineExerciseInput[] = lines.map((l) => ({
      exerciseId: l.exerciseId,
      targetSets: Math.min(20, Math.max(1, num(l.sets) ?? 3)),
      repLow: num(l.repLow),
      repHigh: num(l.repHigh),
      restSec: num(l.rest),
    }));
    const input = { name: name.trim(), notes: notes.trim() || null, exercises };
    try {
      const db = getDb();
      if (detail) updateRoutine(db, detail.id, input);
      else createRoutine(db, input);
      router.back();
    } catch (error) {
      inFlight.current = false;
      console.warn('[routines] save failed', error);
      Alert.alert('Save failed', 'Nothing was changed. Please try again.');
    }
  };

  const confirmDelete = () => {
    if (!detail) return;
    Alert.alert(
      'Delete this routine?',
      'Workouts you logged from it keep their history — they just lose the link.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (inFlight.current) return;
            inFlight.current = true;
            try {
              deleteRoutine(getDb(), detail.id);
              router.back();
            } catch (error) {
              inFlight.current = false;
              console.warn('[routines] delete failed', error);
              Alert.alert('Delete failed', 'Nothing was changed. Please try again.');
            }
          },
        },
      ]
    );
  };

  if (editing && !detail) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Edit routine" />
        </View>
        <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
          This routine no longer exists.
        </Text>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={editing ? 'Edit routine' : 'New routine'} />
      </View>

      <View className="mt-3">
        <SectionLabel label="Routine" />
        <View className="mt-2 min-h-[44px] justify-center border border-paper-deep bg-paper-dim px-3.5">
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Upper A"
            placeholderTextColor={palette.inkMuted}
            className="py-2.5 font-serif text-[15px] text-ink"
            accessibilityLabel="Routine name"
          />
        </View>
        <View className="mt-2 min-h-[44px] justify-center border border-paper-deep bg-paper-dim px-3.5">
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Notes (optional)"
            placeholderTextColor={palette.inkMuted}
            className="py-2.5 font-serif text-[15px] text-ink"
            accessibilityLabel="Routine notes"
          />
        </View>
      </View>

      {/* Exercises — the routine's record, so: one ruled plate, one line each,
          drawn whether or not there are lines yet. A new routine always opens
          empty, and the plate is what says a record goes here. (The sweep of
          2026-08-10 made it conditional; reverted at the owner's instruction.) */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel
            label="Exercises"
            note={lines.length > 0 ? String(lines.length) : undefined}
          />
          {lines.length === 0 ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              No exercises yet — add the movements this routine runs, with their target sets and rep
              range.
            </Text>
          ) : (
            <View className="mt-1">
              {lines.map((l, i) => (
                <View key={l.key}>
                  <Divider first={i === 0} />
                  <View className="py-3">
                    <View className="flex-row items-start gap-2">
                      <View className="flex-1">
                        <Text className="font-serif text-[15px] text-ink">{l.exerciseName}</Text>
                        {l.primaryMuscles ? (
                          <Text className="mt-0.5 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                            {l.primaryMuscles}
                          </Text>
                        ) : null}
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${l.exerciseName}`}
                        onPress={() => removeLine(l.key)}
                        hitSlop={10}
                        className="-mr-1 h-8 w-8 items-center justify-center active:opacity-60">
                        <Ionicons name="close" size={16} color={palette.inkMuted} />
                      </Pressable>
                    </View>
                    <View className="mt-2.5 flex-row items-end gap-2">
                      <NumField
                        label="Sets"
                        value={l.sets}
                        onChange={(sets) => updateLine(l.key, { sets })}
                        placeholder="3"
                        accessibilityLabel={`Target sets for ${l.exerciseName}`}
                      />
                      <NumField
                        label="Rep low"
                        value={l.repLow}
                        onChange={(repLow) => updateLine(l.key, { repLow })}
                        placeholder="6"
                        accessibilityLabel={`Rep range low for ${l.exerciseName}`}
                      />
                      <NumField
                        label="Rep high"
                        value={l.repHigh}
                        onChange={(repHigh) => updateLine(l.key, { repHigh })}
                        placeholder="10"
                        accessibilityLabel={`Rep range high for ${l.exerciseName}`}
                      />
                      <NumField
                        label="Rest s"
                        value={l.rest}
                        onChange={(rest) => updateLine(l.key, { rest })}
                        placeholder="150"
                        accessibilityLabel={`Rest seconds for ${l.exerciseName}`}
                      />
                    </View>
                  </View>
                </View>
              ))}
            </View>
          )}
        </Block>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add exercise"
          onPress={() => setPickerOpen(true)}
          className="mt-2 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
          <Ionicons name="add" size={17} color={palette.inkSecondary} />
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
            Add exercise
          </Text>
        </Pressable>
      </View>

      {/* Why Save is off — an annotation, so: margin. */}
      {problem ? (
        <View className="mt-5">
          <Block device="margin">
            <Text className="font-serif text-[13px] leading-5 text-ink-secondary">{problem}</Text>
          </Block>
        </View>
      ) : null}

      {/*
        The one primary action. Disabled reads as an unfilled outline rather than
        a filled grey: muted ink on the sheet clears 4.5:1, on a hairline fill it
        does not.
      */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={editing ? 'Save routine' : 'Create routine'}
        accessibilityState={{ disabled: !canSave }}
        disabled={!canSave}
        onPress={save}
        className={`mt-6 h-12 items-center justify-center rounded-btn ${
          canSave ? 'bg-pine active:opacity-70' : 'border border-hairline'
        }`}>
        <Text
          className={`font-label text-[15px] font-semibold ${
            canSave ? 'text-pine-on' : 'text-ink-muted'
          }`}>
          {editing ? 'Save routine' : 'Create routine'}
        </Text>
      </Pressable>

      {editing ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete routine"
          onPress={confirmDelete}
          className="mt-5 min-h-[44px] items-center justify-center active:opacity-60">
          <Text className="font-label text-[11px] font-semibold uppercase tracking-[1px] text-ink-secondary">
            Delete routine
          </Text>
        </Pressable>
      ) : null}

      <ExercisePicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(ex) =>
          addExercise(ex.id, ex.name, ex.primaryMuscles.map((m) => MUSCLE_LABEL[m]).join(', '))
        }
      />
    </Screen>
  );
}
