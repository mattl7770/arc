/**
 * The saved-workout editor's lines (app/routine-edit.tsx) — what it opens from
 * a stored routine and what its Save hands back to the repository. Pure, so
 * db/routines.test.mjs can round-trip a reorder through `updateRoutine` with
 * the editor's own mapping rather than a copy of it.
 *
 * ## Reorder uses the session's helper, not a second one
 *
 * Owner, on the device, 2026-09-23: *"be able to reorder exercises in a
 * workout."* The live logger got an Order mode first; the saved-workout editor
 * had none, so moving an exercise meant removing it and adding it again, which
 * threw away the sets, rep range and rest typed on that line. The editor now
 * moves lines with {@link moveBlockSegment} from block-order.ts — the same
 * function the session uses — and draws the same Order plate
 * (src/components/exercise/exercise-order.tsx).
 *
 * A line is moved whole: the helper reorders the array and copies an object
 * only when it has to clear a bind, so every field typed on a line travels with
 * it. Save writes the array in order and `insertLines` numbers `position` 1..n
 * from it, so the order needs no field of its own.
 *
 * ## Why every line says `linkedToNext: false`
 *
 * A saved workout cannot carry a superset. `routine_exercises` (0012) has no
 * group column and `RoutineExerciseInput` has no bind, so a session started
 * from a saved workout begins with every block unbound, and any superset made
 * during it is written to that session's sets, never back to the saved
 * workout. The field is here only so a line is a block-order `Bindable`; typed
 * as the literal `false`, it cannot be set to anything else. With no binds,
 * every line is its own segment and each arrow press swaps one line with its
 * neighbour. If a saved workout ever stores a superset, this becomes a real
 * flag and the session's rule — a superset moves as one — already applies.
 */
import { blockSegments, moveBlockSegment } from './block-order';
import { MUSCLE_LABEL } from './constants';
import type { RoutineDetail, RoutineExerciseInput } from './types';

/** One line under edit. `key` is a mount-local id for React lists and moves. */
export type RoutineLine = {
  key: number;
  /** Always false: a saved workout stores no superset. See the module note. */
  linkedToNext: false;
  exerciseId: string;
  /** The exercise's name, as the list and the Order plate show it. */
  name: string;
  /** Primary muscles as one display string ("Chest, Triceps"). */
  primaryMuscles: string;
  // The targets as typed. Strings, so a half-typed field stays as it is.
  sets: string;
  repLow: string;
  repHigh: string;
  rest: string;
};

/** A saved workout's stored lines, as the editor opens them. Keys run 0..n-1. */
export function routineLines(detail: RoutineDetail | null): RoutineLine[] {
  if (!detail) return [];
  return detail.exercises.map((e, i) => ({
    key: i,
    linkedToNext: false,
    exerciseId: e.exerciseId,
    name: e.exerciseName,
    primaryMuscles: e.primaryMuscles.map((m) => MUSCLE_LABEL[m]).join(', '),
    sets: String(e.targetSets),
    repLow: e.repLow == null ? '' : String(e.repLow),
    repHigh: e.repHigh == null ? '' : String(e.repHigh),
    rest: e.restSec == null ? '' : String(e.restSec),
  }));
}

/** A line for an exercise just picked: three sets, no range, no rest. */
export function newRoutineLine(
  key: number,
  exerciseId: string,
  name: string,
  primaryMuscles: string
): RoutineLine {
  return {
    key,
    linkedToNext: false,
    exerciseId,
    name,
    primaryMuscles,
    sets: '3',
    repLow: '',
    repHigh: '',
    rest: '',
  };
}

/**
 * Move one line a place up (`-1`) or down (`1`) — {@link moveBlockSegment},
 * the session's own move. `null` when the line is already at that end, which
 * the Order plate draws as a disabled arrow.
 */
export function moveRoutineLine(
  lines: readonly RoutineLine[],
  key: number,
  direction: -1 | 1
): RoutineLine[] | null {
  return moveBlockSegment(lines, key, direction);
}

/**
 * A line's targets on one row, for the Order plate. Reorder mode folds the
 * target fields away, and the picker allows one exercise twice (a heavy top
 * set and a back-off line), so without this two lines of one movement are two
 * identical rows and the owner cannot tell which one he is moving.
 *
 * `text` is drawn in mono: `4 × 5–8 · 180 s rest`, or `3 sets · 60 s rest` for
 * a line with no rep range. `spoken` says the same for VoiceOver, with no
 * symbol for it to read out. The figures are the fields as typed, so a row
 * says what the fields say; blank sets reads 3, the figure the field shows as
 * its placeholder and Save writes.
 */
