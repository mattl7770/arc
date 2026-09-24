import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useReducer, useRef, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';

import { ExerciseOrder, ReorderToggle } from '@/components/exercise/exercise-order';
import { ExercisePicker } from '@/components/exercise/exercise-picker';
import { Block, Divider } from '@/components/ui/block';
import { KEYPAD_DONE } from '@/components/ui/keyboard';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { createRoutine, deleteRoutine, updateRoutine } from '@/lib/db/repositories/routines';
import { MUSCLE_LABEL } from '@/lib/exercise/constants';
import {
  canReorderLines,
  openRoutineList,
  routineExerciseInputs,
  routineLineTargets,
  routineListReducer,
  showsOrder,
  type RoutineListAction,
  type RoutineListState,
} from '@/lib/exercise/routine-lines';
import { useRoutine } from '@/hooks/use-training';

/**
 * Saved-workout builder — create/edit, pushed from the Exercise hub. A saved
 * workout (the routines tables, UI renamed 2026-08-11) is a
 * name + notes + an ordered exercise list, each line carrying its target sets,
 * rep range, and rest. Exercises are added through the shared picker. Mirrors
 * the Protocol editor's discipline: in-flight guard, deep-link id coercion,
 * atomic save with a keep-the-form retry.
 *
 * ## The surface system (00-design-spec.md §1)
 *
 *   Exercises      plate   a routine IS a record — an ordered, ruled list
 *   Order          plate   reorder mode: the same record, a row per line
 *   Save problems  margin  the "why Save is off" annotation
 *
 * Exercises and Order are never on screen together: reorder mode swaps one
 * plate for the other, so there is still one device for the list.
 *
 * The name/notes/target fields are recessed stock drawn inline: an input is not
 * a content block and takes no device of its own. Targets are measurements, so
 * every one of them is mono; their captions are the label voice.
 *
 * **Accent budget: one.** Save, and nothing else — Delete is a quiet text
 * button, because a destructive action should never be the brightest thing on
 * the page. Reorder and its arrows are chrome, off the budget.
 *
 * ## Reorder (2026-09-23)
 *
 * The owner's note — *"be able to reorder exercises in a workout"* — was built
 * for a live and a logged session first; this editor could only append and
 * remove, so moving a line meant retyping its targets. It now has the
 * session's Order mode: the same toggle, the same plate
 * (src/components/exercise/exercise-order.tsx) and the same move
 * (`moveBlockSegment`, via src/lib/exercise/routine-lines.ts). A line moves
 * whole, so its sets, rep range and rest go with it, and Save — unchanged —
 * writes the lines in their new order. Each Order row carries its line's
 * targets in mono, because the picker allows one exercise twice and the fields
 * that tell those lines apart are the ones the mode folds away.
 *
 * The list (its lines, the mode, the next key) is one pure reducer in
 * routine-lines.ts, and the list section is {@link RoutineLinesSection}, a
 * plain function of that state. The editor only holds the state and passes
 * `dispatch` down, so the toggle and the arrows the tests press are the ones
 * the screen wires.
 */

/**
 * A compact mono numeric field for the per-line targets.
 *
 * ## `fill` is opt-in, and this field is the one that would hurt most
 *
 * The wrapper used to be `<View className="flex-1">` unconditionally. Every one
 * of the four call sites below sits in `flex-row items-end gap-2`, so today that
 * is correct and nothing on this screen renders wrong. It is correct by accident
 * of where the fields happen to sit, though, and this helper is the worst one to
 * leave that way: its input lives inside a bordered `min-h-[40px]` well, so a
 * column call site would not merely misplace some text — it would stamp a 40pt
 * box across the routine line underneath it.
 *
 * The mechanism, same as app/protocol-edit.tsx (the reference fix) and
 * app/food-new.tsx (where it was live): in a column the main axis is vertical,
 * so `flex-1` resolves to `flexBasis: 0%` **on the height**. A `mt-*` parent has
 * no height of its own — it sizes to its content inside a `<Screen scroll>` — so
 * `flexGrow` has no free space to claim and the wrapper lays out at **zero
 * height**. Yoga implements no `min-height: auto` floor to catch it, and views
 * do not clip, so the caption and the well paint at full size on top of whatever
 * follows. The `min-h-[40px]` is on the well INSIDE the wrapper; it does nothing
 * to stop the wrapper itself measuring zero.
 *
 * So the flex is opt-in: `fill` belongs to a field sharing a **row**, and
 * nowhere else. The wrapper stays — a caption stacked over a well needs
 * something to stack in — but it is plain by default, and since the row
 * distributes the wrapper rather than the well, `fill` lands on the wrapper.
 */