export type RoutineLineTargets = { text: string; spoken: string };

export function routineLineTargets(line: RoutineLine): RoutineLineTargets {
  const sets = line.sets.trim() || '3';
  const setWord = sets === '1' ? 'set' : 'sets';
  const low = line.repLow.trim();
  const high = line.repHigh.trim();
  const rest = line.rest.trim();
  const range = low !== '' && high !== '' && low !== high;
  const reps = range ? `${low}–${high}` : low || high;
  const text = [reps ? `${sets} × ${reps}` : `${sets} ${setWord}`];
  const spoken = [
    reps ? `${sets} ${setWord} of ${range ? `${low} to ${high}` : reps}` : `${sets} ${setWord}`,
  ];
  if (rest !== '') {
    text.push(`${rest} s rest`);
    spoken.push(`${rest} seconds rest`);
  }
  return { text: text.join(' · '), spoken: spoken.join(', ') };
}

// ---------------------------------------------------------------------------
// The editor's list as one pure state: its lines, whether Order mode is on,
// and the next key to mint. The screen holds it with `useReducer` and only
// dispatches, so the toggle and the move it wires are the ones
// db/routines.test.mjs and db/screens-render.test.mjs drive.

export type RoutineListState = {
  lines: RoutineLine[];
  /** Order mode asked for. It shows only while {@link canReorderLines} holds. */
  reordering: boolean;
  /** The key the next added line takes. Keys are never reused on one mount. */
  nextKey: number;
};

/** The four targets: the only part of a line a field edits. */
export type RoutineLinePatch = Partial<Pick<RoutineLine, 'sets' | 'repLow' | 'repHigh' | 'rest'>>;

export type RoutineListAction =
  | { type: 'add'; exerciseId: string; name: string; primaryMuscles: string }
  | { type: 'update'; key: number; patch: RoutineLinePatch }
  | { type: 'remove'; key: number }
  | { type: 'move'; key: number; direction: -1 | 1 }
  | { type: 'toggle-order' };

/** The list as the editor opens it: the stored lines, Order mode off. */
export function openRoutineList(detail: RoutineDetail | null): RoutineListState {
  const lines = routineLines(detail);
  return { lines, reordering: false, nextKey: lines.length };
}

/**
 * Two things to put in order. A saved workout stores no superset, so that is
 * two lines, counted in segments as the logger counts it.
 */
export function canReorderLines(lines: readonly RoutineLine[]): boolean {
  return blockSegments(lines).length > 1;
}

/** Whether the Order plate is the one drawn. */
export function showsOrder(state: RoutineListState): boolean {
  return state.reordering && canReorderLines(state.lines);
}

export function routineListReducer(
  state: RoutineListState,
  action: RoutineListAction
): RoutineListState {
  switch (action.type) {
    case 'add':
      return {
        ...state,
        lines: [
          ...state.lines,
          newRoutineLine(state.nextKey, action.exerciseId, action.name, action.primaryMuscles),
        ],
        nextKey: state.nextKey + 1,
      };
    case 'update':
      return {
        ...state,
        lines: state.lines.map((l) => (l.key === action.key ? { ...l, ...action.patch } : l)),
      };
    case 'remove':
      return { ...state, lines: state.lines.filter((l) => l.key !== action.key) };
    case 'move': {
      const moved = moveRoutineLine(state.lines, action.key, action.direction);
      return moved ? { ...state, lines: moved } : state;
    }
    case 'toggle-order':
      // From what is drawn, not what was asked: Done always leaves the mode.
      return { ...state, reordering: !showsOrder(state) };
  }
}

/** A typed field as a number, or null when blank or not a number. */
function fieldNumber(s: string): number | null {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * What Save writes, in the lines' current order. Sets fall back to 3 when blank
 * and are clamped to routine_exercises' 1..20; the rep range and rest pass
 * through (the editor holds Save while either is out of range, so the CHECKs in
 * 0012 are never the ones to refuse).
 */
export function routineExerciseInputs(lines: readonly RoutineLine[]): RoutineExerciseInput[] {
  return lines.map((l) => ({
    exerciseId: l.exerciseId,
    targetSets: Math.min(20, Math.max(1, fieldNumber(l.sets) ?? 3)),
    repLow: fieldNumber(l.repLow),
    repHigh: fieldNumber(l.repHigh),
    restSec: fieldNumber(l.rest),
  }));
}