function NumField({
  value,
  onChange,
  placeholder,
  label,
  accessibilityLabel,
  fill,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  accessibilityLabel: string;
  /**
   * Set ONLY when this field is a child of a `flex-row` and should take an equal
   * share of its width. See the note above — in a column it collapses the
   * wrapper to zero height and the well paints over the line below.
   */
  fill?: boolean;
}) {
  return (
    <View className={fill ? 'flex-1' : undefined}>
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
          returnKeyType={KEYPAD_DONE}
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
  // The lines, Order mode and the next key: one pure reducer (routine-lines.ts).
  const [list, dispatch] = useReducer(routineListReducer, detail, openRoutineList);
  const { lines } = list;
  const [pickerOpen, setPickerOpen] = useState(false);
  const inFlight = useRef(false);

  // A line's targets must fit routine_exercises' per-column CHECKs
  // (0012_routines.sql): each rep bound in [1, 99], rest in [0, 3599], and when
  // both rep bounds are set low ≤ high. Without this an in-range-looking 0 / 150
  // / 3600 passes canSave and then throws the CHECK inside save()'s transaction,
  // rolling the whole routine back with an opaque alert — so block Save with a
  // hint instead. Blank stays valid (a carry or timed hold has no range / rest).
  const inRange = (v: string, lo: number, hi: number) => {
    if (v.trim() === '') return true;
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi;
  };
  const repsValid = lines.every((l) => {
    if (!inRange(l.repLow, 1, 99) || !inRange(l.repHigh, 1, 99)) return false;
    const lo = l.repLow.trim() === '' ? null : Number(l.repLow);
    const hi = l.repHigh.trim() === '' ? null : Number(l.repHigh);
    if (lo != null && hi != null) return lo <= hi;
    return true;
  });
  const restValid = lines.every((l) => inRange(l.rest, 0, 3599));
  const canSave = name.trim() !== '' && repsValid && restValid;
  const problem = !repsValid
    ? 'A rep range runs from 1 to 99, low ≤ high — or leave both blank.'
    : !restValid
      ? 'Rest is in seconds — keep it under 3600 (an hour), or leave it blank.'
      : null;

  const save = () => {
    if (inFlight.current || !canSave) return;
    inFlight.current = true;
    // The lines as they stand, in the order they stand: a reorder needs
    // nothing more, because `insertLines` numbers `position` from this array.
    const exercises = routineExerciseInputs(lines);
    const input = { name: name.trim(), notes: notes.trim() || null, exercises };
    try {
      const db = getDb();
      if (detail) updateRoutine(db, detail.id, input);
      else createRoutine(db, input);
      router.back();
    } catch (error) {
      inFlight.current = false;
      console.warn('[routines] save failed', error);
      Alert.alert('Save failed', 'Nothing was changed. Try again.');
    }
  };

  const confirmDelete = () => {
    if (!detail) return;
    Alert.alert(
      'Delete this saved workout?',
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
              Alert.alert('Delete failed', 'Nothing was changed. Try again.');
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
          <StackHeader title="Edit saved workout" />
        </View>
        <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
          This saved workout no longer exists.
        </Text>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={editing ? 'Edit saved workout' : 'New saved workout'} />
      </View>

      <View className="mt-3">
        <SectionLabel label="Saved workout" />
        <View className="mt-2 min-h-[44px] justify-center border border-paper-deep bg-paper-dim px-3.5">
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Upper A"
            placeholderTextColor={palette.inkMuted}
            className="py-2.5 font-serif text-[15px] text-ink"
            accessibilityLabel="Saved workout name"
          />
        </View>
        <View className="mt-2 min-h-[44px] justify-center border border-paper-deep bg-paper-dim px-3.5">
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Notes (optional)"
            placeholderTextColor={palette.inkMuted}
            className="py-2.5 font-serif text-[15px] text-ink"
            accessibilityLabel="Saved workout notes"
          />
        </View>
      </View>

      {/* The exercise list and its Order mode — see RoutineLinesSection. */}
      <RoutineLinesSection
        state={list}
        dispatch={dispatch}
        onAddExercise={() => setPickerOpen(true)}
      />

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
        accessibilityLabel="Save workout"
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
          Save workout
        </Text>
      </Pressable>

      {editing ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete saved workout"
          onPress={confirmDelete}
          className="mt-5 min-h-[44px] items-center justify-center active:opacity-60">
          <Text className="font-label text-[11px] font-semibold uppercase tracking-[1px] text-ink-secondary">
            Delete saved workout
          </Text>
        </Pressable>
      ) : null}

      <ExercisePicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(ex) =>
          dispatch({
            type: 'add',
            exerciseId: ex.id,
            name: ex.name,
            primaryMuscles: ex.primaryMuscles.map((m) => MUSCLE_LABEL[m]).join(', '),
          })
        }
      />
    </Screen>
  );
}

/**
 * The exercise list: the Reorder door, the Exercises plate or the Order plate,
 * and Add exercise. A plain function of the editor's list state with no hooks,
 * so db/screens-render.test.mjs can render it in either mode and press its
 * toggle and arrows through the element tree. Every change goes out through
 * `dispatch`; the editor holds the state and owns nothing else here.
 *
 * Exercises is the routine's record, so: one ruled plate, one line each, drawn
 * whether or not there are lines yet. A new routine always opens empty, and the
 * plate is what says a record goes here. (The sweep of 2026-08-10 made it
 * conditional; reverted at the owner's instruction.)
 *
 * REORDER is the live logger's mode, not a handle on every line: the toggle
 * sits right above the list, and in reorder mode the Order plate takes the
 * Exercises plate's place, so there is one device for the list either way.
 * The door is drawn only when there are two lines to put in order.
 */
export function RoutineLinesSection({
  state,
  dispatch,
  onAddExercise,
}: {
  state: RoutineListState;
  dispatch: (action: RoutineListAction) => void;
  onAddExercise: () => void;
}) {
  const { lines } = state;
  const canReorder = canReorderLines(lines);
  const showOrder = showsOrder(state);
  return (
    <View className={canReorder ? 'mt-4' : 'mt-7'}>
      {canReorder ? (
        <ReorderToggle active={showOrder} onToggle={() => dispatch({ type: 'toggle-order' })} />
      ) : null}
      <View className={canReorder ? 'mt-2' : undefined}>
        {showOrder ? (
          <ExerciseOrder
            items={lines.map((l) => ({ ...l, detail: routineLineTargets(l) }))}
            onMove={(key, direction) => dispatch({ type: 'move', key, direction })}
          />
        ) : (
          <Block device="plate">
            <SectionLabel
              label="Exercises"
              note={lines.length > 0 ? String(lines.length) : undefined}
            />
            {lines.length === 0 ? (
              <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                No exercises yet.
              </Text>
            ) : (
              <View className="mt-1">
                {lines.map((l, i) => (
                  <View key={l.key}>
                    <Divider first={i === 0} />
                    <View className="py-3">
                      <View className="flex-row items-start gap-2">
                        <View className="flex-1">
                          <Text className="font-serif text-[15px] text-ink">{l.name}</Text>
                          {l.primaryMuscles ? (
                            <Text className="mt-0.5 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                              {l.primaryMuscles}
                            </Text>
                          ) : null}
                        </View>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Remove ${l.name}`}
                          onPress={() => dispatch({ type: 'remove', key: l.key })}
                          hitSlop={10}
                          className="-mr-1 h-8 w-8 items-center justify-center active:opacity-60">
                          <Ionicons name="close" size={16} color={palette.inkMuted} />
                        </Pressable>
                      </View>
                      {/* `fill` on all four: this row splits its width evenly
                          between them. A target field that ever gets a row to
                          itself must NOT carry it — see {@link NumField}. */}
                      <View className="mt-2.5 flex-row items-end gap-2">
                        <NumField
                          label="Sets"
                          value={l.sets}
                          onChange={(sets) =>
                            dispatch({ type: 'update', key: l.key, patch: { sets } })
                          }
                          placeholder="3"
                          accessibilityLabel={`Target sets for ${l.name}`}
                          fill
                        />
                        <NumField
                          label="Rep low"
                          value={l.repLow}
                          onChange={(repLow) =>
                            dispatch({ type: 'update', key: l.key, patch: { repLow } })
                          }
                          placeholder="6"
                          accessibilityLabel={`Rep range low for ${l.name}`}
                          fill
                        />
                        <NumField
                          label="Rep high"
                          value={l.repHigh}
                          onChange={(repHigh) =>
                            dispatch({ type: 'update', key: l.key, patch: { repHigh } })
                          }
                          placeholder="10"
                          accessibilityLabel={`Rep range high for ${l.name}`}
                          fill
                        />
                        <NumField
                          label="Rest s"
                          value={l.rest}
                          onChange={(rest) =>
                            dispatch({ type: 'update', key: l.key, patch: { rest } })
                          }
                          placeholder="150"
                          accessibilityLabel={`Rest seconds for ${l.name}`}
                          fill
                        />
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </Block>
        )}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add exercise"
        onPress={onAddExercise}
        className="mt-2 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
        <Ionicons name="add" size={17} color={palette.inkSecondary} />
        <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
          Add exercise
        </Text>
      </Pressable>
    </View>
  );
}
